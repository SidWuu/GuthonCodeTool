"""Maintain only paths affected by an explicit SVN update, including deletions."""

from __future__ import annotations

import json
from pathlib import Path

from common.operation_control import checkpoint, publication_barrier, OperationCancelled
from providers.svn.checkout import operation_lock, require_capability, svn_status, file_hash
from providers.svn.dedup import resolve_page_duplicates
from . import catalog
from .manifest import load_authorized_scope, logical_path_for_entry, resolve_authorized_path


def _status_allows_indexing(change):
    return (change.get("item") in {"modified", "normal", "none", ""}
            and not any(change.get(key) for key in ("treeConflicted", "switched", "wcLocked"))
            and change.get("properties") != "conflicted")


def reindex_changed_files(conn, workspace, paths):
    scope = load_authorized_scope(workspace)
    entries = {resolve_authorized_path(scope, path)[0].id for path in paths}
    refreshed = {"updated": [
        {"id": entry.id, "after": svn_status(entry.root)}
        for entry in scope.entries if entry.id in entries
    ]}
    return index_changes(conn, workspace, paths, refreshed, skip_current=True)


def index_changes(conn, workspace, paths, refresh_result, on_progress=None, *, skip_current=False):
    from common import gusen_hub as hub

    require_capability(workspace, "reindex")
    scope = load_authorized_scope(workspace)
    result = {
        "mode": "svn-incremental-refresh", "workspaceKey": workspace["workspaceKey"],
        "changed": 0, "deleted": 0, "failures": 0, "errors": [], "ignored": [],
        "scannedFiles": 0, "skippedFiles": 0, "paths": [],
    }

    def progress(message):
        if on_progress is not None:
            on_progress(f"{workspace['displayName']}｜索引｜{message}")

    with operation_lock(workspace, "manifest-incremental-refresh", blocking=True):
        candidates = set()
        existing = {}
        roots = []
        for logical in sorted(set(paths), key=lambda value: (len(Path(value).parts), value)):
            if not any(root == "." or logical == root or logical.startswith(root + "/") for root in roots):
                roots.append(logical)
        for logical in roots:
            checkpoint()
            entry, target, relative = resolve_authorized_path(scope, logical)
            canonical = logical_path_for_entry(entry, relative)
            # Indexed range lookup, with '/' as the directory boundary; legal
            # wildcard characters in SVN names must not affect the selection.
            rows = list(conn.execute(
                "SELECT * FROM gusen_source_record WHERE provider='svn' AND scope_entry_id=? AND source_path=?",
                (entry.id, canonical),
            ))
            if target.is_dir() or not target.exists():
                if canonical:
                    rows.extend(conn.execute(
                        "SELECT * FROM gusen_source_record WHERE provider='svn' AND scope_entry_id=? "
                        "AND source_path>=? AND source_path<?",
                        (entry.id, canonical + "/", canonical + "0"),
                    ))
                else:
                    rows.extend(conn.execute(
                        "SELECT * FROM gusen_source_record WHERE provider='svn' AND scope_entry_id=?", (entry.id,),
                    ))
            for row in rows:
                existing[row["source_path"]] = dict(row)
                candidates.add(row["source_path"])
            if target.is_dir():
                for path in catalog.working_copy_files(target):
                    candidates.add(logical_path_for_entry(entry, path.relative_to(entry.root).as_posix()))
            else:
                candidates.add(canonical)

        changes_by_entry = {
            item["id"]: {change["path"]: change for change in (item.get("after") or {}).get("changes") or []}
            for item in refresh_result.get("updated") or []
        }
        if skip_current:
            remaining = set()
            for logical in candidates:
                checkpoint()
                entry, path, relative = resolve_authorized_path(scope, logical)
                row = existing.get(logical)
                changes = changes_by_entry.get(entry.id, {})
                current = False
                if row and path.is_file() and row["status"] in {"OK", "SVN_DIRTY"}:
                    current = (all(_status_allows_indexing(change) for change in changes.values())
                               and (row["status"] == "SVN_DIRTY") == (relative in changes)
                               and file_hash(path) == row["source_hash"])
                elif not row:
                    current = (not path.exists() and relative not in changes
                               or path.is_file() and not catalog.source_file_supported(entry, path))
                if current:
                    result["skippedFiles"] += 1
                    existing.pop(logical, None)
                else:
                    remaining.add(logical)
            candidates = remaining

        # Deleting a winning PAGE alias may reveal an older unindexed alias.
        # Old indexes do not retain those aliases, so recover only PAGE trees,
        # never the repository's procedures, metadata or public sources.
        removed_page = any(
            row["source_table"] == "page"
            and not resolve_authorized_path(scope, path)[1].is_file()
            for path, row in existing.items()
        )
        if removed_page:
            progress("删除 PAGE，核对授权页面目录中的别名候选")
            for entry in scope.entries:
                if entry.category == "pages":
                    roots = [entry.root]
                elif entry.category == "systems":
                    roots = [entry.root / "pages"]
                elif entry.category == "root":
                    roots = [*entry.root.glob("systems/*/pages"), *entry.root.glob("pages/*")]
                else:
                    roots = []
                for root in roots:
                    for path in catalog.working_copy_files(root):
                        candidates.add(logical_path_for_entry(entry, path.relative_to(entry.root).as_posix()))

        # A changed or deleted physical product layer changes its child projection.
        for path in list(candidates):
            if path.casefold().endswith(".inherit.gss"):
                child = path[:-len(".inherit.gss")] + ".gss"
                if resolve_authorized_path(scope, child)[1].is_file():
                    candidates.add(child)

        # Check conflicts before deleting anything; missing files from a successful
        # clean update are deletions, but conflicted/missing local files are not.
        grouped = {}
        for logical in sorted(candidates):
            checkpoint()
            entry, path, relative = resolve_authorized_path(scope, logical)
            changes = changes_by_entry.get(entry.id, {})
            for changed_path, change in changes.items():
                if relative == changed_path or relative.startswith(changed_path.rstrip("/") + "/") or changed_path == ".":
                    if not _status_allows_indexing(change):
                        result["errors"].append({"path": logical, "error": "unsupported local SVN state after update"})
            if path.is_file() and catalog.source_file_supported(entry, path):
                grouped.setdefault(entry.id, (entry, []))[1].append((logical, path, relative))

        objects = []
        for entry, files in grouped.values():
            changes = changes_by_entry.get(entry.id, {})
            for start in range(0, len(files), 100):
                checkpoint()
                batch = files[start:start + 100]
                progress(f"读取变更文件版本 · 本批 {len(batch)} 个文件")
                revisions = catalog._revision_map(entry.root, [path for _logical, path, _relative in batch])
                for logical, path, _relative in batch:
                    checkpoint()
                    try:
                        item = catalog._object_for_file(entry, path, revisions, changes)
                        if item:
                            if item["status"] == "IDENTITY_MISMATCH":
                                raise ValueError("Source header identity does not match its authorized path")
                            objects.append(item)
                    except OperationCancelled:
                        raise
                    except (Exception, SystemExit) as error:
                        code = ("SOURCE_PARSE_FAILED" if isinstance(error, (json.JSONDecodeError, UnicodeError))
                                else "SOURCE_READ_RETRYABLE" if isinstance(error, OSError) and not isinstance(error, PermissionError)
                                else "SOURCE_INDEX_BLOCKED")
                        result["errors"].append({"path": logical, "error": str(error), "code": code})
                    result["scannedFiles"] += 1
                progress(f"已核对 {result['scannedFiles']} 个变更及关联文件")

        # Include the currently indexed winner when a changed PAGE competes with it.
        collisions = {}
        for item in objects:
            if item["source_table"] != "page":
                continue
            rows = conn.execute(
                "SELECT * FROM gusen_source_record WHERE provider='svn' AND source_table='page' "
                "AND source_id=? AND fun_id=?",
                (item["source_id"], item.get("fun_id") or ""),
            ).fetchall()
            for row in rows:
                if row["source_path"] not in candidates:
                    collisions[row["source_path"]] = dict(row)
        for logical, row in collisions.items():
            scanned = catalog.scan_file(workspace, logical)
            result["scannedFiles"] += 1
            result["errors"].extend(scanned["errors"])
            if scanned["object"]:
                objects.append(scanned["object"])
            candidates.add(logical)
            existing[logical] = row
        objects, result["ignored"] = resolve_page_duplicates(objects)
        identities = set()
        for item in objects:
            identity = (item["source_namespace"], item["source_table"], item["source_id"], item.get("fun_id") or "")
            if identity in identities:
                result["errors"].append({"path": item["source_path"], "error": "duplicate object identity"})
            identities.add(identity)
            collision = conn.execute(
                "SELECT source_path FROM gusen_source_record WHERE provider='svn' AND source_namespace=? "
                "AND source_table=? AND source_id=? AND fun_id=?", identity,
            ).fetchone()
            if collision and collision["source_path"] not in candidates:
                result["errors"].append({"path": item["source_path"], "error": "identity already indexed at another path"})
        if result["errors"]:
            result.update(failures=len(result["errors"]), indexPreserved=True)
            return result

        if not objects and not existing:
            progress("无源码内容变化，跳过索引写入")
            return result
        progress(f"批量发布 · 涉及路径 {len(candidates)} 个 · 解析对象 {len(objects)} 个")
        try:
            conn.execute("BEGIN IMMEDIATE")
            for logical in sorted(candidates):
                checkpoint()
                entry, target, _relative = resolve_authorized_path(scope, logical)
                rows = conn.execute(
                    "SELECT * FROM gusen_source_record WHERE provider='svn' AND scope_entry_id=? AND source_path=?",
                    (entry.id, logical),
                ).fetchall()
                for row in rows:
                    hub._delete_svn_index_item(conn, workspace, row)
                    if not target.is_file():
                        result["deleted"] += 1
            indexed_time = hub._now()
            for item in objects:
                checkpoint()
                hub._insert_svn_index_item(conn, workspace, item, indexed_time)
            hub._advance_page_semantic_generation(conn)
            publication_barrier()
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        result["changed"] = len(objects)
        result["paths"] = sorted(candidates)
        progress(f"增量索引完成 · 更新对象 {len(objects)} 个 · 删除对象 {result['deleted']} 个")
        return result

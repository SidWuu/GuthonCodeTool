"""Inspect and refresh eligible physical SVN sources after an external edit."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import xml.etree.ElementTree as ET

from common import legacy_source, source_facts
from common.source_format import decode_source
from providers.svn.checkout import (
    file_hash, operation_lock, require_capability, run_svn, run_svn_binary,
    svn_info, svn_path_changes, svn_scm_status_lightweight,
)
from providers.svn.nexus import catalog, edit_sessions, incremental
from providers.svn.nexus.manifest import (
    load_authorized_scope, logical_path_for_entry, source_path_writable, source_relative_path,
)
from providers.svn.nexus.procedure_sources import source_index_status
from providers.svn.nexus.workspace import _validate_existing


def index_item_current(conn, previous: dict, item: dict) -> bool:
    """Compare the indexed source and its derived fragments with the current scan."""
    fields = ("source_hash", "status", "svn_revision", "change_key", "source_alias_id",
              "source_name", "system_id", "data_source_id")
    if any((previous.get(key) or "") != (item.get(key) or "") for key in fields):
        return False
    fragments = conn.execute(
        "SELECT json_pointer, fragment_type, content_hash, origin_map_json "
        "FROM gusen_source_fragment WHERE source_record_id=?", (previous["record_id"],),
    ).fetchall()
    actual = {(row["json_pointer"], row["fragment_type"]): (row["content_hash"], row["origin_map_json"])
              for row in fragments}
    expected = {}
    for script in item.get("scripts") or []:
        pointer = str(script.get("json_path") or "")
        kind = source_facts._fragment_type(str(script.get("script_type") or ""), pointer)
        content = str(script.get("content") or "")
        origin_map = json.dumps(script.get("originMap") or [], ensure_ascii=False, separators=(",", ":"))
        expected[(pointer, kind)] = (hashlib.sha256(content.encode("utf-8")).hexdigest(), origin_map)
    return actual == expected


def inspect_file(workspace: dict, path: Path, *, refresh: bool) -> dict:
    """Verify one indexed physical source and optionally refresh its SVN index."""
    for capability in ("browse", "status", "reindex", "edit"):
        require_capability(workspace, capability)
    if workspace["svn"].get("checkoutLayout") == "legacy-sparse":
        from providers.svn import legacy_direct_edit

        return legacy_direct_edit.inspect_file(workspace, path, refresh=refresh)
    if workspace["svn"].get("checkoutLayout") != "manifest-working-copies":
        raise ValueError("SVN 工作区检出布局不支持直接编辑")

    with operation_lock(workspace, "direct-edit-inspect", blocking=True):
        scope = load_authorized_scope(workspace)
        matches = [entry for entry in scope.entries if path.is_relative_to(entry.root)]
        if len(matches) != 1:
            raise ValueError("SVN 路径不在授权工作副本中，或匹配到多个授权工作副本")
        entry = matches[0]
        relative = path.relative_to(entry.root).as_posix()
        logical = logical_path_for_entry(entry, relative)
        if path.suffix.lower() not in {".js", ".gss", ".vm", ".java", ".sql", ".css"}:
            raise ValueError("SVN 结构化源码不支持直接编辑")
        if not source_path_writable(entry, relative):
            raise ValueError("SVN 源码路径不可写，或属于继承层、结构化源码")
        if not catalog.source_file_supported(entry, path):
            raise ValueError("SVN 源码路径不受当前源码索引支持")
        _validate_existing(entry)
        info = ET.fromstring(run_svn(["info", "--xml", "--", str(path)]).stdout).find("entry")
        if (info is None or info.get("kind") != "file" or not info.get("revision")
                or Path(info.findtext("wc-info/wcroot-abspath") or "").resolve() != entry.root.resolve()):
            raise ValueError("SVN 源码不是授权工作副本中具有 BASE 版本的受版本控制文件")

        target_changes = []
        for candidate in (entry.root, *reversed(path.relative_to(entry.root).parents), path):
            target = candidate if candidate.is_absolute() else entry.root / candidate
            changes = svn_path_changes(entry.root, target)
            if target == path:
                target_changes = changes
            for change in changes:
                block = catalog.svn_state_block(change)
                if block or change.get("copied"):
                    raise ValueError(f"SVN 源码或上级目录存在不可编辑的工作副本状态 {change['path']}: {block[1] if block else '已复制'}")
        base = run_svn_binary(["cat", "-r", "BASE", "--", str(path)]).stdout
        digest = file_hash(path)
        modified = any(change["path"] == relative and change["item"] == "modified" for change in target_changes)
        session = edit_sessions.load_session(workspace)
        if any(document.get("sourcePath") == logical and not document.get("invalidatedReason")
               for document in session["documents"].values()):
            raise ValueError("SVN 源码存在活动的 Nexus 编辑租约，请先关闭编辑器")
        health = source_index_status(workspace)
        if health["buildStatus"] not in {"READY", "PARTIAL"}:
            raise ValueError("SVN 源码索引不可用或需要重建")
        with legacy_source.index_connection(workspace, action="direct-edit-index", readonly=True) as conn:
            rows = conn.execute(
                "SELECT * FROM gusen_source_record WHERE provider='svn' AND scope_id=? "
                "AND scope_entry_id=? AND source_path=?", (workspace["scopeId"], entry.id, logical),
            ).fetchall()
            if len(rows) != 1 or rows[0]["status"] not in {"OK", "SVN_DIRTY"}:
                raise ValueError("SVN 源码没有唯一且可用的索引身份")
            previous = dict(rows[0])
            if Path(previous["local_path"]).resolve() != path:
                raise ValueError("SVN 索引中的物理路径与授权源码不一致")
            scanned = catalog.scan_file(workspace, logical)
            item = scanned["object"]
            if scanned["errors"] or not item or item["status"] not in {"OK", "SVN_DIRTY"}:
                raise ValueError(f"SVN 源码无法索引： {scanned['errors'] or (item or {}).get('status')}")
            if item["source_hash"] != digest:
                raise ValueError("SVN 源码在检查期间发生变化")
            identity = ("source_namespace", "working_copy_id", "source_table", "source_id", "fun_id")
            if any((previous.get(key) or "") != (item.get(key) or "") for key in identity):
                raise ValueError("SVN 源码身份与索引身份不一致")
            if path.suffix.lower() == ".gss" and item["source_table"] in {"page", "procedure"}:
                header = catalog.header_fields(decode_source(base)[0])
                if item["source_table"] == "page":
                    base_identity = header.get("pageId") or path.stem
                else:
                    source_path = source_relative_path(entry, relative).with_suffix("")
                    package = header.get("packageId") or ".".join(source_path.parts[:-1])
                    function = header.get("functionId") or source_path.name
                    base_identity = f"{package}#{function}"
                if item["source_id"] != base_identity:
                    raise ValueError("SVN 源码身份与 BASE 版本不一致")
            current = index_item_current(conn, previous, item)
        if refresh:
            if not current:
                with legacy_source.index_connection(workspace, action="direct-edit-index", readonly=False) as conn:
                    status = svn_scm_status_lightweight(entry.root)
                    outcome = incremental.index_changes(conn, workspace, [logical], {
                        "updated": [{"id": entry.id, "after": status}],
                    })
                if outcome["failures"] or outcome["blocked"] or outcome["ignored"]:
                    raise ValueError(f"SVN 源码索引刷新失败： {outcome}")
            with legacy_source.index_connection(workspace, action="direct-edit-index", readonly=True) as conn:
                rows = conn.execute(
                    "SELECT * FROM gusen_source_record WHERE provider='svn' AND scope_id=? "
                    "AND scope_entry_id=? AND source_path=?", (workspace["scopeId"], entry.id, logical),
                ).fetchall()
                if (len(rows) != 1 or rows[0]["source_hash"] != digest
                        or not index_item_current(conn, dict(rows[0]), item)):
                    raise ValueError("SVN 刷新后的索引与当前源码哈希不一致")
            run_svn_binary(["diff", "--", str(path)])
        if file_hash(path) != digest:
            raise ValueError("SVN 源码在检查或索引核验期间发生变化")
        result = {"sourceHash": digest, "modified": modified}
        if refresh:
            result["indexedHash"] = digest
        return result


def changed_files(workspace: dict) -> dict[str, str]:
    """Return local SVN changes, including paths absent from the source catalog."""
    if workspace.get("sourceMode") != "svn" or not workspace.get("capabilities", {}).get("svn.status"):
        return {}
    settings = workspace.get("svn", {})
    layout = settings.get("checkoutLayout")
    if layout == "manifest-working-copies":
        manifest = settings.get("scopeManifestPath")
        if not isinstance(manifest, Path) or not manifest.is_file():
            return {}
        entries = [(entry.root, entry) for entry in load_authorized_scope(workspace).entries]
    elif layout == "legacy-sparse":
        entries = [(workspace["checkoutPath"], None)]
    else:
        return {}
    result = {}
    for root, entry in entries:
        if not (root / ".svn").is_dir():
            continue
        if entry:
            _validate_existing(entry)
        elif svn_info(root)["url"] != settings.get("repositoryUrl", "").rstrip("/"):
            raise ValueError("SVN 工作副本地址与配置的仓库地址不一致")
        for change in svn_scm_status_lightweight(root)["changes"]:
            path = root / change["path"]
            if not path.is_relative_to(root):
                raise ValueError("SVN 状态路径超出授权工作副本")
            paths = [path]
            if change["item"] == "unversioned" and path.is_dir() and not path.is_symlink():
                for directory, children, files in os.walk(path, followlinks=False):
                    children[:] = [name for name in children if name != ".svn" and not (Path(directory) / name).is_symlink()]
                    paths.extend(Path(directory) / name for name in files)
            for changed_path in paths:
                digest = file_hash(changed_path) if changed_path.is_file() and not changed_path.is_symlink() else ""
                stamp = json.dumps({"status": change, "sha256": digest}, sort_keys=True, ensure_ascii=False)
                result[str(changed_path)] = hashlib.sha256(stamp.encode("utf-8")).hexdigest()
    return result

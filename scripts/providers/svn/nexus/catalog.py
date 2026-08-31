"""Scan authorized SVN working copies into Nexus source objects and modules."""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from common.page_projection import extract_page_fields, extract_page_scripts
from common.source_format import decode_source
from providers.svn.checkout import file_hash, run_svn, svn_path_changes, svn_status

from .manifest import (
    ScopeEntry,
    load_authorized_scope,
    scope_entry_label,
    source_category,
    source_path_writable,
    source_relative_path,
)


HEADER_FIELD = re.compile(r"(?m)^\s*\*\s*@(?P<key>[A-Za-z]+)\s+(?P<value>.*?)\s*$")
TEXT_SUFFIXES = {".gss", ".js", ".vm", ".sql"}
GENERIC_TEXT_SUFFIXES = {*TEXT_SUFFIXES, ".json", ".md", ".txt", ".yaml", ".yml"}


def header_fields(text: str) -> dict[str, str]:
    return {match.group("key"): match.group("value").strip() for match in HEADER_FIELD.finditer(text[:8192])}


def _decode_json(text: str):
    data = json.loads(text)
    if isinstance(data, str):
        return json.loads(data), True
    return data, False


def _revision_map(root: Path) -> dict[str, str]:
    result = run_svn(["info", "-R", "--xml", str(root)])
    document = ET.fromstring(result.stdout)
    revisions = {}
    for node in document.findall("entry"):
        raw = Path(node.get("path") or "")
        try:
            relative = raw.resolve().relative_to(root.resolve()).as_posix()
        except ValueError:
            continue
        revisions[relative] = node.get("revision") or ""
    return revisions


def _file_revision(path: Path) -> str:
    result = run_svn(["info", "--xml", str(path)])
    entry = ET.fromstring(result.stdout).find("entry")
    return entry.get("revision") if entry is not None else ""


def _logical_path(entry: ScopeEntry, path: Path) -> str:
    relative = path.resolve().relative_to(entry.root.resolve()).as_posix()
    return f"{entry.local_subdir}/{relative}" if relative != "." else entry.local_subdir


def _base_object(entry: ScopeEntry, path: Path, source_table: str, revisions: dict, changes: dict) -> dict:
    relative = path.resolve().relative_to(entry.root.resolve()).as_posix()
    digest = file_hash(path)
    revision = revisions.get(relative, "")
    logical_path = _logical_path(entry, path)
    return {
        "provider": "svn",
        "working_copy_id": entry.id,
        "scope_entry_id": entry.id,
        "source_table": source_table,
        "source_path": logical_path,
        "local_path": str(path.resolve()),
        "source_hash": digest,
        "svn_revision": revision,
        "change_key": f"svn:{revision}:{digest}",
        "status": "SVN_DIRTY" if relative in changes else "OK",
        "scripts": [],
    }


def _identity_from_subdir(entry: ScopeEntry) -> str:
    return Path(entry.local_subdir).name


def _page_object(entry: ScopeEntry, path: Path, revisions: dict, changes: dict) -> dict:
    result = _base_object(entry, path, "page", revisions, changes)
    system_id = _identity_from_subdir(entry)
    if path.suffix.lower() == ".gss":
        text = decode_source(path.read_bytes())[0]
        header = header_fields(text)
        page_id = header.get("pageId") or path.stem
        result.update(
            source_id=page_id,
            source_alias_id=header.get("pageAliasId") or path.stem,
            fun_id="",
            source_name=header.get("pageName") or path.stem,
            system_id=system_id,
            data_source_id="",
            scripts=[{"script_type": "gss", "json_path": "", "content": text}],
        )
        return result
    raw = decode_source(path.read_bytes())[0]
    data, double_encoded = _decode_json(raw)
    if not isinstance(data, dict):
        raise ValueError("PAGE JSON root must be an object")
    page_id = str(data.get("pageId") or path.stem)
    result.update(
        source_id=page_id,
        source_alias_id=str(data.get("pageAliasId") or page_id),
        fun_id="",
        source_name=str(data.get("pageName") or page_id),
        system_id=system_id,
        data_source_id="",
        double_encoded=double_encoded,
        scripts=[
            *[
                {
                    "script_type": field.key,
                    "json_path": field.json_pointer,
                    "content": field.effective_value,
                    "label": field.display_name,
                }
                for field in extract_page_scripts(data)
            ],
            *[
                {
                    "script_type": field["script_type"],
                    "json_path": field["json_pointer"],
                    "content": field["content"],
                    "label": field["label"],
                }
                for field in extract_page_fields(data)
            ],
        ],
    )
    if page_id != path.stem and not path.stem.startswith("SYS-"):
        result["status"] = "IDENTITY_MISMATCH"
    return result


def _procedure_object(entry: ScopeEntry, path: Path, revisions: dict, changes: dict) -> dict:
    result = _base_object(entry, path, "procedure", revisions, changes)
    text = decode_source(path.read_bytes())[0]
    header = header_fields(text)
    relative = source_relative_path(entry, path.relative_to(entry.root)).with_suffix("")
    package = header.get("packageId") or ".".join(relative.parts[:-1])
    function_id = header.get("functionId") or relative.name
    result.update(
        source_id=f"{package}#{function_id}",
        source_alias_id=package,
        fun_id=function_id,
        source_name=header.get("description") or function_id,
        system_id="",
        data_source_id=_identity_from_subdir(entry),
        scripts=[{"script_type": "procedure_script", "json_path": "", "content": text}],
    )
    if function_id != relative.name:
        result["status"] = "IDENTITY_MISMATCH"
    return result


def _system_script_object(entry: ScopeEntry, path: Path, revisions: dict, changes: dict) -> dict:
    result = _base_object(entry, path, "system-script", revisions, changes)
    text = decode_source(path.read_bytes())[0]
    system_id = _identity_from_subdir(entry)
    result.update(
        source_id=f"{system_id}#{path.stem}",
        source_alias_id=system_id,
        fun_id=path.stem,
        source_name=path.name,
        system_id=system_id,
        data_source_id="",
        scripts=[{"script_type": "system_script", "json_path": "", "content": text}],
    )
    return result


def _metadata_object(
    entry: ScopeEntry,
    path: Path,
    revisions: dict,
    changes: dict,
    category: str,
) -> dict:
    kind = "table" if category == "tables" else "view"
    result = _base_object(entry, path, kind, revisions, changes)
    data = json.loads(decode_source(path.read_bytes())[0])
    id_key = "tableId" if kind == "table" else "viewId"
    name_key = "tableName" if kind == "table" else "viewName"
    source_id = str(data.get(id_key) or path.stem)
    result.update(
        source_id=source_id,
        source_alias_id=source_id,
        fun_id="",
        source_name=str(data.get(name_key) or source_id),
        system_id="",
        data_source_id=_identity_from_subdir(entry),
        scripts=(
            [{"script_type": "view_sql", "json_path": "/viewSql", "content": data.get("viewSql") or ""}]
            if kind == "view" and isinstance(data.get("viewSql"), str)
            else []
        ),
    )
    if source_id != path.stem:
        result["status"] = "IDENTITY_MISMATCH"
    return result


def _generic_read_only_object(entry: ScopeEntry, path: Path, revisions: dict, changes: dict) -> dict:
    result = _base_object(entry, path, entry.category, revisions, changes)
    relative = path.relative_to(entry.root).as_posix()
    result.update(
        source_id=f"{entry.id}:{relative}",
        source_alias_id=entry.id,
        fun_id="",
        source_name=path.name,
        system_id="",
        data_source_id="",
        scripts=[],
    )
    return result


def _object_for_file(entry: ScopeEntry, path: Path, revisions: dict, changes: dict) -> dict | None:
    relative = path.relative_to(entry.root)
    category = source_category(entry, relative)
    suffix = path.suffix.lower()
    if category == "pages" and suffix in {".json", ".gss"}:
        return _page_object(entry, path, revisions, changes)
    if category == "procedures" and suffix == ".gss":
        return _procedure_object(entry, path, revisions, changes)
    if category == "system-script" and suffix in TEXT_SUFFIXES:
        return _system_script_object(entry, path, revisions, changes)
    if category in {"tables", "views"} and suffix == ".json":
        return _metadata_object(entry, path, revisions, changes, category)
    if entry.category in {"skill", "public"} and suffix in GENERIC_TEXT_SUFFIXES:
        return _generic_read_only_object(entry, path, revisions, changes)
    return None


def scan(
    workspace: dict,
    *,
    on_object=None,
    collect_objects: bool = True,
    collect_modules: bool = True,
    on_progress=None,
) -> dict:
    """Read authorized files; optionally stream each parsed object to an index writer."""

    scope = load_authorized_scope(workspace)
    objects = []
    modules = []
    errors = []
    status_records = []
    revisions = []
    counts = {}
    identities = {}
    total = len(scope.entries)
    for index, entry in enumerate(scope.entries, 1):
        label = scope_entry_label(workspace, entry)
        if on_progress is not None:
            on_progress(f"[{index}/{total}] {label}｜索引｜扫描 working copy")
        before_count = sum(counts.values())
        before_errors = len(errors)
        if not (entry.root / ".svn").is_dir():
            errors.append({"scopeEntryId": entry.id, "path": entry.local_subdir, "error": "missing working copy"})
            if on_progress is not None:
                on_progress(f"[{index}/{total}] {label}｜索引｜失败 · working copy 不存在")
            continue
        if on_progress is not None:
            on_progress(f"[{index}/{total}] {label}｜索引｜读取 SVN 状态")
        current = svn_status(entry.root)
        status_records.append({"id": entry.id, "status": current})
        revisions.append(f"{entry.id}:{current.get('revision') or ''}")
        if on_progress is not None:
            on_progress(
                f"[{index}/{total}] {label}｜索引｜读取 SVN 版本 · "
                f"r{current.get('revision') or '-'} · 文件变更 {len(current.get('changes') or [])}"
            )
            on_progress(f"[{index}/{total}] {label}｜索引｜读取文件版本信息")
        revision_map = _revision_map(entry.root)
        change_map = {change["path"]: change for change in current.get("changes") or []}
        if on_progress is not None:
            on_progress(f"[{index}/{total}] {label}｜索引｜解析授权文件")
        for path in sorted(entry.root.rglob("*")):
            if not path.is_file() or ".svn" in path.parts:
                continue
            relative = path.relative_to(entry.root).as_posix()
            logical_category = source_category(entry, relative) or entry.category
            if collect_modules:
                modules.append(
                    {
                        "scopeEntryId": entry.id,
                        "workingCopyId": entry.id,
                        "category": logical_category,
                        "path": _logical_path(entry, path),
                        "relativePath": relative,
                        "writable": source_path_writable(entry, relative),
                        "status": "SVN_DIRTY" if relative in change_map else "OK",
                    }
                )
            try:
                item = _object_for_file(entry, path, revision_map, change_map)
                if item:
                    counts[item["source_table"]] = counts.get(item["source_table"], 0) + 1
                    identity = (item["source_table"], item["source_id"], item.get("fun_id") or "")
                    previous = identities.get(identity)
                    if previous:
                        previous_path = previous["source_path"] if isinstance(previous, dict) else previous
                        item["status"] = "IDENTITY_AMBIGUOUS"
                        if isinstance(previous, dict):
                            previous["status"] = "IDENTITY_AMBIGUOUS"
                        errors.append(
                            {
                                "scopeEntryId": item["scope_entry_id"],
                                "path": item["source_path"],
                                "error": f"duplicate object identity also used by {previous_path}",
                            }
                        )
                    else:
                        identities[identity] = item if collect_objects else item["source_path"]
                    if collect_objects:
                        objects.append(item)
                    if on_object is not None:
                        on_object(item)
            except Exception as error:
                errors.append(
                    {"scopeEntryId": entry.id, "path": _logical_path(entry, path), "error": str(error)}
                )
        if on_progress is not None:
            on_progress(
                f"[{index}/{total}] {label}｜索引｜完成 · "
                f"对象 {sum(counts.values()) - before_count} · 错误 {len(errors) - before_errors}"
            )

    all_changes = [
        {"workingCopyId": record["id"], **change}
        for record in status_records
        for change in record["status"].get("changes") or []
    ]
    return {
        "provider": "svn",
        "checkoutLayout": "manifest-working-copies",
        "workspaceKey": workspace["workspaceKey"],
        "revision": ",".join(revisions),
        "status": {"clean": not all_changes, "changes": all_changes, "workingCopies": status_records},
        "objects": objects,
        "modules": modules,
        "counts": counts,
        "errors": errors,
    }


def scan_file(workspace: dict, logical_path: str) -> dict:
    """Scan one exact authorized physical file for incremental index updates."""

    scope = load_authorized_scope(workspace)
    normalized = Path(str(logical_path or "").replace("\\", "/")).as_posix().lstrip("/")
    matches = []
    for entry in scope.entries:
        prefix = entry.local_subdir
        if normalized.startswith(prefix + "/"):
            relative = normalized[len(prefix) + 1:]
            target = (entry.root / relative).resolve()
            if entry.root.resolve() in target.parents:
                matches.append((entry, target, relative))
    if len(matches) != 1:
        raise SystemExit(f"Incremental SVN index path is outside or ambiguous in scope: {logical_path}")
    entry, path, relative = matches[0]
    if not path.is_file():
        return {
            "object": None,
            "path": normalized,
            "errors": [{"scopeEntryId": entry.id, "path": normalized, "error": "authorized source file is missing"}],
        }
    changes = {change["path"]: change for change in svn_path_changes(entry.root, path)}
    revisions = {relative: _file_revision(path)}
    change = changes.get(relative)
    if change and change.get("item") not in {"modified", "normal", "none", ""}:
        return {
            "object": None,
            "path": normalized,
            "errors": [
                {
                    "scopeEntryId": entry.id,
                    "path": normalized,
                    "error": f"unsupported SVN state for indexing: {change.get('item')}",
                }
            ],
        }
    try:
        item = _object_for_file(entry, path, revisions, changes)
        return {"object": item, "path": normalized, "errors": []}
    except Exception as error:
        return {
            "object": None,
            "path": normalized,
            "errors": [{"scopeEntryId": entry.id, "path": normalized, "error": str(error)}],
        }

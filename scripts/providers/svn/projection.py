"""Lazy projection of one indexed SVN object into an editable Workcopy."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from pathlib import Path

from common.page_projection import extract_page_scripts, text_hash
from common.source_format import decode_source, encode_source
from providers.svn.checkout import atomic_json, file_hash, operation_lock, verify_repository_fingerprint


META_VERSION = 1
META_FILE = "source-meta.json"


def _part(value: str) -> str:
    value = re.sub(r"[<>:\"/\\|?*\x00-\x1f]", "_", str(value or "")).strip(" .")
    return value[:180] or "unknown"


def _dict(row) -> dict:
    return dict(row) if not isinstance(row, dict) else row


def _sha_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _atomic_bytes(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(value)
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def source_text(data: bytes) -> tuple[str, dict]:
    return decode_source(data)


def encode_source_text(text: str, format_info: dict) -> bytes:
    return encode_source(text, format_info)


def projection_file(target: Path, value: str, *, label="projection") -> Path:
    """Resolve a generated Workcopy-relative file without following symlinks."""

    target = target.resolve()
    relative = Path(str(value or ""))
    if relative.is_absolute() or not relative.parts or ".." in relative.parts:
        raise SystemExit(f"Unsafe SVN Workcopy {label} path: {value}")
    candidate = target / relative
    resolved = candidate.resolve()
    components = []
    component = candidate
    while component != target and target in component.parents:
        components.append(component)
        component = component.parent
    if target not in resolved.parents or any(path.is_symlink() for path in components):
        raise SystemExit(f"Unsafe SVN Workcopy {label} path: {value}")
    if relative.as_posix() == META_FILE:
        raise SystemExit(f"SVN Workcopy {label} must not target {META_FILE}")
    return candidate


def _target_path(workspace: dict, row: dict, scope: dict) -> Path:
    system_id = row.get("system_id") or ""
    data_source_id = row.get("data_source_id") or ""
    system_name = (scope.get("systemNames") or {}).get(system_id)
    if not system_name:
        system_name = (scope.get("systemNamesByDataSource") or {}).get(data_source_id)
    system_name = system_name or (f"data-source-{data_source_id}" if data_source_id else system_id or "未解析系统")
    root = workspace["workcopyDir"] / _part(system_name)
    source_table = row["source_table"]
    if source_table == "procedure":
        return root / "procedure" / _part(row["source_alias_id"]) / _part(row["fun_id"])
    if source_table == "page":
        return root / "page" / _part(f"{row.get('source_name') or row['source_alias_id']} {row['source_id']}")
    if source_table == "system-script":
        return root / "system-script" / _part(system_id) / _part(row["fun_id"])
    return root / source_table / _part(row["source_id"])


def _projection_changes(target: Path, meta: dict) -> list[str]:
    changes = []
    for mapping in meta.get("mappings") or []:
        path = projection_file(target, mapping.get("projectionPath") or "")
        current = file_hash(path) if path.is_file() else ""
        if current != mapping.get("projectionHash"):
            changes.append(mapping["projectionPath"])
    raw = meta.get("rawSnapshot")
    if raw:
        path = projection_file(target, raw, label="raw snapshot")
        current = file_hash(path) if path.is_file() else ""
        if current != meta.get("rawSnapshotHash"):
            changes.append(raw)
    return changes


def inspect_projection(path: Path) -> tuple[Path, dict, list[str]]:
    target = path.resolve()
    while target.parent != target and not (target / META_FILE).is_file():
        target = target.parent
    if not (target / META_FILE).is_file():
        raise SystemExit(f"Missing SVN Workcopy metadata: {path}")
    try:
        meta = json.loads((target / META_FILE).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Invalid SVN Workcopy metadata: {target / META_FILE}") from error
    if meta.get("version") != META_VERSION or meta.get("provider") != "svn":
        raise SystemExit(f"Unsupported SVN Workcopy metadata: {target / META_FILE}")
    return target, meta, _projection_changes(target, meta)


def _open_workcopy(workspace: dict, row, scope: dict) -> dict:
    row = _dict(row)
    verify_repository_fingerprint(workspace, scope.get("repositoryFingerprint") or "")
    if row.get("status") not in {"OK", "SVN_DIRTY"}:
        raise SystemExit(f"SVN object is not safe to project: {row.get('status') or 'UNKNOWN'}")
    checkout_path = workspace["checkoutPath"].resolve()
    relative = Path(row.get("source_path") or row.get("local_path") or "")
    if relative.is_absolute() or ".." in relative.parts or not relative.parts:
        raise SystemExit(f"Indexed SVN source path is invalid: {relative}")
    candidate = checkout_path / relative
    source_path = candidate.resolve()
    components = []
    component = candidate
    while component != checkout_path and checkout_path in component.parents:
        components.append(component)
        component = component.parent
    if checkout_path not in source_path.parents or any(path.is_symlink() for path in components) or not source_path.is_file():
        raise SystemExit(f"Indexed SVN source path is invalid: {relative}")
    source_bytes = source_path.read_bytes()
    current_hash = _sha_bytes(source_bytes)
    if current_hash != row.get("source_hash"):
        raise SystemExit("SVN source changed after indexing; reindex before opening Workcopy")
    target = _target_path(workspace, row, scope)
    existed = (target / META_FILE).is_file()
    if target.exists() and not (target / META_FILE).is_file():
        raise SystemExit(f"Refusing to overwrite unmanaged Workcopy directory: {target}")
    if (target / META_FILE).is_file():
        _old_target, old, local_changes = inspect_projection(target)
        if local_changes:
            return {
                "ok": True,
                "path": str(target),
                "state": "UPSTREAM_CHANGED" if old.get("sourceHash") != current_hash else "LOCAL_CHANGED",
                "action": "PRESERVED",
                "localChanged": True,
                "localChanges": local_changes,
            }
        for old_mapping in old.get("mappings") or []:
            old_path = projection_file(target, old_mapping.get("projectionPath") or "")
            if old_path.is_file():
                old_path.unlink()
    target.mkdir(parents=True, exist_ok=True)
    text, format_info = source_text(source_bytes)
    mappings = []
    source_table = row["source_table"]
    raw_snapshot = ""
    double_encoded = False
    if source_table == "page" and source_path.suffix.lower() == ".json":
        data = json.loads(text)
        if isinstance(data, str):
            data = json.loads(data)
            double_encoded = True
        raw_snapshot = "raw.json"
        _atomic_bytes(target / raw_snapshot, source_bytes)
        scripts_dir = target / "scripts"
        scripts_dir.mkdir(exist_ok=True)
        for field in extract_page_scripts(data):
            projection_path = Path("scripts") / field.projection_name
            content = field.original_value.encode("utf-8")
            _atomic_bytes(target / projection_path, content)
            mappings.append(
                {
                    "projectionPath": projection_path.as_posix(),
                    "jsonPointer": field.json_pointer,
                    "key": field.key,
                    "scriptType": field.script_type,
                    "originalValue": field.original_value,
                    "originalHash": text_hash(field.original_value),
                    "effectiveHash": text_hash(field.effective_value),
                    "projectionHash": _sha_bytes(content),
                }
            )
    else:
        if source_table in {"table", "view"}:
            extension = ".json"
        elif source_table == "system-script" and source_path.suffix.lower() in {".js", ".vm", ".sql"}:
            extension = source_path.suffix.lower()
        else:
            extension = ".vm"
        projection_path = f"source{extension}"
        _atomic_bytes(target / projection_path, text.encode("utf-8"))
        mappings.append(
            {
                "projectionPath": projection_path,
                "jsonPointer": "",
                "key": "source",
                "scriptType": source_table,
                "originalHash": text_hash(text),
                "projectionHash": file_hash(target / projection_path),
            }
        )
    writable = source_table in {"page", "procedure", "system-script"} and not double_encoded
    meta = {
        "version": META_VERSION,
        "provider": "svn",
        "workspaceKey": workspace["workspaceKey"],
        "sourceTable": source_table,
        "sourceId": row["source_id"],
        "sourceAliasId": row["source_alias_id"],
        "funId": row.get("fun_id") or "",
        "systemId": row.get("system_id") or "",
        "dataSourceId": row.get("data_source_id") or "",
        "checkoutPath": str(checkout_path),
        "repositoryFingerprint": scope.get("repositoryFingerprint") or "",
        "repositoryUrl": (scope.get("repository") or {}).get("url") or "",
        "repositoryUuid": (scope.get("repository") or {}).get("repositoryUuid") or "",
        "svnPath": relative.as_posix(),
        "svnRevision": row.get("svn_revision") or scope.get("revision") or "",
        "sourceHash": current_hash,
        "format": format_info,
        "rawSnapshot": raw_snapshot,
        "rawSnapshotHash": file_hash(target / raw_snapshot) if raw_snapshot else "",
        "doubleEncoded": double_encoded,
        "writable": writable,
        "mappings": mappings,
    }
    atomic_json(target / META_FILE, meta)
    return {
        "ok": True,
        "path": str(target),
        "state": "CLEAN",
        "action": "REFRESHED" if existed else "CREATED",
        "localChanged": False,
        "writable": writable,
    }


def open_workcopy(workspace: dict, row, scope: dict) -> dict:
    with operation_lock(workspace, "workcopy-open", shared=True):
        return _open_workcopy(workspace, row, scope)

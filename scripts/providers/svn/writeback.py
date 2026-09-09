"""The sole SVN provider entry allowed to edit checked-out Guthon source files."""

from __future__ import annotations

import copy
import datetime as dt
import difflib
import hashlib
import json
import os
import stat
import tempfile
from pathlib import Path

from common.page_projection import pointer_value, replace_json_strings, text_hash
from common.source_format import encode_source_exact, merge_preserving_generated_header, read_projection
from providers.svn.checkout import (
    EXPECTED_WRITEBACK_FILE,
    atomic_json,
    file_hash,
    operation_lock,
    load_scope,
    require_capability,
    run_svn,
    svn_status,
    verify_repository_fingerprint,
)
from providers.svn.projection import (
    META_FILE,
    encode_source_text,
    inspect_projection,
    projection_file,
    source_text,
)


AUDIT_FILE = "svn-writeback.ndjson"
WRITABLE_ROOTS = {"pages", "procedures", "system-script"}
SOURCE_ROOTS = {"page": "pages", "procedure": "procedures", "system-script": "system-script"}


def _sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _atomic_bytes(path: Path, value: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".guthon-writeback", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_name, mode)
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def _atomic_source_write(path: Path, value: bytes) -> None:
    _atomic_bytes(path, value, stat.S_IMODE(path.stat().st_mode))


def _snapshot(path: Path) -> dict:
    if not path.is_file():
        return {"exists": False, "data": b"", "mode": 0o600}
    return {
        "exists": True,
        "data": path.read_bytes(),
        "mode": stat.S_IMODE(path.stat().st_mode),
    }


def _restore_snapshot(path: Path, snapshot: dict) -> None:
    if snapshot["exists"]:
        _atomic_bytes(path, snapshot["data"], snapshot["mode"])
    else:
        path.unlink(missing_ok=True)


def _expected_path(workspace: dict) -> Path:
    return workspace["contextDir"] / EXPECTED_WRITEBACK_FILE


def _load_expected(workspace: dict) -> dict:
    try:
        value = json.loads(_expected_path(workspace).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        value = {}
    return value if value.get("workspaceKey") == workspace["workspaceKey"] else {"workspaceKey": workspace["workspaceKey"], "files": {}}


def _source_path(workspace: dict, meta: dict) -> tuple[Path, str]:
    checkout = workspace["checkoutPath"].resolve()
    if Path(meta.get("checkoutPath") or "").resolve() != checkout:
        raise SystemExit("Workcopy checkout identity does not match the selected workspace")
    relative = Path(meta.get("svnPath") or "")
    if relative.is_absolute() or ".." in relative.parts or not relative.parts or relative.parts[0] not in WRITABLE_ROOTS:
        raise SystemExit(f"SVN writeback path is not allowed: {relative}")
    expected_root = SOURCE_ROOTS.get(meta.get("sourceTable") or "")
    if expected_root != relative.parts[0]:
        raise SystemExit("SVN Workcopy object type does not match its source path")
    if expected_root in {"pages", "system-script"} and len(relative.parts) > 1:
        if str(meta.get("systemId") or "") != relative.parts[1]:
            raise SystemExit("SVN Workcopy system identity does not match its source path")
    if expected_root == "procedures" and len(relative.parts) > 1:
        if str(meta.get("dataSourceId") or "") != relative.parts[1]:
            raise SystemExit("SVN Workcopy data source identity does not match its source path")
    candidate = checkout / relative
    target = candidate.resolve()
    components = []
    component = candidate
    while component != checkout and checkout in component.parents:
        components.append(component)
        component = component.parent
    if checkout not in target.parents or any(path.is_symlink() for path in components) or not target.is_file():
        raise SystemExit(f"SVN writeback target is invalid: {target}")
    return target, relative.as_posix()


def _unexpected_checkout_changes(workspace: dict, target_relative: str, meta: dict) -> list[dict]:
    status = svn_status(workspace["checkoutPath"])
    expected = _load_expected(workspace).get("files") or {}
    unexpected = []
    for change in status["changes"]:
        relative = change["path"]
        expected_hash = (expected.get(relative) or {}).get("hash")
        path = workspace["checkoutPath"] / relative
        current_hash = file_hash(path) if path.is_file() else ""
        safe_status = (
            change.get("item") == "modified"
            and change.get("properties") in {"", "normal", "none"}
            and not any(change.get(key) for key in ("treeConflicted", "switched", "copied"))
            and path.is_file()
        )
        allowed = safe_status and expected_hash and current_hash == expected_hash
        if (
            relative == target_relative
            and safe_status
            and meta.get("expectedDirty")
            and current_hash == meta.get("sourceHash")
        ):
            allowed = True
        if not allowed:
            unexpected.append(change)
    return unexpected


def _file_revision(path: Path) -> str:
    return run_svn(["info", "--show-item", "revision", str(path)]).stdout.strip()


def _validate_post_write_status(workspace: dict, target_relative: str, target_hash: str) -> tuple[dict, bool]:
    status = svn_status(workspace["checkoutPath"])
    expected_hashes = {
        relative: (record or {}).get("hash")
        for relative, record in (_load_expected(workspace).get("files") or {}).items()
    }
    expected_hashes[target_relative] = target_hash
    unsafe = []
    target_dirty = False
    for change in status["changes"]:
        relative = change["path"]
        path = workspace["checkoutPath"] / relative
        expected_hash = expected_hashes.get(relative)
        safe = (
            change.get("item") == "modified"
            and change.get("properties") in {"", "normal", "none"}
            and not any(change.get(key) for key in ("treeConflicted", "switched", "copied"))
            and path.is_file()
            and bool(expected_hash)
            and file_hash(path) == expected_hash
        )
        if not safe:
            unsafe.append(change)
        if relative == target_relative:
            target_dirty = True
    if unsafe:
        paths = ", ".join(change["path"] for change in unsafe[:10])
        raise RuntimeError(f"Unexpected SVN changes appeared during writeback: {paths}")
    return status, target_dirty


def _append_audit(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8")
    existed = path.exists()
    original_size = 0
    try:
        with path.open("a+b") as handle:
            handle.seek(0, os.SEEK_END)
            original_size = handle.tell()
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        if path.exists():
            with path.open("r+b") as handle:
                handle.truncate(original_size)
        if not existed and original_size == 0:
            path.unlink(missing_ok=True)
        raise


def _validate_identity(meta: dict, data) -> None:
    if meta["sourceTable"] == "page" and isinstance(data, dict):
        page_id = str(data.get("pageId") or meta["sourceId"])
        if page_id != meta["sourceId"]:
            raise SystemExit("PAGE identity changed in the SVN source")


def _prepare(workspace: dict, workcopy_path: Path) -> dict:
    require_capability(workspace, "writeback")
    target, meta, projection_changes = inspect_projection(workcopy_path)
    try:
        target.relative_to(workspace["workcopyDir"].resolve())
    except ValueError as error:
        raise SystemExit(f"Workcopy is outside the selected workspace: {target}") from error
    if meta.get("workspaceKey") != workspace["workspaceKey"]:
        raise SystemExit("Workcopy belongs to another workspace")
    scope = load_scope(workspace)
    expected_fingerprint = meta.get("repositoryFingerprint") or ""
    if expected_fingerprint != scope.get("repositoryFingerprint"):
        raise SystemExit("Workcopy repository identity does not match the current SVN scope")
    scoped_paths = [str(value).strip("/") for value in scope.get("paths") or [] if str(value).strip("/")]
    svn_path = str(meta.get("svnPath") or "").strip("/")
    if not any(svn_path == path or svn_path.startswith(path + "/") for path in scoped_paths):
        raise SystemExit("SVN Workcopy source path is outside the configured sparse scope")
    verify_repository_fingerprint(workspace, expected_fingerprint)
    if not meta.get("writable"):
        raise SystemExit("This SVN object is read-only or cannot be safely written back")
    source_path, relative = _source_path(workspace, meta)
    source_bytes = source_path.read_bytes()
    current_hash = _sha(source_bytes)
    if current_hash != meta.get("sourceHash"):
        raise SystemExit("SVN source hash changed after Workcopy creation; reindex and reopen before writing back")
    current_revision = _file_revision(source_path)
    if str(meta.get("svnRevision") or "") != current_revision:
        raise SystemExit("SVN BASE revision changed after Workcopy creation; reindex and reopen before writing back")
    unexpected = _unexpected_checkout_changes(workspace, relative, meta)
    if unexpected:
        paths = ", ".join(change["path"] for change in unexpected[:10])
        raise SystemExit(f"CHECKOUT_EXTERNAL_CHANGED: {paths}")
    raw_snapshot = meta.get("rawSnapshot") or ""
    if raw_snapshot and raw_snapshot in projection_changes:
        raise SystemExit("raw.json is a protected baseline; edit scripts/ files instead")
    changed_mappings = [mapping for mapping in meta.get("mappings") or [] if mapping["projectionPath"] in projection_changes]
    source_text_value, detected_format = source_text(source_bytes)
    if detected_format != meta.get("format"):
        raise SystemExit("SVN source encoding or newline format changed")
    if not changed_mappings:
        return {
            "target": target,
            "meta": meta,
            "sourcePath": source_path,
            "relative": relative,
            "before": source_bytes,
            "after": source_bytes,
            "changedMappings": [],
            "projectionChanges": projection_changes,
            "diff": "",
        }
    if meta["sourceTable"] == "page" and source_path.suffix.lower() == ".json":
        data = json.loads(source_text_value)
        if isinstance(data, str):
            raise SystemExit("Double-encoded PAGE JSON is read-only because minimal token replacement is not safe")
        _validate_identity(meta, data)
        replacements = {}
        expected = {}
        for mapping in changed_mappings:
            pointer = mapping.get("jsonPointer") or ""
            current = pointer_value(data, pointer)
            if not isinstance(current, str) or current != mapping.get("originalValue"):
                raise SystemExit(f"JSON Pointer structure changed: {pointer}")
            projection = read_projection(projection_file(target, mapping["projectionPath"]))
            replacements[pointer] = projection
            expected[pointer] = mapping["originalValue"]
        after_text = replace_json_strings(source_text_value, replacements, expected)
        after_data = json.loads(after_text)
        _validate_identity(meta, after_data)
        after_bytes = encode_source_exact(after_text, meta["format"])
    else:
        if len(meta.get("mappings") or []) != 1:
            raise SystemExit("Whole-file SVN objects must have exactly one projection mapping")
        projection = read_projection(projection_file(target, meta["mappings"][0]["projectionPath"]))
        try:
            merged = merge_preserving_generated_header(source_text_value, projection, meta["format"])
        except ValueError as error:
            raise SystemExit(str(error)) from error
        after_bytes = (
            encode_source_exact(merged, meta["format"])
            if merged is not None
            else encode_source_text(projection, meta["format"])
        )
    before_lines = source_text_value.splitlines(keepends=True)
    after_lines = source_text(after_bytes)[0].splitlines(keepends=True)
    diff = "".join(
        difflib.unified_diff(before_lines, after_lines, fromfile=f"a/{relative}", tofile=f"b/{relative}")
    )
    return {
        "target": target,
        "meta": meta,
        "sourcePath": source_path,
        "relative": relative,
        "before": source_bytes,
        "after": after_bytes,
        "changedMappings": changed_mappings,
        "projectionChanges": projection_changes,
        "diff": diff,
    }


def _inspect_status(workspace: dict, workcopy_path: Path) -> dict:
    target, meta, changes = inspect_projection(workcopy_path)
    source_path, relative = _source_path(workspace, meta)
    upstream_hash = file_hash(source_path)
    if meta.get("rawSnapshot") in changes:
        state = "RAW_SNAPSHOT_CHANGED"
    elif upstream_hash != meta.get("sourceHash"):
        state = "UPSTREAM_CHANGED"
    elif changes:
        state = "LOCAL_CHANGED"
    else:
        state = "CLEAN"
    return {
        "path": str(target),
        "state": state,
        "localChanged": bool(changes),
        "localChanges": changes,
        "upstreamPath": str(source_path),
        "svnPath": relative,
        "svnRevision": meta.get("svnRevision") or "",
        "sourceHash": meta.get("sourceHash") or "",
        "upstreamHash": upstream_hash,
        "writable": bool(meta.get("writable")),
    }


def inspect_status(workspace: dict, workcopy_path: Path) -> dict:
    with operation_lock(workspace, "workcopy-status", shared=True):
        return _inspect_status(workspace, workcopy_path)


def _save(workspace: dict, workcopy_path: Path, check_only=False) -> dict:
    prepared = _prepare(workspace, workcopy_path)
    result = {
        "ok": True,
        "checkOnly": bool(check_only),
        "changed": prepared["before"] != prepared["after"],
        "workspaceKey": workspace["workspaceKey"],
        "workCopyPath": str(prepared["target"]),
        "svnPath": prepared["relative"],
        "changedProjections": [mapping["projectionPath"] for mapping in prepared["changedMappings"]],
        "diff": prepared["diff"],
    }
    if check_only or not result["changed"]:
        return result
    meta = copy.deepcopy(prepared["meta"])
    new_hash = _sha(prepared["after"])
    new_text = source_text(prepared["after"])[0]
    raw_path = None
    if meta["sourceTable"] == "page" and prepared["sourcePath"].suffix.lower() == ".json":
        data = json.loads(new_text)
        for mapping in meta["mappings"]:
            value = pointer_value(data, mapping["jsonPointer"])
            mapping["originalValue"] = value
            mapping["originalHash"] = text_hash(value)
            projection_path = projection_file(prepared["target"], mapping["projectionPath"])
            mapping["projectionHash"] = file_hash(projection_path)
        raw_path = projection_file(prepared["target"], meta["rawSnapshot"], label="raw snapshot")
        meta["rawSnapshotHash"] = new_hash
    else:
        mapping = meta["mappings"][0]
        mapping["originalHash"] = text_hash(new_text)
        mapping["projectionHash"] = file_hash(projection_file(prepared["target"], mapping["projectionPath"]))
    meta["sourceHash"] = new_hash
    meta_path = prepared["target"] / META_FILE
    expected_path = _expected_path(workspace)
    audit_path = workspace["logsDir"] / AUDIT_FILE
    managed_paths = [prepared["sourcePath"], meta_path, expected_path]
    if raw_path:
        managed_paths.append(raw_path)
    snapshots = {path: _snapshot(path) for path in managed_paths}
    try:
        _atomic_source_write(prepared["sourcePath"], prepared["after"])
        _post_status, target_dirty = _validate_post_write_status(
            workspace,
            prepared["relative"],
            new_hash,
        )
        svn_diff = run_svn(["diff", "--", str(prepared["sourcePath"])]).stdout
        meta["expectedDirty"] = target_dirty
        expected = _load_expected(workspace)
        if target_dirty:
            expected.setdefault("files", {})[prepared["relative"]] = {
                "hash": new_hash,
                "workCopyPath": str(prepared["target"]),
                "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            }
        else:
            expected.setdefault("files", {}).pop(prepared["relative"], None)
        if raw_path:
            _atomic_source_write(raw_path, prepared["after"])
        atomic_json(meta_path, meta)
        atomic_json(expected_path, expected)
        audit = {
            "time": dt.datetime.now(dt.timezone.utc).isoformat(),
            "workspaceKey": workspace["workspaceKey"],
            "workCopyPath": str(prepared["target"]),
            "svnPath": prepared["relative"],
            "baselineHash": _sha(prepared["before"]),
            "newHash": new_hash,
            "svnRevision": meta.get("svnRevision") or "",
            "status": "SVN_DIRTY" if target_dirty else "CLEAN",
            "changedProjections": result["changedProjections"],
        }
        _append_audit(audit_path, audit)
    except BaseException as error:
        rollback_errors = []
        for path in reversed(managed_paths):
            try:
                _restore_snapshot(path, snapshots[path])
            except Exception as rollback_error:  # pragma: no cover - requires filesystem failure
                rollback_errors.append(f"{path}: {rollback_error}")
        if rollback_errors:
            raise RuntimeError(
                "SVN writeback failed and rollback was incomplete: " + "; ".join(rollback_errors)
            ) from error
        raise
    result.update(
        {
            "sourceHash": new_hash,
            "status": "SVN_DIRTY" if target_dirty else "CLEAN",
            "svnDiff": svn_diff,
            "auditLog": str(audit_path),
        }
    )
    return result


def save(workspace: dict, workcopy_path: Path, check_only=False) -> dict:
    with operation_lock(
        workspace,
        "writeback-check" if check_only else "writeback",
        blocking=True,
        timeout_seconds=30,
    ):
        return _save(workspace, workcopy_path, check_only)

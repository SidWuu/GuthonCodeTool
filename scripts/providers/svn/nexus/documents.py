"""Read and safely write Nexus virtual documents against SVN checkouts."""

from __future__ import annotations

import hashlib
import difflib
import json
import os
import stat
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from common.page_projection import (
    extract_page_fields,
    extract_page_scripts,
    json_string_token,
    pointer_value,
    replace_json_strings,
    replace_json_value,
)
from common.source_format import (
    decode_source,
    encode_source,
    encode_source_exact,
    merge_preserving_generated_header,
)
from providers.svn.checkout import (
    atomic_json,
    file_hash,
    operation_lock,
    require_capability,
    run_svn_binary,
    svn_path_changes,
)

from .catalog import header_fields, scan
from . import index_queries
from .manifest import (
    load_authorized_scope,
    logical_path_for_entry,
    relative_path_for_entry,
    resolve_authorized_path,
    source_path_writable,
)


SESSION_VERSION = 1
SESSION_FILE = "svn-edit-session.json"
DOCUMENT_LOCK_TIMEOUT_SECONDS = 30
MAX_BATCH_CHANGES = 100
MAX_DOCUMENT_LEASES = 1000
MAX_PAGE_EDIT_TOKENS = 1000
MAX_PROCEDURE_EDIT_TOKENS = 1000
PAGE_FRAGMENT_TYPES = {
    "page-string",
    "page-js",
    "page-gss",
    "page-vm",
    "page-sql",
    "page-fields",
}


def _text_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def session_path(workspace: dict) -> Path:
    return workspace["contextDir"] / SESSION_FILE


def _prune_document_leases(session: dict) -> None:
    documents = session["documents"]
    overflow = len(documents) - MAX_DOCUMENT_LEASES
    if overflow > 0:
        for document_id in list(documents)[:overflow]:
            documents.pop(document_id, None)
    now = time.time()
    tokens = {
        token: value for token, value in session["pageEditTokens"].items()
        if value.get("documentId") in documents
        and isinstance(value.get("expiresAt"), (int, float))
        and value["expiresAt"] >= now
    }
    session["pageEditTokens"] = dict(list(tokens.items())[-MAX_PAGE_EDIT_TOKENS:])
    procedure_tokens = {
        token: value for token, value in session["procedureEditTokens"].items()
        if value.get("documentId") in documents
        and isinstance(value.get("expiresAt"), (int, float))
        and value["expiresAt"] >= now
    }
    session["procedureEditTokens"] = dict(list(procedure_tokens.items())[-MAX_PROCEDURE_EDIT_TOKENS:])


def load_session(workspace: dict) -> dict:
    path = session_path(workspace)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        value = {}
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Invalid SVN edit session: {path}") from error
    if not value:
        return {
            "version": SESSION_VERSION,
            "workspaceKey": workspace["workspaceKey"],
            "sessionId": str(uuid.uuid4()),
            "files": {},
            "documents": {},
            "pageEditTokens": {},
            "procedureEditTokens": {},
        }
    if value.get("version") != SESSION_VERSION or value.get("workspaceKey") != workspace["workspaceKey"]:
        raise SystemExit(f"SVN edit session does not match {workspace['workspaceKey']}")
    if not isinstance(value.get("files"), dict) or not isinstance(value.get("documents"), dict):
        raise SystemExit(f"Invalid SVN edit session records: {path}")
    if (not isinstance(value.setdefault("pageEditTokens", {}), dict)
            or any(not isinstance(token, dict) for token in value["pageEditTokens"].values())):
        raise SystemExit(f"Invalid PAGE edit token records: {path}")
    if (not isinstance(value.setdefault("procedureEditTokens", {}), dict)
            or any(not isinstance(token, dict) for token in value["procedureEditTokens"].values())):
        raise SystemExit(f"Invalid procedure edit token records: {path}")
    return value


def accept_refreshed_files(workspace: dict, refreshed: list[dict]) -> None:
    """Advance the edit ledger after an explicit, successful SVN update."""
    session = load_session(workspace)
    scope = load_authorized_scope(workspace)
    entries = {entry.id: entry for entry in scope.entries}
    accepted_paths = set()
    affected_paths = set()
    for result in refreshed:
        entry = entries.get(result.get("id"))
        if entry is None:
            continue
        exact_paths = {
            str(path).strip().replace("\\", "/")
            for path in result.get("paths") or ()
            if str(path).strip()
        }
        if exact_paths:
            affected_paths.update(exact_paths)
        else:
            affected_paths.update(
                path
                for path in session["files"]
                if _session_path_belongs_to_entry(scope, entry, path)
            )
        for change in (result.get("after") or {}).get("changes") or ():
            relative = str(change.get("path") or "")
            logical_path = logical_path_for_entry(entry, relative)
            if exact_paths and logical_path not in exact_paths:
                continue
            path = entry.root / relative
            safe = (
                change.get("item") == "modified"
                and change.get("properties") in {"", "normal", "none"}
                and not any(change.get(key) for key in ("treeConflicted", "switched", "copied", "wcLocked"))
                and path.is_file()
                and source_path_writable(entry, relative)
            )
            if safe:
                accepted_paths.add(logical_path)
                affected_paths.add(logical_path)
                record = session["files"].setdefault(logical_path, {})
                record["expectedCurrentHash"] = file_hash(path)
                record["refreshAccepted"] = True
    for logical_path in affected_paths - accepted_paths:
        record = session["files"].get(logical_path)
        if not record:
            continue
        try:
            _entry, path, _relative = resolve_authorized_path(scope, logical_path)
        except SystemExit:
            continue
        if path.is_file():
            record["expectedCurrentHash"] = file_hash(path)
            record["refreshAccepted"] = True
    session["documents"] = {
        key: value
        for key, value in session["documents"].items()
        if value.get("sourcePath") not in affected_paths
    }
    session["pageEditTokens"] = {
        key: value for key, value in session["pageEditTokens"].items()
        if value.get("documentId") in session["documents"]
    }
    session["procedureEditTokens"] = {
        key: value for key, value in session["procedureEditTokens"].items()
        if value.get("documentId") in session["documents"]
    }
    atomic_json(session_path(workspace), session)


def _object_identity(source_type: str, source_id: str, fun_id: str = "") -> tuple[str, str, str]:
    normalized_type = str(source_type or "").strip()
    normalized_id = str(source_id or "").strip()
    normalized_fun = str(fun_id or "").strip()
    if normalized_type not in {"page", "procedure", "system-script", "table", "view", "skill", "public"}:
        raise SystemExit(f"Unsupported SVN source type: {normalized_type}")
    if not normalized_id:
        raise SystemExit("Missing SVN source id")
    return normalized_type, normalized_id, normalized_fun


def _resolve_object(
    workspace: dict,
    source_type: str,
    source_id: str,
    fun_id: str = "",
    working_copy_id: str = "",
) -> dict:
    identity = _object_identity(source_type, source_id, fun_id)
    if workspace["indexPath"].is_file():
        return index_queries.source_object(
            workspace,
            source_type=identity[0],
            source_id=identity[1],
            fun_id=identity[2],
            working_copy_id=working_copy_id,
        )
    current = scan(workspace)
    matches = [
        item
        for item in current["objects"]
        if (item["source_table"], item["source_id"], item.get("fun_id") or "") == identity
        and (not working_copy_id or item.get("working_copy_id") == working_copy_id)
    ]
    if not matches:
        raise SystemExit(f"SVN object was not found: {source_type}/{source_id}/{fun_id}")
    if len(matches) != 1 or matches[0].get("status") == "IDENTITY_AMBIGUOUS":
        raise SystemExit(f"SVN object identity is ambiguous: {source_type}/{source_id}/{fun_id}")
    return matches[0]


def _page_scripts_text(text: str) -> tuple[list[dict], bool]:
    data = json.loads(text)
    double_encoded = isinstance(data, str)
    if double_encoded:
        data = json.loads(data)
    if not isinstance(data, dict):
        raise SystemExit("PAGE JSON root must be an object")
    script_fields = extract_page_scripts(data)
    display_counts = {}
    for field in script_fields:
        display_counts[field.display_name] = display_counts.get(field.display_name, 0) + 1

    def script_label(field):
        if field.display_name != field.key and display_counts[field.display_name] == 1:
            return field.display_name
        pointer_parts = [part for part in field.json_pointer.split("/") if part]
        return " / ".join(pointer_parts[-3:]) or field.display_name

    return (
        [
            *[
                {
                    "script_type": "gss" if field.script_type == "vm" else field.script_type,
                    "json_path": field.json_pointer,
                    "content": field.effective_value,
                    "label": script_label(field),
                }
                for field in script_fields
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
        double_encoded,
    )


def _page_scripts(path: Path) -> tuple[list[dict], bool]:
    return _page_scripts_text(decode_source(path.read_bytes())[0])


def _object_scripts(item: dict) -> tuple[list[dict], bool]:
    path = Path(item["local_path"])
    # PAGE fragments must use the Nexus parser even when a scanner result already
    # carries legacy field-key types such as beforeSaveScript/onClickScript.
    if item["source_table"] == "page" and path.suffix.lower() == ".json":
        return _page_scripts(path)
    existing = item.get("scripts")
    if isinstance(existing, list) and existing:
        return existing, bool(item.get("double_encoded"))
    if item["source_table"] == "view" and path.suffix.lower() == ".json":
        data = json.loads(decode_source(path.read_bytes())[0])
        value = data.get("viewSql") if isinstance(data, dict) else None
        return (
            [{"script_type": "view_sql", "json_path": "/viewSql", "content": value, "label": ""}]
            if isinstance(value, str)
            else [],
            False,
        )
    return existing or [], False


def _entry(workspace: dict, scope_entry_id: str):
    scope = load_authorized_scope(workspace)
    return next((entry for entry in scope.entries if entry.id == scope_entry_id), None)


def _document_content(item: dict, json_pointer: str) -> tuple[str, str]:
    path = Path(item["local_path"])
    text, _format = decode_source(path.read_bytes())
    if item["source_table"] == "page" and path.suffix.lower() == ".json":
        data = json.loads(text)
        if isinstance(data, str):
            raise SystemExit("Double-encoded PAGE JSON is read-only because minimal token replacement is not safe")
        if not json_pointer:
            raise SystemExit("PAGE JSON must be opened through a supported virtual fragment")
        scripts, _double_encoded = _object_scripts(item)
        fragment = next(
            (script for script in scripts if script.get("json_path") == json_pointer),
            None,
        )
        if not fragment:
            raise SystemExit(f"PAGE JSON Pointer is not an editable Nexus fragment: {json_pointer}")
        value = pointer_value(data, json_pointer)
        if fragment.get("script_type") == "fields":
            if not isinstance(value, list):
                raise SystemExit(f"PAGE fields Pointer is not an array: {json_pointer}")
            return json.dumps(value, ensure_ascii=False, indent=2), "page-fields"
        if not isinstance(value, str):
            raise SystemExit(f"PAGE JSON Pointer is not a text field: {json_pointer}")
        script_type = str(fragment.get("script_type") or "js")
        return value, f"page-{script_type}"
    if json_pointer:
        scripts, _double_encoded = _object_scripts(item)
        script = next((script for script in scripts if script.get("json_path") == json_pointer), None)
        if not script:
            raise SystemExit(f"Virtual fragment was not found: {json_pointer}")
        return str(script.get("content") or ""), "read-only-fragment"
    return text, "whole-file"


def _content_at_pointer(text: str, json_pointer: str, fragment_type: str) -> str:
    if not json_pointer:
        return text
    data = json.loads(text)
    if isinstance(data, str):
        data = json.loads(data)
    value = pointer_value(data, json_pointer)
    if fragment_type == "page-fields" or not isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, indent=2)
    return value


def _base_document_content(path: Path, json_pointer: str, fragment_type: str) -> str:
    text = _base_source_text(path)
    if text is None:
        return ""
    try:
        return _content_at_pointer(text, json_pointer, fragment_type)
    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
        return ""


def _base_source_text(path: Path) -> str | None:
    result = run_svn_binary(["cat", "-r", "BASE", "--", str(path)], check=False)
    if result.returncode:
        return None
    return decode_source(result.stdout)[0]


def _base_json_string_token(text: str, json_pointer: str) -> str | None:
    try:
        return json_string_token(text, json_pointer)
    except (TypeError, ValueError, KeyError):
        return None


def line_changes(base_content: str, working_content: str) -> list[dict]:
    """Return zero-based working-document line ranges relative to SVN BASE."""

    base_lines = str(base_content or "").splitlines()
    working_lines = str(working_content or "").splitlines()
    changes = []
    matcher = difflib.SequenceMatcher(None, base_lines, working_lines, autojunk=False)
    for operation, base_start, base_end, working_start, working_end in matcher.get_opcodes():
        if operation == "equal":
            continue
        if operation == "insert":
            changes.append({
                "type": "added",
                "startLine": working_start,
                "endLine": max(working_start, working_end - 1),
            })
            continue
        if operation == "replace" and working_start < working_end:
            changes.append({
                "type": "modified",
                "startLine": working_start,
                "endLine": working_end - 1,
                "deletedLines": base_end - base_start,
            })
            continue
        anchor = max(0, min(working_start, max(0, len(working_lines) - 1)))
        changes.append({
            "type": "deleted",
            "startLine": anchor,
            "endLine": anchor,
            "deletedLines": base_end - base_start,
        })
    return changes


def fragments(
    workspace: dict,
    *,
    source_type: str,
    source_id: str,
    fun_id: str = "",
    working_copy_id: str = "",
) -> dict:
    require_capability(workspace, "browse")
    with operation_lock(workspace, "document-fragments", shared=True):
        item = _resolve_object(workspace, source_type, source_id, fun_id, working_copy_id)
        scripts, double_encoded = _object_scripts(item)
        base_scripts = {}
        base_result = run_svn_binary(["cat", "-r", "BASE", "--", str(item["local_path"])], check=False)
        if not base_result.returncode:
            try:
                base_text = decode_source(base_result.stdout)[0]
                base_path = Path(item["local_path"])
                if item["source_table"] == "page" and base_path.suffix.lower() == ".json":
                    parsed, _double_encoded = _page_scripts_text(base_text)
                elif item["source_table"] == "view" and base_path.suffix.lower() == ".json":
                    data = json.loads(base_text)
                    value = data.get("viewSql") if isinstance(data, dict) else None
                    parsed = (
                        [{"json_path": "/viewSql", "content": value}]
                        if isinstance(value, str)
                        else []
                    )
                else:
                    parsed = [{"json_path": scripts[0].get("json_path") if scripts else "", "content": base_text}]
                base_scripts = {
                    str(script.get("json_path") or ""): script.get("content")
                    for script in parsed
                }
            except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
                base_scripts = {}
        return {
            "ok": True,
            "workspaceKey": workspace["workspaceKey"],
            "sourceType": item["source_table"],
            "sourceId": item["source_id"],
            "sourcePath": item["source_path"],
            "funId": item.get("fun_id") or "",
            "workingCopyId": item.get("working_copy_id") or item.get("scope_entry_id") or "",
            "doubleEncoded": double_encoded,
            "fragments": [
                {
                    "scriptType": script.get("script_type") or "",
                    "jsonPointer": script.get("json_path") or "",
                    "label": script.get("label") or "",
                    "status": (
                        "SVN_DIRTY"
                        if str(script.get("json_path") or "") in base_scripts
                        and script.get("content") != base_scripts[str(script.get("json_path") or "")]
                        else "OK"
                    ),
                }
                for script in scripts
            ],
        }


def _relative_in_entry(entry, path: Path) -> str:
    try:
        return path.resolve().relative_to(entry.root.resolve()).as_posix()
    except ValueError as error:
        raise SystemExit(f"SVN object escaped its authorized working copy: {path}") from error


def _session_path_belongs_to_entry(scope, entry, logical_path: str) -> bool:
    try:
        resolved_entry, _path, _relative = resolve_authorized_path(scope, logical_path)
    except SystemExit:
        return False
    return resolved_entry.id == entry.id


def _is_safe_modified_file(entry, path: Path, changes: list[dict] | None = None) -> bool:
    relative = _relative_in_entry(entry, path)
    current = changes if changes is not None else svn_path_changes(entry.root, path)
    matching = next((change for change in current if change["path"] == relative), None)
    return bool(
        matching
        and matching.get("item") == "modified"
        and matching.get("properties") in {"", "normal", "none"}
        and not any(matching.get(key) for key in ("treeConflicted", "switched", "copied", "wcLocked"))
        and path.is_file()
    )


def _session_change_errors(
    entry,
    session: dict,
    logical_path: str,
    current_changes: list[dict] | None = None,
) -> list[str]:
    try:
        relative = relative_path_for_entry(entry, logical_path)
    except ValueError as error:
        raise SystemExit(f"SVN session path escaped its authorized working copy: {logical_path}") from error
    target = entry.root.joinpath(*relative.parts)
    _relative_in_entry(entry, target)
    current = current_changes if current_changes is not None else svn_path_changes(entry.root, target)
    errors = []
    for change in current:
        logical_path = logical_path_for_entry(entry, change["path"])
        record = session["files"].get(logical_path) or {}
        path = entry.root / change["path"]
        safe = (
            change.get("item") == "modified"
            and change.get("properties") in {"", "normal", "none"}
            and not any(change.get(key) for key in ("treeConflicted", "switched", "copied", "wcLocked"))
            and path.is_file()
            and record.get("expectedCurrentHash") == file_hash(path)
        )
        if not safe:
            errors.append(logical_path)
    return errors


def read(
    workspace: dict,
    *,
    source_type: str,
    source_id: str,
    fun_id: str = "",
    json_pointer: str = "",
    working_copy_id: str = "",
) -> dict:
    require_capability(workspace, "browse")
    # An editable read also creates an edit lease in the shared session ledger,
    # so it must not run under a shared/read lock.
    with operation_lock(
        workspace,
        "document-read",
        blocking=True,
        timeout_seconds=DOCUMENT_LOCK_TIMEOUT_SECONDS,
    ):
        item = _resolve_object(workspace, source_type, source_id, fun_id, working_copy_id)
        entry = _entry(workspace, item["scope_entry_id"])
        if entry is None:
            raise SystemExit(f"SVN object is outside the current authorization scope: {item['source_path']}")
        path = Path(item["local_path"])
        content, fragment_type = _document_content(item, json_pointer)
        base_content = _base_document_content(path, json_pointer, fragment_type)
        session = load_session(workspace)
        known_file = session["files"].get(item["source_path"])
        current_hash = file_hash(path)
        current_changes = svn_path_changes(entry.root, path)
        external = bool(
            _session_change_errors(entry, session, item["source_path"], current_changes)
        )
        if known_file and known_file.get("expectedCurrentHash") != current_hash:
            if current_changes:
                external = True
            else:
                # A clean SVN file whose bytes changed since it was opened was
                # advanced by update/switch, not by an untracked local edit.
                # Drop stale fragment hashes and establish a fresh edit record.
                session["files"].pop(item["source_path"], None)
                session["documents"] = {
                    key: value
                    for key, value in session["documents"].items()
                    if value.get("sourcePath") != item["source_path"]
                }
                session["pageEditTokens"] = {
                    key: value for key, value in session["pageEditTokens"].items()
                    if value.get("documentId") in session["documents"]
                }
                session["procedureEditTokens"] = {
                    key: value for key, value in session["procedureEditTokens"].items()
                    if value.get("documentId") in session["documents"]
                }
                known_file = None
        relative_path = relative_path_for_entry(entry, item["source_path"])
        editable = bool(
            workspace["capabilities"].get("svn.edit")
            and source_path_writable(entry, relative_path)
            and item["source_table"] in {"page", "procedure", "system-script"}
            and not external
        )
        document_key = json.dumps(
            [
                item.get("working_copy_id") or item.get("scope_entry_id") or "",
                item["source_table"], item["source_id"], item.get("fun_id") or "", json_pointer,
            ],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        document_id = ""
        if editable:
            raw = path.read_bytes()
            _text, format_info = decode_source(raw)
            if not known_file or known_file.get("refreshAccepted"):
                session["files"][item["source_path"]] = {
                    "scopeEntryId": entry.id,
                    "workingCopyId": item.get("working_copy_id") or item.get("scope_entry_id") or entry.id,
                    "objectType": item["source_table"],
                    "objectId": item["source_id"],
                    "funId": item.get("fun_id") or "",
                    "baseRevision": item.get("svn_revision") or "",
                    "openingHash": current_hash,
                    "expectedCurrentHash": current_hash,
                    "format": format_info,
                    "state": (
                        "LOCAL_MODIFIED"
                        if _is_safe_modified_file(entry, path, current_changes)
                        else "EDITING"
                    ),
                }
            # Every open receives an independent lease. Reusing a mutable
            # document record lets a stale editor inherit another editor's
            # advanced hash and overwrite that editor's save.
            document_id = str(uuid.uuid4())
            session["documents"][document_id] = {
                "documentKey": document_key,
                "sourcePath": item["source_path"],
                "jsonPointer": json_pointer,
                "fragmentType": fragment_type,
                "expectedSourceHash": current_hash,
                "expectedDocumentHash": _text_hash(content),
            }
            _prune_document_leases(session)
            atomic_json(session_path(workspace), session)
        return {
            "ok": True,
            "workspaceKey": workspace["workspaceKey"],
            "sessionId": session["sessionId"] if editable else "",
            "documentId": document_id if editable else "",
            "sourceType": item["source_table"],
            "sourceId": item["source_id"],
            "funId": item.get("fun_id") or "",
            "workingCopyId": item.get("working_copy_id") or item.get("scope_entry_id") or "",
            "jsonPointer": json_pointer,
            "language": (
                "json"
                if fragment_type == "page-fields"
                else "sql"
                if fragment_type == "page-sql" or json_pointer.lower().endswith("sql")
                else "javascript"
                if fragment_type in {"page-js", "page-string"}
                else "guthon-gss"
            ),
            "editable": editable,
            "externalModified": external,
            "sourcePath": item["source_path"],
            "sourceHash": current_hash,
            "documentHash": _text_hash(content),
            "content": content,
            "baseContent": base_content,
            "lineChanges": line_changes(base_content, content),
        }


def _atomic_write(path: Path, value: bytes) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, mode)
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def _session_document(workspace: dict, session: dict, document_id: str) -> dict:
    document = session["documents"].get(document_id)
    if not document:
        raise SystemExit("SVN virtual document is missing or expired")
    file_record = session["files"].get(document["sourcePath"])
    if not file_record:
        raise SystemExit("SVN edit session file record is missing")
    item = _resolve_object(
        workspace,
        file_record["objectType"],
        file_record["objectId"],
        file_record.get("funId") or "",
        file_record.get("workingCopyId") or file_record.get("scopeEntryId") or "",
    )
    if item["source_path"] != document["sourcePath"]:
        raise SystemExit("SVN object path changed after the virtual document was opened")
    entry = _entry(workspace, file_record["scopeEntryId"])
    if entry is None:
        raise SystemExit("SVN object is no longer writable in the authorization scope")
    relative_path = relative_path_for_entry(entry, item["source_path"])
    if not source_path_writable(entry, relative_path):
        raise SystemExit("SVN object is no longer writable in the authorization scope")
    return {
        "document": document,
        "fileRecord": file_record,
        "item": item,
        "entry": entry,
        "path": Path(item["local_path"]),
    }


def _apply_replacements(content: str, replacements, source_path: str) -> str:
    if not isinstance(replacements, list) or not replacements:
        raise SystemExit(f"SVN batch replacements must be a non-empty array: {source_path}")
    result = content
    for index, replacement in enumerate(replacements, 1):
        if not isinstance(replacement, dict):
            raise SystemExit(f"SVN batch replacement {index} must be an object: {source_path}")
        old = replacement.get("old")
        new = replacement.get("new")
        expected_count = replacement.get("expectedCount", 1)
        if not isinstance(old, str) or not isinstance(new, str):
            raise SystemExit(f"SVN batch replacement {index} requires text old/new values: {source_path}")
        if not isinstance(expected_count, int) or isinstance(expected_count, bool) or expected_count <= 0:
            raise SystemExit(f"SVN batch replacement {index} expectedCount must be positive: {source_path}")
        actual_count = result.count(old)
        if actual_count != expected_count:
            raise SystemExit(
                f"SVN batch replacement {index} expected {expected_count} matches but found "
                f"{actual_count}: {source_path}"
            )
        result = result.replace(old, new, expected_count)
    return result


def _prepare_write(
    workspace: dict,
    session: dict,
    *,
    document_id: str,
    content: str | None = None,
    replacements=None,
) -> dict:
    record = _session_document(workspace, session, document_id)
    document = record["document"]
    file_record = record["fileRecord"]
    item = record["item"]
    entry = record["entry"]
    path = record["path"]
    source_bytes = path.read_bytes()
    current_hash = file_hash(path)
    external = _session_change_errors(entry, session, item["source_path"])
    if external:
        raise SystemExit("CHECKOUT_EXTERNAL_CHANGED: " + ", ".join(external[:10]))
    source_text, detected_format = decode_source(source_bytes)
    if detected_format != file_record.get("format"):
        raise SystemExit("SVN source encoding or newline format changed")
    pointer = document.get("jsonPointer") or ""
    fragment_type = document.get("fragmentType") or ""
    is_page_fragment = fragment_type in PAGE_FRAGMENT_TYPES
    current_value = None
    if is_page_fragment:
        data = json.loads(source_text)
        if isinstance(data, str):
            raise SystemExit("Double-encoded PAGE JSON is read-only")
        current_value = pointer_value(data, pointer)
        current_document = (
            json.dumps(current_value, ensure_ascii=False, indent=2)
            if fragment_type == "page-fields"
            else current_value
        )
        if not isinstance(current_document, str):
            raise SystemExit(f"PAGE JSON Pointer is no longer text: {pointer}")
    else:
        current_document = source_text

    expected_source_hash = document.get("expectedSourceHash")
    expected_document_hash = document.get("expectedDocumentHash")
    current_document_hash = _text_hash(current_document)
    ledger_is_current = file_record.get("expectedCurrentHash") == current_hash
    if not expected_source_hash:
        raise SystemExit("SVN edit lease predates concurrency protection; reopen the virtual document")
    if current_hash != expected_source_hash:
        can_rebase_fragment = (
            is_page_fragment
            and ledger_is_current
            and current_document_hash == expected_document_hash
        )
        if not can_rebase_fragment:
            raise SystemExit("SVN_EDIT_CONFLICT: source changed after this document was opened")
    elif not ledger_is_current:
        raise SystemExit("SVN edit session source ledger is stale; reopen the virtual document")
    if is_page_fragment and current_document_hash != expected_document_hash:
        raise SystemExit(f"SVN_EDIT_CONFLICT: PAGE JSON Pointer changed after open: {pointer}")

    if content is not None and replacements is not None:
        raise SystemExit(f"SVN batch change cannot contain both content and replacements: {item['source_path']}")
    if replacements is not None:
        content = _apply_replacements(current_document, replacements, item["source_path"])
    if not isinstance(content, str):
        raise SystemExit("SVN virtual document content must be text")

    base_source_text = _base_source_text(path)
    if base_source_text is None:
        base_content = ""
    else:
        try:
            base_content = _content_at_pointer(base_source_text, pointer, fragment_type)
        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
            base_content = ""
    if is_page_fragment:
        if fragment_type == "page-fields":
            try:
                replacement = json.loads(content)
            except json.JSONDecodeError as error:
                raise SystemExit("PAGE fields fragment must be valid JSON") from error
            if not isinstance(replacement, list) or any(not isinstance(field, dict) for field in replacement):
                raise SystemExit("PAGE fields fragment must be an array of objects")
            after_text = replace_json_value(source_text, pointer, replacement, current_value)
        else:
            encoded_replacements = {}
            if base_source_text is not None and content == base_content:
                base_token = _base_json_string_token(base_source_text, pointer)
                if base_token:
                    encoded_replacements[pointer] = base_token
            after_text = replace_json_strings(
                source_text,
                {pointer: content},
                {pointer: current_value},
                encoded_replacements,
            )
        after_bytes = encode_source_exact(after_text, detected_format)
        parsed_after = json.loads(after_text)
        if str(parsed_after.get("pageId") or item["source_id"]) != item["source_id"]:
            raise SystemExit("PAGE identity changed during virtual document save")
    else:
        try:
            merged = merge_preserving_generated_header(source_text, content, detected_format)
        except ValueError as error:
            raise SystemExit(str(error)) from error
        header = header_fields(content)
        if item["source_table"] == "procedure" and (
            (header.get("packageId") and header["packageId"] != item["source_alias_id"])
            or (header.get("functionId") and header["functionId"] != item["fun_id"])
        ):
            raise SystemExit("Procedure identity header must not be changed")
        if item["source_table"] == "page" and header.get("pageId") and header["pageId"] != item["source_id"]:
            raise SystemExit("PAGE identity header must not be changed")
        after_bytes = (
            encode_source_exact(merged, detected_format)
            if merged is not None
            else encode_source(content, detected_format)
        )
    base_bytes = (
        encode_source_exact(base_source_text, detected_format)
        if base_source_text is not None
        else None
    )
    physical_changed = after_bytes != source_bytes
    returns_to_base = base_bytes is not None and after_bytes == base_bytes
    if returns_to_base:
        next_state = "EDITING"
    elif physical_changed or _is_safe_modified_file(entry, path):
        next_state = "LOCAL_MODIFIED"
    else:
        next_state = "EDITING"
    return {
        **record,
        "documentId": document_id,
        "content": content,
        "sourceBytes": source_bytes,
        "sourceHash": current_hash,
        "afterBytes": after_bytes,
        "afterHash": hashlib.sha256(after_bytes).hexdigest(),
        "physicalChanged": physical_changed,
        "changed": bool(physical_changed and not returns_to_base),
        "state": next_state,
        "baseContent": base_content,
        "lineChanges": line_changes(base_content, content),
    }


def _commit_prepared(workspace: dict, session: dict, prepared: dict) -> dict:
    path = prepared["path"]
    if prepared["physicalChanged"]:
        _atomic_write(path, prepared["afterBytes"])
    after_hash = file_hash(path)
    if after_hash != prepared["afterHash"]:
        raise SystemExit("SVN source hash changed during virtual document save")
    if prepared["state"] == "LOCAL_MODIFIED" and not _is_safe_modified_file(
        prepared["entry"], path
    ):
        raise SystemExit("SVN status after virtual document save is not a safe modified file")
    prepared["fileRecord"]["expectedCurrentHash"] = after_hash
    prepared["fileRecord"]["state"] = prepared["state"]
    prepared["document"]["expectedSourceHash"] = after_hash
    prepared["document"]["expectedDocumentHash"] = _text_hash(prepared["content"])
    return {
        "ok": True,
        "changed": prepared["changed"],
        "written": prepared["physicalChanged"],
        "workspaceKey": workspace["workspaceKey"],
        "sessionId": session["sessionId"],
        "documentId": prepared["documentId"],
        "sourcePath": prepared["item"]["source_path"],
        "workingCopyId": prepared["item"].get("working_copy_id") or prepared["entry"].id,
        "sourceHash": after_hash,
        "documentHash": prepared["document"]["expectedDocumentHash"],
        "status": prepared["state"],
        "baseContent": prepared["baseContent"],
        "lineChanges": prepared["lineChanges"],
    }


def _restore_prepared(prepared_items: list[dict]) -> None:
    errors = []
    for prepared in reversed(prepared_items):
        if not prepared["physicalChanged"]:
            continue
        try:
            current = prepared["path"].read_bytes()
            if current != prepared["sourceBytes"]:
                if hashlib.sha256(current).hexdigest() != prepared["afterHash"]:
                    errors.append(f"{prepared['path']}: source changed after write; rollback refused")
                    continue
                _atomic_write(prepared["path"], prepared["sourceBytes"])
        except Exception as error:  # pragma: no cover - requires filesystem failure
            errors.append(f"{prepared['path']}: {error}")
    if errors:
        raise RuntimeError("SVN virtual write rollback was incomplete: " + "; ".join(errors))


def _validate_session(session: dict, session_id: str) -> None:
    if not session_id or session_id != session.get("sessionId"):
        raise SystemExit("SVN edit session is missing or expired")


def _page_operation_path(workspace: dict, idempotency_key: str) -> Path:
    if not isinstance(idempotency_key, str) or not 8 <= len(idempotency_key) <= 128:
        raise SystemExit("PAGE idempotencyKey must contain 8–128 characters")
    if any(ord(char) < 33 or ord(char) > 126 for char in idempotency_key):
        raise SystemExit("PAGE idempotencyKey must contain printable ASCII without spaces")
    digest = hashlib.sha256(idempotency_key.encode("ascii")).hexdigest()
    return workspace["contextDir"] / "page-operations" / f"{digest}.json"


def _page_operation_by_id(workspace: dict, operation_id: str) -> tuple[Path, dict]:
    prefix = "page-op:v1:"
    digest = operation_id[len(prefix):] if isinstance(operation_id, str) and operation_id.startswith(prefix) else ""
    if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        raise SystemExit("Invalid PAGE operationId")
    path = workspace["contextDir"] / "page-operations" / f"{digest}.json"
    record = _load_page_operation(path)
    if (record is None or record.get("workspaceKey") != workspace["workspaceKey"]
            or record.get("operationId") != operation_id):
        raise SystemExit("PAGE operation was not found in this workspace")
    return path, record


def page_node_operation_status(
    workspace: dict, *, operation_id: str = "", idempotency_key: str = "",
) -> dict:
    """Read a private operation journal by ID or caller key without source text."""

    require_capability(workspace, "edit")
    if bool(operation_id) == bool(idempotency_key):
        raise SystemExit("Provide exactly one PAGE operationId or idempotencyKey")
    if idempotency_key:
        operation_id = "page-op:v1:" + _page_operation_path(workspace, idempotency_key).stem
    _path, record = _page_operation_by_id(workspace, operation_id)
    authorization_current = False
    current_source_matches = False
    current_index_matches = False
    current_diff_matches = False
    try:
        scope = load_authorized_scope(workspace)
        entry, source, _relative = resolve_authorized_path(scope, record["sourcePath"])
        authorization_current = entry.id == record["scopeEntryId"]
        current_source_matches = (
            authorization_current and source.is_file() and file_hash(source) == record["afterHash"]
        )
    except (OSError, ValueError, SystemExit):
        pass
    if current_source_matches:
        from . import page_nodes

        try:
            with page_nodes._connection(workspace) as conn:
                page_nodes._require_ready(conn)
                rows = conn.execute(
                    "SELECT source_hash FROM gusen_source_record WHERE provider='svn' "
                    "AND source_path=? AND source_table='page' LIMIT 2",
                    (record["sourcePath"],),
                ).fetchall()
                current_index_matches = len(rows) == 1 and rows[0]["source_hash"] == record["afterHash"]
        except (OSError, ValueError, SystemExit, page_nodes.PageIndexError):
            pass
        if record["state"] == "DIFF_VERIFIED" and current_index_matches:
            try:
                diff = run_svn_binary(["diff", "--", str(source)]).stdout
                current_diff_matches = (
                    len(diff) == record.get("diffBytes")
                    and hashlib.sha256(diff).hexdigest() == record.get("diffHash")
                )
            except (OSError, ValueError, SystemExit):
                pass
    return {
        "operationId": operation_id,
        "workspaceKey": workspace["workspaceKey"],
        "state": record["state"],
        "createdAt": record.get("createdAt"),
        "updatedAt": record.get("updatedAt"),
        "phaseTimes": record.get("phaseTimes", {}),
        "authorizationCurrent": authorization_current,
        "sourcePath": record["sourcePath"] if authorization_current else None,
        "beforeHash": record["beforeHash"],
        "afterHash": record["afterHash"],
        "indexGeneration": record.get("indexGeneration"),
        "diffHash": record.get("diffHash"),
        "diffBytes": record.get("diffBytes"),
        "currentSourceMatches": current_source_matches,
        "currentIndexMatches": current_index_matches,
        "currentDiffMatches": current_diff_matches,
        "localVerificationComplete": record["state"] == "DIFF_VERIFIED",
        "result": record["result"] if authorization_current and record["state"] in {
            "LOCAL_WRITE_DONE", "INDEX_SYNCED", "DIFF_VERIFIED"
        } else None,
    }


def sync_page_node_operation_index(workspace: dict, config: dict, *, operation_id: str) -> dict:
    """Refresh only a completed local PAGE operation in the shared workspace index."""

    from common import gusen_hub
    from . import page_nodes

    require_capability(workspace, "edit")
    require_capability(workspace, "reindex")
    with operation_lock(workspace, "page-operation-index-sync", blocking=True,
                        timeout_seconds=DOCUMENT_LOCK_TIMEOUT_SECONDS):
        operation_path, record = _page_operation_by_id(workspace, operation_id)
        if record["state"] in {"INDEX_SYNCED", "DIFF_VERIFIED"}:
            return page_node_operation_status(workspace, operation_id=operation_id)
        if record["state"] != "LOCAL_WRITE_DONE":
            raise SystemExit("PAGE local write must finish before index sync")
        scope = load_authorized_scope(workspace)
        entry, path, _relative = resolve_authorized_path(scope, record["sourcePath"])
        if entry.id != record["scopeEntryId"] or not path.is_file():
            raise SystemExit("PAGE operation source is no longer authorized")
        if file_hash(path) != record["afterHash"]:
            raise SystemExit("PAGE operation source changed before index sync")
        if not workspace["indexPath"].is_file():
            raise SystemExit("PAGE index must be fully built before operation sync")
        with gusen_hub.index_connection(workspace, action="page-operation-index-sync", readonly=False) as conn:
            page_nodes._require_ready(conn)
            row = conn.execute(
                "SELECT source_hash, status FROM gusen_source_record "
                "WHERE provider='svn' AND source_path=? AND source_table='page' LIMIT 2",
                (record["sourcePath"],),
            ).fetchall()
            already_indexed = (len(row) == 1 and row[0]["source_hash"] == record["afterHash"]
                               and row[0]["status"] in {"OK", "SVN_DIRTY"})
            if not already_indexed:
                outcome = gusen_hub.index_svn_workspace_file(conn, config, workspace, record["sourcePath"])
                if outcome.get("failures") or outcome.get("ignored"):
                    raise SystemExit("PAGE operation index sync did not index the exact source")
                row = conn.execute(
                    "SELECT source_hash, status FROM gusen_source_record "
                    "WHERE provider='svn' AND source_path=? AND source_table='page' LIMIT 2",
                    (record["sourcePath"],),
                ).fetchall()
            if len(row) != 1 or row[0]["source_hash"] != record["afterHash"]:
                raise SystemExit("PAGE operation index hash differs from the written source")
            generation = page_nodes._require_ready(conn)
        if file_hash(path) != record["afterHash"]:
            raise SystemExit("PAGE operation source changed during index sync")
        record["indexGeneration"] = generation
        record["state"] = "INDEX_SYNCED"
        _save_page_operation(operation_path, record)
        return page_node_operation_status(workspace, operation_id=operation_id)


def verify_page_node_operation_diff(workspace: dict, *, operation_id: str) -> dict:
    """Verify the indexed PAGE against its exact SVN working-copy diff, without persisting source."""

    from common import gusen_hub
    from . import page_nodes

    require_capability(workspace, "edit")
    with operation_lock(workspace, "page-operation-diff-verify", blocking=True,
                        timeout_seconds=DOCUMENT_LOCK_TIMEOUT_SECONDS):
        operation_path, record = _page_operation_by_id(workspace, operation_id)
        if record["state"] == "DIFF_VERIFIED":
            return page_node_operation_status(workspace, operation_id=operation_id)
        if record["state"] != "INDEX_SYNCED":
            raise SystemExit("PAGE index must be synced before diff verification")
        scope = load_authorized_scope(workspace)
        entry, path, relative = resolve_authorized_path(scope, record["sourcePath"])
        if entry.id != record["scopeEntryId"] or not path.is_file():
            raise SystemExit("PAGE operation source is no longer authorized")
        if file_hash(path) != record["afterHash"]:
            raise SystemExit("PAGE operation source changed before diff verification")
        with gusen_hub.index_connection(workspace, action="page-operation-diff-verify") as conn:
            generation = page_nodes._require_ready(conn)
            rows = conn.execute(
                "SELECT source_hash FROM gusen_source_record "
                "WHERE provider='svn' AND source_path=? AND source_table='page' LIMIT 2",
                (record["sourcePath"],),
            ).fetchall()
            if len(rows) != 1 or rows[0]["source_hash"] != record["afterHash"]:
                raise SystemExit("PAGE operation index differs from the current source")
        if record["result"]["status"] == "LOCAL_MODIFIED":
            if not _is_safe_modified_file(entry, path):
                raise SystemExit("PAGE operation SVN status is not a safe modified file")
        elif any(change["path"] == relative for change in svn_path_changes(entry.root, path)):
            raise SystemExit("PAGE operation expected a clean SVN file")
        diff = run_svn_binary(["diff", "--", str(path)]).stdout
        if bool(diff) != (record["result"]["status"] == "LOCAL_MODIFIED"):
            raise SystemExit("PAGE operation SVN diff does not match its local state")
        if file_hash(path) != record["afterHash"]:
            raise SystemExit("PAGE operation source changed during diff verification")
        record["indexGeneration"] = generation
        record["diffHash"] = hashlib.sha256(diff).hexdigest()
        record["diffBytes"] = len(diff)
        record["state"] = "DIFF_VERIFIED"
        _save_page_operation(operation_path, record)
        return page_node_operation_status(workspace, operation_id=operation_id)


def resume_page_node_operation(workspace: dict, config: dict, *, operation_id: str) -> dict:
    """Resume only recorded post-write stages; never reconstruct or replay source content."""

    require_capability(workspace, "edit")
    with operation_lock(workspace, "page-operation-resume", blocking=True,
                        timeout_seconds=DOCUMENT_LOCK_TIMEOUT_SECONDS):
        operation_path, record = _page_operation_by_id(workspace, operation_id)
        if record["state"] == "PREFLIGHT_PASSED":
            if not _recover_page_operation_local_write(workspace, operation_path, record):
                return {
                    **page_node_operation_status(workspace, operation_id=operation_id),
                    "operationComplete": False,
                    "nextAction": "Retry the original request with the same idempotencyKey and content",
                }
        if record["state"] == "LOCAL_WRITE_DONE":
            sync_page_node_operation_index(workspace, config, operation_id=operation_id)
            record = _page_operation_by_id(workspace, operation_id)[1]
        if record["state"] == "INDEX_SYNCED":
            verify_page_node_operation_diff(workspace, operation_id=operation_id)
        status = page_node_operation_status(workspace, operation_id=operation_id)
        current = (status["localVerificationComplete"] and status["currentSourceMatches"]
                   and status["currentIndexMatches"] and status["currentDiffMatches"])
        return {
            **status, "operationComplete": current,
            **({"nextAction": "Operation evidence is no longer current; inspect source, index, and SVN diff"}
               if status["localVerificationComplete"] and not current else {}),
        }


def _page_operation_request_hash(session_id: str, changes: list[dict]) -> str:
    request = {"sessionId": session_id, "changes": changes}
    return _text_hash(json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def _page_operation_time() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _load_recorded_operation(path: Path, kind: str) -> dict | None:
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"{kind} operation record is unreadable; manual recovery required") from error
    if not isinstance(record, dict) or record.get("version") != 1:
        raise SystemExit(f"{kind} operation record is invalid; manual recovery required")
    required_strings = (
        "operationId", "workspaceKey", "sessionId", "requestHash", "state",
        "sourcePath", "scopeEntryId", "beforeHash", "afterHash",
    )
    if (any(not isinstance(record.get(key), str) or not record[key] for key in required_strings)
            or record["state"] not in {"PREFLIGHT_PASSED", "LOCAL_WRITE_DONE", "INDEX_SYNCED", "DIFF_VERIFIED"}
            or not isinstance(record.get("documents"), list)
            or not isinstance(record.get("result"), dict)
            or not isinstance(record.get("phaseTimes", {}), dict)):
        raise SystemExit(f"{kind} operation record is incomplete; manual recovery required")
    return record


def _load_page_operation(path: Path) -> dict | None:
    return _load_recorded_operation(path, "PAGE")


def _save_recorded_operation(path: Path, record: dict) -> None:
    record["updatedAt"] = _page_operation_time()
    record.setdefault("phaseTimes", {}).setdefault(record["state"], record["updatedAt"])
    new_directory = not path.parent.exists()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if new_directory and os.name != "nt":
        descriptor = os.open(path.parent.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    atomic_json(path, record)
    # The preflight journal must survive a rename before the source file may be
    # replaced. Windows directory fsync is not supported by this runtime and
    # remains an explicit D6 platform gate.
    if os.name != "nt":
        descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def _save_page_operation(path: Path, record: dict) -> None:
    _save_recorded_operation(path, record)


def _recover_recorded_local_write(workspace: dict, operation_path: Path, operation: dict) -> bool:
    """Advance a preflight record only when its exact candidate is already on disk."""

    scope = load_authorized_scope(workspace)
    entry, path, relative = resolve_authorized_path(scope, operation["sourcePath"])
    if (entry.id != operation["scopeEntryId"] or not path.is_file()
            or not source_path_writable(entry, relative)):
        raise SystemExit("Recorded operation source is no longer authorized")
    current_hash = file_hash(path)
    if current_hash == operation["beforeHash"] and current_hash != operation["afterHash"]:
        return False
    if current_hash != operation["afterHash"]:
        raise SystemExit("Recorded operation source changed outside the recorded write; manual recovery required")
    if (operation["result"]["status"] == "LOCAL_MODIFIED"
            and not _is_safe_modified_file(entry, path)):
        raise SystemExit("Recorded operation source has an unsafe SVN status")
    session = load_session(workspace)
    _validate_session(session, operation["sessionId"])
    file_record = session["files"].get(operation["sourcePath"])
    if not file_record or file_record.get("expectedCurrentHash") not in {
        operation["beforeHash"], operation["afterHash"]
    }:
        raise SystemExit("Recorded operation session file changed; manual recovery required")
    for document_state in operation["documents"]:
        document = session["documents"].get(document_state["documentId"])
        if (not document or document.get("sourcePath") != operation["sourcePath"]
                or document.get("jsonPointer") != document_state["jsonPointer"]
                or document.get("expectedSourceHash") not in {
                    operation["beforeHash"], operation["afterHash"]
                }):
            raise SystemExit("Recorded operation document lease changed; manual recovery required")
        document["expectedSourceHash"] = operation["afterHash"]
        document["expectedDocumentHash"] = document_state["documentHash"]
    file_record["expectedCurrentHash"] = operation["afterHash"]
    file_record["state"] = operation["result"]["status"]
    atomic_json(session_path(workspace), session)
    operation["state"] = "LOCAL_WRITE_DONE"
    _save_recorded_operation(operation_path, operation)
    return True


def _recover_page_operation_local_write(workspace: dict, operation_path: Path, operation: dict) -> bool:
    return _recover_recorded_local_write(workspace, operation_path, operation)


def write(workspace: dict, *, session_id: str, document_id: str, content: str) -> dict:
    require_capability(workspace, "edit")
    with operation_lock(
        workspace,
        "document-write",
        blocking=True,
        timeout_seconds=DOCUMENT_LOCK_TIMEOUT_SECONDS,
    ):
        session = load_session(workspace)
        _validate_session(session, session_id)
        prepared = _prepare_write(
            workspace,
            session,
            document_id=document_id,
            content=content,
        )
        try:
            result = _commit_prepared(workspace, session, prepared)
            atomic_json(session_path(workspace), session)
            return result
        except BaseException:
            _restore_prepared([prepared])
            raise


def write_batch(workspace: dict, *, session_id: str, changes: list[dict]) -> dict:
    require_capability(workspace, "edit")
    if not isinstance(changes, list) or not changes:
        raise SystemExit("SVN write-batch requires a non-empty changes array")
    if len(changes) > MAX_BATCH_CHANGES:
        raise SystemExit(f"SVN write-batch supports at most {MAX_BATCH_CHANGES} changes")
    with operation_lock(
        workspace,
        "document-write-batch",
        blocking=True,
        timeout_seconds=DOCUMENT_LOCK_TIMEOUT_SECONDS,
    ):
        session = load_session(workspace)
        _validate_session(session, session_id)
        prepared_items = []
        document_ids = set()
        source_paths = set()
        for index, change in enumerate(changes, 1):
            if not isinstance(change, dict):
                raise SystemExit(f"SVN write-batch change {index} must be an object")
            document_id = str(change.get("documentId") or "")
            if not document_id:
                raise SystemExit(f"SVN write-batch change {index} requires documentId")
            if document_id in document_ids:
                raise SystemExit(f"SVN write-batch repeats documentId: {document_id}")
            document_ids.add(document_id)
            prepared = _prepare_write(
                workspace,
                session,
                document_id=document_id,
                content=change.get("content"),
                replacements=change.get("replacements"),
            )
            source_path = prepared["item"]["source_path"]
            if source_path in source_paths:
                raise SystemExit(
                    f"SVN write-batch requires one change per physical source file: {source_path}"
                )
            source_paths.add(source_path)
            prepared_items.append(prepared)
        results = []
        try:
            for prepared in prepared_items:
                results.append(_commit_prepared(workspace, session, prepared))
            atomic_json(session_path(workspace), session)
        except BaseException:
            _restore_prepared(prepared_items)
            raise
        return {
            "ok": True,
            "changed": any(result["changed"] for result in results),
            "written": any(result["written"] for result in results),
            "workspaceKey": workspace["workspaceKey"],
            "sessionId": session["sessionId"],
            "sourcePaths": [result["sourcePath"] for result in results if result["written"]],
            "results": results,
        }


def write_page_nodes_batch(
    workspace: dict, *, session_id: str, changes: list[dict],
    idempotency_key: str | None = None, dry_run: bool = False,
) -> dict:
    """Apply several leased PAGE string fragments to one source snapshot and physical file.

    This shared primitive is also called by the opt-in MCP adapter through
    page_mutation. Field-array structural operations remain unavailable; the
    caller must advance index and diff stages before reporting completion.
    """

    require_capability(workspace, "edit")
    if not isinstance(changes, list) or not 1 <= len(changes) <= MAX_BATCH_CHANGES:
        raise SystemExit(f"PAGE node batch requires 1–{MAX_BATCH_CHANGES} changes")
    if not isinstance(dry_run, bool) or (dry_run and idempotency_key is not None):
        raise SystemExit("PAGE dry run must not reserve an idempotencyKey")
    operation_path = _page_operation_path(workspace, idempotency_key) if idempotency_key is not None else None
    try:
        request_hash = _page_operation_request_hash(session_id, changes) if operation_path else ""
    except (TypeError, ValueError) as error:
        raise SystemExit("PAGE node batch request must contain JSON-compatible values") from error
    with operation_lock(
        workspace, "page-nodes-write-batch", blocking=True,
        timeout_seconds=DOCUMENT_LOCK_TIMEOUT_SECONDS,
    ):
        session = load_session(workspace)
        _validate_session(session, session_id)
        operation = _load_page_operation(operation_path) if operation_path else None
        if operation:
            if (operation.get("workspaceKey") != workspace["workspaceKey"]
                    or operation.get("requestHash") != request_hash
                    or operation.get("sessionId") != session_id):
                raise SystemExit("PAGE idempotencyKey was already used for another request")
            if operation.get("state") in {"LOCAL_WRITE_DONE", "INDEX_SYNCED", "DIFF_VERIFIED"}:
                return operation["result"]
            if operation.get("state") != "PREFLIGHT_PASSED":
                raise SystemExit("PAGE operation state requires manual recovery")
            if _recover_page_operation_local_write(workspace, operation_path, operation):
                return operation["result"]
        prepared = []
        document_ids = set()
        pointers = set()
        for index, change in enumerate(changes, 1):
            if not isinstance(change, dict) or set(change) != {"documentId", "content"}:
                raise SystemExit(f"PAGE node change {index} requires documentId and content only")
            document_id = change["documentId"]
            if not isinstance(document_id, str) or not document_id or document_id in document_ids:
                raise SystemExit(f"PAGE node change {index} repeats or omits documentId")
            document_ids.add(document_id)
            item = _prepare_write(
                workspace, session, document_id=document_id, content=change["content"],
            )
            pointer = item["document"].get("jsonPointer") or ""
            if (item["item"]["source_table"] != "page"
                    or item["path"].suffix.lower() != ".json"
                    or item["document"].get("fragmentType") not in PAGE_FRAGMENT_TYPES - {"page-fields"}
                    or not pointer):
                raise SystemExit("PAGE node batch accepts only leased PAGE script/SQL string fragments")
            if pointer in pointers:
                raise SystemExit(f"PAGE node batch repeats JSON Pointer: {pointer}")
            pointers.add(pointer)
            if prepared and (item["item"]["source_path"] != prepared[0]["item"]["source_path"]
                             or item["sourceHash"] != prepared[0]["sourceHash"]
                             or item["sourceBytes"] != prepared[0]["sourceBytes"]):
                raise SystemExit("PAGE node batch must use one physical source snapshot")
            prepared.append(item)

        first = prepared[0]
        source_text, detected_format = decode_source(first["sourceBytes"])
        data = json.loads(source_text)
        if not isinstance(data, dict):
            raise SystemExit("Double-encoded PAGE JSON is read-only")
        expected = {item["document"]["jsonPointer"]: pointer_value(data, item["document"]["jsonPointer"])
                    for item in prepared}
        replacements = {item["document"]["jsonPointer"]: item["content"] for item in prepared}
        base_source_text = _base_source_text(first["path"])
        encoded_replacements = {}
        for item in prepared:
            if base_source_text is not None and item["content"] == item["baseContent"]:
                base_token = _base_json_string_token(
                    base_source_text, item["document"]["jsonPointer"]
                )
                if base_token:
                    encoded_replacements[item["document"]["jsonPointer"]] = base_token
        after_text = replace_json_strings(source_text, replacements, expected, encoded_replacements)
        parsed_after = json.loads(after_text)
        if str(parsed_after.get("pageId") or first["item"]["source_id"]) != first["item"]["source_id"]:
            raise SystemExit("PAGE identity changed during node batch save")
        after_bytes = encode_source_exact(after_text, detected_format)
        base_bytes = (encode_source_exact(base_source_text, detected_format)
                      if base_source_text is not None else None)
        physical_changed = after_bytes != first["sourceBytes"]
        returns_to_base = base_bytes is not None and after_bytes == base_bytes
        if returns_to_base:
            state = "EDITING"
        elif physical_changed or _is_safe_modified_file(first["entry"], first["path"]):
            state = "LOCAL_MODIFIED"
        else:
            state = "EDITING"
        combined = {
            **first, "afterBytes": after_bytes,
            "afterHash": hashlib.sha256(after_bytes).hexdigest(),
            "physicalChanged": physical_changed, "state": state,
        }
        if file_hash(first["path"]) != first["sourceHash"]:
            raise SystemExit("SVN_EDIT_CONFLICT: PAGE source changed during node batch preflight")
        document_states = [{
            "documentId": item["documentId"],
            "jsonPointer": item["document"]["jsonPointer"],
            "documentHash": _text_hash(item["content"]),
        } for item in prepared]
        if operation and (operation["sourcePath"] != first["item"]["source_path"]
                          or operation["scopeEntryId"] != first["entry"].id
                          or operation["beforeHash"] != first["sourceHash"]
                          or operation["afterHash"] != combined["afterHash"]
                          or operation["documents"] != document_states):
            raise SystemExit("PAGE operation candidate no longer matches its recorded preflight")
        results = [{
            **document_state,
            "changed": item["physicalChanged"] and not returns_to_base,
        } for document_state, item in zip(document_states, prepared)]
        result = {
            "ok": True, "workspaceKey": workspace["workspaceKey"],
            "sessionId": session["sessionId"], "sourcePath": first["item"]["source_path"],
            "workingCopyId": first["item"].get("working_copy_id") or first["entry"].id,
            "sourceHash": combined["afterHash"], "changed": physical_changed and not returns_to_base,
            "written": physical_changed, "status": state, "results": results,
        }
        if dry_run:
            return {
                "ok": True, "dryRun": True, "workspaceKey": workspace["workspaceKey"],
                "sourcePath": first["item"]["source_path"],
                "beforeHash": first["sourceHash"], "candidateSourceHash": combined["afterHash"],
                "changed": physical_changed, "byteDelta": len(after_bytes) - len(first["sourceBytes"]),
                "nodes": [{"jsonPointer": item["jsonPointer"], "changed": item["changed"]}
                          for item in results],
            }
        if operation_path:
            if operation is None:
                operation = {
                    "version": 1, "operationId": f"page-op:v1:{operation_path.stem}",
                    "workspaceKey": workspace["workspaceKey"], "sessionId": session_id,
                    "requestHash": request_hash, "state": "PREFLIGHT_PASSED",
                    "createdAt": _page_operation_time(),
                    "sourcePath": first["item"]["source_path"], "scopeEntryId": first["entry"].id,
                    "beforeHash": first["sourceHash"], "afterHash": combined["afterHash"],
                    "documents": document_states, "result": result,
                }
                operation["result"]["operationId"] = operation["operationId"]
                _save_page_operation(operation_path, operation)
            else:
                result = operation["result"]
        try:
            if physical_changed:
                _atomic_write(first["path"], after_bytes)
            after_hash = file_hash(first["path"])
            if after_hash != combined["afterHash"]:
                raise SystemExit("SVN source hash changed during PAGE node batch save")
            if state == "LOCAL_MODIFIED" and not _is_safe_modified_file(first["entry"], first["path"]):
                raise SystemExit("SVN status after PAGE node batch save is not a safe modified file")
            first["fileRecord"]["expectedCurrentHash"] = after_hash
            first["fileRecord"]["state"] = state
            for item, document_state in zip(prepared, document_states):
                item["document"]["expectedSourceHash"] = after_hash
                item["document"]["expectedDocumentHash"] = document_state["documentHash"]
            atomic_json(session_path(workspace), session)
        except BaseException:
            _restore_prepared([combined])
            raise
        if operation_path:
            operation["state"] = "LOCAL_WRITE_DONE"
            _save_page_operation(operation_path, operation)
        return result

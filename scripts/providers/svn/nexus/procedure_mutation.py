"""Guarded single-file SVN procedure edits shared by MCP and Nexus document primitives."""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from pathlib import Path

from common import gusen_hub
from providers.svn.checkout import (
    atomic_json, file_hash, operation_lock, require_capability, run_svn_binary,
    svn_path_changes,
)

from . import documents, index_queries, page_nodes, procedure_sources
from .manifest import load_authorized_scope, resolve_authorized_path, source_path_writable


EDIT_TOKEN_SECONDS = 30 * 60


def _operation_path(workspace: dict, idempotency_key: str) -> Path:
    if (not isinstance(idempotency_key, str) or not 8 <= len(idempotency_key) <= 128
            or any(ord(char) < 33 or ord(char) > 126 for char in idempotency_key)):
        raise page_nodes.PageIndexError(
            "INVALID_ARGUMENT", "idempotencyKey must be 8–128 printable ASCII characters without spaces",
        )
    digest = hashlib.sha256(idempotency_key.encode("ascii")).hexdigest()
    return workspace["contextDir"] / "procedure-operations" / f"{digest}.json"


def _operation_by_id(workspace: dict, operation_id: str) -> tuple[Path, dict]:
    prefix = "procedure-op:v1:"
    digest = operation_id[len(prefix):] if isinstance(operation_id, str) and operation_id.startswith(prefix) else ""
    if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        raise page_nodes.PageIndexError("INVALID_ARGUMENT", "Invalid procedure operationId")
    path = workspace["contextDir"] / "procedure-operations" / f"{digest}.json"
    record = documents._load_recorded_operation(path, "Procedure")
    if (record is None or record.get("workspaceKey") != workspace["workspaceKey"]
            or record.get("operationId") != operation_id or record.get("sourceType") != "procedure"):
        raise page_nodes.PageIndexError("OPERATION_NOT_FOUND", "Procedure operation was not found")
    return path, record


def _request_hash(edit_token: str, content: str | None, replacements: list | None) -> str:
    payload = {"editToken": edit_token, "content": content, "replacements": replacements}
    try:
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise page_nodes.PageIndexError("INVALID_TARGETS", "Procedure candidate is not JSON-compatible") from error
    return hashlib.sha256(encoded).hexdigest()


def _candidate(workspace: dict, session: dict, token: dict, *, content: str | None,
               replacements: list | None) -> dict:
    if (content is None) == (replacements is None):
        raise page_nodes.PageIndexError("INVALID_TARGETS", "Provide exactly one content or replacements")
    if content is not None and not isinstance(content, str):
        raise page_nodes.PageIndexError("INVALID_TARGETS", "content must be text")
    if replacements is not None and not isinstance(replacements, list):
        raise page_nodes.PageIndexError("INVALID_TARGETS", "replacements must be an array")
    if token["expiresAt"] < time.time():
        raise page_nodes.PageIndexError("EDIT_TOKEN_EXPIRED", "Procedure edit token expired")
    scope = load_authorized_scope(workspace)
    if token["scopeDigest"] != scope.digest:
        raise page_nodes.PageIndexError("EDIT_TOKEN_EXPIRED", "Procedure authorization changed")
    documents._validate_session(session, token["sessionId"])
    record, _generation = procedure_sources._record(
        workspace, source_namespace=token["sourceNamespace"], source_id=token["sourceId"],
        fun_id=token["funId"], working_copy_id=token["workingCopyId"],
    )
    if record["source_path"] != token["sourcePath"] or record["source_hash"] != token["sourceHash"]:
        raise page_nodes.PageIndexError("INDEX_STALE", "Procedure index changed since edit open")
    document = session["documents"].get(token["documentId"])
    if (not document or document.get("sourcePath") != token["sourcePath"]
            or document.get("expectedSourceHash") != token["sourceHash"]
            or document.get("expectedDocumentHash") != token["documentHash"]
            or document.get("jsonPointer")):
        raise page_nodes.PageIndexError("EDIT_TOKEN_STALE", "Procedure document lease changed")
    try:
        prepared = documents._prepare_write(
            workspace, session, document_id=token["documentId"],
            content=content, replacements=replacements,
        )
    except SystemExit as error:
        raise page_nodes.PageIndexError("EDIT_CONFLICT", str(error),
                                        next_action="Reopen the exact procedure and inspect SVN diff") from error
    if prepared["item"]["source_table"] != "procedure" or prepared["sourceHash"] != token["sourceHash"]:
        raise page_nodes.PageIndexError("SOURCE_STALE", "Procedure source changed during preflight")
    return prepared


def open_procedure_edit(
    workspace: dict, *, source_namespace: str, source_id: str, fun_id: str,
    working_copy_id: str,
) -> dict:
    require_capability(workspace, "edit")
    with operation_lock(workspace, "procedure-edit-open", blocking=True,
                        timeout_seconds=documents.DOCUMENT_LOCK_TIMEOUT_SECONDS):
        record, generation = procedure_sources._record(
            workspace, source_namespace=source_namespace, source_id=source_id,
            fun_id=fun_id, working_copy_id=working_copy_id,
        )
        _content, digest = procedure_sources._current_source(workspace, record)
        opened = documents.read(
            workspace, source_type="procedure", source_id=source_id, fun_id=fun_id,
            working_copy_id=working_copy_id,
        )
        if (not opened["editable"] or opened["sourcePath"] != record["source_path"]
                or opened["sourceHash"] != digest):
            raise page_nodes.PageIndexError("SOURCE_STALE", "Procedure edit lease could not bind the indexed source")
        token = "procedure-edit:v1:" + uuid.uuid4().hex
        expires_at = int(time.time()) + EDIT_TOKEN_SECONDS
        session = documents.load_session(workspace)
        documents._validate_session(session, opened["sessionId"])
        session["procedureEditTokens"][token] = {
            "documentId": opened["documentId"], "sessionId": opened["sessionId"],
            "sourceNamespace": source_namespace, "sourceId": source_id, "funId": fun_id,
            "workingCopyId": working_copy_id, "sourcePath": record["source_path"],
            "sourceHash": digest, "documentHash": opened["documentHash"],
            "scopeDigest": load_authorized_scope(workspace).digest, "expiresAt": expires_at,
        }
        documents._prune_document_leases(session)
        atomic_json(documents.session_path(workspace), session)
        return {
            "workspaceKey": workspace["workspaceKey"], "sourceType": "procedure",
            "sourceNamespace": source_namespace, "sourceId": source_id, "funId": fun_id,
            "workingCopyId": working_copy_id, "sourcePath": record["source_path"],
            "sourceHash": digest, "indexGeneration": generation,
            "editToken": token, "expiresAt": expires_at,
        }


def preview_procedure(
    workspace: dict, *, edit_token: str, content: str | None = None,
    replacements: list | None = None,
) -> dict:
    require_capability(workspace, "edit")
    with operation_lock(workspace, "procedure-edit-preview", blocking=True,
                        timeout_seconds=documents.DOCUMENT_LOCK_TIMEOUT_SECONDS):
        session = documents.load_session(workspace)
        token = session["procedureEditTokens"].get(edit_token)
        if not token:
            raise page_nodes.PageIndexError("EDIT_TOKEN_INVALID", "Procedure edit token is missing or expired")
        prepared = _candidate(workspace, session, token, content=content, replacements=replacements)
        return {
            "workspaceKey": workspace["workspaceKey"], "sourceType": "procedure",
            "sourceNamespace": token["sourceNamespace"], "sourceId": token["sourceId"],
            "funId": token["funId"], "workingCopyId": token["workingCopyId"],
            "sourcePath": token["sourcePath"], "beforeHash": prepared["sourceHash"],
            "candidateSourceHash": prepared["afterHash"], "changed": prepared["physicalChanged"],
            "byteDelta": len(prepared["afterBytes"]) - len(prepared["sourceBytes"]),
            "dryRun": True,
        }


def update_procedure(
    workspace: dict, *, edit_token: str, idempotency_key: str,
    content: str | None = None, replacements: list | None = None,
) -> dict:
    require_capability(workspace, "edit")
    operation_path = _operation_path(workspace, idempotency_key)
    request_hash = _request_hash(edit_token, content, replacements)
    with operation_lock(workspace, "procedure-edit-write", blocking=True,
                        timeout_seconds=documents.DOCUMENT_LOCK_TIMEOUT_SECONDS):
        operation = documents._load_recorded_operation(operation_path, "Procedure")
        if operation:
            if (operation.get("requestHash") != request_hash
                    or operation.get("workspaceKey") != workspace["workspaceKey"]
                    or operation.get("sourceType") != "procedure"
                    or operation.get("operationId") != f"procedure-op:v1:{operation_path.stem}"):
                raise page_nodes.PageIndexError("IDEMPOTENCY_CONFLICT", "Key was used for another procedure edit")
            if operation["state"] in {"LOCAL_WRITE_DONE", "INDEX_SYNCED", "DIFF_VERIFIED"}:
                return operation_status(workspace, operation_id=operation["operationId"])
            if documents._recover_recorded_local_write(workspace, operation_path, operation):
                return operation_status(workspace, operation_id=operation["operationId"])
        session = documents.load_session(workspace)
        token = session["procedureEditTokens"].get(edit_token)
        if not token:
            raise page_nodes.PageIndexError("EDIT_TOKEN_INVALID", "Procedure edit token is missing or expired")
        prepared = _candidate(workspace, session, token, content=content, replacements=replacements)
        if operation and (operation["sourcePath"] != token["sourcePath"]
                          or operation["beforeHash"] != prepared["sourceHash"]
                          or operation["afterHash"] != prepared["afterHash"]):
            raise page_nodes.PageIndexError("IDEMPOTENCY_CONFLICT", "Recorded procedure candidate changed")
        if file_hash(prepared["path"]) != prepared["sourceHash"]:
            raise page_nodes.PageIndexError("SOURCE_STALE", "Procedure source changed during preflight")
        if operation is None:
            operation = {
                "version": 1, "sourceType": "procedure",
                "operationId": f"procedure-op:v1:{operation_path.stem}",
                "workspaceKey": workspace["workspaceKey"], "sessionId": token["sessionId"],
                "requestHash": request_hash, "state": "PREFLIGHT_PASSED",
                "createdAt": documents._page_operation_time(),
                "sourcePath": token["sourcePath"], "scopeEntryId": prepared["entry"].id,
                "beforeHash": prepared["sourceHash"], "afterHash": prepared["afterHash"],
                "documents": [{"documentId": token["documentId"], "jsonPointer": "",
                               "documentHash": documents._text_hash(prepared["content"])}],
                "result": {
                    "workspaceKey": workspace["workspaceKey"], "sourceType": "procedure",
                    "sourceNamespace": token["sourceNamespace"], "sourceId": token["sourceId"],
                    "funId": token["funId"], "workingCopyId": token["workingCopyId"],
                    "sourcePath": token["sourcePath"], "beforeHash": prepared["sourceHash"],
                    "afterHash": prepared["afterHash"], "changed": prepared["changed"],
                    "written": prepared["physicalChanged"], "status": prepared["state"],
                },
            }
            documents._save_recorded_operation(operation_path, operation)
        try:
            documents._commit_prepared(workspace, session, prepared)
            atomic_json(documents.session_path(workspace), session)
        except BaseException:
            documents._restore_prepared([prepared])
            raise
        operation["state"] = "LOCAL_WRITE_DONE"
        documents._save_recorded_operation(operation_path, operation)
        return operation_status(workspace, operation_id=operation["operationId"])


def operation_status(workspace: dict, *, operation_id: str = "", idempotency_key: str = "") -> dict:
    require_capability(workspace, "edit")
    if bool(operation_id) == bool(idempotency_key):
        raise page_nodes.PageIndexError("INVALID_ARGUMENT", "Provide exactly one operationId or idempotencyKey")
    if idempotency_key:
        operation_id = f"procedure-op:v1:{_operation_path(workspace, idempotency_key).stem}"
    _path, record = _operation_by_id(workspace, operation_id)
    authorization_current = False
    source_matches = False
    index_matches = False
    diff_matches = False
    try:
        scope = load_authorized_scope(workspace)
        entry, path, relative = resolve_authorized_path(scope, record["sourcePath"])
        authorization_current = (entry.id == record["scopeEntryId"]
                                 and source_path_writable(entry, relative))
        source_matches = authorization_current and path.is_file() and file_hash(path) == record["afterHash"]
    except (OSError, SystemExit, ValueError):
        pass
    if source_matches:
        try:
            with index_queries._connection(workspace) as conn:
                rows = conn.execute(
                    "SELECT source_hash FROM gusen_source_record WHERE provider='svn' "
                    "AND source_table='procedure' AND source_path=? LIMIT 2",
                    (record["sourcePath"],),
                ).fetchall()
                index_matches = len(rows) == 1 and rows[0]["source_hash"] == record["afterHash"]
        except (OSError, SystemExit, ValueError):
            pass
        if record["state"] == "DIFF_VERIFIED" and index_matches:
            try:
                diff = run_svn_binary(["diff", "--", str(path)]).stdout
                diff_matches = (len(diff) == record.get("diffBytes")
                                and hashlib.sha256(diff).hexdigest() == record.get("diffHash"))
            except (OSError, SystemExit, ValueError):
                pass
    return {
        "workspaceKey": workspace["workspaceKey"], "operationId": operation_id,
        "state": record["state"], "createdAt": record["createdAt"],
        "updatedAt": record.get("updatedAt"), "phaseTimes": record.get("phaseTimes", {}),
        "authorizationCurrent": authorization_current, "currentSourceMatches": source_matches,
        "currentIndexMatches": index_matches, "currentDiffMatches": diff_matches,
        "sourcePath": record["sourcePath"] if authorization_current else None,
        "beforeHash": record["beforeHash"], "afterHash": record["afterHash"],
        "indexGeneration": record.get("indexGeneration"),
        "diffHash": record.get("diffHash"), "diffBytes": record.get("diffBytes"),
        "localVerificationComplete": record["state"] == "DIFF_VERIFIED",
        "result": record["result"] if authorization_current and record["state"] != "PREFLIGHT_PASSED" else None,
    }


def resume_operation(workspace: dict, config: dict, *, operation_id: str) -> dict:
    require_capability(workspace, "edit")
    with operation_lock(workspace, "procedure-operation-resume", blocking=True,
                        timeout_seconds=documents.DOCUMENT_LOCK_TIMEOUT_SECONDS):
        operation_path, record = _operation_by_id(workspace, operation_id)
        if record["state"] == "PREFLIGHT_PASSED":
            if not documents._recover_recorded_local_write(workspace, operation_path, record):
                return {**operation_status(workspace, operation_id=operation_id),
                        "operationComplete": False,
                        "nextAction": "Retry the original request with the same idempotencyKey and candidate"}
            record = _operation_by_id(workspace, operation_id)[1]
        scope = load_authorized_scope(workspace)
        entry, path, relative = resolve_authorized_path(scope, record["sourcePath"])
        if (entry.id != record["scopeEntryId"] or not path.is_file()
                or not source_path_writable(entry, relative) or file_hash(path) != record["afterHash"]):
            raise page_nodes.PageIndexError("SOURCE_STALE", "Procedure changed before operation verification")
        if record["state"] == "LOCAL_WRITE_DONE":
            require_capability(workspace, "reindex")
            with gusen_hub.index_connection(workspace, action="procedure-operation-index-sync", readonly=False) as conn:
                page_nodes._require_source_ready(conn)
                rows = conn.execute(
                    "SELECT source_hash, status FROM gusen_source_record WHERE provider='svn' "
                    "AND source_table='procedure' AND source_path=? LIMIT 2",
                    (record["sourcePath"],),
                ).fetchall()
                if not (len(rows) == 1 and rows[0]["source_hash"] == record["afterHash"]
                        and rows[0]["status"] in {"OK", "SVN_DIRTY"}):
                    outcome = gusen_hub.index_svn_workspace_file(
                        conn, config, workspace, record["sourcePath"],
                    )
                    if outcome.get("failures") or outcome.get("ignored"):
                        raise page_nodes.PageIndexError("INDEX_STALE", "Procedure index sync failed")
                rows = conn.execute(
                    "SELECT source_hash FROM gusen_source_record WHERE provider='svn' "
                    "AND source_table='procedure' AND source_path=? LIMIT 2",
                    (record["sourcePath"],),
                ).fetchall()
                if len(rows) != 1 or rows[0]["source_hash"] != record["afterHash"]:
                    raise page_nodes.PageIndexError("INDEX_STALE", "Procedure index differs from written source")
                record["indexGeneration"] = page_nodes._require_source_ready(conn)
            if file_hash(path) != record["afterHash"]:
                raise page_nodes.PageIndexError("SOURCE_STALE", "Procedure changed during index sync")
            record["state"] = "INDEX_SYNCED"
            documents._save_recorded_operation(operation_path, record)
        if record["state"] == "INDEX_SYNCED":
            with index_queries._connection(workspace) as conn:
                rows = conn.execute(
                    "SELECT source_hash FROM gusen_source_record WHERE provider='svn' "
                    "AND source_table='procedure' AND source_path=? LIMIT 2",
                    (record["sourcePath"],),
                ).fetchall()
                if len(rows) != 1 or rows[0]["source_hash"] != record["afterHash"]:
                    raise page_nodes.PageIndexError("INDEX_STALE", "Procedure index changed before diff verification")
            if record["result"]["status"] == "LOCAL_MODIFIED":
                if not documents._is_safe_modified_file(entry, path):
                    raise page_nodes.PageIndexError("SVN_STATUS_UNSAFE", "Procedure SVN status is unsafe")
            elif any(change["path"] == relative for change in svn_path_changes(entry.root, path)):
                raise page_nodes.PageIndexError("SVN_STATUS_UNSAFE", "Procedure expected a clean SVN file")
            diff = run_svn_binary(["diff", "--", str(path)]).stdout
            if bool(diff) != (record["result"]["status"] == "LOCAL_MODIFIED"):
                raise page_nodes.PageIndexError("DIFF_MISMATCH", "Procedure SVN diff disagrees with local state")
            if file_hash(path) != record["afterHash"]:
                raise page_nodes.PageIndexError("SOURCE_STALE", "Procedure changed during diff verification")
            record["diffHash"] = hashlib.sha256(diff).hexdigest()
            record["diffBytes"] = len(diff)
            record["state"] = "DIFF_VERIFIED"
            documents._save_recorded_operation(operation_path, record)
        status = operation_status(workspace, operation_id=operation_id)
        current = (status["localVerificationComplete"] and status["currentSourceMatches"]
                   and status["currentIndexMatches"] and status["currentDiffMatches"])
        return {**status, "operationComplete": current,
                **({"nextAction": "Inspect source, index, and SVN diff; operation evidence changed"}
                   if status["localVerificationComplete"] and not current else {})}

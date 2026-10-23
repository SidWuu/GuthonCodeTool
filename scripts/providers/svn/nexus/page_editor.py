"""PAGE-level visual editing on the shared SVN lease and operation ledger."""
from __future__ import annotations

import time
import uuid
import json

from common.page_editor import describe, MAX_PAGE_BYTES
from common.page_projection import extract_page_nodes
from common.source_format import decode_source
from providers.svn.checkout import atomic_json, file_hash, operation_lock, require_capability
from . import documents, page_field_mutation, page_nodes
from .manifest import load_authorized_scope, resolve_authorized_path


def open_editor(workspace, *, source_namespace, source_id, fun_id=""):
    require_capability(workspace, "browse")
    with operation_lock(workspace, "page-editor-open", blocking=True,
                        timeout_seconds=documents.DOCUMENT_LOCK_TIMEOUT_SECONDS):
        _, record, data = page_field_mutation._source_snapshot(workspace, source_namespace, source_id, fun_id)
        _, path, _ = resolve_authorized_path(load_authorized_scope(workspace), record["source_path"])
        if path.stat().st_size > MAX_PAGE_BYTES:
            raise ValueError("PAGE exceeds the 4 MB local editor limit")
        text = decode_source(path.read_bytes())[0]
        model = describe(text)
        anchor = next((node for node in extract_page_nodes(data)
                       if node.node_type == "FIELD_COLLECTION"), None)
        if anchor is None:
            anchor = next((node for node in extract_page_nodes(data) if node.node_type in {"SCRIPT", "SQL"}), None)
        opened = documents.read(workspace, source_type="page", source_id=source_id, fun_id=fun_id,
                                json_pointer=anchor.json_pointer if anchor else "",
                                working_copy_id=record["working_copy_id"])
        token = ""
        if opened["editable"]:
            if opened["sourceHash"] != record["source_hash"]:
                raise ValueError("PAGE source changed during editor open")
            token = "page-editor:v1:" + uuid.uuid4().hex
            session = documents.load_session(workspace)
            session["pageEditTokens"][token] = {
                "kind": "PAGE_EDITOR", "documentId": opened["documentId"],
                "sessionId": opened["sessionId"], "sourcePath": record["source_path"],
                "sourceHash": opened["sourceHash"], "scopeDigest": load_authorized_scope(workspace).digest,
                "expiresAt": int(time.time()) + 30 * 60, "anchorContent": opened["content"],
            }
            documents._prune_document_leases(session)
            atomic_json(documents.session_path(workspace), session)
        result = {"workspaceKey": workspace["workspaceKey"], "sourceNamespace": source_namespace,
                "sourceId": source_id, "funId": fun_id, "workingCopyId": record["working_copy_id"],
                "sourcePath": record["source_path"], "sourceHash": opened["sourceHash"],
                "baseRevision": record.get("svn_revision", ""), "editToken": token,
                "editable": bool(token), "model": model, "sourceText": text,
                "expiresAt": session["pageEditTokens"][token]["expiresAt"] if token else 0}
        if len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > 6 * 1024 * 1024:
            raise ValueError("PAGE editor snapshot exceeds the ToolHost response budget; use fragment editors")
        return result


def save_editor(workspace, config, *, edit_token, operations, idempotency_key="", dry_run=False):
    require_capability(workspace, "edit")
    with operation_lock(workspace, "page-editor-save", blocking=True,
                        timeout_seconds=documents.DOCUMENT_LOCK_TIMEOUT_SECONDS):
        session = documents.load_session(workspace)
        token = session["pageEditTokens"].get(edit_token)
        if not token or token.get("kind") != "PAGE_EDITOR":
            raise ValueError("PAGE editor lease is missing; reopen the editor")
        documents._validate_session(session, token["sessionId"])
        if token["scopeDigest"] != load_authorized_scope(workspace).digest:
            raise ValueError("PAGE authorization changed; reopen the editor")
        if token["expiresAt"] < time.time():
            raise ValueError("PAGE editor lease expired; preserve the draft and reopen")
        # A retry after an interrupted write uses exactly the recorded request.
        recorded = (documents._load_page_operation(documents._page_operation_path(workspace, idempotency_key))
                    if idempotency_key and not dry_run else None)
        if not recorded:
            _, path, _ = resolve_authorized_path(load_authorized_scope(workspace), token["sourcePath"])
            if file_hash(path) != token["sourceHash"]:
                raise ValueError("SVN_EDIT_CONFLICT: PAGE source changed; draft was not written")
        result = documents.write_page_nodes_batch(
            workspace, session_id=token["sessionId"],
            changes=[{"documentId": token["documentId"], "content": token["anchorContent"]}],
            idempotency_key=None if dry_run else idempotency_key, dry_run=dry_run,
            editor_operations=operations,
        )
        if dry_run:
            return result
    try:
        return documents.resume_page_node_operation(workspace, config, operation_id=result["operationId"])
    except (OSError, ValueError, SystemExit, page_nodes.PageIndexError):
        return {**documents.page_node_operation_status(workspace, operation_id=result["operationId"]),
                "operationComplete": False, "warnings": ["本地写入已记录，后续校验待恢复；请按 operationId 恢复"]}


def run(workspace, config, payload):
    if not isinstance(payload, dict):
        raise ValueError("PAGE editor requires a JSON object")
    action = payload.get("action")
    if action == "open" and set(payload) <= {"action", "sourceNamespace", "sourceId", "funId"}:
        if (any(not isinstance(payload.get(key), str) or not payload[key].strip() or len(payload[key]) > 512
                for key in ("sourceNamespace", "sourceId"))
                or not isinstance(payload.get("funId", ""), str) or len(payload.get("funId", "")) > 512):
            raise ValueError("Explicit sourceNamespace and sourceId are required")
        return open_editor(workspace, source_namespace=payload["sourceNamespace"],
                           source_id=payload["sourceId"], fun_id=payload.get("funId", ""))
    if action in {"preview", "save"} and set(payload) <= {"action", "editToken", "operations", "idempotencyKey"}:
        if not isinstance(payload.get("editToken"), str):
            raise ValueError("editToken is required")
        if action == "save" and (not isinstance(payload.get("idempotencyKey"), str) or not payload["idempotencyKey"]):
            raise ValueError("Saving requires an idempotencyKey")
        return save_editor(workspace, config, edit_token=payload["editToken"], operations=payload.get("operations"),
                           idempotency_key=payload.get("idempotencyKey", ""), dry_run=action == "preview")
    if action == "resume" and set(payload) == {"action", "operationId"}:
        if not isinstance(payload["operationId"], str):
            raise ValueError("operationId must be text")
        return documents.resume_page_node_operation(workspace, config, operation_id=payload["operationId"])
    raise ValueError("Unsupported PAGE editor action or arguments")

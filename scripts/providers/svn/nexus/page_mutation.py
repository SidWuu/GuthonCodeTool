"""Shared, source-bound edit leases for stable SVN PAGE script and SQL nodes."""

from __future__ import annotations

import time
import uuid

from providers.svn.checkout import atomic_json, file_hash, operation_lock, require_capability

from . import documents, page_nodes
from .manifest import load_authorized_scope, resolve_authorized_path, source_path_writable


EDIT_TOKEN_SECONDS = 30 * 60


def open_node_for_edit(
    workspace: dict, *, source_namespace: str, source_id: str,
    semantic_node_id: str, fun_id: str = "",
) -> dict:
    """Issue an opaque short lease for one stable script/SQL node, never a field array."""

    require_capability(workspace, "edit")
    if not isinstance(semantic_node_id, str) or not semantic_node_id.startswith("page-node:v1:"):
        raise page_nodes.PageIndexError("INVALID_TARGETS", "A stable semanticNodeId is required for editing")
    with operation_lock(workspace, "page-node-edit-open", blocking=True,
                        timeout_seconds=documents.DOCUMENT_LOCK_TIMEOUT_SECONDS):
        selected = page_nodes.read_nodes(
            workspace, source_namespace=source_namespace, source_id=source_id,
            fun_id=fun_id, targets=[{"semanticNodeId": semantic_node_id}],
            max_chars=page_nodes.MAX_READ_CHARS,
        )
        node = selected["nodes"][0]
        if node["truncated"] or node["nodeType"] not in {"SCRIPT", "SQL"}:
            raise page_nodes.PageIndexError("NODE_NOT_EDITABLE", "Only complete script or SQL nodes may be edited")
        with page_nodes._connection(workspace) as conn:
            page_nodes._require_ready(conn)
            record = page_nodes._page_record(conn, source_namespace, source_id, fun_id)
        if record["source_path"] != selected["sourcePath"] or record["source_hash"] != selected["indexedSourceHash"]:
            raise page_nodes.PageIndexError("INDEX_STALE", "PAGE locator changed during edit open")
        opened = documents.read(
            workspace, source_type="page", source_id=source_id, fun_id=fun_id,
            json_pointer=node["jsonPointer"], working_copy_id=record["working_copy_id"],
        )
        if (not opened["editable"] or opened["sourcePath"] != record["source_path"]
                or opened["sourceHash"] != record["source_hash"]
                or opened["content"] != node["content"]):
            raise page_nodes.PageIndexError("SOURCE_STALE", "PAGE edit lease could not bind the indexed source")
        token = "page-edit:v1:" + uuid.uuid4().hex
        expires_at = int(time.time()) + EDIT_TOKEN_SECONDS
        scope = load_authorized_scope(workspace)
        session = documents.load_session(workspace)
        documents._validate_session(session, opened["sessionId"])
        session["pageEditTokens"][token] = {
            "documentId": opened["documentId"], "sessionId": opened["sessionId"],
            "sourceNamespace": source_namespace, "sourceId": source_id, "funId": fun_id,
            "sourcePath": record["source_path"], "scopeEntryId": record["scope_entry_id"],
            "semanticNodeId": semantic_node_id, "jsonPointer": node["jsonPointer"],
            "sourceHash": record["source_hash"], "documentHash": opened["documentHash"],
            "scopeDigest": scope.digest, "expiresAt": expires_at,
        }
        documents._prune_document_leases(session)
        atomic_json(documents.session_path(workspace), session)
        return {
            "workspaceKey": workspace["workspaceKey"], "sourceNamespace": source_namespace,
            "sourceType": "page", "sourceId": source_id, "funId": fun_id,
            "semanticNodeId": semantic_node_id, "jsonPointer": node["jsonPointer"],
            "nodeType": node["nodeType"], "editToken": token, "expiresAt": expires_at,
            "indexedSourceHash": record["source_hash"], "documentHash": opened["documentHash"],
            "indexGeneration": selected["indexGeneration"], "content": opened["content"],
        }


def write_nodes(
    workspace: dict, *, changes: list[dict], idempotency_key: str = "", dry_run: bool = False,
) -> dict:
    """Preview or write one PAGE's leased script/SQL nodes.

    A separate operation resume advances index and diff after a real write.
    """

    require_capability(workspace, "edit")
    if not isinstance(changes, list) or not 1 <= len(changes) <= documents.MAX_BATCH_CHANGES:
        raise page_nodes.PageIndexError("INVALID_TARGETS", "A bounded nonempty node changes array is required")
    if not isinstance(dry_run, bool):
        raise page_nodes.PageIndexError("INVALID_ARGUMENT", "dryRun must be a boolean")
    if not dry_run:
        documents._page_operation_path(workspace, idempotency_key)
    with operation_lock(workspace, "page-node-edit-write", blocking=True,
                        timeout_seconds=documents.DOCUMENT_LOCK_TIMEOUT_SECONDS):
        session = documents.load_session(workspace)
        tokens = []
        document_changes = []
        for change in changes:
            if (not isinstance(change, dict) or set(change) != {"editToken", "content"}
                    or not isinstance(change["editToken"], str)
                    or not isinstance(change["content"], str)):
                raise page_nodes.PageIndexError("INVALID_TARGETS", "Each node change requires editToken and text content")
            token = session["pageEditTokens"].get(change["editToken"])
            if not token:
                raise page_nodes.PageIndexError("EDIT_TOKEN_INVALID", "PAGE edit token is missing or expired")
            tokens.append(token)
            document_changes.append({"documentId": token["documentId"], "content": change["content"]})
        if len({token["documentId"] for token in tokens}) != len(tokens):
            raise page_nodes.PageIndexError("INVALID_TARGETS", "PAGE edit token is repeated")
        session_id = tokens[0]["sessionId"]
        documents._validate_session(session, session_id)
        if any(token["sessionId"] != session_id for token in tokens):
            raise page_nodes.PageIndexError("EDIT_TOKEN_INVALID", "PAGE edit tokens belong to different sessions")
        scope = load_authorized_scope(workspace)
        if any(token["scopeDigest"] != scope.digest for token in tokens):
            raise page_nodes.PageIndexError("EDIT_TOKEN_EXPIRED", "PAGE authorization changed after edit open")
        operation_path = documents._page_operation_path(workspace, idempotency_key) if not dry_run else None
        if operation_path and documents._load_page_operation(operation_path) is not None:
            return documents.write_page_nodes_batch(
                workspace, session_id=session_id, changes=document_changes,
                idempotency_key=idempotency_key,
            )
        first = tokens[0]
        identity = (first["sourceNamespace"], first["sourceId"], first["funId"],
                    first["sourcePath"], first["sourceHash"])
        if any((token["sourceNamespace"], token["sourceId"], token["funId"],
                token["sourcePath"], token["sourceHash"]) != identity for token in tokens):
            raise page_nodes.PageIndexError("INVALID_TARGETS", "All edit tokens must bind one PAGE snapshot")
        entry, path, relative = resolve_authorized_path(scope, first["sourcePath"])
        if (entry.id != first["scopeEntryId"] or not source_path_writable(entry, relative)
                or not path.is_file() or file_hash(path) != first["sourceHash"]):
            raise page_nodes.PageIndexError("SOURCE_STALE", "PAGE source or authorization changed after edit open")
        if any(token["scopeDigest"] != scope.digest or token["expiresAt"] < time.time() for token in tokens):
            raise page_nodes.PageIndexError("EDIT_TOKEN_EXPIRED", "PAGE edit token or authorization expired")
        with page_nodes._connection(workspace) as conn:
            page_nodes._require_ready(conn)
            record = page_nodes._page_record(conn, *identity[:3])
            if record["source_path"] != first["sourcePath"] or record["source_hash"] != first["sourceHash"]:
                raise page_nodes.PageIndexError("INDEX_STALE", "PAGE index changed after edit open")
            for token in tokens:
                rows = conn.execute(
                    "SELECT json_pointer, node_type, content_hash, identity_stability "
                    "FROM gusen_page_node WHERE source_record_id=? AND semantic_node_id=? LIMIT 2",
                    (record["record_id"], token["semanticNodeId"]),
                ).fetchall()
                document = session["documents"].get(token["documentId"])
                if (len(rows) != 1 or rows[0]["identity_stability"] != "STABLE"
                        or rows[0]["node_type"] not in {"SCRIPT", "SQL"}
                        or rows[0]["json_pointer"] != token["jsonPointer"]
                        or rows[0]["content_hash"] != token["documentHash"]
                        or not document or document.get("expectedSourceHash") != token["sourceHash"]
                        or document.get("expectedDocumentHash") != token["documentHash"]):
                    raise page_nodes.PageIndexError("EDIT_TOKEN_STALE", "PAGE node or lease changed after edit open")
        return documents.write_page_nodes_batch(
            workspace, session_id=session_id, changes=document_changes,
            idempotency_key=idempotency_key if not dry_run else None,
            dry_run=dry_run,
        )

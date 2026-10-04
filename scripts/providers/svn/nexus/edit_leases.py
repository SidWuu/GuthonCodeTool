"""Shared lifecycle for source-bound PAGE and procedure edit leases."""
from __future__ import annotations

import time

from providers.svn.checkout import atomic_json, file_hash, operation_lock, require_capability
from . import documents, page_nodes, procedure_sources
from .manifest import load_authorized_scope

RENEW_SECONDS = 30 * 60


def renew_edit_token(workspace: dict, *, edit_token: str) -> dict:
    """Extend a live unchanged lease, never resurrect an expired or refreshed one."""
    require_capability(workspace, "edit")
    with operation_lock(workspace, "edit-token-renew", blocking=True,
                        timeout_seconds=documents.DOCUMENT_LOCK_TIMEOUT_SECONDS):
        session = documents.load_session(workspace)
        source_type = "procedure" if edit_token in session["procedureEditTokens"] else "page"
        token = session["procedureEditTokens" if source_type == "procedure" else "pageEditTokens"].get(edit_token)
        if not token:
            raise page_nodes.PageIndexError("EDIT_TOKEN_INVALID", "Edit token is missing or released")
        now = time.time()
        if token.get("expiresAt", 0) < now or token["scopeDigest"] != load_authorized_scope(workspace).digest:
            raise page_nodes.PageIndexError("EDIT_TOKEN_EXPIRED", "Edit token expired or source authorization changed")
        documents._validate_session(session, token["sessionId"])
        try:
            selected = documents._session_document(workspace, session, token["documentId"])
        except SystemExit as error:
            raise page_nodes.PageIndexError("EDIT_TOKEN_STALE", str(error)) from error
        document = selected["document"]
        if (document.get("expectedSourceHash") != token["sourceHash"]
                or document.get("expectedDocumentHash") != token["documentHash"]
                or file_hash(selected["path"]) != token["sourceHash"]):
            raise page_nodes.PageIndexError("SOURCE_STALE", "Source or document changed since this edit token was opened")
        if source_type == "procedure":
            record, generation = procedure_sources._record(
                workspace, source_namespace=token["sourceNamespace"], source_id=token["sourceId"],
                fun_id=token["funId"], working_copy_id=token["workingCopyId"],
            )
        else:
            with page_nodes._connection(workspace) as conn:
                generation = page_nodes._require_ready(conn)
                record = page_nodes._page_record(conn, token["sourceNamespace"], token["sourceId"], token["funId"])
        if record["source_path"] != token["sourcePath"] or record["source_hash"] != token["sourceHash"]:
            raise page_nodes.PageIndexError("INDEX_STALE", "Indexed source changed since this edit token was opened")
        token["expiresAt"] = int(now) + RENEW_SECONDS
        token["lastUsedAt"] = now
        atomic_json(documents.session_path(workspace), session)
        return {"workspaceKey": workspace["workspaceKey"], "editToken": edit_token,
                "documentId": token["documentId"], "sessionId": token["sessionId"], "sourceType": source_type,
                "sourceHash": token["sourceHash"], "expiresAt": token["expiresAt"],
                "indexGeneration": generation}


def release_edit_lease(workspace: dict, *, session_id: str, document_id: str) -> dict:
    """Release exactly one document and its opaque tokens; preserve files and other editors."""
    require_capability(workspace, "edit")
    if not isinstance(document_id, str) or not document_id:
        raise page_nodes.PageIndexError("INVALID_ARGUMENT", "documentId is required")
    with operation_lock(workspace, "edit-lease-release", blocking=True,
                        timeout_seconds=documents.DOCUMENT_LOCK_TIMEOUT_SECONDS):
        session = documents.load_session(workspace)
        documents._validate_session(session, session_id)
        from .operation_maintenance import _records

        records = _records(workspace)
        if any(not record.get("valid") for record in records):
            raise page_nodes.PageIndexError("JOURNAL_DAMAGED", "Inspect damaged operation records before releasing lease evidence")
        pending = [record for record in records if record.get("valid")
                   and record.get("state") != "DIFF_VERIFIED" and document_id in record.get("documentIds", [])]
        if pending:
            raise page_nodes.PageIndexError("OPERATION_PENDING", "Resume or recover the operation before releasing its edit lease")
        released = session["documents"].pop(document_id, None) is not None
        for key in ("pageEditTokens", "procedureEditTokens"):
            session[key] = {token: value for token, value in session[key].items()
                            if value.get("documentId") != document_id}
        atomic_json(documents.session_path(workspace), session)
        return {"workspaceKey": workspace["workspaceKey"], "sessionId": session_id,
                "documentId": document_id, "released": released}

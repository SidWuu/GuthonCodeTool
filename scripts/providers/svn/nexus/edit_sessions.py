"""Shared SVN edit-session ledger validation and bounded active leases."""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

SESSION_VERSION = 1

SESSION_FILE = "svn-edit-session.json"

MAX_DOCUMENT_LEASES = 1000

MAX_PAGE_EDIT_TOKENS = 1000

MAX_PROCEDURE_EDIT_TOKENS = 1000

def session_path(workspace: dict) -> Path:
    return workspace["contextDir"] / SESSION_FILE

def _prune_document_leases(session: dict) -> None:
    documents = session["documents"]
    # Active editors must never lose a lease because another caller browsed
    # many documents. Only known-invalid leases are expendable at capacity.
    overflow = len(documents) - MAX_DOCUMENT_LEASES
    for document_id, value in sorted(documents.items(), key=lambda item: item[1].get("lastUsedAt", 0)):
        if overflow <= 0:
            break
        if value.get("invalidatedReason"):
            documents.pop(document_id)
            overflow -= 1
    if overflow > 0:
        raise SystemExit("SVN edit lease capacity reached; refresh affected sources and reopen their editors; existing active leases were preserved")
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
        return {
            "version": SESSION_VERSION,
            "workspaceKey": workspace["workspaceKey"],
            "sessionId": str(uuid.uuid4()),
            "files": {},
            "documents": {},
            "pageEditTokens": {},
            "procedureEditTokens": {},
        }
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"Invalid SVN edit session: {path}; manual recovery required") from error
    if not isinstance(value, dict):
        raise SystemExit(f"Invalid SVN edit session: {path}; manual recovery required")
    if (type(value.get("version")) is not int or value["version"] != SESSION_VERSION
            or value.get("workspaceKey") != workspace["workspaceKey"]):
        raise SystemExit(f"SVN edit session does not match {workspace['workspaceKey']}")
    if not isinstance(value.get('sessionId'), str) or not value['sessionId']:
        raise SystemExit(f"Invalid SVN edit session ID: {path}; manual recovery required")
    if not isinstance(value.get("files"), dict) or not isinstance(value.get("documents"), dict):
        raise SystemExit(f"Invalid SVN edit session records: {path}")
    if any(not isinstance(item, dict) for records in (value['files'], value['documents']) for item in records.values()):
        raise SystemExit(f"Invalid SVN edit session record values: {path}; manual recovery required")
    if (not isinstance(value.setdefault("pageEditTokens", {}), dict)
            or any(not isinstance(token, dict) for token in value["pageEditTokens"].values())):
        raise SystemExit(f"Invalid PAGE edit token records: {path}")
    if (not isinstance(value.setdefault("procedureEditTokens", {}), dict)
            or any(not isinstance(token, dict) for token in value["procedureEditTokens"].values())):
        raise SystemExit(f"Invalid procedure edit token records: {path}")
    return value

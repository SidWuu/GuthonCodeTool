"""Authorized, session-free reads of indexed SVN procedure sources."""

from __future__ import annotations

import hashlib
import json

from common.inheritance import SOURCE_CATALOG_VERSION
from common.source_format import decode_source
from providers.svn.checkout import require_capability

from . import index_queries, page_nodes
from .manifest import load_authorized_scope, resolve_authorized_path


MAX_PROCEDURE_READ_CHARS = 24_000


def source_index_status(workspace: dict) -> dict:
    """Report object-catalog readiness without requiring PAGE semantic tables."""

    require_capability(workspace, "browse")
    if not workspace["indexPath"].is_file():
        return {"workspaceKey": workspace["workspaceKey"], "buildStatus": "MISSING",
                "indexGeneration": None, "procedureCount": 0, "staleSourceCount": 0,
                "requiredAction": "svn-reindex"}
    with index_queries._connection(workspace) as conn:
        try:
            generation = page_nodes._require_source_ready(conn)
        except page_nodes.PageIndexError:
            return {"workspaceKey": workspace["workspaceKey"], "buildStatus": "REBUILD_REQUIRED",
                    "indexGeneration": None, "procedureCount": 0, "staleSourceCount": 0,
                    "requiredAction": "svn-reindex"}
        procedure_count = conn.execute(
            "SELECT COUNT(*) FROM gusen_source_record WHERE provider='svn' AND source_table='procedure'"
        ).fetchone()[0]
        parser = conn.execute(
            "SELECT state_value FROM gusen_sync_state WHERE state_key='source_catalog_parser_version'"
        ).fetchone()
        if not parser or parser[0] != SOURCE_CATALOG_VERSION:
            return {"workspaceKey": workspace["workspaceKey"], "buildStatus": "REBUILD_REQUIRED",
                    "indexGeneration": generation, "procedureCount": procedure_count,
                    "staleSourceCount": 0, "requiredAction": "svn-reindex"}
        stale_count = conn.execute(
            "SELECT COUNT(*) FROM gusen_source_record WHERE provider='svn' AND scope_id=? AND status NOT IN ('OK','SVN_DIRTY')",
            (workspace["scopeId"],),
        ).fetchone()[0]
        errors = conn.execute("SELECT state_value FROM gusen_sync_state WHERE state_key='svn_catalog_errors'").fetchone()
        try:
            scan_errors = json.loads(errors[0]) if errors else []
        except (ValueError, TypeError):
            scan_errors = ["invalid stored scan diagnostics"]
        if not isinstance(scan_errors, list):
            scan_errors = ["invalid stored scan diagnostics"]
    return {"workspaceKey": workspace["workspaceKey"],
            "buildStatus": "PARTIAL" if stale_count or scan_errors else "READY",
            "indexGeneration": generation, "procedureCount": procedure_count,
            "staleSourceCount": stale_count, "scanErrorCount": len(scan_errors), "requiredAction": ""}


def _record(workspace: dict, *, source_namespace: str, source_id: str,
            fun_id: str, working_copy_id: str) -> tuple[dict, str]:
    require_capability(workspace, "browse")
    if not all((source_namespace, source_id, fun_id)):
        raise page_nodes.PageIndexError("INVALID_LOCATOR", "Complete procedure identity is required")
    with index_queries._connection(workspace) as conn:
        generation = page_nodes._require_source_ready(conn)
        rows = conn.execute(
            "SELECT * FROM gusen_source_record WHERE provider='svn' AND source_table='procedure' "
            "AND scope_id=? AND source_namespace=? AND source_id=? AND fun_id=? "
            + ("AND working_copy_id=? " if working_copy_id else "")
            + "ORDER BY working_copy_id, record_id LIMIT 11",
            (workspace["scopeId"], source_namespace, source_id, fun_id, *([working_copy_id] if working_copy_id else [])),
        ).fetchall()
    if len(rows) != 1:
        error = page_nodes.PageIndexError(
            "SOURCE_AMBIGUOUS" if rows else "SOURCE_NOT_FOUND",
            "Procedure identity is not uniquely indexed",
            next_action="Select an exact workingCopyId from the bounded candidates" if rows else "Search the authorized source catalog",
        )
        error.candidates = [{"workingCopyId": row["working_copy_id"], "sourcePath": row["source_path"]} for row in rows[:10]]
        raise error
    record = dict(rows[0])
    if record["status"] not in {"OK", "SVN_DIRTY"}:
        raise page_nodes.PageIndexError("SOURCE_STALE", "Procedure source is stale",
                                        retryable=True, next_action="Refresh the exact indexed source")
    return record, generation


def _current_source(workspace: dict, record: dict) -> tuple[str, str]:
    scope = load_authorized_scope(workspace)
    entry, path, _relative = resolve_authorized_path(scope, record["source_path"])
    if entry.id != record["scope_entry_id"] or not path.is_file():
        raise page_nodes.PageIndexError("UNAUTHORIZED_PATH", "Procedure path is outside the authorized source")
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != record["source_hash"]:
        raise page_nodes.PageIndexError("SOURCE_STALE", "Procedure source changed since indexing",
                                        retryable=True, next_action="Refresh the exact indexed source")
    return decode_source(raw)[0], digest


def read_procedure(
    workspace: dict, *, source_namespace: str, source_id: str, fun_id: str,
    working_copy_id: str = "", offset: int = 0, max_chars: int = 12_000,
) -> dict:
    """Return a bounded text window without creating a document edit lease."""

    from .source_queries import read_source_document

    return read_source_document(workspace, source_type="procedure", source_namespace=source_namespace,
                                source_id=source_id, fun_id=fun_id, working_copy_id=working_copy_id,
                                offset=offset, max_chars=max_chars)


def procedure_callers(
    workspace: dict, *, source_namespace: str, source_id: str, fun_id: str,
    working_copy_id: str = "", limit: int = 20, cursor: str = "",
) -> dict:
    """Return bounded index evidence for an exactly identified procedure."""

    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise page_nodes.PageIndexError("INVALID_LIMIT", "limit must be between 1 and 100")
    record, generation = _record(
        workspace, source_namespace=source_namespace, source_id=source_id,
        fun_id=fun_id, working_copy_id=working_copy_id,
    )
    _current_source(workspace, record)
    query = [workspace["workspaceKey"], source_namespace, source_id, fun_id, record["working_copy_id"], "procedure-callers-v1"]
    after = page_nodes._decode_cursor(cursor, generation, query, key_length=1) if cursor else ["0"]
    if not after[0].isdecimal():
        raise page_nodes.PageIndexError("INVALID_CURSOR", "Invalid caller evidence position")
    offset = int(after[0])
    with index_queries._connection(workspace) as conn:
        target_count = conn.execute(
            "SELECT COUNT(*) FROM gusen_source_record WHERE provider='svn' "
            "AND source_table='procedure' AND source_alias_id=? AND fun_id=? "
            "AND status IN ('OK', 'SVN_DIRTY')",
            (record["source_alias_id"], fun_id),
        ).fetchone()[0]
    if target_count != 1:
        raise page_nodes.PageIndexError(
            "CALL_TARGET_AMBIGUOUS", "Caller index cannot distinguish same-alias procedure targets",
            next_action="Inspect each exact working copy; do not attribute callers to one target",
        )
    result = index_queries.callers(
        workspace, alias=record["source_alias_id"], fun_id=fun_id, limit=limit + 1, continuation=offset,
    )
    callers = result["callers"][:limit]
    return {
        "workspaceKey": workspace["workspaceKey"], "sourceType": "procedure",
        "sourceNamespace": source_namespace, "sourceId": source_id, "funId": fun_id,
        "workingCopyId": record["working_copy_id"], "sourceHash": record["source_hash"],
        "indexGeneration": generation, "callers": callers,
        "complete": len(result["callers"]) <= limit,
        "truncated": len(result["callers"]) > limit,
        "nextCursor": page_nodes._encode_cursor(generation, query, [str(offset + len(callers))])
                      if len(result["callers"]) > limit else None,
    }

"""Authorized, session-free reads of indexed SVN procedure sources."""

from __future__ import annotations

import hashlib

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
        stale_count = conn.execute(
            "SELECT COUNT(*) FROM gusen_source_record WHERE provider='svn' AND status='STALE'"
        ).fetchone()[0]
    return {"workspaceKey": workspace["workspaceKey"],
            "buildStatus": "PARTIAL" if stale_count else "READY",
            "indexGeneration": generation, "procedureCount": procedure_count,
            "staleSourceCount": stale_count, "requiredAction": ""}


def _record(workspace: dict, *, source_namespace: str, source_id: str,
            fun_id: str, working_copy_id: str) -> tuple[dict, str]:
    require_capability(workspace, "browse")
    if not all((source_namespace, source_id, fun_id, working_copy_id)):
        raise page_nodes.PageIndexError("INVALID_LOCATOR", "Complete procedure identity is required")
    with index_queries._connection(workspace) as conn:
        generation = page_nodes._require_source_ready(conn)
        rows = conn.execute(
            "SELECT * FROM gusen_source_record WHERE provider='svn' AND source_table='procedure' "
            "AND source_namespace=? AND source_id=? AND fun_id=? AND working_copy_id=? LIMIT 2",
            (source_namespace, source_id, fun_id, working_copy_id),
        ).fetchall()
    if len(rows) != 1:
        raise page_nodes.PageIndexError(
            "SOURCE_AMBIGUOUS" if rows else "SOURCE_NOT_FOUND",
            "Procedure identity is not uniquely indexed",
        )
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
    working_copy_id: str, offset: int = 0, max_chars: int = 12_000,
) -> dict:
    """Return a bounded text window without creating a document edit lease."""

    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise page_nodes.PageIndexError("INVALID_LIMIT", "offset must be a nonnegative integer")
    if (isinstance(max_chars, bool) or not isinstance(max_chars, int)
            or not 1 <= max_chars <= MAX_PROCEDURE_READ_CHARS):
        raise page_nodes.PageIndexError(
            "INVALID_LIMIT", f"maxChars must be between 1 and {MAX_PROCEDURE_READ_CHARS}",
        )
    record, generation = _record(
        workspace, source_namespace=source_namespace, source_id=source_id,
        fun_id=fun_id, working_copy_id=working_copy_id,
    )
    content, digest = _current_source(workspace, record)
    if offset > len(content):
        raise page_nodes.PageIndexError("INVALID_LIMIT", "offset exceeds procedure length")
    end = min(len(content), offset + max_chars)
    return {
        "workspaceKey": workspace["workspaceKey"], "sourceType": "procedure",
        "sourceNamespace": source_namespace, "sourceId": source_id, "funId": fun_id,
        "workingCopyId": working_copy_id, "sourcePath": record["source_path"],
        "sourceHash": digest, "svnBaseRevision": record["svn_revision"],
        "indexGeneration": generation, "offset": offset, "totalChars": len(content),
        "content": content[offset:end], "complete": end == len(content),
        "truncated": end < len(content), "nextOffset": end if end < len(content) else None,
    }


def procedure_callers(
    workspace: dict, *, source_namespace: str, source_id: str, fun_id: str,
    working_copy_id: str, limit: int = 20,
) -> dict:
    """Return bounded index evidence for an exactly identified procedure."""

    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise page_nodes.PageIndexError("INVALID_LIMIT", "limit must be between 1 and 100")
    record, generation = _record(
        workspace, source_namespace=source_namespace, source_id=source_id,
        fun_id=fun_id, working_copy_id=working_copy_id,
    )
    _current_source(workspace, record)
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
        workspace, alias=record["source_alias_id"], fun_id=fun_id, limit=limit + 1,
    )
    callers = result["callers"][:limit]
    return {
        "workspaceKey": workspace["workspaceKey"], "sourceType": "procedure",
        "sourceNamespace": source_namespace, "sourceId": source_id, "funId": fun_id,
        "workingCopyId": working_copy_id, "sourceHash": record["source_hash"],
        "indexGeneration": generation, "callers": callers,
        "complete": len(result["callers"]) <= limit,
        "truncated": len(result["callers"]) > limit,
    }

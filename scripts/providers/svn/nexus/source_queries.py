"""Bounded, session-free source reads and index diagnostics for CLI/MCP clients."""

from __future__ import annotations

import hashlib
import json

from common.page_projection import pointer_value
from common.source_format import decode_source
from common.source_facts import WRITE_OPERATIONS
from providers.svn.checkout import operation_lock, require_capability

from . import index_queries, page_nodes, procedure_sources
from .manifest import load_authorized_scope, resolve_authorized_path


MAX_BATCH_OBJECTS = 20
MAX_READ_CHARS = 24_000


def read_source_document(workspace: dict, *, source_type: str, source_namespace: str,
                         source_id: str, fun_id: str = "", working_copy_id: str = "",
                         json_pointer: str = "", offset: int = 0, max_chars: int = 12_000) -> dict:
    """Read a physical object or JSON subtree without creating an editable session."""
    require_capability(workspace, "browse")
    if source_type not in {"page", "procedure", "system-script", "table", "view", "skill", "public"}:
        raise page_nodes.PageIndexError("INVALID_LOCATOR", "Unsupported sourceType")
    if not source_namespace or not source_id:
        raise page_nodes.PageIndexError("INVALID_LOCATOR", "sourceNamespace and sourceId are required")
    if (isinstance(offset, bool) or not isinstance(offset, int) or offset < 0
            or isinstance(max_chars, bool) or not isinstance(max_chars, int) or not 1 <= max_chars <= MAX_READ_CHARS):
        raise page_nodes.PageIndexError("INVALID_LIMIT", "offset must be nonnegative; maxChars must be between 1 and 24000")
    if not isinstance(json_pointer, str) or len(json_pointer) > 4096 or (json_pointer and not json_pointer.startswith("/")):
        raise page_nodes.PageIndexError("INVALID_LOCATOR", "jsonPointer must be a bounded JSON pointer")
    with operation_lock(workspace, "source-document-read", shared=True):
        with index_queries._connection(workspace) as conn:
            generation = page_nodes._require_source_ready(conn)
            rows = conn.execute(
                "SELECT * FROM gusen_source_record WHERE provider='svn' AND scope_id=? "
                "AND source_table=? AND source_namespace=? AND source_id=? AND fun_id=? "
                + ("AND working_copy_id=? " if working_copy_id else "")
                + "ORDER BY working_copy_id, record_id LIMIT 11",
                (workspace["scopeId"], source_type, source_namespace, source_id, fun_id,
                 *([working_copy_id] if working_copy_id else [])),
            ).fetchall()
        if len(rows) != 1:
            error = page_nodes.PageIndexError(
                "SOURCE_AMBIGUOUS" if rows else "SOURCE_NOT_FOUND", "Source identity is not uniquely indexed",
                next_action="Search sources and select an exact sourceNamespace and workingCopyId",
            )
            error.candidates = [{"workingCopyId": row["working_copy_id"], "sourcePath": row["source_path"]}
                                for row in rows[:10]]
            raise error
        record = dict(rows[0])
        if record["status"] not in {"OK", "SVN_DIRTY"}:
            raise page_nodes.PageIndexError("SOURCE_STALE", "Indexed source is stale", retryable=True,
                                            next_action="Refresh this exact source before reading")
        entry, path, _relative = resolve_authorized_path(load_authorized_scope(workspace), record["source_path"])
        if entry.id != record["scope_entry_id"] or not path.is_file():
            raise page_nodes.PageIndexError("UNAUTHORIZED_PATH", "Source is outside the authorized working copy")
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if digest != record["source_hash"]:
            raise page_nodes.PageIndexError("SOURCE_STALE", "Source bytes changed since indexing", retryable=True,
                                            next_action="Refresh this exact source before reading")
        content = decode_source(raw)[0]
        if json_pointer:
            try:
                data = json.loads(content)
                if isinstance(data, str):
                    data = json.loads(data)
                value = pointer_value(data, json_pointer)
            except (ValueError, KeyError, IndexError, TypeError) as error:
                raise page_nodes.PageIndexError("NODE_NOT_FOUND", "JSON pointer is absent or source is not JSON") from error
            content = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)
    if offset > len(content):
        raise page_nodes.PageIndexError("INVALID_LIMIT", "offset exceeds source length")
    end = min(len(content), offset + max_chars)
    return {"workspaceKey": workspace["workspaceKey"], "sourceType": source_type,
            "sourceNamespace": source_namespace, "sourceId": source_id, "funId": fun_id,
            "workingCopyId": record["working_copy_id"], "sourcePath": record["source_path"],
            "absolutePath": str(path.resolve()), "sourceHash": digest, "jsonPointer": json_pointer,
            "svnBaseRevision": record["svn_revision"], "indexGeneration": generation,
            "content": content[offset:end], "offset": offset, "totalChars": len(content),
            "complete": end == len(content), "truncated": end < len(content),
            "nextOffset": end if end < len(content) else None}


def read_objects_batch(workspace: dict, *, objects: list[dict], max_chars: int = 24_000) -> dict:
    require_capability(workspace, "browse")
    if not isinstance(objects, list) or not 1 <= len(objects) <= MAX_BATCH_OBJECTS:
        raise page_nodes.PageIndexError("INVALID_TARGETS", "objects must contain 1–20 exact source locators")
    if isinstance(max_chars, bool) or not isinstance(max_chars, int) or not len(objects) <= max_chars <= MAX_READ_CHARS:
        raise page_nodes.PageIndexError("INVALID_LIMIT", "maxChars must cover each object and remain at most 24000")
    results = []
    remaining = max_chars
    keys = {"sourceType": "source_type", "sourceNamespace": "source_namespace", "sourceId": "source_id",
            "funId": "fun_id", "workingCopyId": "working_copy_id", "jsonPointer": "json_pointer", "offset": "offset"}
    # Hold one shared lock so a tool write cannot change the batch's snapshot.
    with operation_lock(workspace, "source-document-batch", shared=True):
        for index, locator in enumerate(objects):
            if (not isinstance(locator, dict) or set(locator) - set(keys)
                    or not {"sourceType", "sourceNamespace", "sourceId"} <= set(locator)
                    or any(not isinstance(value, str) for key, value in locator.items() if key != "offset")):
                raise page_nodes.PageIndexError("INVALID_LOCATOR", "Each object must be an exact source locator")
            try:
                size = max(1, remaining // (len(objects) - index))
                result = read_source_document(workspace, **{keys[key]: value for key, value in locator.items()},
                                              max_chars=size)
                remaining -= len(result["content"])
                results.append({"ok": True, **result})
            except page_nodes.PageIndexError as error:
                results.append({"ok": False, "locator": locator,
                                "error": {"code": error.code, "message": str(error), "nextAction": error.next_action}})
    complete = all(result.get("ok") and result.get("complete") for result in results)
    return {"workspaceKey": workspace["workspaceKey"], "objects": results, "complete": complete,
            "truncated": any(result.get("truncated", False) for result in results),
            "warnings": [] if complete else ["Inspect each object's error or nextOffset; the batch is incomplete"]}


def list_sources(workspace: dict, *, source_namespace: str = "", source_type: str = "",
                 limit: int = 20, cursor: str = "") -> dict:
    """List stable identities plus compact index summaries; never materialize a catalog tree."""
    require_capability(workspace, "browse")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise page_nodes.PageIndexError("INVALID_LIMIT", "limit must be between 1 and 100")
    with index_queries._connection(workspace) as conn:
        generation = page_nodes._require_source_ready(conn)
        query = [workspace["workspaceKey"], source_namespace, source_type, "summary-v1"]
        after = page_nodes._decode_cursor(cursor, generation, query, key_length=1) if cursor else None
        if after and not after[0].isdecimal():
            raise page_nodes.PageIndexError("INVALID_CURSOR", "Invalid source record position")
        clauses = ["provider='svn'", "scope_id=?", "source_table<>'procedure-inherit'"]
        params = [workspace["scopeId"]]
        for column, value in (("source_namespace", source_namespace), ("source_table", source_type)):
            if value:
                clauses.append(column + "=?")
                params.append(value)
        if after:
            clauses.append("record_id>?")
            params.append(int(after[0]))
        rows = conn.execute("SELECT * FROM gusen_source_record WHERE " + " AND ".join(clauses)
                            + " ORDER BY record_id LIMIT ?", (*params, limit + 1)).fetchall()
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view')")}
        sources = []
        for row in rows[:limit]:
            counts = {}
            for table, key in (("gusen_source_fragment", "fragmentCount"), ("gusen_page_node", "nodeCount"),
                               ("gusen_page_field", "fieldCount"), ("gusen_data_access", "dataAccessCount"),
                               ("gusen_invoke_call_detail", "callCount"), ("gusen_logic_fact", "logicFactCount")):
                if table in tables:
                    counts[key] = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE source_record_id=?",
                                               (row["record_id"],)).fetchone()[0]
            access_available = "gusen_data_access" in tables
            accesses = conn.execute(
                "SELECT DISTINCT table_name, operation FROM gusen_data_access WHERE source_record_id=? "
                "ORDER BY table_name, operation LIMIT 7", (row["record_id"],)
            ).fetchall() if access_available else []
            access_items = []
            for access in accesses[:6]:
                operation = access["operation"]
                direction = ("READ" if operation == "SELECT" else "WRITE"
                             if operation in WRITE_OPERATIONS else "UNKNOWN")
                access_items.append({"tableName": access["table_name"][:64], "operation": operation[:32],
                                     "direction": direction,
                                     "identityTruncated": len(access["table_name"]) > 64 or len(operation) > 32})
            counts["tableAccess"] = {"available": access_available, "coverage": "INDEXED_FACTS_ONLY",
                                     "items": access_items,
                                     "truncated": len(accesses) > 6 or any(item["identityTruncated"] for item in access_items)}
            region_available = "gusen_page_field" in tables
            is_page = row["source_table"] == "page"
            regions = conn.execute(
                "SELECT region_type, COUNT(*) AS field_count, COUNT(DISTINCT collection_pointer) AS collection_count "
                "FROM gusen_page_field WHERE source_record_id=? GROUP BY region_type ORDER BY region_type LIMIT 6",
                (row["record_id"],)
            ).fetchall() if region_available and is_page else []
            region_items = [{"regionType": region["region_type"][:32], "fieldCount": region["field_count"],
                             "collectionCount": region["collection_count"],
                             "identityTruncated": len(region["region_type"]) > 32} for region in regions[:5]]
            counts["pageRegions"] = {"available": region_available, "applicable": is_page,
                                     "coverage": "INDEXED_UI_FIELDS_ONLY", "items": region_items,
                                     "truncated": len(regions) > 5 or any(item["identityTruncated"] for item in region_items)}
            sources.append({"sourceType": row["source_table"], "sourceNamespace": row["source_namespace"],
                            "sourceId": row["source_id"], "funId": row["fun_id"],
                            "sourceName": row["source_name"], "sourcePath": row["source_path"],
                            "workingCopyId": row["working_copy_id"], "indexedSourceHash": row["source_hash"],
                            "status": row["status"], "summary": counts})
        has_more = len(rows) > limit
        next_cursor = page_nodes._encode_cursor(generation, query, [str(rows[limit-1]["record_id"])]) if has_more else None
    return {"workspaceKey": workspace["workspaceKey"], "indexGeneration": generation,
            "sources": sources, "complete": not has_more, "truncated": has_more, "nextCursor": next_cursor,
            "warnings": ["Summaries contain indexed facts only; they do not prove runtime behavior or deletion safety"]}


def index_health(workspace: dict, *, limit: int = 20) -> dict:
    require_capability(workspace, "browse")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise page_nodes.PageIndexError("INVALID_LIMIT", "limit must be between 1 and 100")
    status = procedure_sources.source_index_status(workspace)
    result = {**status, "rebuildRequired": status["buildStatus"] in {"MISSING", "REBUILD_REQUIRED"},
              "staleSources": [], "scanErrors": [], "projectionGaps": 0,
              "freshnessVerified": False}
    if result["rebuildRequired"]:
        return result
    with index_queries._connection(workspace) as conn:
        tables={row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        body_version=conn.execute("SELECT state_value FROM gusen_sync_state WHERE state_key='source_body_index_version'").fetchone()
        from common.source_text_search import VERSION as body_index_version
        result["bodySearchReady"] = "source_body_content" in tables and body_version is not None and body_version[0]==body_index_version
        result["bodySearchAction"] = "" if result["bodySearchReady"] else "full-reindex"
        result["partialBodyCount"] = conn.execute("SELECT COUNT(*) FROM source_body_content WHERE indexed_chars<total_chars").fetchone()[0] if "source_body_content" in tables else 0
        result["statusCounts"] = {row[0]: row[1] for row in conn.execute(
            "SELECT status, COUNT(*) FROM gusen_source_record WHERE provider='svn' AND scope_id=? GROUP BY status",
            (workspace["scopeId"],))}
        result["staleSources"] = [dict(row) for row in conn.execute(
            "SELECT source_table AS sourceType, source_id AS sourceId, source_path AS sourcePath, status "
            "FROM gusen_source_record WHERE provider='svn' AND scope_id=? AND status NOT IN ('OK','SVN_DIRTY') "
            "ORDER BY record_id LIMIT ?", (workspace["scopeId"], limit))]
        state = {row[0]: row[1] for row in conn.execute(
            "SELECT state_key, state_value FROM gusen_sync_state WHERE state_key IN "
            "('svn_catalog_errors', 'svn_catalog_build_status')")}
        try:
            errors = json.loads(state.get("svn_catalog_errors", "[]"))
        except (ValueError, TypeError):
            errors = [{"error": "Invalid stored scan error metadata"}]
        if not isinstance(errors, list):
            errors = [{"error": "Invalid stored scan error metadata"}]
        result["scanErrorCount"] = len(errors)
        result["scanErrors"] = errors[:limit]
        result["complete"] = len(errors) <= limit and sum(count for key, count in result["statusCounts"].items()
                                                          if key not in {"OK", "SVN_DIRTY"}) <= limit
        result["truncated"] = not result["complete"]
        try:
            page_nodes._require_ready(conn)
            result["projectionGaps"] = conn.execute(
                "SELECT COUNT(*) FROM gusen_source_record s WHERE s.provider='svn' AND s.scope_id=? "
                "AND s.source_table='page' AND s.source_path LIKE '%.json' AND s.status IN ('OK','SVN_DIRTY') "
                "AND EXISTS (SELECT 1 FROM gusen_source_fragment f WHERE f.source_record_id=s.record_id) "
                "AND NOT EXISTS (SELECT 1 FROM gusen_page_node n WHERE n.source_record_id=s.record_id)",
                (workspace["scopeId"],)).fetchone()[0]
        except page_nodes.PageIndexError:
            result["pageProjectionRebuildRequired"] = True
    if errors or result["staleSources"]:
        result["buildStatus"] = "PARTIAL"
        result["requiredAction"] = "Inspect bounded errors and refresh the affected sources"
    result["warnings"] = ["Health reports index metadata; source bytes are verified by read tools"]
    return result


def table_references(workspace: dict, *, table_name: str, column_name: str = "", limit: int = 20,
                     cursor: str = "", graph: bool = False) -> dict:
    """Return indexed table access or explicit PAGE column mapping evidence only."""
    require_capability(workspace, "browse")
    if not isinstance(table_name, str) or not 1 <= len(table_name.strip()) <= 128:
        raise page_nodes.PageIndexError("INVALID_FILTER", "tableName must contain 1–128 characters")
    if not isinstance(column_name, str) or len(column_name) > 128 or not isinstance(graph, bool):
        raise page_nodes.PageIndexError("INVALID_FILTER", "columnName or graph is invalid")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise page_nodes.PageIndexError("INVALID_LIMIT", "limit must be between 1 and 100")
    table_name = table_name.strip()
    column_name = column_name.strip()
    with index_queries._connection(workspace) as conn:
        generation = page_nodes._require_source_ready(conn)
        query = [workspace["workspaceKey"], table_name.upper(), column_name.upper(), "table-references-v1"]
        after = page_nodes._decode_cursor(cursor, generation, query, key_length=2) if cursor else None
        if after and not after[1].isdecimal():
            raise page_nodes.PageIndexError("INVALID_CURSOR", "Invalid table evidence position")
        statements = []
        params = []
        if not column_name:
            statements.append("SELECT 'TABLE_ACCESS' AS evidence_kind, a.access_id AS evidence_id, s.source_namespace, "
                              "s.source_table, s.source_id, s.fun_id, s.source_path, s.source_hash, s.status, "
                              "a.operation, a.confidence, a.evidence, a.line_no, '' AS json_pointer, '' AS field_id, '' AS column_id "
                              "FROM gusen_data_access a JOIN gusen_source_record s ON s.record_id=a.source_record_id "
                              "WHERE s.provider='svn' AND s.scope_id=? AND UPPER(a.table_name)=UPPER(?)")
            params.extend((workspace["scopeId"], table_name))
        statements.append("SELECT 'FIELD_MAPPING', f.rowid, s.source_namespace, s.source_table, s.source_id, s.fun_id, "
                          "s.source_path, s.source_hash, s.status, 'MAPPING' AS operation, 'EXPLICIT' AS confidence, '' AS evidence, 0 AS line_no, "
                          "f.json_pointer, f.field_id, f.column_id FROM gusen_page_field f "
                          "JOIN gusen_source_record s ON s.record_id=f.source_record_id "
                          "WHERE s.provider='svn' AND s.scope_id=? AND UPPER(f.table_id)=UPPER(?) "
                          + ("AND UPPER(f.column_id)=UPPER(?)" if column_name else ""))
        params.extend((workspace["scopeId"], table_name, *([column_name] if column_name else [])))
        # Provide the same result column names when FIELD_MAPPING is the only arm.
        if column_name:
            statements[0] = statements[0].replace("SELECT 'FIELD_MAPPING', f.rowid,", "SELECT 'FIELD_MAPPING' AS evidence_kind, f.rowid AS evidence_id,")
        sql = "SELECT * FROM (" + " UNION ALL ".join(statements) + ")"
        if after:
            sql += " WHERE (evidence_kind, evidence_id) > (?, ?)"
            params.extend((after[0], int(after[1])))
        rows = conn.execute(sql + " ORDER BY evidence_kind, evidence_id LIMIT ?", (*params, limit + 1)).fetchall()
        visible = [dict(row) for row in rows[:limit]]
        more = len(rows) > limit
        next_cursor = page_nodes._encode_cursor(generation, query, [visible[-1]["evidence_kind"], str(visible[-1]["evidence_id"])]) if more else None
    result = {"workspaceKey": workspace["workspaceKey"], "indexGeneration": generation,
              "tableName": table_name, "columnName": column_name, "references": visible,
              "complete": not more, "truncated": more, "nextCursor": next_cursor,
              "referenceCompleteness": "UNKNOWN", "deletionSafety": "BLOCKED_UNVERIFIED",
              "warnings": ["Column filters return explicit PAGE field mappings only; SQL column access and dynamic references are unverified",
                           "Evidence reflects the index snapshot; source bytes and runtime behavior were not checked"]}
    if graph:
        def label(value):
            return str(value).replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", " ").replace("\r", " ")[:160]
        lines = ["flowchart LR", f'  table["{label(table_name)}"]']
        grouped = {}
        for row in visible:
            key = (row["source_namespace"], row["source_table"], row["source_id"], row["fun_id"])
            grouped.setdefault(key, set()).add(row["operation"])
        for index, (identity, operations) in enumerate(sorted(grouped.items())):
            lines.append(f'  s{index}["{label(identity[0] + ": " + identity[2] + ("#" + identity[3] if identity[3] else ""))}"]')
            lines.append(f'  s{index} -->|"{label(", ".join(sorted(operations)))}"| table')
        result["mermaid"] = "\n".join(lines)
    return result

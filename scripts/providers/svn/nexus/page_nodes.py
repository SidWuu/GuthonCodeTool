"""Bounded PAGE node directory and source-backed reads for SVN workspaces."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from pathlib import Path

from common import source_facts
from common.page_projection import pointer_value
from common.source_format import decode_source
from providers.svn.checkout import require_capability

from .index_queries import _connection
from .manifest import load_authorized_scope, resolve_authorized_path


MAX_PAGE_SIZE = 100
MAX_READ_NODES = 20
MAX_READ_CHARS = 24_000


class PageIndexError(Exception):
    def __init__(self, code: str, message: str, *, retryable: bool = False, next_action: str = ""):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.next_action = next_action


def _state(conn) -> tuple[str, str, str, str, str, str, str]:
    rows = conn.execute(
        "SELECT state_key, state_value FROM gusen_sync_state "
        "WHERE state_key IN ('page_node_schema_version', 'page_node_projection_version', "
        "'page_field_schema_version', 'page_field_projection_version', "
        "'page_field_relation_schema_version', 'page_field_relation_projection_version', "
        "'page_semantic_generation')"
    ).fetchall()
    values = {row["state_key"]: row["state_value"] for row in rows}
    return (values.get("page_node_schema_version", ""),
            values.get("page_node_projection_version", ""),
            values.get("page_field_schema_version", ""),
            values.get("page_field_projection_version", ""),
            values.get("page_field_relation_schema_version", ""),
            values.get("page_field_relation_projection_version", ""),
            values.get("page_semantic_generation", ""))


def _require_ready(conn) -> str:
    schema, version, field_schema, field_version, relation_schema, relation_version, generation = _state(conn)
    if (schema != str(source_facts.PAGE_NODE_SCHEMA_VERSION)
            or version != source_facts.PAGE_NODE_PARSER_VERSION
            or field_schema != str(source_facts.PAGE_FIELD_SCHEMA_VERSION)
            or field_version != source_facts.PAGE_FIELD_PARSER_VERSION
            or relation_schema != str(source_facts.PAGE_FIELD_RELATION_SCHEMA_VERSION)
            or relation_version != source_facts.PAGE_FIELD_RELATION_PARSER_VERSION
            or not generation
            or conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' "
                            "AND name IN ('gusen_page_node', 'gusen_page_field', "
                            "'gusen_page_field_relation', 'gusen_source_fragment')").fetchone()[0] != 4):
        raise PageIndexError(
            "INDEX_REBUILD_REQUIRED", "PAGE node directory requires a full local SVN reindex",
            next_action="Run the existing SVN reindex command for this workspace",
        )
    return generation


def _require_source_ready(conn) -> str:
    """Check the shared object catalog independently of PAGE projection versions."""

    tables = {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name IN ('gusen_source_record', 'gusen_sync_state')"
    )}
    if tables != {"gusen_source_record", "gusen_sync_state"}:
        raise PageIndexError("INDEX_REBUILD_REQUIRED", "SVN source catalog is unavailable")
    rows = conn.execute(
        "SELECT state_key, state_value FROM gusen_sync_state WHERE state_key IN "
        "('source_catalog_generation', 'page_semantic_generation')"
    ).fetchall()
    values = {row["state_key"]: row["state_value"] for row in rows}
    generation = values.get("source_catalog_generation") or values.get("page_semantic_generation")
    if not generation:
        raise PageIndexError("INDEX_REBUILD_REQUIRED", "SVN source catalog has no snapshot generation")
    return generation


def index_status(workspace: dict) -> dict:
    """Inspect index metadata without creating or migrating a database."""

    require_capability(workspace, "browse")
    if not Path(workspace["indexPath"]).is_file():
        return {"workspaceKey": workspace["workspaceKey"], "buildStatus": "MISSING",
                "indexGeneration": None, "schemaVersion": None,
                "parserVersion": source_facts.PAGE_NODE_PARSER_VERSION,
                "projectionGapCount": 0,
                "requiredAction": "svn-reindex"}
    with _connection(workspace) as conn:
        tables = {row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name IN ('gusen_page_node', 'gusen_page_field', 'gusen_page_field_relation', "
            "'gusen_source_fragment')"
        )}
        schema, version, field_schema, field_version, relation_schema, relation_version, generation = _state(conn)
        if (tables != {'gusen_page_node', 'gusen_page_field', 'gusen_page_field_relation',
                       'gusen_source_fragment'}
                or schema != str(source_facts.PAGE_NODE_SCHEMA_VERSION)
                or version != source_facts.PAGE_NODE_PARSER_VERSION
                or field_schema != str(source_facts.PAGE_FIELD_SCHEMA_VERSION)
                or field_version != source_facts.PAGE_FIELD_PARSER_VERSION
                or relation_schema != str(source_facts.PAGE_FIELD_RELATION_SCHEMA_VERSION)
                or relation_version != source_facts.PAGE_FIELD_RELATION_PARSER_VERSION or not generation):
            status = "REBUILD_REQUIRED"
            count = 0
            field_count = 0
            relation_count = 0
            stale = 0
            projection_gaps = 0
        else:
            count = conn.execute("SELECT COUNT(*) FROM gusen_page_node").fetchone()[0]
            field_count = conn.execute("SELECT COUNT(*) FROM gusen_page_field").fetchone()[0]
            relation_count = conn.execute("SELECT COUNT(*) FROM gusen_page_field_relation").fetchone()[0]
            stale = conn.execute(
                "SELECT COUNT(*) FROM gusen_source_record WHERE provider='svn' AND status='STALE'"
            ).fetchone()[0]
            projection_gaps = conn.execute(
                "SELECT COUNT(*) FROM gusen_source_record AS source "
                "WHERE source.provider='svn' AND source.source_table='page' "
                "AND source.source_path LIKE '%.json' "
                "AND EXISTS (SELECT 1 FROM gusen_source_fragment AS fragment "
                "            WHERE fragment.source_record_id=source.record_id) "
                "AND NOT EXISTS (SELECT 1 FROM gusen_page_node AS node "
                "                WHERE node.source_record_id=source.record_id)"
            ).fetchone()[0]
            status = "PARTIAL" if stale or projection_gaps else "READY"
    return {
        "workspaceKey": workspace["workspaceKey"],
        "buildStatus": status,
        "schemaVersion": int(schema) if schema.isdecimal() else None,
        "indexGeneration": generation or None,
        "parserVersion": version or None,
        "expectedParserVersion": source_facts.PAGE_NODE_PARSER_VERSION,
        "nodeCount": count,
        "fieldSchemaVersion": int(field_schema) if field_schema.isdecimal() else None,
        "fieldParserVersion": field_version or None,
        "expectedFieldParserVersion": source_facts.PAGE_FIELD_PARSER_VERSION,
        "fieldCount": field_count,
        "fieldRelationSchemaVersion": int(relation_schema) if relation_schema.isdecimal() else None,
        "fieldRelationParserVersion": relation_version or None,
        "expectedFieldRelationParserVersion": source_facts.PAGE_FIELD_RELATION_PARSER_VERSION,
        "fieldRelationCount": relation_count,
        "staleSourceCount": stale,
        "projectionGapCount": projection_gaps,
        "requiredAction": "svn-reindex" if status == "REBUILD_REQUIRED" or projection_gaps else "",
    }


def _page_record(conn, source_namespace: str, source_id: str, fun_id: str = "") -> dict:
    if not source_namespace or not source_id:
        raise PageIndexError("INVALID_LOCATOR", "sourceNamespace and sourceId are required")
    rows = conn.execute(
        """
        SELECT record_id, source_namespace, source_table, source_id, fun_id, source_path,
               source_hash, svn_revision, working_copy_id, scope_entry_id, status
        FROM gusen_source_record
        WHERE provider='svn' AND source_namespace=? AND source_table='page'
          AND source_id=? AND fun_id=?
        LIMIT 2
        """,
        (source_namespace, source_id, fun_id),
    ).fetchall()
    if not rows:
        raise PageIndexError("SOURCE_NOT_FOUND", "PAGE object was not found in the local index")
    if len(rows) != 1:
        raise PageIndexError("SOURCE_AMBIGUOUS", "PAGE object identity is ambiguous")
    record = dict(rows[0])
    if record["status"] not in {"OK", "SVN_DIRTY"}:
        raise PageIndexError("SOURCE_STALE", f"PAGE source status is {record['status']}",
                             retryable=True, next_action="Refresh the exact PAGE index entry")
    if (record["source_path"].lower().endswith(".json")
            and conn.execute("SELECT 1 FROM gusen_source_fragment "
                             "WHERE source_record_id=? LIMIT 1", (record["record_id"],)).fetchone()
            and not conn.execute("SELECT 1 FROM gusen_page_node "
                                 "WHERE source_record_id=? LIMIT 1", (record["record_id"],)).fetchone()):
        raise PageIndexError(
            "INDEX_STALE", "PAGE source has indexed fragments but no semantic nodes",
            retryable=True,
            next_action="Refresh the exact PAGE with svn reindex-file --path " + record["source_path"],
        )
    return record


def _source_path(workspace: dict, record: dict) -> Path:
    scope = load_authorized_scope(workspace)
    entry, path, _relative = resolve_authorized_path(scope, record["source_path"])
    if entry.id != record["scope_entry_id"] or not path.is_file():
        raise PageIndexError("UNAUTHORIZED_PATH", "Indexed PAGE path is outside the authorized source")
    return path


def _checked_raw(workspace: dict, record: dict) -> bytes:
    try:
        raw = _source_path(workspace, record).read_bytes()
    except OSError as error:
        raise PageIndexError("SOURCE_UNAVAILABLE", "Authorized PAGE source cannot be read",
                             retryable=True) from error
    if hashlib.sha256(raw).hexdigest() != record["source_hash"]:
        raise PageIndexError("SOURCE_STALE", "PAGE source has changed since indexing",
                             retryable=True, next_action="Refresh the exact PAGE index entry")
    return raw


def _encode_cursor(generation: str, query: list[str], after: list[str]) -> str:
    raw = json.dumps({"v": 1, "g": generation, "q": query, "k": after},
                     ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str, generation: str, query: list[str], *, key_length: int = 2) -> list[str]:
    if not isinstance(cursor, str) or len(cursor) > 4096:
        raise PageIndexError("INVALID_CURSOR", "PAGE node cursor is invalid")
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        value = json.loads(raw)
    except (ValueError, TypeError, binascii.Error) as error:
        raise PageIndexError("INVALID_CURSOR", "PAGE node cursor is invalid") from error
    if not isinstance(value, dict):
        raise PageIndexError("INVALID_CURSOR", "PAGE node cursor is invalid")
    if value.get("v") != 1 or value.get("g") != generation or value.get("q") != query:
        raise PageIndexError("CURSOR_STALE", "PAGE node cursor no longer matches this index snapshot",
                             retryable=True, next_action="Restart listing from the first page")
    key = value.get("k")
    if not isinstance(key, list) or len(key) != key_length or any(not isinstance(part, str) for part in key):
        raise PageIndexError("INVALID_CURSOR", "PAGE node cursor has no valid position")
    return key


def _require_index_file(workspace: dict) -> None:
    if not Path(workspace["indexPath"]).is_file():
        raise PageIndexError(
            "INDEX_REBUILD_REQUIRED", "PAGE node index does not exist",
            next_action="Run the existing SVN reindex command for this workspace",
        )


def search_sources(
    workspace: dict, *, keyword: str, source_type: str = "", limit: int = 20, cursor: str = "",
) -> dict:
    """Search exact workspace source identities with deterministic bounded pagination."""

    require_capability(workspace, "browse")
    if not isinstance(keyword, str) or not 1 <= len(keyword.strip()) <= 100:
        raise PageIndexError("INVALID_FILTER", "keyword must contain 1–100 characters")
    if not isinstance(source_type, str) or len(source_type) > 40:
        raise PageIndexError("INVALID_FILTER", "sourceType is invalid")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_PAGE_SIZE:
        raise PageIndexError("INVALID_LIMIT", f"limit must be between 1 and {MAX_PAGE_SIZE}")
    keyword = keyword.strip()
    _require_index_file(workspace)
    with _connection(workspace) as conn:
        generation = _require_source_ready(conn)
        query = [workspace["workspaceKey"], keyword, source_type]
        after = _decode_cursor(cursor, generation, query, key_length=5) if cursor else None
        if after and not after[-1].isdecimal():
            raise PageIndexError("INVALID_CURSOR", "Source search cursor has no valid record position")
        clauses = ["provider='svn'", "(instr(lower(source_id), ?) > 0 OR "
                   "instr(lower(source_alias_id), ?) > 0 OR "
                   "instr(lower(COALESCE(source_name, '')), ?) > 0)"]
        params: list[object] = [keyword.lower(), keyword.lower(), keyword.lower()]
        if source_type:
            clauses.append("source_table=?")
            params.append(source_type)
        if after:
            clauses.append("(source_table, source_namespace, source_id, fun_id, record_id) > (?, ?, ?, ?, ?)")
            params.extend([*after[:-1], int(after[-1])])
        rows = conn.execute(
            "SELECT record_id, source_table, source_namespace, source_id, fun_id, source_alias_id, "
            "source_name, source_path, source_hash, svn_revision, working_copy_id, status "
            "FROM gusen_source_record WHERE " + " AND ".join(clauses)
            + " ORDER BY source_table, source_namespace, source_id, fun_id, record_id LIMIT ?",
            (*params, limit + 1),
        ).fetchall()
    has_more = len(rows) > limit
    visible = rows[:limit]
    next_cursor = _encode_cursor(generation, query, [
        visible[-1]["source_table"], visible[-1]["source_namespace"],
        visible[-1]["source_id"], visible[-1]["fun_id"], str(visible[-1]["record_id"]),
    ]) if has_more else None
    return {
        "workspaceKey": workspace["workspaceKey"], "indexGeneration": generation,
        "sources": [{"sourceType": row["source_table"], "sourceNamespace": row["source_namespace"],
                     "sourceId": row["source_id"], "funId": row["fun_id"],
                     "sourceAliasId": row["source_alias_id"], "sourceName": row["source_name"],
                     "sourcePath": row["source_path"], "indexedSourceHash": row["source_hash"],
                     "svnBaseRevision": row["svn_revision"], "workingCopyId": row["working_copy_id"],
                     "status": row["status"]} for row in visible],
        "complete": not has_more, "truncated": has_more, "nextCursor": next_cursor,
    }


def list_nodes(
    workspace: dict, *, source_namespace: str, source_id: str, fun_id: str = "",
    node_type: str = "", event_scope: str = "", limit: int = 50, cursor: str = "",
) -> dict:
    """List indexed nodes without materializing PAGE JSON or script bodies."""

    require_capability(workspace, "browse")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_PAGE_SIZE:
        raise PageIndexError("INVALID_LIMIT", f"limit must be between 1 and {MAX_PAGE_SIZE}")
    if node_type and node_type not in {"SCRIPT", "SQL", "FIELD_COLLECTION"}:
        raise PageIndexError("INVALID_FILTER", "Unknown PAGE node type")
    if event_scope and event_scope not in {"PAGE", "SERVICE"}:
        raise PageIndexError("INVALID_FILTER", "Unknown PAGE event scope")
    _require_index_file(workspace)
    with _connection(workspace) as conn:
        generation = _require_ready(conn)
        record = _page_record(conn, source_namespace, source_id, fun_id)
        query = [workspace["workspaceKey"], source_namespace, source_id, fun_id, node_type, event_scope]
        after = _decode_cursor(cursor, generation, query) if cursor else None
        clauses = ["source_record_id=?"]
        params: list[object] = [record["record_id"]]
        if node_type:
            clauses.append("node_type=?")
            params.append(node_type)
        if event_scope:
            clauses.append("event_scope=?")
            params.append(event_scope)
        if after:
            clauses.append("(node_type, json_pointer) > (?, ?)")
            params.extend(after)
        rows = conn.execute(
            "SELECT json_pointer, node_type, label, content_hash, semantic_node_id, identity_stability, "
            "event_scope, owner_type, owner_id FROM gusen_page_node WHERE "
            + " AND ".join(clauses) + " ORDER BY node_type, json_pointer LIMIT ?",
            (*params, limit + 1),
        ).fetchall()
        _checked_raw(workspace, record)
    has_more = len(rows) > limit
    visible = rows[:limit]
    next_cursor = _encode_cursor(generation, query, [visible[-1]["node_type"], visible[-1]["json_pointer"]]) if has_more else None
    return {
        "workspaceKey": workspace["workspaceKey"], "sourceNamespace": source_namespace,
        "sourceType": "page", "sourceId": source_id, "funId": fun_id,
        "workingCopyId": record["working_copy_id"], "sourcePath": record["source_path"],
        "indexedSourceHash": record["source_hash"], "indexGeneration": generation,
        "nodes": [{"jsonPointer": row["json_pointer"], "nodeType": row["node_type"],
                   "label": row["label"], "contentHash": row["content_hash"],
                   "semanticNodeId": row["semantic_node_id"],
                   "identityStability": row["identity_stability"], "eventScope": row["event_scope"],
                   "ownerType": row["owner_type"], "ownerId": row["owner_id"]} for row in visible],
        "complete": not has_more, "truncated": has_more, "nextCursor": next_cursor,
    }


def _field_descriptor(row) -> dict:
    return {
        "jsonPointer": row["json_pointer"], "collectionPointer": row["collection_pointer"],
        "ordinal": row["ordinal"], "regionType": row["region_type"],
        "componentType": row["component_type"], "fieldId": row["field_id"],
        "nativeId": row["native_id"], "nativeGuid": row["native_guid"],
        "tableId": row["table_id"], "columnId": row["column_id"],
        "mappingResolution": "UNVERIFIED" if row["table_id"] and row["column_id"] else "NONE",
        "label": row["label"], "contentHash": row["content_hash"],
        "semanticFieldId": row["semantic_field_id"],
        "identityStability": row["identity_stability"],
    }


def list_fields(
    workspace: dict, *, source_namespace: str, source_id: str, fun_id: str = "",
    region_type: str = "", field_id: str = "", limit: int = 50, cursor: str = "",
) -> dict:
    """List typed UI fields; datasource projection columns stay in their source collection."""

    require_capability(workspace, "browse")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_PAGE_SIZE:
        raise PageIndexError("INVALID_LIMIT", f"limit must be between 1 and {MAX_PAGE_SIZE}")
    if region_type and region_type not in {"FORM", "SEARCH", "MAIN_TABLE", "DETAIL_TABLE", "UNKNOWN"}:
        raise PageIndexError("INVALID_FILTER", "Unknown PAGE field region")
    if not isinstance(field_id, str) or len(field_id) > 128:
        raise PageIndexError("INVALID_FILTER", "fieldId is invalid")
    _require_index_file(workspace)
    with _connection(workspace) as conn:
        generation = _require_ready(conn)
        record = _page_record(conn, source_namespace, source_id, fun_id)
        query = [workspace["workspaceKey"], source_namespace, source_id, fun_id, region_type, field_id]
        after = _decode_cursor(cursor, generation, query, key_length=4) if cursor else None
        if after and not after[2].isdecimal():
            raise PageIndexError("INVALID_CURSOR", "PAGE field cursor has no valid ordinal")
        clauses = ["source_record_id=?"]
        params: list[object] = [record["record_id"]]
        if region_type:
            clauses.append("region_type=?")
            params.append(region_type)
        if field_id:
            clauses.append("field_id=?")
            params.append(field_id)
        if after:
            clauses.append("(region_type, collection_pointer, ordinal, json_pointer) > (?, ?, ?, ?)")
            params.extend([after[0], after[1], int(after[2]), after[3]])
        rows = conn.execute(
            "SELECT * FROM gusen_page_field WHERE " + " AND ".join(clauses)
            + " ORDER BY region_type, collection_pointer, ordinal, json_pointer LIMIT ?",
            (*params, limit + 1),
        ).fetchall()
        _checked_raw(workspace, record)
    has_more = len(rows) > limit
    visible = rows[:limit]
    next_cursor = _encode_cursor(generation, query, [
        visible[-1]["region_type"], visible[-1]["collection_pointer"],
        str(visible[-1]["ordinal"]), visible[-1]["json_pointer"],
    ]) if has_more else None
    return {
        "workspaceKey": workspace["workspaceKey"], "sourceNamespace": source_namespace,
        "sourceType": "page", "sourceId": source_id, "funId": fun_id,
        "sourcePath": record["source_path"], "indexedSourceHash": record["source_hash"],
        "indexGeneration": generation, "coverage": "UI_FIELDS_ONLY",
        "referenceCompleteness": "UNKNOWN",
        "fields": [_field_descriptor(row) for row in visible],
        "complete": not has_more, "truncated": has_more, "nextCursor": next_cursor,
    }


def get_field(
    workspace: dict, *, source_namespace: str, source_id: str, target: dict,
    fun_id: str = "", max_chars: int = 12_000,
) -> dict:
    """Read one current UI field after source and indexed identity checks."""

    require_capability(workspace, "browse")
    if not isinstance(target, dict) or set(target) - {"semanticFieldId", "jsonPointer", "indexedSourceHash"}:
        raise PageIndexError("INVALID_TARGETS", "PAGE field target must be a supported object")
    if isinstance(max_chars, bool) or not isinstance(max_chars, int) or not 1 <= max_chars <= MAX_READ_CHARS:
        raise PageIndexError("INVALID_LIMIT", f"maxChars must be between 1 and {MAX_READ_CHARS}")
    semantic_id = target.get("semanticFieldId")
    pointer = target.get("jsonPointer")
    if bool(semantic_id) == bool(pointer):
        raise PageIndexError("INVALID_TARGETS", "Use exactly one semanticFieldId or jsonPointer")
    if semantic_id and (not isinstance(semantic_id, str) or len(semantic_id) > 128):
        raise PageIndexError("INVALID_TARGETS", "semanticFieldId is invalid")
    if pointer and (not isinstance(pointer, str) or len(pointer) > 4096):
        raise PageIndexError("INVALID_TARGETS", "jsonPointer is invalid")
    _require_index_file(workspace)
    with _connection(workspace) as conn:
        generation = _require_ready(conn)
        record = _page_record(conn, source_namespace, source_id, fun_id)
        raw = _checked_raw(workspace, record)
        if semantic_id:
            rows = conn.execute(
                "SELECT * FROM gusen_page_field WHERE source_record_id=? AND semantic_field_id=? LIMIT 2",
                (record["record_id"], semantic_id),
            ).fetchall()
        else:
            if target.get("indexedSourceHash") != record["source_hash"]:
                raise PageIndexError("SOURCE_STALE", "Pointer reads require the indexed source hash")
            rows = conn.execute(
                "SELECT * FROM gusen_page_field WHERE source_record_id=? AND json_pointer=? LIMIT 2",
                (record["record_id"], pointer),
            ).fetchall()
        if len(rows) != 1:
            raise PageIndexError("FIELD_AMBIGUOUS" if rows else "FIELD_NOT_FOUND",
                                 "PAGE UI field is not uniquely indexed")
        row = rows[0]
        if semantic_id and row["identity_stability"] != "STABLE":
            raise PageIndexError("FIELD_AMBIGUOUS", "PAGE field identity is not stable")
        data = json.loads(decode_source(raw)[0])
        if isinstance(data, str):
            data = json.loads(data)
        try:
            value = pointer_value(data, row["json_pointer"])
        except (KeyError, ValueError, TypeError) as error:
            raise PageIndexError("INDEX_STALE", "PAGE field Pointer no longer resolves") from error
        if not isinstance(value, dict):
            raise PageIndexError("INDEX_STALE", "PAGE UI field is no longer an object")
        canonical = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if hashlib.sha256(canonical.encode("utf-8")).hexdigest() != row["content_hash"]:
            raise PageIndexError("INDEX_STALE", "PAGE field content differs from the indexed field")
        content = json.dumps(value, ensure_ascii=False, indent=2)
    truncated = len(content) > max_chars
    return {
        "workspaceKey": workspace["workspaceKey"], "sourceNamespace": source_namespace,
        "sourceType": "page", "sourceId": source_id, "funId": fun_id,
        "sourcePath": record["source_path"], "indexedSourceHash": record["source_hash"],
        "indexGeneration": generation, "coverage": "UI_FIELDS_ONLY",
        "referenceCompleteness": "UNKNOWN",
        "field": {**_field_descriptor(row), "content": content[:max_chars]},
        "complete": not truncated, "truncated": truncated,
    }


def list_field_relations(
    workspace: dict, *, source_namespace: str, source_id: str, fun_id: str = "",
    source_field_id: str = "", target_field_id: str = "", limit: int = 50, cursor: str = "",
) -> dict:
    """List selectBox links and unresolved mappings, not a reference closure."""

    require_capability(workspace, "browse")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_PAGE_SIZE:
        raise PageIndexError("INVALID_LIMIT", f"limit must be between 1 and {MAX_PAGE_SIZE}")
    if any(not isinstance(value, str) or len(value) > 128 for value in (source_field_id, target_field_id)):
        raise PageIndexError("INVALID_FILTER", "Field identity filter is invalid")
    _require_index_file(workspace)
    with _connection(workspace) as conn:
        generation = _require_ready(conn)
        record = _page_record(conn, source_namespace, source_id, fun_id)
        query = [workspace["workspaceKey"], source_namespace, source_id, fun_id,
                 source_field_id, target_field_id]
        after = _decode_cursor(cursor, generation, query, key_length=1) if cursor else None
        if after and not after[0].isdecimal():
            raise PageIndexError("INVALID_CURSOR", "Field relation cursor has no valid position")
        clauses = ["source_record_id=?"]
        params: list[object] = [record["record_id"]]
        if source_field_id:
            clauses.append("source_field_id=?")
            params.append(source_field_id)
        if target_field_id:
            clauses.append("target_field_id=?")
            params.append(target_field_id)
        if after:
            clauses.append("relation_id>?")
            params.append(int(after[0]))
        rows = conn.execute(
            "SELECT relation_id, source_pointer, collection_pointer, source_field_id, "
            "relation_type, target_field_id, target_pointer, resolution, confidence, evidence_pointer "
            "FROM gusen_page_field_relation WHERE " + " AND ".join(clauses)
            + " ORDER BY relation_id LIMIT ?",
            (*params, limit + 1),
        ).fetchall()
        _checked_raw(workspace, record)
    has_more = len(rows) > limit
    visible = rows[:limit]
    return {
        "workspaceKey": workspace["workspaceKey"], "sourceNamespace": source_namespace,
        "sourceType": "page", "sourceId": source_id, "funId": fun_id,
        "sourcePath": record["source_path"], "indexedSourceHash": record["source_hash"],
        "indexGeneration": generation, "coverage": "SELECTBOX_EVIDENCE_ONLY",
        "referenceCompleteness": "UNKNOWN", "safetyUse": "DIAGNOSTIC_ONLY",
        "relations": [{
            "sourcePointer": row["source_pointer"], "collectionPointer": row["collection_pointer"],
            "sourceFieldId": row["source_field_id"], "relationType": row["relation_type"],
            "targetFieldId": row["target_field_id"], "targetPointer": row["target_pointer"],
            "resolution": row["resolution"], "confidence": row["confidence"],
            "evidencePointer": row["evidence_pointer"],
        } for row in visible],
        "complete": not has_more, "truncated": has_more,
        "nextCursor": _encode_cursor(generation, query, [str(visible[-1]["relation_id"])]) if has_more else None,
    }


def field_reference_diagnostics(
    workspace: dict, *, source_namespace: str, source_id: str,
    semantic_field_id: str, fun_id: str = "", limit: int = 20,
) -> dict:
    """Report bounded reference evidence; never certify that a field is safe to delete."""

    require_capability(workspace, "browse")
    if not isinstance(semantic_field_id, str) or not semantic_field_id.startswith("page-node:v1:"):
        raise PageIndexError("INVALID_TARGETS", "A stable semanticFieldId is required")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 20:
        raise PageIndexError("INVALID_LIMIT", "limit must be between 1 and 20")
    _require_index_file(workspace)
    with _connection(workspace) as conn:
        generation = _require_ready(conn)
        record = _page_record(conn, source_namespace, source_id, fun_id)
        rows = conn.execute(
            "SELECT * FROM gusen_page_field WHERE source_record_id=? AND semantic_field_id=? LIMIT 2",
            (record["record_id"], semantic_field_id),
        ).fetchall()
        if len(rows) != 1 or rows[0]["identity_stability"] != "STABLE":
            raise PageIndexError("FIELD_AMBIGUOUS" if rows else "FIELD_NOT_FOUND",
                                 "PAGE UI field is not uniquely indexed")
        field = rows[0]
        record_id = record["record_id"]
        native_id = field["field_id"]
        duplicates = conn.execute(
            "SELECT COUNT(*) FROM gusen_page_field WHERE source_record_id=? AND field_id=?",
            (record_id, native_id),
        ).fetchone()[0] if native_id else 0
        incoming = conn.execute(
            "SELECT source_pointer, evidence_pointer, resolution, target_pointer "
            "FROM gusen_page_field_relation WHERE source_record_id=? AND relation_type='SELECT_CODE_FIELD' "
            "AND target_field_id=? ORDER BY relation_id LIMIT ?",
            (record_id, native_id, limit + 1),
        ).fetchall() if native_id else []
        incoming_count = conn.execute(
            "SELECT COUNT(*) FROM gusen_page_field_relation WHERE source_record_id=? "
            "AND relation_type='SELECT_CODE_FIELD' AND target_field_id=?",
            (record_id, native_id),
        ).fetchone()[0] if native_id else 0
        unresolved = conn.execute(
            "SELECT evidence_pointer FROM gusen_page_field_relation WHERE source_record_id=? "
            "AND relation_type='OTHER_SET_FIELDS_UNPARSED' ORDER BY relation_id LIMIT ?",
            (record_id, limit + 1),
        ).fetchall()
        unresolved_count = conn.execute(
            "SELECT COUNT(*) FROM gusen_page_field_relation WHERE source_record_id=? "
            "AND relation_type='OTHER_SET_FIELDS_UNPARSED'",
            (record_id,),
        ).fetchone()[0]
        _checked_raw(workspace, record)
    reasons = ["DYNAMIC_REFERENCES_UNVERIFIED"]
    if incoming_count:
        reasons.append("EXPLICIT_INCOMING_REFERENCE")
    if unresolved_count:
        reasons.append("OTHER_SET_FIELDS_UNPARSED")
    if duplicates > 1:
        reasons.append("NATIVE_FIELD_ID_AMBIGUOUS")
    return {
        "workspaceKey": workspace["workspaceKey"], "sourceNamespace": source_namespace,
        "sourceType": "page", "sourceId": source_id, "funId": fun_id,
        "sourcePath": record["source_path"], "indexedSourceHash": record["source_hash"],
        "indexGeneration": generation, "target": _field_descriptor(field),
        "nativeFieldIdOccurrences": duplicates, "explicitIncomingCount": incoming_count,
        "explicitIncoming": [{
            "sourcePointer": row["source_pointer"], "evidencePointer": row["evidence_pointer"],
            "resolution": row["resolution"], "targetPointer": row["target_pointer"],
        } for row in incoming[:limit]],
        "unparsedMappingCount": unresolved_count,
        "unparsedMappingEvidence": [row["evidence_pointer"] for row in unresolved[:limit]],
        "referenceCompleteness": "UNKNOWN", "deletionSafety": "BLOCKED_UNVERIFIED",
        "blockingReasons": reasons,
        "complete": len(incoming) <= limit and len(unresolved) <= limit,
        "truncated": len(incoming) > limit or len(unresolved) > limit,
    }


def read_nodes(
    workspace: dict, *, source_namespace: str, source_id: str, targets: list[dict],
    fun_id: str = "", max_chars: int = 12_000,
) -> dict:
    """Read selected current nodes under the same index/source snapshot lock."""

    require_capability(workspace, "browse")
    if not isinstance(targets, list) or not 1 <= len(targets) <= MAX_READ_NODES:
        raise PageIndexError("INVALID_TARGETS", f"targets must contain 1–{MAX_READ_NODES} nodes")
    if isinstance(max_chars, bool) or not isinstance(max_chars, int) or not 1 <= max_chars <= MAX_READ_CHARS:
        raise PageIndexError("INVALID_LIMIT", f"maxChars must be between 1 and {MAX_READ_CHARS}")
    _require_index_file(workspace)
    with _connection(workspace) as conn:
        generation = _require_ready(conn)
        record = _page_record(conn, source_namespace, source_id, fun_id)
        raw = _checked_raw(workspace, record)
        data = json.loads(decode_source(raw)[0])
        if isinstance(data, str):
            data = json.loads(data)
        if not isinstance(data, dict):
            raise PageIndexError("SOURCE_INVALID", "PAGE JSON root must be an object")
        results = []
        remaining = max_chars
        for target in targets:
            if not isinstance(target, dict):
                raise PageIndexError("INVALID_TARGETS", "Each node target must be an object")
            if set(target) - {"semanticNodeId", "jsonPointer", "indexedSourceHash"}:
                raise PageIndexError("INVALID_TARGETS", "Unknown node target fields")
            semantic_id = target.get("semanticNodeId")
            pointer = target.get("jsonPointer")
            if semantic_id and (not isinstance(semantic_id, str) or len(semantic_id) > 128):
                raise PageIndexError("INVALID_TARGETS", "semanticNodeId is invalid")
            if pointer and (not isinstance(pointer, str) or len(pointer) > 4096):
                raise PageIndexError("INVALID_TARGETS", "jsonPointer is invalid")
            if bool(semantic_id) == bool(pointer):
                raise PageIndexError("INVALID_TARGETS", "Use exactly one semanticNodeId or jsonPointer")
            if semantic_id:
                rows = conn.execute(
                    "SELECT * FROM gusen_page_node WHERE source_record_id=? AND semantic_node_id=? LIMIT 2",
                    (record["record_id"], semantic_id),
                ).fetchall()
            else:
                if target.get("indexedSourceHash") != record["source_hash"]:
                    raise PageIndexError("SOURCE_STALE", "Pointer reads require the indexed source hash")
                rows = conn.execute(
                    "SELECT * FROM gusen_page_node WHERE source_record_id=? AND json_pointer=? LIMIT 2",
                    (record["record_id"], pointer),
                ).fetchall()
            if len(rows) != 1:
                raise PageIndexError("NODE_AMBIGUOUS" if rows else "NODE_NOT_FOUND", "PAGE node is not uniquely indexed")
            row = rows[0]
            if semantic_id and row["identity_stability"] != "STABLE":
                raise PageIndexError("NODE_AMBIGUOUS", "PAGE node identity is not stable")
            try:
                value = pointer_value(data, row["json_pointer"])
            except (KeyError, ValueError, TypeError) as error:
                raise PageIndexError("INDEX_STALE", "PAGE node Pointer no longer resolves") from error
            content = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
            canonical_content = value if isinstance(value, str) else json.dumps(
                value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            )
            if hashlib.sha256(canonical_content.encode("utf-8")).hexdigest() != row["content_hash"]:
                raise PageIndexError("INDEX_STALE", "PAGE node content differs from the indexed node")
            take = min(len(content), remaining)
            results.append({"jsonPointer": row["json_pointer"], "semanticNodeId": row["semantic_node_id"],
                            "nodeType": row["node_type"], "content": content[:take],
                            "truncated": take < len(content)})
            remaining -= take
        return {
            "workspaceKey": workspace["workspaceKey"], "sourceNamespace": source_namespace,
            "sourceType": "page", "sourceId": source_id, "funId": fun_id,
            "sourcePath": record["source_path"], "indexedSourceHash": record["source_hash"],
            "indexGeneration": generation, "nodes": results,
            "complete": all(not node["truncated"] for node in results),
            "truncated": any(node["truncated"] for node in results),
        }


def source_context(
    workspace: dict, *, source_namespace: str, source_id: str, fun_id: str = "", limit: int = 10,
) -> dict:
    """Return separate bounded evidence classes for one exact PAGE, never a mixed fact stream."""

    require_capability(workspace, "browse")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 20:
        raise PageIndexError("INVALID_LIMIT", "limit must be between 1 and 20")
    _require_index_file(workspace)
    with _connection(workspace) as conn:
        generation = _require_ready(conn)
        record = _page_record(conn, source_namespace, source_id, fun_id)
        _checked_raw(workspace, record)
        record_id = record["record_id"]
        fragments = conn.execute(
            "SELECT fragment_type, json_pointer, label, content_hash FROM gusen_source_fragment "
            "WHERE source_record_id=? ORDER BY fragment_type, json_pointer LIMIT ?",
            (record_id, limit + 1),
        ).fetchall()
        accesses = conn.execute(
            "SELECT table_name, operation, confidence, evidence FROM gusen_data_access "
            "WHERE source_record_id=? ORDER BY table_name, operation, access_id LIMIT ?",
            (record_id, limit + 1),
        ).fetchall()
        facts = conn.execute(
            "SELECT fact_kind, subject, value_text, confidence, line_start FROM gusen_logic_fact "
            "WHERE source_record_id=? ORDER BY fact_kind, line_start, fact_id LIMIT ?",
            (record_id, limit + 1),
        ).fetchall()
        node_count = conn.execute(
            "SELECT COUNT(*) FROM gusen_page_node WHERE source_record_id=?", (record_id,)
        ).fetchone()[0]
    truncated = any(len(rows) > limit for rows in (fragments, accesses, facts))
    return {
        "workspaceKey": workspace["workspaceKey"], "sourceNamespace": source_namespace,
        "sourceType": "page", "sourceId": source_id, "funId": fun_id,
        "sourcePath": record["source_path"], "indexedSourceHash": record["source_hash"],
        "indexGeneration": generation, "nodeCount": node_count,
        "fragments": [dict(row) for row in fragments[:limit]],
        "tableAccesses": [dict(row) for row in accesses[:limit]],
        "logicFacts": [dict(row) for row in facts[:limit]],
        "complete": not truncated, "truncated": truncated,
        "truncation": {"fragments": len(fragments) > limit,
                       "tableAccesses": len(accesses) > limit,
                       "logicFacts": len(facts) > limit},
    }

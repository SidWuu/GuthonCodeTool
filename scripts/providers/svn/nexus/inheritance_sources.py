"""Bounded, source-checked reads of project and inherited SVN scripts."""

from __future__ import annotations

import hashlib
import json

from common.inheritance import SOURCE_CATALOG_VERSION, procedure_body, project
from common.page_projection import extract_page_scripts, pointer_parts, pointer_value, json_pointer
from common.source_format import decode_source
from providers.svn.checkout import require_capability

from . import page_nodes, procedure_sources
from .index_queries import _connection


MAX_READ_CHARS = 24_000
SUPER_KEYS = {"pageEvents": "superPageEvents", "serviceEvents": "superServiceEvents"}


def _window(value: str | None, offset: int, size: int) -> dict | None:
    if value is None:
        return None
    if offset > len(value):
        return {"content": "", "totalChars": len(value), "complete": True}
    end = min(len(value), offset + size)
    return {"content": value[offset:end], "totalChars": len(value),
            "complete": end == len(value)}


def read_inherited_source(
    workspace: dict, *, source_type: str, source_namespace: str, source_id: str,
    fun_id: str = "", working_copy_id: str = "", json_pointer_value: str = "",
    indexed_source_hash: str = "", offset: int = 0, max_chars: int = 12_000,
) -> dict:
    """Read both physical layers and a source-mapped derived view, without a lease."""

    require_capability(workspace, "browse")
    if source_type not in {"procedure", "page"}:
        raise page_nodes.PageIndexError("INVALID_TARGET", "Only procedure or PAGE scripts support inheritance")
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise page_nodes.PageIndexError("INVALID_LIMIT", "offset must be nonnegative")
    if isinstance(max_chars, bool) or not isinstance(max_chars, int) or not 1 <= max_chars <= MAX_READ_CHARS:
        raise page_nodes.PageIndexError("INVALID_LIMIT", "maxChars is outside the allowed range")
    with _connection(workspace) as conn:
        version = conn.execute(
            "SELECT state_value FROM gusen_sync_state WHERE state_key='source_catalog_parser_version'"
        ).fetchone()
    if not version or version[0] != SOURCE_CATALOG_VERSION:
        raise page_nodes.PageIndexError(
            "INDEX_REBUILD_REQUIRED", "Inheritance source catalog requires a full SVN reindex",
            next_action="Rebuild the local SVN index for this workspace",
        )

    invalid_parent_header = False

    if source_type == "procedure":
        if not working_copy_id or not fun_id or json_pointer_value:
            raise page_nodes.PageIndexError("INVALID_LOCATOR", "Exact procedure identity is required")
        record, generation = procedure_sources._record(
            workspace, source_namespace=source_namespace, source_id=source_id,
            fun_id=fun_id, working_copy_id=working_copy_id,
        )
        project_original, project_hash = procedure_sources._current_source(workspace, record)
        parent_path = record["source_path"][:-len(".gss")] + ".inherit.gss"
        with _connection(workspace) as conn:
            rows = conn.execute(
                "SELECT * FROM gusen_source_record WHERE provider='svn' AND source_table='procedure-inherit' "
                "AND source_namespace=? AND working_copy_id=? AND source_path=? LIMIT 2",
                (source_namespace, working_copy_id, parent_path),
            ).fetchall()
        if len(rows) > 1:
            raise page_nodes.PageIndexError("SOURCE_AMBIGUOUS", "Inherited procedure is ambiguous")
        parent = dict(rows[0]) if rows else None
        if parent and (parent["source_id"] != source_id or parent["fun_id"] != fun_id):
            raise page_nodes.PageIndexError("SOURCE_IDENTITY_MISMATCH", "Inherited procedure identity differs from project source")
        if parent and parent["status"] not in {"OK", "SVN_DIRTY"}:
            raise page_nodes.PageIndexError("SOURCE_STALE", "Inherited procedure is not ready")
        if parent:
            product_original, product_hash = procedure_sources._current_source(workspace, parent)
            product_body, product_offset = procedure_body(product_original)
            invalid_parent_header = product_original.lstrip("\ufeff").startswith("/**") and product_offset == 0
            if invalid_parent_header:
                product_body = None
        else:
            product_original, product_hash, product_body, product_offset = None, None, None, 0
            invalid_parent_header = False
        product_source_path = parent_path if parent else None
        project_pointer = product_pointer = ""
    else:
        if not json_pointer_value or working_copy_id:
            raise page_nodes.PageIndexError("INVALID_LOCATOR", "Exact PAGE script pointer is required")
        with _connection(workspace) as conn:
            generation = page_nodes._require_ready(conn)
            record = page_nodes._page_record(conn, source_namespace, source_id, fun_id)
        raw = page_nodes._checked_raw(workspace, record)
        project_hash = hashlib.sha256(raw).hexdigest()
        if indexed_source_hash and indexed_source_hash != project_hash:
            raise page_nodes.PageIndexError("SOURCE_STALE", "PAGE source changed since selection")
        data = json.loads(decode_source(raw)[0])
        if isinstance(data, str):
            data = json.loads(data)
        scripts = {field.json_pointer for field in extract_page_scripts(data)}
        if json_pointer_value not in scripts:
            raise page_nodes.PageIndexError("NODE_NOT_FOUND", "Pointer is not a project script")
        project_original = pointer_value(data, json_pointer_value)
        parts = pointer_parts(json_pointer_value)
        product_parts = list(parts)
        if "pageEvents" in parts:
            product_parts[parts.index("pageEvents")] = "superPageEvents"
        elif "serviceEvents" in parts:
            product_parts[parts.index("serviceEvents")] = "superServiceEvents"
        elif len(parts) >= 2 and parts[-1] == "script":
            product_parts[-1] = "superScript"
        else:
            product_parts = []
        product_pointer = json_pointer(product_parts) if product_parts else ""
        try:
            inherited = pointer_value(data, product_pointer) if product_pointer else None
        except (KeyError, IndexError, TypeError, ValueError):
            inherited = None
        product_original = inherited if isinstance(inherited, str) else None
        product_body = product_original
        product_offset = 0
        product_hash = project_hash if product_original is not None else None
        product_source_path = record["source_path"] if product_original is not None else None
        project_pointer = json_pointer_value
        working_copy_id = record["working_copy_id"]

    projection = project(project_original, product_body, product_offset=product_offset)
    if invalid_parent_header:
        projection["status"] = "INVALID_PRODUCT_HEADER"
        projection["diagnostic"] = "Inherited procedure has an unterminated generated header"
    for segment in projection["segments"]:
        original = product_original if segment["layer"] == "product" else project_original
        rendered = projection["effective"][segment["start"]:segment["end"]]
        leading = len(rendered) - len(rendered.lstrip("\r\n"))
        segment["sourceLine"] = original.count("\n", 0, segment["sourceStart"] + leading) + 1
    # The complete product file remains available for inspection. The effective
    # segment points past its generated header to the executable body.
    values = {
        "projectOriginal": project_original,
        "productOriginal": product_original,
        "effective": projection["effective"],
    }
    windows = {key: _window(value, offset, max_chars) for key, value in values.items()}
    complete = all(value is None or value["complete"] for value in windows.values())
    return {
        "workspaceKey": workspace["workspaceKey"], "sourceType": source_type,
        "sourceNamespace": source_namespace, "sourceId": source_id, "funId": fun_id,
        "workingCopyId": working_copy_id, "indexGeneration": generation,
        "project": {"sourcePath": record["source_path"], "jsonPointer": project_pointer,
                    "sourceHash": project_hash},
        "product": {"sourcePath": product_source_path, "jsonPointer": product_pointer,
                    "sourceHash": product_hash},
        "inheritanceStatus": projection["status"],
        "materializable": projection["materializable"] and complete and offset == 0,
        "diagnostic": projection.get("diagnostic", ""),
        "segments": projection["segments"], "offset": offset,
        **windows, "complete": complete,
        "nextOffset": None if complete else offset + max_chars,
    }

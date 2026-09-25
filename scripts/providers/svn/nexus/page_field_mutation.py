"""Guarded single-field insertion for indexed SVN PAGE UI collections."""

from __future__ import annotations

import json
import re
import time
import uuid

from common.page_projection import extract_page_field_entities, pointer_value
from common.source_format import decode_source
from providers.svn.checkout import atomic_json, operation_lock, require_capability

from . import documents, page_nodes
from .manifest import load_authorized_scope


REGIONS = {"input-box": "FORM", "search-box": "SEARCH",
           "table-main": "MAIN_TABLE", "table-item": "DETAIL_TABLE"}
MAX_FIELD_BYTES = 64_000


def _field_id(value) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 128:
        raise page_nodes.PageIndexError("INVALID_FIELD", "A nonempty fieldId of at most 128 characters is required")
    return value.strip()


def _unsafe_references(field: dict, known_field_ids=()) -> bool:
    select = field.get("selectBox")
    if isinstance(select, dict) and any(select.get(key) for key in
                                         ("selectCodefieldId", "otherSetFields", "selectInitParam")):
        return True
    candidates = [value for value in known_field_ids if value and value != field.get("fieldId")]
    if not candidates:
        return False
    pattern = re.compile(r"(?<![A-Za-z0-9_])(?:" + "|".join(re.escape(value) for value in candidates)
                         + r")(?![A-Za-z0-9_])")

    def walk(value, key=""):
        if isinstance(value, dict):
            return any(walk(child, child_key) for child_key, child in value.items())
        if isinstance(value, list):
            return any(walk(child) for child in value)
        return key not in {"fieldId", "id", "guid"} and isinstance(value, str) and bool(pattern.search(value))

    return walk(field)


def _source_snapshot(workspace: dict, source_namespace: str, source_id: str, fun_id: str):
    with page_nodes._connection(workspace) as conn:
        generation = page_nodes._require_ready(conn)
        record = page_nodes._page_record(conn, source_namespace, source_id, fun_id)
        raw = page_nodes._checked_raw(workspace, record)
    parsed = json.loads(decode_source(raw)[0])
    if not isinstance(parsed, dict):
        raise page_nodes.PageIndexError("NODE_NOT_EDITABLE", "Double-encoded PAGE JSON is read-only")
    return generation, record, parsed


def open_field_insert(
    workspace: dict, *, source_namespace: str, source_id: str,
    collection_pointer: str, indexed_source_hash: str, action: str,
    field: dict | None = None, source_semantic_field_id: str = "",
    new_field_id: str = "", new_label: str = "",
    after_semantic_field_id: str = "", fun_id: str = "",
) -> dict:
    """Freeze a proposed add/copy and issue a short collection-bound lease."""

    require_capability(workspace, "edit")
    if action not in {"add", "copy"} or not isinstance(collection_pointer, str) or not collection_pointer:
        raise page_nodes.PageIndexError("INVALID_TARGETS", "action and collectionPointer are required")
    if not isinstance(indexed_source_hash, str) or len(indexed_source_hash) != 64:
        raise page_nodes.PageIndexError("INVALID_TARGETS", "indexedSourceHash is required")
    if not isinstance(new_label, str) or len(new_label) > 512:
        raise page_nodes.PageIndexError("INVALID_FIELD", "newLabel is invalid")
    with operation_lock(workspace, "page-field-edit-open", blocking=True,
                        timeout_seconds=documents.DOCUMENT_LOCK_TIMEOUT_SECONDS):
        generation, record, parsed = _source_snapshot(workspace, source_namespace, source_id, fun_id)
        if indexed_source_hash != record["source_hash"]:
            raise page_nodes.PageIndexError("SOURCE_STALE", "PAGE source changed since field listing")
        try:
            fields = pointer_value(parsed, collection_pointer)
            parent = pointer_value(parsed, collection_pointer.rpartition("/")[0])
        except (KeyError, ValueError, TypeError) as error:
            raise page_nodes.PageIndexError("INVALID_TARGETS", "Field collection Pointer is unavailable") from error
        if (not collection_pointer.endswith("/fields") or not isinstance(fields, list)
                or not isinstance(parent, dict) or parent.get("type") not in REGIONS
                or any(not isinstance(item, dict) for item in fields)):
            raise page_nodes.PageIndexError("NODE_NOT_EDITABLE", "Target is not a recognized UI field collection")
        region = REGIONS[parent["type"]]
        with page_nodes._connection(workspace) as conn:
            rows = conn.execute(
                "SELECT semantic_field_id, json_pointer, collection_pointer, region_type, identity_stability "
                "FROM gusen_page_field WHERE source_record_id=? AND collection_pointer=?",
                (record["record_id"], collection_pointer),
            ).fetchall()
        indexed = {row["semantic_field_id"]: row for row in rows if row["semantic_field_id"]}
        if len(rows) != len(fields) or any(row["region_type"] != region for row in rows):
            raise page_nodes.PageIndexError("INDEX_STALE", "Field collection differs from the index")

        if action == "add":
            if not isinstance(field, dict) or source_semantic_field_id or new_field_id:
                raise page_nodes.PageIndexError("INVALID_FIELD", "add requires one complete field object only")
            candidate = json.loads(json.dumps(field, ensure_ascii=False))
            candidate["fieldId"] = _field_id(candidate.get("fieldId"))
        else:
            if field is not None or not source_semantic_field_id:
                raise page_nodes.PageIndexError("INVALID_FIELD", "copy requires sourceSemanticFieldId and newFieldId")
            source_row = indexed.get(source_semantic_field_id)
            if not source_row or source_row["identity_stability"] != "STABLE":
                raise page_nodes.PageIndexError("FIELD_AMBIGUOUS", "Copy source is not a stable field in this collection")
            source_field = pointer_value(parsed, source_row["json_pointer"])
            candidate = json.loads(json.dumps(source_field, ensure_ascii=False))
            _field_id(candidate.get("fieldId"))
            candidate["fieldId"] = _field_id(new_field_id)
            if new_label:
                candidate["label"] = new_label
        known_field_ids = [str(item.get("fieldId") or "") for item in fields]
        if _unsafe_references(candidate, known_field_ids):
            raise page_nodes.PageIndexError("FIELD_RELATIONS_UNVERIFIED",
                                             "Reflection or unresolved field references require a separate group operation")
        if not isinstance(candidate.get("type"), str) or not candidate["type"]:
            raise page_nodes.PageIndexError("INVALID_FIELD", "Field type is required")
        if candidate["type"] == "select" and (not isinstance(candidate.get("selectBox"), dict)
                                               or not candidate["selectBox"].get("codeType")):
            raise page_nodes.PageIndexError("INVALID_FIELD", "Select field requires selectBox.codeType")
        if any(str(item.get("fieldId") or "").casefold() == candidate["fieldId"].casefold()
               for item in fields):
            raise page_nodes.PageIndexError("FIELD_DUPLICATE", "fieldId already exists in the target collection")
        candidate["id"] = uuid.uuid4().hex.upper()
        if "guid" in candidate:
            candidate["guid"] = uuid.uuid4().hex.upper()
        all_fields = extract_page_field_entities(parsed)
        for identity_key in ("id", "guid"):
            if identity_key not in candidate:
                continue
            existing = {getattr(item, "native_" + identity_key).casefold() for item in all_fields}
            if candidate[identity_key].casefold() in existing:
                raise page_nodes.PageIndexError("FIELD_DUPLICATE", f"Generated {identity_key} already exists")
        if len(json.dumps(candidate, ensure_ascii=False).encode("utf-8")) > MAX_FIELD_BYTES:
            raise page_nodes.PageIndexError("INVALID_FIELD", "Field candidate exceeds the size limit")
        insertion_index = len(fields)
        if after_semantic_field_id:
            after_row = indexed.get(after_semantic_field_id)
            if not after_row or after_row["identity_stability"] != "STABLE":
                raise page_nodes.PageIndexError("FIELD_AMBIGUOUS", "Insertion anchor is not stable")
            insertion_index = int(after_row["json_pointer"].rsplit("/", 1)[1]) + 1
        opened = documents.read(
            workspace, source_type="page", source_id=source_id, fun_id=fun_id,
            json_pointer=collection_pointer, working_copy_id=record["working_copy_id"],
        )
        if (not opened["editable"] or opened["sourcePath"] != record["source_path"]
                or opened["sourceHash"] != record["source_hash"]
                or json.loads(opened["content"]) != fields):
            raise page_nodes.PageIndexError("SOURCE_STALE", "Field collection lease could not bind the indexed PAGE")
        token = "page-field:v1:" + uuid.uuid4().hex
        session = documents.load_session(workspace)
        documents._validate_session(session, opened["sessionId"])
        session["pageEditTokens"][token] = {
            "kind": "FIELD_INSERT", "documentId": opened["documentId"],
            "sessionId": opened["sessionId"], "sourceNamespace": source_namespace,
            "sourceId": source_id, "funId": fun_id, "sourcePath": record["source_path"],
            "sourceHash": record["source_hash"], "documentHash": opened["documentHash"],
            "scopeDigest": load_authorized_scope(workspace).digest,
            "collectionPointer": collection_pointer, "action": action,
            "field": candidate, "index": insertion_index,
            "expiresAt": int(time.time()) + 30 * 60,
        }
        documents._prune_document_leases(session)
        atomic_json(documents.session_path(workspace), session)
        return {
            "workspaceKey": workspace["workspaceKey"], "sourceNamespace": source_namespace,
            "sourceType": "page", "sourceId": source_id, "funId": fun_id,
            "collectionPointer": collection_pointer, "regionType": region,
            "action": action, "field": candidate, "insertIndex": insertion_index,
            "editToken": token, "expiresAt": session["pageEditTokens"][token]["expiresAt"],
            "indexedSourceHash": record["source_hash"], "indexGeneration": generation,
        }


def insert_field(workspace: dict, *, edit_token: str, idempotency_key: str = "",
                 dry_run: bool = False) -> dict:
    require_capability(workspace, "edit")
    if not dry_run:
        documents._page_operation_path(workspace, idempotency_key)
    with operation_lock(workspace, "page-field-edit-write", blocking=True,
                        timeout_seconds=documents.DOCUMENT_LOCK_TIMEOUT_SECONDS):
        session = documents.load_session(workspace)
        token = session["pageEditTokens"].get(edit_token)
        if not token or token.get("kind") != "FIELD_INSERT":
            raise page_nodes.PageIndexError("EDIT_TOKEN_INVALID", "PAGE field edit token is missing or invalid")
        documents._validate_session(session, token["sessionId"])
        document = session["documents"].get(token["documentId"])
        operation_path = (documents._page_operation_path(workspace, idempotency_key)
                          if not dry_run else None)
        operation = documents._load_page_operation(operation_path) if operation_path else None
        if (not document or document.get("sourcePath") != token["sourcePath"]
                or document.get("jsonPointer") != token["collectionPointer"]
                or document.get("fragmentType") != "page-fields"
                or (operation is None and
                    document.get("expectedDocumentHash") != token["documentHash"])):
            raise page_nodes.PageIndexError("EDIT_TOKEN_STALE", "PAGE field collection lease changed")
        file_record = session["files"].get(token["sourcePath"])
        if not file_record:
            raise page_nodes.PageIndexError("EDIT_TOKEN_STALE", "PAGE field source lease is missing")
        source = documents._resolve_object(
            workspace, "page", token["sourceId"], token["funId"], file_record["workingCopyId"],
        )
        original = json.loads(documents._document_content(source, token["collectionPointer"])[0])
        already_inserted = (operation is not None and token["index"] < len(original)
                            and original[token["index"]] == token["field"])
        candidate = (original if already_inserted else
                     [*original[:token["index"]], token["field"], *original[token["index"]:]])
        changes = [{"documentId": token["documentId"],
                    "content": json.dumps(candidate, ensure_ascii=False, indent=2)}]
        insert_spec = {"index": token["index"], "field": token["field"]}
        if operation is None:
            if token["expiresAt"] < time.time() or token["scopeDigest"] != load_authorized_scope(workspace).digest:
                raise page_nodes.PageIndexError("EDIT_TOKEN_EXPIRED", "PAGE field edit token or scope expired")
            generation, record, parsed = _source_snapshot(
                workspace, token["sourceNamespace"], token["sourceId"], token["funId"],
            )
            if record["source_path"] != token["sourcePath"] or record["source_hash"] != token["sourceHash"]:
                raise page_nodes.PageIndexError("SOURCE_STALE", "PAGE field source changed after edit open")
            if pointer_value(parsed, token["collectionPointer"]) != original:
                raise page_nodes.PageIndexError("INDEX_STALE", "PAGE field collection changed after edit open")
        result = documents.write_page_nodes_batch(
            workspace, session_id=token["sessionId"], changes=changes,
            idempotency_key=idempotency_key if not dry_run else None,
            dry_run=dry_run, field_insert=insert_spec,
        )
        return {**result, "action": token["action"], "collectionPointer": token["collectionPointer"],
                "fieldId": token["field"]["fieldId"], "insertIndex": token["index"]}

"""Close an unstarted idempotent source request without cancelling source writes."""
from __future__ import annotations

import hashlib
import time
import uuid

from common.persistence import file_lock
from .client import ApiError

CLOSED_BEFORE_WRITE = "CLOSED_BEFORE_WRITE"


def close_unstarted(workspace, request, idempotency_key, *, confirm):
    """Serialize with dispatch, preserving any original operation that already exists."""
    from . import documents, source_batch

    if confirm is not True:
        raise ApiError("API_CONFIRM_REQUIRED", "关闭原请求需要明确确认，不会撤销已有源码写入")
    if not isinstance(idempotency_key, str) or not 1 <= len(idempotency_key) <= 256:
        raise ValueError("idempotency_key is required and at most 256 characters")
    kind = request["kind"]
    if kind == "document":
        directory = documents._directory(workspace)
        fields = ("leaseId", "previewId")
    elif kind == "source-batch":
        directory = source_batch._directory(workspace)
        fields = ("planId", "planHash")
    else:
        raise ValueError("unsupported source request kind")
    key_hash = hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()
    key_path = directory / "keys" / (key_hash + ".json")
    # Both dispatchers hold these same locks before registering a key and writing source.
    with file_lock(workspace["contextDir"] / "api/sync.lock"), file_lock(documents._directory(workspace) / "documents.lock"):
        if key_path.exists():
            existing = documents._load(key_path)
            if any(existing.get(field) != request[field] for field in fields):
                raise ApiError("API_IDEMPOTENCY_CONFLICT", "原幂等键不属于指定请求")
            if existing.get("state") == CLOSED_BEFORE_WRITE:
                return existing
            return {"workspaceKey": workspace["workspaceKey"], "kind": kind,
                    **{field: request[field] for field in fields}, "idempotencyKeyHash": key_hash,
                    "requestClosed": False, "state": "OPERATION_EXISTS", "operationId": existing["operationId"],
                    "mutationRetried": False}
        closed = {"workspaceKey": workspace["workspaceKey"], "kind": kind,
                  **{field: request[field] for field in fields}, "idempotencyKeyHash": key_hash,
                  "requestClosed": True, "state": CLOSED_BEFORE_WRITE, "closureId": uuid.uuid4().hex,
                  "closedAt": time.time(), "mutationRetried": False}
        documents._save(key_path, closed)
        return closed

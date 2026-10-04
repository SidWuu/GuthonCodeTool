"""Bounded operation-ledger inspection and explicit, recoverable completed-record GC."""
from __future__ import annotations

import hashlib
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from providers.svn.checkout import operation_lock, require_capability
from . import documents, page_nodes

MAX_OPERATION_RECORDS = 10_000


def _records(workspace: dict) -> list[dict]:
    records = []
    for kind, directory in (("page", "page-operations"), ("procedure", "procedure-operations")):
        root = workspace["contextDir"] / directory
        if root.is_symlink():
            raise page_nodes.PageIndexError("UNAUTHORIZED_PATH", "Operation directory is a symlink")
        if not root.exists():
            continue
        for path in sorted(root.glob("*.json")):
            if len(records) >= MAX_OPERATION_RECORDS:
                raise page_nodes.PageIndexError("RESULT_TOO_LARGE", "Ledger exceeds bounded inspection; narrow it offline")
            value = {"kind": kind, "path": str(path), "file": path.name}
            try:
                if path.is_symlink() or len(path.stem) != 64 or any(char not in "0123456789abcdef" for char in path.stem):
                    raise ValueError("Unexpected or linked journal filename")
                raw = path.read_bytes()
                if len(raw) > 1_048_576:
                    raise ValueError("Journal exceeds the 1 MiB inspection limit")
                record = documents._load_recorded_operation(path, kind)
                if (not record or record["workspaceKey"] != workspace["workspaceKey"]
                        or record["operationId"] != f"{kind}-op:v1:{path.stem}"
                        or (kind == "procedure" and record.get("sourceType") != "procedure")):
                    raise ValueError("Journal identity differs from its filename or workspace")
                value.update(operationId=record["operationId"], state=record["state"],
                             sourcePath=record["sourcePath"], updatedAt=record.get("updatedAt", ""),
                             sourceHash=record["afterHash"], documentIds=[item.get("documentId") for item in record["documents"]],
                             digest=hashlib.sha256(raw).hexdigest(), valid=True)
            except (Exception, SystemExit) as error:
                value.update(valid=False, error=str(error))
            records.append(value)
    return records


def inspect_operations(workspace: dict, *, limit: int = 20, cursor: str = "") -> dict:
    require_capability(workspace, "browse")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise page_nodes.PageIndexError("INVALID_LIMIT", "limit must be between 1 and 100")
    with operation_lock(workspace, "operations-inspect", shared=True):
        records = _records(workspace)
        generation = hashlib.sha256(json.dumps(records, sort_keys=True).encode("utf-8")).hexdigest()
        query = [workspace["workspaceKey"], "operations-v1"]
        after = page_nodes._decode_cursor(cursor, generation, query, key_length=1) if cursor else None
        if after and not after[0].isdecimal():
            raise page_nodes.PageIndexError("INVALID_CURSOR", "Invalid operation inspection position")
        offset = int(after[0]) if after else 0
        selected = records[offset:offset + limit]
        more = offset + limit < len(records)
        visible = [{key: value for key, value in record.items() if key not in {"path", "documentIds", "digest"}}
                   for record in selected]
        return {"workspaceKey": workspace["workspaceKey"], "operations": visible, "total": len(records),
                "invalidCount": sum(not record["valid"] for record in records),
                "pendingCount": sum(record.get("valid") and record.get("state") != "DIFF_VERIFIED" for record in records),
                "complete": not more, "truncated": more,
                "nextCursor": page_nodes._encode_cursor(generation, query, [str(offset + limit)]) if more else None}


def gc_operations(workspace: dict, *, before: str, check: bool = True, confirmation: str = "") -> dict:
    """Preview, then archive only completed, inactive journals using the exact plan hash.

    Archives retain source hashes and idempotency evidence for manual recovery.
    The destructive phase never touches source files or pending/corrupt records.
    """
    require_capability(workspace, "browse" if check else "edit")
    if not isinstance(check, bool):
        raise page_nodes.PageIndexError("INVALID_ARGUMENT", "check must be a boolean")
    try:
        cutoff = datetime.fromisoformat(before.replace("Z", "+00:00"))
        if cutoff.tzinfo is None:
            cutoff = cutoff.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError, AttributeError) as error:
        raise page_nodes.PageIndexError("INVALID_ARGUMENT", "before must be an ISO date or UTC timestamp") from error
    with operation_lock(workspace, "operations-gc", shared=check, blocking=True,
                        timeout_seconds=documents.DOCUMENT_LOCK_TIMEOUT_SECONDS):
        records = _records(workspace)
        session = documents.load_session(workspace)
        candidates = []
        blockers = []
        for record in records:
            if not record["valid"]:
                blockers.append({"file": record["file"], "reason": "INVALID_JOURNAL"})
                continue
            try:
                updated = datetime.fromisoformat(record["updatedAt"].replace("Z", "+00:00"))
                if updated.tzinfo is None:
                    raise ValueError("Timezone is missing")
            except ValueError:
                blockers.append({"file": record["file"], "reason": "INVALID_TIMESTAMP"})
                continue
            if updated >= cutoff:
                continue
            if record["state"] != "DIFF_VERIFIED":
                blockers.append({"file": record["file"], "reason": "OPERATION_PENDING"})
            elif any(document_id in session["documents"] for document_id in record["documentIds"]):
                blockers.append({"file": record["file"], "reason": "EDIT_LEASE_ACTIVE"})
            else:
                candidates.append(record)
        fingerprint = hashlib.sha256(json.dumps({"before": cutoff.isoformat(), "records": candidates,
                                                "blockers": blockers}, sort_keys=True).encode("utf-8")).hexdigest()
        plan = {"workspaceKey": workspace["workspaceKey"], "check": check, "before": cutoff.isoformat(),
                "candidateCount": len(candidates), "candidates": [{"operationId": row["operationId"], "file": row["file"]} for row in candidates[:100]],
                "blockerCount": len(blockers), "blockers": blockers[:100], "confirmation": fingerprint,
                "complete": len(candidates) <= 100 and len(blockers) <= 100,
                "truncated": len(candidates) > 100 or len(blockers) > 100, "archivedCount": 0}
        if check:
            return plan
        if blockers:
            raise page_nodes.PageIndexError("GC_BLOCKED", "Pending, damaged or active journals must be resolved before GC")
        if confirmation != fingerprint:
            raise page_nodes.PageIndexError("GC_PLAN_STALE", "Run check first and confirm its unchanged plan hash")
        if not candidates:
            return plan
        root = workspace["contextDir"] / "operation-archive"
        if root.is_symlink():
            raise page_nodes.PageIndexError("UNAUTHORIZED_PATH", "Operation archive is a symlink")
        archive = root / uuid.uuid4().hex
        archive.mkdir(parents=True, mode=0o700)
        moved = []
        try:
            for record in candidates:
                path = Path(record["path"])
                target = archive / (record["kind"] + "-" + record["file"])
                os.replace(path, target)
                moved.append((path, target))
        except OSError:
            for path, target in reversed(moved):
                os.replace(target, path)
            raise
        return {**plan, "archivedCount": len(moved), "archivePath": str(archive)}

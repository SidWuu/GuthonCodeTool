"""Shared private edit-journal schema and durable phase persistence."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from providers.svn.checkout import atomic_json

def operation_time() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def load_recorded_operation(path: Path, kind: str) -> dict | None:
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"{kind} operation record is unreadable; manual recovery required") from error
    if not isinstance(record, dict) or record.get("version") != 1:
        raise SystemExit(f"{kind} operation record is invalid; manual recovery required")
    required_strings = (
        "operationId", "workspaceKey", "sessionId", "requestHash", "state",
        "sourcePath", "scopeEntryId", "beforeHash", "afterHash",
    )
    if (any(not isinstance(record.get(key), str) or not record[key] for key in required_strings)
            or record["state"] not in {"PREFLIGHT_PASSED", "LOCAL_WRITE_DONE", "INDEX_SYNCED", "DIFF_VERIFIED"}
            or not isinstance(record.get("documents"), list)
            or not isinstance(record.get("result"), dict)
            or not isinstance(record.get("phaseTimes", {}), dict)):
        raise SystemExit(f"{kind} operation record is incomplete; manual recovery required")
    return record

def save_recorded_operation(path: Path, record: dict) -> None:
    record["updatedAt"] = operation_time()
    record.setdefault("phaseTimes", {}).setdefault(record["state"], record["updatedAt"])
    new_directory = not path.parent.exists()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if new_directory and os.name != "nt":
        descriptor = os.open(path.parent.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    atomic_json(path, record)
    # The preflight journal must survive a rename before the source file may be
    # replaced. Windows directory fsync is not supported by this runtime and
    # remains an explicit D6 platform gate.
    if os.name != "nt":
        descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

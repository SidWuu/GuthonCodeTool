"""Keep DATABASE mirror updates and their SQLite rows recoverable together."""
from __future__ import annotations

import json
import re
import shutil
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

from common.persistence import atomic_text, file_lock

_ACTIVE = ContextVar("guthon_source_transaction", default=None)


def _restore(workspace, directory, journal):
    root = workspace["readonlyDir"].resolve()
    for entry in reversed(journal["paths"]):
        target = Path(entry["target"])
        backup_name = entry["backup"]
        if not isinstance(backup_name, str) or not re.fullmatch(r"backup-\d+", backup_name):
            raise ValueError("Invalid source recovery backup; manual recovery required")
        backup = directory / backup_name
        safe_target = target.parent.resolve() / target.name
        if target != safe_target or target == root or not target.is_relative_to(root) or backup.parent.resolve() != directory.resolve():
            raise ValueError("Invalid source recovery path; manual recovery required")
        if backup.is_symlink() and not entry.get("allowLink"):
            raise ValueError("Invalid source recovery link; manual recovery required")
        if backup.exists() or backup.is_symlink() or not entry["existed"]:
            if target.is_symlink():
                target.unlink()
            elif target.exists():
                shutil.rmtree(target)
        if backup.exists() or backup.is_symlink():
            target.parent.mkdir(parents=True, exist_ok=True)
            backup.replace(target)


def recover(conn, workspace):
    parent = workspace["contextDir"] / "source-transactions"
    if not parent.exists():
        return
    committed = conn.execute("SELECT state_value FROM gusen_sync_state WHERE state_key='source_transaction_id'").fetchone()
    for directory in parent.iterdir():
        if not directory.is_dir() or directory.is_symlink():
            raise ValueError("Invalid source transaction journal; manual recovery required")
        journal = json.loads((directory / "journal.json").read_text(encoding="utf-8"))
        if journal["workspaceKey"] != workspace["workspaceKey"] or journal["id"] != directory.name:
            raise ValueError("Source journal identity mismatch; manual recovery required")
        if not committed or committed[0] != journal["id"]:
            _restore(workspace, directory, journal)
        shutil.rmtree(directory)


def prepare_path(path, *, allow_link=False):
    active = _ACTIVE.get()
    if active is None:
        return
    path = Path(path)
    path = path.parent.resolve() / path.name if allow_link else path.resolve()
    root = active["workspace"]["readonlyDir"].resolve()
    if path == root or not path.is_relative_to(root):
        raise ValueError("Source update path is outside the selected readonly mirror")
    if any(entry["target"] == str(path) for entry in active["journal"]["paths"]):
        return
    name = f"backup-{len(active['journal']['paths'])}"
    entry = {"target": str(path), "backup": name, "existed": path.exists() or path.is_symlink()}
    if allow_link:
        entry["allowLink"] = True
    active["journal"]["paths"].append(entry)
    atomic_text(active["directory"] / "journal.json", json.dumps(active["journal"]))
    if entry["existed"]:
        if not (allow_link and path.is_symlink()) and (path.is_symlink() or not path.is_dir()):
            raise ValueError("Source mirror path must be a physical directory")
        path.replace(active["directory"] / name)


@contextmanager
def source_transaction(conn, workspace):
    with file_lock(workspace["contextDir"] / ".source-write.lock"):
        recover(conn, workspace)
        identifier = uuid.uuid4().hex
        directory = workspace["contextDir"] / "source-transactions" / identifier
        directory.mkdir(parents=True)
        journal = {"id": identifier, "workspaceKey": workspace["workspaceKey"], "paths": []}
        atomic_text(directory / "journal.json", json.dumps(journal))
        token = _ACTIVE.set({"directory": directory, "journal": journal, "workspace": workspace})
        committed = False
        try:
            yield
            conn.execute("INSERT OR REPLACE INTO gusen_sync_state(state_key,state_value) VALUES(?,?)", ("source_transaction_id", identifier))
            conn.commit()
            committed = True
        except BaseException:
            conn.rollback()
            _restore(workspace, directory, journal)
            raise
        finally:
            _ACTIVE.reset(token)
            if committed or not any((directory / entry["backup"]).exists() or (directory / entry["backup"]).is_symlink()
                                    for entry in journal["paths"]):
                shutil.rmtree(directory)

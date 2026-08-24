"""Manage exact-URL SVN working copies for one Nexus workspace."""

from __future__ import annotations

import json
from pathlib import Path

from providers.svn.checkout import (
    atomic_json,
    operation_lock,
    require_capability,
    run_remote_svn,
    svn_info,
    svn_status,
)

from .manifest import STATE_VERSION, AuthorizedScope, ScopeEntry, load_authorized_scope


def state_path(workspace: dict) -> Path:
    return workspace["contextDir"] / "checkout-scope.json"


def load_state(workspace: dict, *, required=False) -> dict:
    path = state_path(workspace)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        if required:
            raise SystemExit(f"Missing SVN checkout state: {path}") from error
        return {}
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Invalid SVN checkout state: {path}") from error
    if (
        value.get("version") != STATE_VERSION
        or value.get("workspaceKey") != workspace["workspaceKey"]
        or value.get("checkoutLayout") != "manifest-working-copies"
    ):
        raise SystemExit(f"SVN checkout state does not match {workspace['workspaceKey']}")
    return value


def _validate_existing(entry: ScopeEntry) -> dict:
    if not (entry.root / ".svn").is_dir():
        raise SystemExit(f"Not an SVN working copy for scope entry {entry.id}: {entry.root}")
    info = svn_info(entry.root)
    if info["url"].rstrip("/") != entry.url:
        raise SystemExit(f"SVN URL mismatch for scope entry {entry.id}: {info['url']}")
    return info


def _checkout_entry(workspace: dict, entry: ScopeEntry) -> dict:
    if entry.root.exists() and not entry.root.is_dir():
        raise SystemExit(f"SVN checkout target is not a directory for scope entry {entry.id}: {entry.root}")
    if (entry.root / ".svn").is_dir():
        return _validate_existing(entry)
    if entry.root.exists() and any(entry.root.iterdir()):
        raise SystemExit(f"SVN checkout target is not empty for scope entry {entry.id}: {entry.root}")
    entry.root.parent.mkdir(parents=True, exist_ok=True)
    run_remote_svn(["checkout", entry.url, str(entry.root)], workspace["svn"])
    return _validate_existing(entry)


def _entry_record(entry: ScopeEntry, info: dict, status_value: dict) -> dict:
    return {
        "id": entry.id,
        "category": entry.category,
        "url": info.get("url") or entry.url,
        "localSubdir": entry.local_subdir,
        "root": str(entry.root),
        "writable": entry.writable,
        "repositoryRoot": info.get("repositoryRoot") or "",
        "repositoryUuid": info.get("repositoryUuid") or "",
        "relativeUrl": info.get("relativeUrl") or "",
        "revision": info.get("revision") or "",
        "clean": bool(status_value.get("clean")),
        "changes": status_value.get("changes") or [],
    }


def _state(workspace: dict, scope: AuthorizedScope, records: list[dict]) -> dict:
    repositories = {(item["repositoryRoot"], item["repositoryUuid"]) for item in records}
    if any(not root or not uuid for root, uuid in repositories):
        raise SystemExit(f"SVN repository identity is incomplete for {workspace['workspaceKey']}")
    return {
        "version": STATE_VERSION,
        "workspaceKey": workspace["workspaceKey"],
        "checkoutLayout": "manifest-working-copies",
        "authorizedScopeHash": scope.digest,
        "repositories": [
            {"root": root, "uuid": uuid}
            for root, uuid in sorted(repositories)
        ],
        "workingCopies": records,
    }


def _status(workspace: dict, scope: AuthorizedScope, *, include_diff=False, remote=False) -> dict:
    records = []
    for entry in scope.entries:
        info = _validate_existing(entry)
        current = svn_status(
            entry.root,
            include_diff=include_diff,
            remote=remote,
            settings=workspace["svn"],
        )
        records.append(_entry_record(entry, info, current))
        records[-1]["status"] = current
    state = _state(workspace, scope, records)
    state["clean"] = all(record["clean"] for record in records)
    return state


def initialize(workspace: dict) -> dict:
    require_capability(workspace, "initialize")
    scope = load_authorized_scope(workspace)
    with operation_lock(workspace, "manifest-init"):
        records = []
        for entry in scope.entries:
            info = _checkout_entry(workspace, entry)
            current = svn_status(entry.root)
            records.append(_entry_record(entry, info, current))
        state = _state(workspace, scope, records)
        state["clean"] = all(record["clean"] for record in records)
        atomic_json(state_path(workspace), state)
        return {"ok": True, "action": "initialized", "scope": state}


def status(workspace: dict, *, include_diff=False, remote=False) -> dict:
    require_capability(workspace, "status")
    scope = load_authorized_scope(workspace)
    with operation_lock(workspace, "manifest-status", shared=True):
        state = _status(workspace, scope, include_diff=include_diff, remote=remote)
        atomic_json(state_path(workspace), state)
        return {"ok": True, "status": state}


def refresh(workspace: dict, *, merge_local=False, working_copy_ids: list[str] | None = None) -> dict:
    require_capability(workspace, "refresh")
    scope = load_authorized_scope(workspace)
    selected = set(working_copy_ids or ())
    unknown = selected - {entry.id for entry in scope.entries}
    if unknown:
        raise SystemExit(f"Unknown SVN working copy ids: {', '.join(sorted(unknown))}")
    with operation_lock(workspace, "manifest-refresh"):
        updated = []
        for entry in scope.entries:
            _validate_existing(entry)
            if selected and entry.id not in selected:
                continue
            before = svn_status(entry.root, remote=True, settings=workspace["svn"])
            if not before["clean"] and not merge_local:
                raise SystemExit(
                    f"SVN update is blocked by local changes in {entry.id}; use the explicit merge-local action"
                )
            run_remote_svn(["update", str(entry.root)], workspace["svn"])
            after = svn_status(entry.root)
            updated.append({"id": entry.id, "before": before, "after": after})
        state = _status(workspace, scope)
        atomic_json(state_path(workspace), state)
        return {
            "ok": True,
            "action": "refreshed-with-local-merge" if merge_local else "refreshed",
            "updated": updated,
            "status": state,
        }

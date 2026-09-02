"""Manage exact-URL SVN working copies for one Nexus workspace."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

from providers.svn.checkout import (
    atomic_json,
    operation_lock,
    require_capability,
    run_remote_svn,
    run_svn,
    svn_info,
    svn_status,
)

from .manifest import (
    STATE_VERSION,
    AuthorizedScope,
    ScopeEntry,
    load_authorized_scope,
    resolve_authorized_path,
    scope_entry_label,
)


ProgressCallback = Callable[[str], None] | None


def _progress(callback: ProgressCallback, message: str) -> None:
    if callback is not None:
        callback(message)


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


def _status(
    workspace: dict,
    scope: AuthorizedScope,
    *,
    include_diff=False,
    remote=False,
    on_progress: ProgressCallback = None,
    phase="状态汇总",
    working_copy_ids: set[str] | None = None,
) -> dict:
    records = []
    candidates = [
        entry for entry in scope.entries
        if not working_copy_ids or entry.id in working_copy_ids
    ]
    total = len(candidates)
    for index, entry in enumerate(candidates, 1):
        label = scope_entry_label(workspace, entry)
        _progress(on_progress, f"[{index}/{total}] {label}｜{phase}｜检查 working copy")
        info = _validate_existing(entry)
        current = svn_status(
            entry.root,
            include_diff=include_diff,
            remote=remote,
            settings=workspace["svn"],
        )
        records.append(_entry_record(entry, info, current))
        records[-1]["status"] = current
        _progress(
            on_progress,
            f"[{index}/{total}] {label}｜{phase}｜完成 · r{info.get('revision') or '-'} · "
            f"{'干净' if current.get('clean') else '有本地修改'}",
        )
    state = _state(workspace, scope, records)
    state["clean"] = all(record["clean"] for record in records)
    return state


def _merge_refreshed_state(
    workspace: dict,
    scope: AuthorizedScope,
    previous: dict,
    refreshed: dict,
) -> dict:
    expected_ids = [entry.id for entry in scope.entries]
    previous_records = {
        item.get("id"): item
        for item in previous.get("workingCopies") or []
        if isinstance(item, dict) and item.get("id")
    }
    refreshed_records = {
        item.get("id"): item
        for item in refreshed.get("workingCopies") or []
        if isinstance(item, dict) and item.get("id")
    }
    records = {**previous_records, **refreshed_records}
    if previous.get("authorizedScopeHash") != scope.digest or any(
        entry_id not in records for entry_id in expected_ids
    ):
        return refreshed
    ordered = [records[entry_id] for entry_id in expected_ids]
    state = _state(workspace, scope, ordered)
    state["clean"] = all(record.get("clean") for record in ordered)
    return state


def initialize(workspace: dict, *, on_progress: ProgressCallback = None) -> dict:
    require_capability(workspace, "initialize")
    scope = load_authorized_scope(workspace)
    with operation_lock(workspace, "manifest-init"):
        records = []
        total = len(scope.entries)
        for index, entry in enumerate(scope.entries, 1):
            label = scope_entry_label(workspace, entry)
            action = "校验已有 working copy" if (entry.root / ".svn").is_dir() else "执行 SVN checkout"
            _progress(on_progress, f"[{index}/{total}] {label}｜初始化｜{action}")
            info = _checkout_entry(workspace, entry)
            _progress(on_progress, f"[{index}/{total}] {label}｜初始化｜检查本地状态")
            current = svn_status(entry.root)
            records.append(_entry_record(entry, info, current))
            _progress(
                on_progress,
                f"[{index}/{total}] {label}｜初始化｜完成 · r{info.get('revision') or '-'} · "
                f"{'干净' if current.get('clean') else '有本地修改'}",
            )
        state = _state(workspace, scope, records)
        state["clean"] = all(record["clean"] for record in records)
        atomic_json(state_path(workspace), state)
        return {"ok": True, "action": "initialized", "scope": state}


def status(
    workspace: dict,
    *,
    include_diff=False,
    remote=False,
    on_progress: ProgressCallback = None,
) -> dict:
    require_capability(workspace, "status")
    scope = load_authorized_scope(workspace)
    with operation_lock(workspace, "manifest-status", shared=True):
        state = _status(
            workspace,
            scope,
            include_diff=include_diff,
            remote=remote,
            on_progress=on_progress,
        )
        atomic_json(state_path(workspace), state)
        return {"ok": True, "status": state}


def refresh(
    workspace: dict,
    *,
    merge_local=False,
    working_copy_ids: list[str] | None = None,
    logical_paths: list[str] | None = None,
    on_progress: ProgressCallback = None,
) -> dict:
    require_capability(workspace, "refresh")
    scope = load_authorized_scope(workspace)
    selected = set(working_copy_ids or ())
    requested_paths = list(dict.fromkeys(str(value or "").strip() for value in (logical_paths or ())))
    if selected and requested_paths:
        raise SystemExit("Select SVN working copies or exact paths, not both")
    unknown = selected - {entry.id for entry in scope.entries}
    if unknown:
        raise SystemExit(f"Unknown SVN working copy ids: {', '.join(sorted(unknown))}")
    exact_targets: dict[str, list[tuple[Path, str, str]]] = {}
    for logical_path in requested_paths:
        entry, target, relative = resolve_authorized_path(scope, logical_path)
        if target.is_dir() or not Path(relative).suffix:
            raise SystemExit(f"Single SVN update target must be a file: {logical_path}")
        exact_targets.setdefault(entry.id, []).append((target, relative, logical_path))
    if exact_targets:
        selected = set(exact_targets)
    with operation_lock(workspace, "manifest-refresh"):
        previous_state = load_state(workspace, required=False)
        updated = []
        candidates = [entry for entry in scope.entries if not selected or entry.id in selected]
        total = len(candidates)
        progress_index = 0
        for entry in scope.entries:
            _validate_existing(entry)
            if selected and entry.id not in selected:
                continue
            progress_index += 1
            label = scope_entry_label(workspace, entry)
            _progress(on_progress, f"[{progress_index}/{total}] {label}｜更新｜检查远程状态")
            before = svn_status(entry.root, remote=True, settings=workspace["svn"])
            cleanup_performed = any(
                change.get("item") == "incomplete" or change.get("wcLocked")
                for change in before.get("changes") or []
            )
            if cleanup_performed:
                # Repair only SVN administrative locks/incomplete state.  Do not
                # remove unversioned files, revert edits, or break locks.
                _progress(
                    on_progress,
                    f"[{progress_index}/{total}] {label}｜更新｜清理 SVN working copy 锁",
                )
                run_svn(["cleanup", "--", str(entry.root)])
                _validate_existing(entry)
                before = svn_status(entry.root, remote=True, settings=workspace["svn"])
            targets = exact_targets.get(entry.id) or []
            if targets:
                remote_paths = {change.get("path") for change in before.get("remoteChanges") or []}
                missing = [logical for _target, relative, logical in targets if relative not in remote_paths]
                if missing:
                    raise SystemExit(
                        f"SVN path is no longer a remote change: {', '.join(missing)}"
                    )
                local_paths = {change.get("path") for change in before.get("changes") or []}
                overlapping_local = [
                    logical for _target, relative, logical in targets if relative in local_paths
                ]
            else:
                overlapping_local = [entry.id] if not before["clean"] else []
            if overlapping_local and not merge_local:
                raise SystemExit(
                    "SVN update is blocked by local changes in "
                    f"{', '.join(overlapping_local)}; use the explicit merge-local action"
                )
            update_paths = [target for target, _relative, _logical in targets] or [entry.root]
            _progress(on_progress, f"[{progress_index}/{total}] {label}｜更新｜执行 SVN update")
            update_result = run_remote_svn(["update", *map(str, update_paths)], workspace["svn"])
            _progress(on_progress, f"[{progress_index}/{total}] {label}｜更新｜检查更新后状态")
            after = svn_status(entry.root)
            updated.append(
                {
                    "id": entry.id,
                    "before": before,
                    "after": after,
                    "cleanupPerformed": cleanup_performed,
                    "paths": [logical for _target, _relative, logical in targets],
                }
            )
            update_summary = next(
                (line.strip() for line in reversed(update_result.stdout.splitlines()) if line.strip()),
                "SVN update 完成",
            )
            _progress(
                on_progress,
                f"[{progress_index}/{total}] {label}｜更新｜完成 · {update_summary}",
            )
        refreshed_state = _status(
            workspace,
            scope,
            on_progress=on_progress,
            phase="更新汇总",
            working_copy_ids={item["id"] for item in updated},
        )
        state = _merge_refreshed_state(workspace, scope, previous_state, refreshed_state)
        if len(state.get("workingCopies") or []) != len(scope.entries):
            state = _status(workspace, scope, on_progress=on_progress, phase="更新汇总")
        atomic_json(state_path(workspace), state)
        return {
            "ok": True,
            "action": "refreshed-with-local-merge" if merge_local else "refreshed",
            "updated": updated,
            "status": state,
        }

"""SCM operations for a logical Nexus workspace backed by multiple SVN WCs."""

from __future__ import annotations

import datetime as dt
import difflib
import json
import os
import tempfile
import uuid
from pathlib import Path

from providers.svn.checkout import (
    atomic_json,
    file_hash,
    operation_lock,
    require_capability,
    run_remote_svn,
    run_svn,
    run_svn_binary,
    svn_path_changes,
    svn_status,
)
from common.source_format import decode_source

from .documents import load_session, session_path
from .manifest import ScopeEntry, load_authorized_scope


TOKEN_VERSION = 1
TOKEN_TTL_SECONDS = 600
TOKEN_FILE = "svn-selection-token.json"
PLATFORM_STATE_FILE = "svn-platform-save-state.json"


def _logical_path(entry: ScopeEntry, relative: str) -> str:
    normalized = Path(relative).as_posix().lstrip("/")
    return f"{entry.local_subdir}/{normalized}" if normalized not in {"", "."} else entry.local_subdir


def _entry_and_path(workspace: dict, logical_path: str) -> tuple[ScopeEntry, Path, str]:
    scope = load_authorized_scope(workspace)
    normalized = Path(str(logical_path or "").replace("\\", "/")).as_posix().lstrip("/")
    matches = []
    for entry in scope.entries:
        prefix = entry.local_subdir
        if normalized == prefix:
            matches.append((entry, entry.root, "."))
        elif normalized.startswith(prefix + "/"):
            relative = normalized[len(prefix) + 1:]
            target = (entry.root / relative).resolve()
            if target == entry.root.resolve() or entry.root.resolve() in target.parents:
                matches.append((entry, target, relative))
    if len(matches) != 1:
        raise SystemExit(f"Path is outside or ambiguous in the authorized SVN scope: {logical_path}")
    return matches[0]


def _safe_session_change(change: dict, entry: ScopeEntry, session: dict) -> tuple[bool, str, dict]:
    logical_path = _logical_path(entry, change["path"])
    record = session["files"].get(logical_path) or {}
    path = entry.root / change["path"]
    safe = (
        change.get("item") == "modified"
        and change.get("properties") in {"", "normal", "none"}
        and not any(change.get(key) for key in ("treeConflicted", "switched", "copied"))
        and path.is_file()
        and record.get("state") == "LOCAL_MODIFIED"
        and record.get("expectedCurrentHash") == file_hash(path)
    )
    return safe, logical_path, record


def _platform_state(workspace: dict) -> dict:
    path = workspace["contextDir"] / PLATFORM_STATE_FILE
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if value.get("workspaceKey") == workspace["workspaceKey"] else {}


def status(workspace: dict, *, remote=False) -> dict:
    require_capability(workspace, "status")
    scope = load_authorized_scope(workspace)
    session = load_session(workspace)
    changes = []
    working_copies = []
    for entry in scope.entries:
        current = svn_status(entry.root, remote=remote, settings=workspace["svn"])
        working_copies.append(
            {
                "id": entry.id,
                "category": entry.category,
                "root": str(entry.root),
                "revision": current.get("revision") or "",
                "clean": current["clean"],
                "outOfDate": current.get("outOfDate", False),
            }
        )
        for change in current.get("changes") or []:
            safe, logical_path, record = _safe_session_change(change, entry, session)
            path = entry.root / change["path"]
            conflicted = bool(change.get("treeConflicted") or change.get("item") == "conflicted")
            untracked = change.get("item") == "unversioned"
            selectable = bool(
                change.get("item") == "modified"
                and change.get("properties") in {"", "normal", "none"}
                and not any(change.get(key) for key in ("treeConflicted", "switched", "copied"))
                and path.is_file()
            )
            state = (
                "CONFLICT"
                if conflicted
                else "UNTRACKED"
                if untracked
                else "LOCAL_MODIFIED"
                if safe
                else "EXTERNAL_MODIFIED"
            )
            changes.append(
                {
                    "workingCopyId": entry.id,
                    "scopeEntryId": entry.id,
                    "category": entry.category,
                    "path": logical_path,
                    "item": change.get("item") or "",
                    "properties": change.get("properties") or "",
                    "state": state,
                    "sessionManaged": safe,
                    "diffable": path.is_file(),
                    "selectable": selectable,
                    "sourceHash": file_hash(path) if selectable else "",
                }
            )
    return {
        "ok": True,
        "workspaceKey": workspace["workspaceKey"],
        "sessionId": session["sessionId"],
        "clean": not changes,
        "workingCopies": working_copies,
        "changes": changes,
        "groups": {
            state: [change for change in changes if change["state"] == state]
            for state in ("LOCAL_MODIFIED", "EXTERNAL_MODIFIED", "CONFLICT", "UNTRACKED")
        },
        "platformSave": _platform_state(workspace),
    }


def diff(workspace: dict, *, logical_path: str) -> dict:
    require_capability(workspace, "status")
    entry, path, relative = _entry_and_path(workspace, logical_path)
    if not path.is_file():
        raise SystemExit(f"SVN diff target is not a file: {logical_path}")
    with operation_lock(workspace, "manifest-diff", shared=True):
        base_result = run_svn_binary(["cat", "-r", "BASE", "--", str(path)], check=False)
        if base_result.returncode:
            change = next(
                (item for item in svn_path_changes(entry.root, path) if item["path"] == relative),
                None,
            )
            if not change or change.get("item") not in {"added", "unversioned"}:
                message = (base_result.stderr or base_result.stdout).decode("utf-8", errors="replace").strip()
                raise SystemExit(message or f"Unable to read SVN BASE: {logical_path}")
            base_bytes = b""
        else:
            base_bytes = base_result.stdout
        working_bytes = path.read_bytes()
    base_content = decode_source(base_bytes)[0]
    working_content = decode_source(working_bytes)[0]
    output = "".join(
        difflib.unified_diff(
            base_content.splitlines(keepends=True),
            working_content.splitlines(keepends=True),
            fromfile=f"{logical_path} (SVN BASE)",
            tofile=f"{logical_path} (working copy)",
        )
    )
    return {
        "ok": True,
        "workspaceKey": workspace["workspaceKey"],
        "workingCopyId": entry.id,
        "path": logical_path,
        "baseContent": base_content,
        "workingContent": working_content,
        "diff": output,
    }


def history(workspace: dict, *, logical_path: str, limit=20) -> dict:
    require_capability(workspace, "history")
    entry, path, _relative = _entry_and_path(workspace, logical_path)
    if not path.exists():
        raise SystemExit(f"SVN history target does not exist: {logical_path}")
    bounded_limit = max(1, min(int(limit), 100))
    with operation_lock(workspace, "manifest-history", shared=True):
        result = run_remote_svn(["log", "--xml", "--limit", str(bounded_limit), str(path)], workspace["svn"])
    return {
        "ok": True,
        "workspaceKey": workspace["workspaceKey"],
        "workingCopyId": entry.id,
        "path": logical_path,
        "xml": result.stdout,
    }


def _candidate_records(workspace: dict, session: dict) -> tuple[list[dict], list[dict]]:
    current_status = status(workspace)
    candidates = []
    for change in current_status["changes"]:
        if not change.get("selectable"):
            continue
        record = session["files"].get(change["path"]) or {}
        candidates.append(
            {
                "id": str(uuid.uuid4()),
                "workingCopyId": change["workingCopyId"],
                "scopeEntryId": change["scopeEntryId"],
                "path": change["path"],
                "sourceHash": change["sourceHash"],
                "objectType": record.get("objectType") or change["category"],
                "objectId": record.get("objectId") or Path(change["path"]).name,
                "funId": record.get("funId") or "",
                "sessionManaged": bool(change.get("sessionManaged")),
            }
        )
    if not candidates:
        raise SystemExit("当前项目没有可安全保存或撤销的 SVN 修改文件")
    blockers = [
        change
        for change in current_status["changes"]
        if not change.get("selectable")
    ]
    return candidates, blockers


def preview(workspace: dict, *, action: str, session_id: str) -> dict:
    if action == "revert":
        require_capability(workspace, "revert")
    elif action != "platform-save":
        raise SystemExit(f"Unsupported SVN selection action: {action}")
    session = load_session(workspace)
    if not session_id or session_id != session.get("sessionId"):
        raise SystemExit("SVN edit session is missing or expired")
    candidates, blockers = _candidate_records(workspace, session)
    now = dt.datetime.now(dt.timezone.utc)
    token = str(uuid.uuid4())
    record = {
        "version": TOKEN_VERSION,
        "workspaceKey": workspace["workspaceKey"],
        "sessionId": session_id,
        "action": action,
        "token": token,
        "createdAt": now.isoformat(),
        "expiresAt": (now + dt.timedelta(seconds=TOKEN_TTL_SECONDS)).isoformat(),
        "candidates": candidates,
        "blockers": blockers,
    }
    atomic_json(workspace["contextDir"] / TOKEN_FILE, record)
    return {
        "ok": True,
        "workspaceKey": workspace["workspaceKey"],
        "sessionId": session_id,
        "action": action,
        "selectionToken": token,
        "expiresAt": record["expiresAt"],
        "candidates": candidates,
        "blockers": blockers,
    }


def _load_selection(workspace: dict, *, action: str, session_id: str, token: str, candidate_ids: list[str]):
    path = workspace["contextDir"] / TOKEN_FILE
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit("SVN selection token is missing or invalid") from error
    now = dt.datetime.now(dt.timezone.utc)
    try:
        expires = dt.datetime.fromisoformat(record["expiresAt"])
    except (KeyError, ValueError) as error:
        raise SystemExit("SVN selection token has an invalid expiry") from error
    if (
        record.get("version") != TOKEN_VERSION
        or record.get("workspaceKey") != workspace["workspaceKey"]
        or record.get("sessionId") != session_id
        or record.get("action") != action
        or record.get("token") != token
        or expires <= now
    ):
        raise SystemExit("SVN selection token is expired or does not match the request")
    selected_ids = list(dict.fromkeys(str(value) for value in candidate_ids if str(value)))
    if not selected_ids:
        raise SystemExit("Select at least one SVN file")
    candidates_by_id = {item["id"]: item for item in record.get("candidates") or []}
    if any(candidate_id not in candidates_by_id for candidate_id in selected_ids):
        raise SystemExit("SVN selection contains an unknown candidate")
    selected = [candidates_by_id[candidate_id] for candidate_id in selected_ids]
    return path, selected


def _revalidate_selected(
    workspace: dict,
    session: dict,
    selected: list[dict],
    *,
    require_remote_current: bool,
) -> tuple[ScopeEntry, list[Path]]:
    scope = load_authorized_scope(workspace)
    entry_id = selected[0]["workingCopyId"]
    entry = next((value for value in scope.entries if value.id == entry_id), None)
    if entry is None:
        raise SystemExit("Selected SVN working copy is no longer authorized")
    current = svn_status(
        entry.root,
        remote=require_remote_current,
        settings=workspace["svn"] if require_remote_current else None,
    )
    if require_remote_current and current.get("outOfDate"):
        raise SystemExit(f"SVN working copy is out of date: {entry.id}")
    changes_by_path = {change["path"]: change for change in current.get("changes") or []}
    targets = []
    for candidate in selected:
        candidate_entry, path, relative = _entry_and_path(workspace, candidate["path"])
        change = changes_by_path.get(relative)
        safe = (
            candidate_entry.id == entry.id
            and path.is_file()
            and candidate["sourceHash"] == file_hash(path)
            and change
            and change.get("item") == "modified"
            and change.get("properties") in {"", "normal", "none"}
            and not any(change.get(key) for key in ("treeConflicted", "switched", "copied"))
        )
        if not safe:
            raise SystemExit(f"Selected SVN file changed after preview: {candidate['path']}")
        targets.append(path)
    return entry, targets


def _selected_groups(selected: list[dict]) -> list[list[dict]]:
    grouped = {}
    for candidate in selected:
        grouped.setdefault(candidate["workingCopyId"], []).append(candidate)
    return list(grouped.values())


def _clear_selected_session(workspace: dict, session: dict, selected: list[dict]) -> None:
    selected_paths = {item["path"] for item in selected}
    for logical_path in selected_paths:
        session["files"].pop(logical_path, None)
    session["documents"] = {
        key: value
        for key, value in session["documents"].items()
        if value.get("sourcePath") not in selected_paths
    }
    atomic_json(session_path(workspace), session)


def revert(
    workspace: dict,
    *,
    session_id: str,
    selection_token: str,
    candidate_ids: list[str],
) -> dict:
    require_capability(workspace, "revert")
    with operation_lock(workspace, "manifest-revert"):
        token_path, selected = _load_selection(
            workspace,
            action="revert",
            session_id=session_id,
            token=selection_token,
            candidate_ids=candidate_ids,
        )
        session = load_session(workspace)
        prepared = [
            (
                group,
                *_revalidate_selected(
                    workspace,
                    session,
                    group,
                    require_remote_current=False,
                ),
            )
            for group in _selected_groups(selected)
        ]
        groups = []
        for group, entry, targets in prepared:
            run_svn(["revert", *map(str, targets)])
            groups.append({"workingCopyId": entry.id, "files": [item["path"] for item in group]})
        _clear_selected_session(workspace, session, selected)
        token_path.unlink(missing_ok=True)
        return {
            "ok": True,
            "action": "reverted",
            "workspaceKey": workspace["workspaceKey"],
            "files": [item["path"] for item in selected],
            "groups": groups,
        }


def platform_save(
    workspace: dict,
    *,
    session_id: str,
    selection_token: str,
    candidate_ids: list[str],
    message: str,
) -> dict:
    commit_message = str(message or "").strip()
    if not commit_message:
        raise SystemExit("SVN commit message must not be empty")
    with operation_lock(workspace, "manifest-platform-save"):
        token_path, selected = _load_selection(
            workspace,
            action="platform-save",
            session_id=session_id,
            token=selection_token,
            candidate_ids=candidate_ids,
        )
        session = load_session(workspace)
        prepared = [
            (
                group,
                *_revalidate_selected(
                    workspace,
                    session,
                    group,
                    require_remote_current=True,
                ),
            )
            for group in _selected_groups(selected)
        ]
        saved_groups = []
        try:
            for group, entry, targets in prepared:
                descriptor, message_path = tempfile.mkstemp(
                    prefix="svn-message-", suffix=".txt", dir=workspace["contextDir"]
                )
                try:
                    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                        handle.write(commit_message)
                        handle.write("\n")
                    result = run_remote_svn(
                        ["commit", "--file", message_path, *map(str, targets)],
                        workspace["svn"],
                    )
                finally:
                    try:
                        os.unlink(message_path)
                    except FileNotFoundError:
                        pass
                after = svn_status(entry.root)
                remaining = {change["path"] for change in after.get("changes") or []}
                for target in targets:
                    relative = target.resolve().relative_to(entry.root.resolve()).as_posix()
                    if relative in remaining:
                        raise SystemExit(f"SVN commit did not clean the selected file: {relative}")
                revision = run_svn(["info", "--show-item", "revision", str(targets[0])]).stdout.strip()
                saved_groups.append(
                    {
                        "workingCopyId": entry.id,
                        "revision": revision,
                        "files": [item["path"] for item in group],
                        "svnOutput": result.stdout,
                    }
                )
                _clear_selected_session(workspace, session, group)
        except (Exception, SystemExit) as error:
            completed = "、".join(
                f"{group['workingCopyId']}@r{group['revision']}" for group in saved_groups
            ) or "无"
            raise SystemExit(f"分组保存中断；已完成：{completed}；失败：{error}") from error
        finally:
            token_path.unlink(missing_ok=True)
        revisions = [group["revision"] for group in saved_groups]
        platform_state = {
            "workspaceKey": workspace["workspaceKey"],
            "pendingPlatformSubmit": True,
            "statusVerified": False,
            "workingCopyId": saved_groups[-1]["workingCopyId"],
            "lastCommittedRevision": revisions[-1],
            "files": [item["path"] for item in selected],
            "groups": saved_groups,
            "committedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        }
        atomic_json(workspace["contextDir"] / PLATFORM_STATE_FILE, platform_state)
        return {
            "ok": True,
            "action": "saved-to-guthon",
            "workspaceKey": workspace["workspaceKey"],
            "workingCopyId": saved_groups[-1]["workingCopyId"],
            "revision": revisions[-1],
            "revisions": revisions,
            "groups": saved_groups,
            "files": platform_state["files"],
            "pendingPlatformSubmit": True,
            "platformStatusVerified": False,
            "svnOutput": "\n".join(group["svnOutput"] for group in saved_groups),
        }

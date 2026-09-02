"""SCM operations for a logical Nexus workspace backed by multiple SVN WCs."""

from __future__ import annotations

import datetime as dt
import difflib
import json
import os
import sqlite3
import tempfile
import uuid
from pathlib import Path
from typing import Callable
from urllib.parse import quote

from common.page_projection import extract_page_fields, extract_page_scripts
from providers.svn.checkout import (
    atomic_json,
    file_hash,
    operation_lock,
    require_capability,
    run_remote_svn,
    run_remote_svn_binary,
    run_svn,
    run_svn_binary,
    svn_info,
    svn_path_changes,
    svn_status,
)
from common.source_format import decode_source

from .documents import load_session, session_path
from .manifest import (
    ScopeEntry,
    load_authorized_scope,
    resolve_authorized_path,
    source_category,
    source_path_writable,
    scope_entry_label,
)


TOKEN_VERSION = 1
TOKEN_TTL_SECONDS = 600
TOKEN_FILE = "svn-selection-token.json"
PLATFORM_STATE_FILE = "svn-platform-save-state.json"
ProgressCallback = Callable[[str], None] | None


def _progress(callback: ProgressCallback, message: str) -> None:
    if callback is not None:
        callback(message)


def _page_projection(text: str) -> str:
    """Render PAGE JSON as stable script/SQL/field sections for human diffing."""

    data = json.loads(text)
    if isinstance(data, str):
        data = json.loads(data)
    if not isinstance(data, dict):
        raise ValueError("PAGE JSON root must be an object")
    sections = ["# PAGE 可读源码"]
    for field in extract_page_scripts(data):
        script_type = "GSS" if field.script_type == "vm" else field.script_type.upper()
        sections.extend(
            [
                "",
                f"## {script_type} · {field.display_name}",
                f"@json-pointer {field.json_pointer}",
                field.original_value,
            ]
        )
    for field in extract_page_fields(data):
        sections.extend(
            [
                "",
                f"## 字段 · {field['label']}",
                f"@json-pointer {field['json_pointer']}",
                field["content"],
            ]
        )
    return "\n".join(sections).rstrip() + "\n"


def _catalog_by_path(workspace: dict) -> dict[str, dict]:
    if not workspace["indexPath"].is_file():
        return {}
    try:
        from .index_queries import catalog

        return {item["sourcePath"]: item for item in catalog(workspace)["objects"]}
    except (OSError, sqlite3.Error, SystemExit):
        # SCM status remains available even when the derived index is missing or stale.
        return {}


def _change_metadata(indexed: dict[str, dict], logical_path: str) -> dict:
    item = indexed.get(logical_path)
    if not item:
        return {}
    return {
        "sourceType": item.get("sourceType") or "",
        "sourceId": item.get("sourceId") or "",
        "sourceName": item.get("sourceName") or "",
        "funId": item.get("funId") or "",
        "treePath": item.get("treePath") or [],
        "treeLabel": item.get("treeLabel") or "",
    }


def _logical_path(entry: ScopeEntry, relative: str) -> str:
    normalized = Path(relative).as_posix().lstrip("/")
    return f"{entry.local_subdir}/{normalized}" if normalized not in {"", "."} else entry.local_subdir


def _entry_and_path(workspace: dict, logical_path: str) -> tuple[ScopeEntry, Path, str]:
    return resolve_authorized_path(load_authorized_scope(workspace), logical_path)


def _safe_session_change(change: dict, entry: ScopeEntry, session: dict) -> tuple[bool, str, dict]:
    logical_path = _logical_path(entry, change["path"])
    record = session["files"].get(logical_path) or {}
    path = entry.root / change["path"]
    safe = (
        change.get("item") == "modified"
        and change.get("properties") in {"", "normal", "none"}
        and not any(change.get(key) for key in ("treeConflicted", "switched", "copied", "wcLocked"))
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


def status(workspace: dict, *, remote=False, on_progress: ProgressCallback = None) -> dict:
    require_capability(workspace, "status")
    scope = load_authorized_scope(workspace)
    session = load_session(workspace)
    changes = []
    remote_changes = []
    working_copies = []
    _progress(on_progress, "SCM 状态｜读取 Nexus 索引元数据")
    indexed = _catalog_by_path(workspace)
    total = len(scope.entries)
    phase = "检查远程与本地状态" if remote else "检查本地状态"
    for index, entry in enumerate(scope.entries, 1):
        label = scope_entry_label(workspace, entry)
        _progress(on_progress, f"[{index}/{total}] {label}｜SCM 状态｜{phase}")
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
                source_path_writable(entry, change["path"])
                and change.get("item") == "modified"
                and change.get("properties") in {"", "normal", "none"}
                and not any(change.get(key) for key in ("treeConflicted", "switched", "copied", "wcLocked"))
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
                    **_change_metadata(indexed, logical_path),
                }
            )
        for change in current.get("remoteChanges") or []:
            logical_path = _logical_path(entry, change["path"])
            remote_changes.append(
                {
                    "workingCopyId": entry.id,
                    "scopeEntryId": entry.id,
                    "category": entry.category,
                    "path": logical_path,
                    "item": change.get("item") or "",
                    "properties": change.get("properties") or "",
                    **_change_metadata(indexed, logical_path),
                }
            )
        _progress(
            on_progress,
            f"[{index}/{total}] {label}｜SCM 状态｜完成 · "
            f"本地 {len(current.get('changes') or [])} · 远程 {len(current.get('remoteChanges') or [])}",
        )
    return {
        "ok": True,
        "workspaceKey": workspace["workspaceKey"],
        "sessionId": session["sessionId"],
        "clean": not changes,
        "workingCopies": working_copies,
        "changes": changes,
        "remoteChecked": bool(remote),
        "remoteChanges": remote_changes,
        "groups": {
            state: [change for change in changes if change["state"] == state]
            for state in ("LOCAL_MODIFIED", "EXTERNAL_MODIFIED", "CONFLICT", "UNTRACKED")
        },
        "platformSave": _platform_state(workspace),
    }


def diff(workspace: dict, *, logical_path: str, remote=False) -> dict:
    require_capability(workspace, "status")
    entry, path, relative = _entry_and_path(workspace, logical_path)
    if not remote and not path.is_file():
        raise SystemExit(f"SVN diff target is not a file: {logical_path}")
    with operation_lock(workspace, "manifest-diff", shared=True):
        if remote:
            current = svn_status(entry.root, remote=True, settings=workspace["svn"])
            remote_change = next(
                (item for item in current.get("remoteChanges") or [] if item["path"] == relative),
                None,
            )
            if not remote_change:
                raise SystemExit(f"SVN path is no longer a remote change: {logical_path}")
            local_bytes = path.read_bytes() if path.is_file() else b""
            if remote_change.get("item") == "deleted":
                remote_bytes = b""
            else:
                entry_url = svn_info(entry.root)["url"]
                remote_url = f"{entry_url}/{quote(relative, safe='/')}"
                remote_result = run_remote_svn_binary(
                    ["cat", "-r", "HEAD", "--", remote_url],
                    workspace["svn"],
                    check=False,
                )
                if remote_result.returncode:
                    message = (remote_result.stderr or remote_result.stdout).decode(
                        "utf-8", errors="replace"
                    ).strip()
                    raise SystemExit(message or f"Unable to read SVN HEAD: {logical_path}")
                remote_bytes = remote_result.stdout
            local_content = decode_source(local_bytes)[0]
            remote_content = decode_source(remote_bytes)[0]
            readable_local = ""
            readable_remote = ""
            if path.suffix.lower() == ".json" and source_category(entry, relative) == "pages":
                try:
                    readable_local = _page_projection(local_content) if local_content else ""
                    readable_remote = _page_projection(remote_content) if remote_content else ""
                except (json.JSONDecodeError, TypeError, ValueError):
                    readable_local = ""
                    readable_remote = ""
            output = "".join(
                difflib.unified_diff(
                    local_content.splitlines(keepends=True),
                    remote_content.splitlines(keepends=True),
                    fromfile=f"{logical_path} (working copy)",
                    tofile=f"{logical_path} (SVN HEAD)",
                )
            )
            return {
                "ok": True,
                "workspaceKey": workspace["workspaceKey"],
                "workingCopyId": entry.id,
                "path": logical_path,
                "comparison": "remote",
                "localContent": local_content,
                "remoteContent": remote_content,
                "readableLocalContent": readable_local,
                "readableRemoteContent": readable_remote,
                "diff": output,
            }
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
    readable_base = ""
    readable_working = ""
    if path.suffix.lower() == ".json" and source_category(entry, relative) == "pages":
        try:
            readable_base = _page_projection(base_content)
            readable_working = _page_projection(working_content)
        except (json.JSONDecodeError, TypeError, ValueError):
            readable_base = ""
            readable_working = ""
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
        "readableBaseContent": readable_base,
        "readableWorkingContent": readable_working,
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


def _candidate_records(
    workspace: dict,
    session: dict,
    *,
    on_progress: ProgressCallback = None,
) -> tuple[list[dict], list[dict]]:
    current_status = status(workspace, on_progress=on_progress)
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


def preview(
    workspace: dict,
    *,
    action: str,
    session_id: str,
    on_progress: ProgressCallback = None,
) -> dict:
    if action == "revert":
        require_capability(workspace, "revert")
    elif action != "platform-save":
        raise SystemExit(f"Unsupported SVN selection action: {action}")
    session = load_session(workspace)
    if not session_id or session_id != session.get("sessionId"):
        raise SystemExit("SVN edit session is missing or expired")
    _progress(on_progress, f"{action}｜生成可选文件和阻断项")
    candidates, blockers = _candidate_records(workspace, session, on_progress=on_progress)
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
    _progress(on_progress, f"{action}｜预览完成 · 可选 {len(candidates)} 个文件 · 阻断 {len(blockers)} 个")
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
    on_progress: ProgressCallback = None,
    phase: str = "提交前校验",
) -> tuple[ScopeEntry, list[Path]]:
    scope = load_authorized_scope(workspace)
    entry_id = selected[0]["workingCopyId"]
    entry = next((value for value in scope.entries if value.id == entry_id), None)
    if entry is None:
        raise SystemExit("Selected SVN working copy is no longer authorized")
    label = scope_entry_label(workspace, entry)
    _progress(on_progress, f"{label}｜{phase}｜重新检查 SVN 状态")
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
            and source_path_writable(candidate_entry, relative)
            and path.is_file()
            and candidate["sourceHash"] == file_hash(path)
            and change
            and change.get("item") == "modified"
            and change.get("properties") in {"", "normal", "none"}
            and not any(change.get(key) for key in ("treeConflicted", "switched", "copied", "wcLocked"))
        )
        if not safe:
            raise SystemExit(f"Selected SVN file changed after preview: {candidate['path']}")
        targets.append(path)
    _progress(on_progress, f"{label}｜{phase}｜通过 · {len(targets)} 个文件")
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
    on_progress: ProgressCallback = None,
) -> dict:
    require_capability(workspace, "revert")
    with operation_lock(workspace, "manifest-revert"):
        _progress(on_progress, "放弃本地修改｜读取选择并重新校验")
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
                    on_progress=on_progress,
                    phase="放弃前校验",
                ),
            )
            for group in _selected_groups(selected)
        ]
        groups = []
        total = len(prepared)
        for index, (group, entry, targets) in enumerate(prepared, 1):
            _progress(
                on_progress,
                f"[{index}/{total}] {scope_entry_label(workspace, entry)}｜放弃｜执行 SVN revert · "
                f"{len(targets)} 个文件",
            )
            run_svn(["revert", *map(str, targets)])
            groups.append({"workingCopyId": entry.id, "files": [item["path"] for item in group]})
            _progress(on_progress, f"[{index}/{total}] {scope_entry_label(workspace, entry)}｜放弃｜完成")
        _progress(on_progress, "放弃本地修改｜清理 Nexus 编辑会话")
        _clear_selected_session(workspace, session, selected)
        token_path.unlink(missing_ok=True)
        _progress(on_progress, f"放弃本地修改｜完成 · {len(selected)} 个文件")
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
    on_progress: ProgressCallback = None,
) -> dict:
    commit_message = str(message or "").strip()
    with operation_lock(workspace, "manifest-platform-save"):
        _progress(on_progress, "提交 Nexus 修改｜读取选择并重新校验")
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
                    on_progress=on_progress,
                    phase="提交前校验",
                ),
            )
            for group in _selected_groups(selected)
        ]
        saved_groups = []
        try:
            total = len(prepared)
            for index, (group, entry, targets) in enumerate(prepared, 1):
                label = scope_entry_label(workspace, entry)
                _progress(
                    on_progress,
                    f"[{index}/{total}] {label}｜提交｜写入 SVN 提交说明并执行 commit · "
                    f"{len(targets)} 个文件",
                )
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
                _progress(on_progress, f"[{index}/{total}] {label}｜提交｜检查提交后的 working copy 状态")
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
                _progress(on_progress, f"[{index}/{total}] {label}｜提交｜完成 · r{revision}")
                _clear_selected_session(workspace, session, group)
            _progress(on_progress, "提交 Nexus 修改｜写入待谷神平台最终提交状态")
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
        _progress(
            on_progress,
            f"提交 Nexus 修改｜完成 · {len(saved_groups)} 个 working copy · "
            f"revision {'、'.join(revisions)}",
        )
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

"""Coordinate live Nexus drafts with all API file writers; not an OS security boundary."""

from __future__ import annotations
import json
import os
import sys
import secrets
from common.persistence import atomic_text, file_lock
from .client import ApiError


def _live(pid):
    if sys.platform == "win32":
        # Windows os.kill(pid, 0) calls TerminateProcess; use query-only handles.
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(wintypes.DWORD),
        ]
        kernel.GetExitCodeProcess.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            # Access denied does not prove the editor is gone; retain its drafts.
            return ctypes.get_last_error() != 87
        try:
            code = wintypes.DWORD()
            if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
                return True
            return code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False


def update(workspace, payload):
    if not isinstance(payload, dict) or set(payload) - {
        "pid",
        "documents",
        "editorToken",
        "close",
    }:
        raise ApiError("API_INPUT_INVALID", "编辑会话字段无效")
    directory = workspace["contextDir"] / "api"
    path = directory / "editors.json"
    with file_lock(directory / "editors.lock"):
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            state = {}
        token = payload.get("editorToken")
        if token and token not in state:
            raise ApiError("API_EDITOR_SESSION_INVALID", "编辑会话已失效，请重新登记")
        if payload.get("close"):
            if not token:
                raise ApiError("API_EDITOR_SESSION_INVALID", "关闭会话需要原会话令牌")
            state.pop(token)
        else:
            pid = payload.get("pid")
            if type(pid) is not int or pid <= 0 or not _live(pid):
                raise ApiError("API_EDITOR_SESSION_INVALID", "编辑器进程无效")
            documents = payload.get("documents")
            if not isinstance(documents, list) or len(documents) > 1000:
                raise ApiError("API_INPUT_INVALID", "编辑文档列表无效")
            normalized = []
            for item in documents:
                if (
                    not isinstance(item, dict)
                    or set(item) - {"path", "dirty", "version"}
                    or not isinstance(item.get("path"), str)
                    or type(item.get("dirty")) is not bool
                ):
                    raise ApiError("API_INPUT_INVALID", "编辑文档状态无效")
                target = (workspace["providerSourceRoot"] / item["path"]).resolve()
                if not target.is_relative_to(workspace["providerSourceRoot"].resolve()):
                    raise ApiError(
                        "API_SOURCE_PATH_INVALID", "编辑文档不属于当前checkout"
                    )
                normalized.append(
                    {
                        "path": target.relative_to(
                            workspace["providerSourceRoot"].resolve()
                        ).as_posix(),
                        "dirty": item["dirty"],
                        "version": item.get("version"),
                    }
                )
            if token and state[token]["pid"] != pid:
                raise ApiError("API_EDITOR_SESSION_INVALID", "编辑进程与会话不一致")
            token = token or secrets.token_urlsafe(24)
            state[token] = {"pid": pid, "documents": normalized}
        atomic_text(path, json.dumps(state, ensure_ascii=False) + "\n")
    return {"editorToken": token, "closed": bool(payload.get("close"))}


def assert_writable(workspace, paths, editor_token=None):
    directory = workspace["contextDir"] / "api"
    path = directory / "editors.json"
    with file_lock(directory / "editors.lock"):
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        dead = []
        for token, entry in state.items():
            if not _live(entry["pid"]):
                dead.append(token)
                continue
            if token == editor_token:
                continue
            blocked = [
                x["path"]
                for x in entry["documents"]
                if x["dirty"] and (paths is None or x["path"] in paths)
            ]
            if blocked:
                raise ApiError(
                    "API_EDITOR_DIRTY",
                    "Nexus存在未保存文档/设计器草稿：" + ", ".join(blocked[:5]),
                )
        if dead:
            for token in dead:
                state.pop(token)
            atomic_text(path, json.dumps(state, ensure_ascii=False) + "\n")

"""Verify external edits against the owning local provider and refresh its derived index."""

import hashlib
import os
from pathlib import Path
import re
import sqlite3

PURE_SUFFIXES = {".gss", ".js", ".css", ".sql", ".vm", ".java"}


def workcopy_snapshot(root):
    # Workcopy also contains generated page projections. Compare inexpensive local file
    # stamps at the two hook boundaries; only changed paths need provider verification.
    result = {}
    if not root.exists():
        return result

    def fail(error):
        raise error

    for folder, directories, files in os.walk(root, onerror=fail):
        directories[:] = [name for name in directories if name not in {".svn", ".git"}]
        for name in files:
            path = Path(folder) / name
            if path.suffix.lower() in PURE_SUFFIXES | {".json", ".xml"}:
                stat = path.lstat()
                result[str(path)] = f"{stat.st_ino}:{stat.st_size}:{stat.st_mtime_ns}:{stat.st_ctime_ns}"
    return result


def run(workspace, action, payload):
    mode = workspace["sourceMode"]
    if mode == "api":
        from providers.api import direct_edit as provider
    elif mode == "svn":
        from providers.svn import direct_edit as provider
    elif mode == "database":
        from providers.database import direct_edit as provider
    else:
        raise ValueError("当前工作区不支持本地源码直改")
    response = {"ok": True, "workspaceKey": workspace["workspaceKey"], "root": str(workspace["root"]), "sourceMode": mode}
    roots = [entry["path"] for entry in workspace["sourceRoots"]
             if entry["role"] in {"api-checkout", "svn-working-copy", "svn-checkout", "workcopy"}]
    if any(root.resolve() != root for root in roots):
        raise ValueError("工作区的登记源码目录已被替换为链接，请核对配置")
    if action == "snapshot" and payload == {}:
        if not any(root.is_dir() for root in roots):
            changes = {}
        elif mode == "database":
            changes = workcopy_snapshot(workspace["workcopyDir"])
        else:
            changes = provider.changed_files(workspace)
        return {**response, "changes": changes}
    if (action not in {"inspect", "refresh"} or not isinstance(payload, dict) or set(payload) != {"files"}
            or not isinstance(payload["files"], list) or not payload["files"]):
        raise ValueError("需要明确的直改文件清单")
    results = []
    for item in payload["files"]:
        fields = {"path", "sourceHash"} if action == "refresh" else {"path"}
        if (not isinstance(item, dict) or set(item) != fields or not isinstance(item["path"], str)
                or action == "refresh" and not re.fullmatch(r"[0-9a-f]{64}", str(item["sourceHash"]))):
            raise ValueError("直改核验需要准确的文件路径和所核验版本")
        path = Path(item["path"])
        try:
            if (not path.is_absolute() or path.resolve() != path or not path.is_file()
                    or path.suffix.lower() not in PURE_SUFFIXES or path.stat().st_nlink > 1 or not os.access(path, os.W_OK)
                    or not any(root in path.parents for root in roots)):
                raise ValueError("仅允许修改登记源码目录中现有的普通纯源码文件")
            before = hashlib.sha256(path.read_bytes()).hexdigest()
            if action == "refresh" and before != item["sourceHash"]:
                raise ValueError("磁盘文件已变化，请重新核对")
            record = provider.inspect_file(workspace, path, refresh=action == "refresh")
            if (record["sourceHash"] != before or type(record["modified"]) is not bool
                    or action == "refresh" and record.get("indexedHash") != before
                    or hashlib.sha256(path.read_bytes()).hexdigest() != before):
                raise ValueError("文件、差异或索引版本发生变化，请重新核对")
            results.append({**record, "path": str(path), "ok": True})
        except (ValueError, OSError, RuntimeError, sqlite3.Error, SystemExit) as error:
            results.append({"path": str(path), "ok": False, "error": str(error)})
    return {**response, "files": results}

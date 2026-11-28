"""Local direct-edit eligibility and checkout change inventory for API sources."""

from __future__ import annotations

from contextlib import closing
import os
from pathlib import Path

from common.persistence import file_lock
from . import documents, index, page_source
from .client import ApiError
from .editor_state import assert_writable
from .store import ApiStore


CODE_SUFFIXES = {".js", ".gss", ".vm", ".java", ".sql", ".css"}
SOURCE_SUFFIXES = CODE_SUFFIXES | {".json", ".xml"}


def inspect_file(workspace, path: Path, *, refresh: bool) -> dict:
    if workspace.get("sourceMode") != "api" or not workspace["capabilities"].get("api.edit"):
        raise ApiError("API_CAPABILITY_REQUIRED", "当前工作区未启用 API 源码编辑")
    store = ApiStore(workspace)
    try:
        relative = path.relative_to(store.root).as_posix()
    except ValueError as error:
        raise ApiError("API_SOURCE_PATH_INVALID", "源码不属于当前 API checkout") from error

    with file_lock(documents._directory(workspace) / "documents.lock"):
        item = store.read(relative)
        metadata = item["metadata"]
        kind = metadata.get("sourceType", "")
        if item["readonly"] or kind.endswith("-inherit"):
            raise ApiError("API_SOURCE_READONLY", "继承或受管源码不可直接修改")
        if metadata.get("remoteDeleted"):
            raise ApiError("API_REMOTE_DELETED", "平台已删除该源码对象")
        if store._conflict_path(relative).is_file():
            raise ApiError("API_MERGE_CONFLICT", "源码存在未解决的同步冲突")
        if path.suffix.lower() not in CODE_SUFFIXES or kind not in {
            "page", "procedure", "system-script",
        }:
            raise ApiError("API_DIRECT_EDIT_UNSUPPORTED", "该源码对象不支持直接编辑")
        if kind == "page" and (
            metadata.get("pageSource") == page_source.BATCH_EXPORT
            or page_source.structured(metadata, relative)
        ):
            raise ApiError("API_DIRECT_EDIT_UNSUPPORTED", "结构化 PAGE 不能直接编辑")
        identity_keys = {
            "page": ("systemId", "pageId"),
            "procedure": ("dataSourceId", "procedureId", "funId"),
            "system-script": ("systemId", "scriptType"),
        }[kind]
        if any(metadata.get(key) in (None, "") for key in identity_keys):
            raise ApiError("API_IDENTITY_MISSING", "源码对象缺少平台身份")
        parts = relative.split("/")
        root, identity = (
            ("datasources", metadata["dataSourceId"])
            if kind == "procedure" else ("systems", metadata["systemId"])
        )
        if len(parts) < 2 or parts[:2] != [root, str(identity)]:
            raise ApiError("API_IDENTITY_MISMATCH", "源码路径与平台身份不一致")
        assert_writable(workspace, [relative])
        documents.assert_no_active_lease(workspace, relative)
        result = {
            "sourceHash": item["sourceHash"],
            "modified": item["sourceHash"] != item["baseHash"],
        }
        if refresh:
            index.update(workspace, [relative])
            with closing(index._connection(workspace)) as conn:
                row = conn.execute(
                    "SELECT source_hash,status,diagnostic FROM gusen_source_record WHERE source_path=?",
                    (relative,),
                ).fetchone()
            if row is None or row["status"] != "OK":
                reason = row["diagnostic"] if row is not None else "API_INDEX_SOURCE_MISSING"
                raise ApiError(reason or "API_INDEX_INVALID", "源码索引不可用")
            if (
                row["source_hash"] != item["sourceHash"]
                or store.read(relative)["sourceHash"] != item["sourceHash"]
            ):
                raise ApiError("API_SOURCE_STALE", "源码或索引在刷新期间发生变化")
            result["indexedHash"] = row["source_hash"]
        return result


def changed_files(workspace) -> dict[str, str]:
    store = ApiStore(workspace)
    try:
        status = store.status(use_cache=True)
    except UnicodeDecodeError as error:
        raise ApiError("API_SOURCE_ENCODING", "API源码必须保留UTF-8编码") from error
    registered = {item["path"] for item in status}
    changes = {
        str(store.root / item["path"]): ":".join(
            (item["state"], item["sourceHash"] or "missing", item["baseHash"])
        )
        for item in status
        if item["state"] == "CONFLICT" or item["sourceHash"] != item["baseHash"]
    }

    def raise_scan_error(error):
        raise error

    for directory, directories, files in os.walk(store.root, followlinks=False, onerror=raise_scan_error):
        directories[:] = [name for name in directories if not (Path(directory) / name).is_symlink()]
        for name in files:
            path = Path(directory) / name
            relative = path.relative_to(store.root).as_posix()
            if relative in registered or path.suffix.lower() not in SOURCE_SUFFIXES:
                continue
            info = path.lstat()
            changes[str(path)] = "UNREGISTERED:" + ":".join(
                str(value) for value in (
                    info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
                )
            )
    return changes

"""Reviewable current-project deltas, independent of the source transport."""

from __future__ import annotations
import json
from pathlib import Path
import uuid
from common.persistence import atomic_text, file_lock
from .client import ApiError
from .editor_state import assert_writable
from .store import ApiStore, digest, merge


IDENTITY = (
    "sourceType",
    "pageId",
    "systemId",
    "procedureId",
    "funId",
    "dataSourceId",
    "tableId",
    "viewId",
    "scriptType",
)


def export_changes(workspace, payload):
    store = ApiStore(workspace)
    output = Path(payload.get("output", "")).expanduser()
    if not output.is_absolute() or output.resolve().is_relative_to(store.root):
        raise ApiError("API_INPUT_INVALID", "请选择checkout之外的绝对导出文件路径")
    if output.exists():
        raise ApiError("API_EXPORT_EXISTS", "导出文件已存在，请选择新文件")
    paths = payload.get("paths")
    if paths is not None and (
        not isinstance(paths, list) or any(not isinstance(x, str) for x in paths)
    ):
        raise ApiError("API_INPUT_INVALID", "paths必须是源码路径数组")
    rows = [
        x
        for x in store.status()
        if x["inScope"]
        and x["state"] in {"MODIFIED", "REMOTE_DELETED"}
        and not x["readonly"]
        and (paths is None or x["path"] in paths)
    ]
    files = []
    for row in rows:
        item = store.read(row["path"])
        files.append(
            {
                "path": item["path"],
                "metadata": {
                    k: item["metadata"][k] for k in IDENTITY if k in item["metadata"]
                },
                "baseContent": store.baseline(item["path"]),
                "localContent": item["content"],
                "baseHash": item["baseHash"],
                "localHash": item["sourceHash"],
            }
        )
    if not files:
        raise ApiError("API_EXPORT_EMPTY", "所选范围没有可导出的本地修改")
    value = {
        "schemaVersion": 1,
        "workspaceKey": workspace["workspaceKey"],
        "files": files,
    }
    atomic_text(output, json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    return {
        "path": str(output),
        "fileCount": len(files),
        "bundleHash": digest(output.read_text(encoding="utf-8")),
        "uploaded": False,
    }


def import_changes(workspace, payload):
    store = ApiStore(workspace)
    bundle_path = Path(payload.get("input", "")).expanduser()
    if (
        not bundle_path.is_absolute()
        or not bundle_path.is_file()
        or bundle_path.stat().st_size > 64 * 1024 * 1024
    ):
        raise ApiError("API_INPUT_INVALID", "请选择有效且不超过64MB的修改包绝对路径")
    raw = bundle_path.read_text(encoding="utf-8")
    bundle = json.loads(raw)
    if (
        not isinstance(bundle, dict)
        or bundle.get("schemaVersion") != 1
        or bundle.get("workspaceKey") != workspace["workspaceKey"]
    ):
        raise ApiError("API_IDENTITY_MISMATCH", "修改包版本或当前项目身份不一致")
    files = bundle.get("files")
    if not isinstance(files, list) or not 1 <= len(files) <= 200:
        raise ApiError("API_INPUT_INVALID", "修改包必须包含1至200个对象")
    paths = []
    changes = []
    conflicts = []
    for change in files:
        if (
            not isinstance(change, dict)
            or not isinstance(change.get("path"), str)
            or any(
                not isinstance(change.get(k), str)
                for k in ("baseContent", "localContent")
            )
            or not isinstance(change.get("metadata"), dict)
        ):
            raise ApiError("API_INPUT_INVALID", "修改包对象格式无效")
        path = change["path"]
        if path in paths:
            raise ApiError("API_IDENTITY_AMBIGUOUS", "修改包含重复对象")
        paths.append(path)
        current = store.read(path)
        if current["metadata"].get("remoteDeleted"):
            raise ApiError(
                "API_REMOTE_DELETED", "导入目标已在平台删除，请明确映射到当前有效对象"
            )
        if current["readonly"] or any(
            str(current["metadata"].get(k, "")) != str(change["metadata"].get(k, ""))
            for k in IDENTITY
        ):
            raise ApiError("API_IDENTITY_MISMATCH", "修改包与当前可写对象身份不一致")
        if change.get("baseHash") != digest(change["baseContent"]) or change.get(
            "localHash"
        ) != digest(change["localContent"]):
            raise ApiError("API_SOURCE_STALE", "修改包正文与摘要不一致")
        candidate = merge(
            change["baseContent"], change["localContent"], current["content"]
        )
        if candidate is None:
            conflicts.append(
                {"path": path, "reason": "共同基线、本地修改与当前源码存在冲突"}
            )
        else:
            changes.append(
                {
                    "path": path,
                    "beforeHash": current["sourceHash"],
                    "candidateHash": digest(candidate),
                    "candidate": candidate,
                }
            )
    plan_hash = digest(
        json.dumps(
            {
                "bundle": digest(raw),
                "changes": [
                    {k: v for k, v in c.items() if k != "candidate"} for c in changes
                ],
                "conflicts": conflicts,
            },
            sort_keys=True,
        )
    )
    preview = {
        "bundleHash": digest(raw),
        "planHash": plan_hash,
        "changes": [{k: v for k, v in c.items() if k != "candidate"} for c in changes],
        "conflicts": conflicts,
        "complete": not conflicts,
        "uploaded": False,
    }
    if payload.get("apply") is not True:
        return preview
    if payload.get("planHash") != plan_hash or conflicts:
        raise ApiError(
            "API_MIGRATION_REVIEW_REQUIRED",
            "请先审阅当前无冲突预览，再按同一planHash导入",
        )
    with file_lock(store.directory / "sync.lock"):
        assert_writable(workspace, paths)
        for change in changes:
            if store.read(change["path"])["sourceHash"] != change["beforeHash"]:
                raise ApiError("API_SOURCE_STALE", "导入发布前源码变化，请重新预览")
        operation = {
            "operationId": uuid.uuid4().hex,
            "kind": "import-changes",
            "stage": "PREPARED",
            "planHash": plan_hash,
            "applied": [],
        }
        store._receipt(operation)
        try:
            for change in changes:
                written = store.write(
                    change["path"], change["candidate"], change["beforeHash"]
                )
                operation["applied"].append(
                    {"path": change["path"], "operationId": written["operationId"]}
                )
                store._receipt(operation)
            operation["stage"] = "LOCAL_WRITE_VERIFIED"
        finally:
            store._receipt(operation)
        from .index import update

        update(workspace, paths)
    return {**preview, **operation}

"""Replace one legacy source registration with an empty API workspace."""
import hashlib
import json
from pathlib import Path

from common import config_store
from common.command_errors import CommandError
from common.runtime_paths import tool_source_root


def _overlap(left, right):
    common_length = min(len(left.parts), len(right.parts))
    return tuple(part.casefold() for part in left.parts[:common_length]) == tuple(
        part.casefold() for part in right.parts[:common_length]
    )


def _plan(home, workspace, document, hub):
    key = workspace["workspaceKey"]
    record = document["workspaces"][key]
    root = workspace["root"]
    checkout = root / "checkout"
    context = root / "context"
    runtime = root / "runtime"
    docs = workspace["docsDir"]
    targets = {checkout, context, runtime, workspace["contextDir"], workspace["runtimeDir"],
               *(workspace[name] for name in ("checkoutPath", "readonlyDir", "workcopyDir", "databaseDir")
                 if workspace.get(name) is not None)}
    legacy_checkout = workspace["spaceRoot"] / "checkout" / workspace["id"]
    protected = (docs, root / "docs", home / "config", home / "docs", home / "GuthonCodeTool", tool_source_root())
    configured_paths = [Path(path).expanduser() for path in record.get("paths", {}).values()]
    configured_root = Path(record["root"]).expanduser() if record.get("root") else root
    old_config = workspace["config"]
    if old_config.get("workspace_root") or (old_config.get("svn") or {}).get("checkout_root"):
        from common.svn_workspace_config import expand_config_value

        for value in (old_config.get("workspace_root"), (old_config.get("svn") or {}).get("checkout_root")):
            if value:
                configured_paths.append(Path(expand_config_value(value, "旧项目路径")).expanduser().absolute())
    if (configured_root.resolve() != configured_root
            or workspace["spaceRoot"].is_relative_to(root)
            or any(_overlap(root, other) for other in protected[2:])
            or any(path.resolve() != path for path in configured_paths)):
        raise CommandError("WORKSPACE_API_RESET_PATH_INVALID", "项目根目录或专用路径不是独立真实目录")
    valid_targets = all(
        target.resolve() == target
        and (root in target.parents or workspace["sourceMode"] == "svn" and target == legacy_checkout)
        and not any(_overlap(target, other) for other in protected)
        and (not target.exists() or target.is_dir())
        for target in targets
    )
    if not valid_targets:
        raise CommandError("WORKSPACE_API_RESET_PATH_INVALID", "有自定义外部路径、非真实目录或文档路径重叠，无法安全清理此项目")
    # A manifest can authorize nested working copies. Reset only the project
    # checkout when the full directory is independent of every other workspace.
    for other in hub.list_workspaces(config_store.resolve_document(home, document)):
        if other["workspaceKey"] == key:
            continue
        paths = [other[name] for name in ("root", "docsDir", "contextDir", "runtimeDir", "providerSourceRoot")]
        if any(_overlap(target, path) for target in targets for path in paths):
            raise CommandError("WORKSPACE_API_RESET_PATH_INVALID", "待清理目录与其他项目重叠")
    paths = sorted(target for target in targets if not any(parent in targets for parent in target.parents))
    payload = [key, record, document["apiWorkspaces"].get(key), str(root), str(docs), list(map(str, paths))]
    plan_id = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return plan_id, paths


def reset_to_api(home, workspace, document, hub, *, check_only, confirmed_plan, required=True):
    """Preview or clear the old local source and publish a fresh API binding."""
    key = workspace["workspaceKey"]
    plan_id, paths = _plan(home, workspace, document, hub)
    if confirmed_plan is not None and confirmed_plan != plan_id:
        raise CommandError("WORKSPACE_API_RESET_STALE", "项目登记或清理路径已变化，请重新预览")
    # Put staging beside each original so the move stays on its own filesystem.
    # The same plan can be retried if a process exits before publishing config.
    moves = [(path, path.with_name(f".{path.name}.guthon-api-{plan_id[:16]}")) for path in paths]
    if not required and confirmed_plan is None and not any(staged.exists() or staged.is_symlink() for _, staged in moves):
        return None
    for path, staged in moves:
        if staged.is_symlink() or (staged.exists() and (not staged.is_dir() or path.exists())):
            raise CommandError("WORKSPACE_API_RESET_PATH_INVALID", f"清理暂存路径已被占用：{staged}")
    if check_only:
        return {"ok": True, "workspaceKey": key, "sourceMode": "api", "requiresReset": True,
                "planId": plan_id, "docsPath": str(workspace["docsDir"]),
                "paths": list(map(str, paths))}
    if confirmed_plan is None:
        raise CommandError("WORKSPACE_MODE_MIGRATION_REQUIRED", "请先确认已将源码改动同步到谷神平台")

    record = document["workspaces"][key]
    identity = {field: workspace[field] for field in ("id", "kind", "layer")}
    identity["displayName"] = workspace["displayName"]
    registration = {"name": workspace["name"], "aliases": workspace["aliases"],
                    "sourceMode": "api", "identity": identity,
                    "paths": {"docsDir": str(workspace["docsDir"])}}
    if "root" not in record and "directory" in record:
        registration["directory"] = record["directory"]
    else:
        registration["root"] = str(workspace["root"])
    document["workspaces"][key] = registration
    document["apiWorkspaces"].pop(key, None)

    moved = []
    try:
        for path, staged in moves:
            if path.exists():
                path.rename(staged)
            if staged.exists():
                moved.append((path, staged))
        hub.resolve_workspace(config_store.resolve_document(home, document), key)
        config_store.write(home, document)
    except BaseException:
        blocked = []
        for path, staged in reversed(moved):
            try:
                if path.exists() or path.is_symlink():
                    raise OSError("原目录已被占用")
                staged.rename(path)
            except OSError:
                blocked.append(str(staged))
        if blocked:
            raise CommandError("WORKSPACE_API_RESET_RESTORE_REQUIRED",
                               "API 登记切换失败，以下暂存目录仍可恢复：" + "、".join(blocked))
        raise
    return {"ok": True, "workspaceKey": key, "sourceMode": "api", "changed": True,
            "trashPaths": [str(staged) for _, staged in moved]}

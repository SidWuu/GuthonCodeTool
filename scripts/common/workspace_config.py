"""Manage project registrations in the unified configuration."""
from __future__ import annotations
import uuid
from pathlib import Path

from common.command_errors import CommandError
from common.persistence import file_lock
from common.workspace_sources import SOURCE_MODES
from common.workspace_identity import validate_workspace_key
from common.workspace_layout import (
    PROJECTS_DIRECTORY, directory_name, registered_project_directory, update_workspace_ignores,
)
from common.runtime_paths import workspace_root


def _canonical_yaml(text):
    """The dependency-free runtime edits only the documented block YAML subset."""
    from common.gusen_hub import _parse_tiny_yaml

    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "\t" in line[: len(line) - len(line.lstrip())]:
            raise SystemExit("PyYAML is required for noncanonical YAML configuration")
        value = line.partition(":")[2].strip()
        if value and value[0] in "&*|>" or value.startswith("{") and value != "{}":
            raise SystemExit(
                "PyYAML is required for flow mappings, anchors or multiline YAML"
            )
    return _parse_tiny_yaml(text)



def create_workspace(home, payload, gusen_hub):
    if not isinstance(payload, dict) or set(payload) - {"id", "name", "directory", "aliases", "sourceMode"}:
        raise SystemExit("workspace-create 只接受 name、sourceMode、directory、aliases 和可选稳定 id")
    if not isinstance(payload.get("name"), str) or not payload["name"].strip():
        raise SystemExit("工作区名称不能为空")
    name = payload["name"].strip()
    directory = directory_name(payload.get("directory", name))
    identifier = validate_workspace_key(payload["id"]) if "id" in payload else "ws_" + uuid.uuid4().hex
    mode = payload.get("sourceMode", "api")
    if not isinstance(mode, str) or mode not in SOURCE_MODES:
        raise ValueError("请选择 API、SVN 或 DATABASE 同步方式")
    aliases = payload.get("aliases", [])
    if not isinstance(aliases, list) or any(not isinstance(x, str) or not x.strip() for x in aliases):
        raise SystemExit("aliases must contain names")
    from common import config_store
    if not config_store.unified(home):
        raise SystemExit('旧配置可只读接入；新增项目需要独立的配置升级流程，本命令不自动转换')
    with file_lock(home / "config/.configuration.lock"):
        config = gusen_hub.load_config()
        if config.get('_configuration', {}).get('format') == 'legacy-yaml':
            raise SystemExit('旧配置可只读接入；新增项目需要独立的配置升级流程，本命令不自动转换')
        existing = gusen_hub.list_workspaces(config, strict=True)
        if identifier in config["workspaces"]:
            raise SystemExit("Duplicate workspace ID")
        if any(x["root"].name.casefold() == directory.casefold() for x in existing):
            raise SystemExit("工作区目录已经注册")
        space = workspace_root(home)
        relative_directory = f"{PROJECTS_DIRECTORY}/{directory}"
        if registered_project_directory(space, relative_directory).exists():
            raise SystemExit("工作区目录已经存在，请使用新的目录名；不会覆盖原有内容")
        document = config_store.read(home)
        record = {"name": name, "directory": relative_directory, "aliases": list(dict.fromkeys(x.strip() for x in aliases))}
        if document["schemaVersion"] == 3:
            record["sourceMode"] = mode
        elif mode != "api":
            raise ValueError("请先升级统一配置，再添加 SVN 或 DATABASE 项目")
        document["workspaces"][identifier] = record
        workspace = gusen_hub.resolve_workspace(config_store.resolve_document(home, document), identifier)
        update_workspace_ignores(space)
        gusen_hub.ensure_workspace_structure(workspace)
        config_store.write(home, document)
    return {"ok": True, "workspace": gusen_hub.workspace_summary(gusen_hub.load_config(), workspace),
            "workspaceKey": identifier}


def _has_source_state(workspace):
    context = workspace["contextDir"]
    # A new API project is registered with Nexus as soon as its card is visible.
    # Empty editor registrations and operation locks do not constitute source history.
    transient = {context / name for name in ("api/editors.json", "api/editors.lock", ".svn-operation.lock")}
    paths = {context, workspace["runtimeDir"], *(entry["path"] for entry in workspace["sourceRoots"])}
    if workspace["sourceMode"] == "database":
        paths.add(workspace["databaseDir"])
    return any(
        root.is_symlink() or root.exists() and not root.is_dir()
        or any(item.is_symlink() or (not item.is_dir() and item not in transient) for item in root.rglob("*"))
        for root in paths
    )


def change_source_mode(home, payload, gusen_hub):
    from common import config_store

    if not isinstance(payload, dict) or set(payload) != {"workspaceKey", "expectedMode", "sourceMode"}:
        raise ValueError("修改同步方式需要明确的项目、原同步方式和目标同步方式")
    key = validate_workspace_key(payload["workspaceKey"])
    expected_mode, mode = payload["expectedMode"], payload["sourceMode"]
    if any(not isinstance(value, str) or value not in SOURCE_MODES for value in (expected_mode, mode)):
        raise ValueError("请选择有效的同步方式")
    with file_lock(home / "config/.configuration.lock"):
        config = gusen_hub.load_config()
        workspace = gusen_hub.resolve_workspace(config, key)
        if workspace["sourceMode"] != expected_mode:
            raise CommandError("WORKSPACE_SOURCE_MODE_STALE", "项目同步方式已变化，请刷新后重新选择")
        if mode == expected_mode:
            return {"ok": True, "changed": False, "workspaceKey": key, "sourceMode": mode}
        if not config_store.unified(home) or config["_configuration"]["schemaVersion"] != 3:
            raise CommandError("WORKSPACE_MODE_UPGRADE_REQUIRED", "请先完成统一配置升级，再修改同步方式")

        document = config_store.read(home)
        record = document["workspaces"][key]
        migrate_error = CommandError(
            "WORKSPACE_MODE_MIGRATION_REQUIRED",
            "项目已有来源配置、源码、索引或操作记录，无法直接修改同步方式",
        )
        if set(record) - {"name", "directory", "aliases", "sourceMode"} or key in document["apiWorkspaces"]:
            raise migrate_error
        if _has_source_state(workspace):
            raise migrate_error

        record["sourceMode"] = mode
        updated = gusen_hub.resolve_workspace(config_store.resolve_document(home, document), key)
        if _has_source_state(updated):
            raise migrate_error

        if expected_mode == "api" and (workspace["contextDir"] / "api/editors.json").is_file():
            from providers.api.editor_state import assert_writable
            assert_writable(workspace, None)

        gusen_hub.ensure_workspace_structure(updated)
        config_store.write(home, document)
        return {"ok": True, "changed": True, "workspaceKey": key, "sourceMode": mode}


def delete_workspace_config(home, payload, gusen_hub):
    if not isinstance(payload, dict):
        raise SystemExit("workspace-delete input must be an object")
    key = validate_workspace_key(payload.get("workspaceKey"))
    from common import config_store
    if not config_store.unified(home):
        raise SystemExit('旧配置当前仅支持公共解析，不自动改写或删除登记')
    with file_lock(home / "config/.configuration.lock"):
        config = gusen_hub.load_config()
        workspace = gusen_hub.resolve_workspace(config, key)
        if workspace['sourceMode'] != 'api':
            raise SystemExit('旧 provider 的登记管理尚未接线，不删除其源码或配置')
        if payload.get("checkOnly", True):
            return {"ok": True, "workspaceKey": key, "displayName": workspace["displayName"],
                    "paths": [str(workspace["root"])], "checkOnly": True}
        if workspace["root"].exists():
            raise SystemExit("请先将已确认的工作区目录移入废纸篓，再删除配置")
        from common import config_store
        def remove(document):
            document["workspaces"].pop(key)
            document["apiWorkspaces"].pop(key, None)
        config_store.mutate(home, remove)
    return {"ok": True, "workspaceKey": key, "removed": True}

"""Bootstrap a Nexus SVN authorization manifest from the workspace checkout script."""

from __future__ import annotations

import json
from pathlib import Path

from providers.svn.checkout import resolve_configured_scope
from providers.svn.scope_import import ImportResult, build_manifest, read_checkout_script, write_manifest


COMMON_CATEGORIES = {"skill", "public"}
SYSTEM_CATEGORIES = {"systems", "pages", "system-script"}
DATA_SOURCE_CATEGORIES = {"datasources", "procedures", "tables", "views"}


def _paths(workspace: dict) -> tuple[Path, Path]:
    settings = workspace.get("svn") or {}
    if settings.get("checkoutLayout") != "manifest-working-copies":
        raise SystemExit("Workspace checkout-script bootstrap requires manifest-working-copies")
    script_path = settings.get("checkoutScriptPath")
    manifest_path = settings.get("scopeManifestPath")
    if not isinstance(script_path, Path):
        raise SystemExit(f"Missing SVN checkout script path for {workspace['workspaceKey']}")
    if not isinstance(manifest_path, Path):
        raise SystemExit(f"Missing SVN scope manifest path for {workspace['workspaceKey']}")
    return script_path, manifest_path


def _existing_manifest(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Invalid existing SVN scope manifest: {path}") from error


def _mapping_error(workspace: dict, scope: dict) -> str:
    details = []
    if scope["missingAliases"]:
        details.append(f"未找到别名：{', '.join(scope['missingAliases'])}")
    if scope["invalidAliases"]:
        details.append(f"映射格式无效：{', '.join(scope['invalidAliases'])}")
    if not scope["systemIds"]:
        details.append("未得到 SYSTEM_ID")
    if not scope["dataSourceIds"]:
        details.append("未得到 DATA_SOURCE_ID")
    return (
        f"无法把 {workspace['workspaceKey']} 的 systems.include.mappings 映射到 SVN 范围"
        f"（{'；'.join(details)}）。"
        "请在 products.yaml 或 projects.yaml 的 systems.include.mappings 中，"
        "为每个别名配置 system_id 和 data_source_id。"
    )


def _filter_to_configured_systems(workspace: dict, result: ImportResult) -> ImportResult:
    aliases = workspace.get("systemAliases") or []
    if not aliases:
        return result
    scope = resolve_configured_scope(workspace)
    if not scope["complete"] or not scope["systemIds"] or not scope["dataSourceIds"]:
        raise SystemExit(_mapping_error(workspace, scope))

    system_ids = set(scope["systemIds"])
    data_source_ids = set(scope["dataSourceIds"])
    entries = result.manifest["entries"]
    available_system_ids = {
        Path(entry["localSubdir"]).name for entry in entries if entry["category"] in SYSTEM_CATEGORIES
    }
    available_data_source_ids = {
        Path(entry["localSubdir"]).name for entry in entries if entry["category"] in DATA_SOURCE_CATEGORIES
    }
    missing_system_ids = sorted(system_ids - available_system_ids)
    missing_data_source_ids = sorted(data_source_ids - available_data_source_ids)
    if missing_system_ids or missing_data_source_ids:
        missing = []
        if missing_system_ids:
            missing.append(f"SYSTEM_ID={','.join(missing_system_ids)}")
        if missing_data_source_ids:
            missing.append(f"DATA_SOURCE_ID={','.join(missing_data_source_ids)}")
        raise SystemExit(
            f"签出脚本无法覆盖 {workspace['workspaceKey']} 已配置子系统的 SVN 范围：{'；'.join(missing)}。"
            "请提供同一谷神产品、同一账号最新下载的 svnCheckoutHere.sh；"
            "若这些 ID 确实没有源码目录，请同时说明缺少的是 pages、system-script、procedures、tables 还是 views。"
        )

    selected_entries = [
        entry
        for entry in entries
        if (
            entry["category"] in COMMON_CATEGORIES
            or (
                entry["category"] in SYSTEM_CATEGORIES
                and Path(entry["localSubdir"]).name in system_ids
            )
            or (
                entry["category"] in DATA_SOURCE_CATEGORIES
                and Path(entry["localSubdir"]).name in data_source_ids
            )
        )
    ]
    manifest = {
        **result.manifest,
        "selection": {
            "systemAliases": list(aliases),
            "systemIds": sorted(system_ids),
            "dataSourceIds": sorted(data_source_ids),
            "mappingHash": scope["mappingHash"],
        },
        "entries": selected_entries,
    }
    return ImportResult(
        manifest=manifest,
        command_count=result.command_count,
        duplicate_count=result.duplicate_count,
    )


def _build_workspace_manifest(workspace: dict, script_path: Path) -> ImportResult:
    parsed = build_manifest(read_checkout_script(script_path), workspace["workspaceKey"])
    return _filter_to_configured_systems(workspace, parsed)


def preview(workspace: dict) -> dict:
    """Return a credential-free script/manifest change summary without writing files."""

    script_path, manifest_path = _paths(workspace)
    if not script_path.is_file():
        raise SystemExit(
            f"Missing SVN checkout script for {workspace['workspaceKey']}: {script_path}"
        )
    result = _build_workspace_manifest(workspace, script_path)
    previous = _existing_manifest(manifest_path)
    old_entries = {
        str(entry.get("id") or ""): entry
        for entry in (previous or {}).get("entries", [])
        if isinstance(entry, dict) and entry.get("id")
    } if isinstance(previous, dict) else {}
    new_entries = {entry["id"]: entry for entry in result.manifest["entries"]}
    old_keys = set(old_entries)
    new_keys = set(new_entries)
    return {
        "ok": True,
        "workspaceKey": workspace["workspaceKey"],
        "scriptPath": str(script_path),
        "batPath": str(script_path),
        "manifestPath": str(manifest_path),
        "commands": result.command_count,
        "entries": len(new_entries),
        "excludedBySystemAliases": result.command_count - result.duplicate_count - len(new_entries),
        "selection": result.manifest.get("selection") or {},
        "duplicatesSkipped": result.duplicate_count,
        "added": len(new_keys - old_keys),
        "removed": len(old_keys - new_keys),
        "modified": sum(old_entries[key] != new_entries[key] for key in old_keys & new_keys),
        "manifestReady": manifest_path.is_file(),
    }


def import_scope(workspace: dict, *, accept_scope_change: bool = False) -> dict:
    """Write the sanitized manifest; script credentials are never persisted."""

    script_path, manifest_path = _paths(workspace)
    if not script_path.is_file():
        raise SystemExit(
            f"Missing SVN checkout script for {workspace['workspaceKey']}: {script_path}"
        )
    result = _build_workspace_manifest(workspace, script_path)
    return write_manifest(manifest_path, result, replace=accept_scope_change)

"""Bootstrap a Nexus SVN authorization manifest from an editable scope config."""

from __future__ import annotations

import json
from pathlib import Path

from providers.svn.checkout import resolve_configured_scope, run_remote_svn
from providers.svn.scope_import import (
    ImportResult,
    build_manifest_from_config,
    build_manifest_from_workspace_config,
    build_manifest_from_workspace_input,
    read_checkout_script,
    merge_scope_config,
    write_manifest,
    write_scope_config,
)


COMMON_CATEGORIES = {"skill", "public"}
SYSTEM_CATEGORIES = {"systems", "pages", "system-script"}
DATA_SOURCE_CATEGORIES = {"datasources", "procedures", "tables", "views"}


def _is_compact_scope_config(settings: dict) -> bool:
    if not settings.get("scopeRootUrl"):
        return False
    values = settings.get("scopeEntries")
    if values is None:
        return True
    if not isinstance(values, list):
        return False
    # A compact scope is a list of category names. Keep accepting the older
    # exact URL objects/strings when a user has both ``url`` and legacy scope.
    return all(
        isinstance(value, str)
        and value.strip().casefold() in {
            "skill",
            "public",
            "system",
            "systems",
            "datasource",
            "datasources",
            "pages",
            "procedures",
            "tables",
            "views",
            "system-script",
            "system_script",
            "systemscript",
        }
        for value in values
    )


def _paths(workspace: dict) -> tuple[Path | None, Path, Path]:
    settings = workspace.get("svn") or {}
    if settings.get("checkoutLayout") != "manifest-working-copies":
        raise SystemExit("Workspace SVN scope bootstrap requires manifest-working-copies")
    script_path = settings.get("checkoutScriptPath")
    manifest_path = settings.get("scopeManifestPath")
    if not isinstance(manifest_path, Path):
        raise SystemExit(f"Missing SVN scope manifest path for {workspace['workspaceKey']}")
    config_path = settings.get("scopeConfigPath")
    if script_path is not None and not isinstance(script_path, Path):
        raise SystemExit(f"Invalid SVN checkout script path for {workspace['workspaceKey']}")
    if config_path is not None and not isinstance(config_path, Path):
        raise SystemExit(f"Invalid SVN scope configuration path for {workspace['workspaceKey']}")
    return script_path, manifest_path, config_path


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
        "为每个别名配置 system_id 和 data_source_id，并在 svn.url/scope 中配置根地址与分类。"
    )


def _filter_to_configured_systems(workspace: dict, result: ImportResult) -> ImportResult:
    aliases = workspace.get("systemAliases") or []
    entries = result.manifest["entries"]
    if not aliases or not any(
        entry["category"] in SYSTEM_CATEGORIES | DATA_SOURCE_CATEGORIES for entry in entries
    ):
        return result
    scope = resolve_configured_scope(workspace)
    if not scope["complete"] or not scope["systemIds"] or not scope["dataSourceIds"]:
        raise SystemExit(_mapping_error(workspace, scope))

    system_ids = set(scope["systemIds"])
    data_source_ids = set(scope["dataSourceIds"])
    available_system_ids = {
        Path(entry["localSubdir"]).name for entry in entries if entry["category"] in SYSTEM_CATEGORIES
    }
    available_data_source_ids = {
        Path(entry["localSubdir"]).name for entry in entries if entry["category"] in DATA_SOURCE_CATEGORIES
    }
    needs_system_ids = any(entry["category"] in SYSTEM_CATEGORIES for entry in entries)
    needs_data_source_ids = any(entry["category"] in DATA_SOURCE_CATEGORIES for entry in entries)
    missing_system_ids = sorted(system_ids - available_system_ids) if needs_system_ids else []
    missing_data_source_ids = sorted(data_source_ids - available_data_source_ids) if needs_data_source_ids else []
    if missing_system_ids or missing_data_source_ids:
        missing = []
        if missing_system_ids:
            missing.append(f"SYSTEM_ID={','.join(missing_system_ids)}")
        if missing_data_source_ids:
            missing.append(f"DATA_SOURCE_ID={','.join(missing_data_source_ids)}")
        raise SystemExit(
            f"SVN 范围配置无法覆盖 {workspace['workspaceKey']} 已配置子系统的 SVN 范围：{'；'.join(missing)}。"
            "请在对应 products.yaml/projects.yaml 的 svn.url/scope 中配置根地址与分类，或提供同一谷神产品、同一账号最新下载的 svnCheckoutHere.sh；"
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


def _build_workspace_manifest(
    workspace: dict,
    script_path: Path | None,
    config_path: Path | None,
) -> tuple[ImportResult, str]:
    settings = workspace.get("svn") or {}
    if _is_compact_scope_config(settings):
        parsed = build_manifest_from_workspace_config(workspace)
        return _filter_to_configured_systems(workspace, parsed), "config"
    scope_entries = (workspace.get("svn") or {}).get("scopeEntries")
    if scope_entries is not None:
        parsed = build_manifest_from_config(
            json.dumps({"entries": scope_entries}, ensure_ascii=False),
            workspace["workspaceKey"],
        )
        return _filter_to_configured_systems(workspace, parsed), "config"
    if config_path and config_path.is_file() and settings.get("scopeConfigExplicit"):
        try:
            parsed = build_manifest_from_config(
                config_path.read_text(encoding="utf-8"),
                workspace["workspaceKey"],
            )
        except (OSError, UnicodeDecodeError) as error:
            raise SystemExit(f"Cannot read SVN scope configuration: {config_path}") from error
        return _filter_to_configured_systems(workspace, parsed), "config"
    if script_path and script_path.is_file():
        parsed = build_manifest_from_workspace_input(
            read_checkout_script(script_path), workspace
        )
        return _filter_to_configured_systems(workspace, parsed), "script"
    config_hint = str(config_path or "products.yaml/projects.yaml")
    raise SystemExit(
        f"Missing SVN scope configuration for {workspace['workspaceKey']}: {config_hint}. "
        "Add svn.url/scope to the existing products.yaml/projects.yaml or provide svnCheckoutHere.sh/.bat once to import it."
    )


def preview(workspace: dict) -> dict:
    """Return a credential-free script/manifest change summary without writing files."""

    script_path, manifest_path, config_path = _paths(workspace)
    result, source = _build_workspace_manifest(workspace, script_path, config_path)
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
        "source": source,
        "configPath": str(config_path),
        "configReady": bool(config_path and config_path.is_file()),
        "scriptPath": str(script_path) if script_path else "",
        "batPath": str(script_path) if script_path else "",
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


def cache_authentication(workspace: dict, password: str) -> dict:
    """Authenticate once and let the native SVN client persist the password."""

    if not isinstance(password, str) or not password:
        raise SystemExit("SVN password must not be empty")
    script_path, _manifest_path, config_path = _paths(workspace)
    result, _source = _build_workspace_manifest(workspace, script_path, config_path)
    entries = result.manifest.get("entries") or []
    if not entries:
        raise SystemExit(f"SVN checkout script has no authorized entries for {workspace['workspaceKey']}")
    run_remote_svn(
        ["info", entries[0]["url"]],
        workspace["svn"],
        password=password,
    )
    return {
        "ok": True,
        "action": "authentication-cached",
        "workspaceKey": workspace["workspaceKey"],
    }


def import_scope(workspace: dict, *, accept_scope_change: bool = False) -> dict:
    """Write the sanitized manifest; script credentials are never persisted."""

    script_path, manifest_path, config_path = _paths(workspace)
    result, source = _build_workspace_manifest(workspace, script_path, config_path)
    summary = write_manifest(manifest_path, result, replace=accept_scope_change)
    if (
        source == "script"
        and config_path
        and config_path.name in {"products.yaml", "projects.yaml"}
        and (workspace.get("svn") or {}).get("scopeManifestConvention", True)
    ):
        # Convert the one-time platform script into the existing workspace YAML
        # without replacing its comments or unrelated manual configuration.
        # The sanitized manifest is written first; a failed config write never
        # causes the authorized scope to be replaced with script credentials.
        raw_result = build_manifest_from_workspace_input(
            read_checkout_script(script_path), workspace
        )
        summary["scopeConfig"] = merge_scope_config(
            config_path,
            workspace["workspaceKey"],
            raw_result,
            workspace,
        )
    elif source == "script" and config_path and not config_path.exists():
        # Compatibility for an explicitly configured standalone scope file.
        summary["scopeConfig"] = write_scope_config(config_path, result)
    summary["source"] = source
    summary["configPath"] = str(config_path)
    return summary

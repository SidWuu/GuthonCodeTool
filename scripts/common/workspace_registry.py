"""Workspace identity, provider routing metadata and synchronization state.

The public gusen_hub facade owns runtime path overrides and shared provider APIs;
this module keeps the workspace lifecycle in one place without copying it into
CLI, Bridge or Nexus.
"""
from __future__ import annotations
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import uuid
from pathlib import Path
from common import gusen_hub as hub

def workspace_steps(workspace):
    return ("source",) if workspace.get("sourceMode") == "svn" else hub.WORKSPACE_STEPS


def _database_capabilities():
    return {
        "database.sourceSync": True,
        "database.schemaExport": True,
        "database.billTypeExport": True,
        "database.systemScriptExport": True,
        "database.viewExport": True,
        "database.diagnose": True,
        "source.reindex": True,
        "workcopy.open": True,
    }


def _svn_capabilities(settings):
    return {f"svn.{name}": bool(value) for name, value in settings["capabilities"].items()}


def workspace_key(value=None):
    key = str(os.environ.get(hub.WORKSPACE_ENV) or "").strip() if value is None else str(value).strip()
    if not key:
        raise SystemExit("Missing --workspace. Use products.<id> or projects.<id>.")
    try:
        hub.validate_workspace_key(key)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    return key


def set_workspace(value):
    os.environ[hub.WORKSPACE_ENV] = hub.workspace_key(value)


def workspace_source_mode_path(workspace_root: Path) -> Path:
    return workspace_root / "context" / hub.SOURCE_MODE_FILE


def read_workspace_source_mode(workspace_root: Path, key: str, item: dict) -> tuple[str, str]:
    """Read the workspace-local provider choice without coupling it to project YAML."""

    path = hub.workspace_source_mode_path(workspace_root)
    if path.is_file():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise SystemExit(f"Invalid source mode file for {key}: {path}: {error}") from error
        if not isinstance(payload, dict) or payload.get("version") != hub.SOURCE_MODE_VERSION:
            raise SystemExit(f"Invalid source mode version for {key}: {path}")
        if payload.get("workspaceKey") != key:
            raise SystemExit(f"source mode workspaceKey mismatch for {key}: {path}")
        mode = str(payload.get("sourceMode") or "").strip().lower()
        if mode not in hub.SOURCE_MODES:
            raise SystemExit(f"sourceMode must be database or svn for {key}: {path}")
        return mode, "workspace-context"

    # Temporary read compatibility for existing installations. Nexus writes the
    # project-local context file and all distributed YAML templates omit this key.
    legacy_mode = str(item.get("source_mode") or "").strip().lower()
    if legacy_mode:
        if legacy_mode not in hub.SOURCE_MODES:
            raise SystemExit(f"source_mode must be database or svn for {key}")
        return legacy_mode, "legacy-config"
    return "database", "default"


def write_workspace_source_mode(workspace: dict, source_mode: str) -> dict:
    mode = str(source_mode or "").strip().lower()
    if mode not in hub.SOURCE_MODES:
        raise SystemExit("source mode must be database or svn")
    path = hub.workspace_source_mode_path(workspace["root"])
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": hub.SOURCE_MODE_VERSION,
        "workspaceKey": workspace["workspaceKey"],
        "sourceMode": mode,
    }
    temp_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temp_path.replace(path)
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass
    return {
        "ok": True,
        "workspaceKey": workspace["workspaceKey"],
        "sourceMode": mode,
        "sourceModeSource": "workspace-context",
        "sourceModePath": str(path),
    }


def change_workspace_source_mode(config: dict, workspace: dict, source_mode: str) -> tuple[dict, dict]:
    """Persist a provider choice and roll it back if the target provider is invalid."""

    path = hub.workspace_source_mode_path(workspace["root"])
    with hub.file_lock(path.with_suffix('.lock')):
        previous = path.read_bytes() if path.is_file() else None
        result = hub.write_workspace_source_mode(workspace, source_mode)
        try:
            updated = hub.resolve_workspace(config, workspace["workspaceKey"])
        except BaseException:
            if previous is None:
                path.unlink(missing_ok=True)
            else:
                temp_path = path.with_name(f".{path.name}.{os.getpid()}.rollback.tmp")
                try:
                    temp_path.write_bytes(previous)
                    temp_path.replace(path)
                finally:
                    temp_path.unlink(missing_ok=True)
            raise
        return result, updated


def resolve_workspace_storage_root(kind: str, config_id: str, item: dict) -> Path:
    """Resolve one product/project's private root from its persisted identity."""

    prefixes = {"products": "PRD", "projects": "PRJ"}
    if kind not in prefixes:
        raise SystemExit(f"Unknown workspace kind: {kind}")
    configured_workspace_root = item.get("workspace_root")
    workspace_root_value = (
        hub.svn_checkout.expand_config_value(configured_workspace_root, f"workspace_root for {kind}.{config_id}")
        if configured_workspace_root not in (None, "")
        else ""
    )
    workspace_root = Path(workspace_root_value or hub.VAR_DIR / "workspace").expanduser().absolute()
    resolved_workspace_root = workspace_root.resolve()
    if resolved_workspace_root in {Path("/").resolve(), Path.home().resolve()}:
        raise SystemExit(f"Unsafe workspace_root for {kind}.{config_id}: {workspace_root}")
    name = str(item.get("name") or "").strip()
    return workspace_root / hub.path_part(f"{prefixes[kind]} {name}")


def _list_workspaces_strict(config):
    workspaces = []
    seen_names = {"products": set(), "projects": set()}
    seen_ids = set()
    for kind, config_key, prefix, layer in (
        ("products", "products", "PRD", "PRODUCT"),
        ("projects", "projects", "PRJ", "PROJECT"),
    ):
        for item_id, item in (config.get(config_key, {}).get(config_key) or {}).items():
            hub.svn_checkout.validate_config_id(item_id)
            if str(item_id) in seen_ids:
                raise SystemExit(f"Duplicate workspace config id across products/projects: {item_id}")
            seen_ids.add(str(item_id))
            name = str(item.get("name") or "").strip()
            if not name:
                raise SystemExit(f"Missing name for {kind}.{item_id}")
            if name in seen_names[kind]:
                raise SystemExit(f"Duplicate {kind} display name: {name}")
            seen_names[kind].add(name)
            key = f"{kind}.{item_id}"
            root = hub.resolve_workspace_storage_root(kind, item_id, item)
            resolved_workspace_root = root.parent.resolve()
            source_mode, source_mode_source = hub.read_workspace_source_mode(root, key, item)
            svn = hub.svn_checkout.svn_settings(
                item_id,
                item,
                hub.VAR_DIR,
                root,
                (config.get("sync", {}).get("svn") or {}),
            ) if source_mode == "svn" else None
            if svn and svn.get("scopeConfigPath") is None:
                svn["scopeConfigPath"] = (
                    hub.CONFIG_DIR / ("products.yaml" if kind == "products" else "projects.yaml")
                ).resolve()
            datasource_name = str(item.get("datasource") or "").strip()
            datasource = (config.get("datasource", {}).get("datasource") or {}).get(datasource_name)
            manifest_layout = bool(svn and svn.get("checkoutLayout") == "manifest-working-copies")
            if datasource_name and not datasource:
                raise SystemExit(f"Unknown datasource for {key}: {datasource_name}")
            datasource = datasource or {}
            resolved_checkout_root = svn["checkoutRoot"].resolve() if svn else None
            if svn and (
                resolved_checkout_root == resolved_workspace_root
                or resolved_checkout_root in resolved_workspace_root.parents
                or resolved_workspace_root in resolved_checkout_root.parents
            ):
                raise SystemExit(f"checkout_root and workspace_root must be separate for {key}")
            capabilities = hub._svn_capabilities(svn) if svn else hub._database_capabilities()
            system_mappings = ((item.get("systems") or {}).get("include") or {}).get("mappings") or {}
            if not isinstance(system_mappings, dict):
                raise SystemExit(f"systems.include.mappings must be a mapping: {key}")
            aliases = [str(alias).strip() for alias in system_mappings if str(alias).strip()]
            if source_mode == "svn" and not aliases and not manifest_layout:
                raise SystemExit(f"SVN workspace requires systems.include.mappings: {key}")
            workspaces.append(
                {
                    "workspaceKey": key,
                    "kind": kind,
                    "type": "product" if kind == "products" else "project",
                    "id": str(item_id),
                    "name": name,
                    "displayName": f"{prefix} {name}",
                    "layer": layer,
                    "scopeId": str(item_id),
                    "projectId": "" if kind == "products" else str(item_id),
                    "datasourceName": datasource_name,
                    "datasource": datasource,
                    "sourceMode": source_mode,
                    "sourceModeSource": source_mode_source,
                    "sourceModePath": hub.workspace_source_mode_path(root),
                    "capabilities": capabilities,
                    "svn": svn,
                    "checkoutPath": svn["checkoutPath"] if svn else None,
                    "providerSourceRoot": svn["checkoutPath"] if svn else root / "source" / "readonly",
                    "systemAliases": aliases,
                    "systemMappings": system_mappings,
                    "systems": item.get("systems") or {},
                    "sourceScope": {
                        "include": item.get("include") or {},
                        "exclude": item.get("exclude") or {},
                        "extraWhere": item.get("extra_where") or {},
                    },
                    "pageOrigins": [str(value).rstrip("/") for value in item.get("page_origins") or [] if str(value).strip()],
                    "config": item,
                    "configDir": hub.CONFIG_DIR,
                    "root": root,
                    "docsDir": root / "docs",
                    "sourceDir": root / "source",
                    "readonlyDir": root / "source" / "readonly",
                    "workcopyDir": root / "source" / "workcopy",
                    "databaseDir": root / "database",
                    "contextDir": root / "context",
                    "indexPath": root / "context" / "index.db",
                    "statePath": root / "context" / "state.json",
                    "logsDir": root / "context" / "logs",
                }
            )
    _validate_workspace_storage_boundaries(workspaces)
    hub._validate_svn_workspace_boundaries(workspaces)
    return workspaces


def list_workspaces(config, *, errors=None, strict=False):
    """Keep unrelated valid workspaces usable; reject ambiguous identities on both sides."""
    if strict:
        return hub._list_workspaces_strict(config)
    diagnostics = errors if errors is not None else []
    candidates = []
    for kind in ("products", "projects"):
        section = config.get(kind, {})
        entries = section.get(kind) if isinstance(section, dict) else None
        if entries is not None and not isinstance(entries, dict):
            diagnostics.append({"workspaceKey": kind, "code": "CONFIG_INVALID", "message": "registry must be a mapping"})
            continue
        for item_id, item in (entries or {}).items():
            key = f"{kind}.{item_id}"
            isolated = {**config, "products": {"products": {}}, "projects": {"projects": {}}}
            isolated[kind] = {kind: {item_id: item}}
            try:
                if not isinstance(item, dict):
                    raise SystemExit("workspace entry must be a mapping")
                candidates.extend(hub._list_workspaces_strict(isolated))
            except (SystemExit, ValueError, TypeError, KeyError, OSError) as error:
                diagnostics.append({"workspaceKey": key, "code": "CONFIG_INVALID", "message": str(error)})
    invalid = set()
    for index, left in enumerate(candidates):
        for right in candidates[index + 1:]:
            problem = ""
            if left["id"] == right["id"]:
                problem = "Duplicate workspace config id across products/projects"
            elif left["kind"] == right["kind"] and left["name"] == right["name"]:
                problem = "Duplicate workspace display name"
            else:
                try:
                    _validate_workspace_storage_boundaries([left,right])
                    hub._validate_svn_workspace_boundaries([left, right])
                except SystemExit as error:
                    problem = str(error)
            if problem:
                for workspace in (left, right):
                    key = workspace["workspaceKey"]
                    if key not in invalid:
                        diagnostics.append({"workspaceKey": key, "code": "CONFIG_AMBIGUOUS", "message": problem})
                        invalid.add(key)
    return [workspace for workspace in candidates if workspace["workspaceKey"] not in invalid]


def _validate_workspace_storage_boundaries(workspaces):
    for index,left in enumerate(workspaces):
        left_root=left['root'].resolve()
        for right in workspaces[index+1:]:
            right_root=right['root'].resolve()
            if left_root==right_root or left_root in right_root.parents or right_root in left_root.parents:
                raise SystemExit('Workspace storage roots overlap: '+left['workspaceKey']+' and '+right['workspaceKey'])


def _validate_svn_workspace_boundaries(workspaces):
    managed_paths = []
    for workspace in workspaces:
        if workspace.get("sourceMode") != "svn":
            continue
        if workspace["svn"].get("checkoutLayout") == "manifest-working-copies":
            from providers.svn.nexus.manifest import load_authorized_scope

            manifest_path = workspace["svn"].get("scopeManifestPath")
            if not manifest_path or not manifest_path.is_file():
                continue
            paths = [(entry.root.resolve(), entry.id) for entry in load_authorized_scope(workspace).entries]
        else:
            paths = [(workspace["checkoutPath"].resolve(), "legacy-sparse")]
        for path, entry_id in paths:
            for other_path, other_workspace_key, other_entry_id in managed_paths:
                if path == other_path or path in other_path.parents or other_path in path.parents:
                    raise SystemExit(
                        "SVN working-copy paths overlap across workspaces: "
                        f"{workspace['workspaceKey']}/{entry_id} and {other_workspace_key}/{other_entry_id}"
                    )
            managed_paths.append((path, workspace["workspaceKey"], entry_id))


def resolve_workspace(config, value=None):
    key = hub.workspace_key(value)
    errors = []
    for workspace in hub.list_workspaces(config, errors=errors):
        if workspace["workspaceKey"] == key:
            return workspace
    invalid = next((item for item in errors if item["workspaceKey"] == key), None)
    if invalid:
        raise SystemExit(f"{invalid['code']}: {key}: {invalid['message']}")
    raise SystemExit(f"Unknown workspace: {key}")


def resolve_workspace_for_path(config: dict, value: str | Path | None = None) -> dict:
    """Resolve exactly one configured workspace containing a cwd or child path."""

    candidate = Path(value or Path.cwd()).expanduser().resolve()
    matches = []
    for workspace in hub.list_workspaces(config):
        root = workspace["root"].expanduser().resolve()
        if candidate == root or root in candidate.parents:
            matches.append((len(root.parts), workspace))
    if not matches:
        raise SystemExit(f"Path is not inside a configured workspace: {candidate}")
    matches.sort(key=lambda item: item[0], reverse=True)
    if len(matches) > 1 and matches[0][0] == matches[1][0]:
        keys = ", ".join(item[1]["workspaceKey"] for item in matches if item[0] == matches[0][0])
        raise SystemExit(f"Path matches multiple configured workspaces: {candidate}: {keys}")
    return matches[0][1]


def workspace_index_state(workspace: dict) -> dict:
    """Return local index readiness without triggering synchronization or remote access."""

    index_path = workspace["indexPath"]
    index_size = index_path.stat().st_size if index_path.is_file() else 0
    index_ready = False
    if index_size:
        try:
            connection = sqlite3.connect(f"{index_path.resolve().as_uri()}?mode=ro", uri=True)
            try:
                columns = {
                    row[1]
                    for row in connection.execute("PRAGMA table_info(gusen_source_record)")
                }
                if {"scope_id", "source_namespace"}.issubset(columns):
                    index_ready = connection.execute(
                        "SELECT 1 FROM gusen_source_record WHERE scope_id=? LIMIT 1",
                        (workspace["scopeId"],),
                    ).fetchone() is not None
                elif {"product_id", "project_id"}.issubset(columns):
                    index_ready = connection.execute(
                        "SELECT 1 FROM gusen_source_record WHERE product_id=? OR project_id=? LIMIT 1",
                        (workspace["scopeId"], workspace["scopeId"]),
                    ).fetchone() is not None
            finally:
                connection.close()
        except sqlite3.Error:
            index_ready = False
    return {
        "path": str(index_path),
        "ready": index_ready,
        "sizeBytes": index_size,
        "requiredAction": "" if index_ready else "init-or-reindex",
    }


def index_first_examples(command: str, workspace_key: str) -> list[dict]:
    """Return copy-ready bounded-query commands for one workspace and source mode."""

    prefix = [command, "--home", str(hub.CONFIG_DIR.parent), "--workspace", workspace_key, "--"]
    return [
        {"intent": intent, "argv": [*prefix, *arguments]}
        for intent, arguments in hub.INDEX_FIRST_EXAMPLE_ARGUMENTS.get(command, ())
    ]


def workspace_agent_context(config: dict, workspace: dict) -> dict:
    """Return the small, machine-readable context an agent needs before source lookup."""

    query_command = "svn" if workspace["sourceMode"] == "svn" else "query"
    return {
        "workspaceKey": workspace["workspaceKey"],
        "root": str(workspace["root"]),
        "sourceMode": workspace["sourceMode"],
        "sourceModeSource": workspace["sourceModeSource"],
        "sourceModePath": str(workspace["sourceModePath"]),
        "index": hub.workspace_index_state(workspace),
        "indexFirst": {
            "command": query_command,
            "unknownObject": "find",
            "knownLocalFact": "facts",
            "tableOrBillWriteReason": "explain",
            "sharedCallChain": "context",
            "callersOfSharedFunction": "callers",
            "examples": hub.index_first_examples(query_command, workspace["workspaceKey"]),
            "note": (
                "索引 ready 时首次源码定位必须执行上述有界查询；仅在索引未初始化、明确漏项或证据不足时"
                "才改用定向文件检索，并在交付说明中写明原因。"
            ),
        },
    }


def _workspace_cockpit(summary: dict) -> dict:
    index_ready = bool(summary["index"]["ready"])
    status_failed = summary.get("status") == "FAILED"
    working_copies = summary.get("workingCopies") or []
    skipped_working_copies = summary.get("skippedWorkingCopies") or []
    dirty_count = sum(not item.get("clean") for item in working_copies)
    messages = []
    if status_failed:
        failure = summary.get("lastFailure") or {}
        message = failure.get("message") if isinstance(failure, dict) else str(failure)
        messages.append(message or "最近一次工作区操作失败")
    if not index_ready:
        messages.append("本地事实索引尚未就绪")
    if summary.get("sourceMode") == "database" and not summary.get("datasourceReady"):
        messages.append("DATABASE 数据源尚未配置")
    if summary.get("status") == "PARTIAL":
        messages.append("工作区资料尚未达到完整一致状态")
    elif summary.get("status") == "UNINITIALIZED" and index_ready:
        messages.append("工作区尚未完成初始化")
    if dirty_count:
        messages.append(f"{dirty_count} 个 SVN working copy 存在本地变更")
    if skipped_working_copies:
        messages.append(f"{len(skipped_working_copies)} 个 SVN scope 无权限或不存在，已跳过")
    return {
        "health": "FAILED" if status_failed else "ACTION_REQUIRED" if messages else "READY",
        "issueCount": len(messages),
        "indexReady": index_ready,
        "workingCopyCount": len(working_copies),
        "skippedWorkingCopyCount": len(skipped_working_copies),
        "dirtyWorkingCopies": dirty_count,
        "messages": messages,
    }


def workspace_config_digest(config, workspace):
    workspace_config = dict(workspace["config"])
    workspace_config.pop("source_mode", None)
    payload = {
        "workspace": workspace_config,
        "sourceMode": workspace["sourceMode"],
        "datasource": workspace["datasource"],
        "rules": config.get("sync", {}).get("rules") or {},
        "sourceTables": config.get("source_tables") or {},
    }
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def legacy_workspace_config_digest(config, workspace):
    """Recognize state written before provider selection moved out of YAML."""

    workspace_config = dict(workspace["config"])
    workspace_config["source_mode"] = workspace["sourceMode"]
    payload = {
        "workspace": workspace_config,
        "datasource": workspace["datasource"],
        "rules": config.get("sync", {}).get("rules") or {},
        "sourceTables": config.get("source_tables") or {},
    }
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def load_workspace_state(config, workspace):
    path = workspace["statePath"]
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        state = {}
    digest = hub.workspace_config_digest(config, workspace)
    digest_matches = state.get("configDigest") in {
        digest,
        hub.legacy_workspace_config_digest(config, workspace),
    }
    steps = state.get("steps") if isinstance(state.get("steps"), dict) else {}
    all_synced = digest_matches and all(
        (steps.get(step) or {}).get("status") == "SUCCESS" for step in hub.workspace_steps(workspace)
    )
    if not state:
        status = "UNINITIALIZED"
    elif all_synced:
        status = "SYNCED"
    elif digest_matches and any((steps.get(step) or {}).get("status") == "PARTIAL" for step in hub.workspace_steps(workspace)):
        status = "PARTIAL"
    elif digest_matches and state.get("lastFailure"):
        status = "FAILED"
    else:
        status = "PARTIAL"
    return {
        "workspaceKey": workspace["workspaceKey"],
        "configDigest": digest,
        "status": status,
        "lastFullSyncAt": state.get("lastFullSyncAt") or "",
        "steps": steps,
        "lastFailure": state.get("lastFailure"),
    }


def update_workspace_state(config, workspace, step=None, status=None, error="", full_sync=False):
    with hub.file_lock(workspace["contextDir"] / ".state.lock"):
        hub.ensure_workspace_structure(workspace)
        state = hub.load_workspace_state(config, workspace)
        state["configDigest"] = hub.workspace_config_digest(config, workspace)
        state.pop("status", None)
        now = hub._now()
        if step:
            state.setdefault("steps", {})[step] = {"status": status, "updatedAt": now}
        if error:
            state["lastFailure"] = {"step": step or "", "message": str(error)[:1000], "time": now}
        elif status == "SUCCESS" and (state.get("lastFailure") or {}).get("step") == step:
            state["lastFailure"] = None
        if full_sync:
            state["lastFullSyncAt"] = now
            state["lastFailure"] = None
        state_path = workspace["statePath"]
        hub.svn_checkout.atomic_json(state_path, state)
        return hub.load_workspace_state(config, workspace)


def _svn_source_control_groups(workspace, working_copies):
    mappings = workspace.get("systemMappings") or {}
    root_copy = next(
        (item for item in working_copies if isinstance(item, dict) and item.get("category") == "root"),
        None,
    )
    if root_copy:
        system_ids = sorted({
            str(mapping.get("system_id") or "").strip()
            for mapping in mappings.values()
            if isinstance(mapping, dict) and str(mapping.get("system_id") or "").strip()
        })
        return [{
            "id": "repository-root",
            "label": workspace.get("name") or workspace.get("workspaceKey") or "SVN 仓库",
            "dataSourceId": "",
            "systemIds": system_ids,
            "systemNames": [],
            "workingCopyIds": [str(root_copy.get("id") or "repository-root")],
            "inferred": False,
        }]

    def checkout_name(local_subdir):
        return hub.group_inference.checkout_name(workspace["checkoutPath"] / local_subdir)

    inferred = None
    effective_mappings = mappings
    if not mappings:
        inferred = hub.group_inference.infer_groups(workspace["checkoutPath"], working_copies)
        effective_mappings = {
            f"inferred.{system_id}": {
                "system_id": system_id,
                "data_source_id": match["dataSourceId"],
                "inference": match,
            }
            for system_id, match in inferred["matches"].items()
        }

    systems_by_data_source = {}
    for mapping in effective_mappings.values():
        if not isinstance(mapping, dict):
            continue
        data_source_id = str(mapping.get("data_source_id") or "").strip()
        system_id = str(mapping.get("system_id") or "").strip()
        if not data_source_id or not system_id:
            continue
        group = systems_by_data_source.setdefault(data_source_id, {"systemIds": [], "systemNames": []})
        if system_id not in group["systemIds"]:
            group["systemIds"].append(system_id)
        system_name = checkout_name(f"systems/{system_id}")
        if system_name and system_name not in group["systemNames"]:
            group["systemNames"].append(system_name)

    copy_ids_by_subdir = {
        str(item.get("localSubdir") or "").strip().replace("\\", "/"): str(item.get("id") or "").strip()
        for item in working_copies
        if isinstance(item, dict) and str(item.get("id") or "").strip()
    }
    assigned = set()
    groups = []
    for data_source_id, system_group in systems_by_data_source.items():
        subdirs = [f"datasources/{data_source_id}"] + [
            f"systems/{system_id}" for system_id in system_group["systemIds"]
        ]
        working_copy_ids = [copy_ids_by_subdir[subdir] for subdir in subdirs if subdir in copy_ids_by_subdir]
        assigned.update(working_copy_ids)
        system_names = system_group["systemNames"]
        datasource_name = checkout_name(f"datasources/{data_source_id}")
        display_name = (
            datasource_name
            if datasource_name
            else system_names[0]
            if len(system_names) == 1
            else " / ".join(system_names)
            if system_names
            else f"{data_source_id} 子系统"
        )
        groups.append({
            "id": f"{'subsystem' if mappings else 'inferred-subsystem'}-flat-{data_source_id}",
            "label": display_name,
            "dataSourceId": data_source_id,
            "systemIds": system_group["systemIds"],
            "systemNames": system_group["systemNames"],
            "workingCopyIds": working_copy_ids,
            "inferred": not bool(mappings),
        })

    remaining = {
        str(item.get("localSubdir") or "").strip().replace("\\", "/"):
            str(item.get("id") or "").strip()
        for item in working_copies
        if isinstance(item, dict)
        and str(item.get("id") or "").strip()
        and str(item.get("id") or "").strip() not in assigned
    }
    if inferred:
        for item in inferred["unmatchedSystems"]:
            system_id = item["systemId"]
            working_copy_id = remaining.pop(f"systems/{system_id}", "")
            if working_copy_id:
                groups.append({
                    "id": f"unmatched-system-flat-{system_id}",
                    "label": item["systemName"] or f"{system_id} 业务系统",
                    "dataSourceId": "",
                    "systemIds": [system_id],
                    "systemNames": [item["systemName"]] if item["systemName"] else [],
                    "workingCopyIds": [working_copy_id],
                    "inferred": True,
                    "unmatched": True,
                })
        for item in inferred["unmatchedDatasources"]:
            data_source_id = item["dataSourceId"]
            working_copy_id = remaining.pop(f"datasources/{data_source_id}", "")
            if working_copy_id:
                groups.append({
                    "id": f"unmatched-datasource-flat-{data_source_id}",
                    "label": item["dataSourceName"] or f"{data_source_id} 数据源",
                    "dataSourceId": data_source_id,
                    "systemIds": [],
                    "systemNames": [],
                    "workingCopyIds": [working_copy_id],
                    "inferred": True,
                    "unmatched": True,
                })
    remaining_ids = [working_copy_id for working_copy_id in remaining.values() if working_copy_id]
    if remaining_ids:
        groups.append({
            "id": "shared-flat",
            "label": "公共源码",
            "dataSourceId": "",
            "systemIds": [],
            "systemNames": [],
            "workingCopyIds": remaining_ids,
        })
    return groups


def workspace_summary(config, workspace):
    state = hub.load_workspace_state(config, workspace)
    summary = {
        "workspaceKey": workspace["workspaceKey"],
        "type": workspace["type"],
        "id": workspace["id"],
        "name": workspace["name"],
        "displayName": workspace["displayName"],
        "root": str(workspace["root"]),
        "sourceMode": workspace["sourceMode"],
        "sourceModeSource": workspace["sourceModeSource"],
        "sourceModePath": str(workspace["sourceModePath"]),
        "providerSourceRoot": str(workspace["providerSourceRoot"]),
        "checkoutPath": str(workspace["checkoutPath"]) if workspace.get("checkoutPath") else "",
        "datasourceName": workspace.get("datasourceName") or "",
        "datasourceReady": bool(workspace.get("datasourceName") and workspace.get("datasource")),
        "capabilities": workspace["capabilities"],
        "status": state["status"],
        "lastFullSyncAt": state["lastFullSyncAt"],
        "steps": state["steps"],
        "lastFailure": state["lastFailure"],
    }
    if workspace.get("sourceMode") == "svn" and workspace["svn"].get("checkoutLayout") == "manifest-working-copies":
        from providers.svn.nexus.workspace import load_state

        checkout_state = load_state(workspace, required=False)
        summary["checkoutLayout"] = "manifest-working-copies"
        manifest_path = workspace["svn"].get("scopeManifestPath")
        checkout_script_path = workspace["svn"].get("checkoutScriptPath")
        scope_config_path = workspace["svn"].get("scopeConfigPath")
        scope_entries = workspace["svn"].get("scopeEntries")
        summary["scopeManifestPath"] = str(manifest_path) if manifest_path else ""
        summary["scopeManifestReady"] = bool(manifest_path and manifest_path.is_file())
        summary["scopeConfigPath"] = str(scope_config_path) if scope_config_path else ""
        summary["scopeConfigReady"] = bool(
            workspace["svn"].get("scopeRootUrl")
            or scope_entries is not None
            or (workspace["svn"].get("scopeConfigExplicit") and scope_config_path and scope_config_path.is_file())
        )
        summary["scopeRootUrl"] = workspace["svn"].get("scopeRootUrl") or ""
        summary["checkoutScriptPath"] = str(checkout_script_path) if checkout_script_path else ""
        summary["checkoutScriptReady"] = bool(checkout_script_path and checkout_script_path.is_file())
        # Compatibility for clients released before checkout scripts became platform-neutral.
        summary["checkoutBatPath"] = summary["checkoutScriptPath"]
        summary["checkoutBatReady"] = summary["checkoutScriptReady"]
        summary["svnLoginRequired"] = True
        summary["svnUsernameSource"] = "sync.yaml"
        summary["svnUsername"] = workspace["svn"].get("username") or ""
        summary["workingCopies"] = [
            {
                "id": item.get("id") or "",
                "root": item.get("root") or "",
                "localSubdir": item.get("localSubdir") or "",
                "category": item.get("category") or "",
                "scopeEntryId": item.get("id") or "",
                "revision": item.get("revision") or "",
                "clean": bool(item.get("clean")),
            }
            for item in checkout_state.get("workingCopies") or []
        ]
        summary["skippedWorkingCopies"] = [
            {
                "id": item.get("id") or "",
                "localSubdir": item.get("localSubdir") or "",
                "category": item.get("category") or "",
                "reason": item.get("reason") or "",
            }
            for item in checkout_state.get("skipped") or []
            if isinstance(item, dict)
        ]
        summary["sourceControlGroups"] = hub._svn_source_control_groups(
            workspace,
            summary["workingCopies"],
        )
        summary["delivery"] = hub._svn_delivery_state(workspace)
    summary["index"] = hub.workspace_index_state(workspace)
    summary["cockpit"] = hub._workspace_cockpit(summary)
    return summary

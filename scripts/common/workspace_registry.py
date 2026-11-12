"""Explicit API-only project identities, checkout roots and runtime summaries."""

from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from common.runtime_paths import RuntimePath

CONFIG_DIR = RuntimePath("config")
VAR_DIR = RuntimePath("var")
from common.persistence import atomic_text
from common.workspace_identity import validate_config_id, validate_workspace_key


def resolve_workspace_storage_root(kind, config_id, item):
    from common import gusen_hub as hub

    configured = item.get("workspace_root")
    if configured and not Path(configured).expanduser().is_absolute():
        raise ValueError("workspace_root must be an explicit absolute directory")
    base = (
        Path(configured).expanduser().resolve()
        if configured
        else (Path(VAR_DIR) / "workspace").resolve()
    )
    if not base.is_absolute() or base in {Path("/"), Path.home()}:
        raise SystemExit("Unsafe workspace_root")
    return base / (
        ("PRD " if kind == "products" else "PRJ ") + hub.path_part(item["name"])
    )


def list_workspaces(config, *, errors=None, strict=False):
    result = []
    diagnostics = errors if errors is not None else []
    seen = set()
    for kind in ("products", "projects"):
        entries = (config.get(kind, {}) or {}).get(kind) or {}
        if not isinstance(entries, dict):
            raise SystemExit(kind + " must be a mapping")
        for identifier, item in entries.items():
            try:
                identifier = validate_config_id(identifier)
                key = validate_workspace_key(kind + "." + identifier)
                if identifier in seen:
                    raise ValueError("Duplicate project config ID")
                seen.add(identifier)
                if (
                    not isinstance(item, dict)
                    or not isinstance(item.get("name"), str)
                    or not item["name"].strip()
                ):
                    raise ValueError("Missing workspace name")
                root = resolve_workspace_storage_root(kind, identifier, item)
                old = root / "context/source-mode.json"
                if (
                    old.is_file()
                    and json.loads(old.read_text(encoding="utf-8")).get("sourceMode")
                    != "api"
                ):
                    raise ValueError(
                        "API_MIGRATION_REQUIRED: 原工作区需显式迁移；不会接管旧同步数据"
                    )
                settings = item.get("api") or {}
                if not isinstance(settings, dict):
                    raise ValueError("api must be an object")
                checkout_root = Path(
                    settings.get("checkout_root") or Path(VAR_DIR) / "checkout"
                ).expanduser()
                if not checkout_root.is_absolute() or checkout_root.resolve() in {
                    Path("/"),
                    Path.home(),
                }:
                    raise ValueError(
                        "api.checkout_root must be a safe absolute directory"
                    )
                checkout = (checkout_root / identifier).resolve()
                if (
                    root == checkout
                    or root in checkout.parents
                    or checkout in root.parents
                ):
                    raise ValueError("checkout and metadata roots overlap")
                aliases = item.get("aliases", [])
                if not isinstance(aliases, list) or any(
                    not isinstance(x, str) or not x.strip() for x in aliases
                ):
                    raise ValueError("aliases must contain names")
                result.append(
                    {
                        "workspaceKey": key,
                        "kind": kind,
                        "type": "product" if kind == "products" else "project",
                        "id": identifier,
                        "name": item["name"],
                        "displayName": ("PRD " if kind == "products" else "PRJ ")
                        + item["name"],
                        "aliases": aliases,
                        "layer": "PRODUCT" if kind == "products" else "PROJECT",
                        "scopeId": key,
                        "projectId": "" if kind == "products" else identifier,
                        "sourceMode": "api",
                        "root": root,
                        "providerSourceRoot": checkout,
                        "checkoutPath": checkout,
                        "contextDir": root / "context",
                        "docsDir": root / "docs",
                        "logsDir": root / "context/logs",
                        "indexPath": root / "context/index.db",
                        "statePath": root / "context/state.json",
                        "sourceModePath": root / "context/source-mode.json",
                        "sourceModeSource": "api-only",
                        "config": item,
                        "configDir": CONFIG_DIR,
                        "datasourceName": item.get("datasource", "")
                        if isinstance(item.get("datasource", ""), str)
                        else "",
                        "datasource": {},
                        "systemMappings": (
                            (item.get("systems") or {}).get("include") or {}
                        ).get("mappings")
                        or {},
                        "pageOrigins": item.get("page_origins") or [],
                        "capabilities": {
                            "api.configure": True,
                            "api.pull": True,
                            "api.status": True,
                            "api.edit": True,
                            "api.upload": True,
                            "source.read": True,
                            "source.index": True,
                            "source.reindex": True,
                            "source.edit": True,
                            "database.diagnose": True,
                        },
                    }
                )
            except (ValueError, TypeError, KeyError, OSError) as error:
                if strict:
                    raise SystemExit(str(error)) from error
                diagnostics.append(
                    {
                        "workspaceKey": str(kind) + "." + str(identifier),
                        "code": "CONFIG_INVALID",
                        "message": str(error),
                    }
                )
    for i, left in enumerate(result):
        for right in result[i + 1 :]:
            for a in (left["root"], left["checkoutPath"]):
                for b in (right["root"], right["checkoutPath"]):
                    if a == b or a in b.parents or b in a.parents:
                        raise SystemExit(
                            "Project data roots overlap: "
                            + left["workspaceKey"]
                            + " / "
                            + right["workspaceKey"]
                        )
    return result


def resolve_workspace(config, value=None):
    from common import gusen_hub as hub

    key = value or hub._CURRENT_WORKSPACE.get() or os.environ.get(hub.WORKSPACE_ENV, "")
    validate_workspace_key(key)
    errors = []
    matches = [
        x for x in list_workspaces(config, errors=errors) if x["workspaceKey"] == key
    ]
    if len(matches) != 1:
        problem = next((x for x in errors if x["workspaceKey"] == key), None)
        raise SystemExit(
            problem["message"] if problem else "Unknown explicit API workspace: " + key
        )
    return matches[0]


def resolve_workspace_for_path(config, path):
    target = Path(path).expanduser().resolve()
    matches = []
    for item in list_workspaces(config):
        if any(
            target == base or base in target.parents
            for base in (item["root"], item["providerSourceRoot"])
        ):
            matches.append(item)
    if len(matches) != 1:
        raise SystemExit("请选择唯一 API workspaceKey 或项目目录")
    return matches[0]


def workspace_index_state(workspace):
    from providers.api.index import health

    path = workspace["indexPath"]
    state = health(workspace)
    return {
        "path": str(path),
        **state,
        "sizeBytes": path.stat().st_size if path.is_file() else 0,
        "requiredAction": ""
        if state.get("ready") and state.get("complete")
        else "api-index",
    }


def workspace_config_digest(config, workspace):
    return hashlib.sha256(
        json.dumps(
            {"key": workspace["workspaceKey"], "config": workspace["config"]},
            sort_keys=True,
            ensure_ascii=False,
        ).encode()
    ).hexdigest()


def load_workspace_state(config, workspace):
    try:
        return json.loads(workspace["statePath"].read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {
            "status": "UNINITIALIZED",
            "steps": {},
            "lastFullSyncAt": None,
            "lastFailure": None,
        }


def update_workspace_state(
    config, workspace, step=None, status=None, error="", full_sync=False
):
    from common import gusen_hub as hub

    value = load_workspace_state(config, workspace)
    if step:
        value.setdefault("steps", {})[step] = {
            "status": status,
            "updatedAt": hub._now(),
        }
    value["status"] = status or value.get("status", "UNINITIALIZED")
    if error:
        value["lastFailure"] = {"step": step, "message": str(error), "at": hub._now()}
    elif status == "SUCCESS":
        value["lastFailure"] = None
    if full_sync and status == "SUCCESS":
        value["lastFullSyncAt"] = hub._now()
    atomic_text(
        workspace["statePath"], json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    )
    return value


def workspace_agent_context(config, workspace):
    return {
        "ok": True,
        "workspaceKey": workspace["workspaceKey"],
        "root": str(workspace["root"]),
        "checkoutPath": str(workspace["checkoutPath"]),
        "sourceMode": "api",
        "sourceModeSource": "api-only",
        "index": workspace_index_state(workspace),
        "indexFirst": {
            "command": "api",
            "unknownObject": "search",
            "knownLocalFact": "context",
            "callersOfSharedFunction": "callers",
            "examples": [
                {
                    "intent": "unknownObject",
                    "argv": [
                        "api",
                        "--home",
                        str(CONFIG_DIR.parent),
                        "--workspace",
                        workspace["workspaceKey"],
                        "--",
                        "search",
                        "--stdin",
                    ],
                }
            ],
        },
    }


def workspace_summary(config, workspace):
    state = load_workspace_state(config, workspace)
    index = workspace_index_state(workspace)
    result = {
        k: workspace[k]
        for k in (
            "workspaceKey",
            "type",
            "id",
            "name",
            "displayName",
            "aliases",
            "sourceMode",
            "capabilities",
            "sourceModeSource",
        )
    }
    result.update(
        root=str(workspace["root"]),
        checkoutPath=str(workspace["checkoutPath"]),
        providerSourceRoot=str(workspace["providerSourceRoot"]),
        datasourceName=workspace["datasourceName"],
        datasourceReady=False,
        index=index,
        status=state.get("status", "UNINITIALIZED"),
        lastFullSyncAt=state.get("lastFullSyncAt"),
        lastFailure=state.get("lastFailure"),
        steps=state.get("steps", {}),
    )
    result["cockpit"] = {
        "health": "READY"
        if index["ready"] and index.get("complete")
        else "ACTION_REQUIRED",
        "indexReady": index["ready"],
        "issueCount": index.get("partialSourceCount", 0) if index["ready"] else 1,
        "messages": (
            ["当前项目索引存在未解析对象"] if index.get("partialSourceCount") else []
        )
        if index["ready"]
        else ["当前项目索引待建立或范围已变化"],
    }
    return result


def workspace_matches_request(workspace, request):
    from providers.api.workspace import settings, active_scope

    requested = request.get("workspaceKey")
    if requested and requested != workspace["workspaceKey"]:
        return False
    origin = request.get("pageOrigin") or request.get("origin")
    config = settings(workspace)
    if origin:
        if not isinstance(origin, str):
            return False
        parsed = urlsplit(config.get("serverUrl") or "")
        if origin.rstrip("/") != (parsed.scheme + "://" + parsed.netloc).rstrip("/"):
            return False
    if not requested and not origin:
        return False
    scope = active_scope(workspace)
    system = request.get("systemId")
    data_source = request.get("dataSourceId")
    if system and str(system) not in scope["systemIds"]:
        return False
    if data_source and str(data_source) not in scope["dataSourceIds"]:
        return False
    return True


def route_workspace_request(config, request):
    matches = [
        x for x in list_workspaces(config) if workspace_matches_request(x, request)
    ]
    if len(matches) != 1:
        return {
            "ok": False,
            "code": "WORKSPACE_AMBIGUOUS" if matches else "WORKSPACE_NOT_FOUND",
            "candidates": [workspace_summary(config, x) for x in matches],
        }
    selected = matches[0]
    return {
        "ok": True,
        "workspaceKey": selected["workspaceKey"],
        "workspace": workspace_summary(config, selected),
        **workspace_summary(config, selected),
    }

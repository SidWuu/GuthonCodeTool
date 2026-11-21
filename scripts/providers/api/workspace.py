"""Explicit project configuration, in-memory login and a subsystem scope contract."""

from __future__ import annotations
from contextlib import contextmanager, nullcontext
import json
from pathlib import Path
from common.persistence import atomic_text, file_lock
from common.runtime_paths import tool_source_root
from .client import ApiClient, ApiError, server_url

_CLIENTS = {}
FIELDS = {
    "serverUrl",
    "systemIds",
    "dataSourceIds",
    "allSystems",
    "includeProjectFiles",
}
SCOPE_FIELDS = {"allSystems", "systemIds", "dataSourceIds"}


def _pending_scope_path(workspace):
    return api_paths(workspace)[0] / "pending-scope.json"


def pending_scope(workspace, current):
    try:
        value = json.loads(_pending_scope_path(workspace).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    return value["settings"] if value["serverUrl"] == current["serverUrl"] else None


def validate_scope_selection(selected, current):
    if not isinstance(selected, dict) or not SCOPE_FIELDS <= selected.keys() or selected.keys() - SCOPE_FIELDS - {"includeProjectFiles"}:
        raise ApiError("API_INPUT_INVALID", "范围同步只接受子系统和数据源设置")
    return validate({"includeProjectFiles": current["includeProjectFiles"], **selected})


def save_scope(workspace, selected):
    with configuration_lock(workspace):
        current = settings(workspace)
        selected = validate_scope_selection(selected, current)
        if not selected["allSystems"] and not selected["systemIds"]:
            raise ApiError("API_INPUT_INVALID", "请至少选择一个子系统")
        if not current["serverUrl"]:
            raise ApiError("API_CONFIG_REQUIRED", "请先配置 API 项目地址")
        atomic_text(_pending_scope_path(workspace), json.dumps({
            "serverUrl": current["serverUrl"],
            "settings": selected,
        }, ensure_ascii=False) + "\n")
        return {"pendingScope": selected}


def clear_pending_scope(workspace):
    _pending_scope_path(workspace).unlink(missing_ok=True)


def api_paths(workspace):
    directory, checkout = (
        workspace["contextDir"] / "api",
        workspace["providerSourceRoot"],
    )
    public = tool_source_root()
    if checkout.resolve().is_relative_to(public) or directory.resolve().is_relative_to(
        public
    ):
        raise ApiError(
            "API_PRIVATE_HOME_REQUIRED", "API配置和源码必须在工具仓库之外的显式toolHome"
        )
    return directory, checkout


def validate(value):
    if (
        type(value.get("allSystems")) is not bool
        or type(value.get("includeProjectFiles", True)) is not bool
    ):
        raise ApiError("API_CONFIG_INVALID", "范围选择必须使用布尔值")
    for key in ("systemIds", "dataSourceIds"):
        ids = value.get(key)
        if not isinstance(ids, list) or any(
            not isinstance(x, str) or not x.strip() for x in ids
        ):
            raise ApiError("API_CONFIG_INVALID", key + "必须是ID字符串数组")
        value[key] = list(dict.fromkeys(x.strip() for x in ids))
    if value["allSystems"] and value["systemIds"]:
        raise ApiError("API_CONFIG_INVALID", "全部和指定子系统不能同时选择")
    value["includeProjectFiles"] = value.get("includeProjectFiles", True)
    return value


def _configuration_home(workspace):
    from common.runtime_paths import tool_home

    config_dir = workspace.get("configDir")
    if config_dir is not None:
        home = Path(config_dir).parent
    else:
        try:
            home = tool_home()
        except SystemExit:
            return None
    return home


def _unified_home(workspace):
    from common import config_store

    home = _configuration_home(workspace)
    return home if home is not None and config_store.unified(home) else None


@contextmanager
def configuration_lock(workspace):
    """Serialize configuration writes with migration, in the same lock order."""
    directory, _ = api_paths(workspace)
    home = _configuration_home(workspace)
    global_lock = file_lock(home / 'config' / '.configuration.lock') if home is not None else nullcontext()
    with global_lock, file_lock(directory / 'configuration.lock'):
        yield


def settings(workspace):
    directory, _ = api_paths(workspace)
    home = _unified_home(workspace)
    if home is not None:
        from common.config_store import api_settings
        value = api_settings(home, workspace["workspaceKey"])
    else:
        try:
            value = json.loads((directory / "config.json").read_text(encoding="utf-8"))
        except FileNotFoundError:
            value = None
    if value is None:
        return {
            "serverUrl": "",
            "systemIds": [],
            "dataSourceIds": [],
            "allSystems": False,
            "includeProjectFiles": True,
        }
    return validate_stored_settings(value, workspace["workspaceKey"])


def validate_stored_settings(value, workspace_key):
    if (
        not isinstance(value, dict)
        or value.get("workspaceKey") != workspace_key
        or "serverUrl" not in value
        or set(value) - FIELDS - {"workspaceKey"}
    ):
        raise ApiError("API_CONFIG_INVALID", "API配置身份或字段无效")
    value = dict(value)
    value["serverUrl"] = server_url(value["serverUrl"])
    return validate(value)


def configure(workspace, payload):
    with configuration_lock(workspace):
        return _configure(workspace, payload)


def _configure(workspace, payload):
    if not isinstance(payload, dict) or set(payload) - FIELDS:
        raise ApiError("API_CONFIG_INVALID", "API配置含未知字段")
    previous = settings(workspace)
    value = validate({**previous, **payload, "workspaceKey": workspace["workspaceKey"]})
    value["serverUrl"] = server_url(value["serverUrl"])
    directory, checkout = api_paths(workspace)
    if (directory / "baseline.db").exists():
        identity_path = directory / "identity.json"
        if not identity_path.is_file():
            raise ApiError(
                "API_PROJECT_IDENTITY_MISSING",
                "已有基线缺少平台身份记录，请使用明确迁移材料重新建立",
            )
        bound = json.loads(identity_path.read_text(encoding="utf-8"))
        if bound != {
            "workspaceKey": workspace["workspaceKey"],
            "serverUrl": value["serverUrl"],
        }:
            raise ApiError(
                "API_PROJECT_REBIND_REQUIRED",
                "当前checkout与基线已绑定平台地址；连接其他平台请建立独立项目或先完成明确迁移",
            )
    context = workspace["contextDir"].resolve()
    if checkout.resolve() == context or checkout.resolve().is_relative_to(context) or context.is_relative_to(checkout.resolve()):
        raise ApiError("API_CONFIG_INVALID", "checkout和context目录必须分开")
    if value != previous:
        home = _unified_home(workspace)
        if home is not None:
            from common.config_store import save_api_settings
            save_api_settings(home, workspace["workspaceKey"], value)
        else:
            atomic_text(
                directory / "config.json",
                json.dumps(value, ensure_ascii=False, indent=2) + "\n",
            )
        if value["serverUrl"] != previous["serverUrl"]:
            clear_pending_scope(workspace)
    if not (directory / "baseline.db").exists():
        atomic_text(
            directory / "identity.json",
            json.dumps(
                {
                    "workspaceKey": workspace["workspaceKey"],
                    "serverUrl": value["serverUrl"],
                },
                ensure_ascii=False,
            )
            + "\n",
        )
    key = (str(directory.resolve()), workspace["workspaceKey"])
    if key in _CLIENTS and _CLIENTS[key].root_url != value["serverUrl"]:
        _CLIENTS.pop(key)
    return value


def client_for(workspace, *, authenticated=False):
    directory, _ = api_paths(workspace)
    value = settings(workspace)
    if not value["serverUrl"]:
        raise ApiError("API_CONFIG_REQUIRED", "请配置API项目地址与子系统范围")
    key = (str(directory.resolve()), workspace["workspaceKey"])
    client = _CLIENTS.get(key)
    if client is None or client.root_url != value["serverUrl"]:
        client = ApiClient(value["serverUrl"])
        _CLIENTS[key] = client
    if authenticated:
        client.ensure_login()
    return client


def logout(workspace):
    directory, _ = api_paths(workspace)
    key = (str(directory.resolve()), workspace["workspaceKey"])
    client = _CLIENTS.pop(key, None)
    if client is not None:
        client.logout()
    path = directory / "last-login.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return
    if value.get("workspaceKey") == workspace["workspaceKey"]:
        path.unlink()


def project_metadata(workspace, *, include_menu=False):
    directory, _ = api_paths(workspace)
    path = directory / "project.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        value = {}
    if not isinstance(value, dict):
        raise ApiError("API_PROJECT_METADATA_INVALID", "项目目录元数据无效")
    if include_menu:
        try:
            value["menuTree"] = json.loads((directory / "menu-tree.json").read_text(encoding="utf-8"))
        except FileNotFoundError:
            pass
    return value


def save_project(workspace, systems=None, data_sources=None, menu_tree=None):
    directory, _ = api_paths(workspace)
    with file_lock(directory / "project.lock"):
        value = project_metadata(workspace)
        if systems is not None:
            value["systems"] = [
                {k: str(row[k]) for k in ("systemId", "systemName", "dataSourceId") if row.get(k) is not None}
                for row in systems
            ]
        if data_sources is not None:
            value["dataSources"] = [
                {k: str(row[k]) for k in ("dataSourceId", "dataSourceName") if row.get(k) is not None}
                for row in data_sources
            ]
        if systems is not None or data_sources is not None:
            atomic_text(directory / "project.json", json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        if menu_tree is not None:
            atomic_text(directory / "menu-tree.json", json.dumps(menu_tree, ensure_ascii=False) + "\n")


def active_scope(workspace):
    config = settings(workspace)
    project = project_metadata(workspace)
    systems = project.get("systems", [])
    selected = (
        {str(x["systemId"]) for x in systems}
        if config["allSystems"]
        else set(config["systemIds"])
    )
    sources = set(config["dataSourceIds"])
    sources.update(
        str(x["dataSourceId"])
        for x in systems
        if str(x["systemId"]) in selected and x.get("dataSourceId") is not None
    )
    return {
        "systemIds": selected,
        "dataSourceIds": sources,
        "allSystems": config["allSystems"],
        "includeProjectFiles": config["includeProjectFiles"],
    }


def in_scope(workspace, path, metadata, *, scope=None):
    scope = active_scope(workspace) if scope is None else scope
    parts = path.split("/")
    if metadata.get("sourceType") == "module-parameter-directory":
        return bool(scope["systemIds"])
    if len(parts) > 1 and parts[0] == "systems":
        return parts[1] in scope["systemIds"]
    if len(parts) > 1 and parts[0] == "datasources":
        return parts[1] in scope["dataSourceIds"]
    return scope["includeProjectFiles"] and metadata.get("sourceType") in {
        "skill",
        "public",
        "config",
    }


def save_session(workspace, session):
    """Remember display metadata only; authentication material stays out of files."""
    import datetime

    directory, _ = api_paths(workspace)
    value = {
        key: session.get(key, "") for key in ("userName", "mainVersion", "dateVersion")
    }
    value.update(
        workspaceKey=workspace["workspaceKey"],
        serverUrl=settings(workspace)["serverUrl"],
        at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
    )
    atomic_text(
        directory / "last-login.json", json.dumps(value, ensure_ascii=False) + "\n"
    )


def last_login(workspace):
    directory, _ = api_paths(workspace)
    try:
        value = json.loads((directory / "last-login.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    if (
        value.get("workspaceKey") != workspace["workspaceKey"]
        or value.get("serverUrl") != settings(workspace)["serverUrl"]
    ):
        return None
    return {
        key: value.get(key, "")
        for key in ("userName", "mainVersion", "dateVersion", "at")
    }

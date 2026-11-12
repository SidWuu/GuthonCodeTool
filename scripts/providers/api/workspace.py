"""Explicit project configuration, saved login and a single subsystem scope contract."""

from __future__ import annotations
import hashlib
import json
from pathlib import Path
from common.persistence import atomic_text
from .client import ApiClient, ApiError, server_url

_CLIENTS = {}
FIELDS = {
    "serverUrl",
    "systemIds",
    "dataSourceIds",
    "allSystems",
    "includeProjectFiles",
}
SERVICE = "GuthonCodeTool.api"


def api_paths(workspace):
    directory, checkout = (
        workspace["contextDir"] / "api",
        workspace["providerSourceRoot"],
    )
    public = Path(__file__).resolve().parents[3]
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


def settings(workspace):
    directory, _ = api_paths(workspace)
    try:
        value = json.loads((directory / "config.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {
            "serverUrl": "",
            "systemIds": [],
            "dataSourceIds": [],
            "allSystems": False,
            "includeProjectFiles": True,
        }
    if (
        not isinstance(value, dict)
        or value.get("workspaceKey") != workspace["workspaceKey"]
        or set(value) - FIELDS - {"workspaceKey"}
    ):
        raise ApiError("API_CONFIG_INVALID", "API配置身份或字段无效")
    value["serverUrl"] = server_url(value["serverUrl"])
    return validate(value)


def configure(workspace, payload):
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
    if checkout.resolve().is_relative_to(workspace["root"].resolve()) or workspace[
        "root"
    ].resolve().is_relative_to(checkout.resolve()):
        raise ApiError("API_CONFIG_INVALID", "checkout和元数据目录必须分开")
    atomic_text(
        directory / "config.json",
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
    )
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
    if authenticated and client.session is None:
        saved = load_login(workspace)
        if saved:
            client.login(saved["userId"], saved["password"])
            save_session(workspace, client.session)
        client.ensure_login()
    return client


def credential_ref(workspace):
    directory, _ = api_paths(workspace)
    return hashlib.sha256(
        (
            str(directory.resolve())
            + "|"
            + workspace["workspaceKey"]
            + "|"
            + settings(workspace)["serverUrl"]
        ).encode()
    ).hexdigest()


def remember_login(workspace, user_id, password, remember):
    if type(remember) is not bool:
        raise ApiError("API_INPUT_INVALID", "remember必须是布尔值")
    try:
        import keyring

        ref = credential_ref(workspace)
        if remember:
            keyring.set_password(
                SERVICE, ref, json.dumps({"userId": user_id, "password": password})
            )
        elif keyring.get_password(SERVICE, ref) is not None:
            keyring.delete_password(SERVICE, ref)
    except ImportError as error:
        if remember:
            raise ApiError(
                "API_CREDENTIAL_STORE_UNAVAILABLE", "记住登录需要系统安全凭据库"
            ) from error


def load_login(workspace):
    try:
        import keyring

        value = keyring.get_password(SERVICE, credential_ref(workspace))
        return json.loads(value) if value else None
    except ImportError:
        return None


def save_project(workspace, systems=None, data_sources=None):
    directory, _ = api_paths(workspace)
    path = directory / "project.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        value = {}
    if systems is not None:
        value["systems"] = [
            {
                k: str(row[k])
                for k in ("systemId", "systemName", "dataSourceId")
                if row.get(k) is not None
            }
            for row in systems
        ]
    if data_sources is not None:
        value["dataSources"] = [
            {
                k: str(row[k])
                for k in ("dataSourceId", "dataSourceName")
                if row.get(k) is not None
            }
            for row in data_sources
        ]
    atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def active_scope(workspace):
    config = settings(workspace)
    directory, _ = api_paths(workspace)
    try:
        project = json.loads((directory / "project.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        project = {}
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


def in_scope(workspace, path, metadata):
    scope = active_scope(workspace)
    parts = path.split("/")
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

"""Read and update connection settings for one registered SVN or DATABASE project."""
from __future__ import annotations

import hashlib
import json
import uuid
from urllib.parse import urlsplit

from common import config_store, database_readonly
from common.command_errors import CommandError
from common.persistence import file_lock
from common.workspace_identity import validate_workspace_key
from common import workspace_source_scope


DATABASE_FIELDS = ("type", "host", "port", "database", "username")
CREDENTIAL_FIELDS = ("password", "passwordEnv", "passwordFile", "credentialRef")


def _text(value, label):
    if not isinstance(value, str) or not value.strip() or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError(f"{label}不能为空或包含控制字符")
    return value.strip()


def _database_endpoint(source):
    result = {name: source.get(name, "") for name in DATABASE_FIELDS}
    engine = str(result["type"] or ("mysql" if source else "")).lower()
    result["type"] = {"mariadb": "mysql", "postgres": "postgresql"}.get(engine, engine)
    if str(result["port"]).isdigit():
        result["port"] = int(result["port"])
    return result


def source_connection_summary(workspace, *, svn_scope_ready=False):
    """Report card readiness and safe connection fields without resolving passwords."""
    if workspace["sourceMode"] == "database":
        datasource = workspace["datasource"]
        connection = _database_endpoint(datasource)
        has_password = any(datasource.get(field) for field in CREDENTIAL_FIELDS)
        return {"connection": connection, "ready": has_password and all(connection.values())}

    svn = workspace["svn"]
    address = svn["repositoryUrl"] if svn["checkoutLayout"] == "legacy-sparse" else svn["scopeRootUrl"]
    existing_copy = svn["checkoutLayout"] == "legacy-sparse" and (workspace["checkoutPath"] / ".svn").is_dir()
    existing_scope = svn_scope_ready or svn.get("scopeEntries") is not None or svn.get("scopeConfigExplicit")
    ready = bool(existing_copy or existing_scope or address and svn["username"] and svn.get("credentialRef"))
    return {"repositoryUrl": address, "username": svn["username"], "ready": ready}


def _summary(document, workspace):
    key, mode = workspace["workspaceKey"], workspace["sourceMode"]
    if mode == "database":
        source = workspace["datasource"]
        connection = _database_endpoint(source)
        result = {"connection": connection, "passwordConfigured": any(source.get(name) for name in CREDENTIAL_FIELDS),
                  "systemAliases": list(workspace["systemMappings"]),
                  "sourceTablesConfigured": all(name in document["sourceTables"] for name in ("page", "procedure"))}
        binding = [connection, workspace["datasourceName"], source.get("credentialRef"), workspace["systemMappings"]]
    elif mode == "svn":
        svn = workspace["svn"]
        repository = svn["repositoryUrl"] if svn["checkoutLayout"] == "legacy-sparse" else svn["scopeRootUrl"]
        configured_scope = bool(svn.get("scopeEntries") or
                                svn.get("scopeConfigExplicit") and svn["scopeConfigPath"].is_file() or
                                svn["scopeManifestPath"] and svn["scopeManifestPath"].is_file())
        result = {"repositoryUrl": repository, "username": svn["username"], "scopeConfigured": configured_scope,
                  "scopePaths": workspace_source_scope.svn_scope_paths(svn)}
        binding = [result, svn.get("scopeDigest"), svn["checkoutLayout"], svn.get("credentialRef")]
    else:
        raise ValueError("请选择 SVN 或 DATABASE 项目")
    revision = hashlib.sha256(json.dumps([key, mode, binding], sort_keys=True).encode()).hexdigest()
    return {"ok": True, "workspaceKey": key, "sourceMode": mode, "revision": revision, **result}


def run(home, key, payload, hub):
    key = validate_workspace_key(key)
    if not isinstance(payload, dict) or payload.get("action") not in {"show", "save", "login", "scope-list", "scope-save"}:
        raise ValueError("需要连接设置或同步范围操作")
    if not config_store.unified(home):
        raise ValueError("请先升级到统一配置，再通过 Nexus 保存源码连接")
    if payload["action"] in {"show", "scope-list"}:
        document = config_store.read(home)
        if document["schemaVersion"] != 3:
            raise ValueError("源码连接向导需要 schema 3")
        workspace = hub.resolve_workspace(config_store.resolve_document(home, document), key)
        result = _summary(document, workspace)
        if payload["action"] == "scope-list":
            result["options"] = workspace_source_scope.options(workspace)
        return result

    with file_lock(home / "config/.configuration.lock"):
        document = config_store.read(home)
        if document["schemaVersion"] != 3:
            raise ValueError("源码连接向导需要 schema 3")
        workspace = hub.resolve_workspace(config_store.resolve_document(home, document), key)
        current = _summary(document, workspace)
        if payload.get("sourceMode") != current["sourceMode"] or payload.get("revision") != current["revision"]:
            raise CommandError("SOURCE_SETTINGS_STALE", "项目连接设置已变化，请刷新后重新配置")
        registration = document["workspaces"][key]
        item = registration.get("legacyConfig", registration)
        if payload["action"] == "scope-save":
            if not workspace_source_scope.save(workspace, item, payload.get("selected"),grouped=payload.get("grouped") is True):
                return current
            resolved = hub.resolve_workspace(config_store.resolve_document(home, document), key)
            if current["sourceMode"] == "svn":
                from providers.svn.nexus.bootstrap import preview

                preview(resolved)
            config_store.write(home, document)
            return _summary(document, resolved)
        settings = payload.get("connection")
        if not isinstance(settings, dict):
            raise ValueError("需要连接设置对象")
        require_login = payload["action"] == "login"
        if require_login and (not isinstance(settings.get("password"), str) or not settings["password"]):
            raise ValueError("请输入登录密码")
        secret_ref = None
        secret_service = database_readonly.CREDENTIAL_SERVICE

        if current["sourceMode"] == "svn":
            if set(settings) - {"username", "repositoryUrl", "password"}:
                raise ValueError("SVN 连接含未知字段")
            username = _text(settings.get("username"), "SVN 用户名")
            repository = settings.get("repositoryUrl")
            if not isinstance(repository, str):
                raise ValueError("SVN 仓库地址必须为字符串")
            if repository or current["repositoryUrl"]:
                repository = _text(repository, "SVN 仓库地址").rstrip("/")
                parsed = urlsplit(repository)
                if (parsed.scheme not in {"http", "https", "svn", "svn+ssh", "file"}
                        or not parsed.path
                        or (parsed.scheme != "file" and not parsed.hostname)
                        or parsed.username or parsed.password or parsed.query or parsed.fragment
                        or any(c.isspace() for c in repository)):
                    raise ValueError("请输入不含账号、密码或查询参数的完整 SVN 仓库 URL")
            elif not current["scopeConfigured"]:
                raise ValueError("请先输入 SVN 仓库地址")
            svn = workspace["svn"]
            values = item.setdefault("svn", {})
            if repository != current["repositoryUrl"] or username != current["username"]:
                values.pop("credential_ref", None)
            if repository != current["repositoryUrl"]:
                if ((svn["scopeManifestPath"] and svn["scopeManifestPath"].is_file())
                        or svn.get("scopeEntries") is not None or svn.get("scopeConfigExplicit")
                        or any((root["path"] / ".svn").is_dir() for root in workspace["sourceRoots"])):
                    raise CommandError("SVN_SOURCE_ALREADY_BOUND", "项目已有 SVN 签出或授权范围，请保留原仓库地址")
                field = "repository_url" if svn["checkoutLayout"] == "legacy-sparse" else "url"
                values[field] = repository
            values["username"] = username
            password = settings.get("password", "")
            if not isinstance(password, str) or any(c in password for c in "\x00\r\n"):
                raise ValueError("SVN 密码不能包含换行或空字符")
            if password:
                from providers.svn.checkout import SVN_CREDENTIAL_SERVICE

                secret_service = SVN_CREDENTIAL_SERVICE
                secret_ref = "source-sync." + uuid.uuid4().hex
                values["credential_ref"] = secret_ref
        else:
            if set(settings) - {*DATABASE_FIELDS, "password"}:
                raise ValueError("DATABASE 主库连接含未知字段")
            connection = {name: _text(settings.get(name), name) for name in DATABASE_FIELDS if name != "port"}
            if connection["type"] not in {"mysql", "postgresql"}:
                raise ValueError("DATABASE 主数据源码连接支持 MySQL 和 PostgreSQL")
            port = settings.get("port")
            if type(port) is not int or not 1 <= port <= 65535:
                raise ValueError("数据库端口须为 1–65535")
            connection["port"] = port
            password = settings.get("password", "")
            if not isinstance(password, str):
                raise ValueError("数据库密码必须为字符串")
            previous = current["connection"]
            same_endpoint = connection == previous
            if not password and not (same_endpoint and current["passwordConfigured"]):
                raise ValueError("请为此数据库连接输入密码")
            if not password:
                return current
            if previous["host"] and any(connection[k] != previous[k] for k in ("type", "host", "port", "database")):
                if workspace["indexPath"].is_file() or any(
                    any(p.is_file() for p in root["path"].rglob("*")) for root in workspace["sourceRoots"]
                ):
                    raise CommandError("DATABASE_SOURCE_ALREADY_BOUND", "项目已有源码、工作副本或索引，请保留原主库地址")
            # A different physical source may not reuse the previous system cache.
            digest = hashlib.sha256(json.dumps(connection, sort_keys=True).encode()).hexdigest()[:16]
            datasource_id = f"{key}.source.{digest}"
            for other_key, other in document["workspaces"].items():
                if other_key != key and isinstance(other, dict):
                    other = other.get("legacyConfig", other)
                    if isinstance(other, dict) and other.get("datasource") == datasource_id:
                        datasource_id += "." + uuid.uuid4().hex[:8]
                        break
            records = document["datasource"]["datasource"]
            existing = records.get(item.get("datasource"), {}) if same_endpoint else {}
            updated = {**connection, **{k: v for k, v in existing.items() if k not in CREDENTIAL_FIELDS}}
            secret_ref = "source-sync." + uuid.uuid4().hex
            updated["credentialRef"] = secret_ref
            records[datasource_id] = updated
            item["datasource"] = datasource_id

        resolved = hub.resolve_workspace(config_store.resolve_document(home, document), key)
        result = _summary(document, resolved)
        if secret_ref:
            if current["sourceMode"] == "svn":
                from providers.svn.nexus.bootstrap import cache_authentication

                cache_authentication(resolved, password)
            elif require_login:
                from common.legacy_source import read_database_systems

                probe = {name: value for name, value in resolved["datasource"].items() if name not in CREDENTIAL_FIELDS}
                probe["password"] = password
                try:
                    systems = read_database_systems({**resolved, "datasource": probe}, first_only=True)
                except (Exception, SystemExit) as error:
                    raise CommandError("DATABASE_SOURCE_LOGIN_FAILED", "无法用此连接读取谷神主库子系统，请核对地址、只读账号和权限") from error
                if not systems:
                    raise CommandError("DATABASE_SOURCE_SCOPE_EMPTY", "此主库没有可读取的谷神子系统")
            database_readonly.set_password(secret_ref, password, service=secret_service)
        try:
            config_store.write(home, document)
        except OSError:
            if secret_ref:
                database_readonly.delete_password(secret_ref, service=secret_service)
            raise
    return result

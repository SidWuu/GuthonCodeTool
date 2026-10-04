"""Built-in, credential-safe, read-only database diagnosis adapter."""

from __future__ import annotations

import datetime as dt
import decimal
import json
import os
import re
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from common import database_test_artifacts as artifacts
from common.database_sql import validate_single_select, table_references


CREDENTIAL_SERVICE = "GuthonCodeTool.Database"
MAX_ROWS = 100
MAX_CELL_CHARS = 2_000


class DatabaseReadonlyError(RuntimeError):
    def __init__(self, code: str, message: str, detail: str = ""):
        super().__init__(message)
        self.code = code
        self.detail = detail


def _redact_secret(text: str, secret: str | None) -> str:
    if secret:
        return text.replace(secret, "***")
    return text


def _keyring():
    try:
        import keyring  # type: ignore
    except ModuleNotFoundError as error:
        raise DatabaseReadonlyError(
            "CREDENTIAL_STORE_UNAVAILABLE",
            "当前 GuthonCodeTool 未包含系统凭据存储支持，请安装完整发行版或 keyring",
        ) from error
    return keyring


def set_password(credential_ref: str, password: str) -> None:
    if not credential_ref or not password:
        raise DatabaseReadonlyError("CREDENTIAL_MISSING", "凭据标识和密码不能为空")
    try:
        _keyring().set_password(CREDENTIAL_SERVICE, credential_ref, password)
    except Exception as error:
        raise DatabaseReadonlyError("CREDENTIAL_STORE_FAILED", "无法写入系统凭据存储", _redact_secret(str(error), password)) from error


def delete_password(credential_ref: str) -> None:
    try:
        keyring = _keyring()
        if keyring.get_password(CREDENTIAL_SERVICE, credential_ref) is not None:
            keyring.delete_password(CREDENTIAL_SERVICE, credential_ref)
    except Exception as error:
        raise DatabaseReadonlyError("CREDENTIAL_STORE_FAILED", "无法删除系统凭据，请重新清理该凭据") from error


def get_password(credential_ref: str) -> str:
    try:
        password = _keyring().get_password(CREDENTIAL_SERVICE, credential_ref)
    except Exception as error:
        raise DatabaseReadonlyError("CREDENTIAL_STORE_FAILED", f"无法读取系统凭据存储: {error}") from error
    if not password:
        raise DatabaseReadonlyError("CREDENTIAL_MISSING", "系统凭据存储中没有该数据库密码，请在 Nexus 重新配置")
    return password


def resolve_password(connection: dict) -> str:
    """Resolve explicit credential sources; only missing credentials fall back."""
    credential_ref = str(connection.get("credentialRef") or "")
    if credential_ref:
        try:
            return get_password(credential_ref)
        except DatabaseReadonlyError as error:
            if error.code not in {"CREDENTIAL_MISSING", "DRIVER_MISSING", "CREDENTIAL_STORE_FAILED"}:
                raise
            if not any(connection.get(key) for key in ("passwordEnv", "passwordFile")):
                raise
    if connection.get("passwordEnv"):
        name = str(connection["passwordEnv"])
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            raise DatabaseReadonlyError("CONFIG_INVALID", "passwordEnv 不是有效环境变量名称")
        password = os.environ.get(name)
        if password:
            return password
    if connection.get("passwordFile"):
        path = Path(str(connection["passwordFile"])).expanduser()
        if not path.is_absolute():
            raise DatabaseReadonlyError("CONFIG_INVALID", "passwordFile 必须使用绝对路径")
        try:
            password = path.read_text(encoding="utf-8").rstrip("\r\n")
        except OSError as error:
            raise DatabaseReadonlyError("CREDENTIAL_MISSING", "无法读取配置的密码文件") from error
        if password:
            return password
    if connection.get("password"):
        return str(connection["password"])
    raise DatabaseReadonlyError("CREDENTIAL_MISSING", "没有可用的数据库密码，请配置凭据引用、环境变量或密码文件")


def build_diagnosis_config(config: dict, workspace_key: str, payload: dict) -> tuple[dict, str]:
    """Build a target/update; return a keyring ID only when a password must be set.

    Existing targets reuse their connection, credential, identity and list position.
    Formal targets require caller-supplied identity evidence and all scope fields.
    This function neither resolves secrets nor probes the database.
    """
    if not isinstance(payload, dict):
        raise DatabaseReadonlyError("CONFIG_INVALID", "数据库配置必须是 JSON 对象")
    allowed = {
        "targetId", "environment", "engine", "host", "port", "database",
        "schema", "username", "password", "passwordEnv", "passwordFile",
        "makeDefault", "connectTimeoutSeconds", "validationScope", "systemId",
        "dataSourceId", "allowedTables", "tenantScope", "evidenceRef",
    }
    unknown = sorted(set(payload) - allowed)
    if unknown:
        raise DatabaseReadonlyError("CONFIG_INVALID", f"数据库配置包含未知字段: {', '.join(unknown)}")
    if "makeDefault" in payload and not isinstance(payload["makeDefault"], bool):
        raise DatabaseReadonlyError("CONFIG_INVALID", "makeDefault 必须是布尔值")
    if "validationScope" in payload and (not isinstance(payload["validationScope"], str) or payload["validationScope"] not in artifacts.VALIDATION_SCOPES):
        raise DatabaseReadonlyError("CONFIG_INVALID", "validationScope 仅允许 diagnosis-only/full")
    if "evidenceRef" in payload and (not isinstance(payload["evidenceRef"], str) or artifacts._is_placeholder(payload["evidenceRef"])):
        raise DatabaseReadonlyError("ENVIRONMENT_UNVERIFIED", "evidenceRef 必须是实际身份核验证据引用")
    target_id = str(payload.get("targetId") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", target_id):
        raise DatabaseReadonlyError("CONFIG_INVALID", "targetId 仅允许字母、数字、点、下划线和连字符")
    if not artifacts.WORKSPACE_KEY.fullmatch(workspace_key):
        raise DatabaseReadonlyError("CONFIG_INVALID", "workspaceKey 无效")
    if config:
        artifacts.validate_config(config)
    value = json.loads(json.dumps(config)) if config else {"schemaVersion": 1}
    connections = value.setdefault("connections", {})
    identities = value.setdefault("expectedIdentities", {})
    workspace = value.setdefault("databaseTests", {}).setdefault(workspace_key, {"targets": []})
    targets = workspace.setdefault("targets", [])
    existing = next((item for item in targets if item.get("id") == target_id), None)
    connection_ref = str((existing or {}).get("connectionRef") or f"{workspace_key}.{target_id}")
    existing_connection = connections.get(connection_ref) or {}
    identity_ref = str((existing or {}).get("expectedIdentityRef") or f"{connection_ref}.identity")
    existing_identity = identities.get(identity_ref) or {}
    merged = {**existing_identity, **existing_connection, **(existing or {}), **payload}
    required = {"environment", "engine", "host", "port", "database", "username"}
    missing = sorted(key for key in required if merged.get(key) in (None, ""))
    if missing:
        raise DatabaseReadonlyError("CONFIG_INVALID", f"数据库配置缺少字段: {', '.join(missing)}")
    engine = str(merged["engine"]).strip().lower()
    engine = {"postgres": "postgresql", "mariadb": "mysql"}.get(engine, engine)
    environment = str(merged["environment"]).strip().lower()
    host = str(merged["host"]).strip()
    database = str(merged["database"]).strip()
    schema = str(merged.get("schema") or "").strip()
    username = str(merged["username"]).strip()
    if engine not in artifacts.ENGINES:
        raise DatabaseReadonlyError("UNSUPPORTED", "仅支持 MySQL/PostgreSQL/Oracle")
    if environment not in artifacts.ENVIRONMENTS:
        raise DatabaseReadonlyError("CONFIG_INVALID", "数据库环境仅允许 dev/test")
    if not host or any(char.isspace() for char in host):
        raise DatabaseReadonlyError("CONFIG_INVALID", "数据库服务器无效")
    if not artifacts.IDENTIFIER.fullmatch(database):
        raise DatabaseReadonlyError("CONFIG_INVALID", "database 必须是普通标识符")
    if schema and not artifacts.IDENTIFIER.fullmatch(schema):
        raise DatabaseReadonlyError("CONFIG_INVALID", "schema 必须是普通标识符")
    if engine == "oracle" and not schema:
        raise DatabaseReadonlyError("CONFIG_INVALID", "Oracle 必须配置业务 schema")
    try:
        if isinstance(merged["port"], bool) or isinstance(merged.get("connectTimeoutSeconds"), bool):
            raise ValueError("boolean is not an integer port/timeout")
        port = int(merged["port"])
        timeout = int(merged.get("connectTimeoutSeconds", 10))
    except (TypeError, ValueError) as error:
        raise DatabaseReadonlyError("CONFIG_INVALID", "数据库端口或连接超时无效") from error
    if not 1 <= port <= 65535 or not 1 <= timeout <= 60:
        raise DatabaseReadonlyError("CONFIG_INVALID", "数据库端口或连接超时超出范围")

    target = dict(existing or {})
    scope = str(payload.get("validationScope") or target.get("validationScope") or ("full" if existing else "diagnosis-only"))
    if scope not in artifacts.VALIDATION_SCOPES:
        raise DatabaseReadonlyError("CONFIG_INVALID", "validationScope 仅允许 diagnosis-only/full")
    was_full = existing is not None and str(existing.get("validationScope") or "full") == "full"
    if scope == "full" and not was_full and not payload.get("evidenceRef"):
        raise DatabaseReadonlyError("ENVIRONMENT_UNVERIFIED", "新建或升级 full 目标必须提供真实身份 evidenceRef")
    evidence_ref = str(payload.get("evidenceRef") or existing_identity.get("evidenceRef") or f"nexus-config:{connection_ref}")
    identity = {"engine": engine, "endpoint": f"{host}:{port}", "database": database, "evidenceRef": evidence_ref}
    if schema:
        identity["schema"] = schema
    if scope == "full" and was_full and not payload.get("evidenceRef"):
        changed_identity = any(str(existing_identity.get(field) or "").lower() != str(identity.get(field) or "").lower() for field in ("engine", "endpoint", "database", "schema"))
        if changed_identity:
            raise DatabaseReadonlyError("ENVIRONMENT_UNVERIFIED", "修改 full 目标连接身份必须提供新的 evidenceRef")
    connection = {"engine": engine, "host": host, "port": port, "database": database, "username": username, "connectTimeoutSeconds": timeout}
    for field in ("credentialRef", "passwordEnv", "passwordFile"):
        if existing_connection.get(field):
            connection[field] = existing_connection[field]
    password_supplied = "password" in payload
    if password_supplied and (not isinstance(payload["password"], str) or not payload["password"]):
        raise DatabaseReadonlyError("CONFIG_INVALID", "password 必须是非空字符串")
    explicit_external_source = any(field in payload for field in ("passwordEnv", "passwordFile"))
    for field in ("passwordEnv", "passwordFile"):
        if field in payload:
            if not isinstance(payload[field], str) or not payload[field].strip():
                raise DatabaseReadonlyError("CONFIG_INVALID", f"{field} 必须是非空字符串")
            connection[field] = payload[field].strip()
    credential_ref = ""
    if password_supplied:
        credential_ref = str(existing_connection.get("credentialRef") or connection_ref)
        connection["credentialRef"] = credential_ref
    elif explicit_external_source:
        connection.pop("credentialRef", None)
    if not any(connection.get(field) for field in ("credentialRef", "passwordEnv", "passwordFile")):
        raise DatabaseReadonlyError("CREDENTIAL_MISSING", "必须提供 password/passwordEnv/passwordFile，或复用现有凭据来源")
    target.update({"id": target_id, "connectionRef": connection_ref, "database": database, "environment": environment, "access": "read-only", "expectedIdentityRef": identity_ref})
    if existing is None or "validationScope" in payload:
        target["validationScope"] = scope
    for field in ("systemId", "dataSourceId", "allowedTables", "tenantScope"):
        if field in payload:
            target[field] = payload[field]
    if schema:
        connection["schema"] = schema
        identity["schema"] = schema
        target["schema"] = schema
    else:
        target.pop("schema", None)
    connections[connection_ref] = connection
    identities[identity_ref] = identity
    if existing is None:
        targets.append(target)
    else:
        targets[targets.index(existing)] = target
    defaults = workspace.setdefault("defaults", {})
    by_environment = defaults.setdefault("byEnvironment", {})
    for name in list(by_environment):
        if by_environment[name] == target_id and name != environment:
            del by_environment[name]
    make_default = payload.get("makeDefault", existing is None)
    if make_default:
        by_environment[environment] = target_id
        defaults["diagnosisTargetId"] = target_id
    artifacts.validate_config(value)
    return value, credential_ref


def connection_for_target(config: dict, target: dict) -> dict:
    connection_ref = str(target.get("connectionRef") or "")
    if not connection_ref:
        raise DatabaseReadonlyError(
            "CONNECTOR_UNAVAILABLE",
            "该目标仅配置了 DBX connectionId；请使用 DBX 或在 Nexus 配置内置只读连接",
        )
    connection = dict((config.get("connections") or {}).get(connection_ref) or {})
    if not connection:
        raise DatabaseReadonlyError("CONNECTION_MISSING", f"内置连接不存在: {connection_ref}")
    connection["password"] = resolve_password(connection)
    return connection


def connect(connection: dict):
    engine = connection["engine"]
    common = {
        "host": connection["host"],
        "port": int(connection["port"]),
        "user": connection["username"],
        "password": connection["password"],
    }
    timeout = int(connection.get("connectTimeoutSeconds", 10))
    if engine == "mysql":
        try:
            import pymysql  # type: ignore
        except ModuleNotFoundError as error:
            raise DatabaseReadonlyError("DRIVER_MISSING", "缺少 MySQL 驱动 pymysql") from error
        try:
            return pymysql.connect(
                **common,
                database=connection["database"],
                charset="utf8mb4",
                cursorclass=pymysql.cursors.DictCursor,
                connect_timeout=timeout,
                read_timeout=30,
                write_timeout=30,
                autocommit=False,
            )
        except Exception as error:
            raise DatabaseReadonlyError(
                "CONNECTION_FAILED",
                "MySQL 连接失败，请检查地址、只读账号、密码和网络",
                _redact_secret(str(error), connection.get("password")),
            ) from error
    if engine == "postgresql":
        try:
            import psycopg  # type: ignore
            from psycopg.rows import dict_row  # type: ignore
        except ModuleNotFoundError as error:
            raise DatabaseReadonlyError("DRIVER_MISSING", "缺少 PostgreSQL 驱动 psycopg") from error
        try:
            return psycopg.connect(
                **common,
                dbname=connection["database"],
                connect_timeout=timeout,
                row_factory=dict_row,
                autocommit=False,
            )
        except Exception as error:
            raise DatabaseReadonlyError(
                "CONNECTION_FAILED",
                "PostgreSQL 连接失败，请检查地址、只读账号、密码和网络",
                _redact_secret(str(error), connection.get("password")),
            ) from error
    if engine == "oracle":
        try:
            import oracledb  # type: ignore
        except ModuleNotFoundError as error:
            raise DatabaseReadonlyError("DRIVER_MISSING", "缺少 Oracle 驱动 oracledb") from error
        try:
            db = oracledb.connect(
                **common,
                service_name=connection["database"],
                tcp_connect_timeout=timeout,
            )
            db.call_timeout = 30_000
            return db
        except Exception as error:
            raise DatabaseReadonlyError(
                "CONNECTION_FAILED",
                "Oracle 连接失败，请检查地址、服务名、只读账号、密码和网络",
                _redact_secret(str(error), connection.get("password")),
            ) from error
    raise DatabaseReadonlyError("UNSUPPORTED", f"不支持的数据库引擎: {engine}")


def _set_read_only(cursor, connection: dict) -> None:
    engine = connection["engine"]
    if engine == "mysql":
        cursor.execute("SET TRANSACTION READ ONLY")
    elif engine == "postgresql":
        cursor.execute("SET TRANSACTION READ ONLY")
        cursor.execute("SET LOCAL statement_timeout = '30s'")
        schema = str(connection.get("schema") or "public")
        if not artifacts.IDENTIFIER.fullmatch(schema):
            raise DatabaseReadonlyError("CONFIG_INVALID", "schema 必须是普通标识符")
        cursor.execute(f"SET LOCAL search_path TO {schema}")
    else:
        cursor.execute("SET TRANSACTION READ ONLY")


def _result_columns(cursor):
    columns = [column.name if hasattr(column, "name") else column[0] for column in (cursor.description or [])]
    if any(not isinstance(name, str) or not name for name in columns) or len(set(columns)) != len(columns):
        raise DatabaseReadonlyError('RESULT_UNSUPPORTED', '结果列名为空或重复；请为同名列指定不同 SQL 别名，避免字典覆盖')
    return columns


def _execute_dicts(cursor, sql: str, params: tuple = ()) -> tuple[list[str], list[dict]]:
    cursor.execute(sql, params)
    columns = _result_columns(cursor)
    raw_rows = cursor.fetchall()
    rows = []
    for raw in raw_rows:
        if isinstance(raw, dict):
            rows.append({str(key): value for key, value in raw.items()})
        else:
            rows.append(dict(zip(columns, raw)))
    return columns, rows


def _json_value(value: Any) -> tuple[Any, bool]:
    if value is None or isinstance(value, (bool, int, float)):
        return value, False
    if isinstance(value, decimal.Decimal):
        return str(value), False
    if isinstance(value, (dt.date, dt.datetime, dt.time)):
        return value.isoformat(), False
    if isinstance(value, bytes):
        text = value.hex()
    else:
        text = str(value)
    return text[:MAX_CELL_CHARS], len(text) > MAX_CELL_CHARS


def _normalize_rows(rows: list[dict], limit: int) -> tuple[list[dict], str]:
    row_truncated = len(rows) > limit
    cell_truncated = False
    normalized = []
    for row in rows[:limit]:
        converted = {}
        for key, value in row.items():
            converted[key], truncated = _json_value(value)
            cell_truncated = cell_truncated or truncated
        normalized.append(converted)
    truncation = "rows" if row_truncated else "cell" if cell_truncated else "none"
    return normalized, truncation


def _truncation_details(rows: list[dict], limit: int) -> dict:
    return {
        "rows": len(rows) > limit,
        "cells": [
            {"row": index + 1, "column": str(key), "maxChars": MAX_CELL_CHARS}
            for index, row in enumerate(rows[:limit])
            for key, value in row.items() if _json_value(value)[1]
        ],
    }


def _metadata_table_names(cursor, connection: dict, references: list[str]) -> set[str]:
    engine = connection["engine"]
    schema = str(connection.get("schema") or connection["database"])
    names = sorted({reference.split(".")[-1].upper() for reference in references})
    if not names:
        return set()
    placeholders = ", ".join(["%s"] * len(names))
    if engine == "mysql":
        sql = f"SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=%s AND UPPER(TABLE_NAME) IN ({placeholders})"
        params = (connection["database"], *names)
    elif engine == "postgresql":
        sql = f"SELECT table_name FROM information_schema.tables WHERE table_schema=%s AND UPPER(table_name) IN ({placeholders})"
        params = (connection.get("schema") or "public", *names)
    else:
        placeholders = ", ".join([f":{index + 2}" for index in range(len(names))])
        sql = (
            f"SELECT TABLE_NAME FROM ALL_TABLES WHERE OWNER=:1 AND UPPER(TABLE_NAME) IN ({placeholders}) "
            f"UNION SELECT VIEW_NAME FROM ALL_VIEWS WHERE OWNER=:1 AND UPPER(VIEW_NAME) IN ({placeholders})"
        )
        params = (schema.upper(), *names)
    _, rows = _execute_dicts(cursor, sql, tuple(params))
    return {str(next(iter(row.values()))).upper() for row in rows}


def verify_query_scope(cursor, connection: dict, target: dict, sql: str) -> str:
    try:
        candidate = validate_single_select(sql, connection["engine"])
        references = table_references(candidate)
    except ValueError as error:
        raise DatabaseReadonlyError("QUERY_UNSUPPORTED", str(error)) from error
    if not references:
        raise DatabaseReadonlyError("QUERY_UNSUPPORTED", "无法识别查询中的数据表")
    expected = str(target.get("schema") or target["database"]).lower()
    for reference in references:
        parts = reference.split(".")
        if connection["engine"] == "oracle":
            if len(parts) != 2:
                raise DatabaseReadonlyError("QUERY_UNSUPPORTED", "Oracle 查询必须使用业务 schema 限定表名")
            if parts[0].lower() != expected:
                raise DatabaseReadonlyError("CROSS_DATABASE_DENIED", f"引用了未授权 schema: {parts[0]}")
        elif len(parts) == 3:
            raise DatabaseReadonlyError("CROSS_DATABASE_DENIED", "不支持三段数据库限定表名")
        elif len(parts) > 3:
            raise DatabaseReadonlyError("CROSS_DATABASE_DENIED", "不支持多段数据库限定表名")
        elif len(parts) == 2 and parts[0].lower() != expected:
            raise DatabaseReadonlyError("CROSS_DATABASE_DENIED", f"引用了未授权数据库或 schema: {parts[0]}")
    allowed = {str(name).upper() for name in target.get("allowedTables") or []}
    required = {reference.split(".")[-1].upper() for reference in references}
    missing = required - allowed
    if missing:
        existing = _metadata_table_names(cursor, connection, references)
        if not missing <= existing:
            denied = ", ".join(sorted(missing - existing))
            raise DatabaseReadonlyError("TABLE_DENIED", f"目标 schema 中不存在或不可见的表: {denied}")
    return candidate


def _database_name_matches(engine: str, actual: str, expected: str) -> bool:
    if engine == "oracle":
        # Oracle 的 SERVICE_NAME 可能带域名后缀（pdb.example.com），按 service name 前缀匹配
        return actual.lower().split(".")[0] == expected.lower().split(".")[0]
    return actual.lower() == expected.lower()


def _probe_cursor(cursor, connection: dict, target: dict) -> dict:
    if connection["engine"] == "mysql":
        columns, rows = _execute_dicts(cursor, "SELECT DATABASE() AS database_name, VERSION() AS server_version")
    elif connection["engine"] == "postgresql":
        columns, rows = _execute_dicts(cursor, "SELECT CURRENT_DATABASE() AS database_name, CURRENT_SCHEMA() AS schema_name, version() AS server_version")
    else:
        columns, rows = _execute_dicts(cursor, "SELECT SYS_CONTEXT('USERENV', 'SERVICE_NAME') AS database_name, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS schema_name FROM DUAL")
    actual = rows[0] if rows else {}
    actual_database = str(actual.get("database_name") or actual.get("DATABASE_NAME") or "")
    if not actual_database:
        raise DatabaseReadonlyError("ENVIRONMENT_UNVERIFIED", "连接未返回 database 身份，不能继续查询")
    if not _database_name_matches(connection["engine"], actual_database, str(target["database"])):
        raise DatabaseReadonlyError("ENVIRONMENT_MISMATCH", "连接返回的 database 与目标配置不一致")
    actual_schema = str(actual.get("schema_name") or actual.get("SCHEMA_NAME") or "")
    business_schema = str(target.get("schema") or connection.get("schema") or "")
    schema_evidence = None
    if connection["engine"] == "postgresql" and actual_schema.lower() != (business_schema or "public").lower():
        raise DatabaseReadonlyError("ENVIRONMENT_MISMATCH", "连接当前 schema 与目标配置不一致")
    if connection["engine"] == "oracle":
        if not artifacts.IDENTIFIER.fullmatch(business_schema):
            raise DatabaseReadonlyError("CONFIG_INVALID", "Oracle 目标必须明确业务 schema")
        _, schema_rows = _execute_dicts(cursor,
            "SELECT (SELECT COUNT(*) FROM ALL_USERS WHERE USERNAME=:1) AS schema_exists, "
            "(SELECT COUNT(*) FROM ALL_TABLES WHERE OWNER=:2) AS visible_tables FROM DUAL",
            (business_schema.upper(), business_schema.upper()))
        schema_evidence = {str(key).lower(): value for key, value in (schema_rows[0] if schema_rows else {}).items()}
        if schema_evidence.get("schema_exists") != 1 or not schema_evidence.get("visible_tables"):
            raise DatabaseReadonlyError("ENVIRONMENT_UNVERIFIED", "Oracle 业务 schema 不存在或没有可见业务表")
    return {
        "ok": True,
        "columns": columns,
        "identity": _normalize_rows(rows, 1)[0][0] if rows else {},
        "database": actual_database,
        "schema": business_schema if connection["engine"] == "oracle" else actual_schema,
        **({"loginSchema": actual_schema, "schemaEvidence": schema_evidence} if schema_evidence is not None else {}),
        "serverVersion": str(actual.get("server_version") or actual.get("SERVER_VERSION") or ""),
        "readOnly": True,
    }


def probe(connection: dict, target: dict) -> dict:
    with readonly_session(connection) as cursor:
        return _probe_cursor(cursor, connection, target)


def _describe_cursor(cursor, connection: dict, target: dict, table: str) -> dict:
    if not artifacts.IDENTIFIER.fullmatch(table):
        raise DatabaseReadonlyError("CONFIG_INVALID", "表名必须是普通标识符")
    schema = str(connection.get("schema") or connection["database"])
    if connection["engine"] == "oracle":
        sql = "SELECT COLUMN_NAME, DATA_TYPE, NULLABLE FROM ALL_TAB_COLUMNS WHERE OWNER=:1 AND TABLE_NAME=:2 ORDER BY COLUMN_ID"
        params = (schema.upper(), table.upper())
    else:
        sql = "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema=%s AND table_name=%s ORDER BY ordinal_position"
        params = ((connection.get("schema") or ("public" if connection["engine"] == "postgresql" else connection["database"])), table.lower() if connection["engine"] == "postgresql" else table)
    columns, rows = _execute_dicts(cursor, sql, params)
    normalized, truncation = _normalize_rows(rows, MAX_ROWS)
    return {"ok": True, "table": table, "columns": columns, "rows": normalized, "truncation": truncation}


def describe(connection: dict, target: dict, table: str) -> dict:
    with readonly_session(connection) as cursor:
        return _describe_cursor(cursor, connection, target, table)


def _query_cursor(cursor, connection: dict, target: dict, sql: str, max_rows: int = MAX_ROWS) -> dict:
    limit = max(1, min(int(max_rows), MAX_ROWS))
    candidate = verify_query_scope(cursor, connection, target, sql)
    cursor.execute(candidate)
    columns = _result_columns(cursor)
    raw_rows = cursor.fetchmany(limit + 1)
    rows = [raw if isinstance(raw, dict) else dict(zip(columns, raw)) for raw in raw_rows]
    normalized, truncation = _normalize_rows(rows, limit)
    return {"ok": True, "columns": columns, "rows": normalized, "truncation": truncation, "truncationDetails": _truncation_details(rows, limit), "maxRows": limit}


def _explain_cursor(cursor, connection, target, sql, max_rows=MAX_ROWS):
    if connection['engine'] == 'oracle':
        raise DatabaseReadonlyError('EXPLAIN_UNSUPPORTED', 'Oracle EXPLAIN 会写计划表，不能通过只读排查入口执行；请使用已有执行计划证据')
    candidate = verify_query_scope(cursor, connection, target, sql)
    prefix = 'EXPLAIN FORMAT=JSON ' if connection['engine'] == 'mysql' else 'EXPLAIN (FORMAT JSON) '
    cursor.execute(prefix + candidate)
    columns = _result_columns(cursor)
    limit = max(1, min(int(max_rows), MAX_ROWS))
    raw = cursor.fetchmany(limit + 1)
    rows = [value if isinstance(value, dict) else dict(zip(columns, value)) for value in raw]
    normalized, truncation = _normalize_rows(rows, limit)
    return {'ok':True, 'columns':columns, 'rows':normalized, 'truncation':truncation,
            'truncationDetails':_truncation_details(rows,limit), 'maxRows':limit,
            'kind':'execution-plan', 'queryExecuted':False, 'analyze':False,
            'evidenceBoundary':'优化器估计计划，不是业务查询结果或实际执行成本'}


def query(connection: dict, target: dict, sql: str, max_rows: int = MAX_ROWS, *, explain=False) -> dict:
    with readonly_session(connection) as cursor:
        if explain:
            _probe_cursor(cursor, connection, target)
            return _explain_cursor(cursor,connection,target,sql,max_rows)
        return _query_cursor(cursor, connection, target, sql, max_rows)

@contextmanager
def readonly_session(connection: dict):
    db = connect(connection)
    try:
        cursor = db.cursor()
        try:
            _set_read_only(cursor, connection)
            yield cursor
        finally:
            if callable(getattr(cursor, "close", None)):
                cursor.close()
    except DatabaseReadonlyError:
        raise
    except Exception as error:
        raise DatabaseReadonlyError("DATABASE_QUERY_FAILED", "数据库只读操作失败", _redact_secret(str(error), connection.get("password"))) from error
    finally:
        try:
            db.rollback()
        finally:
            db.close()


def diagnose(connection: dict, target: dict, *, table: str = "", sql: str = "", max_rows: int = MAX_ROWS, explain=False) -> dict:
    """Probe identity and inspect/query in one read-only connection/transaction."""
    stage = "connect"
    try:
        with readonly_session(connection) as cursor:
            stage = "identity"
            identity = _probe_cursor(cursor, connection, target)
            result = {"ok": True, "identityCheck": identity, "connectionEvidence": {"engine": connection["engine"], "endpoint": f"{connection['host']}:{connection['port']}", "readOnly": True}}
            if table:
                stage = "describe"
                result["description"] = _describe_cursor(cursor, connection, target, table)
            if sql:
                stage = "explain" if explain else "query"
                result["result"] = _explain_cursor(cursor,connection,target,sql,max_rows) if explain else _query_cursor(cursor, connection, target, sql, max_rows)
            elif explain:
                raise DatabaseReadonlyError('QUERY_INVALID', '--explain 必须提供待校验的 SELECT')
            return result
    except DatabaseReadonlyError as error:
        error.stage = stage
        raise


def list_targets(config: dict, workspace_key: str, *, environment: str = "", target_id: str = "") -> dict:
    artifacts.validate_config(config)
    workspace = config["databaseTests"].get(workspace_key)
    if workspace is None:
        raise DatabaseReadonlyError("BINDING_MISSING", f"工作区未配置数据库目标: {workspace_key}")
    selection = {}
    try:
        selected, source = artifacts.resolve_diagnosis_target(config, workspace_key, environment=environment, target_id=target_id)
        selection = {"targetId": selected["id"], "selectionSource": source}
    except artifacts.ArtifactError as error:
        selection = {"code": error.code, "message": str(error)}
    defaults = workspace.get("defaults") or {}
    rows = []
    for target in workspace["targets"]:
        identity = config["expectedIdentities"][target["expectedIdentityRef"]]
        rows.append({**target, "engine": identity["engine"], "endpoint": identity["endpoint"], "connector": "builtin-readonly" if target.get("connectionRef") else "dbx", "builtinAvailable": bool(target.get("connectionRef")), "isDefault": target["id"] == defaults.get("diagnosisTargetId"), "isEnvironmentDefault": target["id"] == (defaults.get("byEnvironment") or {}).get(target["environment"])})
    return {"ok": True, "workspaceKey": workspace_key, "targets": rows, "selection": selection}


def build_remove_target_config(config: dict, workspace_key: str, target_id: str) -> tuple[dict, list[str]]:
    """Return validated configuration and unreferenced keyring IDs to delete after save."""
    artifacts.validate_config(config)
    value = json.loads(json.dumps(config))
    workspace = value["databaseTests"].get(workspace_key)
    targets = workspace.get("targets", []) if workspace else []
    target = next((item for item in targets if item["id"] == target_id), None)
    if target is None:
        raise DatabaseReadonlyError("BINDING_MISSING", f"数据库目标不存在: {target_id}")
    targets.remove(target)
    defaults = workspace.get("defaults") or {}
    if defaults.get("diagnosisTargetId") == target_id:
        defaults.pop("diagnosisTargetId")
    by_environment = defaults.get("byEnvironment") or {}
    for name in list(by_environment):
        if by_environment[name] == target_id:
            del by_environment[name]
    if not targets:
        del value["databaseTests"][workspace_key]
    for name, profile in list(value.get("profiles", {}).items()):
        if profile["workspaceKey"] == workspace_key and profile["targetId"] == target_id:
            del value["profiles"][name]
    remaining = [item for item_workspace in value["databaseTests"].values() for item in item_workspace["targets"]]
    credentials = []
    connection_ref = target.get("connectionRef")
    if connection_ref and not any(item.get("connectionRef") == connection_ref for item in remaining):
        removed = value.get("connections", {}).pop(connection_ref, {})
        credential_ref = removed.get("credentialRef")
        if credential_ref and not any(item.get("credentialRef") == credential_ref for item in value.get("connections", {}).values()):
            credentials.append(str(credential_ref))
    identity_ref = target["expectedIdentityRef"]
    if not any(item["expectedIdentityRef"] == identity_ref for item in remaining):
        value["expectedIdentities"].pop(identity_ref, None)
    artifacts.validate_config(value)
    return value, credentials

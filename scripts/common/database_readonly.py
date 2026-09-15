"""Built-in, credential-safe, read-only database diagnosis adapter."""

from __future__ import annotations

import datetime as dt
import decimal
import json
import re
from pathlib import Path
from typing import Any

from common import database_test_artifacts as artifacts
from providers.database.run_source_diagnosis import validate_single_select


CREDENTIAL_SERVICE = "GuthonCodeTool.Database"
MAX_ROWS = 100
MAX_CELL_CHARS = 2_000


class DatabaseReadonlyError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


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
        raise DatabaseReadonlyError("CREDENTIAL_STORE_FAILED", f"无法写入系统凭据存储: {error}") from error


def delete_password(credential_ref: str) -> None:
    try:
        _keyring().delete_password(CREDENTIAL_SERVICE, credential_ref)
    except Exception:
        pass


def get_password(credential_ref: str) -> str:
    try:
        password = _keyring().get_password(CREDENTIAL_SERVICE, credential_ref)
    except Exception as error:
        raise DatabaseReadonlyError("CREDENTIAL_STORE_FAILED", f"无法读取系统凭据存储: {error}") from error
    if not password:
        raise DatabaseReadonlyError("CREDENTIAL_MISSING", "系统凭据存储中没有该数据库密码，请在 Nexus 重新配置")
    return password


def build_diagnosis_config(config: dict, workspace_key: str, payload: dict) -> tuple[dict, str]:
    """Return an updated config and credential ref; never retain the password."""

    allowed = {
        "targetId", "environment", "engine", "host", "port", "database",
        "schema", "username", "password", "makeDefault", "connectTimeoutSeconds",
    }
    unknown = sorted(set(payload) - allowed)
    if unknown:
        raise DatabaseReadonlyError("CONFIG_INVALID", f"数据库配置包含未知字段: {', '.join(unknown)}")
    required = {"targetId", "environment", "engine", "host", "port", "database", "username", "password"}
    missing = sorted(key for key in required if payload.get(key) in (None, ""))
    if missing:
        raise DatabaseReadonlyError("CONFIG_INVALID", f"数据库配置缺少字段: {', '.join(missing)}")
    engine = {"postgres": "postgresql", "mariadb": "mysql"}.get(
        str(payload["engine"]).strip().lower(), str(payload["engine"]).strip().lower()
    )
    if engine not in artifacts.ENGINES:
        raise DatabaseReadonlyError("UNSUPPORTED", "仅支持 MySQL/PostgreSQL/Oracle")
    target_id = str(payload["targetId"]).strip()
    environment = str(payload["environment"]).strip().lower()
    host = str(payload["host"]).strip()
    database = str(payload["database"]).strip()
    schema = str(payload.get("schema") or "").strip()
    username = str(payload["username"]).strip()
    if environment not in artifacts.ENVIRONMENTS:
        raise DatabaseReadonlyError("CONFIG_INVALID", "数据库环境仅允许 dev/test")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", target_id):
        raise DatabaseReadonlyError("CONFIG_INVALID", "targetId 仅允许字母、数字、点、下划线和连字符")
    if not host or any(char.isspace() for char in host):
        raise DatabaseReadonlyError("CONFIG_INVALID", "数据库服务器无效")
    if not artifacts.IDENTIFIER.fullmatch(database):
        raise DatabaseReadonlyError("CONFIG_INVALID", "database 必须是普通标识符")
    if schema and not artifacts.IDENTIFIER.fullmatch(schema):
        raise DatabaseReadonlyError("CONFIG_INVALID", "schema 必须是普通标识符")
    if engine == "oracle" and not schema:
        raise DatabaseReadonlyError("CONFIG_INVALID", "Oracle 必须配置业务 schema")
    try:
        port = int(payload["port"])
        timeout = int(payload.get("connectTimeoutSeconds", 10))
    except (TypeError, ValueError) as error:
        raise DatabaseReadonlyError("CONFIG_INVALID", "数据库端口或连接超时无效") from error
    if not 1 <= port <= 65535 or not 1 <= timeout <= 60:
        raise DatabaseReadonlyError("CONFIG_INVALID", "数据库端口或连接超时超出范围")

    value = json.loads(json.dumps(config)) if config else {"schemaVersion": 1}
    value.setdefault("schemaVersion", 1)
    connections = value.setdefault("connections", {})
    identities = value.setdefault("expectedIdentities", {})
    workspaces = value.setdefault("databaseTests", {})
    connection_ref = f"{workspace_key}.{target_id}"
    workspace = workspaces.setdefault(workspace_key, {"targets": []})
    targets = workspace.setdefault("targets", [])
    existing_target = next((item for item in targets if item.get("id") == target_id), None)
    identity_ref = str((existing_target or {}).get("expectedIdentityRef") or f"{connection_ref}.identity")
    credential_ref = connection_ref
    connection = {
        "engine": engine,
        "host": host,
        "port": port,
        "database": database,
        "username": username,
        "credentialRef": credential_ref,
        "connectTimeoutSeconds": timeout,
    }
    identity = {
        "engine": engine,
        "endpoint": f"{host}:{port}",
        "database": database,
        "evidenceRef": f"nexus-config:{connection_ref}",
    }
    target = dict(existing_target or {})
    target.update({
        "id": target_id,
        "connectionRef": connection_ref,
        "database": database,
        "environment": environment,
        "access": "read-only",
        "expectedIdentityRef": identity_ref,
    })
    if existing_target is None:
        target["validationScope"] = "diagnosis-only"
    if schema:
        connection["schema"] = schema
        identity["schema"] = schema
        target["schema"] = schema
    else:
        target.pop("schema", None)
    connections[connection_ref] = connection
    identities[identity_ref] = identity
    targets[:] = [item for item in targets if item.get("id") != target_id]
    targets.append(target)
    defaults = workspace.setdefault("defaults", {})
    defaults.setdefault("byEnvironment", {})[environment] = target_id
    if payload.get("makeDefault", True) or not defaults.get("diagnosisTargetId"):
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
    connection["password"] = get_password(str(connection["credentialRef"]))
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
            raise DatabaseReadonlyError("CONNECTION_FAILED", "MySQL 连接失败，请检查地址、只读账号、密码和网络") from error
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
            raise DatabaseReadonlyError("CONNECTION_FAILED", "PostgreSQL 连接失败，请检查地址、只读账号、密码和网络") from error
    if engine == "oracle":
        try:
            import oracledb  # type: ignore
        except ModuleNotFoundError as error:
            raise DatabaseReadonlyError("DRIVER_MISSING", "缺少 Oracle 驱动 oracledb") from error
        try:
            return oracledb.connect(
                **common,
                service_name=connection["database"],
                tcp_connect_timeout=timeout,
            )
        except Exception as error:
            raise DatabaseReadonlyError("CONNECTION_FAILED", "Oracle 连接失败，请检查地址、服务名、只读账号、密码和网络") from error
    raise DatabaseReadonlyError("UNSUPPORTED", f"不支持的数据库引擎: {engine}")


def _set_read_only(cursor, connection: dict) -> None:
    engine = connection["engine"]
    if engine == "mysql":
        cursor.execute("SET TRANSACTION READ ONLY")
    elif engine == "postgresql":
        cursor.execute("SET TRANSACTION READ ONLY")
        cursor.execute("SET LOCAL statement_timeout = '30s'")
        cursor.execute(f"SET LOCAL search_path TO {connection.get('schema') or 'public'}")
    else:
        cursor.execute("SET TRANSACTION READ ONLY")


def _execute_dicts(cursor, sql: str, params: tuple = ()) -> tuple[list[str], list[dict]]:
    cursor.execute(sql, params)
    columns = [getattr(column, "name", column[0]) for column in (cursor.description or [])]
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
        candidate = validate_single_select(sql)
    except ValueError as error:
        raise DatabaseReadonlyError("QUERY_UNSUPPORTED", str(error)) from error
    if artifacts._has_top_level_comma_join(candidate):
        raise DatabaseReadonlyError("QUERY_UNSUPPORTED", "不支持逗号连接，请使用显式 JOIN")
    references = artifacts.TABLE_REFERENCE.findall(candidate)
    if not references:
        raise DatabaseReadonlyError("QUERY_UNSUPPORTED", "无法识别查询中的数据表")
    expected = str(target.get("schema") or target["database"]).lower()
    for reference in references:
        parts = reference.split(".")
        if connection["engine"] == "oracle" and len(parts) != 2:
            raise DatabaseReadonlyError("QUERY_UNSUPPORTED", "Oracle 查询必须使用业务 schema 限定表名")
        if len(parts) == 2 and parts[0].lower() != expected:
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


def probe(connection: dict, target: dict) -> dict:
    db = connect(connection)
    try:
        cursor = db.cursor()
        _set_read_only(cursor, connection)
        if connection["engine"] == "mysql":
            columns, rows = _execute_dicts(cursor, "SELECT DATABASE() AS database_name")
        elif connection["engine"] == "postgresql":
            columns, rows = _execute_dicts(cursor, "SELECT CURRENT_DATABASE() AS database_name, CURRENT_SCHEMA() AS schema_name")
        else:
            columns, rows = _execute_dicts(cursor, "SELECT SYS_CONTEXT('USERENV', 'SERVICE_NAME') AS database_name, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS schema_name FROM DUAL")
        actual = rows[0] if rows else {}
        actual_database = str(actual.get("database_name") or actual.get("DATABASE_NAME") or "")
        if actual_database and actual_database.lower() != str(target["database"]).lower():
            raise DatabaseReadonlyError("ENVIRONMENT_MISMATCH", "连接返回的 database 与目标配置不一致")
        return {"ok": True, "columns": columns, "identity": _normalize_rows(rows, 1)[0][0] if rows else {}}
    finally:
        try:
            db.rollback()
        finally:
            db.close()


def describe(connection: dict, target: dict, table: str) -> dict:
    if not artifacts.IDENTIFIER.fullmatch(table):
        raise DatabaseReadonlyError("CONFIG_INVALID", "表名必须是普通标识符")
    db = connect(connection)
    try:
        cursor = db.cursor()
        _set_read_only(cursor, connection)
        schema = str(connection.get("schema") or connection["database"])
        if connection["engine"] == "oracle":
            sql = "SELECT COLUMN_NAME, DATA_TYPE, NULLABLE FROM ALL_TAB_COLUMNS WHERE OWNER=:1 AND TABLE_NAME=:2 ORDER BY COLUMN_ID"
            params = (schema.upper(), table.upper())
        else:
            sql = "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema=%s AND UPPER(table_name)=%s ORDER BY ordinal_position"
            params = ((connection.get("schema") or ("public" if connection["engine"] == "postgresql" else connection["database"])), table.upper())
        columns, rows = _execute_dicts(cursor, sql, params)
        normalized, truncation = _normalize_rows(rows, MAX_ROWS)
        return {"ok": True, "table": table, "columns": columns, "rows": normalized, "truncation": truncation}
    finally:
        try:
            db.rollback()
        finally:
            db.close()


def query(connection: dict, target: dict, sql: str, max_rows: int = MAX_ROWS) -> dict:
    limit = max(1, min(int(max_rows), MAX_ROWS))
    db = connect(connection)
    try:
        cursor = db.cursor()
        _set_read_only(cursor, connection)
        candidate = verify_query_scope(cursor, connection, target, sql)
        cursor.execute(candidate)
        columns = [getattr(column, "name", column[0]) for column in (cursor.description or [])]
        raw_rows = cursor.fetchmany(limit + 1)
        rows = [raw if isinstance(raw, dict) else dict(zip(columns, raw)) for raw in raw_rows]
        normalized, truncation = _normalize_rows(rows, limit)
        return {"ok": True, "columns": columns, "rows": normalized, "truncation": truncation, "maxRows": limit}
    finally:
        try:
            db.rollback()
        finally:
            db.close()

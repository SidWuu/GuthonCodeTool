#!/usr/bin/env python3
"""Shared implementation for the Gushen source hub."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import sqlite3
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONFIG_DIR = ROOT / "config"
VAR_DIR = ROOT / "var"
PAGE_SOURCE_TYPE = "page"
PROCEDURE_SOURCE_TYPE = "procedure"


def source_dir() -> Path:
    return VAR_DIR / "source"


def readonly_source_dir() -> Path:
    return source_dir() / "readonly"


def effective_source_dir() -> Path:
    return source_dir() / "effective"


def work_copy_dir() -> Path:
    return source_dir() / "workcopy"


def load_yaml(path: Path):
    text = _expand_env(path.read_text(encoding="utf-8"))
    try:
        import yaml  # type: ignore

        return yaml.safe_load(text) or {}
    except ModuleNotFoundError:
        return _parse_tiny_yaml(text)


def _expand_env(text: str) -> str:
    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", lambda m: os.getenv(m.group(1), m.group(0)), text)


def _parse_tiny_yaml(text: str):
    # ponytail: supports this repo's config templates; install PyYAML if configs grow more complex.
    root = {}
    stack = [(-1, root)]
    lines = [line.rstrip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    for idx, line in enumerate(lines):
        indent = len(line) - len(line.lstrip(" "))
        item = line.strip()
        while stack and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        if item.startswith("- "):
            if not isinstance(parent, list):
                raise ValueError(f"List item has no list parent: {line}")
            parent.append(_scalar(item[2:]))
            continue
        key, _, raw_value = item.partition(":")
        key = key.strip()
        raw_value = raw_value.strip()
        if raw_value:
            parent[key] = _scalar(raw_value)
            continue
        next_line = _next_content_line(lines, idx + 1)
        child = [] if next_line and next_line.strip().startswith("- ") else {}
        parent[key] = child
        stack.append((indent, child))
    return root


def _next_content_line(lines, start):
    for line in lines[start:]:
        if line.strip():
            return line
    return None


def _scalar(value: str):
    if value in ("true", "True"):
        return True
    if value in ("false", "False"):
        return False
    if value in ("null", "NULL", "~"):
        return None
    if value in ('""', "''"):
        return ""
    if value.startswith(("'", '"')) and value.endswith(("'", '"')):
        return value[1:-1]
    try:
        return int(value)
    except ValueError:
        return value


def load_config():
    files = {
        "datasource": "datasource.yaml",
        "products": "products.yaml",
        "projects": "projects.yaml",
        "source_tables": "source-tables.yaml",
        "sync": "sync.yaml",
    }
    missing = [name for name in files.values() if not (CONFIG_DIR / name).exists()]
    if missing:
        raise SystemExit(
            "Missing config files: "
            + ", ".join(missing)
            + "\nCopy config/example/*.example.yaml to config/*.yaml and fill them first."
        )
    config = {key: load_yaml(CONFIG_DIR / filename) for key, filename in files.items()}
    systems_file = CONFIG_DIR / "systems.yaml"
    config["systems"] = load_yaml(systems_file) if systems_file.exists() else {}
    config["_system_scope"] = load_system_scope(config["systems"])
    return config


def load_system_scope(config: dict):
    systems = config.get("systems") or {}
    data_file = systems.get("data_file")
    selected = [str(item) for item in (systems.get("include") or {}).get("system_codes", [])]
    if not data_file or not selected:
        return {"system_ids": [], "data_source_ids": []}
    selected_order = {code: index for index, code in enumerate(selected)}
    data_path = CONFIG_DIR / data_file
    if not data_path.exists():
        raise SystemExit(f"Missing system data json: {data_path}")
    records = _flatten_records(json.loads(data_path.read_text(encoding="utf-8")))
    system_ids = set()
    data_source_ids = set()
    system_name_by_id = {}
    data_source_names = {}
    for record in records:
        code_values = _values(record, "SYSTEM_CODE", "SYSTEM_ID", "SYSTEM_ALIAS_ID", "SYS_CODE", "systemCode", "systemId")
        matched = [code for code in selected if code in code_values]
        if not matched:
            continue
        order = min(selected_order[code] for code in matched)
        ids = _values(record, "SYSTEM_ID", "systemId", "id")
        data_ids = _values(record, "DATA_SOURCE_ID", "DATA_SOURCE_IDS", "dataSourceId", "dataSourceIds")
        name = next(iter(_values(record, "SYSTEM_NAME", "systemName", "name")), "") or next(iter(code_values), "")
        system_ids.update(ids)
        data_source_ids.update(data_ids)
        for system_id in ids:
            system_name_by_id[system_id] = name
        for data_source_id in data_ids:
            data_source_names.setdefault(data_source_id, []).append((order, name))
    system_name_by_data_source_id = {}
    system_link_names_by_data_source_id = {}
    for data_source_id, names in data_source_names.items():
        ordered = []
        for _order, name in sorted(names):
            if name not in ordered:
                ordered.append(name)
        system_name_by_data_source_id[data_source_id] = ordered[0]
        system_link_names_by_data_source_id[data_source_id] = ordered[1:]
    return {
        "system_ids": sorted(system_ids),
        "data_source_ids": sorted(data_source_ids),
        "system_name_by_id": system_name_by_id,
        "system_name_by_data_source_id": system_name_by_data_source_id,
        "system_link_names_by_data_source_id": system_link_names_by_data_source_id,
    }


def connect_index(index_db: Path) -> sqlite3.Connection:
    index_db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(index_db)
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS gusen_source_record (
            source_layer TEXT NOT NULL,
            product_id TEXT NOT NULL,
            project_id TEXT NOT NULL DEFAULT '',
            source_table TEXT NOT NULL,
            source_id TEXT NOT NULL,
            source_alias_id TEXT NOT NULL,
            fun_id TEXT NOT NULL DEFAULT '',
            source_name TEXT,
            version_mac TEXT,
            update_time TEXT,
            check_out_user_id TEXT,
            check_out_date TEXT,
            check_in_date TEXT,
            change_key TEXT NOT NULL,
            local_path TEXT,
            status TEXT NOT NULL,
            indexed_time TEXT NOT NULL,
            PRIMARY KEY (source_layer, product_id, project_id, source_table, source_id, fun_id)
        );
        CREATE TABLE IF NOT EXISTS gusen_invoke_call (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_layer TEXT NOT NULL,
            product_id TEXT NOT NULL,
            project_id TEXT NOT NULL DEFAULT '',
            source_table TEXT NOT NULL,
            source_id TEXT NOT NULL,
            source_alias_id TEXT NOT NULL,
            fun_id TEXT NOT NULL DEFAULT '',
            source_name TEXT,
            script_type TEXT,
            json_path TEXT,
            line_no INTEGER,
            target_alias_id TEXT,
            target_fun_id TEXT,
            invoke_expr TEXT,
            invoke_type TEXT,
            confidence TEXT,
            update_time TEXT,
            indexed_time TEXT
        );
        CREATE TABLE IF NOT EXISTS gusen_dynamic_call (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_layer TEXT NOT NULL,
            product_id TEXT NOT NULL,
            project_id TEXT NOT NULL DEFAULT '',
            source_table TEXT NOT NULL,
            source_id TEXT NOT NULL,
            source_alias_id TEXT NOT NULL,
            fun_id TEXT NOT NULL DEFAULT '',
            source_name TEXT,
            script_type TEXT,
            json_path TEXT,
            line_no INTEGER,
            invoke_expr TEXT,
            reason TEXT,
            confidence TEXT,
            update_time TEXT,
            indexed_time TEXT
        );
        CREATE TABLE IF NOT EXISTS gusen_effective_source (
            project_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            source_table TEXT NOT NULL,
            source_alias_id TEXT NOT NULL,
            fun_id TEXT NOT NULL DEFAULT '',
            effective_layer TEXT NOT NULL,
            effective_source_id TEXT NOT NULL,
            effective_local_path TEXT NOT NULL,
            product_source_id TEXT,
            product_change_key TEXT,
            product_local_path TEXT,
            project_source_id TEXT,
            project_change_key TEXT,
            project_local_path TEXT,
            is_override INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            build_time TEXT NOT NULL,
            PRIMARY KEY (project_id, source_table, source_alias_id, fun_id)
        );
        CREATE TABLE IF NOT EXISTS gusen_sync_state (
            state_key TEXT PRIMARY KEY,
            state_value TEXT
        );
        """
    )
    return conn


def db_connect(ds: dict):
    if ds.get("type", "mysql") != "mysql":
        raise SystemExit(f"Only mysql datasource is implemented now: {ds.get('name')}")
    try:
        import pymysql  # type: ignore
    except ModuleNotFoundError as exc:
        raise SystemExit("Missing dependency: pip install pymysql") from exc
    return pymysql.connect(
        host=ds["host"],
        port=int(ds["port"]),
        database=ds["database"],
        user=ds["username"],
        password=ds["password"],
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        read_timeout=60,
        write_timeout=60,
    )


def _source_available_sql(alias: str, cfg: dict, rules: dict | None):
    check_in = f"{_field(alias, cfg['check_in_date_field'])} IS NOT NULL"
    users = (rules or {}).get("allow_unchecked_check_out_user_ids") or []
    check_out_field = cfg.get("check_out_user_id_field")
    if not users or not check_out_field:
        return check_in
    quoted = ", ".join(_sql_quote(str(user)) for user in users)
    return f"({check_in} OR {_field(alias, check_out_field)} IN ({quoted}))"


def _sql_quote(value: str):
    return "'" + value.replace("'", "''") + "'"


def _page_select(table_cfg: dict):
    cfg = _source_table_cfg(table_cfg, PAGE_SOURCE_TYPE)
    module_table = cfg.get("module_table_name")
    mk_name = "NULL"
    join = ""
    if module_table:
        mk_name = _field("m", cfg["module_name_field"])
        join = f"LEFT JOIN {_name(module_table)} m ON {_field('p', cfg['module_join_field'])} = {_field('m', cfg['module_join_field'])}"
    return cfg, f"""
SELECT
    '{PAGE_SOURCE_TYPE}' AS source_table,
    {_field('p', cfg['id_field'])} AS source_id,
    {_field('p', cfg['alias_field'])} AS source_alias_id,
    '' AS fun_id,
    {_field('p', cfg['name_field'])} AS source_name,
    {_field('p', cfg['content_field'])} AS source_content,
    {_field('p', cfg['update_time_field'])} AS update_time,
    {_field('p', cfg.get('check_out_user_id_field'))} AS check_out_user_id,
    {_field('p', cfg.get('check_out_date_field'))} AS check_out_date,
    {_field('p', cfg['check_in_date_field'])} AS check_in_date,
    {_field('p', cfg.get('version_mac_field'))} AS version_mac,
    {_field('p', cfg.get('error_field'))} AS is_error,
    {_field('p', cfg.get('error_message_field'))} AS err_msg,
    {_field('p', cfg['system_id_field'])} AS system_id,
    {_field('p', cfg.get('module_join_field'))} AS mk_id,
    {mk_name} AS mk_name
FROM {_name(cfg['source_table_name'])} p
{join}
"""


def page_sql(table_cfg: dict, rules: dict | None = None):
    cfg, select = _page_select(table_cfg)
    return f"""
{select}
WHERE {_source_available_sql('p', cfg, rules)}
  AND ({_field('p', cfg.get('error_field'))} IS NULL OR {_field('p', cfg.get('error_field'))} <> '1')
  AND ({_field('p', cfg['update_time_field'])} >= %s OR {_field('p', cfg['check_in_date_field'])} >= %s)
  {{system_filter}}
ORDER BY {_field('p', cfg['update_time_field'])}, {_field('p', cfg['id_field'])}
"""


def proc_sql(table_cfg: dict, rules: dict | None = None):
    cfg = _source_table_cfg(table_cfg, PROCEDURE_SOURCE_TYPE)
    return f"""
SELECT
    '{PROCEDURE_SOURCE_TYPE}' AS source_table,
    {_field('s', cfg['id_field'])} AS source_id,
    {_field('p', cfg['alias_field'])} AS source_alias_id,
    {_field('s', cfg['fun_id_field'])} AS fun_id,
    {_field('s', cfg['name_field'])} AS source_name,
    {_field('s', cfg['content_field'])} AS source_content,
    {_field('s', cfg['update_time_field'])} AS update_time,
    {_field('s', cfg.get('check_out_user_id_field'))} AS check_out_user_id,
    {_field('s', cfg.get('check_out_date_field'))} AS check_out_date,
    {_field('s', cfg['check_in_date_field'])} AS check_in_date,
    {_field('s', cfg.get('version_mac_field'))} AS version_mac,
    {_field('s', cfg.get('error_field'))} AS is_error,
    {_field('s', cfg.get('error_message_field'))} AS err_msg,
    {_field('s', cfg.get('params_field'))} AS fun_params,
    {_field('p', cfg.get('procedure_name_field'))} AS procedure_name,
    {_field('p', cfg['data_source_id_field'])} AS data_source_id
FROM {_name(cfg['procedure_table_name'])} p
JOIN {_name(cfg['source_table_name'])} s ON {_field('p', cfg['join_field'])} = {_field('s', cfg['join_field'])}
WHERE {_source_available_sql('s', cfg, rules)}
  AND ({_field('s', cfg.get('error_field'))} IS NULL OR {_field('s', cfg.get('error_field'))} <> '1')
  AND ({_field('s', cfg['update_time_field'])} >= %s OR {_field('s', cfg['check_in_date_field'])} >= %s)
  {{data_source_filter}}
ORDER BY {_field('s', cfg['update_time_field'])}, {_field('s', cfg['id_field'])}, {_field('s', cfg['fun_id_field'])}
"""


def module_page_sql(table_cfg: dict, row: dict, rules: dict | None = None):
    cfg, select = _page_select(table_cfg)
    if not cfg.get("module_join_field"):
        raise SystemExit("page module_join_field is required for module pull")
    filters = [f"{_field('p', cfg['module_join_field'])} = %s"]
    params = [row["mk_id"]]
    if row.get("system_id"):
        filters.append(f"{_field('p', cfg['system_id_field'])} = %s")
        params.append(row["system_id"])
    return (
        f"""
{select}
WHERE {_source_available_sql('p', cfg, rules)}
  AND ({_field('p', cfg.get('error_field'))} IS NULL OR {_field('p', cfg.get('error_field'))} <> '1')
  AND {' AND '.join(filters)}
ORDER BY {_field('p', cfg['update_time_field'])} DESC, {_field('p', cfg['id_field'])} DESC
""",
        params,
    )


def single_source_sql(table_cfg: dict, source_type: str, payload: dict, rules: dict | None = None):
    if source_type == PAGE_SOURCE_TYPE:
        cfg, select = _page_select(table_cfg)
        filters = []
        params = []
        if payload.get("sourceId"):
            filters.append(f"{_field('p', cfg['id_field'])} = %s")
            params.append(payload["sourceId"])
        elif payload.get("alias"):
            filters.append(f"{_field('p', cfg['alias_field'])} = %s")
            params.append(payload["alias"])
        else:
            raise SystemExit("page sourceId or alias is required")
        return (
            f"""
{select}
WHERE {_source_available_sql('p', cfg, rules)}
  AND ({_field('p', cfg.get('error_field'))} IS NULL OR {_field('p', cfg.get('error_field'))} <> '1')
  AND {' AND '.join(filters)}
ORDER BY {_field('p', cfg['update_time_field'])} DESC, {_field('p', cfg['id_field'])} DESC
LIMIT 1
""",
            params,
        )
    if source_type == PROCEDURE_SOURCE_TYPE:
        cfg = _source_table_cfg(table_cfg, PROCEDURE_SOURCE_TYPE)
        filters = []
        params = []
        if payload.get("sourceId"):
            filters.append(f"{_field('s', cfg['id_field'])} = %s")
            params.append(payload["sourceId"])
        elif payload.get("alias"):
            filters.append(f"{_field('p', cfg['alias_field'])} = %s")
            params.append(payload["alias"])
        else:
            raise SystemExit("procedure sourceId or alias is required")
        if not payload.get("funId"):
            raise SystemExit("procedure funId is required")
        filters.append(f"{_field('s', cfg['fun_id_field'])} = %s")
        params.append(payload["funId"])
        return (
            f"""
SELECT
    '{PROCEDURE_SOURCE_TYPE}' AS source_table,
    {_field('s', cfg['id_field'])} AS source_id,
    {_field('p', cfg['alias_field'])} AS source_alias_id,
    {_field('s', cfg['fun_id_field'])} AS fun_id,
    {_field('s', cfg['name_field'])} AS source_name,
    {_field('s', cfg['content_field'])} AS source_content,
    {_field('s', cfg['update_time_field'])} AS update_time,
    {_field('s', cfg.get('check_out_user_id_field'))} AS check_out_user_id,
    {_field('s', cfg.get('check_out_date_field'))} AS check_out_date,
    {_field('s', cfg['check_in_date_field'])} AS check_in_date,
    {_field('s', cfg.get('version_mac_field'))} AS version_mac,
    {_field('s', cfg.get('error_field'))} AS is_error,
    {_field('s', cfg.get('error_message_field'))} AS err_msg,
    {_field('s', cfg.get('params_field'))} AS fun_params,
    {_field('p', cfg.get('procedure_name_field'))} AS procedure_name,
    {_field('p', cfg['data_source_id_field'])} AS data_source_id
FROM {_name(cfg['procedure_table_name'])} p
JOIN {_name(cfg['source_table_name'])} s ON {_field('p', cfg['join_field'])} = {_field('s', cfg['join_field'])}
WHERE {_source_available_sql('s', cfg, rules)}
  AND ({_field('s', cfg.get('error_field'))} IS NULL OR {_field('s', cfg.get('error_field'))} <> '1')
  AND {' AND '.join(filters)}
ORDER BY {_field('s', cfg['update_time_field'])} DESC, {_field('s', cfg['id_field'])} DESC
LIMIT 1
""",
            params,
        )
    raise SystemExit(f"Unsupported sourceType: {source_type}")


def run_sync_once(args=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--init-only", action="store_true", help="create local sqlite schema and docs only")
    parsed = parser.parse_args(args)
    cfg = load_config()
    sync = cfg["sync"]["sync"]
    conn = connect_index(ROOT / sync["index_db"])
    if parsed.init_only:
        export_status(conn, {"mode": "init-only", "changed": 0, "candidates": 0, "failures": 0})
        return

    lookback = int(sync.get("lookback_minutes", 10))
    sync_from = _sync_from(conn, lookback)
    active, products, projects, effective_project_ids = resolve_active(cfg)
    stats = {"mode": "sync", "active": active, "sync_from": sync_from, "candidates": 0, "changed": 0, "failures": 0}
    for product_id, product in products:
        stats = _sync_layer(conn, cfg, product, "PRODUCT", product_id, "", sync_from, stats)
        export_product_docs(conn, product_id)
    for project_id, project in projects:
        stats = _sync_layer(conn, cfg, project, "PROJECT", project["product_id"], project_id, sync_from, stats)
    if effective_project_ids:
        build_effective(conn, cfg, effective_project_ids)
    conn.execute(
        "INSERT OR REPLACE INTO gusen_sync_state(state_key, state_value) VALUES('last_success_time', ?)",
        (_now(),),
    )
    conn.commit()
    export_status(conn, stats)


def resolve_active(cfg):
    sync = cfg["sync"]["sync"]
    active = sync.get("ACTIVE") or sync.get("active")
    if not active:
        raise SystemExit("Missing sync.ACTIVE. Use products.<product_id> or projects.<project_id>.")
    kind, _, item_id = str(active).partition(".")
    if kind == "products":
        product = (cfg["products"].get("products") or {}).get(item_id)
        if product:
            return active, [(item_id, product)], [], []
    if kind == "projects":
        project = (cfg["projects"].get("projects") or {}).get(item_id)
        if project:
            return active, [], [(item_id, project)], [item_id]
    raise SystemExit(f"Invalid sync.ACTIVE: {active}")


def _sync_layer(conn, cfg, layer_cfg, layer, product_id, project_id, sync_from, stats):
    ds_name = layer_cfg["datasource"]
    ds = cfg["datasource"]["datasource"][ds_name]
    table_cfg = cfg["source_tables"]
    rules = cfg["sync"].get("rules") or {}
    page_query, page_params = _scoped_sql(page_sql(table_cfg, rules), cfg["_system_scope"], "system", table_cfg)
    proc_query, proc_params = _scoped_sql(proc_sql(table_cfg, rules), cfg["_system_scope"], "data_source", table_cfg)
    with db_connect(ds) as remote:
        with remote.cursor() as cur:
            for sql, extra_params in ((page_query, page_params), (proc_query, proc_params)):
                cur.execute(sql, (sync_from, sync_from, *extra_params))
                for row in cur.fetchall():
                    stats["candidates"] += 1
                    if not _included(layer_cfg, row):
                        continue
                    if upsert_source(conn, row, layer, product_id, project_id, layer_cfg, cfg["_system_scope"]):
                        stats["changed"] += 1
    conn.commit()
    return stats


def _scoped_sql(sql: str, scope: dict, kind: str, table_cfg: dict):
    if kind == "system":
        ids = scope.get("system_ids") or []
        placeholder = "system_filter"
        cfg = _source_table_cfg(table_cfg, PAGE_SOURCE_TYPE)
        field = _field("p", cfg["system_id_field"])
    else:
        ids = scope.get("data_source_ids") or []
        placeholder = "data_source_filter"
        cfg = _source_table_cfg(table_cfg, PROCEDURE_SOURCE_TYPE)
        field = _field("p", cfg["data_source_id_field"])
    if not ids:
        return sql.format(system_filter="", data_source_filter=""), []
    clause = f"AND {field} IN (" + ",".join(["%s"] * len(ids)) + ")"
    return sql.format(system_filter=clause, data_source_filter=clause), ids


def _included(layer_cfg, row):
    include = layer_cfg.get("include") or {}
    if include.get("all"):
        return True
    key = "page_alias_prefix" if row["source_table"] == PAGE_SOURCE_TYPE else "procedure_alias_prefix"
    prefixes = include.get(key) or []
    return any((row["source_alias_id"] or "").startswith(prefix) for prefix in prefixes)


def upsert_source(conn, row, layer, product_id, project_id, layer_cfg, system_scope, force=False):
    change_key = _change_key(row)
    source_alias_id = _source_alias_id(row)
    existing = conn.execute(
        """
        SELECT change_key FROM gusen_source_record
        WHERE source_layer=? AND product_id=? AND project_id=? AND source_table=? AND source_id=? AND fun_id=?
        """,
        (layer, product_id, project_id, row["source_table"], row["source_id"], row["fun_id"] or ""),
    ).fetchone()
    if existing and existing["change_key"] == change_key and not force:
        return False
    local_path, status, scripts = write_source(row, layer, product_id, project_id, layer_cfg, system_scope, change_key)
    indexed_time = _now()
    conn.execute(
        """
        INSERT OR REPLACE INTO gusen_source_record(
            source_layer, product_id, project_id, source_table, source_id, source_alias_id, fun_id,
            source_name, version_mac, update_time, check_out_user_id, check_out_date, check_in_date,
            change_key, local_path, status, indexed_time
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            layer,
            product_id,
            project_id,
            row["source_table"],
            row["source_id"],
            source_alias_id,
            row["fun_id"] or "",
            row["source_name"],
            _str(row.get("version_mac")),
            _str(row.get("update_time")),
            _str(row.get("check_out_user_id")),
            _str(row.get("check_out_date")),
            _str(row.get("check_in_date")),
            change_key,
            str(local_path.relative_to(ROOT)),
            status,
            indexed_time,
        ),
    )
    conn.execute(
        "DELETE FROM gusen_invoke_call WHERE source_layer=? AND product_id=? AND project_id=? AND source_table=? AND source_id=? AND fun_id=?",
        (layer, product_id, project_id, row["source_table"], row["source_id"], row["fun_id"] or ""),
    )
    conn.execute(
        "DELETE FROM gusen_dynamic_call WHERE source_layer=? AND product_id=? AND project_id=? AND source_table=? AND source_id=? AND fun_id=?",
        (layer, product_id, project_id, row["source_table"], row["source_id"], row["fun_id"] or ""),
    )
    for script_type, script_path, content in scripts:
        index_calls(conn, row, layer, product_id, project_id, script_type, script_path, content, indexed_time)
    return True


def write_source(row, layer, product_id, project_id, layer_cfg, system_scope, change_key):
    system_name = _system_name(row, system_scope)
    if layer == "PRODUCT":
        layer_root = readonly_source_dir() / "products"
    else:
        layer_root = readonly_source_dir() / "project" / path_part(layer_cfg.get("name") or project_id)
    root = layer_root / path_part(system_name)
    if row["source_table"] == PAGE_SOURCE_TYPE:
        module_name = row.get("mk_name") or row.get("mk_id") or "未归属模块"
        base = root / "page" / path_part(module_name) / path_part(f"{row.get('source_name') or row['source_alias_id']} {row['source_id']}")
    else:
        base = root / "procedure" / path_part(row["source_alias_id"]) / path_part(row["fun_id"])
        _link_shared_procedure_dirs(layer_root, system_name, row, system_scope)
    if base.exists():
        shutil.rmtree(base)
    base.mkdir(parents=True, exist_ok=True)
    content = row.get("source_content") or ""
    status = "OK" if content else "EMPTY_CONTENT"
    meta = {key: _str(value) for key, value in row.items() if key != "source_content"}
    meta.update({"change_key": change_key, "status": status})
    (base / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    scripts = []
    if not content:
        return base, status, scripts
    if row["source_table"] == PAGE_SOURCE_TYPE:
        (base / "raw.json").write_text(content, encoding="utf-8")
        scripts = parse_page_scripts(base, content)
    else:
        script_path = base / "source.vm"
        script_path.write_text(content, encoding="utf-8")
        scripts = [("procedure_script", script_path, content)]
    (base / "README.md").write_text(f"# {_source_alias_id(row)}\n\n- status: {status}\n", encoding="utf-8")
    return base, status, scripts


SCRIPT_KEYS = {
    "beforeSaveScript",
    "afterSaveScript",
    "onClickScript",
    "onOpenScript",
    "onCreateScript",
    "onAfterLoadScript",
    "onChangeScript",
    "onBeforeWinCloseScript",
    "doMethodScript",
    "compScript",
    "sql",
}


def parse_page_scripts(base: Path, raw: str):
    try:
        data = json.loads(raw)
        if isinstance(data, str):
            data = json.loads(data)
    except Exception:
        return []
    out_dir = base / "scripts"
    out_dir.mkdir(exist_ok=True)
    scripts = []
    for path, key, value in _walk_scripts(data):
        ext = "sql" if key == "sql" else ("vm" if "SaveScript" in key or key in {"doMethodScript", "compScript"} else "js")
        name = path_part(".".join(path[-2:] + [key])) if path else path_part(key)
        script_path = out_dir / f"{name}.{ext}"
        script_path.write_text(value, encoding="utf-8")
        scripts.append((key, script_path, value))
    return scripts


def _walk_scripts(value, path=None):
    path = path or []
    if isinstance(value, dict):
        label = str(value.get("aliasName") or value.get("name") or value.get("id") or "")
        next_path = path + ([label] if label else [])
        for key, child in value.items():
            if key in SCRIPT_KEYS and isinstance(child, str) and (child.strip() or key == "compScript"):
                yield next_path, key, child
            else:
                yield from _walk_scripts(child, next_path)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_scripts(child, path)


CALL_PATTERNS = [
    ("proc_invoke", re.compile(r"\$vs\.proc\.invoke\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]")),
    ("vm_open", re.compile(r"\$vm\.open\(\s*['\"]([^'\"]+)['\"]")),
    ("vm_open_dialog", re.compile(r"\$vm\.openDialog\(\s*['\"]([^'\"]+)['\"]")),
    ("gutil_request", re.compile(r"gUtil\.request\(\s*['\"]([^'\"]+)['\"]")),
]
PROC_FIND = re.compile(r"#set\(\s*\$(\w+)\s*=\s*\$vs\.proc\.find\(\s*['\"]([^'\"]+)['\"]\s*\)")


def index_calls(conn, row, layer, product_id, project_id, script_type, script_path, content, indexed_time):
    bindings = {}
    for line_no, line in enumerate(content.splitlines(), 1):
        find = PROC_FIND.search(line)
        if find:
            bindings[find.group(1)] = find.group(2)
        for var, alias in bindings.items():
            match = re.search(rf"\${re.escape(var)}\.([A-Za-z_][A-Za-z0-9_]*)\(", line)
            if match:
                _insert_call(conn, row, layer, product_id, project_id, script_type, script_path, line_no, alias, match.group(1), line, "proc_find_call", indexed_time)
        for invoke_type, pattern in CALL_PATTERNS:
            match = pattern.search(line)
            if not match:
                continue
            target_alias = match.group(1)
            target_fun = match.group(2) if invoke_type == "proc_invoke" and len(match.groups()) > 1 else ""
            _insert_call(conn, row, layer, product_id, project_id, script_type, script_path, line_no, target_alias, target_fun, line, invoke_type, indexed_time)
        if "$vs.proc.invoke(" in line and not re.search(r"\$vs\.proc\.invoke\(\s*['\"]", line):
            conn.execute(
                """
                INSERT INTO gusen_dynamic_call(source_layer, product_id, project_id, source_table, source_id, source_alias_id, fun_id, source_name, script_type, json_path, line_no, invoke_expr, reason, confidence, update_time, indexed_time)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (layer, product_id, project_id, row["source_table"], row["source_id"], _source_alias_id(row), row["fun_id"] or "", row["source_name"], script_type, str(script_path.relative_to(ROOT)), line_no, line.strip(), "目标过程别名或函数名来自变量", "LOW", _str(row.get("update_time")), indexed_time),
            )


def _insert_call(conn, row, layer, product_id, project_id, script_type, script_path, line_no, target_alias, target_fun, expr, invoke_type, indexed_time):
    conn.execute(
        """
        INSERT INTO gusen_invoke_call(source_layer, product_id, project_id, source_table, source_id, source_alias_id, fun_id, source_name, script_type, json_path, line_no, target_alias_id, target_fun_id, invoke_expr, invoke_type, confidence, update_time, indexed_time)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (layer, product_id, project_id, row["source_table"], row["source_id"], _source_alias_id(row), row["fun_id"] or "", row["source_name"], script_type, str(script_path.relative_to(ROOT)), line_no, target_alias, target_fun, expr.strip(), invoke_type, "HIGH", _str(row.get("update_time")), indexed_time),
    )


def build_effective(conn, cfg, project_ids=None):
    now = _now()
    projects = cfg["projects"].get("projects") or {}
    selected = set(project_ids or projects)
    for project_id, project in projects.items():
        if project_id not in selected:
            continue
        product_id = project["product_id"]
        project_name = project.get("name") or project_id
        rows = conn.execute(
            """
            SELECT * FROM gusen_source_record
            WHERE product_id=? AND (source_layer='PRODUCT' OR (source_layer='PROJECT' AND project_id=?))
            ORDER BY source_layer
            """,
            (product_id, project_id),
        ).fetchall()
        chosen = {}
        for row in rows:
            key = (row["source_table"], row["source_alias_id"], row["fun_id"])
            if key not in chosen or row["source_layer"] == "PROJECT":
                chosen[key] = row
        conn.execute("DELETE FROM gusen_effective_source WHERE project_id=?", (project_id,))
        effective_root = effective_source_dir() / "project" / path_part(project_name)
        if effective_root.exists():
            shutil.rmtree(effective_root)
        for key, row in chosen.items():
            local_path = ROOT / row["local_path"]
            if not local_path.exists():
                continue
            if row["source_layer"] == "PRODUCT":
                source_root = readonly_source_dir() / "products"
            else:
                source_root = readonly_source_dir() / "project" / path_part(project_name)
            target = effective_root / local_path.relative_to(source_root)
            shutil.copytree(local_path, target)
            product = _find_source(conn, product_id, "", key)
            project_row = _find_source(conn, product_id, project_id, key)
            conn.execute(
                """
                INSERT OR REPLACE INTO gusen_effective_source(project_id, product_id, source_table, source_alias_id, fun_id, effective_layer, effective_source_id, effective_local_path, product_source_id, product_change_key, product_local_path, project_source_id, project_change_key, project_local_path, is_override, status, build_time)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (project_id, product_id, row["source_table"], row["source_alias_id"], row["fun_id"], row["source_layer"], row["source_id"], str(target.relative_to(ROOT)), product["source_id"] if product else None, product["change_key"] if product else None, product["local_path"] if product else None, project_row["source_id"] if project_row else None, project_row["change_key"] if project_row else None, project_row["local_path"] if project_row else None, 1 if product and project_row else 0, row["status"], now),
            )
        conn.commit()
        export_project_docs(conn, project_id)


def _find_source(conn, product_id, project_id, key):
    source_table, alias, fun_id = key
    layer = "PROJECT" if project_id else "PRODUCT"
    return conn.execute(
        """
        SELECT * FROM gusen_source_record
        WHERE source_layer=? AND product_id=? AND project_id=? AND source_table=? AND source_alias_id=? AND fun_id=?
        """,
        (layer, product_id, project_id, source_table, alias, fun_id),
    ).fetchone()


def export_product_docs(conn, product_id):
    out = VAR_DIR / "knowledge" / "products" / product_id
    out.mkdir(parents=True, exist_ok=True)
    rows = conn.execute(
        """
        SELECT * FROM gusen_source_record
        WHERE source_layer='PRODUCT' AND product_id=?
        ORDER BY source_table, source_alias_id, fun_id
        """,
        (product_id,),
    ).fetchall()
    _write_table(
        out / "source-index.md",
        "产品源码索引",
        ["类型", "别名", "函数", "名称", "状态", "本地路径"],
        [[r["source_table"], r["source_alias_id"], r["fun_id"], r["source_name"], r["status"], r["local_path"]] for r in rows],
    )
    calls = conn.execute(
        """
        SELECT * FROM gusen_invoke_call
        WHERE source_layer='PRODUCT' AND product_id=?
        ORDER BY source_table, source_alias_id, fun_id, line_no
        """,
        (product_id,),
    ).fetchall()
    _write_table(
        out / "invoke-index.md",
        "产品调用索引",
        ["来源类型", "来源别名", "来源函数", "脚本位置", "行号", "调用类型", "目标别名", "目标函数", "置信度"],
        [[c["source_table"], c["source_alias_id"], c["fun_id"], c["json_path"], c["line_no"], c["invoke_type"], c["target_alias_id"], c["target_fun_id"], c["confidence"]] for c in calls],
    )
    dynamic_calls = conn.execute(
        """
        SELECT * FROM gusen_dynamic_call
        WHERE source_layer='PRODUCT' AND product_id=?
        ORDER BY source_table, source_alias_id, fun_id, line_no
        """,
        (product_id,),
    ).fetchall()
    _write_table(
        out / "dynamic-invoke-points.md",
        "产品动态调用点",
        ["来源类型", "来源别名", "来源函数", "脚本位置", "行号", "原因", "表达式", "置信度"],
        [[c["source_table"], c["source_alias_id"], c["fun_id"], c["json_path"], c["line_no"], c["reason"], c["invoke_expr"], c["confidence"]] for c in dynamic_calls],
    )


def export_project_docs(conn, project_id):
    out = VAR_DIR / "knowledge" / "projects" / project_id
    out.mkdir(parents=True, exist_ok=True)
    rows = conn.execute("SELECT * FROM gusen_effective_source WHERE project_id=? ORDER BY source_table, source_alias_id, fun_id", (project_id,)).fetchall()
    _write_table(out / "effective-source-index.md", "项目 Effective 源码索引", ["类型", "别名", "函数", "生效层", "覆盖产品", "本地路径"], [[r["source_table"], r["source_alias_id"], r["fun_id"], r["effective_layer"], "是" if r["is_override"] else "否", r["effective_local_path"]] for r in rows])
    calls = []
    for row in rows:
        calls.extend(
            conn.execute(
                """
                SELECT * FROM gusen_invoke_call
                WHERE source_layer=? AND product_id=? AND project_id=? AND source_table=? AND source_id=? AND fun_id=?
                ORDER BY source_alias_id, fun_id, line_no
                """,
                (
                    row["effective_layer"],
                    row["product_id"],
                    project_id if row["effective_layer"] == "PROJECT" else "",
                    row["source_table"],
                    row["effective_source_id"],
                    row["fun_id"],
                ),
            ).fetchall()
        )
    _write_table(out / "invoke-index.md", "项目 Effective 调用索引", ["来源层", "来源类型", "来源别名", "来源函数", "脚本位置", "行号", "调用类型", "目标别名", "目标函数", "置信度"], [[c["source_layer"], c["source_table"], c["source_alias_id"], c["fun_id"], c["script_type"], c["line_no"], c["invoke_type"], c["target_alias_id"], c["target_fun_id"], c["confidence"]] for c in calls])


def export_status(conn, stats):
    out = VAR_DIR / "knowledge"
    out.mkdir(parents=True, exist_ok=True)
    lines = ["# 谷神源码 Hub 同步状态", "", f"- 最近生成时间：{_now()}"]
    for key, value in stats.items():
        lines.append(f"- {key}: {value}")
    (out / "source-sync-status.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def create_work_copy(args=None):
    parser = argparse.ArgumentParser()
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument("--project")
    scope.add_argument("--product")
    parser.add_argument("--type", required=True, choices=[PAGE_SOURCE_TYPE, PROCEDURE_SOURCE_TYPE])
    parser.add_argument("--alias", required=True)
    parser.add_argument("--fun", default="")
    parsed = parser.parse_args(args)
    cfg = load_config()
    conn = connect_index(ROOT / cfg["sync"]["sync"]["index_db"])
    row, owner = find_work_copy_source(conn, cfg, parsed.product, parsed.project, parsed.type, parsed.alias, parsed.fun)
    source_path = row["local_path"] if parsed.product else row["effective_local_path"]
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    target = work_copy_dir() / owner / f"{stamp}-{path_part(parsed.alias if not parsed.fun else parsed.fun)}"
    shutil.copytree(ROOT / source_path, target)
    (target / "source-meta.json").write_text(json.dumps(dict(row), ensure_ascii=False, indent=2), encoding="utf-8")
    (target / "diff.md").write_text("# 修改说明\n\n# Diff\n", encoding="utf-8")
    print(target)


def create_work_copy_from_row(conn, cfg, row, product_id, project_id):
    if project_id:
        build_effective(conn, cfg, [project_id])
    found, owner = find_work_copy_source(
        conn,
        cfg,
        product_id=product_id if not project_id else None,
        project_id=project_id,
        source_type=row["source_table"],
        alias=_source_alias_id(row),
        fun=row["fun_id"] or "",
    )
    source_path = found["local_path"] if not project_id else found["effective_local_path"]
    target = work_copy_dir() / owner / _work_copy_source_relative_path(source_path, project_id)
    shutil.copytree(ROOT / source_path, target, dirs_exist_ok=True)
    (target / "source-meta.json").write_text(json.dumps(dict(found), ensure_ascii=False, indent=2), encoding="utf-8")
    (target / "diff.md").write_text("# 修改说明\n\n# Diff\n", encoding="utf-8")
    return target


def _work_copy_source_relative_path(source_path, project_id):
    path = Path(source_path)
    if project_id:
        rel = _path_after_marker(path, ("source", "effective", "project"))
        return Path(*rel.parts[1:])
    return _path_after_marker(path, ("source", "readonly", "products"))


def _path_after_marker(path: Path, marker: tuple[str, ...]) -> Path:
    parts = path.parts
    size = len(marker)
    for index in range(len(parts) - size + 1):
        if parts[index : index + size] == marker:
            return Path(*parts[index + size :])
    raise ValueError(f"Path is not under {'/'.join(marker)}: {path}")


def pull_source_to_work_copy(payload: dict):
    cfg = load_config()
    layer, product_id, project_id, layer_cfg = resolve_pull_scope(cfg, payload)
    rules = cfg["sync"].get("rules") or {}
    conn = connect_index(ROOT / cfg["sync"]["sync"]["index_db"])
    sql, params = single_source_sql(cfg["source_tables"], payload["sourceType"], payload, rules)
    ds = cfg["datasource"]["datasource"][layer_cfg["datasource"]]
    with db_connect(ds) as remote:
        with remote.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone()
            rows = [row] if row else []
            if row and payload["sourceType"] == PAGE_SOURCE_TYPE and row.get("mk_id"):
                module_sql, module_params = module_page_sql(cfg["source_tables"], row, rules)
                cur.execute(module_sql, module_params)
                rows = cur.fetchall()
    if not row:
        allowed = ", ".join(rules.get("allow_unchecked_check_out_user_ids") or []) or "none"
        raise SystemExit(
            "Source not found or filtered. "
            f"type={payload.get('sourceType')}, sourceId={payload.get('sourceId') or ''}, "
            f"alias={payload.get('alias') or ''}, funId={payload.get('funId') or ''}. "
            f"Allowed source must be checked in or checked out by configured users: {allowed}."
        )
    rows = [candidate for candidate in rows if _included(layer_cfg, candidate)]
    if not rows:
        raise SystemExit("Source is outside configured include scope")
    targets = []
    for candidate in rows:
        upsert_source(conn, candidate, layer, product_id, project_id, layer_cfg, cfg["_system_scope"], force=True)
    conn.commit()
    for candidate in rows:
        targets.append(create_work_copy_from_row(conn, cfg, candidate, product_id, project_id))
    conn.commit()
    work_copy_path = os.path.commonpath([str(target) for target in targets])
    return {
        "ok": True,
        "workCopyPath": work_copy_path,
        "pulled": len(targets),
        "source": {key: _str(row.get(key)) for key in ("source_table", "source_id", "source_alias_id", "fun_id", "source_name")},
    }


def resolve_pull_scope(cfg: dict, payload: dict):
    scope = payload.get("scope")
    product_id = payload.get("productId") or ""
    project_id = payload.get("projectId") or ""
    if not scope:
        _active, products, projects, _effective_project_ids = resolve_active(cfg)
        if products:
            product_id, layer_cfg = products[0]
            return "PRODUCT", product_id, "", layer_cfg
        if projects:
            project_id, layer_cfg = projects[0]
            return "PROJECT", layer_cfg["product_id"], project_id, layer_cfg
    if scope == "product":
        layer_cfg = (cfg["products"].get("products") or {}).get(product_id)
        if not layer_cfg:
            raise SystemExit(f"Unknown productId: {product_id}")
        return "PRODUCT", product_id, "", layer_cfg
    elif scope == "project":
        layer_cfg = (cfg["projects"].get("projects") or {}).get(project_id)
        if not layer_cfg:
            raise SystemExit(f"Unknown projectId: {project_id}")
        return "PROJECT", layer_cfg["product_id"], project_id, layer_cfg
    else:
        raise SystemExit("scope must be product or project")


def pull_source_payload_from_args(scope, product_id, project_id, source_type, source_id, alias, fun):
    if not scope:
        if project_id:
            scope = "project"
        elif product_id:
            scope = "product"
    return {
        "scope": scope,
        "productId": product_id,
        "projectId": project_id,
        "sourceType": source_type,
        "sourceId": source_id,
        "alias": alias,
        "funId": fun,
    }


def pull_source_to_work_copy_cli(args=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--json-stdin", action="store_true")
    parser.add_argument("--scope", choices=["product", "project"])
    parser.add_argument("--product-id")
    parser.add_argument("--project-id")
    parser.add_argument("--type", dest="source_type", choices=[PAGE_SOURCE_TYPE, PROCEDURE_SOURCE_TYPE])
    parser.add_argument("--source-id")
    parser.add_argument("--alias")
    parser.add_argument("--fun")
    parsed = parser.parse_args(args)
    if parsed.json_stdin:
        payload = json.loads(sys.stdin.read() or "{}")
    else:
        payload = pull_source_payload_from_args(parsed.scope, parsed.product_id, parsed.project_id, parsed.source_type, parsed.source_id, parsed.alias, parsed.fun)
    result = pull_source_to_work_copy(payload)
    print(json.dumps(result, ensure_ascii=False))


def find_work_copy_source(conn, cfg, product_id, project_id, source_type, alias, fun):
    if product_id:
        row = conn.execute(
            """
            SELECT * FROM gusen_source_record
            WHERE source_layer='PRODUCT' AND product_id=? AND source_table=? AND source_alias_id=? AND fun_id=?
            """,
            (product_id, source_type, alias, fun),
        ).fetchone()
        if not row:
            raise SystemExit("Product source not found. Run sync first.")
        product_name = (cfg["products"].get("products") or {}).get(product_id, {}).get("name") or product_id
        return row, Path("products") / path_part(product_name)
    row = conn.execute(
        """
        SELECT * FROM gusen_effective_source
        WHERE project_id=? AND source_table=? AND source_alias_id=? AND fun_id=?
        """,
        (project_id, source_type, alias, fun),
    ).fetchone()
    if not row:
        raise SystemExit("Effective source not found. Run sync first.")
    project_name = (cfg["projects"].get("projects") or {}).get(project_id, {}).get("name") or project_id
    return row, Path(path_part(project_name))


def _write_table(path, title, headers, rows):
    lines = [f"# {title}", "", "| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"]
    for row in rows:
        lines.append("| " + " | ".join("" if v is None else str(v).replace("\n", " ") for v in row) + " |")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _sync_from(conn, lookback):
    raw = conn.execute("SELECT state_value FROM gusen_sync_state WHERE state_key='last_success_time'").fetchone()
    if not raw:
        return "1970-01-01 00:00:00"
    parsed = dt.datetime.fromisoformat(raw["state_value"])
    return (parsed - dt.timedelta(minutes=lookback)).strftime("%Y-%m-%d %H:%M:%S")


def _flatten_records(value):
    if isinstance(value, list):
        records = []
        for item in value:
            records.extend(_flatten_records(item))
        return records
    if isinstance(value, dict):
        children = []
        for key in ("data", "rows", "records", "items", "children", "list"):
            if key in value:
                children.extend(_flatten_records(value[key]))
        return [value] + children if any(_looks_like_system_key(k) for k in value) else children
    return []


def _looks_like_system_key(key):
    return str(key).upper() in {"SYSTEM_ID", "SYSTEM_CODE", "SYSTEM_ALIAS_ID", "SYS_CODE", "DATA_SOURCE_ID", "DATA_SOURCE_IDS"}


def _values(record, *keys):
    out = set()
    for key in keys:
        value = record.get(key)
        if isinstance(value, list):
            out.update(str(item) for item in value if item not in (None, ""))
        elif value not in (None, ""):
            out.add(str(value))
    return out


def _change_key(row):
    if row.get("version_mac"):
        return f"VERSION:{row['version_mac']}"
    if row.get("check_in_date"):
        return f"CHECK_IN:{_str(row['check_in_date'])}"
    return f"UPDATE_TIME:{_str(row.get('update_time'))}"


def _source_alias_id(row):
    return _str(row.get("source_alias_id")) or _str(row.get("source_id"))


def _link_shared_procedure_dirs(layer_root, system_name, row, scope):
    link_names = scope.get("system_link_names_by_data_source_id", {}).get(_str(row.get("data_source_id")), [])
    target = layer_root / path_part(system_name) / "procedure"
    for link_name in link_names:
        link = layer_root / path_part(link_name) / "procedure"
        if link == target:
            continue
        link.parent.mkdir(parents=True, exist_ok=True)
        if link.is_symlink():
            link.unlink()
        elif link.exists():
            shutil.rmtree(link)
        os.symlink(os.path.relpath(target, link.parent), link, target_is_directory=True)


def _system_name(row, scope):
    if row["source_table"] == PAGE_SOURCE_TYPE:
        return scope.get("system_name_by_id", {}).get(_str(row.get("system_id"))) or _str(row.get("system_id")) or "未归属子系统"
    return scope.get("system_name_by_data_source_id", {}).get(_str(row.get("data_source_id"))) or _str(row.get("data_source_id")) or "未归属子系统"


def _source_table_cfg(config, source_type):
    tables = config.get("source_tables") or {}
    cfg = tables.get(source_type)
    if not cfg:
        raise SystemExit(f"Missing source_tables.{source_type} config")
    return cfg


def _name(value):
    value = str(value or "")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
        raise SystemExit(f"Invalid SQL identifier in source-tables.yaml: {value}")
    return value


def _field(alias, value):
    if not value:
        return "NULL"
    return f"{alias}.{_name(value)}"


def _now():
    return dt.datetime.now().replace(microsecond=0).isoformat(sep=" ")


def safe(value):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or ""))


def path_part(value):
    return re.sub(r'[\\\\/:*?"<>|]+', "_", str(value or "未命名")).strip() or "未命名"


def _str(value):
    if value is None:
        return ""
    return str(value)


if __name__ == "__main__":
    run_sync_once()

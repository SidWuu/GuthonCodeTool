#!/usr/bin/env python3
"""Shared implementation for the Gushen source hub."""

from __future__ import annotations

import argparse
import datetime as dt
import difflib
import hashlib
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
WORK_COPY_BASELINE_DIR = ".guthon-baseline"
WORK_COPY_META_FILE = "source-meta.json"
WORK_COPY_DIFF_FILE = "diff.md"
WORK_COPY_DELIVERY_FILE = "delivery.md"
WORK_COPY_MANAGED_FILES = {WORK_COPY_META_FILE, WORK_COPY_DIFF_FILE, WORK_COPY_DELIVERY_FILE}


def source_dir() -> Path:
    return VAR_DIR / "source"


def readonly_source_dir() -> Path:
    return source_dir() / "readonly"


def pull_log_path() -> Path:
    return Path(os.environ.get("GUTHON_PULL_LOG_PATH") or VAR_DIR / "runtime" / "logs" / "pull-log.ndjson")


def append_pull_log(pull_type, trigger, summary, payload=None, result=None, ok=True, message="") -> Path:
    path = pull_log_path()
    if os.environ.get("GUTHON_SUPPRESS_PULL_LOG") == "1":
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "time": dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S"),
        "trigger": trigger,
        "pullType": pull_type,
        "ok": bool(ok),
        "summary": summary or {},
        "payload": payload or {},
        "result": result or {},
        "message": message or "",
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return path


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
    config["systems"] = config["sync"].get("systems") or {}
    return config


def system_aliases(config: dict):
    return list(dict.fromkeys(str(item).strip() for item in (config.get("systems", {}).get("include") or {}).get("system_aliases", []) if str(item).strip()))


def _build_system_scope(records, selected):
    if not selected:
        return {"system_ids": [], "data_source_ids": []}
    selected_order = {code: index for index, code in enumerate(selected)}
    system_ids = set()
    data_source_ids = set()
    system_name_by_id = {}
    data_source_names = {}
    for record in records:
        alias_values = _values(record, "SYSTEM_ALIAS_ID", "systemAliasId")
        matched = [alias for alias in selected if alias in alias_values]
        if not matched:
            continue
        order = min(selected_order[code] for code in matched)
        ids = _values(record, "SYSTEM_ID", "systemId", "id")
        data_ids = _values(record, "DATA_SOURCE_ID", "DATA_SOURCE_IDS", "dataSourceId", "dataSourceIds")
        name = next(iter(_values(record, "SYSTEM_NAME", "systemName", "name")), "") or next(iter(alias_values), "")
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


def resolve_system_scope(conn, config: dict, datasource_name: str):
    selected = system_aliases(config)
    if not selected:
        return {"system_ids": [], "data_source_ids": []}
    cache_path = CONFIG_DIR / "system-data.json"
    try:
        cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    except (json.JSONDecodeError, OSError):
        cache = {}
    if not isinstance(cache, dict) or not isinstance(cache.get("datasources"), dict):
        cache = {"datasources": {}}
    entry = cache["datasources"].get(datasource_name) or {}
    records = entry.get("systems") if entry.get("system_aliases") == selected else None
    if not records:
        placeholders = ", ".join(["%s"] * len(selected))
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT SYSTEM_ID, SYSTEM_NAME, SYSTEM_ALIAS_ID, DATA_SOURCE_ID FROM gd_system WHERE SYSTEM_ALIAS_ID IN ({placeholders})",
                tuple(selected),
            )
            records = [
                {key: _str(row.get(key)) for key in ("SYSTEM_ID", "SYSTEM_NAME", "SYSTEM_ALIAS_ID", "DATA_SOURCE_ID")}
                for row in cur.fetchall()
            ]
        if not records:
            raise SystemExit("No gd_system rows match systems.include.system_aliases in config/sync.yaml")
        cache["datasources"][datasource_name] = {"system_aliases": selected, "systems": records}
        cache["generated_at"] = _now()
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = cache_path.with_name(f".{cache_path.name}.{os.getpid()}.tmp")
        temp_path.write_text(json.dumps(cache, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temp_path.replace(cache_path)
    scope = _build_system_scope(records, selected)
    if not scope.get("system_ids") or not scope.get("data_source_ids"):
        raise SystemExit(f"Invalid system cache for datasource: {datasource_name}")
    return scope


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
        CREATE TABLE IF NOT EXISTS gusen_sync_state (
            state_key TEXT PRIMARY KEY,
            state_value TEXT
        );
        """
    )
    conn.execute("DROP TABLE IF EXISTS gusen_effective_source")
    conn.execute("DELETE FROM gusen_sync_state WHERE state_key='last_success_time'")
    conn.commit()
    return conn


def find_source_candidates(conn, product_id, keyword, limit=10):
    limit = max(1, min(int(limit), 10))
    query = f"%{keyword.strip()}%"
    return conn.execute(
        """
        SELECT source_layer, project_id, source_table, source_id, source_alias_id, fun_id, source_name, local_path, status
        FROM gusen_source_record
        WHERE product_id=?
          AND (source_id LIKE ? OR source_alias_id LIKE ? OR source_name LIKE ?)
        ORDER BY source_name, source_alias_id, fun_id
        LIMIT ?
        """,
        (product_id, query, query, query, limit),
    ).fetchall()


def query_source_context(conn, product_id, source_id, fun_id="", limit=20):
    limit = max(1, min(int(limit), 20))
    source = conn.execute(
        """
        SELECT * FROM gusen_source_record
        WHERE product_id=? AND source_id=? AND fun_id=?
        ORDER BY source_layer, project_id
        LIMIT 1
        """,
        (product_id, source_id, fun_id),
    ).fetchone()
    if not source:
        raise ValueError(f"Source not found: product={product_id}, sourceId={source_id}, funId={fun_id}")
    identity = (source["source_layer"], source["product_id"], source["project_id"], source["source_table"], source["source_id"], source["fun_id"])
    outgoing = conn.execute(
        """
        SELECT source_table, source_id, source_alias_id, fun_id, script_type, json_path, line_no,
               target_alias_id, target_fun_id, invoke_type, confidence
        FROM gusen_invoke_call
        WHERE source_layer=? AND product_id=? AND project_id=? AND source_table=? AND source_id=? AND fun_id=?
        ORDER BY line_no
        LIMIT ?
        """,
        (*identity, limit),
    ).fetchall()
    incoming = conn.execute(
        """
        SELECT source_layer, source_table, source_id, source_alias_id, fun_id, script_type, json_path, line_no,
               invoke_type, confidence
        FROM gusen_invoke_call
        WHERE product_id=? AND target_alias_id=? AND target_fun_id=?
        ORDER BY source_layer, source_alias_id, fun_id, line_no
        LIMIT ?
        """,
        (product_id, source["source_alias_id"], source["fun_id"], limit),
    ).fetchall()
    dynamic = conn.execute(
        """
        SELECT script_type, json_path, line_no, invoke_expr, reason, confidence
        FROM gusen_dynamic_call
        WHERE source_layer=? AND product_id=? AND project_id=? AND source_table=? AND source_id=? AND fun_id=?
        ORDER BY line_no
        LIMIT ?
        """,
        (*identity, limit),
    ).fetchall()
    return {"source": source, "outgoing": outgoing, "incoming": incoming, "dynamic": dynamic}


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
    mk_order_no = "NULL"
    model_id = "NULL"
    model_name = "NULL"
    model_order_no = "NULL"
    join = ""
    if module_table:
        mk_name = _field("m", cfg["module_name_field"])
        join = f"LEFT JOIN {_name(module_table)} m ON {_field('p', cfg['module_join_field'])} = {_field('m', cfg['module_join_field'])}"
        mk_order_no = _field("m", cfg.get("module_order_field"))
        model_id = _field("m", cfg.get("module_model_field"))
        if cfg.get("model_table_name") and cfg.get("module_model_field") and cfg.get("model_id_field"):
            join += f"\nLEFT JOIN {_name(cfg['model_table_name'])} md ON {model_id} = {_field('md', cfg['model_id_field'])}"
            model_name = _field("md", cfg.get("model_name_field"))
            model_order_no = _field("md", cfg.get("model_order_field"))
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
    {mk_name} AS mk_name,
    {mk_order_no} AS mk_order_no,
    {model_id} AS model_id,
    {model_name} AS model_name,
    {model_order_no} AS model_order_no
FROM {_name(cfg['source_table_name'])} p
{join}
"""


def page_inventory_sql(table_cfg: dict):
    cfg = _source_table_cfg(table_cfg, PAGE_SOURCE_TYPE)
    return f"""
SELECT
    '{PAGE_SOURCE_TYPE}' AS source_table,
    {_field('p', cfg['id_field'])} AS source_id,
    {_field('p', cfg['alias_field'])} AS source_alias_id
FROM {_name(cfg['source_table_name'])} p
WHERE 1=1
  {{system_filter}}
"""


def _build_model_paths(rows):
    nodes = {
        _str(row.get("model_id")): {
            "model_id": _str(row.get("model_id")),
            "model_name": _str(row.get("model_name")),
            "model_order_no": row.get("model_order_no"),
            "parent_model_id": _str(row.get("parent_model_id")),
        }
        for row in rows
        if row.get("model_id")
    }
    paths = {}
    for model_id in nodes:
        path = []
        current = model_id
        seen = set()
        while current and current in nodes and current not in seen:
            seen.add(current)
            path.append(nodes[current])
            current = nodes[current]["parent_model_id"]
        paths[model_id] = list(reversed(path))
    return paths


def load_model_paths(remote, table_cfg: dict):
    cfg = _source_table_cfg(table_cfg, PAGE_SOURCE_TYPE)
    required = ("model_table_name", "model_id_field", "model_name_field", "model_parent_field")
    if not all(cfg.get(key) for key in required):
        return {}
    with remote.cursor() as cur:
        cur.execute(
            f"""
SELECT
    {_field('md', cfg['model_id_field'])} AS model_id,
    {_field('md', cfg['model_name_field'])} AS model_name,
    {_field('md', cfg.get('model_order_field'))} AS model_order_no,
    {_field('md', cfg['model_parent_field'])} AS parent_model_id
FROM {_name(cfg['model_table_name'])} md
"""
        )
        return _build_model_paths(cur.fetchall())


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
    {_field('s', cfg.get('product_content_field'))} AS product_source_content,
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
    {_field('s', cfg.get('product_content_field'))} AS product_source_content,
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
    index_path = active_index_path(cfg)
    index_name = str(index_path.relative_to(ROOT))
    conn = connect_index(index_path)
    if parsed.init_only:
        active, _products, _projects = resolve_active(cfg)
        export_status(conn, {"mode": "init-only", "active": active, "changed": 0, "candidates": 0, "failures": 0})
        export_knowledge_readme(conn, index_name, active)
        return

    lookback = int(sync.get("lookback_minutes", 10))
    active, products, projects = resolve_active(cfg)
    state_key = f"last_success_time:{active}"
    sync_from = _sync_from(conn, lookback, state_key)
    stats = {"mode": "sync", "active": active, "sync_from": sync_from, "candidates": 0, "changed": 0, "deleted": 0, "failures": 0}
    for product_id, product in products:
        stats = _sync_layer(conn, cfg, product, "PRODUCT", product_id, "", sync_from, stats)
    for project_id, project in projects:
        stats = _sync_layer(conn, cfg, project, "PROJECT", project["product_id"], project_id, sync_from, stats)
    conn.execute(
        "INSERT OR REPLACE INTO gusen_sync_state(state_key, state_value) VALUES(?, ?)",
        (state_key, _now()),
    )
    conn.commit()
    export_status(conn, stats)
    export_knowledge_readme(conn, index_name, active)
    append_pull_log(
        "source",
        "scheduled",
        {
            "active": active,
            "candidates": stats.get("candidates", 0),
            "changed": stats.get("changed", 0),
            "deleted": stats.get("deleted", 0),
            "failures": stats.get("failures", 0),
        },
        payload={"sync_from": sync_from},
        result=stats,
        ok=not stats.get("failures"),
    )


def resolve_active(cfg):
    sync = cfg["sync"]["sync"]
    active = sync.get("ACTIVE") or sync.get("active")
    if not active:
        raise SystemExit("Missing sync.ACTIVE. Use products.<product_id> or projects.<project_id>.")
    kind, _, item_id = str(active).partition(".")
    if kind == "products":
        product = (cfg["products"].get("products") or {}).get(item_id)
        if product:
            return active, [(item_id, product)], []
    if kind == "projects":
        project = (cfg["projects"].get("projects") or {}).get(item_id)
        if project:
            return active, [], [(item_id, project)]
    raise SystemExit(f"Invalid sync.ACTIVE: {active}")


def active_index_path(cfg):
    active, _products, _projects = resolve_active(cfg)
    kind, _, item_id = active.partition(".")
    index_dir = cfg["sync"]["sync"].get("index_dir")
    if not index_dir:
        raise SystemExit("Missing sync.index_dir.")
    return ROOT / index_dir / kind / f"{path_part(item_id)}.db"


def resolve_datasource(cfg, name=None):
    if not name:
        _active, products, projects = resolve_active(cfg)
        _item_id, item = (products or projects)[0]
        name = item.get("datasource")
    datasource = (cfg["datasource"].get("datasource") or {}).get(name)
    if not datasource:
        raise SystemExit(f"Unknown datasource: {name}")
    return name, datasource


def _sync_layer(conn, cfg, layer_cfg, layer, product_id, project_id, sync_from, stats):
    ds_name = layer_cfg["datasource"]
    ds = cfg["datasource"]["datasource"][ds_name]
    table_cfg = cfg["source_tables"]
    rules = cfg["sync"].get("rules") or {}
    with db_connect(ds) as remote:
        system_scope = resolve_system_scope(remote, cfg, ds_name)
        page_query, page_params = _scoped_sql(page_sql(table_cfg, rules), system_scope, "system", table_cfg)
        inventory_query, inventory_params = _scoped_sql(page_inventory_sql(table_cfg), system_scope, "system", table_cfg)
        proc_query, proc_params = _scoped_sql(proc_sql(table_cfg, rules), system_scope, "data_source", table_cfg)
        model_paths = load_model_paths(remote, table_cfg)
        with remote.cursor() as cur:
            for sql, extra_params in ((page_query, page_params), (proc_query, proc_params)):
                cur.execute(sql, (sync_from, sync_from, *extra_params))
                for row in cur.fetchall():
                    stats["candidates"] += 1
                    if not _included(layer_cfg, row):
                        continue
                    if row["source_table"] == PAGE_SOURCE_TYPE:
                        row["model_path"] = model_paths.get(_str(row.get("model_id")))
                    if upsert_source(conn, row, layer, product_id, project_id, layer_cfg, system_scope):
                        stats["changed"] += 1
            cur.execute(inventory_query, inventory_params)
            current_page_ids = {row["source_id"] for row in cur.fetchall() if _included(layer_cfg, row)}
        stats["deleted"] = stats.get("deleted", 0) + reconcile_deleted_pages(conn, layer, product_id, project_id, current_page_ids)
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
        SELECT change_key, local_path FROM gusen_source_record
        WHERE source_layer=? AND product_id=? AND project_id=? AND source_table=? AND source_id=? AND fun_id=?
        """,
        (layer, product_id, project_id, row["source_table"], row["source_id"], row["fun_id"] or ""),
    ).fetchone()
    desired_path = source_base(row, layer, product_id, project_id, layer_cfg, system_scope)
    if existing and existing["change_key"] == change_key and not force:
        indexed_path = ROOT / existing["local_path"] if existing["local_path"] else None
        if indexed_path == desired_path and desired_path.exists():
            return False
    local_path, status, scripts = write_source(row, layer, product_id, project_id, layer_cfg, system_scope, change_key)
    if existing and existing["local_path"]:
        old_path = ROOT / existing["local_path"]
        if old_path != local_path:
            remove_source_path(old_path)
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


def remove_source_path(path: Path):
    root = readonly_source_dir().resolve()
    target = path.resolve()
    if target == root or root not in target.parents:
        raise ValueError(f"Refusing to remove path outside readonly source: {path}")
    if target.exists():
        shutil.rmtree(target)
    page_root = next((parent for parent in target.parents if parent.name == "page"), None)
    parent = target.parent
    while page_root and parent != page_root:
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent


def reconcile_deleted_pages(conn, layer, product_id, project_id, current_page_ids):
    rows = conn.execute(
        """
        SELECT source_id, local_path FROM gusen_source_record
        WHERE source_layer=? AND product_id=? AND project_id=? AND source_table=?
        """,
        (layer, product_id, project_id, PAGE_SOURCE_TYPE),
    ).fetchall()
    stale = [row for row in rows if row["source_id"] not in current_page_ids]
    for row in stale:
        if row["local_path"]:
            remove_source_path(ROOT / row["local_path"])
        identity = (layer, product_id, project_id, PAGE_SOURCE_TYPE, row["source_id"], "")
        conn.execute(
            "DELETE FROM gusen_invoke_call WHERE source_layer=? AND product_id=? AND project_id=? AND source_table=? AND source_id=? AND fun_id=?",
            identity,
        )
        conn.execute(
            "DELETE FROM gusen_dynamic_call WHERE source_layer=? AND product_id=? AND project_id=? AND source_table=? AND source_id=? AND fun_id=?",
            identity,
        )
        conn.execute(
            "DELETE FROM gusen_source_record WHERE source_layer=? AND product_id=? AND project_id=? AND source_table=? AND source_id=? AND fun_id=?",
            identity,
        )
    return len(stale)


def source_base(row, layer, product_id, project_id, layer_cfg, system_scope):
    system_name = _system_name(row, system_scope)
    if layer == "PRODUCT":
        layer_root = readonly_source_dir() / "products" / path_part(product_id)
    else:
        layer_root = readonly_source_dir() / "project" / path_part(layer_cfg.get("name") or project_id)
    root = layer_root / path_part(system_name)
    if row["source_table"] == PAGE_SOURCE_TYPE:
        module_name = row.get("mk_name") or row.get("mk_id") or "未归属模块"
        module_dir = path_part(f"{order_part(row.get('mk_order_no'))}_{module_name}")
        model_path = row.get("model_path") or [
            {
                "model_name": row.get("model_name") or row.get("model_id") or "未归属模型",
                "model_order_no": row.get("model_order_no"),
            }
        ]
        base = root / "page"
        for model in model_path:
            base /= path_part(f"{order_part(model.get('model_order_no'))}_{model.get('model_name') or model.get('model_id') or '未归属模型'}")
        return base / module_dir / path_part(f"{row.get('source_name') or row['source_alias_id']} {row['source_id']}")
    else:
        return root / "procedure" / path_part(row["source_alias_id"]) / path_part(row["fun_id"])


def write_source(row, layer, product_id, project_id, layer_cfg, system_scope, change_key):
    base = source_base(row, layer, product_id, project_id, layer_cfg, system_scope)
    if row["source_table"] != PAGE_SOURCE_TYPE:
        system_name = _system_name(row, system_scope)
        layer_root = readonly_source_dir() / "products" / path_part(product_id) if layer == "PRODUCT" else readonly_source_dir() / "project" / path_part(layer_cfg.get("name") or project_id)
        _link_shared_procedure_dirs(layer_root, system_name, row, system_scope)
    if base.exists():
        shutil.rmtree(base)
    base.mkdir(parents=True, exist_ok=True)
    content = _resolve_inherited_script(row.get("source_content") or "", row.get("product_source_content") or "")
    status = "OK" if content else "EMPTY_CONTENT"
    meta = {
        key: _str(value)
        for key, value in row.items()
        if key not in ("source_content", "product_source_content", "model_path")
    }
    meta.update({"change_key": change_key, "status": status})
    (base / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    scripts = []
    if row["source_table"] == PAGE_SOURCE_TYPE:
        if not content:
            return base, status, scripts
        (base / "raw.json").write_text(content, encoding="utf-8")
        scripts = parse_page_scripts(base, content)
    else:
        script_path = base / "source.vm"
        script_path.write_text(content, encoding="utf-8")
        scripts = [("procedure_script", script_path, content)]
    (base / "README.md").write_text(f"# {_source_alias_id(row)}\n\n- status: {status}\n", encoding="utf-8")
    return base, status, scripts


SCRIPT_KEYS = {
    "script",
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


def _is_script_key(key):
    return key != "superScript" and (key in SCRIPT_KEYS or str(key).endswith("Script"))


INHERIT_MARKER = re.compile(r"(?m)^[ \t]*(?:return[ \t]+)?@?inherit\(\);[ \t]*\r?$")
EVENT_SUPERS = {"serviceEvents": "superServiceEvents", "pageEvents": "superPageEvents"}


def _resolve_inherited_script(script, inherited):
    if not INHERIT_MARKER.search(script):
        return script
    resolved = inherited.rstrip("\r\n")
    return INHERIT_MARKER.sub(lambda _match: resolved, script)


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
        ext = "sql" if key == "sql" else ("vm" if "SaveScript" in key or key in {"script", "doMethodScript", "compScript"} else "js")
        name = path_part(".".join(path[-2:] + [key])) if path else path_part(key)
        script_path = out_dir / f"{name}.{ext}"
        script_path.write_text(value, encoding="utf-8")
        scripts.append((key, script_path, value))
    return scripts


def _walk_scripts(value, path=None, inherited_scripts=None):
    path = path or []
    if isinstance(value, dict):
        label = str(value.get("aliasName") or value.get("name") or value.get("id") or "")
        next_path = path + ([label] if label else [])
        for key, child in value.items():
            if _is_script_key(key) and isinstance(child, str) and (child.strip() or key == "compScript"):
                inherited = (inherited_scripts or {}).get(key, "")
                if key == "script":
                    inherited = value.get("superScript", "")
                resolved = _resolve_inherited_script(child, inherited if isinstance(inherited, str) else "")
                if resolved.strip() or (key == "compScript" and not child.strip()):
                    yield next_path, key, resolved
            elif key in EVENT_SUPERS.values():
                continue
            else:
                inherited = value.get(EVENT_SUPERS.get(key, ""), {})
                yield from _walk_scripts(child, next_path, inherited if isinstance(inherited, dict) else None)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_scripts(child, path, inherited_scripts)


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
    (out / "effective-source-index.md").unlink(missing_ok=True)
    rows = conn.execute(
        "SELECT * FROM gusen_source_record WHERE source_layer='PROJECT' AND project_id=? ORDER BY source_table, source_alias_id, fun_id",
        (project_id,),
    ).fetchall()
    _write_table(out / "source-index.md", "项目源码索引", ["类型", "别名", "函数", "本地路径"], [[r["source_table"], r["source_alias_id"], r["fun_id"], r["local_path"]] for r in rows])
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
                    "PROJECT",
                    row["product_id"],
                    project_id,
                    row["source_table"],
                    row["source_id"],
                    row["fun_id"],
                ),
            ).fetchall()
        )
    _write_table(out / "invoke-index.md", "项目调用索引", ["来源层", "来源类型", "来源别名", "来源函数", "脚本位置", "行号", "调用类型", "目标别名", "目标函数", "置信度"], [[c["source_layer"], c["source_table"], c["source_alias_id"], c["fun_id"], c["script_type"], c["line_no"], c["invoke_type"], c["target_alias_id"], c["target_fun_id"], c["confidence"]] for c in calls])


def export_status(conn, stats):
    out = VAR_DIR / "knowledge"
    out.mkdir(parents=True, exist_ok=True)
    lines = ["# 谷神源码 Hub 同步状态", "", f"- 最近生成时间：{_now()}"]
    for key, value in stats.items():
        lines.append(f"- {key}: {value}")
    (out / "source-sync-status.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def export_knowledge_readme(conn, index_db, active):
    out = VAR_DIR / "knowledge"
    out.mkdir(parents=True, exist_ok=True)
    source_count = conn.execute("SELECT COUNT(*) FROM gusen_source_record").fetchone()[0]
    call_count = conn.execute("SELECT COUNT(*) FROM gusen_invoke_call").fetchone()[0]
    dynamic_count = conn.execute("SELECT COUNT(*) FROM gusen_dynamic_call").fetchone()[0]
    lines = [
        "# 谷神源码知识入口",
        "",
        f"- 当前索引：`{index_db}`",
        f"- 当前范围：`{active}`",
        f"- 源码对象数：{source_count}",
        f"- 静态调用数：{call_count}",
        f"- 动态调用点数：{dynamic_count}",
        "",
        "AI 开发先查询 SQLite 局部上下文，不读取全量 Markdown 索引：",
        "",
        "```bash",
        "python scripts/query_hub_context.py find <关键字>",
        "python scripts/query_hub_context.py context --source-id <ID> --fun <函数名>",
        "```",
        "",
        "全量 Markdown 仅在显式运行 `scripts/export_hub_markdown.py` 时生成；默认使用上述 SQLite 局部查询。",
    ]
    path = out / "README.md"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def _row_value(row, key, default=""):
    if row is None:
        return default
    if isinstance(row, dict):
        return row.get(key, default)
    return row[key] if key in row.keys() else default


def _work_copy_change_key(row):
    return _str(_row_value(row, "change_key"))


def _tree_files(root: Path, exclude_work_copy_files=False):
    if not root or not root.exists():
        return {}
    files = {}
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        if exclude_work_copy_files and (rel.parts[0] == WORK_COPY_BASELINE_DIR or rel.as_posix() in WORK_COPY_MANAGED_FILES):
            continue
        files[rel.as_posix()] = path
    return files


def _tree_digest(root: Path, exclude_work_copy_files=False):
    digest = hashlib.sha256()
    for rel, path in sorted(_tree_files(root, exclude_work_copy_files).items()):
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _tree_changes(before: Path, after: Path, after_is_work_copy=False):
    before_files = _tree_files(before)
    after_files = _tree_files(after, after_is_work_copy)
    changes = []
    for rel in sorted(set(before_files) | set(after_files)):
        if rel not in before_files:
            status = "A"
        elif rel not in after_files:
            status = "D"
        elif before_files[rel].read_bytes() != after_files[rel].read_bytes():
            status = "M"
        else:
            continue
        changes.append({"status": status, "path": rel})
    return changes


def _local_changes_are_upstream(target: Path, upstream: Path, changes: list[dict]):
    upstream_files = _tree_files(upstream)
    local_files = _tree_files(target, exclude_work_copy_files=True)
    return all(
        (change["path"] not in local_files and change["path"] not in upstream_files)
        or (
            change["path"] in local_files
            and change["path"] in upstream_files
            and local_files[change["path"]].read_bytes() == upstream_files[change["path"]].read_bytes()
        )
        for change in changes
    )


def _work_copy_metadata(target: Path):
    path = target / WORK_COPY_META_FILE
    if not path.exists():
        raise SystemExit(f"工作副本缺少 {WORK_COPY_META_FILE}: {target}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"工作副本元数据无效: {path}: {exc}") from exc


def _display_path(path: Path):
    try:
        return str(path.resolve().relative_to(ROOT))
    except ValueError:
        return str(path.resolve())


def _write_work_copy_metadata(target: Path, row, source_path: Path, change_key: str, mode: str):
    old = {}
    meta_path = target / WORK_COPY_META_FILE
    if meta_path.exists():
        try:
            old = json.loads(meta_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            old = {}
    old_work_copy = old.get("_workcopy") or {}
    metadata = dict(row)
    metadata["_workcopy"] = {
        "format": 1,
        "mode": mode,
        "createdAt": old_work_copy.get("createdAt") or _now(),
        "updatedAt": _now(),
        "sourcePath": _display_path(source_path),
        "baselineChangeKey": change_key,
        "baselineDigest": _tree_digest(target / WORK_COPY_BASELINE_DIR),
    }
    meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _copy_work_copy_baseline(source_path: Path, target: Path):
    baseline = target / WORK_COPY_BASELINE_DIR
    if baseline.exists():
        shutil.rmtree(baseline)
    shutil.copytree(source_path, baseline)


def _replace_work_copy_source(source_path: Path, target: Path):
    for child in target.iterdir():
        if child.name in WORK_COPY_MANAGED_FILES or child.name == WORK_COPY_BASELINE_DIR:
            continue
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()
    shutil.copytree(source_path, target, dirs_exist_ok=True)


def _manual_diff_notes(target: Path):
    path = target / WORK_COPY_DIFF_FILE
    if not path.exists():
        return ""
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "# 修改说明":
        return ""
    notes = []
    for line in lines[1:]:
        if line.startswith("# "):
            break
        notes.append(line)
    return "\n".join(notes).strip()


def _json_path_changes(before, after, path="$", output=None, limit=200):
    output = [] if output is None else output
    if len(output) >= limit:
        return output
    if isinstance(before, dict) and isinstance(after, dict):
        for key in sorted(set(before) | set(after)):
            child = f"{path}.{key}"
            if key not in before:
                output.append(f"A {child}")
            elif key not in after:
                output.append(f"D {child}")
            else:
                _json_path_changes(before[key], after[key], child, output, limit)
            if len(output) >= limit:
                break
    elif isinstance(before, list) and isinstance(after, list):
        if len(before) != len(after):
            output.append(f"M {path}.length ({len(before)} -> {len(after)})")
        for index, (left, right) in enumerate(zip(before, after)):
            _json_path_changes(left, right, f"{path}[{index}]", output, limit)
            if len(output) >= limit:
                break
    elif before != after:
        output.append(f"M {path}")
    return output


def _render_file_diff(before: Path, after: Path, rel: str):
    if rel == "raw.json" and (not before.exists() or not after.exists()):
        return ["JSON 文件新增。" if after.exists() else "JSON 文件删除。"]
    if rel == "raw.json" and before.exists() and after.exists():
        try:
            changes = _json_path_changes(
                json.loads(before.read_text(encoding="utf-8")),
                json.loads(after.read_text(encoding="utf-8")),
            )
            lines = ["JSON 路径变化：", ""] + [f"    {line}" for line in changes]
            if len(changes) == 200:
                lines.append("    ... 仅展示前 200 个路径")
            return lines
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            pass
    try:
        before_lines = before.read_text(encoding="utf-8").splitlines() if before.exists() else []
        after_lines = after.read_text(encoding="utf-8").splitlines() if after.exists() else []
    except UnicodeDecodeError:
        return ["二进制文件发生变化。"]
    diff = list(
        difflib.unified_diff(
            before_lines,
            after_lines,
            fromfile=f"baseline/{rel}",
            tofile=f"workcopy/{rel}",
            lineterm="",
        )
    )
    # ponytail: reports cap each file at 400 lines; inspect the source file directly when a larger diff matters.
    rendered = [f"    {line}" for line in diff[:400]]
    if len(diff) > 400:
        rendered.append(f"    ... 已省略 {len(diff) - 400} 行")
    return rendered or ["文件内容发生变化。"]


def _work_copy_state(target: Path, upstream_path: Path | None, upstream_change_key=""):
    metadata = _work_copy_metadata(target)
    work_copy = metadata.get("_workcopy") or {}
    baseline = target / WORK_COPY_BASELINE_DIR
    if not baseline.exists():
        raise SystemExit(f"旧版工作副本没有基线，拒绝覆盖: {target}")
    baseline_digest = _str(work_copy.get("baselineDigest"))
    if baseline_digest and baseline_digest != _tree_digest(baseline):
        raise SystemExit(f"工作副本基线已被修改，拒绝继续: {baseline}")
    local_changes = _tree_changes(baseline, target, after_is_work_copy=True)
    upstream_missing = not upstream_path or not upstream_path.exists()
    upstream_changes = [] if upstream_missing else _tree_changes(baseline, upstream_path)
    baseline_change_key = _str(work_copy.get("baselineChangeKey"))
    upstream_changed = upstream_missing or bool(upstream_changes) or bool(
        upstream_change_key and upstream_change_key != baseline_change_key
    )
    if upstream_missing:
        state = "UPSTREAM_MISSING"
    elif local_changes and upstream_changed:
        state = "CONFLICT"
    elif local_changes:
        state = "LOCAL_CHANGED"
    elif upstream_changed:
        state = "UPSTREAM_CHANGED"
    else:
        state = "CLEAN"
    return {
        "path": str(target),
        "state": state,
        "localChanged": bool(local_changes),
        "upstreamChanged": upstream_changed,
        "upstreamMissing": upstream_missing,
        "baselineChangeKey": baseline_change_key,
        "upstreamChangeKey": upstream_change_key,
        "localChanges": local_changes,
        "upstreamChanges": upstream_changes,
    }


def _write_work_copy_diff(target: Path, status: dict, notes=""):
    labels = {
        "CLEAN": "无变化",
        "LOCAL_CHANGED": "仅本地有修改",
        "UPSTREAM_CHANGED": "仅上游有变化",
        "CONFLICT": "本地与上游均有变化",
        "UPSTREAM_MISSING": "上游源码不存在",
    }
    lines = [
        "# 修改说明",
        "",
        notes,
        "",
        "# Workcopy 状态",
        "",
        f"- 状态：`{status['state']}`（{labels[status['state']]}）",
        f"- 基线版本：`{status['baselineChangeKey'] or '-'}`",
        f"- 上游版本：`{status['upstreamChangeKey'] or '-'}`",
        f"- 本地变更文件：{len(status['localChanges'])}",
        f"- 上游变更文件：{len(status['upstreamChanges'])}",
        "",
        "# 本地文件汇总",
        "",
    ]
    if status["localChanges"]:
        lines.extend(f"- `{change['status']}` `{change['path']}`" for change in status["localChanges"])
    else:
        lines.append("- 无")
    lines.extend(["", "# 上游文件汇总", ""])
    if status["upstreamChanges"]:
        lines.extend(f"- `{change['status']}` `{change['path']}`" for change in status["upstreamChanges"])
    else:
        lines.append("- 无")
    lines.extend(["", "# Diff", ""])
    baseline = target / WORK_COPY_BASELINE_DIR
    for change in status["localChanges"]:
        rel = change["path"]
        lines.extend([f"## {change['status']} `{rel}`", ""])
        lines.extend(_render_file_diff(baseline / rel, target / rel, rel))
        lines.append("")
    if not status["localChanges"]:
        lines.append("无本地源码差异。")
    (target / WORK_COPY_DIFF_FILE).write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def _write_work_copy_delivery(target: Path, status: dict):
    lines = [
        "# Workcopy 交付清单",
        "",
        f"- 状态：`{status['state']}`",
        f"- 基线版本：`{status['baselineChangeKey'] or '-'}`",
        f"- 上游版本：`{status['upstreamChangeKey'] or '-'}`",
        "",
    ]
    if status["state"] in {"CONFLICT", "UPSTREAM_MISSING"}:
        lines.extend(["> 当前状态不可直接交付，请先处理上游变化。", ""])
    lines.extend(["## 需要回写或复核的文件", ""])
    if status["localChanges"]:
        lines.extend(f"- [ ] `{change['status']}` `{change['path']}`" for change in status["localChanges"])
    else:
        lines.append("- 无本地修改")
    lines.extend(
        [
            "",
            "## 交付检查",
            "",
            "- [ ] 已查看 `diff.md`",
            "- [ ] 已在谷神开发平台完成手工回写",
            "- [ ] 已重新拉取并确认上游版本",
        ]
    )
    path = target / WORK_COPY_DELIVERY_FILE
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def _initialize_work_copy(source_path: Path, target: Path, row, change_key: str, mode: str):
    shutil.copytree(source_path, target)
    _copy_work_copy_baseline(source_path, target)
    _write_work_copy_metadata(target, row, source_path, change_key, mode)
    status = _work_copy_state(target, source_path, change_key)
    status["action"] = "CREATED"
    _write_work_copy_diff(target, status)
    return status


def _prepare_work_copy(source_path: Path, target: Path, row, change_key: str, mode="mirror"):
    if not target.exists():
        return _initialize_work_copy(source_path, target, row, change_key, mode)
    baseline = target / WORK_COPY_BASELINE_DIR
    if not baseline.exists():
        if _tree_changes(source_path, target, after_is_work_copy=True):
            raise SystemExit(f"旧版工作副本没有基线且存在修改，拒绝覆盖: {target}")
        _copy_work_copy_baseline(source_path, target)
        _write_work_copy_metadata(target, row, source_path, change_key, mode)
    notes = _manual_diff_notes(target)
    status = _work_copy_state(target, source_path, change_key)
    if status["localChanged"] and status["upstreamChanged"] and _local_changes_are_upstream(
        target, source_path, status["localChanges"]
    ):
        status["localChanged"] = False
    if status["localChanged"]:
        status["action"] = "CONFLICT" if status["upstreamChanged"] else "PRESERVED"
        _write_work_copy_diff(target, status, notes)
        if status["upstreamChanged"]:
            raise SystemExit(
                f"工作副本与上游均有变化，已拒绝覆盖: {target}\n"
                f"查看差异: {target / WORK_COPY_DIFF_FILE}"
            )
        return status
    if status["upstreamChanged"]:
        _replace_work_copy_source(source_path, target)
        _copy_work_copy_baseline(source_path, target)
        _write_work_copy_metadata(target, row, source_path, change_key, mode)
        status = _work_copy_state(target, source_path, change_key)
        status["action"] = "UPDATED"
    else:
        status["action"] = "UNCHANGED"
    _write_work_copy_diff(target, status, notes)
    return status


def _current_work_copy_source(metadata: dict):
    cfg = load_config()
    conn = connect_index(active_index_path(cfg))
    source_type = metadata.get("source_table") or ""
    alias = metadata.get("source_alias_id") or ""
    fun = metadata.get("fun_id") or ""
    project_id = metadata.get("project_id") or ""
    if project_id:
        row = conn.execute(
            """
            SELECT * FROM gusen_source_record
            WHERE source_layer='PROJECT' AND project_id=? AND source_table=? AND source_alias_id=? AND fun_id=?
            """,
            (project_id, source_type, alias, fun),
        ).fetchone()
        if not row:
            return None, None, ""
        path = ROOT / row["local_path"]
        return row, path, _work_copy_change_key(row)
    row = conn.execute(
        """
        SELECT * FROM gusen_source_record
        WHERE source_layer='PRODUCT' AND product_id=? AND source_table=? AND source_alias_id=? AND fun_id=?
        """,
        (metadata.get("product_id") or "", source_type, alias, fun),
    ).fetchone()
    if not row:
        return None, None, ""
    path = ROOT / row["local_path"]
    return row, path, _work_copy_change_key(row)


def inspect_work_copy(path):
    target = Path(path).expanduser()
    target = target if target.is_absolute() else ROOT / target
    target = target.resolve()
    root = work_copy_dir().resolve()
    if target != root and root not in target.parents:
        raise SystemExit(f"路径不在 workcopy 目录下: {target}")
    while target != root and not (target / WORK_COPY_META_FILE).exists():
        target = target.parent
    if not (target / WORK_COPY_META_FILE).exists():
        raise SystemExit(f"未找到工作副本元数据: {path}")
    metadata = _work_copy_metadata(target)
    _row, source_path, change_key = _current_work_copy_source(metadata)
    return target, _work_copy_state(target, source_path, change_key)


def work_copy_cli(args=None):
    parser = argparse.ArgumentParser(description="检查和打包 Guthon workcopy")
    parser.add_argument("command", choices=["status", "diff", "package"])
    parser.add_argument("path")
    parser.add_argument("--json", action="store_true")
    parsed = parser.parse_args(args)
    target, status = inspect_work_copy(parsed.path)
    output = None
    if parsed.command in {"diff", "package"}:
        _write_work_copy_diff(target, status, _manual_diff_notes(target))
        output = target / WORK_COPY_DIFF_FILE
    if parsed.command == "package":
        output = _write_work_copy_delivery(target, status)
    result = {**status, "output": str(output) if output else ""}
    if parsed.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    print(f"状态: {status['state']}")
    print(f"本地变更: {len(status['localChanges'])}")
    print(f"上游变更: {len(status['upstreamChanges'])}")
    print(f"基线版本: {status['baselineChangeKey'] or '-'}")
    print(f"上游版本: {status['upstreamChangeKey'] or '-'}")
    if output:
        print(f"输出: {output}")


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
    layer, product_id, project_id, _layer_cfg = resolve_pull_scope(
        cfg,
        {"scope": "product" if parsed.product else "project", "productId": parsed.product, "projectId": parsed.project},
    )
    conn = connect_index(active_index_path(cfg))
    row, owner = find_work_copy_source(conn, cfg, product_id if layer == "PRODUCT" else None, project_id or None, parsed.type, parsed.alias, parsed.fun)
    source_path = ROOT / row["local_path"]
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    target = work_copy_dir() / owner / f"{stamp}-{path_part(parsed.alias if not parsed.fun else parsed.fun)}"
    _initialize_work_copy(source_path, target, row, _work_copy_change_key(row), "snapshot")
    print(target)


def create_work_copy_from_row(conn, cfg, row, product_id, project_id):
    found, owner = find_work_copy_source(
        conn,
        cfg,
        product_id=product_id if not project_id else None,
        project_id=project_id,
        source_type=row["source_table"],
        alias=_source_alias_id(row),
        fun=row["fun_id"] or "",
    )
    source_rel = found["local_path"]
    source_path = ROOT / source_rel
    target = work_copy_dir() / owner / _work_copy_source_relative_path(source_rel, product_id, project_id)
    return _prepare_work_copy(source_path, target, found, _work_copy_change_key(found))


def _work_copy_source_relative_path(source_path, product_id, project_id):
    path = Path(source_path)
    marker = ("source", "readonly", "project") if project_id else ("source", "readonly", "products")
    rel = _path_after_marker(path, marker)
    if project_id or (rel.parts and rel.parts[0] == path_part(product_id)):
        return Path(*rel.parts[1:])
    return rel


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
    conn = connect_index(active_index_path(cfg))
    sql, params = single_source_sql(cfg["source_tables"], payload["sourceType"], payload, rules)
    ds_name = layer_cfg["datasource"]
    ds = cfg["datasource"]["datasource"][ds_name]
    with db_connect(ds) as remote:
        system_scope = resolve_system_scope(remote, cfg, ds_name)
        model_paths = load_model_paths(remote, cfg["source_tables"]) if payload["sourceType"] == PAGE_SOURCE_TYPE else {}
        with remote.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone()
            rows = [row] if row else []
    if row and row["source_table"] == PAGE_SOURCE_TYPE:
        row["model_path"] = model_paths.get(_str(row.get("model_id")))
    if not row:
        if project_id:
            found, _owner = find_work_copy_source(
                conn, cfg, None, project_id, payload["sourceType"], payload.get("alias") or payload.get("sourceId") or "", payload.get("funId") or ""
            )
            work_result = create_work_copy_from_row(conn, cfg, found, product_id, project_id)
            return {
                "ok": True,
                "changed": False,
                "message": "拉取成功, 已保留本地修改" if work_result["localChanged"] else "拉取成功, 无变更",
                "workCopyPath": work_result["path"],
                "workCopyStatus": work_result["state"],
                "workCopyAction": work_result["action"],
                "localChanged": work_result["localChanged"],
                "pulled": 1,
                "source": {key: _str(found[key]) if key in found.keys() else "" for key in ("source_table", "source_id", "source_alias_id", "fun_id", "source_name")},
            }
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
    work_results = []
    changed = False
    for candidate in rows:
        changed = upsert_source(conn, candidate, layer, product_id, project_id, layer_cfg, system_scope, force=bool(payload.get("force"))) or changed
    conn.commit()
    for candidate in rows:
        work_results.append(create_work_copy_from_row(conn, cfg, candidate, product_id, project_id))
    conn.commit()
    work_copy_path = os.path.commonpath([result["path"] for result in work_results])
    local_changed = any(result["localChanged"] for result in work_results)
    return {
        "ok": True,
        "changed": changed,
        "message": "拉取成功, 已保留本地修改" if local_changed else "拉取成功" if changed else "拉取成功, 无变更",
        "workCopyPath": work_copy_path,
        "workCopyStatus": work_results[0]["state"] if len(work_results) == 1 else "MULTIPLE",
        "workCopyAction": work_results[0]["action"] if len(work_results) == 1 else "MULTIPLE",
        "localChanged": local_changed,
        "pulled": len(work_results),
        "source": {key: _str(row.get(key)) for key in ("source_table", "source_id", "source_alias_id", "fun_id", "source_name")},
    }


def resolve_pull_scope(cfg: dict, payload: dict):
    scope = payload.get("scope")
    product_id = payload.get("productId") or ""
    project_id = payload.get("projectId") or ""
    active, products, projects = resolve_active(cfg)
    if products:
        active_product_id, layer_cfg = products[0]
        if scope and (scope != "product" or product_id != active_product_id):
            raise SystemExit(f"Requested source scope does not match sync.ACTIVE: {active}")
        return "PRODUCT", active_product_id, "", layer_cfg
    active_project_id, layer_cfg = projects[0]
    if scope and (scope != "project" or project_id != active_project_id):
        raise SystemExit(f"Requested source scope does not match sync.ACTIVE: {active}")
    return "PROJECT", layer_cfg["product_id"], active_project_id, layer_cfg


def pull_source_payload_from_args(scope, product_id, project_id, source_type, source_id, alias, fun, force=False):
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
        "force": force,
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
    parser.add_argument("--force", action="store_true")
    parsed = parser.parse_args(args)
    if parsed.json_stdin:
        payload = json.loads(sys.stdin.read() or "{}")
    else:
        payload = pull_source_payload_from_args(parsed.scope, parsed.product_id, parsed.project_id, parsed.source_type, parsed.source_id, parsed.alias, parsed.fun, parsed.force)
    result = pull_source_to_work_copy(payload)
    append_pull_log(
        "source",
        "manual",
        {
            "sourceType": payload.get("sourceType") or "",
            "sourceId": payload.get("sourceId") or "",
            "alias": payload.get("alias") or "",
            "funId": payload.get("funId") or "",
            "changed": result.get("changed", ""),
            "pulled": result.get("pulled", ""),
            "workCopyPath": result.get("workCopyPath") or "",
            "workCopyStatus": result.get("workCopyStatus") or "",
            "workCopyAction": result.get("workCopyAction") or "",
            "localChanged": result.get("localChanged", ""),
        },
        payload=payload,
        result=result,
        ok=result.get("ok", False),
    )
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
        SELECT * FROM gusen_source_record
        WHERE source_layer='PROJECT'
          AND project_id=? AND source_table=? AND fun_id=?
          AND (source_alias_id=? OR source_id=?)
        """,
        (project_id, source_type, fun, alias, alias),
    ).fetchone()
    if not row:
        raise SystemExit("Project source not found. Run sync first.")
    project_name = (cfg["projects"].get("projects") or {}).get(project_id, {}).get("name") or project_id
    return row, Path(path_part(project_name))


def _write_table(path, title, headers, rows):
    lines = [f"# {title}", "", "| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"]
    for row in rows:
        lines.append("| " + " | ".join("" if v is None else str(v).replace("\n", " ") for v in row) + " |")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _sync_from(conn, lookback, state_key):
    raw = conn.execute("SELECT state_value FROM gusen_sync_state WHERE state_key=?", (state_key,)).fetchone()
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


def order_part(value):
    try:
        return f"{int(value):03d}"
    except (TypeError, ValueError):
        return "999"


def _str(value):
    if value is None:
        return ""
    return str(value)


if __name__ == "__main__":
    run_sync_once()

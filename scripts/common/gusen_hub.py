#!/usr/bin/env python3
"""Shared implementation for the Gushen source hub."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import uuid
from contextlib import contextmanager, nullcontext
from contextvars import ContextVar
from pathlib import Path

from common import index_schema_comments, source_facts, identity_search, source_changes
from common.persistence import file_lock
from common.operation_control import OperationCancelled, checkpoint, publication_barrier
from common.source_store import source_transaction, prepare_path
from common.inheritance import SOURCE_CATALOG_VERSION
from common.source_format import decode_source
from providers.svn import checkout as svn_checkout
from providers.svn import group_inference
from providers.svn.dedup import is_newer_page


from common.runtime_paths import RuntimePath, tool_home
from common.workspace_identity import validate_workspace_key

ROOT = RuntimePath()
CONFIG_DIR = RuntimePath("config")
VAR_DIR = RuntimePath("var")


PAGE_SOURCE_TYPE = "page"
PROCEDURE_SOURCE_TYPE = "procedure"
LEGACY_WORK_COPY_BASELINE_DIR = ".guthon-baseline"
WORK_COPY_META_FILE = "source-meta.json"
WORK_COPY_DIFF_FILE = "diff.md"
WORK_COPY_DELIVERY_FILE = "delivery.md"
WORK_COPY_TRASH_DIR = ".guthon-trash"
WORK_COPY_MANAGED_FILES = {WORK_COPY_META_FILE, WORK_COPY_DIFF_FILE, WORK_COPY_DELIVERY_FILE}
WORK_COPY_COMPARE_EXCLUDED_FILES = WORK_COPY_MANAGED_FILES | {"meta.json"}
WORKSPACE_ENV = "GUTHON_WORKSPACE"
WORKSPACE_STEPS = ("source", "schema", "billType", "systemScripts", "views")
SVN_SOURCE_TYPES = {PAGE_SOURCE_TYPE, PROCEDURE_SOURCE_TYPE, "system-script", "table", "view"}
SOURCE_MODES = {"database", "svn"}
SOURCE_MODE_FILE = "source-mode.json"
SOURCE_MODE_VERSION = 1
INDEX_BUSY_TIMEOUT_MS = 30000
INDEX_LOCK_TIMEOUT_SECONDS = INDEX_BUSY_TIMEOUT_MS / 1000


_GENERATED_FILES = ContextVar("guthon_generated_files", default=None)


@contextmanager
def operation_generated_files():
    paths = set()
    token = _GENERATED_FILES.set(paths)
    try:
        yield paths
    finally:
        _GENERATED_FILES.reset(token)


def record_generated_files(paths):
    generated = _GENERATED_FILES.get()
    if generated is not None:
        generated.update(Path(path).resolve() for path in paths)


class IndexPartialError(SystemExit):
    error_code = "INDEX_PARTIAL"


class IndexRebuildRequired(SystemExit):
    """Raised when a derived index cannot be upgraded in place."""
    error_code = "INDEX_REBUILD_REQUIRED"


# indexFirst 的可运行示例参数按源码模式区分：svn action 用 --keyword/--fun-id，
# 旧 query 入口的 find 用位置参数，context 与 callers 用 --fun。
INDEX_FIRST_EXAMPLE_ARGUMENTS = {
    "svn": (
        ("unknownObject", ["find", "--keyword", "<对象名、别名或ID>"]),
        ("knownLocalFact", ["facts", "--keyword", "<错误、条件、字段或业务词>"]),
        ("tableOrBillWriteReason", ["explain", "--table", "<表名>"]),
        ("billWriteReason", ["explain", "--bill-type", "<单据类型>", "--data-source-id", "<数据源ID>"]),
        ("sharedCallChain", ["context", "--source-id", "<source_id>", "--fun-id", "<fun_id>"]),
        ("callersOfSharedFunction", ["callers", "--alias", "<source_alias_id>", "--fun-id", "<fun_id>"]),
    ),
    "query": (
        ("unknownObject", ["find", "<对象名、别名或ID>"]),
        ("knownLocalFact", ["facts", "--keyword", "<错误、条件、字段或业务词>"]),
        ("tableOrBillWriteReason", ["explain", "--table", "<表名>"]),
        ("billWriteReason", ["explain", "--bill-type", "<单据类型>", "--data-source-id", "<数据源ID>"]),
        ("sharedCallChain", ["context", "--source-id", "<source_id>", "--fun", "<fun_id>"]),
        ("callersOfSharedFunction", ["callers", "--alias", "<source_alias_id>", "--fun", "<fun_id>"]),
    ),
}


def _svn_delivery_state(workspace: dict) -> dict:
    path = workspace["contextDir"] / "svn-platform-save-state.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"deliveryCount": 0, "deliveries": []}
    if not isinstance(value, dict) or value.get("workspaceKey") != workspace["workspaceKey"]:
        return {"deliveryCount": 0, "deliveries": []}
    deliveries = value.get("deliveries") if isinstance(value.get("deliveries"), list) else []
    if not deliveries and value.get("committedAt"):
        deliveries = [{
            "deliveryId": value.get("deliveryId") or "legacy-latest",
            "workingCopyId": value.get("workingCopyId") or "",
            "lastCommittedRevision": value.get("lastCommittedRevision") or "",
            "files": value.get("files") or [],
            "groups": value.get("groups") or [],
            "committedAt": value.get("committedAt") or "",
        }]
    deliveries = [{
        "deliveryId": item.get("deliveryId") or "",
        "workingCopyId": item.get("workingCopyId") or "",
        "lastCommittedRevision": item.get("lastCommittedRevision") or "",
        "files": item.get("files") or [],
        "groups": [{
            "workingCopyId": group.get("workingCopyId") or "",
            "revision": group.get("revision") or "",
            "files": group.get("files") or [],
        } for group in item.get("groups") or []],
        "committedAt": item.get("committedAt") or "",
    } for item in deliveries]
    return {
        "deliveryCount": len(deliveries),
        "lastCommittedRevision": value.get("lastCommittedRevision") or "",
        "committedAt": value.get("committedAt") or "",
        "deliveries": deliveries[-10:],
    }


def current_workspace(config=None):
    return resolve_workspace(config or load_config())


def ensure_workspace_structure(workspace):
    paths = [
        workspace["docsDir"],
        workspace["contextDir"],
        workspace["logsDir"],
    ]
    if workspace.get("sourceMode") == "database":
        paths.extend(
            [
                workspace["workcopyDir"],
                workspace["readonlyDir"],
                workspace["databaseDir"] / "schema",
                workspace["databaseDir"] / "billtype",
                workspace["databaseDir"] / "views",
            ]
        )
    elif workspace["svn"].get("checkoutLayout") == "legacy-sparse":
        paths.append(workspace["workcopyDir"])
    for path in paths:
        path.mkdir(parents=True, exist_ok=True)


def source_dir(workspace=None) -> Path:
    return (workspace or current_workspace())["sourceDir"]


def readonly_source_dir(workspace=None) -> Path:
    return (workspace or current_workspace())["readonlyDir"]


def work_copy_dir(workspace=None) -> Path:
    return (workspace or current_workspace())["workcopyDir"]


def pull_log_path(workspace=None) -> Path:
    if os.environ.get("GUTHON_PULL_LOG_PATH"):
        return Path(os.environ["GUTHON_PULL_LOG_PATH"])
    return (workspace or current_workspace())["logsDir"] / "pull-log.ndjson"


def append_pull_log(pull_type, trigger, summary, payload=None, result=None, ok=True, message="") -> Path:
    path = pull_log_path()
    if os.environ.get("GUTHON_SUPPRESS_PULL_LOG") == "1":
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "time": _now(),
        "trigger": trigger,
        "pullType": pull_type,
        "ok": bool(ok),
        "summary": summary or {},
        "payload": payload or {},
        "result": result or {},
        "message": message or "",
    }
    def redact(value):
        if isinstance(value, dict):
            return {key: redact(item) for key, item in value.items()
                    if not re.search(r'password|secret|token|credential|content|sql|stack', str(key), re.I)}
        if isinstance(value, list):
            return [redact(item) for item in value]
        return value[:2000] if isinstance(value, str) else value
    # Match Bridge retention and serialize append/rotation across CLI workers.
    with file_lock(path.with_name('.pull-log.lock')):
        if path.exists() and path.stat().st_size >= 5 * 1024 * 1024:
            os.replace(path, path.with_name(path.name + '.1'))
        with open(path, "a", encoding="utf-8", opener=lambda name, flags: os.open(name, flags, 0o600)) as handle:
            handle.write(json.dumps(redact(record), ensure_ascii=False) + "\n")
    return path


def load_yaml(path: Path):
    text = path.read_text(encoding="utf-8")
    if text.lstrip().startswith(("{", "[")):
        data = json.loads(text)
    else:
        try:
            import yaml  # type: ignore
            data = yaml.safe_load(text) or {}
        except ModuleNotFoundError:
            data = _parse_tiny_yaml(text)
    def expand(value):
        if isinstance(value, str):
            return _expand_env(value)
        if isinstance(value, list):
            return [expand(item) for item in value]
        if isinstance(value, dict):
            return {key: expand(item) for key, item in value.items()}
        return value
    # Expand scalar values after parsing: passwords/paths cannot inject YAML
    # syntax or change type when they contain quotes, backslashes or newlines.
    return expand(data)


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
            value = item[2:].strip()
            key, separator, raw_value = value.partition(":")
            if separator and key.strip() and raw_value.strip():
                child = {key.strip(): _scalar(raw_value.strip())}
                parent.append(child)
                stack.append((indent, child))
            else:
                parent.append(_scalar(value))
            continue
        key, _, raw_value = item.partition(":")
        key = key.strip()
        if key.startswith(("'", '"')):
            key = _scalar(key)
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
    if value == "[]":
        return []
    if value == "{}":
        return {}
    if value.startswith("[") and value.endswith("]"):
        return [_scalar(part.strip()) for part in value[1:-1].split(",") if part.strip()]
    if value in ("true", "True"):
        return True
    if value in ("false", "False"):
        return False
    if value in ("null", "NULL", "~"):
        return None
    if value in ('""', "''"):
        return ""
    if value.startswith('"') and value.endswith('"'):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value[1:-1]
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    try:
        return int(value)
    except ValueError:
        if re.fullmatch(r"[+-]?\d+\.\d+", value):
            return float(value)
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
    return {key: load_yaml(CONFIG_DIR / filename) for key, filename in files.items()}


def system_aliases(config: dict, workspace=None):
    workspace = workspace or resolve_workspace(config)
    mappings = workspace.get("systemMappings")
    if mappings is None:
        mappings = (workspace.get("systems", {}).get("include") or {}).get("mappings") or {}
    return [str(alias).strip() for alias in mappings if str(alias).strip()]


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


def resolve_system_scope(conn, config: dict, datasource_name: str, workspace=None, *, allow_remote=True):
    workspace = workspace or resolve_workspace(config)
    selected = system_aliases(config, workspace)
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
    records = entry.get("systems") or []
    covered_aliases = {
        alias
        for record in records
        for alias in _values(record, "SYSTEM_ALIAS_ID", "systemAliasId")
    }
    records = records if set(selected).issubset(covered_aliases) else None
    if not records:
        if not allow_remote:
            return None
        if conn is None:
            raise SystemExit("System identity cache is missing; run init for this DATABASE workspace")
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
            raise SystemExit(f"No gd_system rows match systems.include.mappings for {workspace['workspaceKey']}")
        cache["datasources"][datasource_name] = {"system_aliases": selected, "systems": records}
        cache["generated_at"] = _now()
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        _merge_system_cache(cache_path, datasource_name, cache["datasources"][datasource_name])
    scope = _build_system_scope(records, selected)
    if not scope.get("system_ids") or not scope.get("data_source_ids"):
        raise SystemExit(f"Invalid system cache for datasource: {datasource_name}")
    return scope


def _merge_system_cache(path, datasource_name, entry):
    with file_lock(path.with_suffix(".lock")):
        try:
            cache = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            cache = {}
        if not isinstance(cache, dict) or not isinstance(cache.get("datasources"), dict):
            cache = {"datasources": {}}
        cache["datasources"][datasource_name] = entry
        cache["generated_at"] = _now()
        svn_checkout.atomic_json(path, cache)


def bootstrap_system_data(config: dict, workspace) -> dict:
    """Refresh one database datasource's cached system mapping."""

    datasource_name = workspace["datasourceName"]
    with db_connect(workspace["datasource"]) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT SYSTEM_ID, SYSTEM_NAME, SYSTEM_ALIAS_ID, DATA_SOURCE_ID "
                "FROM gd_system WHERE SYSTEM_ALIAS_ID IS NOT NULL"
            )
            records = [
                {key: _str(row.get(key)) for key in ("SYSTEM_ID", "SYSTEM_NAME", "SYSTEM_ALIAS_ID", "DATA_SOURCE_ID")}
                for row in cur.fetchall()
            ]
    if not records:
        raise SystemExit(f"No gd_system rows are available for datasource: {datasource_name}")
    cache_path = CONFIG_DIR / "system-data.json"
    try:
        cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    except (json.JSONDecodeError, OSError):
        cache = {}
    if not isinstance(cache, dict) or not isinstance(cache.get("datasources"), dict):
        cache = {"datasources": {}}
    cache["datasources"][datasource_name] = {
        "system_aliases": sorted({record["SYSTEM_ALIAS_ID"] for record in records if record["SYSTEM_ALIAS_ID"]}),
        "systems": records,
    }
    cache["generated_at"] = _now()
    _merge_system_cache(cache_path, datasource_name, cache["datasources"][datasource_name])
    return {"datasource": datasource_name, "systems": len(records)}


def request_identity(payload):
    data_source_ids = {
        str(value)
        for value in (
            [payload.get("dataSourceId")]
            + list(payload.get("dataSourceIds") or [])
        )
        if value not in (None, "")
    }
    system_ids = {
        str(value)
        for value in (
            [payload.get("systemId")]
            + list(payload.get("systemIds") or [])
        )
        if value not in (None, "")
    }
    return str(payload.get("pageOrigin") or "").rstrip("/"), data_source_ids, system_ids


def workspace_matches_request(config, workspace, payload, match_origin=True):
    origin, data_source_ids, system_ids = request_identity(payload)
    if match_origin and workspace["pageOrigins"] and origin not in workspace["pageOrigins"]:
        return False
    requested_alias = str(payload.get("systemAlias") or "").strip()
    if workspace.get("sourceMode") == "svn":
        if workspace["svn"].get("checkoutLayout") == "manifest-working-copies":
            from providers.svn.nexus.manifest import load_authorized_scope

            manifest_path = workspace["svn"].get("scopeManifestPath")
            if not manifest_path or not manifest_path.is_file():
                return False
            entries = load_authorized_scope(workspace).entries
            has_repository_root = any(entry.category == "root" for entry in entries)
            authorized_system_ids = {
                Path(entry.local_subdir).name
                for entry in entries
                if entry.category in {"systems", "pages", "system-script"}
            }
            authorized_data_source_ids = {
                Path(entry.local_subdir).name
                for entry in entries
                if entry.category in {"datasources", "procedures", "tables", "views"}
            }
            if has_repository_root:
                authorized_system_ids = {
                    str(mapping.get("system_id") or "").strip()
                    for mapping in (workspace.get("systemMappings") or {}).values()
                    if isinstance(mapping, dict) and str(mapping.get("system_id") or "").strip()
                }
                authorized_data_source_ids = {
                    str(mapping.get("data_source_id") or "").strip()
                    for mapping in (workspace.get("systemMappings") or {}).values()
                    if isinstance(mapping, dict) and str(mapping.get("data_source_id") or "").strip()
                }
            authorized_aliases = {
                str(alias).strip()
                for alias, mapping in (workspace.get("systemMappings") or {}).items()
                if isinstance(mapping, dict)
                and (
                    str(mapping.get("system_id") or "").strip() in authorized_system_ids
                    or str(mapping.get("data_source_id") or "").strip() in authorized_data_source_ids
                )
            }
        else:
            scope = svn_checkout.load_scope(workspace, required=False)
            if not scope:
                return False
            authorized_aliases = set(scope.get("systemAliases") or [])
            authorized_data_source_ids = set(scope.get("dataSourceIds") or [])
            authorized_system_ids = set(scope.get("systemIds") or [])
        if requested_alias and requested_alias not in authorized_aliases:
            return False
        if not data_source_ids and not system_ids:
            return bool(requested_alias in authorized_aliases or origin and origin in workspace["pageOrigins"])
        return data_source_ids.issubset(authorized_data_source_ids) and system_ids.issubset(authorized_system_ids)
    if not data_source_ids and not system_ids:
        return bool(requested_alias in workspace.get("systemAliases", []) or origin and origin in workspace["pageOrigins"])
    scope = resolve_system_scope(None, config, workspace["datasourceName"], workspace, allow_remote=False)
    if scope is None:
        return False
    return data_source_ids.issubset(set(scope.get("data_source_ids") or [])) and system_ids.issubset(
        set(scope.get("system_ids") or [])
    )


def route_workspace_request(config, payload):
    if not isinstance(payload, dict):
        raise SystemExit("route input must be a JSON object")
    requested = str(payload.get("workspaceKey") or "").strip()
    if requested:
        workspace = resolve_workspace(config, requested)
        identity = request_identity(payload)
        has_identity = bool(identity[0] or identity[1] or identity[2] or payload.get("systemAlias"))
        if not has_identity:
            return {"ok": True, "workspaceKey": requested, "workspace": workspace_summary(config, workspace)}
        if not workspace_matches_request(config, workspace, payload):
            raise SystemExit(f"Page identity does not match workspace: {requested}")
        return {"ok": True, "workspaceKey": requested, "workspace": workspace_summary(config, workspace)}
    candidates = [
        workspace
        for workspace in list_workspaces(config)
        if workspace_matches_request(config, workspace, payload)
    ]
    if len(candidates) == 1:
        workspace = candidates[0]
        return {
            "ok": True,
            "workspaceKey": workspace["workspaceKey"],
            "workspace": workspace_summary(config, workspace),
        }
    return {
        "ok": False,
        "workspaceSelectionRequired": True,
        "message": "请选择目标工作区" if candidates else "页面身份未匹配到工作区",
        "candidates": [workspace_summary(config, workspace) for workspace in candidates],
    }


def _reset_incompatible_index(conn: sqlite3.Connection) -> bool:
    existing = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='gusen_source_record'"
    ).fetchone()
    if not existing:
        return False
    # The index is derived data. When its identity model changes, rebuilding it is
    # safer than carrying obsolete workspace relationships into current queries.
    objects = conn.execute(
        "SELECT type, name FROM sqlite_master "
        "WHERE type IN ('view', 'table') AND name NOT LIKE 'sqlite_%' "
        "ORDER BY CASE type WHEN 'view' THEN 0 ELSE 1 END"
    ).fetchall()
    for item in objects:
        identifier = str(item["name"]).replace('"', '""')
        conn.execute(f'DROP {item["type"].upper()} IF EXISTS "{identifier}"')
    conn.commit()
    return True


def _migrate_workspace_identity(conn: sqlite3.Connection) -> bool:
    """Upgrade the previous workspace identity column without discarding the index."""

    existing = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='gusen_source_record'"
    ).fetchone()
    if not existing:
        return False
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(gusen_source_record)")}
    if "scope_id" in columns:
        return True
    if "product_id" not in columns:
        return False

    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("ALTER TABLE gusen_source_record RENAME COLUMN product_id TO scope_id")
        conn.execute(
            "UPDATE gusen_source_record SET scope_id=project_id "
            "WHERE source_layer='PROJECT' AND project_id<>''"
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return True


def _index_lock_error(index_db: Path, error: sqlite3.Error) -> SystemExit:
    return SystemExit(
        "本地索引正在被其他进程占用，无法完成索引操作："
        f"{Path(index_db).resolve()}。请关闭 DBX、DataGrip 或 SQLite 查看器后重试。"
    )


def connect_index(
    index_db: Path,
    *,
    rebuild_incompatible: bool = False,
    readonly: bool = False,
) -> sqlite3.Connection:
    index_db = Path(index_db)
    if readonly:
        if not index_db.is_file():
            raise sqlite3.OperationalError(f"index database does not exist: {index_db}")
        connection_target = f"{index_db.resolve().as_uri()}?mode=ro"
        conn = sqlite3.connect(
            connection_target,
            uri=True,
            timeout=INDEX_BUSY_TIMEOUT_MS / 1000,
        )
    else:
        index_db.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(index_db, timeout=INDEX_BUSY_TIMEOUT_MS / 1000)
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout={INDEX_BUSY_TIMEOUT_MS}")
    if readonly:
        conn.execute("PRAGMA query_only=ON")
        return conn
    existing = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='gusen_source_record'"
    ).fetchone()
    if existing:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(gusen_source_record)")}
        reset = False
        if "scope_id" not in columns:
            if _migrate_workspace_identity(conn):
                columns = {
                    row["name"] for row in conn.execute("PRAGMA table_info(gusen_source_record)")
                }
            elif not rebuild_incompatible:
                conn.close()
                raise IndexRebuildRequired("源码索引结构已更新，需要重建派生索引")
            else:
                _reset_incompatible_index(conn)
                reset = True
        if not reset and "source_namespace" not in columns:
            if not rebuild_incompatible:
                conn.close()
                raise IndexRebuildRequired("源码索引身份结构已更新，需要重建派生索引")
            _reset_incompatible_index(conn)
    conn.executescript(
        """
        -- 源码对象主表：保存对象身份、来源、版本、路径和索引状态，是其他事实表的关联入口。
        CREATE TABLE IF NOT EXISTS gusen_source_record (
            record_id INTEGER,
            source_layer TEXT NOT NULL,
            scope_id TEXT NOT NULL,
            project_id TEXT NOT NULL DEFAULT '',
            source_namespace TEXT NOT NULL DEFAULT '',
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
            PRIMARY KEY (
                source_layer, scope_id, project_id, source_namespace,
                source_table, source_id, fun_id
            )
        );
        -- 静态调用边表：记录能够确定目标的函数调用，用于转到定义、查找引用和调用链分析。
        CREATE TABLE IF NOT EXISTS gusen_invoke_call (
            id INTEGER PRIMARY KEY,
            source_record_id INTEGER NOT NULL,
            script_type TEXT,
            json_path TEXT,
            line_no INTEGER,
            target_alias_id TEXT,
            target_fun_id TEXT,
            invoke_type TEXT
        );
        -- 动态调用线索表：记录无法静态确定目标的调用表达式及原因，供人工或 AI 继续核验。
        CREATE TABLE IF NOT EXISTS gusen_dynamic_call (
            id INTEGER PRIMARY KEY,
            source_record_id INTEGER NOT NULL,
            script_type TEXT,
            json_path TEXT,
            line_no INTEGER,
            invoke_expr TEXT,
            reason TEXT
        );
        -- 索引同步状态表：保存索引构建和增量刷新所需的轻量键值状态。
        CREATE TABLE IF NOT EXISTS gusen_sync_state (
            state_key TEXT PRIMARY KEY,
            state_value TEXT
        );
        """
    )
    source_columns = {row["name"] for row in conn.execute("PRAGMA table_info(gusen_source_record)")}
    migrations = {
        "record_id": "INTEGER",
        "provider": "TEXT NOT NULL DEFAULT 'database'",
        "source_path": "TEXT",
        "source_hash": "TEXT",
        "svn_revision": "TEXT",
        "json_pointer": "TEXT",
        "system_id": "TEXT",
        "data_source_id": "TEXT",
        "working_copy_id": "TEXT",
        "scope_entry_id": "TEXT",
        "file_size": "INTEGER",
        "mtime_ns": "INTEGER",
        "diagnostic_code": "TEXT",
        "diagnostic_message": "TEXT",
        "parser_version": "TEXT",
        "last_seen_time": "TEXT",
    }
    for name, definition in migrations.items():
        if name not in source_columns:
            conn.execute(f"ALTER TABLE gusen_source_record ADD COLUMN {name} {definition}")
    conn.execute("UPDATE gusen_source_record SET record_id=rowid WHERE record_id IS NULL")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS gusen_source_record_id_idx "
        "ON gusen_source_record(record_id)"
    )
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS gusen_source_record_id_insert
        AFTER INSERT ON gusen_source_record
        WHEN NEW.record_id IS NULL
        BEGIN
            UPDATE gusen_source_record SET record_id=NEW.rowid WHERE rowid=NEW.rowid;
        END
        """
    )
    source_facts.setup_schema(conn)
    conn.commit()
    call_schema_migrated = _migrate_call_index_schema(conn)
    identity_search.setup(conn)
    source_changes.setup(conn)
    index_schema_comments.setup_schema_comments(conn)
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gusen_effective_source'").fetchone():
        conn.execute("DROP TABLE gusen_effective_source")
    conn.commit()
    if call_schema_migrated:
        conn.execute("VACUUM")
    return conn


def connect_index_for_workspace(
    workspace: dict,
    *,
    action: str = "index-init",
    rebuild_incompatible: bool = False,
) -> sqlite3.Connection:
    """Initialize a workspace index under the same lock used by SVN writes.

    The returned connection is intentionally unlocked after schema setup. Callers
    that perform an index transaction must acquire the operation lock around that
    transaction, as the SVN indexing functions already do.
    """

    lock = nullcontext()
    if workspace.get("sourceMode") == "svn":
        lock = svn_checkout.operation_lock(
            workspace,
            action,
            blocking=True,
            timeout_seconds=INDEX_LOCK_TIMEOUT_SECONDS,
        )
    try:
        with lock:
            return connect_index(
                workspace["indexPath"],
                rebuild_incompatible=rebuild_incompatible,
            )
    except sqlite3.OperationalError as error:
        if "locked" in str(error).lower():
            raise _index_lock_error(workspace["indexPath"], error) from error
        raise


@contextmanager
def index_connection(
    workspace: dict,
    *,
    action: str = "index-read",
    readonly: bool = True,
    rebuild_incompatible: bool = False,
):
    """Use a workspace index while holding its SVN operation lock.

    Read-only callers hold a shared lock for the complete SQLite query. On
    Windows the checkout lock implementation serializes shared and exclusive
    operations, which keeps the behavior deterministic across hosts.
    """

    lock = nullcontext()
    if workspace.get("sourceMode") == "svn":
        lock = svn_checkout.operation_lock(
            workspace,
            action,
            shared=readonly,
            blocking=True,
            timeout_seconds=INDEX_LOCK_TIMEOUT_SECONDS,
        )
    with lock:
        conn = None
        try:
            conn = connect_index(
                workspace["indexPath"],
                rebuild_incompatible=rebuild_incompatible,
                readonly=readonly,
            )
            yield conn
        except sqlite3.OperationalError as error:
            if "locked" in str(error).lower():
                raise _index_lock_error(workspace["indexPath"], error) from error
            raise
        finally:
            if conn is not None:
                conn.close()


def _migrate_call_index_schema(conn):
    """Normalize repeated source metadata out of call-edge rows."""

    invoke_columns = {row["name"] for row in conn.execute("PRAGMA table_info(gusen_invoke_call)")}
    dynamic_columns = {row["name"] for row in conn.execute("PRAGMA table_info(gusen_dynamic_call)")}
    try:
        conn.execute("BEGIN")
        if "source_record_id" not in invoke_columns:
            conn.execute("ALTER TABLE gusen_invoke_call RENAME TO gusen_invoke_call_legacy")
            conn.execute(
                """
                -- 迁移后的静态调用边表；用途与主建表语句中的 gusen_invoke_call 相同。
                CREATE TABLE gusen_invoke_call (
                    id INTEGER PRIMARY KEY,
                    source_record_id INTEGER NOT NULL,
                    source_fragment_id INTEGER,
                    script_type TEXT,
                    json_path TEXT,
                    line_no INTEGER,
                    target_alias_id TEXT,
                    target_fun_id TEXT,
                    invoke_type TEXT
                )
                """
            )
            conn.execute(
                """
                INSERT INTO gusen_invoke_call(
                    id, source_record_id, script_type, json_path, line_no,
                    target_alias_id, target_fun_id, invoke_type
                )
                SELECT c.id, s.record_id, c.script_type, c.json_path, c.line_no,
                       c.target_alias_id, c.target_fun_id, c.invoke_type
                FROM gusen_invoke_call_legacy c
                JOIN gusen_source_record s
                  ON s.source_layer=c.source_layer AND s.scope_id=c.scope_id
                 AND s.project_id=c.project_id AND s.source_table=c.source_table
                 AND s.source_id=c.source_id AND s.fun_id=c.fun_id
                """
            )
            conn.execute("DROP TABLE gusen_invoke_call_legacy")
        if "source_record_id" not in dynamic_columns:
            conn.execute("ALTER TABLE gusen_dynamic_call RENAME TO gusen_dynamic_call_legacy")
            conn.execute(
                """
                -- 迁移后的动态调用线索表；用途与主建表语句中的 gusen_dynamic_call 相同。
                CREATE TABLE gusen_dynamic_call (
                    id INTEGER PRIMARY KEY,
                    source_record_id INTEGER NOT NULL,
                    source_fragment_id INTEGER,
                    script_type TEXT,
                    json_path TEXT,
                    line_no INTEGER,
                    invoke_expr TEXT,
                    reason TEXT
                )
                """
            )
            conn.execute(
                """
                INSERT INTO gusen_dynamic_call(
                    id, source_record_id, script_type, json_path, line_no, invoke_expr, reason
                )
                SELECT c.id, s.record_id, c.script_type, c.json_path, c.line_no, c.invoke_expr, c.reason
                FROM gusen_dynamic_call_legacy c
                JOIN gusen_source_record s
                  ON s.source_layer=c.source_layer AND s.scope_id=c.scope_id
                 AND s.project_id=c.project_id AND s.source_table=c.source_table
                 AND s.source_id=c.source_id AND s.fun_id=c.fun_id
                """
            )
            conn.execute("DROP TABLE gusen_dynamic_call_legacy")
        conn.execute("DROP VIEW IF EXISTS gusen_invoke_call_detail")
        conn.execute("DROP VIEW IF EXISTS gusen_dynamic_call_detail")
        for statement in (
            "CREATE INDEX IF NOT EXISTS gusen_invoke_target_idx "
            "ON gusen_invoke_call(target_alias_id, target_fun_id, source_record_id, line_no)",
            "CREATE INDEX IF NOT EXISTS gusen_invoke_source_idx "
            "ON gusen_invoke_call(source_record_id, line_no)",
            "CREATE INDEX IF NOT EXISTS gusen_dynamic_source_idx "
            "ON gusen_dynamic_call(source_record_id, line_no)",
            "CREATE INDEX IF NOT EXISTS gusen_source_alias_lookup_idx "
            "ON gusen_source_record(source_alias_id, fun_id, status, scope_id)",
            "CREATE INDEX IF NOT EXISTS gusen_source_object_lookup_idx "
            "ON gusen_source_record(scope_id, source_id, fun_id, source_layer, project_id)",
            "CREATE INDEX IF NOT EXISTS gusen_source_physical_lookup_idx "
            "ON gusen_source_record(provider, scope_entry_id, source_path, status)",
            """
            CREATE VIEW gusen_invoke_call_detail AS
            SELECT c.id, c.source_record_id, c.source_fragment_id,
                   s.source_layer, s.scope_id, s.project_id, s.source_table, s.source_id,
                   s.source_alias_id, s.fun_id, s.source_name,
                   c.script_type, c.json_path, c.line_no,
                   c.target_alias_id, c.target_fun_id, c.invoke_type,
                   'HIGH' AS confidence, s.update_time, s.indexed_time
            FROM gusen_invoke_call c
            JOIN gusen_source_record s ON s.record_id=c.source_record_id
            """,
            """
            CREATE VIEW gusen_dynamic_call_detail AS
            SELECT c.id, c.source_record_id, c.source_fragment_id,
                   s.source_layer, s.scope_id, s.project_id, s.source_table, s.source_id,
                   s.source_alias_id, s.fun_id, s.source_name,
                   c.script_type, c.json_path, c.line_no, c.invoke_expr, c.reason,
                   'LOW' AS confidence, s.update_time, s.indexed_time
            FROM gusen_dynamic_call c
            JOIN gusen_source_record s ON s.record_id=c.source_record_id
            """,
        ):
            conn.execute(statement)
        conn.commit()
        return "source_record_id" not in invoke_columns or "source_record_id" not in dynamic_columns
    except Exception:
        conn.rollback()
        raise


def find_source_candidates(conn, scope_id, keyword, limit=10, include_paths=False):
    limit = max(1, min(int(limit), 10))
    query = f"%{keyword.strip()}%"
    if include_paths and ("/" in keyword or "\\" in keyword or re.search(r"\.(?:gss|json|vm|js|java|sql)$", keyword, re.I)):
        normalized = keyword.replace("\\", "/").strip()
        return conn.execute("SELECT source_layer,project_id,source_namespace,working_copy_id,source_table,source_id,source_alias_id,fun_id,source_name,local_path,status,provider,source_path,source_hash,svn_revision,system_id,data_source_id FROM gusen_source_record WHERE scope_id=? AND (source_path LIKE ? OR replace(local_path, char(92), '/') LIKE ?) ORDER BY source_path,source_namespace,record_id LIMIT ?",
                            (scope_id,"%"+normalized+"%","%"+normalized+"%",limit)).fetchall()
    fts_clause, fts_params = identity_search.candidate_clause(conn, keyword.strip(), allow_like_wildcards=True)
    return conn.execute(
        f"""
        SELECT source_layer, project_id, source_namespace, working_copy_id, source_table, source_id, source_alias_id, fun_id, source_name,
               local_path, status, provider, source_path, source_hash, svn_revision, system_id, data_source_id
        FROM gusen_source_record
        WHERE scope_id=?
          AND (source_id LIKE ? OR source_alias_id LIKE ? OR fun_id LIKE ? OR source_name LIKE ?)
          {"AND " + fts_clause if fts_clause else ""}
        ORDER BY source_name, source_alias_id, fun_id, source_namespace, record_id
        LIMIT ?
        """,
        (scope_id, query, query, query, query, *fts_params, limit),
    ).fetchall()


def query_source_context(conn, scope_id, source_id, fun_id="", limit=20, source_namespace=""):
    limit = max(1, min(int(limit), 20))
    filters = ["scope_id=?", "source_id=?"]
    params = [scope_id, source_id]
    if fun_id:
        filters.append("fun_id=?")
        params.append(fun_id)
    if source_namespace:
        filters.append("source_namespace=?")
        params.append(source_namespace)
    sources = conn.execute(
        "SELECT record_id AS source_record_id,* FROM gusen_source_record WHERE " + " AND ".join(filters)
        + " ORDER BY source_namespace,source_layer,project_id,fun_id LIMIT 2", params,
    ).fetchall()
    if not sources:
        raise ValueError(f"Source not found: scope={scope_id}, sourceId={source_id}, funId={fun_id}")
    if len(sources) > 1:
        raise ValueError("SOURCE_AMBIGUOUS: supply exact funId/sourceNamespace; candidates=" + json.dumps(
            [{"sourceNamespace": row["source_namespace"], "funId": row["fun_id"]} for row in sources], ensure_ascii=False))
    source = sources[0]
    outgoing = conn.execute(
        """
        SELECT ? AS source_table, ? AS source_id, ? AS source_alias_id, ? AS fun_id,
               script_type, json_path, line_no, target_alias_id, target_fun_id,
               invoke_type, 'HIGH' AS confidence
        FROM gusen_invoke_call
        WHERE source_record_id=?
        ORDER BY line_no
        LIMIT ?
        """,
        (
            source["source_table"],
            source["source_id"],
            source["source_alias_id"],
            source["fun_id"],
            source["source_record_id"],
            limit,
        ),
    ).fetchall()
    incoming = conn.execute(
        """
        SELECT c.source_layer, c.source_table, c.source_id, c.source_alias_id, c.fun_id,
               c.script_type, c.json_path, c.line_no, c.invoke_type, c.confidence,
               s.source_namespace, s.source_path, s.working_copy_id
        FROM gusen_invoke_call_detail c
        JOIN gusen_source_record s ON s.record_id=c.source_record_id
        WHERE c.scope_id=? AND c.target_alias_id=? AND c.target_fun_id=?
        ORDER BY c.source_layer, c.source_alias_id, c.fun_id, c.line_no
        LIMIT ?
        """,
        (scope_id, source["source_alias_id"], source["fun_id"], limit),
    ).fetchall()
    dynamic = conn.execute(
        """
        SELECT script_type, json_path, line_no, invoke_expr, reason, 'LOW' AS confidence
        FROM gusen_dynamic_call
        WHERE source_record_id=?
        ORDER BY line_no
        LIMIT ?
        """,
        (source["source_record_id"], limit),
    ).fetchall()
    source_payload = dict(source)
    source_payload.pop("source_record_id", None)
    return {"source": source_payload, "outgoing": outgoing, "incoming": incoming, "dynamic": dynamic}


def query_incoming_callers(conn, scope_id, target_alias_id, target_fun_id, limit=100):
    limit = max(1, min(int(limit), 100))
    return conn.execute(
        """
        SELECT source_layer, project_id, source_table, source_id, source_alias_id, fun_id,
               source_name, script_type, json_path, line_no, invoke_type, confidence
        FROM gusen_invoke_call_detail
        WHERE scope_id=? AND target_alias_id=? AND target_fun_id=?
        ORDER BY source_table, source_alias_id, fun_id, line_no
        LIMIT ?
        """,
        (scope_id, target_alias_id, target_fun_id, limit),
    ).fetchall()


def db_connect(ds: dict):
    from common.database_readonly import resolve_password
    ds = dict(ds)
    ds["password"] = resolve_password(ds)
    missing = [key for key in ("host", "port", "database", "username", "password") if not ds.get(key)]
    if missing:
        raise SystemExit(f"数据源配置缺少字段: {', '.join(missing)}")
    database_type = str(ds.get("type") or "mysql").strip().lower()
    database_type = {"mariadb": "mysql", "postgres": "postgresql"}.get(database_type, database_type)
    if database_type == "postgresql":
        try:
            import psycopg  # type: ignore
        except ModuleNotFoundError as exc:
            raise SystemExit("Missing dependency: pip install 'psycopg[binary]'") from exc

        def flexible_dict_row(cursor):
            keys = [column.name for column in cursor.description]

            def make_row(values):
                row = {}
                for key, value in zip(keys, values):
                    row[key] = value
                    row.setdefault(key.lower(), value)
                    row.setdefault(key.upper(), value)
                return row

            return make_row

        return psycopg.connect(
            host=ds["host"],
            port=int(ds["port"]),
            dbname=ds["database"],
            user=ds["username"],
            password=ds["password"],
            row_factory=flexible_dict_row,
            connect_timeout=60,
        )
    if database_type != "mysql":
        raise SystemExit(f"Unsupported datasource type: {database_type}")
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


def run_sync_once(args=None, on_progress=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--init-only", action="store_true", help="create local sqlite schema and docs only")
    mode.add_argument("--reindex-calls", action="store_true", help="rebuild call index from local readonly sources")
    mode.add_argument("--full-rebuild", action="store_true", help="pull all eligible sources and rebuild the call index")
    parsed = parser.parse_args(args)
    cfg = load_config()
    if parsed.workspace:
        set_workspace(parsed.workspace)
    workspace = resolve_workspace(cfg)
    ensure_workspace_structure(workspace)
    sync = (cfg.get("sync") or {}).get("sync") or {}
    index_path = workspace["indexPath"]
    index_name = _indexed_path(index_path)
    conn = connect_index_for_workspace(
        workspace,
        action="index-init",
        rebuild_incompatible=(
            not parsed.init_only
            and (workspace.get("sourceMode") == "svn" or not parsed.reindex_calls)
        ),
    )
    try:
        if workspace.get("sourceMode") == "svn":
            if parsed.init_only:
                export_knowledge_readme(conn, index_name, workspace["workspaceKey"], workspace["sourceMode"])
                return
            result = index_svn_workspace(conn, cfg, workspace, on_progress=on_progress)
            if on_progress is not None:
                on_progress(f"{workspace.get('displayName') or workspace['workspaceKey']}｜索引｜生成索引说明文档")
            export_knowledge_readme(conn, index_name, workspace["workspaceKey"], workspace["sourceMode"])
            if on_progress is not None:
                on_progress(f"{workspace.get('displayName') or workspace['workspaceKey']}｜索引｜重建流程完成")
            append_pull_log(
                "source",
                "local-svn-scan",
                {"workspaceKey": workspace["workspaceKey"], "revision": result["revision"], "changed": result["changed"], "failures": result["failures"]},
                result=result,
                ok=not result["failures"],
            )
            if result["failures"]:
                if not result.get("indexPreserved", True):
                    raise IndexPartialError(f"SVN index PARTIAL; {result['failures']} scoped path errors")
                raise SystemExit(f"SVN scan completed with {result['failures']} scoped path errors; old index preserved")
            return result
        if parsed.init_only:
            export_knowledge_readme(conn, index_name, workspace["workspaceKey"], workspace["sourceMode"])
            return
        if parsed.reindex_calls:
            indexed = reindex_local_calls(conn)
            export_knowledge_readme(conn, index_name, workspace["workspaceKey"], workspace["sourceMode"])
            return

        full_rebuild = parsed.full_rebuild
        if not sync:
            raise SystemExit("配置缺少 sync.sync 段：请在 config/sync.yaml 中声明同步规则")
        lookback = int(sync.get("lookback_minutes", 10))
        state_key = "last_success_time"
        sync_from = "1970-01-01 00:00:00" if full_rebuild else _sync_from(conn, lookback, state_key)
        stats = {
            "mode": "full-rebuild" if full_rebuild else "sync",
            "workspaceKey": workspace["workspaceKey"],
            "sync_from": sync_from,
            "candidates": 0,
            "changed": 0,
            "deleted": 0,
            "failures": 0,
        }
        stats = _sync_layer(
            conn,
            cfg,
            workspace["config"],
            workspace["layer"],
            workspace["scopeId"],
            workspace["projectId"],
            sync_from,
            stats,
            workspace,
            force=full_rebuild,
        )
        conn.execute(
            "INSERT OR REPLACE INTO gusen_sync_state(state_key, state_value) VALUES(?, ?)",
            (state_key, _now()),
        )
        conn.commit()
        if full_rebuild:
            stats["reindexed"] = reindex_local_calls(conn)
        export_knowledge_readme(conn, index_name, workspace["workspaceKey"], workspace["sourceMode"])
        append_pull_log(
            "source",
            "scheduled",
            {
                "workspaceKey": workspace["workspaceKey"],
                "candidates": stats.get("candidates", 0),
                "changed": stats.get("changed", 0),
                "deleted": stats.get("deleted", 0),
                "failures": stats.get("failures", 0),
            },
            payload={"sync_from": sync_from},
            result=stats,
            ok=not stats.get("failures"),
        )
    finally:
        conn.close()


def _indexed_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(Path(ROOT).resolve()))
    except ValueError:
        return str(path.resolve())


def _delete_call_index(conn, identity):
    source_ids = (
        "SELECT record_id FROM gusen_source_record "
        "WHERE source_layer=? AND scope_id=? AND project_id=? "
        "AND source_table=? AND source_id=? AND fun_id=?"
    )
    record_ids = [
        int(row["record_id"])
        for row in conn.execute(source_ids, identity).fetchall()
        if row["record_id"] is not None
    ]
    conn.execute(
        f"DELETE FROM gusen_invoke_call WHERE source_record_id IN ({source_ids})",
        identity,
    )
    conn.execute(
        f"DELETE FROM gusen_dynamic_call WHERE source_record_id IN ({source_ids})",
        identity,
    )
    for record_id in record_ids:
        source_facts.clear_source_details(conn, record_id)


def _delete_svn_index_item(conn, workspace, row):
    row = dict(row)
    namespace = str(row.get("source_namespace") or row.get("scope_entry_id") or "").strip()
    source_ids = (
        "SELECT record_id FROM gusen_source_record "
        "WHERE source_layer=? AND scope_id=? AND project_id=? AND source_namespace=? "
        "AND source_table=? AND source_id=? AND fun_id=?"
    )
    identity = (
        workspace["layer"], workspace["scopeId"], workspace["projectId"], namespace,
        row["source_table"], row["source_id"], row["fun_id"] or "",
    )
    record_ids = [
        int(item["record_id"])
        for item in conn.execute(source_ids, identity).fetchall()
        if item["record_id"] is not None
    ]
    conn.execute(f"DELETE FROM gusen_invoke_call WHERE source_record_id IN ({source_ids})", identity)
    conn.execute(f"DELETE FROM gusen_dynamic_call WHERE source_record_id IN ({source_ids})", identity)
    for record_id in record_ids:
        source_facts.clear_source_details(conn, record_id)
    conn.execute(
        "DELETE FROM gusen_source_record WHERE source_layer=? AND scope_id=? AND project_id=? "
        "AND source_namespace=? AND source_table=? AND source_id=? AND fun_id=?",
        identity,
    )


def _insert_svn_index_item(conn, workspace, item, indexed_time):
    local_path = Path(item.get("local_path") or workspace["checkoutPath"] / item["source_path"])
    before = local_path.stat()
    raw_source = local_path.read_bytes()
    after = local_path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or hashlib.sha256(raw_source).hexdigest() != item["source_hash"]:
        raise ValueError(f"Source changed during scan: {item['source_path']}")
    conn.execute(
        """
        INSERT OR REPLACE INTO gusen_source_record(
            source_layer, scope_id, project_id, source_namespace,
            source_table, source_id, source_alias_id, fun_id,
            source_name, version_mac, update_time, check_out_user_id, check_out_date, check_in_date,
            change_key, local_path, status, indexed_time, provider, source_path, source_hash,
            svn_revision, json_pointer, system_id, data_source_id, working_copy_id, scope_entry_id,
            file_size, mtime_ns, diagnostic_code, diagnostic_message, parser_version, last_seen_time
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            workspace["layer"],
            workspace["scopeId"],
            workspace["projectId"],
            item.get("source_namespace") or item.get("scope_entry_id") or item.get("working_copy_id") or "",
            item["source_table"],
            item["source_id"],
            item["source_alias_id"],
            item.get("fun_id") or "",
            item.get("source_name") or "",
            "",
            "",
            "",
            "",
            "",
            item["change_key"],
            str(local_path.resolve()),
            item["status"],
            indexed_time,
            "svn",
            item["source_path"],
            item["source_hash"],
            item["svn_revision"],
            "",
            item.get("system_id") or "",
            item.get("data_source_id") or "",
            item.get("working_copy_id") or "",
            item.get("scope_entry_id") or "",
            after.st_size,
            after.st_mtime_ns,
            "" if item["status"] == "OK" else item["status"],
            "",
            "source-facts-v1",
            indexed_time,
        ),
    )
    source_record = conn.execute(
        "SELECT record_id FROM gusen_source_record WHERE provider='svn' AND source_path=? "
        "AND source_namespace=? AND source_table=? AND source_id=? AND fun_id=?",
        (
            item["source_path"], item.get("source_namespace") or item.get("scope_entry_id") or item.get("working_copy_id") or "",
            item["source_table"], item["source_id"], item.get("fun_id") or "",
        ),
    ).fetchone()
    if source_record is None:
        raise ValueError(f"SVN source record was not inserted: {item['source_path']}")
    source_record_id = int(source_record["record_id"])
    page_data = None
    public_data = None
    if local_path.suffix.lower() == ".json":
        try:
            raw_json = raw_source
            if (item["source_table"] == "page"
                    and hashlib.sha256(raw_json).hexdigest() != item["source_hash"]):
                raise ValueError(f"PAGE projection source changed during scan: {item['source_path']}")
            parsed = json.loads(decode_source(raw_json)[0])
            parsed = json.loads(parsed) if isinstance(parsed, str) else parsed
            if item["source_table"] == "page" and isinstance(parsed, dict):
                page_data = parsed
            elif item["source_table"] == "public":
                public_data = parsed
        except (OSError, json.JSONDecodeError) as error:
            if item["source_table"] == "page":
                raise ValueError(f"PAGE projection source cannot be parsed: {item['source_path']}") from error
        if item["source_table"] == "page" and page_data is None:
            raise ValueError(f"PAGE projection source is not an object: {item['source_path']}")
    detail_index = source_facts.index_source_details(
        conn,
        source_record_id,
        item,
        list(item.get("scripts") or []),
        page_data=page_data,
        public_data=public_data,
    )
    fragments = detail_index["fragments"]
    for script in item.get("scripts") or []:
        if script.get("script_type") == "fields":
            continue
        index_calls(
            conn,
            item,
            workspace["layer"],
            workspace["scopeId"],
            workspace["projectId"],
            script["script_type"],
            local_path,
            script["content"],
            json_path=script.get("json_path") or item["source_path"],
            source_fragment_id=fragments.get(script.get("json_path") or ""),
            source_record_id=source_record_id,
        )


def _advance_page_semantic_generation(conn, *, full_rebuild=False):
    """Publish one visible PAGE projection snapshot in the surrounding SVN transaction."""

    if full_rebuild:
        from common import source_text_search
        conn.execute("INSERT OR REPLACE INTO gusen_sync_state(state_key,state_value) VALUES(?,?)", ("source_body_index_version",source_text_search.VERSION))
        conn.execute(
            "INSERT OR REPLACE INTO gusen_sync_state(state_key, state_value) VALUES(?, ?)",
            ("source_catalog_parser_version", SOURCE_CATALOG_VERSION),
        )
        conn.execute(
            "INSERT OR REPLACE INTO gusen_sync_state(state_key, state_value) VALUES(?, ?)",
            ("page_node_schema_version", str(source_facts.PAGE_NODE_SCHEMA_VERSION)),
        )
        conn.execute(
            "INSERT OR REPLACE INTO gusen_sync_state(state_key, state_value) VALUES(?, ?)",
            ("page_node_projection_version", source_facts.PAGE_NODE_PARSER_VERSION),
        )
        conn.execute(
            "INSERT OR REPLACE INTO gusen_sync_state(state_key, state_value) VALUES(?, ?)",
            ("page_field_schema_version", str(source_facts.PAGE_FIELD_SCHEMA_VERSION)),
        )
        conn.execute(
            "INSERT OR REPLACE INTO gusen_sync_state(state_key, state_value) VALUES(?, ?)",
            ("page_field_projection_version", source_facts.PAGE_FIELD_PARSER_VERSION),
        )
        conn.execute(
            "INSERT OR REPLACE INTO gusen_sync_state(state_key, state_value) VALUES(?, ?)",
            ("page_field_relation_schema_version", str(source_facts.PAGE_FIELD_RELATION_SCHEMA_VERSION)),
        )
        conn.execute(
            "INSERT OR REPLACE INTO gusen_sync_state(state_key, state_value) VALUES(?, ?)",
            ("page_field_relation_projection_version", source_facts.PAGE_FIELD_RELATION_PARSER_VERSION),
        )
    digest = hashlib.sha256()
    digest.update(json.dumps([SOURCE_CATALOG_VERSION, source_facts.PAGE_NODE_PARSER_VERSION,
                             source_facts.PAGE_FIELD_PARSER_VERSION, source_facts.PAGE_FIELD_RELATION_PARSER_VERSION]).encode("utf-8"))
    for row in conn.execute(
        "SELECT source_namespace,source_table,source_id,fun_id,source_path,source_hash,change_key,status "
        "FROM gusen_source_record WHERE provider='svn' "
        "ORDER BY source_namespace,source_table,source_id,fun_id,source_path"
    ):
        digest.update(json.dumps(tuple(row), ensure_ascii=False).encode("utf-8"))
    fingerprint = digest.hexdigest()
    previous = conn.execute("SELECT state_value FROM gusen_sync_state WHERE state_key='source_catalog_fingerprint'").fetchone()
    if previous and previous[0] == fingerprint:
        existing_generation = conn.execute("SELECT state_value FROM gusen_sync_state WHERE state_key='source_catalog_generation'").fetchone()
        if existing_generation:
            source_changes.publish(conn, existing_generation[0])
        return
    conn.execute("INSERT OR REPLACE INTO gusen_sync_state(state_key,state_value) VALUES(?,?)", ("source_catalog_fingerprint", fingerprint))
    generation = uuid.uuid4().hex
    source_changes.publish(conn, generation)
    for state_key in ("source_catalog_generation", "page_semantic_generation"):
        conn.execute(
            "INSERT OR REPLACE INTO gusen_sync_state(state_key, state_value) VALUES(?, ?)",
            (state_key, generation),
        )


def _cleanup_database_source_after_svn_index(workspace):
    """Remove an inactive DATABASE mirror only after a successful SVN index build."""

    source_root = (workspace["root"] / "source").resolve()
    readonly = workspace["readonlyDir"]
    workcopy = workspace["workcopyDir"]
    expected = {source_root / "readonly", source_root / "workcopy"}
    actual = {readonly.resolve(), workcopy.resolve()}
    if actual != expected or readonly.is_symlink() or workcopy.is_symlink():
        return {"status": "BLOCKED", "reason": "unexpected or symbolic DATABASE source path"}
    if workcopy.is_dir() and any(path.is_file() or path.is_symlink() for path in workcopy.rglob("*")):
        return {"status": "BLOCKED", "reason": "DATABASE workcopy contains files"}
    removed = []
    for path in (readonly, workcopy):
        if path.is_dir():
            shutil.rmtree(path)
            removed.append(str(path))
    return {"status": "REMOVED" if removed else "NOT_NEEDED", "paths": removed}


def _insert_svn_scan_item(conn, workspace, item, indexed_time):
    conn.execute("SAVEPOINT scan_item")
    try:
        _insert_svn_index_item(conn, workspace, item, indexed_time)
        conn.execute("RELEASE scan_item")
    except Exception:
        conn.execute("ROLLBACK TO scan_item")
        conn.execute("RELEASE scan_item")
        raise


def _store_svn_scan_diagnostics(conn, scan):
    for key, value in (
        ("svn_catalog_build_status", "PARTIAL" if scan["errors"] else "READY"),
        ("svn_catalog_errors", json.dumps(scan["errors"], ensure_ascii=False)),
    ):
        conn.execute("INSERT OR REPLACE INTO gusen_sync_state(state_key,state_value) VALUES(?,?)", (key, value))


def index_svn_workspace(conn, cfg, workspace, on_progress=None):
    checkpoint()
    svn_checkout.require_capability(workspace, "reindex")
    progress_label = workspace.get("displayName") or workspace["workspaceKey"]

    def progress(message: str) -> None:
        if on_progress is not None:
            on_progress(f"{progress_label}｜索引｜{message}")

    progress("开始重建本地 SVN 索引")
    if workspace["svn"].get("checkoutLayout") == "manifest-working-copies":
        from providers.svn.nexus import catalog

        scope = catalog.load_authorized_scope(workspace)
        progress(f"读取授权范围 · {len(scope.entries)} 个 working copy")
        progress("检查索引操作锁")
        with svn_checkout.operation_lock(workspace, "manifest-scan"):
            indexed_time = _now()
            try:
                progress("开始索引事务")
                conn.execute("BEGIN IMMEDIATE")
                conn.execute("DELETE FROM gusen_invoke_call")
                conn.execute("DELETE FROM gusen_dynamic_call")
                source_facts.clear_all_details(conn)
                conn.execute("DELETE FROM gusen_source_record")
                progress("清理旧索引完成，开始扫描授权 working copy")
                scan = catalog.scan(
                    workspace,
                    on_object=lambda item: _insert_svn_scan_item(conn, workspace, item, indexed_time),
                    collect_objects=False,
                    collect_modules=False,
                    on_progress=on_progress,
                )
                if any(error.get("code") not in {"PARSE_ERROR"} for error in scan["errors"]):
                    progress(f"扫描发现身份或范围错误，回滚并保留旧索引")
                    conn.rollback()
                    scan["indexPreserved"] = True
                else:
                    progress("扫描完成，写入 SVN 版本状态")
                    conn.execute(
                        "INSERT OR REPLACE INTO gusen_sync_state(state_key, state_value) VALUES(?, ?)",
                        ("svn_revision", scan["revision"]),
                    )
                    _store_svn_scan_diagnostics(conn, scan)
                    _advance_page_semantic_generation(conn, full_rebuild=True)
                    publication_barrier()
                    conn.commit()
                    scan["indexPreserved"] = False
                    progress("索引事务已提交" + ("（PARTIAL，坏文件见 errors）" if scan["errors"] else ""))
            except (Exception, OperationCancelled) as error:
                conn.rollback()
                progress("索引扫描已取消，事务已回滚" if isinstance(error, OperationCancelled) else "索引事务异常，已回滚并保留旧索引")
                raise
    else:
        from providers.svn import scanner

        scope = svn_checkout.load_scope(workspace)
        progress("读取 SVN 范围配置")
        progress("检查索引操作锁")
        with svn_checkout.operation_lock(workspace, "scan"):
            progress("扫描 SVN checkout")
            svn_checkout.verify_repository_fingerprint(workspace, scope.get("repositoryFingerprint") or "")
            scan = scanner.scan(workspace["checkoutPath"], scope)
            scan["errors"] = [*svn_checkout.validate_expected_changes(workspace, scan["status"]), *scan["errors"]]
            if not scan["errors"]:
                try:
                    progress("开始写入扫描结果")
                    conn.execute("BEGIN IMMEDIATE")
                    conn.execute("DELETE FROM gusen_invoke_call")
                    conn.execute("DELETE FROM gusen_dynamic_call")
                    source_facts.clear_all_details(conn)
                    conn.execute("DELETE FROM gusen_source_record")
                    indexed_time = _now()
                    for item in scan["objects"]:
                        checkpoint()
                        _insert_svn_index_item(conn, workspace, item, indexed_time)
                    conn.execute(
                        "INSERT OR REPLACE INTO gusen_sync_state(state_key, state_value) VALUES(?, ?)",
                        ("svn_revision", scan["revision"]),
                    )
                    _store_svn_scan_diagnostics(conn, scan)
                    _advance_page_semantic_generation(conn, full_rebuild=True)
                    publication_barrier()
                    conn.commit()
                    progress("扫描结果事务已提交")
                except (Exception, OperationCancelled) as error:
                    conn.rollback()
                    progress("索引扫描已取消，事务已回滚" if isinstance(error, OperationCancelled) else "扫描结果事务异常，已回滚并保留旧索引")
                    raise
    if scan["errors"]:
        preserved = scan.get("indexPreserved", True)
        progress(f"扫描错误 · {len(scan['errors'])} 个 · " + ("旧索引已保留" if preserved else "已发布部分可用索引"))
        return {
            "mode": "svn-scan",
            "provider": "svn",
            "workspaceKey": workspace["workspaceKey"],
            "revision": scan["revision"],
            "changed": 0 if preserved else conn.execute("SELECT COUNT(*) FROM gusen_source_record WHERE provider='svn'").fetchone()[0],
            "candidates": sum(scan["counts"].values()),
            "counts": scan["counts"],
            "failures": len(scan["errors"]),
            "errors": scan["errors"],
            "ignored": scan.get("ignored") or [],
            "indexPreserved": preserved,
            "buildStatus": "FAILED" if preserved else "PARTIAL",
            "checkoutClean": scan["status"]["clean"],
            "checkoutChanges": scan["status"]["changes"],
        }
    scope_count = len(scope.entries) if hasattr(scope, "entries") else 1
    progress(
        f"重建完成 · working copy {scope_count} 个 · "
        f"索引对象 {sum(scan['counts'].values())} 个"
    )
    return {
        "mode": "svn-scan",
        "provider": "svn",
        "workspaceKey": workspace["workspaceKey"],
        "revision": scan["revision"],
        "changed": sum(scan["counts"].values()),
        "candidates": sum(scan["counts"].values()),
        "counts": scan["counts"],
        "failures": len(scan["errors"]),
        "errors": scan["errors"],
        "ignored": scan.get("ignored") or [],
        "checkoutClean": scan["status"]["clean"],
        "checkoutChanges": scan["status"]["changes"],
        "providerCleanup": _cleanup_database_source_after_svn_index(workspace),
    }


def index_svn_workspace_working_copies(conn, cfg, workspace, working_copy_ids, on_progress=None):
    """Atomically rebuild only the selected physical SVN working copies."""

    from providers.svn.nexus import catalog

    svn_checkout.require_capability(workspace, "reindex")
    if workspace["svn"].get("checkoutLayout") != "manifest-working-copies":
        raise SystemExit("Scoped SVN indexing requires manifest-working-copies")
    selected = list(dict.fromkeys(str(value or "").strip() for value in working_copy_ids if str(value or "").strip()))
    if not selected:
        return {
            "mode": "svn-scoped-refresh",
            "provider": "svn",
            "workspaceKey": workspace["workspaceKey"],
            "workingCopyIds": [],
            "changed": 0,
            "failures": 0,
            "errors": [],
        }
    progress_label = workspace.get("displayName") or workspace["workspaceKey"]

    def progress(message: str) -> None:
        if on_progress is not None:
            on_progress(f"{progress_label}｜索引｜{message}")

    progress(f"开始按 working copy 增量重建 · {', '.join(selected)}")
    with svn_checkout.operation_lock(workspace, "manifest-scan", blocking=True):
        scan = catalog.scan(
            workspace,
            working_copy_ids=selected,
            collect_modules=False,
            on_progress=on_progress,
        )
        errors = list(scan["errors"])
        selected_set = set(selected)
        if errors:
            progress(f"扫描发现 {len(errors)} 个错误，保留旧索引")
            return {
                "mode": "svn-scoped-refresh",
                "provider": "svn",
                "workspaceKey": workspace["workspaceKey"],
                "workingCopyIds": selected,
                "changed": 0,
                "failures": len(errors),
                "errors": errors,
                "indexPreserved": True,
            }
        placeholders = ",".join("?" for _ in selected)
        try:
            conn.execute("BEGIN IMMEDIATE")
            skipped = set()
            ignored = list(scan.get("ignored") or [])
            for item in scan["objects"]:
                if item["source_table"] != "page":
                    continue
                collision = conn.execute(
                    """
                    SELECT source_table, source_id, fun_id, source_path, svn_revision, status,
                           scope_entry_id, source_namespace
                    FROM gusen_source_record
                    WHERE provider='svn' AND source_table=? AND source_id=? AND fun_id=?
                      AND working_copy_id NOT IN ({})
                      LIMIT 1
                    """.format(",".join("?" for _ in selected)),
                    (
                        item["source_table"],
                        item["source_id"],
                        item.get("fun_id") or "",
                        *selected,
                    ),
                ).fetchone()
                if collision:
                    collision_item = dict(collision)
                    if is_newer_page(item, collision_item):
                        _delete_svn_index_item(conn, workspace, collision_item)
                    else:
                        skipped.add(item["source_path"])
                        ignored.append(
                            {
                                "source_table": "page",
                                "source_id": item["source_id"],
                                "path": item["source_path"],
                                "keptPath": collision_item["source_path"],
                                "revision": item.get("svn_revision") or "",
                                "keptRevision": collision_item.get("svn_revision") or "",
                                "reason": "duplicate PAGE_ID; older SVN file excluded from source index",
                            }
                        )
            if errors:
                conn.rollback()
                progress(f"扫描发现 {len(errors)} 个错误，保留旧索引")
                return {
                    "mode": "svn-scoped-refresh",
                    "provider": "svn",
                    "workspaceKey": workspace["workspaceKey"],
                    "workingCopyIds": selected,
                    "changed": 0,
                    "failures": len(errors),
                    "errors": errors,
                    "indexPreserved": True,
                }
            existing = conn.execute(
                "SELECT source_table, source_id, fun_id, scope_entry_id, source_namespace "
                "FROM gusen_source_record "
                f"WHERE provider='svn' AND working_copy_id IN ({placeholders})",
                selected,
            ).fetchall()
            for row in existing:
                _delete_svn_index_item(conn, workspace, row)
            indexed_time = _now()
            for item in scan["objects"]:
                if item["source_path"] not in skipped:
                    _insert_svn_index_item(conn, workspace, item, indexed_time)
            _advance_page_semantic_generation(conn)
            conn.commit()
        except Exception:
            conn.rollback()
            progress("索引事务异常，已回滚并保留旧索引")
            raise
    changed = len(scan["objects"]) - len(skipped)
    progress(f"按 working copy 增量重建完成 · working copy {len(selected_set)} 个 · 对象 {changed} 个")
    return {
        "mode": "svn-scoped-refresh",
        "provider": "svn",
        "workspaceKey": workspace["workspaceKey"],
        "workingCopyIds": selected,
        "changed": changed,
        "failures": 0,
        "errors": [],
        "ignored": ignored,
        "indexPreserved": False,
    }


def index_svn_workspace_file(conn, cfg, workspace, source_path):
    """Atomically replace one physical file's objects and outgoing call edges."""

    from providers.svn.nexus import catalog

    svn_checkout.require_capability(workspace, "reindex")
    if workspace["svn"].get("checkoutLayout") != "manifest-working-copies":
        raise SystemExit("Incremental SVN indexing requires manifest-working-copies")
    with svn_checkout.operation_lock(workspace, "manifest-scan-file", blocking=True):
        scanned = catalog.scan_file(workspace, source_path)
        try:
            conn.execute("BEGIN IMMEDIATE")
            if scanned["errors"]:
                conn.execute(
                    "UPDATE gusen_source_record SET status='STALE', indexed_time=? "
                    "WHERE provider='svn' AND source_path=?",
                    (_now(), scanned["path"]),
                )
                if scanned["path"].casefold().endswith(".inherit.gss"):
                    child_path = scanned["path"][:-len(".inherit.gss")] + ".gss"
                    conn.execute(
                        "UPDATE gusen_source_record SET status='STALE', indexed_time=? "
                        "WHERE provider='svn' AND source_table='procedure' AND source_path=?",
                        (_now(), child_path),
                    )
                _advance_page_semantic_generation(conn)
                conn.commit()
                return {
                    "mode": "svn-incremental-scan",
                    "provider": "svn",
                    "workspaceKey": workspace["workspaceKey"],
                    "sourcePath": scanned["path"],
                    "changed": 0,
                    "failures": len(scanned["errors"]),
                    "errors": scanned["errors"],
                    "indexPreserved": True,
                }
            existing = conn.execute(
                "SELECT source_table, source_id, fun_id, scope_entry_id, source_namespace "
                "FROM gusen_source_record "
                "WHERE provider='svn' AND source_path=?",
                (scanned["path"],),
            ).fetchall()
            item = scanned["object"]
            if item and item["source_table"] == "page":
                collision = conn.execute(
                    """
                    SELECT source_table, source_id, fun_id, source_path, svn_revision, status,
                           scope_entry_id, source_namespace
                    FROM gusen_source_record
                    WHERE provider='svn' AND source_table=? AND source_id=? AND fun_id=? AND source_path<>?
                    LIMIT 1
                    """,
                    (item["source_table"], item["source_id"], item.get("fun_id") or "", scanned["path"]),
                ).fetchone()
                if collision:
                    collision_item = dict(collision)
                    if is_newer_page(item, collision_item):
                        _delete_svn_index_item(conn, workspace, collision_item)
                    else:
                        conn.commit()
                        return {
                            "mode": "svn-incremental-scan",
                            "provider": "svn",
                            "workspaceKey": workspace["workspaceKey"],
                            "sourcePath": scanned["path"],
                            "changed": 0,
                            "failures": 0,
                            "errors": [],
                            "ignored": [
                                {
                                    "source_table": "page",
                                    "source_id": item["source_id"],
                                    "path": item["source_path"],
                                    "keptPath": collision_item["source_path"],
                                    "revision": item.get("svn_revision") or "",
                                    "keptRevision": collision_item.get("svn_revision") or "",
                                    "reason": "duplicate PAGE_ID; older SVN file excluded from source index",
                                }
                            ],
                            "indexPreserved": True,
                        }
            for row in existing:
                _delete_svn_index_item(conn, workspace, row)
            if item:
                _insert_svn_index_item(conn, workspace, item, _now())
                if item["source_table"] == "procedure-inherit":
                    child_path = item["source_path"][:-len(".inherit.gss")] + ".gss"
                    child_scan = catalog.scan_file(workspace, child_path)
                    child_item = child_scan.get("object")
                    if child_item and child_item["source_table"] == "procedure" and not child_scan["errors"]:
                        previous_child = conn.execute(
                            "SELECT source_table, source_id, fun_id, scope_entry_id, source_namespace "
                            "FROM gusen_source_record WHERE provider='svn' AND source_path=?",
                            (child_path,),
                        ).fetchall()
                        for child_row in previous_child:
                            _delete_svn_index_item(conn, workspace, child_row)
                        _insert_svn_index_item(conn, workspace, child_item, _now())
            _advance_page_semantic_generation(conn)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        return {
            "mode": "svn-incremental-scan",
            "provider": "svn",
            "workspaceKey": workspace["workspaceKey"],
            "sourcePath": scanned["path"],
            "changed": 1,
            "failures": 0,
            "errors": [],
            "ignored": [],
            "indexPreserved": False,
        }


def workspace_index_path(cfg, value=None):
    return resolve_workspace(cfg, value)["indexPath"]


def resolve_datasource(cfg, name=None, workspace=None):
    if not name:
        workspace = workspace or resolve_workspace(cfg)
        name = workspace["datasourceName"]
    datasource = (cfg["datasource"].get("datasource") or {}).get(name)
    if not datasource:
        raise SystemExit(f"Unknown datasource: {name}")
    return name, datasource


def _sync_layer(conn, cfg, layer_cfg, layer, scope_id, project_id, sync_from, stats, workspace, force=False):
    ds_name = layer_cfg["datasource"]
    ds = cfg["datasource"]["datasource"][ds_name]
    table_cfg = cfg["source_tables"]
    rules = cfg["sync"].get("rules") or {}
    include = layer_cfg.get("include") or {}
    if not include.get("all") and not include.get("procedure_alias_prefix"):
        print("警告：include 未声明 all 或 procedure_alias_prefix，本次不会同步过程函数。", file=sys.stderr)
    with source_transaction(conn, workspace), db_connect(ds) as remote:
        system_scope = resolve_system_scope(remote, cfg, ds_name, workspace)
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
                    if upsert_source(conn, row, layer, scope_id, project_id, layer_cfg, system_scope, force=force, workspace=workspace):
                        stats["changed"] += 1
            cur.execute(inventory_query, inventory_params)
            current_page_ids = {row["source_id"] for row in cur.fetchall() if _included(layer_cfg, row)}
        stats["deleted"] = stats.get("deleted", 0) + reconcile_deleted_pages(conn, layer, scope_id, project_id, current_page_ids, workspace)
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


def upsert_source(conn, row, layer, scope_id, project_id, layer_cfg, system_scope, force=False, workspace=None):
    change_key = _change_key(row)
    source_alias_id = _source_alias_id(row)
    existing = conn.execute(
        """
        SELECT change_key, local_path FROM gusen_source_record
        WHERE source_layer=? AND scope_id=? AND project_id=? AND source_table=? AND source_id=? AND fun_id=?
        """,
        (layer, scope_id, project_id, row["source_table"], row["source_id"], row["fun_id"] or ""),
    ).fetchone()
    desired_path = source_base(row, layer, scope_id, project_id, layer_cfg, system_scope, workspace)
    if existing and existing["change_key"] == change_key and not force:
        indexed_path = ROOT / existing["local_path"] if existing["local_path"] else None
        if indexed_path.resolve() == desired_path.resolve() and desired_path.exists() and all(
            path.is_file() for path in _source_output_paths(row, desired_path)
        ):
            return False
    local_path, status, scripts = write_source(row, layer, scope_id, project_id, layer_cfg, system_scope, change_key, workspace)
    if existing and existing["local_path"]:
        old_path = ROOT / existing["local_path"]
        if old_path.resolve() != local_path.resolve():
            remove_source_path(old_path, workspace)
    indexed_time = _now()
    identity = (
        layer,
        scope_id,
        project_id,
        row["source_table"],
        row["source_id"],
        row["fun_id"] or "",
    )
    _delete_call_index(conn, identity)
    conn.execute(
        """
        INSERT OR REPLACE INTO gusen_source_record(
            source_layer, scope_id, project_id, source_table, source_id, source_alias_id, fun_id,
            source_name, version_mac, update_time, check_out_user_id, check_out_date, check_in_date,
            change_key, local_path, status, indexed_time
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            layer,
            scope_id,
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
            _indexed_path(local_path),
            status,
            indexed_time,
        ),
    )
    source_record = conn.execute(
        """
        SELECT record_id FROM gusen_source_record
        WHERE source_layer=? AND scope_id=? AND project_id=?
          AND source_table=? AND source_id=? AND fun_id=?
        """,
        identity,
    ).fetchone()
    if source_record is None:
        raise ValueError(f"Database source record was not inserted: {identity}")
    detail_scripts, page_data = _database_index_payload(row, local_path, scripts)
    detail_index = source_facts.index_source_details(
        conn,
        int(source_record["record_id"]),
        row,
        detail_scripts,
        page_data=page_data,
    )
    for script in detail_scripts:
        if script.get("script_type") == "fields":
            continue
        index_calls(
            conn,
            row,
            layer,
            scope_id,
            project_id,
            script["script_type"],
            script.get("path") or local_path,
            script["content"],
            json_path=script.get("json_path"),
            source_fragment_id=detail_index["fragments"].get(script.get("json_path") or ""),
        )
    return True


def remove_source_path(path: Path, workspace=None):
    root = (workspace or current_workspace())["readonlyDir"].resolve()
    target = path.resolve()
    if target == root or root not in target.parents:
        raise ValueError(f"Refusing to remove path outside readonly source: {path}")
    prepare_path(target)
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


def reconcile_deleted_pages(conn, layer, scope_id, project_id, current_page_ids, workspace=None):
    rows = conn.execute(
        """
        SELECT source_id, local_path FROM gusen_source_record
        WHERE source_layer=? AND scope_id=? AND project_id=? AND source_table=?
        """,
        (layer, scope_id, project_id, PAGE_SOURCE_TYPE),
    ).fetchall()
    stale = [row for row in rows if row["source_id"] not in current_page_ids]
    for row in stale:
        if row["local_path"]:
            remove_source_path(ROOT / row["local_path"], workspace)
        identity = (layer, scope_id, project_id, PAGE_SOURCE_TYPE, row["source_id"], "")
        _delete_call_index(conn, identity)
        conn.execute(
            "DELETE FROM gusen_source_record WHERE source_layer=? AND scope_id=? AND project_id=? AND source_table=? AND source_id=? AND fun_id=?",
            identity,
        )
    return len(stale)


def readonly_layer_root(layer, scope_id, project_id, layer_cfg, workspace=None):
    return (workspace or current_workspace())["readonlyDir"]


def source_base(row, layer, scope_id, project_id, layer_cfg, system_scope, workspace=None):
    system_name = _system_name(row, system_scope)
    layer_root = readonly_layer_root(layer, scope_id, project_id, layer_cfg, workspace)
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


def write_source(row, layer, scope_id, project_id, layer_cfg, system_scope, change_key, workspace=None):
    base = source_base(row, layer, scope_id, project_id, layer_cfg, system_scope, workspace)
    if row["source_table"] != PAGE_SOURCE_TYPE:
        system_name = _system_name(row, system_scope)
        layer_root = readonly_layer_root(layer, scope_id, project_id, layer_cfg, workspace)
        _link_shared_procedure_dirs(layer_root, system_name, row, system_scope)
    prepare_path(base)
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
            script_path = base / "scripts" / "compScript.vm"
            script_path.parent.mkdir(exist_ok=True)
            script_path.write_text("", encoding="utf-8")
            record_generated_files([base / "meta.json", script_path])
            return base, status, [("compScript", script_path, "")]
        (base / "raw.json").write_text(content, encoding="utf-8")
        scripts = parse_page_scripts(base, content)
    else:
        script_path = base / "source.vm"
        script_path.write_text(content, encoding="utf-8")
        scripts = [("procedure_script", script_path, content)]
    record_generated_files([base / "meta.json", *_source_output_paths(row, base)])
    return base, status, scripts


def _database_index_payload(row, local_path, scripts):
    """Return stable virtual fragments for DATABASE and the already parsed PAGE value."""

    if row["source_table"] != PAGE_SOURCE_TYPE:
        return (
            [
                {
                    "script_type": script_type,
                    "json_path": "",
                    "content": content,
                    "label": row.get("source_name") or row.get("fun_id") or row.get("source_id") or "",
                    "path": script_path,
                }
                for script_type, script_path, content in scripts
            ],
            None,
        )
    raw_path = local_path / "raw.json"
    if not raw_path.is_file():
        return [], None
    try:
        from common.page_projection import extract_page_fields, extract_page_scripts

        page_data = json.loads(raw_path.read_text(encoding="utf-8"))
        page_data = json.loads(page_data) if isinstance(page_data, str) else page_data
        if not isinstance(page_data, dict):
            return [], None
        fragments = [
            {
                "script_type": field.key,
                "json_path": field.json_pointer,
                "content": field.effective_value,
                "label": field.display_name,
                "path": raw_path,
            }
            for field in extract_page_scripts(page_data)
        ]
        fragments.extend(
            {
                "script_type": field["script_type"],
                "json_path": field["json_pointer"],
                "content": field["content"],
                "label": field["label"],
                "path": raw_path,
            }
            for field in extract_page_fields(page_data)
        )
        return fragments, page_data
    except (OSError, json.JSONDecodeError):
        return [], None


INHERIT_MARKER = re.compile(r"(?m)^[ \t]*(?:return[ \t]+)?@?inherit\(\);[ \t]*\r?$")


def _resolve_inherited_script(script, inherited):
    from common.inheritance import mask_noncode
    markers = list(INHERIT_MARKER.finditer(mask_noncode(script)))
    if not markers:
        return script
    resolved = inherited.rstrip("\r\n")
    for marker in reversed(markers):
        script = script[:marker.start()] + resolved + script[marker.end():]
    return script


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
    from common.page_projection import extract_page_scripts
    for field in extract_page_scripts(data, missing_product_as_empty=True):
        if not field.effective_value.strip() and field.key != "compScript":
            continue
        script_path = out_dir / _page_script_filename(list(field.display_path), field.key, field.event_type)
        script_path.write_text(field.effective_value, encoding="utf-8")
        scripts.append((field.key, script_path, field.effective_value))
    return scripts


def _page_script_filename(path, key, event_type):
    if key == "sql":
        ext = "sql"
    elif event_type:
        ext = "vm" if event_type == "serviceEvents" else "js"
    else:
        ext = "vm" if "SaveScript" in key or key in {"script", "doMethodScript", "compScript"} else "js"
    tab_index = next((i for i, part in enumerate(path) if re.fullmatch(r"tabPage\d+", part)), None)
    name_parts = path[tab_index:] if tab_index is not None else path[-2:]
    table_index = next((i for i, part in enumerate(name_parts[1:], 1) if part in {"mainTable", "detailTable"}), None)
    if table_index is not None:
        name_parts = name_parts[:1] + name_parts[table_index:]
    name_parts = [part for i, part in enumerate(name_parts) if i == 0 or part != name_parts[i - 1]]
    name = path_part(".".join(name_parts + [key])) if path else path_part(key)
    return f"{name}.{ext}"


def _source_output_paths(row, base):
    if row["source_table"] != PAGE_SOURCE_TYPE:
        return [base / "source.vm"]
    content = row.get("source_content") or ""
    if not content:
        return [base / "scripts" / "compScript.vm"]
    try:
        data = json.loads(content)
        if isinstance(data, str):
            data = json.loads(data)
    except Exception:
        return [base / "raw.json"]
    from common.page_projection import extract_page_scripts
    return [
        base / "raw.json",
        *(base / "scripts" / _page_script_filename(list(field.display_path), field.key, field.event_type)
          for field in extract_page_scripts(data, missing_product_as_empty=True) if field.effective_value.strip() or field.key == "compScript"),
    ]


CALL_PATTERNS = [
    ("proc_invoke", re.compile(r"\$vs\.proc\.invoke\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]")),
    ("vm_open", re.compile(r"\$vm\.open\(\s*['\"]([^'\"]+)['\"]")),
    ("vm_open_dialog", re.compile(r"\$vm\.openDialog\(\s*['\"]([^'\"]+)['\"]")),
    ("gutil_request", re.compile(r"gUtil\.request\(\s*['\"]([^'\"]+)['\"]")),
]
PROC_FIND = re.compile(r"#set\s*\(\s*\$(\w+)\s*=\s*\$vs\.proc\.find\(\s*['\"]([^'\"]+)['\"]\s*\)")


def index_calls(
    conn,
    row,
    layer,
    scope_id,
    project_id,
    script_type,
    script_path,
    content,
    json_path=None,
    source_fragment_id=None,
    source_record_id=None,
):
    stored_path = json_path or _indexed_path(script_path)
    if source_record_id is None:
        source_record = conn.execute(
            """
            SELECT record_id AS source_record_id
            FROM gusen_source_record
            WHERE source_layer=? AND scope_id=? AND project_id=?
              AND source_table=? AND source_id=? AND fun_id=?
            """,
            (
                layer,
                scope_id,
                project_id,
                row["source_table"],
                row["source_id"],
                row["fun_id"] or "",
            ),
        ).fetchone()
        if source_record is None:
            raise ValueError(
                f"Call index source record is missing: {row['source_table']}/{row['source_id']}/{row['fun_id'] or ''}"
            )
        source_record_id = source_record["source_record_id"]
    bindings = {}
    for line_no, line in enumerate(content.splitlines(), 1):
        assignments = list(re.finditer(r"#set\s*\(\s*\$(\w+)\s*=", line))
        for assignment in assignments:
            bindings.pop(assignment.group(1), None)
        for find in PROC_FIND.finditer(line):
            bindings[find.group(1)] = find.group(2)
        for var, alias in bindings.items():
            match = re.search(rf"\${re.escape(var)}\.([A-Za-z_][A-Za-z0-9_]*)\(", line)
            if match:
                _insert_call(
                    conn, source_record_id, source_fragment_id, script_type, stored_path, line_no,
                    alias, match.group(1), "proc_find_call",
                )
        for invoke_type, pattern in CALL_PATTERNS:
            match = pattern.search(line)
            if not match:
                continue
            target_alias = match.group(1)
            target_fun = match.group(2) if invoke_type == "proc_invoke" and len(match.groups()) > 1 else ""
            _insert_call(
                conn, source_record_id, source_fragment_id, script_type, stored_path, line_no,
                target_alias, target_fun, invoke_type,
            )
        if "$vs.proc.invoke(" in line and not re.search(r"\$vs\.proc\.invoke\(\s*['\"]", line):
            conn.execute(
                """
                INSERT INTO gusen_dynamic_call(
                    source_record_id, source_fragment_id, script_type, json_path, line_no, invoke_expr, reason
                ) VALUES(?,?,?,?,?,?,?)
                """,
                (
                    source_record_id,
                    source_fragment_id,
                    script_type,
                    stored_path,
                    line_no,
                    line.strip(),
                    "目标过程别名或函数名来自变量",
                ),
            )


def _insert_call(
    conn,
    source_record_id,
    source_fragment_id,
    script_type,
    json_path,
    line_no,
    target_alias,
    target_fun,
    invoke_type,
):
    conn.execute(
        """
        INSERT INTO gusen_invoke_call(
            source_record_id, source_fragment_id, script_type, json_path, line_no,
            target_alias_id, target_fun_id, invoke_type
        ) VALUES(?,?,?,?,?,?,?,?)
        """,
        (
            source_record_id,
            source_fragment_id,
            script_type,
            str(json_path),
            line_no,
            target_alias,
            target_fun,
            invoke_type,
        ),
    )


def reindex_local_calls(conn):
    conn.execute("DELETE FROM gusen_invoke_call")
    conn.execute("DELETE FROM gusen_dynamic_call")
    source_facts.clear_all_details(conn, preserve_external_bill_routes=True)
    indexed = 0
    rows = conn.execute("SELECT * FROM gusen_source_record WHERE status='OK' ORDER BY local_path").fetchall()
    for row in rows:
        base = ROOT / row["local_path"]
        if row["source_table"] == PAGE_SOURCE_TYPE:
            written_scripts = [
                (path.stem, path, path.read_text(encoding="utf-8"))
                for path in sorted((base / "scripts").glob("*"))
                if path.is_file()
            ]
        else:
            path = base / "source.vm"
            written_scripts = [("procedure_script", path, path.read_text(encoding="utf-8"))] if path.is_file() else []
        scripts, page_data = _database_index_payload(dict(row), base, written_scripts)
        details = source_facts.index_source_details(
            conn,
            int(row["record_id"]),
            dict(row),
            scripts,
            page_data=page_data,
        )
        for script in scripts:
            if script.get("script_type") == "fields":
                continue
            index_calls(
                conn,
                dict(row),
                row["source_layer"],
                row["scope_id"],
                row["project_id"],
                script["script_type"],
                script.get("path") or base,
                script["content"],
                json_path=script.get("json_path"),
                source_fragment_id=details["fragments"].get(script.get("json_path") or ""),
            )
            indexed += 1
    conn.commit()
    return indexed


def export_product_docs(conn, scope_id, workspace=None):
    out = (workspace or current_workspace())["contextDir"]
    out.mkdir(parents=True, exist_ok=True)
    rows = conn.execute(
        """
        SELECT * FROM gusen_source_record
        WHERE source_layer='PRODUCT' AND scope_id=?
        ORDER BY source_table, source_alias_id, fun_id
        """,
        (scope_id,),
    ).fetchall()
    _write_table(
        out / "source-index.md",
        "产品源码索引",
        ["类型", "别名", "函数", "名称", "状态", "本地路径"],
        [[r["source_table"], r["source_alias_id"], r["fun_id"], r["source_name"], r["status"], r["local_path"]] for r in rows],
    )
    calls = conn.execute(
        """
        SELECT * FROM gusen_invoke_call_detail
        WHERE source_layer='PRODUCT' AND scope_id=?
        ORDER BY source_table, source_alias_id, fun_id, line_no
        """,
        (scope_id,),
    ).fetchall()
    _write_table(
        out / "invoke-index.md",
        "产品调用索引",
        ["来源类型", "来源别名", "来源函数", "脚本位置", "行号", "调用类型", "目标别名", "目标函数", "置信度"],
        [[c["source_table"], c["source_alias_id"], c["fun_id"], c["json_path"], c["line_no"], c["invoke_type"], c["target_alias_id"], c["target_fun_id"], c["confidence"]] for c in calls],
    )
    dynamic_calls = conn.execute(
        """
        SELECT * FROM gusen_dynamic_call_detail
        WHERE source_layer='PRODUCT' AND scope_id=?
        ORDER BY source_table, source_alias_id, fun_id, line_no
        """,
        (scope_id,),
    ).fetchall()
    _write_table(
        out / "dynamic-invoke-points.md",
        "产品动态调用点",
        ["来源类型", "来源别名", "来源函数", "脚本位置", "行号", "原因", "表达式", "置信度"],
        [[c["source_table"], c["source_alias_id"], c["fun_id"], c["json_path"], c["line_no"], c["reason"], c["invoke_expr"], c["confidence"]] for c in dynamic_calls],
    )


def export_project_docs(conn, project_id, workspace=None):
    out = (workspace or current_workspace())["contextDir"]
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
                SELECT * FROM gusen_invoke_call_detail
                WHERE source_layer=? AND scope_id=? AND project_id=? AND source_table=? AND source_id=? AND fun_id=?
                ORDER BY source_alias_id, fun_id, line_no
                """,
                (
                    "PROJECT",
                    row["scope_id"],
                    project_id,
                    row["source_table"],
                    row["source_id"],
                    row["fun_id"],
                ),
            ).fetchall()
        )
    _write_table(out / "invoke-index.md", "项目调用索引", ["来源层", "来源类型", "来源别名", "来源函数", "脚本位置", "行号", "调用类型", "目标别名", "目标函数", "置信度"], [[c["source_layer"], c["source_table"], c["source_alias_id"], c["fun_id"], c["script_type"], c["line_no"], c["invoke_type"], c["target_alias_id"], c["target_fun_id"], c["confidence"]] for c in calls])


def export_knowledge_readme(conn, index_db, active, source_mode="database"):
    out = current_workspace()["contextDir"]
    out.mkdir(parents=True, exist_ok=True)
    source_mode = str(source_mode or "database").strip().lower()
    if source_mode not in SOURCE_MODES:
        raise ValueError(f"Unsupported source mode for knowledge README: {source_mode}")
    source_count = conn.execute("SELECT COUNT(*) FROM gusen_source_record").fetchone()[0]
    call_count = conn.execute("SELECT COUNT(*) FROM gusen_invoke_call").fetchone()[0]
    dynamic_count = conn.execute("SELECT COUNT(*) FROM gusen_dynamic_call").fetchone()[0]
    lines = [
        "# 谷神源码知识入口",
        "",
        f"- 当前索引：`{index_db}`",
        f"- 当前工作区：`{active}`",
        f"- 当前源码模式：`{source_mode.upper()}`",
        f"- 生成时统计：源码对象 {source_count}，静态调用 {call_count}，动态调用点 {dynamic_count}",
        "",
        "AI 开发先按问题类型查询有界索引，不读取全量 Markdown 索引，也不直接依赖内部表结构：",
        "",
        "```text",
    ]
    if source_mode == "svn":
        lines.extend(
            [
                f'command + ["svn", "--home", home, "--workspace", "{active}", "--", "facts", "--keyword", "<错误、条件、字段或业务词>"]',
                f'command + ["svn", "--home", home, "--workspace", "{active}", "--", "explain", "--table", "<表名>"]',
                f'command + ["svn", "--home", home, "--workspace", "{active}", "--", "explain", "--bill-type", "<单据类型>", "--data-source-id", "<数据源ID>"]',
            ]
        )
    else:
        lines.extend(
            [
                f'command + ["query", "--home", home, "--workspace", "{active}", "--", "facts", "--keyword", "<错误、条件、字段或业务词>"]',
                f'command + ["query", "--home", home, "--workspace", "{active}", "--", "explain", "--table", "<表名>"]',
                f'command + ["query", "--home", home, "--workspace", "{active}", "--", "explain", "--bill-type", "<单据类型>", "--data-source-id", "<数据源ID>"]',
            ]
        )
    lines.extend(
        [
            f'command + ["query", "--home", home, "--workspace", "{active}", "--", "find", "<对象名、别名或ID>"]',
            f'command + ["query", "--home", home, "--workspace", "{active}", "--", "context", "--source-id", "<source_id>", "--fun", "<fun_id>"]',
            f'command + ["query", "--home", home, "--workspace", "{active}", "--", "callers", "--alias", "<source_alias_id>", "--fun", "<fun_id>"]',
            "```",
            "",
            "其中 `command` 和 `home` 读取自 `var/nexus/tool-runtime.json`；该文件由 Guthon Nexus 按当前发行或调试模式生成。对象名不明确时才用 `find`，共享函数或跨对象影响分析时才补 `context`/`callers`。",
            "",
            "默认只读取首屏结果；仅在证据不足时使用返回的 `continuationToken` 续查。PAGE 行号属于返回的 JSON Pointer 片段，不是原始 JSON 文件行号。索引是静态定位证据，实际修改前仍须按 provider 读取目标源码。",
            "",
            "全量 Markdown 仅在显式运行统一 CLI 的 `export-markdown` 时生成；默认使用上述有界查询。",
        ]
    )
    path = out / "README.md"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def _row_value(row, key, default=""):
    if row is None:
        return default
    if isinstance(row, dict):
        return row.get(key, default)
    return row[key] if key in row.keys() else default


def _auto_add_work_copy(cfg: dict, target: Path, generated_paths=()):
    if not (cfg.get("sync", {}).get("rules") or {}).get("pull_auto_add_git"):
        return {"gitAddStatus": "DISABLED", "gitAdded": 0}
    if os.environ.get("GUTHON_DEFER_GIT_ADD") == "1":
        return {"gitAddStatus": "DEFERRED", "gitAdded": 0}
    return _add_generated_paths(generated_paths)


def _add_generated_paths(generated_paths, before=()):
    repo_root = Path(VAR_DIR).resolve()
    try:
        root = subprocess.run(["git", "-C", str(repo_root), "rev-parse", "--show-toplevel"],
                              capture_output=True, text=True, check=False)
    except FileNotFoundError:
        return {"gitAddStatus": "GIT_UNAVAILABLE", "gitAdded": 0}
    if root.returncode or Path(root.stdout.strip()).resolve() != repo_root:
        return {"gitAddStatus": "OUTSIDE_VAR_REPOSITORY", "gitAdded": 0}
    allowed = set()
    for path in generated_paths:
        path = Path(path).resolve()
        try:
            relative = path.relative_to(repo_root)
        except ValueError:
            continue
        if path.is_file() and WORK_COPY_TRASH_DIR not in relative.parts:
            allowed.add(relative.as_posix())
    with file_lock(repo_root / '.guthon' / 'git-add.lock'):
        paths = sorted(allowed & (untracked_files(repo_root) - set(before)))
        if not paths:
            return {"gitAddStatus": "NO_NEW_FILES", "gitAdded": 0}
        try:
            result = subprocess.run(
                ["git", "-C", str(repo_root), "add", "--pathspec-from-file=-", "--pathspec-file-nul"],
                input="\0".join(paths) + "\0", capture_output=True, text=True, check=False,
            )
        except FileNotFoundError:
            return {"gitAddStatus": "GIT_UNAVAILABLE", "gitAdded": 0}
    if result.returncode:
        return {"gitAddStatus": "FAILED", "gitAdded": 0, "gitAddMessage": result.stderr.strip()}
    return {"gitAddStatus": "ADDED", "gitAdded": len(paths), "gitRoot": str(repo_root)}


def untracked_files(repo_root=None, pathspec=None):
    repo_root = repo_root or VAR_DIR
    command = ["git", "-C", str(repo_root), "ls-files", "--others", "--exclude-standard", "-z"]
    if pathspec:
        command.extend(["--", *pathspec])
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return set()
    return set(result.stdout.split("\0")) - {""} if result.returncode == 0 else set()


def workspace_var_prefix(workspace):
    try:
        return workspace["root"].resolve().relative_to(VAR_DIR.resolve()).as_posix() + "/"
    except ValueError:
        return ""


def auto_add_operation_files(config, before, workspace, generated_paths=()):
    if not (config.get("sync", {}).get("rules") or {}).get("pull_auto_add_git"):
        return {"gitAddStatus": "DISABLED", "gitAdded": 0}
    root = workspace["root"].resolve()
    paths = [Path(path) for path in generated_paths if Path(path).resolve().is_relative_to(root)]
    return _add_generated_paths(paths, before)


def pull_source_to_work_copy(payload: dict):
    cfg = load_config()
    route = route_workspace_request(cfg, payload)
    if not route["ok"]:
        return route
    payload = {**payload, "workspaceKey": route["workspaceKey"]}
    set_workspace(route["workspaceKey"])
    workspace = resolve_workspace(cfg)
    if workspace.get("sourceMode") == "svn":
        if payload.get("client") == "bridge-legacy-pull":
            raise SystemExit(
                "pullHubSource is unavailable in SVN source mode; use the Guthon Nexus SVN source tree"
            )
        svn_checkout.require_capability(workspace, "workcopy")
        source_type = payload.get("sourceType") or ""
        if source_type not in SVN_SOURCE_TYPES:
            raise SystemExit(f"Unsupported SVN sourceType: {source_type}")
        with index_connection(workspace, action="workcopy-read", readonly=True) as conn:
            row = find_svn_source(
                conn,
                workspace,
                source_type,
                payload.get("sourceId") or "",
                payload.get("alias") or "",
                payload.get("funId") or "",
            )
            work_result = create_work_copy_from_row(conn, cfg, row, workspace)
            source = {
                key: _str(row[key]) if key in row.keys() else ""
                for key in ("source_table", "source_id", "source_alias_id", "fun_id", "source_name")
            }
        return {
            "ok": True,
            "workspaceKey": workspace["workspaceKey"],
            "changed": False,
            "message": "已从本地 SVN 索引打开 Workcopy；未访问数据库",
            "workCopyPath": work_result["path"],
            "workCopyStatus": work_result["state"],
            "workCopyAction": work_result["action"],
            "localChanged": work_result["localChanged"],
            "pulled": 1,
            "provider": "svn",
            "source": source,
        }
    layer, scope_id, project_id, layer_cfg = resolve_pull_scope(cfg, payload)
    rules = cfg["sync"].get("rules") or {}
    force = payload.get("force", False)
    if not isinstance(force, bool):
        raise SystemExit("pull force must be a boolean")
    if force and payload.get("confirmation") != workspace["workspaceKey"]:
        raise SystemExit("pull force requires confirmation equal to the exact workspaceKey")
    pull_diff_check = rules.get("pull_diff_check", True) and not force
    with index_connection(workspace, action="workcopy-pull", readonly=False) as conn:
        sql, params = single_source_sql(cfg["source_tables"], payload["sourceType"], payload, rules)
        ds_name = layer_cfg["datasource"]
        ds = cfg["datasource"]["datasource"][ds_name]
        with db_connect(ds) as remote:
            system_scope = resolve_system_scope(remote, cfg, ds_name, workspace)
            model_paths = load_model_paths(remote, cfg["source_tables"]) if payload["sourceType"] == PAGE_SOURCE_TYPE else {}
            with remote.cursor() as cur:
                cur.execute(sql, params)
                row = cur.fetchone()
                rows = [row] if row else []
                if row and row["source_table"] == PAGE_SOURCE_TYPE and row.get("mk_id") and rules.get("pull_more_page", False):
                    module_sql, module_params = module_page_sql(cfg["source_tables"], row, rules)
                    cur.execute(module_sql, module_params)
                    rows = cur.fetchall()
        for candidate in rows:
            if candidate["source_table"] == PAGE_SOURCE_TYPE:
                candidate["model_path"] = model_paths.get(_str(candidate.get("model_id")))
        if not row:
            if project_id:
                found = find_work_copy_source(
                    conn, None, project_id, payload["sourceType"], payload.get("alias") or payload.get("sourceId") or "", payload.get("funId") or ""
                )
                return {
                    "ok": False, "errorCode": "SOURCE_NOT_FOUND", "workspaceKey": workspace["workspaceKey"],
                    "changed": False, "pulled": 0, "cacheAvailable": True,
                    "message": "远程源码未找到；本地缓存存在，未修改 Workcopy。需要缓存时显式执行 create-workcopy。",
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
        with source_transaction(conn, workspace):
            for candidate in rows:
                changed = upsert_source(
                    conn,
                    candidate,
                    layer,
                    scope_id,
                    project_id,
                    layer_cfg,
                    system_scope,
                    force=not pull_diff_check or force,
                    workspace=workspace,
                ) or changed
        for candidate in rows:
            work_results.append(create_work_copy_from_row(conn, cfg, candidate, workspace, diff_check=pull_diff_check))
        conn.commit()
        try:
            work_copy_path = os.path.commonpath([result["path"] for result in work_results])
        except ValueError:
            work_copy_path = work_results[0]["path"] if work_results else ""
        local_changed = any(result["localChanged"] for result in work_results)
        return {
            "ok": True,
            "workspaceKey": workspace["workspaceKey"],
            "changed": changed,
            "message": "拉取成功, 已覆盖 readonly/workcopy" if not pull_diff_check else "拉取成功, 已保留本地修改" if local_changed else "拉取成功" if changed else "拉取成功, 无变更",
            "workCopyPath": work_copy_path,
            "workCopyStatus": work_results[0]["state"] if len(work_results) == 1 else "MULTIPLE",
            "workCopyAction": work_results[0]["action"] if len(work_results) == 1 else "MULTIPLE",
            "localChanged": local_changed,
            "gitAddStatus": work_results[0].get("gitAddStatus", "DISABLED") if len(work_results) == 1 else "MULTIPLE",
            "gitAdded": sum(result.get("gitAdded", 0) for result in work_results),
            "pulled": len(work_results),
            "source": {key: _str(row.get(key)) for key in ("source_table", "source_id", "source_alias_id", "fun_id", "source_name")},
        }


def resolve_pull_scope(cfg: dict, payload: dict):
    workspace = resolve_workspace(cfg, payload.get("workspaceKey"))
    return workspace["layer"], workspace["scopeId"], workspace["projectId"], workspace["config"]


def pull_source_payload_from_args(workspace, source_type, source_id, alias, fun, force=False):
    return {
        "workspaceKey": workspace,
        "sourceType": source_type,
        "sourceId": source_id,
        "alias": alias,
        "funId": fun,
        "force": force,
    }


def pull_source_to_work_copy_cli(args=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--json-stdin", action="store_true")
    parser.add_argument("--workspace")
    parser.add_argument("--type", dest="source_type", choices=[PAGE_SOURCE_TYPE, PROCEDURE_SOURCE_TYPE])
    parser.add_argument("--source-id")
    parser.add_argument("--alias")
    parser.add_argument("--fun")
    parser.add_argument("--force", action="store_true")
    parsed = parser.parse_args(args)
    if parsed.json_stdin:
        payload = json.loads(sys.stdin.read() or "{}")
    else:
        payload = pull_source_payload_from_args(parsed.workspace, parsed.source_type, parsed.source_id, parsed.alias, parsed.fun, parsed.force)
    result = pull_source_to_work_copy(payload)
    if result.get("workspaceSelectionRequired"):
        print(json.dumps(result, ensure_ascii=False))
        return
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


def find_work_copy_source(conn, scope_id, project_id, source_type, alias, fun):
    if scope_id:
        row = conn.execute(
            """
            SELECT * FROM gusen_source_record
            WHERE source_layer='PRODUCT' AND scope_id=? AND source_table=? AND source_alias_id=? AND fun_id=?
            """,
            (scope_id, source_type, alias, fun),
        ).fetchone()
        if not row:
            raise SystemExit("Product source not found. Run sync first.")
        return row
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
    return row


def find_svn_source(conn, workspace, source_type, source_id="", alias="", fun=""):
    filters = ["provider='svn'", "source_table=?"]
    params = [source_type]
    if source_id:
        filters.append("source_id=?")
        params.append(source_id)
    elif alias:
        filters.append("source_alias_id=?")
        params.append(alias)
        if source_type in {PROCEDURE_SOURCE_TYPE, "system-script"}:
            if not fun:
                raise SystemExit(f"funId is required for SVN {source_type}")
            filters.append("fun_id=?")
            params.append(fun)
    else:
        raise SystemExit("SVN sourceId or alias is required")
    rows = conn.execute(
        "SELECT * FROM gusen_source_record WHERE " + " AND ".join(filters) + " ORDER BY source_path LIMIT 2",
        params,
    ).fetchall()
    if not rows:
        raise SystemExit("SVN source is not present in the current local index; run reindex first")
    if len(rows) > 1:
        raise SystemExit("SVN source identity is ambiguous; use sourceId and funId")
    return rows[0]


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
    return _str(_row_value(row, "source_alias_id")) or _str(_row_value(row, "source_id"))


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
    raise SystemExit("Use scripts/guthon_tool.py with an explicit --home and command")


# Public workspace APIs are aliases to the owning implementation.
from common.workspace_registry import (
    workspace_steps,
    _database_capabilities,
    _svn_capabilities,
    workspace_key,
    set_workspace,
    workspace_source_mode_path,
    read_workspace_source_mode,
    write_workspace_source_mode,
    change_workspace_source_mode,
    resolve_workspace_storage_root,
    _list_workspaces_strict,
    list_workspaces,
    _validate_svn_workspace_boundaries,
    resolve_workspace,
    resolve_workspace_for_path,
    workspace_index_state,
    index_first_examples,
    workspace_agent_context,
    _workspace_cockpit,
    workspace_config_digest,
    legacy_workspace_config_digest,
    load_workspace_state,
    update_workspace_state,
    _svn_source_control_groups,
    workspace_summary,
)


# Workcopy lifecycle APIs have a single implementation; keep facade aliases.
from common.workcopy_store import (
    _work_copy_change_key,
    _tree_files,
    _tree_changes,
    _work_copy_metadata,
    _display_path,
    _write_work_copy_metadata,
    _replace_work_copy_source,
    _manual_diff_notes,
    _json_path_changes,
    _render_file_diff,
    _work_copy_state,
    _write_work_copy_diff,
    _write_work_copy_delivery,
    _initialize_work_copy,
    _trash_work_copy,
    _prepare_work_copy,
    _current_work_copy_source,
    inspect_work_copy,
    restore_work_copy,
    work_copy_cli,
    create_work_copy,
    create_work_copy_from_row,
    _work_copy_source_relative_path,
)

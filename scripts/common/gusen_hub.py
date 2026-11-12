"""API workspace/configuration facade shared by CLI, Nexus and read-only diagnostics."""

from __future__ import annotations
from contextlib import contextmanager
from contextvars import ContextVar
import datetime as dt
import json
import os
from pathlib import Path
import re
import sqlite3
from common.runtime_paths import RuntimePath, tool_home as tool_home
from common.persistence import file_lock
from common.workspace_identity import validate_workspace_key

ROOT = RuntimePath()
CONFIG_DIR = RuntimePath("config")
VAR_DIR = RuntimePath("var")
SOURCE_MODES = {"api"}
WORKSPACE_STEPS = ("source", "index")
WORKSPACE_ENV = "GUTHON_WORKSPACE"
_CURRENT_WORKSPACE = ContextVar("guthon_current_workspace", default="")
_GENERATED_FILES = ContextVar("guthon_generated_files", default=None)


class IndexRebuildRequired(SystemExit):
    error_code = "INDEX_REBUILD_REQUIRED"


class IndexPartialError(SystemExit):
    error_code = "INDEX_PARTIAL"


@contextmanager
def operation_generated_files():
    paths = set()
    token = _GENERATED_FILES.set(paths)
    try:
        yield paths
    finally:
        _GENERATED_FILES.reset(token)


def record_generated_files(paths):
    current = _GENERATED_FILES.get()
    if current is not None:
        current.update(Path(p).resolve() for p in paths)


def set_workspace(value):
    _CURRENT_WORKSPACE.set(validate_workspace_key(value))


def load_config():
    files = {
        "products": "products.yaml",
        "projects": "projects.yaml",
        "sync": "sync.yaml",
        "datasource": "datasource.yaml",
    }
    result = {
        key: load_yaml(CONFIG_DIR / name) if (CONFIG_DIR / name).is_file() else {}
        for key, name in files.items()
    }
    if (
        not (CONFIG_DIR / "projects.yaml").is_file()
        or not (CONFIG_DIR / "products.yaml").is_file()
    ):
        raise SystemExit(
            "Missing workspace configuration; run setup with an explicit --home"
        )
    return result


def path_part(value):
    return (
        re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", str(value)).strip().rstrip(".")
        or "unnamed"
    )


def current_workspace(config=None):
    return resolve_workspace(config or load_config())


def ensure_workspace_structure(workspace):
    for key in ("contextDir", "docsDir", "logsDir", "providerSourceRoot"):
        workspace[key].mkdir(parents=True, exist_ok=True)


def workspace_index_path(config, value=None):
    return resolve_workspace(config, value)["indexPath"]


@contextmanager
def index_connection(
    workspace, *, action="index-read", readonly=True, rebuild_incompatible=False
):
    path = workspace["indexPath"]
    if readonly and not path.is_file():
        raise IndexRebuildRequired("API index is not initialized; run api index")
    path.parent.mkdir(parents=True, exist_ok=True)
    with file_lock(workspace["contextDir"] / "api/index.lock"):
        conn = (
            sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
            if readonly
            else sqlite3.connect(path)
        )
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            if not readonly:
                conn.commit()
        except BaseException:
            if not readonly:
                conn.rollback()
            raise
        finally:
            conn.close()


def connect_index(path, *, readonly=False, rebuild_incompatible=False):
    path = Path(path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = (
        sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
        if readonly
        else sqlite3.connect(path)
    )
    conn.row_factory = sqlite3.Row
    return conn


def resolve_datasource(config, name=None, workspace=None):
    if not name:
        workspace = workspace or resolve_workspace(config)
        name = workspace.get("datasourceName")
    item = (config.get("datasource", {}).get("datasource") or {}).get(name)
    if not item:
        raise SystemExit("明确选择只读诊断数据源，API源码同步不使用数据库连接")
    return name, item


def source_dir(workspace=None):
    return (workspace or current_workspace())["providerSourceRoot"]


def find_source_candidates(conn, scope_id, keyword, limit=10, include_paths=False):
    pattern = "%" + str(keyword).lower() + "%"
    return conn.execute(
        "SELECT * FROM gusen_source_record WHERE scope_id=? AND (lower(source_id) LIKE ? OR lower(source_alias_id) LIKE ? OR lower(source_name) LIKE ?) ORDER BY source_id,fun_id LIMIT ?",
        (scope_id, pattern, pattern, pattern, min(max(int(limit), 1), 100)),
    ).fetchall()


def query_incoming_callers(conn, scope_id, target_alias_id, target_fun_id, limit=100):
    return conn.execute(
        "SELECT c.*,s.source_id,s.source_alias_id,s.source_path,s.fun_id,s.source_name FROM gusen_invoke_call c JOIN gusen_source_record s ON s.record_id=c.source_record_id WHERE s.scope_id=? AND c.target_alias_id=? AND c.target_fun_id=? ORDER BY s.source_id,c.line_no LIMIT ?",
        (scope_id, target_alias_id, target_fun_id, min(int(limit), 100)),
    ).fetchall()


def query_source_context(conn, scope_id, source_id, fun_id="", limit=20):
    rows = conn.execute(
        'SELECT * FROM gusen_source_record WHERE scope_id=? AND source_id=? AND (?="" OR fun_id=?)',
        (scope_id, source_id, fun_id, fun_id),
    ).fetchall()
    if not rows:
        return {"source": None, "incoming": [], "outgoing": [], "dynamic": []}
    row = rows[0]
    return {
        "source": dict(row),
        "incoming": [
            dict(x)
            for x in query_incoming_callers(
                conn, scope_id, row["source_alias_id"], row["fun_id"], limit
            )
        ],
        "outgoing": [
            dict(x)
            for x in conn.execute(
                "SELECT * FROM gusen_invoke_call WHERE source_record_id=? LIMIT ?",
                (row["record_id"], limit),
            )
        ],
        "dynamic": [
            dict(x)
            for x in conn.execute(
                "SELECT * FROM gusen_dynamic_call WHERE source_record_id=? LIMIT ?",
                (row["record_id"], limit),
            )
        ],
    }


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


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
    return re.sub(
        r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}",
        lambda m: os.getenv(m.group(1), m.group(0)),
        text,
    )


def _parse_tiny_yaml(text: str):
    # ponytail: supports this repo's config templates; install PyYAML if configs grow more complex.
    root = {}
    stack = [(-1, root)]
    lines = [
        line.rstrip()
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
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
        return [
            _scalar(part.strip()) for part in value[1:-1].split(",") if part.strip()
        ]
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


def db_connect(ds: dict):
    from common.database_readonly import resolve_password

    ds = dict(ds)
    ds["password"] = resolve_password(ds)
    missing = [
        key
        for key in ("host", "port", "database", "username", "password")
        if not ds.get(key)
    ]
    if missing:
        raise SystemExit(f"数据源配置缺少字段: {', '.join(missing)}")
    database_type = str(ds.get("type") or "mysql").strip().lower()
    database_type = {"mariadb": "mysql", "postgres": "postgresql"}.get(
        database_type, database_type
    )
    if database_type == "postgresql":
        try:
            import psycopg  # type: ignore
        except ModuleNotFoundError as exc:
            raise SystemExit(
                "Missing dependency: pip install 'psycopg[binary]'"
            ) from exc

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


def _indexed_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(Path(ROOT).resolve()))
    except ValueError:
        return str(path.resolve())


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
                    conn,
                    source_record_id,
                    source_fragment_id,
                    script_type,
                    stored_path,
                    line_no,
                    alias,
                    match.group(1),
                    "proc_find_call",
                )
        for invoke_type, pattern in CALL_PATTERNS:
            match = pattern.search(line)
            if not match:
                continue
            target_alias = match.group(1)
            target_fun = (
                match.group(2)
                if invoke_type == "proc_invoke" and len(match.groups()) > 1
                else ""
            )
            _insert_call(
                conn,
                source_record_id,
                source_fragment_id,
                script_type,
                stored_path,
                line_no,
                target_alias,
                target_fun,
                invoke_type,
            )
        if "$vs.proc.invoke(" in line and not re.search(
            r"\$vs\.proc\.invoke\(\s*['\"]", line
        ):
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


CALL_PATTERNS = [
    (
        "proc_invoke",
        re.compile(
            r"\$vs\.proc\.invoke\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]"
        ),
    ),
    ("vm_open", re.compile(r"\$vm\.open\(\s*['\"]([^'\"]+)['\"]")),
    ("vm_open_dialog", re.compile(r"\$vm\.openDialog\(\s*['\"]([^'\"]+)['\"]")),
    ("gutil_request", re.compile(r"gUtil\.request\(\s*['\"]([^'\"]+)['\"]")),
]
PROC_FIND = re.compile(
    r"#set\s*\(\s*\$(\w+)\s*=\s*\$vs\.proc\.find\(\s*['\"]([^'\"]+)['\"]\s*\)"
)

from common.workspace_registry import (
    list_workspaces as list_workspaces,
    resolve_workspace as resolve_workspace,
    resolve_workspace_storage_root as resolve_workspace_storage_root,
    workspace_summary as workspace_summary,
    workspace_index_state as workspace_index_state,
    workspace_agent_context as workspace_agent_context,
    workspace_config_digest as workspace_config_digest,
    load_workspace_state as load_workspace_state,
    update_workspace_state as update_workspace_state,
    resolve_workspace_for_path as resolve_workspace_for_path,
    workspace_matches_request as workspace_matches_request,
    route_workspace_request as route_workspace_request,
)


def pull_log_path(workspace=None) -> Path:
    if os.environ.get("GUTHON_PULL_LOG_PATH"):
        return Path(os.environ["GUTHON_PULL_LOG_PATH"])
    return (workspace or current_workspace())["logsDir"] / "pull-log.ndjson"


def append_pull_log(
    pull_type, trigger, summary, payload=None, result=None, ok=True, message=""
) -> Path:
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
    key = _CURRENT_WORKSPACE.get()
    if key:
        record["workspaceKey"] = key

    def redact(value):
        if isinstance(value, dict):
            return {
                key: redact(item)
                for key, item in value.items()
                if not re.search(
                    r"password|secret|token|credential|content|sql|stack",
                    str(key),
                    re.I,
                )
            }
        if isinstance(value, list):
            return [redact(item) for item in value]
        return value[:2000] if isinstance(value, str) else value

    # Match Bridge retention and serialize append/rotation across CLI workers.
    with file_lock(path.with_name(".pull-log.lock")):
        if path.exists() and path.stat().st_size >= 5 * 1024 * 1024:
            os.replace(path, path.with_name(path.name + ".1"))
        with open(
            path,
            "a",
            encoding="utf-8",
            opener=lambda name, flags: os.open(name, flags, 0o600),
        ) as handle:
            handle.write(json.dumps(redact(record), ensure_ascii=False) + "\n")
    return path

"""Workspace-local derived index for the API checkout.

Indexed data is a snapshot; use read_source for current bytes and hashes.
"""

from __future__ import annotations

from collections import OrderedDict
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
from threading import Lock
import uuid
from urllib.parse import unquote

from common import (
    source_facts,
    source_text_search,
    page_projection,
    inheritance as inheritance_algorithms,
)
from common.persistence import file_lock
from common.operation_control import checkpoint, publication_barrier
from .client import ApiError
from .content import source_name
from .store import ApiStore
from .reference_assets import CONFIGS, config_objects, page_references
from .workspace import active_scope, settings


def _bound(limit, offset, maximum=100):
    if (
        type(limit) is not int
        or not 1 <= limit <= maximum
        or type(offset) is not int
        or offset < 0
    ):
        raise ValueError(f"limit must be 1–{maximum} and offset must be non-negative")


def _query(value, *, empty=False):
    if (
        not isinstance(value, str)
        or len(value) > 256
        or (not empty and not value.strip())
    ):
        raise ValueError("query must be a non-empty string of at most 256 characters")
    return value.strip()


def _scope_fingerprint(workspace):
    scope = active_scope(workspace)
    value = {
        "serverUrl": settings(workspace)["serverUrl"],
        "systemIds": sorted(scope["systemIds"]),
        "dataSourceIds": sorted(scope["dataSourceIds"]),
        "includeProjectFiles": scope["includeProjectFiles"],
    }
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _connection(workspace, *, check_scope=True):
    path = Path(workspace["indexPath"])
    if not path.is_file():
        raise ApiError("API_INDEX_REQUIRED", "请先重建当前工作区的 API 索引")
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=ON")
        identity = conn.execute(
            "SELECT state_value FROM gusen_sync_state WHERE state_key='workspaceKey'"
        ).fetchone()
        if identity is None or identity[0] != workspace["workspaceKey"]:
            raise ApiError("API_INDEX_IDENTITY_MISMATCH", "索引不属于当前工作区")
        scope = conn.execute(
            "SELECT state_value FROM gusen_sync_state WHERE state_key='scopeFingerprint'"
        ).fetchone()
        if check_scope and (scope is None or scope[0] != _scope_fingerprint(workspace)):
            raise ApiError(
                "API_INDEX_SCOPE_STALE",
                "当前平台或授权范围与索引不一致，请更新或重建索引",
            )
        return conn
    except BaseException:
        conn.close()
        raise


def health(workspace):
    """Check index identity and scope using local metadata only."""
    try:
        with closing(_connection(workspace)) as conn:
            required = {
                "gusen_sync_state",
                "gusen_source_record",
                "gusen_invoke_call",
                "gusen_dynamic_call",
                "gusen_source_fragment",
                "gusen_page_node",
                "gusen_page_field",
                "gusen_page_field_relation",
                "gusen_page_relation",
                "gusen_data_access",
                "gusen_logic_fact",
                "gusen_bill_route",
                "source_body_content",
                "api_reference_object",
                "api_reference_use",
            }
            present = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            state = dict(
                conn.execute(
                    "SELECT state_key,state_value FROM gusen_sync_state WHERE state_key IN ('generation','source_body_index_version')"
                )
            )
            if (
                not required.issubset(present)
                or not re.fullmatch(r"[0-9a-f]{32}", state.get("generation", ""))
                or state.get("source_body_index_version") != source_text_search.VERSION
            ):
                return {"ready": False, "errorCode": "API_INDEX_INVALID"}
            partial = conn.execute(
                "SELECT COUNT(*) FROM gusen_source_record WHERE scope_id=? AND status<>'OK'",
                (workspace["workspaceKey"],),
            ).fetchone()[0]
        return {"ready": True, "complete": partial == 0, "partialSourceCount": partial}
    except ApiError as error:
        return {"ready": False, "errorCode": error.code}
    except (sqlite3.Error, OSError):
        return {"ready": False, "errorCode": "API_INDEX_INVALID"}


def _setup(conn):
    conn.row_factory = sqlite3.Row
    conn.executescript("""
    CREATE TABLE gusen_source_record (
      record_id INTEGER PRIMARY KEY, scope_id TEXT NOT NULL, source_table TEXT NOT NULL,
      source_id TEXT NOT NULL, source_alias_id TEXT NOT NULL, fun_id TEXT NOT NULL,
      source_name TEXT NOT NULL, source_path TEXT NOT NULL UNIQUE, local_path TEXT NOT NULL,
      source_hash TEXT NOT NULL, provider TEXT NOT NULL, system_id TEXT NOT NULL,
      data_source_id TEXT NOT NULL, source_format TEXT NOT NULL, status TEXT NOT NULL, diagnostic TEXT NOT NULL,
      metadata_json TEXT NOT NULL, readonly INTEGER NOT NULL
    );
    CREATE TABLE gusen_invoke_call(id INTEGER PRIMARY KEY, source_record_id INTEGER NOT NULL,
      script_type TEXT, json_path TEXT, line_no INTEGER, target_alias_id TEXT, target_fun_id TEXT,
      invoke_type TEXT, source_fragment_id INTEGER);
    CREATE TABLE gusen_dynamic_call(id INTEGER PRIMARY KEY, source_record_id INTEGER NOT NULL,
      script_type TEXT, json_path TEXT, line_no INTEGER, invoke_expr TEXT, reason TEXT,
      source_fragment_id INTEGER);
    CREATE TABLE gusen_sync_state(state_key TEXT PRIMARY KEY, state_value TEXT NOT NULL);
    CREATE INDEX api_call_target_idx ON gusen_invoke_call(target_alias_id,target_fun_id,source_record_id);
    CREATE VIEW gusen_invoke_call_detail AS
      SELECT c.id,c.source_record_id,c.source_fragment_id,s.scope_id,
        s.source_table,s.source_id,s.source_alias_id,s.fun_id,s.source_name,c.script_type,c.json_path,
        c.line_no,c.target_alias_id,c.target_fun_id,c.invoke_type,'HIGH' AS confidence
      FROM gusen_invoke_call c JOIN gusen_source_record s ON s.record_id=c.source_record_id;
    """)
    conn.executescript("""
    CREATE TABLE api_reference_object(
      source_record_id INTEGER NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
      name TEXT NOT NULL, data_source_id TEXT NOT NULL, line_number INTEGER NOT NULL,
      reference_id TEXT NOT NULL, fields_json TEXT NOT NULL,
      PRIMARY KEY(source_record_id,reference_id));
    CREATE TABLE api_reference_use(source_record_id INTEGER NOT NULL,source_type TEXT NOT NULL,source_id TEXT NOT NULL,json_pointer TEXT NOT NULL);
    CREATE INDEX api_reference_identity ON api_reference_object(source_type,source_id);
    CREATE INDEX api_reference_caller ON api_reference_use(source_record_id);
    CREATE VIEW api_source_catalog AS
      SELECT source_path AS path,source_table AS sourceType,source_id AS sourceId,
        source_alias_id AS alias,fun_id AS funId,source_name AS name,source_hash AS sourceHash,
        system_id AS systemId,data_source_id AS dataSourceId,source_format AS sourceFormat,
        status,diagnostic,readonly,0 AS lineNumber,'' AS referenceId,'' AS referenceFields
      FROM gusen_source_record s WHERE NOT EXISTS
        (SELECT 1 FROM api_reference_object r WHERE r.source_record_id=s.record_id)
      UNION ALL
      SELECT s.source_path,r.source_type,r.source_id,r.source_id,'',r.name,s.source_hash,
        s.system_id,r.data_source_id,'reference',s.status,s.diagnostic,1,
        r.line_number,r.reference_id,r.fields_json
      FROM api_reference_object r JOIN gusen_source_record s ON s.record_id=r.source_record_id;
    """)
    source_facts.setup_schema(conn)


_CALLS = [
    ("vm_open", re.compile(r"""\$vm\.open\(\s*['"]([^'"]+)['"]""")),
    ("vm_open_dialog", re.compile(r"""\$vm\.openDialog\(\s*['"]([^'"]+)['"]""")),
    ("gutil_request", re.compile(r"""gUtil\.request\(\s*['"]([^'"]+)['"]""")),
]
_PROCEDURE_START = re.compile(
    r"\$vs\.(proc\.(?:invoke|invokeWithGlobalTrans)|thread\.(?:run|runFutureTask|runFutureTaskWithGlobalTrans))\s*\("
)
_PROCEDURE_CALL = re.compile(
    _PROCEDURE_START.pattern + r"""\s*(['"])([A-Za-z_][\w.]*)\2\s*,\s*(['"])([A-Za-z_]\w*)\4(?=\s*[,\)])"""
)
_FIND = re.compile(
    r"""#set\s*\(\s*\$(\w+)\s*=\s*\$vs\.proc\.find\(\s*['"]([^'"]+)['"]\s*\)"""
)


def _index_calls(conn, record_id, script, fragment):
    text = script["content"]
    static = {}
    for match in _PROCEDURE_CALL.finditer(text):
        kind = "proc_invoke" if match[1] == "proc.invoke" else match[1].replace(".", "_")
        static[match.start()] = (text.count("\n", 0, match.start()) + 1, kind, match[3], match[5])
    matches = list(static.values())
    bindings = {}
    for line_no, line in enumerate(text.splitlines(), 1):
        for assignment in re.finditer(r"#set\s*\(\s*\$(\w+)\s*=", line):
            bindings.pop(assignment.group(1), None)
        for found in _FIND.finditer(line):
            bindings[found.group(1)] = found.group(2)
        for var, alias in bindings.items():
            for match in re.finditer(rf"\${re.escape(var)}\.([A-Za-z_][A-Za-z0-9_]*)\(", line):
                matches.append((line_no, "proc_find_call", alias, match[1]))
        for kind, pattern in _CALLS:
            matches.extend((line_no, kind, match[1], "") for match in pattern.finditer(line))
    for line_no, kind, alias, fun in matches:
        conn.execute(
            "INSERT INTO gusen_invoke_call(source_record_id,source_fragment_id,script_type,json_path,line_no,target_alias_id,target_fun_id,invoke_type) VALUES(?,?,?,?,?,?,?,?)",
            (record_id, fragment, script["script_type"], script["json_path"], line_no, alias, fun, kind),
        )
    for match in _PROCEDURE_START.finditer(text):
        if match.start() in static:
            continue
        end = text.find("\n", match.start())
        conn.execute(
            "INSERT INTO gusen_dynamic_call(source_record_id,source_fragment_id,script_type,json_path,line_no,invoke_expr,reason) VALUES(?,?,?,?,?,?,?)",
            (record_id, fragment, script["script_type"], script["json_path"], text.count("\n", 0, match.start()) + 1,
             text[match.start():end if end >= 0 else len(text)][:2048], "目标过程别名或函数名来自变量"),
        )


class PageIdentityMismatch(ValueError):
    """The PAGE body identifies a different object from the API metadata."""


def _page_data(text, expected_page_id=None):
    if text.lstrip("\ufeff \t\r\n").startswith("<"):
        from .native_page import decode

        data = decode(text)
    else:
        data = json.loads(text)
        if isinstance(data, str):
            data = json.loads(data)
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("pageId"), str)
        or not data["pageId"].strip()
    ):
        raise ValueError("PAGE JSON must have a non-empty string pageId")
    if expected_page_id is not None and data["pageId"] != str(expected_page_id):
        raise PageIdentityMismatch("PAGE pageId does not match API metadata")
    return data


def page_format(item):
    """Classify a current API PAGE from its native type, name and content."""
    if item["metadata"].get("sourceType") != "page":
        return "other"
    page_id = item["metadata"].get("pageId")
    if (
        not isinstance(page_id, (str, int))
        or isinstance(page_id, bool)
        or not str(page_id).strip()
    ):
        raise ValueError("PAGE API metadata must have a pageId")
    if str(item["metadata"].get("pageType", "")) == "0" or item[
        "path"
    ].lower().endswith(".gss"):
        return "script"
    if item["content"].lstrip("\ufeff \t\r\n").startswith("<"):
        from .native_page import is_metadata_only, is_native

        if not is_native(item["content"]):
            return "unsupported-xml"
        try:
            _page_data(item["content"], page_id)
        except ValueError:
            if is_metadata_only(item["content"], item["metadata"], item["path"]):
                return "unsupported-xml"
            raise
        return "native-xml"
    _page_data(item["content"], page_id)
    return "json"


def _index_item(conn, workspace, item):
    meta, path, text = item["metadata"], item["path"], item["content"]
    kind = str(meta.get("sourceType") or "")
    source_id = str(
        meta.get("pageId")
        or meta.get("procedureId")
        or meta.get("tableId")
        or meta.get("viewId")
        or meta.get("scriptType")
        or meta.get("configId")
        or path
    )
    procedure_alias = (
        (
            meta.get("procedureAliasId")
            or str(meta.get("subPath") or "").replace("/", ".")
        )
        if kind.startswith("procedure")
        else ""
    )
    alias = str(meta.get("pageAliasId") or procedure_alias or source_id)
    name = source_name(meta) or source_id
    metadata_only = False
    try:
        fmt = page_format(item)
        diagnostic = "API_PAGE_XML_UNSUPPORTED" if fmt == "unsupported-xml" else ""
        if diagnostic:
            from .native_page import is_metadata_only

            if is_metadata_only(text, meta, path):
                fmt, diagnostic, metadata_only = "native-page-minimal", "API_PAGE_MINIMAL_SOURCE", True
    except PageIdentityMismatch:
        if not text.lstrip("\ufeff \t\r\n").startswith("<"):
            raise
        fmt, diagnostic = "unsupported", "API_PAGE_IDENTITY_MISMATCH"
    except (ValueError, TypeError):
        if not text.lstrip("\ufeff \t\r\n").startswith("<"):
            raise
        from .native_page import is_metadata_only

        if is_metadata_only(text, meta, path):
            fmt, diagnostic, metadata_only = "native-page-minimal", "API_PAGE_MINIMAL_SOURCE", True
        else:
            fmt, diagnostic = "unsupported", "API_PAGE_FORMAT_INVALID"
    view_sql = None
    if kind == "view":
        from .view_editor import extract_sql, is_metadata_only

        try:
            view_sql = extract_sql(text, meta)
        except ApiError as error:
            if is_metadata_only(text, meta, path):
                fmt, diagnostic, metadata_only = "view-no-sql", "API_VIEW_SQL_ABSENT", True
            else:
                diagnostic = error.code
    cur = conn.execute(
        """INSERT INTO gusen_source_record(scope_id,source_table,source_id,source_alias_id,fun_id,source_name,source_path,local_path,source_hash,provider,system_id,data_source_id,source_format,status,diagnostic,metadata_json,readonly)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            workspace["workspaceKey"],
            kind,
            source_id,
            alias,
            str(meta.get("funId") or ""),
            name,
            path,
            path,
            item["sourceHash"],
            "api",
            str(meta.get("systemId") or ""),
            str(meta.get("dataSourceId") or ""),
            fmt,
            "PARTIAL" if diagnostic and not metadata_only else "OK",
            diagnostic,
            json.dumps(meta, ensure_ascii=False),
            int(item["readonly"] or bool(diagnostic and not metadata_only)),
        ),
    )
    record_id = cur.lastrowid
    try:
        references = config_objects(path, text, active_scope(workspace)["dataSourceIds"])
    except ApiError as error:
        conn.execute("UPDATE gusen_source_record SET status='PARTIAL',diagnostic=? WHERE record_id=?", (error.code, record_id))
        return
    for reference in references:
        conn.execute("INSERT INTO api_reference_object VALUES(?,?,?,?,?,?,?,?)",
                     (record_id, reference["sourceType"], reference["sourceId"], reference["name"],
                      reference["dataSourceId"], reference["lineNumber"], reference["referenceId"],
                      json.dumps(reference["fields"], ensure_ascii=False)))
    if diagnostic:
        return
    page_data = (
        _page_data(text, meta.get("pageId")) if fmt in {"json", "native-xml"} else None
    )
    if page_data is not None:
        conn.executemany("INSERT INTO api_reference_use VALUES(?,?,?,?)", [(record_id,*reference) for reference in page_references(page_data)])
        scripts = [
            {
                "script_type": x.script_type,
                "json_path": x.json_pointer,
                "content": x.effective_value,
                "label": x.display_name,
                "originMap": x.origin_segments,
            }
            for x in page_projection.extract_page_scripts(page_data)
        ]
        scripts += [
            {
                "script_type": x["script_type"],
                "json_path": x["json_pointer"],
                "content": x["content"],
                "label": x["label"],
            }
            for x in page_projection.extract_page_fields(page_data)
        ]
    elif kind == "view":
        scripts = [{"script_type": "view_sql", "json_path": "/viewSql", "content": view_sql, "label": name}]
    else:
        scripts = [
            {
                "script_type": "gss"
                if kind.startswith("procedure") or fmt == "script"
                else "text",
                "json_path": "",
                "content": text,
                "label": name,
            }
        ]
    details = source_facts.index_source_details(
        conn,
        record_id,
        {
            "source_name": name,
            "source_id": source_id,
            "source_hash": item["sourceHash"],
        },
        scripts,
        page_data=page_data,
        replace_existing=False,
    )
    for script in scripts:
        if script["script_type"] != "fields":
            _index_calls(
                conn, record_id, script, details["fragments"].get(script["json_path"])
            )


def _diagnostics(conn):
    return [
        {
            "path": row["source_path"],
            "code": row["diagnostic"],
            "message": {
                "API_PAGE_XML_UNSUPPORTED": "未知 PAGE XML 格式仅可读取原文，未生成结构或源码事实",
                "API_PAGE_FORMAT_INVALID": "PAGE 格式或编码与元数据不符，仅保留原文，未生成结构或源码事实",
                "API_PAGE_IDENTITY_MISMATCH": "PAGE 表示编码与对象身份不一致；需核对原生编辑源码，不可修改平台编码来消除诊断",
                "API_VIEW_FORMAT_UNSUPPORTED": "视图缺少可核验身份或 SQL，未生成源码事实",
                "API_VIEW_IDENTITY_MISSING": "视图元数据缺少平台编码，未生成源码事实",
                "API_IDENTITY_MISMATCH": "视图源码编码与平台对象不一致，未生成源码事实",
            }.get(row["diagnostic"], "本地源码不可用，未生成事实"),
        }
        for row in conn.execute(
            "SELECT source_path,diagnostic FROM gusen_source_record WHERE status<>'OK' ORDER BY source_path"
        )
    ]


def _clear_record(conn, row):
    record_id = row["record_id"]
    source_facts.clear_source_details(conn, record_id)
    conn.execute("DELETE FROM api_reference_object WHERE source_record_id=?", (record_id,))
    conn.execute("DELETE FROM api_reference_use WHERE source_record_id=?", (record_id,))
    conn.execute("DELETE FROM gusen_invoke_call WHERE source_record_id=?", (record_id,))
    conn.execute(
        "DELETE FROM gusen_dynamic_call WHERE source_record_id=?", (record_id,)
    )
    conn.execute("DELETE FROM gusen_source_record WHERE record_id=?", (record_id,))


def _refresh_bill_routes(conn, workspace):
    docs_dir = workspace.get("docsDir")
    if docs_dir is None:
        source_facts.replace_workspace_bill_routes(conn, [])
        conn.execute(
            "INSERT OR REPLACE INTO gusen_sync_state VALUES('billRouteStatus','UNAVAILABLE')"
        )
        return 0, "UNAVAILABLE"
    root = Path(workspace["root"]).resolve()
    directory = (Path(docs_dir) / "exports" / "billtype").resolve()
    if not directory.is_relative_to(root):
        raise ApiError("API_BILL_EXPORT_PATH_INVALID", "单据导出目录不属于当前工作区")
    scope = active_scope(workspace)["dataSourceIds"]
    values = []
    for path in sorted(directory.glob("*.json")):
        checkpoint()
        if not path.resolve().is_relative_to(directory):
            raise ApiError("API_BILL_EXPORT_PATH_INVALID", "单据导出文件超出当前工作区")
        payload = json.loads(path.read_text(encoding="utf-8"))
        if (
            not isinstance(payload, dict)
            or not isinstance(payload.get("dataSourceId"), str)
            or not isinstance(payload.get("billTypes"), list)
        ):
            raise ApiError(
                "API_BILL_EXPORT_INVALID", "单据导出缺少数据源身份或单据列表"
            )
        data_source_id = payload["dataSourceId"]
        if data_source_id not in scope:
            continue
        bill_types = []
        for item in payload["billTypes"]:
            if not isinstance(item, dict) or (
                item.get("dataSourceId") not in (None, "", data_source_id)
            ):
                raise ApiError(
                    "API_BILL_EXPORT_INVALID", "单据导出包含无效或不一致的数据源身份"
                )
            for key in ("billTypeCode", "tableId", "billTypeName"):
                if key in item and not isinstance(item[key], (str, int)):
                    raise ApiError("API_BILL_EXPORT_INVALID", "单据路由字段类型无效")
            keys = item.get("tablePkids", "")
            if (
                not isinstance(keys, (str, list))
                or isinstance(keys, list)
                and any(not isinstance(value, (str, int)) for value in keys)
            ):
                raise ApiError("API_BILL_EXPORT_INVALID", "单据主键字段类型无效")
            bill_types.append(
                {
                    key: item[key]
                    for key in ("billTypeCode", "tableId", "billTypeName", "tablePkids")
                    if key in item
                }
            )
        values.append({"dataSourceId": data_source_id, "billTypes": bill_types})
    count = source_facts.replace_workspace_bill_routes(conn, values)
    status = "READY" if values else "NO_EXPORTS"
    conn.execute(
        "INSERT OR REPLACE INTO gusen_sync_state VALUES('billRouteStatus',?)", (status,)
    )
    return count, status


def _bill_routes_fingerprint(workspace):
    docs_dir = workspace.get("docsDir")
    if docs_dir is None:
        return "UNAVAILABLE"
    root = Path(workspace["root"]).resolve()
    directory = (Path(docs_dir) / "exports" / "billtype").resolve()
    if not directory.is_relative_to(root):
        raise ApiError("API_BILL_EXPORT_PATH_INVALID", "单据导出目录不属于当前工作区")
    digest = hashlib.sha256()
    for path in sorted(directory.glob("*.json")):
        checkpoint()
        if not path.resolve().is_relative_to(directory):
            raise ApiError("API_BILL_EXPORT_PATH_INVALID", "单据导出文件超出当前工作区")
        digest.update(path.name.encode("utf-8") + b"\0")
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def _unchanged_update(workspace, store, conn, paths, scope_fingerprint, bill_fingerprint):
    """Prove every input to a non-empty incremental update is unchanged."""
    states = dict(conn.execute("SELECT state_key,state_value FROM gusen_sync_state"))
    if (states.get("scopeFingerprint") != scope_fingerprint
            or states.get("billRoutesFingerprint") != bill_fingerprint
            or states.get("source_body_index_version") != source_text_search.VERSION
            or not re.fullmatch(r"[0-9a-f]{32}", states.get("generation", ""))):
        return None
    active = set(store.paths())
    rows = {row["source_path"]: row for row in conn.execute(
        "SELECT source_path,source_table,source_hash,metadata_json,readonly,status,diagnostic FROM gusen_source_record"
    )}
    if set(rows) != active:
        return None
    for path in paths:
        checkpoint()
        row = rows.get(path)
        try:
            item = store.read(path)
        except ApiError as error:
            if error.code in {"API_SOURCE_NOT_FOUND", "API_SOURCE_OUT_OF_SCOPE"} and row is None:
                continue
            if error.code == "API_SOURCE_MISSING" and row is None and path not in active:
                if store._record(path)["metadata"].get("remoteDeleted"):
                    continue
            if error.code != "API_SOURCE_MISSING" or row is None or row["diagnostic"] != "API_SOURCE_MISSING":
                return None
            item = store._record(path)
            if bool(row["readonly"]) != bool(item["readonly"]):
                return None
        else:
            if row is None and path not in active and item["metadata"].get("remoteDeleted"):
                continue
            if row is None or row["diagnostic"] == "API_SOURCE_MISSING" or row["source_hash"] != item["sourceHash"]:
                return None
            if bool(row["readonly"]) != bool(item["readonly"] or row["status"] == "PARTIAL"):
                return None
        if (row["source_table"] != item["metadata"].get("sourceType")
                or json.loads(row["metadata_json"]) != item["metadata"]):
            return None
    if _scope_fingerprint(workspace) != scope_fingerprint or _bill_routes_fingerprint(workspace) != bill_fingerprint:
        return None
    diagnostics = _diagnostics(conn)
    return {"workspaceKey": workspace["workspaceKey"], "indexGeneration": states["generation"],
            "objects": len(rows), "updatedPaths": [], "unchanged": True,
            "complete": not diagnostics, "diagnosticCount": len(diagnostics), "diagnostics": diagnostics[:100],
            "billRouteCount": conn.execute("SELECT COUNT(*) FROM gusen_bill_route WHERE source_record_id=0").fetchone()[0],
            "billRouteStatus": states.get("billRouteStatus", "UNAVAILABLE"), "truncated": len(diagnostics) > 100}


def rebuild(workspace):
    """Build an atomic snapshot from authorized current checkout files."""
    dest = Path(workspace["indexPath"])
    dest.parent.mkdir(parents=True, exist_ok=True)
    generation = uuid.uuid4().hex
    with file_lock(Path(workspace["contextDir"]) / "api" / "index.lock"):
        fd, tmp_name = tempfile.mkstemp(
            prefix=".api-index-", suffix=".db", dir=dest.parent
        )
        os.close(fd)
        tmp = Path(tmp_name)
        try:
            store = ApiStore(workspace)
            scope_fingerprint = _scope_fingerprint(workspace)
            bill_fingerprint = _bill_routes_fingerprint(workspace)
            paths = store.paths()
            with closing(sqlite3.connect(tmp)) as conn:
                _setup(conn)
                conn.executemany(
                    "INSERT INTO gusen_sync_state VALUES(?,?)",
                    [
                        ("workspaceKey", workspace["workspaceKey"]),
                        ("generation", generation),
                        ("scopeFingerprint", scope_fingerprint),
                        ("source_body_index_version", source_text_search.VERSION),
                        ("billRoutesFingerprint", bill_fingerprint),
                    ],
                )
                for path in paths:
                    checkpoint()
                    item = store.read(path)
                    _index_item(conn, workspace, item)
                bill_count, bill_status = _refresh_bill_routes(conn, workspace)
                if _bill_routes_fingerprint(workspace) != bill_fingerprint:
                    raise ApiError("API_BILL_EXPORT_STALE", "单据导出在索引构建期间变化，请重试")
                if _scope_fingerprint(workspace) != scope_fingerprint:
                    raise ApiError(
                        "API_INDEX_SCOPE_STALE",
                        "索引构建期间平台或授权范围已变化，请重试",
                    )
                conn.commit()
                diagnostics = _diagnostics(conn)
            publication_barrier()
            os.replace(tmp, dest)
        finally:
            tmp.unlink(missing_ok=True)
    return {
        "workspaceKey": workspace["workspaceKey"],
        "indexGeneration": generation,
        "objects": len(paths),
        "complete": not diagnostics,
        "diagnosticCount": len(diagnostics),
        "diagnostics": diagnostics[:100],
        "billRouteCount": bill_count,
        "billRouteStatus": bill_status,
        "truncated": len(diagnostics) > 100,
    }


def update(workspace, paths):
    """Atomically refresh explicit files, keeping unaffected indexed facts intact."""
    if not isinstance(paths, list) or any(
        not isinstance(path, str) or not path for path in paths
    ):
        raise ValueError("paths must be a list of checkout-relative paths")
    paths = list(dict.fromkeys(paths))
    dest = Path(workspace["indexPath"])
    if not dest.is_file():
        return rebuild(workspace)
    with closing(sqlite3.connect(dest.resolve().as_uri() + "?mode=ro", uri=True)) as previous:
        upgrade = previous.execute("SELECT 1 FROM sqlite_master WHERE name='api_reference_object'").fetchone() is None
    if upgrade:
        return rebuild(workspace)
    generation = uuid.uuid4().hex
    with file_lock(Path(workspace["contextDir"]) / "api" / "index.lock"):
        store = ApiStore(workspace)
        scope_fingerprint = _scope_fingerprint(workspace)
        bill_fingerprint = _bill_routes_fingerprint(workspace)
        if paths:
            with closing(_connection(workspace, check_scope=False)) as original:
                unchanged = _unchanged_update(workspace, store, original, paths, scope_fingerprint, bill_fingerprint)
            if unchanged is not None:
                return unchanged
        fd, tmp_name = tempfile.mkstemp(
            prefix=".api-index-", suffix=".db", dir=dest.parent
        )
        os.close(fd)
        tmp = Path(tmp_name)
        try:
            active = set(store.paths())
            with (
                closing(_connection(workspace, check_scope=False)) as original,
                closing(sqlite3.connect(tmp)) as conn,
            ):
                original.backup(conn)
                conn.row_factory = sqlite3.Row
                old = {
                    row["source_path"]: row
                    for row in conn.execute(
                        "SELECT record_id,source_path FROM gusen_source_record"
                    )
                }
                targets = set(paths) | (set(old) - active) | (active - set(old))
                previous_scope=conn.execute("SELECT state_value FROM gusen_sync_state WHERE state_key='scopeFingerprint'").fetchone()
                if previous_scope is None or previous_scope[0]!=scope_fingerprint:
                    targets.update(set(CONFIGS)&active)
                for path in sorted(targets):
                    checkpoint()
                    row = old.get(path)
                    try:
                        item = store.read(path)
                    except ApiError as error:
                        if error.code not in {
                            "API_SOURCE_NOT_FOUND",
                            "API_SOURCE_OUT_OF_SCOPE",
                            "API_SOURCE_MISSING",
                        }:
                            raise
                        if row is None:
                            continue
                        if error.code == "API_SOURCE_MISSING":
                            source_facts.clear_source_details(conn, row["record_id"])
                            conn.execute("DELETE FROM api_reference_object WHERE source_record_id=?",(row["record_id"],))
                            conn.execute("DELETE FROM api_reference_use WHERE source_record_id=?",(row["record_id"],))
                            conn.execute(
                                "DELETE FROM gusen_invoke_call WHERE source_record_id=?",
                                (row["record_id"],),
                            )
                            conn.execute(
                                "DELETE FROM gusen_dynamic_call WHERE source_record_id=?",
                                (row["record_id"],),
                            )
                            conn.execute(
                                "UPDATE gusen_source_record SET status='PARTIAL',diagnostic='API_SOURCE_MISSING' WHERE record_id=?",
                                (row["record_id"],),
                            )
                        else:
                            _clear_record(conn, row)
                        continue
                    if path not in active and item["metadata"].get("remoteDeleted"):
                        if row is not None:
                            _clear_record(conn, row)
                        continue
                    if path not in active:
                        raise ApiError(
                            "API_SOURCE_STALE", "源码范围在索引更新期间变化，请重新执行"
                        )
                    if row is not None:
                        _clear_record(conn, row)
                    _index_item(conn, workspace, item)
                conn.execute(
                    "UPDATE gusen_sync_state SET state_value=? WHERE state_key='generation'",
                    (generation,),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO gusen_sync_state VALUES('scopeFingerprint',?)",
                    (scope_fingerprint,),
                )
                bill_count, bill_status = _refresh_bill_routes(conn, workspace)
                if _bill_routes_fingerprint(workspace) != bill_fingerprint:
                    raise ApiError("API_BILL_EXPORT_STALE", "单据导出在索引更新期间变化，请重试")
                conn.execute("INSERT OR REPLACE INTO gusen_sync_state VALUES('billRoutesFingerprint',?)", (bill_fingerprint,))
                if _scope_fingerprint(workspace) != scope_fingerprint:
                    raise ApiError(
                        "API_INDEX_SCOPE_STALE",
                        "索引更新期间平台或授权范围已变化，请重试",
                    )
                conn.commit()
                diagnostics = _diagnostics(conn)
                count = conn.execute(
                    "SELECT COUNT(*) FROM gusen_source_record"
                ).fetchone()[0]
            publication_barrier()
            os.replace(tmp, dest)
        finally:
            tmp.unlink(missing_ok=True)
    return {
        "workspaceKey": workspace["workspaceKey"],
        "indexGeneration": generation,
        "objects": count,
        "updatedPaths": paths,
        "complete": not diagnostics,
        "diagnosticCount": len(diagnostics),
        "diagnostics": diagnostics[:100],
        "billRouteCount": bill_count,
        "billRouteStatus": bill_status,
        "truncated": len(diagnostics) > 100,
    }


def procedure_signature(text, metadata, *, truncated=False):
    """Derive only explicit declarations and leading documentation from an index header."""
    name = r"\$?[A-Za-z_][A-Za-z0-9_]*"
    result = {"parameters": None, "hasReturn": None,
              "parameterSource": "unknown", "returnSource": "unknown"}
    if not isinstance(metadata, dict):
        metadata = {}

    header = re.match(r"\ufeff?\s*/\*\*(.*?)\*/", text, re.S)
    lines = [re.sub(r"^\s*\* ?", "", line).strip()
             for line in header.group(1).splitlines()] if header else []
    config = None
    config_tags = [i for i, line in enumerate(lines) if re.match(r"^@config(?:\s|$)", line)]
    config_invalid = len(config_tags) > 1
    if len(config_tags) == 1:
        i = config_tags[0]
        inline = re.sub(r"^@config\b", "", lines[i], count=1).strip()
        config_text = (inline + "\n" if inline.startswith("{") else "") + "\n".join(lines[i + 1:])
        def unique_pairs(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError("duplicate configuration key")
                value[key] = item
            return value
        try:
            config, _ = json.JSONDecoder(object_pairs_hook=unique_pairs).raw_decode(config_text.lstrip())
            if not isinstance(config, dict):
                config_invalid = True
        except (ValueError, RecursionError):
            config_invalid = True
    if config_invalid:
        config = None

    declarations = []
    # The usual generated header is followed immediately by its one declaration.
    # Avoid masking the body in that case; any other marker requires the full scan.
    start = header.end() if header else (1 if text.startswith("\ufeff") else 0)
    leading = re.compile(r"\s*@DECLARE_PROCEDURE\s+(" + name + r")\s*\(([^()]*)\)(?=[ \t]*(?:\r?\n|$|\{))").match(text, start)
    if leading and text.count("@DECLARE_PROCEDURE") == 1 and leading.group(1) == metadata.get("funId"):
        raw = leading.group(2)
        parts = [part.strip() for part in raw.split(",")] if raw.strip() else []
        if all(re.fullmatch(name, part) for part in parts) and len(parts) == len(set(parts)):
            declarations.append(parts)
    if not declarations:
        # Markers and arguments must be actual top-level code, never comments or literals.
        masked = inheritance_algorithms.mask_noncode(text)
        if masked.startswith("\ufeff"):
            masked = " " + masked[1:]
        depth = 0
        position = 0
        marker = re.compile(r"^[ \t]*@DECLARE_PROCEDURE\s+(" + name + r")\b", re.M)
        for match in marker.finditer(masked):
            for char in masked[position:match.start()]:
                if char == "{":
                    depth += 1
                elif char == "}":
                    depth = max(0, depth - 1)
            position = match.start()
            if depth == 0 and isinstance(metadata.get("funId"), str) and match.group(1) == metadata["funId"]:
                tail = re.match(r"\s*\(([^()]*)\)(?=[ \t]*(?:\r?\n|$|\{))", masked[match.end():], re.S)
                if tail:
                    raw = text[match.end() + tail.start(1):match.end() + tail.end(1)]
                    parts = [part.strip() for part in raw.split(",")] if raw.strip() else []
                    declarations.append(parts if all(re.fullmatch(name, part) for part in parts)
                                        and len(parts) == len(set(parts)) else None)
                else:
                    declarations.append(None)
    if len(declarations) == 1 and declarations[0] is not None:
        result.update(parameters=declarations[0], parameterSource="declaration")
    elif not declarations and (header or not truncated) and not config_invalid:
        if config is not None and "params" in config:
            params = config["params"]
            if (isinstance(params, list)
                    and all(isinstance(item, dict) and isinstance(item.get("id"), str)
                            and re.fullmatch(name, item["id"]) for item in params)):
                names = [item["id"] for item in params]
                if len(names) == len(set(names)):
                    result.update(parameters=names, parameterSource="config")
        else:
            documented = []
            documented_empty = False
            in_params = False
            awaiting_name = False
            invalid = False
            for line in lines:
                tag = re.match(r"^@param(?:\s+(.*))?$", line)
                if tag:
                    in_params = True
                    rest = (tag.group(1) or "").strip()
                    awaiting_name = not rest
                    if rest == "无":
                        documented_empty = True
                    elif rest:
                        item = re.match(r"^(?:\{[^{}]+\}\s+)?(" + name + r")(?:\s|$|:|：)", rest)
                        if item:
                            documented.append(item.group(1))
                        else:
                            invalid = True
                elif line.startswith("@"):
                    in_params = False
                    awaiting_name = False
                elif in_params and line.startswith("-"):
                    item = re.match(r"^-\s*(" + name + r")\s*[:：]", line)
                    if item:
                        documented.append(item.group(1))
                        awaiting_name = False
                    else:
                        invalid = True
                elif in_params and awaiting_name and line:
                    if line == "无":
                        documented_empty = True
                        awaiting_name = False
                    else:
                        item = re.match(r"^(?:\{[^{}]+\}\s+(" + name + r")|(\$[A-Za-z_][A-Za-z0-9_]*))(?:\s|$|:|：)", line)
                        if item:
                            documented.append(item.group(1) or item.group(2))
                            awaiting_name = False
            if documented_empty and not documented and not invalid:
                result.update(parameters=[], parameterSource="documentation")
            elif documented and not documented_empty and not invalid and len(documented) == len(set(documented)):
                result.update(parameters=documented, parameterSource="documentation")

    def flag(value):
        if type(value) is bool:
            return value
        if type(value) is int and value in (0, 1):
            return bool(value)
        if isinstance(value, str) and value.lower() in ("0", "1", "false", "true"):
            return value.lower() in ("1", "true")
        return None

    if not config_invalid and config is not None and "isReturn" in config:
        value = flag(config["isReturn"])
        if value is not None:
            result.update(hasReturn=value, returnSource="config")
    elif not config_invalid and (header or not truncated):
        if "isReturn" in metadata:
            value = flag(metadata["isReturn"])
            if value is not None:
                result.update(hasReturn=value, returnSource="metadata")
        else:
            documented_returns = set()
            for line in lines:
                tag = re.match(r"^@returns?(?:\s+(.*))?$", line)
                if not tag or not (description := (tag.group(1) or "").strip()):
                    continue
                if re.match(r"^(?:\{void\}|void|无返回值)(?=$|[\s:：,，。;；])", description, re.I):
                    documented_returns.add(False)
                elif description.lower() not in {"无", "none", "null"} and re.search(r"\w", description):
                    documented_returns.add(True)
            if len(documented_returns) == 1:
                result.update(hasReturn=documented_returns.pop(), returnSource="documentation")
    return result


_RETURN_TOKENS = re.compile(r"(?<![\w$])#([A-Za-z_][A-Za-z0-9_]*)\b|(?<![\w$.#])return\b")
_RETURN_STRING = re.compile(r"'(?:\\[\s\S]|[^'\\])*'|\"(?:\\[\s\S]|[^\"\\])*\"|`(?:\\[\s\S]|[^`\\])*`")
_RETURN_CACHE = OrderedDict()
_RETURN_CACHE_LOCK = Lock()
_RETURN_CACHE_MISS = object()


def procedure_return_expressions(text):
    """Find explicit procedure-level returns, excluding local GSS functions."""
    masked = inheritance_algorithms.mask_noncode(text)
    blocks = []
    expressions = []
    expression_end = 0
    for token in _RETURN_TOKENS.finditer(masked):
        if token.start() < expression_end:
            continue
        directive = token.group(1)
        if directive in ("function", "if", "foreach"):
            blocks.append(directive)
            continue
        if directive == "end":
            if not blocks:
                return None
            blocks.pop()
            continue
        if directive:
            if directive not in ("set", "else", "elseif", "break"):
                return None
            continue
        if "function" in blocks:
            continue

        start = token.end()
        while start < len(text) and text[start] in " \t":
            start += 1
        if start == len(text) or text[start] in "\r\n;":
            return None
        stack = []
        last = start
        pos = start
        while pos < len(text):
            char = text[pos]
            code = masked[pos]
            if char in "'\"`" and code == " ":
                literal = _RETURN_STRING.match(text, pos)
                if not literal:
                    return None
                pos = literal.end()
                last = pos
                continue
            if code == " " and text[pos:pos + 2] in ("//", "##", "/*"):
                if stack or text[pos:pos + 2] == "/*":
                    return None
                break
            if not stack and code == "#" and _RETURN_TOKENS.match(masked, pos):
                break
            if code in "([{":
                stack.append(code)
            elif code in ")]}" and code != " ":
                if not stack:
                    break
                if stack.pop() != {')': '(', ']': '[', '}': '{'}[code]:
                    return None
            elif not stack and (code == ";" or char in "\r\n"):
                break
            if not char.isspace():
                last = pos + 1
            pos += 1
        if stack:
            return None
        expression = text[start:last].strip()
        if not expression:
            return None
        if expression not in expressions:
            expressions.append(expression)
        expression_end = pos
    return expressions if expressions and not blocks else None


def _result(workspace, conn, rows, limit, offset, key="items"):
    generation = conn.execute(
        "SELECT state_value FROM gusen_sync_state WHERE state_key='generation'"
    ).fetchone()[0]
    more = len(rows) > limit
    values = [dict(x) for x in rows[:limit]]
    procedure_paths = list({item["path"] for item in values if item.get("sourceType") == "procedure"})
    signatures = {}
    if procedure_paths:
        placeholders = ",".join("?" for _ in procedure_paths)
        for row in conn.execute(
            "SELECT s.source_path,s.metadata_json,substr(coalesce(b.content,''),1,16384) AS header, "
            "(coalesce(b.total_chars,0)>16384 OR coalesce(b.indexed_chars,0)<coalesce(b.total_chars,0)) AS header_truncated "
            "FROM gusen_source_record s LEFT JOIN source_body_content b "
            "ON b.source_record_id=s.record_id AND b.json_pointer='' "
            f"WHERE s.source_path IN ({placeholders})", procedure_paths
        ):
            signatures[row["source_path"]] = procedure_signature(
                row["header"], json.loads(row["metadata_json"]), truncated=bool(row["header_truncated"])
            )
        for signature in signatures.values():
            signature["returnExpressions"] = [] if signature["hasReturn"] is False else None
        return_paths = [path for path, signature in signatures.items() if signature["hasReturn"] is True]
        if return_paths:
            placeholders = ",".join("?" for _ in return_paths)
            for row in conn.execute(
                "SELECT s.source_path,b.content,b.source_hash,b.indexed_chars,b.total_chars "
                "FROM gusen_source_record s JOIN source_body_content b "
                "ON b.source_record_id=s.record_id AND b.json_pointer='' "
                f"WHERE s.source_path IN ({placeholders})", return_paths
            ):
                if row["indexed_chars"] == row["total_chars"]:
                    cache_key = (row["source_hash"], row["indexed_chars"], row["total_chars"])
                    with _RETURN_CACHE_LOCK:
                        expressions = _RETURN_CACHE.get(cache_key, _RETURN_CACHE_MISS) if cache_key[0] else _RETURN_CACHE_MISS
                        if expressions is not _RETURN_CACHE_MISS:
                            _RETURN_CACHE.move_to_end(cache_key)
                    if expressions is _RETURN_CACHE_MISS:
                        parsed = procedure_return_expressions(row["content"])
                        expressions = tuple(parsed) if parsed is not None else None
                        if cache_key[0] and (expressions is None or sum(map(len, expressions)) <= 8192):
                            with _RETURN_CACHE_LOCK:
                                _RETURN_CACHE[cache_key] = expressions
                                _RETURN_CACHE.move_to_end(cache_key)
                                if len(_RETURN_CACHE) > 4096:
                                    _RETURN_CACHE.popitem(last=False)
                    signatures[row["source_path"]]["returnExpressions"] = list(expressions) if expressions is not None else None
    for item in values:
        if item.get("path") in signatures:
            item["procedureSignature"] = signatures[item["path"]]
        if item.get("referenceFields"):
            item["referenceFields"] = json.loads(item["referenceFields"])
        if "sourceId" in item and "path" in item:
            item["sourcePath"] = item["path"]
            item["sourceNamespace"] = source_facts.api_source_namespace(
                item.get("systemId", ""), item.get("dataSourceId", ""), item["path"]
            )
    partial = conn.execute(
        "SELECT COUNT(*) FROM gusen_source_record WHERE status<>'OK'"
    ).fetchone()[0]
    bill_status = conn.execute(
        "SELECT state_value FROM gusen_sync_state WHERE state_key='billRouteStatus'"
    ).fetchone()
    bill_status = bill_status[0] if bill_status else "UNAVAILABLE"
    warnings = ["索引是构建时快照；编辑前请读取当前文件并核对 sourceHash。"]
    if partial:
        warnings.append(f"{partial} 个对象未完成解析，请查看目录中的诊断。")
    return {
        "workspaceKey": workspace["workspaceKey"],
        "indexGeneration": generation,
        key: values,
        "complete": not more and not partial,
        "truncated": more or bool(partial),
        "nextOffset": offset + limit if more else None,
        "partialSourceCount": partial,
        "billRouteStatus": bill_status,
        "coverage": "INDEX_SNAPSHOT",
        "warnings": warnings,
    }


def catalog(workspace, limit=100, offset=0):
    _bound(limit, offset)
    with closing(_connection(workspace)) as conn:
        rows = conn.execute(
            "SELECT c.*,json_extract(s.metadata_json,'$.pageSource') AS pageSource,json_extract(s.metadata_json,'$.nativeState') AS nativeState FROM api_source_catalog c LEFT JOIN gusen_source_record s ON s.source_path=c.path ORDER BY c.path,c.dataSourceId,c.sourceId,c.lineNumber LIMIT ? OFFSET ?",
            (limit + 1, offset),
        ).fetchall()
        return _result(workspace, conn, rows, limit, offset, "objects")


def search(workspace, query, limit=20, offset=0):
    _bound(limit, offset)
    query = _query(query)
    with closing(_connection(workspace)) as conn:
        rows = conn.execute(
            """SELECT c.*,substr(coalesce(nullif(c.referenceFields,''),b.content,''),
              max(1,instr(lower(coalesce(nullif(c.referenceFields,''),b.content,'')),lower(?))-80),240) AS excerpt,
              coalesce(b.json_pointer,'') AS jsonPointer
            FROM api_source_catalog c LEFT JOIN gusen_source_record s ON s.source_path=c.path
            LEFT JOIN source_body_content b ON b.source_record_id=s.record_id
            WHERE instr(lower(c.path || ' ' || c.name || ' ' || c.alias || ' ' || c.funId || ' ' || c.referenceFields),lower(?))>0
               OR instr(lower(coalesce(b.content,'')),lower(?))>0 AND c.referenceId=''
            ORDER BY c.path,c.dataSourceId,c.sourceId,c.lineNumber,b.json_pointer LIMIT ? OFFSET ?""",
            (query, query, query, limit + 1, offset),
        ).fetchall()
        result = _result(workspace, conn, rows, limit, offset, "hits")
        partial = conn.execute(
            "SELECT COUNT(*) FROM source_body_content WHERE indexed_chars<total_chars"
        ).fetchone()[0]
        result["partialBodyCount"] = partial
        if partial:
            result.update(complete=False, truncated=True)
        return result


def search_body(
    workspace, keyword, limit=20, cursor="", source_namespace="", source_type=""
):
    with closing(_connection(workspace)) as conn:
        generation = conn.execute(
            "SELECT state_value FROM gusen_sync_state WHERE state_key='generation'"
        ).fetchone()[0]
        result = source_text_search.search(
            conn,
            workspace["workspaceKey"],
            keyword=keyword,
            generation=generation,
            limit=limit,
            cursor=cursor,
            source_namespace=source_namespace,
            source_type=source_type,
        )
        result["workspaceKey"] = workspace["workspaceKey"]
        return result


def read_source(workspace, path, offset=0, max_chars=12000):
    _bound(max_chars, offset, 50000)
    item = ApiStore(workspace).read(path)
    if item["metadata"].get("sourceType") == "page":
        try:
            fmt = page_format(item)
        except PageIdentityMismatch:
            item = {**item, "readonly": True, "diagnostic": "API_PAGE_IDENTITY_MISMATCH"}
        except (ValueError, TypeError):
            from .native_page import is_metadata_only

            minimal = is_metadata_only(item["content"], item["metadata"], item["path"])
            item = {**item, "readonly": item["readonly"] if minimal else True,
                    "diagnostic": "API_PAGE_MINIMAL_SOURCE" if minimal else "API_PAGE_FORMAT_INVALID"}
            if minimal:
                item.update(sourceFormat="native-page-minimal", contentState="METADATA_ONLY", identitySource="API_METADATA", projectionReadonly=True)
        else:
            if fmt == "unsupported-xml":
                from .native_page import is_metadata_only

                minimal = is_metadata_only(item["content"], item["metadata"], item["path"])
                item = {**item, "readonly": item["readonly"] if minimal else True,
                        "diagnostic": "API_PAGE_MINIMAL_SOURCE" if minimal else "API_PAGE_XML_UNSUPPORTED"}
                if minimal:
                    item.update(sourceFormat="native-page-minimal", contentState="METADATA_ONLY", identitySource="API_METADATA", projectionReadonly=True)
    elif item["metadata"].get("sourceType") == "view":
        from .view_editor import extract_sql, is_metadata_only

        if is_metadata_only(item["content"], item["metadata"], item["path"]):
            item = {**item, "readonly": item["readonly"], "projectionReadonly": True, "diagnostic": "API_VIEW_SQL_ABSENT",
                    "sourceFormat": "view-no-sql", "contentState": "SQL_ABSENT", "identitySource": "SOURCE_AND_API_METADATA"}
        else:
            try:
                extract_sql(item["content"], item["metadata"])
            except ApiError as error:
                item = {**item, "readonly": True, "diagnostic": error.code}
    text = item["content"]
    more = offset + max_chars < len(text)
    return {
        **item,
        "content": text[offset : offset + max_chars],
        "offset": offset,
        "totalChars": len(text),
        "complete": not more,
        "truncated": more,
        "nextOffset": offset + max_chars if more else None,
    }


def _record(conn, path):
    if not isinstance(path, str) or not path:
        raise ValueError("path is required")
    row = conn.execute(
        "SELECT * FROM gusen_source_record WHERE source_path=?", (path,)
    ).fetchone()
    if row is None:
        raise ApiError("API_SOURCE_NOT_INDEXED", "源码不在当前工作区索引中，请重建索引")
    return row


def resolve_source(workspace, source_id, fun_id="", source_namespace=""):
    """Resolve exactly one current-workspace indexed identity or report ambiguity."""
    source_id = _query(source_id)
    fun_id = _query(fun_id, empty=True)
    params = [workspace["workspaceKey"], source_id]
    clauses = ["scope_id=?", "source_id=?", "source_table NOT LIKE '%-inherit'"]
    if fun_id:
        clauses.append("fun_id=?")
        params.append(fun_id)
    if source_namespace:
        if not isinstance(source_namespace, str):
            raise ValueError("invalid source namespace")
        parts = source_namespace.split(":")
        if len(parts) != 4 or parts[0] != "api":
            raise ValueError("invalid API source namespace")
        system_id, data_source_id, path = map(unquote, parts[1:])
        if (
            source_facts.api_source_namespace(system_id, data_source_id, path)
            != source_namespace
        ):
            raise ValueError("invalid API source namespace")
        clauses.extend(["system_id=?", "data_source_id=?", "source_path=?"])
        params.extend([system_id, data_source_id, path])
    with closing(_connection(workspace)) as conn:
        rows = conn.execute(
            "SELECT * FROM gusen_source_record WHERE "
            + " AND ".join(clauses)
            + " ORDER BY source_path LIMIT 2",
            params,
        ).fetchall()
        if not rows:
            raise ApiError("API_SOURCE_NOT_INDEXED", "当前工作区中没有匹配的源码")
        if len(rows) > 1:
            raise ApiError(
                "API_IDENTITY_AMBIGUOUS",
                "源码身份不唯一，请提供函数 ID 和精确 sourceNamespace",
            )
        source = dict(rows[0])
        source["source_namespace"] = source_facts.api_source_namespace(
            source["system_id"], source["data_source_id"], source["source_path"]
        )
        return source


def context(workspace, path, limit=20, offset=0):
    _bound(limit, offset)
    with closing(_connection(workspace)) as conn:
        row = _record(conn, path)
        rows = conn.execute(
            """SELECT script_type AS scriptType,json_path AS jsonPointer,line_no AS line,target_alias_id AS targetAlias,target_fun_id AS targetFunId,invoke_type AS type FROM gusen_invoke_call WHERE source_record_id=?
          UNION ALL SELECT script_type,json_path,line_no,invoke_expr,'',reason FROM gusen_dynamic_call WHERE source_record_id=? ORDER BY jsonPointer,line LIMIT ? OFFSET ?""",
            (row["record_id"], row["record_id"], limit + 1, offset),
        ).fetchall()
        result = _result(workspace, conn, rows, limit, offset, "calls")
        incoming = conn.execute(
            """SELECT s.source_path AS path,s.source_table AS sourceType,s.source_id AS sourceId,s.source_alias_id AS alias,s.fun_id AS funId,s.source_name AS name,s.system_id AS systemId,s.data_source_id AS dataSourceId,s.source_hash AS sourceHash,c.json_path AS jsonPointer,c.line_no AS line,c.invoke_type AS type
          FROM gusen_invoke_call c JOIN gusen_source_record s ON s.record_id=c.source_record_id
          WHERE c.target_alias_id=? AND c.target_fun_id=? ORDER BY s.source_path,c.json_path,c.line_no LIMIT ?""",
            (row["source_alias_id"], row["fun_id"], limit + 1),
        ).fetchall()
        result["incoming"] = _result(workspace, conn, incoming, limit, 0, "incoming")[
            "incoming"
        ]
        result["incomingTruncated"] = len(incoming) > limit
        if result["incomingTruncated"]:
            result.update(complete=False, truncated=True)
        from .workspace import project_metadata
        source_id = row["data_source_id"] or next((str(system.get("dataSourceId", "")) for system in
            project_metadata(workspace).get("systems", []) if str(system.get("systemId")) == row["system_id"]), "")
        configurations=conn.execute(
            """SELECT c.*,u.json_pointer AS jsonPointer FROM api_reference_use u
            JOIN api_source_catalog c ON c.sourceType=u.source_type AND c.sourceId=u.source_id
            WHERE u.source_record_id=? AND (u.source_type<>'bill-type' OR ?='' OR c.dataSourceId=?) ORDER BY u.json_pointer,c.dataSourceId LIMIT ?""",
            (row["record_id"],source_id,source_id,limit+1)).fetchall()
        result["configurationReferences"]=_result(workspace,conn,configurations,limit,0)["items"]
        result["configurationReferencesTruncated"]=len(configurations)>limit
        if result["configurationReferencesTruncated"]:result.update(complete=False,truncated=True)
        result["source"] = {
            "path": path,
            "sourcePath": path,
            "sourceHash": row["source_hash"],
            "sourceType": row["source_table"],
            "sourceId": row["source_id"],
            "sourceNamespace": source_facts.api_source_namespace(
                row["system_id"], row["data_source_id"], path
            ),
            "systemId": row["system_id"],
            "dataSourceId": row["data_source_id"],
            "alias": row["source_alias_id"],
            "funId": row["fun_id"],
        }
        return result


def callers(workspace, alias="", fun_id="", limit=100, offset=0, *, path=""):
    _bound(limit, offset)
    alias = _query(alias, empty=bool(path))
    fun_id = _query(fun_id, empty=True)
    with closing(_connection(workspace)) as conn:
        condition = "c.target_alias_id=? AND (?='' OR c.target_fun_id=?)"
        parameters = (alias, fun_id, fun_id)
        if path:
            source = _record(conn, path)
            if source["source_table"] == "page":
                condition = "c.target_alias_id IN (?,?) AND c.invoke_type IN ('vm_open','vm_open_dialog','gutil_request')"
                parameters = (source["source_alias_id"], source["source_id"])
            elif source["source_table"] == "procedure":
                condition = "c.target_alias_id=? AND c.target_fun_id=? AND c.invoke_type IN ('proc_invoke','proc_find_call')"
                parameters = (source["source_alias_id"], source["fun_id"])
            else:
                raise ApiError("API_INPUT_INVALID", "使用位置查询仅支持页面和过程函数")
        rows = conn.execute(
            """SELECT s.source_path AS path,s.source_table AS sourceType,s.source_id AS sourceId,s.source_alias_id AS alias,s.fun_id AS funId,s.source_name AS name,s.system_id AS systemId,s.data_source_id AS dataSourceId,s.source_hash AS sourceHash,c.json_path AS jsonPointer,c.line_no AS line,c.target_alias_id AS targetAlias,c.target_fun_id AS targetFunId,c.invoke_type AS type
          FROM gusen_invoke_call c JOIN gusen_source_record s ON s.record_id=c.source_record_id WHERE """ + condition + " ORDER BY s.source_path,c.json_path,c.line_no,c.id LIMIT ? OFFSET ?",
            (*parameters, limit + 1, offset),
        ).fetchall()
        return _result(workspace, conn, rows, limit, offset, "callers")


def facts(workspace, keyword="", path="", limit=50, offset=0):
    _bound(limit, offset)
    keyword = _query(keyword, empty=True)
    with closing(_connection(workspace)) as conn:
        if path:
            _record(conn, path)
        match = "%" + keyword + "%"
        rows = conn.execute(
            """SELECT 'data' AS kind,s.source_path AS path,f.json_pointer AS jsonPointer,d.line_no AS line,d.table_name AS subject,d.operation AS operation,d.key_fields AS fields,d.evidence AS evidence,d.confidence AS confidence
          FROM gusen_data_access d JOIN gusen_source_record s ON s.record_id=d.source_record_id LEFT JOIN gusen_source_fragment f ON f.fragment_id=d.source_fragment_id
          WHERE (?='' OR s.source_path=?) AND (d.table_name LIKE ? OR d.key_fields LIKE ? OR d.evidence LIKE ?)
          UNION ALL SELECT 'logic',s.source_path,f.json_pointer,l.line_start,l.subject,l.fact_kind,'',l.evidence,l.confidence FROM gusen_logic_fact l JOIN gusen_source_record s ON s.record_id=l.source_record_id LEFT JOIN gusen_source_fragment f ON f.fragment_id=l.source_fragment_id
          WHERE (?='' OR s.source_path=?) AND (l.subject LIKE ? OR l.value_text LIKE ? OR l.evidence LIKE ?)
          UNION ALL SELECT 'field',s.source_path,p.json_pointer,0,p.field_id,p.region_type,p.column_id,p.label,'HIGH' FROM gusen_page_field p JOIN gusen_source_record s ON s.record_id=p.source_record_id
          WHERE (?='' OR s.source_path=?) AND (p.field_id LIKE ? OR p.column_id LIKE ? OR p.label LIKE ?)
          UNION ALL SELECT 'relation',s.source_path,r.json_pointer,0,r.source_key,r.relation_type,r.target_key,'',r.confidence FROM gusen_page_relation r JOIN gusen_source_record s ON s.record_id=r.source_record_id
          WHERE (?='' OR s.source_path=?) AND (r.source_key LIKE ? OR r.target_key LIKE ? OR r.relation_type LIKE ?)
          ORDER BY path,jsonPointer,line LIMIT ? OFFSET ?""",
            (
                path,
                path,
                match,
                match,
                match,
                path,
                path,
                match,
                match,
                match,
                path,
                path,
                match,
                match,
                match,
                path,
                path,
                match,
                match,
                match,
                limit + 1,
                offset,
            ),
        ).fetchall()
        return _result(workspace, conn, rows, limit, offset, "facts")


def page(workspace, path, kind="nodes", limit=50, offset=0):
    _bound(limit, offset)
    tables = {
        "nodes": ("gusen_page_node", "json_pointer"),
        "fields": ("gusen_page_field", "json_pointer"),
        "relations": ("gusen_page_field_relation", "relation_id"),
        "scripts": ("gusen_source_fragment", "json_pointer"),
    }
    if kind not in tables:
        raise ValueError("kind must be nodes, fields, relations or scripts")
    with closing(_connection(workspace)) as conn:
        row = _record(conn, path)
        if row["source_table"] != "page" or (
            row["source_format"] not in {"json", "native-xml"}
            and not (row["source_format"] == "script" and kind == "scripts")
        ):
            raise ApiError(
                "API_PAGE_STRUCTURE_UNAVAILABLE", "此对象不支持所请求的 PAGE 结构查询"
            )
        table, order = tables[kind]
        rows = conn.execute(
            f"SELECT * FROM {table} WHERE source_record_id=? ORDER BY {order} LIMIT ? OFFSET ?",
            (row["record_id"], limit + 1, offset),
        ).fetchall()
        result = _result(workspace, conn, rows, limit, offset, kind)
        result["sourceHash"] = row["source_hash"]
        return result


def search_page_fields(workspace, query, path="", limit=50, offset=0):
    _bound(limit, offset)
    query = _query(query)
    with closing(_connection(workspace)) as conn:
        if path:
            _record(conn, path)
        rows = conn.execute(
            """SELECT s.source_path AS path,s.source_table AS sourceType,s.source_id AS sourceId,
          s.source_alias_id AS alias,s.fun_id AS funId,s.source_name AS name,s.system_id AS systemId,
          s.data_source_id AS dataSourceId,s.source_hash AS sourceHash,f.json_pointer AS jsonPointer,
          f.field_id AS fieldId,f.column_id AS columnId,f.table_id AS tableId,f.label,f.region_type AS regionType,
          f.semantic_field_id AS semanticFieldId,f.identity_stability AS identityStability
          FROM gusen_page_field f JOIN gusen_source_record s ON s.record_id=f.source_record_id
          WHERE s.scope_id=? AND (?='' OR s.source_path=?) AND
          (instr(lower(f.field_id),lower(?))>0 OR instr(lower(f.column_id),lower(?))>0 OR instr(lower(f.label),lower(?))>0)
          ORDER BY s.source_path,f.json_pointer LIMIT ? OFFSET ?""",
            (
                workspace["workspaceKey"],
                path,
                path,
                query,
                query,
                query,
                limit + 1,
                offset,
            ),
        ).fetchall()
        return _result(workspace, conn, rows, limit, offset, "fields")


def page_field_references(workspace, path, semantic_field_id, limit=20, offset=0):
    _bound(limit, offset, 20)
    if not isinstance(semantic_field_id, str) or not semantic_field_id.startswith(
        "page-node:v1:"
    ):
        raise ValueError("a stable semantic field ID is required")
    with closing(_connection(workspace)) as conn:
        record = _record(conn, path)
        if record["source_format"] not in {"json", "native-xml"}:
            raise ApiError("API_PAGE_STRUCTURE_UNAVAILABLE", "此对象没有 PAGE 字段结构")
        fields = conn.execute(
            "SELECT * FROM gusen_page_field WHERE source_record_id=? AND semantic_field_id=? LIMIT 2",
            (record["record_id"], semantic_field_id),
        ).fetchall()
        if len(fields) != 1 or fields[0]["identity_stability"] != "STABLE":
            raise ApiError("API_PAGE_FIELD_AMBIGUOUS", "字段不存在或身份不唯一")
        if ApiStore(workspace).read(path)["sourceHash"] != record["source_hash"]:
            raise ApiError("API_SOURCE_STALE", "PAGE 源码已变化，请先更新索引")
        field = fields[0]
        field_id = field["field_id"]
        rid = record["record_id"]
        incoming = (
            conn.execute(
                """SELECT source_pointer,evidence_pointer,resolution,target_pointer FROM gusen_page_field_relation
            WHERE source_record_id=? AND relation_type='SELECT_CODE_FIELD' AND target_field_id=?
            ORDER BY relation_id LIMIT ? OFFSET ?""",
                (rid, field_id, limit + 1, offset),
            ).fetchall()
            if field_id
            else []
        )
        unresolved = conn.execute(
            """SELECT evidence_pointer FROM gusen_page_field_relation WHERE source_record_id=?
            AND relation_type='OTHER_SET_FIELDS_UNPARSED' ORDER BY relation_id LIMIT ? OFFSET ?""",
            (rid, limit + 1, offset),
        ).fetchall()
        incoming_count = (
            conn.execute(
                "SELECT COUNT(*) FROM gusen_page_field_relation WHERE source_record_id=? AND relation_type='SELECT_CODE_FIELD' AND target_field_id=?",
                (rid, field_id),
            ).fetchone()[0]
            if field_id
            else 0
        )
        unresolved_count = conn.execute(
            "SELECT COUNT(*) FROM gusen_page_field_relation WHERE source_record_id=? AND relation_type='OTHER_SET_FIELDS_UNPARSED'",
            (rid,),
        ).fetchone()[0]
        duplicates = (
            conn.execute(
                "SELECT COUNT(*) FROM gusen_page_field WHERE source_record_id=? AND field_id=?",
                (rid, field_id),
            ).fetchone()[0]
            if field_id
            else 0
        )
        more = len(incoming) > limit or len(unresolved) > limit
        reasons = ["DYNAMIC_REFERENCES_UNVERIFIED"]
        if incoming_count:
            reasons.append("EXPLICIT_INCOMING_REFERENCE")
        if unresolved_count:
            reasons.append("OTHER_SET_FIELDS_UNPARSED")
        if duplicates > 1:
            reasons.append("NATIVE_FIELD_ID_AMBIGUOUS")
        return {
            "workspaceKey": workspace["workspaceKey"],
            "path": path,
            "sourceHash": record["source_hash"],
            "indexGeneration": conn.execute(
                "SELECT state_value FROM gusen_sync_state WHERE state_key='generation'"
            ).fetchone()[0],
            "target": dict(field),
            "nativeFieldIdOccurrences": duplicates,
            "explicitIncomingCount": incoming_count,
            "explicitIncoming": [dict(row) for row in incoming[:limit]],
            "unparsedMappingCount": unresolved_count,
            "unparsedMappingEvidence": [
                row["evidence_pointer"] for row in unresolved[:limit]
            ],
            "referenceCompleteness": "UNKNOWN",
            "deletionSafety": "BLOCKED_UNVERIFIED",
            "blockingReasons": reasons,
            "complete": not more,
            "truncated": more,
            "nextOffset": offset + limit if more else None,
        }


def read_page_item(workspace, path, json_pointer, offset=0, max_chars=12000):
    _bound(max_chars, offset, 50000)
    item = ApiStore(workspace).read(path)
    if page_format(item) not in {"json", "native-xml"}:
        raise ApiError(
            "API_PAGE_STRUCTURE_UNAVAILABLE", "此对象不是已解析的 PAGE，无法读取节点"
        )
    if not isinstance(json_pointer, str) or not json_pointer.startswith("/"):
        raise ValueError("json_pointer must identify a PAGE node")
    try:
        value = page_projection.pointer_value(_page_data(item["content"]), json_pointer)
    except (KeyError, IndexError, TypeError) as error:
        raise ValueError("PAGE node does not exist") from error
    text = (
        value
        if isinstance(value, str)
        else json.dumps(value, ensure_ascii=False, indent=2)
    )
    more = offset + max_chars < len(text)
    return {
        "path": path,
        "sourceHash": item["sourceHash"],
        "jsonPointer": json_pointer,
        "content": text[offset : offset + max_chars],
        "totalChars": len(text),
        "offset": offset,
        "truncated": more,
        "complete": not more,
        "nextOffset": offset + max_chars if more else None,
    }


def explain(
    workspace,
    table_name="",
    bill_type_code="",
    data_source_id="",
    operation="WRITE",
    limit=1,
    offset=0,
    fact_limit=4,
    caller_depth=2,
    include_details=False,
):
    _bound(limit, offset, 10)
    _bound(fact_limit, 0, 50)
    if type(caller_depth) is not int or not 0 <= caller_depth <= 5:
        raise ValueError("caller_depth must be 0–5")
    with closing(_connection(workspace)) as conn:
        bill_status = conn.execute(
            "SELECT state_value FROM gusen_sync_state WHERE state_key='billRouteStatus'"
        ).fetchone()
        if bill_type_code and (bill_status is None or bill_status[0] == "UNAVAILABLE"):
            raise ApiError(
                "API_BILL_EXPORT_UNAVAILABLE",
                "工作区未提供单据导出目录，无法解析单据路由",
            )
        result = source_facts.explain_table(
            conn,
            workspace["workspaceKey"],
            table_name=table_name,
            bill_type_code=bill_type_code,
            data_source_id=data_source_id,
            operation=operation,
            limit=limit,
            offset=offset,
            fact_limit=fact_limit,
            caller_depth=caller_depth,
            include_details=include_details,
        )
        result["workspaceKey"] = workspace["workspaceKey"]
        result["indexGeneration"] = conn.execute(
            "SELECT state_value FROM gusen_sync_state WHERE state_key='generation'"
        ).fetchone()[0]
        result["coverage"] = "INDEX_SNAPSHOT"
        result["billRouteStatus"] = bill_status[0] if bill_status else "UNAVAILABLE"
        result["partialSourceCount"] = conn.execute(
            "SELECT COUNT(*) FROM gusen_source_record WHERE status<>'OK'"
        ).fetchone()[0]
        result["complete"] = (
            not result.get("truncated", False) and not result["partialSourceCount"]
        )
        if result["partialSourceCount"]:
            result["warnings"] = ["部分源码未解析，分析结果不完整；请查看目录诊断。"]
        return result


def inheritance(workspace, path, json_pointer="", offset=0, max_chars=12000):
    _bound(max_chars, offset, 50000)
    store = ApiStore(workspace)
    current = store.read(path)
    meta = current["metadata"]
    kind = meta.get("sourceType")
    parent = None
    if kind == "page" and json_pointer:
        if page_format(current) not in {"json", "native-xml"}:
            raise ValueError("PAGE pointer requires an indexed PAGE")
        data = _page_data(current["content"])
        project = page_projection.pointer_value(data, json_pointer)
        if not isinstance(project, str):
            raise ValueError("PAGE pointer must identify a string")
        parent_pointer, parent = page_projection.inherited_page_script(
            data, json_pointer
        )
        result = inheritance_algorithms.project(project, parent)
        result["parentPointer"] = parent_pointer
    else:
        if kind == "page" and page_format(current) == "script":
            identity_keys = ("systemId", "pageSubId", "pageId")
        elif kind == "procedure":
            identity_keys = ("dataSourceId", "procedureId", "funId")
        elif kind == "system-script":
            identity_keys = ("systemId", "scriptType")
        else:
            raise ValueError(
                "inheritance requires a procedure, system script, service component or PAGE pointer"
            )
        matches = store.related(kind + "-inherit", meta, identity_keys)
        if len(matches) > 1:
            raise ApiError("API_IDENTITY_AMBIGUOUS", "继承父源码不唯一")
        parent_item = store.read(matches[0]["path"]) if matches else None
        parent = parent_item["content"] if parent_item else None
        product_offset = 0
        invalid_parent_header = False
        if parent is not None and kind in {"procedure", "page"}:
            original = parent
            parent, product_offset = inheritance_algorithms.procedure_body(parent)
            if original.lstrip("\ufeff").startswith("/**") and product_offset == 0:
                parent = None
                invalid_parent_header = True
        result = inheritance_algorithms.project(
            current["content"], parent, product_offset=product_offset
        )
        if invalid_parent_header:
            result["diagnostic"] = "父源码文档块未闭合，无法展开继承"
        result["parentPath"] = parent_item["path"] if parent_item else None
        result["parentHash"] = parent_item["sourceHash"] if parent_item else None
    effective = result.get("effective")
    if effective is not None:
        result["totalChars"] = len(effective)
        result["effective"] = effective[offset : offset + max_chars]
        result["truncated"] = offset + max_chars < len(effective)
        result["nextOffset"] = offset + max_chars if result["truncated"] else None
    result.update(path=path, sourceHash=current["sourceHash"], offset=offset)
    return result

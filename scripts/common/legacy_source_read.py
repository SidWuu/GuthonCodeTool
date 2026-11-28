"""Bounded local catalog and caller queries for the legacy index."""
import json

from common import legacy_source as hub
from common import database_source_exports as exports
from common.page_comparison import baseline_pointer, same_json_value
from common.page_projection import extract_page_fields, extract_page_scripts

SOURCE_TYPES = ("page", "procedure", "system-script", "table", "view", "skill", "public")
DATABASE_TYPES = ("page", "procedure", *exports.TYPES)
RECORD_COLUMNS = "record_id, source_table, source_id, source_alias_id, fun_id, source_name, source_path, local_path, working_copy_id"


def _record(workspace, row, scope_codes=None):
    target = _indexed_file(workspace, row)
    if not target:
        return None
    result = {"sourceType": row["source_table"], "sourceId": row["source_id"], "funId": row["fun_id"],
              "alias": row["source_alias_id"], "name": row["source_name"], "recordId": row["record_id"],
              "sourcePath": row["source_path"], "workingCopyId": row["working_copy_id"]}
    if workspace["sourceMode"] == "database":
        relative = target.relative_to(workspace["readonlyDir"]).as_posix()
        parts = relative.split("/")
        groups = parts[:-2]
        if len(groups) >= 2 and groups[1] in {"page", "procedure"}:
            del groups[1]
        result.update(sourcePath=relative, groups=groups)
        if scope_codes is not None and groups:
            group=groups[0]
            if group not in scope_codes:
                metadata=target.with_name("meta.json")
                code=""
                if metadata.is_file() and metadata.resolve()==metadata:
                    try:
                        value=json.loads(metadata.read_text(encoding="utf-8"))
                        code=str(value.get("system_id" if row["source_table"]=="page" else "data_source_id") or "")
                    except (OSError,ValueError,AttributeError):
                        pass
                scope_codes[group]=code
            result["scopeCode"]=scope_codes[group]
    return result


def catalog(workspace, *, source_type="", after=0, limit=100, config=None):
    database = workspace["sourceMode"] == "database"
    if source_type and source_type not in (DATABASE_TYPES if database else SOURCE_TYPES):
        raise ValueError("Unsupported source category")
    if type(after) is not int or after < 0:
        raise ValueError("Invalid catalog cursor")
    if type(limit) is not int or not 1 <= limit <= 500:
        raise ValueError("Catalog page size must be between 1 and 500")
    conditions = "scope_id=? AND provider=?"
    args = [workspace["scopeId"], workspace["sourceMode"]]
    with hub.index_connection(workspace, action="local-catalog") as conn:
        indexed_exports = database and exports.available(conn)
        if not source_type:
            rows = conn.execute(
                f"SELECT DISTINCT source_table FROM gusen_source_record WHERE {conditions} ORDER BY source_table", args
            )
            categories = {row[0] for row in rows if row[0] in SOURCE_TYPES}
            if indexed_exports:
                categories.update(row[0] for row in conn.execute("SELECT DISTINCT source_type FROM database_source_export"))
            result = {"categories": [category for category in (DATABASE_TYPES if database else SOURCE_TYPES) if category in categories]}
            if database:
                result["exportIndexReady"] = indexed_exports
                if config is not None:
                    from common.source_tree_order import local_navigation_groups

                    try:
                        scope = hub.resolve_system_scope(None, config, workspace["datasourceName"], workspace, allow_remote=False) or {}
                    except SystemExit:
                        # Navigation can still use explicit mappings when the local name cache is stale.
                        scope = {}
                    result["navigationGroups"] = local_navigation_groups(workspace,
                        scope.get("system_name_by_id", {}), scope.get("system_name_by_data_source_id", {}))
            return result
        if database and source_type in exports.TYPES:
            rows = conn.execute(
                f"SELECT {exports.OBJECT_COLUMNS} FROM database_source_export WHERE source_type=? ORDER BY folder, source_name, export_key LIMIT ? OFFSET ?",
                (source_type, limit + 1, after),
            ).fetchall() if indexed_exports else []
            return {"items": [exports.payload(row) for row in rows[:limit]], "next": after + limit if len(rows) > limit else None}
        rows = conn.execute(
            f"""SELECT {RECORD_COLUMNS}
                FROM gusen_source_record WHERE {conditions} AND source_table=? AND record_id>?
                ORDER BY record_id LIMIT ?""",
            [*args, source_type, after, limit + 1],
        ).fetchall()
    scope_codes={}
    items = [item for row in rows[:limit] if (item := _record(workspace, row,scope_codes))]
    return {"items": items, "next": rows[limit-1]["record_id"] if len(rows) > limit else None}


def locate(workspace, *, source_type, source_id="", alias="", fun_id=""):
    if source_type not in {"page", "procedure"}:
        raise ValueError("Only exact page and procedure targets can be located")
    conditions = ["scope_id=?", "provider=?", "source_table=?"]
    args = [workspace["scopeId"], workspace["sourceMode"], source_type]
    if source_type == "page" and source_id:
        conditions.append("source_id=?")
        args.append(source_id)
    elif source_type == "procedure" and alias and fun_id:
        conditions.extend(["source_alias_id=?", "fun_id=?"])
        args.extend([alias, fun_id])
    else:
        raise ValueError("Source identity is incomplete")
    with hub.index_connection(workspace, action="locate-local-source") as conn:
        rows = conn.execute(
            f"SELECT {RECORD_COLUMNS} FROM gusen_source_record WHERE "
            + " AND ".join(conditions) + " ORDER BY record_id LIMIT 51", args
        ).fetchall()
    if len(rows) > 50:
        raise SystemExit("Too many exact matches; narrow the source scope")
    return {"items": [item for row in rows if (item := _record(workspace, row))]}


def local_changes(workspace):
    """Report canonical DATABASE Workcopy changes independently of Git and projections."""
    from common.page_editor import MAX_PAGE_BYTES
    from common.source_format import decode_source

    readonly = workspace["readonlyDir"].resolve()
    workcopy = workspace["workcopyDir"].resolve()
    if not workcopy.is_dir():
        return {"items": []}
    items = []
    with hub.index_connection(workspace, action="workcopy-changes") as conn:
        rows = conn.execute("""SELECT source_table, local_path FROM gusen_source_record
            WHERE scope_id=? AND provider='database' AND source_table IN ('page','procedure') AND local_path<>''""",
                            (workspace["scopeId"],))
        for row in rows:
            filename = "raw.json" if row["source_table"] == "page" else "source.vm"
            source = hub.ROOT / row["local_path"] / filename
            if not source.is_relative_to(readonly):
                continue
            relative = source.relative_to(readonly)
            target = workcopy / relative
            if not target.is_file() or target.resolve() != target or source.resolve() != source or not source.is_file():
                continue
            try:
                with source.open("rb") as baseline, target.open("rb") as saved:
                    for chunk in iter(lambda: saved.read(64 * 1024), b""):
                        if chunk != baseline.read(len(chunk)):
                            break
                    else:
                        if not baseline.read(1):
                            continue
                    if row["source_table"] == "page":
                        baseline.seek(0)
                        saved.seek(0)
                        left = baseline.read(MAX_PAGE_BYTES + 1)
                        right = saved.read(MAX_PAGE_BYTES + 1)
                        if max(len(left), len(right)) <= MAX_PAGE_BYTES:
                            try:
                                base_page = _page_data(decode_source(left)[0])
                                saved_page = _page_data(decode_source(right)[0])
                                if same_json_value(base_page, saved_page):
                                    continue
                            except (ValueError, RecursionError):
                                # Without a semantic comparison, retain the observed byte difference.
                                pass
            except FileNotFoundError:
                # Resync can replace either file between the lookup and open.
                continue
            items.append({"sourceType": row["source_table"], "sourcePath": relative.as_posix()})
    return {"items": items}


def _indexed_file(workspace, row):
    paths = [entry["path"].resolve() for entry in workspace["sourceRoots"]
             if entry["role"] != "workcopy"]
    if not row["local_path"]:
        return None
    target = (hub.ROOT / row["local_path"]).resolve()
    if target.is_dir() and workspace["sourceMode"] == "database":
        target = (target / ("raw.json" if row["source_table"] == "page" else "source.vm")).resolve()
    if target.is_file() and any(
        target.is_relative_to(root) and ".svn" not in target.relative_to(root).parts
        for root in paths
    ):
        return target
    return None


def _page_data(text):
    data = json.loads(text)
    data = json.loads(data) if isinstance(data, str) else data
    if not isinstance(data, dict):
        raise ValueError("PAGE 根节点必须为对象")
    return data


def _page_fragments(data):
    fragments = {field.json_pointer: (field.display_name,
                 {"js": "javascript", "sql": "sql"}.get(field.script_type, "guthon-gss"),
                 field.effective_value, any(segment["layer"] == "product" for segment in field.origin_segments))
                 for field in extract_page_scripts(data)}
    for field in extract_page_fields(data, include_buttons=True):
        fragments[field["json_pointer"]] = (field["label"], "json", field["content"], False)
    return fragments


def read(workspace, record_id, *, limit=24000, pointer="", fragments=False, export_key="", source_id=""):
    from common.source_format import decode_source

    with hub.index_connection(workspace, action="read-indexed-source") as conn:
        if export_key and workspace["sourceMode"] == "database":
            result = exports.read(conn, workspace, export_key)
            return {**result, "truncated": len(result["content"]) > limit, "content": result["content"][:limit]}
        if type(record_id) is not int or record_id <= 0:
            raise ValueError("Invalid source record identity")
        row = conn.execute(
            """SELECT source_table, source_id, fun_id, local_path FROM gusen_source_record
               WHERE scope_id=? AND provider=? AND record_id=?""",
            (workspace["scopeId"], workspace["sourceMode"], record_id),
        ).fetchone()
        target = _indexed_file(workspace, row) if row and row["source_table"] in SOURCE_TYPES else None
        if not target or source_id and row["source_id"] != source_id:
            raise SystemExit("Indexed source is outside this workspace or unavailable")
        baseline = target
        if (pointer or fragments) and row["source_table"] == "page" and workspace["sourceMode"] == "database":
            workcopy = workspace["workcopyDir"].resolve() / target.relative_to(workspace["readonlyDir"].resolve())
            if workcopy.is_file() and workcopy.resolve() == workcopy:
                target = workcopy
        with target.open("rb") as source:
            raw = source.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise SystemExit("Source exceeds the local read limit")
        content = decode_source(raw)[0]
    source_type = row["source_table"]
    language = {"json": "json", "sql": "sql", "vm": "guthon-gss", "gss": "guthon-gss", "js": "javascript"}.get(target.suffix[1:], "plaintext")
    if (pointer or fragments) and source_type == "page" and workspace["sourceMode"] == "database":
        try:
            data = _page_data(content)
        except ValueError as error:
            if fragments:
                return {"fragments": [], "diagnostic": f"PAGE 无法解析：{error}"}
            raise SystemExit(f"PAGE 无法解析：{error}") from error
        scripts = _page_fragments(data)
        if fragments:
            modified = set()
            diagnostic = ""
            if baseline != target:
                try:
                    with baseline.open("rb") as source:
                        original = source.read(2 * 1024 * 1024 + 1)
                    if len(original) > 2 * 1024 * 1024:
                        raise ValueError("超过本地源码预览上限")
                    if raw != original:
                        base_data = _page_data(decode_source(original)[0])
                        original_scripts = _page_fragments(base_data)
                        for key, value in scripts.items():
                            prior = original_scripts.get(baseline_pointer(base_data, data, key))
                            if prior is not None and (prior[2] == value[2] or (
                                    prior[1] == value[1] == "json"
                                    and same_json_value(json.loads(prior[2]), json.loads(value[2])))):
                                continue
                            modified.add(key)
                except (OSError, ValueError) as error:
                    diagnostic = f"无法读取 DATABASE 只读基线：{error}"
            return {"fragments": [{"pointer": key, "label": value[0], "language": value[1], "inherited": value[3]}
                                  for key, value in scripts.items()], "modifiedPointers": sorted(modified),
                    **({"diagnostic": diagnostic} if diagnostic else {})}
        if pointer not in scripts:
            raise SystemExit("PAGE 片段已变化或不属于当前对象")
        _label, language, content, _inherited = scripts[pointer]
    result = {"content": content[:limit], "truncated": len(content) > limit, "sourceType": source_type, "language": language}
    if source_type == "procedure" and workspace["sourceMode"] == "database":
        from common.procedure_signature import procedure_signature

        result["procedureSignature"] = procedure_signature(content, {"funId": row["fun_id"]})
    return result


def search(workspace, keyword, *, limit=80, source_type=""):
    if not isinstance(keyword, str) or not 1 <= len(keyword.strip()) <= 256:
        raise ValueError("请输入 1–256 字符的源码关键词")
    if source_type and source_type not in DATABASE_TYPES:
        raise ValueError("Unsupported source category")
    keyword = keyword.strip()
    items = []
    visited = set()
    excerpt = """CASE WHEN position>0 THEN substr(body,max(1,position-36),length(:keyword)+111) END AS excerpt,
                 CASE WHEN position>0 THEN position-length(replace(substr(body,1,position-1),char(10),'')) END AS line"""
    with hub.index_connection(workspace, action="database-source-search") as conn:
        columns = ", ".join(f"s.{column.strip()}" for column in RECORD_COLUMNS.split(","))
        params = {"scope": workspace["scopeId"], "keyword": keyword, "limit": limit + 1, "source_type": source_type}
        rows = conn.execute(f"""SELECT {columns}, NULL AS pointer, NULL AS excerpt, NULL AS line
            FROM gusen_source_record s WHERE s.scope_id=:scope AND s.provider='database'
            AND (:source_type='' OR s.source_table=:source_type)
            AND instr(lower(s.source_id || ' ' || s.source_alias_id || ' ' || s.fun_id || ' ' || coalesce(s.source_name,'')),lower(:keyword))>0
            ORDER BY s.record_id LIMIT :limit""", params).fetchall()
        bodies = conn.execute(f"""WITH hits AS (
            SELECT {columns}, b.json_pointer AS pointer, b.content AS body,
                   instr(lower(b.content),lower(:keyword)) AS position
            FROM source_body_content b JOIN gusen_source_record s ON s.record_id=b.source_record_id
            WHERE s.scope_id=:scope AND s.provider='database' AND s.status='OK' AND position>0
            AND (:source_type='' OR s.source_table=:source_type)
            ORDER BY b.body_id LIMIT :limit)
            SELECT {RECORD_COLUMNS}, pointer, {excerpt} FROM hits""", params).fetchall() if conn.execute(
            "SELECT 1 FROM sqlite_master WHERE name='source_body_content'").fetchone() else []
        derived = conn.execute(f"""WITH hits AS (
            SELECT {exports.OBJECT_COLUMNS}, body, instr(lower(body),lower(:keyword)) AS position
            FROM database_source_export WHERE (:source_type='' OR source_type=:source_type)
            AND (position>0 OR instr(lower(source_id || ' ' || source_name || ' ' || folder),lower(:keyword))>0)
            ORDER BY folder,source_name,export_key LIMIT :limit)
            SELECT {exports.OBJECT_COLUMNS}, {excerpt} FROM hits""", params).fetchall() if exports.available(conn) else []
        for row in (*bodies, *rows, *derived):
            item = exports.payload(row) if "export_key" in row.keys() else _record(workspace, row)
            if not item:
                continue
            item["pointer"] = row["pointer"] or "" if "pointer" in row.keys() else ""
            identity = (item.get("recordId"), item.get("exportKey"), item["pointer"])
            if identity in visited:
                continue
            visited.add(identity)
            item["excerpt"] = row["excerpt"]
            if not item["pointer"].endswith(("/fields", "/buttons")):
                item["line"] = row["line"]
            items.append(item)
    return {"items": items[:limit], "truncated": len(items) > limit}


def callers(workspace, alias, fun_id, *, locations=False):
    if not isinstance(alias, str) or not alias.strip() or not isinstance(fun_id, str) or not fun_id.strip():
        raise ValueError("Explicit procedure alias and function ID required")
    with hub.index_connection(workspace, action="callers") as conn:
        if locations and workspace["sourceMode"] == "database":
            columns = ", ".join(f"s.{column.strip()}" for column in RECORD_COLUMNS.split(","))
            rows = conn.execute(f"""SELECT {columns}, c.json_path, c.line_no
                FROM gusen_invoke_call c JOIN gusen_source_record s ON c.source_record_id=s.record_id
                WHERE s.scope_id=? AND s.provider='database' AND c.target_alias_id=? AND c.target_fun_id=?
                ORDER BY s.record_id, c.line_no LIMIT 100""", (workspace["scopeId"], alias, fun_id))
            return {"callers": [{**item, "pointer": row["json_path"], "line": row["line_no"]}
                                for row in rows if (item := _record(workspace, row))]}
        return {"callers": [dict(row) for row in hub.query_incoming_callers(conn, workspace["scopeId"], alias, fun_id, 100)]}

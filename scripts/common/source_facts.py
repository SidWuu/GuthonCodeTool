"""Compact, source-free facts derived from indexed Gushen objects."""

from __future__ import annotations

import hashlib
import json
import re


MAX_FACTS_PER_FRAGMENT = 2_000
MAX_EVIDENCE_CHARS = 240
MAX_DETAIL_CHARS = 2_048
WRITE_OPERATIONS = {"INSERT", "UPDATE", "DELETE", "MERGE", "BATCH_WRITE"}

SQL_ACCESS = re.compile(
    r"(?is)\b(?P<operation>insert\s+into|update|delete\s+from|merge\s+into|from|join)"
    r"\s+(?P<table>[`\"\[]?[A-Za-z_][A-Za-z0-9_.$]*[`\"\]]?)"
)
API_ACCESS = re.compile(
    r"(?i)\b(?P<operation>batchUpdate|batchInsert|selectOne|insert|update|delete|count|select)"
    r"\s*\(\s*['\"](?P<table>[A-Za-z_][A-Za-z0-9_.$]*)['\"]"
)
API_VARIABLE_ACCESS = re.compile(
    r"(?i)\b(?P<operation>batchUpdate|batchInsert|selectOne|insert|update|delete|count|select)"
    r"\s*\(\s*\$(?P<variable>[A-Za-z_][A-Za-z0-9_]*)"
)
STRING_BINDING = re.compile(
    r"(?:#set\s*\(\s*)?\$(?P<variable>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*"
    r"['\"](?P<value>[A-Za-z_][A-Za-z0-9_.$]*)['\"]"
)
CONDITION = re.compile(r"(?i)(?:^|\s)(?:#?if)\s*\((?P<value>.+)")
ASSIGNMENT = re.compile(
    r"^(?:#set\s*\(\s*)?\$?(?P<subject>[A-Za-z_][A-Za-z0-9_.$\[\]'-]*)"
    r"\s*(?<![=!<>])=(?!=)\s*(?P<value>.+?)(?:\)\s*)?;?$"
)
ERROR_MARKER = re.compile(r"(?i)\b(?:throw|error|exception|fail(?:ed|ure)?)\b|失败|异常|错误")
RETURN_MARKER = re.compile(r"(?i)^\s*(?:#return|return)\b")
RELEVANT_PAGE_KEY = re.compile(
    r"(?i)(?:field|column|table|query|datasource|service|component|module|mapping|relation|bind|alias|code|id)$"
)
MAPPING_CONTAINER_KEY = re.compile(r"(?i)(?:mapping|relation|binding|bind|map)")


def setup_schema(conn) -> None:
    """Create additive fact tables without changing existing source identities."""

    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS gusen_source_fragment (
            fragment_id INTEGER PRIMARY KEY,
            source_record_id INTEGER NOT NULL,
            fragment_type TEXT NOT NULL,
            json_pointer TEXT NOT NULL DEFAULT '',
            label TEXT NOT NULL DEFAULT '',
            language TEXT NOT NULL DEFAULT '',
            coordinate_kind TEXT NOT NULL DEFAULT 'fragment-line',
            line_count INTEGER NOT NULL DEFAULT 0,
            content_hash TEXT NOT NULL,
            UNIQUE(source_record_id, json_pointer, fragment_type)
        );
        CREATE TABLE IF NOT EXISTS gusen_page_relation (
            relation_id INTEGER PRIMARY KEY,
            source_record_id INTEGER NOT NULL,
            source_fragment_id INTEGER,
            relation_type TEXT NOT NULL,
            source_key TEXT NOT NULL DEFAULT '',
            target_key TEXT NOT NULL DEFAULT '',
            json_pointer TEXT NOT NULL DEFAULT '',
            confidence TEXT NOT NULL DEFAULT 'MEDIUM'
        );
        CREATE TABLE IF NOT EXISTS gusen_bill_route (
            route_id INTEGER PRIMARY KEY,
            source_record_id INTEGER NOT NULL,
            data_source_id TEXT NOT NULL DEFAULT '',
            bill_type_code TEXT NOT NULL,
            bill_type_name TEXT NOT NULL DEFAULT '',
            table_name TEXT NOT NULL,
            primary_keys TEXT NOT NULL DEFAULT '',
            UNIQUE(source_record_id, data_source_id, bill_type_code, table_name)
        );
        CREATE TABLE IF NOT EXISTS gusen_data_access (
            access_id INTEGER PRIMARY KEY,
            source_record_id INTEGER NOT NULL,
            source_fragment_id INTEGER NOT NULL,
            table_name TEXT NOT NULL,
            operation TEXT NOT NULL,
            key_fields TEXT NOT NULL DEFAULT '',
            line_no INTEGER NOT NULL DEFAULT 0,
            scope_path TEXT NOT NULL DEFAULT '',
            access_kind TEXT NOT NULL,
            confidence TEXT NOT NULL,
            evidence TEXT NOT NULL DEFAULT '',
            detail_text TEXT NOT NULL DEFAULT '',
            detail_hash TEXT NOT NULL DEFAULT '',
            detail_truncated INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS gusen_logic_fact (
            fact_id INTEGER PRIMARY KEY,
            source_record_id INTEGER NOT NULL,
            source_fragment_id INTEGER NOT NULL,
            fact_kind TEXT NOT NULL,
            subject TEXT NOT NULL DEFAULT '',
            operator TEXT NOT NULL DEFAULT '',
            value_text TEXT NOT NULL DEFAULT '',
            scope_path TEXT NOT NULL DEFAULT '',
            parent_fact_id INTEGER,
            line_start INTEGER NOT NULL DEFAULT 0,
            line_end INTEGER NOT NULL DEFAULT 0,
            confidence TEXT NOT NULL DEFAULT 'MEDIUM',
            evidence TEXT NOT NULL DEFAULT '',
            detail_text TEXT NOT NULL DEFAULT '',
            detail_hash TEXT NOT NULL DEFAULT '',
            detail_truncated INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS gusen_fragment_source_idx
            ON gusen_source_fragment(source_record_id, json_pointer);
        CREATE INDEX IF NOT EXISTS gusen_page_relation_source_idx
            ON gusen_page_relation(source_record_id, source_fragment_id, relation_type);
        CREATE INDEX IF NOT EXISTS gusen_bill_route_lookup_idx
            ON gusen_bill_route(data_source_id, bill_type_code, table_name);
        CREATE INDEX IF NOT EXISTS gusen_data_access_table_idx
            ON gusen_data_access(table_name, operation, source_fragment_id);
        CREATE INDEX IF NOT EXISTS gusen_data_access_source_idx
            ON gusen_data_access(source_fragment_id, table_name);
        CREATE INDEX IF NOT EXISTS gusen_logic_fact_source_idx
            ON gusen_logic_fact(source_fragment_id, fact_kind, line_start);
        CREATE INDEX IF NOT EXISTS gusen_logic_fact_scope_idx
            ON gusen_logic_fact(source_fragment_id, scope_path, line_start, line_end);
        """
    )
    for table in ("gusen_invoke_call", "gusen_dynamic_call"):
        columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if "source_fragment_id" not in columns:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN source_fragment_id INTEGER")
    fts = conn.execute("SELECT 1 FROM sqlite_master WHERE name='gusen_fact_fts'").fetchone()
    if fts:
        conn.execute("DROP TABLE gusen_fact_fts")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS gusen_page_relation_target_idx "
        "ON gusen_page_relation(target_key, relation_type, source_record_id)"
    )


def clear_source_details(conn, source_record_id: int) -> None:
    conn.execute("DELETE FROM gusen_page_relation WHERE source_record_id=?", (source_record_id,))
    conn.execute("DELETE FROM gusen_bill_route WHERE source_record_id=?", (source_record_id,))
    conn.execute("DELETE FROM gusen_data_access WHERE source_record_id=?", (source_record_id,))
    conn.execute("DELETE FROM gusen_logic_fact WHERE source_record_id=?", (source_record_id,))
    conn.execute("DELETE FROM gusen_source_fragment WHERE source_record_id=?", (source_record_id,))


def clear_all_details(conn, *, preserve_external_bill_routes: bool = False) -> None:
    for table in (
        "gusen_page_relation",
        "gusen_data_access",
        "gusen_logic_fact",
        "gusen_source_fragment",
    ):
        conn.execute(f"DELETE FROM {table}")
    if preserve_external_bill_routes:
        conn.execute("DELETE FROM gusen_bill_route WHERE source_record_id<>0")
    else:
        conn.execute("DELETE FROM gusen_bill_route")


def _hash_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _bounded_text(value: object, limit: int) -> tuple[str, str, int]:
    text = str(value or "").strip()
    return text[:limit], _hash_text(text), int(len(text) > limit)


def _json_pointer(parts) -> str:
    if not parts:
        return ""
    return "/" + "/".join(str(part).replace("~", "~0").replace("/", "~1") for part in parts)


def _pointer_parts(pointer: str) -> list[str]:
    if not pointer:
        return []
    return [part.replace("~1", "/").replace("~0", "~") for part in pointer[1:].split("/")]


def _pointer_value(value, pointer: str):
    current = value
    for part in _pointer_parts(pointer):
        current = current[int(part)] if isinstance(current, list) else current[part]
    return current


def _fragment_type(script_type: str, pointer: str) -> str:
    normalized = str(script_type or "").lower()
    if normalized == "fields":
        return "page-fields"
    if normalized == "sql" or pointer.lower().endswith("sql") or normalized == "view_sql":
        return "query-sql"
    if "serviceevents" in pointer.lower() or normalized in {"vm", "gss"} and "event" in pointer.lower():
        return "service-event"
    if "pageevents" in pointer.lower() or normalized.endswith("script") and "event" in pointer.lower():
        return "page-event"
    return normalized or "source"


def _language(script_type: str, pointer: str) -> str:
    normalized = str(script_type or "").lower()
    if normalized == "fields":
        return "json"
    if normalized == "sql" or pointer.lower().endswith("sql") or normalized == "view_sql":
        return "sql"
    if normalized in {"js", "javascript"} or "pageevents" in pointer.lower():
        return "javascript"
    return "guthon-gss"


def _insert_fragment(conn, source_record_id: int, script: dict) -> int:
    content = str(script.get("content") or "")
    pointer = str(script.get("json_path") or "")
    fragment_type = _fragment_type(str(script.get("script_type") or ""), pointer)
    conn.execute(
        """
        INSERT OR REPLACE INTO gusen_source_fragment(
            fragment_id, source_record_id, fragment_type, json_pointer, label, language,
            coordinate_kind, line_count, content_hash
        ) VALUES(
            (SELECT fragment_id FROM gusen_source_fragment
             WHERE source_record_id=? AND json_pointer=? AND fragment_type=?),
            ?,?,?,?,?,?,?,?
        )
        """,
        (
            source_record_id,
            pointer,
            fragment_type,
            source_record_id,
            fragment_type,
            pointer,
            str(script.get("label") or pointer or fragment_type),
            _language(str(script.get("script_type") or ""), pointer),
            "fragment-line",
            len(content.splitlines()),
            _hash_text(content),
        ),
    )
    row = conn.execute(
        "SELECT fragment_id FROM gusen_source_fragment WHERE source_record_id=? AND json_pointer=? AND fragment_type=?",
        (source_record_id, pointer, fragment_type),
    ).fetchone()
    return int(row["fragment_id"])


def _logic_facts(content: str, label: str) -> list[dict]:
    lines = content.splitlines()
    facts = []
    stack: list[int] = []
    for line_no, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#end") or line.startswith("}"):
            if stack:
                facts[stack.pop()]["line_end"] = line_no
        scope = "/".join(str(facts[index]["line_start"]) for index in stack)
        match = CONDITION.search(line)
        if match and len(facts) < MAX_FACTS_PER_FRAGMENT:
            index = len(facts)
            facts.append(
                {
                    "fact_kind": "CONDITION",
                    "subject": "if",
                    "operator": "EVALUATE",
                    "value_text": match.group("value").rstrip("{ ").strip(),
                    "scope_path": scope,
                    "parent_index": stack[-1] if stack else None,
                    "line_start": line_no,
                    "line_end": line_no,
                    "confidence": "MEDIUM",
                    "detail": line,
                }
            )
            if "{" in line or line.startswith("#if"):
                stack.append(index)
                scope = "/".join(str(facts[item]["line_start"]) for item in stack)
        assignment = ASSIGNMENT.match(line)
        if assignment and len(facts) < MAX_FACTS_PER_FRAGMENT:
            facts.append(
                {
                    "fact_kind": "ASSIGNMENT",
                    "subject": assignment.group("subject"),
                    "operator": "SET",
                    "value_text": assignment.group("value").strip(),
                    "scope_path": scope,
                    "parent_index": stack[-1] if stack else None,
                    "line_start": line_no,
                    "line_end": line_no,
                    "confidence": "MEDIUM",
                    "detail": line,
                }
            )
        if ERROR_MARKER.search(line) and len(facts) < MAX_FACTS_PER_FRAGMENT:
            facts.append(
                {
                    "fact_kind": "ERROR",
                    "subject": "error",
                    "operator": "RAISE",
                    "value_text": line,
                    "scope_path": scope,
                    "parent_index": stack[-1] if stack else None,
                    "line_start": line_no,
                    "line_end": line_no,
                    "confidence": "HIGH",
                    "detail": line,
                }
            )
        if RETURN_MARKER.search(line) and len(facts) < MAX_FACTS_PER_FRAGMENT:
            facts.append(
                {
                    "fact_kind": "RETURN",
                    "subject": "return",
                    "operator": "RETURN",
                    "value_text": line,
                    "scope_path": scope,
                    "parent_index": stack[-1] if stack else None,
                    "line_start": line_no,
                    "line_end": line_no,
                    "confidence": "HIGH",
                    "detail": line,
                }
            )
        closing = line.count("}") - int(line.startswith("}"))
        for _ in range(max(0, closing)):
            if stack:
                facts[stack.pop()]["line_end"] = line_no
    final_line = max(1, len(lines))
    for index in stack:
        facts[index]["line_end"] = final_line
    return facts


def _insert_logic_facts(conn, source_record_id: int, fragment_id: int, content: str, label: str) -> list[dict]:
    inserted = []
    ids: dict[int, int] = {}
    for ordinal, fact in enumerate(_logic_facts(content, label)):
        raw_detail = str(fact["detail"] or "").strip()
        detail, detail_hash, detail_truncated = _bounded_text(raw_detail, MAX_DETAIL_CHARS)
        evidence = detail[:MAX_EVIDENCE_CHARS]
        stored_detail = detail if len(raw_detail) > MAX_EVIDENCE_CHARS else ""
        parent_id = ids.get(fact["parent_index"])
        cursor = conn.execute(
            """
            INSERT INTO gusen_logic_fact(
                source_record_id, source_fragment_id, fact_kind, subject, operator, value_text,
                scope_path, parent_fact_id, line_start, line_end, confidence, evidence,
                detail_text, detail_hash, detail_truncated
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                source_record_id,
                fragment_id,
                fact["fact_kind"],
                fact["subject"],
                fact["operator"],
                str(fact["value_text"])[:MAX_DETAIL_CHARS],
                fact["scope_path"],
                parent_id,
                fact["line_start"],
                fact["line_end"],
                fact["confidence"],
                evidence,
                stored_detail,
                detail_hash,
                detail_truncated,
            ),
        )
        fact_id = int(cursor.lastrowid)
        ids[ordinal] = fact_id
        inserted.append({**fact, "fact_id": fact_id})
    return inserted


def _scope_for_line(facts: list[dict], line_no: int) -> str:
    candidates = [
        fact
        for fact in facts
        if fact["fact_kind"] == "CONDITION" and fact["line_start"] <= line_no <= fact["line_end"]
    ]
    if not candidates:
        return ""
    selected = max(candidates, key=lambda fact: fact["line_start"])
    return "/".join(
        part for part in (selected["scope_path"], str(selected["line_start"])) if part
    )


def _operation(value: str) -> str:
    normalized = re.sub(r"\s+", "_", value.strip().upper())
    return {
        "INSERT_INTO": "INSERT",
        "DELETE_FROM": "DELETE",
        "MERGE_INTO": "MERGE",
        "FROM": "SELECT",
        "JOIN": "SELECT",
        "BATCHUPDATE": "BATCH_WRITE",
        "BATCHINSERT": "BATCH_WRITE",
        "SELECTONE": "SELECT",
        "COUNT": "SELECT",
        "SELECT": "SELECT",
    }.get(normalized, normalized)


def _data_accesses(content: str, facts: list[dict]) -> list[dict]:
    accesses = []
    seen = set()
    lines = content.splitlines()
    for pattern, access_kind, confidence in (
        (SQL_ACCESS, "DIRECT_SQL", "HIGH"),
        (API_ACCESS, "PLATFORM_API", "MEDIUM"),
    ):
        for match in pattern.finditer(content):
            table_name = match.group("table").strip("`\"[]")
            operation = _operation(match.group("operation"))
            line_no = content.count("\n", 0, match.start()) + 1
            identity = (table_name.upper(), operation, line_no)
            if identity in seen:
                continue
            seen.add(identity)
            line = lines[line_no - 1].strip() if lines else match.group(0)
            accesses.append(
                {
                    "table_name": table_name,
                    "operation": operation,
                    "line_no": line_no,
                    "scope_path": _scope_for_line(facts, line_no),
                    "access_kind": access_kind,
                    "confidence": confidence,
                    "detail": line,
                }
            )
    bindings = {}
    for line_no, line in enumerate(lines, 1):
        for binding in STRING_BINDING.finditer(line):
            bindings[binding.group("variable")] = binding.group("value")
        for match in API_VARIABLE_ACCESS.finditer(line):
            table_name = bindings.get(match.group("variable"))
            if not table_name:
                continue
            operation = _operation(match.group("operation"))
            identity = (table_name.upper(), operation, line_no)
            if identity in seen:
                continue
            seen.add(identity)
            accesses.append(
                {
                    "table_name": table_name,
                    "operation": operation,
                    "line_no": line_no,
                    "scope_path": _scope_for_line(facts, line_no),
                    "access_kind": "PLATFORM_API_BINDING",
                    "confidence": "MEDIUM",
                    "detail": line.strip(),
                }
            )
    return accesses


def _insert_data_accesses(
    conn,
    source_record_id: int,
    fragment_id: int,
    content: str,
    facts: list[dict],
    label: str,
) -> None:
    for access in _data_accesses(content, facts):
        raw_detail = str(access["detail"] or "").strip()
        detail, detail_hash, detail_truncated = _bounded_text(raw_detail, MAX_DETAIL_CHARS)
        stored_detail = detail if len(raw_detail) > MAX_EVIDENCE_CHARS else ""
        cursor = conn.execute(
            """
            INSERT INTO gusen_data_access(
                source_record_id, source_fragment_id, table_name, operation, key_fields,
                line_no, scope_path, access_kind, confidence, evidence,
                detail_text, detail_hash, detail_truncated
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                source_record_id,
                fragment_id,
                access["table_name"],
                access["operation"],
                "",
                access["line_no"],
                access["scope_path"],
                access["access_kind"],
                access["confidence"],
                detail[:MAX_EVIDENCE_CHARS],
                stored_detail,
                detail_hash,
                detail_truncated,
            ),
        )


def _page_scalar_relations(value: dict) -> list[tuple[str, str, str]]:
    relations = []
    for key, child in value.items():
        if isinstance(child, (str, int, float, bool)) and RELEVANT_PAGE_KEY.search(str(key)):
            lowered = str(key).lower()
            relation = (
                "MAPS_TABLE" if "table" in lowered
                else "USES_QUERY" if "query" in lowered or "datasource" in lowered
                else "CALLS_COMPONENT" if "service" in lowered or "component" in lowered
                else "BINDS_FIELD" if "field" in lowered or "column" in lowered
                else "MAPS_TO"
            )
            relations.append((relation, str(key), str(child)))
    return relations


def _walk_page_nodes(value, parts=None):
    parts = parts or []
    if isinstance(value, dict):
        for key, child in value.items():
            child_parts = [*parts, key]
            if key == "fields" and isinstance(child, list):
                for index, field in enumerate(child):
                    if isinstance(field, dict):
                        yield "page-field", [*child_parts, index], field
            elif MAPPING_CONTAINER_KEY.search(str(key)) and isinstance(child, (dict, list)):
                nodes = child if isinstance(child, list) else [child]
                for index, node in enumerate(nodes):
                    if isinstance(node, dict):
                        yield "page-mapping", [*child_parts, *([index] if isinstance(child, list) else [])], node
            yield from _walk_page_nodes(child, child_parts)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _walk_page_nodes(child, [*parts, index])


def _insert_page_metadata(conn, source_record_id: int, page_data: dict, fragments: dict[str, int]) -> None:
    for fragment_type, parts, node in _walk_page_nodes(page_data):
        pointer = _json_pointer(parts)
        label = str(
            node.get("label") or node.get("name") or node.get("aliasName")
            or node.get("fieldId") or node.get("id") or pointer
        )
        relations = _page_scalar_relations(node)
        if fragment_type == "page-field":
            table = str(node.get("tableId") or node.get("tbId") or node.get("table") or "").strip()
            column = str(node.get("columnId") or node.get("fdId") or node.get("column") or "").strip()
            target = ".".join(part for part in (table, column) if part)
            field_id = str(node.get("fieldId") or node.get("id") or label).strip()
            relations = [("BINDS_FIELD", field_id, target)] if target else []
        elif relations:
            relations = relations[:8]
        else:
            relations = [("MAPS_TO", label, pointer)]
        for relation_type, source_key, target_key in relations:
            conn.execute(
                """
                INSERT INTO gusen_page_relation(
                    source_record_id, source_fragment_id, relation_type,
                    source_key, target_key, json_pointer, confidence
                ) VALUES(?,?,?,?,?,?,?)
                """,
                (source_record_id, None, relation_type, source_key, target_key, pointer, "HIGH"),
            )
    for pointer, fragment_id in list(fragments.items()):
        if not pointer:
            continue
        try:
            parent = _pointer_value(page_data, "/".join(pointer.split("/")[:-1]))
        except (KeyError, IndexError, TypeError, ValueError):
            continue
        if not isinstance(parent, dict):
            continue
        for relation_type, source_key, target_key in _page_scalar_relations(parent):
            conn.execute(
                """
                INSERT INTO gusen_page_relation(
                    source_record_id, source_fragment_id, relation_type,
                    source_key, target_key, json_pointer, confidence
                ) VALUES(?,?,?,?,?,?,?)
                """,
                (source_record_id, fragment_id, relation_type, source_key, target_key, pointer, "MEDIUM"),
            )


def _bill_type_rows(value, inherited_data_source=""):
    if isinstance(value, dict):
        data_source_id = str(value.get("dataSourceId") or inherited_data_source or "")
        if value.get("billTypeCode") and value.get("tableId"):
            yield data_source_id, value
        for child in value.values():
            yield from _bill_type_rows(child, data_source_id)
    elif isinstance(value, list):
        for child in value:
            yield from _bill_type_rows(child, inherited_data_source)


def _insert_bill_routes(conn, source_record_id: int, value) -> None:
    for data_source_id, row in _bill_type_rows(value):
        table_name = str(row.get("tableId") or "").strip()
        bill_type_code = str(row.get("billTypeCode") or "").strip()
        if not table_name or not bill_type_code:
            continue
        primary_keys = row.get("tablePkids") or ""
        if isinstance(primary_keys, list):
            primary_keys = ",".join(str(item) for item in primary_keys)
        conn.execute(
            """
            INSERT OR REPLACE INTO gusen_bill_route(
                source_record_id, data_source_id, bill_type_code, bill_type_name,
                table_name, primary_keys
            ) VALUES(?,?,?,?,?,?)
            """,
            (
                source_record_id,
                data_source_id,
                bill_type_code,
                str(row.get("billTypeName") or ""),
                table_name,
                str(primary_keys),
            ),
        )


def replace_workspace_bill_routes(conn, values: list[object]) -> int:
    """Replace DATABASE-exported bill routes that do not have a source record."""

    conn.execute("DELETE FROM gusen_bill_route WHERE source_record_id=0")
    for value in values:
        _insert_bill_routes(conn, 0, value)
    return int(
        conn.execute("SELECT COUNT(*) FROM gusen_bill_route WHERE source_record_id=0").fetchone()[0]
    )


def index_source_details(
    conn,
    source_record_id: int,
    source: dict,
    scripts: list[dict],
    *,
    page_data: dict | None = None,
    public_data=None,
) -> dict:
    """Replace one source object's derived fragments and facts."""

    clear_source_details(conn, source_record_id)
    fragments: dict[str, int] = {}
    for script in scripts:
        fragment_id = _insert_fragment(conn, source_record_id, script)
        pointer = str(script.get("json_path") or "")
        fragments[pointer] = fragment_id
        label = str(script.get("label") or pointer or source.get("source_name") or source.get("source_id") or "")
        content = str(script.get("content") or "")
        if str(script.get("script_type") or "").lower() == "fields":
            continue
        facts = _insert_logic_facts(conn, source_record_id, fragment_id, content, label)
        _insert_data_accesses(conn, source_record_id, fragment_id, content, facts, label)
    if page_data:
        _insert_page_metadata(conn, source_record_id, page_data, fragments)
    if public_data is not None:
        _insert_bill_routes(conn, source_record_id, public_data)
    return {"fragments": fragments}


def _fact_rows(conn, product_id: str, *, source_id: str = "", keyword: str = "", limit: int, offset: int):
    clauses = ["s.product_id=?"]
    params: list[object] = [product_id]
    if source_id:
        clauses.append("s.source_id=?")
        params.append(source_id)
    where = " AND ".join(clauses)
    keyword_filter = ""
    if keyword:
        keyword_filter = "AND (subject LIKE ? OR value_text LIKE ? OR evidence LIKE ?)"
        match = f"%{keyword}%"
        logic_params = [*params, match, match, match]
        data_filter = "AND (table_name LIKE ? OR operation LIKE ? OR evidence LIKE ?)"
        data_params = [*params, match, match, match]
        relation_filter = "AND (source_key LIKE ? OR target_key LIKE ?)"
        relation_params = [*params, match, match]
    else:
        logic_params = data_params = relation_params = params
        data_filter = relation_filter = ""
    return conn.execute(
        f"""
        SELECT 'logic' fact_type, l.fact_id fact_id
        FROM gusen_logic_fact l JOIN gusen_source_record s ON s.record_id=l.source_record_id
        WHERE {where} {keyword_filter}
        UNION ALL
        SELECT 'data', d.access_id
        FROM gusen_data_access d JOIN gusen_source_record s ON s.record_id=d.source_record_id
        WHERE {where} {data_filter}
        UNION ALL
        SELECT 'relation', r.relation_id
        FROM gusen_page_relation r JOIN gusen_source_record s ON s.record_id=r.source_record_id
        WHERE {where} {relation_filter}
        LIMIT ? OFFSET ?
        """,
        (*logic_params, *data_params, *relation_params, limit, offset),
    ).fetchall()


def _fact_payload(conn, fact_type: str, fact_id: int):
    tables = {
        "logic": ("gusen_logic_fact", "fact_id"),
        "data": ("gusen_data_access", "access_id"),
        "relation": ("gusen_page_relation", "relation_id"),
        "fragment": ("gusen_source_fragment", "fragment_id"),
    }
    table = tables.get(fact_type)
    if table is None:
        return None
    return conn.execute(f"SELECT * FROM {table[0]} WHERE {table[1]}=?", (fact_id,)).fetchone()


def _compact_logic_fact(value) -> dict:
    return {
        "kind": value["fact_kind"],
        "subject": value["subject"],
        "value": str(value["value_text"] or value["evidence"] or "")[:MAX_EVIDENCE_CHARS],
        "scope": value["scope_path"],
        "lines": [value["line_start"], value["line_end"]],
        "confidence": value["confidence"],
    }


def _source_locator(conn, source_record_id: int, source_fragment_id: int | None = None) -> dict:
    row = conn.execute(
        """
        SELECT source_table, source_id, source_alias_id, fun_id, source_name,
               source_path, provider, system_id, data_source_id, status
        FROM gusen_source_record WHERE record_id=?
        """,
        (source_record_id,),
    ).fetchone()
    locator = {
        key: row[key]
        for key in (
            "source_table", "source_id", "source_alias_id", "fun_id", "source_name",
            "source_path", "system_id", "data_source_id",
        )
        if row and row[key] not in (None, "")
    }
    if source_fragment_id:
        fragment = conn.execute(
            """
            SELECT fragment_type, json_pointer, label, language, coordinate_kind, line_count
            FROM gusen_source_fragment WHERE fragment_id=?
            """,
            (source_fragment_id,),
        ).fetchone()
        if fragment:
            locator["fragment"] = {
                key: fragment[key]
                for key in ("fragment_type", "json_pointer", "label")
                if fragment[key] not in (None, "")
            }
    return locator


def query_facts(
    conn,
    product_id: str,
    *,
    keyword: str = "",
    table_name: str = "",
    source_id: str = "",
    limit: int = 3,
    offset: int = 0,
) -> dict:
    limit = max(1, min(int(limit), 50))
    offset = max(0, int(offset))
    matches = []
    normalized_keyword = str(keyword or "").strip()
    if table_name:
        rows = conn.execute(
            """
            SELECT 'data' AS fact_type, d.access_id AS fact_id
            FROM gusen_data_access d
            JOIN gusen_source_record s ON s.record_id=d.source_record_id
            WHERE s.product_id=? AND UPPER(d.table_name)=UPPER(?)
            ORDER BY d.operation, s.source_alias_id, s.fun_id, d.line_no
            LIMIT ? OFFSET ?
            """,
            (product_id, table_name, limit + 1, offset),
        ).fetchall()
    elif source_id:
        rows = _fact_rows(conn, product_id, source_id=source_id, limit=limit + 1, offset=offset)
    elif normalized_keyword:
        rows = _fact_rows(conn, product_id, keyword=normalized_keyword, limit=limit + 1, offset=offset)
    else:
        raise ValueError("facts query requires keyword, table_name, or source_id")
    truncated = len(rows) > limit
    for row in rows[:limit]:
        payload = _fact_payload(conn, row["fact_type"], int(row["fact_id"]))
        if payload:
            value = dict(payload)
            source = _source_locator(
                conn,
                int(value["source_record_id"]),
                value.get("source_fragment_id"),
            )
            if row["fact_type"] == "logic":
                compact = _compact_logic_fact(value)
            elif row["fact_type"] == "data":
                compact = {
                    key: value[key]
                    for key in (
                        "table_name", "operation", "line_no", "scope_path",
                        "access_kind", "confidence", "evidence",
                    )
                }
            else:
                compact = {
                    key: value[key]
                    for key in (
                        "relation_type", "source_key", "target_key", "json_pointer", "confidence",
                    )
                }
            matches.append({"factType": row["fact_type"], **compact, "source": source})
    return {
        "facts": matches,
        "truncated": truncated,
        "continuationToken": str(offset + limit) if truncated else "",
    }


def _incoming_chain(conn, product_id: str, alias: str, fun_id: str, depth: int) -> list[dict]:
    chain = []
    visited = {(alias, fun_id)}
    current = [(alias, fun_id)]
    for level in range(1, max(0, min(depth, 5)) + 1):
        following = []
        for target_alias, target_fun in current:
            rows = conn.execute(
                """
                SELECT source_record_id, source_fragment_id, source_table, source_id,
                       source_alias_id, fun_id, source_name, script_type, json_path,
                       line_no, invoke_type
                FROM gusen_invoke_call_detail
                WHERE product_id=? AND target_alias_id=? AND target_fun_id=?
                ORDER BY source_table, source_alias_id, fun_id, line_no
                LIMIT 3
                """,
                (product_id, target_alias, target_fun),
            ).fetchall()
            for row in rows:
                identity = (row["source_alias_id"], row["fun_id"])
                if identity in visited:
                    continue
                visited.add(identity)
                caller = {
                    "depth": level,
                    **{
                        key: row[key]
                        for key in (
                            "source_alias_id", "fun_id", "source_name", "line_no", "invoke_type",
                        )
                    },
                }
                if row["source_fragment_id"]:
                    nearby = conn.execute(
                        """
                        SELECT fact_kind, subject, operator, value_text, scope_path,
                               line_start, line_end, confidence, evidence
                        FROM gusen_logic_fact
                        WHERE source_fragment_id=? AND fact_kind IN ('CONDITION','ASSIGNMENT','ENTRY')
                        ORDER BY CASE
                            WHEN fact_kind='CONDITION' AND line_start<=? THEN 0
                            WHEN fact_kind='ASSIGNMENT' THEN 1 ELSE 2 END,
                            ABS(line_start-?), line_start
                        LIMIT 1
                        """,
                        (row["source_fragment_id"], row["line_no"], row["line_no"]),
                    ).fetchall()
                    caller["facts"] = [_compact_logic_fact(fact) for fact in nearby]
                    locator = _source_locator(
                        conn, int(row["source_record_id"]), int(row["source_fragment_id"])
                    )
                    caller["source_path"] = locator.get("source_path") or ""
                    caller["fragment"] = locator.get("fragment") or {}
                chain.append(caller)
                following.append(identity)
                if len(chain) >= 6:
                    return chain
        current = following
        if not current:
            break
    return chain


def explain_table(
    conn,
    product_id: str,
    *,
    table_name: str = "",
    bill_type_code: str = "",
    data_source_id: str = "",
    operation: str = "WRITE",
    limit: int = 1,
    offset: int = 0,
    fact_limit: int = 4,
    caller_depth: int = 2,
    include_details: bool = False,
) -> dict:
    if not table_name and bill_type_code:
        rows = conn.execute(
            """
            SELECT table_name, primary_keys FROM gusen_bill_route
            WHERE bill_type_code=? AND (?='' OR data_source_id=?)
            ORDER BY data_source_id, table_name LIMIT 2
            """,
            (bill_type_code, data_source_id, data_source_id),
        ).fetchall()
        if len(rows) != 1:
            return {
                "tableName": "",
                "billTypeCode": bill_type_code,
                "routes": [dict(row) for row in rows],
                "chains": [],
                "ambiguousRoute": len(rows) > 1,
                "routeMissing": not rows,
            }
        table_name = rows[0]["table_name"]
    if not table_name:
        raise ValueError("explain requires table_name or an unambiguous bill_type_code")
    limit = max(1, min(int(limit), 10))
    offset = max(0, int(offset))
    fact_limit = max(1, min(int(fact_limit), 50))
    normalized_operation = str(operation or "WRITE").upper()
    operation_sql = "d.operation IN ('INSERT','UPDATE','DELETE','MERGE','BATCH_WRITE')"
    params: list[object] = [product_id, table_name]
    if normalized_operation not in {"", "WRITE", "ANY"}:
        operation_sql = "d.operation=?"
        params.append(normalized_operation)
    count = conn.execute(
        f"""
        SELECT COUNT(*)
        FROM gusen_data_access d
        JOIN gusen_source_record s ON s.record_id=d.source_record_id
        WHERE s.product_id=? AND UPPER(d.table_name)=UPPER(?) AND {operation_sql}
        """,
        tuple(params),
    ).fetchone()[0]
    rows = conn.execute(
        f"""
        SELECT d.*, s.source_table, s.source_id, s.source_alias_id, s.fun_id,
               s.source_name, s.source_path, f.fragment_type, f.json_pointer, f.label
        FROM gusen_data_access d
        JOIN gusen_source_record s ON s.record_id=d.source_record_id
        JOIN gusen_source_fragment f ON f.fragment_id=d.source_fragment_id
        WHERE s.product_id=? AND UPPER(d.table_name)=UPPER(?) AND {operation_sql}
        ORDER BY CASE d.confidence WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
                 s.source_table, s.source_alias_id, s.fun_id, d.line_no
        LIMIT ? OFFSET ?
        """,
        (*params, limit, offset),
    ).fetchall()
    chains = []
    for row in rows:
        total_facts = int(
            conn.execute(
                "SELECT COUNT(*) FROM gusen_logic_fact WHERE source_fragment_id=?",
                (row["source_fragment_id"],),
            ).fetchone()[0]
        )
        facts = conn.execute(
            """
            SELECT fact_kind, subject, operator, value_text, scope_path, line_start, line_end,
                   confidence, evidence, detail_text, detail_truncated
            FROM gusen_logic_fact
            WHERE source_fragment_id=?
            ORDER BY CASE
                WHEN fact_kind='CONDITION' AND instr('/' || ? || '/', '/' || line_start || '/')>0 THEN 0
                WHEN fact_kind='ASSIGNMENT' THEN 1 WHEN fact_kind='CONDITION' THEN 2
                WHEN fact_kind='ERROR' THEN 3 WHEN fact_kind='ENTRY' THEN 4 ELSE 5 END,
                ABS(line_start-?), line_start
            LIMIT ?
            """,
            (row["source_fragment_id"], row["scope_path"], row["line_no"], fact_limit + 1),
        ).fetchall()
        fact_payload = []
        for fact in facts[:fact_limit]:
            value = _compact_logic_fact(fact)
            if not include_details:
                pass
            elif fact["detail_text"]:
                value["detail"] = fact["detail_text"]
            fact_payload.append(value)
        chains.append(
            {
                "source": {
                    key: row[key]
                    for key in (
                        "source_table", "source_id", "source_alias_id", "fun_id",
                        "source_name", "source_path", "fragment_type", "json_pointer", "label",
                    )
                },
                "access": {
                    key: row[key]
                    for key in (
                        "table_name", "operation", "line_no", "scope_path",
                        "access_kind", "confidence", "evidence", "detail_truncated",
                    )
                },
                "facts": fact_payload,
                "totalFacts": total_facts,
                "omittedFacts": max(0, total_facts - len(fact_payload)),
                "factsTruncated": total_facts > len(fact_payload),
                "callers": _incoming_chain(
                    conn,
                    product_id,
                    row["source_alias_id"],
                    row["fun_id"],
                    caller_depth,
                ),
            }
        )
    return {
        "tableName": table_name,
        "billTypeCode": bill_type_code,
        "operation": normalized_operation,
        "chains": chains,
        "totalChains": int(count),
        "omittedChains": max(0, int(count) - offset - len(chains)),
        "truncated": offset + len(chains) < int(count),
        "continuationToken": str(offset + len(chains)) if offset + len(chains) < int(count) else "",
        "runtimeTraceVerified": False,
    }

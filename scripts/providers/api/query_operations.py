"""Current-file batch reads sharing one response budget, without edit leases."""
from contextlib import closing
from . import index
from .client import ApiError


def read_batch(workspace, payload):
    objects = payload.get("objects")
    budget = payload.get("maxChars", 24000)
    if not isinstance(objects, list) or not 1 <= len(objects) <= 20:
        raise ApiError("API_INPUT_INVALID", "批量读取需要1至20个明确对象")
    if type(budget) is not int or not 1 <= budget <= 50000:
        raise ApiError("API_INPUT_INVALID", "批量读取总正文预算必须在1至50000之间")
    for target in objects:
        if (not isinstance(target, dict) or set(target) - {"path", "jsonPointer", "offset", "expectedHash"}
                or not isinstance(target.get("path"), str) or not target["path"]
                or type(target.get("offset", 0)) is not int or target.get("offset", 0) < 0
                or not isinstance(target.get("jsonPointer", ""), str)
                or not isinstance(target.get("expectedHash", ""), str)):
            raise ApiError("API_INPUT_INVALID", "批量对象路径、偏移或哈希无效")
    remaining, results = budget, []
    for target in objects:
        if remaining == 0:
            results.append({**target, "complete": False, "truncated": True,
                            "nextOffset": target.get("offset", 0), "content": "", "budgetExhausted": True})
            continue
        try:
            if target.get("jsonPointer"):
                item = index.read_page_item(workspace, target["path"], target["jsonPointer"],
                                            target.get("offset", 0), remaining)
            else:
                item = index.read_source(workspace, target["path"], target.get("offset", 0), remaining)
            if target.get("expectedHash") and item["sourceHash"] != target["expectedHash"]:
                raise ApiError("API_SOURCE_STALE", "源码已变化，请重新读取同一哈希快照")
            remaining -= len(item["content"])
            results.append(item)
        except (ApiError, ValueError, OSError) as error:
            results.append({**target, "complete": False, "truncated": False,
                            "error": {"code": getattr(error, "code", "SOURCE_UNAVAILABLE"), "message": str(error)}})
    return {"workspaceKey": workspace["workspaceKey"], "objects": results,
            "complete": all(item.get("complete", not item.get("truncated")) and not item.get("error") for item in results),
            "truncated": any(item.get("truncated") for item in results), "maxChars": budget,
            "returnedChars": budget - remaining, "coverage": "CURRENT_LOCAL_FILES",
            "warnings": ["各对象独立读取；跨对象非原子快照，后续分段须核对各自 sourceHash。"]}


def table_references(workspace, table_name, column_name="", limit=20, offset=0, graph=False):
    """Keep indexed table access and explicit PAGE column mapping evidence distinct."""
    index._bound(limit, offset)
    if (not isinstance(table_name, str) or not 1 <= len(table_name.strip()) <= 128
            or not isinstance(column_name, str) or len(column_name) > 128 or type(graph) is not bool):
        raise ApiError("API_INPUT_INVALID", "表名、列名或关系图参数无效")
    table_name, column_name = table_name.strip(), column_name.strip()
    identity = "s.source_path AS path,s.source_table AS sourceType,s.source_id AS sourceId,s.fun_id AS funId,s.source_hash AS sourceHash,s.system_id AS systemId,s.data_source_id AS dataSourceId"
    statements, params = [], []
    if not column_name:
        statements.append("SELECT 'TABLE_ACCESS' AS evidenceKind,a.access_id AS evidenceId," + identity +
                          ",a.operation,a.confidence,a.evidence,a.line_no AS line,'' AS jsonPointer,'' AS fieldId,'' AS columnId "
                          "FROM gusen_data_access a JOIN gusen_source_record s ON s.record_id=a.source_record_id "
                          "WHERE s.scope_id=? AND UPPER(a.table_name)=UPPER(?)")
        params.extend([workspace["workspaceKey"], table_name])
    statements.append("SELECT 'FIELD_MAPPING' AS evidenceKind,f.rowid AS evidenceId," + identity +
                      ",'MAPPING' AS operation,'EXPLICIT' AS confidence,'' AS evidence,0 AS line,f.json_pointer AS jsonPointer,f.field_id AS fieldId,f.column_id AS columnId "
                      "FROM gusen_page_field f JOIN gusen_source_record s ON s.record_id=f.source_record_id "
                      "WHERE s.scope_id=? AND UPPER(f.table_id)=UPPER(?)" + (" AND UPPER(f.column_id)=UPPER(?)" if column_name else ""))
    params.extend([workspace["workspaceKey"], table_name, *([column_name] if column_name else [])])
    with closing(index._connection(workspace)) as conn:
        rows = conn.execute("SELECT * FROM (" + " UNION ALL ".join(statements) + ") ORDER BY evidenceKind,evidenceId LIMIT ? OFFSET ?",
                            (*params, limit + 1, offset)).fetchall()
        result = index._result(workspace, conn, rows, limit, offset, "references")
    result.update(tableName=table_name, columnName=column_name, referenceCompleteness="UNKNOWN", deletionSafety="BLOCKED_UNVERIFIED")
    result["warnings"].append("列筛选只返回显式PAGE字段映射；动态引用、SQL列访问及运行行为尚未核验。")
    if graph:
        import html
        def label(value):
            return html.escape(str(value).replace("\n", " ").replace("\r", " "), quote=True)[:160]
        lines = ["flowchart LR", '  table["' + label(table_name) + '"]']
        for number, item in enumerate(result["references"]):
            lines += [f'  s{number}["{label(item["path"])}"]', f'  s{number} -->|"{label(item["operation"])}"| table']
        result["mermaid"] = "\n".join(lines)
    return result

#!/usr/bin/env python3
"""Run source-derived SELECT checks and write a Markdown diagnosis report."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
from pathlib import Path
from zoneinfo import ZoneInfo

import gusen_hub


ROOT = gusen_hub.ROOT
REPORT_ROOT = ROOT / "var" / "docs" / "业务排查文档"
CONTINUE_CONDITIONS = {"always", "rows_found", "no_rows"}
ALLOWED_FUNCTIONS = {
    "ABS",
    "AVG",
    "CAST",
    "CEIL",
    "CEILING",
    "CHAR_LENGTH",
    "COALESCE",
    "CONCAT",
    "CONCAT_WS",
    "CONVERT",
    "COUNT",
    "DATE",
    "DATABASE",
    "DATEDIFF",
    "DATE_FORMAT",
    "DAY",
    "DENSE_RANK",
    "EXISTS",
    "FIND_IN_SET",
    "FLOOR",
    "FORMAT",
    "GREATEST",
    "GROUP_CONCAT",
    "IF",
    "IFNULL",
    "IN",
    "JSON_EXTRACT",
    "JSON_UNQUOTE",
    "LEAST",
    "LEFT",
    "LENGTH",
    "LOWER",
    "LTRIM",
    "MAX",
    "MIN",
    "MOD",
    "MONTH",
    "NOW",
    "NULLIF",
    "OVER",
    "RANK",
    "REPLACE",
    "RIGHT",
    "ROUND",
    "ROW_NUMBER",
    "RTRIM",
    "STR_TO_DATE",
    "SUBSTR",
    "SUBSTRING",
    "SUM",
    "TIMESTAMPDIFF",
    "TRIM",
    "UPPER",
    "VERSION",
    "YEAR",
}
FORBIDDEN_SQL = re.compile(
    r"\b(?:INSERT|UPDATE|DELETE|REPLACE|MERGE|CREATE|ALTER|DROP|TRUNCATE|"
    r"GRANT|REVOKE|CALL|DO|SET|USE|LOAD|LOCK|UNLOCK|HANDLER|PROCEDURE|"
    r"OUTFILE|DUMPFILE|GET_LOCK|RELEASE_LOCK|SLEEP|BENCHMARK|LOAD_FILE)\b"
    r"|FOR\s+UPDATE|LOCK\s+IN\s+SHARE\s+MODE|:=",
    re.IGNORECASE,
)
FUNCTION_CALL = re.compile(r"\b([A-Za-z_][A-Za-z0-9_$]*)\s*\(", re.IGNORECASE)


def load_case(path: Path) -> dict:
    case = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(case, dict):
        raise ValueError("排查定义必须是 JSON 对象")
    return validate_case(case)


def validate_case(case: dict) -> dict:
    for field in ("name", "source_scope", "datasource", "database"):
        if not str(case.get(field) or "").strip():
            raise ValueError(f"排查定义缺少字段: {field}")
    if not isinstance(case.get("parameters", {}), dict):
        raise ValueError("parameters 必须是 JSON 对象")
    steps = case.get("steps")
    if not isinstance(steps, list) or not steps:
        raise ValueError("steps 必须是非空数组")
    parameters = case.get("parameters") or {}
    for index, step in enumerate(steps, 1):
        if not isinstance(step, dict):
            raise ValueError(f"步骤 {index} 必须是 JSON 对象")
        for field in ("id", "name", "source", "logic", "sql"):
            if not str(step.get(field) or "").strip():
                raise ValueError(f"步骤 {index} 缺少字段: {field}")
        condition = step.get("continue_when", "always")
        if condition not in CONTINUE_CONDITIONS:
            raise ValueError(f"步骤 {index} 的 continue_when 无效: {condition}")
        if "database" in step and not str(step["database"] or "").strip():
            raise ValueError(f"步骤 {index} 的 database 不能为空")
        bindings = step.get("bindings", [])
        if not isinstance(bindings, list):
            raise ValueError(f"步骤 {index} 的 bindings 必须是数组")
        missing = [name for name in bindings if name not in parameters]
        if missing:
            raise ValueError(f"步骤 {index} 引用了未定义参数: {', '.join(missing)}")
        validate_single_select(step["sql"])
    max_rows = int(case.get("max_rows", 200))
    if not 1 <= max_rows <= 5000:
        raise ValueError("max_rows 必须在 1 到 5000 之间")
    case["max_rows"] = max_rows
    return case


def validate_single_select(sql: str) -> str:
    candidate = str(sql or "").strip()
    if candidate.endswith(";"):
        candidate = candidate[:-1].rstrip()
    if not candidate:
        raise ValueError("SQL 不能为空")
    if not re.match(r"^SELECT\b", candidate, re.IGNORECASE):
        raise ValueError("只允许单条 SELECT 查询")
    if ";" in candidate:
        raise ValueError("不允许多条 SQL")
    if "--" in candidate or "/*" in candidate or "#" in candidate:
        raise ValueError("SQL 中不允许注释")
    if "`" in candidate or '"' in candidate:
        raise ValueError("SQL 中不允许引用标识符")
    if "@" in candidate:
        raise ValueError("SQL 中不允许用户变量")
    if re.search(r"\.\s*[A-Za-z_][A-Za-z0-9_$]*\s*\(", candidate):
        raise ValueError("SQL 中不允许调用数据库自定义函数")
    match = FORBIDDEN_SQL.search(candidate)
    if match:
        raise ValueError(f"SQL 包含禁止操作: {match.group(0)}")
    functions = {match.group(1).upper() for match in FUNCTION_CALL.finditer(candidate)}
    unknown = sorted(functions - ALLOWED_FUNCTIONS)
    if unknown:
        raise ValueError(f"SQL 包含未允许的函数: {', '.join(unknown)}")
    return candidate


def validate_datasource(name: str, datasource: dict) -> None:
    diagnosis = datasource.get("diagnosis") or {}
    if datasource.get("environment") != "test":
        raise ValueError(f"数据源 {name} 不是 test 环境")
    if diagnosis.get("enabled") is not True:
        raise ValueError(f"数据源 {name} 未启用 diagnosis")
    if diagnosis.get("query_only") is not True:
        raise ValueError(f"数据源 {name} 未声明 query_only")
    databases = datasource.get("databases")
    if not isinstance(databases, list) or not databases:
        raise ValueError(f"数据源 {name} 未配置 databases")
    invalid = [database for database in databases if not isinstance(database, str) or not re.fullmatch(r"[A-Za-z0-9_]+", database)]
    if invalid:
        raise ValueError(f"数据源 {name} 包含无效数据库名: {', '.join(map(str, invalid))}")
    if len(set(databases)) != len(databases):
        raise ValueError(f"数据源 {name} 的 databases 存在重复项")


def execute_case(case: dict, datasource: dict, connect=gusen_hub.db_connect) -> dict:
    started = now()
    results = []
    stopped_at = ""
    conclusion = case.get("success_conclusion") or "全部数据库检查点均满足源码继续执行条件"
    for step in case["steps"]:
        result = execute_database_step(case, step, datasource, connect)
        results.append(result)
        if result["status"] != "PASS":
            stopped_at = str(step["id"])
            conclusion = result["conclusion"]
            break
    return {
        "started": started,
        "finished": now(),
        "results": results,
        "stopped_at": stopped_at,
        "conclusion": conclusion,
    }


def execute_database_step(case: dict, step: dict, datasource: dict, connect) -> dict:
    database = str(step.get("database") or case["database"])
    connection = None
    try:
        if database not in datasource["databases"]:
            raise ValueError(f"数据库 {database} 不在数据源允许列表中")
        selected = dict(datasource)
        selected["database"] = database
        connection = connect(selected)
        connection.autocommit(False)
        with connection.cursor() as cursor:
            cursor.execute("START TRANSACTION READ ONLY")
            result = execute_step(cursor, step, case.get("parameters") or {}, case["max_rows"])
    except Exception as error:
        result = {
            "step": step,
            "status": "ERROR",
            "sql": "",
            "rows": [],
            "row_count": 0,
            "truncated": False,
            "conclusion": f"执行异常: {error}",
        }
    finally:
        if connection is not None:
            try:
                connection.rollback()
            finally:
                connection.close()
    result["database"] = database
    return result


def execute_step(cursor, step: dict, parameters: dict, max_rows: int) -> dict:
    sql = validate_single_select(step["sql"])
    values = tuple(parameters[name] for name in step.get("bindings", []))
    rendered = cursor.mogrify(sql, values)
    if isinstance(rendered, bytes):
        rendered = rendered.decode("utf-8", errors="replace")
    try:
        cursor.execute(sql, values)
    except Exception as error:
        return {
            "step": step,
            "status": "ERROR",
            "sql": str(rendered),
            "rows": [],
            "row_count": 0,
            "truncated": False,
            "conclusion": f"执行异常: {error}",
        }
    row_count = max(0, int(cursor.rowcount))
    rows = list(cursor.fetchmany(max_rows + 1))
    truncated = len(rows) > max_rows
    rows = rows[:max_rows]
    condition = step.get("continue_when", "always")
    passed = condition == "always" or (condition == "rows_found" and row_count > 0) or (condition == "no_rows" and row_count == 0)
    if passed:
        conclusion = step.get("pass_conclusion") or "满足继续条件"
    else:
        conclusion = step.get("stop_conclusion") or "不满足源码继续执行条件"
    return {
        "step": step,
        "status": "PASS" if passed else "STOP",
        "sql": str(rendered),
        "rows": rows,
        "row_count": row_count,
        "truncated": truncated,
        "conclusion": conclusion,
    }


def render_report(case: dict, run: dict, datasource_name: str) -> str:
    lines = [
        f"# {case['name']}排查报告",
        "",
        "## 一、排查对象",
        "",
        f"- 执行开始：{run['started']}",
        f"- 执行结束：{run['finished']}",
        f"- 源码范围：`{case['source_scope']}`",
        f"- 测试数据源：`{datasource_name}`",
        f"- 默认数据库：`{case['database']}`",
        f"- 最大展示行数：{case['max_rows']}",
        "",
        "### 源码证据",
        "",
    ]
    source_files = case.get("source_files") or []
    if source_files:
        lines.extend(source_evidence(source_files))
    else:
        lines.append("- 未登记源码文件；各步骤仍保留源码位置。")
    lines.extend(["", "## 二、排查参数", "", markdown_mapping(case.get("parameters") or {}), "", "## 三、源码逻辑链", ""])
    lines.extend(
        [
            "| 步骤 | 数据库 | 源码位置 | 逻辑 | 继续条件 |",
            "|---|---|---|---|---|",
        ]
    )
    for step in case["steps"]:
        lines.append(
            f"| {md(step['id'])} {md(step['name'])} | `{md(step.get('database') or case['database'])}` | {md(step['source'])} | "
            f"{md(step['logic'])} | `{md(step.get('continue_when', 'always'))}` |"
        )
    lines.extend(["", "## 四、逐步执行结果", ""])
    for result in run["results"]:
        step = result["step"]
        lines.extend(
            [
                f"### 步骤 {step['id']}：{step['name']}",
                "",
                f"- 源码位置：{step['source']}",
                f"- 源码逻辑：{step['logic']}",
                f"- 查询数据库：`{result['database']}`",
                f"- 状态：**{result['status']}**",
                f"- 查询行数：{result['row_count']}",
                f"- 判断：{result['conclusion']}",
                "",
            ]
        )
        if result["sql"]:
            lines.extend(["#### 原生可直接执行 SQL", "", "```sql", result["sql"].rstrip(";") + ";", "```", ""])
        lines.extend(["#### 查询结果", ""])
        if result["rows"]:
            lines.append(markdown_rows(result["rows"]))
            if result["truncated"]:
                lines.extend(["", f"> 结果超过 {case['max_rows']} 行，报告仅展示前 {case['max_rows']} 行。"])
        else:
            lines.append("_无查询结果。_")
        lines.append("")
    stopped = run["stopped_at"] or "未停止，全部步骤执行完成"
    lines.extend(
        [
            "## 五、停止位置",
            "",
            f"- {stopped}",
            "",
            "## 六、结论",
            "",
            run["conclusion"],
            "",
            "## 七、证据边界",
            "",
            "- 本报告只证明测试数据库中的可查询状态。",
            "- 内存计算、缓存、远程调用、页面状态和未落库事务需要使用对应运行时证据继续确认。",
            "",
        ]
    )
    return "\n".join(lines)


def source_evidence(source_files: list) -> list[str]:
    lines = ["| 文件 | 函数 | SHA-256 |", "|---|---|---|"]
    for item in source_files:
        raw_path = str(item.get("path") or "")
        path = (ROOT / raw_path).resolve()
        digest = "文件不存在或不在工作区"
        if path.is_relative_to(ROOT) and path.is_file():
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
        lines.append(f"| {md(raw_path)} | {md(item.get('function', ''))} | `{md(digest)}` |")
    return lines


def markdown_mapping(values: dict) -> str:
    rows = [{"参数": key, "值": value} for key, value in values.items()]
    return markdown_rows(rows) if rows else "_无排查参数。_"


def markdown_rows(rows: list[dict]) -> str:
    columns = list(rows[0])
    lines = [
        "| " + " | ".join(md(column) for column in columns) + " |",
        "|" + "|".join("---" for _ in columns) + "|",
    ]
    for row in rows:
        lines.append("| " + " | ".join(md(row.get(column)) for column in columns) + " |")
    return "\n".join(lines)


def md(value) -> str:
    if value is None:
        return "NULL"
    return str(value).replace("\\", "\\\\").replace("|", "\\|").replace("\r", "").replace("\n", "<br>")


def now() -> str:
    return dt.datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S")


def report_path(case: dict, requested: str = "") -> Path:
    if requested:
        return Path(requested).expanduser().resolve()
    current = dt.datetime.now(ZoneInfo("Asia/Shanghai"))
    safe_name = re.sub(r'[\\/:*?"<>|\s]+', "_", case["name"]).strip("_") or "source_diagnosis"
    return REPORT_ROOT / current.strftime("%Y%m%d") / f"{safe_name}_{current.strftime('%Y%m%d_%H%M%S')}.md"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case", help="排查定义 JSON 文件")
    parser.add_argument("--output", help="报告输出路径；默认写入 var/docs/业务排查文档/<日期>/")
    args = parser.parse_args(argv)

    case = load_case(Path(args.case))
    config = gusen_hub.load_config()
    datasource_name, datasource = gusen_hub.resolve_datasource(config, case["datasource"])
    validate_datasource(datasource_name, datasource)
    run = execute_case(case, datasource)
    target = report_path(case, args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(render_report(case, run, datasource_name), encoding="utf-8")

    status = "STOP" if run["stopped_at"] else "PASS"
    print(f"status={status}")
    print(f"step={run['stopped_at'] or 'ALL'}")
    print(f"conclusion={run['conclusion']}")
    print(f"report={target}")
    return 1 if run["stopped_at"] else 0


if __name__ == "__main__":
    raise SystemExit(main())

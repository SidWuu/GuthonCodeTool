"""Conservative SELECT validation shared by diagnosis and formal artifacts.

String literals are masked before checking operators and identifiers. This is
not a general SQL parser: quoted identifiers, comments, table functions and
ambiguous backslash escaping are deliberately unsupported.
"""

from __future__ import annotations

import re


TOKEN = re.compile(r"[A-Za-z_][A-Za-z0-9_$]*|::|[().,;]|\S")
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")
SAFE_TYPES = {"CHAR", "VARCHAR", "VARCHAR2", "TEXT", "INTEGER", "INT", "BIGINT", "SMALLINT", "DECIMAL", "NUMERIC", "NUMBER", "FLOAT", "DOUBLE", "REAL", "BOOLEAN", "DATE", "DATETIME", "TIME", "TIMESTAMP", "SIGNED", "UNSIGNED", "BINARY"}
ALLOWED_FUNCTIONS = set("ABS AVG CAST CEIL CEILING CHAR_LENGTH COALESCE CONCAT CONCAT_WS CONVERT COUNT DATE DATABASE DATEDIFF DATE_FORMAT DAY DENSE_RANK EXISTS FIND_IN_SET FLOOR FORMAT GREATEST GROUP_CONCAT IF IFNULL IN JSON_EXTRACT JSON_UNQUOTE LEAST LEFT LENGTH LOWER LTRIM MAX MIN MOD MONTH NOW NULLIF OVER RANK REPLACE RIGHT ROUND ROW_NUMBER RTRIM STR_TO_DATE SUBSTR SUBSTRING SUM TIMESTAMPDIFF TRIM UPPER VERSION YEAR DECODE LPAD NVL NVL2 RPAD TO_CHAR TO_DATE TO_NUMBER TRUNC CURRENT_DATABASE CURRENT_SCHEMA".split())
COMMON_FUNCTIONS = set("ABS AVG CAST CEIL COALESCE CONCAT COUNT DENSE_RANK EXISTS FLOOR GREATEST IN LEAST LENGTH LOWER LTRIM MAX MIN MOD NULLIF OVER RANK REPLACE ROUND ROW_NUMBER RTRIM SUBSTR SUM TRIM UPPER LPAD RPAD".split())
ENGINE_FUNCTIONS = {
    "mysql": ALLOWED_FUNCTIONS - set("DECODE NVL NVL2 TO_CHAR TO_DATE TO_NUMBER TRUNC CURRENT_DATABASE CURRENT_SCHEMA".split()),
    "postgresql": COMMON_FUNCTIONS | set("CEILING CHAR_LENGTH CONCAT_WS CONVERT DATE LEFT NOW RIGHT SUBSTRING TO_CHAR TO_DATE TO_NUMBER TRUNC VERSION CURRENT_DATABASE CURRENT_SCHEMA".split()),
    "oracle": COMMON_FUNCTIONS | set("DECODE NVL NVL2 TO_CHAR TO_DATE TO_NUMBER TRUNC".split()),
}
ENGINE_TYPES = {
    "mysql": set("CHAR DECIMAL DATE TIME DATETIME SIGNED UNSIGNED BINARY FLOAT DOUBLE REAL".split()),
    "postgresql": set("CHAR VARCHAR TEXT INTEGER INT BIGINT SMALLINT DECIMAL NUMERIC FLOAT DOUBLE REAL BOOLEAN DATE TIME TIMESTAMP".split()),
    "oracle": set("CHAR VARCHAR VARCHAR2 NUMBER INTEGER INT DECIMAL NUMERIC FLOAT DATE TIMESTAMP".split()),
}
FORBIDDEN = re.compile(r"\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|DO|SET|USE|LOAD|LOCK|UNLOCK|HANDLER|PROCEDURE|INTO|OUTFILE|DUMPFILE|GET_LOCK|RELEASE_LOCK|SLEEP|BENCHMARK|LOAD_FILE|NEXTVAL|NEXT)\b|FOR\s+UPDATE|LOCK\s+IN\s+SHARE\s+MODE|:=", re.I)


def mask_literals(sql: str) -> str:
    chars = list(sql)
    i = 0
    while i < len(sql):
        if sql[i] != "'":
            i += 1
            continue
        start = i
        if i > 0 and sql[i - 1].lower() == "q" and (i < 2 or not (sql[i - 2].isalnum() or sql[i - 2] == "_")):
            raise ValueError("不支持 Oracle 替代引号，请使用普通字符串或绑定参数")
        i += 1
        while i < len(sql):
            if sql[i] == "\\":
                raise ValueError("字符串中不支持反斜线转义，请使用参数绑定或双单引号")
            if sql[i] == "'":
                if i + 1 < len(sql) and sql[i + 1] == "'":
                    i += 2
                    continue
                i += 1
                chars[start:i] = " " * (i - start)
                break
            i += 1
        else:
            raise ValueError("SQL 字符串未闭合")
    return "".join(chars)


def _tokens(sql: str) -> list[str]:
    return [m.group() for m in TOKEN.finditer(mask_literals(sql))]


def _cte_declarations(tokens: list[str]) -> tuple[dict[str, int], set[int]]:
    names, declarations = {}, set()
    if not tokens or tokens[0].upper() != "WITH":
        return names, declarations
    i = 2 if len(tokens) > 1 and tokens[1].upper() == "RECURSIVE" else 1
    while i < len(tokens):
        if not IDENTIFIER.fullmatch(tokens[i]):
            raise ValueError("CTE 名称无效")
        name = tokens[i].lower()
        if name in names:
            raise ValueError("CTE 名称重复")
        declarations.add(i)
        i += 1
        if i < len(tokens) and tokens[i] == "(":
            i += 1
            while i < len(tokens) and tokens[i] != ")":
                if not IDENTIFIER.fullmatch(tokens[i]) and tokens[i] != ",":
                    raise ValueError("CTE 列声明无效")
                i += 1
            i += 1
        if i + 2 >= len(tokens) or tokens[i].upper() != "AS" or tokens[i + 1] != "(" or tokens[i + 2].upper() != "SELECT":
            raise ValueError("CTE 仅支持 AS (SELECT ...) 子查询")
        declarations.add(i)
        i += 2
        depth = 1
        while i < len(tokens) and depth:
            depth += (tokens[i] == "(") - (tokens[i] == ")")
            i += 1
        if depth:
            raise ValueError("CTE 括号未闭合")
        names[name] = i
        if i < len(tokens) and tokens[i] == ",":
            i += 1
            continue
        if i >= len(tokens) or tokens[i].upper() != "SELECT":
            raise ValueError("CTE 主语句必须是 SELECT")
        return names, declarations
    raise ValueError("CTE 缺少主 SELECT")


def validate_single_select(sql: str, engine: str = "") -> str:
    candidate = str(sql or "").strip()
    if candidate.endswith(";"):
        candidate = candidate[:-1].rstrip()
    masked = mask_literals(candidate)
    if not re.match(r"^(?:SELECT|WITH)\b", masked, re.I):
        raise ValueError("只允许单条 SELECT 查询")
    if ";" in masked:
        raise ValueError("不允许多条 SQL")
    if any(marker in masked for marker in ("--", "/*", "#")):
        raise ValueError("SQL 中不允许注释")
    if any(marker in masked for marker in ('"', "`", "@")):
        raise ValueError("SQL 中不允许引用标识符或用户变量")
    if re.search(r"\$[A-Za-z0-9_]*\$", masked):
        raise ValueError("不支持 dollar-quoted 字符串，请使用参数绑定")
    if re.search(r"\b(?:TABLE|VALUES)\b", masked, re.I):
        raise ValueError("子查询仅支持 SELECT，不能使用 TABLE/VALUES")
    match = FORBIDDEN.search(masked)
    if match:
        raise ValueError(f"SQL 包含禁止操作: {match.group()}")
    if re.search(r"\bREPLACE\b(?!\s*\()", masked, re.I):
        raise ValueError("SQL 包含禁止操作: REPLACE")
    tokens = _tokens(candidate)
    functions = ENGINE_FUNCTIONS.get(engine, ALLOWED_FUNCTIONS)
    types = ENGINE_TYPES.get(engine, SAFE_TYPES)
    _, declarations = _cte_declarations(tokens)
    depth = 0
    for i, token in enumerate(tokens):
        if token == "(":
            depth += 1
        elif token == ")":
            depth -= 1
            if depth < 0:
                raise ValueError("SQL 括号不匹配")
        if token == "::":
            if i + 1 >= len(tokens) or tokens[i + 1].upper() not in types or (i + 2 < len(tokens) and tokens[i + 2] == "."):
                raise ValueError("SQL 类型转换仅允许内置类型")
        if IDENTIFIER.fullmatch(token) and i + 1 < len(tokens) and tokens[i + 1] == "(" and i not in declarations:
            if i > 0 and tokens[i - 1] == ".":
                raise ValueError("SQL 中不允许调用数据库自定义函数")
            if token.upper() not in functions and token.upper() not in types and token.upper() not in {"WHERE", "WHEN", "THEN", "ELSE", "AND", "OR", "NOT", "ON", "HAVING", "SELECT"}:
                raise ValueError(f"SQL 包含未允许的函数: {token}")
        if token.upper() == "CAST":
            j, cast_depth = i + 2, 1
            while j < len(tokens) and cast_depth:
                if tokens[j] == "(":
                    cast_depth += 1
                elif tokens[j] == ")":
                    cast_depth -= 1
                elif cast_depth == 1 and tokens[j].upper() == "AS":
                    if j + 1 >= len(tokens) or tokens[j + 1].upper() not in types or (j + 2 < len(tokens) and tokens[j + 2] == "."):
                        raise ValueError("SQL 类型转换仅允许内置类型")
                j += 1
    if depth:
        raise ValueError("SQL 括号未闭合")
    return candidate


def table_references(sql: str) -> list[str]:
    """Return physical table names, rejecting comma joins at every SELECT depth."""
    tokens = _tokens(validate_single_select(sql))
    ctes, _ = _cte_declarations(tokens)
    frames = [{"select": False, "from": False}]
    references = []
    i = 0
    while i < len(tokens):
        token = tokens[i].upper()
        frame = frames[-1]
        if token == "(":
            frames.append({"select": False, "from": False})
        elif token == ")":
            frames.pop()
        elif token == "SELECT":
            frame.update(select=True, **{"from": False})
        elif frame["select"] and token in {"WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "UNION", "EXCEPT", "INTERSECT", "FETCH", "OFFSET"}:
            frame["from"] = False
        elif frame["select"] and token in {"FROM", "JOIN"}:
            frame["from"] = True
            j = i + 1
            if j >= len(tokens):
                raise ValueError("FROM/JOIN 缺少表名")
            if tokens[j] == "(":
                if j + 1 >= len(tokens) or tokens[j + 1].upper() != "SELECT":
                    raise ValueError("仅支持 SELECT 派生表")
            else:
                if not IDENTIFIER.fullmatch(tokens[j]):
                    raise ValueError("无法识别查询中的数据表")
                parts = [tokens[j]]
                j += 1
                while j < len(tokens) and tokens[j] == ".":
                    if j + 1 >= len(tokens) or not IDENTIFIER.fullmatch(tokens[j + 1]):
                        raise ValueError("表名限定符无效")
                    parts.append(tokens[j + 1])
                    j += 2
                if j < len(tokens) and tokens[j] == "(":
                    raise ValueError("不支持表函数")
                if len(parts) > 1 or parts[0].lower() not in ctes or i < ctes[parts[0].lower()]:
                    references.append(".".join(parts))
                i = j - 1
        elif token == "," and frame["from"]:
            raise ValueError("不支持逗号连接，请使用显式 JOIN")
        i += 1
    return references

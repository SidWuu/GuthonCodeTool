#!/usr/bin/env python3
"""Portable Guthon dialect linter used by agents, Git hooks, and CI."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, Sequence


SUPPORTED_SUFFIXES = {".gss", ".js", ".sql", ".vm"}
VELOCITY_SUFFIXES = {".gss", ".vm"}
OPEN_DIRECTIVES = {"if", "foreach", "while", "function", "try", "macro"}
API_CALL_RE = re.compile(
    r"(?:\$vs\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+|"
    r"(?<![$A-Za-z0-9_])SQLTools\.[A-Za-z_][A-Za-z0-9_]*)\s*(?=\()"
)
SET_RE = re.compile(r"#set\s*\(\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*=")
FOREACH_RE = re.compile(
    r"#foreach\s*\(\s*\$([A-Za-z_][A-Za-z0-9_]*)\s+in\b"
)
DIRECTIVE_RE = re.compile(r"^\s*#([A-Za-z_][A-Za-z0-9_]*)\b")
FUNCTION_RE = re.compile(
    r"^\s*#function\s*(?:\(\s*)?([A-Za-z_][A-Za-z0-9_]*)"
)
NATIVE_KEYSET_RE = re.compile(r"\.\s*keySet\s*\(")
DIRECT_RESULT_ASSIGN_RE = re.compile(
    r"^\s*\$result(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]]+\])\s*=(?!=)"
)
CONTROL_DIRECTIVE_RE = re.compile(r"#(?:if|elseif|else|end)\b")
CONDITION_RE = re.compile(r"#(?:if|elseif)\s*\((.*)\)\s*$", re.IGNORECASE)
SET_EXPRESSION_RE = re.compile(
    r"#set\s*\(\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\)\s*;?\s*$",
    re.IGNORECASE,
)
ARITHMETIC_OPERATOR_RE = re.compile(r"(?<![!<>=&|])[+*/%-](?!=)")
BOOLEAN_EXPRESSION_RE = re.compile(
    r"(?:==|!=|<=|>=|(?<![<>=])<(?![<>=])|(?<![<>=])>(?![<>=])|"
    r"&&|\|\||\b(?:and|or|not)\b|!\s*(?=\$|\())",
    re.IGNORECASE,
)
NEW_SET_RE = re.compile(
    r"^\$vs\.util\.(?:newHashSet|newLinkedHashSet)\s*\(", re.IGNORECASE
)
SET_TO_LIST_RE = re.compile(
    r"^\$vs\.util\.setToList\s*\(\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*$",
    re.IGNORECASE,
)
SIMPLE_VARIABLE_RE = re.compile(r"^\$([A-Za-z_][A-Za-z0-9_]*)$")
FOREACH_EXPRESSION_RE = re.compile(
    r"#foreach\s*\(\s*\$[A-Za-z_][A-Za-z0-9_]*\s+in\s+(.+)\)\s*;?\s*$",
    re.IGNORECASE,
)
VM_SAVE_RE = re.compile(r"\$vm\.save\s*\(")
DATABASE_FUNCTION_RE = re.compile(r"(?<![A-Za-z0-9_$.])(?:ifnull|nvl|date_add|to_date)\s*\(", re.IGNORECASE)


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    column: int
    code: str
    severity: str
    message: str


@dataclass
class MethodScope:
    name: str
    start_line: int
    sets: dict[str, list[int]]
    foreaches: list[tuple[str, int, int]]


def _finding(
    path: str | Path,
    line: int,
    column: int,
    code: str,
    message: str,
    severity: str = "error",
) -> Finding:
    return Finding(str(path), line, column, code, severity, message)


def _code_lines(text: str) -> list[str]:
    """Blank Velocity comments while retaining physical line positions."""
    result: list[str] = []
    in_block_comment = False
    for original in text.splitlines():
        line = original
        if in_block_comment:
            end = line.find("*#")
            if end < 0:
                result.append("")
                continue
            line = line[end + 2 :]
            in_block_comment = False
        while True:
            start = line.find("#*")
            if start < 0:
                break
            end = line.find("*#", start + 2)
            if end < 0:
                line = line[:start]
                in_block_comment = True
                break
            line = line[:start] + line[end + 2 :]
        if line.lstrip().startswith("##"):
            line = ""
        result.append(line)
    return result


def _blank_quoted_text(text: str) -> str:
    """Blank quoted text while retaining offsets for expression checks."""
    result: list[str] = []
    quote = ""
    escaped = False
    for char in text:
        if quote:
            result.append(" ")
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = ""
            continue
        if char in {'"', "'"}:
            quote = char
            result.append(" ")
        else:
            result.append(char)
    return "".join(result)


def _javascript_code_lines(text: str, blank_strings: bool) -> list[str]:
    """Remove JavaScript comments and optionally strings, preserving line numbers."""
    lines: list[str] = []
    current: list[str] = []
    quote = ""
    escaped = False
    line_comment = False
    block_comment = False
    index = 0
    while index < len(text):
        char = text[index]
        following = text[index + 1] if index + 1 < len(text) else ""
        if char == "\n":
            lines.append("".join(current))
            current = []
            line_comment = False
            escaped = False if not quote else escaped
            index += 1
            continue
        if line_comment:
            current.append(" ")
            index += 1
            continue
        if block_comment:
            current.append(" ")
            if char == "*" and following == "/":
                current.append(" ")
                block_comment = False
                index += 2
            else:
                index += 1
            continue
        if quote:
            current.append(" " if blank_strings else char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = ""
            index += 1
            continue
        if char == "/" and following == "/":
            current.extend((" ", " "))
            line_comment = True
            index += 2
            continue
        if char == "/" and following == "*":
            current.extend((" ", " "))
            block_comment = True
            index += 2
            continue
        if char in {'"', "'", "`"}:
            quote = char
            current.append(" " if blank_strings else char)
            index += 1
            continue
        current.append(char)
        index += 1
    lines.append("".join(current))
    return lines


def _sql_code_lines(text: str) -> list[str]:
    """Blank SQL comments and string literals while retaining source positions."""
    lines: list[str] = []
    current: list[str] = []
    quote = ""
    block_comment = False
    line_comment = False
    index = 0
    while index < len(text):
        char = text[index]
        following = text[index + 1] if index + 1 < len(text) else ""
        if char == "\n":
            lines.append("".join(current))
            current = []
            line_comment = False
            index += 1
            continue
        if line_comment:
            current.append(" ")
            index += 1
            continue
        if block_comment:
            current.append(" ")
            if char == "*" and following == "/":
                current.append(" ")
                block_comment = False
                index += 2
            else:
                index += 1
            continue
        if quote:
            current.append(" ")
            if char == quote:
                if following == quote:
                    current.append(" ")
                    index += 2
                    continue
                quote = ""
            index += 1
            continue
        if char == "-" and following == "-":
            current.extend((" ", " "))
            line_comment = True
            index += 2
            continue
        if char == "/" and following == "*":
            current.extend((" ", " "))
            block_comment = True
            index += 2
            continue
        if char in {'"', "'"}:
            quote = char
            current.append(" ")
            index += 1
            continue
        current.append(char)
        index += 1
    lines.append("".join(current))
    return lines


def default_api_index_path() -> Path:
    configured = os.environ.get("GUTHON_API_INDEX")
    if configured:
        return Path(configured).expanduser()

    current = Path.cwd().resolve()
    for root in (current, *current.parents):
        candidate = root / ".guthon" / "api-index.json"
        if candidate.is_file():
            return candidate
    return current / ".guthon" / "api-index.json"


def find_guthon_workspace(start: Path | None = None) -> Path | None:
    current = (start or Path.cwd()).resolve()
    for root in (current, *current.parents):
        if (root / ".guthon" / "config.json").is_file():
            return root
    return None


def load_api_index(path: Path | None = None) -> set[str]:
    index_path = path or default_api_index_path()
    if not index_path.is_file():
        return set()
    payload = json.loads(index_path.read_text(encoding="utf-8"))
    return set(payload.get("apis", []))


def _line_findings(
    lines: Sequence[str], path: str | Path, api_index: set[str]
) -> list[Finding]:
    findings: list[Finding] = []
    for line_number, line in enumerate(lines, start=1):
        keyset = NATIVE_KEYSET_RE.search(line)
        if keyset:
            findings.append(
                _finding(
                    path,
                    line_number,
                    keyset.start() + 1,
                    "GUTHON001",
                    "禁止调用 Java Map.keySet()；使用 $vs.util.getMapKeys(map)",
                )
            )

        result_assignment = DIRECT_RESULT_ASSIGN_RE.search(line)
        if result_assignment:
            findings.append(
                _finding(
                    path,
                    line_number,
                    result_assignment.start() + 1,
                    "GUTHON003",
                    "禁止直接赋值 $result 字段；使用 #set($result.FIELD = value);",
                )
            )

        if line.lstrip().startswith("#"):
            controls = list(CONTROL_DIRECTIVE_RE.finditer(line))
            if len(controls) > 1:
                findings.append(
                    _finding(
                        path,
                        line_number,
                        controls[1].start() + 1,
                        "GUTHON004",
                        "#if/#elseif/#else/#end 必须各自独占物理行",
                    )
                )

        if api_index:
            for match in API_CALL_RE.finditer(line):
                api = re.sub(r"\s+", "", match.group(0))
                if api not in api_index:
                    findings.append(
                        _finding(
                            path,
                            line_number,
                            match.start() + 1,
                            "GUTHON006",
                            f"权威 API 索引中不存在 {api}",
                        )
                    )
    return findings


def _velocity_expression_findings(
    lines: Sequence[str], path: str | Path
) -> list[Finding]:
    findings: list[Finding] = []
    for line_number, line in enumerate(lines, start=1):
        condition_match = CONDITION_RE.search(line)
        if condition_match:
            condition = _blank_quoted_text(condition_match.group(1))
            arithmetic = ARITHMETIC_OPERATOR_RE.search(condition)
            if arithmetic:
                findings.append(
                    _finding(
                        path,
                        line_number,
                        condition_match.start(1) + arithmetic.start() + 1,
                        "GUTHON007",
                        "#if/#elseif 条件中禁止直接运算；先用 #set 拆出结果变量",
                    )
                )

        assignment_match = SET_EXPRESSION_RE.search(line)
        if not assignment_match:
            continue
        expression = _blank_quoted_text(assignment_match.group(2))
        if "?" in expression and ":" in expression:
            continue
        boolean_expression = BOOLEAN_EXPRESSION_RE.search(expression)
        if boolean_expression:
            findings.append(
                _finding(
                    path,
                    line_number,
                    assignment_match.start(2) + boolean_expression.start() + 1,
                    "GUTHON008",
                    "布尔比较或逻辑表达式不得直接赋值；使用 #if/#else 显性赋值或三元表达式",
                )
            )
    return findings


def _set_iteration_findings(
    lines: Sequence[str], path: str | Path
) -> list[Finding]:
    findings: list[Finding] = []
    collection_kinds: dict[str, str] = {}
    block_stack: list[tuple[str, dict[str, str] | None]] = []

    for line_number, line in enumerate(lines, start=1):
        directive_match = DIRECTIVE_RE.match(line)
        directive = directive_match.group(1).lower() if directive_match else ""
        if directive == "function":
            block_stack.append((directive, collection_kinds))
            collection_kinds = {}
        elif directive in OPEN_DIRECTIVES:
            block_stack.append((directive, None))
        elif directive == "end" and block_stack:
            opened, parent_collections = block_stack.pop()
            if opened == "function" and parent_collections is not None:
                collection_kinds = parent_collections

        assignment_match = SET_EXPRESSION_RE.search(line)
        if assignment_match:
            target = assignment_match.group(1)
            expression = assignment_match.group(2).strip()
            if NEW_SET_RE.match(expression):
                collection_kinds[target] = "set"
            elif SET_TO_LIST_RE.match(expression):
                collection_kinds[target] = "list"
            else:
                source_match = SIMPLE_VARIABLE_RE.match(expression)
                if source_match and source_match.group(1) in collection_kinds:
                    collection_kinds[target] = collection_kinds[source_match.group(1)]
                else:
                    collection_kinds.pop(target, None)

        foreach_match = FOREACH_EXPRESSION_RE.search(line)
        if not foreach_match:
            continue
        iterable = foreach_match.group(1).strip()
        variable_match = SIMPLE_VARIABLE_RE.match(iterable)
        is_unconverted_set = bool(
            variable_match
            and collection_kinds.get(variable_match.group(1)) == "set"
        )
        inline_conversion = SET_TO_LIST_RE.match(iterable)
        if is_unconverted_set or NEW_SET_RE.match(iterable) or inline_conversion:
            findings.append(
                _finding(
                    path,
                    line_number,
                    foreach_match.start(1) + 1,
                    "GUTHON009",
                    "Set 集合必须先用 #set 将 $vs.util.setToList(set) 结果保存为 List，再执行循环",
                )
            )
    return findings


def _javascript_findings(text: str, path: str | Path) -> list[Finding]:
    findings: list[Finding] = []
    if not Path(str(path)).name.lower().endswith(".onclickscript.js"):
        return findings
    calls: list[tuple[int, int]] = []
    for line_number, line in enumerate(
        _javascript_code_lines(text, blank_strings=True), start=1
    ):
        calls.extend(
            (line_number, match.start() + 1) for match in VM_SAVE_RE.finditer(line)
        )
    for line_number, column in calls[1:]:
        findings.append(
            _finding(
                path,
                line_number,
                column,
                "GUTHON010",
                "同一页面事件脚本只能保留一个 $vm.save(...) 保存入口",
            )
        )
    return findings


def _database_function_findings(
    lines: Sequence[str], path: str | Path
) -> list[Finding]:
    findings: list[Finding] = []
    for line_number, line in enumerate(lines, start=1):
        for match in DATABASE_FUNCTION_RE.finditer(line):
            function_name = match.group(0).split("(", 1)[0].strip()
            findings.append(
                _finding(
                    path,
                    line_number,
                    match.start() + 1,
                    "GUTHON011",
                    f"禁止使用数据库特定函数 {function_name}；改用对应的 SQLTools.* API",
                )
            )
    return findings


def _structural_findings(lines: Sequence[str], path: str | Path) -> list[Finding]:
    findings: list[Finding] = []
    root_scope = MethodScope("<root>", 1, {}, [])
    scopes = [root_scope]
    current_scope = root_scope
    block_stack: list[tuple[str, int, MethodScope]] = []

    for line_number, line in enumerate(lines, start=1):
        directive_match = DIRECTIVE_RE.match(line)
        directive = directive_match.group(1).lower() if directive_match else ""

        if directive == "function":
            function_match = FUNCTION_RE.match(line)
            function_name = (
                function_match.group(1) if function_match else f"<function@{line_number}>"
            )
            previous_scope = current_scope
            current_scope = MethodScope(function_name, line_number, {}, [])
            scopes.append(current_scope)
            block_stack.append((directive, line_number, previous_scope))
        elif directive in OPEN_DIRECTIVES:
            block_stack.append((directive, line_number, current_scope))
        elif directive == "end":
            if not block_stack:
                findings.append(
                    _finding(
                        path,
                        line_number,
                        1,
                        "GUTHON005",
                        "存在没有对应起始指令的 #end",
                    )
                )
            else:
                opened, _, previous_scope = block_stack.pop()
                if opened == "function":
                    current_scope = previous_scope

        for match in SET_RE.finditer(line):
            current_scope.sets.setdefault(match.group(1), []).append(line_number)
        for match in FOREACH_RE.finditer(line):
            current_scope.foreaches.append(
                (match.group(1), line_number, match.start(1) + 1)
            )

    for directive, line_number, _ in block_stack:
        findings.append(
            _finding(
                path,
                line_number,
                1,
                "GUTHON005",
                f"#{directive} 缺少对应的 #end",
            )
        )

    for scope in scopes:
        for variable, line_number, column in scope.foreaches:
            set_lines = scope.sets.get(variable)
            if set_lines:
                locations = ", ".join(str(value) for value in set_lines)
                findings.append(
                    _finding(
                        path,
                        line_number,
                        column,
                        "GUTHON002",
                        f"循环元素 ${variable} 与方法 {scope.name} 内 #set 局部变量重名"
                        f"（#set 行：{locations}）",
                    )
                )
    return findings


def lint_text(
    text: str,
    path: str | Path = "<memory>",
    api_index: set[str] | None = None,
    structural: bool = True,
) -> list[Finding]:
    suffix = Path(str(path)).suffix.lower()
    is_velocity = suffix in VELOCITY_SUFFIXES or suffix == ""
    if suffix == ".js":
        lines = _javascript_code_lines(text, blank_strings=True)
        database_lines: Sequence[str] = ()
    elif suffix == ".sql":
        lines = _sql_code_lines(text)
        database_lines = lines
    else:
        lines = _code_lines(text)
        database_lines = lines

    resolved_api_index = load_api_index() if api_index is None else api_index
    findings = _line_findings(lines, path, resolved_api_index)
    findings.extend(_database_function_findings(database_lines, path))
    if is_velocity:
        findings.extend(_velocity_expression_findings(lines, path))
    if suffix == ".js":
        findings.extend(_javascript_findings(text, path))
    if structural and is_velocity:
        findings.extend(_structural_findings(lines, path))
        findings.extend(_set_iteration_findings(lines, path))
    return sorted(findings, key=lambda item: (item.path, item.line, item.column, item.code))


def lint_patch_additions(
    additions: dict[str, list[str]], api_index: set[str] | None = None
) -> list[Finding]:
    """Run only line-local checks before a patch is applied."""
    resolved_api_index = load_api_index() if api_index is None else api_index
    findings: list[Finding] = []
    for path, lines in additions.items():
        if Path(path).suffix.lower() in SUPPORTED_SUFFIXES:
            findings.extend(
                lint_text(
                    "\n".join(lines),
                    path,
                    api_index=resolved_api_index,
                    structural=False,
                )
            )
    return sorted(findings, key=lambda item: (item.path, item.line, item.column, item.code))


def is_protected_write_path(path: str | Path) -> bool:
    normalized = str(path).replace("\\", "/")
    padded = f"/{normalized.strip('/')}"
    name = Path(normalized).name
    return (
        "/source/readonly/" in f"{padded}/"
        or "/checkout/" in f"{padded}/"
        or name in {"raw.json", "meta.json", "source-meta.json"}
    )


def check_write_paths(paths: Iterable[str | Path]) -> list[Finding]:
    return [
        _finding(
            path,
            1,
            1,
            "GUTHON000",
            "禁止通过普通文件工具修改 readonly、checkout 或平台元数据；使用受控写入入口",
        )
        for path in paths
        if is_protected_write_path(path)
    ]


def iter_source_files(paths: Iterable[str | Path]) -> Iterable[Path]:
    seen: set[Path] = set()
    for raw_path in paths:
        path = Path(raw_path)
        candidates = path.rglob("*") if path.is_dir() else [path]
        for candidate in candidates:
            if (
                candidate.is_file()
                and candidate.suffix.lower() in SUPPORTED_SUFFIXES
                and ".git" not in candidate.parts
            ):
                resolved = candidate.resolve()
                if resolved not in seen:
                    seen.add(resolved)
                    yield candidate


def lint_paths(paths: Iterable[str | Path], api_index: set[str]) -> list[Finding]:
    findings: list[Finding] = []
    for path in iter_source_files(paths):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            findings.append(
                _finding(path, 1, 1, "GUTHON900", f"无法读取文件：{error}")
            )
            continue
        findings.extend(lint_text(text, path, api_index=api_index))
    return sorted(findings, key=lambda item: (item.path, item.line, item.column, item.code))


def git_paths(repo: Path, mode: str) -> list[str]:
    if mode == "staged":
        commands = [["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"]]
    else:
        commands = [
            ["git", "diff", "HEAD", "--name-only", "--diff-filter=ACMR"],
            ["git", "ls-files", "--others", "--exclude-standard"],
        ]
    paths: list[str] = []
    for command in commands:
        completed = subprocess.run(
            command,
            cwd=repo,
            check=False,
            capture_output=True,
            text=True,
        )
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or "git 文件查询失败")
        paths.extend(line for line in completed.stdout.splitlines() if line)
    return list(dict.fromkeys(paths))


def format_findings(findings: Sequence[Finding], output_format: str) -> str:
    if output_format == "json":
        return json.dumps(
            [asdict(finding) for finding in findings],
            ensure_ascii=False,
            separators=(",", ":"),
        )
    return "\n".join(
        f"{item.path}:{item.line}:{item.column}: {item.code} {item.severity} {item.message}"
        for item in findings
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="guthon-lint")
    parser.add_argument("paths", nargs="*", help="文件或目录")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--changed", action="store_true", help="检查 Git 已修改及未跟踪文件")
    mode.add_argument("--staged", action="store_true", help="检查 Git 暂存文件")
    parser.add_argument("--repo", type=Path, default=Path.cwd(), help="Git 仓库根目录")
    parser.add_argument("--api-index", type=Path, help="API 索引 JSON")
    parser.add_argument("--write-target", action="store_true", help="同时检查写入路径边界")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument("--quiet", action="store_true", help="成功时不输出")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.changed or args.staged:
            raw_paths = git_paths(args.repo, "staged" if args.staged else "changed")
            paths = [args.repo / path for path in raw_paths]
            policy_paths: list[str | Path] = raw_paths
        else:
            paths = [Path(path) for path in args.paths]
            policy_paths = paths
    except RuntimeError as error:
        print(f"guthon-lint: {error}", file=sys.stderr)
        return 2

    if not paths and not (args.changed or args.staged):
        print("guthon-lint: 请指定路径、--changed 或 --staged", file=sys.stderr)
        return 2

    api_index = load_api_index(args.api_index)
    if not api_index:
        index_path = args.api_index or default_api_index_path()
        print(
            f"guthon-lint: GUTHON901 API 索引不存在或为空：{index_path}",
            file=sys.stderr,
        )
        return 2
    findings = check_write_paths(policy_paths) if args.write_target else []
    findings.extend(lint_paths(paths, api_index))
    findings.sort(key=lambda item: (item.path, item.line, item.column, item.code))

    if findings:
        print(format_findings(findings, args.format))
        return 1 if any(item.severity == "error" for item in findings) else 0
    if not args.quiet:
        print("guthon-lint: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

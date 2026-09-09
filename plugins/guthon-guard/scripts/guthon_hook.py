#!/usr/bin/env python3
"""Codex lifecycle adapter for the portable guthon-lint engine."""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from pathlib import Path

from guthon_lint import (
    Finding,
    check_write_paths,
    find_guthon_workspace,
    format_findings,
    lint_patch_additions,
    lint_paths,
    load_api_index,
)


PATCH_PATH_RE = re.compile(r"^\*\*\* (?:Add|Update|Delete) File: (.+)$")
MOVE_PATH_RE = re.compile(r"^\*\*\* Move to: (.+)$")


def parse_patch(command: str) -> tuple[list[str], dict[str, list[str]]]:
    paths: list[str] = []
    additions: dict[str, list[str]] = {}
    current_path: str | None = None
    for line in command.splitlines():
        path_match = PATCH_PATH_RE.match(line) or MOVE_PATH_RE.match(line)
        if path_match:
            current_path = path_match.group(1).strip()
            paths.append(current_path)
            additions.setdefault(current_path, [])
            continue
        if current_path and line.startswith("+") and not line.startswith("+++"):
            additions[current_path].append(line[1:])
    return list(dict.fromkeys(paths)), additions


def compact_reason(findings: list[Finding], limit: int = 8) -> str:
    selected = findings[:limit]
    text = format_findings(selected, "text")
    if len(findings) > limit:
        text += f"\n... 另有 {len(findings) - limit} 项"
    return "Guthon 规范检查失败，请修复后重试：\n" + text


def state_path(payload: dict[str, object]) -> Path:
    data_root = Path(
        os.environ.get("PLUGIN_DATA")
        or os.environ.get("CLAUDE_PLUGIN_DATA")
        or Path(tempfile.gettempdir()) / "guthon-guard"
    )
    state_root = data_root / "hook-state"
    state_root.mkdir(parents=True, exist_ok=True)
    identity = f"{payload.get('session_id', 'session')}-{payload.get('turn_id', 'turn')}"
    safe_identity = re.sub(r"[^A-Za-z0-9_.-]", "_", identity)
    return state_root / f"{safe_identity}.json"


def save_paths(payload: dict[str, object], paths: list[str]) -> None:
    path = state_path(payload)
    existing: list[str] = []
    if path.is_file():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            existing = []
    path.write_text(
        json.dumps(list(dict.fromkeys(existing + paths)), ensure_ascii=False),
        encoding="utf-8",
    )


def load_paths(payload: dict[str, object]) -> list[str]:
    path = state_path(payload)
    if not path.is_file():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def resolve_paths(cwd: Path, paths: list[str]) -> list[Path]:
    return [path if path.is_absolute() else cwd / path for path in map(Path, paths)]


def emit_pretool_block(reason: str) -> None:
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            },
            ensure_ascii=False,
        )
    )


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (ValueError, TypeError) as error:
        print(f"invalid hook input: {error}", file=sys.stderr)
        return 1

    event = payload.get("hook_event_name")
    cwd = Path(str(payload.get("cwd") or Path.cwd()))
    tool_input = payload.get("tool_input") or {}
    command = tool_input.get("command", "") if isinstance(tool_input, dict) else ""
    paths, additions = parse_patch(command)
    workspace_root = find_guthon_workspace(cwd)
    if workspace_root is None:
        if event == "Stop":
            print("{}")
        return 0

    index_path = workspace_root / ".guthon" / "api-index.json"
    api_index = load_api_index(index_path)
    if not api_index:
        missing_index = Finding(
            str(index_path),
            1,
            1,
            "GUTHON901",
            "error",
            "已启用 Guthon 门禁，但 API 索引不存在或为空；必须先从私有工作区权威 Markdown 生成索引",
        )
        reason = compact_reason([missing_index])
        if event == "PreToolUse":
            emit_pretool_block(reason)
        elif event in {"PostToolUse", "Stop"}:
            print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
        return 0

    if event == "PreToolUse":
        findings = check_write_paths(paths)
        findings.extend(lint_patch_additions(additions, api_index))
        if findings:
            emit_pretool_block(compact_reason(findings))
        return 0

    if event == "PostToolUse":
        if not paths:
            return 0
        save_paths(payload, paths)
        findings = lint_paths(resolve_paths(cwd, paths), api_index)
        if findings:
            print(
                json.dumps(
                    {"decision": "block", "reason": compact_reason(findings)},
                    ensure_ascii=False,
                )
            )
        return 0

    if event == "Stop":
        touched = load_paths(payload)
        if not touched:
            print("{}")
            return 0
        findings = lint_paths(resolve_paths(cwd, touched), api_index)
        if findings:
            print(
                json.dumps(
                    {"decision": "block", "reason": compact_reason(findings)},
                    ensure_ascii=False,
                )
            )
            return 0
        try:
            state_path(payload).unlink(missing_ok=True)
        except OSError:
            pass
        print("{}")
        return 0

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Resolve task targets against the configured registry, independently of cwd.

Natural language only selects an unambiguous registered name or alias. References
and examples are not write targets; uncertain requests return candidates.
"""
from __future__ import annotations

import re
import shlex
import unicodedata
from pathlib import Path

from common import gusen_hub as hub


KINDS = {"product": "products", "products": "products", "产品": "products",
         "project": "projects", "projects": "projects", "项目": "projects"}
COMMAND = re.compile(r"^\s*(?:/(?:guthon-guard:)?guthon-use|\$(?:guthon-guard:)?guthon-use)(?:\s+|$)(.*)$", re.S)
REFERENCE = re.compile(r"参考|参照|对照|借鉴|继承|来源|来自|基于|reference\b|refer to\b", re.I)
ACTION = re.compile(r"修改|修复|实现|开发|调整|排查|查询|分析|定位|切换|选择|处理|目标|modify\b|fix\b|inspect\b|switch\b", re.I)


def normalized(value):
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def summary(workspace):
    return {"workspaceKey": workspace["workspaceKey"], "name": workspace["name"],
            "displayName": workspace["displayName"], "root": str(workspace["root"]),
            "sourceMode": workspace["sourceMode"], "aliases": workspace.get("aliases", [])}


def select_workspace(config, *, workspace_key="", name="", kind="", path=None,
                     prompt="", current_workspace=""):
    """Return a context or a bounded, reviewable selection error; never persist it."""
    diagnostics = []
    workspaces = hub.list_workspaces(config, errors=diagnostics)
    by_key = {item["workspaceKey"]: item for item in workspaces}

    def failure(code, message, candidates=None):
        items = workspaces if candidates is None else candidates
        return {"ok": False, "error": {"code": code, "message": message},
                "candidates": [summary(item) for item in items[:50]],
                "complete": len(items) <= 50, "truncated": len(items) > 50,
                "configErrors": diagnostics}

    for field, value in (("workspaceKey", workspace_key), ("name", name), ("kind", kind),
                         ("prompt", prompt), ("currentWorkspaceKey", current_workspace)):
        if not isinstance(value, str):
            return failure("WORKSPACE_INPUT_INVALID", f"{field} must be a string", [])
    if len(prompt) > 16000:
        return failure("WORKSPACE_INPUT_INVALID", "prompt exceeds 16000 characters", [])
    if path is not None and not isinstance(path, (str, Path)):
        return failure("WORKSPACE_INPUT_INVALID", "path must be a filesystem path", [])
    action = "select"
    explicit = bool(workspace_key or name)
    command = COMMAND.match(prompt)
    if command:
        if explicit:
            return failure("WORKSPACE_INPUT_INVALID", "Use either a command or explicit selectors", [])
        try:
            words = shlex.split(command[1])
        except ValueError as error:
            return failure("WORKSPACE_INPUT_INVALID", str(error), [])
        if not words or words == ["list"] or words == ["列表"]:
            return {**failure("WORKSPACE_REQUIRED", "Select a registered workspace"), "action": "list"}
        if words in (["clear"], ["清除"]):
            return {"ok": True, "action": "clear"}
        if words in (["status"], ["当前"]):
            action = "status"
        else:
            if words[0] in KINDS:
                kind = words.pop(0)
            name = " ".join(words)
            if not name:
                return failure("WORKSPACE_INPUT_INVALID", "Supply a workspace name after the kind")
            if re.fullmatch(r"(?:products|projects)\.[A-Za-z0-9._-]+", name):
                workspace_key, name = name, ""
            explicit = True
    if workspace_key and name:
        return failure("WORKSPACE_INPUT_INVALID", "workspaceKey and name are mutually exclusive", [])
    if kind and kind not in KINDS:
        return failure("WORKSPACE_INPUT_INVALID", "kind must be product or project", [])
    pool = [item for item in workspaces if not kind or item["kind"] == KINDS[kind]]
    selected = None
    source = ""
    if workspace_key:
        selected = by_key.get(workspace_key)
        if selected not in pool:
            return failure("WORKSPACE_NOT_FOUND", f"Unknown workspace or kind mismatch: {workspace_key}", [])
        source = "key"
    elif name:
        matches = [item for item in pool if normalized(name) in {
            normalized(label) for label in [item["name"], item["displayName"], *item.get("aliases", [])]}]
        if len(matches) != 1:
            return failure("WORKSPACE_AMBIGUOUS" if matches else "WORKSPACE_NOT_FOUND",
                           f"Name must match exactly one registered workspace: {name}", matches)
        selected, source = matches[0], "name"
    elif prompt and not command:
        # Quoted examples and fenced code are evidence, not target declarations.
        text = "\n".join(normalized(line) for line in re.sub(r"```.*?```|^\s*>[^\n]*", "", prompt, flags=re.S | re.M).splitlines())
        occurrences = []
        for item in pool:
            for label in [item["name"], item["displayName"], item["workspaceKey"], *item.get("aliases", [])]:
                label = normalized(label)
                for match in re.finditer(re.escape(label), text):
                    if label.isascii() and ((match.start() and re.match(r"[A-Za-z0-9_.-]", text[match.start()-1]))
                                           or match.end() < len(text) and re.match(r"[A-Za-z0-9_.-]", text[match.end()])):
                        continue
                    occurrences.append((match.start(), match.end(), item))
        # A full registered name wins over an alias contained in that same span.
        occurrences = [hit for hit in occurrences if not any(
            other[0] <= hit[0] and other[1] >= hit[1] and other[1]-other[0] > hit[1]-hit[0]
            for other in occurrences)]
        targets = {}
        for start, end, item in occurrences:
            prefix = re.split(r"[，,。；;\n]", text[:start])[-1]
            typed = re.search(r"(项目|产品|project|product)\s*[：:是为]?\s*$", prefix, re.I)
            if typed and item["kind"] != KINDS[typed[1].lower()]:
                continue
            if re.match(r"\s*(?:作为参考|供参考|仅供参考|as (?:a )?reference)", text[end:], re.I):
                continue
            references = list(REFERENCE.finditer(prefix))
            actions = list(ACTION.finditer(prefix))
            if references and (not actions or references[-1].start() >= actions[-1].start()):
                continue
            if re.search(r"不要|无需|不必|别修改|不是|非目标|do not\b", prefix):
                continue
            targets[item["workspaceKey"]] = item
        if len(targets) > 1:
            return failure("WORKSPACE_AMBIGUOUS", "Multiple task targets; select one explicitly", list(targets.values()))
        if targets:
            selected, source = next(iter(targets.values())), "prompt"
            explicit = bool(re.search(r"切换(?:到|为)|目标(?:项目|产品|工作区)?\s*[：:是为]|switch\s+to\b", text))
        elif re.search(r"(?:目标(?:项目|产品|工作区)?\s*[：:是为]|切换到)\s*\S", text):
            return failure("WORKSPACE_NOT_FOUND", "Explicit target is not a registered name or alias")
    if selected and current_workspace and selected["workspaceKey"] != current_workspace and not explicit:
        return failure("WORKSPACE_CONFLICT", "Prompt target differs from the current conversation; use /guthon-use to switch", [selected])
    if selected is None and current_workspace:
        selected, source = by_key.get(current_workspace), "session"
        if selected is None:
            return failure("WORKSPACE_NOT_FOUND", f"Previous workspace is no longer valid: {current_workspace}", [])
        if path:
            candidate = Path(path).expanduser().resolve()
            conflicting = [item for item in pool if item["workspaceKey"] != current_workspace
                           and (candidate == item["root"].resolve() or item["root"].resolve() in candidate.parents)]
            if conflicting:
                return failure("WORKSPACE_CONFLICT", "cwd differs from the conversation target; select explicitly", conflicting)
    if selected is None and path:
        candidate = Path(path).expanduser().resolve()
        matches = [item for item in pool if candidate == item["root"].resolve() or item["root"].resolve() in candidate.parents]
        if matches:
            matches.sort(key=lambda item: len(item["root"].parts), reverse=True)
            selected, source = matches[0], "path"
    if selected is None:
        return failure("WORKSPACE_AMBIGUOUS" if len(pool) > 1 else "WORKSPACE_REQUIRED",
                       "Select a project/product by name, key or configured path", pool)
    context = hub.workspace_agent_context(config, selected)
    return {"ok": True, **context, **summary(selected), "action": action,
            "selectionSource": source, "explicit": explicit, "configErrors": diagnostics}

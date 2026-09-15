"""Bounded workspace search and AI context packages backed by the local index."""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from common import gusen_hub, source_facts


def _connection(workspace: dict) -> sqlite3.Connection:
    index_path = Path(workspace["indexPath"])
    if not index_path.is_file() or not index_path.stat().st_size:
        raise SystemExit(f"本地索引尚未建立：{workspace['workspaceKey']}")
    try:
        connection = sqlite3.connect(f"file:{index_path}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        connection.execute("SELECT 1 FROM gusen_source_record LIMIT 1").fetchone()
        return connection
    except sqlite3.Error as error:
        raise SystemExit(f"本地索引不可用，请先重建：{error}") from error


def _text(value, limit=180) -> str:
    normalized = re.sub(r"\s+", " ", str(value or "")).strip()
    return normalized if len(normalized) <= limit else f"{normalized[:limit - 1]}…"


def _identity(source: dict) -> dict:
    fragment = source.get("fragment") or {}
    return {
        "sourceType": source.get("source_table") or "",
        "sourceId": source.get("source_id") or "",
        "sourceAliasId": source.get("source_alias_id") or "",
        "funId": source.get("fun_id") or "",
        "sourcePath": source.get("source_path") or "",
        "jsonPointer": fragment.get("json_pointer") or "",
        "fragmentType": fragment.get("fragment_type") or "",
    }


def _source_label(source: dict) -> str:
    alias = str(source.get("source_alias_id") or "").strip()
    fun_id = str(source.get("fun_id") or "").strip()
    identity = f"{alias}.{fun_id}" if alias and fun_id else alias or str(source.get("source_id") or "")
    name = str(source.get("source_name") or "").strip()
    return f"{name} · {identity}" if name and name != identity else identity or "未命名源码"


def _preferred_file(root: Path, local_path: str) -> str:
    if not local_path:
        return ""
    path = Path(local_path)
    if not path.is_absolute():
        path = root / path
    if path.is_file():
        return str(path)
    if not path.is_dir():
        return ""
    for name in ("source.vm", "compScript.vm", "raw.json"):
        candidate = path / name
        if candidate.is_file():
            return str(candidate)
    for pattern in ("*.gss", "*.vm", "*.js", "*.sql", "*.json"):
        candidate = next(iter(sorted(path.rglob(pattern))), None)
        if candidate:
            return str(candidate)
    return str(path)


def unified_search(workspace: dict, query: str, limit: int = 20) -> dict:
    """Search identities and indexed facts through one bounded local operation."""

    normalized = str(query or "").strip()
    if not normalized:
        raise SystemExit("统一搜索需要输入关键词")
    bounded_limit = max(1, min(int(limit), 50))
    connection = _connection(workspace)
    try:
        candidates = [
            dict(row)
            for row in gusen_hub.find_source_candidates(
                connection, workspace["scopeId"], normalized, min(bounded_limit, 10)
            )
        ]
        exact_source_match = any(
            normalized.casefold() == str(row.get(name) or "").casefold()
            for row in candidates
            for name in ("source_id", "source_alias_id", "fun_id", "source_name")
        )
        fact_result = (
            {"facts": [], "truncated": False}
            if exact_source_match
            else source_facts.query_facts(
                connection,
                workspace["scopeId"],
                keyword=normalized,
                limit=bounded_limit,
            )
        )
        source_ids = sorted({
            str((fact.get("source") or {}).get("source_id") or "")
            for fact in fact_result.get("facts") or []
            if (fact.get("source") or {}).get("source_id")
        })
        local_paths = {}
        if source_ids:
            placeholders = ",".join("?" for _ in source_ids)
            local_paths = {
                (row["source_id"], row["fun_id"] or ""): row["local_path"] or ""
                for row in connection.execute(
                    f"SELECT source_id, fun_id, local_path FROM gusen_source_record "
                    f"WHERE scope_id=? AND source_id IN ({placeholders})",
                    (workspace["scopeId"], *source_ids),
                ).fetchall()
            }
    finally:
        connection.close()

    items = []
    seen = set()
    lowered = normalized.casefold()
    for row in candidates:
        identity = _identity(row)
        key = (identity["sourceType"], identity["sourceId"], identity["funId"], "source")
        if key in seen:
            continue
        seen.add(key)
        values = {
            str(row.get(name) or "").casefold()
            for name in ("source_id", "source_alias_id", "fun_id", "source_name")
        }
        items.append({
            "kind": "source",
            "score": 100 if lowered in values else 80,
            "label": _source_label(row),
            "description": f"{row.get('source_table') or 'source'} · {row.get('source_path') or row.get('local_path') or ''}",
            "detail": row.get("source_path") or row.get("local_path") or "",
            "identity": identity,
            "filePath": _preferred_file(Path(gusen_hub.ROOT), row.get("local_path") or ""),
        })

    for fact in fact_result.get("facts") or []:
        source = fact.get("source") or {}
        identity = _identity(source)
        fact_type = fact.get("factType") or "fact"
        subject = fact.get("subject") or fact.get("table_name") or fact.get("target_key") or fact_type
        value = fact.get("value") or fact.get("operation") or fact.get("relation_type") or ""
        evidence = fact.get("evidence") or value
        line = fact.get("line_no") or (fact.get("lines") or [0])[0]
        key = (identity["sourceType"], identity["sourceId"], identity["funId"], fact_type, subject, line)
        if key in seen:
            continue
        seen.add(key)
        items.append({
            "kind": "fact",
            "score": 60,
            "label": f"{subject} · {_source_label(source)}",
            "description": _text(value or evidence),
            "detail": _text(evidence, 300),
            "line": int(line or 0),
            "identity": identity,
            "filePath": _preferred_file(
                Path(gusen_hub.ROOT),
                local_paths.get((identity["sourceId"], identity["funId"]), ""),
            ),
        })

    items.sort(key=lambda item: (-item["score"], item["label"].casefold(), item.get("line") or 0))
    items = items[:bounded_limit]
    return {
        "ok": True,
        "workspaceKey": workspace["workspaceKey"],
        "sourceMode": workspace["sourceMode"],
        "query": normalized,
        "items": items,
        "counts": {
            "sources": sum(item["kind"] == "source" for item in items),
            "facts": sum(item["kind"] == "fact" for item in items),
        },
        "truncated": bool(fact_result.get("truncated")) or len(items) >= bounded_limit,
    }


def _relation_label(row: dict, outgoing: bool) -> str:
    if outgoing:
        target = ".".join(filter(None, (str(row.get("target_alias_id") or ""), str(row.get("target_fun_id") or ""))))
        return f"{target or row.get('invoke_expr') or '动态调用'}（第 {row.get('line_no') or '?'} 行）"
    source = ".".join(filter(None, (str(row.get("source_alias_id") or ""), str(row.get("fun_id") or ""))))
    return f"{source or row.get('source_id') or '未知调用方'}（第 {row.get('line_no') or '?'} 行）"


def _fact_markdown(fact: dict) -> str:
    subject = fact.get("subject") or fact.get("table_name") or fact.get("target_key") or fact.get("factType")
    value = fact.get("value") or fact.get("operation") or fact.get("relation_type") or fact.get("evidence") or ""
    line = fact.get("line_no") or (fact.get("lines") or [""])[0]
    suffix = f"，第 {line} 行" if line else ""
    return f"- {subject}: {_text(value, 240)}{suffix}"


def _fact_priority(fact: dict) -> tuple[int, int]:
    if fact.get("factType") == "data":
        priority = 0 if str(fact.get("operation") or "").upper() in {"WRITE", "INSERT", "UPDATE", "DELETE"} else 2
    else:
        priority = {"ERROR": 0, "RETURN": 1, "CONDITION": 2}.get(str(fact.get("kind") or "").upper(), 3)
    line = fact.get("line_no") or (fact.get("lines") or [0])[0]
    return priority, int(line or 0)


def context_pack(
    workspace: dict,
    source_id: str,
    fun_id: str = "",
    limit: int = 5,
    detailed: bool = False,
) -> dict:
    """Build a copy-ready, bounded evidence package for one indexed source object."""

    bounded_limit = max(1, min(int(limit), 30))
    connection = _connection(workspace)
    try:
        context = gusen_hub.query_source_context(
            connection, workspace["scopeId"], source_id, fun_id, bounded_limit
        )
        facts_result = source_facts.query_facts(
            connection,
            workspace["scopeId"],
            source_id=source_id,
            limit=min(30, bounded_limit * 4),
        )
    except ValueError as error:
        raise SystemExit(str(error)) from error
    finally:
        connection.close()

    source = dict(context["source"])
    candidate_facts = [
        fact for fact in facts_result.get("facts") or []
        if not fun_id or (fact.get("source") or {}).get("fun_id") == fun_id
    ]
    facts = (
        candidate_facts[:bounded_limit]
        if detailed
        else sorted(candidate_facts, key=_fact_priority)[:bounded_limit]
    )
    outgoing = [dict(row) for row in context["outgoing"]][:bounded_limit if detailed else 3]
    incoming = [dict(row) for row in context["incoming"]][:bounded_limit if detailed else 3]
    dynamic = [dict(row) for row in context["dynamic"]][:bounded_limit if detailed else 2]
    if not detailed:
        identity = ".".join(filter(None, (
            str(source.get("source_alias_id") or ""),
            str(source.get("fun_id") or ""),
        ))) or str(source.get("source_id") or "")
        version = f"r{source['svn_revision']}" if source.get("svn_revision") else "本地索引"
        source_hash = str(source.get("source_hash") or "")
        if source_hash:
            version += f" · hash {source_hash[:12]}"
        relation_lines = []
        if outgoing:
            relation_lines.append("- 调用：" + "；".join(_relation_label(row, True) for row in outgoing))
        if incoming:
            relation_lines.append("- 调用方：" + "；".join(_relation_label(row, False) for row in incoming))
        if dynamic:
            relation_lines.append("- 动态调用：" + "；".join(
                _text(row.get("invoke_expr") or row.get("reason"), 100) for row in dynamic
            ))
        lines = [
            f"# AI 上下文：{source.get('source_name') or identity}",
            "",
            f"- 对象：`{identity}`（{source.get('source_table') or ''}）",
            f"- 定位：`{workspace['workspaceKey']}` · {version}",
            f"- 路径：`{source.get('source_path') or source.get('local_path') or ''}`",
        ]
        if relation_lines:
            lines.extend(["", "## 关系", *relation_lines])
        if facts:
            lines.extend(["", "## 关键事实", *(_fact_markdown(fact) for fact in facts)])
        lines.extend([
            "",
            "> 本摘要来自本地索引；不包含完整源码，也不代表数据库、平台发布或运行验证结果。",
        ])
        markdown = "\n".join(lines).rstrip() + "\n"
        return {
            "ok": True,
            "workspaceKey": workspace["workspaceKey"],
            "source": source,
            "detailLevel": "compact",
            "counts": {"outgoing": len(outgoing), "incoming": len(incoming), "dynamic": len(dynamic), "facts": len(facts)},
            "markdown": markdown,
        }

    lines = [
        f"# Guthon AI 上下文：{_source_label(source)}",
        "",
        f"- 工作区：`{workspace['workspaceKey']}`",
        f"- 源码模式：`{workspace['sourceMode']}`",
        f"- 类型：`{source.get('source_table') or ''}`",
        f"- 源码 ID：`{source.get('source_id') or ''}`",
        f"- 别名/函数：`{source.get('source_alias_id') or ''}` / `{source.get('fun_id') or ''}`",
        f"- 相对路径：`{source.get('source_path') or source.get('local_path') or ''}`",
    ]
    if source.get("svn_revision"):
        lines.append(f"- SVN revision：`{source['svn_revision']}`")
    if source.get("source_hash"):
        lines.append(f"- 源码 hash：`{source['source_hash']}`")

    lines.extend(["", "## 直接调用"])
    if outgoing:
        lines.extend(f"- {_relation_label(row, True)}" for row in outgoing)
    else:
        lines.append("- 无已识别静态调用")
    lines.extend(["", "## 直接调用方"])
    if incoming:
        lines.extend(f"- {_relation_label(row, False)}" for row in incoming)
    else:
        lines.append("- 无已识别调用方")
    if dynamic:
        lines.extend(["", "## 动态调用"])
        lines.extend(
            f"- {_text(row.get('invoke_expr') or row.get('reason'), 240)}（第 {row.get('line_no') or '?'} 行）"
            for row in dynamic
        )
    lines.extend(["", "## 索引事实"])
    if facts:
        lines.extend(_fact_markdown(fact) for fact in facts)
    else:
        lines.append("- 无已识别条件、赋值、异常或表读写事实")
    lines.extend([
        "",
        "## 证据边界",
        "- 本包来自本地事实索引，不包含整份源码，也不证明平台编译、发布或运行结果。",
        "- 索引证据不足时，应再读取目标局部源码；涉及数据结果时应另外取得数据库或运行时证据。",
    ])
    markdown = "\n".join(lines).rstrip() + "\n"
    return {
        "ok": True,
        "workspaceKey": workspace["workspaceKey"],
        "source": source,
        "detailLevel": "detailed",
        "counts": {"outgoing": len(outgoing), "incoming": len(incoming), "dynamic": len(dynamic), "facts": len(facts)},
        "markdown": markdown,
    }

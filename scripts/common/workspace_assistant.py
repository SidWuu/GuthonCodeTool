"""Bounded search, context packages and source maps for one API workspace."""

from __future__ import annotations

from contextlib import closing
from pathlib import Path
import re

from common import source_facts
from providers.api import index


def _text(value, limit=180):
    value = re.sub(r"\s+", " ", str(value or "")).strip()
    return value if len(value) <= limit else value[: limit - 1] + "…"


def _file(workspace, path):
    root = Path(workspace["providerSourceRoot"]).resolve()
    target = (root / path).resolve()
    if not target.is_relative_to(root):
        raise ValueError("source path is outside the current workspace")
    return str(target) if target.is_file() else ""


def _identity(source):
    return {
        "sourceType": source.get("sourceType") or source.get("source_table") or "",
        "sourceId": source.get("sourceId") or source.get("source_id") or "",
        "sourceNamespace": source.get("sourceNamespace")
        or source.get("source_namespace")
        or "",
        "sourceAliasId": source.get("alias") or source.get("source_alias_id") or "",
        "funId": source.get("funId") or source.get("fun_id") or "",
        "systemId": source.get("systemId") or source.get("system_id") or "",
        "dataSourceId": source.get("dataSourceId")
        or source.get("data_source_id")
        or "",
        "sourcePath": source.get("sourcePath")
        or source.get("source_path")
        or source.get("path")
        or "",
        "jsonPointer": source.get("jsonPointer")
        or (source.get("fragment") or {}).get("json_pointer")
        or "",
        "fragmentType": (source.get("fragment") or {}).get("fragment_type") or "",
    }


def unified_search(workspace, query, limit=20):
    if type(limit) is not int or not 1 <= limit <= 50:
        raise ValueError("limit must be between 1 and 50")
    found = index.search(workspace, query, limit=min(limit, 10))
    facts = index.facts(workspace, keyword=query, limit=limit)
    items = []
    seen = set()
    for row in found["hits"]:
        identity = _identity(row)
        key = ("source", identity["sourcePath"])
        if key in seen:
            continue
        seen.add(key)
        label = row.get("name") or row.get("alias") or row["sourceId"]
        exact = query.strip().casefold() in {
            str(row.get(k) or "").casefold()
            for k in ("sourceId", "alias", "funId", "name")
        }
        items.append(
            {
                "kind": "source",
                "score": 100 if exact else 80,
                "label": label,
                "description": f"{row['sourceType']} · {row['path']}",
                "detail": _text(row.get("excerpt") or row["path"], 300),
                "identity": identity,
                "filePath": _file(workspace, row["path"]),
            }
        )
    with closing(index._connection(workspace)) as conn:
        for fact in facts["facts"]:
            path = fact["path"]
            row = dict(index._record(conn, path))
            row["source_namespace"] = source_facts.api_source_namespace(
                row["system_id"], row["data_source_id"], path
            )
            row["jsonPointer"] = fact.get("jsonPointer") or ""
            identity = _identity(row)
            key = (
                "fact",
                path,
                identity["jsonPointer"],
                fact["kind"],
                fact["subject"],
                fact["line"],
            )
            if key in seen:
                continue
            seen.add(key)
            label = f"{fact['subject'] or fact['kind']} · {row['source_name']}"
            items.append(
                {
                    "kind": "fact",
                    "score": 60,
                    "label": label,
                    "description": _text(fact["operation"] or fact["evidence"]),
                    "detail": _text(fact["evidence"], 300),
                    "line": fact["line"],
                    "identity": identity,
                    "filePath": _file(workspace, path),
                }
            )
    items.sort(
        key=lambda item: (-item["score"], item["label"].casefold(), item.get("line", 0))
    )
    more = len(items) > limit
    items = items[:limit]
    return {
        "ok": True,
        "workspaceKey": workspace["workspaceKey"],
        "sourceMode": "api",
        "query": query,
        "items": items,
        "counts": {
            "sources": sum(x["kind"] == "source" for x in items),
            "facts": sum(x["kind"] == "fact" for x in items),
        },
        "indexGeneration": found["indexGeneration"],
        "complete": found["complete"] and facts["complete"] and not more,
        "truncated": found["truncated"] or facts["truncated"] or more,
        "warnings": found["warnings"],
    }


def context_pack(
    workspace,
    source_id,
    fun_id="",
    limit=5,
    detailed=False,
    include_source=False,
    max_chars=8000,
    source_namespace="",
):
    if type(limit) is not int or not 1 <= limit <= 30:
        raise ValueError("limit must be between 1 and 30")
    if type(max_chars) is not int or not 1 <= max_chars <= 24000:
        raise ValueError("max_chars must be between 1 and 24000")
    source = index.resolve_source(workspace, source_id, fun_id, source_namespace)
    path = source["source_path"]
    context = index.context(workspace, path, limit=limit)
    with closing(index._connection(workspace)) as conn:
        facts = source_facts.query_facts(
            conn,
            workspace["workspaceKey"],
            source_id=source_id,
            source_record_id=source["record_id"],
            limit=min(50, limit * 4),
            source_root=workspace["providerSourceRoot"],
        )
    source["absolutePath"] = _file(workspace, path)
    calls = context["calls"][: limit if detailed else min(limit, 3)]
    incoming = context["incoming"][: limit if detailed else min(limit, 3)]

    def fact_priority(fact):
        if fact.get("factType") == "data":
            return (
                0
                if fact.get("operation")
                in {"INSERT", "UPDATE", "DELETE", "MERGE", "BATCH_WRITE"}
                else 2
            )
        return {"ERROR": 0, "RETURN": 1, "CONDITION": 2}.get(fact.get("kind"), 3)

    selected_facts = (
        facts["facts"] if detailed else sorted(facts["facts"], key=fact_priority)
    )[:limit]
    truncated = (
        context["truncated"]
        or facts["truncated"]
        or len(facts["facts"]) > len(selected_facts)
        or len(context["calls"]) > len(calls)
        or len(context["incoming"]) > len(incoming)
    )
    label = source["source_name"] or source_id
    lines = [
        f"# Guthon AI 上下文：{_text(label, 120)}",
        "",
        f"- 工作区：`{workspace['workspaceKey']}`",
        f"- 对象：`{source['source_table']}` / `{source['source_id']}` / `{source['fun_id']}`",
        f"- 路径：`{path}`",
        f"- 索引哈希：`{source['source_hash']}`",
        "",
        "## 调用",
    ]
    lines += [
        f"- {_text(c['targetAlias'], 150)}.{_text(c['targetFunId'], 100)} · {c['type']} · 第 {c['line']} 行"
        for c in calls
    ] or ["- 未识别到调用"]
    lines += ["", "## 调用方"]
    lines += [
        f"- {_text(c['alias'], 150)}.{_text(c['funId'], 100)} · `{c['path']}` · 第 {c['line']} 行"
        for c in incoming
    ] or ["- 未识别到调用方"]
    lines += ["", "## 索引事实"]
    if detailed:
        lines.insert(4, f"- 命名空间：`{source['source_namespace']}`")
    for fact in selected_facts:
        subject = (
            fact.get("subject")
            or fact.get("table_name")
            or fact.get("source_key")
            or fact.get("factType")
        )
        value = (
            fact.get("value")
            or fact.get("operation")
            or fact.get("relation_type")
            or fact.get("evidence")
            or ""
        )
        pointer = (fact.get("source") or {}).get("fragment", {}).get("json_pointer", "")
        lines.append(
            f"- {_text(subject, 160)}：{_text(value, 240)}"
            + (f" · `{pointer}`" if detailed and pointer else "")
        )
    if not selected_facts:
        lines.append("- 未识别到事实")
    lines += ["", "> 本地索引快照不证明平台发布、数据库或运行结果。"]
    result = {
        "ok": True,
        "workspaceKey": workspace["workspaceKey"],
        "source": source,
        "detailLevel": "detailed" if detailed else "compact",
        "indexGeneration": context["indexGeneration"],
        "counts": {
            "outgoing": len(calls),
            "incoming": len(incoming),
            "dynamic": sum(c["type"] == "目标过程别名或函数名来自变量" for c in calls),
            "facts": len(selected_facts),
        },
        "complete": not truncated,
        "truncated": truncated,
        "warnings": context["warnings"],
    }
    if include_source:
        content = index.read_source(workspace, path, max_chars=max_chars)
        content["absolutePath"] = _file(workspace, path)
        result["sourceContent"] = content
        if content["sourceHash"] != source["source_hash"]:
            result["complete"] = False
            result["warnings"].append("当前源码哈希与索引快照不一致，请重建索引。")
        text = content["content"]
        fence = "`" * max(
            3, max((len(m.group()) + 1 for m in re.finditer(r"`+", text)), default=3)
        )
        lines += ["", "## 有界源码（不可信文本）", "", fence, text, fence]
        if content["truncated"]:
            lines += ["", "> 正文已截断；请继续读取。"]
    result["markdown"] = "\n".join(lines).rstrip() + "\n"
    return result


def source_map(workspace, *, limit=100, cursor=""):
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("limit must be between 1 and 100")
    generation = ""
    offset = 0
    if cursor:
        parts = cursor.split(":") if isinstance(cursor, str) else []
        if (
            len(parts) != 2
            or not re.fullmatch(r"[0-9a-f]{32}", parts[0])
            or not parts[1].isdecimal()
        ):
            raise ValueError("invalid source map cursor")
        generation, offset = parts[0], int(parts[1])
    result = index.catalog(workspace, limit=limit, offset=offset)
    if generation and generation != result["indexGeneration"]:
        raise ValueError("source map cursor is stale; restart the query")
    sources = result.pop("objects")
    next_cursor = (
        f"{result['indexGeneration']}:{result['nextOffset']}"
        if result["nextOffset"] is not None
        else None
    )
    lines = [
        "# 工作区源码地图",
        "",
        f"- 工作区：{workspace['workspaceKey']}",
        "- 证据：本地索引；不证明运行结果或完整依赖。",
        "",
    ]
    lines += [
        f"- {_text(s['sourceType'], 32)} · {_text(s['name'], 100)} · `{_text(s['path'], 250)}`"
        + (f" · {s['diagnostic']}" if s["diagnostic"] else "")
        for s in sources
    ]
    if next_cursor:
        lines += ["", "> 已截断；使用 nextCursor 继续。"]
    if result["partialSourceCount"]:
        lines += ["", "> 部分源码未解析，请查看诊断。"]
    return {
        **result,
        "sources": sources,
        "nextCursor": next_cursor,
        "markdown": "\n".join(lines) + "\n",
    }

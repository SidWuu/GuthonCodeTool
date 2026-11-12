#!/usr/bin/env python3
"""Export the current API workspace's derived source and call indexes."""

import argparse
from contextlib import closing
import json

from common import gusen_hub
from common.persistence import atomic_text
from providers.api import index


def _table(title, headers, rows):
    def cell(value):
        return (
            str(value if value is not None else "")
            .replace("|", "\\|")
            .replace("\r", " ")
            .replace("\n", " ")
        )

    return "\n".join(
        [
            "# " + title,
            "",
            "| " + " | ".join(headers) + " |",
            "| " + " | ".join(["---"] * len(headers)) + " |",
            *("| " + " | ".join(cell(value) for value in row) + " |" for row in rows),
            "",
        ]
    )


def export(workspace):
    scope = workspace["workspaceKey"]
    out = workspace["contextDir"]
    with closing(index._connection(workspace)) as conn:
        generation = conn.execute(
            "SELECT state_value FROM gusen_sync_state WHERE state_key='generation'"
        ).fetchone()[0]
        sources = conn.execute(
            """SELECT source_table,source_id,source_alias_id,fun_id,source_name,system_id,data_source_id,source_path,status,diagnostic
            FROM gusen_source_record WHERE scope_id=? ORDER BY source_table,source_alias_id,fun_id,source_path""",
            (scope,),
        ).fetchall()
        calls = conn.execute(
            """SELECT s.source_table,s.source_id,s.source_alias_id,s.fun_id,s.source_path,c.json_path,c.line_no,c.invoke_type,c.target_alias_id,c.target_fun_id
            FROM gusen_invoke_call c JOIN gusen_source_record s ON s.record_id=c.source_record_id WHERE s.scope_id=?
            ORDER BY s.source_path,c.json_path,c.line_no""",
            (scope,),
        ).fetchall()
        dynamic = conn.execute(
            """SELECT s.source_table,s.source_id,s.source_alias_id,s.fun_id,s.source_path,c.json_path,c.line_no,c.reason,c.invoke_expr
            FROM gusen_dynamic_call c JOIN gusen_source_record s ON s.record_id=c.source_record_id WHERE s.scope_id=?
            ORDER BY s.source_path,c.json_path,c.line_no""",
            (scope,),
        ).fetchall()
    files = {
        "source-index.md": _table(
            "源码索引",
            [
                "类型",
                "源码 ID",
                "别名",
                "函数",
                "名称",
                "系统",
                "数据源",
                "路径",
                "状态",
                "诊断",
            ],
            sources,
        ),
        "invoke-index.md": _table(
            "调用索引",
            [
                "来源类型",
                "源码 ID",
                "来源别名",
                "来源函数",
                "路径",
                "节点",
                "行号",
                "调用类型",
                "目标别名",
                "目标函数",
            ],
            calls,
        ),
        "dynamic-invoke-points.md": _table(
            "动态调用点",
            [
                "来源类型",
                "源码 ID",
                "来源别名",
                "来源函数",
                "路径",
                "节点",
                "行号",
                "原因",
                "表达式",
            ],
            dynamic,
        ),
    }
    for name, text in files.items():
        atomic_text(out / name, text)
    partial = sum(row["status"] != "OK" for row in sources)
    return {
        "ok": True,
        "workspaceKey": scope,
        "indexGeneration": generation,
        "complete": partial == 0,
        "partialSourceCount": partial,
        "files": [str(out / name) for name in files],
        "counts": {
            "sources": len(sources),
            "calls": len(calls),
            "dynamicCalls": len(dynamic),
        },
    }


def main(args=None, workspace=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace")
    parsed = parser.parse_args(args)
    if workspace is None:
        workspace = gusen_hub.resolve_workspace(
            gusen_hub.load_config(), parsed.workspace
        )
    result = export(workspace)
    print(json.dumps(result, ensure_ascii=False))
    return result


if __name__ == "__main__":
    main()

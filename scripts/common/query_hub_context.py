#!/usr/bin/env python3
import argparse
import json

from common import gusen_hub
from common import source_facts
from providers.api import index
from contextlib import closing


def _rows(rows):
    return [dict(row) for row in rows]


def build_parser():
    parser = argparse.ArgumentParser(
        description="Query bounded Gushen Hub context without reading source bodies."
    )
    parser.add_argument("--workspace")
    subparsers = parser.add_subparsers(dest="command", required=True)
    find = subparsers.add_parser("find")
    find.add_argument("keyword")
    find.add_argument("--limit", type=int, default=10)
    context = subparsers.add_parser("context")
    context.add_argument("--source-id", required=True)
    context.add_argument("--fun", "--fun-id", dest="fun", default="")
    context.add_argument("--source-namespace", default="")
    context.add_argument("--limit", type=int, default=20)
    callers = subparsers.add_parser("callers")
    callers.add_argument("--alias", required=True)
    callers.add_argument("--fun", "--fun-id", dest="fun", required=True)
    callers.add_argument("--limit", type=int, default=100)
    facts = subparsers.add_parser("facts")
    facts.add_argument("--keyword", default="")
    facts.add_argument("--table", default="")
    facts.add_argument("--source-id", default="")
    facts.add_argument("--limit", type=int, default=3)
    facts.add_argument("--continuation", type=int, default=0)
    explain = subparsers.add_parser("explain")
    explain.add_argument("--table", default="")
    explain.add_argument("--bill-type", default="")
    explain.add_argument("--data-source-id", default="")
    explain.add_argument("--operation", default="WRITE")
    explain.add_argument("--limit", type=int, default=1)
    explain.add_argument("--fact-limit", type=int, default=4)
    explain.add_argument("--caller-depth", type=int, default=2)
    explain.add_argument("--continuation", type=int, default=0)
    explain.add_argument("--include-details", action="store_true")
    return parser


def main(args=None):
    parsed = build_parser().parse_args(args)
    cfg = gusen_hub.load_config()
    if parsed.workspace:
        gusen_hub.set_workspace(parsed.workspace)
    workspace = gusen_hub.resolve_workspace(cfg)
    scope_id = workspace["workspaceKey"]
    if parsed.command == "find":
        found = index.search(workspace, parsed.keyword, limit=parsed.limit)
        candidates = found.pop("hits")
        result = {**found, "scopeId": scope_id, "candidates": candidates}
    elif parsed.command == "context":
        source = index.resolve_source(
            workspace, parsed.source_id, parsed.fun, parsed.source_namespace
        )
        result = index.context(workspace, source["source_path"], limit=parsed.limit)
        result["scopeId"] = scope_id
    elif parsed.command == "callers":
        result = index.callers(workspace, parsed.alias, parsed.fun, limit=parsed.limit)
        result["scopeId"] = scope_id
        result["target"] = {"alias": parsed.alias, "funId": parsed.fun}
    elif parsed.command == "facts":
        index._bound(parsed.limit, parsed.continuation, 50)
        with closing(index._connection(workspace)) as conn:
            result = source_facts.query_facts(
                conn,
                scope_id,
                keyword=parsed.keyword,
                table_name=parsed.table,
                source_id=parsed.source_id,
                limit=parsed.limit,
                offset=parsed.continuation,
                source_root=workspace["providerSourceRoot"],
            )
            partial = conn.execute(
                "SELECT COUNT(*) FROM gusen_source_record WHERE status<>'OK'"
            ).fetchone()[0]
        result.update(
            workspaceKey=scope_id,
            scopeId=scope_id,
            partialSourceCount=partial,
            complete=not result["truncated"] and not partial,
        )
    else:
        result = index.explain(
            workspace,
            table_name=parsed.table,
            bill_type_code=parsed.bill_type,
            data_source_id=parsed.data_source_id,
            operation=parsed.operation,
            limit=parsed.limit,
            offset=parsed.continuation,
            fact_limit=parsed.fact_limit,
            caller_depth=parsed.caller_depth,
            include_details=parsed.include_details,
        )
        result["scopeId"] = scope_id
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

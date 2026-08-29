#!/usr/bin/env python3
import argparse
import json

from common import gusen_hub
from common import source_facts


def _rows(rows):
    return [dict(row) for row in rows]


def main(args=None):
    parser = argparse.ArgumentParser(description="Query bounded Gushen Hub context without reading source bodies.")
    parser.add_argument("--workspace")
    subparsers = parser.add_subparsers(dest="command", required=True)
    find = subparsers.add_parser("find")
    find.add_argument("keyword")
    find.add_argument("--limit", type=int, default=10)
    context = subparsers.add_parser("context")
    context.add_argument("--source-id", required=True)
    context.add_argument("--fun", default="")
    context.add_argument("--limit", type=int, default=20)
    callers = subparsers.add_parser("callers")
    callers.add_argument("--alias", required=True)
    callers.add_argument("--fun", required=True)
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
    parsed = parser.parse_args(args)
    cfg = gusen_hub.load_config()
    if parsed.workspace:
        gusen_hub.set_workspace(parsed.workspace)
    workspace = gusen_hub.resolve_workspace(cfg)
    product_id = workspace["productId"]
    conn = gusen_hub.connect_index(workspace["indexPath"])
    try:
        if parsed.command == "find":
            result = {"productId": product_id, "candidates": _rows(gusen_hub.find_source_candidates(conn, product_id, parsed.keyword, parsed.limit))}
        elif parsed.command == "context":
            result = {key: (dict(value) if key == "source" else _rows(value)) for key, value in gusen_hub.query_source_context(conn, product_id, parsed.source_id, parsed.fun, parsed.limit).items()}
        elif parsed.command == "callers":
            result = {
                "target": {"alias": parsed.alias, "funId": parsed.fun},
                "callers": _rows(gusen_hub.query_incoming_callers(conn, product_id, parsed.alias, parsed.fun, parsed.limit)),
            }
        elif parsed.command == "facts":
            result = source_facts.query_facts(
                conn,
                product_id,
                keyword=parsed.keyword,
                table_name=parsed.table,
                source_id=parsed.source_id,
                limit=parsed.limit,
                offset=parsed.continuation,
            )
        else:
            result = source_facts.explain_table(
                conn,
                product_id,
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
    finally:
        conn.close()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

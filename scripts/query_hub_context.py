#!/usr/bin/env python3
import argparse
import json

import gusen_hub


def _rows(rows):
    return [dict(row) for row in rows]


def main(args=None):
    parser = argparse.ArgumentParser(description="Query bounded Gushen Hub context without reading source bodies.")
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
    parsed = parser.parse_args(args)
    cfg = gusen_hub.load_config()
    _active, products, projects = gusen_hub.resolve_active(cfg)
    if products:
        product_id = products[0][0]
    else:
        product_id = projects[0][1]["product_id"]
    conn = gusen_hub.connect_index(gusen_hub.active_index_path(cfg))
    try:
        if parsed.command == "find":
            result = {"productId": product_id, "candidates": _rows(gusen_hub.find_source_candidates(conn, product_id, parsed.keyword, parsed.limit))}
        elif parsed.command == "context":
            result = {key: (dict(value) if key == "source" else _rows(value)) for key, value in gusen_hub.query_source_context(conn, product_id, parsed.source_id, parsed.fun, parsed.limit).items()}
        else:
            result = {
                "target": {"alias": parsed.alias, "funId": parsed.fun},
                "callers": _rows(gusen_hub.query_incoming_callers(conn, product_id, parsed.alias, parsed.fun, parsed.limit)),
            }
    finally:
        conn.close()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

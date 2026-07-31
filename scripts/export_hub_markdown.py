#!/usr/bin/env python3
import argparse

import gusen_hub


def main(args=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace")
    parsed = parser.parse_args(args)
    cfg = gusen_hub.load_config()
    if parsed.workspace:
        gusen_hub.set_workspace(parsed.workspace)
    workspace = gusen_hub.resolve_workspace(cfg)
    conn = gusen_hub.connect_index(workspace["indexPath"])
    try:
        if workspace["type"] == "product":
            gusen_hub.export_product_docs(conn, workspace["productId"])
        else:
            gusen_hub.export_project_docs(conn, workspace["projectId"])
    finally:
        conn.close()


if __name__ == "__main__":
    main()

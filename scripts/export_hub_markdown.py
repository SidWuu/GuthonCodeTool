#!/usr/bin/env python3
import gusen_hub


def main():
    cfg = gusen_hub.load_config()
    _active, products, projects = gusen_hub.resolve_active(cfg)
    conn = gusen_hub.connect_index(gusen_hub.ROOT / cfg["sync"]["sync"]["index_db"])
    try:
        for product_id, _product in products:
            gusen_hub.export_product_docs(conn, product_id)
        for project_id, _project in projects:
            gusen_hub.export_project_docs(conn, project_id)
    finally:
        conn.close()


if __name__ == "__main__":
    main()

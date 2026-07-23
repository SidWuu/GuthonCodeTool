#!/usr/bin/env python3
"""Export Gushen view SQL directly from platform metadata."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import gusen_hub
from export_table_schema_sql import (
    normalize_data_source_ids,
    resolve_data_source_ids,
    resolve_output_dir,
    sanitize_name,
    system_folder_name,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = ROOT / "var" / "database" / "views"


def normalize_view_ids(value):
    if not value:
        return []
    if isinstance(value, str):
        value = value.split(",")
    return [str(item).strip() for item in value if str(item).strip()]


def fetch_rows(conn, table_name, data_source_ids, view_ids=None):
    ids = normalize_data_source_ids(data_source_ids)
    selected = normalize_view_ids(view_ids)
    params = list(ids)
    sql = f"SELECT * FROM {table_name} WHERE DATA_SOURCE_ID IN ({', '.join(['%s'] * len(ids))})"
    if selected and table_name == "gdp_tables_views":
        sql += f" AND VIEW_ID IN ({', '.join(['%s'] * len(selected))})"
        params.extend(selected)
    with conn.cursor() as cur:
        cur.execute(sql, tuple(params))
        return list(cur.fetchall())


def export_views(conn, output_dir=DEFAULT_OUTPUT_DIR, data_source_ids=None, view_ids=None):
    output_dir = Path(output_dir)
    data_source_ids = normalize_data_source_ids(data_source_ids)
    if not data_source_ids:
        raise ValueError("data_source_ids is required")
    view_ids = normalize_view_ids(view_ids)
    views = fetch_rows(conn, "gdp_tables_views", data_source_ids, view_ids)
    systems = fetch_rows(conn, "gd_system", data_source_ids)

    if view_ids:
        found = {str(row.get("VIEW_ID") or "") for row in views}
        missing = [view_id for view_id in view_ids if view_id not in found]
        if missing:
            raise ValueError(f"View source not found. missing_view_ids={','.join(missing)}")

    system_by_data_source = {}
    for system in systems:
        data_source_id = str(system.get("DATA_SOURCE_ID") or "")
        if data_source_id:
            system_by_data_source.setdefault(data_source_id, system)

    exported = 0
    for view in sorted(views, key=lambda row: (str(row.get("DATA_SOURCE_ID") or ""), str(row.get("VIEW_ID") or ""))):
        data_source_id = str(view.get("DATA_SOURCE_ID") or "")
        view_id = str(view.get("VIEW_ID") or "")
        source = str(view.get("VIEW_SQL") or "").rstrip()
        if not view_id or not source:
            continue
        system = system_by_data_source.get(data_source_id, {})
        folder = output_dir / system_folder_name(data_source_id, system.get("SYSTEM_NAME"))
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{sanitize_name(view_id)}.sql").write_text(f"{source}\n", encoding="utf-8")
        exported += 1

    return {
        "view_count": len(views),
        "exported_view_count": exported,
        "data_source_ids": data_source_ids,
        "view_ids": view_ids,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Export Gushen view SQL directly from platform metadata.")
    parser.add_argument("--datasource", help="Datasource override. Defaults to the product or project selected by sync.ACTIVE.")
    parser.add_argument("--output-dir", help="Output directory override. Defaults to var/database/views/{products|projects}/<active_name>.")
    parser.add_argument("--data-source-ids", help="Comma-separated DATA_SOURCE_ID list. Defaults to configured system aliases.")
    parser.add_argument("--view-ids", help="Comma-separated VIEW_ID list. Defaults to all views in selected data sources.")
    args = parser.parse_args(argv)

    requested_data_source_ids = normalize_data_source_ids(args.data_source_ids) if args.data_source_ids else []
    view_ids = normalize_view_ids(args.view_ids)
    config = gusen_hub.load_config()
    output_dir = resolve_output_dir(DEFAULT_OUTPUT_DIR, args.output_dir, config)
    datasource_name, datasource = gusen_hub.resolve_datasource(config, args.datasource)
    try:
        with gusen_hub.db_connect(datasource) as conn:
            data_source_ids = resolve_data_source_ids(conn, datasource_name, requested_data_source_ids)
            summary = export_views(conn, output_dir, data_source_ids, view_ids)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2

    result = {"ok": True, **summary, "outputDir": str(output_dir)}
    gusen_hub.append_pull_log(
        "views",
        "manual",
        {
            "dataSourceIds": data_source_ids,
            "viewIds": view_ids,
            "exported_view_count": summary["exported_view_count"],
            "outputDir": str(output_dir),
        },
        payload={"datasource": datasource_name, "dataSourceIds": data_source_ids, "viewIds": view_ids},
        result=result,
        ok=True,
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

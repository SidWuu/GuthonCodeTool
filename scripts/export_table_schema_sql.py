#!/usr/bin/env python3
"""Export Gushen table schemas directly from SQL."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

import gusen_hub


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = ROOT / "var" / "database" / "schema"
DEFAULT_DATA_SOURCE_IDS = ["0000", "0008", "0015", "0018", "0019", "0021"]


def sanitize_name(value):
    if value is None or str(value).strip() == "":
        return "空"
    text = re.sub(r"[\\/:*?\"<>|]+", "_", str(value)).strip()
    text = re.sub(r"\s+", "_", text)
    return text[:120] or "空"


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def to_camel_key(key):
    text = str(key)
    if "_" not in text and not text.isupper():
        return text
    parts = text.lower().split("_")
    return parts[0] + "".join(part.capitalize() for part in parts[1:])


def camelize_keys(value):
    if isinstance(value, list):
        return [camelize_keys(item) for item in value]
    if isinstance(value, dict):
        return {to_camel_key(key): camelize_keys(item) for key, item in value.items()}
    return value


def drop_empty(value):
    if isinstance(value, list):
        return [drop_empty(item) for item in value]
    if isinstance(value, dict):
        return {key: drop_empty(item) for key, item in value.items() if item not in (None, "")}
    return value


def schema_json(table, system, fields):
    return drop_empty(
        {
            "tableId": table.get("TABLE_ID"),
            "tableName": table.get("TABLE_NAME"),
            "dataSourceId": table.get("DATA_SOURCE_ID"),
            "systemName": system.get("SYSTEM_NAME"),
            "systemAliasId": system.get("SYSTEM_ALIAS_ID"),
            "cacheType": table.get("CACHE_TYPE"),
            "cacheKey": table.get("CACHE_KEY"),
            "cacheDataField": table.get("CACHE_DATA_FIELD"),
            "fields": [
                drop_empty(
                    {
                        "fieldId": field.get("FIELD_ID"),
                        "fieldName": field.get("FIELD_NAME"),
                        "dataType": field.get("DATA_TYPE"),
                        "dataLength": field.get("DATA_LENGTH"),
                        "dataPrecision": field.get("DATA_PRECISION"),
                        "isPrimary": field.get("IS_PRIMARY"),
                        "isCanNull": field.get("IS_CAN_NULL"),
                        "isIncrement": field.get("IS_INCREMENT"),
                        "defaultValue": field.get("DEFAULT_VALUE"),
                        "fieldRemark": field.get("FIELD_REMARK"),
                        "dataAuthField": field.get("DATA_AUTH_FIELD"),
                        "isCipher": field.get("IS_CIPHER"),
                        "orderNo": field.get("ORDER_NO"),
                    }
                )
                for field in fields
            ],
        }
    )


def system_folder_name(data_source_id, system_name):
    name = "贸易系统" if data_source_id == "0008" else system_name or "空"
    return f"{sanitize_name(data_source_id)}_{sanitize_name(name)}"


def normalize_data_source_ids(value):
    if value is None:
        return list(DEFAULT_DATA_SOURCE_IDS)
    if isinstance(value, str):
        items = value.split(",")
    else:
        items = value
    return [str(item).strip() for item in items if str(item).strip()]


def normalize_table_ids(value):
    if not value:
        return []
    if isinstance(value, str):
        items = value.split(",")
    else:
        items = value
    return [str(item).strip() for item in items if str(item).strip()]


def fetch_rows(conn, table_name, data_source_ids, table_ids=None):
    ids = normalize_data_source_ids(data_source_ids)
    placeholders = ", ".join(["%s"] * len(ids))
    params = list(ids)
    table_filter = ""
    table_ids = normalize_table_ids(table_ids)
    if table_ids and table_name in {"gd_tables", "gd_tables_field"}:
        table_placeholders = ", ".join(["%s"] * len(table_ids))
        table_filter = f" AND TABLE_ID IN ({table_placeholders})"
        params.extend(table_ids)
    with conn.cursor() as cur:
        cur.execute(f"SELECT * FROM {table_name} WHERE DATA_SOURCE_ID IN ({placeholders}){table_filter}", tuple(params))
        return list(cur.fetchall())


def export_table_schema(conn, output_dir=DEFAULT_OUTPUT_DIR, data_source_ids=None, table_ids=None, exported_at=None):
    output_dir = Path(output_dir)
    data_source_ids = normalize_data_source_ids(data_source_ids)
    table_ids = normalize_table_ids(table_ids)
    exported_at = exported_at or dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    tables = fetch_rows(conn, "gd_tables", data_source_ids, table_ids)
    fields = fetch_rows(conn, "gd_tables_field", data_source_ids, table_ids)
    systems = fetch_rows(conn, "gd_system", data_source_ids)
    if table_ids:
        found_ids = {str(table.get("TABLE_ID") or "") for table in tables}
        missing_ids = [table_id for table_id in table_ids if table_id not in found_ids]
        if missing_ids:
            raise ValueError(
                "Table schema not found. "
                f"data_source_ids={','.join(data_source_ids)}, "
                f"missing_table_ids={','.join(missing_ids)}"
            )

    system_by_data_source = {}
    for system in systems:
        data_source_id = str(system.get("DATA_SOURCE_ID") or "")
        if data_source_id:
            system_by_data_source.setdefault(data_source_id, system)

    fields_by_table = {}
    for field in fields:
        table_id = field.get("TABLE_ID")
        if table_id:
            fields_by_table.setdefault(table_id, []).append(field)

    metadata = []
    exported_names = []
    for table in sorted(tables, key=lambda item: (str(item.get("DATA_SOURCE_ID") or ""), str(item.get("TABLE_NAME") or ""), str(item.get("TABLE_ID") or ""))):
        data_source_id = str(table.get("DATA_SOURCE_ID") or "")
        system = system_by_data_source.get(data_source_id, {})
        field_list = sorted(
            fields_by_table.get(table.get("TABLE_ID"), []),
            key=lambda item: (item.get("ORDER_NO") is None, item.get("ORDER_NO"), item.get("PKID")),
        )
        folder = output_dir / system_folder_name(data_source_id, system.get("SYSTEM_NAME"))
        file_name = f"{sanitize_name(table.get('TABLE_ID'))}.{sanitize_name(table.get('TABLE_NAME'))}.json"
        write_json(folder / file_name, schema_json(table, system, field_list))
        exported_names.append(str(table.get("TABLE_ID") or ""))
        metadata.append(
            {
                "TABLE_ID": table.get("TABLE_ID"),
                "TABLE_NAME": table.get("TABLE_NAME"),
                "CACHE_TYPE": table.get("CACHE_TYPE"),
                "DATA_SOURCE_ID": data_source_id,
                "SYSTEM_ID": system.get("SYSTEM_ID"),
                "SYSTEM_NAME": system.get("SYSTEM_NAME"),
            }
        )

    metadata.sort(key=lambda item: (item.get("DATA_SOURCE_ID") or "", item.get("SYSTEM_NAME") or "", item.get("TABLE_NAME") or "", item.get("TABLE_ID") or ""))
    write_json(output_dir / "table_metadata.json", metadata)
    summary = {
        "table_count": len(tables),
        "field_count": len(fields),
        "exported_table_count": len(metadata),
        "exported_table_time": exported_at,
        "data_source_ids": data_source_ids,
        "table_ids": table_ids,
        "exported_table_name": ",".join(name for name in exported_names if name),
    }
    summary_file = output_dir / "export_summary.json"
    summaries = read_json(summary_file) if summary_file.exists() else []
    summaries.append(summary)
    write_json(summary_file, summaries)
    return summary


def load_datasource(name=None):
    cfg = gusen_hub.load_config()
    return gusen_hub.resolve_datasource(cfg, name)


def load_default_data_source_ids():
    cfg = gusen_hub.load_config()
    rules = cfg["sync"].get("rules") or {}
    return normalize_data_source_ids(rules.get("table_schema_data_source_ids"))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Export Gushen table schemas directly from SQL.")
    parser.add_argument("--datasource", help="Datasource override. Defaults to the product or project selected by sync.ACTIVE.")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--data-source-ids", help="Comma-separated DATA_SOURCE_ID list. Defaults to config sync.rules.table_schema_data_source_ids.")
    parser.add_argument("--table-ids", help="Comma-separated TABLE_ID list. Omit to export all tables in selected data sources.")
    args = parser.parse_args(argv)

    data_source_ids = normalize_data_source_ids(args.data_source_ids) if args.data_source_ids else load_default_data_source_ids()
    table_ids = normalize_table_ids(args.table_ids)
    datasource_name, datasource = load_datasource(args.datasource)
    try:
        with gusen_hub.db_connect(datasource) as conn:
            summary = export_table_schema(conn, Path(args.output_dir), data_source_ids=data_source_ids, table_ids=table_ids)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    result = {"ok": True, **summary, "outputDir": args.output_dir}
    gusen_hub.append_pull_log(
        "database",
        "manual",
        {
            "dataSourceIds": data_source_ids,
            "tableIds": table_ids,
            "exported_table_count": summary.get("exported_table_count", 0),
            "outputDir": args.output_dir,
        },
        payload={"datasource": datasource_name, "dataSourceIds": data_source_ids, "tableIds": table_ids},
        result=result,
        ok=True,
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Export Gushen bill types directly from SQL."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import gusen_hub
from export_table_schema_sql import DEFAULT_DATA_SOURCE_IDS, normalize_data_source_ids


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = ROOT / "var" / "database" / "billtype"


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


def drop_empty(value):
    if isinstance(value, list):
        return [drop_empty(item) for item in value]
    if isinstance(value, dict):
        return {key: drop_empty(item) for key, item in value.items() if item not in (None, "")}
    return value


def system_display_name(data_source_id, system_name):
    return "贸易系统" if data_source_id == "0008" else system_name or "空"


def output_file_name(data_source_id, system_name):
    return f"{sanitize_name(data_source_id)} {sanitize_name(system_name)}.json"


def fetch_rows(conn, table_name, data_source_ids):
    ids = normalize_data_source_ids(data_source_ids)
    placeholders = ", ".join(["%s"] * len(ids))
    with conn.cursor() as cur:
        cur.execute(f"SELECT * FROM {table_name} WHERE DATA_SOURCE_ID IN ({placeholders})", tuple(ids))
        return list(cur.fetchall())


def bill_type_json(row):
    return drop_empty(
        {
            "billTypeCode": row.get("BILL_TYPE_CODE"),
            "billTypeName": row.get("BILL_TYPE_NAME"),
            "tableId": row.get("TABLE_ID"),
            "tablePkids": row.get("TABLE_PKIDS"),
            "status": row.get("STATUS"),
            "billCodeMode": row.get("BILL_CODE_MODE"),
            "billCodeMark": row.get("BILL_CODE_MARK"),
            "billSeqLength": row.get("BILL_SEQ_LENGTH"),
            "startCode": row.get("START_CODE"),
            "stepNum": row.get("STEP_NUM"),
            "billDateType": row.get("BILL_DATE_TYPE"),
            "billCheck": row.get("BILL_CHECK"),
            "billCheckMode": row.get("BILL_CHECK_MODE"),
            "billCheckPrint": row.get("BILL_CHECK_PRINT"),
            "billClose": row.get("BILL_CLOSE"),
            "billPrintNum": row.get("BILL_PRINT_NUM"),
            "isProduct": row.get("IS_PRODUCT"),
            "billTypeRemark": row.get("BILL_TYPE_REMARK"),
            "fields": row.get("FIELDS"),
        }
    )


def export_bill_types(conn, output_dir=DEFAULT_OUTPUT_DIR, data_source_ids=None):
    output_dir = Path(output_dir)
    data_source_ids = normalize_data_source_ids(data_source_ids or DEFAULT_DATA_SOURCE_IDS)
    bill_types = fetch_rows(conn, "gd_bill_type", data_source_ids)
    systems = fetch_rows(conn, "gd_system", data_source_ids)

    system_by_data_source = {}
    for system in systems:
        data_source_id = str(system.get("DATA_SOURCE_ID") or "")
        if data_source_id:
            system_by_data_source.setdefault(data_source_id, system)

    grouped = {}
    for bill_type in bill_types:
        data_source_id = str(bill_type.get("DATA_SOURCE_ID") or "")
        if data_source_id and data_source_id in system_by_data_source:
            grouped.setdefault(data_source_id, []).append(bill_type)

    exported_count = 0
    for data_source_id in sorted(grouped):
        system = system_by_data_source[data_source_id]
        system_name = system_display_name(data_source_id, system.get("SYSTEM_NAME"))
        rows = sorted(
            grouped[data_source_id],
            key=lambda item: (
                item.get("BILL_TYPE_CODE") or "",
                item.get("BILL_TYPE_NAME") or "",
                item.get("TABLE_ID") or "",
            ),
        )
        exported_count += len(rows)
        payload = drop_empty(
            {
                "dataSourceId": data_source_id,
                "systemName": system_name,
                "systemAliasId": system.get("SYSTEM_ALIAS_ID"),
                "billTypes": [bill_type_json(row) for row in rows],
            }
        )
        write_json(output_dir / output_file_name(data_source_id, system_name), payload)

    return {
        "bill_type_count": len(bill_types),
        "exported_data_source_count": len(grouped),
        "exported_bill_type_count": exported_count,
        "data_source_ids": data_source_ids,
    }


def load_config():
    return gusen_hub.load_config()


def load_datasource(name):
    cfg = load_config()
    datasource = (cfg["datasource"].get("datasource") or {}).get(name)
    if not datasource:
        raise SystemExit(f"Unknown datasource: {name}")
    return datasource


def load_default_data_source_ids():
    cfg = load_config()
    rules = cfg["sync"].get("rules") or {}
    return normalize_data_source_ids(rules.get("table_schema_data_source_ids"))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Export Gushen bill types directly from SQL.")
    parser.add_argument("--datasource", default="product-dev")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--data-source-ids", help="Comma-separated DATA_SOURCE_ID list. Defaults to config sync.rules.table_schema_data_source_ids.")
    args = parser.parse_args(argv)

    data_source_ids = normalize_data_source_ids(args.data_source_ids) if args.data_source_ids else load_default_data_source_ids()
    with gusen_hub.db_connect(load_datasource(args.datasource)) as conn:
        summary = export_bill_types(conn, Path(args.output_dir), data_source_ids=data_source_ids)
    print(
        "导出完成: "
        f"{summary['exported_bill_type_count']}/{summary['bill_type_count']} "
        f"({summary['exported_data_source_count']} 个数据源) -> {args.output_dir}"
    )


if __name__ == "__main__":
    main()

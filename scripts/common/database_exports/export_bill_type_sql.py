#!/usr/bin/env python3
"""Export Gushen bill types directly from SQL."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from common import gusen_hub
from common.database_exports._export_common import (
    bill_type_export_lock, bill_type_output_dir, drop_empty, legacy_bill_type_dir, sanitize_name, write_json,
)
from common.database_exports._export_common import normalize_values as normalize_bill_type_codes
from common.database_exports.scope import (
    normalize_data_source_ids,
    resolve_data_source_ids,
)


def system_display_name(data_source_id, system_name):
    return "贸易系统" if data_source_id == "0008" else system_name or "空"


def output_file_name(data_source_id, system_name):
    return f"{sanitize_name(data_source_id)} {sanitize_name(system_name)}.json"


def fetch_rows(conn, table_name, data_source_ids, bill_type_codes=None):
    ids = normalize_data_source_ids(data_source_ids)
    codes = normalize_bill_type_codes(bill_type_codes)
    placeholders = ", ".join(["%s"] * len(ids))
    params = list(ids)
    sql = f"SELECT * FROM {table_name} WHERE DATA_SOURCE_ID IN ({placeholders})"
    if codes and table_name == "gd_bill_type":
        sql += f" AND BILL_TYPE_CODE IN ({', '.join(['%s'] * len(codes))})"
        params.extend(codes)
    with conn.cursor() as cur:
        cur.execute(sql, tuple(params))
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


def export_bill_types(
    conn, output_dir=None, data_source_ids=None, bill_type_codes=None, *, legacy_dir=None, generated=True
):
    if output_dir is None:
        workspace = gusen_hub.resolve_workspace(gusen_hub.load_config())
        output_dir = bill_type_output_dir(workspace)
        if workspace["sourceMode"] == "database":
            legacy_dir = legacy_bill_type_dir(workspace)
    output_dir = Path(output_dir).resolve()
    data_source_ids = normalize_data_source_ids(data_source_ids)
    if not data_source_ids:
        raise ValueError("data_source_ids is required")
    bill_type_codes = normalize_bill_type_codes(bill_type_codes)
    bill_types = fetch_rows(
        conn, "gd_bill_type", data_source_ids, bill_type_codes=bill_type_codes
    )
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
        filename = output_file_name(data_source_id, system_name)
        prefix = sanitize_name(data_source_id) + " "
        with bill_type_export_lock(output_dir):
            existing = None
            directories = (output_dir, legacy_dir) if bill_type_codes or legacy_dir is not None else ()
            for directory in directories:
                if directory is None:
                    continue
                candidates = [file for file in sorted(directory.glob("*.json")) if file.name.startswith(prefix)]
                if candidates:
                    preferred = directory / filename
                    if len(candidates) != 1 and preferred not in candidates:
                        raise ValueError(f"数据源 {data_source_id} 的单据类型导出文件不唯一")
                    existing = preferred if preferred in candidates else candidates[0]
                    if existing.resolve() != existing:
                        raise ValueError("单据类型导出文件不能是链接")
                    break
            if existing is not None and bill_type_codes:
                current = json.loads(existing.read_text(encoding="utf-8"))
                if (not isinstance(current, dict) or str(current.get("dataSourceId")) != data_source_id
                        or not isinstance(current.get("billTypes"), list)
                        or any(not isinstance(row, dict) or not row.get("billTypeCode") for row in current["billTypes"])):
                    raise ValueError(f"数据源 {data_source_id} 的单据类型导出文件不完整，无法合并定向导出")
                # Keep the existing order and replace only the codes returned by the query.
                refreshed = {row["billTypeCode"]: row for row in payload["billTypes"]}
                combined = [refreshed.pop(row["billTypeCode"], row) for row in current["billTypes"]]
                payload = {**current, **payload, "billTypes": [*combined, *refreshed.values()]}
            write_json(output_dir / (existing.name if existing else filename), payload, generated=generated)

    return {
        "bill_type_count": len(bill_types),
        "exported_data_source_count": len(grouped),
        "exported_bill_type_count": exported_count,
        "data_source_ids": data_source_ids,
        "bill_type_codes": bill_type_codes,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Export Gushen bill types directly from SQL."
    )
    parser.add_argument("--workspace")
    parser.add_argument(
        "--datasource",
        help="Datasource override. Defaults to the selected workspace datasource.",
    )
    parser.add_argument(
        "--output-dir",
        help="Output directory override. Defaults to database/billtype in DATABASE mode and docs/exports/billtype in API mode.",
    )
    parser.add_argument(
        "--data-source-ids",
        help="Comma-separated DATA_SOURCE_ID list. Defaults to current API data-source scope.",
    )
    parser.add_argument(
        "--bill-type-codes",
        help="Comma-separated BILL_TYPE_CODE list. Defaults to all bill types in selected data sources.",
    )
    args = parser.parse_args(argv)

    requested_data_source_ids = (
        normalize_data_source_ids(args.data_source_ids) if args.data_source_ids else []
    )
    bill_type_codes = normalize_bill_type_codes(args.bill_type_codes)
    config = gusen_hub.load_config()
    if args.workspace:
        gusen_hub.set_workspace(args.workspace)
    workspace = gusen_hub.resolve_workspace(config)
    default_dir = bill_type_output_dir(workspace)
    output_dir = Path(args.output_dir) if args.output_dir else default_dir
    database_default = workspace["sourceMode"] == "database" and output_dir.resolve() == default_dir
    legacy_dir = legacy_bill_type_dir(workspace) if database_default else None
    datasource_name, datasource = gusen_hub.resolve_datasource(config, args.datasource)
    with gusen_hub.db_connect(datasource) as conn:
        data_source_ids = resolve_data_source_ids(
            conn, datasource_name, requested_data_source_ids
        )
        index_sources = (
            resolve_data_source_ids(conn, datasource_name)
            if requested_data_source_ids else data_source_ids
        )
        summary = export_bill_types(
            conn,
            output_dir,
            data_source_ids=data_source_ids,
            bill_type_codes=bill_type_codes,
            legacy_dir=legacy_dir,
        )
    from common import source_facts

    from common import database_source_exports

    with bill_type_export_lock(output_dir), gusen_hub.index_connection(
        workspace,
        action="billtype-index",
        readonly=False,
    ) as index:
        paths = (database_source_exports.bill_type_files(workspace) if database_default
                 else sorted(output_dir.glob("*.json")))
        payloads = []
        for path in paths:
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(payload, dict) and str(payload.get("dataSourceId")) in index_sources:
                payloads.append(payload)
        summary["indexed_bill_route_count"] = (
            source_facts.replace_workspace_bill_routes(index, payloads)
        )
        if database_default:
            summary["indexDiagnostics"] = database_source_exports.rebuild(index, workspace, source_type="bill-type")
        index.commit()
    result = {"ok": True, **summary, "outputDir": str(output_dir)}
    gusen_hub.append_pull_log(
        "billtype",
        "manual",
        {
            "dataSourceIds": data_source_ids,
            "billTypeCodes": bill_type_codes,
            "exported_bill_type_count": summary.get("exported_bill_type_count", 0),
            "outputDir": str(output_dir),
        },
        payload={
            "datasource": datasource_name,
            "dataSourceIds": data_source_ids,
            "billTypeCodes": bill_type_codes,
        },
        result=result,
        ok=True,
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

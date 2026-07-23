#!/usr/bin/env python3
"""Export Gushen system scripts directly from platform metadata."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import gusen_hub
from export_table_schema_sql import normalize_data_source_ids, resolve_data_source_ids


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = ROOT / "var" / "source" / "readonly"
STANDARD_TYPES = {
    10: ("系统启动初始化脚本", "js"),
    11: ("用户登录初始化脚本", "js"),
    20: ("系统私有JAVASCRIPT", "js"),
    30: ("系统私有CSS脚本", "css"),
    31: ("系统私有H5CSS脚本", "css"),
}


def resolve_output_dir(base_dir=DEFAULT_OUTPUT_DIR, requested=None, config=None):
    if requested:
        return Path(requested)
    config = config or gusen_hub.load_config()
    active, products, projects = gusen_hub.resolve_active(config)
    _item_id, item = (products or projects)[0]
    name = item.get("name")
    if not name:
        raise SystemExit(f"Missing name for sync.ACTIVE: {active}")
    owner = "products" if products else "project"
    return Path(base_dir) / owner / gusen_hub.path_part(name)


def resolve_workcopy_dir(config=None):
    config = config or gusen_hub.load_config()
    active, products, projects = gusen_hub.resolve_active(config)
    _item_id, item = (products or projects)[0]
    name = item.get("name")
    if not name:
        raise SystemExit(f"Missing name for sync.ACTIVE: {active}")
    owner = "products" if products else "projects"
    return ROOT / "var" / "source" / "workcopy" / owner / gusen_hub.path_part(name)


def normalize_values(value):
    if not value:
        return []
    if isinstance(value, str):
        value = value.split(",")
    return [str(item).strip() for item in value if str(item).strip()]


def normalize_script_types(value):
    return [int(item) for item in normalize_values(value)]


def fetch_systems(conn, data_source_ids, system_ids=None):
    ids = normalize_data_source_ids(data_source_ids)
    placeholders = ", ".join(["%s"] * len(ids))
    selected = normalize_values(system_ids)
    params = list(ids)
    system_filter = ""
    if selected:
        system_filter = f" AND SYSTEM_ID IN ({', '.join(['%s'] * len(selected))})"
        params.extend(selected)
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT SYSTEM_ID, SYSTEM_NAME, SYSTEM_ALIAS_ID, DATA_SOURCE_ID "
            f"FROM gd_system WHERE DATA_SOURCE_ID IN ({placeholders}){system_filter}",
            tuple(params),
        )
        return list(cur.fetchall())


def fetch_scripts(conn, system_ids, script_types=None):
    ids = normalize_values(system_ids)
    if not ids:
        return []
    placeholders = ", ".join(["%s"] * len(ids))
    selected_types = normalize_script_types(script_types)
    params = list(ids)
    type_filter = ""
    if selected_types:
        type_filter = f" AND SCRIPT_TYPE IN ({', '.join(['%s'] * len(selected_types))})"
        params.extend(selected_types)
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT SCRIPT_TYPE, SYSTEM_ID, SCRIPT, LAST_UPDATE, CHECK_OUT_USER_ID, "
            f"CHECK_OUT_DATE, CHECK_IN_DATE, PROD_SCRIPT, IS_PRODUCT, USE_REMARK "
            f"FROM gd_system_script WHERE SYSTEM_ID IN ({placeholders}){type_filter}",
            tuple(params),
        )
        return list(cur.fetchall())


def script_info(script_type):
    value = int(script_type)
    if value in STANDARD_TYPES:
        return STANDARD_TYPES[value]
    if 10000 <= value < 20000:
        return "系统私有CSS脚本", "css"
    if value >= 20000:
        return "系统私有JAVASCRIPT", "js"
    return f"脚本类型{value}", "js"


def resolve_script(row):
    source = str(row.get("SCRIPT") or "")
    product_source = str(row.get("PROD_SCRIPT") or "")
    if gusen_hub.INHERIT_MARKER.search(source):
        return gusen_hub._resolve_inherited_script(source, product_source), "PRODUCT"
    if not source and row.get("IS_PRODUCT") and product_source:
        return product_source, "PRODUCT"
    return source, "CURRENT"


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def script_dir_name(script_type, script_type_name, script_description):
    parts = [str(script_type), script_type_name, str(script_description or "").strip()]
    return gusen_hub.path_part("-".join(part for part in parts if part))


def migrate_script_dir(parent, script_type, target):
    if target.exists() or not parent.exists():
        return
    for candidate in parent.iterdir():
        meta_path = candidate / "meta.json"
        if not candidate.is_dir() or not meta_path.exists():
            continue
        try:
            metadata = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if int(metadata.get("scriptType") or 0) == script_type:
            candidate.rename(target)
            return


def change_key(source, row):
    digest = hashlib.sha256()
    digest.update(source.encode("utf-8"))
    digest.update(b"\0")
    digest.update(str(row.get("LAST_UPDATE") or "").encode("utf-8"))
    digest.update(b"\0")
    digest.update(str(row.get("CHECK_IN_DATE") or "").encode("utf-8"))
    digest.update(b"\0")
    digest.update(str(row.get("CHECK_OUT_DATE") or "").encode("utf-8"))
    return f"SHA256:{digest.hexdigest()}"


def export_system_scripts(
    conn,
    output_dir=DEFAULT_OUTPUT_DIR,
    data_source_ids=None,
    system_ids=None,
    script_types=None,
    workcopy_dir=None,
    config=None,
):
    output_dir = Path(output_dir)
    config = config or gusen_hub.load_config()
    data_source_ids = normalize_data_source_ids(data_source_ids)
    if not data_source_ids:
        raise ValueError("data_source_ids is required")
    system_ids = normalize_values(system_ids)
    script_types = normalize_script_types(script_types)

    systems = fetch_systems(conn, data_source_ids, system_ids)
    system_by_id = {str(row.get("SYSTEM_ID") or ""): row for row in systems if row.get("SYSTEM_ID")}
    missing_system_ids = [system_id for system_id in system_ids if system_id not in system_by_id]
    if missing_system_ids:
        raise ValueError(f"System IDs are outside configured system_aliases: {','.join(missing_system_ids)}")
    scripts = fetch_scripts(conn, system_by_id, script_types)
    if script_types and not scripts:
        raise ValueError(f"System script source not found. script_types={','.join(map(str, script_types))}")
    if workcopy_dir and (len(system_ids) != 1 or len(script_types) != 1):
        raise ValueError("workcopy export requires exactly one system_id and one script_type")

    exported = 0
    git_added = 0
    work_copy_paths = []
    work_copy_actions = []
    for row in sorted(scripts, key=lambda item: (str(item.get("SYSTEM_ID") or ""), int(item.get("SCRIPT_TYPE") or 0))):
        system_id = str(row.get("SYSTEM_ID") or "")
        script_type = int(row.get("SCRIPT_TYPE") or 0)
        system = system_by_id.get(system_id)
        if not system or not script_type:
            continue
        script_type_name, extension = script_info(script_type)
        description = str(row.get("USE_REMARK") or "").strip()
        system_name = gusen_hub.path_part(system.get("SYSTEM_NAME") or system_id)
        relative_dir = Path(system_name) / "scripts" / script_dir_name(script_type, script_type_name, description)
        script_dir = output_dir / relative_dir
        migrate_script_dir(script_dir.parent, script_type, script_dir)
        script_dir.mkdir(parents=True, exist_ok=True)
        source, source_origin = resolve_script(row)
        source_change_key = change_key(source, row)
        source_file = f"source.{extension}"
        (script_dir / source_file).write_text(source, encoding="utf-8")
        metadata = {
            "sourceTable": "gd_system_script",
            "systemId": system_id,
            "systemName": system.get("SYSTEM_NAME"),
            "systemAliasId": system.get("SYSTEM_ALIAS_ID"),
            "dataSourceId": system.get("DATA_SOURCE_ID"),
            "scriptType": script_type,
            "scriptTypeName": script_type_name,
            "scriptDescription": description,
            "isProduct": row.get("IS_PRODUCT"),
            "sourceOrigin": source_origin,
            "sourceFile": source_file,
            "lastUpdate": str(row.get("LAST_UPDATE") or ""),
            "checkOutUserId": row.get("CHECK_OUT_USER_ID"),
            "checkOutDate": str(row.get("CHECK_OUT_DATE") or ""),
            "checkInDate": str(row.get("CHECK_IN_DATE") or ""),
            "changeKey": source_change_key,
            "status": "OK" if source else "EMPTY_CONTENT",
        }
        write_json(script_dir / "meta.json", metadata)
        git_added += gusen_hub._auto_add_work_copy(config, script_dir)["gitAdded"]
        if workcopy_dir:
            target = Path(workcopy_dir) / relative_dir
            migrate_script_dir(target.parent, script_type, target)
            work_copy_row = {
                **metadata,
                "source_table": "system-script",
                "source_id": system_id,
                "source_alias_id": system_id,
                "fun_id": str(script_type),
                "source_name": description or script_type_name,
                "change_key": source_change_key,
            }
            result = gusen_hub._prepare_work_copy(script_dir, target, work_copy_row, source_change_key)
            result.update(gusen_hub._auto_add_work_copy(config, target))
            git_added += result["gitAdded"]
            work_copy_paths.append(str(target))
            work_copy_actions.append(result["action"])
        exported += 1

    return {
        "system_count": len(system_by_id),
        "system_script_count": len(scripts),
        "exported_system_script_count": exported,
        "data_source_ids": data_source_ids,
        "system_ids": system_ids,
        "script_types": script_types,
        "work_copy_paths": work_copy_paths,
        "work_copy_actions": work_copy_actions,
        "git_added": git_added,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Export Gushen system scripts directly from platform metadata.")
    parser.add_argument("--datasource", help="Datasource override. Defaults to the product or project selected by sync.ACTIVE.")
    parser.add_argument(
        "--output-dir",
        help="Output directory override. Defaults to var/source/readonly/{products|project}/<active_name>.",
    )
    parser.add_argument(
        "--data-source-ids",
        help="Comma-separated DATA_SOURCE_ID list. Defaults to IDs resolved from config/sync.yaml systems.include.system_aliases.",
    )
    parser.add_argument("--system-ids", help="Comma-separated SYSTEM_ID list. Defaults to all configured systems.")
    parser.add_argument("--script-types", help="Comma-separated SCRIPT_TYPE list. Defaults to all scripts in selected systems.")
    parser.add_argument("--workcopy", action="store_true", help="Create or refresh a workcopy for one selected system script.")
    args = parser.parse_args(argv)

    requested_ids = normalize_data_source_ids(args.data_source_ids) if args.data_source_ids else []
    system_ids = normalize_values(args.system_ids)
    script_types = normalize_script_types(args.script_types)
    config = gusen_hub.load_config()
    output_dir = resolve_output_dir(requested=args.output_dir, config=config)
    datasource_name, datasource = gusen_hub.resolve_datasource(config, args.datasource)
    try:
        with gusen_hub.db_connect(datasource) as conn:
            data_source_ids = resolve_data_source_ids(conn, datasource_name, requested_ids)
            summary = export_system_scripts(
                conn,
                output_dir,
                data_source_ids,
                system_ids,
                script_types,
                resolve_workcopy_dir(config) if args.workcopy else None,
                config,
            )
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2

    result = {"ok": True, **summary, "outputDir": str(output_dir)}
    gusen_hub.append_pull_log(
        "system-scripts",
        "manual",
        {
            "dataSourceIds": data_source_ids,
            "systemIds": system_ids,
            "scriptTypes": script_types,
            "exported_system_script_count": summary["exported_system_script_count"],
            "workCopyPaths": summary["work_copy_paths"],
            "outputDir": str(output_dir),
        },
        payload={
            "datasource": datasource_name,
            "dataSourceIds": data_source_ids,
            "systemIds": system_ids,
            "scriptTypes": script_types,
        },
        result=result,
        ok=True,
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

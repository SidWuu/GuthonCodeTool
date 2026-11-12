"""Explicit metadata/document exports from the current API checkout, never a mirror."""

from __future__ import annotations
import argparse
import json
from pathlib import Path
import xml.etree.ElementTree as ET
from common import gusen_hub
from common.persistence import atomic_text
from .client import ApiError
from .store import ApiStore


def parser(kind):
    parser = argparse.ArgumentParser(description="从当前项目API源码导出" + kind)
    parser.add_argument("--workspace")
    parser.add_argument("--output-dir")
    parser.add_argument("--data-source-ids", default="")
    parser.add_argument("--system-ids", default="")
    parser.add_argument("--table-ids", default="")
    parser.add_argument("--view-ids", default="")
    parser.add_argument("--script-types", default="")
    return parser


def main(kind, argv=None):
    args = parser(kind).parse_args(argv)
    workspace = gusen_hub.resolve_workspace(gusen_hub.load_config(), args.workspace)
    dest = (
        Path(args.output_dir).expanduser().resolve()
        if args.output_dir
        else workspace["docsDir"] / "exports" / kind
    )
    checkout = workspace["providerSourceRoot"].resolve()
    if dest.resolve() == checkout or checkout in dest.resolve().parents:
        raise ApiError(
            "API_EXPORT_PATH_INVALID",
            "导出资料必须位于checkout之外，不能成为第二套可上传源码",
        )
    filters = {
        k: set(v.split(",")) if v else set()
        for k, v in [
            ("dataSourceId", args.data_source_ids),
            ("systemId", args.system_ids),
            ("tableId", args.table_ids),
            ("viewId", args.view_ids),
            ("scriptType", args.script_types),
        ]
    }
    exported = []
    for item in ApiStore(workspace).objects():
        m = item["metadata"]
        if m["sourceType"] != kind or any(
            ids and str(m.get(key)) not in ids for key, ids in filters.items()
        ):
            continue
        content = item["content"]
        relative = Path(item["path"])
        if kind == "view":
            try:
                value = json.loads(content)
            except json.JSONDecodeError:
                try:
                    node = ET.fromstring(content)
                except ET.ParseError as error:
                    raise ApiError(
                        "API_VIEW_FORMAT_UNSUPPORTED",
                        "视图格式不支持SQL投影，请先查看原文",
                    ) from error
                sql = node.find(".//viewSql")
                if sql is None:
                    raise ApiError("API_VIEW_FORMAT_UNSUPPORTED", "视图未提供viewSql")
                content = sql.text or ""
            else:
                if isinstance(value, str):
                    value = json.loads(value)
                if not isinstance(value, dict) or not isinstance(
                    value.get("viewSql"), str
                ):
                    raise ApiError("API_VIEW_FORMAT_UNSUPPORTED", "视图未提供viewSql")
                content = value["viewSql"]
            relative = relative.with_suffix(".sql")
        target = dest / relative
        atomic_text(target, content)
        exported.append(str(target))
    if not exported:
        raise ApiError(
            "API_EXPORT_EMPTY", "当前范围尚无所选源码，请先拉取或检查筛选条件"
        )
    result = {
        "ok": True,
        "workspaceKey": workspace["workspaceKey"],
        "outputDir": str(dest),
        "exported": exported,
        "sourceProvider": "api",
        "uploadable": False,
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0

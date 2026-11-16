"""Official API source decoding, pagination and exact object retrieval."""

from __future__ import annotations
from dataclasses import dataclass
import hashlib
import json
from pathlib import PurePosixPath
from common.operation_control import checkpoint
from .client import ApiError

BASE = "/develop/vscode/source/download/"


@dataclass(frozen=True)
class SourceFile:
    path: str
    content: str
    kind: str
    metadata: dict
    readonly: bool = False


def records(data):
    result = (
        data
        if isinstance(data, list)
        else data.get("list")
        if isinstance(data, dict)
        else None
    )
    if not isinstance(result, list) or any(not isinstance(x, dict) for x in result):
        raise ApiError("API_RESPONSE_INVALID", "源码列表应为对象数组")
    return result


def paged(client, path, params=None):
    data = client.request(path, params)
    result, seen = [], set()
    while True:
        checkpoint()
        batch = records(data)
        guid = data.get("guid") if isinstance(data, dict) else None
        signature = hashlib.sha256(
            json.dumps([guid, batch], sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()
        if signature in seen:
            raise ApiError(
                "API_PAGINATION_INVALID", "分页返回重复内容，未发布不完整源码"
            )
        seen.add(signature)
        result.extend(batch)
        if not guid:
            return result
        if not isinstance(guid, str):
            raise ApiError("API_RESPONSE_INVALID", "分页 guid 类型无效")
        data = client.request(BASE + "getNextPage.htm", {"guid": guid})


def source_file(path, content, kind, metadata, readonly=False):
    if not isinstance(content, str):
        raise ApiError("API_RESPONSE_INVALID", "源码正文必须是字符串")
    if (
        not isinstance(path, str)
        or "\\" in path
        or any(ord(x) < 32 or ord(x) == 127 for x in path)
        or ":" in path
    ):
        raise ApiError("API_SOURCE_PATH_INVALID", "平台返回无效源码路径")
    parts = path.split("/")
    if (
        not parts
        or any(x in {"", ".", ".."} for x in parts)
        or PurePosixPath(path).is_absolute()
    ):
        raise ApiError("API_SOURCE_PATH_INVALID", "平台源码路径越界")
    return SourceFile(path, content, kind, metadata, readonly)


def required(obj, keys):
    if not isinstance(obj, dict) or any(obj.get(k) in (None, "") for k in keys):
        raise ApiError("API_IDENTITY_MISSING", "源码对象缺少身份：" + ", ".join(keys))


def page_files(page, sid):
    required(page, ("pageId", "pageSubId", "fileName"))
    if str(page.get("systemId", sid)) != sid:
        raise ApiError("API_IDENTITY_MISMATCH", "页面子系统不匹配")
    parent = f"systems/{sid}/pages/{page['pageSubId']}/{page['pageId']}"
    meta = {
        k: page[k]
        for k in (
            "pageId",
            "pageSubId",
            "pageType",
            "pageAliasId",
            "versionMac",
            "checkOutUserId",
            "isInhert",
            "fileName",
            "superFileName",
            "pageName",
            "title",
        )
        if k in page
    }
    meta["systemId"] = sid
    files = [
        source_file(parent + "/" + page["fileName"], page.get("xml"), "page", meta)
    ]
    if (
        str(page.get("pageType")) == "0"
        and str(page.get("isInhert")) == "1"
        and page.get("superFileName")
        and isinstance(page.get("superScript"), str)
    ):
        files.append(
            source_file(
                parent + "/" + page["superFileName"],
                page["superScript"],
                "page-inherit",
                meta,
                True,
            )
        )
    return files


def function_files(fun, ds, subpath, procedure_id):
    required(fun, ("funId",))
    meta = {
        k: fun[k]
        for k in (
            "funId",
            "funName",
            "versionMac",
            "checkOutUserId",
            "isTran",
            "isReturn",
            "isInhert",
            "description",
        )
        if k in fun
    }
    meta.update(
        dataSourceId=ds,
        subPath=subpath,
        procedureId=procedure_id,
        procedureAliasId=str(subpath).replace("/", "."),
    )
    parent = f"datasources/{ds}/procedures/{subpath}/{fun['funId']}"
    files = [source_file(parent + ".gss", fun.get("funScript"), "procedure", meta)]
    if str(fun.get("isInhert")) == "1" and isinstance(fun.get("prodScript"), str):
        files.append(
            source_file(
                parent + ".inherit.gss",
                fun["prodScript"],
                "procedure-inherit",
                meta,
                True,
            )
        )
    return files


def object_files(obj, kind, ds):
    key, folder, suffix, field = (
        ("tableId", "tables", ".json", "json")
        if kind == "table"
        else ("viewId", "views", ".xml", "xml")
    )
    required(obj, (key,))
    if str(obj.get("dataSourceId", ds)) != ds:
        raise ApiError("API_IDENTITY_MISMATCH", "数据源身份不匹配")
    meta = {
        k: obj[k] for k in (key, "pkid", "versionMac", "checkOutUserId") if k in obj
    }
    meta["dataSourceId"] = ds
    return [
        source_file(
            f"datasources/{ds}/{folder}/{obj[key]}{suffix}", obj.get(field), kind, meta
        )
    ]


def script_files(script):
    required(script, ("systemId",))
    if script.get("scriptType") is None:
        raise ApiError("API_IDENTITY_MISSING", "系统脚本缺少类型")
    meta = {
        k: script[k]
        for k in ("systemId", "scriptType", "versionMac", "checkOutUserId")
        if k in script
    }
    meta["systemId"] = str(meta["systemId"])
    meta["scriptType"] = str(meta["scriptType"])
    parent = f"systems/{meta['systemId']}/system-script/{meta['scriptType']}"
    files = [source_file(parent + ".js", script.get("script"), "system-script", meta)]
    if isinstance(script.get("prodScript"), str):
        files.append(
            source_file(
                parent + ".inherit.js",
                script["prodScript"],
                "system-script-inherit",
                meta,
                True,
            )
        )
    return files


def project_files(client):
    files = []
    for kind, endpoint in [
        ("config", "getOtherConfig.htm"),
        ("skill", "getSkills.htm"),
    ]:
        data = client.request(BASE + endpoint)
        if not isinstance(data, dict) or not isinstance(data.get("files"), list):
            raise ApiError("API_RESPONSE_INVALID", "平台资料应答缺少files")
        for item in data["files"]:
            required(item, ("path",))
            # The official package paths are kept below checkout and never executed.
            files.append(
                source_file(
                    item["path"].replace("\\", "/").lstrip("/"),
                    item.get("context"),
                    kind,
                    {"managedBy": "official-api"},
                    True,
                )
            )
    return files


def download(client, config, *, on_project=None):
    client.ensure_login()
    systems = records(client.request("/develop/systems/apps/developSystemList.htm"))
    by_id = {str(x["systemId"]): x for x in systems if x.get("systemId") is not None}
    selected = list(by_id) if config["allSystems"] else config["systemIds"]
    if not selected:
        raise ApiError("API_SCOPE_REQUIRED", "请选择子系统，空选择不会自动拉取全部源码")
    if set(selected) - set(by_id):
        raise ApiError("API_SCOPE_INVALID", "选择的子系统不在当前平台项目中")
    data_sources = set(config["dataSourceIds"])
    data_sources.update(
        str(by_id[sid]["dataSourceId"])
        for sid in selected
        if by_id[sid].get("dataSourceId") not in (None, "")
    )
    if not data_sources:
        raise ApiError(
            "API_DATA_SOURCE_REQUIRED",
            "平台未返回子系统的数据源关联，请明确配置共享数据源 ID",
        )
    available = records(client.request("/develop/systems/datasource/list.htm"))
    if data_sources - {str(x.get("dataSourceId")) for x in available}:
        raise ApiError("API_SCOPE_INVALID", "配置的数据源不在当前平台项目中")
    if on_project:
        on_project(systems, available)
    files = []
    for sid in selected:
        for page in paged(client, BASE + "getModulePages.htm", {"systemId": sid}):
            files.extend(page_files(page, sid))
    for script in records(client.request(BASE + "getSystemScripts.htm")):
        if str(script.get("systemId")) in selected:
            files.extend(script_files(script))
    for ds in sorted(data_sources):
        for proc in paged(client, BASE + "getProcedures.htm", {"dataSourceId": ds}):
            required(proc, ("subPath", "procedureId"))
            if str(proc.get("dataSourceId", ds)) != ds:
                raise ApiError("API_IDENTITY_MISMATCH", "过程包数据源不匹配")
            for fun in records(proc.get("funs")):
                files.extend(
                    function_files(fun, ds, proc["subPath"], proc["procedureId"])
                )
        for kind, endpoint in [("table", "getTables.htm"), ("view", "getViews.htm")]:
            for obj in records(client.request(BASE + endpoint, {"dataSourceId": ds})):
                files.extend(object_files(obj, kind, ds))
    from .module_parameters import download_parameters
    files.extend(download_parameters(client, [by_id[sid] for sid in selected]))
    if config.get("includeProjectFiles", True):
        files.extend(project_files(client))
    paths = [x.path.casefold() for x in files]
    if len(paths) != len(set(paths)):
        raise ApiError("API_IDENTITY_AMBIGUOUS", "下载对象映射到重复文件")
    return files, {
        "systemIds": selected,
        "dataSourceIds": sorted(data_sources),
        "dataSourceScope": "shared-datasource",
    }


def fetch_object(client, metadata):
    """Fetch exactly one known object, including its inherited companion."""
    kind = metadata["sourceType"]
    m = metadata
    if kind == "page":
        endpoint = "getModulePage.htm"
        params = {"pageId": m["pageId"]}
    elif kind == "procedure":
        endpoint = "getProcFun.htm"
        params = {k: m[k] for k in ("procedureId", "funId")}
    elif kind in {"table", "view"}:
        endpoint = "getTable.htm" if kind == "table" else "getView.htm"
        params = {
            "tableId" if kind == "table" else "viewId": m[
                "tableId" if kind == "table" else "viewId"
            ],
            "dataSourceId": m["dataSourceId"],
        }
    elif kind == "system-script":
        endpoint = "getSystemScript.htm"
        params = {k: m[k] for k in ("systemId", "scriptType")}
    else:
        raise ApiError("API_REFRESH_UNSUPPORTED", "请选择可刷新的源码对象")
    data = client.request(BASE + endpoint, params)
    item = data.get("item") if isinstance(data, dict) else None
    if not isinstance(item, dict):
        raise ApiError("API_SOURCE_NOT_FOUND", "平台未返回此精确源码对象")
    return files_from_item(metadata, item)


def files_from_item(metadata, item, *, expected_path=None):
    """Decode one official download/upload item within the requested identity."""
    kind = metadata["sourceType"]
    m = metadata
    if not isinstance(item, dict):
        raise ApiError("API_RESPONSE_INVALID", "平台未返回完整源码 item")
    identity_keys = {
        "page": ("pageId",),
        "procedure": ("funId",),
        "table": ("tableId",),
        "view": ("viewId",),
        "system-script": ("systemId", "scriptType"),
    }[kind]
    if any(str(item.get(k)) != str(m[k]) for k in identity_keys):
        raise ApiError("API_IDENTITY_MISMATCH", "平台返回的对象与请求身份不一致")
    for key in ("systemId", "dataSourceId", "procedureId", "subPath", "pkid"):
        if key in item and key in m and str(item[key]) != str(m[key]):
            raise ApiError("API_IDENTITY_MISMATCH", "平台返回的对象上下文与请求不一致")
    if kind == "page":
        files = page_files(item, str(m["systemId"]))
    elif kind == "procedure":
        files = function_files(
            item, str(m["dataSourceId"]), m["subPath"], m["procedureId"]
        )
    elif kind in {"table", "view"}:
        files = object_files(item, kind, str(m["dataSourceId"]))
    else:
        files = script_files(item)
    primary = [file for file in files if file.kind == kind]
    if expected_path is not None and (
        len(primary) != 1 or primary[0].path != expected_path
    ):
        raise ApiError("API_REMOTE_PATH_CHANGED", "平台返回的源码路径与提交对象不一致")
    return files

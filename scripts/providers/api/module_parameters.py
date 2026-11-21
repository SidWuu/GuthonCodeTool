"""Identity-bound module parameter downloads and full response snapshots."""
from __future__ import annotations

import json
from urllib.parse import quote

from common.operation_control import checkpoint
from common.persistence import file_lock
from .client import ApiError
from .download import records, required, source_file

BASE = "/develop/dev/models/config/"
SOURCE_TYPE = "module-parameter"
DIRECTORY_TYPE = "module-parameter-directory"
DIRECTORY_PATH = "otherconfig/module-parameters.json"


def _check_identity(value, system_id, config_id=None):
    required(value, ("systemId", "configId"))
    if not isinstance(value["systemId"], str) or not isinstance(value["configId"], str):
        raise ApiError("API_IDENTITY_MISMATCH", "模块参数身份必须为字符串")
    if value["systemId"] != system_id or config_id is not None and value["configId"] != config_id:
        raise ApiError("API_IDENTITY_MISMATCH", "模块参数返回了其他系统或参数的内容")
    identity = value.get("id")
    if identity is not None and (not isinstance(identity, dict) or any(
        identity.get(key) != value[key] for key in ("systemId", "configId")
    )):
        raise ApiError("API_IDENTITY_MISMATCH", "模块参数复合身份与顶层编码不一致")


def snapshot_path(system_id, config_id):
    return f"systems/{system_id}/module-parameters/{quote(config_id, safe='')}.json"


def directory_entries(text):
    try:
        value = json.loads(text)
    except (ValueError, TypeError) as error:
        raise ApiError("API_MODULE_DIRECTORY_INVALID", "模块参数清单不是有效 JSON") from error
    if not isinstance(value, dict) or value.get("schemaVersion") != 1 or not isinstance(value.get("systems"), list):
        raise ApiError("API_MODULE_DIRECTORY_INVALID", "模块参数清单格式无效")
    entries, systems, identities = [], set(), set()
    for system in value["systems"]:
        if not isinstance(system, dict) or not all(key in system for key in ("systemId", "dataSourceId", "parameters")):
            raise ApiError("API_MODULE_DIRECTORY_INVALID", "模块参数清单缺少子系统字段")
        sid = system["systemId"]
        if not isinstance(sid, str) or not isinstance(system["dataSourceId"], str) or sid in systems or not isinstance(system["parameters"], list):
            raise ApiError("API_MODULE_DIRECTORY_INVALID", "模块参数清单子系统身份无效或重复")
        systems.add(sid)
        for item in system["parameters"]:
            _check_identity(item, sid)
            if "configName" in item and not isinstance(item["configName"], str):
                raise ApiError("API_RESPONSE_INVALID", "模块参数名称必须为字符串")
            identity = (sid, item["configId"].casefold())
            if identity in identities:
                raise ApiError("API_IDENTITY_AMBIGUOUS", "模块参数清单包含重复身份")
            identities.add(identity)
            entries.append({**item, "dataSourceId": system["dataSourceId"],
                            "snapshotPath": snapshot_path(sid, item["configId"])})
    return entries


def download_parameters(client, systems):
    blocks, seen = [], {}
    for system in systems:
        sid = str(system["systemId"])
        source = str(system.get("dataSourceId") or "")
        if sid in seen:
            if seen[sid] != source:
                raise ApiError("API_IDENTITY_AMBIGUOUS", "同一子系统映射到不同数据源")
            continue
        seen[sid] = source
        response = client.request(BASE + "getConfigs.htm", form={"systemId": sid, "tempId": "", "flName": ""})
        rows, identities = [], {}
        for item in records(response):
            checkpoint(); _check_identity(item, sid)
            identity = item["configId"].casefold()
            if identity in identities:
                if identities[identity] == item:
                    continue
                raise ApiError("API_IDENTITY_AMBIGUOUS", "模块参数列表包含冲突的重复身份")
            identities[identity] = item; rows.append(item)
        blocks.append({"systemId": sid, "dataSourceId": source, "parameters": rows})
    content = json.dumps({"schemaVersion": 1, "systems": blocks}, ensure_ascii=False, indent=2) + "\n"
    entries = directory_entries(content)
    return [source_file(DIRECTORY_PATH, content, DIRECTORY_TYPE,
                        {"managedBy": "official-module-api", "parameterCount": len(entries)}, True)]


def load_parameter(workspace, client, payload):
    """Fetch one listed parameter; retain local edits through the normal publisher."""
    from .workspace import active_scope
    from .store import ApiStore
    from .index import update
    sid, config_id = payload.get("systemId"), payload.get("configId")
    if not isinstance(sid, str) or not isinstance(config_id, str) or not sid or not config_id:
        raise ApiError("API_IDENTITY_MISSING", "请选择清单中的明确模块参数")
    if sid not in active_scope(workspace)["systemIds"]:
        raise ApiError("API_SOURCE_OUT_OF_SCOPE", "模块参数不属于当前子系统范围")
    store = ApiStore(workspace); client.ensure_login()
    with file_lock(store.directory / "sync.lock"):
        directory = store.read(DIRECTORY_PATH)
        entry = next((item for item in directory_entries(directory["content"])
                      if item["systemId"] == sid and item["configId"] == config_id), None)
        if entry is None:
            raise ApiError("API_MODULE_NOT_LISTED", "当前清单未登记此模块参数，请先同步清单")
        item = fetch_parameter(client, entry)
        result = store.publish([item])
        result["index"] = update(workspace, [item.path])
        current = store.read(item.path)
    return {**result, "path": item.path, "systemId": sid, "configId": config_id,
            "sourceHash": current["sourceHash"], "downloadedFiles": 1, "detailRequests": 1,
            "platformWrites": 0, "complete": result["complete"] and result["index"]["complete"]}


def snapshot_file(detail, system_id, config_id, data_source_id=""):
    if not isinstance(detail,dict) or not isinstance(detail.get("bean"),dict):
        raise ApiError("API_RESPONSE_INVALID","模块参数详情缺少 bean 身份")
    _check_identity(detail["bean"],system_id,config_id)
    bean=detail["bean"]
    metadata={key:bean[key] for key in ("systemId","configId","configName","tempId","isProduct","configFlag","lastUpdate","checkOutUserId","checkOutDate") if key in bean}
    if "configName" in metadata and not isinstance(metadata["configName"],str):
        raise ApiError("API_RESPONSE_INVALID","模块参数名称必须为字符串")
    metadata.update(dataSourceId=data_source_id,snapshotKind="platform-response",managedBy="official-module-api")
    return source_file(snapshot_path(system_id, config_id),
                       json.dumps(detail,ensure_ascii=False,indent=2)+"\n",SOURCE_TYPE,metadata,False)


def fetch_parameter(client, metadata):
    detail=client.request(BASE+"getConfig.htm",form={"systemId":metadata["systemId"],"configId":metadata["configId"]})
    return snapshot_file(detail,metadata["systemId"],metadata["configId"],metadata.get("dataSourceId",""))


def sync_parameters(workspace, client, system_id=None):
    from .workspace import active_scope, project_metadata
    from .store import ApiStore
    from .index import update

    scope = active_scope(workspace)
    selected = set(scope["systemIds"])
    if not selected:
        raise ApiError("API_SCOPE_REQUIRED", "请先选择当前项目的子系统范围")
    by_id = {str(item["systemId"]): item for item in project_metadata(workspace).get("systems", [])}
    if selected - set(by_id):
        raise ApiError("API_SCOPE_INVALID", "当前范围缺少子系统身份，请先刷新平台目录")
    store = ApiStore(workspace)
    if system_id is not None and (not isinstance(system_id,str) or system_id not in selected):
        raise ApiError("API_SOURCE_OUT_OF_SCOPE", "模块参数不属于当前子系统范围")
    client.ensure_login()
    with file_lock(store.directory / "sync.lock"):
        files = download_parameters(client, [by_id[key] for key in ([system_id] if system_id else sorted(selected))])
        if system_id:
            listed=json.loads(files[0].content)
            try:
                saved=store.read(DIRECTORY_PATH)
            except ApiError as error:
                if error.code!="API_SOURCE_NOT_FOUND":
                    raise
            else:
                previous=json.loads(saved["content"])
                present={item["systemId"]:item for item in previous["systems"] if item["systemId"] in selected}
                present[system_id]=listed["systems"][0]
                listed["systems"]=[present[key] for key in sorted(present)]
            content=json.dumps(listed,ensure_ascii=False,indent=2)+"\n"
            files=[source_file(DIRECTORY_PATH,content,DIRECTORY_TYPE,
                               {"managedBy":"official-module-api","parameterCount":len(directory_entries(content))},True)]
        result = store.publish(files, scope={**scope, "systemIds": sorted(selected),
                               "dataSourceIds": sorted(scope["dataSourceIds"])})
        result["index"] = update(workspace, [item.path for item in files] + result["deleted"])
    return {**result, "downloadedParameters": len(directory_entries(files[0].content)),
            "downloadedFiles": len(files), "detailRequests": 0, "platformWrites": 0, "downloadComplete": result["complete"],
            "complete": result["complete"] and result["index"]["complete"], "readonly": True}

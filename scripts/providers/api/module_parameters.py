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


def download_parameters(client, systems):
    files, identities = [], set()
    for system in systems:
        system_id = str(system["systemId"])
        response = client.request(BASE + "getConfigs.htm", form={
            "systemId": system_id, "tempId": "", "flName": "",
        })
        for item in records(response):
            checkpoint()
            _check_identity(item, system_id)
            config_id = item["configId"]
            identity = (system_id, config_id.casefold())
            if identity in identities:
                raise ApiError("API_IDENTITY_AMBIGUOUS", "模块参数列表包含重复身份")
            identities.add(identity)
            detail = client.request(BASE + "getConfig.htm", form={
                "systemId": system_id, "configId": config_id,
            })
            files.append(snapshot_file(detail, system_id, config_id, str(system.get("dataSourceId") or "")))
    return files


def snapshot_file(detail, system_id, config_id, data_source_id=""):
    if not isinstance(detail,dict) or not isinstance(detail.get("bean"),dict):
        raise ApiError("API_RESPONSE_INVALID","模块参数详情缺少 bean 身份")
    _check_identity(detail["bean"],system_id,config_id)
    bean=detail["bean"]
    metadata={key:bean[key] for key in ("systemId","configId","configName","tempId","isProduct","configFlag","lastUpdate","checkOutUserId","checkOutDate") if key in bean}
    if "configName" in metadata and not isinstance(metadata["configName"],str):
        raise ApiError("API_RESPONSE_INVALID","模块参数名称必须为字符串")
    metadata.update(dataSourceId=data_source_id,snapshotKind="platform-response",managedBy="official-module-api")
    return source_file(f"systems/{system_id}/module-parameters/{quote(config_id,safe='')}.json",
                       json.dumps(detail,ensure_ascii=False,indent=2)+"\n",SOURCE_TYPE,metadata,False)


def fetch_parameter(client, metadata):
    detail=client.request(BASE+"getConfig.htm",form={"systemId":metadata["systemId"],"configId":metadata["configId"]})
    return snapshot_file(detail,metadata["systemId"],metadata["configId"],metadata.get("dataSourceId",""))


def sync_parameters(workspace, client):
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
    client.ensure_login()
    with file_lock(store.directory / "sync.lock"):
        files = download_parameters(client, [by_id[key] for key in sorted(selected)])
        result = store.publish(files, scope={**scope, "systemIds": sorted(selected),
                               "dataSourceIds": sorted(scope["dataSourceIds"])}, authoritative=True,
                               authoritative_source_types={SOURCE_TYPE})
        result["index"] = update(workspace, [item.path for item in files] + result["deleted"])
    return {**result, "downloadedParameters": len(files), "platformWrites": 0,
            "complete": result["complete"] and result["index"]["complete"], "readonly": False}

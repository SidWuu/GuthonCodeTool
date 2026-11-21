"""Preview-bound module parameter saves with checkout ownership and no implicit check-in."""
from __future__ import annotations

import base64
import difflib
import json
import uuid
from pathlib import Path
from urllib.parse import quote

from common.persistence import atomic_text, file_lock
from .client import ApiError
from .download import records
from .store import ApiStore, digest
from .workspace import api_paths
from .editor_state import assert_writable
from .module_parameters import BASE, SOURCE_TYPE, fetch_parameter
from .module_parameter_editor import extract_data, parse_json, validate_candidate
from .documents import _identifier

_UNCERTAIN = {"API_CONNECTION_FAILED", "API_HTTP_ERROR", "API_RESPONSE_INVALID"}
_DONE = {"REMOTE_READBACK_VERIFIED", "ALREADY_REMOTE"}


def checkout_owners(client, identities):
    owners = {}
    for row in records(client.request(BASE + "version/getCheckOutList.htm", form={"showAllUser":1})):
        identity = (row.get("systemId"), row.get("configId"))
        if identity not in identities:
            continue
        if identity in owners or not isinstance(row.get("checkOutUserId"), str) or not row["checkOutUserId"]:
            raise ApiError("API_MODULE_CHECKOUT_UNCONFIRMED", "无法唯一确认目标模块参数的签出者")
        owners[identity] = row["checkOutUserId"]
    return owners


def source_version(content):
    # Only the parameter data and template govern a save. Checkout timestamps are not a data revision.
    value = json.loads(content)
    return digest(json.dumps({key:value[key] for key in ("data","template") if key in value},ensure_ascii=False,sort_keys=True))


def pending_file(workspace, path):
    directory, _ = api_paths(workspace)
    return directory / "module-upload-pending" / (digest(path) + ".json")


def prepare(workspace, client, payload):
    paths = payload.get("paths")
    if not isinstance(paths,list) or not 1<=len(paths)<=50 or any(not isinstance(path,str) for path in paths):
        raise ApiError("API_INPUT_INVALID", "模块参数上传需要 1 至 50 个明确路径")
    paths = list(dict.fromkeys(paths))
    store = ApiStore(workspace)
    user_id = (client.session or {}).get("userId")
    if not isinstance(user_id,str) or not user_id:
        raise ApiError("API_LOGIN_REQUIRED", "当前会话缺少上传用户身份")
    assert_writable(workspace, paths)
    current = [store.read(path) for path in paths]
    if any(item["metadata"].get("sourceType")!=SOURCE_TYPE or item["readonly"] for item in current):
        raise ApiError("API_MODULE_REQUIRED", "请选择已打开编辑的模块参数，不可混入其他源码")
    identities = {(item["metadata"]["systemId"], item["metadata"]["configId"]) for item in current}
    owners = checkout_owners(client,identities)
    items, diffs = [], []
    for item in current:
        path,m=item["path"],item["metadata"]
        pending=pending_file(workspace,path)
        if pending.exists():
            record=json.loads(pending.read_text())
            raise ApiError("API_MODULE_UPLOAD_PENDING", "此前上传尚待核对，请先查看操作记录："+record["operationId"])
        baseline=store.baseline(path)
        validate_candidate(baseline,item["content"],m)
        remote=fetch_parameter(client,m)
        local_data=extract_data(item["content"],m);remote_data=extract_data(remote.content,m)
        equal=parse_json(local_data)==parse_json(remote_data)
        if not equal and source_version(baseline)!=source_version(remote.content):
            raise ApiError("API_MODULE_REMOTE_CHANGED", "平台参数或模板已变化，请先同步并核对本地差异")
        owner=owners.get((m["systemId"],m["configId"]),"")
        if not equal and owner and owner!=user_id:
            raise ApiError("API_MODULE_CHECKED_OUT_BY_OTHER", "目标参数已由其他用户签出，不执行强制覆盖")
        diff=''.join(difflib.unified_diff(remote_data.splitlines(keepends=True),local_data.splitlines(keepends=True),fromfile='platform',tofile='local'))
        items.append({"path":path,"localHash":item["sourceHash"],"remoteVersion":source_version(remote.content),
                      "metadata":m,"owner":owner,"alreadyRemote":equal,"checkoutRequired":not equal and not owner,
                      "content":item["content"],"data":local_data})
        diffs.append({"path":path,"systemId":m["systemId"],"configId":m["configId"],"name":m.get("configName",m["configId"]),
                      "checkoutRequired":not equal and not owner,"alreadyRemote":equal,"diff":diff[:12000],"diffTruncated":len(diff)>12000})
    plan_id=uuid.uuid4().hex
    plan={"workspaceKey":workspace["workspaceKey"],"planId":plan_id,"userId":user_id,"items":items}
    plan_hash=digest(json.dumps(plan,sort_keys=True,ensure_ascii=False))
    directory,_=api_paths(workspace)
    atomic_text(directory/"module-upload-plans"/(plan_id+".json"),json.dumps({**plan,"planHash":plan_hash},ensure_ascii=False))
    return {"workspaceKey":workspace["workspaceKey"],"planId":plan_id,"planHash":plan_hash,"items":diffs,"platformFinalSubmit":"NOT_PERFORMED"}


def upload(workspace, client, payload):
    plan_id=_identifier(payload.get("planId"));directory,_=api_paths(workspace)
    plan=json.loads((directory/"module-upload-plans"/(plan_id+".json")).read_text())
    calculated=digest(json.dumps({key:value for key,value in plan.items() if key!="planHash"},sort_keys=True,ensure_ascii=False))
    if calculated!=plan.get("planHash"):
        raise ApiError("API_MODULE_UPLOAD_PLAN_MISMATCH","上传预览文件内容与绑定哈希不一致")
    if plan.get("workspaceKey")!=workspace["workspaceKey"] or plan.get("planHash")!=payload.get("planHash") or payload.get("confirm") is not True:
        raise ApiError("API_MODULE_UPLOAD_PLAN_MISMATCH", "请确认当前项目的准确上传预览")
    user_id=(client.session or {}).get("userId")
    if user_id!=plan["userId"]:
        raise ApiError("API_MODULE_UPLOAD_PLAN_MISMATCH", "上传用户已变化，请重新预览")
    store=ApiStore(workspace)
    with file_lock(directory/"sync.lock"):
        existing=directory/"operations"/plan_id/"record.json"
        if existing.exists():
            return store.operation(plan_id)
        paths=[item["path"] for item in plan["items"]]
        assert_writable(workspace,paths)
        identities={(item["metadata"]["systemId"],item["metadata"]["configId"]) for item in plan["items"]}
        owners=checkout_owners(client,identities)
        # Freeze and validate the whole request before the first checkout or save.
        for item in plan["items"]:
            current=store.read(item["path"]);m=item["metadata"]
            if current["readonly"] or current["sourceHash"]!=item["localHash"]:
                raise ApiError("API_SOURCE_STALE", "预览后本地参数已变化，请重新预览")
            validate_candidate(store.baseline(item["path"]),current["content"],m)
            remote=fetch_parameter(client,m)
            if source_version(remote.content)!=item["remoteVersion"] or owners.get((m["systemId"],m["configId"]),"")!=item["owner"]:
                raise ApiError("API_MODULE_REMOTE_CHANGED", "预览后平台参数、模板或签出者已变化")
            if pending_file(workspace,item["path"]).exists():
                raise ApiError("API_MODULE_UPLOAD_PENDING", "该参数已有待核对的上传")
        operation={"operationId":plan_id,"workspaceKey":workspace["workspaceKey"],"kind":"module-upload",
                   "paths":paths,"stage":"PREPARED","results":[],"platformFinalSubmit":"NOT_PERFORMED"}
        store._receipt(operation)
        for item in plan["items"]:
            path,m=item["path"],item["metadata"]
            result={"path":path,"stage":"PREPARED","saveAttempted":False,"submittedHash":item["localHash"]}
            operation["results"].append(result)
            atomic_text(directory/"operations"/plan_id/("submitted-"+digest(path)+".json"),item["content"])
            store._receipt(operation)
            try:
                if item["alreadyRemote"]:
                    remote=fetch_parameter(client,m)
                    result["stage"]="ALREADY_REMOTE"
                else:
                    atomic_text(pending_file(workspace,path),json.dumps({"operationId":plan_id,"workspaceKey":workspace["workspaceKey"]}))
                    if item["checkoutRequired"]:
                        result["stage"]="CHECKOUT_REQUEST_STARTED";store._receipt(operation)
                        try:
                            client.request(BASE+"version/checkOut.htm",form={"systemId":m["systemId"],"configId":m["configId"]})
                        except ApiError as error:
                            if error.code not in _UNCERTAIN:
                                result["stage"]="CHECKOUT_REJECTED"
                                raise
                        owner=checkout_owners(client,{(m["systemId"],m["configId"])})
                        if owner.get((m["systemId"],m["configId"]))!=user_id:
                            raise ApiError("API_MODULE_CHECKOUT_UNCONFIRMED","签出结果尚未确认，不继续保存")
                        result["checkedOut"]=True;result["stage"]="CHECKOUT_VERIFIED"
                    remote=fetch_parameter(client,m)
                    if source_version(remote.content)!=item["remoteVersion"]:
                        raise ApiError("API_MODULE_REMOTE_CHANGED","签出后平台参数或模板已变化，未保存")
                    if store.read(path)["sourceHash"]!=item["localHash"]:
                        raise ApiError("API_SOURCE_STALE","上传前本地参数已变化，未保存")
                    assert_writable(workspace,[path])
                    result.update(stage="SAVE_REQUEST_STARTED",saveAttempted=True);store._receipt(operation)
                    response_error=None
                    try:
                        client.request(BASE+"saveConfigContext.htm",form={"systemId":m["systemId"],"configId":m["configId"],"isBase64":1,
                            "json":quote(base64.b64encode(item["data"].encode("utf-8")).decode(),safe=""),"flag":0})
                        result["stage"]="REMOTE_ACKNOWLEDGED";store._receipt(operation)
                    except ApiError as error:
                        if error.code not in _UNCERTAIN:
                            result["stage"]="REMOTE_REJECTED"
                            raise
                        response_error=error
                    remote=fetch_parameter(client,m)
                    if parse_json(extract_data(remote.content,m))!=parse_json(item["data"]):
                        raise ApiError("API_MODULE_UPLOAD_UNKNOWN" if response_error else "API_UPLOAD_READBACK_MISMATCH",
                                       "平台回读未确认提交内容，不自动重发")
                    result["stage"]="REMOTE_READBACK_VERIFIED"
                result["remoteHash"]=digest(remote.content)
                result["remoteDataVerified"]=True
                try:
                    published=store.publish([remote],uploaded_content={path:item["content"]})
                except ApiError as error:
                    result.update(stage="REMOTE_VERIFIED_LOCAL_PENDING",code=error.code,message=str(error))
                    break
                if published["conflicts"]:
                    result["stage"]="REMOTE_VERIFIED_LOCAL_CONFLICT"
            except ApiError as error:
                uncertain=result["stage"] in {"CHECKOUT_REQUEST_STARTED","SAVE_REQUEST_STARTED","REMOTE_ACKNOWLEDGED"}
                result.update(stage="UNKNOWN" if uncertain else "FAILED",code=error.code,message=str(error))
                break
            finally:
                if result["stage"] in _DONE | {"FAILED","REMOTE_VERIFIED_LOCAL_CONFLICT","REMOTE_VERIFIED_LOCAL_PENDING"}:
                    pending_file(workspace,path).unlink(missing_ok=True)
                store._receipt(operation)
        from .index import update
        operation["index"]=update(workspace,paths)
        operation["complete"]=len(operation["results"])==len(paths) and all(item["stage"] in _DONE for item in operation["results"])
        operation["stage"]="REMOTE_READBACK_VERIFIED" if operation["complete"] else "PARTIAL"
        store._receipt(operation)
        return operation


def verify(workspace, client, payload):
    store=ApiStore(workspace);operation=store.operation(_identifier(payload.get("operationId")))
    if operation.get("kind")!="module-upload" or operation.get("workspaceKey")!=workspace["workspaceKey"]:
        raise ApiError("API_IDENTITY_MISMATCH","操作记录不是当前项目的模块参数上传")
    directory,_=api_paths(workspace)
    with file_lock(directory/"sync.lock"):
        for result in operation["results"]:
            if result["stage"] not in {"UNKNOWN","PREPARED","CHECKOUT_REQUEST_STARTED","SAVE_REQUEST_STARTED","REMOTE_ACKNOWLEDGED"}:continue
            path=result["path"];item=store.read(path);m=item["metadata"]
            if result["stage"]=="PREPARED":
                result["stage"]="NOT_PERFORMED"
            elif not result.get("saveAttempted"):
                owner=checkout_owners(client,{(m["systemId"],m["configId"])})
                current_owner=owner.get((m["systemId"],m["configId"]),"")
                result["stage"]=("CHECKOUT_VERIFIED_SAVE_NOT_PERFORMED" if current_owner==(client.session or {}).get("userId")
                                 else "CHECKOUT_ABSENT_SAVE_NOT_PERFORMED" if not current_owner else "CHECKED_OUT_BY_OTHER_SAVE_NOT_PERFORMED")
            else:
                submitted=(directory/"operations"/operation["operationId"]/("submitted-"+digest(path)+".json")).read_text()
                if digest(submitted)!=result["submittedHash"]:
                    raise ApiError("API_MODULE_OPERATION_INVALID","提交快照哈希与原操作不一致")
                remote=fetch_parameter(client,m)
                if parse_json(extract_data(remote.content,m))!=parse_json(extract_data(submitted,m)):continue
                published=store.publish([remote],uploaded_content={path:submitted})
                result["stage"]="REMOTE_VERIFIED_LOCAL_CONFLICT" if published["conflicts"] else "REMOTE_READBACK_VERIFIED"
                result["remoteHash"]=digest(remote.content)
            pending=pending_file(workspace,path)
            if pending.exists() and json.loads(pending.read_text())["operationId"]==operation["operationId"]:
                pending.unlink()
        from .index import update
        operation["index"]=update(workspace,operation["paths"])
        operation["complete"]=len(operation["results"])==len(operation["paths"]) and all(item["stage"] in _DONE for item in operation["results"])
        operation["stage"]="REMOTE_READBACK_VERIFIED" if operation["complete"] else "PARTIAL"
        operation["mutationRetried"]=False
        store._receipt(operation)
        return operation


def run(workspace, client, payload):
    action=payload.get("action")
    if action=="preview":return prepare(workspace,client,payload)
    if action=="upload":return upload(workspace,client,payload)
    if action=="verify":return verify(workspace,client,payload)
    raise ApiError("API_INPUT_INVALID","未知模块参数上传操作")

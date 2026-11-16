"""Lease-bound editing of only the data node in a module parameter snapshot."""
from __future__ import annotations

from contextlib import closing
from decimal import Decimal
import json
import sqlite3

from common.page_projection import _JsonValueLocator
from common.persistence import file_lock
from .client import ApiError
from .store import ApiStore
from . import documents
from .module_parameters import SOURCE_TYPE, _check_identity


def parse_json(text):
    def object_value(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("JSON 包含重复键：" + key)
            result[key] = value
        return result
    def constant(value):
        raise ValueError("JSON 不允许 " + value)
    try:
        return json.loads(text, parse_float=Decimal, object_pairs_hook=object_value, parse_constant=constant)
    except (ValueError, TypeError) as error:
        raise ApiError("API_MODULE_JSON_INVALID", "模块参数必须为有效 JSON：" + str(error)) from error


def snapshot(text, metadata):
    value = parse_json(text)
    if not isinstance(value, dict) or not isinstance(value.get("bean"), dict):
        raise ApiError("API_MODULE_FORMAT_INVALID", "模块参数快照缺少对象身份")
    _check_identity(value["bean"], metadata["systemId"], metadata["configId"])
    return value


def extract_data(text, metadata):
    value = snapshot(text, metadata)
    if not isinstance(value.get("data"), dict):
        raise ApiError("API_MODULE_DATA_ABSENT", "当前参数没有可编辑的 data 对象，请在平台核对")
    start, end, _ = _JsonValueLocator(text).locate()["/data"]
    return text[start:end] + "\n"


def validate_candidate(before, after, metadata):
    old, new = snapshot(before, metadata), snapshot(after, metadata)
    if not isinstance(new.get("data"), dict):
        raise ApiError("API_MODULE_DATA_INVALID", "模块参数 data 必须为 JSON 对象")
    if {key:value for key,value in old.items() if key!="data"} != {key:value for key,value in new.items() if key!="data"}:
        raise ApiError("API_MODULE_PROTECTED_FIELDS", "仅允许修改 data；模板、身份和其他元数据不可修改")


def candidate(text, metadata, content):
    if not isinstance(content, str) or len(content.encode("utf-8")) > documents._MAX_CONTENT:
        raise ApiError("API_INPUT_INVALID", "模块参数编辑内容无效或超出大小限制")
    if not isinstance(parse_json(content), dict):
        raise ApiError("API_MODULE_DATA_INVALID", "模块参数 data 必须为 JSON 对象")
    extract_data(text, metadata)
    start, end, _ = _JsonValueLocator(text).locate()["/data"]
    result = text[:start] + content.strip() + text[end:]
    validate_candidate(text, result, metadata)
    return result


def enable_editing(workspace, path):
    """Upgrade the previous read-only phase's local descriptor, never its contents."""
    store = ApiStore(workspace)
    with file_lock(store.directory / "source.lock"):
        item = store.read(path)
        if item["metadata"].get("sourceType") != SOURCE_TYPE:
            raise ApiError("API_MODULE_REQUIRED", "请选择模块参数")
        extract_data(item["content"], item["metadata"])
        if item["readonly"]:
            store._path(path).chmod(0o600)
            with closing(sqlite3.connect(store.path)) as conn:
                conn.execute("UPDATE source SET readonly=0 WHERE path=?", (path,))
                conn.commit()
    return ApiStore(workspace).read(path)


def run(workspace, payload):
    action = payload.get("action")
    if action == "open":
        item = enable_editing(workspace, payload.get("path"))
        lease = documents.open_document(workspace, item["path"])
        if lease["sourceHash"] != item["sourceHash"]:
            documents.close_document(workspace, lease["leaseId"])
            raise ApiError("API_SOURCE_STALE", "打开期间模块参数已变化，请重新打开")
        return {"sourcePath": item["path"], "sourceHash": item["sourceHash"], "editable": True,
                "editToken": lease["leaseId"], "expiresAt": lease["expiresAt"], "baseHash": item["baseHash"],
                "content": extract_data(item["content"], item["metadata"]),
                "baseContentData": extract_data(ApiStore(workspace).baseline(item["path"]), item["metadata"])}
    token=documents._identifier(payload.get("editToken"))
    lease=documents._load(documents._directory(workspace)/"leases"/(token+".json"))
    if lease.get("workspaceKey")!=workspace["workspaceKey"] or lease.get("leaseId")!=token:
        raise ApiError("API_DOCUMENT_RECORD_INVALID","租约身份不匹配")
    item = ApiStore(workspace).read(lease["path"])
    if item["metadata"].get("sourceType") != SOURCE_TYPE:
        raise ApiError("API_MODULE_REQUIRED", "编辑租约不属于模块参数")
    if payload.get("path", lease["path"]) != lease["path"]:
        raise ApiError("API_IDENTITY_MISMATCH", "模块参数路径与编辑租约不一致")
    if action == "preview":
        if payload.get("expectedHash") != lease["sourceHash"] or item["sourceHash"] != lease["sourceHash"]:
            raise ApiError("API_SOURCE_STALE", "模块参数已变化，请重新打开并核对")
        content = candidate(item["content"], item["metadata"], payload.get("content"))
        preview = documents.preview(workspace, lease["leaseId"], content=content)
        return {"sourcePath": item["path"], "sourceHash": preview["sourceHash"], "previewId": preview["previewId"],
                "candidateSourceHash": preview["candidateHash"], "changed": preview["changed"],
                "beforeContent": extract_data(ApiStore(workspace).baseline(item["path"]), item["metadata"]),
                "afterContent": payload["content"], "diff": preview["diff"], "diffTruncated": preview["diffTruncated"]}
    if action == "save":
        result = documents.write(workspace, lease["leaseId"], payload.get("previewId"),
                                 payload.get("idempotencyKey"), editor_token=payload.get("editorToken"))
        verified = documents.verify(workspace, result["operationId"])
        return {"sourcePath": lease["path"], "sourceHash": verified["actualHash"], "operationId": result["operationId"],
                "operationComplete": verified["matchesAfter"] and result["phase"] in {"VERIFIED","INDEX_PARTIAL"},
                "index": {"complete": result["phase"]=="VERIFIED", "indexGeneration":result.get("indexGeneration"),
                          "diagnosticCount":result.get("indexDiagnosticCount",0)}}
    if action == "close":
        documents.close_document(workspace, lease["leaseId"])
        return {"sourcePath":lease["path"],"closed":True}
    raise ApiError("API_INPUT_INVALID", "未知模块参数编辑操作")

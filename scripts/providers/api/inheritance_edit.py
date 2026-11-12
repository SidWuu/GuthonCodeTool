"""Guarded inline editing of project scripts over a read-only inherited parent."""

from __future__ import annotations
import json
import uuid
from common.persistence import atomic_text, file_lock
from common.inheritance import project, procedure_body
from .client import ApiError
from .index import inheritance, update
from .store import ApiStore, digest
from .editor_state import assert_writable


def write(workspace, payload):
    if not workspace["workspaceKey"].startswith("projects."):
        raise ApiError(
            "API_PROJECT_SOURCE_REQUIRED", "继承展开编辑只写入明确的项目层源码"
        )
    content = payload.get("content")
    key = payload.get("idempotencyKey")
    if (
        not isinstance(content, str)
        or len(content.encode()) > 4_000_000
        or not isinstance(key, str)
        or not 1 <= len(key) <= 256
    ):
        raise ApiError("API_INPUT_INVALID", "继承编辑需要有界源码和幂等键")
    if type(payload.get("materialized")) is not bool or (
        "controlFlowConfirmed" in payload
        and type(payload["controlFlowConfirmed"]) is not bool
    ):
        raise ApiError("API_INPUT_INVALID", "继承保存方式与控制流确认必须为布尔值")
    store = ApiStore(workspace)
    directory = store.directory / "inheritance-edits"
    keypath = directory / (digest(key) + ".json")
    request_hash = digest(
        json.dumps(
            {
                k: payload.get(k)
                for k in (
                    "path",
                    "content",
                    "expectedHash",
                    "parentPath",
                    "parentHash",
                    "materialized",
                    "controlFlowConfirmed",
                )
            },
            sort_keys=True,
            ensure_ascii=False,
        )
    )
    with file_lock(store.directory / "sync.lock"):
        if keypath.is_file():
            previous = json.loads(keypath.read_text(encoding="utf-8"))
            if previous["requestHash"] != request_hash:
                raise ApiError(
                    "API_IDEMPOTENCY_CONFLICT", "继承编辑幂等键已绑定其他请求"
                )
            operation = store.operation(previous["operationId"])
            current = store.read(operation["path"])
            if current["sourceHash"] == operation["afterHash"]:
                operation["stage"] = "LOCAL_WRITE_VERIFIED"
                store._receipt(operation)
                return {
                    **operation,
                    "sourceHash": current["sourceHash"],
                    "operationComplete": True,
                }
            if operation["stage"] == "LOCAL_WRITE_VERIFIED":
                return {
                    **operation,
                    "sourceHash": operation["afterHash"],
                    "operationComplete": True,
                }
            raise ApiError("API_WRITE_UNKNOWN", "原继承保存结果待核对，不重放写入")
        current = store.read(payload.get("path"))
        kind = current["metadata"]["sourceType"]
        if current["readonly"] or kind not in {"procedure", "page", "system-script"}:
            raise ApiError("API_SOURCE_READONLY", "请选择当前项目可写主源码")
        if current["sourceHash"] != payload.get("expectedHash"):
            raise ApiError("API_SOURCE_STALE", "项目源码已变化，请重新展开")
        projection = inheritance(workspace, current["path"], max_chars=1)
        if (
            projection.get("status") != "ACTIVE"
            or projection.get("parentPath") != payload.get("parentPath")
            or projection.get("parentHash") != payload.get("parentHash")
        ):
            raise ApiError(
                "API_INHERITANCE_STALE", "继承父层身份或内容已变化，请重新展开"
            )
        assert_writable(workspace, [payload["parentPath"]])
        if (
            payload["materialized"]
            and not projection.get("materializable")
            and payload.get("controlFlowConfirmed") is not True
        ):
            raise ApiError(
                "API_INHERITANCE_REVIEW_REQUIRED", "物化继承代码前需要明确核对控制流"
            )
        parent = store.read(payload["parentPath"])["content"]
        if kind in {"procedure", "page"}:
            parent, _ = procedure_body(parent)
        status = project(content, parent)["status"]
        if payload["materialized"] and status != "INACTIVE":
            raise ApiError("API_INHERITANCE_INVALID", "物化源码不能保留继承入口")
        if not payload["materialized"] and status != "ACTIVE":
            raise ApiError("API_INHERITANCE_INVALID", "项目修改必须保留原生继承入口")
        operation = {
            "operationId": uuid.uuid4().hex,
            "kind": "inheritance-write",
            "path": current["path"],
            "stage": "PREPARED",
            "beforeHash": current["sourceHash"],
            "afterHash": digest(content),
            "parentPath": payload["parentPath"],
            "parentHash": payload["parentHash"],
        }
        atomic_text(
            directory / (operation["operationId"] + "-before.txt"), current["content"]
        )
        store._receipt(operation)
        atomic_text(
            keypath,
            json.dumps(
                {"requestHash": request_hash, "operationId": operation["operationId"]}
            )
            + "\n",
        )
        written = store.write(
            current["path"],
            content,
            current["sourceHash"],
            editor_token=payload.get("editorToken"),
        )
        operation.update(
            stage="LOCAL_WRITE_VERIFIED", childOperationId=written["operationId"]
        )
        store._receipt(operation)
        result = {
            **operation,
            "sourceHash": written["sourceHash"],
            "operationComplete": True,
        }
        result["index"] = update(workspace, [current["path"]])
        return result

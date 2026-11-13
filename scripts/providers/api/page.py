"""Native PAGE editor snapshots and guarded writes over the single API checkout."""

from __future__ import annotations
import json
import time
import uuid
from common import page_editor
from common.page_comparison import compare_pages
from common.persistence import atomic_text, file_lock
from .client import ApiError
from .store import ApiStore, digest
from .sync import target
from .index import PageIdentityMismatch, page_format


def _directory(workspace):
    return workspace["contextDir"] / "api" / "page-sessions"


def _load(workspace, token):
    if (
        not isinstance(token, str)
        or len(token) != 32
        or any(c not in "0123456789abcdef" for c in token)
    ):
        raise ApiError("API_EDIT_TOKEN_INVALID", "PAGE编辑令牌无效")
    try:
        record = json.loads(
            (_directory(workspace) / (token + ".json")).read_text(encoding="utf-8")
        )
    except FileNotFoundError as error:
        raise ApiError("API_EDIT_TOKEN_INVALID", "请重新打开PAGE编辑器") from error
    if (
        record["workspaceKey"] != workspace["workspaceKey"]
        or record["expiresAt"] < time.time()
    ):
        raise ApiError(
            "API_EDIT_TOKEN_EXPIRED", "PAGE编辑会话已过期，草稿保留，请重新载入"
        )
    return record


def snapshot(workspace, payload):
    item = target(workspace, {**payload, "sourceType": "page"})
    from .native_page import is_metadata_only

    minimal = is_metadata_only(item["content"], item["metadata"], item["path"])
    identity_mismatch = False
    if not minimal:
        try:
            fmt = page_format(item)
        except PageIdentityMismatch:
            identity_mismatch = True
    if minimal or identity_mismatch:
        return {
            "workspaceKey": workspace["workspaceKey"],
            "sourcePath": item["path"],
            "sourceHash": item["sourceHash"],
            "sourceId": item["metadata"]["pageId"],
            "sessionId": None,
            "documentId": None,
            "editToken": None,
            "editable": False,
            "rawEditable": minimal and not item["readonly"],
            "sourceText": item["content"],
            "model": None,
            "expiresAt": None,
            "sourceFormat": "native-page-minimal" if minimal else "unsupported",
            "contentState": "METADATA_ONLY" if minimal else "IDENTITY_MISMATCH",
            "identitySource": "API_METADATA",
            "diagnostic": "API_PAGE_MINIMAL_SOURCE" if minimal else "API_PAGE_IDENTITY_MISMATCH",
            "message": "原始页面仅包含最小元数据，缺少页面编码；请使用原始文件进行显式编辑。"
            if minimal else "页面源码中的编码与官方元数据不一致；可只读查看原文。",
        }
    if fmt not in {"json", "native-xml"}:
        raise ApiError(
            "API_PAGE_FORMAT_UNSUPPORTED",
            "此对象是服务组件或未知PAGE格式，请使用代码编辑器",
        )
    from .native_page import display_text

    source_text = (
        display_text(item["content"]) if fmt == "native-xml" else item["content"]
    )
    model = page_editor.describe(source_text)
    token = uuid.uuid4().hex
    record = {
        "workspaceKey": workspace["workspaceKey"],
        "path": item["path"],
        "sourceHash": item["sourceHash"],
        "expiresAt": int(time.time()) + 1800,
    }
    atomic_text(
        _directory(workspace) / (token + ".json"),
        json.dumps(record, ensure_ascii=False) + "\n",
    )
    return {
        "workspaceKey": workspace["workspaceKey"],
        "sourcePath": item["path"],
        "sourceHash": item["sourceHash"],
        "sourceId": item["metadata"]["pageId"],
        "sessionId": token,
        "documentId": token,
        "editToken": token,
        "editable": not item["readonly"],
        "sourceText": source_text,
        "model": model,
        "expiresAt": record["expiresAt"],
        "apiVersion": item["metadata"].get("versionMac", ""),
    }


def candidate_for(workspace, current, payload):
    operations = payload.get("operations")
    inheritance = payload.get("inheritance")
    if (
        isinstance(operations, list)
        and len(operations) == 1
        and isinstance(operations[0], dict)
        and operations[0].get("kind") == "collection"
    ):
        from .index import _page_data
        from common.page_projection import _JsonValueLocator, pointer_value
        from common.page_structure import set_value

        op = operations[0]
        if (
            set(op) != {"kind", "jsonPointer", "content"}
            or not isinstance(op.get("content"), str)
            or len(op["content"].encode()) > 500000
        ):
            raise ApiError("API_INPUT_INVALID", "字段集合需要明确指针和有界JSON正文")
        data = _page_data(current["content"])
        projected = json.dumps(data, ensure_ascii=False)
        model = page_editor.describe(projected)
        collection = next(
            (c for c in model["collections"] if c["pointer"] == op["jsonPointer"]), None
        )
        if not collection:
            raise ApiError(
                "API_PAGE_COLLECTION_INVALID", "此指针不是当前页面支持的字段或按钮集合"
            )
        _JsonValueLocator(op["content"]).locate()
        value = json.loads(op["content"])
        if not isinstance(value, list) or any(
            not isinstance(item, dict) for item in value
        ):
            raise ApiError("API_PAGE_COLLECTION_INVALID", "集合JSON必须为对象数组")
        from collections import Counter

        previous = pointer_value(data, op["jsonPointer"])
        for key in ("fieldId", "id", "guid"):
            before = Counter(
                item[key].strip().casefold()
                for item in previous
                if isinstance(item, dict)
                and isinstance(item.get(key), str)
                and item[key].strip()
            )
            after = Counter(
                item[key].strip().casefold()
                for item in value
                if isinstance(item.get(key), str) and item[key].strip()
            )
            if any(
                count > 1 and count > before[identifier]
                for identifier, count in after.items()
            ):
                raise ApiError(
                    "API_PAGE_COLLECTION_INVALID", "字段或按钮身份重复：" + key
                )
        candidate = set_value(projected, op["jsonPointer"], value)
        described = page_editor.describe(candidate)
        changed = next(
            c for c in described["collections"] if c["pointer"] == op["jsonPointer"]
        )
        if collection.get("reorderable") and not changed.get("reorderable"):
            raise ApiError(
                "API_PAGE_COLLECTION_INVALID",
                "新集合存在身份重复或不支持的成员，请先检查字段与按钮",
            )
        if page_format(current) == "native-xml":
            from .native_page import replace_value

            return replace_value(current["content"], op["jsonPointer"], value)
        return set_value(current["content"], op["jsonPointer"], value)
    if inheritance is not None:
        from .index import inheritance as read_inheritance, _page_data
        from common.page_projection import pointer_value
        from common.inheritance import project

        if (
            not workspace["workspaceKey"].startswith("projects.")
            or not isinstance(inheritance, dict)
            or set(inheritance)
            - {
                "jsonPointer",
                "parentPointer",
                "sourceHash",
                "parentHash",
                "materialized",
                "controlFlowConfirmed",
            }
            or type(inheritance.get("materialized")) is not bool
            or inheritance.get("sourceHash") != current["sourceHash"]
            or (
                "controlFlowConfirmed" in inheritance
                and type(inheritance["controlFlowConfirmed"]) is not bool
            )
        ):
            raise ApiError("API_INHERITANCE_INVALID", "继承编辑身份或当前源码版本无效")
        pointer = inheritance.get("jsonPointer")
        if (
            not isinstance(operations, list)
            or len(operations) != 1
            or not isinstance(operations[0], dict)
            or operations[0].get("kind") != "text"
            or operations[0].get("jsonPointer") != pointer
        ):
            raise ApiError(
                "API_INHERITANCE_INVALID", "继承编辑必须绑定一个明确的代码节点"
            )
        projection = read_inheritance(workspace, current["path"], pointer, 0, 1)
        if (
            projection.get("status") != "ACTIVE"
            or projection.get("sourceHash") != current["sourceHash"]
            or projection.get("parentPointer") != inheritance.get("parentPointer")
            or inheritance.get("parentHash")
            != (projection.get("parentHash") or current["sourceHash"])
        ):
            raise ApiError("API_SOURCE_STALE", "继承来源已变化，请重新打开代码")
        if (
            inheritance["materialized"]
            and not projection.get("materializable")
            and inheritance.get("controlFlowConfirmed") is not True
        ):
            raise ApiError(
                "API_INHERITANCE_REVIEW_REQUIRED", "物化继承代码前需要明确核对控制流"
            )
        data = _page_data(current["content"])
        parent = pointer_value(data, projection["parentPointer"])
        text = operations[0].get("content")
        if not isinstance(text, str) or len(text) > 500000:
            raise ApiError("API_INPUT_INVALID", "继承代码超出文本范围")
        next_projection = project(text, parent)
        expected = "INACTIVE" if inheritance["materialized"] else "ACTIVE"
        if next_projection["status"] != expected:
            raise ApiError("API_INHERITANCE_INVALID", "继承标记与保存方式不一致")
        if page_format(current) == "native-xml":
            from .native_page import replace_text

            return replace_text(current["content"], pointer, text)
        from common.page_structure import set_value

        return set_value(current["content"], pointer, text)
    if page_format(current) == "native-xml":
        from .native_page import apply_operations
    else:
        apply_operations = page_editor.apply_operations
    return apply_operations(current["content"], operations)


def run(workspace, payload):
    if not isinstance(payload, dict):
        raise ApiError("API_INPUT_INVALID", "PAGE输入必须是对象")
    action = payload.get("action")
    store = ApiStore(workspace)
    if action == "contract":
        from common.page_design import contract

        return contract()
    if action == "validate":
        if payload.get("path"):
            from .content import validate_candidate

            current = store.read(payload["path"])
            if current["sourceHash"] != payload.get("expectedHash"):
                raise ApiError("API_SOURCE_STALE", "PAGE已变化，请重新打开设计器")
            validate_candidate(
                current["path"],
                current["metadata"],
                store.baseline(current["path"]),
                payload.get("content"),
            )
            return {
                "valid": True,
                "sourceHash": current["sourceHash"],
                "pageId": current["metadata"].get("pageId"),
                "inheritedUnchanged": True,
            }
        from common.page_structure import inspect
        from .index import _page_data

        return inspect(_page_data(payload["content"]))
    if action == "fragment":
        from .index import _page_data
        from common.page_projection import pointer_value

        opened = snapshot(workspace, payload)
        pointer = payload.get("jsonPointer")
        if not any(c["pointer"] == pointer for c in opened["model"]["collections"]):
            raise ApiError(
                "API_PAGE_COLLECTION_INVALID", "请选择当前页面的字段或按钮集合"
            )
        value = pointer_value(json.loads(opened["sourceText"]), pointer)
        return {
            key: val
            for key, val in opened.items()
            if key not in {"model", "sourceText"}
        } | {
            "jsonPointer": pointer,
            "content": json.dumps(value, ensure_ascii=False, indent=2),
            "fragmentType": "collection",
        }
    if action in {"open", "structure-open", "inspect"}:
        result = snapshot(workspace, payload)
        if result.get("contentState") in {"METADATA_ONLY", "IDENTITY_MISMATCH"} and action != "open":
            raise ApiError("API_PAGE_STRUCTURE_UNAVAILABLE", "原始页面没有可编辑的页面结构")
        if action == "inspect":
            from common.page_structure import inspect

            return {
                "sourceHash": result["sourceHash"],
                **inspect(page_editor._data(result["sourceText"])[0]),
            }
        if action == "structure-open":
            model = result.pop("model")
            result.pop("sourceText")
            return {
                **result,
                "insertTargets": model["insertTargets"],
                "eventOwners": model["eventOwners"],
                "collections": model["collections"],
            }
        return result
    if action == "comparison":
        item = store.read(payload["path"])
        if item["sourceHash"] != payload.get("sourceHash"):
            raise ApiError("API_SOURCE_STALE", "PAGE已变化，请重新载入比较")
        base = store.baseline(item["path"])
        from .index import _page_data

        changes = compare_pages(_page_data(base), _page_data(item["content"]))
        return {
            "available": True,
            "sourceHash": item["sourceHash"],
            "apiVersion": item["metadata"].get("versionMac", ""),
            "baseRevision": item["metadata"].get("versionMac", ""),
            "changes": changes,
            "baseSourceText": json.dumps(
                _page_data(base), ensure_ascii=False, indent=2
            ),
            "baseHash": digest(base),
            "formatOnly": base != item["content"] and not changes["total"],
        }
    if action == "resume":
        record = store.operation(payload["operationId"])
        current = store.read(record["path"])
        return {
            **record,
            "sourceHash": current["sourceHash"],
            "operationComplete": record.get("afterHash") == current["sourceHash"],
        }
    if action not in {"preview", "save"}:
        raise ApiError("API_INPUT_INVALID", "未知PAGE操作")
    directory = _directory(workspace)
    with file_lock(directory / "page.lock"):
        lease = _load(workspace, payload.get("editToken"))
        if payload.get("path") and payload["path"] != lease["path"]:
            raise ApiError("API_IDENTITY_MISMATCH", "PAGE路径与令牌不一致")
        request_hash = digest(
            json.dumps(
                {
                    "token": payload["editToken"],
                    "operations": payload.get("operations"),
                    "inheritance": payload.get("inheritance"),
                },
                sort_keys=True,
                ensure_ascii=False,
            )
        )
        key = payload.get("idempotencyKey")
        keypath = None
        if action == "save":
            if not isinstance(key, str) or not 1 <= len(key) <= 256:
                raise ApiError("API_INPUT_INVALID", "PAGE保存需要幂等键")
            keypath = directory / "keys" / (digest(key) + ".json")
            if keypath.is_file():
                prior = json.loads(keypath.read_text(encoding="utf-8"))
                if prior["requestHash"] != request_hash:
                    raise ApiError(
                        "API_IDEMPOTENCY_CONFLICT", "幂等键已绑定其他保存请求"
                    )
                if prior.get("operationId"):
                    return run(
                        workspace,
                        {"action": "resume", "operationId": prior["operationId"]},
                    )
                current = store.read(lease["path"])
                if current["sourceHash"] == prior["candidateSourceHash"]:
                    return {
                        **prior,
                        "sourceHash": current["sourceHash"],
                        "operationComplete": True,
                    }
                raise ApiError("API_WRITE_UNKNOWN", "先前保存结果待核对，不重放写入")
        current = store.read(lease["path"])
        if current["sourceHash"] != lease["sourceHash"]:
            raise ApiError("API_SOURCE_STALE", "PAGE已变化，未覆盖草稿")
        candidate = candidate_for(workspace, current, payload)
        result = {
            "sourceHash": current["sourceHash"],
            "candidateSourceHash": digest(candidate),
            "changed": candidate != current["content"],
        }
        if action == "preview":
            return result
        atomic_text(keypath, json.dumps({**result, "requestHash": request_hash}) + "\n")
        written = store.write(
            lease["path"],
            candidate,
            lease["sourceHash"],
            editor_token=payload.get("editorToken"),
        )
        result.update(
            operationId=written["operationId"],
            sourceHash=written["sourceHash"],
            operationComplete=True,
        )
        atomic_text(keypath, json.dumps({**result, "requestHash": request_hash}) + "\n")
        from .index import update

        result["index"] = update(workspace, [lease["path"]])
        return result

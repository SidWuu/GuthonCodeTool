"""Hash-bound, local-only API document editing with durable operation receipts."""

from __future__ import annotations

import difflib
import hashlib
import json
import time
import uuid
from pathlib import Path

from common import page_editor
from common.persistence import atomic_text, file_lock
from .client import ApiError
from .local_mutation import local_mutation
from .page_source import BATCH_EXPORT
from .store import ApiStore
from .source_requests import CLOSED_BEFORE_WRITE

_MAX_CONTENT = 4_000_000


def _directory(workspace):
    return Path(workspace["contextDir"]) / "api" / "documents"


def _identifier(value):
    if (
        not isinstance(value, str)
        or len(value) != 32
        or any(c not in "0123456789abcdef" for c in value)
    ):
        raise ValueError("invalid document identifier")
    return value


def _load(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ApiError("API_DOCUMENT_NOT_FOUND", "文档租约或操作记录不存在") from error
    if not isinstance(value, dict):
        raise ApiError("API_DOCUMENT_RECORD_INVALID", "文档记录损坏")
    return value


def _save(path, value):
    atomic_text(path, json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n")


def _lease(workspace, lease_id):
    value = _load(_directory(workspace) / "leases" / (_identifier(lease_id) + ".json"))
    if (
        value.get("workspaceKey") != workspace["workspaceKey"]
        or value.get("leaseId") != lease_id
    ):
        raise ApiError("API_DOCUMENT_RECORD_INVALID", "租约身份不匹配")
    if value.get("closed") or value.get("expiresAt", 0) <= time.time():
        raise ApiError("API_DOCUMENT_LEASE_EXPIRED", "租约已关闭或过期，请重新打开")
    return value


def _parents(data, path=""):
    result = {}
    if isinstance(data, dict):
        for key, value in data.items():
            pointer = path + "/" + key.replace("~", "~0").replace("/", "~1")
            if key in {"superServiceEvents", "superPageEvents", "superScript"}:
                result[pointer] = value
            else:
                result.update(_parents(value, pointer))
    elif isinstance(data, list):
        for index, value in enumerate(data):
            result.update(_parents(value, path + "/" + str(index)))
    return result


def _check_parent(workspace, lease):
    parent = lease.get("parentBinding")
    if parent:
        from .editor_state import assert_writable

        assert_writable(workspace, [parent["path"]])
        current = ApiStore(workspace).read(parent["path"])
        if not current["readonly"] or current["sourceHash"] != parent["sourceHash"]:
            raise ApiError(
                "API_INHERITANCE_STALE", "继承父层已变化，请重新打开编辑租约"
            )


def open_document(workspace, path, ttl_seconds=1800):
    if type(ttl_seconds) is not int or not 1 <= ttl_seconds <= 86400:
        raise ValueError("ttl_seconds must be 1–86400")
    directory = _directory(workspace)
    with file_lock(directory / "documents.lock"):
        item = ApiStore(workspace).read(path)
        if item["metadata"].get("pageSource") == BATCH_EXPORT:
            raise ApiError(
                "API_PAGE_NATIVE_BASE_REQUIRED",
                "批量下载的 PAGE XML 仅可浏览；请先定向加载可编辑的原生 PAGE",
            )
        if item["metadata"].get("sourceType") == "module-parameter" and item["readonly"]:
            from .module_parameter_editor import enable_editing
            item = enable_editing(workspace, path)
        if item["readonly"] or str(item["metadata"].get("sourceType", "")).endswith(
            "-inherit"
        ):
            raise ApiError("API_SOURCE_READONLY", "继承父源码为只读")
        from .index import page_format

        if page_format(item) == "unsupported-xml":
            raise ApiError(
                "API_PAGE_XML_UNSUPPORTED", "未知 PAGE XML 格式仅可读取原文，不能编辑"
            )
        leases = directory / "leases"
        if leases.is_dir():
            for file in leases.glob("*.json"):
                existing = _load(file)
                if (
                    existing.get("path") == path
                    and not existing.get("closed")
                    and existing.get("expiresAt", 0) > time.time()
                ):
                    if existing.get("sourceHash") != item["sourceHash"]:
                        existing.update(
                            closed=True,
                            closedAt=time.time(),
                            invalidatedReason="SOURCE_CHANGED",
                        )
                        _save(file, existing)
                        continue
                    raise ApiError("API_DOCUMENT_LEASE_BUSY", "该文件已有活动编辑租约")
        lease_id = uuid.uuid4().hex
        record = {
            "workspaceKey": workspace["workspaceKey"],
            "leaseId": lease_id,
            "path": path,
            "sourceHash": item["sourceHash"],
            "createdAt": time.time(),
            "expiresAt": time.time() + ttl_seconds,
            "closed": False,
        }
        if (
            item["metadata"].get("sourceType") in {"procedure", "system-script"}
            or page_format(item) == "script"
        ):
            from .index import inheritance

            projection = inheritance(workspace, path, max_chars=1)
            if projection.get("status") == "ACTIVE" and projection.get("parentPath"):
                record["parentBinding"] = {
                    "path": projection["parentPath"],
                    "sourceHash": projection["parentHash"],
                }
        _save(leases / (lease_id + ".json"), record)
        return {
            **record,
            "content": item["content"][:12000],
            "totalChars": len(item["content"]),
            "complete": len(item["content"]) <= 12000,
            "truncated": len(item["content"]) > 12000,
            "nextOffset": 12000 if len(item["content"]) > 12000 else None,
            "metadata": item["metadata"],
            "readonly": False,
        }


def preview(workspace, lease_id, content=None, operations=None):
    if (content is None) == (operations is None):
        raise ValueError("provide exactly one of content or operations")
    directory = _directory(workspace)
    with file_lock(directory / "documents.lock"):
        lease = _lease(workspace, lease_id)
        _check_parent(workspace, lease)
        item = ApiStore(workspace).read(lease["path"])
        if item["readonly"] or item["sourceHash"] != lease["sourceHash"]:
            raise ApiError("API_SOURCE_STALE", "源码已变化或变为只读，请重新打开")
        from .index import page_format

        fmt = page_format(item)
        if fmt == "unsupported-xml":
            raise ApiError(
                "API_PAGE_XML_UNSUPPORTED", "未知 PAGE XML 格式仅可读取原文，不能编辑"
            )
        is_page = fmt in {"json", "native-xml"}
        if operations is not None:
            if not is_page:
                raise ValueError("PAGE operations require a PAGE source")
            if fmt == "native-xml":
                from . import native_page

                candidate = native_page.apply_operations(item["content"], operations)
            else:
                candidate = page_editor.apply_operations(item["content"], operations)
        else:
            if (
                not isinstance(content, str)
                or len(content.encode("utf-8")) > _MAX_CONTENT
            ):
                raise ValueError("content exceeds the document limit")
            candidate = content
        if is_page:
            if fmt == "native-xml":
                from . import native_page

                before = native_page.decode(item["content"])
                after = native_page.decode(candidate)
            else:
                before, _ = page_editor._data(item["content"])
                after, _ = page_editor._data(candidate)
            if before["pageId"] != after["pageId"] or _parents(before) != _parents(
                after
            ):
                raise ApiError(
                    "API_PAGE_PARENT_READONLY", "PAGE 身份和继承父节点不可修改"
                )
        if item["metadata"].get("sourceType") == "module-parameter":
            from .content import validate_candidate
            validate_candidate(item["path"],item["metadata"],ApiStore(workspace).baseline(item["path"]),candidate)
        candidate_hash = hashlib.sha256(candidate.encode("utf-8")).hexdigest()
        preview_id = uuid.uuid4().hex
        diff = "".join(
            difflib.unified_diff(
                item["content"].splitlines(keepends=True),
                candidate.splitlines(keepends=True),
                fromfile="before",
                tofile="after",
            )
        )
        record = {
            "workspaceKey": workspace["workspaceKey"],
            "leaseId": lease_id,
            "previewId": preview_id,
            "path": lease["path"],
            "sourceHash": lease["sourceHash"],
            "candidateHash": candidate_hash,
            "content": candidate,
            "createdAt": time.time(),
        }
        _save(directory / "previews" / (preview_id + ".json"), record)
        return {key: value for key, value in record.items() if key != "content"} | {
            "diff": diff[:12000],
            "diffTruncated": len(diff) > 12000,
            "changed": candidate != item["content"],
        }


def _prepared_preview(workspace, lease_id, preview_id):
    directory = _directory(workspace)
    lease = _lease(workspace, lease_id)
    _check_parent(workspace, lease)
    draft = _load(directory / "previews" / (_identifier(preview_id) + ".json"))
    if (draft.get("workspaceKey") != workspace["workspaceKey"]
            or draft.get("leaseId") != lease_id or draft.get("sourceHash") != lease["sourceHash"]
            or draft.get("path") != lease["path"]):
        raise ApiError("API_PREVIEW_MISMATCH", "预览与当前租约不匹配")
    if not isinstance(draft.get("content"), str) or hashlib.sha256(draft["content"].encode()).hexdigest() != draft.get("candidateHash"):
        raise ApiError("API_PREVIEW_MISMATCH", "预览候选内容与哈希不一致")
    item = ApiStore(workspace).read(lease["path"])
    if item["readonly"] or item["sourceHash"] != draft["sourceHash"]:
        raise ApiError("API_SOURCE_STALE", "源码已变化或变为只读，请重新预览")
    return lease, draft


def preview_content(workspace, lease_id, preview_id):
    """Read the exact validated candidate associated with an active lease."""
    with file_lock(_directory(workspace) / "documents.lock"):
        _lease_record, draft = _prepared_preview(workspace, lease_id, preview_id)
        return {key: draft[key] for key in ("path", "content", "sourceHash", "candidateHash", "leaseId", "previewId")}


def complete_batch(workspace, lease_ids, operation_id):
    with file_lock(_directory(workspace) / "documents.lock"):
        for lease_id in lease_ids:
            path = _directory(workspace) / "leases" / (_identifier(lease_id) + ".json")
            lease = _load(path)
            if lease.get("workspaceKey") != workspace["workspaceKey"] or lease.get("leaseId") != lease_id:
                raise ApiError("API_DOCUMENT_RECORD_INVALID", "批量租约身份不匹配")
            lease.update(closed=True, closedAt=time.time(), batchOperationId=operation_id)
            _save(path, lease)


def write(workspace, lease_id, preview_id, idempotency_key, *, editor_token=None):
    with local_mutation(workspace["workspaceKey"], "document", leaseId=lease_id, previewId=preview_id) as mutation:
        if not isinstance(idempotency_key, str) or not 1 <= len(idempotency_key) <= 256:
            raise ValueError("idempotency_key is required and at most 256 characters")
        directory = _directory(workspace)
        key_hash = hashlib.sha256(idempotency_key.encode()).hexdigest()
        with (
            file_lock(workspace["contextDir"] / "api/sync.lock"),
            file_lock(directory / "documents.lock"),
        ):
            key_path = directory / "keys" / (key_hash + ".json")
            if key_path.exists():
                key = _load(key_path)
                if key.get("leaseId") != lease_id or key.get("previewId") != preview_id:
                    raise ApiError("API_IDEMPOTENCY_CONFLICT", "幂等键已用于其他请求")
                if key.get("state") == CLOSED_BEFORE_WRITE:
                    raise ApiError("API_SOURCE_REQUEST_CLOSED", "原幂等请求已在写入前关闭；不会派发源码写入")
                return operation(workspace, key["operationId"])
            lease, draft = _prepared_preview(workspace, lease_id, preview_id)
            op_id = uuid.uuid4().hex
            record = {
                "workspaceKey": workspace["workspaceKey"],
                "operationId": op_id,
                "leaseId": lease_id,
                "previewId": preview_id,
                "path": lease["path"],
                "beforeHash": draft["sourceHash"],
                "afterHash": draft["candidateHash"],
                "phase": "PENDING",
                "createdAt": time.time(),
            }
            op_path = directory / "operations" / (op_id + ".json")
            _save(op_path, record)
            mutation.update(state="PREPARED", operationId=op_id)
            _save(
                key_path,
                {
                    "workspaceKey": workspace["workspaceKey"],
                    "leaseId": lease_id,
                    "previewId": preview_id,
                    "operationId": op_id,
                },
            )
            try:
                mutation["state"] = "WRITE_STARTED"
                written = ApiStore(workspace).write(
                    lease["path"],
                    draft["content"],
                    draft["sourceHash"],
                    editor_token=editor_token,
                )
            except Exception as error:
                rejected = isinstance(error, ApiError) and error.code == "API_EDITOR_DIRTY"
                record.update(
                    phase="REJECTED" if rejected else "WRITE_UNKNOWN", updatedAt=time.time()
                )
                if rejected:
                    mutation["state"] = "REJECTED"
                    record["errorCode"] = error.code
                _save(op_path, record)
                raise
            if written["sourceHash"] != draft["candidateHash"]:
                record.update(
                    phase="VERIFY_FAILED",
                    actualHash=written["sourceHash"],
                    updatedAt=time.time(),
                )
                _save(op_path, record)
                raise ApiError(
                    "API_DOCUMENT_VERIFY_FAILED", "写后回读哈希不匹配，请核查操作记录"
                )
            record.update(phase="LOCAL_WRITTEN", updatedAt=time.time())
            _save(op_path, record)
            lease.update(sourceHash=written["sourceHash"], closed=True)
            _save(directory / "leases" / (lease_id + ".json"), lease)
            # Local file was saved. Index failures are reported separately; never replay the write.
            try:
                from . import index

                result = index.update(workspace, [lease["path"]])
                record.update(
                    phase="VERIFIED" if result.get("complete") else "INDEX_PARTIAL",
                    indexGeneration=result["indexGeneration"],
                    indexDiagnosticCount=result.get("diagnosticCount", 0),
                )
            except Exception as error:
                record.update(phase="INDEX_FAILED", indexError=str(error))
            record["updatedAt"] = time.time()
            _save(op_path, record)
            return record


def operation(workspace, operation_id):
    record = _load(
        _directory(workspace) / "operations" / (_identifier(operation_id) + ".json")
    )
    if (
        record.get("workspaceKey") != workspace["workspaceKey"]
        or record.get("operationId") != operation_id
    ):
        raise ApiError("API_DOCUMENT_RECORD_INVALID", "操作记录身份不匹配")
    return record


def find_operation(workspace, idempotency_key, *, lease_id=None, preview_id=None):
    """Find an already recorded request without dispatching or replaying a write."""
    if not isinstance(idempotency_key, str) or not 1 <= len(idempotency_key) <= 256:
        raise ValueError("idempotency_key is required and at most 256 characters")
    directory = _directory(workspace)
    key_hash = hashlib.sha256(idempotency_key.encode()).hexdigest()
    with file_lock(workspace["contextDir"] / "api/sync.lock"), file_lock(directory / "documents.lock"):
        key_path = directory / "keys" / (key_hash + ".json")
        if not key_path.is_file():
            return {"workspaceKey": workspace["workspaceKey"], "found": False, "mutationRetried": False,
                    "warnings": ["未找到已登记操作不代表原请求未派发；先核对原请求状态，不重发写入。"]}
        key = _load(key_path)
        if key.get("workspaceKey") != workspace["workspaceKey"]:
            raise ApiError("API_DOCUMENT_RECORD_INVALID", "幂等登记不属于当前工作区")
        if lease_id is not None and key.get("leaseId") != lease_id or preview_id is not None and key.get("previewId") != preview_id:
            raise ApiError("API_IDEMPOTENCY_CONFLICT", "原幂等键不属于指定租约和预览")
        if key.get("state") == CLOSED_BEFORE_WRITE:
            return {"workspaceKey": workspace["workspaceKey"], "found": False, "requestClosed": True,
                    "closure": key, "mutationRetried": False}
        record = operation(workspace, key["operationId"])
        if any(record.get(field) != key.get(field) for field in ("leaseId", "previewId")):
            raise ApiError("API_DOCUMENT_RECORD_INVALID", "幂等登记与原操作身份不一致")
        return {**record, "found": True, "idempotencyKeyHash": key_hash, "mutationRetried": False}


def verify(workspace, operation_id):
    with file_lock(workspace["contextDir"] / "api/sync.lock"), file_lock(_directory(workspace) / "documents.lock"), file_lock(workspace["contextDir"] / "api/source.lock"):
        record = operation(workspace, operation_id)
        item = ApiStore(workspace).read(record["path"])
        return {
            **record,
            "actualHash": item["sourceHash"],
            "matchesAfter": item["sourceHash"] == record["afterHash"],
            "matchesBefore": item["sourceHash"] == record["beforeHash"],
            "verifiedAt": time.time(),
            "scope": "LOCAL_FILE",
        }


def resume_operation(workspace, operation_id):
    """Repair verification/index stages only when the recorded bytes are present."""
    from . import index
    directory = _directory(workspace)
    with (file_lock(workspace["contextDir"] / "api/sync.lock"),
          file_lock(directory / "documents.lock"), file_lock(workspace["contextDir"] / "api/source.lock")):
        checked = verify(workspace, operation_id)
        if not checked["matchesAfter"]:
            return {**checked, "phase": "RECOVERY_REQUIRED", "mutationRetried": False}
        record = operation(workspace, operation_id)
        result = index.update(workspace, [record["path"]])
        record.update(phase="VERIFIED" if result.get("complete") else "INDEX_PARTIAL",
                      indexGeneration=result.get("indexGeneration"), verifiedAt=time.time(), mutationRetried=False)
        lease_path = directory / "leases" / (record["leaseId"] + ".json")
        lease = _load(lease_path)
        if lease.get("leaseId") != record["leaseId"] or lease.get("workspaceKey") != workspace["workspaceKey"]:
            raise ApiError("API_DOCUMENT_RECORD_INVALID", "恢复租约身份不匹配")
        lease.update(closed=True, closedAt=time.time())
        _save(lease_path, lease)
        _save(directory / "operations" / (operation_id + ".json"), record)
        return record


def renew_document(workspace, lease_id, ttl_seconds=1800):
    """Extend only a live lease whose source and inherited parent still match."""
    if type(ttl_seconds) is not int or not 1 <= ttl_seconds <= 86400:
        raise ValueError("ttl_seconds must be 1–86400")
    directory = _directory(workspace)
    with file_lock(directory / "documents.lock"):
        lease = _lease(workspace, lease_id)
        _check_parent(workspace, lease)
        item = ApiStore(workspace).read(lease["path"])
        if item["readonly"] or item["sourceHash"] != lease["sourceHash"]:
            raise ApiError("API_SOURCE_STALE", "源码已变化，不能续期旧租约")
        lease.update(expiresAt=time.time() + ttl_seconds, renewedAt=time.time())
        _save(directory / "leases" / (lease_id + ".json"), lease)
        return lease


def close_document(workspace, lease_id):
    directory = _directory(workspace)
    with file_lock(directory / "documents.lock"):
        lease = _lease(workspace, lease_id)
        lease["closed"] = True
        lease["closedAt"] = time.time()
        _save(directory / "leases" / (lease_id + ".json"), lease)
        return lease

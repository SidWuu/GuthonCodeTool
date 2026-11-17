"""Authoritative PAGE editor snapshots and version-bound native JSON saves.

The VSCode download XML is an export representation, not an editable baseline.
The checkout keeps its XML path, with a lossless local projection of bean/version.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass
import hashlib
import json
from urllib.parse import quote

from common import page_editor
from common.persistence import atomic_text
from .client import ApiError
from .download import BASE, SourceFile, page_source_path, required
from . import native_page

READ = "/develop/dev/pages/getPageModuleXml.htm"
INFO = "/develop/dev/pages/getPageBaseInfo.htm"
SAVE = "/develop/dev/models/savePageModuleXml.htm"
ORIGIN = "native-editor"


@dataclass(frozen=True)
class Snapshot:
    model: dict | None
    version: str | None


def structured(metadata, path=""):
    return metadata.get("sourceType", "page") == "page" and str(metadata.get("pageType", "")) != "0" and not path.lower().endswith(".gss")


def model(text):
    value = native_page.decode(text) if text.lstrip("\ufeff \t\r\n").startswith("<") else page_editor._data(text)[0]
    if not isinstance(value, dict) or not isinstance(value.get("pageId"), str) or not value["pageId"]:
        raise ApiError("API_PAGE_NATIVE_INVALID", "PAGE 原生模型缺少页面编码")
    return value


def fingerprint(value):
    # JSON numbers 3 and 3.0 are the same native value; strings remain distinct.
    def normalized(item):
        if isinstance(item, dict):return {k: normalized(v) for k, v in item.items()}
        if isinstance(item, list):return [normalized(v) for v in item]
        if isinstance(item, float) and item.is_integer():return int(item)
        return item
    return hashlib.sha256(json.dumps(normalized(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def read(client, metadata, *, check_info=False):
    if check_info:
        response = client.request(INFO, form={"pageId": metadata["pageId"]})
        info = response.get("page") if isinstance(response, dict) else None
        if not isinstance(info, dict) or any(str(info.get(k)) != str(metadata[k]) for k in ("pageId", "systemId")):
            raise ApiError("API_IDENTITY_MISMATCH", "原生 PAGE 基本信息与当前项目/子系统不一致")
        owner = info.get("checkOutUserId")
        if owner and owner != client.session.get("userId"):
            raise ApiError("API_PAGE_CHECKED_OUT_OTHER", "PAGE 已由其他用户签出，未保存或强制覆盖")
    response = client.request(READ, form={"pageId": metadata["pageId"]})
    if not isinstance(response, dict) or "bean" not in response or "version" not in response:
        raise ApiError("API_PAGE_NATIVE_INVALID", "原生 PAGE 应答缺少版本，未使用下载 XML 替代")
    value = response.get("bean")
    version = response["version"]
    metadata_only = isinstance(value, dict) and bool(value) and set(value) <= {"pageId", "pageType", "isProduct", "pageAliasId"}
    if not (isinstance(version, str) and version) and not (version is None and metadata_only):
        raise ApiError("API_PAGE_NATIVE_INVALID", "原生 PAGE 有内容但缺少可核验版本，未使用下载 XML 替代")
    if value is not None:
        if not isinstance(value, dict) or value.get("pageId") != metadata["pageId"]:
            raise ApiError("API_IDENTITY_MISMATCH", "原生 PAGE 编码与请求身份不一致")
        try:
            fingerprint(value)
            if "pageType" in value and "pageType" in metadata and float(value["pageType"]) != float(metadata["pageType"]):
                raise ValueError("pageType")
        except (TypeError, ValueError) as error:
            raise ApiError("API_PAGE_NATIVE_INVALID", "原生 PAGE 模型或页面类型无效") from error
    return Snapshot(value, version)


def baseline(store, path):
    if store is None:return None
    try:return store._record(path, require_scope=False)
    except ApiError as error:
        if error.code != "API_SOURCE_NOT_FOUND":raise
        return None


def as_file(snapshot, source, *, template=None):
    metadata = {**source.metadata, "pageSource": ORIGIN, "nativeVersion": snapshot.version,
                "nativeModelHash": fingerprint(snapshot.model), "versionMac": snapshot.version}
    if snapshot.model is None:
        from .store import digest
        bound = {**metadata, "sourceType": "page", "remoteHash": digest(source.content)}
        if not native_page.is_metadata_only(source.content, bound, source.path):
            raise ApiError("API_PAGE_EXPORT_DERIVED", "下载 PAGE 有内容，但原生编辑模型为空；未发布导出表示")
        text = source.content
        metadata["nativeState"] = "ABSENT"
    else:
        text = None
        for candidate in (template, source.content):
            if candidate is None:continue
            try:equal = native_page._same(model(candidate), snapshot.model)
            except (ValueError, TypeError, ApiError):equal = False
            if equal:
                text = candidate
                break
        if text is None:
            try:text = native_page.encode(snapshot.model)
            except (ValueError, TypeError) as error:
                raise ApiError("API_PAGE_NATIVE_INVALID", "原生 PAGE 无法无损表示为本地 XML") from error
        metadata["nativeState"] = "METADATA_ONLY" if snapshot.version is None else "PRESENT"
    return SourceFile(source.path, text, "page", metadata, source.readonly or snapshot.version is None)


def resolve(client, source, *, store=None):
    if not structured(source.metadata, source.path):return source
    cached = baseline(store, source.path)
    if cached and source.metadata.get("versionMac") and cached["metadata"].get("pageSource") == ORIGIN and cached["metadata"].get("nativeVersion") == source.metadata["versionMac"]:
        meta = cached["metadata"]
        value = None if meta.get("nativeState") == "ABSENT" else model(cached["baseContent"])
        if fingerprint(value) == meta.get("nativeModelHash"):
            return as_file(Snapshot(value, meta["nativeVersion"]), source, template=cached["baseContent"])
    snapshot = read(client, source.metadata)
    return as_file(snapshot, source, template=cached["baseContent"] if cached else None)


def check_before_upload(client, current, original):
    meta = current["metadata"]
    if meta.get("nativeState") == "ABSENT":
        from .store import digest
        bound = {**meta, "remoteHash": digest(original)}
        if not native_page.is_metadata_only(original, bound, current["path"]):
            raise ApiError("API_PAGE_NATIVE_BASE_REQUIRED", "原生空模型基线已变化，请重新刷新并核对")
        before = None
    else:before = model(original)
    snapshot = read(client, meta, check_info=True)
    if snapshot.version is None:
        raise ApiError("API_PAGE_NATIVE_VERSION_REQUIRED", "平台仅有 PAGE 元数据，尚无原生源码版本；请先在平台初始化源码并同步")
    if meta.get("pageSource") == ORIGIN:
        if fingerprint(before) != meta.get("nativeModelHash"):
            raise ApiError("API_PAGE_NATIVE_BASE_REQUIRED", "PAGE 基线与已核验原生模型不一致，未上传")
    elif not native_page._same(before, snapshot.model):
        raise ApiError("API_PAGE_EXPORT_DERIVED", "下载表示与原生编辑源码不一致，请刷新并核对本地差异；不能回写下载 XML")
    return snapshot


# The platform's PageJsonClear removes these documented literal defaults.
# Unknown nonempty values, identities and nonempty scripts are never discarded.
_DEFAULTS = {"ctName": "VARCHAR", "dataType": "VARCHAR", "colGroupType": 1, "forceSelection": 1,
             "sortable": 1, "isDefaultLike": 1, "length": 0, "isDisabled": 0, "isHide": 0,
             "isLike": 0, "areaRange": 0, "dqMust1": 0, "dqMust2": 0, "dqMust3": 0, "dqMust4": 0}


def saved_model_matches(candidate, received):
    def clean(value):
        if isinstance(value, list):return [clean(v) for v in value]
        if not isinstance(value, dict):return value
        result = {}
        for key, item in value.items():
            item = clean(item)
            if item is None or item == "" or item == {} or item == []:continue
            default = _DEFAULTS.get(key)
            if default is not None and type(item) is not bool and type(item) in (str, int, float) and item == default:continue
            result[key] = item
        return result
    return native_page._same(clean(candidate), clean(received))


def save(client, snapshot, metadata, candidate):
    if snapshot.version is None:
        raise ApiError("API_PAGE_NATIVE_VERSION_REQUIRED", "原生保存必须绑定当前源码版本")
    if candidate.get("pageId") != metadata["pageId"]:
        raise ApiError("API_IDENTITY_MISMATCH", "原生保存候选页面编码不一致")
    text = json.dumps(candidate, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    response = client.request(SAVE, form={"pageId": metadata["pageId"], "pageVersion": snapshot.version,
        "json": quote(base64.b64encode(text.encode()).decode(), safe=""), "isBase64": 1, "flag": 0, "isAutoCompile": 0})
    if not isinstance(response, dict) or not isinstance(response.get("version"), str) or not response["version"]:
        raise ApiError("API_RESPONSE_INVALID", "原生保存应答缺少版本，请通过原生接口核对，勿重复上传")
    return response["version"]


def finish_upload(store, client, current, result, operation, snapshot=None):
    """Send at most one native JSON save, then independently read the editor model."""
    from .content import validate_candidate
    from .editor_state import assert_writable
    from .store import digest
    path = current["path"]
    if snapshot is not None:
        response = client.request(BASE + "getModulePage.htm", {"pageId": current["metadata"]["pageId"]})
        exported = response.get("item") if isinstance(response, dict) else None
        required(exported, ("pageId", "pageSubId", "fileName"))
        if exported["pageId"] != current["metadata"]["pageId"] or str(exported.get("systemId", current["metadata"]["systemId"])) != current["metadata"]["systemId"]:
            raise ApiError("API_IDENTITY_MISMATCH", "PAGE 目录身份与当前对象不一致")
        remote_path = page_source_path(current["metadata"]["systemId"], exported["pageSubId"], exported["pageId"], exported["fileName"])
        if remote_path != path:
            raise ApiError("API_REMOTE_PATH_CHANGED", "PAGE 目录路径已变化，未发布或上传，请核对对象迁移")
        # Only directory identity is used above. Its XML is never a save candidate.
        source = SourceFile(path, store.baseline(path), "page", current["metadata"])
        remote = as_file(snapshot, source, template=source.content)
        publication = store.publish([remote])
        if publication["conflicts"]:raise ApiError("API_MERGE_CONFLICT", "原生 PAGE 与本地修改冲突，未上传")
        current = store.read(path)
        validate_candidate(path, current["metadata"], store.baseline(path), current["content"])
        candidate = model(current["content"])
        if saved_model_matches(candidate, snapshot.model):
            accepted = as_file(snapshot, remote, template=current["content"])
            store.publish([accepted], uploaded_content={path: current["content"]})
            result["stage"] = "ALREADY_REMOTE"
            return
        result.update(stage="REMOTE_REQUEST_PREPARED", pageProtocol="native-json", beforeHash=current["baseHash"],
                      submittedHash=current["sourceHash"], submittedModelHash=fingerprint(candidate), nativeBeforeVersion=snapshot.version)
        folder = store.directory / "operations" / operation["operationId"]
        atomic_text(folder / ("submitted-" + digest(path) + ".txt"), current["content"])
        atomic_text(folder / ("submitted-native-" + digest(path) + ".json"), json.dumps(candidate, ensure_ascii=False))
        store._receipt(operation)
        assert_writable(store.workspace, [path])
        if store.read(path)["sourceHash"] != current["sourceHash"]:
            raise ApiError("API_SOURCE_STALE", "原生 PAGE 上传前本地内容已变化")
        result["stage"] = "REMOTE_REQUEST_STARTED"
        store._receipt(operation)
        try:
            result["nativeAcceptedVersion"] = save(client, snapshot, current["metadata"], candidate)
        except ApiError as error:
            if error.code not in {"API_CONNECTION_FAILED", "API_RESPONSE_INVALID", "API_HTTP_ERROR"}:
                result["stage"] = "REMOTE_REJECTED"
                raise
            result["responseError"] = error.code
        else:
            result["stage"] = "REMOTE_ACKNOWLEDGED"
            store._receipt(operation)
    else:
        folder = store.directory / "operations" / operation["operationId"]
        submitted = (folder / ("submitted-" + digest(path) + ".txt")).read_text(encoding="utf-8")
        candidate = json.loads((folder / ("submitted-native-" + digest(path) + ".json")).read_text(encoding="utf-8"))
        if digest(submitted) != result["submittedHash"] or fingerprint(candidate) != result["submittedModelHash"]:
            raise ApiError("API_OPERATION_INVALID", "原生 PAGE 提交记录与哈希不一致")
        current = {**current, "content": submitted}
    verified = read(client, current["metadata"], check_info=True)
    if (result.get("nativeAcceptedVersion") and verified.version != result["nativeAcceptedVersion"]) or not saved_model_matches(candidate, verified.model):
        raise ApiError("API_PAGE_NATIVE_READBACK_MISMATCH", "原生 PAGE 回读与提交模型不一致，结果待核对；未重复上传")
    source = SourceFile(path, current["content"], "page", current["metadata"])
    accepted = as_file(verified, source, template=current["content"])
    publication = store.publish([accepted], uploaded_content={path: current["content"]})
    if publication["conflicts"]:raise ApiError("API_LOCAL_AFTER_UPLOAD_CONFLICT", "原生保存已回读，本地合并存在冲突，保留本地修改")
    result.update(stage="REMOTE_READBACK_VERIFIED", remoteHash=digest(accepted.content), nativeRemoteVersion=verified.version,
                  nativeReadbackHash=fingerprint(verified.model), sourceNormalized=not native_page._same(candidate, verified.model))

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
BATCH_EXPORT = "batch-export"


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


def read(client, metadata, *, check_info=False, require_checkout_owner=True):
    if check_info:
        response = client.request(INFO, form={"pageId": metadata["pageId"]})
        info = response.get("page") if isinstance(response, dict) else None
        if not isinstance(info, dict) or any(str(info.get(k)) != str(metadata[k]) for k in ("pageId", "systemId")):
            raise ApiError("API_IDENTITY_MISMATCH", "原生 PAGE 基本信息与当前项目/子系统不一致")
        owner = info.get("checkOutUserId")
        if require_checkout_owner and owner and owner != client.session.get("userId"):
            raise ApiError("API_PAGE_CHECKED_OUT_OTHER", "PAGE 已由其他用户签出，未保存或强制覆盖")
    response = client.request(READ, form={"pageId": metadata["pageId"]})
    identity = f"子系统 {metadata['systemId']} / PAGE {metadata['pageId']}"

    def invalid(reason):
        from .progress import emit
        emit(f"原生 PAGE 校验失败 · {json.dumps(identity, ensure_ascii=False)} · {reason}")
        return ApiError("API_PAGE_NATIVE_INVALID", f"{identity} 的原生应答{reason}")

    if not isinstance(response, dict):
        raise invalid("不是对象")
    missing = [field for field in ("bean", "version") if field not in response]
    if missing:
        raise invalid(f"缺少 {', '.join(missing)}")
    value = response.get("bean")
    version = response["version"]
    metadata_only = isinstance(value, dict) and bool(value) and set(value) <= {"pageId", "pageType", "isProduct", "pageAliasId"}
    if not (isinstance(version, str) and version) and not (version is None and metadata_only):
        raise invalid("没有可核验版本")
    if value is not None:
        if not isinstance(value, dict) or value.get("pageId") != metadata["pageId"]:
            raise ApiError("API_IDENTITY_MISMATCH", "原生 PAGE 编码与请求身份不一致")
        try:
            fingerprint(value)
            if "pageType" in value and "pageType" in metadata and float(value["pageType"]) != float(metadata["pageType"]):
                raise ValueError("pageType")
        except (TypeError, ValueError) as error:
            raise invalid("中的模型或页面类型无效") from error
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


def cached_snapshot(source, cached):
    if not cached or not source.metadata.get("versionMac"):
        return None
    meta = cached["metadata"]
    if meta.get("pageSource") != ORIGIN or meta.get("nativeVersion") != source.metadata["versionMac"]:
        return None
    if any(meta.get(key) != source.metadata.get(key) for key in ("systemId", "pageId", "pageSubId")):
        return None
    try:
        value = None if meta.get("nativeState") == "ABSENT" else model(cached["baseContent"])
        if fingerprint(value) == meta.get("nativeModelHash"):
            return Snapshot(value, meta["nativeVersion"])
    except (ValueError, TypeError, ApiError):
        # An invalid local cache is not an authoritative model.
        return None
    return None


def from_bulk(source, store):
    if source.kind != "page" or not structured(source.metadata, source.path):
        return source
    cached = baseline(store, source.path)
    snapshot = cached_snapshot(source, cached)
    if snapshot is not None and snapshot.model is not None:
        return as_file(snapshot, source, template=cached["baseContent"])
    return SourceFile(source.path, source.content, source.kind,
                      {**source.metadata, "pageSource": BATCH_EXPORT}, readonly=True)


def resolve(client, source, *, store=None):
    if not structured(source.metadata, source.path):return source
    cached = baseline(store, source.path)
    snapshot = cached_snapshot(source, cached)
    if snapshot is not None:
        return as_file(snapshot, source, template=cached["baseContent"])
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
_MAIN_TABLE_COLUMN_ZERO_DEFAULTS = {
    "autoHeight", "editable", "isDisAdvSearch", "isDisExtraSearch", "isDisLabel", "isImageUpload", "isMust",
    "isProduct", "isRichEdit", "isRowSpanning", "isSum", "isTrimValue", "isUseMaxEdit",
    "pcAndH5", "useTableFieldName",
}
_SEARCH_TEXT_FIELD_ZERO_DEFAULTS = {
    "isCanRemoveGroupField", "isDisExtraSearch", "isEndDate", "isMust", "isProduct",
    "isRowSpanning", "isTrimValue", "isUseMaxEdit", "pcAndH5",
}
_MAIN_TABLE_CHILD_ZERO_DEFAULTS = {"datasource": {"isProduct"}, "params": {"isNeedSum"}}


def normalize_saved_model(model):
    """Compare native PAGE content without known server/editor default shapes."""
    def clean(value, location=(), *, owner_component=None):
        if isinstance(value, list):
            return [
                clean(v, location + (str(index),), owner_component=owner_component)
                for index, v in enumerate(value)
            ]
        if not isinstance(value, dict):return value
        component = value.get("type") if location[:1] == ("views",) and location[-1:] == ("component",) else None
        member_type = value.get("type") if len(location) >= 2 and location[-2] == "fields" else None
        table_column = owner_component == "table-main" and member_type in ("text", "datetime")
        search_text = owner_component == "search-box" and member_type == "text"
        if table_column:
            zero_defaults = _MAIN_TABLE_COLUMN_ZERO_DEFAULTS
        elif search_text:
            zero_defaults = _SEARCH_TEXT_FIELD_ZERO_DEFAULTS
        elif owner_component == "table-main":
            zero_defaults = _MAIN_TABLE_CHILD_ZERO_DEFAULTS.get(location[-1], ())
        else:
            zero_defaults = ()
        result = {}
        for key, item in value.items():
            child_owner = component if key in {"fields", "datasource", "params"} else None
            item = clean(item, location + (key,), owner_component=child_owner)
            if item is None or item == "" or item == {} or item == []:continue
            if key in zero_defaults and type(item) in (int, float) and item == 0:
                continue
            if table_column or search_text:
                if (key == "selectBox" and isinstance(item, dict) and item.keys() == {"forceSelection"}
                        and type(item["forceSelection"]) is int and item["forceSelection"] == 0):
                    continue
            default = _DEFAULTS.get(key)
            if table_column and member_type == "datetime" and key == "dataType":
                default = "DATETIME"
            # Native save omits zero decimal precision on datasource fields/PKs.
            # Report zoom also uses "scale", so it must retain its own semantics.
            if key == "scale" and len(location) >= 3 and location[-3] == "datasource" and location[-2] in {"fields", "pks"}:
                default = 0
            if default is not None and type(item) is not bool and type(item) in (str, int, float) and item == default:continue
            result[key] = item
        return result
    return clean(model)


def saved_model_matches(candidate, received):
    return native_page._same(normalize_saved_model(candidate), normalize_saved_model(received))


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


def _verified_upload_file(client, source, result, candidate):
    from .store import digest

    accepted_version = result.get("nativeAcceptedVersion")
    # Acknowledged saves are checked by exact version and model. Checkout ownership
    # still applies before any save and when no accepted version was recorded.
    verified = read(client, source.metadata, check_info=True, require_checkout_owner=not accepted_version)
    if ((accepted_version and verified.version != accepted_version)
            or not saved_model_matches(candidate, verified.model)):
        raise ApiError("API_PAGE_NATIVE_READBACK_MISMATCH", "原生 PAGE 回读与提交模型不一致，结果待核对；未重复上传")
    accepted = as_file(verified, source, template=source.content)
    proof = {
        "stage": "REMOTE_READBACK_VERIFIED", "remoteHash": digest(accepted.content),
        "nativeRemoteVersion": verified.version, "nativeReadbackHash": fingerprint(verified.model),
        "sourceNormalized": not native_page._same(candidate, verified.model),
    }
    return accepted, proof


def recover_upload_file(store, client, source, result, operation):
    """Use the frozen submission and a fresh readback without sending a save."""
    from .store import digest

    folder = store.directory / "operations" / operation["operationId"]
    path_hash = digest(source.path)
    try:
        submitted = (folder / ("submitted-" + path_hash + ".txt")).read_bytes().decode("utf-8")
        candidate = json.loads((folder / ("submitted-native-" + path_hash + ".json")).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ApiError("API_OPERATION_INVALID", "无法读取原生 PAGE 提交记录") from error
    if digest(submitted) != result["submittedHash"] or fingerprint(candidate) != result["submittedModelHash"]:
        raise ApiError("API_OPERATION_INVALID", "原生 PAGE 提交记录与哈希不一致")
    accepted, proof = _verified_upload_file(
        client, SourceFile(source.path, submitted, "page", source.metadata), result, candidate,
    )
    return accepted, submitted, proof


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
        submitted = current["content"]
        accepted, proof = _verified_upload_file(client, SourceFile(path, submitted, "page", current["metadata"]), result, candidate)
    else:
        source = SourceFile(path, current["content"], "page", current["metadata"])
        accepted, submitted, proof = recover_upload_file(store, client, source, result, operation)
    publication = store.publish([accepted], uploaded_content={path: submitted})
    if publication["conflicts"]:raise ApiError("API_LOCAL_AFTER_UPLOAD_CONFLICT", "原生保存已回读，本地合并存在冲突，保留本地修改")
    result.update(proof)
    result.pop("code", None)
    result.pop("message", None)

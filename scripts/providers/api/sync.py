"""API refresh/upload orchestration with receipts and mandatory remote readback."""

from __future__ import annotations
import base64
import uuid
from urllib.parse import quote
from common.persistence import atomic_text, file_lock
from .client import ApiError
from .download import download, fetch_object, files_from_item, records, BASE
from .editor_state import assert_writable
from .store import ApiStore, digest
from .workspace import settings, save_project, active_scope, api_paths


def pull(workspace, client):
    directory, _ = api_paths(workspace)
    with file_lock(directory / "sync.lock"):
        assert_writable(workspace, None)
        files, scope = download(
            client,
            settings(workspace),
            on_project=lambda systems, sources: save_project(
                workspace, systems, sources
            ),
        )
        result = ApiStore(workspace).publish(files, scope=scope, authoritative=True)
        from .index import rebuild

        result["index"] = rebuild(workspace)
        result["downloadComplete"] = result["complete"]
        result["complete"] = result["complete"] and result["index"]["complete"]
        return {
            **result,
            "downloadedFiles": len(files),
            "checkoutPath": str(workspace["providerSourceRoot"]),
        }


def target(workspace, payload):
    store = ApiStore(workspace)
    if payload.get("path"):
        return store.read(payload["path"])
    kind = payload.get("sourceType")
    if kind == "bill-type":
        raise ApiError(
            "API_SOURCE_UNAVAILABLE",
            "官方源码接口未提供单据类型；请使用保留的只读导出功能",
        )
    if kind not in {"page", "procedure", "table", "view", "system-script"}:
        raise ApiError("API_INPUT_INVALID", "请提供精确对象类型和身份")
    identity = {
        "page": "pageId",
        "procedure": "funId",
        "table": "tableId",
        "view": "viewId",
        "system-script": "scriptType",
    }[kind]
    identifier = payload.get(identity) or payload.get("sourceId")
    if not identifier:
        raise ApiError("API_IDENTITY_MISSING", "缺少精确源码对象身份")
    matches = []
    for row in store.status():
        m = row["metadata"]
        if (
            not row["inScope"]
            or row["sourceType"] != kind
            or str(m.get(identity)) != str(identifier)
        ):
            continue
        if any(
            payload.get(k) and str(m.get(k)) != str(payload[k])
            for k in ("systemId", "dataSourceId", "procedureId")
        ):
            continue
        if payload.get("alias") and payload["alias"] not in {
            m.get("subPath"),
            m.get("procedureId"),
            m.get("pageAliasId"),
        }:
            continue
        matches.append(row)
    if len(matches) != 1:
        raise ApiError(
            "API_IDENTITY_AMBIGUOUS" if matches else "API_SOURCE_NOT_FOUND",
            "当前项目范围内未找到唯一精确对象，请先拉取对应子系统/数据源",
        )
    return store.read(matches[0]["path"])


def refresh(workspace, client, payload):
    directory, _ = api_paths(workspace)
    with file_lock(directory / "sync.lock"):
        source = target(workspace, payload)
        files = fetch_object(client, source["metadata"])
        main = [item for item in files if item.kind == source["metadata"]["sourceType"]]
        if len(main) != 1 or main[0].path != source["path"]:
            raise ApiError(
                "API_REMOTE_PATH_CHANGED",
                "平台对象路径已变化，请更新当前范围后核对迁移；未创建重复源码",
            )
        result = ApiStore(workspace).publish(files)
        from .index import update

        result["index"] = update(workspace, [x.path for x in files])
        result["downloadComplete"] = result["complete"]
        result["complete"] = result["complete"] and result["index"]["complete"]
        return {
            **result,
            "path": source["path"],
            "sourcePath": str(workspace["providerSourceRoot"] / source["path"]),
            "sourceType": source["metadata"]["sourceType"],
            "metadata": source["metadata"],
            "checkoutPath": str(workspace["providerSourceRoot"]),
        }


UPLOADS = {
    "page": ("commitModulePage.htm", ("pageId", "pageType", "versionMac")),
    "procedure": ("commitProcFun.htm", ("procedureId", "funId", "versionMac")),
    "table": ("commitTable.htm", ("tableId",)),
    "view": ("commitView.htm", ("pkid", "viewId")),
    "system-script": ("commitSystemScript.htm", ("systemId", "scriptType")),
}


def upload(workspace, client, payload):
    store = ApiStore(workspace)
    directory, _ = api_paths(workspace)
    paths = payload.get("paths")
    if paths is None:
        paths = [
            x["path"]
            for x in store.status()
            if x["inScope"] and x["state"] == "MODIFIED" and not x["readonly"]
        ]
    if (
        not isinstance(paths, list)
        or not paths
        or len(paths) > 200
        or any(not isinstance(x, str) for x in paths)
    ):
        raise ApiError("API_INPUT_INVALID", "上传需要1至200个精确源码路径")
    paths = list(dict.fromkeys(paths))
    expected = payload.get("expectedHashes", {})
    if not isinstance(expected, dict) or any(
        not isinstance(k, str) or not isinstance(v, str) for k, v in expected.items()
    ):
        raise ApiError("API_INPUT_INVALID", "expectedHashes必须为路径与哈希映射")
    if payload.get("confirm") is not True:
        raise ApiError(
            "API_CONFIRMATION_REQUIRED", "上传会修改开发平台，请确认本次上传对象"
        )
    operation = {
        "operationId": uuid.uuid4().hex,
        "kind": "upload",
        "paths": paths,
        "stage": "PREPARED",
        "results": [],
    }
    store._receipt(operation)
    with file_lock(directory / "sync.lock"):
        assert_writable(workspace, paths)
        # Validate every selected object before the first platform mutation.
        for path in paths:
            current = store.read(path)
            if expected.get(path) and current["sourceHash"] != expected[path]:
                raise ApiError("API_SOURCE_STALE", "确认上传后本地源码发生变化")
            if current["readonly"] or current["metadata"]["sourceType"] not in UPLOADS:
                raise ApiError("API_SOURCE_READONLY", "选择包含继承或不可上传资料")
            from .content import validate_candidate

            validate_candidate(
                path, current["metadata"], store.baseline(path), current["content"]
            )
            if current["metadata"].get("remoteDeleted"):
                raise ApiError(
                    "API_REMOTE_DELETED", "远端已删除的对象不能作为现有对象上传"
                )
        for path in paths:
            result = {"path": path, "stage": "PRECHECK"}
            operation["results"].append(result)
            store._receipt(operation)
            try:
                current = store.read(path)
                kind = current["metadata"]["sourceType"]
                if current["sourceHash"] == current["baseHash"]:
                    result["stage"] = "UNCHANGED"
                    continue
                remote = fetch_object(client, current["metadata"])
                main = [item for item in remote if item.kind == kind]
                if len(main) != 1 or main[0].path != path:
                    raise ApiError(
                        "API_REMOTE_PATH_CHANGED",
                        "平台对象路径已变化，未合并或上传；请先核对对象迁移",
                    )
                merged = store.publish(remote)
                if merged["conflicts"]:
                    raise ApiError(
                        "API_MERGE_CONFLICT", "本地与平台有冲突，请先解决冲突"
                    )
                current = store.read(path)
                m = current["metadata"]
                if current["sourceHash"] == current["baseHash"]:
                    result["stage"] = "ALREADY_REMOTE"
                    continue
                # Match the official routes: table identity is in native JSON;
                # views use the exact PKID together with their view ID.
                if kind == "view" and (
                    type(m.get("pkid")) is not int or m["pkid"] <= 0
                ):
                    raise ApiError("API_IDENTITY_MISSING", "视图缺少明确的PKID，未上传")
                from .content import validate_candidate

                validate_candidate(path, m, store.baseline(path), current["content"])
                endpoint, keys = UPLOADS[kind]
                form = {key: m.get(key, "") for key in keys}
                form["base64"] = quote(
                    base64.b64encode(current["content"].encode("utf-8")).decode(),
                    safe="",
                )
                result.update(
                    stage="REMOTE_REQUEST_PREPARED",
                    beforeHash=current["baseHash"],
                    submittedHash=current["sourceHash"],
                )
                atomic_text(
                    directory
                    / "operations"
                    / operation["operationId"]
                    / ("submitted-" + digest(path) + ".txt"),
                    current["content"],
                )
                store._receipt(operation)
                if store.read(path)["sourceHash"] != result["submittedHash"]:
                    raise ApiError("API_SOURCE_STALE", "上传前本地源码发生变化")
                result["stage"] = "REMOTE_REQUEST_STARTED"
                store._receipt(operation)
                response_error = None
                try:
                    response = client.request(
                        "/develop/vscode/source/upload/" + endpoint, form=form
                    )
                except ApiError as error:
                    if error.code in {
                        "API_CONNECTION_FAILED",
                        "API_RESPONSE_INVALID",
                        "API_HTTP_ERROR",
                    }:
                        response_error = error
                    else:
                        result["stage"] = "REMOTE_REJECTED"
                        raise
                else:
                    accepted = files_from_item(
                        m,
                        response.get("item") if isinstance(response, dict) else None,
                        expected_path=path,
                    )
                    accepted_main = next(x for x in accepted if x.path == path)
                    result.update(
                        stage="REMOTE_ACKNOWLEDGED",
                        acceptedHash=digest(accepted_main.content),
                        sourceNormalized=accepted_main.content != current["content"],
                    )
                    atomic_text(
                        directory / "operations" / operation["operationId"]
                        / ("accepted-" + digest(path) + ".txt"),
                        accepted_main.content,
                    )
                    store._receipt(operation)
                # A timeout is an unknown result. Read the remote object; never retry its POST.
                verified = fetch_object(client, m)
                exact = [x for x in verified if x.path == path]
                if (
                    len(exact) != 1
                    or digest(exact[0].content)
                    != result.get("acceptedHash", result["submittedHash"])
                ):
                    if response_error:
                        raise ApiError(
                            "API_REMOTE_RESULT_UNKNOWN",
                            "上传应答未知且回读未确认，不自动重试；请检查操作记录",
                        ) from response_error
                    raise ApiError(
                        "API_UPLOAD_READBACK_MISMATCH",
                        "平台回读与上传应答的源码不同，未标记上传成功",
                    )
                published = store.publish(
                    verified, uploaded_content={path: current["content"]}
                )
                if published["conflicts"]:
                    raise ApiError(
                        "API_LOCAL_AFTER_UPLOAD_CONFLICT",
                        "平台已回读，但本地更新冲突，请检查操作记录",
                    )
                result.update(
                    stage="REMOTE_READBACK_VERIFIED",
                    remoteHash=digest(exact[0].content),
                )
            except ApiError as error:
                unknown = result.get("stage") in {
                    "REMOTE_REQUEST_STARTED",
                    "REMOTE_ACKNOWLEDGED",
                }
                result.update(
                    stage="UNKNOWN" if unknown else "FAILED",
                    code=error.code,
                    message=str(error),
                )
                break
            finally:
                store._receipt(operation)
        operation["stage"] = (
            "REMOTE_READBACK_VERIFIED"
            if len(operation["results"]) == len(paths)
            and all(
                x["stage"]
                in {"REMOTE_READBACK_VERIFIED", "UNCHANGED", "ALREADY_REMOTE"}
                for x in operation["results"]
            )
            else "PARTIAL"
        )
        store._receipt(operation)
        from .index import update

        update(workspace, paths)
    return {
        **operation,
        "complete": operation["stage"] == "REMOTE_READBACK_VERIFIED",
        "uploaded": sum(
            x["stage"] == "REMOTE_READBACK_VERIFIED" for x in operation["results"]
        ),
        "platformFinalSubmit": "NOT_PERFORMED",
    }


def sync_database(workspace, client, payload):
    source = target(workspace, payload)
    store = ApiStore(workspace)
    m = source["metadata"]
    kind = m["sourceType"]
    if kind not in {"table", "view"}:
        raise ApiError("API_INPUT_INVALID", "只支持表/视图结构同步")
    if payload.get("confirm") is not True:
        raise ApiError(
            "API_CONFIRMATION_REQUIRED",
            "结构同步会在开发平台执行数据库DDL，需要明确确认",
        )
    assert_writable(workspace, [source["path"]])
    if source["sourceHash"] != source["baseHash"]:
        raise ApiError("API_LOCAL_MODIFIED", "请先上传并回读当前结构修改")
    pkid = m.get("pkid")
    if type(pkid) is not int:
        raise ApiError("API_IDENTITY_MISSING", "结构缺少数值pkid，不能执行结构同步")
    operation = {
        "operationId": uuid.uuid4().hex,
        "kind": "database-structure",
        "path": source["path"],
        "pkid": pkid,
        "stage": "REMOTE_REQUEST_STARTED",
    }
    store._receipt(operation)
    endpoint = "/develop/systems/" + (
        "tables/createTable.htm" if kind == "table" else "views/createView.htm"
    )
    try:
        client.request(endpoint, form={"pkid": str(pkid)})
        operation["stage"] = "PLATFORM_ACKNOWLEDGED"
        operation["databaseVerification"] = "NOT_PERFORMED"
    except ApiError as error:
        operation.update(
            stage="UNKNOWN"
            if error.code
            in {"API_CONNECTION_FAILED", "API_RESPONSE_INVALID", "API_HTTP_ERROR"}
            else "FAILED",
            code=error.code,
            message=str(error),
        )
        raise
    finally:
        store._receipt(operation)
    return operation


def create_function(workspace, client, payload):
    """Create an official procedure function and fetch its exact server representation."""
    for key in ("procedureId", "funId", "funName", "dataSourceId"):
        if not isinstance(payload.get(key), str) or not payload[key].strip():
            raise ApiError("API_INPUT_INVALID", key + "不能为空")
    if len(payload["funName"].encode("utf-8")) > 400:
        raise ApiError("API_INPUT_INVALID", "函数描述不能超过400字节")
    if any(type(payload.get(key)) is not bool for key in ("isTran", "isReturn")):
        raise ApiError("API_INPUT_INVALID", "事务/返回值标记必须为布尔值")
    if payload.get("confirm") is not True:
        raise ApiError(
            "API_CONFIRMATION_REQUIRED", "创建过程函数会修改平台，需要明确确认"
        )
    ds = payload["dataSourceId"]
    if ds not in active_scope(workspace)["dataSourceIds"]:
        raise ApiError("API_SOURCE_OUT_OF_SCOPE", "过程包不在当前项目选定的数据源内")
    from .download import paged

    procedures = paged(client, BASE + "getProcedures.htm", {"dataSourceId": ds})
    packages = [
        x for x in procedures if str(x.get("procedureId")) == payload["procedureId"]
    ]
    if len(packages) != 1:
        raise ApiError("API_IDENTITY_AMBIGUOUS", "未找到唯一过程包")
    package = packages[0]
    if any(
        str(x.get("funId")) == payload["funId"] for x in records(package.get("funs"))
    ):
        raise ApiError("API_SOURCE_EXISTS", "同名函数已存在，请编辑现有函数")
    store = ApiStore(workspace)
    operation = {
        "operationId": uuid.uuid4().hex,
        "kind": "create-function",
        "stage": "REMOTE_REQUEST_STARTED",
        "procedureId": payload["procedureId"],
        "funId": payload["funId"],
        "dataSourceId": ds,
    }
    store._receipt(operation)
    form = {k: payload[k] for k in ("procedureId", "funId", "funName")}
    form.update(
        opt="new",
        isTran="1" if payload["isTran"] else "0",
        isReturn="1" if payload["isReturn"] else "0",
    )
    try:
        client.request("/develop/procedure/admin/saveFunInfo.htm", form=form)
        files = fetch_object(
            client,
            {
                "sourceType": "procedure",
                "procedureId": payload["procedureId"],
                "funId": payload["funId"],
                "dataSourceId": ds,
                "subPath": package["subPath"],
            },
        )
        operation["publication"] = store.publish(files)
        operation["stage"] = "REMOTE_READBACK_VERIFIED"
        from .index import update

        update(workspace, [x.path for x in files])
    except ApiError as error:
        operation.update(
            stage="UNKNOWN"
            if error.code
            in {"API_CONNECTION_FAILED", "API_RESPONSE_INVALID", "API_HTTP_ERROR"}
            else "FAILED",
            code=error.code,
            message=str(error),
        )
        raise
    finally:
        store._receipt(operation)
    return operation


def verify_upload(workspace, client, operation_id):
    """Reconcile an interrupted receipt using GETs; this never repeats a mutation."""
    store = ApiStore(workspace)
    operation = store.operation(operation_id)
    if operation.get("kind") != "upload":
        raise ApiError("API_INPUT_INVALID", "请选择上传操作记录")
    with file_lock(store.directory / "sync.lock"):
        for result in operation["results"]:
            if result.get("stage") not in {
                "UNKNOWN",
                "REMOTE_REQUEST_STARTED",
                "REMOTE_ACKNOWLEDGED",
            }:
                continue
            source = store.read(result["path"])
            files = fetch_object(client, source["metadata"])
            exact = [x for x in files if x.path == result["path"]]
            if len(exact) == 1 and digest(exact[0].content) == result.get(
                "acceptedHash", result.get("submittedHash")
            ):
                submitted = (
                    store.directory / "operations" / operation_id
                    / ("submitted-" + digest(result["path"]) + ".txt")
                ).read_text(encoding="utf-8")
                if digest(submitted) != result["submittedHash"]:
                    raise ApiError("API_OPERATION_INVALID", "提交记录正文与哈希不一致")
                published = store.publish(
                    files, uploaded_content={result["path"]: submitted}
                )
                result["stage"] = "REMOTE_READBACK_VERIFIED"
                result["remoteHash"] = digest(exact[0].content)
                result["localConflicts"] = published["conflicts"]
            else:
                result.update(
                    stage="UNKNOWN",
                    message="当前平台内容不能证明先前上传结果；请人工核对，不自动重发",
                )
            store._receipt(operation)
        operation["stage"] = (
            "REMOTE_READBACK_VERIFIED"
            if len(operation["results"]) == len(operation["paths"])
            and all(
                x["stage"]
                in {"REMOTE_READBACK_VERIFIED", "UNCHANGED", "ALREADY_REMOTE"}
                for x in operation["results"]
            )
            else "PARTIAL"
        )
        store._receipt(operation)
        from .index import update

        update(workspace, [x["path"] for x in operation["results"]])
    return {
        **operation,
        "complete": operation["stage"] == "REMOTE_READBACK_VERIFIED",
        "mutationRetried": False,
    }


def platform_request(workspace, client, payload):
    """Explicit same-project request for platform functions outside typed commands."""
    from urllib.parse import urlsplit
    import json

    path = payload.get("path")
    method = payload.get("method", "GET")
    if (
        not isinstance(path, str)
        or not path.startswith("/develop/")
        or path.startswith("/develop/login/")
    ):
        raise ApiError(
            "API_INPUT_INVALID",
            "请输入当前项目的 /develop/ 业务接口；登录由独立认证入口处理",
        )
    parts = urlsplit(path)
    if (
        parts.netloc
        or parts.scheme
        or parts.query
        or parts.fragment
        or "\\" in path
        or ".." in path.split("/")
    ):
        raise ApiError(
            "API_INPUT_INVALID", "接口仅接受当前项目相对路径，查询参数单独提供"
        )
    if method not in {"GET", "POST"}:
        raise ApiError("API_INPUT_INVALID", "接口方法仅支持GET/POST")
    params = payload.get("params", {})
    form = payload.get("form", {})
    for values in (params, form):
        if not isinstance(values, dict) or any(
            not isinstance(k, str) or not isinstance(v, (str, int, float, bool))
            for k, v in values.items()
        ):
            raise ApiError("API_INPUT_INVALID", "参数必须为扁平JSON对象")
    scope = active_scope(workspace)
    for values in (params, form):
        if values.get("systemId") and str(values["systemId"]) not in scope["systemIds"]:
            raise ApiError("API_SOURCE_OUT_OF_SCOPE", "接口系统不在当前项目选择范围内")
        if (
            values.get("dataSourceId")
            and str(values["dataSourceId"]) not in scope["dataSourceIds"]
        ):
            raise ApiError(
                "API_SOURCE_OUT_OF_SCOPE", "接口数据源不在当前项目选择范围内"
            )
    if payload.get("confirm") is not True:
        raise ApiError(
            "API_CONFIRMATION_REQUIRED",
            "通用平台接口可能产生业务副作用，请明确确认当前接口与参数",
        )
    max_chars = payload.get("maxChars", 12000)
    if type(max_chars) is not int or not 1 <= max_chars <= 50000:
        raise ApiError("API_INPUT_INVALID", "maxChars必须在1至50000之间")
    store = ApiStore(workspace)
    operation = {
        "operationId": uuid.uuid4().hex,
        "kind": "platform-request",
        "method": method,
        "endpoint": path,
        "stage": "REMOTE_REQUEST_STARTED",
    }
    store._receipt(operation)
    try:
        response = client.request(
            path, params or None, **({"form": form} if method == "POST" else {})
        )
        operation["stage"] = "PLATFORM_ACKNOWLEDGED"
    except ApiError as error:
        operation.update(
            stage="UNKNOWN"
            if error.code
            in {"API_CONNECTION_FAILED", "API_HTTP_ERROR", "API_RESPONSE_INVALID"}
            else "FAILED",
            code=error.code,
            message=str(error),
        )
        raise
    finally:
        store._receipt(operation)
    content = json.dumps(response, ensure_ascii=False)
    return {
        **operation,
        "content": content[:max_chars],
        "totalChars": len(content),
        "truncated": len(content) > max_chars,
        "verification": "PLATFORM_RESPONSE_ONLY",
        "mutationRetried": False,
    }

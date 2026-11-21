"""API commands shared by the CLI, ToolHost, Nexus and Bridge."""

from __future__ import annotations
import argparse
from contextlib import closing
import json
import sys
from .client import ApiError
from .workspace import (
    configuration_lock,
    settings,
    configure,
    client_for,
    save_project,
    project_metadata,
    logout,
    save_session,
    last_login,
    active_scope,
)
from .download import records
from .store import ApiStore

ACTIONS = (
    "configure",
    "login",
    "logout",
    "session",
    "captcha",
    "systems",
    "data-sources",
    "pull",
    "scope-apply",
    "refresh",
    "status",
    "catalog",
    "reference",
    "reference-sync",
    "module-parameters-sync",
    "module-parameter-load",
    "module-parameter",
    "module-upload",
    "read",
    "write",
    "diff",
    "revert",
    "upload",
    "sync-database",
    "index",
    "search",
    "context",
    "callers",
    "facts",
    "explain",
    "inheritance",
    "inherited-write",
    "page",
    "view",
    "designer-context",
    "editor-state",
    "history",
    "operation",
    "conflict",
    "resolve-conflict",
    "create-function",
    "system-menu",
    "verify-upload",
    "export-changes",
    "import-changes",
    "platform-request",
    "page-lifecycle",
    "source-batch",
    "read-batch",
    "document",
    "index-health",
    "table-references",
)


def parser():
    result = argparse.ArgumentParser(prog="guthon_tool.py api")
    result.add_argument("action", choices=ACTIONS)
    result.add_argument(
        "--stdin", action="store_true", help="JSON input; credentials use stdin only"
    )
    return result


def execute(workspace, action, payload):
    if workspace.get('sourceMode', 'api') != 'api':
        raise ApiError('API_SOURCE_MODE_REQUIRED', '当前项目不是 API 源码模式；旧模式执行接线尚未提供')
    if not isinstance(payload, dict):
        raise ApiError("API_INPUT_INVALID", "输入必须是JSON对象")
    if action == "configure":
        with configuration_lock(workspace):
            before = settings(workspace)
            configured = configure(workspace, payload)
            result = {"settings": configured}
            if workspace["indexPath"].is_file() and any(
                before.get(key) != configured.get(key)
                for key in (
                    "serverUrl",
                    "systemIds",
                    "dataSourceIds",
                    "allSystems",
                    "includeProjectFiles",
                )
            ):
                from .index import update

                try:
                    result["index"] = update(workspace, [])
                except Exception as error:
                    raise ApiError(
                        "API_SCOPE_INDEX_REFRESH_REQUIRED",
                        "范围已保存，索引尚未按新范围建立，请重建当前项目索引："
                        + str(error),
                    ) from error
            return result
    if action == "logout":
        if payload:
            raise ApiError("API_INPUT_INVALID", "退出登录输入含未知字段")
        logout(workspace)
        return {"authenticated": False, "session": None}
    store = ApiStore(workspace)
    if action == "status":
        from common.workspace_registry import workspace_index_state

        changes_only = payload.get("changesOnly", False)
        if type(changes_only) is not bool:
            raise ApiError("API_INPUT_INVALID", "changesOnly 必须是布尔值")
        summary_only = payload.get("summaryOnly", False)
        if type(summary_only) is not bool:
            raise ApiError("API_INPUT_INVALID", "summaryOnly 必须是布尔值")
        files = [] if summary_only else store.status(use_cache=True)
        active = [item for item in files if item["inScope"]]
        index_state = workspace_index_state(workspace)
        if index_state["ready"]:
            from .index import _connection

            with closing(_connection(workspace)) as connection:
                index_state["indexGeneration"] = connection.execute(
                    "SELECT state_value FROM gusen_sync_state WHERE state_key='generation'"
                ).fetchone()[0]
        return {
            "settings": settings(workspace),
            "checkoutPath": str(workspace["providerSourceRoot"]),
            "workspaceRoot": str(workspace["root"]),
            "files": [item for item in files if item["state"] != "CLEAN"]
            if changes_only else files,
            "summary": {
                "sourceCount": store.registered_count() if summary_only else len(active),
                "changedCount": None if summary_only else sum(item["state"] != "CLEAN" for item in active),
                "uploadableCount": None if summary_only else sum(
                    item["state"] == "MODIFIED" and not item["readonly"]
                    for item in active
                ),
            },
            "unverifiedUploadCount": sum(operation.get("kind") in {"upload","module-upload"} and
                (operation.get("stage") in {"UNKNOWN","REMOTE_REQUEST_STARTED","REMOTE_ACKNOWLEDGED","SAVE_REQUEST_STARTED","CHECKOUT_REQUEST_STARTED"} or
                 any(item.get("stage") in {"UNKNOWN","REMOTE_REQUEST_STARTED","REMOTE_ACKNOWLEDGED","SAVE_REQUEST_STARTED","CHECKOUT_REQUEST_STARTED"} for item in operation.get("results",[])) or operation.get("kind")=="module-upload" and
                 (operation.get("stage")=="PREPARED" or any(item.get("stage")=="PREPARED" for item in operation.get("results",[]))))
                for operation in (store.history(50) if not summary_only else [])),
            "changesOnly": changes_only,
            "summaryComplete": not summary_only,
            "statusKind": "metadata-only" if summary_only else "scanned",
            "index": index_state,
            "sessionPersistence": "current-toolhost",
            "lastLogin": last_login(workspace),
        }
    if action == "module-parameter-load":
        from .module_parameters import load_parameter
        return load_parameter(workspace, client_for(workspace, authenticated=True), payload)
    if action == "module-parameter":
        from .module_parameter_editor import run
        return run(workspace,payload)
    if action == "page-lifecycle":
        from common.runtime_paths import tool_home
        from . import page_lifecycle
        return page_lifecycle.run(workspace, tool_home(), payload)
    if action == "source-batch":
        from . import source_batch
        return source_batch.run(workspace, payload)
    if action == "read-batch":
        from .query_operations import read_batch
        return read_batch(workspace, payload)
    if action == "index-health":
        from .index import health
        return health(workspace)
    if action == "table-references":
        from .query_operations import table_references
        return table_references(workspace, payload.get("tableName"), payload.get("columnName", ""), payload.get("limit", 20), payload.get("offset", 0), payload.get("graph", False))
    if action == "document":
        from . import documents
        operation = payload.get("action")
        if operation == "open":
            return documents.open_document(workspace, payload.get("path"), payload.get("ttlSeconds", 1800))
        if operation == "preview":
            return documents.preview(workspace, payload.get("leaseId"), payload.get("content"), payload.get("operations"))
        if operation == "write":
            return documents.write(workspace, payload.get("leaseId"), payload.get("previewId"), payload.get("idempotencyKey"), editor_token=payload.get("editorToken"))
        if operation == "renew":
            return documents.renew_document(workspace, payload.get("leaseId"), payload.get("ttlSeconds", 1800))
        if operation == "close":
            return documents.close_document(workspace, payload.get("leaseId"))
        if operation == "operation":
            return documents.operation(workspace, payload.get("operationId"))
        if operation == "verify":
            return documents.verify(workspace, payload.get("operationId"))
        if operation == "resume":
            return documents.resume_operation(workspace, payload.get("operationId"))
        raise ApiError("API_INPUT_INVALID", "未知文档操作")
    if action == "reference":
        from .reference_assets import read_reference

        return read_reference(workspace, payload)
    if action == "editor-state":
        from .editor_state import update

        return update(workspace, payload)
    if action in {"read", "diff", "write", "revert"}:
        path = payload.get("path")
        if action == "read":
            item = store.read(path)
            kind = item["metadata"].get("sourceType")
            if kind == "page":
                from .native_page import is_metadata_only
                if is_metadata_only(item["content"], item["metadata"], item["path"]):
                    return {**item, "storeReadonly": item["readonly"], "projectionReadonly": True, "sourceFormat": "native-page-minimal", "contentState": "METADATA_ONLY", "identitySource": "API_METADATA", "diagnostic": "API_PAGE_MINIMAL_SOURCE"}
                from .index import page_format, PageIdentityMismatch
                try:
                    page_format(item)
                except PageIdentityMismatch:
                    return {**item, "storeReadonly": item["readonly"], "readonly": True, "projectionReadonly": True, "sourceFormat": "unsupported", "contentState": "IDENTITY_MISMATCH", "identitySource": "API_METADATA", "diagnostic": "API_PAGE_IDENTITY_MISMATCH"}
                except (ValueError, TypeError):
                    pass  # Preserve the raw-source entry for other unsupported page formats.
            elif kind == "view":
                from .view_editor import is_metadata_only
                if is_metadata_only(item["content"], item["metadata"], item["path"]):
                    return {**item, "storeReadonly": item["readonly"], "projectionReadonly": True, "sourceFormat": "view-no-sql", "contentState": "SQL_ABSENT", "identitySource": "SOURCE_AND_API_METADATA", "diagnostic": "API_VIEW_SQL_ABSENT"}
            return item
        if action == "diff":
            if "view" in payload:
                from .source_diff import read_diff
                return read_diff(workspace, path, view=payload["view"], offset=payload.get("offset",0), max_chars=payload.get("maxChars",50000))
            return store.diff(path)
        if action == "write":
            result = store.write(
                path,
                payload.get("content"),
                payload.get("expectedHash"),
                editor_token=payload.get("editorToken"),
            )
        else:
            result = store.revert(
                path,
                payload.get("expectedHash"),
                editor_token=payload.get("editorToken"),
            )
        from .index import update

        result["index"] = update(workspace, [path])
        return result
    if action == "conflict":
        return store.conflict(payload.get("path"))
    if action == "resolve-conflict":
        result = store.resolve_conflict(
            payload.get("path"),
            payload.get("choice"),
            payload.get("expectedHash"),
            payload.get("content"),
            editor_token=payload.get("editorToken"),
        )
        from .index import update

        result["index"] = update(workspace, [payload["path"]])
        return result
    if action in {"export-changes", "import-changes"}:
        from .change_bundle import export_changes, import_changes

        return (export_changes if action == "export-changes" else import_changes)(
            workspace, payload
        )
    if action == "history":
        return {"operations": store.history(payload.get("limit", 20))}
    if action == "operation":
        return store.operation(payload.get("operationId"))
    if action == "inherited-write":
        from .inheritance_edit import write

        return write(workspace, payload)
    if action == "page":
        from .page import run

        return run(workspace, payload)
    if action == "view":
        from .view_editor import run

        return run(workspace, payload)
    if action in {
        "index",
        "catalog",
        "search",
        "context",
        "callers",
        "facts",
        "explain",
    }:
        from . import index

        limit = payload.get("limit", 100 if action in {"catalog", "callers"} else 20)
        offset = payload.get("offset", 0)
        if action == "index":
            check_only = payload.get("checkOnly", False)
            compare_index = payload.get("compareIndex", False)
            if type(check_only) is not bool:
                raise ApiError("API_INPUT_INVALID", "checkOnly 必须是布尔值")
            if type(compare_index) is not bool or (compare_index and not check_only):
                raise ApiError("API_INPUT_INVALID", "compareIndex 仅用于 checkOnly 路径检查")
            if "paths" not in payload:
                if check_only:
                    raise ApiError("API_INPUT_INVALID", "checkOnly 需要 paths 数组")
                return index.rebuild(workspace)
            selected = store.registered_paths(payload["paths"])
            ignored = len(payload["paths"]) - len(selected)
            if check_only:
                checked = (index.check_pending_paths(workspace, store, selected) if compare_index
                           else {"updatedPaths": selected})
                return {"workspaceKey": workspace["workspaceKey"], **checked,
                        "ignoredCount": ignored, "skipped": True, "checkOnly": True}
            if not payload["paths"]:
                return {**index.update(workspace, []), "ignoredCount": 0, "skipped": False}
            if not selected:
                status = index.health(workspace)
                return {"workspaceKey": workspace["workspaceKey"], "updatedPaths": [],
                        "ignoredCount": ignored, "skipped": True, "indexReady": status["ready"],
                        "complete": status.get("complete", False),
                        **({"errorCode": status["errorCode"]} if "errorCode" in status else {})}
            result = index.update(workspace, selected)
            return {**result, "ignoredCount": ignored, "skipped": False}
        if action == "catalog":
            result = index.catalog(workspace, limit, offset)
            project = project_metadata(workspace, include_menu=True) if offset == 0 else None
            if project is not None:
                scope = active_scope(workspace)
                project = {**project,
                           "systems": [row for row in project.get("systems", []) if row["systemId"] in scope["systemIds"]],
                           "dataSources": [row for row in project.get("dataSources", []) if row["dataSourceId"] in scope["dataSourceIds"]]}
                if "menuTree" in project:
                    project["menuTree"] = [row for row in project["menuTree"] if row["systemId"] in scope["systemIds"]]
            return {**result, "objects": result.get("items", result.get("objects", [])),
                    **({"project": {k: project[k] for k in ("systems", "dataSources", "menuTree") if k in project}} if project is not None else {})}
        if action == "search":
            return index.search(workspace, payload.get("query"), limit, offset)
        if action == "context":
            return index.context(workspace, payload.get("path"), limit, offset)
        if action == "callers":
            return index.callers(
                workspace, payload.get("alias", ""), payload.get("funId", ""), limit, offset,
                path=payload.get("path", ""),
            )
        if action == "facts":
            return index.facts(
                workspace,
                payload.get("keyword", ""),
                payload.get("path", ""),
                limit,
                offset,
            )
        return index.explain(
            workspace,
            table_name=payload.get("table", ""),
            bill_type_code=payload.get("billType", ""),
            data_source_id=payload.get("dataSourceId", ""),
            operation=payload.get("operation", "WRITE"),
            limit=payload.get("limit", 1),
            offset=offset,
            fact_limit=payload.get("factLimit", 4),
            caller_depth=payload.get("callerDepth", 2),
            include_details=payload.get("includeDetails", False),
        )
    if action == "session":
        local_only = payload.get("localOnly", False)
        if type(local_only) is not bool:
            raise ApiError("API_INPUT_INVALID", "localOnly 必须是布尔值")
        if not settings(workspace)["serverUrl"]:
            return {"authenticated": False, "session": None}
        try:
            client = client_for(workspace, authenticated=not local_only)
            if local_only:
                if client.session is None:
                    return {"authenticated": False, "session": None}
            else:
                client.validate_session()
        except ApiError as error:
            return {
                "authenticated": False,
                "session": None,
                **(
                    {"error": {"code": error.code, "message": str(error)}}
                    if error.code != "API_LOGIN_REQUIRED"
                    else {}
                ),
            }
        return {
            "authenticated": True,
            "session": {
                key: client.session.get(key, "")
                for key in ("userName", "mainVersion", "dateVersion")
            },
        }
    if action == "inheritance":
        from .index import inheritance

        return inheritance(
            workspace,
            payload.get("path"),
            payload.get("jsonPointer", ""),
            payload.get("offset", 0),
            payload.get("maxChars", 12000),
        )
    if action == "captcha":
        return {"dataURL": client_for(workspace).captcha()["image"]}
    if action == "login":
        if set(payload) - {"userId", "password", "randCode"}:
            raise ApiError("API_INPUT_INVALID", "登录输入含未知字段")
        session = client_for(workspace).login(
            payload.get("userId"), payload.get("password"), payload.get("randCode", "")
        )
        save_session(workspace, session)
        return {"session": session}
    if action == "scope-apply":
        from . import sync
        return sync.scope_apply(workspace, None, payload)
    client = client_for(workspace, authenticated=True)
    if action == "module-parameters-sync":
        from .module_parameters import sync_parameters
        return sync_parameters(workspace, client, payload.get("systemId"))
    if action == "module-upload":
        from .module_parameter_upload import run
        return run(workspace,client,payload)
    if action == "reference-sync":
        from .reference_assets import sync_references
        return sync_references(workspace, client, payload.get("paths"))
    if action == "designer-context":
        return client.designer_context()
    if action == "system-menu":
        def menu_node(node):
            if not isinstance(node, dict) or node.get("id") is None:
                raise ApiError("API_RESPONSE_INVALID", "菜单缺少身份")
            result = {k: node[k] for k in ("id", "name", "isDir") if k in node}
            for field in ("childs", "pages"):
                if field in node:
                    if not isinstance(node[field], list):
                        raise ApiError("API_RESPONSE_INVALID", "菜单层级无效")
                    result[field] = ([menu_node(child) for child in node[field]] if field == "childs" else
                                     [{k: page[k] for k in ("pageId", "pageSubId") if k in page} for page in node[field] if isinstance(page, dict)])
            return result
        response = client.request("/develop/vscode/source/download/getModuleTree.htm")
        rows = records(response)
        menu = []
        for row in rows:
            if row.get("systemId") is None or not isinstance(row.get("menus"), list):
                raise ApiError("API_RESPONSE_INVALID", "系统菜单身份无效")
            menu.append({"systemId": str(row["systemId"]), "menus": [menu_node(node) for node in row["menus"]]})
        save_project(workspace, menu_tree=menu)
        return {"menu": response}
    if action in {"systems", "data-sources"}:
        systems = action == "systems"
        key = "systems" if systems else "dataSources"
        endpoint = (
            "/develop/systems/apps/developSystemList.htm"
            if systems
            else "/develop/systems/datasource/list.htm"
        )
        fields = (
            ("systemId", "systemName", "dataSourceId")
            if systems
            else ("dataSourceId", "dataSourceName")
        )
        rows = [
            {k: str(row[k]) for k in fields if row.get(k) is not None}
            for row in records(client.request(endpoint))
        ]
        save_project(
            workspace, **({"systems": rows} if systems else {"data_sources": rows})
        )
        return {key: rows}
    from . import sync

    if action == "pull":
        check_only = payload.get("checkOnly", False)
        if type(check_only) is not bool:
            raise ApiError("API_INPUT_INVALID", "checkOnly 必须为布尔值")
        if check_only:
            from .download import download
            files, scope = download(client, settings(workspace))
            return {
                "workspaceKey": workspace["workspaceKey"], "checkedFiles": len(files),
                "scope": scope, "sourcePublished": False, "checkOnly": True,
            }

        return sync.pull(workspace, client)
    if action == "refresh":
        return sync.refresh(workspace, client, payload)
    if action == "upload":
        return sync.upload(workspace, client, payload)
    if action == "verify-upload":
        return sync.verify_upload(workspace, client, payload.get("operationId"))
    if action == "sync-database":
        return sync.sync_database(workspace, client, payload)
    if action == "platform-request":
        return sync.platform_request(workspace, client, payload)
    if action == "create-function":
        return sync.create_function(workspace, client, payload)
    raise ApiError("API_INPUT_INVALID", "未知API操作")


def run(workspace, args):
    parsed = parser().parse_args(args)
    payload = json.load(sys.stdin) if parsed.stdin else {}
    publishes_source = parsed.action in {"pull", "scope-apply", "refresh", "upload"} and not (
        parsed.action == "pull" and isinstance(payload, dict) and payload.get("checkOnly") is True
    )
    try:
        from .progress import operation, emit

        with operation(workspace["workspaceKey"], parsed.action):
            result = execute(workspace, parsed.action, payload)
            state = "部分完成，请核对结果" if result.get("complete") is False else "已返回处理结果"
            emit(state)
    except Exception as error:
        if publishes_source:
            from common import gusen_hub
            from common.command_errors import error_code

            gusen_hub.append_pull_log(
                "source",
                "api-" + parsed.action,
                {
                    "workspaceKey": workspace["workspaceKey"],
                    "status": "FAILED",
                    "errorCode": error_code(error),
                },
                ok=False,
            )
            gusen_hub.update_workspace_state(
                gusen_hub.load_config(), workspace, "source", "FAILED", error
            )
        raise
    if publishes_source:
        from common import gusen_hub

        gusen_hub.append_pull_log(
            "source",
            "api-" + parsed.action,
            {
                "status": "SUCCESS" if result.get("complete", True) else "PARTIAL",
                **({"errorCode": result["error"]["code"]} if result.get("error") else {}),
                **{key: result[key] for key in (
                    "operationId",
                    "complete",
                    "downloadedFiles",
                    "uploaded",
                    "checkoutPath",
                )
                if key in result},
            },
            ok=result.get("complete", True),
        )
        gusen_hub.update_workspace_state(
            gusen_hub.load_config(),
            workspace,
            "source",
            "SUCCESS" if result.get("complete", True) else "PARTIAL",
            full_sync=parsed.action in {"pull", "scope-apply"} and result.get("complete", False),
        )
    print(
        json.dumps(
            {
                "ok": True,
                "workspaceKey": workspace["workspaceKey"],
                "sourceMode": "api",
                **result,
            },
            ensure_ascii=False,
        )
    )
    return 0

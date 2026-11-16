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
    remember_login,
    save_session,
    last_login,
)
from .download import records
from .store import ApiStore

ACTIONS = (
    "configure",
    "login",
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
)


def parser():
    result = argparse.ArgumentParser(prog="guthon_tool.py api")
    result.add_argument("action", choices=ACTIONS)
    result.add_argument(
        "--stdin", action="store_true", help="JSON input; credentials use stdin only"
    )
    return result


def execute(workspace, action, payload):
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
            "sessionPersistence": "current-toolhost-or-system-keyring",
            "lastLogin": last_login(workspace),
        }
    if action == "module-parameter":
        from .module_parameter_editor import run
        return run(workspace,payload)
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
            if type(check_only) is not bool:
                raise ApiError("API_INPUT_INVALID", "checkOnly 必须是布尔值")
            if "paths" not in payload:
                if check_only:
                    raise ApiError("API_INPUT_INVALID", "checkOnly 需要 paths 数组")
                return index.rebuild(workspace)
            selected = store.registered_paths(payload["paths"])
            ignored = len(payload["paths"]) - len(selected)
            if check_only:
                return {"workspaceKey": workspace["workspaceKey"], "updatedPaths": selected,
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
            return {**result, "objects": result.get("items", result.get("objects", [])),
                    **({"project": {k: project[k] for k in ("systems", "dataSources", "menuTree") if k in project}} if project is not None else {})}
        if action == "search":
            return index.search(workspace, payload.get("query"), limit, offset)
        if action == "context":
            return index.context(workspace, payload.get("path"), limit, offset)
        if action == "callers":
            return index.callers(
                workspace, payload.get("alias"), payload.get("funId", ""), limit, offset
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
        if not settings(workspace)["serverUrl"]:
            return {"authenticated": False, "session": None}
        try:
            client = client_for(workspace, authenticated=True)
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
        if set(payload) - {"userId", "password", "randCode", "remember"}:
            raise ApiError("API_INPUT_INVALID", "登录输入含未知字段")
        session = client_for(workspace).login(
            payload.get("userId"), payload.get("password"), payload.get("randCode", "")
        )
        save_session(workspace, session)
        if "remember" in payload:
            remember_login(
                workspace, payload["userId"], payload["password"], payload["remember"]
            )
        return {"session": session}
    if action == "scope-apply":
        from . import sync
        return sync.scope_apply(workspace, None, payload)
    client = client_for(workspace, authenticated=True)
    if action == "module-parameters-sync":
        from .module_parameters import sync_parameters
        return sync_parameters(workspace, client)
    if action == "module-upload":
        from .module_parameter_upload import run
        return run(workspace,client,payload)
    if action == "reference-sync":
        from .reference_assets import sync_references
        return sync_references(workspace, client)
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
    try:
        result = execute(workspace, parsed.action, payload)
    except Exception as error:
        if parsed.action in {"pull", "scope-apply", "refresh", "upload"}:
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
    if parsed.action in {"pull", "scope-apply", "refresh", "upload"}:
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

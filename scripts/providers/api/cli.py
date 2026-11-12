"""API commands shared by the CLI, ToolHost, Nexus and Bridge."""

from __future__ import annotations
import argparse
import json
import sys
from common.persistence import file_lock
from .client import ApiError
from .workspace import (
    api_paths,
    settings,
    configure,
    client_for,
    save_project,
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
    "refresh",
    "status",
    "catalog",
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
        directory, _ = api_paths(workspace)
        with file_lock(directory / "configuration.lock"):
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

        return {
            "settings": settings(workspace),
            "checkoutPath": str(workspace["providerSourceRoot"]),
            "workspaceRoot": str(workspace["root"]),
            "files": store.status(),
            "index": workspace_index_state(workspace),
            "sessionPersistence": "current-toolhost-or-system-keyring",
            "lastLogin": last_login(workspace),
        }
    if action == "editor-state":
        from .editor_state import update

        return update(workspace, payload)
    if action in {"read", "diff", "write", "revert"}:
        path = payload.get("path")
        if action == "read":
            return store.read(path)
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
            return (
                index.update(workspace, payload["paths"])
                if "paths" in payload
                else index.rebuild(workspace)
            )
        if action == "catalog":
            result = index.catalog(workspace, limit, offset)
            return {**result, "objects": result.get("items", result.get("objects", []))}
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
    client = client_for(workspace, authenticated=True)
    if action == "designer-context":
        return client.designer_context()
    if action == "system-menu":
        return {
            "menu": client.request("/develop/vscode/source/download/getModuleTree.htm")
        }
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
        if parsed.action in {"pull", "refresh", "upload"}:
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
    if parsed.action in {"pull", "refresh", "upload"}:
        from common import gusen_hub

        gusen_hub.append_pull_log(
            "source",
            "api-" + parsed.action,
            {
                key: result[key]
                for key in (
                    "operationId",
                    "complete",
                    "downloadedFiles",
                    "uploaded",
                    "checkoutPath",
                )
                if key in result
            },
            ok=result.get("complete", True),
        )
        gusen_hub.update_workspace_state(
            gusen_hub.load_config(),
            workspace,
            "source",
            "SUCCESS" if result.get("complete", True) else "PARTIAL",
            full_sync=parsed.action == "pull" and result.get("complete", False),
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

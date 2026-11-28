"""Dispatch legacy source commands after common workspace resolution."""
import argparse
from contextlib import closing
from datetime import datetime
import json
from pathlib import Path
import sys
import time

from common.command_errors import CommandError


def build_svn_parser() -> argparse.ArgumentParser:
    from providers.svn.cli import ACTION_HANDLERS

    parser = argparse.ArgumentParser(prog="guthon_tool.py svn")
    parser.add_argument("action", choices=list(ACTION_HANDLERS))
    parser.add_argument("--prune", action="store_true", help="exclude paths removed from the configured sparse scope")
    parser.add_argument(
        "--accept-scope-change",
        action="store_true",
        help="accept the reviewed workspace checkout script as the new exact authorization manifest",
    )
    parser.add_argument("--diff", action="store_true", help="include full svn diff in status output")
    parser.add_argument("--remote", action="store_true", help="contact the repository and report out-of-date paths")
    parser.add_argument(
        "--merge-local",
        action="store_true",
        help="explicitly allow native SVN update/merge when the selected working copy has local changes",
    )
    parser.add_argument(
        "--working-copy",
        action="append",
        default=[],
        help="limit a manifest operation to exact scope entry ids; repeat to select multiple entries",
    )
    parser.add_argument(
        "--source-type",
        choices=["page", "procedure", "system-script", "table", "view", "skill", "public"],
    )
    parser.add_argument("--source-id")
    parser.add_argument("--fun-id", "--fun", dest="fun_id", default="")
    parser.add_argument("--json-pointer", default="")
    parser.add_argument("--session")
    parser.add_argument("--document")
    parser.add_argument("--path")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--selection-token")
    parser.add_argument("--candidate", action="append", default=[])
    parser.add_argument("--alias")
    parser.add_argument("--keyword", default="")
    parser.add_argument("--table", default="")
    parser.add_argument("--bill-type", default="")
    parser.add_argument("--data-source-id", default="")
    parser.add_argument("--operation", default="WRITE")
    parser.add_argument("--fact-limit", type=int, default=4)
    parser.add_argument("--caller-depth", type=int, default=2)
    parser.add_argument("--continuation", type=int, default=0)
    parser.add_argument("--include-details", action="store_true")
    parser.add_argument("--edit-token", default="")
    parser.add_argument("--before", default="")
    parser.add_argument("--confirmation", default="")
    parser.add_argument("--apply", action="store_true", help="apply the confirmed operation archive plan")
    parser.add_argument("--cursor", default="")
    parser.add_argument("--since-generation", default="")
    parser.add_argument("--column", default="")
    parser.add_argument("--graph", action="store_true")
    parser.add_argument("--start-line", type=int, default=1)
    parser.add_argument("--end-line", type=int, default=100)
    return parser

def _svn_progress(message: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] [SVN] {message}", file=sys.stderr, flush=True)


def _database_progress(message: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] [DATABASE] {message}", file=sys.stderr, flush=True)


def _reindex_database_exports(hub, workspace, *, config=None):
    from common import database_source_exports

    if config is not None:
        scope = hub.resolve_system_scope(None, config, workspace["datasourceName"], workspace, allow_remote=False)
        if not scope:
            raise CommandError("DATABASE_SCOPE_METADATA_REQUIRED", "缺少项目子系统目录，请重新更新源码")
        removed = database_source_exports.prune_outside_scope(workspace, scope)
        _database_progress(f"退出范围的本地导出已清理 · {removed} 项")
    with closing(hub.connect_index_for_workspace(workspace, action="database-export-index")) as conn, conn:
        diagnostics = database_source_exports.rebuild(conn, workspace)
        count = conn.execute("SELECT COUNT(*) FROM database_source_export").fetchone()[0]
    _database_progress(f"本地导出对象索引 · {count} 项 · 解析诊断 {len(diagnostics)} 项")
    for error in diagnostics[:20]:
        _database_progress(f"{error['category']} · {error['path']} · {error['message']}")


def _reindex_svn(gusen_hub, config, workspace, on_progress=None) -> dict:
    if on_progress is not None:
        on_progress(f"{workspace['displayName']}｜重建本地索引")
    conn = gusen_hub.connect_index_for_workspace(
        workspace,
        action="index-init",
        rebuild_incompatible=True,
    )
    try:
        result = gusen_hub.index_svn_workspace(conn, config, workspace, on_progress=on_progress)
    finally:
        conn.close()
    if result.get("failures"):
        if result.get("indexPreserved", True):
            raise SystemExit(f"SVN 索引未更新，已保留旧索引：{result['errors']}")
        blocked = result.get("blocked") or []
        detail = ""
        if blocked:
            paths = [item.get("path") or "" for item in blocked[:5]]
            detail = (
                f"；冲突阻断 {len(blocked)} 个：{'、'.join(paths)}"
                + (" 等" if len(blocked) > 5 else "")
                + "，请合并后标记「SVN 冲突为已解决」再重建索引"
            )
        raise gusen_hub.IndexPartialError(f"SVN 索引已发布（PARTIAL）{detail}：{result['errors']}")
    return result

def _connect_incremental_svn_index(gusen_hub, config, workspace, on_progress=None):
    try:
        return gusen_hub.connect_index_for_workspace(workspace, action="index-init")
    except gusen_hub.IndexRebuildRequired:
        if on_progress is not None:
            on_progress(f"{workspace['displayName']}｜索引｜旧索引无法原地升级，自动完整重建")
        _reindex_svn(gusen_hub, config, workspace, on_progress=on_progress)
        return gusen_hub.connect_index_for_workspace(workspace, action="index-init")

def _reindex_svn_files(
    gusen_hub,
    config,
    workspace,
    source_paths: list[str],
    on_progress=None,
) -> list[dict]:
    paths = list(dict.fromkeys(source_paths))
    if on_progress is not None:
        on_progress(f"{workspace['displayName']}｜索引｜开始更新 {len(paths)} 个源码文件")
    connection = _connect_incremental_svn_index(
        gusen_hub,
        config,
        workspace,
        on_progress=on_progress,
    )
    try:
        results = []
        for source_path in paths:
            results.append(
                gusen_hub.index_svn_workspace_file(connection, config, workspace, source_path)
            )
    finally:
        connection.close()
    if on_progress is not None:
        on_progress(f"{workspace['displayName']}｜索引｜完成 · {len(results)} 个源码文件")
    return results

def _manifest_refresh_paths(workspace: dict, refresh_result: dict) -> list[str]:
    """Return canonical changed paths, including directories and deleted files."""

    from providers.svn.nexus import catalog
    from providers.svn.nexus.manifest import (
        load_authorized_scope, logical_path_for_entry, resolve_authorized_path,
    )

    scope = load_authorized_scope(workspace)
    entries = {entry.id: entry for entry in scope.entries}
    paths = []
    for updated in refresh_result.get("updated") or []:
        entry = entries.get(updated.get("id"))
        if entry is None:
            raise SystemExit("SVN refresh returned an unknown working copy")
        paths.extend(updated.get("paths") or [])
        for raw in updated.get("updatePaths") or []:
            target = Path(raw)
            if not target.is_absolute():
                target = entry.root / target
            relative = target.resolve().relative_to(entry.root.resolve()).as_posix()
            paths.append(logical_path_for_entry(entry, relative) or entry.local_subdir)
        changes = [] if updated.get("paths") else list((updated.get("before") or {}).get("remoteChanges") or [])
        if refresh_result.get("action") == "refreshed-with-local-merge":
            changes.extend((updated.get("before") or {}).get("changes") or [])
            changes.extend((updated.get("after") or {}).get("changes") or [])
        for change in changes:
            if updated.get("paths") and logical_path_for_entry(entry, change["path"]) not in updated["paths"]:
                continue
            # Directory property changes do not change source contents.
            if change.get("item") in {"", "none", "normal"}:
                if (change.get("properties") in {None, "", "none", "normal"}
                        or not (entry.root / change["path"]).is_file()):
                    continue
            # SVN can mark ancestor directories modified when descendants
            # changed. Their own contents are not source files; update
            # notifications and added/deleted subtrees cover the real changes.
            if change.get("item") == "modified" and (entry.root / change["path"]).is_dir():
                continue
            # Conflict artifacts (.mine, .r1234) and other unversioned files are
            # not authorized source and must not become incremental index paths.
            if change.get("item") in {"unversioned", "ignored", "external"}:
                target = entry.root / change["path"]
                if not (target.is_file() and catalog.source_file_supported(entry, target)):
                    continue
            paths.append(logical_path_for_entry(entry, change["path"]) or entry.local_subdir)
    normalized = []
    for path in paths:
        entry, _target, relative = resolve_authorized_path(scope, path)
        normalized.append(logical_path_for_entry(entry, relative) or entry.local_subdir)
    return list(dict.fromkeys(normalized))

def _reindex_svn_refresh(gusen_hub, config, workspace, refresh_result: dict, on_progress=None) -> dict:
    if on_progress is not None:
        on_progress(f"{workspace['displayName']}｜索引｜开始更新后的增量索引")
    paths = _manifest_refresh_paths(workspace, refresh_result)
    connection = _connect_incremental_svn_index(gusen_hub, config, workspace, on_progress=on_progress)
    try:
        result = gusen_hub.index_svn_workspace_changes(
            connection, config, workspace, paths, refresh_result, on_progress=on_progress,
        )
    finally:
        connection.close()
    blocked = result.get("blocked") or []
    if on_progress is not None:
        for item in blocked:
            on_progress(f"{workspace['displayName']}｜索引｜冲突阻断 · {item['path']} · {item['error']}")
    if result.get("failures"):
        raise SystemExit(f"增量索引未发布，已保留旧索引：{result['errors']}")
    if on_progress is not None:
        on_progress(
            f"{workspace['displayName']}｜索引｜更新后的索引完成 · "
            f"对象 {result.get('changed', 0)} · 失败 {result.get('failures', 0)}"
            + (f" · 冲突阻断 {len(blocked)} 个待合并" if blocked else "")
        )
    return result


def _run(command, args, config, workspace):
    from common import legacy_source as hub
    from common.operation_control import OperationCancelled

    mode = workspace["sourceMode"]
    for index, arg in enumerate(args):
        if arg == "--workspace":
            if args[index + 1:index + 2] != [workspace["workspaceKey"]]:
                raise SystemExit("The provider command cannot change the selected workspace")
        elif arg.startswith("--workspace=") and arg.split("=", 1)[1] != workspace["workspaceKey"]:
            raise SystemExit("The provider command cannot change the selected workspace")
    if command == "legacy-source":
        if args == ["sync-node"]:
            from common.database_node_sync import sync
            if mode != "database":
                raise ValueError("节点同步需要 DATABASE 工作区")
            result=sync(workspace,config,json.load(sys.stdin),_database_progress)
            print(json.dumps({"ok":True,"workspaceKey":workspace["workspaceKey"],**result},ensure_ascii=False))
            return 0
        if args and args[0] in {"edit-read", "edit-preview", "edit-save", "edit-comparison",
                                 "publish-preview", "publish-confirm"}:
            from common.database_workcopy_edit import run as workcopy_edit

            if len(args) != 1 or mode != "database" or not workspace["capabilities"].get("workcopy.open"):
                raise ValueError("DATABASE Workcopy source editing is unavailable")
            result = workcopy_edit(workspace, config, args[0], json.load(sys.stdin))
            print(json.dumps({"ok": True, **result}, ensure_ascii=False))
            return 0
        if args == ["publish-refresh"]:
            from common.database_node_sync import sync_verified_procedure

            if mode != "database" or not workspace["capabilities"].get("database.sourceSync"):
                raise ValueError("当前工作区不支持 DATABASE 发布回拉")
            evidence = json.load(sys.stdin)
            if evidence.get("workspaceKey") != workspace["workspaceKey"]:
                raise ValueError("发布回拉工作区不一致")
            result = sync_verified_procedure(workspace, config, evidence["databaseIdentity"],
                                             base_version=evidence["baseVersion"], database_version=evidence["version"],
                                             content=evidence["content"], advance_workcopy=True)
            print(json.dumps({"ok": True, "workspaceKey": workspace["workspaceKey"], **result}, ensure_ascii=False))
            return 0
        if args == ["review-workcopies"]:
            from common.database_source_publish import reviewable_workcopies

            if mode != "database" or not workspace["capabilities"].get("workcopy.open"):
                raise ValueError("当前工作区不支持 DATABASE 副本审阅")
            print(json.dumps({"ok": True, "workspaceKey": workspace["workspaceKey"],
                              "items": reviewable_workcopies(workspace)}, ensure_ascii=False))
            return 0
        from common import legacy_source_read
        parser = argparse.ArgumentParser(prog="guthon_tool.py legacy-source")
        parser.add_argument("action", choices=["catalog", "callers", "read", "locate", "fragments", "search"])
        parser.add_argument("--type", default="")
        parser.add_argument("--after", type=int, default=0)
        parser.add_argument("--limit", type=int, default=100)
        parser.add_argument("--record-id", type=int, default=0)
        parser.add_argument("--source-id", default="")
        parser.add_argument("--alias", default="")
        parser.add_argument("--fun-id", default="")
        parser.add_argument("--pointer", default="")
        parser.add_argument("--export-key", default="")
        parser.add_argument("--keyword", default="")
        parser.add_argument("--locations", action="store_true")
        parsed = parser.parse_args(args)
        if parsed.action == "catalog":
            result = legacy_source_read.catalog(workspace, source_type=parsed.type, after=parsed.after, limit=parsed.limit, config=config)
        elif parsed.action == "locate":
            result = legacy_source_read.locate(workspace, source_type=parsed.type, source_id=parsed.source_id,
                                                alias=parsed.alias, fun_id=parsed.fun_id)
        elif parsed.action in {"read", "fragments"}:
            result = legacy_source_read.read(workspace, parsed.record_id, limit=200000, source_id=parsed.source_id,
                pointer=parsed.pointer, export_key=parsed.export_key, fragments=parsed.action == "fragments")
        elif parsed.action == "search" and mode == "database":
            result = legacy_source_read.search(workspace, parsed.keyword, source_type=parsed.type)
        elif parsed.action == "search":
            raise ValueError("此查询需要 DATABASE 源码工作区")
        else:
            result = legacy_source_read.callers(workspace, parsed.alias, parsed.fun_id, locations=parsed.locations)
        print(json.dumps({"ok": True, "workspaceKey": workspace["workspaceKey"], **result}, ensure_ascii=False))
        return 0
    if command == "svn":
        if mode != "svn":
            raise SystemExit("svn requires an SVN workspace")
        from providers.svn import cli
        parsed = build_svn_parser().parse_args(args)
        if parsed.action == "scope-import" and workspace["configuration"].get("format") == "unified" and not workspace["svn"]["scopeConfigExplicit"]:
            raise SystemExit("Set an explicit SVN scope configuration file before importing scope")
        track = parsed.action in {"init", "refresh", "refresh-node", "sync-from-config", "sync-from-script", "sync-from-bat"}
        try:
            code = cli.run(
                parsed, args, hub, config, workspace, on_progress=_svn_progress,
                reindex=_reindex_svn, reindex_files=_reindex_svn_files,
                reindex_refresh=_reindex_svn_refresh,
            )
        except (Exception, SystemExit) as error:
            if track:
                hub.append_pull_log("source", "svn-" + parsed.action, {"workspaceKey": workspace["workspaceKey"]},
                                    ok=False, message=str(error))
            raise
        if track:
            hub.append_pull_log("source", "svn-" + parsed.action, {"workspaceKey": workspace["workspaceKey"]})
        return code
    if command == "pull":
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict) or payload.get("workspaceKey", workspace["workspaceKey"]) != workspace["workspaceKey"]:
            raise SystemExit("pull requires a JSON object bound to the selected workspace")
        result = hub.pull_source_to_work_copy({**payload, "workspaceKey": workspace["workspaceKey"]})
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("ok") else 1
    if command in {"workcopy", "create-workcopy"}:
        if not workspace["capabilities"].get("workcopy.open" if mode == "database" else "svn.workcopy"):
            raise SystemExit("The selected workspace has no Workcopy capability")
        result = (hub.work_copy_cli if command == "workcopy" else hub.create_work_copy)(args)
        return 1 if isinstance(result, dict) and result.get("ok") is False else 0
    if command == "query":
        from common import legacy_query_hub_context
        return legacy_query_hub_context.main(args) or 0
    if command == "export-markdown":
        from common import legacy_export_hub_markdown
        return legacy_export_hub_markdown.main(args, workspace) or 0
    if command in {"search", "context-pack", "source-map"}:
        from common import legacy_workspace_assistant as assistant
        from guthon_tool import build_search_parser, build_source_map_parser
        from common.persistence import atomic_text
        if command == "source-map":
            parsed = build_source_map_parser().parse_args(args)
            result = assistant.source_map(workspace, limit=parsed.limit, cursor=parsed.cursor)
            if parsed.write:
                target = workspace["contextDir"] / "ai/SOURCE_MAP.md"
                atomic_text(target, result["markdown"])
                result["artifactPath"] = str(target)
        else:
            parsed = build_search_parser(command).parse_args(args)
            if command == "search":
                result = assistant.unified_search(workspace, parsed.query, parsed.limit)
            else:
                result = assistant.context_pack(workspace, parsed.source_id, parsed.fun_id, parsed.limit, parsed.detailed,
                                                include_source=parsed.include_source, max_chars=parsed.max_chars,
                                                source_namespace=parsed.source_namespace)
                if parsed.write_context:
                    target = workspace["contextDir"] / "ai" / (hub.path_part(parsed.source_id + "." + parsed.fun_id) + ".md")
                    atomic_text(target, result["markdown"])
                    result["artifactPath"] = str(target)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    if command in {"export-schema", "export-view", "export-system-script", "export-bill-type", "sync-all"} and mode == "database":
        from providers.database import export_table_schema_sql, export_view_sql, export_system_script_sql
        from common.database_exports import export_bill_type_sql
        exporters = {
            "export-schema": ("schema", export_table_schema_sql.main),
            "export-view": ("views", export_view_sql.main),
            "export-system-script": ("systemScripts", export_system_script_sql.main),
            "export-bill-type": ("billType", export_bill_type_sql.main),
        }
        if command != "sync-all":
            return exporters[command][1](args) or 0
        if args:
            raise SystemExit("sync-all does not accept provider options")
        from common.workspace_registry import require_workspace_binding
        steps = [
            ("source", "拉取 PAGE 与过程函数", lambda _: hub.run_sync_once([], on_progress=_database_progress, include_system_scripts=True)),
            ("schema", "导出表结构", export_table_schema_sql.main),
            ("views", "导出视图", export_view_sql.main),
            ("systemScripts", "导出系统脚本", export_system_script_sql.main),
            ("billType", "导出单据类型", export_bill_type_sql.main),
            ("sourceCatalog", "清理退出范围的导出并建立索引", lambda _: _reindex_database_exports(hub, workspace, config=config)),
        ]
        for index, (step, label, action) in enumerate(steps, 1):
            require_workspace_binding(workspace, workspace["workspaceBinding"])
            progress = f"[{index}/{len(steps)}] {label}"
            started = time.monotonic()
            _database_progress(f"{workspace['displayName']} · {progress} · 开始")
            try:
                code = action([])
                if code not in (None, 0):
                    raise CommandError("DATABASE_SYNC_STEP_FAILED", f"{label}失败，退出码 {code}")
            except (Exception, SystemExit) as error:
                hub.update_workspace_state(config, workspace, step, "FAILED", error)
                _database_progress(f"{progress} · 失败 · 耗时 {time.monotonic()-started:.1f} 秒")
                raise
            hub.update_workspace_state(config, workspace, step, "SUCCESS")
            _database_progress(f"{progress} · 完成 · 耗时 {time.monotonic()-started:.1f} 秒")
        hub.update_workspace_state(config, workspace, full_sync=True)
        _database_progress(f"{workspace['displayName']} · 全部同步阶段完成")
        return 0
    if command in {"init", "reindex", "sync-source", "sync-source-all", "sync-all"}:
        if args:
            raise SystemExit(f"{command} does not accept provider options")
        if mode == "svn" and command == "init":
            raise SystemExit("Use svn init to initialize an SVN source workspace")
        opts = {"init": ["--init-only"], "reindex": ["--reindex-calls"], "sync-source-all": ["--full-rebuild"]}.get(command, [])
        try:
            hub.run_sync_once(opts, on_progress=_svn_progress if mode == "svn" else _database_progress)
            if mode == "database" and command == "reindex":
                _reindex_database_exports(hub, workspace)
        except (Exception, SystemExit, OperationCancelled) as error:
            status = "PARTIAL" if isinstance(error, hub.IndexPartialError) else "CANCELLED" if isinstance(error, OperationCancelled) else "FAILED"
            hub.update_workspace_state(config, workspace, "source", status, error)
            raise
        hub.update_workspace_state(config, workspace, "source", "INITIALIZED" if command == "init" else "SUCCESS")
        print(f"源码或索引操作完成：{workspace['workspaceKey']}")
        return 0
    if command == "api":
        raise SystemExit("API_SOURCE_MODE_REQUIRED: 当前项目不是 API 源码模式")
    raise SystemExit(f"{command} is unavailable in {mode} source mode")



def run(command, args, config, workspace):
    """Preserve opt-in Git staging for newly generated DATABASE artifacts."""
    import os
    from common import legacy_source as hub

    stage = (
        workspace["sourceMode"] == "database"
        and (config.get("sync", {}).get("rules") or {}).get("pull_auto_add_git")
        and command in {"pull", "sync-source", "sync-source-all", "sync-all", "export-schema",
                        "export-view", "export-system-script", "export-bill-type"}
    )
    prefix = hub.workspace_var_prefix(workspace) if stage else ""
    if not prefix:
        return _run(command, args, config, workspace)
    before = hub.untracked_files(pathspec=[prefix])
    previous = os.environ.get("GUTHON_DEFER_GIT_ADD")
    os.environ["GUTHON_DEFER_GIT_ADD"] = "1"
    try:
        with hub.operation_generated_files() as generated:
            result = _run(command, args, config, workspace)
    finally:
        if previous is None:
            os.environ.pop("GUTHON_DEFER_GIT_ADD", None)
        else:
            os.environ["GUTHON_DEFER_GIT_ADD"] = previous
    if result == 0:
        hub.auto_add_operation_files(config, before, workspace, generated)
    return result

#!/usr/bin/env python3
"""Portable command entry point for GuthonCodeTool."""

from __future__ import annotations

import argparse
import importlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path


SOURCE_ROOT = Path(__file__).resolve().parents[1]
CONFIG_FILES = (
    "datasource.yaml",
    "products.yaml",
    "projects.yaml",
    "source-tables.yaml",
    "sync.yaml",
)
SCRIPT_COMMANDS = {
    "doctor": ("common.doctor", "main"),
    "export-schema": ("providers.database.export_table_schema_sql", "main"),
    "export-bill-type": ("providers.database.export_bill_type_sql", "main"),
    "export-view": ("providers.database.export_view_sql", "main"),
    "export-system-script": ("providers.database.export_system_script_sql", "main"),
    "query": ("common.query_hub_context", "main"),
    "diagnose": ("providers.database.run_source_diagnosis", "main"),
    "create-workcopy": ("common.gusen_hub", "create_work_copy"),
    "workcopy": ("common.gusen_hub", "work_copy_cli"),
}
COMMAND_STEPS = {
    "sync-source-all": "source",
    "sync-source": "source",
    "export-schema": "schema",
    "export-bill-type": "billType",
    "export-system-script": "systemScripts",
    "export-view": "views",
}
SVN_BROWSE_ACTIONS = {
    "catalog",
    "fragments",
    "read",
    "status",
    "scm-status",
    "diff",
    "history",
    "definition",
    "callers",
    "facts",
    "explain",
    "scope-preview",
    "auth-cache",
}
GLOBAL_COMMANDS = {"setup", "doctor", "route", "workspaces", "self-test"}
DATABASE_ONLY_COMMANDS = {
    "export-schema": "database.schemaExport",
    "export-bill-type": "database.billTypeExport",
    "export-system-script": "database.systemScriptExport",
    "export-view": "database.viewExport",
    "diagnose": "database.diagnose",
}


def resource_root() -> Path:
    return Path(getattr(sys, "_MEIPASS", SOURCE_ROOT))


def setup_config(home: Path) -> list[Path]:
    template_dir = resource_root() / "config" / "example"
    config_dir = home / "config"
    config_dir.mkdir(parents=True, exist_ok=True)
    created = []
    for filename in CONFIG_FILES:
        target = config_dir / filename
        template = template_dir / filename.replace(".yaml", ".example.yaml")
        if not target.exists():
            if not template.exists():
                raise SystemExit(f"Missing bundled config template: {template}")
            shutil.copyfile(template, target)
            created.append(target)
    return created


def _auto_add_operation_enabled(command: str, extra_args: list[str]) -> bool:
    if command == "source-mode":
        return False
    return not (command == "svn" and extra_args and extra_args[0] in SVN_BROWSE_ACTIONS)


def run(command: str, home: Path, extra_args: list[str], selected_workspace=None) -> int:
    os.environ["GUTHON_HOME"] = str(home)
    if command == "self-test":
        with tempfile.TemporaryDirectory() as temp:
            created = setup_config(Path(temp) / "home")
        assert len(created) == len(CONFIG_FILES)
        print("guthon_tool self-test: ok")
        return 0
    if command == "setup":
        created = setup_config(home)
        print(f"配置目录已准备：{home / 'config'}")
        print("已创建：" + ("、".join(path.name for path in created) or "无（保留现有配置）"))
        return 0
    if command == "import-svn-scope":
        if not selected_workspace:
            raise SystemExit("Missing --workspace. Use products.<product_id> or projects.<project_id>.")
        import_parser = argparse.ArgumentParser(prog="guthon_tool.py import-svn-scope")
        source = import_parser.add_mutually_exclusive_group(required=True)
        source.add_argument("--script", help="path to svnCheckoutHere.sh or svnCheckoutHere.bat")
        source.add_argument("--bat", help="legacy alias for a checkout BAT path")
        source.add_argument("--config", help="path to an editable svn-scope.yaml/json configuration")
        import_parser.add_argument("--output", required=True, help="target authorized-scope.json path")
        import_parser.add_argument("--replace", action="store_true", help="replace an existing changed manifest")
        parsed = import_parser.parse_args(extra_args)
        from providers.svn.scope_import import (
            build_manifest,
            build_manifest_from_config,
            read_checkout_script,
            write_manifest,
        )

        source_path = Path(parsed.config or parsed.script or parsed.bat).expanduser().resolve()
        if parsed.config:
            try:
                result = build_manifest_from_config(source_path.read_text(encoding="utf-8"), selected_workspace)
            except (OSError, UnicodeDecodeError) as error:
                raise SystemExit(f"Cannot read SVN scope configuration: {source_path}") from error
        else:
            result = build_manifest(read_checkout_script(source_path), selected_workspace)
        output_path = Path(parsed.output).expanduser()
        if not output_path.is_absolute():
            output_path = home / output_path
        summary = write_manifest(output_path.resolve(), result, replace=parsed.replace)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    from common import gusen_hub

    if command == "workspaces":
        config = gusen_hub.load_config()
        print(json.dumps(
            {"ok": True, "workspaces": [gusen_hub.workspace_summary(config, item) for item in gusen_hub.list_workspaces(config)]},
            ensure_ascii=False,
        ))
        return 0
    if command == "route":
        payload = json.load(sys.stdin)
        print(json.dumps(gusen_hub.route_workspace_request(gusen_hub.load_config(), payload), ensure_ascii=False))
        return 0
    if selected_workspace:
        gusen_hub.set_workspace(selected_workspace)
    if command not in GLOBAL_COMMANDS and command != "pull" and not selected_workspace:
        raise SystemExit("Missing --workspace. Use products.<product_id> or projects.<project_id>.")

    config = gusen_hub.load_config()
    workspace = None if command in GLOBAL_COMMANDS or command == "pull" and not selected_workspace else gusen_hub.resolve_workspace(config)
    if workspace and command in DATABASE_ONLY_COMMANDS and workspace["sourceMode"] != "database":
        raise SystemExit(
            f"{command} is unavailable in SVN source mode for {workspace['workspaceKey']}; "
            "use the local SVN index or an explicit database workspace"
        )
    auto_add_git = bool((config.get("sync", {}).get("rules") or {}).get("pull_auto_add_git"))
    auto_add_operation = auto_add_git and _auto_add_operation_enabled(command, extra_args)
    before = set()
    if workspace and auto_add_operation:
        workspace_prefix = gusen_hub.workspace_var_prefix(workspace)
        if workspace_prefix:
            before = gusen_hub.untracked_files(pathspec=[workspace_prefix])
    os.environ["GUTHON_DEFER_GIT_ADD"] = "1"
    step = COMMAND_STEPS.get(command)
    if workspace and workspace.get("sourceMode") == "svn":
        if command in {"reindex", "sync-all"}:
            step = "source"
        elif command == "svn" and extra_args and extra_args[0] in {"init", "refresh"}:
            step = "source"
    result_code = 0
    try:
        result_code = _run_workspace_command(command, extra_args, gusen_hub, config, workspace)
        if result_code:
            raise RuntimeError(f"{command} failed with exit code {result_code}")
        if step:
            gusen_hub.update_workspace_state(config, workspace, step, "SUCCESS")
    except (Exception, SystemExit) as error:
        if workspace and step:
            gusen_hub.update_workspace_state(config, workspace, step, "FAILED", error)
        raise
    finally:
        os.environ.pop("GUTHON_DEFER_GIT_ADD", None)
    if (
        workspace
        and auto_add_operation
        and command not in {"init", "reindex", "export-markdown", "workcopy", "create-workcopy", "source-mode"}
    ):
        gusen_hub.auto_add_operation_files(config, before, workspace)
    return result_code


def _svn_progress(message: str) -> None:
    print(f"[SVN] {message}", file=sys.stderr, flush=True)


def _reindex_svn(gusen_hub, config, workspace, on_progress=None) -> dict:
    conn = gusen_hub.connect_index(workspace["indexPath"])
    try:
        result = gusen_hub.index_svn_workspace(conn, config, workspace, on_progress=on_progress)
    finally:
        conn.close()
    if result.get("failures"):
        raise SystemExit(f"SVN scan failed; existing index preserved: {result['errors']}")
    return result


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
    connection = gusen_hub.connect_index(workspace["indexPath"])
    try:
        results = []
        for index, source_path in enumerate(paths, 1):
            if on_progress is not None:
                on_progress(f"[{index}/{len(paths)}] {workspace['displayName']}｜索引｜更新文件 · {source_path}")
            results.append(
                gusen_hub.index_svn_workspace_file(connection, config, workspace, source_path)
            )
    finally:
        connection.close()
    if on_progress is not None:
        on_progress(f"{workspace['displayName']}｜索引｜完成 · {len(results)} 个源码文件")
    return results


def _reindex_svn_working_copies(
    gusen_hub,
    config,
    workspace,
    working_copy_ids: list[str],
    on_progress=None,
) -> dict:
    connection = gusen_hub.connect_index(workspace["indexPath"])
    try:
        result = gusen_hub.index_svn_workspace_working_copies(
            connection,
            config,
            workspace,
            working_copy_ids,
            on_progress=on_progress,
        )
    finally:
        connection.close()
    if result.get("failures"):
        raise SystemExit(f"Scoped SVN scan failed; existing index preserved: {result['errors']}")
    return result


def _manifest_refresh_paths(workspace: dict, refresh_result: dict) -> list[str] | None:
    """Return exact changed source paths, or None when the selected copies need a scoped scan."""

    from providers.svn.nexus.manifest import load_authorized_scope, source_category

    entries = {entry.id: entry for entry in load_authorized_scope(workspace).entries}
    allowed_suffixes = {
        "pages": {".json", ".gss"},
        "procedures": {".gss"},
        "system-script": {".gss", ".js", ".vm", ".sql"},
        "tables": {".json"},
        "views": {".json"},
    }
    logical_paths = []
    merge_local = refresh_result.get("action") == "refreshed-with-local-merge"
    for updated in refresh_result.get("updated") or []:
        entry = entries.get(updated.get("id"))
        if entry is None:
            return None
        explicit_paths = list(updated.get("paths") or [])
        if explicit_paths:
            for logical_path in explicit_paths:
                prefix = entry.local_subdir + "/"
                if not str(logical_path).startswith(prefix):
                    return None
                relative = str(logical_path)[len(prefix):]
                target = (entry.root / relative).resolve()
                category = source_category(entry, relative)
                if (
                    not relative
                    or relative == "."
                    or entry.root.resolve() not in target.parents
                    or target.suffix.lower() not in allowed_suffixes.get(category, set())
                ):
                    return None
                logical_paths.append(str(logical_path))
            continue
        changes = list((updated.get("before") or {}).get("remoteChanges") or [])
        if merge_local:
            changes.extend((updated.get("before") or {}).get("changes") or [])
            changes.extend((updated.get("after") or {}).get("changes") or [])
        for change in changes:
            relative = Path(str(change.get("path") or "").replace("\\", "/")).as_posix().lstrip("/")
            target = (entry.root / relative).resolve()
            if (
                not relative
                or relative == "."
                or entry.root.resolve() not in target.parents
                or not target.is_file()
                or target.suffix.lower() not in allowed_suffixes.get(source_category(entry, relative), set())
            ):
                return None
            logical_paths.append(f"{entry.local_subdir}/{relative}")
    return list(dict.fromkeys(logical_paths))


def _reindex_svn_refresh(gusen_hub, config, workspace, refresh_result: dict, on_progress=None) -> dict:
    if on_progress is not None:
        on_progress(f"{workspace['displayName']}｜索引｜开始更新后的增量索引")
    paths = _manifest_refresh_paths(workspace, refresh_result)
    if paths is None:
        result = _reindex_svn_working_copies(
            gusen_hub,
            config,
            workspace,
            [item.get("id") for item in refresh_result.get("updated") or [] if item.get("id")],
            on_progress=on_progress,
        )
    else:
        files = _reindex_svn_files(
            gusen_hub,
            config,
            workspace,
            paths,
            on_progress=on_progress,
        )
        result = {
            "mode": "svn-incremental-refresh",
            "workspaceKey": workspace["workspaceKey"],
            "changed": sum(item.get("changed", 0) for item in files),
            "failures": sum(item.get("failures", 0) for item in files),
            "files": files,
        }
    if on_progress is not None:
        on_progress(
            f"{workspace['displayName']}｜索引｜更新后的索引完成 · "
            f"对象 {result.get('changed', 0)} · 失败 {result.get('failures', 0)}"
        )
    return result


def _run_workspace_command(command, extra_args, gusen_hub, config, workspace):
    if command == "source-mode":
        parser = argparse.ArgumentParser(prog="guthon_tool.py source-mode")
        parser.add_argument("action", choices=["get", "set"])
        parser.add_argument("--mode", choices=["database", "svn"])
        parsed = parser.parse_args(extra_args)
        if parsed.action == "get":
            if parsed.mode:
                raise SystemExit("source-mode get does not accept --mode")
            result = gusen_hub.workspace_summary(config, workspace)
        else:
            if not parsed.mode:
                raise SystemExit("source-mode set requires --mode database|svn")
            result, updated = gusen_hub.change_workspace_source_mode(config, workspace, parsed.mode)
            result["workspace"] = gusen_hub.workspace_summary(config, updated)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    if command == "workspace-summary":
        if extra_args:
            raise SystemExit("workspace-summary does not accept extra arguments")
        print(json.dumps({"ok": True, "workspace": gusen_hub.workspace_summary(config, workspace)}, ensure_ascii=False))
        return 0
    if command == "svn":
        from providers.svn import checkout

        svn_parser = argparse.ArgumentParser(prog="guthon_tool.py svn")
        svn_parser.add_argument(
            "action",
            choices=[
                "init",
                "auth-cache",
                "scope-preview",
                "scope-import",
                "sync-from-script",
                "sync-from-bat",
                "sync-from-config",
                "refresh",
                "status",
                "catalog",
                "fragments",
                "read",
                "write",
                "scm-status",
                "diff",
                "history",
                "revert-preview",
                "revert",
                "platform-save-preview",
                "platform-save",
                "definition",
                "callers",
                "facts",
                "explain",
                "reindex-file",
            ],
        )
        svn_parser.add_argument("--prune", action="store_true", help="exclude paths removed from the configured sparse scope")
        svn_parser.add_argument(
            "--accept-scope-change",
            action="store_true",
            help="accept the reviewed workspace checkout script as the new exact authorization manifest",
        )
        svn_parser.add_argument("--diff", action="store_true", help="include full svn diff in status output")
        svn_parser.add_argument("--remote", action="store_true", help="contact the repository and report out-of-date paths")
        svn_parser.add_argument(
            "--merge-local",
            action="store_true",
            help="explicitly allow native SVN update/merge when the selected working copy has local changes",
        )
        svn_parser.add_argument(
            "--working-copy",
            action="append",
            default=[],
            help="limit a manifest refresh to an exact scope entry id; repeat to select multiple entries",
        )
        svn_parser.add_argument(
            "--source-type",
            choices=["page", "procedure", "system-script", "table", "view", "skill", "public"],
        )
        svn_parser.add_argument("--source-id")
        svn_parser.add_argument("--fun-id", default="")
        svn_parser.add_argument("--json-pointer", default="")
        svn_parser.add_argument("--session")
        svn_parser.add_argument("--document")
        svn_parser.add_argument("--path")
        svn_parser.add_argument("--limit", type=int, default=20)
        svn_parser.add_argument("--selection-token")
        svn_parser.add_argument("--candidate", action="append", default=[])
        svn_parser.add_argument("--alias")
        svn_parser.add_argument("--keyword", default="")
        svn_parser.add_argument("--table", default="")
        svn_parser.add_argument("--bill-type", default="")
        svn_parser.add_argument("--data-source-id", default="")
        svn_parser.add_argument("--operation", default="WRITE")
        svn_parser.add_argument("--fact-limit", type=int, default=4)
        svn_parser.add_argument("--caller-depth", type=int, default=2)
        svn_parser.add_argument("--continuation", type=int, default=0)
        svn_parser.add_argument("--include-details", action="store_true")
        parsed = svn_parser.parse_args(extra_args)
        manifest_layout = workspace["svn"].get("checkoutLayout") == "manifest-working-copies"
        if manifest_layout and parsed.prune:
            raise SystemExit("--prune is only available for the legacy sparse SVN layout")
        if not manifest_layout and (parsed.merge_local or parsed.working_copy):
            raise SystemExit("--merge-local and --working-copy require manifest-working-copies")
        bootstrap = None
        if parsed.action == "auth-cache":
            if not manifest_layout:
                raise SystemExit("svn auth-cache requires manifest-working-copies")
            try:
                payload = json.load(sys.stdin)
            except json.JSONDecodeError as error:
                raise SystemExit("svn auth-cache requires a JSON stdin payload") from error
            if not isinstance(payload, dict) or not isinstance(payload.get("password"), str):
                raise SystemExit("svn auth-cache stdin must contain a password field")
            from providers.svn.nexus import bootstrap as nexus_bootstrap

            result = nexus_bootstrap.cache_authentication(workspace, payload["password"])
        elif parsed.action == "scope-preview":
            if not manifest_layout:
                raise SystemExit("svn scope-preview requires manifest-working-copies")
            from providers.svn.nexus import bootstrap as nexus_bootstrap

            result = nexus_bootstrap.preview(workspace)
        elif parsed.action == "scope-import":
            if not manifest_layout:
                raise SystemExit("svn scope-import requires manifest-working-copies")
            try:
                payload = json.load(sys.stdin)
            except json.JSONDecodeError as error:
                raise SystemExit("svn scope-import requires a JSON stdin payload") from error
            if not isinstance(payload, dict):
                raise SystemExit("svn scope-import stdin must contain text or file")
            from providers.svn.scope_import import (
                build_manifest_from_workspace_input,
                merge_scope_config,
                parse_scope_input,
                read_checkout_script,
            )

            source_kind = str(payload.get("source") or "script")
            if isinstance(payload.get("file"), str) and payload["file"].strip():
                source_path = Path(payload["file"]).expanduser().resolve()
                parsed_scope = build_manifest_from_workspace_input(
                    read_checkout_script(source_path), workspace
                )
            elif isinstance(payload.get("text"), str):
                parsed_scope = (
                    parse_scope_input(payload["text"], workspace["workspaceKey"], source_kind)
                    if source_kind.casefold() in {"config", "yaml", "json"}
                    else build_manifest_from_workspace_input(payload["text"], workspace)
                )
            else:
                raise SystemExit("svn scope-import stdin must contain text or file")
            config_path = workspace.get("svn", {}).get("scopeConfigPath")
            if not config_path:
                raise SystemExit(
                    "SVN workspace configuration path is unavailable; use products.yaml/projects.yaml"
                )
            result = merge_scope_config(
                config_path,
                workspace["workspaceKey"],
                parsed_scope,
                workspace,
            )
            result["source"] = source_kind
        elif parsed.action in {"sync-from-script", "sync-from-bat", "sync-from-config"}:
            if not manifest_layout:
                raise SystemExit("svn scope sync requires manifest-working-copies")
            from providers.svn.nexus import bootstrap as nexus_bootstrap
            from providers.svn.nexus import workspace as nexus_workspace
            from providers.svn.nexus.manifest import load_authorized_scope

            manifest_path = workspace["svn"].get("scopeManifestPath")
            had_working_copies = False
            _svn_progress(f"{workspace['displayName']}｜授权范围｜检查现有 working copy")
            if manifest_path and manifest_path.is_file():
                old_scope = load_authorized_scope(workspace)
                had_working_copies = any((entry.root / ".svn").is_dir() for entry in old_scope.entries)
                if had_working_copies:
                    current = nexus_workspace.status(workspace, on_progress=_svn_progress)
                    if not current["status"]["clean"] and not parsed.merge_local:
                        raise SystemExit(
                            "SVN scope sync is blocked by local changes; review them first or explicitly allow merge-local"
                        )
            _svn_progress(f"{workspace['displayName']}｜授权范围｜读取可编辑范围配置（无配置时导入签出脚本）")
            scope_import = nexus_bootstrap.import_scope(
                workspace,
                accept_scope_change=parsed.accept_scope_change,
            )
            _svn_progress(
                f"{workspace['displayName']}｜授权范围｜完成 · working copy {scope_import.get('entries', 0)}"
            )
            initialized = nexus_workspace.initialize(workspace, on_progress=_svn_progress)
            refreshed = (
                nexus_workspace.refresh(
                    workspace,
                    merge_local=parsed.merge_local,
                    on_progress=_svn_progress,
                )
                if had_working_copies
                else None
            )
            initialized_scope = initialized.get("scope") or {}
            refreshed_status = (refreshed or {}).get("status") or {}
            source_label = "script" if scope_import.get("source") == "script" else "config"
            result = {
                "ok": True,
                "action": (
                    f"updated-from-{source_label}" if had_working_copies
                    else f"checked-out-from-{source_label}"
                ),
                "scopeImport": scope_import,
                "workingCopies": len(initialized_scope.get("workingCopies") or []),
                "clean": bool((refreshed_status or initialized_scope).get("clean")),
                "updated": len((refreshed or {}).get("updated") or []),
                "reindex": _reindex_svn(
                    gusen_hub,
                    config,
                    workspace,
                    on_progress=_svn_progress,
                ),
            }
            _svn_progress(
                f"{workspace['displayName']}｜完成｜"
                f"{'更新' if had_working_copies else '检出'} {result['workingCopies']} 个 working copy · "
                f"索引对象 {result['reindex'].get('changed', 0)}"
            )
            gusen_hub.update_workspace_state(config, workspace, "source", "SUCCESS")
        elif parsed.action == "init":
            if manifest_layout:
                from providers.svn.nexus import workspace as nexus_workspace

                result = nexus_workspace.initialize(workspace)
            else:
                result = checkout.initialize(workspace, gusen_hub.CONFIG_DIR, bootstrap)
            result["reindex"] = _reindex_svn(gusen_hub, config, workspace)
            gusen_hub.update_workspace_state(config, workspace, "source", "SUCCESS")
        elif parsed.action == "refresh":
            if manifest_layout:
                if parsed.path and parsed.working_copy:
                    raise SystemExit("svn refresh accepts --path or --working-copy, not both")
                from providers.svn.nexus import workspace as nexus_workspace

                result = nexus_workspace.refresh(
                    workspace,
                    merge_local=parsed.merge_local,
                    working_copy_ids=parsed.working_copy,
                    logical_paths=[parsed.path] if parsed.path else None,
                    on_progress=_svn_progress,
                )
            else:
                if parsed.path:
                    raise SystemExit("svn refresh --path requires manifest-working-copies")
                result = checkout.refresh(
                    workspace,
                    gusen_hub.CONFIG_DIR,
                    bootstrap,
                    prune=parsed.prune,
                    on_progress=_svn_progress,
                )
            result["reindex"] = (
                _reindex_svn_refresh(
                    gusen_hub,
                    config,
                    workspace,
                    result,
                    on_progress=_svn_progress,
                )
                if manifest_layout
                else _reindex_svn(gusen_hub, config, workspace, on_progress=_svn_progress)
            )
            gusen_hub.update_workspace_state(config, workspace, "source", "SUCCESS")
        elif parsed.action == "status":
            checkout.require_capability(workspace, "status")
            if manifest_layout:
                from providers.svn.nexus import workspace as nexus_workspace

                result = nexus_workspace.status(workspace, include_diff=parsed.diff, remote=parsed.remote)
            else:
                with checkout.operation_lock(workspace, "status", shared=True):
                    result = {
                        "ok": True,
                        "status": checkout.svn_status(
                            workspace["checkoutPath"],
                            include_diff=parsed.diff,
                            remote=parsed.remote,
                            settings=workspace["svn"],
                        ),
                    }
        elif parsed.action == "catalog":
            checkout.require_capability(workspace, "browse")
            if not manifest_layout:
                raise SystemExit("svn catalog requires manifest-working-copies")
            from providers.svn.nexus import index_queries

            result = index_queries.catalog(workspace)
        elif parsed.action == "fragments":
            if not manifest_layout:
                raise SystemExit("svn fragments requires manifest-working-copies")
            if not parsed.source_type or not parsed.source_id:
                raise SystemExit("svn fragments requires --source-type and --source-id")
            from providers.svn.nexus import documents

            result = documents.fragments(
                workspace,
                source_type=parsed.source_type,
                source_id=parsed.source_id,
                fun_id=parsed.fun_id,
            )
        elif parsed.action == "read":
            if not manifest_layout:
                raise SystemExit("svn read requires manifest-working-copies")
            if not parsed.source_type or not parsed.source_id:
                raise SystemExit("svn read requires --source-type and --source-id")
            from providers.svn.nexus import documents

            result = documents.read(
                workspace,
                source_type=parsed.source_type,
                source_id=parsed.source_id,
                fun_id=parsed.fun_id,
                json_pointer=parsed.json_pointer,
            )
        elif parsed.action == "write":
            if not manifest_layout:
                raise SystemExit("svn write requires manifest-working-copies")
            if not parsed.session or not parsed.document:
                raise SystemExit("svn write requires --session and --document")
            try:
                payload = json.load(sys.stdin)
            except json.JSONDecodeError as error:
                raise SystemExit("svn write requires a JSON stdin payload") from error
            if not isinstance(payload, dict) or not isinstance(payload.get("content"), str):
                raise SystemExit("svn write stdin must contain a text content field")
            from providers.svn.nexus import documents

            result = documents.write(
                workspace,
                session_id=parsed.session,
                document_id=parsed.document,
                content=payload["content"],
            )
            _svn_progress(f"{workspace['displayName']}｜源码写入｜已写回本地 SVN working copy")
            if result.get("changed"):
                result["reindex"] = _reindex_svn_files(
                    gusen_hub,
                    config,
                    workspace,
                    [result["sourcePath"]],
                    on_progress=_svn_progress,
                )
            _svn_progress(f"{workspace['displayName']}｜源码写入｜完成")
        elif parsed.action in {"definition", "callers"}:
            if not manifest_layout:
                raise SystemExit(f"svn {parsed.action} requires manifest-working-copies")
            if not parsed.alias or not parsed.fun_id:
                raise SystemExit(f"svn {parsed.action} requires --alias and --fun-id")
            from providers.svn.nexus import index_queries

            result = (
                index_queries.definition(workspace, alias=parsed.alias, fun_id=parsed.fun_id)
                if parsed.action == "definition"
                else index_queries.callers(workspace, alias=parsed.alias, fun_id=parsed.fun_id, limit=parsed.limit)
            )
        elif parsed.action in {"facts", "explain"}:
            if not manifest_layout:
                raise SystemExit(f"svn {parsed.action} requires manifest-working-copies")
            from providers.svn.nexus import index_queries

            if parsed.action == "facts":
                if not (parsed.keyword or parsed.table or parsed.source_id):
                    raise SystemExit("svn facts requires --keyword, --table, or --source-id")
                result = index_queries.facts(
                    workspace,
                    keyword=parsed.keyword,
                    table_name=parsed.table,
                    source_id=parsed.source_id or "",
                    limit=parsed.limit if "--limit" in extra_args else 3,
                    continuation=parsed.continuation,
                )
            else:
                if not (parsed.table or parsed.bill_type):
                    raise SystemExit("svn explain requires --table or --bill-type")
                result = index_queries.explain(
                    workspace,
                    table_name=parsed.table,
                    bill_type_code=parsed.bill_type,
                    data_source_id=parsed.data_source_id,
                    operation=parsed.operation,
                    limit=parsed.limit if "--limit" in extra_args else 1,
                    fact_limit=parsed.fact_limit,
                    caller_depth=parsed.caller_depth,
                    continuation=parsed.continuation,
                    include_details=parsed.include_details,
                )
        elif parsed.action == "reindex-file":
            if not manifest_layout or not parsed.path:
                raise SystemExit("svn reindex-file requires manifest-working-copies and --path")
            indexed = _reindex_svn_files(
                gusen_hub,
                config,
                workspace,
                [parsed.path],
                on_progress=_svn_progress,
            )
            result = {
                "ok": True,
                "workspaceKey": workspace["workspaceKey"],
                "sourcePath": parsed.path,
                "reindex": indexed,
                "stale": bool(indexed and indexed[0].get("failures")),
            }
        else:
            if not manifest_layout:
                raise SystemExit(f"svn {parsed.action} requires manifest-working-copies")
            from providers.svn.nexus import scm

            if parsed.action == "scm-status":
                result = scm.status(workspace, remote=parsed.remote, on_progress=_svn_progress)
            elif parsed.action == "diff":
                if not parsed.path:
                    raise SystemExit("svn diff requires --path")
                result = scm.diff(workspace, logical_path=parsed.path, remote=parsed.remote)
            elif parsed.action == "history":
                if not parsed.path:
                    raise SystemExit("svn history requires --path")
                result = scm.history(workspace, logical_path=parsed.path, limit=parsed.limit)
            elif parsed.action in {"revert-preview", "platform-save-preview"}:
                if not parsed.session:
                    raise SystemExit(f"svn {parsed.action} requires --session")
                action = "revert" if parsed.action == "revert-preview" else "platform-save"
                result = scm.preview(
                    workspace,
                    action=action,
                    session_id=parsed.session,
                    on_progress=_svn_progress,
                )
            elif parsed.action == "revert":
                if not parsed.session or not parsed.selection_token:
                    raise SystemExit("svn revert requires --session and --selection-token")
                result = scm.revert(
                    workspace,
                    session_id=parsed.session,
                    selection_token=parsed.selection_token,
                    candidate_ids=parsed.candidate,
                    on_progress=_svn_progress,
                )
                result["reindex"] = _reindex_svn_files(
                    gusen_hub,
                    config,
                    workspace,
                    result["files"],
                    on_progress=_svn_progress,
                )
            else:
                if not parsed.session or not parsed.selection_token:
                    raise SystemExit("svn platform-save requires --session and --selection-token")
                try:
                    payload = json.load(sys.stdin)
                except json.JSONDecodeError as error:
                    raise SystemExit("svn platform-save requires a JSON stdin payload") from error
                result = scm.platform_save(
                    workspace,
                    session_id=parsed.session,
                    selection_token=parsed.selection_token,
                    candidate_ids=parsed.candidate,
                    message=(payload or {}).get("message") if isinstance(payload, dict) else "",
                    on_progress=_svn_progress,
                )
                result["reindex"] = _reindex_svn_files(
                    gusen_hub,
                    config,
                    workspace,
                    result["files"],
                    on_progress=_svn_progress,
                )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if command == "init":
        if workspace["sourceMode"] == "svn":
            raise SystemExit("Use 'svn init' to initialize an SVN source workspace")
        gusen_hub.ensure_workspace_structure(workspace)
        gusen_hub.run_sync_once(["--init-only"])
        gusen_hub.update_workspace_state(config, workspace, "source", "INITIALIZED")
        print("本地源码索引初始化完成")
        return 0
    if command == "sync-source-all":
        gusen_hub.run_sync_once(["--full-rebuild"])
        verb = "本地 SVN 扫描并索引重建" if workspace["sourceMode"] == "svn" else "全部源码拉取并索引重建"
        print(f"工作区{verb}完成：{workspace['workspaceKey']}")
        return 0
    if command == "sync-source":
        gusen_hub.run_sync_once([])
        verb = "本地 SVN 扫描" if workspace["sourceMode"] == "svn" else "源码拉取"
        print(f"工作区{verb}完成：{workspace['workspaceKey']}")
        return 0
    if command == "reindex":
        gusen_hub.run_sync_once(
            ["--reindex-calls"],
            on_progress=_svn_progress if workspace["sourceMode"] == "svn" else None,
        )
        if workspace["sourceMode"] == "svn":
            gusen_hub.update_workspace_state(config, workspace, "source", "SUCCESS")
        print("本地索引重建完成")
        return 0
    if command == "pull":
        payload = json.load(sys.stdin)
        if workspace:
            payload["workspaceKey"] = workspace["workspaceKey"]
        result = gusen_hub.pull_source_to_work_copy(payload)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    if command == "export-markdown":
        if extra_args:
            raise SystemExit("export-markdown does not accept extra arguments")
        from common import export_hub_markdown

        export_hub_markdown.main()
        return 0
    if command in SCRIPT_COMMANDS:
        module_name, function_name = SCRIPT_COMMANDS[command]
        module = importlib.import_module(module_name)
        result = getattr(module, function_name)(extra_args)
        return int(result) if isinstance(result, (bool, int)) else 0
    if command == "sync-all":
        if workspace["sourceMode"] == "svn":
            gusen_hub.run_sync_once([])
            gusen_hub.update_workspace_state(config, workspace, "source", "SUCCESS")
            gusen_hub.update_workspace_state(config, workspace, full_sync=True)
            print(f"SVN 工作区本地扫描、索引和资料摘要完成：{workspace['workspaceKey']}")
            return 0
        from providers.database import export_bill_type_sql
        from providers.database import export_system_script_sql
        from providers.database import export_table_schema_sql
        from providers.database import export_view_sql

        expected_digest = gusen_hub.workspace_config_digest(config, workspace)
        steps = (
            ("source", "源码与索引", lambda: gusen_hub.run_sync_once([])),
            ("schema", "数据库表结构", lambda: export_table_schema_sql.main([])),
            ("billType", "单据类型", lambda: export_bill_type_sql.main([])),
            ("systemScripts", "系统脚本", lambda: export_system_script_sql.main([])),
            ("views", "视图", lambda: export_view_sql.main([])),
        )
        for state_step, label, action in steps:
            latest = gusen_hub.load_config()
            latest_workspace = gusen_hub.resolve_workspace(latest, workspace["workspaceKey"])
            if gusen_hub.workspace_config_digest(latest, latest_workspace) != expected_digest:
                raise SystemExit(f"同步期间工作区配置发生变化：{workspace['workspaceKey']}")
            print(f"同步：{label}", flush=True)
            try:
                result = action()
                if result not in (None, 0):
                    raise RuntimeError(f"{label} failed with exit code {result}")
                gusen_hub.update_workspace_state(config, workspace, state_step, "SUCCESS")
            except (Exception, SystemExit) as error:
                gusen_hub.update_workspace_state(config, workspace, state_step, "FAILED", error)
                raise
        gusen_hub.update_workspace_state(config, workspace, full_sync=True)
        print(f"工作区全量同步完成：{workspace['workspaceKey']}")
        return 0
    raise SystemExit(f"Unsupported command: {command}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=("setup", "import-svn-scope", "workspaces", "workspace-summary", "source-mode", "route", "init", "svn", "sync-source-all", "sync-source", "reindex", "sync-all", "pull", "export-markdown", *SCRIPT_COMMANDS, "self-test"),
    )
    parser.add_argument("--home", required=True, help="Directory that stores local config and private source data")
    parser.add_argument("--workspace", help="Logical workspace key: products.<id> or projects.<id>")
    args, extra_args = parser.parse_known_args(argv)
    if extra_args[:1] == ["--"]:
        extra_args = extra_args[1:]
    return run(args.command, Path(args.home).expanduser().resolve(), extra_args, args.workspace)


if __name__ == "__main__":
    raise SystemExit(main())

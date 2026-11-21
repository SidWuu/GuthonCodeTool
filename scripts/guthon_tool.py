#!/usr/bin/env python3
"""Portable command entry point for GuthonCodeTool."""

from __future__ import annotations

import argparse
import contextlib
import importlib
import io
import json
import os
import re
import sys
import tempfile
import zipfile
from pathlib import Path
from importlib.resources import files
from functools import lru_cache
from common.command_errors import error_code
from common.runtime_paths import tool_source_root
from common.operation_control import (
    OperationCancelled,
    request_control,
    checkpoint,
)

COMMAND_METADATA = json.loads(
    files("common").joinpath("command_metadata.json").read_text(encoding="utf-8")
)
COMMAND_ALIASES = COMMAND_METADATA.get("commandAliases", {})


def _configure_stdio_utf8() -> None:
    """Keep the CLI protocol and human-readable output UTF-8 on every host."""

    for stream_name in ("stdin", "stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="strict")


def application_version() -> str:
    try:
        version = bundled_bytes("VERSION").decode("utf-8").strip()
    except (OSError, KeyError, zipfile.BadZipFile) as error:
        raise SystemExit("GuthonCodeTool VERSION is missing or invalid") from error
    if re.fullmatch(r"\d+\.\d+\.\d+", version):
        return version
    raise SystemExit("GuthonCodeTool VERSION is missing or invalid")


@lru_cache(maxsize=1)
def application_build_info():
    try:
        value = json.loads(bundled_bytes("BUILD_INFO.json"))
        if not isinstance(value, dict) or not re.fullmatch(
            r"sha256:[a-f0-9]{64}", value.get("buildId", "")
        ):
            raise SystemExit("Bundled build identity is invalid")
        return value
    except (OSError, KeyError):
        if getattr(sys, "frozen", False) or Path(sys.argv[0]).suffix == ".pyz":
            return {
                "buildId": "unavailable",
                "coverage": "LEGACY_ARTIFACT_WITHOUT_BUILD_ID",
            }
        from common.build_info import source_build_info

        return source_build_info(SOURCE_ROOT)


SOURCE_ROOT = tool_source_root()


def bundled_bytes(relative: str) -> bytes:
    archive = Path(sys.argv[0]).expanduser()
    if archive.suffix.lower() == ".pyz" and archive.is_file():
        with zipfile.ZipFile(archive) as bundle:
            return bundle.read(relative)
    return (resource_root() / relative).read_bytes()


SCRIPT_COMMANDS = {
    "doctor": ("common.doctor", "main"),
    "query": ("common.query_hub_context", "main"),
    "diagnose": ("common.source_diagnosis", "main"),
    "database-test-artifacts": ("common.database_test_artifacts", "main"),
    "export-bill-type": ("common.database_exports.export_bill_type_sql", "main"),
}
DATABASE_COMMANDS = {
    "database-target-resolve",
    "database-target-configure",
    "database-probe",
    "database-connect-test",
    "database-describe",
    "database-query-readonly",
    "database-diagnose",
    "database-target-list",
    "database-target-remove",
    "database-dbx-import",
    "database-dbx-handoff",
    "database-history-list",
    "database-history-show",
    "diagnosis-list",
    "diagnosis-show",
    "database-compare",
    "diagnosis-template",
    "database-credentials-export",
    "database-credentials-import",
}
CLI_COMMANDS = tuple(
    dict.fromkeys(
        (
            "version",
            "command-metadata",
            "serve",
            "mcp",
            "lint",
            "api",
            "svn",
            "legacy-source",
            "pull",
            "workcopy",
            "create-workcopy",
            "setup",
            "configuration-info",
            "configuration-upgrade",
            "svn-api-migration",
            "workspace-create",
            "workspace-delete",
            "workspace-source-mode",
            "workspace-source-settings",
            "workspaces",
            "workspace-resolve",
            "workspace-summary",
            "route",
            "search",
            "context-pack",
            "source-map",
            "pull-log",
            "parser-feedback",
            "index-doctor",
            "index-compact",
            "init",
            "sync-source-all",
            "sync-source",
            "reindex",
            "sync-all",
            "export-markdown",
            "self-test",
            "export-schema",
            "export-view",
            "export-system-script",
            *sorted(DATABASE_COMMANDS),
            *SCRIPT_COMMANDS,
            *COMMAND_ALIASES,
        )
    )
)
GLOBAL_COMMANDS = {
    "setup",
    "configuration-info",
    "workspace-create",
    "workspace-delete",
    "workspace-source-mode",
    "workspace-source-settings",
    "workspaces",
    "workspace-resolve",
    "route",
    "doctor",
    "self-test",
    "database-test-artifacts",
    *DATABASE_COMMANDS,
}
STDIN_JSON_COMMANDS = {
    "workspace-create",
    "workspace-delete",
    "workspace-source-mode",
    "workspace-source-settings",
    "database-target-configure",
    "database-dbx-import",
    "parser-feedback",
    "route",
}


def build_workspace_resolve_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="guthon_tool.py workspace-resolve")
    parser.add_argument("--path", default=str(Path.cwd()))
    parser.add_argument("--name", default="", help="Exact registered name or alias")
    parser.add_argument("--kind", default="", choices=("product", "project"), help="Optional existing product/project identity filter")
    parser.add_argument(
        "--prompt", default="", help="Resolve an unambiguous task target"
    )
    parser.add_argument(
        "--current-workspace",
        default="",
        help="Conversation-local previous workspaceKey",
    )
    parser.add_argument(
        "--stdin",
        action="store_true",
        help="Read selectors as JSON; useful for lifecycle hooks",
    )
    return parser



def build_database_parser(command: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=f"guthon_tool.py {command}")
    parser.add_argument("--path", default=str(Path.cwd()))
    parser.add_argument("--environment", choices=["dev", "test"], default="")
    parser.add_argument("--target-id", default="")
    parser.add_argument("--profile", default="")
    if command in {"database-describe", "database-diagnose", "database-dbx-handoff"}:
        parser.add_argument(
            "--table", required=command == "database-describe", default=""
        )
    if command in {
        "database-query-readonly",
        "database-diagnose",
        "database-dbx-handoff",
    }:
        sql = parser.add_mutually_exclusive_group()
        sql.add_argument(
            "--sql", help="single SELECT, or @path.sql; query also accepts stdin JSON"
        )
        sql.add_argument("--sql-file", help="UTF-8 file containing a single SELECT")
        sql.add_argument(
            "--stdin",
            action="store_true",
            help="read sql/maxRows JSON from stdin (diagnose is probe-only by default)",
        )
        parser.add_argument("--max-rows", type=int)
        parser.add_argument(
            "--format", choices=["json", "table", "csv", "xlsx"], default="json"
        )
        parser.add_argument("--output", help="write results to this local file")
        if command in {"database-query-readonly", "database-diagnose"}:
            parser.add_argument(
                "--explain",
                action="store_true",
                help="MySQL/PostgreSQL 优化器估计计划；不执行 ANALYZE，不支持 Oracle 计划表写入",
            )
    if command == "database-describe":
        parser.add_argument("--refresh", action="store_true")
        parser.add_argument("--cache-ttl", type=int, default=300)
    if command == "database-dbx-import":
        parser.add_argument("--metadata", required=True)
        parser.add_argument("--source-ref", required=True)
    if command in {"database-history-list", "diagnosis-list"}:
        parser.add_argument("--limit", type=int, default=20)
    if command in {"database-history-show", "diagnosis-show"}:
        parser.add_argument("--id", required=True)
    if command == "database-compare":
        parser.add_argument("--tables", required=True)
        parser.add_argument("--target-ids", default="")
        parser.add_argument(
            "--capture",
            default="",
            help="import complete identity-bound dev/test COUNT evidence",
        )
    if command == "diagnosis-template":
        parser.add_argument("--name", required=True)
        parser.add_argument("--parameters", default="{}")
        parser.add_argument("--template-dir", default="")
        parser.add_argument("--max-rows", type=int, default=100)
        parser.add_argument(
            "--format", choices=["json", "table", "csv"], default="json"
        )
        parser.add_argument("--output")
        parser.add_argument(
            "--case-out", help="生成需人工审阅的legacy诊断案例草稿；不连接数据库"
        )
        parser.add_argument("--datasource", default="")
        parser.add_argument("--source-evidence", default="")
    if command in {"database-credentials-export", "database-credentials-import"}:
        parser.add_argument("--vault", required=True)
        parser.add_argument("--credential-ref", action="append", required=True)
        parser.add_argument("--passphrase-env", required=True)
        parser.add_argument("--node", default="")
        parser.add_argument("--confirmation", required=True)
    if command == "database-target-remove":
        parser.add_argument("--check", action="store_true", help="preview removal")
        parser.add_argument(
            "--confirmation", default="", help="exact target-id for removal"
        )
    return parser


def build_index_doctor_parser():
    parser = argparse.ArgumentParser(prog="guthon_tool.py index-doctor")
    parser.add_argument("--limit", type=int, default=20)
    return parser


def build_index_compact_parser():
    parser = argparse.ArgumentParser(prog="guthon_tool.py index-compact")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="compact the derived index; omit to preview",
    )
    return parser


def build_pull_log_parser():
    parser = argparse.ArgumentParser(prog="guthon_tool.py pull-log")
    parser.add_argument(
        "action", choices=("tail", "summary", "export", "archive", "restore")
    )
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--cursor", default="")
    parser.add_argument("--generation", default="")
    parser.add_argument("--format", choices=["json", "markdown"], default="json")
    parser.add_argument("--before", default="")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--confirmation", default="")
    parser.add_argument("--plan-hash", default="")
    parser.add_argument("--archive-id", default="")
    return parser


def build_search_parser(command: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=f"guthon_tool.py {command}")
    parser.add_argument("--limit", type=int, default=20 if command == "search" else 5)
    if command == "search":
        parser.add_argument("--query", required=True)
    else:
        parser.add_argument("--source-id", required=True)
        parser.add_argument("--fun-id", "--fun", dest="fun_id", default="")
        parser.add_argument("--detailed", action="store_true")
        parser.add_argument("--source-namespace", default="")
        parser.add_argument("--include-source", action="store_true")
        parser.add_argument("--max-chars", type=int, default=8000)
        parser.add_argument(
            "--write-context",
            action="store_true",
            help="save Markdown into this workspace context/ai",
        )
    return parser


def build_source_map_parser():
    parser = argparse.ArgumentParser(prog="guthon_tool.py source-map")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--cursor", default="")
    parser.add_argument(
        "--write",
        action="store_true",
        help="write the bounded Markdown map to workspace context/ai",
    )
    return parser


from providers.api.cli import parser as build_api_parser
from common.configuration_upgrade import parser as build_configuration_upgrade_parser
from common.svn_api_migration import parser as build_svn_api_migration_parser
from common.legacy_source_cli import build_svn_parser

def build_setup_parser():
    parser = argparse.ArgumentParser(prog="guthon_tool.py setup")
    parser.add_argument("--workspace-directory", help="Name of the development directory directly inside --home (default: var)")
    team = parser.add_mutually_exclusive_group()
    team.add_argument("--team-source", help="Trusted guthon-team Git URL or absolute local repository path (default: GUTHON_TEAM_MARKETPLACE_URL)")
    team.add_argument("--no-team-sync", action="store_true", help="Prepare the workspace layout only")
    return parser


COMMAND_PARSER_BUILDERS = {
    "setup": build_setup_parser,
    "api": build_api_parser,
    "configuration-upgrade": build_configuration_upgrade_parser,
    "svn-api-migration": build_svn_api_migration_parser,
    "svn": build_svn_parser,
    "workspace-resolve": build_workspace_resolve_parser,
    "database-target-resolve": lambda: build_database_parser("database-target-resolve"),
    "database-probe": lambda: build_database_parser("database-probe"),
    "database-describe": lambda: build_database_parser("database-describe"),
    "database-query-readonly": lambda: build_database_parser("database-query-readonly"),
    "index-doctor": build_index_doctor_parser,
    "index-compact": build_index_compact_parser,
    "pull-log": build_pull_log_parser,
    "source-map": build_source_map_parser,
    "search": lambda: build_search_parser("search"),
    "context-pack": lambda: build_search_parser("context-pack"),
}
from providers.api.exports import parser as build_export_parser

COMMAND_PARSER_BUILDERS.update(
    {
        command: (lambda source=kind: build_export_parser(source))
        for command, kind in {
            "export-schema": "table",
            "export-view": "view",
            "export-system-script": "system-script",
        }.items()
    }
)
COMMAND_PARSER_BUILDERS.update(
    {
        command: (lambda name=command: build_database_parser(name))
        for command in DATABASE_COMMANDS
    }
)
# 委托模块自带 parser 的命令：帮助直接交给该模块的 argparse 输出。
HELP_DELEGATES = {
    **SCRIPT_COMMANDS,
    "export-markdown": ("common.export_hub_markdown", "main"),
}


def _top_level_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=CLI_COMMANDS,
    )
    parser.add_argument(
        "--home", help="Directory that stores local config and private source data"
    )
    parser.add_argument(
        "--workspace", help="Stable workspace ID returned by workspace-create or workspaces"
    )
    parser.add_argument(
        "--json",
        dest="json_output",
        action="store_true",
        help="emit a structured command result or error",
    )
    parser.add_argument(
        "--format",
        dest="output_format",
        choices=["json", "text", "table", "csv", "xlsx"],
        help="统一输出格式；xlsx仅用于数据库查询且必须指定私有文件输出",
    )
    return parser


def _print_command_help(topic: str, rest: list[str]) -> int:
    topic = COMMAND_ALIASES.get(topic, topic)
    if topic == "lint":
        print("lint --home <toolHome> [Linter 参数]：调用已安装的团队 Linter。")
        print("查看完整参数：lint --home <toolHome> --help")
        return 0
    if topic in HELP_DELEGATES:
        module_name, function_name = HELP_DELEGATES[topic]
        module = importlib.import_module(module_name)
        try:
            getattr(module, function_name)(["--help"])
        except SystemExit as error:
            if error.code not in (None, 0):
                raise
        return 0
    builder = COMMAND_PARSER_BUILDERS.get(topic)
    if builder is not None:
        parser = builder()
        parser.print_help()
        return 0
    print(f"guthon_tool.py {topic} 没有命令级选项，仅接受 --home/--workspace。")
    if topic in STDIN_JSON_COMMANDS:
        print("输入从 stdin 读取 JSON。")
    print(
        "用 `guthon_tool.py --help` 查看全部命令，用 `guthon_tool.py help <command>` 查看具体命令。"
    )
    return 0


def _dispatch_help(raw: list[str]) -> int | None:
    """Route a trailing -h/--help to the target command parser; None means default handling."""

    if not raw or raw[-1] not in {"-h", "--help"}:
        return None
    tokens = iter(enumerate(raw))
    topic = None
    topic_index = None
    for index, token in tokens:
        if token in {"--home", "--workspace"}:
            next(tokens, None)
            continue
        if token in CLI_COMMANDS:
            topic, topic_index = token, index
            break
    if topic is None or topic in {"version", "serve", "mcp"}:
        return None
    return _print_command_help(topic, raw[topic_index + 1 :])


def _command_help(argv: list[str]) -> int:
    """Implement the explicit `guthon_tool.py help <command>` entry point."""

    if not argv or argv[0] in {"-h", "--help"}:
        _top_level_parser().print_help()
        return 0
    topic = argv[0]
    if topic not in CLI_COMMANDS:
        raise SystemExit(f"Unsupported command: {topic}")
    return _print_command_help(topic, argv[1:])


def resource_root() -> Path:
    return Path(getattr(sys, "_MEIPASS", SOURCE_ROOT))


def setup_config(home: Path, *, workspace_name=None, team_source=None) -> list[Path]:
    from common import config_store
    return config_store.initialize(home, workspace_name=workspace_name, team_source=team_source)


def run(
    command: str, home: Path, extra_args: list[str], selected_workspace=None
) -> int:
    command = COMMAND_ALIASES.get(command, command)
    os.environ["GUTHON_HOME"] = str(home)
    if command == "lint":
        import runpy

        from common.runtime_paths import workspace_root

        root = workspace_root(home)
        script = root / ".guthon" / "bin" / "guthon_lint.py"
        if not script.is_file():
            raise SystemExit(f"未安装 Guthon Linter：{script}；请先初始化团队规范")
        lint = runpy.run_path(str(script))
        return lint["main"](["--repo", str(root), "--scope-from", str(Path.cwd()), *extra_args])

    from common import gusen_hub

    if command == "self-test":
        with tempfile.TemporaryDirectory() as temp:
            test_home = Path(temp)
            setup_config(test_home)
            previous = os.environ["GUTHON_HOME"]
            os.environ["GUTHON_HOME"] = str(test_home)
            try:
                from common.workspace_config import create_workspace

                created = create_workspace(
                    test_home,
                    {"id": "self-test", "name": "Self Test"},
                    gusen_hub,
                )
                workspace = gusen_hub.resolve_workspace(
                    gusen_hub.load_config(), "self-test"
                )
                assert created["workspace"]["sourceMode"] == "api"
                assert (
                    workspace["providerSourceRoot"]
                    == (test_home / "var/workspace/Self Test/checkout").resolve()
                )
                from providers.api.index import rebuild, catalog

                assert rebuild(workspace)["complete"]
                assert catalog(workspace)["objects"] == []
                capture = io.StringIO()
                with contextlib.redirect_stdout(capture):
                    _command_help(["api"])
                assert "upload" in capture.getvalue()
            finally:
                os.environ["GUTHON_HOME"] = previous
        print("guthon_tool self-test: ok")
        return 0
    if command == "setup":
        options = build_setup_parser().parse_args(extra_args)
        team_source = None if options.no_team_sync else (
            options.team_source or os.environ.get("GUTHON_TEAM_MARKETPLACE_URL")
        )
        created = setup_config(home, workspace_name=options.workspace_directory, team_source=team_source)
        result = {"ok": True, "created": [str(x) for x in created]}
        if team_source:
            result["governance"] = "ready"
        print(json.dumps(result, ensure_ascii=False))
        return 0
    if command == "svn-api-migration":
        if not selected_workspace:
            raise SystemExit("svn-api-migration requires --workspace")
        from common import svn_api_migration
        from common.command_errors import CommandError
        from providers.api.client import ApiError

        try:
            result = svn_api_migration.run(home, selected_workspace, extra_args, sys.stdin)
        except ApiError as error:
            raise CommandError(error.code, str(error)) from error
        except ValueError as error:
            raise SystemExit(str(error)) from error
        print(json.dumps(result, ensure_ascii=False))
        return 0
    if command == "configuration-upgrade":
        if selected_workspace:
            raise SystemExit("configuration-upgrade applies to a toolHome")
        from common import configuration_upgrade
        print(json.dumps(configuration_upgrade.run(home, extra_args), ensure_ascii=False))
        return 0
    if command == "configuration-info":
        from common import config_store
        if extra_args:
            raise SystemExit("configuration-info 不接受额外参数")
        print(json.dumps(config_store.info(home), ensure_ascii=False))
        return 0
    if command == "workspace-source-settings":
        if extra_args or not selected_workspace:
            raise SystemExit("workspace-source-settings 需要 --workspace 和 stdin JSON")
        from common.workspace_source_settings import run as source_settings

        result = source_settings(home, selected_workspace, json.load(sys.stdin), gusen_hub)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    if command in {"workspace-create", "workspace-delete", "workspace-source-mode"}:
        if extra_args:
            raise SystemExit(command + "只接受stdin JSON")
        from common.workspace_config import change_source_mode, create_workspace, delete_workspace_config

        handler = {"workspace-create": create_workspace, "workspace-delete": delete_workspace_config,
                   "workspace-source-mode": change_source_mode}[command]
        result = handler(home, json.load(sys.stdin), gusen_hub)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    if command == 'doctor':
        from common.doctor import main
        return main(extra_args, workspace_key=selected_workspace or '')
    config = gusen_hub.load_config()
    if command == "workspaces":
        errors = []
        workspaces = gusen_hub.list_workspaces(config, errors=errors)
        summaries = []
        for workspace in workspaces:
            try:
                summaries.append(gusen_hub.workspace_summary(config, workspace))
            except (SystemExit, ValueError, TypeError, OSError) as error:
                errors.append({'workspaceKey': workspace['workspaceKey'], 'code': 'WORKSPACE_STATE_INVALID',
                               'message': str(error)})
        print(
            json.dumps(
                {
                    "ok": True,
                    "workspaces": summaries,
                    "configErrors": errors,
                },
                ensure_ascii=False,
            )
        )
        return 0
    if command == "route":
        print(
            json.dumps(
                gusen_hub.route_workspace_request(config, json.load(sys.stdin)),
                ensure_ascii=False,
            )
        )
        return 0
    if selected_workspace:
        gusen_hub.set_workspace(selected_workspace)
    if command not in GLOBAL_COMMANDS and not selected_workspace:
        raise SystemExit("Missing --workspace. Select an explicit stable workspace ID.")
    workspace = (
        gusen_hub.resolve_workspace(config, selected_workspace)
        if selected_workspace or command not in GLOBAL_COMMANDS
        else None
    )
    checkpoint()
    return _run_workspace_command(command, extra_args, gusen_hub, config, workspace)


def _run_workspace_command(command, extra_args, gusen_hub, config, workspace):
    if workspace and workspace["sourceMode"] != "api" and command not in {
        "workspace-resolve", "workspace-summary", "pull-log", "index-doctor", *DATABASE_COMMANDS
    }:
        from common.legacy_source_cli import run as run_legacy
        return run_legacy(command, extra_args, config, workspace)
    if command in {"svn", "legacy-source", "pull", "workcopy", "create-workcopy"}:
        raise SystemExit(f"{command} requires an explicitly selected legacy workspace")
    if command == "api":
        from providers.api.cli import run as run_api

        return run_api(workspace, extra_args)
    if command == "workspace-resolve":
        parsed = build_workspace_resolve_parser().parse_args(extra_args)
        from common.workspace_selection import select_workspace

        selectors = {
            "workspace_key": workspace["workspaceKey"] if workspace else "",
            "name": parsed.name,
            "kind": parsed.kind,
            "path": parsed.path,
            "prompt": parsed.prompt,
            "current_workspace": parsed.current_workspace,
        }
        if parsed.stdin:
            supplied = json.load(sys.stdin)
            if not isinstance(supplied, dict) or set(supplied) - set(selectors):
                raise SystemExit(
                    "workspace-resolve stdin must be a JSON object of supported selectors"
                )
            selectors.update(supplied)
        result = select_workspace(config, **selectors)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result["ok"] or result.get("action") == "list" else 1
    if command in DATABASE_COMMANDS:
        from common import database_cli

        parsed = build_database_parser(command).parse_args(extra_args)
        return database_cli.run(command, parsed, gusen_hub, config, workspace)
    if command == "workspace-summary":
        if extra_args:
            raise SystemExit("workspace-summary does not accept extra arguments")
        print(
            json.dumps(
                {
                    "ok": True,
                    "workspace": gusen_hub.workspace_summary(config, workspace),
                },
                ensure_ascii=False,
            )
        )
        return 0
    if command == "parser-feedback":
        if extra_args:
            raise SystemExit("parser-feedback accepts only stdin JSON")
        from common.parser_feedback import save_feedback

        print(
            json.dumps(
                save_feedback(workspace, json.load(sys.stdin)),
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    if command == "pull-log":
        from common import pull_history

        parsed = build_pull_log_parser().parse_args(extra_args)
        bridge_root = Path(gusen_hub.VAR_DIR) / "nexus" / "bridge"
        if parsed.action in {"tail", "summary"}:
            result = pull_history.query_history(
                workspace,
                bridge_root,
                limit=parsed.limit,
                summary=parsed.action == "summary",
                cursor=parsed.cursor,
            )
        elif parsed.action == "export":
            result = pull_history.export_history(
                workspace,
                bridge_root,
                format=parsed.format,
                generation=parsed.generation,
            )
        elif parsed.action == "archive":
            if not parsed.before:
                raise SystemExit("pull-log archive requires --before YYYY-MM-DD")
            result = pull_history.archive_history(
                workspace,
                bridge_root,
                before=parsed.before,
                check=parsed.check,
                confirmation=parsed.confirmation,
                plan_hash=parsed.plan_hash,
            )
        else:
            if not parsed.archive_id:
                raise SystemExit("pull-log restore requires --archive-id")
            result = pull_history.restore_history(
                workspace,
                archive_id=parsed.archive_id,
                check=parsed.check,
                confirmation=parsed.confirmation,
                plan_hash=parsed.plan_hash,
            )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["ok"] else 1
    if command == "source-map":
        from common import workspace_assistant

        parsed = build_source_map_parser().parse_args(extra_args)
        result = workspace_assistant.source_map(
            workspace, limit=parsed.limit, cursor=parsed.cursor
        )
        if parsed.write:
            from common.persistence import atomic_text

            path = workspace["contextDir"] / "ai" / "SOURCE_MAP.md"
            atomic_text(path, result["markdown"])
            result["artifactPath"] = str(path)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if command == "index-doctor":
        parsed = build_index_doctor_parser().parse_args(extra_args)
        result = gusen_hub.workspace_index_state(workspace)
        print(
            json.dumps(
                {"ok": True, "workspaceKey": workspace["workspaceKey"], **result},
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    if command == "index-compact":
        from common.index_maintenance import compact_index

        parsed = build_index_compact_parser().parse_args(extra_args)
        print(
            json.dumps(
                compact_index(workspace, apply=parsed.apply),
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    if command in {"search", "context-pack"}:
        from common import workspace_assistant

        parsed = build_search_parser(command).parse_args(extra_args)
        result = (
            workspace_assistant.unified_search(workspace, parsed.query, parsed.limit)
            if command == "search"
            else workspace_assistant.context_pack(
                workspace,
                parsed.source_id,
                parsed.fun_id,
                parsed.limit,
                parsed.detailed,
                include_source=parsed.include_source,
                max_chars=parsed.max_chars,
                source_namespace=parsed.source_namespace,
            )
        )
        if command == "context-pack" and parsed.write_context:
            from common.persistence import atomic_text

            filename = (
                gusen_hub.path_part(
                    parsed.source_id + ("." + parsed.fun_id if parsed.fun_id else "")
                )
                + ".md"
            )
            target = workspace["contextDir"] / "ai" / filename
            atomic_text(target, result["markdown"])
            result["artifactPath"] = str(target.resolve())
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if command in {"init", "reindex"}:
        from providers.api.index import rebuild

        print(json.dumps(rebuild(workspace), ensure_ascii=False))
        return 0
    if command in {"sync-source", "sync-source-all", "sync-all"}:
        from providers.api.cli import run as run_api

        return run_api(workspace, ["pull"])
    if command == "export-markdown":
        if extra_args:
            raise SystemExit("export-markdown does not accept extra arguments")
        from common import export_hub_markdown

        export_hub_markdown.main([], workspace)
        return 0
    if command in {"export-schema", "export-view", "export-system-script"}:
        from providers.api.exports import main

        return main(
            {
                "export-schema": "table",
                "export-view": "view",
                "export-system-script": "system-script",
            }[command],
            extra_args,
        )
    if command in SCRIPT_COMMANDS:
        module_name, function_name = SCRIPT_COMMANDS[command]
        module = importlib.import_module(module_name)
        result = getattr(module, function_name)(extra_args)
        if isinstance(result, dict):
            return 0 if result.get("ok", True) else 1
        return int(result) if isinstance(result, (bool, int)) else 0
    raise SystemExit(f"Unsupported command: {command}")


def _toolhost_request_kind(command: str, args: list[str]) -> str:
    spec = (
        COMMAND_METADATA["apiActions"].get(args[0], {})
        if command == "api" and args
        else COMMAND_METADATA["svnActions"].get(args[0], {})
        if command == "svn" and args
        else COMMAND_METADATA["commands"].get(command, {})
    )
    if any(
        token == flag or token.startswith(flag + "=")
        for flag in spec.get("writeFlags", [])
        for token in args
    ):
        return "write"
    if any(token in spec.get("writeArguments", []) for token in args):
        return "write"
    return spec.get("kind", "write")


def serve_stdio(home: Path) -> int:
    protocol_input = sys.stdin
    # Keep an independent descriptor: native command stdout is redirected to a
    # temporary file, while the protocol reader can still acknowledge cancel.
    import threading
    from common.toolhost_requests import ToolHostRequests

    protocol_output = os.fdopen(
        os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1
    )
    protocol_lock = threading.Lock()

    def reply(frame):
        with protocol_lock:
            protocol_output.write(json.dumps(frame, ensure_ascii=False) + "\n")
            protocol_output.flush()

    os.environ["GUTHON_HOME"] = str(home)
    reply(
        {
            "type": "ready",
            "protocolVersion": 1,
            "version": application_version(),
            "pid": os.getpid(),
            "capabilities": ["cancel-index-v1"],
        }
    )
    requests = ToolHostRequests(protocol_input, reply, COMMAND_METADATA)
    for line, queued_id, control in requests:
        request_id = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request must be a JSON object")
            request_id = request.get("id")
            command = request.get("command")
            args = request.get("args", [])
            workspace_key = request.get("workspaceKey", "")
            if not isinstance(request_id, str) or not request_id:
                raise ValueError("id must be a non-empty string")
            if (
                not isinstance(command, str)
                or command not in CLI_COMMANDS
                or command in {"serve", "mcp", "self-test", "configuration-upgrade", "svn-api-migration"}
            ):
                raise ValueError("unsupported command")
            if not isinstance(args, list) or any(
                not isinstance(arg, str) for arg in args
            ):
                raise ValueError("args must be a string array")
            if not isinstance(workspace_key, str):
                raise ValueError("workspaceKey must be a string")
            if request.get("requestKind") != _toolhost_request_kind(command, args):
                raise ValueError("requestKind does not match command")
            payload = request.get("input")
            capture = io.StringIO()
            old_input = sys.stdin
            protocol_output.flush()
            saved_stdout_fd = None
            try:
                saved_stdout_fd = os.dup(1)
                with tempfile.TemporaryFile() as native_stdout:
                    os.dup2(native_stdout.fileno(), 1)
                    try:
                        sys.stdin = io.StringIO(
                            ""
                            if payload is None
                            else json.dumps(payload, ensure_ascii=False)
                        )
                        with contextlib.redirect_stdout(capture):
                            if command == "command-metadata":
                                print(json.dumps(COMMAND_METADATA, ensure_ascii=False))
                                code = 0
                            elif command == "version":
                                print(
                                    json.dumps(
                                        {
                                            "version": application_version(),
                                            **application_build_info(),
                                        },
                                        ensure_ascii=False,
                                    )
                                )
                                code = 0
                            else:
                                with request_control(control):
                                    checkpoint()
                                    code = run(
                                        command, home, args, workspace_key or None
                                    )
                    finally:
                        os.dup2(saved_stdout_fd, 1)
                    native_stdout.seek(0)
                    native_text = native_stdout.read().decode("utf-8", errors="replace")
            finally:
                sys.stdin = old_input
                if saved_stdout_fd is not None:
                    os.close(saved_stdout_fd)
            if native_text:
                print(native_text, file=sys.stderr, end="", flush=True)
            output = capture.getvalue()
            if code not in (None, 0):
                raise RuntimeError(f"Command failed with exit code {code}")
            try:
                result = json.loads(output)
            except json.JSONDecodeError:
                result = {"stdout": output}
            response = {
                "id": request_id,
                "type": "result",
                "ok": True,
                "result": result,
            }
        except (Exception, SystemExit, OperationCancelled) as error:
            response = {
                "id": request_id,
                "type": "result",
                "ok": False,
                "error": {
                    "code": error_code(
                        error,
                        "INVALID_REQUEST"
                        if isinstance(error, ValueError)
                        else "COMMAND_FAILED",
                    ),
                    "message": str(error),
                },
            }
        requests.finish(queued_id, control)
        reply(response)
    protocol_output.close()
    return 0


def main(argv=None) -> int:
    _configure_stdio_utf8()
    raw = list(sys.argv[1:] if argv is None else argv)
    if raw[:1] == ["lint"]:
        # Leave all linter options (including --format/--json) untouched.
        parser = argparse.ArgumentParser(prog="guthon_tool.py lint", add_help=False)
        parser.add_argument("--home", required=True)
        parsed, lint_args = parser.parse_known_args(raw[1:])
        if lint_args[:1] == ["--"]:
            lint_args = lint_args[1:]
        return run("lint", Path(parsed.home).expanduser().resolve(), lint_args)
    if raw[:1] == ["help"]:
        return _command_help(raw[1:])
    help_code = _dispatch_help(raw)
    if help_code is not None:
        return help_code
    parser = _top_level_parser()
    args, extra_args = parser.parse_known_args(raw)
    if extra_args[:1] == ["--"]:
        extra_args = extra_args[1:]
    if args.json_output and args.output_format not in (None, "json"):
        parser.error("--json cannot be combined with a non-JSON --format")
    if args.command == "version":
        if args.home or args.workspace or extra_args:
            parser.error(
                "version does not accept --home, --workspace, or extra arguments"
            )
        value = {"version": application_version(), **application_build_info()}
        if args.json_output or args.output_format:
            from common.cli_output import envelope, render

            if args.output_format == "xlsx":
                parser.error("version does not support XLSX")
            print(
                render(
                    envelope(json.dumps(value), command="version"),
                    args.output_format or "json",
                ),
                end="",
            )
        else:
            print(json.dumps(value, ensure_ascii=False))
        return 0
    if args.command == "command-metadata":
        if args.workspace or extra_args:
            parser.error("command-metadata does not accept command-level arguments")
        if args.json_output or args.output_format:
            from common.cli_output import envelope, render

            if args.output_format == "xlsx":
                parser.error("command-metadata does not support XLSX")
            print(
                render(
                    envelope(json.dumps(COMMAND_METADATA), command="command-metadata"),
                    args.output_format or "json",
                ),
                end="",
            )
        else:
            print(json.dumps(COMMAND_METADATA, ensure_ascii=False, indent=2))
        return 0
    if not args.home:
        args.home = os.environ.get("GUTHON_HOME") or os.environ.get("GUTHON_TOOL_HOME")
    if not args.home:
        parser.error("--home or GUTHON_HOME / GUTHON_TOOL_HOME is required")
    if args.command == "serve":
        if args.json_output or args.output_format:
            parser.error(
                "serve uses its own stdio protocol; output formatting is unavailable"
            )
        if args.workspace or extra_args != ["--stdio"]:
            parser.error(
                "serve requires --stdio and does not accept --workspace or extra arguments"
            )
        return serve_stdio(Path(args.home).expanduser().resolve())
    if args.command == "mcp":
        if args.json_output or args.output_format:
            parser.error("mcp uses its own protocol; output formatting is unavailable")
        mcp_parser = argparse.ArgumentParser(prog="guthon_tool.py mcp")
        mcp_parser.add_argument("--stdio", action="store_true", required=True)
        mcp_parser.add_argument("--provider", choices=["api", "svn", "database"])
        access = mcp_parser.add_mutually_exclusive_group()
        access.add_argument("--read-only", action="store_true")
        access.add_argument("--enable-page-write", action="store_true")
        options = mcp_parser.parse_args(extra_args)
        if args.workspace:
            parser.error("MCP tools require an explicit workspaceKey per request")
        home = Path(args.home).expanduser().resolve()
        provider = options.provider
        if provider is None:
            from common import config_store
            legacy_only = not config_store.unified(home) and all(
                (home / "config" / name).is_file() for name in config_store.LEGACY_SECTIONS.values()
            )
            provider = "svn" if legacy_only else "api"
        if provider == "svn":
            from providers.svn.nexus.mcp_server import serve_stdio as serve_mcp_stdio
        elif provider == "database":
            from providers.database.mcp_server import serve_stdio as serve_mcp_stdio
        else:
            from providers.api.mcp_server import serve_stdio as serve_mcp_stdio
        return serve_mcp_stdio(home, application_version(), enable_writes=not options.read_only)

    home = Path(args.home).expanduser().resolve()
    if args.output_format in {"csv", "table", "text", "xlsx"} and args.command in {
        "database-query-readonly",
        "database-diagnose",
        "database-dbx-handoff",
    }:
        requested = "table" if args.output_format == "text" else args.output_format
        extra_args = [*extra_args, "--format", requested]
        return run(args.command, home, extra_args, args.workspace)
    if args.output_format == "xlsx":
        parser.error(
            "XLSX is only available for an executed database query with --output"
        )
    if not args.json_output and not args.output_format:
        return run(args.command, home, extra_args, args.workspace)
    if args.command == "doctor":
        extra_args = [*extra_args, "--json"]
    capture = io.StringIO()
    from common.cli_output import envelope, render

    try:
        with contextlib.redirect_stdout(capture):
            code = run(args.command, home, extra_args, args.workspace)
        result = envelope(
            capture.getvalue(),
            command=args.command,
            workspace_key=args.workspace,
            exit_code=code,
        )
        print(render(result, args.output_format or "json"), end="")
        return code
    except (Exception, SystemExit) as error:
        result = envelope(
            json.dumps(
                {
                    "ok": False,
                    "error": {"code": error_code(error), "message": str(error)},
                }
            ),
            command=args.command,
            workspace_key=args.workspace,
            exit_code=1,
        )
        print(render(result, args.output_format or "json"), end="")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

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
from common.operation_control import OperationCancelled, RequestControl, request_control, checkpoint, restrict_to_index

COMMAND_METADATA = json.loads(files("common").joinpath("command_metadata.json").read_text(encoding="utf-8"))
COMMAND_ALIASES = COMMAND_METADATA.get('commandAliases',{})


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
        if not isinstance(value, dict) or not re.fullmatch(r"sha256:[a-f0-9]{64}", value.get("buildId", "")):
            raise SystemExit("Bundled build identity is invalid")
        return value
    except (OSError, KeyError):
        if getattr(sys, "frozen", False) or Path(sys.argv[0]).suffix == ".pyz":
            return {"buildId": "unavailable", "coverage": "LEGACY_ARTIFACT_WITHOUT_BUILD_ID"}
        from common.build_info import source_build_info
        return source_build_info(SOURCE_ROOT)


SOURCE_ROOT = Path(__file__).resolve().parents[1]


def bundled_bytes(relative: str) -> bytes:
    archive = Path(sys.argv[0]).expanduser()
    if archive.suffix.lower() == ".pyz" and archive.is_file():
        with zipfile.ZipFile(archive) as bundle:
            return bundle.read(relative)
    return (resource_root() / relative).read_bytes()
CONFIG_FILES = (
    "datasource.yaml",
    "products.yaml",
    "projects.yaml",
    "source-tables.yaml",
    "sync.yaml",
    "database-testing.yaml",
)
EMPTY_REGISTRY_FILES = {
    "datasource.yaml": "# 本地数据库连接由 Nexus 添加产品/项目时写入。\ndatasource: {}\n",
    "products.yaml": "# 本地产品工作区；可在 Nexus 中随时添加。\nproducts: {}\n",
    "database-testing.yaml": "# 本地数据库测试目标；由 configure 添加连接与身份。\nschemaVersion: 1\nconnections: {}\nexpectedIdentities: {}\ndatabaseTests: {}\n",
    "projects.yaml": "# 本地项目工作区；可在 Nexus 中随时添加。\nprojects: {}\n",
}
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
    "database-test-artifacts": ("common.database_test_artifacts", "main"),
}
COMMAND_STEPS = {
    "sync-source-all": "source",
    "sync-source": "source",
    "export-schema": "schema",
    "export-bill-type": "billType",
    "export-system-script": "systemScripts",
    "export-view": "views",
}
SVN_BROWSE_ACTIONS = {name for name, spec in COMMAND_METADATA["svnActions"].items() if spec["kind"] == "read"}
TOOLHOST_READ_COMMANDS = {name for name, spec in COMMAND_METADATA["commands"].items() if spec["kind"] == "read"}
DATABASE_COMMANDS = {
    "database-target-resolve", "database-target-configure", "database-probe", "database-connect-test",
    "database-describe", "database-query-readonly", "database-diagnose", "database-target-list", "database-target-remove",
    "database-dbx-import", "database-dbx-handoff", "database-history-list", "database-history-show",
    "diagnosis-list", "diagnosis-show", "database-compare", "diagnosis-template",
    "database-credentials-export", "database-credentials-import",
}
TOOLHOST_READ_COMMANDS.update(DATABASE_COMMANDS - {"database-target-configure", "database-target-remove", "database-dbx-import", "database-credentials-export", "database-credentials-import"})

CLI_COMMANDS = (
    "version", "command-metadata", "serve", "mcp", "setup", "workspace-create", "workspace-delete",
    "svn-login-configure", "import-svn-scope", "workspaces", "workspace-resolve",
    "database-target-resolve", "database-target-configure", "database-probe",
    "database-describe", "database-query-readonly", "workspace-summary", "search",
    "context-pack", "source-map", "search-all", "pull-log", "parser-feedback", "index-doctor", "source-mode", "route", "init", "svn", "sync-source-all",
    "sync-source", "reindex", "sync-all", "pull", "export-markdown",
    *SCRIPT_COMMANDS, "self-test", *sorted(DATABASE_COMMANDS - {"database-target-resolve", "database-target-configure", "database-probe", "database-describe", "database-query-readonly"}),
)
CLI_COMMANDS=(*CLI_COMMANDS,*COMMAND_ALIASES)
GLOBAL_COMMANDS = {
    "setup",
    "workspace-create",
    "workspace-delete",
    "svn-login-configure",
    "doctor",
    "route",
    "workspaces",
    "workspace-resolve",
    "database-target-resolve",
    "database-probe",
    "database-describe",
    "database-query-readonly",
    "self-test",
}
GLOBAL_COMMANDS.update(DATABASE_COMMANDS - {"database-target-configure", "database-target-remove", "database-dbx-import", "database-credentials-export", "database-credentials-import"})
GLOBAL_COMMANDS.update({"database-test-artifacts", "search-all"})

DATABASE_ONLY_COMMANDS = {
    "export-schema": "database.schemaExport",
    "export-bill-type": "database.billTypeExport",
    "export-system-script": "database.systemScriptExport",
    "export-view": "database.viewExport",
    "diagnose": "database.diagnose",
}
# 每个 action 的 {说明, 专属参数用法, stdin 约定}；与 run() 分支保持一致，帮助输出与 action 列表都依赖本表。
SVN_ACTION_SPECS = COMMAND_METADATA["svnActions"]
SVN_ACTIONS = tuple(SVN_ACTION_SPECS)
# 这些命令不接受命令级选项，输入从 stdin 读取 JSON。
STDIN_JSON_COMMANDS = {
    "workspace-create",
    "workspace-delete",
    "svn-login-configure",
    "database-target-configure",
    "parser-feedback",
    "database-dbx-import",
    "route",
    "pull",
}
SVN_USAGE_PREFIX = "guthon_tool.py svn --home <toolHome> --workspace <workspaceKey> --"


def build_import_svn_scope_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="guthon_tool.py import-svn-scope")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--script", help="path to svnCheckoutHere.sh or svnCheckoutHere.bat")
    source.add_argument("--bat", help="legacy alias for a checkout BAT path")
    source.add_argument("--config", help="path to an editable svn-scope.yaml/json configuration")
    parser.add_argument("--output", required=True, help="target authorized-scope.json path")
    parser.add_argument("--replace", action="store_true", help="replace an existing changed manifest")
    return parser


def build_workspace_resolve_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="guthon_tool.py workspace-resolve")
    parser.add_argument("--path", default=str(Path.cwd()))
    return parser


def build_database_parser(command: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=f"guthon_tool.py {command}")
    parser.add_argument("--path", default=str(Path.cwd()))
    parser.add_argument("--environment", choices=["dev", "test"], default="")
    parser.add_argument("--target-id", default="")
    parser.add_argument("--profile", default="")
    if command in {"database-describe", "database-diagnose", "database-dbx-handoff"}:
        parser.add_argument("--table", required=command == "database-describe", default="")
    if command in {"database-query-readonly", "database-diagnose", "database-dbx-handoff"}:
        sql = parser.add_mutually_exclusive_group()
        sql.add_argument("--sql", help="single SELECT, or @path.sql; query also accepts stdin JSON")
        sql.add_argument("--sql-file", help="UTF-8 file containing a single SELECT")
        sql.add_argument("--stdin", action="store_true", help="read sql/maxRows JSON from stdin (diagnose is probe-only by default)")
        parser.add_argument("--max-rows", type=int)
        parser.add_argument("--format", choices=["json", "table", "csv", "xlsx"], default="json")
        parser.add_argument("--output", help="write results to this local file")
        if command in {'database-query-readonly','database-diagnose'}:
            parser.add_argument('--explain', action='store_true', help='MySQL/PostgreSQL 优化器估计计划；不执行 ANALYZE，不支持 Oracle 计划表写入')
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
        parser.add_argument("--capture", default="", help="import complete identity-bound dev/test COUNT evidence")
    if command == "diagnosis-template":
        parser.add_argument("--name", required=True)
        parser.add_argument("--parameters", default="{}")
        parser.add_argument("--template-dir", default="")
        parser.add_argument("--max-rows", type=int, default=100)
        parser.add_argument("--format", choices=["json", "table", "csv"], default="json")
        parser.add_argument("--output")
        parser.add_argument('--case-out',help='生成需人工审阅的legacy诊断案例草稿；不连接数据库')
        parser.add_argument('--datasource',default='')
        parser.add_argument('--source-evidence',default='')
    if command in {"database-credentials-export", "database-credentials-import"}:
        parser.add_argument("--vault", required=True)
        parser.add_argument("--credential-ref", action="append", required=True)
        parser.add_argument("--passphrase-env", required=True)
        parser.add_argument("--node", default="")
        parser.add_argument("--confirmation", required=True)
    if command == "database-target-remove":
        parser.add_argument("--check", action="store_true", help="preview removal")
        parser.add_argument("--confirmation", default="", help="exact target-id for removal")
    return parser


def build_source_mode_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="guthon_tool.py source-mode")
    parser.add_argument("action", choices=["get", "set"])
    parser.add_argument("--mode", choices=["database", "svn"])
    return parser


def build_index_doctor_parser():
    parser = argparse.ArgumentParser(prog="guthon_tool.py index-doctor")
    parser.add_argument("--limit", type=int, default=20)
    return parser


def build_pull_log_parser():
    parser = argparse.ArgumentParser(prog="guthon_tool.py pull-log")
    parser.add_argument("action", choices=("tail", "summary", "export", "archive", "restore"))
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument('--cursor',default='')
    parser.add_argument('--generation',default='')
    parser.add_argument('--format',choices=['json','markdown'],default='json')
    parser.add_argument('--before',default='')
    parser.add_argument('--check',action='store_true')
    parser.add_argument('--confirmation',default='')
    parser.add_argument('--plan-hash',default='')
    parser.add_argument('--archive-id',default='')
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
        parser.add_argument("--write-context", action="store_true", help="save Markdown into this workspace context/ai")
    return parser


def build_source_map_parser():
    parser = argparse.ArgumentParser(prog="guthon_tool.py source-map")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--cursor", default="")
    parser.add_argument("--write", action="store_true", help="write the bounded Markdown map to workspace context/ai")
    return parser


def build_search_all_parser():
    parser = argparse.ArgumentParser(prog="guthon_tool.py search-all")
    parser.add_argument("--query", required=True)
    parser.add_argument("--workspace-key", action="append", default=[])
    parser.add_argument("--limit", type=int, default=20)
    return parser


def build_svn_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="guthon_tool.py svn")
    parser.add_argument("action", choices=list(SVN_ACTIONS))
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


COMMAND_PARSER_BUILDERS = {
    "import-svn-scope": build_import_svn_scope_parser,
    "workspace-resolve": build_workspace_resolve_parser,
    "database-target-resolve": lambda: build_database_parser("database-target-resolve"),
    "database-probe": lambda: build_database_parser("database-probe"),
    "database-describe": lambda: build_database_parser("database-describe"),
    "database-query-readonly": lambda: build_database_parser("database-query-readonly"),
    "source-mode": build_source_mode_parser,
    "index-doctor": build_index_doctor_parser,
    "pull-log": build_pull_log_parser,
    "source-map": build_source_map_parser,
    "search-all": build_search_all_parser,
    "search": lambda: build_search_parser("search"),
    "context-pack": lambda: build_search_parser("context-pack"),
    "svn": build_svn_parser,
}
COMMAND_PARSER_BUILDERS.update({command: (lambda name=command: build_database_parser(name)) for command in DATABASE_COMMANDS})
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
    parser.add_argument("--home", help="Directory that stores local config and private source data")
    parser.add_argument("--workspace", help="Logical workspace key: products.<id> or projects.<id>")
    parser.add_argument("--json", dest="json_output", action="store_true", help="emit a structured command result or error")
    parser.add_argument('--format', dest='output_format', choices=['json','text','table','csv','xlsx'],
                        help='统一输出格式；xlsx仅用于数据库查询且必须指定私有文件输出')
    return parser


def _svn_action_from(tokens: list[str]) -> str:
    """Return the svn action named in a help request, skipping --home/--workspace values."""

    skip_value = False
    for token in tokens:
        if skip_value:
            skip_value = False
            continue
        if token in {"--home", "--workspace"}:
            skip_value = True
        elif token != "--" and token in SVN_ACTION_SPECS:
            return token
    return ""


def _print_command_help(topic: str, rest: list[str]) -> int:
    topic=COMMAND_ALIASES.get(topic,topic)
    recommended=next((alias for alias,target in COMMAND_ALIASES.items() if target==topic),None)
    if recommended:
        descriptions={'sync-source':'按provider同步源码；SVN本地扫描，不执行远程update',
                      'sync-source-all':'DATABASE完整拉取；SVN完整本地扫描并重建',
                      'sync-all':'同步当前provider支持的工作区源码及相关资料',
                      'reindex':'从当前本地源码重建索引，不拉取远程源码',
                      'init':'初始化DATABASE索引结构；SVN初始化请用svn init'}
        print(f'推荐命令：{recommended}；兼容命令：{topic}。{descriptions[topic]}')
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
        if topic == "svn":
            action = _svn_action_from(rest)
            spec = SVN_ACTION_SPECS.get(action)
            if spec:
                options = spec.get("options", "")
                print(f"usage: {SVN_USAGE_PREFIX} {action}" + (f" {options}" if options else ""))
                print(f"  {spec['summary']}")
                if spec.get("stdin"):
                    print(f"  stdin：{spec['stdin']}")
                print("\nsvn 全部 action 的共用选项：\n")
        parser.print_help()
        return 0
    print(f"guthon_tool.py {topic} 没有命令级选项，仅接受 --home/--workspace。")
    if topic in STDIN_JSON_COMMANDS:
        print("输入从 stdin 读取 JSON。")
    print("用 `guthon_tool.py --help` 查看全部命令，用 `guthon_tool.py help <command>` 查看具体命令。")
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
    return _print_command_help(topic, raw[topic_index + 1:])


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


def setup_config(home: Path) -> list[Path]:
    from common.persistence import file_lock
    with file_lock(home / "config" / ".configuration.lock"):
        return _setup_config(home)


def _setup_config(home: Path) -> list[Path]:
    config_dir = home / "config"
    config_dir.mkdir(parents=True, exist_ok=True)
    created = []
    for filename in CONFIG_FILES:
        target = config_dir / filename
        if not target.exists():
            if filename in EMPTY_REGISTRY_FILES:
                target.write_text(EMPTY_REGISTRY_FILES[filename], encoding="utf-8")
            else:
                template_name = f"config/example/{filename.replace('.yaml', '.example.yaml')}"
                try:
                    target.write_bytes(bundled_bytes(template_name))
                except (OSError, KeyError, zipfile.BadZipFile) as error:
                    raise SystemExit(f"Missing bundled config template: {template_name}") from error
            created.append(target)
    return created


def _auto_add_operation_enabled(command: str, extra_args: list[str]) -> bool:
    if command in {"source-mode", "workspace-summary", "search", "context-pack", "database-target-configure"}:
        return False
    return not (command == "svn" and extra_args and extra_args[0] in SVN_BROWSE_ACTIONS)


def run(command: str, home: Path, extra_args: list[str], selected_workspace=None) -> int:
    command=COMMAND_ALIASES.get(command,command)
    os.environ["GUTHON_HOME"] = str(home)
    if command == "self-test":
        with tempfile.TemporaryDirectory() as temp:
            test_home = Path(temp) / "home"
            created = setup_config(test_home)
            os.environ["GUTHON_HOME"] = str(test_home)
            from common import gusen_hub
            from common.workspace_config import create_workspace

            configured = create_workspace(
                test_home,
                {
                    "kind": "product",
                    "id": "self-test",
                    "name": "Self Test",
                    "sourceMode": "svn",
                    "svnUsername": "self-test",
                },
                gusen_hub,
            )
            configured_database = create_workspace(
                test_home,
                {
                    "kind": "project",
                    "id": "self-test-db",
                    "name": "Self Test Database",
                    "sourceMode": "database",
                    "datasource": {
                        "id": "self-test-db-dev",
                        "type": "postgresql",
                        "host": "127.0.0.1",
                        "port": 5432,
                        "database": "self_test",
                        "username": "self_test",
                        "password": "",
                    },
                },
                gusen_hub,
            )
            assert len(created) == len(CONFIG_FILES)
            assert configured["workspace"]["workspaceKey"] == "products.self-test"
            assert configured["workspace"]["sourceMode"] == "svn"
            assert configured_database["workspace"]["workspaceKey"] == "projects.self-test-db"
            assert configured_database["workspace"]["sourceMode"] == "database"
            database_workspace = gusen_hub.resolve_workspace(
                gusen_hub.load_config(),
                "projects.self-test-db",
            )
            assert database_workspace["datasource"]["type"] == "postgresql"
            # 子命令帮助必须可达，否则 Agent 无法自省有界查询参数而退回全库检索。
            help_output = io.StringIO()
            with contextlib.redirect_stdout(help_output):
                assert _command_help(["svn", "facts"]) == 0
                assert _command_help(["query", "explain"]) == 0
            assert "--keyword" in help_output.getvalue()
            assert "explain" in help_output.getvalue()
        print("guthon_tool self-test: ok")
        return 0
    if command == "setup":
        created = setup_config(home)
        print(f"配置目录已准备：{home / 'config'}")
        print("已创建：" + ("、".join(path.name for path in created) or "无（保留现有配置）"))
        return 0
    if command == "import-svn-scope":
        if not selected_workspace:
            raise SystemExit("Missing --workspace. Use products.<id> or projects.<id>.")
        parsed = build_import_svn_scope_parser().parse_args(extra_args)
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

    if command == "workspace-create":
        if extra_args:
            raise SystemExit("workspace-create does not accept extra arguments")
        from common.workspace_config import create_workspace

        result = create_workspace(home, json.load(sys.stdin), gusen_hub)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    if command == "workspace-delete":
        if extra_args:
            raise SystemExit("workspace-delete does not accept extra arguments")
        from common.workspace_config import delete_workspace_config

        result = delete_workspace_config(home, json.load(sys.stdin), gusen_hub)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    if command == "svn-login-configure":
        if extra_args:
            raise SystemExit("svn-login-configure does not accept extra arguments")
        from common.workspace_config import configure_svn_username

        result = configure_svn_username(home, json.load(sys.stdin))
        print(json.dumps(result, ensure_ascii=False))
        return 0
    if command == "workspaces":
        config = gusen_hub.load_config()
        errors = []
        workspaces = gusen_hub.list_workspaces(config, errors=errors)
        print(json.dumps(
            {"ok": True, "workspaces": [gusen_hub.workspace_summary(config, item) for item in workspaces], "configErrors": errors},
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
        raise SystemExit("Missing --workspace. Use products.<id> or projects.<id>.")

    config = gusen_hub.load_config()
    workspace = None if command in GLOBAL_COMMANDS or command == "pull" and not selected_workspace else gusen_hub.resolve_workspace(config)
    if (command in DATABASE_COMMANDS or command == "doctor") and selected_workspace:
        workspace = gusen_hub.resolve_workspace(config, selected_workspace)
    checkpoint()
    restrict_to_index(command == 'reindex' and workspace is not None and workspace['sourceMode'] == 'svn')
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
        with gusen_hub.operation_generated_files() as generated_paths:
            result_code = _run_workspace_command(command, extra_args, gusen_hub, config, workspace)
        if result_code:
            raise RuntimeError(f"{command} failed with exit code {result_code}")
        if step:
            gusen_hub.update_workspace_state(config, workspace, step, "SUCCESS")
    except (Exception, SystemExit, OperationCancelled) as error:
        if workspace and step:
            status = 'CANCELLED' if isinstance(error, OperationCancelled) else "PARTIAL" if error_code(error) == "INDEX_PARTIAL" else "FAILED"
            gusen_hub.update_workspace_state(config, workspace, step, status, error)
        raise
    finally:
        os.environ.pop("GUTHON_DEFER_GIT_ADD", None)
    if (
        workspace
        and auto_add_operation
        and command not in {"init", "reindex", "export-markdown", "workcopy", "create-workcopy", "source-mode"}
    ):
        gusen_hub.auto_add_operation_files(config, before, workspace, generated_paths)
    return result_code


def _svn_progress(message: str) -> None:
    print(f"[SVN] {message}", file=sys.stderr, flush=True)


def _reindex_svn(gusen_hub, config, workspace, on_progress=None) -> dict:
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
            raise SystemExit(f"SVN scan failed; existing index preserved: {result['errors']}")
        raise gusen_hub.IndexPartialError(f"SVN scan PARTIAL; valid objects published, fix errors and reindex: {result['errors']}")
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
    connection = _connect_incremental_svn_index(
        gusen_hub,
        config,
        workspace,
        on_progress=on_progress,
    )
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
    if command == "workspace-resolve":
        parsed = build_workspace_resolve_parser().parse_args(extra_args)
        resolved = gusen_hub.resolve_workspace_for_path(config, parsed.path)
        print(json.dumps({"ok": True, **gusen_hub.workspace_agent_context(config, resolved)}, ensure_ascii=False))
        return 0
    if command in DATABASE_COMMANDS:
        from common import database_cli
        parsed = build_database_parser(command).parse_args(extra_args)
        return database_cli.run(command, parsed, gusen_hub, config, workspace)
    if command == "source-mode":
        parsed = build_source_mode_parser().parse_args(extra_args)
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
    if command == "search-all":
        from common import workspace_assistant
        parsed = build_search_all_parser().parse_args(extra_args)
        print(json.dumps(workspace_assistant.search_all_workspaces(config, parsed.query,
                       workspace_keys=parsed.workspace_key, limit=parsed.limit), ensure_ascii=False, indent=2))
        return 0
    if command == "parser-feedback":
        if extra_args:
            raise SystemExit("parser-feedback accepts only stdin JSON")
        from common.parser_feedback import save_feedback
        print(json.dumps(save_feedback(workspace, json.load(sys.stdin)), ensure_ascii=False, indent=2))
        return 0
    if command == "pull-log":
        from common import pull_history
        parsed = build_pull_log_parser().parse_args(extra_args)
        bridge_root=Path(gusen_hub.VAR_DIR) / 'nexus' / 'bridge'
        if parsed.action in {'tail','summary'}:
            result=pull_history.query_history(workspace,bridge_root,limit=parsed.limit,
                                             summary=parsed.action=='summary',cursor=parsed.cursor)
        elif parsed.action=='export':
            result=pull_history.export_history(workspace,bridge_root,format=parsed.format,generation=parsed.generation)
        elif parsed.action=='archive':
            if not parsed.before:raise SystemExit('pull-log archive requires --before YYYY-MM-DD')
            result=pull_history.archive_history(workspace,bridge_root,before=parsed.before,check=parsed.check,
                                               confirmation=parsed.confirmation,plan_hash=parsed.plan_hash)
        else:
            if not parsed.archive_id:raise SystemExit('pull-log restore requires --archive-id')
            result=pull_history.restore_history(workspace,archive_id=parsed.archive_id,check=parsed.check,
                                               confirmation=parsed.confirmation,plan_hash=parsed.plan_hash)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result['ok'] else 1
    if command == "source-map":
        from common import workspace_assistant
        parsed = build_source_map_parser().parse_args(extra_args)
        result = workspace_assistant.source_map(workspace, limit=parsed.limit, cursor=parsed.cursor)
        if parsed.write:
            from common.persistence import atomic_text
            path = workspace["contextDir"] / "ai" / "SOURCE_MAP.md"
            atomic_text(path, result["markdown"])
            result["artifactPath"] = str(path)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if command == "index-doctor":
        from providers.svn.nexus.source_queries import index_health
        parsed = build_index_doctor_parser().parse_args(extra_args)
        result = index_health(workspace, limit=parsed.limit) if workspace.get("sourceMode") == "svn" else gusen_hub.workspace_index_state(workspace)
        print(json.dumps({"ok": True, "workspaceKey": workspace["workspaceKey"], **result}, ensure_ascii=False, indent=2))
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
                parsed.detailed, include_source=parsed.include_source, max_chars=parsed.max_chars,
                source_namespace=parsed.source_namespace,
            )
        )
        if command == "context-pack" and parsed.write_context:
            from common.persistence import atomic_text
            filename = gusen_hub.path_part(parsed.source_id + ("." + parsed.fun_id if parsed.fun_id else "")) + ".md"
            target = workspace["contextDir"] / "ai" / filename
            atomic_text(target, result["markdown"])
            result["artifactPath"] = str(target.resolve())
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if command == "svn":
        from providers.svn import cli as svn_cli

        parsed = build_svn_parser().parse_args(extra_args)
        return svn_cli.run(
            parsed, extra_args, gusen_hub, config, workspace,
            on_progress=_svn_progress, reindex=_reindex_svn,
            reindex_files=_reindex_svn_files, reindex_refresh=_reindex_svn_refresh,
        )
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
        try:
            payload = json.load(sys.stdin)
        except json.JSONDecodeError as error:
            raise SystemExit("pull requires a JSON stdin payload") from error
        if not isinstance(payload, dict):
            raise SystemExit("pull stdin must be a JSON object")
        if workspace:
            payload["workspaceKey"] = workspace["workspaceKey"]
        result = gusen_hub.pull_source_to_work_copy(payload)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    if command == "export-markdown":
        if extra_args:
            raise SystemExit("export-markdown does not accept extra arguments")
        from common import export_hub_markdown

        export_hub_markdown.main([], workspace)
        return 0
    if command in SCRIPT_COMMANDS:
        module_name, function_name = SCRIPT_COMMANDS[command]
        module = importlib.import_module(module_name)
        delegated_args = extra_args
        if command == "doctor" and workspace:
            delegated_args = [*extra_args, "--workspace-key", workspace["workspaceKey"]]
        result = getattr(module, function_name)(delegated_args)
        if isinstance(result, dict):
            return 0 if result.get("ok", True) else 1
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


def _toolhost_request_kind(command: str, args: list[str]) -> str:
    spec = COMMAND_METADATA["svnActions"].get(args[0], {}) if command == "svn" and args else COMMAND_METADATA["commands"].get(command, {})
    if any(token == flag or token.startswith(flag + "=") for flag in spec.get("writeFlags", []) for token in args):
        return "write"
    if any(token in spec.get('writeArguments',[]) for token in args):return 'write'
    return spec.get("kind", "write")


def serve_stdio(home: Path) -> int:
    protocol_input = sys.stdin
    # Keep an independent descriptor: native command stdout is redirected to a
    # temporary file, while the protocol reader can still acknowledge cancel.
    import threading
    from common.toolhost_requests import ToolHostRequests
    protocol_output = os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8', buffering=1)
    protocol_lock = threading.Lock()
    def reply(frame):
        with protocol_lock:
            protocol_output.write(json.dumps(frame, ensure_ascii=False) + '\n')
            protocol_output.flush()
    os.environ["GUTHON_HOME"] = str(home)
    reply({
        "type": "ready", "protocolVersion": 1, "version": application_version(),
        "pid": os.getpid(), 'capabilities':['cancel-index-v1'],
    })
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
            if not isinstance(command, str) or command not in CLI_COMMANDS or command in {"serve", "mcp", "self-test"}:
                raise ValueError("unsupported command")
            if not isinstance(args, list) or any(not isinstance(arg, str) for arg in args):
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
                        sys.stdin = io.StringIO("" if payload is None else json.dumps(payload, ensure_ascii=False))
                        with contextlib.redirect_stdout(capture):
                            if command == "command-metadata":
                                print(json.dumps(COMMAND_METADATA, ensure_ascii=False))
                                code = 0
                            elif command == "version":
                                print(json.dumps({"version": application_version(), **application_build_info()}, ensure_ascii=False))
                                code = 0
                            else:
                                with request_control(control):
                                    checkpoint()
                                    code = run(command, home, args, workspace_key or None)
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
            response = {"id": request_id, "type": "result", "ok": True, "result": result}
        except (Exception, SystemExit, OperationCancelled) as error:
            response = {"id": request_id, "type": "result", "ok": False, "error": {
                "code": error_code(error, "INVALID_REQUEST" if isinstance(error, ValueError) else "COMMAND_FAILED"),
                "message": str(error),
            }}
        requests.finish(queued_id, control)
        reply(response)
    protocol_output.close()
    return 0


def main(argv=None) -> int:
    _configure_stdio_utf8()
    raw = list(sys.argv[1:] if argv is None else argv)
    if raw[:1] == ["help"]:
        return _command_help(raw[1:])
    help_code = _dispatch_help(raw)
    if help_code is not None:
        return help_code
    parser = _top_level_parser()
    args, extra_args = parser.parse_known_args(raw)
    if extra_args[:1] == ["--"]:
        extra_args = extra_args[1:]
    if args.json_output and args.output_format not in (None,'json'):
        parser.error('--json cannot be combined with a non-JSON --format')
    if args.command == "version":
        if args.home or args.workspace or extra_args:
            parser.error("version does not accept --home, --workspace, or extra arguments")
        value={"version": application_version(), **application_build_info()}
        if args.json_output or args.output_format:
            from common.cli_output import envelope,render
            if args.output_format=='xlsx':parser.error('version does not support XLSX')
            print(render(envelope(json.dumps(value),command='version'),args.output_format or 'json'),end='')
        else:print(json.dumps(value,ensure_ascii=False))
        return 0
    if args.command == "command-metadata":
        if args.workspace or extra_args:
            parser.error("command-metadata does not accept command-level arguments")
        if args.json_output or args.output_format:
            from common.cli_output import envelope,render
            if args.output_format=='xlsx':parser.error('command-metadata does not support XLSX')
            print(render(envelope(json.dumps(COMMAND_METADATA),command='command-metadata'),args.output_format or 'json'),end='')
        else:print(json.dumps(COMMAND_METADATA, ensure_ascii=False, indent=2))
        return 0
    if not args.home:
        args.home = os.environ.get("GUTHON_HOME") or os.environ.get("GUTHON_TOOL_HOME")
    if not args.home:
        parser.error("--home or GUTHON_HOME / GUTHON_TOOL_HOME is required")
    if args.command == "serve":
        if args.json_output or args.output_format:parser.error('serve uses its own stdio protocol; output formatting is unavailable')
        if args.workspace or extra_args != ["--stdio"]:
            parser.error("serve requires --stdio and does not accept --workspace or extra arguments")
        return serve_stdio(Path(args.home).expanduser().resolve())
    if args.command == "mcp":
        if args.json_output or args.output_format:parser.error('mcp uses its own protocol; output formatting is unavailable')
        if args.workspace or extra_args not in (
            ["--stdio"], ["--stdio", "--read-only"], ["--stdio", "--enable-page-write"]
        ):
            parser.error("mcp requires --stdio; optional --read-only disables local SVN source writes")
        home = Path(args.home).expanduser().resolve()
        os.environ["GUTHON_HOME"] = str(home)
        from providers.svn.nexus.mcp_server import serve_stdio as serve_mcp_stdio

        return serve_mcp_stdio(
            home, application_version(), enable_writes="--read-only" not in extra_args,
        )
    home = Path(args.home).expanduser().resolve()
    if args.output_format in {'csv','table','text','xlsx'} and args.command in {'database-query-readonly','database-diagnose','database-dbx-handoff'}:
        requested='table' if args.output_format=='text' else args.output_format
        extra_args=[*extra_args,'--format',requested]
        return run(args.command,home,extra_args,args.workspace)
    if args.output_format=='xlsx':parser.error('XLSX is only available for an executed database query with --output')
    if not args.json_output and not args.output_format:
        return run(args.command, home, extra_args, args.workspace)
    if args.command in {"doctor", "workcopy"}:
        extra_args = [*extra_args, "--json"]
    capture = io.StringIO()
    from common.cli_output import envelope, render
    try:
        with contextlib.redirect_stdout(capture):
            code = run(args.command, home, extra_args, args.workspace)
        result=envelope(capture.getvalue(),command=args.command,workspace_key=args.workspace,exit_code=code)
        print(render(result,args.output_format or 'json'),end='')
        return code
    except (Exception, SystemExit) as error:
        result=envelope(json.dumps({'ok':False,'error':{'code':error_code(error),'message':str(error)}}),command=args.command,workspace_key=args.workspace,exit_code=1)
        print(render(result,args.output_format or 'json'),end='')
        return 1



if __name__ == "__main__":
    raise SystemExit(main())

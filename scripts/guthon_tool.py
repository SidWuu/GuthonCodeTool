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
)
EMPTY_REGISTRY_FILES = {
    "datasource.yaml": "# 本地数据库连接由 Nexus 添加产品/项目时写入。\ndatasource: {}\n",
    "products.yaml": "# 本地产品工作区；可在 Nexus 中随时添加。\nproducts: {}\n",
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
    "read-batch",
    "status",
    "scm-status",
    "diff",
    "history",
    "definition",
    "callers",
    "find",
    "context",
    "facts",
    "explain",
    "scope-preview",
    "auth-cache",
    "delivery-status",
    "page-query",
}
TOOLHOST_READ_COMMANDS = {
    "version", "workspaces", "workspace-resolve", "workspace-summary", "route",
    "database-target-resolve", "database-probe", "database-describe",
    "database-query-readonly", "search", "context-pack", "query", "doctor",
}
CLI_COMMANDS = (
    "version", "serve", "mcp", "setup", "workspace-create", "workspace-delete",
    "svn-login-configure", "import-svn-scope", "workspaces", "workspace-resolve",
    "database-target-resolve", "database-target-configure", "database-probe",
    "database-describe", "database-query-readonly", "workspace-summary", "search",
    "context-pack", "source-mode", "route", "init", "svn", "sync-source-all",
    "sync-source", "reindex", "sync-all", "pull", "export-markdown",
    *SCRIPT_COMMANDS, "self-test",
)
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
DATABASE_ONLY_COMMANDS = {
    "export-schema": "database.schemaExport",
    "export-bill-type": "database.billTypeExport",
    "export-system-script": "database.systemScriptExport",
    "export-view": "database.viewExport",
    "diagnose": "database.diagnose",
}
# 每个 action 的 {说明, 专属参数用法, stdin 约定}；与 run() 分支保持一致，帮助输出与 action 列表都依赖本表。
SVN_ACTION_SPECS = {
    "init": {
        "summary": "检出或初始化 SVN working copy，并重建本地索引",
    },
    "auth-cache": {
        "summary": "把 SVN 密码写入系统凭据缓存（仅 manifest-working-copies）",
        "stdin": '{"password": "<密码>"}',
    },
    "scope-preview": {
        "summary": "预览当前授权范围与工作副本差异",
    },
    "scope-import": {
        "summary": "从签出脚本或范围配置导入授权范围",
        "stdin": '{"text": "<脚本或配置文本>"} 或 {"file": "<路径>", "source": "script|config"}',
    },
    "sync-from-script": {
        "summary": "按签出脚本检出/更新 working copy 并重建索引",
        "options": "[--accept-scope-change] [--merge-local]",
    },
    "sync-from-bat": {
        "summary": "sync-from-script 的兼容别名",
        "options": "[--accept-scope-change] [--merge-local]",
    },
    "sync-from-config": {
        "summary": "按可编辑范围配置检出/更新 working copy 并重建索引",
        "options": "[--accept-scope-change] [--merge-local]",
    },
    "refresh": {
        "summary": "更新本地 working copy，并按变更增量刷新索引",
        "options": "[--merge-local] [--working-copy <id>]... [--path <逻辑路径>] [--prune]",
    },
    "status": {
        "summary": "报告 working copy 状态",
        "options": "[--diff] [--remote]",
    },
    "catalog": {
        "summary": "列出索引内的数据源与对象目录",
    },
    "fragments": {
        "summary": "读取对象被索引的片段清单（不含源码正文）",
        "options": "--source-type <类型> --source-id <id> [--fun-id <fun>] [--working-copy <id>]",
    },
    "page-query": {
        "summary": "按 JSON stdin 调用只读 PAGE 有界查询工具",
        "stdin": '{"name": "list_page_nodes|read_page_nodes|search_sources|...", "arguments": {...}}',
    },
    "read": {
        "summary": "读取精确对象并开启编辑会话",
        "options": (
            "--source-type page|procedure|system-script|table|view|skill|public --source-id <id> "
            "[--fun-id <fun>] [--json-pointer <指针>] [--working-copy <id>]"
        ),
    },
    "read-batch": {
        "summary": "一次读取多个精确对象并开启编辑会话",
        "stdin": '{"targets": [{"sourceType": "...", "sourceId": "...", "funId": "", "jsonPointer": ""}]}',
    },
    "write": {
        "summary": "把编辑会话内容写回本地 working copy",
        "options": "--session <会话ID> --document <文档ID>",
        "stdin": '{"content": "<完整文本>", "expectedProductHash": ""}',
    },
    "write-batch": {
        "summary": "一次写回同一会话中的多处修改",
        "options": "[--session <会话ID>]",
        "stdin": '{"changes": [{"documentId": "...", "content": "..."}]}',
    },
    "scm-status": {
        "summary": "报告 SCM 变更集（含可选远端核对）",
        "options": "[--remote] [--working-copy <id>]...",
    },
    "diff": {
        "summary": "查看指定逻辑路径的 SVN 差异",
        "options": "--path <逻辑路径> [--remote]",
    },
    "conflict": {
        "summary": "查看指定逻辑路径的冲突详情",
        "options": "--path <逻辑路径>",
    },
    "resolve-conflict": {
        "summary": "标记解决冲突并重新索引该文件",
        "options": "--path <逻辑路径>",
    },
    "history": {
        "summary": "查看指定逻辑路径的 SVN 历史",
        "options": "--path <逻辑路径> [--limit <条数>]",
    },
    "revert-preview": {
        "summary": "预览撤销某编辑会话的本地改动",
        "options": "--session <会话ID> [--working-copy <id>]...",
    },
    "revert": {
        "summary": "按选择令牌撤销某编辑会话的本地改动",
        "options": "--session <会话ID> --selection-token <令牌> [--candidate <id>]...",
    },
    "platform-save-preview": {
        "summary": "预览平台保存前的本地差异范围",
        "options": "--session <会话ID> [--working-copy <id>]...",
    },
    "platform-save": {
        "summary": "记录平台保存结果并重新索引（不提交 SVN）",
        "options": "--session <会话ID> --selection-token <令牌> [--candidate <id>]...",
        "stdin": '{"message": "<说明>"}',
    },
    "delivery-status": {
        "summary": "报告本地保存与平台发布状态",
    },
    "definition": {
        "summary": "按别名与函数名定位对象定义",
        "options": "--alias <source_alias_id> --fun-id <fun_id>",
    },
    "callers": {
        "summary": "查询跨对象调用方（共享函数影响面）",
        "options": "--alias <source_alias_id> --fun-id <fun_id> [--limit <条数>]",
    },
    "find": {
        "summary": "对象名、别名或 ID 不明时定位候选（索引首选入口）",
        "options": "--keyword <对象名、别名或ID> [--limit <条数>]",
    },
    "context": {
        "summary": "查询一跳出入边上下文",
        "options": "--source-id <source_id> [--fun-id <fun>] [--limit <条数>]",
    },
    "facts": {
        "summary": "查询局部事实：错误、条件、赋值、字段关系（索引首选入口）",
        "options": "--keyword <词> | --table <表名> | --source-id <id>；[--limit <条数>] [--continuation <偏移>]",
    },
    "explain": {
        "summary": "查询表或单据的写入原因链（索引首选入口）",
        "options": (
            "--table <表名> | --bill-type <单据类型>；[--data-source-id <id>] "
            "[--operation WRITE|SELECT] [--limit <条数>] [--fact-limit <条数>] "
            "[--caller-depth <层数>] [--continuation <偏移>] [--include-details]"
        ),
    },
    "reindex-file": {
        "summary": "只重新索引指定逻辑路径",
        "options": "--path <逻辑路径>",
    },
}
SVN_ACTIONS = tuple(SVN_ACTION_SPECS)
# 这些命令不接受命令级选项，输入从 stdin 读取 JSON。
STDIN_JSON_COMMANDS = {
    "workspace-create",
    "workspace-delete",
    "svn-login-configure",
    "database-target-configure",
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
    epilog = (
        'stdin: {"sql": "<单条 SELECT>", "maxRows": 100}'
        if command == "database-query-readonly"
        else None
    )
    parser = argparse.ArgumentParser(prog=f"guthon_tool.py {command}", epilog=epilog)
    parser.add_argument("--path", default=str(Path.cwd()))
    parser.add_argument("--environment", choices=["dev", "test"], default="")
    parser.add_argument("--target-id", default="")
    if command == "database-describe":
        parser.add_argument("--table", required=True)
    return parser


def build_source_mode_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="guthon_tool.py source-mode")
    parser.add_argument("action", choices=["get", "set"])
    parser.add_argument("--mode", choices=["database", "svn"])
    return parser


def build_search_parser(command: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=f"guthon_tool.py {command}")
    parser.add_argument("--limit", type=int, default=20 if command == "search" else 5)
    if command == "search":
        parser.add_argument("--query", required=True)
    else:
        parser.add_argument("--source-id", required=True)
        parser.add_argument("--fun-id", default="")
        parser.add_argument("--detailed", action="store_true")
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
    parser.add_argument("--fun-id", default="")
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
    return parser


COMMAND_PARSER_BUILDERS = {
    "import-svn-scope": build_import_svn_scope_parser,
    "workspace-resolve": build_workspace_resolve_parser,
    "database-target-resolve": lambda: build_database_parser("database-target-resolve"),
    "database-probe": lambda: build_database_parser("database-probe"),
    "database-describe": lambda: build_database_parser("database-describe"),
    "database-query-readonly": lambda: build_database_parser("database-query-readonly"),
    "source-mode": build_source_mode_parser,
    "search": lambda: build_search_parser("search"),
    "context-pack": lambda: build_search_parser("context-pack"),
    "svn": build_svn_parser,
}
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
    if topic in HELP_DELEGATES:
        module_name, function_name = HELP_DELEGATES[topic]
        module = importlib.import_module(module_name)
        with contextlib.suppress(SystemExit):
            getattr(module, function_name)(["--help"])
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
    topic = next((token for token in raw if token in CLI_COMMANDS), None)
    if topic is None or topic in {"version", "serve", "mcp"}:
        return None
    return _print_command_help(topic, raw[raw.index(topic) + 1:])


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
        raise SystemExit("Missing --workspace. Use products.<id> or projects.<id>.")

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
        raise SystemExit(f"SVN scan failed; existing index preserved: {result['errors']}")
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
    if command in {"database-target-resolve", "database-probe", "database-describe", "database-query-readonly"}:
        from common import database_test_artifacts
        from common import database_readonly

        parsed = build_database_parser(command).parse_args(extra_args)
        resolved = gusen_hub.resolve_workspace_for_path(config, parsed.path)
        database_config_path = gusen_hub.CONFIG_DIR / "database-testing.yaml"
        try:
            database_config = database_test_artifacts.load_yaml(database_config_path)
            target, selection_source = database_test_artifacts.resolve_diagnosis_target(
                database_config,
                resolved["workspaceKey"],
                environment=parsed.environment,
                target_id=parsed.target_id,
            )
        except (database_test_artifacts.ArtifactError, OSError) as error:
            code = getattr(error, "code", "CONFIG_INVALID")
            raise SystemExit(f"{code}: {error}") from error
        identity = database_config["expectedIdentities"][target["expectedIdentityRef"]]
        summary = {
            "ok": True,
            "workspaceKey": resolved["workspaceKey"],
            "workspaceRoot": str(resolved["root"]),
            "selectionSource": selection_source,
            "connector": "builtin-readonly" if target.get("connectionRef") else "dbx",
            "targetDigest": database_test_artifacts.digest(target),
            "target": {
                key: target.get(key)
                for key in (
                    "id", "environment", "connectionId", "connectionRef", "validationScope", "database", "schema",
                    "systemId", "dataSourceId", "access", "allowedTables", "tenantScope",
                )
                if target.get(key) not in (None, "")
            },
            "expectedIdentity": {
                key: identity.get(key)
                for key in ("engine", "endpoint", "database", "schema")
                if identity.get(key) not in (None, "")
            },
        }
        if command == "database-target-resolve":
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            return 0
        try:
            connection = database_readonly.connection_for_target(database_config, target)
            if command == "database-probe":
                result = database_readonly.probe(connection, target)
            elif command == "database-describe":
                result = database_readonly.describe(connection, target, parsed.table)
            else:
                payload = json.load(sys.stdin)
                if not isinstance(payload, dict):
                    raise database_readonly.DatabaseReadonlyError("QUERY_INVALID", "查询输入必须是 JSON 对象")
                unknown = sorted(set(payload) - {"sql", "maxRows"})
                if unknown:
                    raise database_readonly.DatabaseReadonlyError("QUERY_INVALID", f"查询输入包含未知字段: {', '.join(unknown)}")
                result = database_readonly.query(
                    connection,
                    target,
                    str(payload.get("sql") or ""),
                    int(payload.get("maxRows", database_readonly.MAX_ROWS)),
                )
        except Exception as error:
            code = getattr(error, "code", "DATABASE_QUERY_FAILED")
            raise SystemExit(f"{code}: {error}") from error
        print(json.dumps({**summary, "result": result}, ensure_ascii=False, indent=2))
        return 0
    if command == "database-target-configure":
        from common import database_readonly
        from common import database_test_artifacts

        if extra_args:
            raise SystemExit("database-target-configure does not accept extra arguments")
        config_path = gusen_hub.CONFIG_DIR / "database-testing.yaml"
        credential_changed = False
        configuration_saved = False
        credential_ref = ""
        previous_password = None
        temporary_path = None
        try:
            payload = json.load(sys.stdin)
            if not isinstance(payload, dict):
                raise database_readonly.DatabaseReadonlyError("CONFIG_INVALID", "数据库配置输入必须是 JSON 对象")
            current = database_test_artifacts.load_yaml(config_path) if config_path.is_file() else {}
            updated, credential_ref = database_readonly.build_diagnosis_config(
                current, workspace["workspaceKey"], payload
            )
            password = str(payload.get("password") or "")
            keyring = database_readonly._keyring()
            previous_password = keyring.get_password(database_readonly.CREDENTIAL_SERVICE, credential_ref)
            database_readonly.set_password(credential_ref, password)
            credential_changed = True
            target, _ = database_test_artifacts.resolve_diagnosis_target(
                updated, workspace["workspaceKey"], target_id=str(payload["targetId"])
            )
            probe_result = database_readonly.probe(
                database_readonly.connection_for_target(updated, target), target
            )
            config_path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                "w", encoding="utf-8", dir=config_path.parent, prefix=".database-testing-", delete=False
            ) as handle:
                json.dump(updated, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                temporary_path = Path(handle.name)
            os.replace(temporary_path, config_path)
            configuration_saved = True
        except Exception as error:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
            if credential_changed and not configuration_saved:
                try:
                    if previous_password is None:
                        database_readonly.delete_password(credential_ref)
                    else:
                        database_readonly.set_password(credential_ref, previous_password)
                except database_readonly.DatabaseReadonlyError:
                    pass
            code = getattr(error, "code", "CONFIG_INVALID")
            raise SystemExit(f"{code}: {error}") from error
        print(json.dumps({
            "ok": True,
            "workspaceKey": workspace["workspaceKey"],
            "targetId": target["id"],
            "environment": target["environment"],
            "connector": "builtin-readonly",
            "probe": probe_result,
        }, ensure_ascii=False, indent=2))
        return 0
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
            )
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if command == "svn":
        from providers.svn import checkout

        parsed = build_svn_parser().parse_args(extra_args)
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
                "skipped": initialized_scope.get("skipped") or [],
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
                f"跳过 {len(result['skipped'])} 个 · "
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
                working_copy_id=parsed.working_copy[0] if len(parsed.working_copy) == 1 else "",
            )
        elif parsed.action == "page-query":
            if not manifest_layout:
                raise SystemExit("svn page-query requires manifest-working-copies")
            try:
                payload = json.load(sys.stdin)
            except json.JSONDecodeError as error:
                raise SystemExit("svn page-query requires a JSON stdin payload") from error
            if not isinstance(payload, dict) or not isinstance(payload.get("name"), str):
                raise SystemExit("svn page-query requires a tool name and arguments object")
            arguments = payload.get("arguments", {})
            if not isinstance(arguments, dict):
                raise SystemExit("svn page-query arguments must be an object")
            if arguments.get("workspaceKey", workspace["workspaceKey"]) != workspace["workspaceKey"]:
                raise SystemExit("svn page-query workspaceKey differs from the selected workspace")
            from providers.svn.nexus import page_nodes

            name = payload["name"]
            identity_keys = {"workspaceKey", "sourceNamespace", "sourceId", "funId"}
            allowed_by_name = {
                "get_index_status": {"workspaceKey"},
                "search_sources": {"workspaceKey", "keyword", "sourceType", "limit", "cursor"},
                "search_page_fields": {"workspaceKey", "sourceNamespace", "fieldIdPrefix", "limit", "cursor"},
                "list_page_nodes": identity_keys | {"nodeType", "eventScope", "limit", "cursor"},
                "read_page_nodes": identity_keys | {"targets", "maxChars"},
                "read_inherited_source": identity_keys | {"sourceType", "workingCopyId", "jsonPointer",
                                                          "indexedSourceHash", "offset", "maxChars"},
                "list_page_fields": identity_keys | {"regionType", "fieldId", "fieldIdPrefix", "limit", "cursor"},
                "get_page_field": identity_keys | {"target", "maxChars"},
                "list_page_field_relations": identity_keys | {"sourceFieldId", "targetFieldId", "limit", "cursor"},
                "check_page_field_references": identity_keys | {"semanticFieldId", "limit"},
                "get_source_context": identity_keys | {"limit"},
            }
            if name not in allowed_by_name:
                raise SystemExit("Unsupported svn page-query tool name")
            if unknown := set(arguments) - allowed_by_name[name]:
                raise SystemExit("Unknown svn page-query arguments: " + ", ".join(sorted(unknown)))
            namespace = arguments.get("sourceNamespace", "")
            source_id = arguments.get("sourceId", "")
            fun_id = arguments.get("funId", "")
            if name not in {"get_index_status", "search_sources", "search_page_fields"}:
                if any(not isinstance(value, str) or not value.strip() or len(value) > 512
                       for value in (namespace, source_id)) or not isinstance(fun_id, str):
                    raise SystemExit("svn page-query requires sourceNamespace and sourceId")
            try:
                if name == "get_index_status":
                    result = page_nodes.index_status(workspace)
                elif name == "search_sources":
                    result = page_nodes.search_sources(
                        workspace, keyword=arguments.get("keyword", ""),
                        source_type=arguments.get("sourceType", ""),
                        limit=arguments.get("limit", 20), cursor=arguments.get("cursor", ""),
                    )
                elif name == "search_page_fields":
                    result = page_nodes.search_page_fields(
                        workspace, source_namespace=namespace,
                        field_id_prefix=arguments.get("fieldIdPrefix", ""),
                        limit=arguments.get("limit", 50), cursor=arguments.get("cursor", ""),
                    )
                elif name == "list_page_nodes":
                    result = page_nodes.list_nodes(
                        workspace, source_namespace=namespace, source_id=source_id, fun_id=fun_id,
                        node_type=arguments.get("nodeType", ""), event_scope=arguments.get("eventScope", ""),
                        limit=arguments.get("limit", 50), cursor=arguments.get("cursor", ""),
                    )
                elif name == "read_page_nodes":
                    result = page_nodes.read_nodes(
                        workspace, source_namespace=namespace, source_id=source_id, fun_id=fun_id,
                        targets=arguments.get("targets"), max_chars=arguments.get("maxChars", 12_000),
                    )
                elif name == "read_inherited_source":
                    from providers.svn.nexus import inheritance_sources

                    result = inheritance_sources.read_inherited_source(
                        workspace, source_type=arguments.get("sourceType", ""),
                        source_namespace=namespace, source_id=source_id, fun_id=fun_id,
                        working_copy_id=arguments.get("workingCopyId", ""),
                        json_pointer_value=arguments.get("jsonPointer", ""),
                        indexed_source_hash=arguments.get("indexedSourceHash", ""),
                        offset=arguments.get("offset", 0), max_chars=arguments.get("maxChars", 12_000),
                    )
                elif name == "list_page_fields":
                    result = page_nodes.list_fields(
                        workspace, source_namespace=namespace, source_id=source_id, fun_id=fun_id,
                        region_type=arguments.get("regionType", ""), field_id=arguments.get("fieldId", ""),
                        field_id_prefix=arguments.get("fieldIdPrefix", ""),
                        limit=arguments.get("limit", 50), cursor=arguments.get("cursor", ""),
                    )
                elif name == "get_page_field":
                    result = page_nodes.get_field(
                        workspace, source_namespace=namespace, source_id=source_id, fun_id=fun_id,
                        target=arguments.get("target"), max_chars=arguments.get("maxChars", 12_000),
                    )
                elif name == "list_page_field_relations":
                    result = page_nodes.list_field_relations(
                        workspace, source_namespace=namespace, source_id=source_id, fun_id=fun_id,
                        source_field_id=arguments.get("sourceFieldId", ""),
                        target_field_id=arguments.get("targetFieldId", ""),
                        limit=arguments.get("limit", 50), cursor=arguments.get("cursor", ""),
                    )
                elif name == "check_page_field_references":
                    result = page_nodes.field_reference_diagnostics(
                        workspace, source_namespace=namespace, source_id=source_id, fun_id=fun_id,
                        semantic_field_id=arguments.get("semanticFieldId", ""),
                        limit=arguments.get("limit", 20),
                    )
                elif name == "get_source_context":
                    result = page_nodes.source_context(
                        workspace, source_namespace=namespace, source_id=source_id, fun_id=fun_id,
                        limit=arguments.get("limit", 10),
                    )
            except page_nodes.PageIndexError as error:
                raise SystemExit(f"{error.code}: {error}") from error
            result = {"ok": True, **result}
        elif parsed.action in {"read", "read-batch"}:
            if not manifest_layout:
                raise SystemExit(f"svn {parsed.action} requires manifest-working-copies")
            from providers.svn.nexus import documents

            if parsed.action == "read":
                if not parsed.source_type or not parsed.source_id:
                    raise SystemExit("svn read requires --source-type and --source-id")
                result = documents.read(
                    workspace,
                    source_type=parsed.source_type,
                    source_id=parsed.source_id,
                    fun_id=parsed.fun_id,
                    json_pointer=parsed.json_pointer,
                    working_copy_id=parsed.working_copy[0] if len(parsed.working_copy) == 1 else "",
                )
            else:
                try:
                    payload = json.load(sys.stdin)
                except json.JSONDecodeError as error:
                    raise SystemExit("svn read-batch requires a JSON stdin payload") from error
                targets = payload.get("targets") if isinstance(payload, dict) else None
                if not isinstance(targets, list) or not targets:
                    raise SystemExit("svn read-batch stdin must contain a non-empty targets array")
                if len(targets) > documents.MAX_BATCH_CHANGES:
                    raise SystemExit(
                        f"svn read-batch supports at most {documents.MAX_BATCH_CHANGES} targets"
                    )
                opened = []
                for index, target in enumerate(targets, 1):
                    if not isinstance(target, dict):
                        raise SystemExit(f"svn read-batch target {index} must be an object")
                    source_type = str(
                        target.get("sourceType") or target.get("source_type") or ""
                    ).strip().lower()
                    source_id = str(
                        target.get("sourceId") or target.get("source_id") or ""
                    ).strip()
                    if not source_type or not source_id:
                        raise SystemExit(
                            f"svn read-batch target {index} requires sourceType and sourceId"
                        )
                    opened.append(
                        documents.read(
                            workspace,
                            source_type=source_type,
                            source_id=source_id,
                            fun_id=str(
                                target.get("funId") or target.get("fun_id") or ""
                            ).strip(),
                            json_pointer=str(
                                target.get("jsonPointer") or target.get("json_pointer") or ""
                            ).strip(),
                            working_copy_id=str(
                                target.get("workingCopyId") or target.get("working_copy_id") or ""
                            ).strip(),
                        )
                    )
                result = {
                    "ok": True,
                    "workspaceKey": workspace["workspaceKey"],
                    "sessionId": next(
                        (item["sessionId"] for item in opened if item.get("sessionId")),
                        "",
                    ),
                    "documents": opened,
                }
        elif parsed.action in {"write", "write-batch"}:
            if not manifest_layout:
                raise SystemExit(f"svn {parsed.action} requires manifest-working-copies")
            try:
                payload = json.load(sys.stdin)
            except json.JSONDecodeError as error:
                raise SystemExit(f"svn {parsed.action} requires a JSON stdin payload") from error
            from providers.svn.nexus import documents

            if parsed.action == "write":
                if not isinstance(payload, dict) or not isinstance(payload.get("content"), str):
                    raise SystemExit("svn write stdin must contain a text content field")
                session_id = parsed.session or str(payload.get("sessionId") or "")
                document_id = parsed.document or str(payload.get("documentId") or "")
                if not session_id or not document_id:
                    raise SystemExit(
                        "svn write requires --session/--document or sessionId/documentId in stdin"
                    )
                result = documents.write(
                    workspace,
                    session_id=session_id,
                    document_id=document_id,
                    content=payload["content"],
                    expected_product_hash=str(payload.get("expectedProductHash") or ""),
                )
                source_paths = [result["sourcePath"]] if result.get("written") else []
            else:
                if not isinstance(payload, dict) or not isinstance(payload.get("changes"), list):
                    raise SystemExit("svn write-batch stdin must contain a changes array")
                changes = payload["changes"]
                if not changes:
                    raise SystemExit("svn write-batch changes must not be empty")
                if len(changes) > documents.MAX_BATCH_CHANGES:
                    raise SystemExit(
                        f"svn write-batch supports at most {documents.MAX_BATCH_CHANGES} changes"
                    )
                session_id = parsed.session or str(payload.get("sessionId") or "")
                resolved_changes = []
                auto_opened = 0
                for index, change in enumerate(changes, 1):
                    if not isinstance(change, dict):
                        raise SystemExit(f"svn write-batch change {index} must be an object")
                    document_id = str(change.get("documentId") or "")
                    if not document_id:
                        target = change.get("target") or change
                        if not isinstance(target, dict):
                            raise SystemExit(f"svn write-batch change {index} target must be an object")
                        source_type = str(
                            target.get("sourceType") or target.get("source_type") or ""
                        ).strip().lower()
                        source_id = str(
                            target.get("sourceId") or target.get("source_id") or ""
                        ).strip()
                        if not source_type or not source_id:
                            raise SystemExit(
                                f"svn write-batch change {index} requires documentId or "
                                "sourceType/sourceId"
                            )
                        opened = documents.read(
                            workspace,
                            source_type=source_type,
                            source_id=source_id,
                            fun_id=str(
                                target.get("funId") or target.get("fun_id") or ""
                            ).strip(),
                            json_pointer=str(
                                target.get("jsonPointer") or target.get("json_pointer") or ""
                            ).strip(),
                        )
                        if not opened.get("editable"):
                            raise SystemExit(
                                f"svn write-batch target is not editable: {opened['sourcePath']}"
                            )
                        document_id = opened["documentId"]
                        if session_id and session_id != opened["sessionId"]:
                            raise SystemExit("svn write-batch changes resolved to different sessions")
                        session_id = opened["sessionId"]
                        auto_opened += 1
                    resolved_changes.append({**change, "documentId": document_id})
                if not session_id:
                    raise SystemExit(
                        "svn write-batch requires --session/sessionId when changes use documentId"
                    )
                result = documents.write_batch(
                    workspace,
                    session_id=session_id,
                    changes=resolved_changes,
                )
                result["autoOpened"] = auto_opened
                source_paths = result["sourcePaths"]
            _svn_progress(
                f"{workspace['displayName']}｜源码写入｜已写回 {len(source_paths)} 个本地 SVN 文件"
            )
            if source_paths:
                result["reindex"] = _reindex_svn_files(
                    gusen_hub,
                    config,
                    workspace,
                    source_paths,
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
        elif parsed.action in {"find", "context"}:
            if not manifest_layout:
                raise SystemExit(f"svn {parsed.action} requires manifest-working-copies")
            from providers.svn.nexus import index_queries

            if parsed.action == "find":
                if not parsed.keyword:
                    raise SystemExit("svn find requires --keyword")
                result = index_queries.find(workspace, keyword=parsed.keyword, limit=parsed.limit)
            else:
                if not parsed.source_id:
                    raise SystemExit("svn context requires --source-id")
                result = index_queries.context(
                    workspace,
                    source_id=parsed.source_id,
                    fun_id=parsed.fun_id,
                    limit=parsed.limit,
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
                result = scm.status(
                    workspace,
                    remote=parsed.remote,
                    working_copy_ids=set(parsed.working_copy) or None,
                    on_progress=_svn_progress,
                )
            elif parsed.action == "diff":
                if not parsed.path:
                    raise SystemExit("svn diff requires --path")
                result = scm.diff(workspace, logical_path=parsed.path, remote=parsed.remote)
            elif parsed.action == "conflict":
                if not parsed.path:
                    raise SystemExit("svn conflict requires --path")
                result = scm.conflict_details(workspace, logical_path=parsed.path)
            elif parsed.action == "resolve-conflict":
                if not parsed.path:
                    raise SystemExit("svn resolve-conflict requires --path")
                result = scm.resolve_conflict(workspace, logical_path=parsed.path)
                result["reindex"] = _reindex_svn_files(
                    gusen_hub,
                    config,
                    workspace,
                    result["files"],
                    on_progress=_svn_progress,
                )
            elif parsed.action == "history":
                if not parsed.path:
                    raise SystemExit("svn history requires --path")
                result = scm.history(workspace, logical_path=parsed.path, limit=parsed.limit)
            elif parsed.action == "delivery-status":
                result = scm.delivery_status(workspace)
            elif parsed.action in {"revert-preview", "platform-save-preview"}:
                if not parsed.session:
                    raise SystemExit(f"svn {parsed.action} requires --session")
                action = "revert" if parsed.action == "revert-preview" else "platform-save"
                result = scm.preview(
                    workspace,
                    action=action,
                    session_id=parsed.session,
                    working_copy_ids=set(parsed.working_copy) or None,
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


def _toolhost_request_kind(command: str, args: list[str]) -> str:
    if command in TOOLHOST_READ_COMMANDS:
        return "read"
    if command == "svn" and args and args[0] in SVN_BROWSE_ACTIONS - {"auth-cache"}:
        return "read"
    return "write"


def serve_stdio(home: Path) -> int:
    protocol_input = sys.stdin
    protocol_output = sys.stdout
    os.environ["GUTHON_HOME"] = str(home)
    protocol_output.write(json.dumps({
        "type": "ready", "protocolVersion": 1, "version": application_version(),
        "pid": os.getpid(),
    }, ensure_ascii=False) + "\n")
    protocol_output.flush()
    for line in protocol_input:
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
            saved_stdout_fd = os.dup(1)
            try:
                with tempfile.TemporaryFile() as native_stdout:
                    os.dup2(native_stdout.fileno(), 1)
                    try:
                        sys.stdin = io.StringIO("" if payload is None else json.dumps(payload, ensure_ascii=False))
                        with contextlib.redirect_stdout(capture):
                            if command == "version":
                                print(json.dumps({"version": application_version()}, ensure_ascii=False))
                                code = 0
                            else:
                                code = run(command, home, args, workspace_key or None)
                    finally:
                        os.dup2(saved_stdout_fd, 1)
                    native_stdout.seek(0)
                    native_text = native_stdout.read().decode("utf-8", errors="replace")
            finally:
                sys.stdin = old_input
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
        except (Exception, SystemExit) as error:
            response = {"id": request_id, "type": "result", "ok": False, "error": {
                "code": "INVALID_REQUEST" if isinstance(error, ValueError) else "COMMAND_FAILED",
                "message": str(error),
            }}
        protocol_output.write(json.dumps(response, ensure_ascii=False) + "\n")
        protocol_output.flush()
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
    if args.command == "version":
        if args.home or args.workspace or extra_args:
            parser.error("version does not accept --home, --workspace, or extra arguments")
        print(json.dumps({"version": application_version()}, ensure_ascii=False))
        return 0
    if not args.home:
        parser.error("--home is required")
    if args.command == "serve":
        if args.workspace or extra_args != ["--stdio"]:
            parser.error("serve requires --stdio and does not accept --workspace or extra arguments")
        return serve_stdio(Path(args.home).expanduser().resolve())
    if args.command == "mcp":
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
    return run(args.command, Path(args.home).expanduser().resolve(), extra_args, args.workspace)


if __name__ == "__main__":
    raise SystemExit(main())

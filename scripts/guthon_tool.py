#!/usr/bin/env python3
"""Portable command entry point for GuthonCodeTool."""

from __future__ import annotations

import argparse
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
    "doctor": ("doctor", "main"),
    "export-schema": ("export_table_schema_sql", "main"),
    "export-bill-type": ("export_bill_type_sql", "main"),
    "export-view": ("export_view_sql", "main"),
    "export-system-script": ("export_system_script_sql", "main"),
    "query": ("query_hub_context", "main"),
    "diagnose": ("run_source_diagnosis", "main"),
    "create-workcopy": ("gusen_hub", "create_work_copy"),
    "workcopy": ("gusen_hub", "work_copy_cli"),
}
COMMAND_STEPS = {
    "sync-source": "source",
    "export-schema": "schema",
    "export-bill-type": "billType",
    "export-system-script": "systemScripts",
    "export-view": "views",
}
GLOBAL_COMMANDS = {"setup", "doctor", "route", "workspaces", "self-test"}


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

    import gusen_hub

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
    before = gusen_hub.untracked_files() if workspace else set()
    os.environ["GUTHON_DEFER_GIT_ADD"] = "1"
    step = COMMAND_STEPS.get(command)
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
    if workspace and command not in {"init", "reindex", "export-markdown", "workcopy", "create-workcopy"}:
        gusen_hub.auto_add_operation_files(config, before, workspace)
    return result_code


def _run_workspace_command(command, extra_args, gusen_hub, config, workspace):
    if command == "init":
        gusen_hub.ensure_workspace_structure(workspace)
        gusen_hub.run_sync_once(["--init-only"])
        gusen_hub.update_workspace_state(config, workspace, "source", "INITIALIZED")
        print("本地源码索引初始化完成")
        return 0
    if command == "sync-source":
        gusen_hub.run_sync_once([])
        print(f"工作区源码同步完成：{workspace['workspaceKey']}")
        return 0
    if command == "reindex":
        gusen_hub.run_sync_once(["--reindex-calls"])
        print("本地调用索引重建完成")
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
        import export_hub_markdown

        export_hub_markdown.main()
        return 0
    if command in SCRIPT_COMMANDS:
        module_name, function_name = SCRIPT_COMMANDS[command]
        module = __import__(module_name)
        result = getattr(module, function_name)(extra_args)
        return int(result or 0)
    if command == "sync-all":
        import export_bill_type_sql
        import export_system_script_sql
        import export_table_schema_sql
        import export_view_sql

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
        choices=("setup", "workspaces", "route", "init", "sync-source", "reindex", "sync-all", "pull", "export-markdown", *SCRIPT_COMMANDS, "self-test"),
    )
    parser.add_argument("--home", required=True, help="Directory that stores local config and private source data")
    parser.add_argument("--workspace", help="Logical workspace key: products.<id> or projects.<id>")
    args, extra_args = parser.parse_known_args(argv)
    if extra_args[:1] == ["--"]:
        extra_args = extra_args[1:]
    return run(args.command, Path(args.home).expanduser().resolve(), extra_args, args.workspace)


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Build the standalone GuthonCodeTool executable with PyInstaller."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from importlib.util import find_spec
from pathlib import Path

from common.build_info import source_build_info


ROOT = Path(__file__).resolve().parents[1]
SEP = ";" if sys.platform == "win32" else ":"
HIDDEN_IMPORTS = (
    "providers.api.cli",
    "providers.api.mcp_server",
    "providers.api.sync",
    "providers.api.exports",
    "common.database_exports.export_bill_type_sql",
    "common.source_diagnosis",
    "common.database_test_artifacts",
    "common.database_plan_runner",
    "common.query_xlsx",
    "common.database_readonly",
    "common.database_cli",
    "common.build_info",
    "common.workspace_registry",
    "common.workspace_identity",
    "common.credential_vault",
    "common.database_dbx",
    "common.database_operations",
    "common.parser_feedback",
    "common.pull_history",
    "common.operation_control",
    "common.toolhost_requests",
    "common.source_text_search",
    "common.page_field_search",
    "common.command_errors",
    "common.cli_output",
    "common.database_sql",
    "common.identity_search",
    "common.persistence",
    "common.runtime_paths",
    "common.doctor",
    "common.export_hub_markdown",
    "common.gusen_hub",
    "common.inheritance",
    "common.page_projection",
    "common.page_editor",
    "common.page_design",
    "common.page_structure",
    "common.page_layout",
    "common.query_hub_context",
    "common.source_facts",
    "common.index_bulk",
    "common.index_maintenance",
    "common.source_format",
    "common.workspace_config",
    "common.workspace_assistant",
    "pymysql",
    "oracledb",
    "psycopg",
    "psycopg.pq",
    "keyring",
    "keyring.backends.macOS",
    "keyring.backends.Windows",
)


def packaging_arguments(platform: str = sys.platform) -> list[str]:
    """Return the PyInstaller layout for the platform.

    macOS uses ``--onedir``: a onefile build unpacks the runtime into a new
    temporary directory on every start, which costs seconds per cold start.
    Windows keeps the single-file ``.exe`` its install steps expect.
    """

    return ["--onedir"] if platform == "darwin" else ["--onefile"]


def main() -> int:
    if find_spec("PyInstaller") is None:
        print("PyInstaller 未安装。请在构建机执行：python -m pip install pyinstaller", file=sys.stderr)
        return 2
    build_root = Path(os.environ.get("GUTHON_BUILD_OUTPUT_ROOT") or ROOT).expanduser().resolve()
    dist_path = build_root / "dist"
    work_path = build_root / "build"
    build_root.mkdir(parents=True, exist_ok=True)
    build_info_path = build_root / "BUILD_INFO.json"
    build_info_path.write_text(json.dumps(source_build_info(ROOT)),encoding="utf-8")
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        *packaging_arguments(),
        "--name",
        "GuthonCodeTool",
        "--specpath",
        str(build_root),
        "--paths",
        str(ROOT / "scripts"),
        "--add-data",
        f"{ROOT / 'config' / 'example'}{SEP}config/example",
        "--add-data",
        f"{ROOT / 'VERSION'}{SEP}.",
        "--add-data",
        f"{ROOT / 'scripts' / 'common' / 'command_metadata.json'}{SEP}common",
        "--add-data",
        f"{build_info_path}{SEP}.",
        "--add-data",
        f"{ROOT / 'scripts' / 'vault_crypto.mjs'}{SEP}scripts",
        "--add-data",
        f"{ROOT / 'plugins/GuthonNexus/gushen-vscode-completion/data/index.json'}{SEP}plugins/GuthonNexus/gushen-vscode-completion/data",
        "--add-data",
        f"{ROOT / 'plugins/GuthonNexus/gushen-vscode-completion/data/manual.json'}{SEP}plugins/GuthonNexus/gushen-vscode-completion/data",
        "--add-data",
        f"{ROOT / 'plugins/GuthonNexus/gushen-vscode-completion/data/official-api.json'}{SEP}plugins/GuthonNexus/gushen-vscode-completion/data",
        "--add-data",
        f"{ROOT / 'plugins/GuthonNexus/gushen-vscode-completion/resources/official-language-support'}{SEP}plugins/GuthonNexus/gushen-vscode-completion/resources/official-language-support",
        "--distpath",
        str(dist_path),
        "--workpath",
        str(work_path),
        str(ROOT / "scripts" / "guthon_tool.py"),
    ]
    command[-1:-1] = [value for module in HIDDEN_IMPORTS for value in ("--hidden-import", module)]
    try:
        env = {**os.environ, "PYINSTALLER_CONFIG_DIR": str(work_path / ".pyinstaller")}
        subprocess.run(command, cwd=ROOT, env=env, check=True)
    except subprocess.CalledProcessError as error:
        return error.returncode or 1
    print(f"Build output: {dist_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

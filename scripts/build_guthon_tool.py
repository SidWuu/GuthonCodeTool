#!/usr/bin/env python3
"""Build the standalone GuthonCodeTool executable with PyInstaller."""

from __future__ import annotations

import os
import subprocess
import sys
from importlib.util import find_spec
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SEP = ";" if sys.platform == "win32" else ":"
HIDDEN_IMPORTS = (
    "common.database_test_artifacts",
    "common.database_plan_runner",
    "common.query_xlsx",
    "common.database_readonly",
    "common.database_cli",
    "common.build_info",
    "common.workspace_registry",
    "common.workcopy_store",
    "common.workspace_identity",
    "common.credential_vault",
    "common.database_dbx",
    "common.database_operations",
    "common.parser_feedback",
    "common.pull_history",
    "common.operation_control",
    "common.toolhost_requests",
    "common.source_changes",
    "common.source_text_search",
    "common.page_field_search",
    "common.command_errors",
    "common.cli_output",
    "common.database_sql",
    "common.identity_search",
    "common.persistence",
    "common.runtime_paths",
    "common.source_store",
    "common.doctor",
    "common.export_hub_markdown",
    "common.gusen_hub",
    "common.inheritance",
    "common.page_projection",
    "common.query_hub_context",
    "common.source_facts",
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
    "providers.database._export_common",
    "providers.database.export_bill_type_sql",
    "providers.database.export_system_script_sql",
    "providers.database.export_table_schema_sql",
    "providers.database.export_view_sql",
    "providers.database.run_source_diagnosis",
    "providers.svn.checkout",
    "providers.svn.cli",
    "providers.svn.scope_import",
    "providers.svn.nexus.catalog",
    "providers.svn.nexus.bootstrap",
    "providers.svn.nexus.documents",
    "providers.svn.nexus.index_queries",
    "providers.svn.nexus.inheritance_sources",
    "providers.svn.nexus.manifest",
    "providers.svn.nexus.mcp_server",
    "providers.svn.nexus.page_mutation",
    "providers.svn.nexus.page_field_mutation",
    "providers.svn.nexus.page_nodes",
    "providers.svn.nexus.procedure_mutation",
    "providers.svn.nexus.procedure_sources",
    "providers.svn.nexus.source_queries",
    "providers.svn.nexus.edit_leases",
    "providers.svn.nexus.edit_sessions",
    "providers.svn.nexus.operation_maintenance",
    "providers.svn.nexus.operation_records",
    "providers.svn.nexus.scm",
    "providers.svn.nexus.workspace",
    "providers.svn.projection",
    "providers.svn.scanner",
    "providers.svn.writeback",
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

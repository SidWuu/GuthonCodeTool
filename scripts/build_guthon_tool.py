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
    "common.doctor",
    "common.export_hub_markdown",
    "common.gusen_hub",
    "common.page_projection",
    "common.query_hub_context",
    "common.source_format",
    "common.workspace_config",
    "pymysql",
    "providers.database.export_bill_type_sql",
    "providers.database.export_system_script_sql",
    "providers.database.export_table_schema_sql",
    "providers.database.export_view_sql",
    "providers.database.run_source_diagnosis",
    "providers.svn.checkout",
    "providers.svn.scope_import",
    "providers.svn.nexus.catalog",
    "providers.svn.nexus.bootstrap",
    "providers.svn.nexus.documents",
    "providers.svn.nexus.index_queries",
    "providers.svn.nexus.manifest",
    "providers.svn.nexus.scm",
    "providers.svn.nexus.workspace",
    "providers.svn.projection",
    "providers.svn.scanner",
    "providers.svn.writeback",
)


def main() -> int:
    if find_spec("PyInstaller") is None:
        print("PyInstaller 未安装。请在构建机执行：python -m pip install pyinstaller", file=sys.stderr)
        return 2
    build_root = Path(os.environ.get("GUTHON_BUILD_OUTPUT_ROOT") or ROOT).expanduser().resolve()
    dist_path = build_root / "dist"
    work_path = build_root / "build"
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--name",
        "GuthonCodeTool",
        "--specpath",
        str(build_root),
        "--paths",
        str(ROOT / "scripts"),
        "--add-data",
        f"{ROOT / 'config' / 'example'}{SEP}config/example",
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

#!/usr/bin/env python3
"""Build the standalone GuthonCodeTool executable with PyInstaller."""

from __future__ import annotations

import subprocess
import sys
import os
from importlib.util import find_spec
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SEP = ";" if sys.platform == "win32" else ":"
HIDDEN_IMPORTS = (
    "pymysql",
    "doctor",
    "export_bill_type_sql",
    "export_hub_markdown",
    "export_system_script_sql",
    "export_table_schema_sql",
    "export_view_sql",
    "query_hub_context",
    "run_source_diagnosis",
)


def main() -> int:
    if find_spec("PyInstaller") is None:
        print("PyInstaller 未安装。请在构建机执行：python -m pip install pyinstaller", file=sys.stderr)
        return 2
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--name",
        "GuthonCodeTool",
        "--paths",
        str(ROOT / "scripts"),
        "--add-data",
        f"{ROOT / 'config' / 'example'}{SEP}config/example",
        "--distpath",
        str(ROOT / "dist"),
        "--workpath",
        str(ROOT / "build"),
        str(ROOT / "scripts" / "guthon_tool.py"),
    ]
    command[-1:-1] = [value for module in HIDDEN_IMPORTS for value in ("--hidden-import", module)]
    try:
        env = {**os.environ, "PYINSTALLER_CONFIG_DIR": str(ROOT / "build" / ".pyinstaller")}
        subprocess.run(command, cwd=ROOT, env=env, check=True)
    except subprocess.CalledProcessError as error:
        return error.returncode or 1
    print(f"Build output: {ROOT / 'dist'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

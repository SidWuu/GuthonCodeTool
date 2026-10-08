#!/usr/bin/env python3
"""Build the current Windows backend, Nexus and Bridge for a suite candidate."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile

from installer.engine import digest, write_json

ROOT = Path(__file__).resolve().parents[1]


def archive_directory(source, destination, prefix):
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for item in sorted(source.rglob("*")):
            if item.is_symlink():
                raise ValueError("组件载荷不允许符号链接")
            if item.is_file() and item.name != ".DS_Store" and not item.name.endswith(".test.js"):
                archive.write(item, prefix + "/" + item.relative_to(source).as_posix())


def write_manifest(output):
    names = ["GuthonCodeTool-windows-x64.exe", "guthon-nexus-vscode.vsix", "GuthonCodeTool-chrome.zip", "guthon-testing.zip"]
    version = json.loads(subprocess.check_output([str(output / names[0]), "version"], encoding="utf-8"))
    write_json(output / "installer-components.json", {
        "schemaVersion": 1, "version": version["version"], "buildId": version["buildId"],
        "files": {name: digest(output / name) for name in names},
    })


def build(output):
    if os.name != "nt":
        raise SystemExit("请在 Windows runner 构建 Windows 组件")
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="guthon-components-") as temporary:
        temp = Path(temporary)
        env = {**os.environ, "GUTHON_BUILD_OUTPUT_ROOT": str(temp / "backend")}
        subprocess.run([sys.executable, str(ROOT / "scripts/build_guthon_tool.py")], env=env, check=True)
        tool = temp / "backend/dist/GuthonCodeTool.exe"
        subprocess.run([str(tool), "self-test", "--home", str(temp / "self-test")], check=True)
        subprocess.run([sys.executable, str(ROOT / "scripts/check_toolhost.py"), str(tool)], check=True)
        subprocess.run([sys.executable, str(ROOT / "scripts/check_release_smoke.py"), "--entry", str(tool)], check=True)
        version = json.loads(subprocess.check_output([str(tool), "version"], encoding="utf-8"))
        shutil.copy2(tool, output / "GuthonCodeTool-windows-x64.exe")
        nexus = ROOT / "plugins/GuthonNexus/gushen-vscode-completion"
        npm = shutil.which("npm.cmd")
        npx = shutil.which("npx.cmd")
        if not npm or not npx:
            raise SystemExit("需要 Node.js 和 npm")
        # Fixed command text only; user inputs never enter these CMD invocations.
        for command in ("npm test", "npm run check", "npm run build:bridge"):
            subprocess.run(command, cwd=nexus, shell=True, check=True)
        # vsce accepts absolute output paths; use Node directly instead of interpolating CMD arguments.
        subprocess.run("npm install --no-save --package-lock=false @vscode/vsce@3.9.2", cwd=temp, shell=True, check=True)
        vsce = temp / "node_modules/@vscode/vsce/vsce"
        subprocess.run(["node", str(vsce), "package", "--allow-missing-repository", "--skip-license", "--out", str(output / "guthon-nexus-vscode.vsix")], cwd=nexus, check=True)
        bridge = ROOT / "plugins/GuthonBridge"
        subprocess.run("npm test", cwd=bridge, shell=True, check=True)
        archive_directory(bridge / "extension", output / "GuthonCodeTool-chrome.zip", "extension")
        archive_directory(ROOT / "skills/guthon-testing", output / "guthon-testing.zip", "guthon-testing")
        write_manifest(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--manifest-only", action="store_true", help="使用同一 CI 作业链已构建的四个组件生成清单")
    args = parser.parse_args()
    if args.manifest_only:
        write_manifest(args.output.resolve())
    else:
        build(args.output.resolve())

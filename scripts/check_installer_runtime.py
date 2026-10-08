#!/usr/bin/env python3
"""Smoke-check a staged suite's isolated Python and setup entry without user data."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from installer.engine import verify_payload


def check(payload):
    manifest = verify_payload(payload)
    python = payload / "runtime/python.exe"
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}

    def execute(args, data=None):
        subprocess.run([str(python), "-X", "utf8", "-B", *[str(a) for a in args]], input=data,
                       capture_output=True, encoding="utf-8", env=env, check=True, timeout=60)

    execute(["-c", "import sys,struct; assert sys.version_info >= (3,12); assert struct.calcsize('P') == 8"])
    execute([payload / "installer/engine.py", "--help"])
    execute(["-c", "print('中文路径与输出校验')"])
    with tempfile.TemporaryDirectory(prefix="guthon-runtime-check-") as directory:
        workspace = Path(directory) / "中文临时工作区"
        subprocess.run([str(payload / 'tool/GuthonCodeTool.exe'), 'setup', '--home', str(workspace)], check=True, capture_output=True)
    verify_payload(payload)
    print(json.dumps({"ok": True, "bundleId": manifest["bundleId"], "checks": "isolated-python,engine,tool-setup,utf8"}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload", required=True, type=Path)
    check(parser.parse_args().payload.resolve())

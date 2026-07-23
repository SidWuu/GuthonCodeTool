#!/usr/bin/env python3
"""Read-only GuthonCodeTool environment checks."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import urllib.error
import urllib.request
from pathlib import Path

import gusen_hub


ROOT = Path(__file__).resolve().parents[1]
CONFIG_FILES = (
    "datasource.yaml",
    "products.yaml",
    "projects.yaml",
    "source-tables.yaml",
    "sync.yaml",
)
EXTENSION_DATA = ROOT / "plugins" / "GuthonVSCodeExtension" / "gushen-vscode-completion" / "data"


def result(name, status, message):
    return {"name": name, "status": status, "message": message}


def run_checks(bridge_port=17361):
    checks = []
    checks.append(
        result(
            "python",
            "PASS" if sys.version_info >= (3, 10) else "FAIL",
            sys.version.split()[0],
        )
    )

    node = shutil.which("node")
    checks.append(result("node", "PASS" if node else "FAIL", node or "not found"))

    missing = [name for name in CONFIG_FILES if not (ROOT / "config" / name).is_file()]
    if missing:
        checks.append(result("config", "FAIL", f"missing: {', '.join(missing)}"))
    else:
        try:
            config = gusen_hub.load_config()
            active, _products, _projects = gusen_hub.resolve_active(config)
            checks.append(result("config", "PASS", f"ACTIVE={active}"))
        except (Exception, SystemExit) as error:
            checks.append(result("config", "FAIL", str(error)))

    try:
        index = json.loads((EXTENSION_DATA / "index.json").read_text(encoding="utf-8"))
        manual = json.loads((EXTENSION_DATA / "manual.json").read_text(encoding="utf-8"))
        counts = ", ".join(f"{language}={len(index.get(language, []))}" for language in ("java", "javascript", "sql"))
        checks.append(result("vscode-data", "PASS", f"{counts}, manual={sum(map(len, manual.values()))}"))
    except (OSError, ValueError, TypeError) as error:
        checks.append(result("vscode-data", "FAIL", str(error)))

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{bridge_port}/health", timeout=0.5) as response:
            payload = json.load(response)
        status = "PASS" if response.status == 200 and payload.get("ok") else "FAIL"
        checks.append(result("bridge", status, f"127.0.0.1:{bridge_port}"))
    except (OSError, ValueError, urllib.error.URLError) as error:
        checks.append(result("bridge", "WARN", f"not running on 127.0.0.1:{bridge_port}: {error}"))

    return checks


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge-port", type=int, default=17361)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    if args.self_test:
        assert result("x", "PASS", "ok") == {"name": "x", "status": "PASS", "message": "ok"}
        print("doctor self-test: ok")
        return 0

    checks = run_checks(args.bridge_port)
    if args.json:
        print(json.dumps(checks, ensure_ascii=False, indent=2))
    else:
        for check in checks:
            print(f"[{check['status']}] {check['name']}: {check['message']}")
    return 1 if any(check["status"] == "FAIL" for check in checks) else 0


if __name__ == "__main__":
    raise SystemExit(main())

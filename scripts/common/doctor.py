#!/usr/bin/env python3
"""Read-only GuthonCodeTool environment checks."""

from __future__ import annotations

import argparse
import importlib
import json
import sys
import hashlib
import uuid
import zipfile
from pathlib import Path
import urllib.error
import urllib.request

from common import gusen_hub


ROOT = gusen_hub.ROOT
CONFIG_FILES = (
    "datasource.yaml",
    "products.yaml",
    "projects.yaml",
    "source-tables.yaml",
    "sync.yaml",
)
EXTENSION_DATA = "plugins/GuthonNexus/gushen-vscode-completion/data"


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

    missing = [name for name in CONFIG_FILES if not (ROOT / "config" / name).is_file()]
    if missing:
        checks.append(result("config", "FAIL", f"missing: {', '.join(missing)}"))
    else:
        try:
            config = gusen_hub.load_config()
            workspaces = gusen_hub.list_workspaces(config)
            checks.append(result("config", "PASS", f"workspaces={len(workspaces)}"))
        except (Exception, SystemExit) as error:
            checks.append(result("config", "FAIL", str(error)))

    missing_drivers = []
    for module, label in (("pymysql", "MySQL"), ("psycopg", "PostgreSQL"), ("oracledb", "Oracle")):
        try:
            importlib.import_module(module)
        except ImportError:
            missing_drivers.append(label)
    try:
        keyring = importlib.import_module("keyring")
        credential_store_ready = float(keyring.get_keyring().priority) > 0
    except (ImportError, TypeError, ValueError):
        credential_store_ready = False
    if missing_drivers or not credential_store_ready:
        detail = []
        if missing_drivers:
            detail.append(f"missing drivers: {', '.join(missing_drivers)}")
        if not credential_store_ready:
            detail.append("credential store unavailable")
        checks.append(result("database-readonly", "FAIL", "; ".join(detail)))
    else:
        checks.append(result("database-readonly", "PASS", "MySQL/PostgreSQL/Oracle + system credential store"))

    try:
        from guthon_tool import bundled_bytes

        index = json.loads(bundled_bytes(f"{EXTENSION_DATA}/index.json"))
        manual = json.loads(bundled_bytes(f"{EXTENSION_DATA}/manual.json"))
        counts = ", ".join(f"{language}={len(index.get(language, []))}" for language in ("java", "javascript", "sql"))
        checks.append(result("vscode-data", "PASS", f"{counts}, manual={sum(map(len, manual.values()))}"))
    except (OSError, KeyError, ValueError, TypeError) as error:
        checks.append(result("vscode-data", "FAIL", str(error)))

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{bridge_port}/health", timeout=0.5) as response:
            payload = json.load(response)
        status = "PASS" if response.status == 200 and payload.get("ok") else "FAIL"
        checks.append(result("bridge", status, f"127.0.0.1:{bridge_port}"))
    except (OSError, ValueError, urllib.error.URLError) as error:
        checks.append(result("bridge", "WARN", f"not running on 127.0.0.1:{bridge_port}: {error}"))

    return checks


def diagnostic_bundle(checks, directory, *, workspace_key=""):
    """Save bounded metadata, excluding raw config, source, SQL, paths and logs."""
    from guthon_tool import application_version, application_build_info
    config = gusen_hub.load_config()
    errors = []
    workspaces = [gusen_hub.resolve_workspace(config, workspace_key)] if workspace_key else gusen_hub.list_workspaces(config, errors=errors)
    if len(workspaces) > 50:
        raise SystemExit("Select --workspace-key to keep the diagnostic bundle bounded")
    summaries = []
    for workspace in workspaces:
        state = gusen_hub.load_workspace_state(config, workspace)
        index = gusen_hub.workspace_index_state(workspace)
        summaries.append({"workspaceKey": workspace["workspaceKey"], "sourceMode": workspace["sourceMode"],
                          "status": state["status"],
                          "indexReady": index["ready"], "indexSizeBytes": index["sizeBytes"],
                          "stepStatuses": {key: value.get("status") for key, value in state["steps"].items()}})
    payload = {"schemaVersion": 1, "version": application_version(), **application_build_info(), "pythonVersion": sys.version.split()[0],
               "checks": [{"name": check["name"], "status": check["status"]} for check in checks],
               "workspaces": summaries, "configErrors": [{"workspaceKey": error["workspaceKey"], "code": error["code"]} for error in errors],
               "coverage": "LOCAL_RUNTIME_AND_INDEX_METADATA", "sourceIncluded": False, "credentialsIncluded": False,
               "logsIncluded": False}
    directory = Path(directory).expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / ("guthon-diagnostics-" + uuid.uuid4().hex + ".zip")
    with zipfile.ZipFile(path, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("diagnostics.json", json.dumps(payload, ensure_ascii=False, indent=2))
        archive.writestr("README.txt", "Metadata only. No source, credentials, raw configuration or query results are included.\n")
    return {"ok": True, "bundlePath": str(path), "sizeBytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "coverage": payload["coverage"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge-port", type=int, default=17361)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--workspace-key", default="")
    parser.add_argument("--bundle", type=Path, help="create a metadata-only diagnostic archive; excludes source, credentials and raw logs")
    args = parser.parse_args(argv)
    if args.self_test:
        assert result("x", "PASS", "ok") == {"name": "x", "status": "PASS", "message": "ok"}
        print("doctor self-test: ok")
        return 0

    checks = run_checks(args.bridge_port)
    if args.bundle:
        bundle = diagnostic_bundle(checks, args.bundle, workspace_key=args.workspace_key)
        print(json.dumps(bundle, ensure_ascii=False, indent=2))
    elif args.json:
        print(json.dumps(checks, ensure_ascii=False, indent=2))
    else:
        for check in checks:
            print(f"[{check['status']}] {check['name']}: {check['message']}")
    return 1 if any(check["status"] == "FAIL" for check in checks) else 0


if __name__ == "__main__":
    raise SystemExit(main())

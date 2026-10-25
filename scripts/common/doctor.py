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


CONFIG_FILES = (
    "datasource.yaml",
    "products.yaml",
    "projects.yaml",
    "source-tables.yaml",
    "sync.yaml",
)
EXTENSION_DATA = "plugins/GuthonNexus/gushen-vscode-completion/data"


class DependencyConfigError(ValueError):
    def __init__(self, filename, message):
        super().__init__(message)
        self.filename = filename


def result(name, status, message, **details):
    return {"name": name, "status": status, "message": message, **details}


def _database_requirements(workspaces):
    """Inspect configured capabilities without resolving passwords or opening connections."""
    engines, connections = set(), []
    for workspace in workspaces:
        if workspace["sourceMode"] != "database":
            continue
        source = workspace.get("datasource") or {}
        if not source:
            raise DependencyConfigError("products.yaml" if workspace["workspaceKey"].startswith("products.") else "projects.yaml",
                                        f"{workspace['workspaceKey']} 尚未配置 DATABASE 数据源")
        engine = source.get("type") or "mysql"
        if not isinstance(engine, str):
            raise DependencyConfigError("datasource.yaml", "DATABASE 数据源类型必须为字符串")
        engine = engine.strip().lower()
        engine = {"mariadb": "mysql", "postgres": "postgresql"}.get(engine, engine)
        if engine not in {"mysql", "postgresql"}:
            raise DependencyConfigError("datasource.yaml", f"{workspace['workspaceKey']} 的 DATABASE 源码模式仅支持 MySQL/PostgreSQL")
        engines.add(engine); connections.append(source)
    testing_path = gusen_hub.CONFIG_DIR / "database-testing.yaml"
    if testing_path.is_file():
        from common import database_test_artifacts as artifacts
        try:
            testing = artifacts.load_yaml(testing_path)
            bindings = testing.get("databaseTests", {})
            if not isinstance(bindings, dict):
                raise ValueError("database-testing.yaml 的 databaseTests 必须为对象")
            selected = [bindings[workspace["workspaceKey"]] for workspace in workspaces if workspace["workspaceKey"] in bindings]
            if selected:
                artifacts.validate_config(testing)
                for binding in selected:
                    for target in binding["targets"]:
                        if target.get("connectionRef"):
                            connection = testing["connections"][target["connectionRef"]]
                            engines.add(connection["engine"]); connections.append(connection)
        except (Exception, SystemExit) as error:
            raise DependencyConfigError("database-testing.yaml", str(error)) from error
    credential_required = any(connection.get("credentialRef") and not any(connection.get(key)
                              for key in ("passwordEnv", "passwordFile", "password")) for connection in connections)
    credential_optional = any(connection.get("credentialRef") for connection in connections) and not credential_required
    return engines, credential_required, credential_optional


def run_checks(bridge_port=17361, *, workspace_key=""):
    checks = []
    checks.append(
        result(
            "python",
            "PASS" if sys.version_info >= (3, 10) else "FAIL",
            sys.version.split()[0],
            code="PYTHON_RUNTIME", action="runtime", required=True,
        )
    )

    workspaces = None
    missing = [name for name in CONFIG_FILES if not (gusen_hub.CONFIG_DIR / name).is_file()]
    if missing:
        checks.append(result("config", "FAIL", f"missing: {', '.join(missing)}", code="CONFIG_MISSING", action="setup", required=True))
    else:
        try:
            config = gusen_hub.load_config()
            if not isinstance(config, dict) or any(not isinstance(section, dict) for section in config.values()):
                raise ValueError("运行配置的顶层必须为 YAML 对象")
            errors = []
            workspaces = [gusen_hub.resolve_workspace(config, workspace_key)] if workspace_key else gusen_hub.list_workspaces(config, errors=errors)
            if errors:
                raise ValueError("；".join(f"{item['workspaceKey']}: {item['code']}: {item['message']}" for item in errors))
            checks.append(result("config", "PASS", f"workspaces={len(workspaces)}", code="CONFIG_READY", required=True))
        except (Exception, SystemExit) as error:
            workspaces = None
            checks.append(result("config", "FAIL", str(error), code="CONFIG_INVALID", action="config", required=True))

    missing_drivers = []
    requirements = None
    if workspaces is not None:
        try:
            requirements = _database_requirements(workspaces)
        except (Exception, SystemExit) as error:
            checks.append(result("database-config", "FAIL", str(error), code="DATABASE_CONFIG_INVALID", action="config",
                                 configFile=getattr(error, "filename", ""), required=True))
    if requirements is None:
        checks.append(result("database-readonly", "WARN", "配置尚未通过，数据库依赖范围未确认", code="DEPENDENCIES_UNKNOWN", required=None))
    else:
        engines, credential_required, credential_optional = requirements
        credential_store_ready = True
        for engine, (module, label) in {"mysql": ("pymysql", "MySQL"), "postgresql": ("psycopg", "PostgreSQL"), "oracle": ("oracledb", "Oracle")}.items():
            if engine not in engines:
                continue
            try:
                importlib.import_module(module)
            except Exception:
                missing_drivers.append(label)
        if credential_required or credential_optional:
            try:
                keyring = importlib.import_module("keyring")
                credential_store_ready = float(keyring.get_keyring().priority) > 0
            except Exception:
                credential_store_ready = False
        detail = []
        if missing_drivers:
            detail.append(f"missing drivers: {', '.join(missing_drivers)}")
        if not credential_store_ready:
            detail.append("credential store unavailable" + ("；已配置备用密码来源，凭据尚未核验" if credential_optional else ""))
        if missing_drivers:
            status, code, action = "FAIL", "DRIVER_MISSING", "runtime"
        elif not credential_store_ready:
            status = "FAIL" if credential_required else "WARN"
            code, action = "CREDENTIAL_STORE_UNAVAILABLE", "credentials"
        elif engines:
            status, code, action = "PASS", "DATABASE_DEPENDENCIES", ""
        else:
            status, code, action = "SKIP", "NOT_REQUIRED", ""
        checks.append(result("database-readonly", status, "; ".join(detail) or (
            "已配置的本地数据库驱动可用；尚未验证连接和凭据" if engines else "当前范围未使用内置数据库连接"),
            code=code, action=action, required=bool(engines), engines=sorted(engines)))

    try:
        from guthon_tool import bundled_bytes

        index = json.loads(bundled_bytes(f"{EXTENSION_DATA}/index.json"))
        manual = json.loads(bundled_bytes(f"{EXTENSION_DATA}/manual.json"))
        counts = ", ".join(f"{language}={len(index.get(language, []))}" for language in ("java", "javascript", "sql"))
        checks.append(result("vscode-data", "PASS", f"{counts}, manual={sum(map(len, manual.values()))}", code="VSCODE_DATA_READY", required=True))
    except (OSError, KeyError, ValueError, TypeError) as error:
        checks.append(result("vscode-data", "FAIL", str(error), code="VSCODE_DATA_INVALID", action="runtime", required=True))

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{bridge_port}/health", timeout=0.5) as response:
            payload = json.load(response)
        if not isinstance(payload, dict):
            raise ValueError("Bridge 健康响应必须为对象，请核对端口和运行版本")
        status = "PASS" if response.status == 200 and payload.get("ok") is True else "FAIL"
        checks.append(result("bridge", status, f"127.0.0.1:{bridge_port}", code="BRIDGE_HEALTH", action="bridge", required=False))
    except (OSError, ValueError, urllib.error.URLError) as error:
        checks.append(result("bridge", "WARN", f"not running on 127.0.0.1:{bridge_port}: {error}", code="BRIDGE_OFFLINE", action="bridge", required=False))

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


def main(argv=None, *, workspace_key=""):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge-port", type=int, default=17361)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--report", action="store_true", help="return a completed local-check report; inspect health and summary for check failures")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--workspace-key", default="")
    parser.add_argument("--bundle", type=Path, help="create a metadata-only diagnostic archive; excludes source, credentials and raw logs")
    args = parser.parse_args(argv)
    if args.workspace_key and workspace_key and args.workspace_key != workspace_key:
        parser.error("--workspace-key 与显式 --workspace 不一致")
    workspace_key = workspace_key or args.workspace_key
    if args.report and args.bundle:
        parser.error("--report 不与 --bundle 同时使用")
    if args.self_test:
        assert result("x", "PASS", "ok") == {"name": "x", "status": "PASS", "message": "ok"}
        print("doctor self-test: ok")
        return 0

    checks = run_checks(args.bridge_port, workspace_key=workspace_key)
    if args.report:
        # The report completed; health records its findings. Legacy JSON retains exit status 1 for FAIL.
        summary = {status: sum(check["status"] == status for check in checks) for status in ("PASS", "WARN", "FAIL", "SKIP")}
        print(json.dumps({"ok": True, "workspaceKey": workspace_key or None, "health": "FAIL" if summary["FAIL"] else "WARN" if summary["WARN"] else "PASS",
                          "summary": summary, "checks": checks, "coverage": "LOCAL_DEPENDENCIES_ONLY",
                          "databaseConnectionVerified": False, "platformVerified": False}, ensure_ascii=False, indent=2))
        return 0
    if args.bundle:
        bundle = diagnostic_bundle(checks, args.bundle, workspace_key=workspace_key)
        print(json.dumps(bundle, ensure_ascii=False, indent=2))
    elif args.json:
        print(json.dumps(checks, ensure_ascii=False, indent=2))
    else:
        for check in checks:
            print(f"[{check['status']}] {check['name']}: {check['message']}")
    return 1 if any(check["status"] == "FAIL" for check in checks) else 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Create one local Guthon product/project configuration without rewriting YAML."""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from providers.svn import checkout as svn_checkout


ROOT_KEYS = {"product": "products", "project": "projects"}
CONFIG_FILES = {"products": "products.yaml", "projects": "projects.yaml"}
SOURCE_MODES = {"database", "svn"}
SVN_URL_SCHEMES = {"http", "https", "svn", "svn+ssh", "file"}


def _required_text(value, label: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise SystemExit(f"Missing {label}")
    if any(character in text for character in ("\r", "\n", "\0")):
        raise SystemExit(f"Invalid {label}")
    return text


def _yaml_string(value) -> str:
    return json.dumps(str(value), ensure_ascii=False)


def _svn_url(value) -> str:
    url = _required_text(value, "svnUrl").rstrip("/")
    parsed = urlsplit(url)
    if parsed.scheme.lower() not in SVN_URL_SCHEMES:
        raise SystemExit("svnUrl must use http, https, svn, svn+ssh or file")
    if parsed.username or parsed.password:
        raise SystemExit("svnUrl must not contain credentials")
    if parsed.scheme.lower() != "file" and not parsed.hostname:
        raise SystemExit("svnUrl must include a server")
    return url


def _atomic_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def _append_root_entry(path: Path, root_key: str, entry_id: str, body: list[str]) -> None:
    text = path.read_text(encoding="utf-8")
    empty_root = re.compile(rf"(?m)^(?P<indent>[ ]*){re.escape(root_key)}:[ ]*\{{\}}[ ]*$")
    match = empty_root.search(text)
    entry = "\n".join([f"  {entry_id}:", *[f"    {line}" for line in body]]) + "\n"
    if match:
        replacement = f"{match.group('indent')}{root_key}:\n{entry.rstrip()}"
        updated = text[: match.start()] + replacement + text[match.end() :]
        if not updated.endswith("\n"):
            updated += "\n"
    else:
        root = re.search(rf"(?m)^{re.escape(root_key)}:[ ]*$", text)
        if not root:
            raise SystemExit(f"Missing YAML root '{root_key}' in {path}")
        updated = text.rstrip() + "\n" + entry
    _atomic_text(path, updated)


def _remove_root_entry_text(text: str, root_key: str, entry_id: str) -> tuple[str, bool]:
    lines = text.splitlines(keepends=True)
    root_pattern = re.compile(rf"^(?P<indent>[ ]*){re.escape(root_key)}:[ ]*(?:#.*)?(?:\r?\n)?$")
    root_index = next((index for index, line in enumerate(lines) if root_pattern.match(line)), None)
    if root_index is None:
        return text, False
    root_indent = len(root_pattern.match(lines[root_index]).group("indent"))
    root_end = root_index + 1
    while root_end < len(lines):
        stripped = lines[root_end].lstrip(" ")
        if not stripped.strip() or stripped.startswith("#"):
            root_end += 1
            continue
        if len(lines[root_end]) - len(stripped) <= root_indent:
            break
        root_end += 1
    entry_indent = root_indent + 2
    entry_pattern = re.compile(
        rf"^[ ]{{{entry_indent}}}(?:[\"']?){re.escape(entry_id)}(?:[\"']?):[ ]*(?:#.*)?(?:\r?\n)?$"
    )
    entry_index = next(
        (
            index
            for index in range(root_index + 1, root_end)
            if entry_pattern.match(lines[index])
        ),
        None,
    )
    if entry_index is None:
        return text, False
    end = entry_index + 1
    while end < len(lines):
        stripped = lines[end].lstrip(" ")
        if not stripped.strip() or stripped.startswith("#"):
            end += 1
            continue
        indent = len(lines[end]) - len(stripped)
        if indent <= entry_indent:
            break
        end += 1
    del lines[entry_index:end]
    return "".join(lines), True


def _remove_root_entries(path: Path, root_key: str, entry_ids: list[str]) -> list[str]:
    if not path.is_file() or not entry_ids:
        return []
    original = path.read_text(encoding="utf-8")
    updated = original
    removed = []
    for entry_id in entry_ids:
        updated, found = _remove_root_entry_text(updated, root_key, entry_id)
        if found:
            removed.append(entry_id)
    if updated != original:
        _atomic_text(path, updated)
    return removed


def _workspace_body(payload: dict, datasource_id: str) -> list[str]:
    body = [
        f"name: {_yaml_string(payload['name'])}",
        f"datasource: {_yaml_string(datasource_id)}",
        "page_origins: []",
        "systems:",
        "  include:",
        "    # 按需维护系统别名、系统 ID 和数据源 ID。",
        "    mappings: {}",
    ]
    body.extend(
        [
            f"source_layer: {'PRODUCT' if payload['kind'] == 'product' else 'PROJECT'}",
            "include:",
            "  all: true",
        ]
    )
    if payload["sourceMode"] == "svn" and payload.get("svnUrl"):
        body.extend([
            "svn:",
            f"  url: {_yaml_string(_svn_url(payload['svnUrl']))}",
        ])
    return body


def _datasource_body(payload: dict, workspace_key: str) -> tuple[str, list[str]]:
    datasource = payload.get("datasource")
    if not isinstance(datasource, dict):
        raise SystemExit("DATABASE workspace requires datasource settings")
    datasource_id = _required_text(datasource.get("id"), "datasource.id")
    svn_checkout.validate_config_id(datasource_id)
    environment = str(datasource.get("environment") or "dev").strip().lower()
    if environment not in {"dev", "test"}:
        raise SystemExit("datasource.environment must be dev or test")
    database_type = str(datasource.get("type") or "mysql").strip().lower()
    database_type = {"mariadb": "mysql", "postgres": "postgresql"}.get(database_type, database_type)
    if database_type not in {"mysql", "postgresql"}:
        raise SystemExit("datasource.type must be mysql or postgresql")
    raw_port = datasource.get("port", 5432 if database_type == "postgresql" else 3306)
    try:
        port = int(raw_port)
    except (TypeError, ValueError) as error:
        raise SystemExit("datasource.port must be an integer") from error
    if not 1 <= port <= 65535:
        raise SystemExit("datasource.port must be between 1 and 65535")
    body = [
        f"name: {_yaml_string(datasource.get('name') or payload['name'] + '_' + environment)}",
        f"object: {_yaml_string(workspace_key)}",
        f"environment: {environment}",
        f"type: {database_type}",
        f"host: {_yaml_string(_required_text(datasource.get('host'), 'datasource.host'))}",
        f"port: {port}",
        f"database: {_yaml_string(_required_text(datasource.get('database'), 'datasource.database'))}",
        f"username: {_yaml_string(_required_text(datasource.get('username'), 'datasource.username'))}",
        f"password: {_yaml_string(str(datasource.get('password') or ''))}",
    ]
    return datasource_id, body


def _ensure_svn_username(path: Path, configured: dict, requested) -> bool:
    current = str(((configured.get("sync") or {}).get("svn") or {}).get("username") or "").strip()
    if current:
        return False
    username = _required_text(requested, "svnUsername")
    text = path.read_text(encoding="utf-8")
    svn_block = re.search(r"(?ms)^svn:[ ]*\n(?P<body>(?:^[ ]+.*\n?)*)", text)
    if not svn_block:
        raise SystemExit(f"Missing YAML root 'svn' in {path}")
    body = svn_block.group("body")
    replaced, count = re.subn(
        r"(?m)^(?P<indent>[ ]+)username:[ ]*.*$",
        lambda match: f"{match.group('indent')}username: {_yaml_string(username)}",
        body,
        count=1,
    )
    if count != 1:
        raise SystemExit(f"Missing svn.username in {path}")
    updated = text[: svn_block.start("body")] + replaced + text[svn_block.end("body") :]
    _atomic_text(path, updated)
    return True


def configure_svn_username(home: Path, payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise SystemExit("svn-login-configure input must be a JSON object")
    username = _required_text(payload.get("username"), "username")
    sync_path = home / "config" / "sync.yaml"
    if not sync_path.is_file():
        raise SystemExit(f"Missing sync config: {sync_path}")
    text = sync_path.read_text(encoding="utf-8")
    svn_block = re.search(r"(?ms)^svn:[ ]*\n(?P<body>(?:^[ ]+.*\n?)*)", text)
    if not svn_block:
        raise SystemExit(f"Missing YAML root 'svn' in {sync_path}")
    body = svn_block.group("body")
    replaced, count = re.subn(
        r"(?m)^(?P<indent>[ ]+)username:[ ]*.*$",
        lambda match: f"{match.group('indent')}username: {_yaml_string(username)}",
        body,
        count=1,
    )
    if count != 1:
        raise SystemExit(f"Missing svn.username in {sync_path}")
    updated = text[: svn_block.start("body")] + replaced + text[svn_block.end("body") :]
    if updated != text:
        _atomic_text(sync_path, updated)
    return {"ok": True, "usernameConfigured": True}


def create_workspace(home: Path, payload: dict, gusen_hub) -> dict:
    """Append one workspace and optional datasource, with rollback on any failure."""

    if not isinstance(payload, dict):
        raise SystemExit("workspace-create input must be a JSON object")
    kind = str(payload.get("kind") or "").strip().lower()
    if kind not in ROOT_KEYS:
        raise SystemExit("kind must be product or project")
    workspace_id = _required_text(payload.get("id"), "id")
    svn_checkout.validate_config_id(workspace_id)
    name = _required_text(payload.get("name"), "name")
    source_mode = str(payload.get("sourceMode") or "").strip().lower()
    if source_mode not in SOURCE_MODES:
        raise SystemExit("sourceMode must be database or svn")

    setup_paths = [home / "config" / filename for filename in ("datasource.yaml", "products.yaml", "projects.yaml")]
    missing = [str(path) for path in setup_paths if not path.is_file()]
    if missing:
        raise SystemExit("Missing configuration files; run setup first: " + ", ".join(missing))

    config = gusen_hub.load_config()
    workspaces = gusen_hub.list_workspaces(config)
    if any(item["id"] == workspace_id for item in workspaces):
        raise SystemExit(f"Duplicate workspace config id: {workspace_id}")
    root_key = ROOT_KEYS[kind]
    if any(item["kind"] == root_key and item["name"] == name for item in workspaces):
        raise SystemExit(f"Duplicate {root_key} display name: {name}")

    workspace_key = f"{root_key}.{workspace_id}"
    normalized = {**payload, "kind": kind, "id": workspace_id, "name": name, "sourceMode": source_mode}
    datasource_id = ""
    datasource_body = None
    if source_mode == "database" and isinstance(normalized.get("datasource"), dict):
        datasource_id, datasource_body = _datasource_body(normalized, workspace_key)
        datasource_items = config.get("datasource", {}).get("datasource") or {}
        if datasource_id in datasource_items:
            raise SystemExit(f"Duplicate datasource id: {datasource_id}")

    workspace_path = home / "config" / CONFIG_FILES[root_key]
    datasource_path = home / "config" / "datasource.yaml"
    sync_path = home / "config" / "sync.yaml"
    snapshots = {path: path.read_bytes() for path in {workspace_path, datasource_path, sync_path}}
    item = {
        "name": name,
        "workspace_root": payload.get("workspaceRoot"),
    }
    workspace_root = gusen_hub.resolve_workspace_storage_root(root_key, workspace_id, item)
    mode_path = gusen_hub.workspace_source_mode_path(workspace_root)
    previous_mode = mode_path.read_bytes() if mode_path.is_file() else None
    try:
        svn_username_added = False
        if source_mode == "svn" and str(payload.get("svnUsername") or "").strip():
            svn_username_added = _ensure_svn_username(
                sync_path,
                config,
                payload.get("svnUsername"),
            )
        if datasource_body is not None:
            _append_root_entry(datasource_path, "datasource", datasource_id, datasource_body)
        _append_root_entry(workspace_path, root_key, workspace_id, _workspace_body(normalized, datasource_id))
        gusen_hub.write_workspace_source_mode(
            {"workspaceKey": workspace_key, "root": workspace_root},
            source_mode,
        )
        updated_config = gusen_hub.load_config()
        workspace = gusen_hub.resolve_workspace(updated_config, workspace_key)
    except BaseException:
        for path, content in snapshots.items():
            _atomic_text(path, content.decode("utf-8"))
        if previous_mode is None:
            mode_path.unlink(missing_ok=True)
        else:
            mode_path.parent.mkdir(parents=True, exist_ok=True)
            _atomic_text(mode_path, previous_mode.decode("utf-8"))
        raise

    return {
        "ok": True,
        "workspace": gusen_hub.workspace_summary(updated_config, workspace),
        "configPath": str(workspace_path),
        "datasourcePath": str(datasource_path) if datasource_body is not None else "",
        "svnUsernameAdded": svn_username_added,
        "requiresSystemMapping": True,
    }


def workspace_deletion_plan(home: Path, workspace_key: str, gusen_hub) -> dict:
    key = _required_text(workspace_key, "workspaceKey")
    config = gusen_hub.load_config()
    match = re.fullmatch(r"(products|projects)\.([A-Za-z0-9][A-Za-z0-9._-]*)", key)
    if not match:
        raise SystemExit("workspaceKey must be products.<id> or projects.<id>")
    kind, workspace_id = match.groups()
    workspace_items = (config.get(kind, {}).get(kind) or {})
    workspace_item = workspace_items.get(workspace_id)
    if not isinstance(workspace_item, dict):
        raise SystemExit(f"Unknown workspace: {key}")
    workspace_name = _required_text(workspace_item.get("name"), f"name for {key}")
    workspace_root = gusen_hub.resolve_workspace_storage_root(kind, workspace_id, workspace_item)
    config_path = home / "config" / CONFIG_FILES[kind]
    datasource_items = config.get("datasource", {}).get("datasource") or {}
    datasource_ids = sorted(
        item_id
        for item_id, item in datasource_items.items()
        if isinstance(item, dict) and str(item.get("object") or "").strip() == key
    )
    directories = []
    for label, candidate in (
        ("工作区目录", workspace_root),
        ("SVN checkout", home / "var" / "checkout" / workspace_id),
    ):
        path = Path(candidate).expanduser().resolve()
        if path in {Path("/").resolve(), Path.home().resolve(), home.resolve()}:
            raise SystemExit(f"Unsafe workspace deletion path: {path}")
        if not any(item["path"] == str(path) for item in directories):
            directories.append({"label": label, "path": str(path), "exists": path.exists()})
    database_testing = home / "config" / "database-testing.yaml"
    return {
        "ok": True,
        "workspaceKey": key,
        "displayName": f"{'PRD' if kind == 'products' else 'PRJ'} {workspace_name}",
        "kind": kind,
        "workspaceConfigPath": str(config_path),
        "datasourceConfigPath": str(home / "config" / "datasource.yaml"),
        "datasourceIds": datasource_ids,
        "databaseTestingPath": str(database_testing),
        "databaseTestingConfigured": database_testing.is_file()
        and re.search(rf"(?m)^  {re.escape(key)}:\s*$", database_testing.read_text(encoding="utf-8")) is not None,
        "directories": directories,
    }


def delete_workspace_config(home: Path, payload: dict, gusen_hub) -> dict:
    if not isinstance(payload, dict):
        raise SystemExit("workspace-delete input must be a JSON object")
    key = _required_text(payload.get("workspaceKey"), "workspaceKey")
    plan = workspace_deletion_plan(home, key, gusen_hub)
    if payload.get("mode") == "preview":
        return plan
    if payload.get("mode") != "delete" or payload.get("confirmation") != key:
        raise SystemExit("workspace-delete requires the exact workspaceKey confirmation")
    remaining = [item["path"] for item in plan["directories"] if Path(item["path"]).exists()]
    if remaining:
        raise SystemExit("Workspace directories must be removed before configuration: " + ", ".join(remaining))

    workspace_path = Path(plan["workspaceConfigPath"])
    datasource_path = Path(plan["datasourceConfigPath"])
    database_testing_path = Path(plan["databaseTestingPath"])
    paths = [workspace_path, datasource_path]
    if database_testing_path.is_file():
        paths.append(database_testing_path)
    snapshots = {path: path.read_bytes() for path in paths}
    try:
        kind_id = key.split(".", 1)[1]
        removed_workspace = _remove_root_entries(workspace_path, plan["kind"], [kind_id])
        if removed_workspace != [kind_id]:
            raise SystemExit(f"Workspace config entry was not found: {key}")
        removed_datasources = _remove_root_entries(
            datasource_path, "datasource", plan["datasourceIds"]
        )
        removed_database_testing = []
        removed_connections = []
        if database_testing_path.is_file():
            removed_database_testing = _remove_root_entries(
                database_testing_path, "databaseTests", [key]
            )
            connection_text = database_testing_path.read_text(encoding="utf-8")
            connection_ids = re.findall(
                rf"(?m)^  ({re.escape(key)}\.[A-Za-z0-9._-]+):\s*$", connection_text
            )
            removed_connections = _remove_root_entries(
                database_testing_path, "connections", connection_ids
            )
    except BaseException:
        for path, content in snapshots.items():
            _atomic_text(path, content.decode("utf-8"))
        raise
    return {
        "ok": True,
        "workspaceKey": key,
        "removedWorkspaceConfig": str(workspace_path),
        "removedDatasourceIds": removed_datasources,
        "removedDatabaseTesting": bool(removed_database_testing),
        "removedDatabaseConnections": removed_connections,
    }

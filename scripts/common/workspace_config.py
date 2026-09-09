"""Create one local Guthon product/project configuration without rewriting YAML."""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path

from providers.svn import checkout as svn_checkout


ROOT_KEYS = {"product": "products", "project": "projects"}
CONFIG_FILES = {"products": "products.yaml", "projects": "projects.yaml"}
SOURCE_MODES = {"database", "svn"}


def _required_text(value, label: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise SystemExit(f"Missing {label}")
    if any(character in text for character in ("\r", "\n", "\0")):
        raise SystemExit(f"Invalid {label}")
    return text


def _yaml_string(value) -> str:
    return json.dumps(str(value), ensure_ascii=False)


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
    raw_port = datasource.get("port", 3306)
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
        "type: mysql",
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
    normalized = {**payload, "kind": kind, "id": workspace_id, "name": name}
    datasource_id = ""
    datasource_body = None
    if source_mode == "database":
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
        svn_username_added = source_mode == "svn" and _ensure_svn_username(
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

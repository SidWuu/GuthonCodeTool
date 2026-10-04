"""Create one local Guthon product/project configuration without rewriting YAML."""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from providers.svn import checkout as svn_checkout
from common.persistence import file_lock, atomic_text
from common.workspace_identity import validate_workspace_key


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


_atomic_text = atomic_text


def _canonical_yaml(text):
    """The dependency-free runtime edits only the documented block YAML subset."""
    from common.gusen_hub import _parse_tiny_yaml
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "\t" in line[:len(line)-len(line.lstrip())]:
            raise SystemExit("PyYAML is required for noncanonical YAML configuration")
        value = line.partition(":")[2].strip()
        if value and value[0] in "&*|>" or value.startswith("{") and value != "{}":
            raise SystemExit("PyYAML is required for flow mappings, anchors or multiline YAML")
    return _parse_tiny_yaml(text)


def _append_canonical_entry(path: Path, root_key: str, entry_id: str, body: list[str]) -> None:
    text = path.read_text(encoding="utf-8")
    empty_root = re.compile(rf"(?m)^(?P<indent>[ ]*){re.escape(root_key)}:[ ]*\{{\}}[ ]*$")
    match = empty_root.search(text)
    entry = "\n".join([f"  {_yaml_string(entry_id) if entry_id[0].isdigit() or entry_id.lower() in {'true','false','null','yes','no','on','off'} else entry_id}:", *[f"    {line}" for line in body]]) + "\n"
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


def _remove_canonical_entry_text(text: str, root_key: str, entry_id: str) -> tuple[str, bool]:
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


def _yaml_mapping_node(text, root_key):
    try:
        import yaml
    except ImportError as error:
        raise SystemExit("PyYAML is required to edit configuration safely") from error
    node = yaml.compose(text)
    if not isinstance(node, yaml.MappingNode):
        raise SystemExit("Configuration root must be a YAML mapping")
    matches = [value for key, value in node.value if key.value == root_key]
    if len(matches) != 1 or not isinstance(matches[0], yaml.MappingNode):
        raise SystemExit(f"Expected exactly one YAML mapping: {root_key}")
    return yaml, matches[0]


def _append_root_entry(path: Path, root_key: str, entry_id: str, body: list[str]) -> None:
    text = path.read_text(encoding="utf-8")
    try:
        import yaml
    except ImportError:
        data = _canonical_yaml(text)
        if entry_id in (data.get(root_key) or {}):
            raise SystemExit(f"Duplicate config entry: {entry_id}")
        _append_canonical_entry(path, root_key, entry_id, body)
        return
    yaml, mapping = _yaml_mapping_node(text, root_key)
    data = yaml.safe_load(text)
    if entry_id in data[root_key]:
        raise SystemExit(f"Duplicate config entry: {entry_id}")
    entry = "\n".join([f"  {_yaml_string(entry_id) if entry_id[0].isdigit() or entry_id.lower() in {'true','false','null','yes','no','on','off'} else entry_id}:", *[f"    {line}" for line in body]]) + "\n"
    if mapping.flow_style:
        combined = {**data[root_key], **yaml.safe_load(entry)}
        replacement = yaml.safe_dump(combined, allow_unicode=True, sort_keys=False, default_flow_style=True).strip()
        updated = text[:mapping.start_mark.index] + replacement + text[mapping.end_mark.index:]
        if not data[root_key]:
            updated = text[:mapping.start_mark.index] + "\n" + entry.rstrip("\n") + text[mapping.end_mark.index:]
    else:
        offset = mapping.end_mark.index - mapping.end_mark.column
        updated = text[:offset].rstrip("\n") + "\n" + entry + text[offset:]
    expected = {**data, root_key: {**data[root_key], **yaml.safe_load(entry)}}
    if yaml.safe_load(updated) != expected:
        raise SystemExit("Configuration edit did not preserve existing YAML values")
    _atomic_text(path, updated if updated.endswith("\n") else updated + "\n")


def _remove_root_entry_text(text: str, root_key: str, entry_id: str) -> tuple[str, bool]:
    try:
        import yaml
    except ImportError:
        data = _canonical_yaml(text)
        updated, found = _remove_canonical_entry_text(text, root_key, entry_id)
        expected = {**data, root_key: {key: value for key, value in (data.get(root_key) or {}).items() if key != entry_id}}
        if found and _canonical_yaml(updated) != expected:
            raise SystemExit("Configuration removal did not preserve existing YAML values")
        return updated, found
    data = yaml.safe_load(text)
    if not isinstance(data, dict) or root_key not in data:
        return text, False
    matches = [key for key in (data[root_key] or {}) if str(key) == entry_id]
    if len(matches) > 1:
        raise SystemExit('Ambiguous YAML entry identity; quote and repair duplicate keys before removal')
    if not matches:
        return text, False
    actual_key = matches[0]
    yaml, mapping = _yaml_mapping_node(text, root_key)
    expected = {**data, root_key: {key: value for key, value in data[root_key].items() if key != actual_key}}
    if mapping.flow_style or len(mapping.value) == 1:
        replacement = yaml.safe_dump(expected[root_key], allow_unicode=True, sort_keys=False, default_flow_style=True).strip()
        updated = text[:mapping.start_mark.index] + replacement + text[mapping.end_mark.index:]
    else:
        offsets = [0]
        for line in text.splitlines(keepends=True):
            offsets.append(offsets[-1] + len(line))
        index = next(index for index, (key, _value) in enumerate(mapping.value) if key.value == entry_id)
        start = offsets[mapping.value[index][0].start_mark.line]
        end = offsets[mapping.value[index + 1][0].start_mark.line] if index + 1 < len(mapping.value) else mapping.end_mark.index - mapping.end_mark.column
        updated = text[:start] + text[end:]
    if yaml.safe_load(updated) != expected:
        raise SystemExit("Configuration removal did not preserve existing YAML values")
    return updated, True


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
        if isinstance(raw_port,bool):
            raise ValueError('boolean is not a port')
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
    ]
    if datasource.get('password') is not None and not isinstance(datasource.get('password'),str):
        raise SystemExit('datasource.password must be a string')
    if datasource.get('credentialRef') or datasource.get('password') or not (datasource.get('passwordEnv') or datasource.get('passwordFile')):
        body.append(f"credentialRef: {_yaml_string(str(datasource.get('credentialRef') or workspace_key + '.source.' + datasource_id))}")
    if datasource.get('passwordEnv'):
        if not isinstance(datasource['passwordEnv'],str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*',datasource['passwordEnv']):
            raise SystemExit('datasource.passwordEnv must be an environment variable name')
        body.append(f"passwordEnv: {_yaml_string(datasource['passwordEnv'])}")
    if datasource.get('passwordFile'):
        if not isinstance(datasource['passwordFile'],str) or not Path(datasource['passwordFile']).expanduser().is_absolute():
            raise SystemExit('datasource.passwordFile must be an absolute path')
        body.append(f"passwordFile: {_yaml_string(datasource['passwordFile'])}")
    reference = str(datasource.get('credentialRef') or workspace_key + '.source.' + datasource_id)
    if not reference.startswith(workspace_key + '.') or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*',reference):
        raise SystemExit('datasource.credentialRef must belong to this explicit workspace')
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
    with file_lock(home / "config" / ".configuration.lock"):
        return _configure_svn_username(home, payload)


def _configure_svn_username(home: Path, payload: dict) -> dict:
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
    with file_lock(home / "config" / ".configuration.lock"):
        return _create_workspace(home, payload, gusen_hub)


def _create_workspace(home: Path, payload: dict, gusen_hub) -> dict:
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
    workspaces = gusen_hub.list_workspaces(config, strict=True)
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
    credential_changed = False
    credential_ref = ''
    previous_password = None
    try:
        svn_username_added = False
        if datasource_body is not None and normalized['datasource'].get('password'):
            from common import database_readonly
            credential_ref = str(normalized['datasource'].get('credentialRef') or workspace_key + '.source.' + datasource_id)
            previous_password = database_readonly._keyring().get_password(database_readonly.CREDENTIAL_SERVICE, credential_ref)
            credential_changed = True
            database_readonly.set_password(credential_ref, str(normalized['datasource']['password']))
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
        if credential_changed:
            from common import database_readonly
            try:
                database_readonly.delete_password(credential_ref) if previous_password is None else database_readonly.set_password(credential_ref, previous_password)
            except database_readonly.DatabaseReadonlyError as error:
                from common.command_errors import CommandError
                raise CommandError('CREDENTIAL_ROLLBACK_FAILED','Workspace configuration rolled back, but credential state is uncertain; reconfigure the source credential') from error
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
    try:
        validate_workspace_key(key)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    kind, workspace_id = key.split(".", 1)
    workspace_items = (config.get(kind, {}).get(kind) or {})
    workspace_item = workspace_items.get(workspace_id)
    if workspace_item is None:
        matches = [item for item_id,item in workspace_items.items() if str(item_id) == workspace_id]
        if len(matches)>1:raise SystemExit('Ambiguous workspace config identity; repair duplicate keys')
        workspace_item = matches[0] if matches else None
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
    docs_has_files = False
    if kind == "projects":
        docs_path = workspace_root / "docs"
        if docs_path.is_dir() and not docs_path.is_symlink():
            docs_has_files = any(files for _, _, files in os.walk(docs_path))
    database_testing = home / "config" / "database-testing.yaml"
    return {
        "ok": True,
        "workspaceKey": key,
        "displayName": f"{'PRD' if kind == 'products' else 'PRJ'} {workspace_name}",
        "kind": kind,
        "docsHasFiles": docs_has_files,
        "workspaceConfigPath": str(config_path),
        "datasourceConfigPath": str(home / "config" / "datasource.yaml"),
        "datasourceIds": datasource_ids,
        "databaseTestingPath": str(database_testing),
        "databaseTestingConfigured": database_testing.is_file()
        and re.search(rf"(?m)^  {re.escape(key)}:\s*$", database_testing.read_text(encoding="utf-8")) is not None,
        "directories": directories,
    }


def delete_workspace_config(home: Path, payload: dict, gusen_hub) -> dict:
    with file_lock(home / "config" / ".configuration.lock"):
        return _delete_workspace_config(home, payload, gusen_hub)


def _delete_workspace_config(home: Path, payload: dict, gusen_hub) -> dict:
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

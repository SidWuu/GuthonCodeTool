"""API-only workspace registration, preserving existing YAML content."""

from __future__ import annotations
import json
import re
from pathlib import Path
from common.persistence import file_lock, atomic_text
from common.workspace_identity import validate_config_id, validate_workspace_key

ROOT_KEYS = {"product": "products", "project": "projects"}
CONFIG_FILES = {"products": "products.yaml", "projects": "projects.yaml"}
_atomic_text = atomic_text


def _required_text(value, label: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise SystemExit(f"Missing {label}")
    if any(character in text for character in ("\r", "\n", "\0")):
        raise SystemExit(f"Invalid {label}")
    return text


def _yaml_string(value) -> str:
    return json.dumps(str(value), ensure_ascii=False)


def _canonical_yaml(text):
    """The dependency-free runtime edits only the documented block YAML subset."""
    from common.gusen_hub import _parse_tiny_yaml

    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "\t" in line[: len(line) - len(line.lstrip())]:
            raise SystemExit("PyYAML is required for noncanonical YAML configuration")
        value = line.partition(":")[2].strip()
        if value and value[0] in "&*|>" or value.startswith("{") and value != "{}":
            raise SystemExit(
                "PyYAML is required for flow mappings, anchors or multiline YAML"
            )
    return _parse_tiny_yaml(text)


def _append_canonical_entry(
    path: Path, root_key: str, entry_id: str, body: list[str]
) -> None:
    text = path.read_text(encoding="utf-8")
    empty_root = re.compile(
        rf"(?m)^(?P<indent>[ ]*){re.escape(root_key)}:[ ]*\{{\}}[ ]*$"
    )
    match = empty_root.search(text)
    entry = (
        "\n".join(
            [
                f"  {_yaml_string(entry_id) if entry_id[0].isdigit() or entry_id.lower() in {'true', 'false', 'null', 'yes', 'no', 'on', 'off'} else entry_id}:",
                *[f"    {line}" for line in body],
            ]
        )
        + "\n"
    )
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


def _remove_canonical_entry_text(
    text: str, root_key: str, entry_id: str
) -> tuple[str, bool]:
    lines = text.splitlines(keepends=True)
    root_pattern = re.compile(
        rf"^(?P<indent>[ ]*){re.escape(root_key)}:[ ]*(?:#.*)?(?:\r?\n)?$"
    )
    root_index = next(
        (index for index, line in enumerate(lines) if root_pattern.match(line)), None
    )
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


def _append_root_entry(
    path: Path, root_key: str, entry_id: str, body: list[str]
) -> None:
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
    entry = (
        "\n".join(
            [
                f"  {_yaml_string(entry_id) if entry_id[0].isdigit() or entry_id.lower() in {'true', 'false', 'null', 'yes', 'no', 'on', 'off'} else entry_id}:",
                *[f"    {line}" for line in body],
            ]
        )
        + "\n"
    )
    if mapping.flow_style:
        combined = {**data[root_key], **yaml.safe_load(entry)}
        replacement = yaml.safe_dump(
            combined, allow_unicode=True, sort_keys=False, default_flow_style=True
        ).strip()
        updated = (
            text[: mapping.start_mark.index]
            + replacement
            + text[mapping.end_mark.index :]
        )
        if not data[root_key]:
            updated = (
                text[: mapping.start_mark.index]
                + "\n"
                + entry.rstrip("\n")
                + text[mapping.end_mark.index :]
            )
    else:
        offset = mapping.end_mark.index - mapping.end_mark.column
        updated = text[:offset].rstrip("\n") + "\n" + entry + text[offset:]
    expected = {**data, root_key: {**data[root_key], **yaml.safe_load(entry)}}
    if yaml.safe_load(updated) != expected:
        raise SystemExit("Configuration edit did not preserve existing YAML values")
    _atomic_text(path, updated if updated.endswith("\n") else updated + "\n")


def _remove_root_entry_text(
    text: str, root_key: str, entry_id: str
) -> tuple[str, bool]:
    try:
        import yaml
    except ImportError:
        data = _canonical_yaml(text)
        updated, found = _remove_canonical_entry_text(text, root_key, entry_id)
        expected = {
            **data,
            root_key: {
                key: value
                for key, value in (data.get(root_key) or {}).items()
                if key != entry_id
            },
        }
        if found and _canonical_yaml(updated) != expected:
            raise SystemExit(
                "Configuration removal did not preserve existing YAML values"
            )
        return updated, found
    data = yaml.safe_load(text)
    if not isinstance(data, dict) or root_key not in data:
        return text, False
    matches = [key for key in (data[root_key] or {}) if str(key) == entry_id]
    if len(matches) > 1:
        raise SystemExit(
            "Ambiguous YAML entry identity; quote and repair duplicate keys before removal"
        )
    if not matches:
        return text, False
    actual_key = matches[0]
    yaml, mapping = _yaml_mapping_node(text, root_key)
    expected = {
        **data,
        root_key: {
            key: value for key, value in data[root_key].items() if key != actual_key
        },
    }
    if mapping.flow_style or len(mapping.value) == 1:
        replacement = yaml.safe_dump(
            expected[root_key],
            allow_unicode=True,
            sort_keys=False,
            default_flow_style=True,
        ).strip()
        updated = (
            text[: mapping.start_mark.index]
            + replacement
            + text[mapping.end_mark.index :]
        )
    else:
        offsets = [0]
        for line in text.splitlines(keepends=True):
            offsets.append(offsets[-1] + len(line))
        index = next(
            index
            for index, (key, _value) in enumerate(mapping.value)
            if key.value == entry_id
        )
        start = offsets[mapping.value[index][0].start_mark.line]
        end = (
            offsets[mapping.value[index + 1][0].start_mark.line]
            if index + 1 < len(mapping.value)
            else mapping.end_mark.index - mapping.end_mark.column
        )
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


def create_workspace(home, payload, gusen_hub):
    if not isinstance(payload, dict):
        raise SystemExit("workspace-create input must be an object")
    kind = payload.get("kind")
    identifier = validate_config_id(payload.get("id"))
    name = _required_text(payload.get("name"), "name")
    if kind not in ROOT_KEYS:
        raise SystemExit("kind must be product or project")
    if payload.get("sourceMode", "api") != "api":
        raise SystemExit("Only API source mode is supported")
    aliases = payload.get("aliases", [])
    if not isinstance(aliases, list) or any(
        not isinstance(x, str) or not x.strip() for x in aliases
    ):
        raise SystemExit("aliases must contain names")
    with file_lock(home / "config/.configuration.lock"):
        config = gusen_hub.load_config()
        existing = gusen_hub.list_workspaces(config)
        registered = {
            str(key)
            for group in ("products", "projects")
            for key in (config.get(group, {}).get(group) or {})
        }
        if identifier in registered:
            raise SystemExit("Duplicate workspace ID")
        if any(x["name"] == name and x["kind"] == ROOT_KEYS[kind] for x in existing):
            raise SystemExit("Duplicate workspace name")
        rootkey = ROOT_KEYS[kind]
        path = home / "config" / CONFIG_FILES[rootkey]
        before = path.read_text(encoding="utf-8")
        body = [
            f"name: {_yaml_string(name)}",
            "aliases: " + json.dumps(aliases, ensure_ascii=False),
            "api: {}",
        ]
        try:
            _append_root_entry(path, rootkey, identifier, body)
            workspace = gusen_hub.resolve_workspace(
                gusen_hub.load_config(), rootkey + "." + identifier
            )
            gusen_hub.ensure_workspace_structure(workspace)
        except BaseException:
            atomic_text(path, before)
            raise
    return {
        "ok": True,
        "workspace": gusen_hub.workspace_summary(gusen_hub.load_config(), workspace),
        "workspaceKey": workspace["workspaceKey"],
    }


def delete_workspace_config(home, payload, gusen_hub):
    key = validate_workspace_key(payload.get("workspaceKey"))
    config = gusen_hub.load_config()
    workspace = gusen_hub.resolve_workspace(config, key)
    paths = [str(workspace["root"]), str(workspace["checkoutPath"])]
    if payload.get("checkOnly", True):
        return {
            "ok": True,
            "workspaceKey": key,
            "displayName": workspace["displayName"],
            "paths": paths,
            "checkOnly": True,
        }
    if any(Path(p).exists() for p in paths):
        raise SystemExit("请先将已确认的项目目录移入废纸篓，再删除配置")
    with file_lock(home / "config/.configuration.lock"):
        _remove_root_entries(
            home / "config" / CONFIG_FILES[workspace["kind"]],
            workspace["kind"],
            [workspace["id"]],
        )
    return {"ok": True, "workspaceKey": key, "removed": True}

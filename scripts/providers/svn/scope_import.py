"""Convert exact SVN checkout commands from a platform script into a scope manifest."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import textwrap
from collections import Counter
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from urllib.parse import urlsplit

from .nexus.manifest import (
    SAFE_ENTRY_ID,
    SCHEMA_VERSION,
    SUPPORTED_CATEGORIES,
    normalize_scope_subdir,
    normalize_scope_url,
    scope_paths_overlap,
)


CHECKOUT_ACTIONS = {"checkout", "co"}
WRITABLE_CATEGORIES = {"systems", "datasources", "pages", "procedures", "system-script"}
OPTIONS_WITH_VALUES = {
    "--changelist",
    "--config-dir",
    "--config-option",
    "--depth",
    "--native-eol",
    "--password",
    "--revision",
    "--targets",
    "--trust-server-cert-failures",
    "--username",
    "-r",
}
OPTIONS_WITHOUT_VALUES = {
    "--force",
    "--ignore-externals",
    "--non-interactive",
    "--no-auth-cache",
    "--parents",
    "--quiet",
    "--trust-server-cert",
    "-q",
}
TOKEN_PATTERN = re.compile(r'"([^"\r\n]*)"|\'([^\'\r\n]*)\'|([^\s]+)')
VARIABLE_PATTERN = re.compile(r"%[^%]+%|![^!]+!")


@dataclass(frozen=True)
class ParsedCheckout:
    line: int
    url: str
    local_subdir: str
    category: str


@dataclass(frozen=True)
class ImportResult:
    manifest: dict
    command_count: int
    duplicate_count: int


SCOPE_CONFIG_SCHEMA_VERSION = 1


def read_checkout_script(path: Path) -> str:
    try:
        content = path.read_bytes()
    except OSError as error:
        raise SystemExit(f"Cannot read SVN checkout script: {path}") from error
    if content.startswith((b"\xff\xfe", b"\xfe\xff")):
        try:
            return content.decode("utf-16")
        except UnicodeDecodeError as error:
            raise SystemExit(f"Cannot decode SVN checkout script: {path}") from error
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise SystemExit(f"Cannot decode SVN checkout script as UTF-8 or GB18030: {path}")


def read_bat(path: Path) -> str:
    """Compatibility alias for callers that still provide a Windows BAT."""

    return read_checkout_script(path)


def _logical_lines(text: str):
    buffered = ""
    start_line = 0
    for line_number, physical in enumerate(text.splitlines(), 1):
        line = physical.rstrip()
        if not buffered:
            start_line = line_number
        continued = bool(re.search(r"(?<!\^)\^$|(?<!\\)\\$", line))
        buffered += line[:-1] + " " if continued else line
        if not continued:
            yield start_line, buffered
            buffered = ""
    if buffered:
        yield start_line, buffered


def _statements(line: str):
    current = []
    quote = ""
    index = 0
    while index < len(line):
        char = line[index]
        if quote:
            current.append(char)
            if char == quote:
                quote = ""
            index += 1
            continue
        if char in {'"', "'"}:
            quote = char
            current.append(char)
            index += 1
            continue
        if char in {"&", "|", ";"}:
            statement = "".join(current).strip()
            if statement:
                yield statement
            current = []
            while index + 1 < len(line) and line[index + 1] == char:
                index += 1
            index += 1
            continue
        current.append(char)
        index += 1
    statement = "".join(current).strip()
    if statement:
        yield statement


def _tokens(statement: str) -> list[str]:
    return [next(group for group in match.groups() if group is not None) for match in TOKEN_PATTERN.finditer(statement)]


def _is_svn_executable(token: str) -> bool:
    name = PureWindowsPath(token.strip('"')).name.casefold()
    return name in {"svn", "svn.exe"}


def _category_from_path(value: str) -> str:
    normalized = value.replace("\\", "/")
    matches = [part.casefold() for part in PurePosixPath(normalized).parts if part.casefold() in SUPPORTED_CATEGORIES]
    return matches[-1] if matches else ""


def _destination_after_url(operands: list[str], url_index: int, line_number: int) -> str:
    index = url_index + 1
    while index < len(operands):
        token = operands[index].rstrip(")")
        option = token.casefold()
        if option.startswith("--") and "=" in option:
            index += 1
            continue
        if option in OPTIONS_WITHOUT_VALUES:
            index += 1
            continue
        if option in OPTIONS_WITH_VALUES:
            if index + 1 >= len(operands):
                raise SystemExit(f"Line {line_number}: missing value for SVN option {token}")
            index += 2
            continue
        if token.startswith("-"):
            raise SystemExit(f"Line {line_number}: unsupported SVN option after checkout URL: {token}")
        return token
    return ""


def _parse_statement(
    statement: str,
    line_number: int,
    *,
    allow_unknown_category: bool = False,
) -> ParsedCheckout | None:
    text = statement.lstrip(" @(\t")
    tokens = _tokens(text)
    if not tokens:
        return None
    first = tokens[0].lstrip("@").casefold()
    if first in {"rem", "echo", "::", "#"} or first.startswith(("::", "#")):
        return None
    svn_index = next((index for index, token in enumerate(tokens) if _is_svn_executable(token)), None)
    if svn_index is None or svn_index + 1 >= len(tokens):
        return None
    action = tokens[svn_index + 1].casefold()
    if action not in CHECKOUT_ACTIONS:
        return None
    operands = tokens[svn_index + 2 :]
    url_indexes = [
        index
        for index, token in enumerate(operands)
        if urlsplit(token.rstrip(")")).scheme.casefold() in {"http", "https", "svn", "svn+ssh", "file"}
    ]
    if len(url_indexes) != 1:
        if any(VARIABLE_PATTERN.search(token) and not token.startswith("-") for token in operands):
            raise SystemExit(f"Line {line_number}: variables are not allowed in an authorized SVN URL")
        raise SystemExit(f"Line {line_number}: SVN checkout must contain exactly one literal URL")
    url_index = url_indexes[0]
    raw_url = operands[url_index].rstrip(")")
    if VARIABLE_PATTERN.search(raw_url):
        raise SystemExit(f"Line {line_number}: variables are not allowed in an authorized SVN URL")
    url = normalize_scope_url(raw_url, f"line-{line_number}")
    raw_subdir = _destination_after_url(operands, url_index, line_number)
    if not raw_subdir:
        raw_subdir = PurePosixPath(urlsplit(url).path).name
    if VARIABLE_PATTERN.search(raw_subdir):
        raise SystemExit(f"Line {line_number}: variables are not allowed in an SVN checkout destination")
    if PureWindowsPath(raw_subdir).is_absolute():
        raise SystemExit(f"Line {line_number}: SVN checkout destination must be relative")
    if allow_unknown_category and raw_subdir in {".", "./"}:
        raw_subdir = "root"
    local_subdir = normalize_scope_subdir(raw_subdir, f"line-{line_number}")
    local_category = _category_from_path(local_subdir)
    remote_category = _category_from_path(urlsplit(url).path)
    if local_category and remote_category and local_category != remote_category:
        raise SystemExit(
            f"Line {line_number}: checkout category differs between URL ({remote_category}) "
            f"and destination ({local_category})"
        )
    category = local_category or remote_category
    if not category and allow_unknown_category:
        category = "aggregate"
    if not category:
        raise SystemExit(f"Line {line_number}: cannot infer a supported source category")
    return ParsedCheckout(line=line_number, url=url, local_subdir=local_subdir, category=category)


def parse_checkout_script(
    text: str,
    *,
    allow_unknown_category: bool = False,
) -> tuple[list[ParsedCheckout], int]:
    parsed = []
    exact_seen = set()
    duplicate_count = 0
    for line_number, line in _logical_lines(text):
        for statement in _statements(line):
            checkout = _parse_statement(
                statement,
                line_number,
                allow_unknown_category=allow_unknown_category,
            )
            if checkout is None:
                continue
            exact_key = (checkout.url, checkout.local_subdir)
            if exact_key in exact_seen:
                duplicate_count += 1
                continue
            exact_seen.add(exact_key)
            parsed.append(checkout)
    if not parsed:
        raise SystemExit("No executable SVN checkout commands were found in the script")
    _validate_checkouts(parsed)
    return parsed, duplicate_count


def parse_bat(text: str) -> tuple[list[ParsedCheckout], int]:
    """Compatibility alias for callers that still refer to the BAT parser."""

    return parse_checkout_script(text)


def _scope_config_scalar(value: object) -> object:
    """Normalize a scalar from a hand-written scope configuration."""

    if isinstance(value, str):
        return value.strip()
    return value


def _read_scope_config_payload(text: str) -> object:
    """Read JSON/YAML scope data, with a dependency-free line fallback.

    The fallback intentionally supports only the small form documented for
    ``svn-scope.yaml``.  It never evaluates shell syntax or expands variables.
    """

    stripped = text.lstrip("\ufeff \t\r\n")
    if stripped.startswith(("{", "[")):
        try:
            return json.loads(stripped)
        except json.JSONDecodeError as error:
            raise SystemExit(f"Invalid SVN scope configuration JSON: {error}") from error
    try:
        import yaml  # type: ignore

        return yaml.safe_load(text) or {}
    except ModuleNotFoundError:
        pass
    except Exception:
        # A plain text file with one ``<url> <localSubdir>`` entry per line is
        # intentionally accepted when it is not valid YAML.
        pass

    return _parse_scope_config_lines(text)


def _strip_scope_comment(value: str) -> str:
    quote = ""
    for index, char in enumerate(value):
        if char in {'"', "'"} and (not quote or quote == char):
            quote = "" if quote else char
        elif char in {"#", ";"} and not quote and (index == 0 or value[index - 1].isspace()):
            return value[:index].rstrip()
    return value.rstrip()


def _scope_yaml_value(value: str) -> object:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    if value.startswith("[") and value.endswith("]"):
        return [_scope_yaml_value(part) for part in value[1:-1].split(",") if part.strip()]
    if value.casefold() == "true":
        return True
    if value.casefold() == "false":
        return False
    return value


def _parse_scope_config_lines(text: str) -> dict:
    """Parse the documented compact YAML form without PyYAML."""

    text = textwrap.dedent(text)
    payload = {"entries": []}
    entries_indent = None
    current = None
    pending_list_key = None
    pending_list_indent = None
    for line_number, raw_line in enumerate(text.splitlines(), 1):
        clean = _strip_scope_comment(raw_line)
        if not clean.strip():
            continue
        indent = len(clean) - len(clean.lstrip(" "))
        line = clean.strip()
        if (
            pending_list_key
            and current is not None
            and isinstance(current, dict)
            and indent > (pending_list_indent or 0)
            and line.startswith("-")
        ):
            value = line[1:].strip()
            current.setdefault(pending_list_key, []).append(_scope_yaml_value(value))
            continue
        if pending_list_key and indent <= (pending_list_indent or 0):
            pending_list_key = None
            pending_list_indent = None
        if line in {"entries:", "scope:", "repositories:"}:
            entries_indent = indent
            continue
        if indent == 0 and ":" in line and not line.startswith("-"):
            key, value = line.split(":", 1)
            if key in {"schemaVersion", "workspaceKey"}:
                payload[key] = _scope_yaml_value(value)
                continue
        if line.startswith("-"):
            if current is not None:
                payload["entries"].append(current)
            content = line[1:].strip()
            if not content:
                current = {}
                continue
            key_value = re.match(r"^([A-Za-z][A-Za-z0-9_-]*):\s+(.*)$", content)
            if key_value:
                current = {key_value.group(1): _scope_yaml_value(key_value.group(2))}
            else:
                current = content
            continue
        if current is not None and entries_indent is not None and indent > entries_indent:
            empty_key = re.match(r"^([A-Za-z][A-Za-z0-9_-]*):\s*$", line)
            if empty_key and isinstance(current, dict):
                pending_list_key = empty_key.group(1)
                pending_list_indent = indent
                current[pending_list_key] = []
                continue
            key_value = re.match(r"^([A-Za-z][A-Za-z0-9_-]*):\s+(.*)$", line)
            if key_value and isinstance(current, dict):
                current[key_value.group(1)] = _scope_yaml_value(key_value.group(2))
                continue
        parsed = _simple_scope_entry(line)
        if parsed is None:
            raise SystemExit(
                f"Line {line_number}: expected '<url> <localSubdir>' in simple SVN scope configuration"
            )
        payload["entries"].append(parsed)
    if current is not None:
        payload["entries"].append(current)
    return payload


def _simple_scope_entry(value: str) -> dict | None:
    text = str(value or "").strip()
    if not text:
        return None
    text = text.replace("=>", " ").replace("->", " ")
    try:
        tokens = shlex.split(text, posix=True)
    except ValueError:
        return None
    if len(tokens) not in {2, 3} or urlsplit(tokens[0]).scheme.casefold() not in {"http", "https", "svn", "svn+ssh", "file"}:
        return None
    return {
        "url": tokens[0],
        "localSubdir": tokens[1],
        **({"category": tokens[2]} if len(tokens) == 3 else {}),
    }


def _scope_config_entry(raw: object, index: int) -> dict:
    if isinstance(raw, str):
        parsed = _simple_scope_entry(raw)
        if parsed is None:
            raise SystemExit(f"SVN scope entry {index} must be '<url> <localSubdir>'")
        raw = parsed
    if not isinstance(raw, dict):
        raise SystemExit(f"SVN scope entry {index} must be an object or simple '<url> <localSubdir>' string")
    aliases = {
        "svn_url": "url",
        "repository_url": "url",
        "local_subdir": "localSubdir",
        "local_path": "localSubdir",
        "path": "localSubdir",
        "directory": "localSubdir",
        "checkout_paths": "checkoutPaths",
        "checkoutpaths": "checkoutPaths",
        "paths": "checkoutPaths",
    }
    normalized = {}
    for key, value in raw.items():
        normalized[aliases.get(str(key).strip().lower(), str(key).strip())] = _scope_config_scalar(value)
    return normalized


def build_manifest_from_config(text: str, workspace_key: str) -> ImportResult:
    """Build a sanitized authorization manifest from an editable config file.

    Accepted forms are a YAML/JSON object with an ``entries`` (or ``scope``)
    list, a list of entry objects, or one simple ``<url> <localSubdir>`` entry
    per line. A single repository root may use ``checkoutPaths`` to expand
    selected child directories into exact working copies. URLs and
    destinations go through the same overlap and safety checks as checkout
    scripts.
    """

    workspace_key = str(workspace_key or "").strip()
    if not re.fullmatch(r"(?:products|projects)\.[A-Za-z0-9][A-Za-z0-9._-]*", workspace_key):
        raise SystemExit("workspaceKey must be products.<id> or projects.<id>")
    payload = _read_scope_config_payload(text)
    declared_workspace = payload.get("workspaceKey") if isinstance(payload, dict) else None
    if declared_workspace not in (None, "", workspace_key):
        raise SystemExit(f"SVN scope configuration does not match {workspace_key}")
    if isinstance(payload, dict):
        raw_entries = payload.get("entries")
        if raw_entries is None:
            raw_entries = payload.get("scope")
        if raw_entries is None:
            raw_entries = payload.get("repositories")
    else:
        raw_entries = payload
    if not isinstance(raw_entries, list) or not raw_entries:
        raise SystemExit("SVN scope configuration must contain a non-empty entries list")

    entries = []
    exact_seen = set()
    duplicate_count = 0
    used_ids = set()
    for index, raw in enumerate(raw_entries, 1):
        item = _scope_config_entry(raw, index)
        url = normalize_scope_url(item.get("url"), f"entry-{index}")
        checkout_paths = item.get("checkoutPaths")
        if checkout_paths is not None:
            if not isinstance(checkout_paths, list) or not checkout_paths:
                raise SystemExit(f"checkoutPaths must be a non-empty list for SVN scope entry {index}")
            # A project may publish one repository root while the user only
            # wants selected child directories. Expand those children into the
            # existing exact-URL working-copy model; no unconfigured sibling is
            # checked out.
            expanded_items = []
            for path_index, raw_path in enumerate(checkout_paths, 1):
                child = str(raw_path or "").strip().replace("\\", "/")
                try:
                    child_path = normalize_scope_subdir(child, f"entry-{index}.checkoutPaths[{path_index}]")
                except SystemExit as error:
                    raise SystemExit(
                        f"Invalid checkoutPaths[{path_index}] for SVN scope entry {index}: {child}"
                    ) from error
                child_url = normalize_scope_url(
                    f"{url}/{child_path}",
                    f"entry-{index}.checkoutPaths[{path_index}]",
                )
                expanded = dict(item)
                expanded.pop("checkoutPaths", None)
                expanded["url"] = child_url
                # Keep the logical category at the first path component so
                # catalog/index semantics remain identical to script imports.
                expanded["localSubdir"] = child_path
                expanded_items.append(expanded)
            item_values = expanded_items
        else:
            item_values = [item]

        for expanded in item_values:
            expanded_url = normalize_scope_url(expanded.get("url"), f"entry-{index}")
            raw_subdir = str(expanded.get("localSubdir") or "").strip()
            if not raw_subdir:
                raw_subdir = PurePosixPath(urlsplit(expanded_url).path).name
            local_subdir = normalize_scope_subdir(raw_subdir, f"entry-{index}")
            category = str(expanded.get("category") or "").strip().casefold()
            inferred_local = _category_from_path(local_subdir)
            inferred_remote = _category_from_path(urlsplit(expanded_url).path)
            if category and category not in SUPPORTED_CATEGORIES:
                raise SystemExit(f"Unsupported SVN scope category for entry {index}: {category}")
            if inferred_local and inferred_remote and inferred_local != inferred_remote:
                raise SystemExit(
                    f"SVN scope entry {index}: category differs between URL ({inferred_remote}) "
                    f"and destination ({inferred_local})"
                )
            category = category or inferred_local or inferred_remote
            if not category:
                raise SystemExit(f"SVN scope entry {index}: cannot infer a supported source category")
            key = (expanded_url, local_subdir)
            if key in exact_seen:
                duplicate_count += 1
                continue
            exact_seen.add(key)
            writable = expanded.get("writable", category in WRITABLE_CATEGORIES)
            if not isinstance(writable, bool):
                raise SystemExit(f"writable must be boolean for SVN scope entry {index}")
            explicit_id = str(expanded.get("id") or "").strip()
            if explicit_id and len(item_values) > 1:
                explicit_id = f"{explicit_id}-{re.sub(r'[^A-Za-z0-9._-]+', '-', local_subdir.replace('/', '-')).strip('.-')}"
            entry_id = explicit_id or _entry_id(
                ParsedCheckout(index, expanded_url, local_subdir, category),
                used_ids,
            )
            if explicit_id:
                if not SAFE_ENTRY_ID.fullmatch(explicit_id) or explicit_id in {".", ".."}:
                    raise SystemExit(f"Unsafe SVN scope entry id for entry {index}: {explicit_id}")
                if explicit_id in used_ids:
                    raise SystemExit(f"Duplicate SVN scope entry id: {explicit_id}")
                used_ids.add(explicit_id)
            entries.append({
                "id": entry_id,
                "category": category,
                "url": expanded_url,
                "localSubdir": local_subdir,
                "writable": writable,
            })
    if not entries:
        raise SystemExit("SVN scope configuration has no unique entries")
    _validate_checkouts([
        ParsedCheckout(index, entry["url"], entry["localSubdir"], entry["category"])
        for index, entry in enumerate(entries, 1)
    ])
    return ImportResult(
        manifest={
            "schemaVersion": SCHEMA_VERSION,
            "workspaceKey": workspace_key,
            "entries": entries,
        },
        command_count=len(entries) + duplicate_count,
        duplicate_count=duplicate_count,
    )


def render_scope_config(result: ImportResult) -> str:
    """Render a compact, hand-editable YAML scope configuration."""

    manifest = result.manifest
    lines = [
        "# SVN 授权范围配置，可手动追加 entries；不要填写用户名或密码。",
        f"schemaVersion: {SCOPE_CONFIG_SCHEMA_VERSION}",
        f"workspaceKey: {json.dumps(manifest['workspaceKey'], ensure_ascii=False)}",
        "entries:",
    ]
    for entry in manifest.get("entries") or []:
        lines.extend([
            "  - url: " + json.dumps(entry["url"], ensure_ascii=False),
            "    localSubdir: " + json.dumps(entry["localSubdir"], ensure_ascii=False),
            "    category: " + str(entry["category"]),
            "    writable: " + ("true" if entry.get("writable") else "false"),
        ])
    return "\n".join(lines) + "\n"


def write_scope_config(path: Path, result: ImportResult, replace: bool = False) -> dict:
    """Create/update the editable scope configuration atomically."""

    rendered = render_scope_config(result)
    previous = None
    if path.exists():
        try:
            previous = build_manifest_from_config(path.read_text(encoding="utf-8"), result.manifest["workspaceKey"]).manifest
        except (OSError, UnicodeDecodeError, SystemExit) as error:
            if not replace:
                raise SystemExit(f"Existing SVN scope configuration is invalid; use --replace: {path}") from error
        if previous and _manifest_entries(previous) == _manifest_entries(result.manifest):
            return {"ok": True, "written": False, "output": str(path)}
        if path.exists() and not replace:
            added, removed, modified = _change_counts(previous, result.manifest)
            raise SystemExit(
                f"SVN scope configuration differs: added={added}, removed={removed}, modified={modified}. "
                f"Review and rerun with --replace: {path}"
            )
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(rendered, encoding="utf-8")
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()
    return {"ok": True, "written": True, "output": str(path)}


def _url_identity(url: str) -> tuple[str, str, PurePosixPath]:
    parsed = urlsplit(url)
    return parsed.scheme.casefold(), parsed.netloc.casefold(), PurePosixPath(parsed.path.rstrip("/"))


def _validate_checkouts(checkouts: list[ParsedCheckout]) -> None:
    subdirs: list[tuple[PurePosixPath, int]] = []
    urls: list[tuple[tuple[str, str, PurePosixPath], int]] = []
    by_url = {}
    by_subdir = {}
    for checkout in checkouts:
        previous = by_url.get(checkout.url)
        if previous is not None:
            raise SystemExit(
                f"Lines {previous.line} and {checkout.line}: the same SVN URL has different checkout destinations"
            )
        by_url[checkout.url] = checkout
        previous = by_subdir.get(checkout.local_subdir.casefold())
        if previous is not None:
            raise SystemExit(
                f"Lines {previous.line} and {checkout.line}: different SVN URLs use the same checkout destination"
            )
        by_subdir[checkout.local_subdir.casefold()] = checkout
        subdir = PurePosixPath(checkout.local_subdir.casefold())
        for existing, existing_line in subdirs:
            if scope_paths_overlap(subdir, existing):
                raise SystemExit(
                    f"Lines {existing_line} and {checkout.line}: SVN checkout destinations overlap"
                )
        subdirs.append((subdir, checkout.line))
        url_identity = _url_identity(checkout.url)
        for existing, existing_line in urls:
            if url_identity[:2] == existing[:2] and scope_paths_overlap(url_identity[2], existing[2]):
                raise SystemExit(f"Lines {existing_line} and {checkout.line}: SVN checkout URLs overlap")
        urls.append((url_identity, checkout.line))


def _entry_id(checkout: ParsedCheckout, used: set[str]) -> str:
    candidate = re.sub(r"[^A-Za-z0-9._-]+", "-", checkout.local_subdir.replace("/", "-")).strip(".-")
    if not candidate or not SAFE_ENTRY_ID.fullmatch(candidate):
        candidate = f"scope-{hashlib.sha256(checkout.url.encode('utf-8')).hexdigest()[:12]}"
    if candidate in used:
        candidate = f"{candidate}-{hashlib.sha256(checkout.url.encode('utf-8')).hexdigest()[:8]}"
    used.add(candidate)
    return candidate


def build_manifest(text: str, workspace_key: str) -> ImportResult:
    workspace_key = str(workspace_key or "").strip()
    if not re.fullmatch(r"(?:products|projects)\.[A-Za-z0-9][A-Za-z0-9._-]*", workspace_key):
        raise SystemExit("workspaceKey must be products.<id> or projects.<id>")
    checkouts, duplicate_count = parse_checkout_script(text)
    used_ids = set()
    entries = [
        {
            "id": _entry_id(checkout, used_ids),
            "category": checkout.category,
            "url": checkout.url,
            "localSubdir": checkout.local_subdir,
            "writable": checkout.category in WRITABLE_CATEGORIES,
        }
        for checkout in checkouts
    ]
    return ImportResult(
        manifest={"schemaVersion": SCHEMA_VERSION, "workspaceKey": workspace_key, "entries": entries},
        command_count=len(checkouts) + duplicate_count,
        duplicate_count=duplicate_count,
    )


def parse_scope_input(text: str, workspace_key: str, source: str = "script") -> ImportResult:
    """Parse pasted checkout commands or a hand-written scope snippet.

    Nexus uses this for the one-time import action.  A script/BAT is parsed as
    commands first; if the pasted content is already YAML/JSON (or the compact
    ``<url> <localSubdir>`` form), the editable-config parser is used instead.
    """

    if not isinstance(text, str) or not text.strip():
        raise SystemExit("SVN scope input is empty")
    kind = str(source or "script").strip().casefold()
    if kind in {"config", "yaml", "json"}:
        return build_manifest_from_config(text, workspace_key)
    try:
        return build_manifest(text, workspace_key)
    except SystemExit as script_error:
        try:
            return build_manifest_from_config(text, workspace_key)
        except SystemExit:
            raise script_error


def _workspace_checkout_paths(workspace: dict) -> list[str]:
    paths = []
    mappings = workspace.get("systemMappings")
    if not isinstance(mappings, dict):
        mappings = ((workspace.get("systems") or {}).get("include") or {}).get("mappings") or {}
    for mapping in mappings.values():
        if not isinstance(mapping, dict):
            continue
        system_id = str(mapping.get("system_id") or "").strip()
        data_source_id = str(mapping.get("data_source_id") or "").strip()
        if system_id and f"systems/{system_id}" not in paths:
            paths.append(f"systems/{system_id}")
        if data_source_id and f"datasources/{data_source_id}" not in paths:
            paths.append(f"datasources/{data_source_id}")
    return paths


COMPACT_SCOPE_DEFAULT = ("systems", "datasources")
COMPACT_SCOPE_NAMES = {
    "skill",
    "public",
    "systems",
    "datasources",
    "pages",
    "procedures",
    "tables",
    "views",
    "system-script",
}
COMPACT_SCOPE_ALIASES = {
    "system": "systems",
    "datasource": "datasources",
    "system_script": "system-script",
    "systemscript": "system-script",
}


def _workspace_mapping_ids(workspace: dict) -> tuple[list[str], list[str]]:
    """Return mapping IDs in declaration order, rejecting incomplete mappings."""

    mappings = workspace.get("systemMappings")
    if not isinstance(mappings, dict):
        mappings = ((workspace.get("systems") or {}).get("include") or {}).get("mappings") or {}
    aliases = workspace.get("systemAliases") or list(mappings.keys())
    system_ids = []
    data_source_ids = []
    invalid = []
    for alias in aliases:
        mapping = mappings.get(alias)
        if not isinstance(mapping, dict):
            invalid.append(str(alias))
            continue
        system_id = str(mapping.get("system_id") or "").strip()
        data_source_id = str(mapping.get("data_source_id") or "").strip()
        if not system_id or not data_source_id:
            invalid.append(str(alias))
            continue
        if system_id not in system_ids:
            system_ids.append(system_id)
        if data_source_id not in data_source_ids:
            data_source_ids.append(data_source_id)
    if invalid:
        raise SystemExit(
            "SVN compact scope requires system_id and data_source_id in "
            "systems.include.mappings: " + ", ".join(invalid)
        )
    if not aliases:
        raise SystemExit("SVN compact scope requires systems.include.mappings")
    return system_ids, data_source_ids


def _compact_scope_values(workspace: dict) -> list[str]:
    """Normalize the optional compact ``svn.scope`` category list."""

    svn = workspace.get("svn") or {}
    configured = svn.get("scope")
    if configured is None:
        # ``svn_settings`` exposes the source YAML value as scopeEntries.
        configured = svn.get("scopeEntries")
    if configured in (None, "", []):
        return list(COMPACT_SCOPE_DEFAULT)
    if isinstance(configured, str):
        configured = configured.strip().strip("[]")
        configured = [part.strip() for part in configured.split(",") if part.strip()]
    if not isinstance(configured, (list, tuple)):
        raise SystemExit("svn.scope must be a list of compact source categories")
    values = []
    for raw in configured:
        value = str(raw or "").strip().casefold().replace("_", "-")
        value = COMPACT_SCOPE_ALIASES.get(value, value)
        if not value:
            continue
        if value not in COMPACT_SCOPE_NAMES:
            raise SystemExit(
                f"Unsupported compact SVN scope '{raw}'; use: "
                + ", ".join(sorted(COMPACT_SCOPE_NAMES))
            )
        if value not in values:
            values.append(value)
    return values or list(COMPACT_SCOPE_DEFAULT)


def build_manifest_from_workspace_config(workspace: dict) -> ImportResult:
    """Expand one compact workspace SVN config into exact child working copies.

    ``svn.url`` is a repository root.  ``systems`` and ``datasources`` scope
    names are expanded with IDs from the workspace's explicit
    ``systems.include.mappings``.  The returned manifest is intentionally a
    generated representation for ``context/authorized-scope.json``; users
    should edit the compact YAML instead.
    """

    settings = workspace.get("svn") or {}
    root_url = str(settings.get("scopeRootUrl") or settings.get("url") or "").strip()
    if not root_url:
        raise SystemExit(f"Missing svn.url for compact SVN scope: {workspace.get('workspaceKey') or ''}")
    scope_values = _compact_scope_values(workspace)
    needs_mapping = any(
        scope in {"systems", "datasources", "pages", "procedures", "tables", "views", "system-script"}
        for scope in scope_values
    )
    system_ids, data_source_ids = _workspace_mapping_ids(workspace) if needs_mapping else ([], [])
    entries = []
    for scope in scope_values:
        if scope in {"systems", "pages", "system-script"}:
            identifiers = system_ids
        elif scope in {"datasources", "procedures", "tables", "views"}:
            identifiers = data_source_ids
        else:
            identifiers = [""]
        for identifier in identifiers:
            path = scope if not identifier else f"{scope}/{identifier}"
            entries.append({
                "url": f"{root_url.rstrip('/')}/{path}",
                "localSubdir": path,
                "category": scope,
                "writable": scope not in {"skill", "public"},
            })
    if not entries:
        raise SystemExit(f"Compact SVN scope has no entries for {workspace.get('workspaceKey') or ''}")
    return build_manifest_from_config(
        json.dumps({"entries": entries}, ensure_ascii=False),
        str(workspace.get("workspaceKey") or ""),
    )


def build_manifest_from_workspace_input(text: str, workspace: dict) -> ImportResult:
    """Parse script/paste input, expanding a project-level checkout root.

    Platform project downloads can contain one checkout command for a root
    repository instead of one command per subsystem. When its category cannot
    be inferred, derive the allowed child directories from the workspace's
    explicit ``systems.include.mappings`` and feed them through the same
    exact-URL manifest validation.
    """

    workspace_key = str(workspace.get("workspaceKey") or "").strip()
    try:
        return build_manifest(text, workspace_key)
    except SystemExit as script_error:
        if "cannot infer a supported source category" not in str(script_error) and "destination must be relative" not in str(script_error):
            raise
    checkouts, duplicate_count = parse_checkout_script(text, allow_unknown_category=True)
    if not any(checkout.category == "aggregate" for checkout in checkouts):
        raise script_error
    if sum(checkout.category == "aggregate" for checkout in checkouts) > 1:
        raise SystemExit("A project-level SVN checkout root must be specified only once")
    raw_entries = []
    for checkout in checkouts:
        if checkout.category == "aggregate":
            raw_entries.append({
                "url": checkout.url,
                # A downloaded root script historically includes the common
                # directories as well. Compact YAML without ``scope`` is
                # intentionally narrower and uses mappings only.
                "checkoutPaths": ["skill", "public", *_workspace_checkout_paths(workspace)],
            })
        else:
            raw_entries.append({
                "url": checkout.url,
                "localSubdir": checkout.local_subdir,
                "category": checkout.category,
                "writable": checkout.category in WRITABLE_CATEGORIES,
            })
    result = build_manifest_from_config(
        json.dumps({"entries": raw_entries}, ensure_ascii=False),
        workspace_key,
    )
    return ImportResult(
        manifest=result.manifest,
        command_count=result.command_count + duplicate_count,
        duplicate_count=result.duplicate_count + duplicate_count,
    )


def _yaml_scope_entries(path: Path, workspace_key: str) -> list[object]:
    """Read only the selected workspace's ``svn.scope`` from products/projects."""

    try:
        import yaml  # type: ignore
    except ModuleNotFoundError:
        # The bundled runtime intentionally supports a tiny dependency-free
        # YAML subset. Reuse the same line parser for the selected nested list
        # so importing a script does not require installing another package.
        lines = path.read_text(encoding="utf-8").splitlines()
        workspace_start, workspace_end, workspace_indent = _workspace_region(lines, workspace_key)
        svn_region = _nested_key_region(lines, workspace_start, workspace_end, workspace_indent, {"svn"})
        if svn_region is None:
            return []
        svn_start, svn_end, svn_indent = svn_region
        scope_region = _nested_key_region(lines, svn_start, svn_end, svn_indent, {"scope", "entries"})
        if scope_region is None:
            return []
        scope_start, scope_end, _scope_indent = scope_region
        inline = re.search(r":\s*(\[[^]]*\])\s*(?:#.*)?$", lines[scope_start])
        if inline:
            return _scope_yaml_value(inline.group(1)) or []
        if re.search(r":\s*\[\s*\]\s*(?:#.*)?$", lines[scope_start]):
            return []
        body = lines[scope_start + 1 : scope_end]
        parsed = _parse_scope_config_lines("entries:\n" + "\n".join(body))
        return parsed.get("entries") or []
    try:
        document = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, UnicodeDecodeError) as error:
        raise SystemExit(f"Cannot read SVN workspace configuration: {path}") from error
    except Exception as error:
        raise SystemExit(f"Invalid YAML workspace configuration: {path}: {error}") from error
    kind, item_id = workspace_key.split(".", 1)
    collection = document.get(kind) if isinstance(document, dict) else None
    items = collection.get(kind) if isinstance(collection, dict) and isinstance(collection.get(kind), dict) else collection
    item = items.get(item_id) if isinstance(items, dict) else None
    if not isinstance(item, dict):
        raise SystemExit(f"Workspace {workspace_key} was not found in {path}")
    svn = item.get("svn")
    if svn is None:
        return []
    if not isinstance(svn, dict):
        raise SystemExit(f"svn must be a mapping for {workspace_key}: {path}")
    values = svn.get("scope")
    if values is None:
        values = svn.get("entries")
    if values is None:
        return []
    if not isinstance(values, list):
        raise SystemExit(f"svn.scope must be a list for {workspace_key}: {path}")
    return values


def _content_line(raw: str) -> bool:
    stripped = raw.strip()
    return bool(stripped) and not stripped.startswith("#")


def _indent(raw: str) -> int:
    return len(raw) - len(raw.lstrip(" "))


def _workspace_region(lines: list[str], workspace_key: str) -> tuple[int, int, int]:
    kind, item_id = workspace_key.split(".", 1)
    section_start = None
    section_indent = None
    for index, raw in enumerate(lines):
        if _content_line(raw) and _indent(raw) == 0 and raw.strip() == f"{kind}:":
            section_start = index
            section_indent = 0
            break
    if section_start is None:
        raise SystemExit(f"Missing {kind}: section in workspace configuration")
    workspace_start = None
    workspace_indent = None
    for index in range(section_start + 1, len(lines)):
        raw = lines[index]
        if not _content_line(raw):
            continue
        indent = _indent(raw)
        if indent <= section_indent:
            break
        if indent == section_indent + 2 and re.match(rf"^{re.escape(item_id)}:\s*(?:#.*)?$", raw.strip()):
            workspace_start = index
            workspace_indent = indent
            break
    if workspace_start is None:
        raise SystemExit(f"Workspace {workspace_key} was not found in products/projects.yaml")
    workspace_end = len(lines)
    for index in range(workspace_start + 1, len(lines)):
        if _content_line(lines[index]) and _indent(lines[index]) <= workspace_indent:
            workspace_end = index
            break
    return workspace_start, workspace_end, workspace_indent


def _nested_key_region(
    lines: list[str], start: int, end: int, parent_indent: int, key_names: set[str]
) -> tuple[int, int, int] | None:
    key_start = None
    key_indent = None
    for index in range(start + 1, end):
        raw = lines[index]
        if not _content_line(raw):
            continue
        indent = _indent(raw)
        if indent <= parent_indent:
            break
        if indent > parent_indent and raw.strip().split(":", 1)[0] in key_names:
            key_start = index
            key_indent = indent
            break
    if key_start is None:
        return None
    key_end = end
    for index in range(key_start + 1, end):
        if _content_line(lines[index]) and _indent(lines[index]) <= key_indent:
            key_end = index
            break
    return key_start, key_end, key_indent


def _render_scope_entries(entries: list[dict], indent: int) -> list[str]:
    prefix = " " * indent
    child = " " * (indent + 2)
    lines = []
    for entry in entries:
        lines.extend([
            f'{prefix}- id: {json.dumps(entry["id"], ensure_ascii=False)}',
            f'{child}url: {json.dumps(entry["url"], ensure_ascii=False)}',
            f'{child}localSubdir: {json.dumps(entry["localSubdir"], ensure_ascii=False)}',
            f'{child}category: {entry["category"]}',
            f'{child}writable: {"true" if entry.get("writable") else "false"}',
        ])
    return lines


def _direct_yaml_key_index(
    lines: list[str], start: int, end: int, parent_indent: int, key_name: str
) -> int | None:
    for index in range(start + 1, end):
        raw = lines[index]
        if _content_line(raw) and _indent(raw) == parent_indent + 2:
            if raw.strip().split(":", 1)[0] == key_name:
                return index
    return None


def _compact_scope_root(result: ImportResult) -> str:
    """Infer the shared repository root from expanded checkout entries."""

    roots = []
    for entry in result.manifest.get("entries") or []:
        url = urlsplit(str(entry.get("url") or ""))
        local_parts = PurePosixPath(str(entry.get("localSubdir") or "")).parts
        if not url.scheme or not url.netloc or not local_parts:
            continue
        category = local_parts[0]
        remote_parts = tuple(part for part in PurePosixPath(url.path).parts if part != "/")
        try:
            category_index = remote_parts.index(category)
        except ValueError:
            continue
        root_path = "/" + "/".join(remote_parts[:category_index])
        roots.append((url.scheme, url.netloc, root_path.rstrip("/")))
    if not roots:
        raise SystemExit("Unable to infer compact SVN root URL from checkout entries")
    first = roots[0]
    if any(root != first for root in roots[1:]):
        raise SystemExit("Checkout entries do not share one SVN root URL")
    return f"{first[0]}://{first[1]}{first[2]}"


def _compact_config_values(result: ImportResult, workspace: dict) -> tuple[str, list[str]]:
    settings = workspace.get("svn") or {}
    root = str(settings.get("scopeRootUrl") or "").strip().rstrip("/")
    if not root:
        root = _compact_scope_root(result)
    scopes = []
    for entry in result.manifest.get("entries") or []:
        local = PurePosixPath(str(entry.get("localSubdir") or ""))
        if not local.parts:
            continue
        category = local.parts[0]
        category = COMPACT_SCOPE_ALIASES.get(category.casefold(), category.casefold())
        if category in COMPACT_SCOPE_NAMES and category not in scopes:
            scopes.append(category)
    if not scopes:
        scopes = list(COMPACT_SCOPE_DEFAULT)
    return root, scopes


def _compact_mapping_is_ready(workspace: dict, result: ImportResult) -> bool:
    mapped_categories = {
        "systems",
        "datasources",
        "pages",
        "procedures",
        "tables",
        "views",
        "system-script",
    }
    if not any(
        PurePosixPath(str(entry.get("localSubdir") or "")).parts
        and PurePosixPath(str(entry.get("localSubdir") or "")).parts[0] in mapped_categories
        for entry in result.manifest.get("entries") or []
    ):
        return True
    mappings = workspace.get("systemMappings")
    if not isinstance(mappings, dict):
        mappings = ((workspace.get("systems") or {}).get("include") or {}).get("mappings") or {}
    aliases = workspace.get("systemAliases") or list(mappings)
    return bool(aliases) and all(
        isinstance(mappings.get(alias), dict)
        and str(mappings[alias].get("system_id") or "").strip()
        and str(mappings[alias].get("data_source_id") or "").strip()
        for alias in aliases
    )


def _render_compact_scope(root: str, scopes: list[str], indent: int) -> list[str]:
    prefix = " " * indent
    child = " " * (indent + 2)
    return [
        f"{prefix}url: {json.dumps(root, ensure_ascii=False)}",
        f"{prefix}scope:",
        *[f"{child}- {scope}" for scope in scopes],
    ]


def _merge_compact_scope_config(path: Path, workspace_key: str, result: ImportResult, workspace: dict) -> dict:
    root, scopes = _compact_config_values(result, workspace)
    existing_scope_values = _yaml_scope_entries(path, workspace_key)
    preserved_scopes = []
    for raw in existing_scope_values:
        if not isinstance(raw, str):
            continue
        value = raw.strip().casefold().replace("_", "-")
        value = COMPACT_SCOPE_ALIASES.get(value, value)
        if value in COMPACT_SCOPE_NAMES and value not in preserved_scopes:
            preserved_scopes.append(value)
    scopes = preserved_scopes + [scope for scope in scopes if scope not in preserved_scopes]
    lines = path.read_text(encoding="utf-8").splitlines()
    workspace_start, workspace_end, workspace_indent = _workspace_region(lines, workspace_key)
    svn_region = _nested_key_region(lines, workspace_start, workspace_end, workspace_indent, {"svn"})
    if svn_region is None:
        insertion = [
            "",
            " " * (workspace_indent + 2) + "svn:",
            *_render_compact_scope(root, scopes, workspace_indent + 4),
        ]
        lines[workspace_end:workspace_end] = insertion
    else:
        svn_start, svn_end, svn_indent = svn_region
        url_index = _direct_yaml_key_index(lines, svn_start, svn_end, svn_indent, "url")
        if url_index is None:
            lines[svn_start + 1 : svn_start + 1] = [
                f"{' ' * (svn_indent + 2)}url: {json.dumps(root, ensure_ascii=False)}"
            ]
            svn_end += 1
        else:
            existing_url = lines[url_index].split(":", 1)[1].strip()
            if existing_url not in {json.dumps(root, ensure_ascii=False), root}:
                raise SystemExit(f"SVN compact root URL conflicts with existing config: {path}")
        scope_region = _nested_key_region(lines, svn_start, svn_end, svn_indent, {"scope", "entries"})
        if scope_region is None:
            lines[svn_end:svn_end] = [
                *_render_compact_scope(root, scopes, svn_indent + 2)[1:],
            ]
        else:
            scope_start, scope_end, scope_indent = scope_region
            old_line = lines[scope_start]
            comment = ""
            if "#" in old_line:
                comment = old_line[old_line.index("#") :].strip()
            replacement = [f"{' ' * scope_indent}scope:" + (f"  {comment}" if comment else "")]
            replacement.extend(f"{' ' * (scope_indent + 2)}- {scope}" for scope in scopes)
            lines[scope_start:scope_end] = replacement
    rendered = "\n".join(lines) + "\n"
    if rendered == path.read_text(encoding="utf-8"):
        return {
            "ok": True,
            "written": False,
            "output": str(path),
            "workspaceKey": workspace_key,
            "added": 0,
            "duplicatesSkipped": result.duplicate_count,
            "entries": len(result.manifest.get("entries") or []),
            "url": root,
            "scope": scopes,
        }
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(rendered, encoding="utf-8")
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()
    return {
        "ok": True,
        "written": True,
        "output": str(path),
        "workspaceKey": workspace_key,
        "added": len(result.manifest.get("entries") or []),
        "duplicatesSkipped": result.duplicate_count,
        "entries": len(result.manifest.get("entries") or []),
        "url": root,
        "scope": scopes,
    }


def merge_scope_config(
    path: Path,
    workspace_key: str,
    result: ImportResult,
    workspace: dict | None = None,
) -> dict:
    """Append parsed entries to the selected products/projects ``svn.scope``.

    The operation is deliberately textual: existing comments, ordering and
    hand-written values remain untouched.  Only new, validated entries are
    inserted into the target list.
    """

    path = Path(path).expanduser().resolve()
    if not path.is_file():
        raise SystemExit(f"Missing SVN workspace configuration: {path}")
    if workspace is not None and _compact_mapping_is_ready(workspace, result):
        return _merge_compact_scope_config(path, workspace_key, result, workspace)
    existing_raw = _yaml_scope_entries(path, workspace_key)
    existing_result = None
    if existing_raw:
        existing_result = build_manifest_from_config(
            json.dumps({"entries": existing_raw}, ensure_ascii=False), workspace_key
        )
    existing_keys = {
        (entry["url"], entry["localSubdir"])
        for entry in (existing_result.manifest.get("entries") if existing_result else [])
    }
    existing_entries = existing_result.manifest.get("entries") if existing_result else []
    existing_by_url = {entry["url"]: entry["localSubdir"] for entry in existing_entries}
    existing_by_subdir = {
        entry["localSubdir"].casefold(): entry["url"] for entry in existing_entries
    }
    for entry in result.manifest.get("entries") or []:
        old_subdir = existing_by_url.get(entry["url"])
        if old_subdir is not None and old_subdir != entry["localSubdir"]:
            raise SystemExit(
                f"SVN URL already has a different localSubdir in {path}: {entry['url']}"
            )
        old_url = existing_by_subdir.get(entry["localSubdir"].casefold())
        if old_url is not None and old_url != entry["url"]:
            raise SystemExit(
                f"SVN localSubdir already belongs to a different URL in {path}: {entry['localSubdir']}"
            )
    additions = [
        entry
        for entry in result.manifest.get("entries") or []
        if (entry["url"], entry["localSubdir"]) not in existing_keys
    ]
    duplicate_count = result.duplicate_count + (len(result.manifest.get("entries") or []) - len(additions))
    if not additions:
        return {
            "ok": True,
            "written": False,
            "output": str(path),
            "workspaceKey": workspace_key,
            "added": 0,
            "duplicatesSkipped": duplicate_count,
            "entries": len(existing_keys),
        }

    lines = path.read_text(encoding="utf-8").splitlines()
    workspace_start, workspace_end, workspace_indent = _workspace_region(lines, workspace_key)
    svn_region = _nested_key_region(lines, workspace_start, workspace_end, workspace_indent, {"svn"})
    if svn_region is None:
        insertion = [""] + [
            " " * (workspace_indent + 2) + "svn:",
            " " * (workspace_indent + 4) + "scope:",
            *_render_scope_entries(additions, workspace_indent + 6),
        ]
        lines[workspace_end:workspace_end] = insertion
    else:
        svn_start, svn_end, svn_indent = svn_region
        scope_region = _nested_key_region(lines, svn_start, svn_end, svn_indent, {"scope", "entries"})
        if scope_region is None:
            insertion = [
                " " * (svn_indent + 2) + "scope:",
                *_render_scope_entries(additions, svn_indent + 4),
            ]
            lines[svn_end:svn_end] = insertion
        else:
            scope_start, scope_end, scope_indent = scope_region
            scope_line = lines[scope_start]
            if re.search(r":\s*\[\s*\]\s*(?:#.*)?$", scope_line):
                lines[scope_start] = re.sub(r":\s*\[\s*\]\s*(?=#|$)", ":", scope_line, count=1)
            lines[scope_end:scope_end] = _render_scope_entries(additions, scope_indent + 2)

    rendered = "\n".join(lines) + "\n"
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(rendered, encoding="utf-8")
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()
    return {
        "ok": True,
        "written": True,
        "output": str(path),
        "workspaceKey": workspace_key,
        "added": len(additions),
        "duplicatesSkipped": duplicate_count,
        "entries": len(existing_keys) + len(additions),
    }


def _manifest_entries(payload: object) -> dict[tuple[str, str], dict]:
    if not isinstance(payload, dict) or not isinstance(payload.get("entries"), list):
        return {}
    return {
        (str(entry.get("url") or ""), str(entry.get("localSubdir") or "")): entry
        for entry in payload["entries"]
        if isinstance(entry, dict)
    }


def _change_counts(previous: object, current: dict) -> tuple[int, int, int]:
    old_entries = _manifest_entries(previous)
    new_entries = _manifest_entries(current)
    old_keys = set(old_entries)
    new_keys = set(new_entries)
    modified = sum(old_entries[key] != new_entries[key] for key in old_keys & new_keys)
    return len(new_keys - old_keys), len(old_keys - new_keys), modified


def write_manifest(path: Path, result: ImportResult, replace: bool = False) -> dict:
    rendered = json.dumps(result.manifest, ensure_ascii=False, indent=2) + "\n"
    previous = None
    if path.exists():
        try:
            previous_text = path.read_text(encoding="utf-8")
            previous = json.loads(previous_text)
        except (OSError, json.JSONDecodeError) as error:
            if not replace:
                raise SystemExit(f"Existing scope manifest is invalid; use --replace to overwrite it: {path}") from error
            previous_text = ""
        if previous_text == rendered:
            return _summary(path, result, previous, written=False)
        if not replace:
            added, removed, modified = _change_counts(previous, result.manifest)
            raise SystemExit(
                f"Scope manifest differs: added={added}, removed={removed}, modified={modified}. "
                f"Review the checkout script and rerun with --replace: {path}"
            )
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(rendered, encoding="utf-8")
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()
    return _summary(path, result, previous, written=True)


def _summary(path: Path, result: ImportResult, previous: object, written: bool) -> dict:
    added, removed, modified = _change_counts(previous, result.manifest)
    counts = Counter(entry["category"] for entry in result.manifest["entries"])
    return {
        "ok": True,
        "written": written,
        "output": str(path),
        "workspaceKey": result.manifest["workspaceKey"],
        "commands": result.command_count,
        "entries": len(result.manifest["entries"]),
        "duplicatesSkipped": result.duplicate_count,
        "excludedBySystemAliases": result.command_count - result.duplicate_count - len(result.manifest["entries"]),
        "selection": result.manifest.get("selection") or {},
        "added": added,
        "removed": removed,
        "modified": modified,
        "categories": dict(sorted(counts.items())),
    }

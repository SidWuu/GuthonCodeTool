"""Convert exact SVN checkout commands from a platform BAT into a scope manifest."""

from __future__ import annotations

import hashlib
import json
import os
import re
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
WRITABLE_CATEGORIES = {"pages", "procedures", "system-script"}
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


def read_bat(path: Path) -> str:
    try:
        content = path.read_bytes()
    except OSError as error:
        raise SystemExit(f"Cannot read SVN checkout BAT: {path}") from error
    if content.startswith((b"\xff\xfe", b"\xfe\xff")):
        try:
            return content.decode("utf-16")
        except UnicodeDecodeError as error:
            raise SystemExit(f"Cannot decode SVN checkout BAT: {path}") from error
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise SystemExit(f"Cannot decode SVN checkout BAT as UTF-8 or GB18030: {path}")


def _logical_lines(text: str):
    buffered = ""
    start_line = 0
    for line_number, physical in enumerate(text.splitlines(), 1):
        line = physical.rstrip()
        if not buffered:
            start_line = line_number
        continued = bool(re.search(r"(?<!\^)\^$", line))
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
        if char in {"&", "|"}:
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


def _parse_statement(statement: str, line_number: int) -> ParsedCheckout | None:
    text = statement.lstrip(" @(\t")
    tokens = _tokens(text)
    if not tokens:
        return None
    first = tokens[0].lstrip("@").casefold()
    if first in {"rem", "echo", "::"} or first.startswith("::"):
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
    local_subdir = normalize_scope_subdir(raw_subdir, f"line-{line_number}")
    local_category = _category_from_path(local_subdir)
    remote_category = _category_from_path(urlsplit(url).path)
    if local_category and remote_category and local_category != remote_category:
        raise SystemExit(
            f"Line {line_number}: checkout category differs between URL ({remote_category}) "
            f"and destination ({local_category})"
        )
    category = local_category or remote_category
    if not category:
        raise SystemExit(f"Line {line_number}: cannot infer a supported source category")
    return ParsedCheckout(line=line_number, url=url, local_subdir=local_subdir, category=category)


def parse_bat(text: str) -> tuple[list[ParsedCheckout], int]:
    parsed = []
    exact_seen = set()
    duplicate_count = 0
    for line_number, line in _logical_lines(text):
        for statement in _statements(line):
            checkout = _parse_statement(statement, line_number)
            if checkout is None:
                continue
            exact_key = (checkout.url, checkout.local_subdir)
            if exact_key in exact_seen:
                duplicate_count += 1
                continue
            exact_seen.add(exact_key)
            parsed.append(checkout)
    if not parsed:
        raise SystemExit("No executable SVN checkout commands were found in the BAT")
    _validate_checkouts(parsed)
    return parsed, duplicate_count


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
    checkouts, duplicate_count = parse_bat(text)
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
                f"Review the BAT and rerun with --replace: {path}"
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

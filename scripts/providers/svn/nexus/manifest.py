"""Load and validate the exact SVN authorization manifest."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from urllib.parse import urlsplit, urlunsplit


SCHEMA_VERSION = 1
STATE_VERSION = 3
SAFE_ENTRY_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
SUPPORTED_CATEGORIES = {
    "systems",
    "datasources",
    "pages",
    "procedures",
    "system-script",
    "tables",
    "views",
    "skill",
    "public",
}

WRITABLE_SOURCE_CATEGORIES = {"pages", "procedures", "system-script"}
WRITABLE_SOURCE_SUFFIXES = {
    "pages": {".json", ".gss"},
    "procedures": {".gss"},
    "system-script": {".gss", ".js", ".vm", ".sql"},
}


def source_category(entry: "ScopeEntry", relative_path: object) -> str:
    """Return the logical source category inside one physical working copy."""

    relative = PurePosixPath(str(relative_path or "").replace("\\", "/"))
    if entry.category == "systems":
        return relative.parts[0] if relative.parts and relative.parts[0] in {"pages", "system-script"} else ""
    if entry.category == "datasources":
        return relative.parts[0] if relative.parts and relative.parts[0] in {"procedures", "tables", "views"} else ""
    return entry.category


def source_relative_path(entry: "ScopeEntry", relative_path: object) -> PurePosixPath:
    """Strip the aggregate source directory while preserving legacy layouts."""

    relative = PurePosixPath(str(relative_path or "").replace("\\", "/"))
    if getattr(entry, "category", "") in {"systems", "datasources"} and relative.parts:
        return PurePosixPath(*relative.parts[1:])
    return relative


def source_path_writable(entry: "ScopeEntry", relative_path: object) -> bool:
    """Apply logical object write rules to mixed aggregate working copies."""

    relative = PurePosixPath(str(relative_path or "").replace("\\", "/"))
    category = source_category(entry, relative)
    return bool(
        entry.writable
        and category in WRITABLE_SOURCE_CATEGORIES
        and relative.suffix.lower() in WRITABLE_SOURCE_SUFFIXES[category]
        and relative.name.casefold() != "index.md"
    )


@dataclass(frozen=True)
class ScopeEntry:
    id: str
    category: str
    url: str
    local_subdir: str
    writable: bool
    root: Path

    def public_dict(self) -> dict:
        return {
            "id": self.id,
            "category": self.category,
            "url": self.url,
            "localSubdir": self.local_subdir,
            "writable": self.writable,
            "root": str(self.root),
        }


@dataclass(frozen=True)
class AuthorizedScope:
    workspace_key: str
    path: Path
    entries: tuple[ScopeEntry, ...]
    digest: str


def normalize_scope_url(raw_url: object, entry_id: str) -> str:
    text = str(raw_url or "").strip().rstrip("/")
    parsed = urlsplit(text)
    if parsed.scheme not in {"http", "https", "svn", "svn+ssh", "file"}:
        raise SystemExit(f"Unsupported SVN URL scheme for scope entry {entry_id}")
    if parsed.username or parsed.password:
        raise SystemExit(f"SVN credentials must not be embedded in scope entry {entry_id}")
    if not parsed.path:
        raise SystemExit(f"Missing SVN URL path for scope entry {entry_id}")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), parsed.query, ""))


def normalize_scope_subdir(raw_subdir: object, entry_id: str) -> str:
    text = str(raw_subdir or "").strip().replace("\\", "/")
    path = PurePosixPath(text)
    if (
        not text
        or path.is_absolute()
        or PureWindowsPath(text).is_absolute()
        or any(part in {"", ".", ".."} for part in path.parts)
    ):
        raise SystemExit(f"Unsafe localSubdir for scope entry {entry_id}: {text}")
    return path.as_posix()


def _entry_root(checkout_path: Path, local_subdir: str, entry_id: str) -> Path:
    checkout_root = checkout_path.resolve()
    root = (checkout_root / local_subdir).resolve()
    if root == checkout_root or checkout_root not in root.parents:
        raise SystemExit(f"Scope entry escapes checkout root {entry_id}: {local_subdir}")
    return root


def scope_paths_overlap(left: PurePosixPath, right: PurePosixPath) -> bool:
    return left == right or left in right.parents or right in left.parents


def load_authorized_scope(workspace: dict) -> AuthorizedScope:
    settings = workspace.get("svn") or {}
    if settings.get("checkoutLayout") != "manifest-working-copies":
        raise SystemExit(f"Workspace does not use manifest-working-copies: {workspace['workspaceKey']}")
    manifest_path = settings.get("scopeManifestPath")
    if not isinstance(manifest_path, Path):
        raise SystemExit(f"Missing SVN scope manifest path for {workspace['workspaceKey']}")
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise SystemExit(f"Missing SVN authorization manifest: {manifest_path}") from error
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Invalid SVN authorization manifest: {manifest_path}") from error
    if not isinstance(payload, dict) or payload.get("schemaVersion") != SCHEMA_VERSION:
        raise SystemExit(f"Unsupported SVN authorization manifest schema: {manifest_path}")
    if payload.get("workspaceKey") != workspace["workspaceKey"]:
        raise SystemExit(f"SVN authorization manifest does not match {workspace['workspaceKey']}")
    raw_entries = payload.get("entries")
    if not isinstance(raw_entries, list) or not raw_entries:
        raise SystemExit(f"SVN authorization manifest has no entries: {manifest_path}")

    entries = []
    ids = set()
    urls = set()
    subdirs: list[PurePosixPath] = []
    for raw in raw_entries:
        if not isinstance(raw, dict):
            raise SystemExit(f"SVN scope entry must be an object: {manifest_path}")
        entry_id = str(raw.get("id") or "").strip()
        if not SAFE_ENTRY_ID.fullmatch(entry_id) or entry_id in {".", ".."}:
            raise SystemExit(f"Unsafe or missing SVN scope entry id: {entry_id}")
        if entry_id in ids:
            raise SystemExit(f"Duplicate SVN scope entry id: {entry_id}")
        ids.add(entry_id)
        category = str(raw.get("category") or "").strip()
        if category not in SUPPORTED_CATEGORIES:
            raise SystemExit(f"Unsupported category for scope entry {entry_id}: {category}")
        url = normalize_scope_url(raw.get("url"), entry_id)
        if url in urls:
            raise SystemExit(f"Duplicate SVN scope entry URL: {entry_id}")
        urls.add(url)
        local_subdir = normalize_scope_subdir(raw.get("localSubdir"), entry_id)
        posix_subdir = PurePosixPath(local_subdir)
        if any(scope_paths_overlap(posix_subdir, existing) for existing in subdirs):
            raise SystemExit(f"Overlapping SVN scope localSubdir: {local_subdir}")
        subdirs.append(posix_subdir)
        writable = raw.get(
            "writable",
            category in {"systems", "datasources", "pages", "procedures", "system-script"},
        )
        if not isinstance(writable, bool):
            raise SystemExit(f"writable must be boolean for scope entry {entry_id}")
        entries.append(
            ScopeEntry(
                id=entry_id,
                category=category,
                url=url,
                local_subdir=local_subdir,
                writable=writable,
                root=_entry_root(workspace["checkoutPath"], local_subdir, entry_id),
            )
        )

    canonical = {
        "schemaVersion": SCHEMA_VERSION,
        "workspaceKey": workspace["workspaceKey"],
        "entries": [
            {
                "id": entry.id,
                "category": entry.category,
                "url": entry.url,
                "localSubdir": entry.local_subdir,
                "writable": entry.writable,
            }
            for entry in entries
        ],
    }
    digest = hashlib.sha256(
        json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return AuthorizedScope(
        workspace_key=workspace["workspaceKey"],
        path=manifest_path,
        entries=tuple(entries),
        digest=digest,
    )


def resolve_authorized_path(
    scope: AuthorizedScope,
    logical_path: object,
) -> tuple[ScopeEntry, Path, str]:
    """Resolve one logical checkout path without escaping or crossing scope entries."""

    text = str(logical_path or "").strip().replace("\\", "/")
    normalized_path = PurePosixPath(text)
    if (
        not text
        or normalized_path.is_absolute()
        or any(part in {"", ".."} for part in normalized_path.parts)
    ):
        raise SystemExit(f"Unsafe SVN scope path: {logical_path}")
    normalized = normalized_path.as_posix()
    matches = []
    for entry in scope.entries:
        prefix = entry.local_subdir
        if normalized == prefix:
            matches.append((entry, entry.root, "."))
        elif normalized.startswith(prefix + "/"):
            relative = normalized[len(prefix) + 1:]
            target = (entry.root / relative).resolve()
            root = entry.root.resolve()
            if target == root or root in target.parents:
                matches.append((entry, target, relative))
    if len(matches) != 1:
        raise SystemExit(f"Path is outside or ambiguous in the authorized SVN scope: {logical_path}")
    return matches[0]

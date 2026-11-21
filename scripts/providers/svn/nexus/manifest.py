"""Load and validate the exact SVN authorization manifest."""

from __future__ import annotations

from common.svn_scope import (AuthorizedScope, SAFE_ENTRY_ID, SCHEMA_VERSION, SUPPORTED_CATEGORIES, ScopeEntry, WRITABLE_SOURCE_CATEGORIES, _entry_root, load_authorized_scope, normalize_scope_subdir, normalize_scope_url, scope_paths_overlap)

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from urllib.parse import urlsplit, urlunsplit


STATE_VERSION = 3

WRITABLE_SOURCE_SUFFIXES = {
    "views": {".json"},
    "pages": {".json", ".gss"},
    "procedures": {".gss"},
    "system-script": {".gss", ".js", ".vm", ".sql"},
}


def source_category(entry: "ScopeEntry", relative_path: object) -> str:
    """Return the logical source category inside one physical working copy."""

    relative = PurePosixPath(str(relative_path or "").replace("\\", "/"))
    if getattr(entry, "category", "") == "root":
        parts = relative.parts
        if len(parts) >= 3 and parts[0] == "systems" and parts[2] in {"pages", "system-script"}:
            return parts[2]
        if len(parts) >= 3 and parts[0] == "datasources" and parts[2] in {"procedures", "tables", "views"}:
            return parts[2]
        if len(parts) >= 2 and parts[0] in {"pages", "system-script", "procedures", "tables", "views"}:
            return parts[0]
        if parts and parts[0] in {"skill", "public"}:
            return parts[0]
        return ""
    if entry.category == "systems":
        return relative.parts[0] if relative.parts and relative.parts[0] in {"pages", "system-script"} else ""
    if entry.category == "datasources":
        return relative.parts[0] if relative.parts and relative.parts[0] in {"procedures", "tables", "views"} else ""
    return entry.category


def source_relative_path(entry: "ScopeEntry", relative_path: object) -> PurePosixPath:
    """Strip the aggregate source directory while preserving legacy layouts."""

    relative = PurePosixPath(str(relative_path or "").replace("\\", "/"))
    if getattr(entry, "category", "") == "root":
        parts = relative.parts
        if len(parts) >= 3 and parts[0] in {"systems", "datasources"}:
            return PurePosixPath(*parts[3:])
        if len(parts) >= 2 and parts[0] in {"pages", "system-script", "procedures", "tables", "views"}:
            return PurePosixPath(*parts[2:])
        return relative
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
        and not relative.name.casefold().endswith(".inherit.gss")
    )


def source_identity(entry: "ScopeEntry", relative_path: object) -> str:
    """Return the system or datasource ID that owns a source path."""

    relative = PurePosixPath(str(relative_path or "").replace("\\", "/"))
    if getattr(entry, "category", "") == "root":
        parts = relative.parts
        if len(parts) >= 3 and parts[0] in {"systems", "datasources"}:
            return parts[1]
        if len(parts) >= 2 and parts[0] in {"pages", "system-script", "procedures", "tables", "views"}:
            return parts[1]
        return ""
    return Path(entry.local_subdir).name




def logical_path_for_entry(entry: ScopeEntry, relative_path: object) -> str:
    """Return the canonical logical path for a file inside one working copy."""

    relative = PurePosixPath(str(relative_path or "").replace("\\", "/"))
    normalized = relative.as_posix()
    if entry.category == "root":
        return "" if normalized == "." else normalized
    return entry.local_subdir if normalized == "." else f"{entry.local_subdir}/{normalized}"


def relative_path_for_entry(entry: ScopeEntry, logical_path: object) -> PurePosixPath:
    """Return a working-copy-relative path from a canonical logical path.

    A repository-root working copy intentionally exposes paths such as
    ``datasources/0002/tables/PR_COMPANY.json`` without its physical
    ``localSubdir`` prefix.  Other working-copy categories retain that prefix.
    """

    logical = PurePosixPath(str(logical_path or "").strip().replace("\\", "/"))
    if entry.category == "root":
        return logical
    return logical.relative_to(PurePosixPath(entry.local_subdir.replace("\\", "/")))




def scope_entry_label(workspace: dict, entry: ScopeEntry) -> str:
    """Return a business label for one physical SVN working copy."""

    identity = Path(entry.local_subdir).name or ("根目录" if entry.category == "root" else entry.id)
    aliases = []
    for alias, mapping in (workspace.get("systemMappings") or {}).items():
        if not isinstance(mapping, dict):
            continue
        expected = (
            mapping.get("system_id")
            if entry.category in {"systems", "pages", "system-script"}
            else mapping.get("data_source_id")
            if entry.category in {"datasources", "procedures", "tables", "views"}
            else None
        )
        if str(expected or "").strip() == identity:
            aliases.append(str(alias))
    business_name = " / ".join(aliases) or identity
    category = {
        "root": "完整仓库",
        "systems": "系统源码",
        "datasources": "数据源源码",
        "pages": "页面源码",
        "procedures": "过程函数源码",
        "system-script": "系统脚本源码",
        "tables": "表结构",
        "views": "视图源码",
        "skill": "Skill",
        "public": "公共源码",
    }.get(entry.category, entry.category)
    return f"{business_name} · {category} · {entry.id}"












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
        if entry.category == "root":
            target = (entry.root / normalized).resolve()
            root = entry.root.resolve()
            if target == root or root in target.parents:
                matches.append((entry, target, normalized))
        elif normalized == prefix:
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

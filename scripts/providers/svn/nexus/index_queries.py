"""Workspace-scoped queries over the derived SVN call index."""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path, PurePosixPath
from urllib.parse import unquote

from .manifest import load_authorized_scope


SUMMARY = re.compile(r"<summary>\s*(?P<label>.*?)\s*</summary>", re.IGNORECASE)
PAGE_MENU = re.compile(r"^\s*-\s*📄\s*(?P<label>.*?)\s*$")
PAGE_LINK = re.compile(r"^\s*-\s*\[(?P<label>[^]]+)]\((?P<path>[^)]+)\)")
SOURCE_ICONS = ("📂", "⭐", "📄", "🏠", "📦", "🧊", "🔰", "⚡", "📊", "🐳", "🌏")


def _connection(workspace: dict) -> sqlite3.Connection:
    if not workspace["indexPath"].is_file():
        raise SystemExit(f"SVN call index is not initialized for {workspace['workspaceKey']}")
    connection = sqlite3.connect(workspace["indexPath"])
    connection.row_factory = sqlite3.Row
    return connection


def _display_label(value: str) -> str:
    label = str(value or "").strip()
    while label.startswith("-"):
        label = label[1:].strip()
    for icon in SOURCE_ICONS:
        if label.startswith(icon):
            return label[len(icon):].strip()
    return label


def _page_index_locations(path: Path) -> dict[str, dict]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        return {}
    directories = []
    current_menu = ""
    locations = {}
    for line in lines:
        summary = SUMMARY.search(line)
        if summary:
            label = _display_label(summary.group("label"))
            if label:
                directories.append(label)
            current_menu = ""
            continue
        if line.strip().lower() == "</details>":
            if directories:
                directories.pop()
            current_menu = ""
            continue
        menu = PAGE_MENU.match(line)
        if menu:
            current_menu = _display_label(menu.group("label"))
            continue
        link = PAGE_LINK.match(line)
        if not link:
            continue
        target = unquote(link.group("path").split("#", 1)[0].split("?", 1)[0]).replace("\\", "/")
        normalized = PurePosixPath(target)
        if normalized.is_absolute() or ".." in normalized.parts:
            continue
        relative = normalized.as_posix().lstrip("./")
        if not relative:
            continue
        locations.setdefault(
            relative,
            {
                "directories": [*directories, *([current_menu] if current_menu else [])],
                "label": _display_label(link.group("label")),
            },
        )
    return locations


def _system_name(entry) -> str:
    try:
        markers = sorted(child.name[2:] for child in entry.root.iterdir() if child.name.startswith("$.") and child.name[2:])
    except OSError:
        markers = []
    return markers[0] if markers else Path(entry.local_subdir).name


def _relative_source_path(entry, source_path: str) -> PurePosixPath | None:
    logical = PurePosixPath(str(source_path or ""))
    prefix = PurePosixPath(entry.local_subdir)
    try:
        return logical.relative_to(prefix)
    except ValueError:
        return None


def _tree_metadata(entry, row: dict, page_locations: dict[str, dict], system_name: str) -> tuple[list[str], str]:
    relative = _relative_source_path(entry, row["source_path"])
    if relative is None:
        return [], row.get("source_name") or row["source_id"]
    source_type = row["source_table"]
    if source_type == "page":
        location = page_locations.get(relative.as_posix())
        if location:
            label = location["label"]
            if relative.suffix.lower() == ".gss":
                label = f"GSS · {label}"
            return [system_name, *location["directories"]], label
        return [system_name, "未编入 index.md", *relative.parts[:-1]], row.get("source_name") or row["source_id"]
    if source_type == "system-script":
        return [system_name, *relative.parts[:-1]], relative.name
    entry_parts = PurePosixPath(entry.local_subdir).parts
    physical_directories = [*entry_parts[1:], *relative.parts[:-1]]
    if source_type == "procedure":
        return physical_directories, f"{row['fun_id']} {row['source_alias_id']}".strip()
    if source_type in {"table", "view"}:
        identity = row["source_id"]
        name = row.get("source_name") or ""
        return physical_directories, f"{identity} {name}".strip() if name != identity else identity
    return [*relative.parts[:-1]], relative.name


def _catalog_fragments(row: dict):
    source_type = row["source_table"]
    suffix = Path(row["source_path"]).suffix.lower()
    if source_type == "page" and suffix == ".json":
        return None
    fixed = {
        "page": ("gss", ""),
        "procedure": ("procedure_script", ""),
        "system-script": ("system_script", ""),
        "view": ("view_sql", "/viewSql"),
    }.get(source_type)
    return [{"scriptType": fixed[0], "jsonPointer": fixed[1], "label": ""}] if fixed else []


def catalog(workspace: dict) -> dict:
    scope = load_authorized_scope(workspace)
    entries = {entry.id: entry for entry in scope.entries}
    connection = _connection(workspace)
    try:
        rows = [
            dict(row)
            for row in connection.execute(
                """
                SELECT source_table, source_id, source_alias_id, fun_id, source_name, source_path,
                       local_path, working_copy_id, scope_entry_id, status
                FROM gusen_source_record
                WHERE provider='svn'
                ORDER BY source_path
                """
            ).fetchall()
        ]
    finally:
        connection.close()
    page_locations = {}
    system_names = {}
    for entry in scope.entries:
        system_names[entry.id] = _system_name(entry)
        if entry.category == "pages":
            page_locations[entry.id] = _page_index_locations(entry.root / "index.md")
    objects = []
    counts = {}
    for row in rows:
        entry = entries.get(row.get("scope_entry_id") or "")
        if entry is None:
            continue
        directories, label = _tree_metadata(
            entry,
            row,
            page_locations.get(entry.id) or {},
            system_names[entry.id],
        )
        source_type = row["source_table"]
        counts[source_type] = counts.get(source_type, 0) + 1
        objects.append({
            "sourceType": source_type,
            "sourceId": row["source_id"],
            "sourceAliasId": row["source_alias_id"],
            "funId": row.get("fun_id") or "",
            "sourceName": row.get("source_name") or "",
            "sourcePath": row["source_path"],
            "workingCopyId": row.get("working_copy_id") or "",
            "scopeEntryId": row.get("scope_entry_id") or "",
            "status": row["status"],
            "treePath": directories,
            "treeLabel": label,
            "fragments": _catalog_fragments(row),
        })
    return {
        "ok": True,
        "partial": False,
        "workspaceKey": workspace["workspaceKey"],
        "objects": objects,
        "counts": counts,
        "errors": [],
    }


def source_object(workspace: dict, *, source_type: str, source_id: str, fun_id: str = "") -> dict:
    connection = _connection(workspace)
    try:
        rows = connection.execute(
            """
            SELECT * FROM gusen_source_record
            WHERE provider='svn' AND source_table=? AND source_id=? AND fun_id=?
            ORDER BY source_path LIMIT 2
            """,
            (source_type, source_id, fun_id),
        ).fetchall()
    finally:
        connection.close()
    if not rows:
        raise SystemExit("SVN source is not present in the current local index; run reindex first")
    if len(rows) > 1:
        raise SystemExit(f"SVN object identity is ambiguous: {source_type}/{source_id}/{fun_id}")
    return dict(rows[0])


def definition(workspace: dict, *, alias: str, fun_id: str) -> dict:
    normalized_alias = str(alias or "").strip()
    normalized_fun = str(fun_id or "").strip()
    if not normalized_alias or not normalized_fun:
        raise SystemExit("SVN definition requires alias and fun id")
    connection = _connection(workspace)
    try:
        rows = connection.execute(
            """
            SELECT source_table, source_id, source_alias_id, fun_id, source_name, source_path,
                   working_copy_id, scope_entry_id, status
            FROM gusen_source_record
            WHERE provider='svn' AND source_alias_id=? AND fun_id=?
            ORDER BY source_table, source_id
            """,
            (normalized_alias, normalized_fun),
        ).fetchall()
    finally:
        connection.close()
    if not rows:
        return {
            "ok": True,
            "workspaceKey": workspace["workspaceKey"],
            "target": {"alias": normalized_alias, "funId": normalized_fun},
            "definition": None,
        }
    if len(rows) != 1:
        identity = f"{normalized_alias}.{normalized_fun}"
        raise SystemExit(f"SVN definition is ambiguous in {workspace['workspaceKey']}: {identity}")
    row = dict(rows[0])
    return {
        "ok": True,
        "workspaceKey": workspace["workspaceKey"],
        "target": {"alias": normalized_alias, "funId": normalized_fun},
        "definition": {
            "sourceType": row["source_table"],
            "sourceId": row["source_id"],
            "sourceAliasId": row["source_alias_id"],
            "funId": row["fun_id"],
            "sourceName": row["source_name"],
            "sourcePath": row["source_path"],
            "workingCopyId": row["working_copy_id"],
            "scopeEntryId": row["scope_entry_id"],
            "status": row["status"],
        },
    }


def callers(workspace: dict, *, alias: str, fun_id: str, limit=100) -> dict:
    bounded_limit = max(1, min(int(limit), 500))
    connection = _connection(workspace)
    try:
        rows = connection.execute(
            """
            SELECT source_table, source_id, source_alias_id, fun_id, source_name, script_type,
                   json_path, line_no, invoke_type, confidence
            FROM gusen_invoke_call_detail
            WHERE target_alias_id=? AND target_fun_id=?
            ORDER BY source_alias_id, fun_id, line_no
            LIMIT ?
            """,
            (str(alias or "").strip(), str(fun_id or "").strip(), bounded_limit),
        ).fetchall()
    finally:
        connection.close()
    return {
        "ok": True,
        "workspaceKey": workspace["workspaceKey"],
        "target": {"alias": alias, "funId": fun_id},
        "callers": [dict(row) for row in rows],
    }

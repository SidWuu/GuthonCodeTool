"""Workspace-scoped queries over the derived SVN call index."""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path, PurePosixPath
from urllib.parse import unquote

from common import gusen_hub, source_facts

from .manifest import load_authorized_scope, source_relative_path


SUMMARY = re.compile(r"<summary>\s*(?P<label>.*?)\s*</summary>", re.IGNORECASE)
PAGE_MENU = re.compile(r"^\s*-\s*📄\s*(?P<label>.*?)\s*$")
PAGE_LINK = re.compile(r"^\s*-\s*\[(?P<label>.+)]\((?P<path>[^)]+)\)\s*$")
PROCEDURE_PACKAGE = re.compile(
    r"^\s*-\s*📦\s*(?P<alias>.*?)\s*-\s*\[(?P<source_id>[^]]+)]\s*\[(?P<label>[^]]*)]"
)
SOURCE_ICONS = ("📂", "⭐", "📄", "🏠", "📦", "🧊", "🔰", "⚡", "📊", "🐳", "🌏")


def _connection(workspace: dict) -> sqlite3.Connection:
    if not workspace["indexPath"].is_file():
        raise SystemExit(f"SVN call index is not initialized for {workspace['workspaceKey']}")
    return gusen_hub.connect_index(workspace["indexPath"])


def _display_label(value: str) -> str:
    label = str(value or "").strip()
    while label.startswith("-"):
        label = label[1:].strip()
    for icon in SOURCE_ICONS:
        if label.startswith(icon):
            return label[len(icon):].strip()
    return label


def _index_target(entry, target: str, category: str) -> str:
    normalized = PurePosixPath(target)
    if normalized.is_absolute() or ".." in normalized.parts:
        return ""
    parts = normalized.parts
    identity = Path(entry.local_subdir).name
    if category == "pages":
        if len(parts) >= 2 and parts[:2] == (identity, "pages"):
            parts = parts[2:]
        elif parts and parts[0] == "pages":
            parts = parts[1:]
        if entry.category == "systems":
            parts = ("pages", *parts)
    elif category == "procedures":
        if parts and parts[0] == "procedures":
            parts = parts[1:]
        if entry.category == "datasources":
            parts = ("procedures", *parts)
    return PurePosixPath(*parts).as_posix() if parts else ""


def _page_index_path(entry) -> Path:
    return entry.root / "pages/index.md" if entry.category == "systems" else entry.root / "index.md"


def _procedure_index_path(entry) -> Path:
    return entry.root / "procedures/index.md" if entry.category == "datasources" else entry.root / "index.md"


def _page_index_locations(entry) -> dict[str, dict]:
    try:
        lines = _page_index_path(entry).read_text(encoding="utf-8").splitlines()
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        return {}
    directories = []
    current_menu = ""
    locations = {}
    for order, line in enumerate(lines):
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
        relative = _index_target(entry, target, "pages")
        if not relative:
            continue
        locations.setdefault(
            relative,
            {
                "directories": [*directories, *([current_menu] if current_menu else [])],
                "label": _display_label(link.group("label")),
                "order": order,
            },
        )
    return locations


def _procedure_index_locations(entry) -> dict[str, dict]:
    try:
        lines = _procedure_index_path(entry).read_text(encoding="utf-8").splitlines()
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        return {}
    package_alias = ""
    package_label = ""
    locations = {}
    for order, line in enumerate(lines):
        package = PROCEDURE_PACKAGE.match(line)
        if package:
            package_alias = package.group("alias").strip()
            description = package.group("label").strip()
            package_label = f"{package_alias} · {description}" if description else package_alias
            continue
        link = PAGE_LINK.match(line)
        if not link or not package_alias:
            continue
        target = unquote(link.group("path").split("#", 1)[0].split("?", 1)[0]).replace("\\", "/")
        relative = _index_target(entry, target, "procedures")
        if not relative:
            continue
        label = _display_label(link.group("label"))
        function_id, separator, description = label.partition(" - ")
        locations.setdefault(
            relative,
            {
                "directories": [package_label],
                "label": f"{function_id} · {description}" if separator and description else label,
                "order": order,
            },
        )
    return locations


def _entry_name(entry) -> str:
    try:
        markers = sorted(child.name[2:] for child in entry.root.iterdir() if child.name.startswith("$.") and child.name[2:])
    except OSError:
        markers = []
    return markers[0] if markers else Path(entry.local_subdir).name


def _system_name(entry) -> str:
    """Compatibility alias for legacy page-tree tests and callers."""

    return _entry_name(entry)


def _subsystem_tree_orders(workspace: dict, scope) -> dict[str, list[int]]:
    """Align every subsystem-backed tree with the procedure datasource order."""

    entries = list(scope.entries)
    entry_orders = {entry.id: order for order, entry in enumerate(entries)}
    datasource_orders = {
        Path(entry.local_subdir).name: entry_orders[entry.id]
        for entry in entries
        if entry.category in {"datasources", "procedures"}
    }
    system_orders = {}
    mappings = workspace.get("systemMappings") or {}
    for alias_order, alias in enumerate(workspace.get("systemAliases") or []):
        mapping = mappings.get(alias)
        if not isinstance(mapping, dict):
            continue
        system_id = str(mapping.get("system_id") or "").strip()
        datasource_id = str(mapping.get("data_source_id") or "").strip()
        datasource_order = datasource_orders.get(datasource_id)
        if system_id and datasource_order is not None:
            system_orders[system_id] = [datasource_order, alias_order]

    orders = {}
    for entry in entries:
        identity = Path(entry.local_subdir).name
        if entry.category in {"systems", "pages", "system-script"} and identity in system_orders:
            orders[entry.id] = system_orders[identity]
        elif entry.category in {"datasources", "procedures", "tables", "views"} and identity in datasource_orders:
            orders[entry.id] = [datasource_orders[identity]]
        else:
            orders[entry.id] = [entry_orders[entry.id]]
    return orders


def _relative_source_path(entry, source_path: str) -> PurePosixPath | None:
    logical = PurePosixPath(str(source_path or ""))
    prefix = PurePosixPath(entry.local_subdir)
    try:
        return logical.relative_to(prefix)
    except ValueError:
        return None


def _page_index_location(entry, relative: PurePosixPath, locations: dict[str, dict]) -> dict | None:
    location = locations.get(relative.as_posix())
    if location:
        return location

    # Current checkouts use two hexadecimal shard directories (for example
    # pages/1/4/PG-....json), while the platform-generated index.md retains
    # the legacy one-shard link (4/PG-....json). Match that documented link
    # without changing the source path used for file operations.
    parts = relative.parts
    shard_offset = 1 if getattr(entry, "category", "") == "systems" and parts[:1] == ("pages",) else 0
    shards = parts[shard_offset:shard_offset + 2]
    if len(shards) == 2 and all(re.fullmatch(r"[0-9A-Fa-f]", shard) for shard in shards):
        legacy = PurePosixPath(*parts[:shard_offset], *parts[shard_offset + 1:])
        return locations.get(legacy.as_posix())
    return None


def _tree_metadata(
    entry,
    row: dict,
    page_locations: dict[str, dict],
    procedure_locations: dict[str, dict] | str | None = None,
    entry_name: str | None = None,
) -> tuple[list[str], str]:
    if isinstance(procedure_locations, str) and entry_name is None:
        entry_name = procedure_locations
        procedure_locations = {}
    procedure_locations = procedure_locations or {}
    entry_name = entry_name if entry_name is not None else _entry_name(entry)
    relative = _relative_source_path(entry, row["source_path"])
    if relative is None:
        return [], row.get("source_name") or row["source_id"]
    source_type = row["source_table"]
    if source_type == "page":
        location = _page_index_location(entry, relative, page_locations)
        if location:
            label = location["label"]
            if relative.suffix.lower() == ".gss":
                label = f"GSS · {label}"
            return [entry_name, *location["directories"]], label
        # PAGE files are physically sharded below pages/0..F. Those storage
        # directories are not business navigation and must not leak into the
        # Nexus tree when a page is absent from pages/index.md.
        return [entry_name, "未编入 index.md"], row.get("source_name") or row["source_id"]
    if source_type == "system-script":
        source_relative = source_relative_path(entry, relative)
        return [entry_name, *source_relative.parts[:-1]], source_relative.name
    source_relative = source_relative_path(entry, relative)
    logical_entry_name = entry_name or Path(entry.local_subdir).name
    if source_type == "procedure":
        location = procedure_locations.get(relative.as_posix())
        if location:
            return [logical_entry_name, *location["directories"]], location["label"]
        directories = [logical_entry_name, *source_relative.parts[:-1]]
        if getattr(entry, "category", "") == "datasources":
            directories.insert(1, "未编入 index.md")
        return directories, f"{row['fun_id']} {row['source_alias_id']}".strip()
    if source_type in {"table", "view"}:
        identity = row["source_id"]
        name = row.get("source_name") or ""
        return [logical_entry_name, *source_relative.parts[:-1]], f"{identity} {name}".strip() if name != identity else identity
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
    subsystem_orders = _subsystem_tree_orders(workspace, scope)
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
    procedure_locations = {}
    entry_names = {}
    for entry in scope.entries:
        entry_names[entry.id] = _entry_name(entry)
        if entry.category in {"systems", "pages"}:
            page_locations[entry.id] = _page_index_locations(entry)
        if entry.category in {"datasources", "procedures"}:
            procedure_locations[entry.id] = _procedure_index_locations(entry)
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
            procedure_locations.get(entry.id) or {},
            entry_names[entry.id],
        )
        source_type = row["source_table"]
        relative = _relative_source_path(entry, row["source_path"])
        location = None
        if relative is not None:
            if source_type == "page":
                location = _page_index_location(entry, relative, page_locations.get(entry.id) or {})
            elif source_type == "procedure":
                location = (procedure_locations.get(entry.id) or {}).get(relative.as_posix())
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
            "treeOrder": (
                [*subsystem_orders[entry.id], location["order"]]
                if location
                else [*subsystem_orders[entry.id], 1_000_000]
                if source_type in {"page", "procedure"}
                else subsystem_orders[entry.id]
            ),
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


def facts(
    workspace: dict,
    *,
    keyword: str = "",
    table_name: str = "",
    source_id: str = "",
    limit: int = 3,
    continuation: int = 0,
) -> dict:
    connection = _connection(workspace)
    try:
        result = source_facts.query_facts(
            connection,
            workspace["scopeId"],
            keyword=keyword,
            table_name=table_name,
            source_id=source_id,
            limit=limit,
            offset=continuation,
        )
    finally:
        connection.close()
    return {"ok": True, "workspaceKey": workspace["workspaceKey"], **result}


def explain(
    workspace: dict,
    *,
    table_name: str = "",
    bill_type_code: str = "",
    data_source_id: str = "",
    operation: str = "WRITE",
    limit: int = 1,
    fact_limit: int = 4,
    caller_depth: int = 2,
    continuation: int = 0,
    include_details: bool = False,
) -> dict:
    connection = _connection(workspace)
    try:
        result = source_facts.explain_table(
            connection,
            workspace["scopeId"],
            table_name=table_name,
            bill_type_code=bill_type_code,
            data_source_id=data_source_id,
            operation=operation,
            limit=limit,
            offset=continuation,
            fact_limit=fact_limit,
            caller_depth=caller_depth,
            include_details=include_details,
        )
    finally:
        connection.close()
    return {"ok": True, "workspaceKey": workspace["workspaceKey"], **result}

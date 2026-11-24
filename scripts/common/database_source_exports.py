"""Index the structured exports that are stored outside DATABASE PAGE/procedures."""

import hashlib
import json
from pathlib import Path
import re

from common.database_exports._export_common import bill_type_output_dir, legacy_bill_type_dir, sanitize_name
from common.source_format import decode_source
from common.source_text_search import MAX_BODY_CHARS

TYPES = ("table", "view", "system-script", "bill-type")
MAX_EXPORT_BYTES = 8 * 1024 * 1024
OBJECT_COLUMNS = "export_key, source_type, source_id, source_name, folder, local_path, json_pointer"
EXPORT_PATTERNS = {
    "table": "*/*.json",
    "view": "*/*.sql",
    "system-script": "*/scripts/*/source.*",
    "bill-type": "*.json",
}


def _roots(workspace):
    return {
        "table": workspace["databaseDir"] / "schema",
        "view": workspace["databaseDir"] / "views",
        "system-script": workspace["readonlyDir"],
        "bill-type": bill_type_output_dir(workspace),
    }


def _file(workspace, source_type, relative):
    root = _roots(workspace)[source_type]
    roots = (root, legacy_bill_type_dir(workspace)) if source_type == "bill-type" else (root,)
    for directory in roots:
        target = directory / relative
        if target.resolve() == target and target.is_relative_to(directory) and target.is_file():
            return target
    return None


def bill_type_files(workspace):
    """One current file per export path, falling back to the pre-upgrade location."""
    root = bill_type_output_dir(workspace)
    names = {file.name for directory in (root, legacy_bill_type_dir(workspace))
             for file in directory.glob(EXPORT_PATTERNS["bill-type"])}
    return [target for name in sorted(names) if (target := _file(workspace, "bill-type", Path(name)))]


def _text(target):
    with target.open("rb") as source:
        raw = source.read(MAX_EXPORT_BYTES + 1)
    if len(raw) > MAX_EXPORT_BYTES:
        raise ValueError("本地导出文件超过解析上限")
    return decode_source(raw)[0]


def prune_outside_scope(workspace, scope):
    """Remove generated exports with a recognized owner outside the new scope."""
    systems = set(scope["system_ids"])
    data_sources = set(scope["data_source_ids"])
    if not systems or not data_sources:
        raise ValueError("缺少可核对的 DATABASE 同步范围，未清理本地导出")
    removed = 0
    roots = [*_roots(workspace).items(), ("bill-type", legacy_bill_type_dir(workspace))]
    for source_type, root in roots:
        for candidate in sorted(root.glob(EXPORT_PATTERNS[source_type])):
            relative = candidate.relative_to(root)
            target = candidate
            if target.resolve() != target or not target.is_relative_to(root) or not target.is_file():
                continue
            companion = None
            if source_type == "view":
                folder = relative.parts[0]
                if any(folder.startswith(f"{sanitize_name(value)}_") for value in data_sources):
                    continue
                # Legacy view exports have no identity sidecar. The generated folder
                # carries the numeric data-source code before the system name.
                if not re.fullmatch(r"[0-9]+_.+", folder):
                    continue
            else:
                if source_type == "system-script":
                    companion = _file(workspace, source_type, relative.parent / "meta.json")
                    if not companion:
                        continue
                try:
                    meta = json.loads(_text(companion or target))
                except (ValueError, UnicodeError):
                    continue
                if not isinstance(meta, dict):
                    continue
                if source_type == "system-script":
                    if (not meta.get("systemId") or not meta.get("scriptType")
                            or meta.get("sourceFile") != target.name or str(meta["systemId"]) in systems):
                        continue
                else:
                    identifier = str(meta.get("dataSourceId") or "")
                    if not identifier or identifier in data_sources:
                        continue
                    if source_type == "table" and not meta.get("tableId"):
                        continue
                    if source_type == "bill-type" and not (
                        isinstance(meta.get("billTypes"), list) and target.name.startswith(f"{sanitize_name(identifier)} ")
                    ):
                        continue
            target.unlink()
            if companion:
                companion.unlink()
            removed += 1
            for parent in target.parents:
                if parent == root or any(parent.iterdir()):
                    break
                parent.rmdir()
    return removed


def _objects(workspace, source_type, target, relative):
    text = _text(target)
    mappings = workspace["systemMappings"].values()
    data_sources = {str(value["data_source_id"]) for value in mappings if value.get("data_source_id")}
    systems = {str(value["system_id"]) for value in mappings if value.get("system_id")}
    if source_type == "view":
        folder = relative.parts[0]
        if not data_sources or any(folder.startswith(f"{sanitize_name(value)}_") for value in data_sources):
            yield target.stem, target.stem, folder, "", text
    elif source_type == "system-script":
        meta_path = _file(workspace, source_type, relative.parent / "meta.json")
        if meta_path:
            meta = json.loads(_text(meta_path))
            if (meta.get("sourceFile") == target.name and meta.get("scriptType")
                    and (not systems or str(meta.get("systemId")) in systems)):
                yield str(meta["scriptType"]), meta.get("scriptDescription") or meta.get("scriptTypeName"), relative.parts[0], "", text
    elif source_type == "table":
        data = json.loads(text)
        if (isinstance(data, dict) and data.get("tableId")
                and (not data_sources or str(data.get("dataSourceId")) in data_sources)):
            yield data["tableId"], data.get("tableName"), relative.parts[0], "", text
    else:
        data = json.loads(text)
        if isinstance(data, dict) and (not data_sources or str(data.get("dataSourceId")) in data_sources):
            group = data.get("systemName") or data.get("dataSourceId") or target.stem
            for index, row in enumerate(data.get("billTypes") or []):
                if isinstance(row, dict) and row.get("billTypeCode"):
                    yield row["billTypeCode"], row.get("billTypeName"), group, f"/billTypes/{index}", json.dumps(row, indent=2, ensure_ascii=False)


def rebuild(conn, workspace, *, source_type=None):
    conn.execute("""CREATE TABLE IF NOT EXISTS database_source_export (
        export_key TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
        source_name TEXT NOT NULL, folder TEXT NOT NULL, local_path TEXT NOT NULL,
        json_pointer TEXT NOT NULL, body TEXT NOT NULL)""")
    roots = _roots(workspace)
    if source_type is not None:
        roots = {source_type: roots[source_type]}
        conn.execute("DELETE FROM database_source_export WHERE source_type=?", (source_type,))
    else:
        conn.execute("DELETE FROM database_source_export")
    errors = []
    for source_type, root in roots.items():
        if source_type == "bill-type":
            candidates = (Path(target.name) for target in bill_type_files(workspace))
        else:
            candidates = (target.relative_to(root) for target in sorted(root.glob(EXPORT_PATTERNS[source_type])))
        for relative in candidates:
            target = _file(workspace, source_type, relative)
            if not target:
                continue
            try:
                records = list(_objects(workspace, source_type, target, relative))
            except (OSError, ValueError, AttributeError, TypeError) as error:
                errors.append({"category": source_type, "path": relative.as_posix(), "message": str(error)})
                continue
            for identity, name, folder, pointer, content in records:
                key = hashlib.sha256(f"{source_type}\n{relative.as_posix()}\n{identity}\n{pointer}".encode()).hexdigest()
                conn.execute("INSERT INTO database_source_export VALUES(?,?,?,?,?,?,?,?)",
                             (key, source_type, str(identity), str(name or identity), str(folder),
                              relative.as_posix(), pointer, content[:MAX_BODY_CHARS]))
    return errors


def available(conn):
    return conn.execute("SELECT 1 FROM sqlite_master WHERE name='database_source_export'").fetchone() is not None


def payload(row):
    return {"sourceType": row["source_type"], "sourceId": row["source_id"], "name": row["source_name"],
            "exportKey": row["export_key"], "sourcePath": row["local_path"], "groups": [row["folder"]]}


def read(conn, workspace, key):
    row = conn.execute(f"SELECT {OBJECT_COLUMNS} FROM database_source_export WHERE export_key=?", (key,)).fetchone() if available(conn) else None
    target = _file(workspace, row["source_type"], Path(row["local_path"])) if row else None
    if not target:
        raise SystemExit("本地导出对象已移除或尚未建立索引")
    relative = Path(row["local_path"])
    for source_id, _name, _folder, pointer, content in _objects(workspace, row["source_type"], target, relative):
        if str(source_id) == row["source_id"] and row["json_pointer"] == pointer:
            language = {"sql": "sql", "js": "javascript", "vm": "guthon-gss", "gss": "guthon-gss"}.get(target.suffix[1:], "json")
            return {**payload(row), "content": content, "language": language}
    raise SystemExit("本地导出对象已变化，请重建当前项目索引")

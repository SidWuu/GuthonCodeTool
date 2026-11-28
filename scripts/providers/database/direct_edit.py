"""Direct edits to registered DATABASE Workcopy source files."""

from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3

from common import legacy_source as hub
from common.database_workcopy_edit import _bytes
from common.inheritance import project as project_inheritance
from common.page_projection import extract_page_nodes, extract_page_scripts
from common.source_format import decode_source


def _inspect_system_script(workspace, path, relative, *, refresh):
    mirror = workspace["readonlyDir"].resolve() / relative
    if mirror.resolve() != mirror or not mirror.is_file():
        raise ValueError("系统脚本缺少普通只读基线")
    with hub.index_connection(workspace, action="database-direct-edit") as conn:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='database_source_export'").fetchone():
            raise ValueError("系统脚本导出索引不可用")
        rows = conn.execute("""SELECT * FROM database_source_export
            WHERE source_type='system-script' AND local_path=?""", (relative.as_posix(),)).fetchall()
        if len(rows) != 1:
            raise ValueError("系统脚本未登记或索引身份不唯一")
        row = rows[0]
        meta_file = mirror.parent / "meta.json"
        copy_meta = path.parent / "source-meta.json"
        if any(file.resolve() != file or not file.is_file() for file in (meta_file, copy_meta)):
            raise ValueError("系统脚本缺少来源或工作副本元数据")
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
            copy = json.loads(copy_meta.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise ValueError("系统脚本元数据无效") from error
        workcopy_meta = copy.get("_workcopy") if isinstance(copy, dict) else None
        source_path = workcopy_meta.get("sourcePath") if isinstance(workcopy_meta, dict) else None
        if (not isinstance(meta, dict) or not isinstance(copy, dict)
                or meta.get("sourceFile") != path.name or str(meta.get("scriptType")) != row["source_id"]
                or meta.get("sourceOrigin") != "CURRENT" or meta.get("status") != "OK"
                or copy.get("workspaceKey") != workspace["workspaceKey"]
                or copy.get("source_table") != "system-script"
                or str(copy.get("source_id")) != str(meta.get("systemId"))
                or str(copy.get("fun_id")) != row["source_id"]
                or not isinstance(source_path, str) or not source_path
                or (hub.ROOT / source_path).resolve() != mirror.parent):
            raise ValueError("系统脚本身份不一致或包含继承来源")
        baseline = _bytes(mirror)
        if path.suffix.lower() == ".js":
            if (meta.get("sourceComposition") != "CURRENT"
                    or meta.get("sourceContentHash") != hashlib.sha256(baseline).hexdigest()
                    or project_inheritance(decode_source(baseline)[0], None)["status"] != "INACTIVE"):
                raise ValueError("系统 JavaScript 包含多层来源或缺少可核验的原始来源")
        from common.source_text_search import MAX_BODY_CHARS

        if row["body"] != decode_source(baseline)[0][:MAX_BODY_CHARS]:
            raise ValueError("系统脚本镜像与导出索引不一致")
        content = _bytes(path)
        text = decode_source(content)[0]
        if path.suffix.lower() == ".js" and project_inheritance(text, None)["status"] != "INACTIVE":
            raise ValueError("继承源码不能直接编辑")
        source_hash = hashlib.sha256(content).hexdigest()
        result = {"sourceHash": source_hash, "modified": content != baseline}
        if refresh:
            with closing(sqlite3.connect(workspace["indexPath"], timeout=hub.INDEX_BUSY_TIMEOUT_MS / 1000)) as writable, writable:
                writable.execute("""CREATE TABLE IF NOT EXISTS database_direct_edit_export_body (
                    relative_path TEXT PRIMARY KEY, export_key TEXT NOT NULL,
                    source_hash TEXT NOT NULL, content TEXT NOT NULL
                )""")
                writable.execute("""INSERT INTO database_direct_edit_export_body
                    (relative_path, export_key, source_hash, content) VALUES (?, ?, ?, ?)
                    ON CONFLICT(relative_path) DO UPDATE SET export_key=excluded.export_key,
                        source_hash=excluded.source_hash, content=excluded.content
                    WHERE export_key<>excluded.export_key OR source_hash<>excluded.source_hash
                       OR content<>excluded.content""",
                    (relative.as_posix(), row["export_key"], source_hash, text))
                indexed = writable.execute("""SELECT export_key, source_hash, content
                    FROM database_direct_edit_export_body WHERE relative_path=?""", (relative.as_posix(),)).fetchone()
                if indexed != (row["export_key"], source_hash, text):
                    raise ValueError("系统脚本索引回读与工作副本不一致")
                if hashlib.sha256(_bytes(path)).hexdigest() != source_hash:
                    raise ValueError("工作副本在索引刷新期间发生变化")
            result["indexedHash"] = indexed[1]
        return result


def inspect_file(workspace, path: Path, *, refresh: bool) -> dict:
    if workspace.get("sourceMode") != "database":
        raise ValueError("DATABASE 工作区才能检查 DATABASE 工作副本")
    if not workspace["capabilities"].get("workcopy.open"):
        raise ValueError("当前工作区未开放 Workcopy 编辑")
    root = workspace["workcopyDir"].resolve()
    path = Path(path)
    if path.resolve() != path or not path.is_file() or not path.is_relative_to(root):
        raise ValueError("文件必须位于登记的普通 Workcopy 目录")
    relative = path.relative_to(root)
    if path.name.lower() in {"source.css", "source.js"}:
        return _inspect_system_script(workspace, path, relative, refresh=refresh)
    page_projection = path.parent.name == "scripts"
    if page_projection:
        source_type = "page"
        owner_relative = relative.parent.parent
    elif path.name == "source.vm":
        source_type = "procedure"
        owner_relative = relative.parent
    else:
        raise ValueError("文件没有登记为独立可写源码")
    mirror_dir = workspace["readonlyDir"].resolve() / owner_relative
    mirror = workspace["readonlyDir"].resolve() / relative
    if mirror.resolve() != mirror or not mirror.is_file():
        raise ValueError("找不到普通只读基线文件")

    with hub.index_connection(workspace, action="database-direct-edit") as conn:
        rows = conn.execute(
            """SELECT * FROM gusen_source_record WHERE provider='database' AND scope_id=?
               AND project_id=? AND source_table=? AND status='OK' AND local_path=?""",
            (workspace["scopeId"], workspace["projectId"], source_type, hub._indexed_path(mirror_dir)),
        ).fetchall()
        if len(rows) != 1:
            raise ValueError("源码路径未登记或索引身份不唯一")
        row = rows[0]
        meta_path = mirror_dir / "meta.json"
        if meta_path.resolve() != meta_path or not meta_path.is_file():
            raise ValueError("只读基线缺少来源元数据")
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise ValueError("只读基线元数据无效") from error
        if not isinstance(meta, dict) or meta.get("change_key") != row["change_key"]:
            raise ValueError("只读基线与索引版本不一致")
        baseline = _bytes(mirror)
        pointer = ""
        if page_projection:
            from common.legacy_source_read import _page_data

            raw_mirror = mirror_dir / "raw.json"
            raw_copy = root / owner_relative / "raw.json"
            if (raw_mirror.resolve() != raw_mirror or not raw_mirror.is_file()
                    or raw_copy.resolve() != raw_copy or not raw_copy.is_file()):
                raise ValueError("PAGE 缺少普通原始源码或工作副本")
            original = _page_data(decode_source(_bytes(raw_mirror))[0])
            current = _page_data(decode_source(_bytes(raw_copy))[0])
            if original.get("pageId") != row["source_id"] or current.get("pageId") != row["source_id"]:
                raise ValueError("PAGE 原始源码与索引身份不一致")
            fields = extract_page_scripts(original, missing_product_as_empty=True, include_empty_inherited=True)
            matches = []
            for field in fields:
                filename = hub._page_script_filename(list(field.display_path), field.key, field.event_type)
                candidate = mirror.parent / filename
                if filename == path.name or candidate.is_file() and candidate.samefile(mirror):
                    matches.append(field)
            if len(matches) != 1:
                raise ValueError("PAGE 投影未登记或文件名对应多个片段")
            field = matches[0]
            pointer = field.json_pointer
            indexed = conn.execute("""SELECT 1 FROM gusen_source_fragment
                WHERE source_record_id=? AND json_pointer=?""", (row["record_id"], pointer)).fetchone()
            if not indexed:
                raise ValueError("PAGE 投影片段未登记在索引中")
            if project_inheritance(field.original_value, None)["status"] != "INACTIVE":
                raise ValueError("继承 PAGE 投影不能直接编辑")
            expected = field.effective_value.replace("\n", os.linesep).encode("utf-8")
            if baseline != expected:
                raise ValueError("PAGE 投影与只读原始源码不一致")
            current_fields = [item for item in extract_page_scripts(current, missing_product_as_empty=True,
                              include_empty_inherited=True) if item.json_pointer == pointer]
            original_nodes = {node.json_pointer: node for node in extract_page_nodes(original)}
            current_nodes = {node.json_pointer: node for node in extract_page_nodes(current)}
            old_node, new_node = original_nodes.get(pointer), current_nodes.get(pointer)
            if (len(current_fields) != 1 or current_fields[0].original_value != field.original_value
                    or current_fields[0].display_path != field.display_path or not old_node or not new_node
                    or old_node.identity_stability != new_node.identity_stability
                    or old_node.semantic_node_id != new_node.semantic_node_id
                    or old_node.identity_stability != "STABLE" and original != current):
                raise ValueError("PAGE 工作副本的片段身份或结构已变化")
        else:
            status = meta.get("source_inheritance")
            original = meta.get("source_content")
            if status is None and isinstance(original, str):
                if hub._resolve_inherited_script(original, meta.get("product_source_content") or "") != decode_source(baseline)[0]:
                    raise ValueError("过程函数来源与只读基线不一致")
                status = project_inheritance(original, None)["status"]
            elif meta.get("source_content_hash") != hashlib.sha256(baseline).hexdigest():
                raise ValueError("过程函数基线缺少可核验的继承来源")
            if status != "INACTIVE":
                raise ValueError("继承过程函数或来源不明的过程函数不能直接编辑")
        content = _bytes(path)
        text = decode_source(content)[0]
        if project_inheritance(text, None)["status"] != "INACTIVE":
            raise ValueError("继承源码不能直接编辑")
        source_hash = hashlib.sha256(content).hexdigest()
        result = {"sourceHash": source_hash, "modified": content != baseline}
        if refresh:
            with closing(sqlite3.connect(workspace["indexPath"], timeout=hub.INDEX_BUSY_TIMEOUT_MS / 1000)) as writable, writable:
                writable.execute("""CREATE TABLE IF NOT EXISTS database_direct_edit_body (
                    relative_path TEXT PRIMARY KEY, local_path TEXT NOT NULL, source_id TEXT NOT NULL,
                    fun_id TEXT NOT NULL, json_pointer TEXT NOT NULL, source_hash TEXT NOT NULL, content TEXT NOT NULL
                )""")
                writable.execute("""INSERT INTO database_direct_edit_body
                    (relative_path, local_path, source_id, fun_id, json_pointer, source_hash, content)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(relative_path) DO UPDATE SET local_path=excluded.local_path,
                        source_id=excluded.source_id, fun_id=excluded.fun_id,
                        json_pointer=excluded.json_pointer, source_hash=excluded.source_hash, content=excluded.content
                    WHERE local_path<>excluded.local_path OR source_id<>excluded.source_id
                       OR fun_id<>excluded.fun_id OR json_pointer<>excluded.json_pointer
                       OR source_hash<>excluded.source_hash OR content<>excluded.content""",
                    (relative.as_posix(), row["local_path"], row["source_id"],
                     row["fun_id"], pointer, source_hash, text))
                indexed = writable.execute("""SELECT local_path, source_id, fun_id, json_pointer, source_hash, content
                    FROM database_direct_edit_body WHERE relative_path=?""", (relative.as_posix(),)).fetchone()
                if indexed != (row["local_path"], row["source_id"], row["fun_id"], pointer, source_hash, text):
                    raise ValueError("工作副本索引回读与源码不一致")
                if hashlib.sha256(_bytes(path)).hexdigest() != source_hash:
                    raise ValueError("工作副本在索引刷新期间发生变化")
            result["indexedHash"] = indexed[4]
        return result

"""Local DATABASE source editor. The synchronized files are immutable baselines."""
from __future__ import annotations

from contextlib import nullcontext
from difflib import SequenceMatcher
import hashlib
import json
import os
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory

from common import legacy_source as hub
from common import page_editor
from common.database_source_publish import workcopy_baseline
from common.inheritance import project as project_inheritance
from common.page_comparison import baseline_pointer, compare_pages
from common.page_projection import (
    extract_page_fields, extract_page_scripts, inherited_page_script, pointer_value,
    replace_json_value, resolve_inherited_script,
)
from common.persistence import atomic_bytes
from common.source_format import decode_source, encode_source_exact


def _bytes(path):
    with path.open("rb") as source:
        content = source.read(page_editor.MAX_PAGE_BYTES + 1)
    if len(content) > page_editor.MAX_PAGE_BYTES:
        raise ValueError("本地源码超过编辑器的 4 MB 上限")
    return content


def _digest(content):
    return hashlib.sha256(content).hexdigest()


def _page(text, source_id):
    value = json.loads(text)
    double_encoded = isinstance(value, str)
    projected = value if double_encoded else text
    data = json.loads(projected) if double_encoded else value
    if not isinstance(data, dict) or data.get("pageId") != source_id:
        raise ValueError("PAGE 内容与索引中的页面身份不一致")
    return projected, data, double_encoded


def _changed_lines(before, after):
    # Normalize line endings and disregard one final line terminator.
    before = before.replace("\r\n", "\n").replace("\r", "\n").removesuffix("\n")
    after = after.replace("\r\n", "\n").replace("\r", "\n").removesuffix("\n")
    if before == after:
        return []
    comparison = SequenceMatcher(None, before.split("\n") if before else [], after.split("\n") if after else [])
    return [{"kind": kind, "start": start, "end": end}
            for kind, _, _, start, end in comparison.get_opcodes() if kind != "equal"]


def _create_page_workcopy(conn, workspace, config, row, source, target, expected_hash):
    source_id = row["source_id"]
    change_key = row["change_key"]
    folder = target.parent
    mirror = source.parent
    identity = {"workspaceKey": workspace["workspaceKey"], "recordId": row["record_id"],
                "sourceId": source_id, "sourcePath": source.relative_to(workspace["readonlyDir"]).as_posix(),
                "workcopyPath": str(target), "baselineSourceHash": expected_hash, "baselineChangeKey": change_key}
    with hub.file_lock(workspace["contextDir"] / ".workcopy.lock"):
        if folder.resolve() != folder or (folder.exists() and not folder.is_dir()):
            raise ValueError("Workcopy 目标不是登记目录下的普通目录")
        raw = _bytes(source)
        _page(decode_source(raw)[0], source_id)
        if _digest(raw) != expected_hash:
            raise ValueError("Readonly PAGE 已变化，请重新读取后创建")
        if folder.exists():
            return {**identity, "action": "EXISTS", "writeArtifacts": []}
        metadata = mirror / "meta.json"
        if metadata.resolve() != metadata:
            raise ValueError("Readonly PAGE 元数据路径包含符号链接")
        meta_bytes = metadata.read_bytes()
        meta = json.loads(meta_bytes)
        if (not isinstance(meta, dict) or meta.get("source_id") != source_id
                or meta.get("source_table") != "page" or meta.get("change_key") != change_key):
            raise ValueError("Readonly PAGE 元数据与当前索引的对象或版本不一致")
        expected = {"raw.json": raw, "meta.json": meta_bytes}

        def verify(staged):
            if any(path.is_symlink() for path in staged.rglob("*")):
                raise ValueError("Readonly PAGE 镜像包含符号链接")
            indexed = conn.execute("SELECT * FROM gusen_source_record WHERE record_id=?", (row["record_id"],)).fetchone()
            if indexed != row or any((mirror / name).resolve() != mirror / name
                                     or (mirror / name).read_bytes() != content
                                     or (staged / name).read_bytes() != content for name, content in expected.items()):
                raise ValueError("Readonly PAGE 镜像或索引在创建期间发生变化，请重新核对")
            expected[hub.WORK_COPY_META_FILE] = (staged / hub.WORK_COPY_META_FILE).read_bytes()

        work_row = {**dict(row), "workspaceKey": workspace["workspaceKey"]}
        result = hub._initialize_work_copy(mirror, folder, work_row, change_key, "mirror", verify=verify)
        artifacts = []
        for name, content in expected.items():
            path = folder / name
            if path.resolve() != path or path.read_bytes() != content:
                raise ValueError("Workcopy 创建后的文件回读不匹配，请核对磁盘")
            artifacts.append({"path": str(path), "sourceHash": _digest(content)})
        outputs = {path for path in folder.rglob("*") if path.is_file()}
        hub.record_generated_files(outputs)
        result.update(hub._auto_add_work_copy(config, folder, outputs))
        return {**result, **identity, "matchesAfter": True, "writeArtifacts": artifacts}


def run(workspace, config, action, payload, *, include_write_artifacts=False, rebind_index_record=False):
    if not isinstance(payload, dict):
        raise ValueError("需要明确的 DATABASE 源码身份")
    record_id, source_id, source_path = (payload.get(key) for key in ("recordId", "sourceId", "sourcePath"))
    if (type(record_id) is not int or record_id <= 0 or not isinstance(source_id, str) or not source_id
            or not isinstance(source_path, str) or not source_path):
        raise ValueError("需要明确的 DATABASE 源码身份")
    readonly_root = workspace["readonlyDir"].resolve()
    with hub.index_connection(workspace, action="workcopy-editor-target") as conn:
        row = conn.execute("""SELECT * FROM gusen_source_record WHERE scope_id=? AND provider='database'
            AND record_id=? AND source_id=? AND source_table IN ('page','procedure')""",
                           (workspace["scopeId"], record_id, source_id)).fetchone()
        indexed = None
        if row is not None and row["local_path"]:
            filename = "raw.json" if row["source_table"] == "page" else "source.vm"
            indexed = hub.ROOT / row["local_path"] / filename
        source = indexed.resolve() if indexed is not None else None
        expected = readonly_root / source_path
        if rebind_index_record and source != expected:
            # Synchronization may replace the row or reuse its number for another path.
            expected = expected.resolve()
            source_type = {"raw.json": "page", "source.vm": "procedure"}.get(expected.name)
            if (source_type and expected.is_relative_to(readonly_root)
                    and expected.relative_to(readonly_root).as_posix() == source_path):
                matches = conn.execute("""SELECT * FROM gusen_source_record
                    WHERE scope_id=? AND provider='database' AND source_id=? AND source_table=? AND local_path=?
                    LIMIT 2""", (workspace["scopeId"], source_id, source_type, hub._indexed_path(expected.parent))).fetchall()
                if len(matches) == 1:
                    row = matches[0]
                    indexed = hub.ROOT / row["local_path"] / expected.name
                    source = expected
        if source is None:
            raise ValueError("源码已移出当前工作区索引")
        if not source.is_relative_to(readonly_root) or source.relative_to(readonly_root).as_posix() != source_path:
            raise ValueError("源码路径与当前工作区索引不一致")
        is_page = row["source_table"] == "page"
        filename = indexed.name
        workcopy_root = workspace["workcopyDir"].resolve()
        target = workcopy_root / source.relative_to(readonly_root)
        if action == "create":
            if (not is_page or source != indexed or readonly_root != workspace["readonlyDir"]
                    or workcopy_root != workspace["workcopyDir"]):
                raise ValueError("仅支持从登记目录下的普通 Readonly PAGE 创建 Workcopy")
            return _create_page_workcopy(conn, workspace, config, row, source, target, payload["baselineSourceHash"])
    pointer = payload.get("pointer", "")
    if not isinstance(pointer, str) or pointer and (not is_page or not pointer.startswith("/") or len(pointer) > 4096):
        raise ValueError("无效的源码分块路径")
    design = is_page and payload.get("design") is True
    editing = action in {"edit-preview", "edit-save"}
    saving = action == "edit-save"
    reviewing_publish = action in {"publish-preview", "publish-confirm"}
    source_lock = hub.file_lock(workspace["contextDir"] / ".source-write.lock") if (saving or reviewing_publish) and not is_page else nullcontext()
    copy_lock = hub.file_lock(workspace["contextDir"] / ".workcopy.lock") if saving or reviewing_publish else nullcontext()
    with source_lock, copy_lock:
        if target.resolve() != target:
            raise ValueError("工作副本路径包含符号链接")
        existing = target.is_file()
        if target.exists() and not existing:
            raise ValueError("工作副本目标不是文件")
        current = _bytes(target if existing else source)
        source_hash = _digest(current)
        text, file_format = decode_source(current)
        result = {"workspaceKey": workspace["workspaceKey"], "sourcePath": source_path,
                  "sourceId": source_id, "sourceHash": source_hash, "editable": True,
                  "workcopy": existing, "workcopyPath": str(target), "language": "json" if is_page else "guthon-gss"}
        if (editing or action == "publish-confirm") and payload.get("sourceHash") != source_hash:
            raise ValueError("源码已发生变化，请保留修改并重新打开后比较")
        if reviewing_publish:
            if is_page or not existing or not row["data_source_id"] or not row["source_alias_id"] or not row["fun_id"]:
                raise ValueError("本期只支持有精确身份的既有过程函数工作副本")
            baseline, original = workcopy_baseline(workspace, row, source_path, source_hash)
            if baseline is None:
                raise ValueError("工作副本没有可信基线；请导出旧改动并按当前同步镜像重新应用")
            baseline_text = decode_source(original)[0]
            if baseline_text.replace("\r\n", "\n") == text.replace("\r\n", "\n"):
                raise ValueError("没有正文变更可供上传审阅")
            if (project_inheritance(baseline_text, None)["status"] != "INACTIVE"
                    or project_inheritance(text, None)["status"] != "INACTIVE"):
                raise ValueError("继承过程不在本期发布范围")
            if max(len(baseline_text.encode("utf-8")), len(text.encode("utf-8"))) > 196608:
                raise ValueError("过程函数正文超过平台发布上限")
            systems = {mapping["system_id"] for mapping in workspace["systemMappings"].values()
                       if mapping.get("data_source_id") == row["data_source_id"] and mapping.get("system_id")}
            identity = dict(baseline["identity"])
            if systems:
                indexed_system = identity["system_id"]
                identity["system_id"] = (indexed_system if indexed_system in systems
                                         else next(iter(systems)) if len(systems) == 1 and not indexed_system else "")
            binding = workspace["workspaceBinding"]
            origins = workspace["pageOrigins"]
            review_id = _digest(json.dumps([identity, source_path, baseline["sourceVersion"],
                                            baseline["sourceHash"], source_hash, binding, origins],
                                           sort_keys=True).encode())
            if action == "publish-confirm" and payload.get("reviewId") != review_id:
                raise ValueError("编辑基线或候选已变化，请重新审阅")
            return {**result, "reviewId": review_id, "databaseIdentity": identity,
                    "workspaceBinding": binding, "pageOrigins": origins, "databaseBaseVersion": baseline["sourceVersion"],
                    "baseContent": baseline_text, "content": text}
        if is_page:
            projected, data, wrapped = _page(text, source_id)
            if action == "edit-read" and payload.get("resolveDefaultFragment") is True:
                default_fragment = (
                    {"pointer": "/compScript", "language": "guthon-gss"}
                    if str(data.get("pageType")) == "0" else None
                )
                return {**result, "defaultFragment": default_fragment}
        if action == "edit-comparison":
            if not is_page:
                baseline, original = workcopy_baseline(workspace, row, source_path, source_hash) if existing else (None, None)
                before = original if baseline else (_bytes(source) if source.is_file() else None)
                return {**result, "available": before is not None, "trustedBaseline": baseline is not None,
                        "changed": before is not None and before != current,
                        "baseContent": decode_source(before)[0] if before is not None else None,
                        "content": text}
            if not design or payload.get("sourceHash") != source_hash:
                raise ValueError("PAGE 已变化，请重新打开后比较")
            from common.database_page_fields import field_batches

            base = _bytes(source)
            _base_text, base_data, _wrapped = _page(decode_source(base)[0], source_id)
            base_hash = _digest(base)
            if "fieldBatchPointer" in payload:
                if payload.get("baseRevision") != base_hash:
                    raise ValueError("DATABASE 只读基线已变化，请重新比较")
                for item, batch in field_batches(base_data, data):
                    if item["pointer"] == payload["fieldBatchPointer"]:
                        clipboard = json.dumps(batch, ensure_ascii=False, allow_nan=False)
                        if len(clipboard.encode("utf-8")) > page_editor.MAX_PAGE_BYTES:
                            raise ValueError("字段改动超过剪贴板导入上限")
                        return {**result, "clipboard": clipboard}
                raise ValueError("没有可复制的字段改动，请重新比较")
            changes = compare_pages(base_data, data)
            return {**result, "available": True, "baseRevision": base_hash[:12], "fieldBaseHash": base_hash,
                    "fieldBatches": [item for item, _batch in field_batches(base_data, data)],
                    "changes": changes, "formatOnly": base != current and not changes["total"]}
        if design and not editing:
            return {**result, "sourceText": projected, "model": page_editor.describe(projected),
                    "editToken": source_hash}
        fragment = None
        display_content = None
        if pointer:
            for field in extract_page_scripts(data):
                if field.json_pointer == pointer:
                    fragment = field.original_value
                    display_content = field.effective_value
                    result.update(language={"js":"javascript","sql":"sql"}.get(field.script_type,"guthon-gss"),
                                  editable=project_inheritance(fragment, None)["status"] == "INACTIVE")
                    break
            else:
                collections = extract_page_fields(data, include_buttons=True, include_content=False)
                if not any(field["json_pointer"] == pointer for field in collections):
                    raise ValueError("当前 PAGE 中无法定位该分块")
                fragment = pointer_value(data, pointer)
        if not editing:
            content = projected if is_page else text
            if pointer:
                content = display_content if isinstance(fragment, str) else json.dumps(fragment, ensure_ascii=False, indent=2)
            if payload.get("includeLineChanges") is True:
                result["lineChanges"] = []
                if existing:
                    try:
                        original = _bytes(source)
                        if original != current:
                            baseline = decode_source(original)[0]
                            if is_page:
                                baseline, base_data, _ = _page(baseline, source_id)
                                if pointer:
                                    old_pointer = baseline_pointer(base_data, data, pointer)
                                    value = pointer_value(base_data, old_pointer) if old_pointer is not None else None
                                    if isinstance(fragment, str):
                                        baseline = (resolve_inherited_script(value, inherited_page_script(base_data, old_pointer)[1])
                                                    if isinstance(value, str) else "")
                                    else:
                                        baseline = json.dumps(value, ensure_ascii=False, indent=2) if value is not None else ""
                            result["lineChanges"] = _changed_lines(baseline, content)
                    except (OSError, ValueError) as error:
                        result["lineChangesDiagnostic"] = f"无法读取 DATABASE 只读基线：{error}"
            return {**result, "content": content}

        if not result["editable"]:
            raise ValueError("继承脚本只读")
        if design:
            candidate = page_editor.apply_operations(projected, payload.get("operations"))
        else:
            candidate = payload.get("content")
            if not isinstance(candidate, str) or len(candidate.encode("utf-8")) > page_editor.MAX_PAGE_BYTES:
                raise ValueError("需要有效的源码文本")
            if pointer:
                replacement = candidate if isinstance(fragment, str) else json.loads(candidate)
                if isinstance(fragment, list) and not isinstance(replacement, list):
                    raise ValueError("按钮和字段集合必须是 JSON 数组")
                candidate = replace_json_value(projected, pointer, replacement, expected=fragment)
        if is_page:
            _page(candidate, source_id)
            candidate = json.dumps(candidate, ensure_ascii=False) if wrapped else candidate
        encoded = encode_source_exact(candidate, file_format)
        if len(encoded) > page_editor.MAX_PAGE_BYTES:
            raise ValueError("保存结果超过源码编辑器的 4 MB 上限")
        candidate_hash = _digest(encoded)
        if action == "edit-preview":
            return {**result, "candidateSourceHash": candidate_hash}
        if "candidateSourceHash" in payload and payload["candidateSourceHash"] != candidate_hash:
            raise ValueError("保存内容与 Workcopy 预览哈希不一致")
        if candidate_hash == source_hash:
            return result
        metadata = {**dict(row), "workspaceKey": workspace["workspaceKey"]}
        folder = target.parent
        archive = folder / hub.WORK_COPY_META_FILE
        if archive.exists():
            if archive.is_symlink():
                raise ValueError("工作副本元数据路径包含符号链接")
            previous = hub._work_copy_metadata(folder)
            if previous.get("workspaceKey") != workspace["workspaceKey"] or previous.get("source_id") != source_id:
                raise ValueError("工作副本元数据与打开的对象不一致")
        if not is_page:
            capture = None
            if row["version_mac"] and source.is_file() and current == _bytes(source):
                with hub.index_connection(workspace, action="workcopy-editor-baseline") as conn:
                    latest = conn.execute("SELECT * FROM gusen_source_record WHERE record_id=?", (record_id,)).fetchone()
                if latest is None or dict(latest) != dict(row):
                    raise ValueError("同步镜像已发生变化，请重新打开后保存")
                capture = current
            workcopy_baseline(workspace, row, source_path, source_hash, capture=capture, candidate_hash=candidate_hash)
        protected_artifacts = set()
        if folder.exists():
            if _digest(_bytes(target if existing else source)) != source_hash:
                raise ValueError("保存前源码发生变化，请重新核对")
            if not archive.exists():
                hub._write_work_copy_metadata(folder, metadata, source.parent, "mirror")
                protected_artifacts.add(archive)
            atomic_bytes(target, encoded)
            new_paths = {target} if not existing else set()
        else:
            folder.parent.mkdir(parents=True, exist_ok=True)
            with TemporaryDirectory(dir=folder.parent, prefix=".workcopy-save-") as temporary:
                staged = Path(temporary) / "source"
                shutil.copytree(source.parent, staged, ignore=shutil.ignore_patterns(".svn"))
                hub._write_work_copy_metadata(staged, metadata, source.parent, "mirror")
                atomic_bytes(staged / filename, encoded)
                if folder.exists() or _digest(_bytes(source)) != source_hash:
                    raise ValueError("保存前源码或工作副本发生变化，请重新核对")
                os.rename(staged, folder)
            new_paths = {file for file in folder.rglob("*") if file.is_file()}
            protected_artifacts = {file for file in new_paths - {target}
                                   if file.name in {hub.WORK_COPY_META_FILE, "meta.json", "raw.json"}}
        if include_write_artifacts:
            result["writeArtifacts"] = [
                {"path": str(file), "sourceHash": _digest(file.read_bytes())}
                for file in sorted(protected_artifacts)
            ]
    hub._auto_add_work_copy(config, folder, new_paths)
    return {**result, "sourceHash": candidate_hash, "workcopy": True, "path": str(target)}

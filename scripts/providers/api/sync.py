"""API refresh/upload orchestration with receipts and mandatory remote readback."""

from __future__ import annotations
import base64
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import uuid
from urllib.parse import quote
from common.persistence import atomic_bytes, atomic_text, file_lock
from .client import ApiError
from . import page_source
from .download import download, download_prefixes, fetch_object, files_from_item, records, BASE
from .editor_state import assert_writable, _live
from .store import ApiStore, digest
from .workspace import settings, save_project, active_scope, api_paths, configure, configuration_lock, in_scope, client_for, project_metadata, pending_scope, clear_pending_scope, validate_scope_selection


def _dirty_paths(workspace):
    path = workspace['contextDir'] / 'api' / 'editors.json'
    try:
        state = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return set()
    return {item['path'] for entry in state.values() if _live(entry['pid'])
            for item in entry['documents'] if item['dirty']}


def _has_symlink(root, path):
    relative = path.relative_to(root)
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            return True
    return False


def _file_identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, stat.S_IMODE(info.st_mode))


def _scope_snapshot(workspace, store, proposed):
    project = project_metadata(workspace)
    systems = project.get('systems', [])
    by_id = {str(row['systemId']): row for row in systems if row.get('systemId') is not None}
    selected = set(by_id) if proposed['allSystems'] else set(proposed['systemIds'])
    rows = []
    if store.path.is_file():
        with closing(sqlite3.connect(store.path)) as conn:
            rows = conn.execute('SELECT path,metadata,readonly FROM source ORDER BY path').fetchall()
    metadata_complete = not (selected - set(by_id)) and (not proposed['allSystems'] or bool(by_id))
    current_settings = settings(workspace)
    if not metadata_complete and (rows or current_settings['systemIds'] or current_settings['allSystems'] or current_settings['dataSourceIds']):
        raise ApiError('API_SCOPE_METADATA_REQUIRED', '项目子系统目录未包含所选范围，请先刷新子系统列表后重新选择')
    target = {'systemIds': selected, 'dataSourceIds': set(proposed['dataSourceIds']),
              'includeProjectFiles': proposed['includeProjectFiles']}
    target['dataSourceIds'].update(str(by_id[sid]['dataSourceId']) for sid in selected & set(by_id)
                                   if by_id[sid].get('dataSourceId') is not None)
    current = active_scope(workspace)
    registered = {row[0] for row in rows}
    dirty = _dirty_paths(workspace)
    excluded = {}; blocked = []
    roots = {('systems', sid) for sid in current['systemIds'] - target['systemIds']}
    roots.update(('datasources', ds) for ds in current['dataSourceIds'] - target['dataSourceIds'])
    for path, rawmeta, readonly in rows:
        meta = json.loads(rawmeta)
        if in_scope(workspace, path, meta, scope=target):
            continue
        parts = path.split('/')
        if len(parts) > 1 and parts[0] in {'systems', 'datasources'}:
            roots.add((parts[0], parts[1]))
        target_path = store._path(path)
        if _has_symlink(store.root, target_path):
            blocked.append((path, 'SYMLINK')); continue
        if target_path.exists() and not target_path.is_file():
            blocked.append((path, 'PATH_NOT_FILE')); continue
        identity = _file_identity(target_path.stat()) if target_path.is_file() else None
        raw = target_path.read_bytes() if identity is not None else None
        if identity is not None and _file_identity(target_path.stat()) != identity:
            raise ApiError('API_SCOPE_STALE', f'检查期间源码已变化，请重新选择：{path}')
        current_hash = hashlib.sha256(raw).hexdigest() if raw is not None else None
        base_hash = meta.get('remoteHash')
        if not base_hash:
            with closing(sqlite3.connect(store.path)) as conn:
                base_hash = digest(conn.execute('SELECT content FROM source WHERE path=?', (path,)).fetchone()[0])
        reason = ('DIRTY' if path in dirty else 'CONFLICT' if store._conflict_path(path).is_file()
                  else 'REMOTE_DELETED' if meta.get('remoteDeleted') else
                  'MODIFIED' if current_hash is not None and current_hash != base_hash else None)
        if reason:
            blocked.append((path, reason))
        excluded[path] = {'hash': current_hash, 'identity': identity, 'baseHash': base_hash, 'metadata': rawmeta,
                          'readonly': readonly}
    managed = {'systems': ('pages', 'system-script'), 'datasources': ('procedures', 'tables', 'views')}
    for kind, identifier in sorted(roots):
        for area in managed[kind]:
            root = store.root / kind / identifier / area
            relative_root = f'{kind}/{identifier}/{area}'
            if _has_symlink(store.root, root):
                blocked.append((relative_root, 'SYMLINK')); continue
            for path in dirty - registered:
                if path.startswith(relative_root + '/'):
                    blocked.append((path, 'DIRTY'))
            if not root.is_dir():
                continue
            def fail_scan(error):
                raise error
            for directory, subdirs, files in os.walk(root, followlinks=False, onerror=fail_scan):
                for name in list(subdirs):
                    if name.startswith('.'):
                        subdirs.remove(name); continue
                    candidate = Path(directory) / name
                    if candidate.is_symlink():
                        blocked.append((candidate.relative_to(store.root).as_posix(), 'SYMLINK'))
                        subdirs.remove(name)
                for name in files:
                    if name.startswith('.'):
                        continue
                    candidate = Path(directory) / name
                    relative = candidate.relative_to(store.root).as_posix()
                    if relative not in registered and relative not in dirty:
                        blocked.append((relative, 'UNREGISTERED'))
    if blocked:
        detail = ', '.join(f'{path} ({reason})' for path, reason in blocked[:100])
        raise ApiError('API_SCOPE_LOCAL_CHANGES', f'退出范围存在 {len(blocked)} 项本地修改、草稿或未登记文件，请先处理并重新选择：{detail}')
    return target, excluded, metadata_complete


def _cleanup_excluded(workspace, store, operation, excluded):
    backup = store.directory / 'operations' / operation['operationId'] / 'cleanup'
    cleanup = operation['cleanup']
    dirty_lock = store.directory / 'editors.lock'
    with file_lock(store.directory / 'source.lock'):
        with closing(sqlite3.connect(store.path)) as conn:
            for path, expected in excluded.items():
                if expected['hash'] is None:
                    continue
                with file_lock(dirty_lock):
                    if path in _dirty_paths(workspace):
                        raise ApiError('API_SCOPE_LOCAL_CHANGES', f'清理前出现未保存草稿，请处理并重新选择：{path}')
                    row = conn.execute('SELECT metadata,readonly FROM source WHERE path=?', (path,)).fetchone()
                    target = store._path(path)
                    if not row or row[0] != expected['metadata'] or row[1] != expected['readonly'] or store._conflict_path(path).is_file():
                        raise ApiError('API_SCOPE_STALE', f'清理前源码基线已变化：{path}')
                    if not json.loads(row[0]).get('remoteHash'):
                        baseline = conn.execute('SELECT content FROM source WHERE path=?', (path,)).fetchone()[0]
                        if digest(baseline) != expected['baseHash']:
                            raise ApiError('API_SCOPE_STALE', f'清理前源码基线已变化：{path}')
                    if _has_symlink(store.root, target) or not target.is_file():
                        raise ApiError('API_SCOPE_STALE', f'清理前源码路径已变化：{path}')
                    if _file_identity(target.stat()) != expected['identity']:
                        raise ApiError('API_SCOPE_LOCAL_CHANGES', f'清理前源码身份或状态已变化，请处理并重新选择：{path}')
                    raw = target.read_bytes()
                    if hashlib.sha256(raw).hexdigest() != expected['hash']:
                        raise ApiError('API_SCOPE_LOCAL_CHANGES', f'清理前源码已修改，请处理并重新选择：{path}')
                    mode = stat.S_IMODE(target.stat().st_mode)
                    backup_file = hashlib.sha256(path.encode()).hexdigest() + '.bin'
                    atomic_bytes(backup / backup_file, raw)
                    cleanup['backupPath'] = str(backup)
                    if hashlib.sha256((backup / backup_file).read_bytes()).hexdigest() != expected['hash']:
                        raise ApiError('API_SCOPE_BACKUP_FAILED', f'源码备份核验失败：{path}')
                    with open(backup / 'manifest.ndjson', 'a', encoding='utf-8',
                              opener=lambda name, flags: os.open(name, flags, 0o600)) as manifest:
                        manifest.write(json.dumps({'path': path, 'sha256': expected['hash'], 'mode': mode,
                                                   'backupFile': backup_file}, ensure_ascii=False) + '\n')
                        manifest.flush(); os.fsync(manifest.fileno())
                    if _file_identity(target.stat()) != expected['identity']:
                        raise ApiError('API_SCOPE_LOCAL_CHANGES', f'备份期间源码已变化，请处理并重新选择：{path}')
                    target.unlink()
                    cleanup['removedCount'] += 1
                    if len(cleanup['removedPaths']) < 100:
                        cleanup['removedPaths'].append(path)
                    parent = target.parent
                    while parent != store.root and parent.is_relative_to(store.root):
                        try: parent.rmdir()
                        except OSError: break
                        parent = parent.parent


def _publish_and_index(workspace, store, files, scope, *, authoritative, on_published=None):
    from .module_parameters import DIRECTORY_PATH, SOURCE_TYPE
    authoritative_types = None
    if any(item.path == DIRECTORY_PATH for item in files):
        authoritative_types = {item.kind for item in files}
        if store.path.is_file():
            with closing(sqlite3.connect(store.path)) as conn:
                authoritative_types.update(row[0] for row in conn.execute("SELECT DISTINCT json_extract(metadata,'$.sourceType') FROM source"))
        # Detail snapshots are an on-demand editing cache, not absent downloads.
        authoritative_types.discard(SOURCE_TYPE)
    result = store.publish(files, scope=scope, authoritative=authoritative,
                           authoritative_source_types=authoritative_types)
    if on_published is not None:
        on_published(result)
    from .index import rebuild

    result["index"] = rebuild(workspace)
    result["downloadComplete"] = result["complete"]
    result["complete"] = result["complete"] and result["index"]["complete"]
    return {**result, "downloadedFiles": len(files), "checkoutPath": str(workspace["providerSourceRoot"])}


def pull(workspace, client):
    selected = pending_scope(workspace, settings(workspace))
    if selected is not None:
        return scope_apply(workspace, client, {"settings": selected}, apply_pending=True)
    directory, _ = api_paths(workspace)
    with file_lock(directory / "sync.lock"):
        store = ApiStore(workspace)
        files, scope = download(
            client,
            settings(workspace),
            on_project=lambda systems, sources: save_project(
                workspace, systems, sources
            ),
            page_store=store,
        )
        assert_writable(workspace, sorted(set(store.paths()) | {item.path for item in files}))
        return _publish_and_index(workspace, store, files, scope, authoritative=True)


def scope_apply(workspace, client, payload, *, apply_pending=False):
    if not isinstance(payload, dict) or set(payload) != {"settings"}:
        raise ApiError("API_INPUT_INVALID", "范围同步需要 settings 对象")
    before = settings(workspace)
    selected = validate_scope_selection(payload["settings"], before)
    if apply_pending and pending_scope(workspace, before) != selected:
        raise ApiError("API_SCOPE_STALE", "同步范围已变化，请重新点击更新源码")
    proposed = {**before, **selected}
    store = ApiStore(workspace)
    target_snapshot, excluded, metadata_complete = _scope_snapshot(workspace, store, proposed)
    if client is None:
        client = client_for(workspace, authenticated=True)
    if client.root_url != before["serverUrl"]:
        raise ApiError("API_SCOPE_STALE", "平台连接已变化，请重新选择范围")
    project = {}
    def capture(systems, sources):
        project.update(systems=systems, sources=sources)
    files, scope = download(client, proposed, on_project=capture, page_store=store)
    directory, _ = api_paths(workspace)
    with configuration_lock(workspace), file_lock(directory / "sync.lock"), file_lock(directory / "source.lock"):
        if settings(workspace) != before:
            raise ApiError("API_SCOPE_STALE", "下载期间项目设置已变化，请重新选择范围")
        if apply_pending and pending_scope(workspace, before) != selected:
            raise ApiError("API_SCOPE_STALE", "下载期间同步范围已变化，请重新点击更新源码")
        store = ApiStore(workspace)
        target_current, excluded_current, metadata_now = _scope_snapshot(workspace, store, proposed)
        if target_current != target_snapshot or excluded_current != excluded or metadata_now != metadata_complete:
            raise ApiError('API_SCOPE_STALE', '下载期间退出范围的源码、基线或项目目录已变化，请重新选择')
        target_scope = {**scope, "systemIds": set(scope["systemIds"]),
                        "dataSourceIds": set(scope["dataSourceIds"]),
                        "includeProjectFiles": proposed["includeProjectFiles"]}
        if metadata_complete and any(target_scope[key] != target_snapshot[key] for key in ('systemIds', 'dataSourceIds', 'includeProjectFiles')):
            raise ApiError('API_SCOPE_STALE', '平台子系统或数据源关联已变化，请刷新目录后重新选择')
        active = set()
        if store.path.is_file():
            with closing(sqlite3.connect(store.path)) as conn:
                for path, raw_meta in conn.execute("SELECT path,metadata FROM source"):
                    meta = json.loads(raw_meta)
                    if in_scope(workspace, path, meta, scope=target_scope):
                        active.add(path)
        assert_writable(workspace, sorted(active | {item.path for item in files}))
        operation = {"operationId": uuid.uuid4().hex, "kind": "scope-apply", "stage": "PREPARED",
                     "workspaceKey": workspace["workspaceKey"], "settingsSaved": False,
                     "remoteDownloadComplete": True, "downloadComplete": False,
                     "downloadedFiles": len(files), "complete": False, "index": None,
                     "cleanup": {"removedCount": 0, "removedPaths": [], "backupPath": None, "blocked": []},
                     "checkoutPath": str(workspace["providerSourceRoot"])}
        store._receipt(operation)
        try:
            operation["stage"] = "CONFIGURING"
            store._receipt(operation)
            configured = configure(workspace, selected)
            operation.update(settings=configured, settingsSaved=True, stage="SCOPE_SAVED")
            store._receipt(operation)
            save_project(workspace, project["systems"], project["sources"])
            operation["stage"] = "PUBLISHING"
            store._receipt(operation)
            def published(result):
                operation.update(stage="INDEXING", publication=result,
                                 publicationOperationId=result["operationId"],
                                 publicationState="COMPLETE" if result["complete"] else "PARTIAL",
                                 downloadComplete=result["complete"],
                                 applied=result["updated"] + result["preserved"],
                                 updated=result["updated"], preserved=result["preserved"],
                                 deleted=result["deleted"], conflicts=result["conflicts"])
                store._receipt(operation)
            publication = _publish_and_index(workspace, store, files, scope, authoritative=True, on_published=published)
            operation.update(publication=publication, index=publication["index"],
                             publicationOperationId=publication["operationId"],
                             complete=publication["complete"],
                             stage="COMPLETE" if publication["complete"] else "PARTIAL")
            if publication['downloadComplete'] and publication['index'].get('indexGeneration'):
                operation['stage'] = 'CLEANUP'
                store._receipt(operation)
                _cleanup_excluded(workspace, store, operation, excluded_current)
                operation['stage'] = 'COMPLETE' if operation['complete'] else 'PARTIAL'
            else:
                operation['cleanup']['blocked'].append('PUBLICATION_OR_INDEX_INCOMPLETE')
                operation.update(complete=False, stage='PARTIAL')
            operation['removedPaths'] = operation['cleanup']['removedPaths']
            operation['cleanup']['truncated'] = operation['cleanup']['removedCount'] > len(operation['cleanup']['removedPaths'])
        except Exception as error:
            from common.command_errors import error_code
            failed_stage = operation["stage"]
            if failed_stage == "CONFIGURING":
                try:
                    actual = settings(workspace)
                    operation.update(settings=actual, settingsSaved=actual != before)
                except Exception:
                    operation["settingsSaved"] = None
            operation.update(stage="FAILED" if operation["settingsSaved"] is False else "PARTIAL",
                             failedStage=failed_stage,
                             complete=False, error={"code": error_code(error), "message": str(error)})
            if "publicationState" not in operation:
                operation["publicationState"] = "PARTIAL_OR_UNKNOWN" if failed_stage == "PUBLISHING" else "NOT_STARTED"
            if failed_stage == 'CLEANUP':
                operation['cleanup']['blocked'].append({'code': error_code(error), 'message': str(error)})
                operation['removedPaths'] = operation['cleanup']['removedPaths']
                operation['cleanup']['truncated'] = operation['cleanup']['removedCount'] > len(operation['cleanup']['removedPaths'])
        store._receipt(operation)
        if (apply_pending and operation["settingsSaved"] and operation["downloadComplete"]
                and (operation["index"] or {}).get("indexGeneration")
                and not operation["cleanup"]["blocked"] and not operation.get("error")):
            clear_pending_scope(workspace)
        return operation


def target(workspace, payload):
    store = ApiStore(workspace)
    if payload.get("path"):
        return store.read(payload["path"])
    kind = payload.get("sourceType")
    if kind == "bill-type":
        raise ApiError(
            "API_SOURCE_UNAVAILABLE",
            "官方源码接口未提供单据类型；请使用保留的只读导出功能",
        )
    if kind not in {"page", "procedure", "table", "view", "system-script"}:
        raise ApiError("API_INPUT_INVALID", "请提供精确对象类型和身份")
    identity = {
        "page": "pageId",
        "procedure": "funId",
        "table": "tableId",
        "view": "viewId",
        "system-script": "scriptType",
    }[kind]
    identifier = payload.get(identity) or payload.get("sourceId")
    if not identifier:
        raise ApiError("API_IDENTITY_MISSING", "缺少精确源码对象身份")
    matches = []
    for row in store.status():
        m = row["metadata"]
        if (
            not row["inScope"]
            or row["sourceType"] != kind
            or str(m.get(identity)) != str(identifier)
        ):
            continue
        if any(
            payload.get(k) and str(m.get(k)) != str(payload[k])
            for k in ("systemId", "dataSourceId", "procedureId")
        ):
            continue
        if payload.get("alias") and payload["alias"] not in {
            m.get("subPath"),
            m.get("procedureId"),
            m.get("pageAliasId"),
        }:
            continue
        matches.append(row)
    if len(matches) != 1:
        raise ApiError(
            "API_IDENTITY_AMBIGUOUS" if matches else "API_SOURCE_NOT_FOUND",
            "当前项目范围内未找到唯一精确对象，请先拉取对应子系统/数据源",
        )
    return store.read(matches[0]["path"])


def refresh(workspace, client, payload):
    # These logical objects share physical files; their typed handlers own the lock.
    path = payload.get("path")
    if path and "prefix" not in payload and "prefixes" not in payload:
        from .module_parameters import DIRECTORY_PATH, sync_parameters
        if path == DIRECTORY_PATH:
            return sync_parameters(workspace, client)
        if isinstance(path, str) and (path in {"otherconfig/bill-type.md", "otherconfig/dropdown.md"}
                                     or path.startswith("skills/")):
            from .reference_assets import sync_references
            return sync_references(workspace, client, [path])
    directory, _ = api_paths(workspace)
    with file_lock(directory / "sync.lock"):
        if "prefix" in payload or "prefixes" in payload:
            if "prefix" in payload and "prefixes" in payload or payload.get("path"):
                raise ApiError("API_INPUT_INVALID", "请选择单一的路径或前缀输入")
            prefixes = [payload["prefix"]] if "prefix" in payload else payload["prefixes"]
            if not isinstance(prefixes, list) or not prefixes or len(prefixes) > 200:
                raise ApiError("API_INPUT_INVALID", "需要1至200个源码目录前缀")
            files = download_prefixes(client, prefixes, active_scope(workspace),
                                      project_metadata(workspace).get("systems", []), page_store=ApiStore(workspace))
            store = ApiStore(workspace)
            identity_keys = {"page": ("systemId", "pageId"), "procedure": ("dataSourceId", "procedureId", "funId"),
                             "table": ("dataSourceId", "tableId"), "view": ("dataSourceId", "viewId"),
                             "system-script": ("systemId", "scriptType"), "module-parameter": ("systemId", "configId")}
            incoming = {}
            for item in files:
                keys = identity_keys.get(item.kind)
                if keys is None:
                    continue
                identity = (item.kind, *(str(item.metadata[key]) for key in keys))
                if identity in incoming and incoming[identity] != item.path:
                    raise ApiError("API_IDENTITY_AMBIGUOUS", "同一远端对象返回了多个路径，未发布源码")
                incoming[identity] = item.path
            if store.path.is_file():
                with closing(sqlite3.connect(store.path)) as conn:
                    for previous_path, raw_metadata in conn.execute("SELECT path,metadata FROM source"):
                        metadata = json.loads(raw_metadata)
                        kind = metadata.get("sourceType")
                        if kind not in identity_keys:
                            continue
                        identity = (kind, *(str(metadata.get(key, "")) for key in identity_keys[kind]))
                        if identity in incoming and incoming[identity] != previous_path:
                            raise ApiError("API_REMOTE_PATH_CHANGED", "远端对象路径已变化，请更新当前范围并核对迁移；未创建重复源码")
            result = store.publish(files, scope={"prefixes": prefixes})
            from .index import update

            result["index"] = update(workspace, [item.path for item in files])
            result["downloadComplete"] = result["complete"]
            result["complete"] = result["complete"] and result["index"]["complete"]
            return {**result, "prefixes": prefixes, "downloadedFiles": len(files),
                    "checkoutPath": str(workspace["providerSourceRoot"])}
        source = target(workspace, payload)
        files = fetch_object(client, source["metadata"], page_store=ApiStore(workspace))
        main = [item for item in files if item.kind == source["metadata"]["sourceType"]]
        if len(main) != 1 or main[0].path != source["path"]:
            raise ApiError(
                "API_REMOTE_PATH_CHANGED",
                "平台对象路径已变化，请更新当前范围后核对迁移；未创建重复源码",
            )
        result = ApiStore(workspace).publish(files)
        from .index import update

        result["index"] = update(workspace, [x.path for x in files])
        result["downloadComplete"] = result["complete"]
        result["complete"] = result["complete"] and result["index"]["complete"]
        return {
            **result,
            "path": source["path"],
            "sourcePath": str(workspace["providerSourceRoot"] / source["path"]),
            "sourceType": source["metadata"]["sourceType"],
            "metadata": source["metadata"],
            "checkoutPath": str(workspace["providerSourceRoot"]),
        }


UPLOADS = {
    "page": ("commitModulePage.htm", ("pageId", "pageType", "versionMac")),
    "procedure": ("commitProcFun.htm", ("procedureId", "funId", "versionMac")),
    "table": ("commitTable.htm", ("tableId",)),
    "view": ("commitView.htm", ("pkid", "viewId")),
    "system-script": ("commitSystemScript.htm", ("systemId", "scriptType")),
}


def upload(workspace, client, payload):
    store = ApiStore(workspace)
    directory, _ = api_paths(workspace)
    paths = payload.get("paths")
    if paths is None:
        paths = [
            x["path"]
            for x in store.status()
            if x["inScope"] and x["state"] == "MODIFIED" and not x["readonly"]
        ]
    if (
        not isinstance(paths, list)
        or not paths
        or len(paths) > 200
        or any(not isinstance(x, str) for x in paths)
    ):
        raise ApiError("API_INPUT_INVALID", "上传需要1至200个精确源码路径")
    paths = list(dict.fromkeys(paths))
    if any(store.read(path)["metadata"].get("sourceType")=="module-parameter" for path in paths):
        raise ApiError("API_MODULE_UPLOAD_PREVIEW_REQUIRED","模块参数需使用模块参数上传预览与确认流程")
    expected = payload.get("expectedHashes", {})
    if not isinstance(expected, dict) or any(
        not isinstance(k, str) or not isinstance(v, str) for k, v in expected.items()
    ):
        raise ApiError("API_INPUT_INVALID", "expectedHashes必须为路径与哈希映射")
    remark = payload.get("remark", "")
    if not isinstance(remark, str):
        raise ApiError("API_INPUT_INVALID", "上传备注必须为文本")
    remark = remark.strip()
    if payload.get("confirm") is not True:
        raise ApiError(
            "API_CONFIRMATION_REQUIRED", "上传会修改开发平台，请确认本次上传对象"
        )
    operation = {
        "operationId": uuid.uuid4().hex,
        "kind": "upload",
        "paths": paths,
        "stage": "PREPARED",
        "results": [],
    }
    if remark:
        operation["remark"] = remark
    store._receipt(operation)
    with file_lock(directory / "sync.lock"):
        assert_writable(workspace, paths)
        native_pages = {}
        # Validate every selected object before the first platform mutation.
        for path in paths:
            current = store.read(path)
            if expected.get(path) and current["sourceHash"] != expected[path]:
                raise ApiError("API_SOURCE_STALE", "确认上传后本地源码发生变化")
            if current["readonly"] or current["metadata"]["sourceType"] not in UPLOADS:
                raise ApiError("API_SOURCE_READONLY", "选择包含继承或不可上传资料")
            from .content import validate_candidate

            validate_candidate(
                path, current["metadata"], store.baseline(path), current["content"]
            )
            if page_source.structured(current["metadata"], path):
                native_pages[path] = page_source.check_before_upload(client, current, store.baseline(path))
            if current["metadata"].get("remoteDeleted"):
                raise ApiError(
                    "API_REMOTE_DELETED", "远端已删除的对象不能作为现有对象上传"
                )
        for path in paths:
            result = {"path": path, "stage": "PRECHECK"}
            operation["results"].append(result)
            store._receipt(operation)
            try:
                current = store.read(path)
                kind = current["metadata"]["sourceType"]
                if current["sourceHash"] == current["baseHash"]:
                    result["stage"] = "UNCHANGED"
                    continue
                if path in native_pages:
                    page_source.finish_upload(store, client, current, result, operation, native_pages[path])
                    continue
                remote = fetch_object(client, current["metadata"])
                main = [item for item in remote if item.kind == kind]
                if len(main) != 1 or main[0].path != path:
                    raise ApiError(
                        "API_REMOTE_PATH_CHANGED",
                        "平台对象路径已变化，未合并或上传；请先核对对象迁移",
                    )
                merged = store.publish(remote)
                if merged["conflicts"]:
                    raise ApiError(
                        "API_MERGE_CONFLICT", "本地与平台有冲突，请先解决冲突"
                    )
                current = store.read(path)
                m = current["metadata"]
                if current["sourceHash"] == current["baseHash"]:
                    result["stage"] = "ALREADY_REMOTE"
                    continue
                # Match the official routes: table identity is in native JSON;
                # views use the exact PKID together with their view ID.
                if kind == "view" and (
                    type(m.get("pkid")) is not int or m["pkid"] <= 0
                ):
                    raise ApiError("API_IDENTITY_MISSING", "视图缺少明确的PKID，未上传")
                from .content import validate_candidate

                validate_candidate(path, m, store.baseline(path), current["content"])
                endpoint, keys = UPLOADS[kind]
                form = {key: m.get(key, "") for key in keys}
                form["base64"] = quote(
                    base64.b64encode(current["content"].encode("utf-8")).decode(),
                    safe="",
                )
                result.update(
                    stage="REMOTE_REQUEST_PREPARED",
                    beforeHash=current["baseHash"],
                    submittedHash=current["sourceHash"],
                )
                atomic_text(
                    directory
                    / "operations"
                    / operation["operationId"]
                    / ("submitted-" + digest(path) + ".txt"),
                    current["content"],
                )
                store._receipt(operation)
                if store.read(path)["sourceHash"] != result["submittedHash"]:
                    raise ApiError("API_SOURCE_STALE", "上传前本地源码发生变化")
                result["stage"] = "REMOTE_REQUEST_STARTED"
                store._receipt(operation)
                response_error = None
                try:
                    response = client.request(
                        "/develop/vscode/source/upload/" + endpoint, form=form
                    )
                except ApiError as error:
                    if error.code in {
                        "API_CONNECTION_FAILED",
                        "API_RESPONSE_INVALID",
                        "API_HTTP_ERROR",
                    }:
                        response_error = error
                    else:
                        result["stage"] = "REMOTE_REJECTED"
                        raise
                else:
                    accepted = files_from_item(
                        m,
                        response.get("item") if isinstance(response, dict) else None,
                        expected_path=path,
                    )
                    accepted_main = next(x for x in accepted if x.path == path)
                    result.update(
                        stage="REMOTE_ACKNOWLEDGED",
                        acceptedHash=digest(accepted_main.content),
                        sourceNormalized=accepted_main.content != current["content"],
                    )
                    atomic_text(
                        directory / "operations" / operation["operationId"]
                        / ("accepted-" + digest(path) + ".txt"),
                        accepted_main.content,
                    )
                    store._receipt(operation)
                # A timeout is an unknown result. Read the remote object; never retry its POST.
                verified = fetch_object(client, m)
                exact = [x for x in verified if x.path == path]
                if (
                    len(exact) != 1
                    or digest(exact[0].content)
                    != result.get("acceptedHash", result["submittedHash"])
                ):
                    if response_error:
                        raise ApiError(
                            "API_REMOTE_RESULT_UNKNOWN",
                            "上传应答未知且回读未确认，不自动重试；请检查操作记录",
                        ) from response_error
                    raise ApiError(
                        "API_UPLOAD_READBACK_MISMATCH",
                        "平台回读与上传应答的源码不同，未标记上传成功",
                    )
                published = store.publish(
                    verified, uploaded_content={path: current["content"]}
                )
                if published["conflicts"]:
                    raise ApiError(
                        "API_LOCAL_AFTER_UPLOAD_CONFLICT",
                        "平台已回读，但本地更新冲突，请检查操作记录",
                    )
                result.update(
                    stage="REMOTE_READBACK_VERIFIED",
                    remoteHash=digest(exact[0].content),
                )
            except ApiError as error:
                unknown = result.get("stage") in {
                    "REMOTE_REQUEST_STARTED",
                    "REMOTE_ACKNOWLEDGED",
                }
                result.update(
                    stage="UNKNOWN" if unknown else "FAILED",
                    code=error.code,
                    message=str(error),
                )
                break
            finally:
                store._receipt(operation)
        operation["stage"] = (
            "REMOTE_READBACK_VERIFIED"
            if len(operation["results"]) == len(paths)
            and all(
                x["stage"]
                in {"REMOTE_READBACK_VERIFIED", "UNCHANGED", "ALREADY_REMOTE"}
                for x in operation["results"]
            )
            else "PARTIAL"
        )
        store._receipt(operation)
        from .index import update

        update(workspace, paths)
    return {
        **operation,
        "complete": operation["stage"] == "REMOTE_READBACK_VERIFIED",
        "uploaded": sum(
            x["stage"] == "REMOTE_READBACK_VERIFIED" for x in operation["results"]
        ),
        "platformFinalSubmit": "NOT_PERFORMED",
    }


def sync_database(workspace, client, payload):
    source = target(workspace, payload)
    store = ApiStore(workspace)
    m = source["metadata"]
    kind = m["sourceType"]
    if kind not in {"table", "view"}:
        raise ApiError("API_INPUT_INVALID", "只支持表/视图结构同步")
    if payload.get("confirm") is not True:
        raise ApiError(
            "API_CONFIRMATION_REQUIRED",
            "结构同步会在开发平台执行数据库DDL，需要明确确认",
        )
    assert_writable(workspace, [source["path"]])
    if source["sourceHash"] != source["baseHash"]:
        raise ApiError("API_LOCAL_MODIFIED", "请先上传并回读当前结构修改")
    pkid = m.get("pkid")
    if type(pkid) is not int:
        raise ApiError("API_IDENTITY_MISSING", "结构缺少数值pkid，不能执行结构同步")
    operation = {
        "operationId": uuid.uuid4().hex,
        "kind": "database-structure",
        "path": source["path"],
        "pkid": pkid,
        "stage": "REMOTE_REQUEST_STARTED",
    }
    store._receipt(operation)
    endpoint = "/develop/systems/" + (
        "tables/createTable.htm" if kind == "table" else "views/createView.htm"
    )
    try:
        client.request(endpoint, form={"pkid": str(pkid)})
        operation["stage"] = "PLATFORM_ACKNOWLEDGED"
        operation["databaseVerification"] = "NOT_PERFORMED"
    except ApiError as error:
        operation.update(
            stage="UNKNOWN"
            if error.code
            in {"API_CONNECTION_FAILED", "API_RESPONSE_INVALID", "API_HTTP_ERROR"}
            else "FAILED",
            code=error.code,
            message=str(error),
        )
        raise
    finally:
        store._receipt(operation)
    return operation


def create_function(workspace, client, payload):
    """Create an official procedure function and fetch its exact server representation."""
    for key in ("procedureId", "funId", "funName", "dataSourceId"):
        if not isinstance(payload.get(key), str) or not payload[key].strip():
            raise ApiError("API_INPUT_INVALID", key + "不能为空")
    if len(payload["funName"].encode("utf-8")) > 400:
        raise ApiError("API_INPUT_INVALID", "函数描述不能超过400字节")
    if any(type(payload.get(key)) is not bool for key in ("isTran", "isReturn")):
        raise ApiError("API_INPUT_INVALID", "事务/返回值标记必须为布尔值")
    if payload.get("confirm") is not True:
        raise ApiError(
            "API_CONFIRMATION_REQUIRED", "创建过程函数会修改平台，需要明确确认"
        )
    ds = payload["dataSourceId"]
    if ds not in active_scope(workspace)["dataSourceIds"]:
        raise ApiError("API_SOURCE_OUT_OF_SCOPE", "过程包不在当前项目选定的数据源内")
    from .download import paged

    procedures = paged(client, BASE + "getProcedures.htm", {"dataSourceId": ds})
    packages = [
        x for x in procedures if str(x.get("procedureId")) == payload["procedureId"]
    ]
    if len(packages) != 1:
        raise ApiError("API_IDENTITY_AMBIGUOUS", "未找到唯一过程包")
    package = packages[0]
    if str(package.get("dataSourceId", ds)) != ds:
        raise ApiError("API_IDENTITY_MISMATCH", "过程包数据源不匹配")
    from .download import function_files, required
    required(package, ("subPath", "procedureId"))
    prospective = function_files({"funId": payload["funId"], "funScript": ""}, ds,
                                 package["subPath"], package["procedureId"])
    assert_writable(workspace, [item.path for item in prospective])
    if any(
        str(x.get("funId")) == payload["funId"] for x in records(package.get("funs"))
    ):
        raise ApiError("API_SOURCE_EXISTS", "同名函数已存在，请编辑现有函数")
    store = ApiStore(workspace)
    operation = {
        "operationId": uuid.uuid4().hex,
        "kind": "create-function",
        "stage": "REMOTE_REQUEST_STARTED",
        "procedureId": payload["procedureId"],
        "funId": payload["funId"],
        "dataSourceId": ds,
    }
    store._receipt(operation)
    form = {k: payload[k] for k in ("procedureId", "funId", "funName")}
    form.update(
        opt="new",
        isTran="1" if payload["isTran"] else "0",
        isReturn="1" if payload["isReturn"] else "0",
    )
    try:
        client.request("/develop/procedure/admin/saveFunInfo.htm", form=form)
        files = fetch_object(
            client,
            {
                "sourceType": "procedure",
                "procedureId": payload["procedureId"],
                "funId": payload["funId"],
                "dataSourceId": ds,
                "subPath": package["subPath"],
            },
        )
        operation["publication"] = store.publish(files)
        operation["stage"] = "REMOTE_READBACK_VERIFIED"
        from .index import update

        update(workspace, [x.path for x in files])
    except ApiError as error:
        operation.update(
            stage="UNKNOWN"
            if error.code
            in {"API_CONNECTION_FAILED", "API_RESPONSE_INVALID", "API_HTTP_ERROR"}
            else "FAILED",
            code=error.code,
            message=str(error),
        )
        raise
    finally:
        store._receipt(operation)
    return operation


def verify_upload(workspace, client, operation_id):
    """Reconcile an interrupted receipt using GETs; this never repeats a mutation."""
    store = ApiStore(workspace)
    operation = store.operation(operation_id)
    if operation.get("kind") != "upload":
        raise ApiError("API_INPUT_INVALID", "请选择上传操作记录")
    with file_lock(store.directory / "sync.lock"):
        for result in operation["results"]:
            if result.get("stage") not in {
                "UNKNOWN",
                "REMOTE_REQUEST_STARTED",
                "REMOTE_ACKNOWLEDGED",
            }:
                continue
            source = store.read(result["path"])
            if result.get("pageProtocol") == "native-json":
                try:
                    page_source.finish_upload(store, client, source, result, operation)
                except ApiError as error:
                    result.update(stage="UNKNOWN", code=error.code, message=str(error))
                store._receipt(operation)
                continue
            files = fetch_object(client, source["metadata"])
            exact = [x for x in files if x.path == result["path"]]
            if len(exact) == 1 and digest(exact[0].content) == result.get(
                "acceptedHash", result.get("submittedHash")
            ):
                submitted = (
                    store.directory / "operations" / operation_id
                    / ("submitted-" + digest(result["path"]) + ".txt")
                ).read_text(encoding="utf-8")
                if digest(submitted) != result["submittedHash"]:
                    raise ApiError("API_OPERATION_INVALID", "提交记录正文与哈希不一致")
                published = store.publish(
                    files, uploaded_content={result["path"]: submitted}
                )
                result["stage"] = "REMOTE_READBACK_VERIFIED"
                result["remoteHash"] = digest(exact[0].content)
                result["localConflicts"] = published["conflicts"]
            else:
                result.update(
                    stage="UNKNOWN",
                    message="当前平台内容不能证明先前上传结果；请人工核对，不自动重发",
                )
            store._receipt(operation)
        operation["stage"] = (
            "REMOTE_READBACK_VERIFIED"
            if len(operation["results"]) == len(operation["paths"])
            and all(
                x["stage"]
                in {"REMOTE_READBACK_VERIFIED", "UNCHANGED", "ALREADY_REMOTE"}
                for x in operation["results"]
            )
            else "PARTIAL"
        )
        store._receipt(operation)
        from .index import update

        update(workspace, [x["path"] for x in operation["results"]])
    return {
        **operation,
        "complete": operation["stage"] == "REMOTE_READBACK_VERIFIED",
        "mutationRetried": False,
    }


def platform_request(workspace, client, payload):
    """Explicit same-project request for platform functions outside typed commands."""
    from urllib.parse import urlsplit
    import json

    path = payload.get("path")
    method = payload.get("method", "GET")
    if (
        not isinstance(path, str)
        or not path.startswith("/develop/")
        or path.startswith("/develop/login/")
    ):
        raise ApiError(
            "API_INPUT_INVALID",
            "请输入当前项目的 /develop/ 业务接口；登录由独立认证入口处理",
        )
    parts = urlsplit(path)
    if (
        parts.netloc
        or parts.scheme
        or parts.query
        or parts.fragment
        or "\\" in path
        or ".." in path.split("/")
    ):
        raise ApiError(
            "API_INPUT_INVALID", "接口仅接受当前项目相对路径，查询参数单独提供"
        )
    if method not in {"GET", "POST"}:
        raise ApiError("API_INPUT_INVALID", "接口方法仅支持GET/POST")
    params = payload.get("params", {})
    form = payload.get("form", {})
    for values in (params, form):
        if not isinstance(values, dict) or any(
            not isinstance(k, str) or not isinstance(v, (str, int, float, bool))
            for k, v in values.items()
        ):
            raise ApiError("API_INPUT_INVALID", "参数必须为扁平JSON对象")
    scope = active_scope(workspace)
    for values in (params, form):
        if values.get("systemId") and str(values["systemId"]) not in scope["systemIds"]:
            raise ApiError("API_SOURCE_OUT_OF_SCOPE", "接口系统不在当前项目选择范围内")
        if (
            values.get("dataSourceId")
            and str(values["dataSourceId"]) not in scope["dataSourceIds"]
        ):
            raise ApiError(
                "API_SOURCE_OUT_OF_SCOPE", "接口数据源不在当前项目选择范围内"
            )
    if payload.get("confirm") is not True:
        raise ApiError(
            "API_CONFIRMATION_REQUIRED",
            "通用平台接口可能产生业务副作用，请明确确认当前接口与参数",
        )
    max_chars = payload.get("maxChars", 12000)
    if type(max_chars) is not int or not 1 <= max_chars <= 50000:
        raise ApiError("API_INPUT_INVALID", "maxChars必须在1至50000之间")
    store = ApiStore(workspace)
    operation = {
        "operationId": uuid.uuid4().hex,
        "kind": "platform-request",
        "method": method,
        "endpoint": path,
        "stage": "REMOTE_REQUEST_STARTED",
    }
    store._receipt(operation)
    try:
        response = client.request(
            path, params or None, **({"form": form} if method == "POST" else {})
        )
        operation["stage"] = "PLATFORM_ACKNOWLEDGED"
    except ApiError as error:
        operation.update(
            stage="UNKNOWN"
            if error.code
            in {"API_CONNECTION_FAILED", "API_HTTP_ERROR", "API_RESPONSE_INVALID"}
            else "FAILED",
            code=error.code,
            message=str(error),
        )
        raise
    finally:
        store._receipt(operation)
    content = json.dumps(response, ensure_ascii=False)
    return {
        **operation,
        "content": content[:max_chars],
        "totalChars": len(content),
        "truncated": len(content) > max_chars,
        "verification": "PLATFORM_RESPONSE_ONLY",
        "mutationRetried": False,
    }

"""Preview-bound local multi-file writes with durable recovery and no uploads."""
from __future__ import annotations
import hashlib
import json
import time
import uuid
from pathlib import Path
from common.persistence import atomic_bytes, atomic_text, file_lock
from .client import ApiError
from .local_mutation import local_mutation
from .source_requests import CLOSED_BEFORE_WRITE
from . import documents, index
from .store import ApiStore, digest
from .index import _scope_fingerprint


def _directory(workspace):
    return workspace['contextDir'] / 'api/source-batch'


def _load_plan(workspace, plan_id):
    documents._identifier(plan_id)
    value = json.loads((_directory(workspace) / 'plans' / (plan_id + '.json')).read_text())
    signature = {key: item for key, item in value.items() if key not in {'planHash', 'operationId'}}
    if value.get('workspaceKey') != workspace['workspaceKey'] or digest(json.dumps(signature, ensure_ascii=False, sort_keys=True)) != value.get('planHash'):
        raise ApiError('API_BATCH_PLAN_INVALID', '批量预览身份或内容校验失败')
    return value


def preview(workspace, changes):
    if not isinstance(changes, list) or not 1 <= len(changes) <= 200:
        raise ApiError('API_INPUT_INVALID', '批量预览需要1至200个源对象')
    items, owned, paths, budget = [], [], set(), 0
    store = ApiStore(workspace)
    try:
        with file_lock(store.directory / 'sync.lock'), file_lock(documents._directory(workspace) / 'documents.lock'), file_lock(store.directory / 'source.lock'):
            for change in changes:
                if not isinstance(change, dict) or set(change) - {'path', 'content', 'operations', 'expectedHash', 'leaseId', 'previewId'}:
                    raise ApiError('API_INPUT_INVALID', '批量项必须为明确路径和候选，或有效的租约/预览')
                if 'leaseId' in change or 'previewId' in change:
                    if set(change) != {'leaseId', 'previewId'}:
                        raise ApiError('API_INPUT_INVALID', '已有预览项只允许 leaseId 和 previewId 两个字段；不得附加 path、content、operations 或 expectedHash')
                    prepared = documents.preview_content(workspace, change['leaseId'], change['previewId'])
                else:
                    if ('content' in change) == ('operations' in change):
                        raise ApiError('API_INPUT_INVALID', '直接候选项必须为 path+content 或 path+operations，二者不能混用')
                    path = change.get('path')
                    if not isinstance(path, str):
                        raise ApiError('API_INPUT_INVALID', '批量项需要明确的源码路径')
                    if path in paths:
                        raise ApiError('API_IDENTITY_AMBIGUOUS', '同一文件在批次中只能出现一次')
                    current = store.read(path)
                    if change.get('expectedHash', current['sourceHash']) != current['sourceHash']:
                        raise ApiError('API_SOURCE_STALE', '批量项与当前源码不一致')
                    lease = documents.open_document(workspace, path)
                    owned.append(lease['leaseId'])
                    draft = documents.preview(workspace, lease['leaseId'], content=change.get('content'), operations=change.get('operations'))
                    prepared = documents.preview_content(workspace, lease['leaseId'], draft['previewId'])
                if prepared['path'] in paths:
                    raise ApiError('API_IDENTITY_AMBIGUOUS', '同一文件在批次中只能出现一次')
                current = store.prepare_write(prepared['path'], prepared['content'], prepared['sourceHash'])
                budget += len(prepared['content'].encode()) + len(current['content'].encode())
                if budget > 64 * 1024 * 1024:
                    raise ApiError('API_BATCH_TOO_LARGE', '批量候选与原文超过64MiB，请分批预览')
                paths.add(prepared['path'])
                items.append(prepared)
            value = {'workspaceKey': workspace['workspaceKey'], 'planId': uuid.uuid4().hex,
                     'scopeDigest': _scope_fingerprint(workspace), 'createdAt': time.time(), 'items': items}
            value['planHash'] = digest(json.dumps(value, ensure_ascii=False, sort_keys=True))
            destination = _directory(workspace) / 'plans' / (value['planId'] + '.json')
            atomic_text(destination, json.dumps(value, ensure_ascii=False))
    except BaseException:
        if owned:
            documents.complete_batch(workspace, owned, 'preview-rejected')
        raise
    return {'planId': value['planId'], 'planHash': value['planHash'], 'workspaceKey': workspace['workspaceKey'],
            'files': [{key: item[key] for key in ('path', 'sourceHash', 'candidateHash', 'leaseId', 'previewId')} for item in items],
            'complete': True, 'uploaded': False, 'platformWrite': False}


def _restore(store, record):
    errors = []
    for item in reversed(record['files']):
        try:
            current = store.read(item['path'])
            if current['sourceHash'] == item['beforeHash']:
                continue
            if current['sourceHash'] != item['afterHash']:
                raise ApiError('API_SOURCE_STALE', '出现外部修改，拒绝覆盖')
            folder = store.directory / 'operations' / item['writeOperationId']
            original = (folder / 'before.txt').read_bytes()
            if hashlib.sha256(original).hexdigest() != item['beforeHash']:
                raise ApiError('API_BATCH_BACKUP_INVALID', '批量原文备份校验失败')
            atomic_bytes(store._path(item['path']), original)
            store._path(item['path']).chmod(item['mode'])
            if store.read(item['path'])['sourceHash'] != item['beforeHash']:
                raise ApiError('API_BATCH_ROLLBACK_FAILED', '原文回读校验失败')
            child = store.operation(item['writeOperationId'])
            child.update(stage='LOCAL_WRITE_ROLLED_BACK', batchOperationId=record['operationId'])
            store._receipt(child)
        except (OSError, ApiError) as error:
            errors.append({'path': item['path'], 'code': getattr(error, 'code', type(error).__name__), 'message': str(error)})
    return errors


def apply(workspace, plan_id, plan_hash, idempotency_key, *, editor_token=None):
    with local_mutation(workspace['workspaceKey'], 'source-batch', planId=plan_id, planHash=plan_hash) as mutation:
        if not isinstance(idempotency_key, str) or not 1 <= len(idempotency_key) <= 256:
            raise ApiError('API_INPUT_INVALID', '批量写入需要明确的幂等键')
        store = ApiStore(workspace)
        with file_lock(store.directory / 'sync.lock'), file_lock(documents._directory(workspace) / 'documents.lock'), file_lock(store.directory / 'source.lock'):
            key_path = _directory(workspace) / 'keys' / (digest(idempotency_key) + '.json')
            if key_path.exists():
                key = json.loads(key_path.read_text())
                if key['planId'] != plan_id or key['planHash'] != plan_hash:
                    raise ApiError('API_IDEMPOTENCY_CONFLICT', '幂等键已用于其他批量计划')
                if key.get('state') == CLOSED_BEFORE_WRITE:
                    raise ApiError('API_SOURCE_REQUEST_CLOSED', '原幂等请求已在写入前关闭；不会派发源码写入')
                return store.operation(key['operationId'])
            plan = _load_plan(workspace, plan_id)
            if plan['planHash'] != plan_hash or plan['scopeDigest'] != _scope_fingerprint(workspace):
                raise ApiError('API_BATCH_PLAN_STALE', '批量预览或项目范围已变化，请重新预览')
            if plan.get('operationId'):
                raise ApiError('API_BATCH_PLAN_CONSUMED', '批量计划已派发，请核对原操作：' + plan['operationId'])
            files = []
            for item in plan['items']:
                current = documents.preview_content(workspace, item['leaseId'], item['previewId'])
                if current != item:
                    raise ApiError('API_BATCH_PLAN_STALE', '批量候选已变化')
                store.prepare_write(item['path'], item['content'], item['sourceHash'], editor_token=editor_token)
                files.append({'path': item['path'], 'beforeHash': item['sourceHash'], 'afterHash': item['candidateHash'],
                              'writeOperationId': uuid.uuid4().hex, 'mode': store._path(item['path']).stat().st_mode & 0o777})
            record = {'operationId': uuid.uuid4().hex, 'workspaceKey': workspace['workspaceKey'], 'kind': 'source-batch',
                      'planId': plan_id, 'planHash': plan_hash, 'stage': 'PREPARED', 'files': files,
                      'paths': [item['path'] for item in files], 'createdAt': time.time(), 'platformWrite': False, 'uploaded': False}
            store._receipt(record)
            mutation.update(state='PREPARED', operationId=record['operationId'])
            atomic_text(key_path, json.dumps({key: record[key] for key in ('planId', 'planHash', 'operationId')}))
            plan['operationId'] = record['operationId']
            atomic_text(_directory(workspace) / 'plans' / (plan_id + '.json'), json.dumps(plan, ensure_ascii=False))
            try:
                mutation['state'] = 'WRITE_STARTED'
                for item, saved in zip(plan['items'], files):
                    record.update(stage='WRITING', currentPath=item['path']);store._receipt(record)
                    written = store.write(item['path'], item['content'], item['sourceHash'], editor_token=editor_token, operation_id=saved['writeOperationId'])
                    if written['sourceHash'] != item['candidateHash']:
                        raise ApiError('API_BATCH_VERIFY_FAILED', '批量文件回读与候选不一致')
                    store._path(item['path']).chmod(saved['mode'])
                result = index.update(workspace, record['paths'])
                record.update(stage='VERIFIED' if result.get('complete') else 'INDEX_PARTIAL', complete=bool(result.get('complete')),
                              sourceWritesComplete=True, indexGeneration=result.get('indexGeneration'), indexDiagnosticCount=result.get('diagnosticCount', 0))
            except Exception as error:
                record.update(stage='ROLLING_BACK', error={'code': getattr(error, 'code', type(error).__name__), 'message': str(error)})
                store._receipt(record)
                failures = _restore(store, record)
                try:
                    index.update(workspace, record['paths'])
                except Exception as index_error:
                    failures.append({'stage': 'index', 'message': str(index_error)})
                record.update(stage='ROLLBACK_INCOMPLETE' if failures else 'ROLLED_BACK', complete=False, rollbackErrors=failures)
            finally:
                record.pop('currentPath', None);store._receipt(record)
                documents.complete_batch(workspace, [item['leaseId'] for item in plan['items']], record['operationId'])
            return record


def verify(workspace, operation_id):
    with file_lock(workspace["contextDir"] / "api/sync.lock"), file_lock(documents._directory(workspace) / "documents.lock"), file_lock(workspace["contextDir"] / "api/source.lock"):
        store = ApiStore(workspace);record = store.operation(operation_id)
        if record.get('kind') != 'source-batch' or record.get('workspaceKey') != workspace['workspaceKey']:
            raise ApiError('API_IDENTITY_MISMATCH', '操作不是当前项目的批量写入')
        files = []
        for item in record['files']:
            current = store.read(item['path'])
            state = 'UNCHANGED' if current['sourceHash'] == item['afterHash'] == item['beforeHash'] else 'AFTER' if current['sourceHash'] == item['afterHash'] else 'BEFORE' if current['sourceHash'] == item['beforeHash'] else 'EXTERNAL_CHANGE'
            files.append({'path': item['path'], 'state': state, 'actualHash': current['sourceHash']})
        return {**record, 'verification': files, 'matchesAfter': all(item['state'] in {'AFTER', 'UNCHANGED'} for item in files),
                'matchesBefore': all(item['state'] in {'BEFORE', 'UNCHANGED'} for item in files), 'mutationRetried': False}


def recover(workspace, operation_id, *, rollback=False, confirm=False):
    with local_mutation(workspace['workspaceKey'], 'source-batch', operationId=operation_id) as mutation:
        store = ApiStore(workspace)
        with file_lock(store.directory / 'sync.lock'), file_lock(documents._directory(workspace) / 'documents.lock'), file_lock(store.directory / 'source.lock'):
            checked = verify(workspace, operation_id)
            record = store.operation(operation_id)
            if any(item['state'] == 'EXTERNAL_CHANGE' for item in checked['verification']):
                raise ApiError('API_SOURCE_STALE', '批次之后有外部修改，保留现场，不覆盖或重放')
            if rollback:
                if confirm is not True:
                    raise ApiError('API_CONFIRMATION_REQUIRED', '恢复批次原文需要明确确认')
                from .editor_state import assert_writable
                assert_writable(workspace, record['paths'])
                mutation['state'] = 'WRITE_STARTED'
                errors = _restore(store, record)
                if errors:
                    record.update(stage='ROLLBACK_INCOMPLETE', complete=False, rollbackErrors=errors)
                    store._receipt(record);return record
            elif not checked['matchesAfter'] and not checked['matchesBefore']:
                return {**checked, 'stage':'RECOVERY_REQUIRED', 'rollbackConfirmationRequired':True}
            result = index.update(workspace, record['paths'])
            before = rollback or checked['matchesBefore'] and not checked['matchesAfter']
            record.update(stage='ROLLED_BACK' if before else 'VERIFIED' if result.get('complete') else 'INDEX_PARTIAL',
                          complete=not before and bool(result.get('complete')), mutationRetried=False, verifiedAt=time.time())
            plan = _load_plan(workspace, record['planId'])
            documents.complete_batch(workspace, [item['leaseId'] for item in plan['items']], record['operationId'])
            store._receipt(record)
            return {**record, **{key:value for key,value in verify(workspace, operation_id).items() if key in {'verification','matchesAfter','matchesBefore'}}}


def run(workspace, payload):
    action = payload.get('action')
    if action == 'preview':return preview(workspace, payload.get('changes'))
    if action == 'apply':return apply(workspace, payload.get('planId'), payload.get('planHash'), payload.get('idempotencyKey'), editor_token=payload.get('editorToken'))
    if action == 'verify':return verify(workspace, payload.get('operationId'))
    if action == 'recover':return recover(workspace, payload.get('operationId'), rollback=payload.get('rollback', False), confirm=payload.get('confirm', False))
    raise ApiError('API_INPUT_INVALID', '未知源码批量操作')

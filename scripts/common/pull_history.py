"""Bounded metadata history, private exports and recoverable local-log maintenance."""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from common.command_errors import CommandError
from common.persistence import atomic_bytes, atomic_text, file_lock
from common.workspace_identity import validate_workspace_key

READ_LIMIT = 2 * 1024 * 1024
SUMMARY_FIELDS = {'sourceType', 'sourceTable', 'sourceId', 'alias', 'funId', 'changed', 'pulled',
                  'workCopyStatus', 'workCopyAction', 'localChanged', 'revision', 'failures', 'status'}
COVERAGE = 'Only retained bounded windows; historical gaps and missing workspace identities are not reconstructed'
TERMINAL_STATUSES = {'OK', 'SUCCESS', 'FAILED', 'ERROR', 'COMPLETED'}


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)


def _paths(workspace, bridge_root):
    try:
        validate_workspace_key(workspace['workspaceKey'])
    except (ValueError, KeyError) as error:
        raise CommandError('INPUT_INVALID', '需要完整、明确的 workspaceKey') from error
    local = Path(workspace['logsDir']) / 'pull-log.ndjson'
    bridge = Path(bridge_root) / 'pull-log.ndjson'
    return [(base if not rotated else base.with_name(base.name + '.1'), label, rotated)
            for base, label in ((local, 'workspace'), (bridge, 'bridge')) for rotated in (False, True)]


def _unsafe_path(path):
    # macOS exposes its ordinary temporary roots through these system aliases.
    aliases = {Path('/var'): Path('/private/var'), Path('/tmp'): Path('/private/tmp')}
    return any(item.is_symlink() and not (item in aliases and item.resolve() == aliases[item])
               for item in (path, *path.parents))


def _signature(path):
    if _unsafe_path(path):
        raise CommandError('SYMLINK_DENIED', '拉取日志路径不能包含符号链接')
    try:
        stat = path.stat()
        return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]
    except FileNotFoundError:
        return None


def _record(line):
    value = json.loads(line)
    if not isinstance(value, dict) or not isinstance(value.get('ok'), bool):
        raise ValueError('record has no known outcome')
    blocks = [value.get(key) for key in ('summary', 'payload', 'result')]
    blocks = [block for block in blocks if isinstance(block, dict)]
    identities = [block['workspaceKey'] for block in [value, *blocks] if 'workspaceKey' in block]
    # Conflicting or invalid identities must never be assigned to one workspace.
    if any(not isinstance(key, str) or not key for key in identities) or len(set(identities)) > 1:
        raise ValueError('record has conflicting workspace identities')
    return value, blocks, identities[0] if identities else None


def _snapshot(workspace, bridge_root):
    entries, errors, scan, signatures = [], [], [], []
    paths = _paths(workspace, bridge_root)
    for path, label, rotated in paths:
        try:
            signature = _signature(path)
            signatures.append((path, signature))
            if signature is None:
                continue
            with path.open('rb') as handle:
                size = handle.seek(0, 2)
                start = max(0, size - READ_LIMIT)
                handle.seek(start)
                data = handle.read(READ_LIMIT)
            lines = data.splitlines()
            if start and lines:
                lines = lines[1:]
            malformed, unidentified = 0, 0
            for position, line in enumerate(lines):
                try:
                    record, blocks, key = _record(line)
                except (ValueError, UnicodeError):
                    malformed += 1
                    continue
                if key is None:
                    unidentified += 1
                if key != workspace['workspaceKey'] and (label == 'bridge' or key is not None):
                    continue
                item = {'workspaceKey': workspace['workspaceKey'], 'log': label,
                        'time': str(record.get('time') or '')[:64], 'trigger': str(record.get('trigger') or '')[:64],
                        'pullType': str(record.get('pullType') or '')[:64], 'ok': record['ok'], 'summary': {}}
                for block in blocks:
                    for field in SUMMARY_FIELDS:
                        value = block.get(field)
                        if isinstance(value, (bool, int, float, str)) and field not in item['summary']:
                            if isinstance(value, float) and not math.isfinite(value):
                                continue
                            item['summary'][field] = value[:256] if isinstance(value, str) else value
                item['id'] = _digest(_json([item, rotated, start, position]).encode())[:24]
                entries.append(item)
            scan.append({'log': label, 'rotated': rotated, 'scannedLines': len(lines),
                         'malformedLines': malformed, 'unidentifiedLines': unidentified, 'windowTruncated': bool(start)})
        except CommandError as error:
            errors.append({'log': label, 'rotated': rotated, 'errorCode': error.error_code})
        except OSError:
            errors.append({'log': label, 'rotated': rotated, 'errorCode': 'LOG_READ_FAILED'})
    for path, signature in signatures:
        try:
            if _signature(path) != signature:
                raise CommandError('HISTORY_CHANGED', '日志已发生变化，请重新读取第一页')
        except OSError as error:
            raise CommandError('HISTORY_CHANGED', '日志已发生变化，请重新读取第一页') from error
    generation = _digest(_json({'workspaceKey': workspace['workspaceKey'], 'readLimit': READ_LIMIT,
                               'files': [[str(path.resolve()), signature] for path, signature in signatures],
                               'errors': errors}).encode())
    entries.sort(key=lambda item: (item['time'], item['id']), reverse=True)
    return entries, {'ok': not errors, 'workspaceKey': workspace['workspaceKey'], 'generation': generation,
                     'errors': errors, 'scan': scan, 'coverage': COVERAGE}


def query_history(workspace, bridge_root, *, limit=20, summary=False, cursor=''):
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise CommandError('INPUT_INVALID', 'pull-log limit 必须为 1..100')
    if not isinstance(summary, bool) or not isinstance(cursor, str) or (summary and cursor):
        raise CommandError('INPUT_INVALID', 'summary 不支持分页 cursor')
    entries, payload = _snapshot(workspace, bridge_root)
    offset = 0
    if cursor:
        try:
            if len(cursor) > 2048:
                raise ValueError('cursor too large')
            token = json.loads(base64.b64decode(cursor.encode(), altchars=b'-_', validate=True))
            if (not isinstance(token, dict) or set(token) != {'version', 'workspaceKey', 'generation', 'offset'}
                    or type(token['version']) is not int or token['version'] != 1 or token['workspaceKey'] != workspace['workspaceKey']
                    or isinstance(token['offset'], bool) or not isinstance(token['offset'], int)
                    or token['offset'] <= 0):
                raise ValueError('cursor query mismatch')
        except (ValueError, UnicodeError, TypeError, KeyError) as error:
            raise CommandError('INVALID_CURSOR', '分页 cursor 无效或不属于当前工作区') from error
        if token['generation'] != payload['generation']:
            raise CommandError('HISTORY_CHANGED', '日志已发生变化，请重新读取第一页')
        if token['offset'] > len(entries):
            raise CommandError('INVALID_CURSOR', '分页 cursor 超出当前窗口')
        offset = token['offset']
    if summary:
        payload['summary'] = {'observed': len(entries), 'success': sum(item['ok'] for item in entries),
                              'failed': sum(not item['ok'] for item in entries)}
    else:
        selected = entries[offset:offset + limit]
        more = offset + len(selected) < len(entries)
        token = {'version': 1, 'workspaceKey': workspace['workspaceKey'], 'generation': payload['generation'],
                 'offset': offset + len(selected)}
        payload.update(entries=selected, returned=len(selected), observed=len(entries), truncated=more,
                       complete=not more, nextCursor=base64.urlsafe_b64encode(_json(token).encode()).decode() if more else None)
    return payload


def _artifact_root(workspace, kind, *, create=True):
    root = Path(workspace['contextDir']) / 'pull-history' / kind
    if _unsafe_path(root):
        raise CommandError('SYMLINK_DENIED', '历史工件路径不能包含符号链接')
    if create:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(root.parent, 0o700)
        os.chmod(root, 0o700)
    return root


def export_history(workspace, bridge_root, *, format='json', generation=''):
    if not isinstance(format, str) or format not in {'json', 'markdown'}:
        raise CommandError('INPUT_INVALID', '导出 format 必须为 json 或 markdown')
    entries, payload = _snapshot(workspace, bridge_root)
    if not payload['ok']:
        raise CommandError('HISTORY_READ_FAILED', '日志存在读取错误，请先解决再导出')
    if generation and generation != payload['generation']:
        raise CommandError('HISTORY_CHANGED', '导出预览已过期，请重新读取历史')
    payload.update(entries=entries, returned=len(entries))
    if format == 'json':
        text = _json(payload) + '\n'
    else:
        # JSON code blocks keep arbitrary metadata from becoming Markdown links/HTML.
        text = '# Pull history\n\n' + COVERAGE + '\n\n```json\n' + json.dumps(payload, ensure_ascii=False, indent=2).replace('`', '\\u0060') + '\n```\n'
    path = _artifact_root(workspace, 'exports') / (uuid.uuid4().hex + ('.json' if format == 'json' else '.md'))
    atomic_text(path, text)
    os.chmod(path, 0o600)
    return {'ok': True, 'workspaceKey': workspace['workspaceKey'], 'generation': payload['generation'],
            'artifactPath': str(path), 'format': format, 'exportedCount': len(entries), 'coverage': COVERAGE}


def _timestamp(value):
    if not isinstance(value, str):
        raise ValueError('timestamp is not text')
    timestamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
    # CLI logs use local wall time; timezone-less cutoffs use the same local zone.
    return timestamp.astimezone(timezone.utc)


def _archive_plan(workspace, bridge_root, before):
    try:
        cutoff = _timestamp(before)
    except (ValueError, TypeError) as error:
        raise CommandError('INPUT_INVALID', 'before 必须为 ISO 日期或时间') from error
    files, retained, blockers = [], {}, []
    for path, label, rotated in _paths(workspace, bridge_root):
        if label != 'workspace':
            continue
        try:
            signature = _signature(path)
            if signature is None:
                continue
            if signature[2] > READ_LIMIT:
                blockers.append({'file': path.name, 'errorCode': 'ARCHIVE_WINDOW_EXCEEDED'})
                continue
            data = path.read_bytes()
            if _signature(path) != signature:
                raise CommandError('HISTORY_CHANGED', '本地日志已变化，请重新预览')
        except (OSError, CommandError) as error:
            blockers.append({'file': path.name, 'errorCode': getattr(error, 'error_code', 'LOG_READ_FAILED')})
            continue
        kept, removed = [], []
        for line in data.splitlines(keepends=True):
            reason = ''
            try:
                record, blocks, key = _record(line)
                if key != workspace['workspaceKey']:
                    reason = 'MISSING_IDENTITY' if key is None else 'OTHER_WORKSPACE'
                elif any('status' in block and block['status'] not in TERMINAL_STATUSES for block in [record, *blocks]):
                    reason = 'UNKNOWN_STATUS'
                elif _timestamp(record.get('time')) >= cutoff:
                    reason = 'NEWER_THAN_CUTOFF'
            except (ValueError, TypeError, UnicodeError):
                reason = 'INVALID_RECORD'
            if reason:
                retained[reason] = retained.get(reason, 0) + 1
                kept.append(line)
            else:
                removed.append(line)
        files.append({'path': path, 'before': data, 'after': b''.join(kept), 'count': len(removed)})
    evidence = {'workspaceKey': workspace['workspaceKey'], 'before': cutoff.isoformat(),
                'files': [{'file': item['path'].name, 'beforeHash': _digest(item['before']),
                           'afterHash': _digest(item['after']), 'candidateCount': item['count']} for item in files],
                'retained': retained, 'blockers': blockers}
    plan_hash = _digest(_json([evidence, str(Path(workspace['logsDir']).resolve())]).encode())
    return files, {**evidence, 'ok': not blockers, 'planHash': plan_hash,
                   'candidateCount': sum(item['count'] for item in files),
                   'sharedBridgePolicy': 'EXPORT_ONLY_NO_SHARED_LOG_MUTATION', 'archivedCount': 0}


def archive_history(workspace, bridge_root, *, before, check=True, confirmation='', plan_hash=''):
    """Keep complete private backups before removing precisely owned terminal lines.

    The local append/rotation lock serializes preview validation and changes.
    Shared Bridge logs have a different writer protocol and are never rewritten.
    Files larger than the observation bound are blocked, rather than partly cleaned.
    """
    if not isinstance(check, bool):
        raise CommandError('INPUT_INVALID', 'check 必须为布尔值')
    _paths(workspace, bridge_root)
    local = Path(workspace['logsDir'])
    if _unsafe_path(local):
        raise CommandError('SYMLINK_DENIED', '日志目录不能包含符号链接')
    with file_lock(local / '.pull-log.lock'):
        files, plan = _archive_plan(workspace, bridge_root, before)
        if check:
            return {**plan, 'check': True}
        if confirmation != workspace['workspaceKey']:
            raise CommandError('CONFIRMATION_REQUIRED', '归档必须确认完整 workspaceKey')
        if plan_hash != plan['planHash']:
            raise CommandError('ARCHIVE_PLAN_STALE', '归档预览已变化，请重新预览并确认 planHash')
        if not plan['ok']:
            raise CommandError('ARCHIVE_BLOCKED', '日志超出有界归档窗口或无法读取')
        affected = [item for item in files if item['count']]
        if not affected:
            return {**plan, 'check': False}
        archive_id = uuid.uuid4().hex
        root = _artifact_root(workspace, 'archives') / archive_id
        root.mkdir(mode=0o700)
        manifest = {'schemaVersion': 1, 'archiveId': archive_id, 'workspaceKey': workspace['workspaceKey'],
                    'state': 'PREPARED', 'planHash': plan['planHash'], 'before': plan['before'],
                    'files': [item for item in plan['files'] if item['candidateCount']]}
        for item in affected:
            atomic_bytes(root / item['path'].name, item['before'])
            os.chmod(root / item['path'].name, 0o600)
        atomic_text(root / 'manifest.json', _json(manifest) + '\n')
        # PREPARED remains recoverable if a later replacement fails or the process stops.
        try:
            for item in affected:
                atomic_bytes(item['path'], item['after'])
                os.chmod(item['path'], 0o600)
            manifest['state'] = 'COMPLETE'
            atomic_text(root / 'manifest.json', _json(manifest) + '\n')
        except OSError as error:
            raise CommandError('ARCHIVE_INTERRUPTED', f'归档中断，保留可恢复备份；archiveId={archive_id}，archivePath={root}') from error
        return {**plan, 'check': False, 'archivedCount': plan['candidateCount'],
                'archiveId': archive_id, 'archivePath': str(root), 'recovery': 'RESTORE_IF_LOGS_UNCHANGED'}


def restore_history(workspace, *, archive_id, check=True, confirmation='', plan_hash=''):
    """Restore a complete or interrupted archive only while every live hash matches."""
    validate_workspace_key(workspace['workspaceKey'])
    if (not isinstance(check, bool) or not isinstance(archive_id, str) or len(archive_id) != 32
            or any(char not in '0123456789abcdef' for char in archive_id)):
        raise CommandError('INPUT_INVALID', 'archiveId 必须为已返回的归档 ID')
    local = Path(workspace['logsDir'])
    if _unsafe_path(local):
        raise CommandError('SYMLINK_DENIED', '日志目录不能包含符号链接')
    with file_lock(local / '.pull-log.lock'):
        root = _artifact_root(workspace, 'archives', create=False) / archive_id
        try:
            if root.is_symlink() or (root / 'manifest.json').is_symlink():
                raise ValueError('archive path is linked')
            manifest_path = root / 'manifest.json'
            if manifest_path.stat().st_size > 16384:
                raise ValueError('manifest too large')
            manifest = json.loads(manifest_path.read_bytes())
            if (manifest['schemaVersion'] != 1 or manifest['workspaceKey'] != workspace['workspaceKey']
                    or manifest['archiveId'] != archive_id or manifest['state'] not in {'PREPARED', 'COMPLETE', 'RESTORED'}
                    or not isinstance(manifest['files'], list) or not 1 <= len(manifest['files']) <= 2):
                raise ValueError('archive identity or state differs')
            files, evidence, names = [], [], set()
            for item in manifest['files']:
                name = item['file']
                if name not in {'pull-log.ndjson', 'pull-log.ndjson.1'} or name in names:
                    raise ValueError('invalid archive log name')
                names.add(name)
                backup, path = root / name, local / name
                if _signature(backup) is None or backup.stat().st_size > READ_LIMIT:
                    raise ValueError('missing or oversized backup')
                data = backup.read_bytes()
                if (any(not isinstance(item.get(field), str) or len(item[field]) != 64
                        or any(char not in '0123456789abcdef' for char in item[field])
                        for field in ('beforeHash', 'afterHash'))
                        or type(item.get('candidateCount')) is not int
                        or not 1 <= item['candidateCount'] <= len(data.splitlines())):
                    raise ValueError('invalid backup evidence')
                if _digest(data) != item['beforeHash']:
                    raise ValueError('backup hash differs')
                if _signature(path) is None or path.stat().st_size > READ_LIMIT:
                    raise ValueError('live log missing or exceeds bound')
                current_hash = _digest(path.read_bytes())
                if current_hash not in {item['beforeHash'], item['afterHash']}:
                    raise CommandError('ARCHIVE_RESTORE_CONFLICT', '归档后日志已变化，需离线合并；不会覆盖新记录')
                files.append((path, data))
                evidence.append([name, current_hash, item['beforeHash']])
        except (KeyError, ValueError, TypeError, OSError) as error:
            raise CommandError('ARCHIVE_INVALID', '归档缺失、损坏、身份不匹配或状态未知') from error
        fingerprint = _digest(_json([manifest, evidence, str(local.resolve()), str(root.resolve())]).encode())
        result = {'ok': True, 'workspaceKey': workspace['workspaceKey'], 'archiveId': archive_id,
                  'state': manifest['state'], 'planHash': fingerprint, 'check': check, 'restoredCount': 0}
        if check:
            return result
        if confirmation != workspace['workspaceKey']:
            raise CommandError('CONFIRMATION_REQUIRED', '恢复必须确认完整 workspaceKey')
        if plan_hash != fingerprint:
            raise CommandError('ARCHIVE_PLAN_STALE', '恢复预览已变化，请重新预览并确认 planHash')
        for path, data in files:
            atomic_bytes(path, data)
            os.chmod(path, 0o600)
        manifest['state'] = 'RESTORED'
        atomic_text(manifest_path, _json(manifest) + '\n')
        return {**result, 'state': 'RESTORED', 'restoredCount': sum(item['candidateCount'] for item in manifest['files'])}

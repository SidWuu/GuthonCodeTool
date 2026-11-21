"""Explicit, offline promotion of legacy configuration to the unified authority."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import uuid
from pathlib import Path

from common import config_store, workspace_registry
from common.persistence import atomic_bytes, file_lock
from common.runtime_paths import runtime_home_context

FILES = (config_store.NAME, *config_store.LEGACY)
_DIGEST = re.compile(r"[a-f0-9]{64}")
_ID = re.compile(r"[a-f0-9]{32}")


def parser():
    command = argparse.ArgumentParser(prog="guthon_tool.py configuration-upgrade")
    command.add_argument("action", choices=("plan", "apply", "status", "recover"))
    command.add_argument("--confirm", help="Exact plan ID, or transaction ID for recovery")
    command.add_argument("--offline", action="store_true",
                         help="Confirm all other writers for this toolHome have been stopped")
    return command


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode()


def _snapshot(directory):
    result = {}
    for name in FILES:
        path = directory / name
        if path.is_symlink() or path.exists() and not path.is_file():
            raise ValueError(f"配置必须是普通文件：{name}")
        if path.is_file():
            result[name] = path.read_bytes()
    return result


def _layout_fingerprint(workspace):
    """Exclude the configuration authority label and implicit scope-edit path."""
    fields = (
        'workspaceKey', 'id', 'name', 'displayName', 'aliases', 'sourceMode',
        'kind', 'layer', 'root', 'contextDir', 'runtimeDir', 'docsDir', 'logsDir',
        'indexPath', 'statePath', 'sourceRoots', 'providerSourceRoot', 'workspaceBinding',
    )
    result = {key: workspace[key] for key in fields}
    if workspace.get('svn', {}).get('scopeConfigExplicit'):
        result['scopeConfigPath'] = workspace['svn']['scopeConfigPath']
    return result


def _prepare(home):
    config_store.require_stable_configuration(home)
    directory = home / 'config'
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('配置目录必须是独立真实目录')
    files = _snapshot(directory)
    old_json = files.get(config_store.NAME)
    legacy = old_json is None
    if not legacy and len(files) != 1:
        raise ValueError('CONFIG_AUTHORITY_CONFLICT: 请先核对 JSON 与旧 YAML 的用途')
    if legacy:
        original = config_store._read_legacy(home, files=files)
        for section in ('products', 'projects', 'source_tables'):
            if set(original[section]) != {section}:
                raise ValueError(f"旧 {section} 的额外顶层字段需要先核对")
        runtime = config_store.resolve_document(home, original, legacy=True)
        database_testing = (
            config_store._yaml(files['database-testing.yaml'].decode())
            if 'database-testing.yaml' in files else
            {'schemaVersion': 1, 'connections': {}, 'expectedIdentities': {}, 'databaseTests': {}}
        )
        target = {
            'schemaVersion': config_store.SCHEMA_VERSION,
            'workspaces': {},
            'sync': original['sync'],
            'datasource': original['datasource'],
            'sourceTables': original['source_tables']['source_tables'],
            'databaseTesting': database_testing,
            'apiWorkspaces': {},
        }
    else:
        target = config_store._validate(json.loads(old_json, object_pairs_hook=config_store._unique))
        runtime = config_store.resolve_document(home, target)
        if target['schemaVersion'] == config_store.SCHEMA_VERSION:
            raise ValueError('配置已经使用 schema 3')
        target['schemaVersion'] = config_store.SCHEMA_VERSION
        target.setdefault('sourceTables', {})
        if any(not isinstance(value, dict) or 'sourceMode' in value
               for value in target['workspaces'].values()):
            raise ValueError('schema 2 登记不符合 API 项目契约')
        target['workspaces'] = {
            key: {**record, 'sourceMode': 'api'} for key, record in target['workspaces'].items()
        }

    with runtime_home_context(home):
        before = workspace_registry.list_workspaces(runtime, strict=True)
        if legacy:
            for workspace in before:
                kind, identifier = workspace['kind'], workspace['id']
                original_item = next(item for key, item in original[kind][kind].items()
                                     if str(key) == identifier)
                target['workspaces'][workspace['workspaceKey']] = {
                    'sourceMode': workspace['sourceMode'],
                    'identity': {'kind': kind, 'id': identifier, 'layer': workspace['layer']},
                    'legacyConfig': original_item,
                }
                settings = workspace.get('svn', {})
                if (settings.get('scopeConfigExplicit')
                        and settings['scopeConfigPath'].parent == directory
                        and settings['scopeConfigPath'].name in files):
                    raise ValueError(f"{workspace['workspaceKey']} 的显式 SVN 范围引用指向待归档配置，请先核对")

        encoded = _encode(target)
        persisted = json.loads(encoded)
        if persisted != target:
            raise ValueError('YAML 含无法无损转换为 JSON 的键或值')
        converted = config_store.resolve_document(home, persisted)
        after = workspace_registry.list_workspaces(converted, strict=True)
        fingerprints = [_layout_fingerprint(item) for item in before]
        if fingerprints != [_layout_fingerprint(item) for item in after]:
            raise ValueError('转换前后项目身份、能力范围或路径不一致')
        from providers.api.workspace import validate_stored_settings
        for item in after:
            key = item['workspaceKey']
            if item['sourceMode'] == 'api' and key in converted['apiWorkspaces']:
                validate_stored_settings(converted['apiWorkspaces'][key], key)
        from common.database_test_artifacts import validate_config
        validate_config(converted['databaseTesting'])
        if any(item['sourceMode'] == 'database' for item in before):
            from common import legacy_source

            mappings = converted['source_tables']
            try:
                legacy_source.page_sql(mappings)
                legacy_source.proc_sql(mappings)
                legacy_source.page_inventory_sql(mappings)
            except (KeyError, TypeError, ValueError, SystemExit) as error:
                raise ValueError('DATABASE 的源码字段映射缺失或无效，请先核对 source-tables') from error

    if _snapshot(directory) != files:
        raise ValueError('准备期间配置已变化，请重新预览')
    hashes = {name: _digest(data) for name, data in files.items()}
    target_hash = _digest(encoded)
    identity = json.dumps([str(home), hashes, target_hash, fingerprints],
                          sort_keys=True, default=str, ensure_ascii=False).encode()
    result = {
        'ok': True, 'phase': 'PREVIEW', 'planId': _digest(identity), 'home': str(home),
        'fromSchema': 0 if legacy else 2, 'toSchema': config_store.SCHEMA_VERSION,
        'sourceFiles': list(files), 'target': str(config_store.path(home)),
        'workspaces': [{'workspaceKey': item['workspaceKey'], 'sourceMode': item['sourceMode'],
                        'root': str(item['root'])} for item in before],
    }
    return result, files, hashes, encoded


def _marker(directory):
    return directory / config_store.UPGRADE_MARKER


def _transactions(directory):
    path = directory / '.configuration-upgrades'
    if path.is_symlink() or path.exists() and not path.is_dir():
        raise ValueError('配置升级备份目录必须是独立真实目录')
    return path


def _read_transaction(directory):
    marker = _marker(directory)
    if marker.is_symlink():
        raise ValueError('配置升级记录不能是符号链接')
    if not marker.exists():
        return None
    entry = json.loads(marker.read_bytes())
    if (not isinstance(entry, dict) or entry.get('version') != 1
            or _ID.fullmatch(str(entry.get('transactionId', ''))) is None
            or _DIGEST.fullmatch(str(entry.get('targetDigest', ''))) is None
            or not isinstance(entry.get('sourceDigests'), dict)
            or not entry['sourceDigests']
            or any(name not in FILES or _DIGEST.fullmatch(str(value)) is None
                   for name, value in entry['sourceDigests'].items())):
        raise ValueError('配置升级记录无效，请保留原文件和备份')
    names = set(entry['sourceDigests'])
    if names != {config_store.NAME} and (config_store.NAME in names
                                        or not set(config_store.LEGACY_SECTIONS.values()).issubset(names)):
        raise ValueError('配置升级记录的源文件集合无效')
    return entry


def _inspect(directory, entry):
    backup = _transactions(directory) / entry['transactionId']
    if backup.is_symlink() or not backup.is_dir():
        raise ValueError('找不到可信的配置升级备份目录')
    originals = _snapshot(backup)
    source_digests = entry['sourceDigests']
    if {name: _digest(data) for name, data in originals.items()} != source_digests:
        raise ValueError('升级备份与原配置摘要不符，请保留现场')
    current = {name: _digest(data) for name, data in _snapshot(directory).items()}
    if current == {config_store.NAME: entry['targetDigest']}:
        return 'PUBLISHED', backup, originals
    if all(source_digests.get(name) == digest for name, digest in current.items()):
        if config_store.NAME not in originals or current == source_digests:
            return 'UNPUBLISHED', backup, originals
    raise ValueError('当前配置与升级记录不符，请保留现场')


def _finish(directory, entry, backup, phase):
    atomic_bytes(backup / 'record.json', _encode({**entry, 'phase': phase}))
    _marker(directory).unlink()
    return {'ok': True, 'phase': phase, 'transactionId': entry['transactionId'], 'backup': str(backup)}


def run(home, args):
    home = Path(home).resolve()
    directory = home / 'config'
    options = parser().parse_args(args)
    if options.action == 'plan':
        return _prepare(home)[0]
    if options.action == 'status':
        entry = _read_transaction(directory)
        if not entry:
            return {'ok': True, 'phase': 'IDLE'}
        phase, backup, _ = _inspect(directory, entry)
        return {'ok': True, 'phase': phase, 'transactionId': entry['transactionId'], 'backup': str(backup)}
    if not options.offline or not options.confirm:
        raise ValueError('请先停用其他写入入口，使用 --offline 和预览或状态返回的 --confirm ID')
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('配置目录必须是独立真实目录')
    with file_lock(directory / '.configuration.lock'):
        if options.action == 'recover':
            entry = _read_transaction(directory)
            if not entry or entry['transactionId'] != options.confirm:
                raise ValueError('配置升级事务不存在或确认 ID 已过期')
            phase, backup, originals = _inspect(directory, entry)
            if phase == 'UNPUBLISHED':
                for name, data in originals.items():
                    if not (directory / name).exists():
                        atomic_bytes(directory / name, data)
                return _finish(directory, entry, backup, 'RESTORED')
            return _finish(directory, entry, backup, 'PUBLISHED')

        preview, files, hashes, encoded = _prepare(home)
        if options.confirm != preview['planId']:
            raise ValueError('配置或目标已变化，请重新预览')
        transaction = uuid.uuid4().hex
        backup = _transactions(directory) / transaction
        backup.parent.mkdir(mode=0o700, exist_ok=True)
        backup.mkdir(mode=0o700)
        for name, data in files.items():
            atomic_bytes(backup / name, data)
        entry = {'version': 1, 'transactionId': transaction, 'sourceDigests': hashes,
                 'targetDigest': _digest(encoded), 'planId': preview['planId']}
        atomic_bytes(backup / 'record.json', _encode({**entry, 'phase': 'PREPARED'}))
        atomic_bytes(_marker(directory), _encode(entry))
        if _snapshot(directory) != files:
            raise ValueError('发布前旧配置已变化，请核对事务和原文件')
        for name in files:
            if name != config_store.NAME:
                (directory / name).unlink()
        # The single publication point. The marker keeps readers closed until
        # this result is recorded or explicitly reconciled by recovery.
        atomic_bytes(config_store.path(home), encoded)
        return _finish(directory, entry, backup, 'PUBLISHED')

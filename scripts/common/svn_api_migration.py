"""Explicit, offline SVN-to-API preparation and cutover for one registered project."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit
from uuid import uuid4

from common import config_store, workspace_registry
from common.persistence import atomic_bytes, atomic_text, file_lock
from common.runtime_paths import runtime_home_context
from common.workspace_identity import validate_workspace_key


def parser():
    command = argparse.ArgumentParser(prog="guthon_tool.py svn-api-migration")
    command.add_argument("action", choices=("preflight", "prepare", "plan", "apply", "status", "recover"))
    command.add_argument("--confirm", help="Exact reviewed plan ID, or transaction ID for recovery")
    command.add_argument("--offline", action="store_true", help="Confirm all other editors and writers are stopped")
    return command


def _unresolved_platform_operations(workspace):
    from providers.svn.nexus import operation_maintenance, page_lifecycle

    root = workspace['contextDir'] / 'page-lifecycle' / 'operations'
    if root.is_symlink() or root.parent.is_symlink() or root.exists() and not root.is_dir():
        raise ValueError('PAGE 平台操作记录目录无效，请核对现场')
    pending = []
    for index, path in enumerate(sorted(root.glob('*.json')), start=1):
        if index > operation_maintenance.MAX_OPERATION_RECORDS or path.is_symlink():
            raise ValueError('无法安全核验 PAGE 平台操作记录')
        operation = page_lifecycle.status(workspace, operation_id=page_lifecycle.PREFIX + path.stem)
        if operation.get('state') not in {'SUCCEEDED', 'FAILED'}:
            pending.append(operation.get('operationId') or path.stem)
    return pending


def _source_snapshot(workspace):
    """Get the exact working-copy identity and local change status under its operation lock."""
    from providers.svn import checkout
    from providers.svn.nexus.manifest import load_authorized_scope

    layout = workspace['svn']['checkoutLayout']
    scope_fingerprint = workspace['workspaceBinding']['digest']
    registered_copies = {}
    if layout == 'manifest-working-copies':
        from providers.svn.nexus.workspace import load_state

        scope = load_authorized_scope(workspace)
        state = load_state(workspace, required=True)
        registered_copies = {entry['id']: entry for entry in state['workingCopies']}
        if state['authorizedScopeHash'] != scope.digest or set(registered_copies) != {entry.id for entry in scope.entries}:
            raise ValueError('SVN 已检出范围与当前授权范围不一致，请检查 working copy')
        copies = [(entry.id, entry.root, entry.url) for entry in scope.entries]
        scope_fingerprint = scope.digest
    else:
        scope = checkout.load_scope(workspace)
        saved_repository = scope.get('repository')
        if not isinstance(saved_repository, dict):
            raise ValueError('旧 sparse SVN 范围缺少已核验的仓库身份')
        expected = workspace['svn']['repositoryUrl'] or saved_repository.get('url')
        if not expected or not scope.get('complete') or not scope.get('repositoryFingerprint'):
            raise ValueError('旧 sparse SVN 范围缺少已核验的仓库身份或完整授权')
        copies = [('sparse', workspace['checkoutPath'], expected)]
        scope_fingerprint = checkout.json_hash(scope)
    working_copies = []
    for identifier, root, expected_url in copies:
        status = checkout.svn_status(root)
        if status['url'] != expected_url or not status['repositoryUuid'] or not status['revision']:
            raise ValueError(f'SVN working copy 与授权身份不匹配：{identifier}')
        if layout == 'legacy-sparse':
            fingerprint, _ = checkout._repository_fingerprint(workspace, status)
            if fingerprint != scope['repositoryFingerprint']:
                raise ValueError('旧 sparse SVN 仓库或产品身份与既有记录不一致')
        else:
            saved = registered_copies[identifier]
            if saved['root'] != str(root) or saved['repositoryUuid'] != status['repositoryUuid'] or saved['repositoryRoot'] != status['repositoryRoot']:
                raise ValueError(f'SVN 仓库身份与已检出记录不一致：{identifier}')
        working_copies.append({
            'id': identifier, 'root': str(root), 'repositoryUrl': status['url'],
            'repositoryUuid': status['repositoryUuid'], 'revision': status['revision'],
            'svnVersion': status['svnVersion'], 'switched': status['switched'],
            'partial': status['partial'],
            'changes': status['changes'], 'clean': status['clean'],
        })
    return scope_fingerprint, working_copies


def _svn_workspace(home, key):
    config = config_store.runtime_config(home)
    if config['_configuration']['schemaVersion'] != config_store.SCHEMA_VERSION:
        raise ValueError('先独立完成 schema 3 配置升级，再预检 SVN 源码迁移')
    workspace = workspace_registry.resolve_workspace(config, key)
    if workspace['sourceMode'] != 'svn':
        raise ValueError('预检需要明确的 SVN 项目 key')
    return workspace


def preflight(home, key):
    from providers.svn import checkout

    with runtime_home_context(home):
        workspace = _svn_workspace(home, key)
        checkout.require_capability(workspace, 'status')
        with checkout.operation_lock(workspace, 'migration-preflight', shared=True):
            return _check_source(workspace)


def _check_source(workspace):
    from providers.svn.nexus import operation_maintenance, scm

    key = workspace['workspaceKey']
    scope_digest, copies = _source_snapshot(workspace)
    deliveries = scm._deliveries(scm._platform_state(workspace))
    blocked_deliveries = [
        record.get('deliveryId', '') for record in deliveries
        if record.get('outcomeUncertain') or record.get('status') in {'PARTIAL', 'IN_PROGRESS'}
    ]
    ledger = [
        item for item in operation_maintenance._records(workspace)
        if not item.get('valid') or item.get('state') != 'DIFF_VERIFIED'
    ]
    platform_operations = _unresolved_platform_operations(workspace)
    blockers = []
    for entry in copies:
        if not entry['clean'] or 'M' in entry['svnVersion']:
            blockers.append({'code': 'SVN_LOCAL_CHANGES', 'workingCopyId': entry['id']})
        if entry['partial'] and workspace['svn']['checkoutLayout'] == 'manifest-working-copies':
            blockers.append({'code': 'SVN_INCOMPLETE_WORKING_COPY', 'workingCopyId': entry['id']})
        if entry['switched']:
            blockers.append({'code': 'SVN_SWITCHED_PATH', 'workingCopyId': entry['id']})
    if blocked_deliveries:
        blockers.append({'code': 'SVN_DELIVERY_NEEDS_REVIEW', 'deliveryIds': blocked_deliveries})
    if ledger:
        blockers.append({'code': 'SVN_LOCAL_OPERATIONS_NEED_REVIEW', 'count': len(ledger)})
    if platform_operations:
        blockers.append({'code': 'PLATFORM_OPERATIONS_NEED_REVIEW', 'operationIds': platform_operations})
    workspace_registry.require_workspace_binding(workspace, workspace['workspaceBinding'])

    fingerprint_data = [workspace['workspaceBinding'], scope_digest, copies]
    fingerprint = hashlib.sha256(json.dumps(fingerprint_data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return {
        'ok': True, 'workspaceKey': key, 'sourceMode': 'svn', 'phase': 'SOURCE_PREFLIGHT',
        'authorizedScopeDigest': scope_digest, 'sourceFingerprint': fingerprint,
        'workingCopies': copies, 'blockers': blockers,
        'sourceReadyForCandidate': not blockers,
        'platformEffectiveVerified': False, 'editorsQuiescentVerified': False,
    }


def _encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + '\n'


def _digest(value):
    return hashlib.sha256(_encode(value).encode()).hexdigest()


def _read(path):
    if path.is_symlink():
        raise ValueError(f'迁移记录不能使用符号链接：{path.name}')
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return None


def _tree_digest(directory):
    from providers.svn import checkout

    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('候选材料目录缺失或为链接')
    files = {}
    for path in sorted(directory.rglob('*')):
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise ValueError(f'候选目录含链接或非普通文件：{path.name}')
        if path.is_file():
            files[path.relative_to(directory).as_posix()] = checkout.file_hash(path)
    return _digest(files)


def _origin(url):
    parts = urlsplit(url)
    return parts.scheme, parts.hostname, parts.port or (443 if parts.scheme == 'https' else 80)


def _download(settings, login, expected_scope):
    from providers.api.client import ApiClient
    from providers.api.download import download

    client = ApiClient(settings['serverUrl'])
    project = []
    try:
        session = client.login(login.get('userId'), login.get('password'), login.get('randCode', ''))
        files, scope = download(client, settings, on_project=lambda systems, sources: project.extend([systems, sources]))
    finally:
        client.logout()
    expected_systems, expected_sources = set(expected_scope['systemIds']), set(expected_scope['dataSourceIds'])
    if set(scope['systemIds']) != expected_systems or set(scope['dataSourceIds']) != expected_sources:
        raise ValueError('平台返回的系统或数据源范围与 SVN 授权范围不同')
    systems, sources = project
    selected = [x for x in systems if str(x.get('systemId')) in expected_systems]
    selected_sources = [x for x in sources if str(x.get('dataSourceId')) in expected_sources]
    if len(selected) != len(expected_systems) or len(selected_sources) != len(expected_sources):
        raise ValueError('平台系统或数据源身份重复')
    pairs = sorted((str(x['systemId']), str(x.get('dataSourceId') or '')) for x in selected)
    if dict(pairs) != expected_scope['systemDataSources']:
        raise ValueError('API 子系统与数据源关联不匹配，不能仅凭同名项目继续迁移')
    snapshot = {
        'scope': {**scope, 'systemIds': sorted(scope['systemIds'])},
        'systemDataSources': dict(pairs),
        'platformVersion': {key: session[key] for key in ('mainVersion', 'dateVersion')},
        'files': _digest([
            [item.path, item.kind, item.readonly, {key: value for key, value in item.metadata.items()
                                                   if key != 'checkOutUserId'},
             hashlib.sha256(item.content.encode()).hexdigest()]
            for item in sorted(files, key=lambda row: row.path)
        ]),
    }
    return files, systems, sources, snapshot


def _expected_scope(workspace, objects):
    from providers.svn import checkout
    from providers.svn.nexus.manifest import load_authorized_scope

    configured = checkout.resolve_configured_scope(workspace)
    scope = (checkout.load_scope(workspace) if workspace['svn']['checkoutLayout'] == 'legacy-sparse'
             else configured)
    if not configured['complete'] or scope.get('mappingHash') != configured['mappingHash']:
        raise ValueError('SVN 系统与数据源的当前映射和已检出范围不一致')
    pairs = scope.get('dataSourceIdsBySystem', {})
    if (not scope['complete'] or not pairs or set(pairs) != set(scope['systemIds'])
            or any(len(sources) != 1 for sources in pairs.values())):
        raise ValueError('缺少唯一的 SVN 系统与数据源映射，请在原项目配置核对授权范围')
    systems, sources = set(scope['systemIds']), set(scope['dataSourceIds'])
    for mapping in workspace['systemMappings'].values():
        system, source = mapping['system_id'].strip(), mapping['data_source_id'].strip()
        if pairs.get(system) != [source]:
            raise ValueError(f'SVN 系统 {system} 的数据源映射不唯一或已变化，请核对授权范围')
    if workspace['svn']['checkoutLayout'] == 'manifest-working-copies':
        for entry in load_authorized_scope(workspace).entries:
            owner = Path(entry.local_subdir).name
            if entry.category in {'systems', 'pages', 'system-script'} and owner not in systems:
                raise ValueError(f'SVN 授权清单中存在未映射的系统：{owner}')
            if entry.category in {'datasources', 'procedures', 'tables', 'views'}:
                sources.add(owner)
    for kind, owner, *_ in objects:
        if kind in {'page', 'page-inherit', 'system-script'} and owner not in systems:
            raise ValueError(f'SVN 授权范围中存在未映射的系统：{owner}')
        if kind in {'procedure', 'procedure-inherit', 'table', 'view'}:
            sources.add(owner)
    return {'systemIds': sorted(systems), 'dataSourceIds': sorted(sources),
            'systemDataSources': {system: ids[0] for system, ids in pairs.items()}}


def _candidate_paths(workspace, identifier):
    root = workspace['root']
    context = root / 'context'
    parent = context / 'api-provider'
    final = root / 'checkout'
    existing = [workspace[name] for name in ('runtimeDir', 'docsDir', 'checkoutPath')]
    for base in (parent, final):
        if base.resolve() != base:
            raise ValueError('候选及目标目录必须是项目根中的独立真实路径')
        if any(base == path or base in path.parents or path in base.parents for path in existing):
            raise ValueError('候选或目标路径与现有项目目录重叠')
    old_context = workspace['contextDir']
    if parent == old_context or parent in old_context.parents or final in old_context.parents or old_context in final.parents:
        raise ValueError('候选或目标路径会占用旧索引及历史目录')
    directory = parent / identifier
    if directory.is_symlink() or (directory / 'checkout').is_symlink():
        raise ValueError('候选材料不能使用符号链接')
    return directory, final


def _candidate_digest(directory, checkout_path):
    return {'checkout': _tree_digest(checkout_path), 'context': _tree_digest(directory / 'context')}


def _candidate_workspace(workspace, directory):
    return {
        **workspace, 'sourceMode': 'api', 'configDir': directory / 'isolated-config',
        'contextDir': directory / 'context', 'providerSourceRoot': directory / 'checkout',
        'indexPath': directory / 'context' / 'index.db',
    }


def _new_registry(workspace, directory, final, target):
    # Keep the existing logical root, independent resources, credentials and aliases.
    original = target['workspaces'][workspace['workspaceKey']]
    record = copy.deepcopy(original.get('legacyConfig', original))
    item = {name: record[name] for name in ('name', 'aliases', 'datasource', 'systems')
            if name in record}
    identity = {'id': workspace['id'], 'kind': workspace['kind'], 'layer': workspace['layer']}
    if workspace['displayName'] != workspace['name']:
        identity['displayName'] = workspace['displayName']
    return {**item, 'sourceMode': 'api', 'root': str(workspace['root']), 'identity': identity,
            'paths': {'contextDir': str(directory / 'context'), 'checkoutPath': str(final),
                      'runtimeDir': str(workspace['runtimeDir']), 'docsDir': str(workspace['docsDir'])}}


def _prepare(home, key, journal, payload):
    from common import svn_api_inventory
    from providers.api import index, workspace as api
    from providers.api.store import ApiStore
    from providers.svn import checkout

    if set(payload) != {'serverUrl', 'platformEvidence', 'login'}:
        raise ValueError('prepare 需要目标 serverUrl、旧侧平台最终生效依据 platformEvidence 及 login 对象')
    evidence = payload['platformEvidence']
    if not isinstance(evidence, str) or not evidence.strip() or len(evidence) > 2000:
        raise ValueError('请提供本次平台最终提交及实际生效的可追查记录编号或说明')
    workspace = _svn_workspace(home, key)
    checkout.require_capability(workspace, 'status')
    with checkout.operation_lock(workspace, 'migration-prepare', shared=True):
        checked = _check_source(workspace)
        if checked['blockers']:
            return checked
        old_objects = svn_api_inventory.svn_objects(workspace, checked)
        expected_scope = _expected_scope(workspace, old_objects)
    if not old_objects:
        raise ValueError('旧侧无可核对的受管源码，无法确认迁移覆盖范围')
    settings = api.validate_stored_settings(
        {'workspaceKey': key, 'serverUrl': payload['serverUrl'], 'allSystems': False,
         'systemIds': expected_scope['systemIds'], 'dataSourceIds': expected_scope['dataSourceIds'],
         'includeProjectFiles': True}, key)
    origins = {_origin(url) for url in workspace['pageOrigins']}
    if origins and _origin(settings['serverUrl']) not in origins:
        raise ValueError('API 目标平台与原 SVN 项目的授权平台地址不匹配')
    identifier = uuid4().hex
    directory, final = _candidate_paths(workspace, identifier)
    if final.exists():
        raise ValueError('API 正式目录已存在，请核对既有材料')
    files, systems, sources, snapshot = _download(settings, payload['login'], expected_scope)
    comparison = svn_api_inventory.compare(old_objects, files)
    if comparison['blockers']:
        return {'ok': True, 'phase': 'CANDIDATE_BLOCKED', 'workspaceKey': key, **comparison}
    directory.mkdir(parents=True, mode=0o700, exist_ok=False)
    candidate = _candidate_workspace(workspace, directory)
    api.configure(candidate, {key: value for key, value in settings.items() if key != 'workspaceKey'})
    api.save_project(candidate, systems, sources)
    result = ApiStore(candidate).publish(files, scope=snapshot['scope'], authoritative=True)
    if not result['complete']:
        raise ValueError('API 候选源码未完整发布')
    candidate['providerSourceRoot'].mkdir(exist_ok=True)
    indexed = index.rebuild(candidate)
    if not indexed['complete'] or indexed['objects'] != len(files):
        raise ValueError('API 候选索引未就绪，不能准备切换：' + str(indexed['diagnostics'][:3]))
    atomic_text(candidate['contextDir'] / 'source-mode.json',
                _encode({'version': 1, 'workspaceKey': key, 'sourceMode': 'api'}))
    target = config_store.read(home)
    registration = _new_registry(workspace, directory, final, target)
    target['workspaces'][key] = registration
    target['apiWorkspaces'][key] = settings
    workspace_registry.resolve_workspace(config_store.resolve_document(home, target), key)
    if preflight(home, key)['sourceFingerprint'] != checked['sourceFingerprint']:
        raise ValueError('SVN 工作副本在候选准备期间变化，请重新准备')
    plan = {
        'workspaceKey': key, 'phase': 'CANDIDATE_READY', 'candidateId': identifier,
        'from': 'svn', 'to': 'api', 'settings': settings, 'registration': registration,
        'projectRoot': str(workspace['root']), 'workingCopies': checked['workingCopies'],
        'historicalContext': str(workspace['contextDir']),
        'sourceFingerprint': checked['sourceFingerprint'],
        'sourceObjectsDigest': _digest(sorted(old_objects.items())),
        'candidateDigest': _candidate_digest(directory, directory / 'checkout'), 'expectedScope': expected_scope,
        'remoteSnapshot': snapshot, 'platformEvidence': evidence.strip(),
        'platformIdentity': 'configured-origin-and-scope' if origins else 'operator-evidence-and-scope',
        **comparison,
    }
    plan['planId'] = _digest(plan)
    atomic_text(journal / 'plan.json', _encode(plan))
    return plan


def _apply(home, key, journal, plan, payload):
    from common import svn_api_inventory
    from providers.svn import checkout

    if set(payload) - {'login', 'manualReview'}:
        raise ValueError('apply 仅接受 login 及 manualReview')
    notes = payload.get('manualReview', {})
    needed = {item['svn']['path'] for item in plan['requiresManualReview']}
    if (not isinstance(notes, dict) or set(notes) != needed
            or any(not isinstance(note, str) or not note.strip() or len(note) > 2000 for note in notes.values())):
        raise ValueError('manualReview 必须逐项提供全部待人工核对的 SVN 路径及依据')
    workspace = _svn_workspace(home, key)
    with checkout.operation_lock(workspace, 'migration-cutover'):
        checked = _check_source(workspace)
        if checked['blockers'] or checked['sourceFingerprint'] != plan['sourceFingerprint']:
            raise ValueError('旧侧状态或配置已变更，请重新预检和准备候选')
        old_objects = svn_api_inventory.svn_objects(workspace, checked)
        if _digest(sorted(old_objects.items())) != plan['sourceObjectsDigest']:
            raise ValueError('SVN 源码清单或内容已变更，请重新准备')
        directory, final = _candidate_paths(workspace, plan['candidateId'])
        if final.exists() or _candidate_digest(directory, directory / 'checkout') != plan['candidateDigest']:
            raise ValueError('候选内容或目标位置已变化，请重新准备并复核')
        _, _, _, snapshot = _download(plan['settings'], payload['login'], plan['expectedScope'])
        if snapshot != plan['remoteSnapshot']:
            raise ValueError('API 平台范围、版本或源码已变化，请重新准备并审阅差异')
        if (_candidate_digest(directory, directory / 'checkout') != plan['candidateDigest']
                or _check_source(workspace)['sourceFingerprint'] != plan['sourceFingerprint']):
            raise ValueError('最终复核期间本地材料变化，请重新准备')

        target = config_store.read(home)
        previous = config_store.path(home).read_bytes()
        target['workspaces'][key] = plan['registration']
        target['apiWorkspaces'][key] = plan['settings']
        workspace_registry.resolve_workspace(config_store.resolve_document(home, target), key)
        identifier = uuid4().hex
        backup = journal / (identifier + '.guthon.json')
        atomic_bytes(backup, previous)
        record = {'transactionId': identifier, 'phase': 'PREPARED', 'planId': plan['planId'],
                  'workspaceKey': key, 'candidateId': plan['candidateId'],
                  'projectRoot': plan['projectRoot'], 'candidateDigest': plan['candidateDigest'],
                  'oldRegistration': json.loads(previous)['workspaces'][key],
                  'oldApiSettings': json.loads(previous)['apiWorkspaces'].get(key),
                  'newRegistration': plan['registration'], 'newApiSettings': plan['settings'],
                  'backupPath': str(backup), 'backupDigest': hashlib.sha256(previous).hexdigest(),
                  'manualReview': notes, 'oldEntriesStoppedByOperator': True}
        transaction = journal / 'transaction.json'
        atomic_text(transaction, _encode(record))
        (directory / 'checkout').rename(final)
        config_store.write(home, target)
        record['phase'] = 'PUBLISHED'
        atomic_text(transaction, _encode(record))
        return {'ok': True, **record}


def _publication_state(home, key, record):
    current = config_store.read(home)
    actual = (current['workspaces'].get(key), current['apiWorkspaces'].get(key))
    if actual == (record['newRegistration'], record['newApiSettings']):
        return 'PUBLISHED'
    if actual == (record['oldRegistration'], record['oldApiSettings']):
        return 'UNPUBLISHED'
    return 'CONFIG_CHANGED'


def _recover(home, key, journal, record):
    backup = journal / (record['transactionId'] + '.guthon.json')
    if backup.is_symlink() or hashlib.sha256(backup.read_bytes()).hexdigest() != record['backupDigest']:
        raise ValueError('迁移配置备份已变化，请保留现场核对')
    state = _publication_state(home, key, record)
    if state == 'UNPUBLISHED':
        from providers.svn import checkout

        workspace = _svn_workspace(home, key)
        with checkout.operation_lock(workspace, 'migration-recover'):
            if str(workspace['root']) != record['projectRoot']:
                raise ValueError('项目根已变化，请保留现场核对')
            candidate, final = _candidate_paths(workspace, record['candidateId'])
            checkout_path = candidate / 'checkout'
            if checkout_path.exists() == final.exists():
                raise ValueError('迁移材料位置不唯一或缺失，请保留现场核对')
            present = final if final.exists() else checkout_path
            if _candidate_digest(candidate, present) != record['candidateDigest']:
                raise ValueError('迁移材料已变化，请保留现场核对')
            if present == final:
                final.rename(checkout_path)
        record['phase'] = 'RECOVERED_UNPUBLISHED'
    elif state == 'PUBLISHED':
        workspace = workspace_registry.resolve_workspace(config_store.runtime_config(home), key)
        if not workspace['providerSourceRoot'].is_dir() or not workspace['indexPath'].is_file():
            raise ValueError('登记已发布但 API 材料缺失，请保留现场核对')
        record['phase'] = 'PUBLISHED'
    else:
        raise ValueError('当前项目登记与迁移记录不同，请保留现场核对')
    atomic_text(journal / 'transaction.json', _encode(record))
    return {'ok': True, **record}


def run(home, key, argv, stdin):
    args = parser().parse_args(argv)
    home = Path(home).resolve()
    key = validate_workspace_key(key)
    if args.action == 'preflight':
        return preflight(home, key)
    if args.action in {'apply', 'recover'} and (not args.offline or not args.confirm):
        raise ValueError('需停止相关 IDE 和写入入口，并提供 --offline 和准确的 --confirm ID')
    config_dir = home / 'config'
    if config_dir.is_symlink() or not config_dir.is_dir():
        raise ValueError('迁移需要已配置的独立 config 目录')
    with runtime_home_context(home), file_lock(config_dir / '.configuration.lock'):
        config_store.require_stable_configuration(home)
        journal = config_dir / '.svn-api-migrations' / key
        if journal.resolve() != journal:
            raise ValueError('迁移记录目录不能使用符号链接')
        record = _read(journal / 'transaction.json')
        plan = _read(journal / 'plan.json')
        pending = record and record['phase'] == 'PREPARED'
        if args.action == 'status':
            return {'ok': True, 'workspaceKey': key, 'transaction': record,
                    'publication': _publication_state(home, key, record) if record else None,
                    'planId': plan['planId'] if plan else None}
        if args.action == 'recover':
            if not pending or args.confirm != record['transactionId']:
                raise ValueError('没有匹配该 ID 的待恢复迁移')
            return _recover(home, key, journal, record)
        if pending:
            raise ValueError('有待恢复的迁移，请先查看 status')
        if args.action == 'plan':
            if not plan:
                raise ValueError('尚未准备可审阅的 API 候选')
            return {'ok': True, **plan}
        payload = json.load(stdin)
        if (not isinstance(payload, dict) or not isinstance(payload.get('login'), dict)
                or set(payload['login']) - {'userId', 'password', 'randCode'}):
            raise ValueError('stdin 必须提供迁移 JSON 与 login 对象，密码只从 stdin 接收')
        if args.action == 'prepare':
            return {'ok': True, **_prepare(home, key, journal, payload)}
        if (not plan or not re.fullmatch('[a-f0-9]{32}', plan['candidateId'])
                or args.confirm != plan['planId']
                or plan['planId'] != _digest({k: v for k, v in plan.items() if k != 'planId'})):
            raise ValueError('迁移预览 ID 不匹配或已变化，请重新审阅')
        return _apply(home, key, journal, plan, payload)

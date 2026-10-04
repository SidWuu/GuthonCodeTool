"""Workspace-local bounded diagnosis history, describe cache and comparison.

History stores metadata and SQL hashes, never query text, bound literals, rows or
credentials. Cache entries contain column definitions only and are keyed by the
complete target/identity/connection metadata digest; successful probes invalidate
that target's entries. Callers provide the resolved workspace root explicitly.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
from pathlib import Path

from common import database_readonly as readonly
from common import database_test_artifacts as artifacts
from common.database_sql import table_references, validate_single_select
from common.persistence import atomic_text, file_lock

HISTORY_LIMIT = 100
CACHE_LIMIT = 100
CACHE_TTL_SECONDS = 300


def _root(workspace_root) -> Path:
    return Path(workspace_root).resolve() / 'context' / 'database'


def _read(path: Path, default):
    if not path.exists():
        return default
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise readonly.DatabaseReadonlyError('STATE_INVALID', '数据库历史或缓存文件无法读取') from error
    return value


def record_history(workspace_root, *, workspace_key, target, command, result=None, sql='', error_code='', stage='', metadata=None) -> dict:
    path = _root(workspace_root) / 'history.json'
    now = time.time()
    result = result or {}
    query_result = result.get('result', result)
    item = {'id': uuid.uuid4().hex, 'createdAt': now, 'workspaceKey': workspace_key, 'targetId': target['id'], 'environment': target['environment'], 'targetDigest': artifacts.digest(target), 'command': command, 'status': 'ERROR' if error_code else 'SUCCESS', 'errorCode': error_code, 'stage': stage}
    if metadata:
        if (not isinstance(metadata,dict) or set(metadata)-{'caseDigest','reportPath','stepCount','stoppedAt'}
                or any(not isinstance(value,(str,int)) or isinstance(value,bool) for value in metadata.values())):
            raise readonly.DatabaseReadonlyError('CONFIG_INVALID','诊断历史附加信息只允许案例摘要、报告路径和步骤计数')
        item.update(metadata)
    if sql:
        item['sqlDigest'] = hashlib.sha256(sql.encode('utf-8')).hexdigest()
        # Do not record textual SQL, literals, table names, parameters or rows.
        try:
            count = len(table_references(sql))
        except ValueError:
            count = None
        item['querySummary'] = {'kind': 'EXPLAIN' if query_result.get('kind') == 'execution-plan' else 'SELECT',
                                'physicalTableCount': count, 'characters': len(sql)}
    if isinstance(query_result, dict):
        item['rowCountReturned'] = len(query_result.get('rows', []))
        item['truncation'] = query_result.get('truncation', 'none')
        item['columnCount'] = len(query_result.get('columns', []))
    with file_lock(path.parent / '.history.lock'):
        items = _read(path, [])
        if not isinstance(items, list):
            raise readonly.DatabaseReadonlyError('STATE_INVALID', 'history.json 必须是数组')
        atomic_text(path, json.dumps([item, *items][:HISTORY_LIMIT], ensure_ascii=False, indent=2) + '\n')
    return item


def history_list(workspace_root, *, limit=20, target_id='', command='') -> dict:
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= HISTORY_LIMIT:
        raise readonly.DatabaseReadonlyError('CONFIG_INVALID', '历史 limit 必须为 1..100')
    items = _read(_root(workspace_root) / 'history.json', [])
    if not isinstance(items, list):
        raise readonly.DatabaseReadonlyError('STATE_INVALID', 'history.json 必须是数组')
    matching = [item for item in items if (not target_id or item['targetId'] == target_id) and (not command or item['command'] == command)]
    return {'ok': True, 'history': matching[:limit], 'returned': min(limit, len(matching)), 'truncated': len(matching) > limit, 'retainedLimit': HISTORY_LIMIT}


def history_show(workspace_root, identifier: str) -> dict:
    if not re.fullmatch(r'[a-f0-9]{32}', identifier):
        raise readonly.DatabaseReadonlyError('CONFIG_INVALID', '历史 ID 无效')
    items = history_list(workspace_root, limit=HISTORY_LIMIT)['history']
    item = next((item for item in items if item['id'] == identifier), None)
    if item is None:
        raise readonly.DatabaseReadonlyError('HISTORY_MISSING', '历史记录不存在或已轮转')
    return {'ok': True, 'entry': item}


def cache_digest(config, target):
    connection = config.get('connections', {}).get(target.get('connectionRef'), {})
    # Credential sources are included by reference only, never resolved.
    return artifacts.digest({'target': target, 'identity': config['expectedIdentities'][target['expectedIdentityRef']], 'connection': connection})


def invalidate_describe_cache(workspace_root, target_id):
    path = _root(workspace_root) / 'describe-cache.json'
    with file_lock(path.parent / '.cache.lock'):
        state = _read(path, {'epoch': 0, 'entries': {}})
        if not isinstance(state, dict) or not isinstance(state.get('entries'), dict):
            raise readonly.DatabaseReadonlyError('STATE_INVALID', 'describe-cache.json 格式无效')
        remaining = {key: item for key, item in state['entries'].items() if item.get('targetId') != target_id}
        atomic_text(path, json.dumps({'epoch': state['epoch'] + 1, 'entries': remaining}, ensure_ascii=False) + '\n')


def describe_cached(workspace_root, config, connection, target, table, *, refresh=False, ttl=CACHE_TTL_SECONDS):
    if not artifacts.IDENTIFIER.fullmatch(table):
        raise readonly.DatabaseReadonlyError('CONFIG_INVALID', '表名必须是普通标识符')
    if not isinstance(ttl, int) or isinstance(ttl, bool) or not 0 <= ttl <= 3600:
        raise readonly.DatabaseReadonlyError('CONFIG_INVALID', 'cache TTL 必须为 0..3600 秒')
    target_digest = cache_digest(config, target)
    key = artifacts.digest({'targetDigest': target_digest, 'table': table})
    path = _root(workspace_root) / 'describe-cache.json'
    now = time.time()
    with file_lock(path.parent / '.cache.lock'):
        state = _read(path, {'epoch': 0, 'entries': {}})
        if not isinstance(state, dict) or not isinstance(state.get('entries'), dict):
            raise readonly.DatabaseReadonlyError('STATE_INVALID', 'describe-cache.json 格式无效')
        epoch = state['epoch']
        item = state['entries'].get(key)
        if not refresh and item and 0 <= now - item['createdAt'] < ttl:
            return {**item['result'], 'cache': {'hit': True, 'createdAt': item['createdAt'], 'ttlSeconds': ttl, 'targetDigest': target_digest}}
    result = readonly.describe(connection, target, table)
    # Store only the schema result; never retain connection/credentials.
    with file_lock(path.parent / '.cache.lock'):
        state = _read(path, {'epoch': 0, 'entries': {}})
        if state['epoch'] != epoch:
            return {**result, 'cache': {'hit': False, 'stored': False, 'reason': 'probe-invalidated-during-fetch'}}
        cache = state['entries']
        cache[key] = {'createdAt': now, 'targetId': target['id'], 'result': result}
        cache = dict(sorted(cache.items(), key=lambda entry: entry[1]['createdAt'], reverse=True)[:CACHE_LIMIT])
        atomic_text(path, json.dumps({'epoch': epoch, 'entries': cache}, ensure_ascii=False, default=str) + '\n')
    return {**result, 'cache': {'hit': False, 'createdAt': now, 'ttlSeconds': ttl, 'targetDigest': target_digest}}


def compare_counts(config, workspace_key, *, tables: list[str], target_ids: list[str], capture=None) -> dict:
    """Compare explicit dev/test targets with bounded COUNT checks; failures stay failures."""
    artifacts.validate_config(config)
    if not 1 <= len(tables) <= 20 or not all(isinstance(table, str) and artifacts.IDENTIFIER.fullmatch(table) for table in tables):
        raise readonly.DatabaseReadonlyError('CONFIG_INVALID', '比较 tables 必须为 1..20 个普通表名')
    if not target_ids:
        target_ids = [artifacts.resolve_diagnosis_target(config,workspace_key,environment=environment)[0]['id'] for environment in ('dev','test')]
    if len(target_ids) != 2 or len(set(target_ids)) != 2:
        raise readonly.DatabaseReadonlyError('CONFIG_INVALID', '比较必须指定两个不同 target ID')
    targets = [artifacts.resolve_diagnosis_target(config, workspace_key, target_id=identifier)[0] for identifier in target_ids]
    if {target['environment'] for target in targets} != {'dev', 'test'}:
        raise readonly.DatabaseReadonlyError('ENVIRONMENT_MISMATCH', '比较必须明确选择 dev 与 test 目标各一个')
    if capture is not None:
        if (not isinstance(capture,dict) or set(capture)!={'schemaVersion','workspaceKey','targetResults'}
                or capture['schemaVersion']!=1 or capture['workspaceKey']!=workspace_key
                or not isinstance(capture['targetResults'],list) or len(capture['targetResults'])!=2):
            raise readonly.DatabaseReadonlyError('RESULT_UNSUPPORTED','Comparison capture must bind exactly two targets to this workspace')
        indexed={result.get('targetId'):result for result in capture['targetResults'] if isinstance(result,dict)}
        if set(indexed)!=set(target_ids):raise readonly.DatabaseReadonlyError('ENVIRONMENT_UNVERIFIED','Comparison targets differ from the requested dev/test targets')
        results=[]
        for target in targets:
            row=indexed[target['id']]
            identity=config['expectedIdentities'][target['expectedIdentityRef']]
            if (set(row)!={'targetId','targetDigest','identityDigest','identityEvidenceRef','counts','rawEvidenceRefs'}
                    or row['targetDigest']!=artifacts.digest(target) or row['identityDigest']!=artifacts.digest(identity)
                    or not isinstance(row['identityEvidenceRef'],str) or artifacts._is_placeholder(row['identityEvidenceRef'])
                    or not isinstance(row['counts'],dict) or set(row['counts'])!=set(tables)
                    or not isinstance(row['rawEvidenceRefs'],dict) or set(row['rawEvidenceRefs'])!=set(tables)
                    or any(isinstance(value,bool) or not isinstance(value,int) or value<0 for value in row['counts'].values())
                    or any(not isinstance(ref,str) or artifacts._is_placeholder(ref) for ref in row['rawEvidenceRefs'].values())):
                raise readonly.DatabaseReadonlyError('ENVIRONMENT_UNVERIFIED','Comparison capture is stale, incomplete or lacks identity/query evidence')
            results.append({**row,'environment':target['environment']})
        return {'ok':True,'executed':True,'execution':'caller-evidence-import','workspaceKey':workspace_key,'results':results,
                'comparisons':[{'table':table,'counts':{row['targetId']:row['counts'][table] for row in results},'equal':results[0]['counts'][table]==results[1]['counts'][table]} for table in tables],
                'evidenceBoundary':'Caller-supplied identity and COUNT evidence; different counts do not prove a business defect'}
    if any(not target.get('connectionRef') for target in targets):
        from common import database_dbx
        calls=[]
        for target in targets:
            identity=config['expectedIdentities'][target['expectedIdentityRef']]
            if not target.get('connectionId'):
                raise readonly.DatabaseReadonlyError('CONNECTOR_UNAVAILABLE','Mixed comparison requires each target to expose an explicit DBX connectionId')
            qualifier=target.get('schema') or ('public' if identity['engine']=='postgresql' else target['database'])
            for table in tables:
                calls.append({'targetId':target['id'],'table':table,'handoff':database_dbx.handoff(config,workspace_key,target,sql=f'SELECT COUNT(*) AS row_count FROM {qualifier}.{table}',max_rows=10)})
        return {'ok':True,'executed':False,'execution':'caller-mcp-handoff','workspaceKey':workspace_key,'calls':calls,
                'expectedCapture':{'schemaVersion':1,'workspaceKey':workspace_key,'targetResults':[{'targetId':target['id'],'targetDigest':artifacts.digest(target),
                    'identityDigest':artifacts.digest(config['expectedIdentities'][target['expectedIdentityRef']]),'identityEvidenceRef':'<required>',
                    'counts':{table:'<integer-count>' for table in tables},'rawEvidenceRefs':{table:'<required>' for table in tables}} for target in targets]},
                'nextAction':'Verify each identity, execute the exact COUNT calls through DBX, then import complete evidence with --capture; no comparison has executed yet'}
    results = []
    for target in targets:
        if not target.get('connectionRef'):
            raise readonly.DatabaseReadonlyError('CONNECTOR_UNAVAILABLE', 'DBX 目标请使用 handoff 分别执行，COUNT 对比需要内置连接')
        connection = readonly.connection_for_target(config, target)
        counts = {}
        with readonly.readonly_session(connection) as cursor:
            identity = readonly._probe_cursor(cursor, connection, target)
            qualifier = target.get('schema') or ('public' if connection['engine'] == 'postgresql' else target['database'])
            for table in tables:
                query = f'SELECT COUNT(*) AS row_count FROM {qualifier}.{table}'
                if str(target.get('validationScope') or 'full') == 'full':
                    artifacts.validate_sql_scope(query, target, 'compare', table)
                result = readonly._query_cursor(cursor, connection, target, query, 1)
                if result['truncation'] != 'none' or len(result['rows']) != 1:
                    raise readonly.DatabaseReadonlyError('RESULT_UNSUPPORTED', 'COUNT 查询未返回完整单行结果')
                count = next(iter(result['rows'][0].values()))
                counts[table] = int(count)
        results.append({'targetId': target['id'], 'environment': target['environment'], 'identityCheck': identity, 'counts': counts})
    comparisons = [{'table': table, 'counts': {item['targetId']: item['counts'][table] for item in results}, 'equal': results[0]['counts'][table] == results[1]['counts'][table]} for table in tables]
    return {'ok': True, 'workspaceKey': workspace_key, 'results': results, 'comparisons': comparisons, 'evidenceBoundary': '只比较本次只读事务中的表行数，不证明业务结果一致'}


def compile_template(template: dict, parameters: dict) -> str:
    if not isinstance(template, dict) or set(template) - {'schemaVersion', 'name', 'description', 'parameters', 'sql'} or template.get('schemaVersion') != 1:
        raise readonly.DatabaseReadonlyError('CONFIG_INVALID', 'SQL 模板结构或版本无效')
    specs = template.get('parameters')
    if not isinstance(specs, dict) or not isinstance(parameters, dict) or set(specs) != set(parameters):
        raise readonly.DatabaseReadonlyError('QUERY_INVALID', '模板参数必须与定义完全一致')
    values = {}
    for name, kind in specs.items():
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name):
            raise readonly.DatabaseReadonlyError('CONFIG_INVALID', '模板参数名称无效')
        value = parameters[name]
        if kind == 'identifier':
            if not isinstance(value, str) or not artifacts.IDENTIFIER.fullmatch(value):
                raise readonly.DatabaseReadonlyError('QUERY_INVALID', f'{name} 必须是普通标识符')
            values[name] = value
        elif kind == 'integer':
            if isinstance(value, bool) or not isinstance(value, int):
                raise readonly.DatabaseReadonlyError('QUERY_INVALID', f'{name} 必须是整数')
            values[name] = str(value)
        elif kind == 'string':
            if not isinstance(value, str) or '\\' in value:
                raise readonly.DatabaseReadonlyError('QUERY_INVALID', f'{name} 必须是不含反斜线的字符串')
            values[name] = "'" + value.replace("'", "''") + "'"
        else:
            raise readonly.DatabaseReadonlyError('CONFIG_INVALID', '模板参数仅支持 identifier/integer/string')
    query = str(template.get('sql') or '')
    placeholders = set(re.findall(r'\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}', query))
    if placeholders != set(specs):
        raise readonly.DatabaseReadonlyError('CONFIG_INVALID', 'SQL 模板占位符与参数定义不一致')
    # One substitution pass: parameter values containing {{...}} remain literals.
    query = re.sub(r'\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}', lambda match: values[match.group(1)], query)
    validate_single_select(query)
    table_references(query)
    return query


def load_template(directory, name):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', name):
        raise readonly.DatabaseReadonlyError('CONFIG_INVALID', '模板名称无效')
    path = Path(directory) / (name + '.json')
    value = json.loads(path.read_text(encoding='utf-8'))
    if value.get('name') != name:
        raise readonly.DatabaseReadonlyError('CONFIG_INVALID', '模板名称与文件不一致')
    return value


def build_diagnosis_case(template, parameters, *, workspace_key, datasource, database, source_evidence, max_rows=100):
    from providers.database.run_source_diagnosis import validate_case
    if not artifacts.WORKSPACE_KEY.fullmatch(workspace_key) or not datasource or not source_evidence.strip():
        raise readonly.DatabaseReadonlyError('CONFIG_INVALID','案例草稿需要明确workspaceKey、datasource和源码证据')
    if isinstance(max_rows,bool) or not isinstance(max_rows,int) or not 1<=max_rows<=100:
        raise readonly.DatabaseReadonlyError('QUERY_INVALID','模板案例max_rows必须为1..100')
    query=compile_template(template,parameters)
    case={'name':template['name'],'source_scope':workspace_key,'datasource':datasource,'database':database,
          'parameters':{},'max_rows':max_rows,'draft':False,
          'steps':[{'id':'template-check','name':template.get('description') or template['name'],
                    'source':source_evidence,'logic':'审阅源码后填写业务继续或停止条件',
                    'sql':query,'bindings':[],'continue_when':'always'}]}
    validate_case(case)
    case['draft']=True
    return case

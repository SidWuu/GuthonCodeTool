"""DBX metadata import and explicit MCP handoff, without DBX credential access.

The local CLI does not own an MCP connection. Exported calls must be executed by
an authorized caller with DBX; identity results are required before query calls.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from common import database_readonly as readonly
from common import database_test_artifacts as artifacts
from common.database_sql import table_references, validate_single_select


QUERY_TOOL = 'mcp__dbx__dbx_execute_query'
DESCRIBE_TOOL = 'mcp__dbx__dbx_describe_table'
ENGINE_ALIASES = {'postgres': 'postgresql', 'mariadb': 'mysql'}
IDENTITY_SQL = {
    'mysql': 'SELECT DATABASE() AS database_name, VERSION() AS server_version, @@hostname AS server_host, @@port AS server_port',
    'postgresql': 'SELECT current_database() AS database_name, current_schema() AS schema_name, version() AS server_version, inet_server_addr() AS server_host, inet_server_port() AS server_port',
    'oracle': "SELECT SYS_CONTEXT('USERENV', 'SERVICE_NAME') AS database_name, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS schema_name, SYS_CONTEXT('USERENV', 'SERVER_HOST') AS server_host FROM DUAL",
}


def parse_metadata(value) -> list[dict]:
    """Accept documented list-connections Markdown or strict public JSON only."""
    if isinstance(value, str):
        text = value.strip()
        if text.startswith(('[', '{')):
            return parse_metadata(json.loads(text))
        lines = [line.strip() for line in text.splitlines() if line.strip().startswith('|')]
        if len(lines) < 2:
            raise artifacts.ArtifactError('CONFIG_INVALID', 'DBX 元数据必须是连接清单 JSON 或 Markdown 表')
        columns = [item.strip() for item in lines[0].strip('|').split('|')]
        expected = ['ID', 'Name', 'Group Path', 'Type', 'Host', 'Port', 'Database']
        if columns != expected:
            raise artifacts.ArtifactError('CONFIG_INVALID', 'DBX Markdown 表列必须是 ID/Name/Group Path/Type/Host/Port/Database')
        rows = []
        for line in lines[2:]:
            parts = [item.strip().replace('\\|', '|') for item in re.split(r'(?<!\\)\|', line.strip('|'))]
            if len(parts) != len(columns):
                raise artifacts.ArtifactError('CONFIG_INVALID', 'DBX 元数据表列数不一致')
            rows.append(dict(zip(['connectionId', 'name', 'groupPath', 'engine', 'host', 'port', 'database'], parts)))
        return parse_metadata(rows)
    if isinstance(value, dict):
        if set(value) != {'connections'}:
            raise artifacts.ArtifactError('CONFIG_INVALID', 'DBX JSON 顶层仅允许 connections')
        value = value['connections']
    if not isinstance(value, list):
        raise artifacts.ArtifactError('CONFIG_INVALID', 'DBX connections 必须是数组')
    allowed = {'connectionId', 'name', 'groupPath', 'engine', 'host', 'port', 'database', 'schema'}
    rows, seen = [], set()
    for raw in value:
        if not isinstance(raw, dict) or set(raw) - allowed:
            raise artifacts.ArtifactError('CONFIG_INVALID', 'DBX 元数据只允许公开连接字段，禁止密码、隧道和凭据字段')
        required = {'connectionId', 'engine'}
        if any(raw.get(key) in (None, '') for key in required):
            raise artifacts.ArtifactError('CONFIG_INVALID', 'DBX 元数据缺少 connectionId/engine')
        row = dict(raw)
        row['engine'] = ENGINE_ALIASES.get(str(row['engine']).lower(), str(row['engine']).lower())
        if row['connectionId'] in seen:
            raise artifacts.ArtifactError('CONFIG_INVALID', 'DBX connectionId 重复')
        seen.add(row['connectionId'])
        if row['engine'] not in artifacts.ENGINES:
            # Unrelated SQLite/Redis entries may have no host or TCP port. They
            # remain selectable metadata but cannot become SQL diagnosis targets.
            rows.append(row)
            continue
        if not isinstance(row.get('host'), str) or not row['host'] or any(char.isspace() for char in row['host']):
            raise artifacts.ArtifactError('CONFIG_INVALID', 'DBX SQL 连接 host 无效')
        try:
            row['port'] = int(row['port'])
        except (TypeError, ValueError) as error:
            raise artifacts.ArtifactError('CONFIG_INVALID', 'DBX port 无效') from error
        if not 1 <= row['port'] <= 65535:
            raise artifacts.ArtifactError('CONFIG_INVALID', 'DBX port 超出范围')
        rows.append(row)
    return rows


def import_target(config: dict, workspace_key: str, metadata, payload: dict, *, source_ref: str) -> dict:
    """Import an exact ID's public endpoint. Never infer environment or database."""
    if not source_ref or artifacts._is_placeholder(source_ref):
        raise artifacts.ArtifactError('ENVIRONMENT_UNVERIFIED', '导入必须记录实际 DBX 元数据来源 sourceRef')
    rows = parse_metadata(metadata)
    unknown = set(payload) - {'connectionId', 'targetId', 'environment', 'database', 'schema', 'makeDefault', 'validationScope', 'systemId', 'dataSourceId', 'allowedTables', 'tenantScope', 'evidenceRef'}
    if unknown:
        raise artifacts.ArtifactError('CONFIG_INVALID', 'DBX 导入包含未知字段: ' + ', '.join(sorted(unknown)))
    row = next((item for item in rows if item['connectionId'] == payload.get('connectionId')), None)
    if row is None:
        raise artifacts.ArtifactError('BINDING_MISSING', 'connectionId 不在本次 DBX 元数据清单中')
    if row['engine'] not in artifacts.ENGINES:
        raise artifacts.ArtifactError('UNSUPPORTED', '只读排查仅支持 MySQL/PostgreSQL/Oracle')
    database = str(payload.get('database') or row.get('database') or '')
    if not database:
        raise artifacts.ArtifactError('ENVIRONMENT_UNVERIFIED', 'DBX 连接未选择 database；请先执行身份查询并显式填写 database')
    if not row.get('database') and (not payload.get('evidenceRef') or artifacts._is_placeholder(str(payload['evidenceRef']))):
        raise artifacts.ArtifactError('ENVIRONMENT_UNVERIFIED', '清单无 database 时必须提供身份查询的实际 evidenceRef')
    if row.get('database') and payload.get('database') and row['database'].lower() != payload['database'].lower():
        raise artifacts.ArtifactError('ENVIRONMENT_MISMATCH', '显式 database 与本次 DBX 清单不一致')
    if not payload.get('environment'):
        raise artifacts.ArtifactError('ENVIRONMENT_UNVERIFIED', '导入必须显式声明 dev/test，不从连接名或分组猜测')
    if config:
        artifacts.validate_config(config)
    value = json.loads(json.dumps(config)) if config else {'schemaVersion': 1, 'connections': {}, 'expectedIdentities': {}, 'databaseTests': {}}
    if not artifacts.WORKSPACE_KEY.fullmatch(workspace_key):
        raise artifacts.ArtifactError('CONFIG_INVALID', 'workspaceKey 无效')
    identifier = str(payload.get('targetId') or '')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', identifier):
        raise artifacts.ArtifactError('CONFIG_INVALID', 'targetId 无效')
    if payload.get('environment') not in artifacts.ENVIRONMENTS:
        raise artifacts.ArtifactError('CONFIG_INVALID', 'environment 仅允许 dev/test')
    if 'makeDefault' in payload and not isinstance(payload['makeDefault'], bool):
        raise artifacts.ArtifactError('CONFIG_INVALID', 'makeDefault 必须为布尔值')
    workspace = value['databaseTests'].setdefault(workspace_key, {'targets': []})
    existing = next((item for item in workspace['targets'] if item['id'] == identifier), None)
    target = dict(existing or {})
    ref = target.get('expectedIdentityRef') or f'{workspace_key}.{identifier}.identity'
    schema = str(payload.get('schema') or row.get('schema') or target.get('schema') or '')
    identity = {'engine': row['engine'], 'endpoint': f"{row['host']}:{row['port']}", 'database': database, 'evidenceRef': payload.get('evidenceRef') or source_ref}
    if schema:
        identity['schema'] = schema
        target['schema'] = schema
    else:
        target.pop('schema', None)
    target.update(id=identifier, connectionId=row['connectionId'], database=database, environment=payload['environment'], access='read-only', expectedIdentityRef=ref)
    target.setdefault('validationScope', 'full' if existing else 'diagnosis-only')
    for field in ('validationScope', 'systemId', 'dataSourceId', 'allowedTables', 'tenantScope'):
        if field in payload:
            target[field] = payload[field]
    # An existing built-in connection stays intact. Incompatible endpoint changes
    # fail shared validation instead of silently discarding stored credentials.
    value['expectedIdentities'][ref] = identity
    if existing:
        workspace['targets'][workspace['targets'].index(existing)] = target
    else:
        workspace['targets'].append(target)
    defaults = workspace.setdefault('defaults', {})
    by_environment = defaults.setdefault('byEnvironment', {})
    for name in list(by_environment):
        if by_environment[name] == identifier and name != target['environment']:
            del by_environment[name]
    if payload.get('makeDefault', existing is None):
        defaults['diagnosisTargetId'] = identifier
        by_environment[target['environment']] = identifier
    artifacts.validate_config(value)
    return value


def identity_sql(engine, target):
    if engine != 'oracle':
        return IDENTITY_SQL[engine]
    schema = str(target.get('schema') or '')
    if not artifacts.IDENTIFIER.fullmatch(schema):
        raise artifacts.ArtifactError('ENVIRONMENT_UNVERIFIED', 'Oracle identity requires an exact business schema')
    return ("SELECT SYS_CONTEXT('USERENV','SERVICE_NAME') AS database_name, "
            "SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS login_schema, "
            f"'{schema.upper()}' AS schema_name, "
            f"(SELECT COUNT(*) FROM ALL_USERS WHERE USERNAME='{schema.upper()}') AS schema_exists, "
            f"(SELECT COUNT(*) FROM ALL_TABLES WHERE OWNER='{schema.upper()}') AS visible_tables FROM DUAL")


def normalize_query_result(result, *, column_types=None):
    """Decode the documented DBX text table conservatively; never guess types/completeness."""
    column_types = column_types or {}
    if not isinstance(result, dict) or not isinstance(result.get('content'), list):
        raise artifacts.ArtifactError('RESULT_UNSUPPORTED', 'DBX result must be an MCP content envelope')
    if result.get('isError'):
        return {'status': 'ERROR', 'columns': [], 'rows': [], 'truncation': 'unknown', 'errorCode': 'DBX_QUERY_FAILED'}
    if any(block.get('type') != 'text' or not isinstance(block.get('text'), str) for block in result['content']):
        raise artifacts.ArtifactError('RESULT_UNSUPPORTED', 'Only complete text-table DBX query results are supported')
    text = '\n'.join(block['text'] for block in result['content'])
    table_lines = [line.strip() for line in text.splitlines() if line.strip().startswith('|')]
    if len(table_lines) < 2:
        raise artifacts.ArtifactError('RESULT_UNSUPPORTED', 'DBX result has no recognized table')
    def cells(line):
        return [value.strip().replace('\\|', '|') for value in re.split(r'(?<!\\)\|', line.strip('|'))]
    columns = cells(table_lines[0])
    if not columns or len(set(columns)) != len(columns) or any(not column for column in columns):
        raise artifacts.ArtifactError('RESULT_UNSUPPORTED', 'DBX table columns are ambiguous')
    if any(not re.fullmatch(r':?-+:?', cell) for cell in cells(table_lines[1])):
        raise artifacts.ArtifactError('RESULT_UNSUPPORTED', 'Invalid DBX table separator')
    if set(column_types) - set(columns) or any(value not in {'integer', 'decimal', 'string'} for value in column_types.values()):
        raise artifacts.ArtifactError('RESULT_UNSUPPORTED', 'Explicit result column types must match returned columns')
    rows = []
    ambiguous = False
    for line in table_lines[2:]:
        values = cells(line)
        if len(values) != len(columns):
            raise artifacts.ArtifactError('RESULT_UNSUPPORTED', 'DBX table row width mismatch')
        row = {}
        for column, value in zip(columns, values):
            declared = column_types.get(column, 'string')
            if value == 'NULL' or '<br' in value.lower() or '…' in value:
                ambiguous = True
            if declared == 'integer':
                if not re.fullmatch(r'-?\d+', value):
                    raise artifacts.ArtifactError('RESULT_UNSUPPORTED', 'DBX integer cell is not an exact integer')
                value = int(value)
            elif declared == 'decimal':
                if not re.fullmatch(r'-?\d+(?:\.\d+)?', value):
                    raise artifacts.ArtifactError('RESULT_UNSUPPORTED', 'DBX decimal cell is not exact')
            row[column] = value
        rows.append(row)
    totals = re.findall(r'\((\d+) rows, \d+ms\)', text)
    complete = len(totals) == 1 and int(totals[0]) == len(rows)
    truncation = 'rows' if 'cap was reached' in text or 'showing ' in text else 'unknown' if not complete or ambiguous or 'truncated' in text.lower() else 'none'
    return {'status': 'SUCCESS', 'columns': columns, 'rows': rows, 'truncation': truncation}


def handoff(config: dict, workspace_key: str, target: dict, *, sql='', table='', max_rows=100) -> dict:
    artifacts.validate_config(config)
    if not target.get('connectionId'):
        raise artifacts.ArtifactError('CONNECTOR_UNAVAILABLE', 'target 未绑定 DBX connectionId')
    identity = config['expectedIdentities'][target['expectedIdentityRef']]
    engine = identity['engine']
    args = {'connection_id': target['connectionId'], 'database': target['database']}
    calls = [{'phase': 'identity', 'tool': QUERY_TOOL, 'arguments': {**args, 'sql': identity_sql(engine, target), 'max_rows': 10}}]
    if not isinstance(max_rows, int) or isinstance(max_rows, bool) or not 1 <= max_rows <= 100:
        raise artifacts.ArtifactError('QUERY_UNSUPPORTED', 'handoff max_rows 必须是 1..100')
    expected = str(target.get('schema') or target['database']).lower()
    if table:
        if not artifacts.IDENTIFIER.fullmatch(table):
            raise artifacts.ArtifactError('QUERY_UNSUPPORTED', '表名必须是普通标识符')
        calls.append({'phase': 'describe', 'requires': 'identity-match', 'tool': DESCRIBE_TOOL, 'arguments': {**args, 'table': table, **({'schema': target['schema']} if target.get('schema') else {})}})
    if sql:
        candidate = validate_single_select(sql, engine)
        references = table_references(candidate)
        if not references:
            raise artifacts.ArtifactError('QUERY_UNSUPPORTED', '查询必须引用目标业务表')
        for reference in references:
            parts = reference.split('.')
            if len(parts) > 2 or (len(parts) == 2 and parts[0].lower() != expected):
                raise artifacts.ArtifactError('CROSS_DATABASE_DENIED', '查询引用目标之外的 database/schema')
            if engine == 'oracle' and len(parts) != 2:
                raise artifacts.ArtifactError('QUERY_UNSUPPORTED', 'Oracle 查询必须限定业务 schema')
        if str(target.get('validationScope') or 'full') == 'full':
            artifacts.validate_sql_scope(candidate, target, 'handoff', 'query')
        calls.append({'phase': 'query', 'requires': 'identity-match', 'tool': QUERY_TOOL, 'arguments': {**args, 'sql': candidate, 'max_rows': max_rows, 'cell_char_limit': 2000}})
    return {'ok': True, 'execution': 'caller-mcp-handoff', 'executed': False, 'workspaceKey': workspace_key, 'targetId': target['id'], 'targetDigest': artifacts.digest(target), 'expectedIdentity': identity, 'identityCheck': {'required': True, 'fields': ['database_name', *(['schema_name'] if target.get('schema') else [])], 'oracleBusinessSchemaCheck': 'schema_exists=1 and visible_tables>0; login_schema is not required to equal business schema' if engine == 'oracle' else None, 'endpointEvidence': 'DBX list metadata; server_host/port may differ behind tunnel; caller must compare declared source evidence'}, 'calls': calls}


def export_plan(config: dict, plan: dict) -> dict:
    artifacts.validate_plan(plan, config)
    targets = {item['id']: item for item in config['databaseTests'][plan['workspaceKey']]['targets']}
    verification, calls = {}, []
    for case in plan['cases']:
        target = targets[case['targetId']]
        if target['id'] not in verification:
            verification[target['id']] = handoff(config, plan['workspaceKey'], target)['calls'][0]
        for step in [*case.get('preconditions', []), *case['checks']]:
            call = handoff(config, plan['workspaceKey'], target, sql=step['sql'])['calls'][-1]
            calls.append({'caseId': case['caseId'], 'stepId': step['id'], 'targetId': target['id'], 'continueOnlyAfter': 'preconditions-pass-and-identity-match', **call})
    return {'schemaVersion': 1, 'executed': False, 'planDigest': artifacts.digest(plan), 'sourceDigest': plan['sourceDigest'], 'workspaceKey': plan['workspaceKey'], 'targetDigests': {key: artifacts.digest(targets[key]) for key in verification}, 'identityCalls': verification, 'stepCalls': calls}


def import_results(config: dict, plan: dict, capture: dict) -> dict:
    """Import explicit execution evidence, keeping unknown truncation BLOCKED.

    The capture is an interchange format filled by the MCP caller. It is not a
    raw DBX response parser; absent execution/identity evidence is never invented.
    """
    artifacts.validate_plan(plan, config)
    required = {'schemaVersion', 'runId', 'sourceDigest', 'planDigest', 'targetVerification', 'steps'}
    if not isinstance(capture, dict) or set(capture) - (required | {'platformEvidence'}) or any(key not in capture for key in required):
        raise artifacts.ArtifactError('RESULT_UNSUPPORTED', 'DBX capture 必须包含 run/source/plan 摘要、身份核验证据及规范化 steps')
    result = {'schemaVersion': 1, 'taskId': plan['taskId'], 'workspaceKey': plan['workspaceKey'], **capture}
    artifacts.validate_results(result, plan)
    targets = {item['id']: item for item in config['databaseTests'][plan['workspaceKey']]['targets']}
    expected_targets = {case['targetId'] for case in plan['cases']}
    if set(result['targetVerification']) != expected_targets:
        raise artifacts.ArtifactError('ENVIRONMENT_UNVERIFIED', 'DBX capture 的核验目标必须与计划精确一致')
    for identifier, verification in result['targetVerification'].items():
        if verification['targetDigest'] != artifacts.digest(targets[identifier]):
            raise artifacts.ArtifactError('ENVIRONMENT_UNVERIFIED', 'DBX capture 的 targetDigest 已变化')
    return result

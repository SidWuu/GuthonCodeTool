"""Execute validated query plans through the existing read-only adapter.

Platform actions and cleanup are supplied by their owning workflow. Evidence is
written only to a new private directory; no credentials or driver details enter
the artifacts. DBX-only targets continue to use the explicit MCP handoff.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import uuid
from pathlib import Path

from common import database_readonly as readonly
from common import database_test_artifacts as artifacts
from common.database_sql import validate_single_select


def run_plan(plan, config, output_dir, *, max_rows=100, platform_evidence=None):
    artifacts.validate_plan(plan, config)
    if isinstance(max_rows, bool) or not isinstance(max_rows, int) or not 1 <= max_rows <= 100:
        raise artifacts.ArtifactError('ARTIFACT_INVALID', 'max_rows 必须为 1..100')
    if platform_evidence is not None and not isinstance(platform_evidence, dict):
        raise artifacts.ArtifactError('ARTIFACT_INVALID', 'platform evidence 必须是按 caseId 索引的对象')
    targets = {target['id']: target for target in config['databaseTests'][plan['workspaceKey']]['targets']}
    for case in plan['cases']:
        target = targets[case['targetId']]
        if not target.get('connectionRef'):
            raise artifacts.ArtifactError('CONNECTOR_UNAVAILABLE', 'DBX-only 计划请使用 export-dbx-plan / import-dbx-results；本命令不会跨进程读取 DBX 凭据')
        if case['cleanup']['required'] is not False:
            raise artifacts.ArtifactError('CLEANUP_REQUIRED', '只读执行器不执行清理；请由原流程完成需要清理的用例')
        engine = config['connections'][target['connectionRef']]['engine']
        for step in [*case.get('preconditions', []), *case['checks']]:
            try:
                validate_single_select(step['sql'], engine)
            except ValueError as error:
                raise artifacts.ArtifactError('QUERY_UNSUPPORTED', str(error)) from error
    directory = Path(output_dir).resolve()
    public_root = Path(__file__).resolve().parents[2]
    if directory.is_relative_to(public_root):
        raise artifacts.ArtifactError('PRIVATE_OUTPUT_REQUIRED', '数据库结果不得写入工具源码仓库')
    # No overwrite or reuse of a previous run, including failed runs.
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    results = {'schemaVersion': 1, 'taskId': plan['taskId'], 'workspaceKey': plan['workspaceKey'],
               'sourceDigest': plan['sourceDigest'], 'planDigest': artifacts.digest(plan),
               'runId': uuid.uuid4().hex, 'targetVerification': {}, 'platformEvidence': platform_evidence or {}, 'steps': []}

    def write_evidence(name, value):
        file = directory / name
        with open(file, 'x', encoding='utf-8', opener=lambda path, flags: os.open(path, flags, 0o600)) as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
        return str(file)

    def stamp():
        return dt.datetime.now(dt.timezone.utc).isoformat()

    for case_index, case in enumerate(plan['cases']):
        target = targets[case['targetId']]
        verification = {'targetDigest': artifacts.digest(target), 'status': 'BLOCKED'}
        # Missing platform evidence must not trigger even read-only checks for
        # an unverified deployment. The evaluator preserves VERSION_UNVERIFIED.
        steps = [*case.get('preconditions', []), *case['checks']]
        current_step = None
        started = stamp()
        try:
            connection = readonly.connection_for_target(config, target)
            with readonly.readonly_session(connection) as cursor:
                identity = readonly._probe_cursor(cursor, connection, target)
                verification.update(status='PASS', identity=identity)
                verification['evidenceRef'] = write_evidence(f'identity-{case_index}.json', verification)
                results['targetVerification'][target['id']] = dict(verification)
                if case['level'] == 'platform-result' and not artifacts._platform_verified(case, results, plan['sourceDigest']):
                    continue
                for step_index, step in enumerate(steps):
                    current_step, started = step, stamp()
                    query = readonly._query_cursor(cursor, connection, target, step['sql'], max_rows)
                    row = {'caseId': case['caseId'], 'stepId': step['id'], 'targetId': target['id'],
                           'startedAt': started, 'finishedAt': stamp(), 'status': 'SUCCESS',
                           'columns': query['columns'], 'rows': query['rows'], 'truncation': query['truncation']}
                    row['rawEvidenceRef'] = write_evidence(f'query-{case_index}-{step_index}.json', row)
                    results['steps'].append(row)
                    current_step = None
                    if step_index < len(case.get('preconditions', [])) and artifacts.evaluate_step(step, row)['status'] != 'PASS':
                        break
        except readonly.DatabaseReadonlyError as error:
            if current_step is not None:
                row = {'caseId': case['caseId'], 'stepId': current_step['id'], 'targetId': target['id'],
                       'startedAt': started, 'finishedAt': stamp(), 'status': 'ERROR', 'columns': [], 'rows': [],
                       'truncation': 'unknown', 'errorCode': error.code, 'message': str(error)}
                row['rawEvidenceRef'] = write_evidence(f'error-{case_index}.json', row)
                results['steps'].append(row)
            else:
                verification.update(status='BLOCKED', errorCode=error.code, message=str(error))
                verification['evidenceRef'] = write_evidence(f'identity-error-{case_index}.json', verification)
                results['targetVerification'][target['id']] = verification
    artifacts.validate_results(results, plan)
    evaluation = artifacts.evaluate(plan, results, config)
    results_path = write_evidence('database-test-results.json', results)
    report_path = directory / 'database-test-report.md'
    with open(report_path, 'x', encoding='utf-8', opener=lambda path, flags: os.open(path, flags, 0o600)) as handle:
        handle.write(artifacts.render_report(plan, results, evaluation))
    return {'ok': evaluation['status'] == 'PASS', 'executed': True, 'evaluation': evaluation,
            'resultsPath': results_path, 'reportPath': str(report_path),
            'evidenceBoundary': '只读查询与调用方提供的平台证据；未执行平台动作、发布或清理'}

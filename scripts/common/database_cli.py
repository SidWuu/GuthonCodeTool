"""Database command orchestration, shared by CLI and persistent ToolHost."""
from __future__ import annotations

import csv
import io
import json
import re
import sys
from pathlib import Path

from common import database_readonly as readonly
from common import database_test_artifacts as artifacts
from common import database_dbx as dbx
from common import database_operations as operations
from common.persistence import atomic_text, atomic_bytes, file_lock
from common.command_errors import CommandError, error_code



def save_config(path, config):
    try:
        import yaml
        text = yaml.safe_dump(config, allow_unicode=True, sort_keys=False, default_flow_style=False)
    except ImportError:
        # JSON is a YAML subset; the runtime's loader explicitly supports it.
        text = json.dumps(config, ensure_ascii=False, indent=2) + "\n"
    atomic_text(path, text)


def configure(path, workspace, payload):
    if not isinstance(payload, dict):
        raise readonly.DatabaseReadonlyError("CONFIG_INVALID", "数据库配置输入必须是 JSON 对象")
    with file_lock(path.parent / ".configuration.lock"):
        current = artifacts.load_yaml(path) if path.is_file() else {}
        updated, ref = readonly.build_diagnosis_config(current, workspace["workspaceKey"], payload)
        previous = None
        if ref:
            keyring = readonly._keyring()
            previous = keyring.get_password(readonly.CREDENTIAL_SERVICE, ref)
            readonly.set_password(ref, str(payload["password"]))
        stage = "connect"
        try:
            target, _ = artifacts.resolve_diagnosis_target(updated, workspace["workspaceKey"], target_id=payload["targetId"])
            evidence = readonly.probe(readonly.connection_for_target(updated, target), target)
            stage = "save"
            save_config(path, updated)
        except Exception as error:
            error.stage = getattr(error, "stage", stage)
            try:
                if ref:
                    readonly.delete_password(ref) if previous is None else readonly.set_password(ref, previous)
            except readonly.DatabaseReadonlyError as rollback_error:
                raise readonly.DatabaseReadonlyError(
                    "CREDENTIAL_ROLLBACK_FAILED", "配置未保存，凭据回滚失败；请重新配置此目标",
                    detail=f"originalCode={getattr(error, 'code', 'CONFIG_INVALID')}; rollbackCode={rollback_error.code}",
                ) from error
            raise
    return {"ok": True, "workspaceKey": workspace["workspaceKey"], "targetId": target["id"],
            "environment": target["environment"], "connector": "builtin-readonly", "probe": evidence}


def _sql_payload(parsed, *, required):
    if parsed.max_rows is not None and not 1 <= parsed.max_rows <= readonly.MAX_ROWS:
        raise readonly.DatabaseReadonlyError("QUERY_INVALID", f"maxRows 必须为 1..{readonly.MAX_ROWS}")
    if parsed.sql_file:
        return Path(parsed.sql_file).expanduser().read_text(encoding="utf-8"), parsed.max_rows or readonly.MAX_ROWS
    if parsed.sql is not None:
        text = Path(parsed.sql[1:]).expanduser().read_text(encoding="utf-8") if parsed.sql.startswith("@") else parsed.sql
        return text, parsed.max_rows or readonly.MAX_ROWS
    if not required and not parsed.stdin:
        return "", parsed.max_rows if parsed.max_rows is not None else readonly.MAX_ROWS
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict) or set(payload) - {"sql", "maxRows"}:
        raise readonly.DatabaseReadonlyError("QUERY_INVALID", "查询 stdin 必须是仅包含 sql/maxRows 的 JSON 对象")
    value = parsed.max_rows if parsed.max_rows is not None else payload.get("maxRows", readonly.MAX_ROWS)
    if not isinstance(value, int) or isinstance(value, bool):
        raise readonly.DatabaseReadonlyError("QUERY_INVALID", "maxRows 必须是整数")
    max_rows = value
    if not 1 <= max_rows <= readonly.MAX_ROWS:
        raise readonly.DatabaseReadonlyError("QUERY_INVALID", f"maxRows 必须为 1..{readonly.MAX_ROWS}")
    return str(payload.get("sql") or ""), max_rows


def emit(payload, parsed):
    format_name = getattr(parsed, "format", "json")
    result = payload.get("result", payload)
    if isinstance(result, dict) and "result" in result and isinstance(result["result"], dict):
        result = result["result"]
    if format_name == 'xlsx':
        from common.query_xlsx import workbook
        from guthon_tool import SOURCE_ROOT
        if not getattr(parsed,'output',None):
            raise readonly.DatabaseReadonlyError('QUERY_INVALID', 'XLSX 导出必须指定 --output，不能写入文本 stdout')
        target = Path(parsed.output).expanduser().resolve()
        if target.is_relative_to(SOURCE_ROOT) or target.suffix.lower() != '.xlsx':
            raise readonly.DatabaseReadonlyError('PRIVATE_OUTPUT_REQUIRED', 'XLSX 必须输出到工具仓库之外的 .xlsx 文件')
        data = workbook(payload, result)
        atomic_bytes(target, data)
        if result.get('truncation') not in (None,'',False,'none') or result.get('truncated'):
            print('结果已截断；详情已记录在工作簿的证据页，请缩小查询范围。',file=sys.stderr)
        print(json.dumps({'ok':True,'outputPath':str(target),'format':'xlsx','rowCountReturned':len(result.get('rows',[])),
                          'truncation':result.get('truncation','none')},ensure_ascii=False))
        return
    if format_name == "json":
        text = json.dumps(payload, ensure_ascii=False, indent=2, default=str) + "\n"
    else:
        rows = result.get("rows", [])
        columns = result.get("columns", list(rows[0]) if rows and isinstance(rows[0], dict) else [])
        output = io.StringIO()
        writer = csv.writer(output, delimiter="," if format_name == "csv" else "\t")
        writer.writerow(columns)
        for row in rows:
            writer.writerow([row.get(column) for column in columns] if isinstance(row, dict) else row)
        text = output.getvalue()
        if result.get("truncation") not in (None, "", False, "none") or result.get("truncated"):
            print("结果已截断；请缩小查询范围或使用 JSON 查看 truncationDetails。", file=sys.stderr)
    if getattr(parsed, "output", None):
        atomic_text(Path(parsed.output).expanduser().resolve(), text)
    else:
        print(text, end="")


def run(command, parsed, hub, tool_config, workspace=None):
    path = hub.CONFIG_DIR / "database-testing.yaml"
    profile = getattr(parsed, 'profile', '')
    profile_config = None
    if profile:
        profile_config = artifacts.load_yaml(path)
        artifacts.validate_config(profile_config)
        binding = profile_config.get('profiles', {}).get(profile)
        if not binding:
            raise CommandError('BINDING_MISSING', f'profile 不存在: {profile}')
        resolved = workspace or hub.resolve_workspace(tool_config, binding['workspaceKey'])
        if resolved['workspaceKey'] != binding['workspaceKey']:
            raise CommandError('ENVIRONMENT_MISMATCH', 'profile 与显式工作区不一致')
    else:
        resolved = workspace or hub.resolve_workspace_for_path(tool_config, parsed.path)
    stage = "resolve"
    target_id = getattr(parsed, "target_id", "")
    if profile:
        if target_id and target_id != binding['targetId']:
            raise CommandError('ENVIRONMENT_MISMATCH', 'profile 与 --target-id 不一致')
        target_id = binding['targetId']
    history_target = None
    history_sql = ''
    try:
        if command=='diagnosis-template' and getattr(parsed,'case_out',''):
            from providers.database.run_source_diagnosis import validate_datasource
            name,datasource=hub.resolve_datasource(tool_config,parsed.datasource)
            validate_datasource(name,datasource)
            if datasource.get('object') and datasource['object']!=resolved['workspaceKey']:
                raise readonly.DatabaseReadonlyError('ENVIRONMENT_MISMATCH','案例数据源不属于当前显式工作区')
            if parsed.template_dir:template=operations.load_template(Path(parsed.template_dir).expanduser(),parsed.name)
            else:
                if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*',parsed.name):
                    raise readonly.DatabaseReadonlyError('CONFIG_INVALID','模板名称无效')
                from guthon_tool import bundled_bytes
                template=json.loads(bundled_bytes('config/example/diagnosis-templates/'+parsed.name+'.json').decode('utf-8'))
            database=str(datasource.get('database') or '')
            if database not in datasource['databases']:
                raise readonly.DatabaseReadonlyError('CONFIG_INVALID','案例数据源必须明确默认database且位于允许数据库列表')
            case=operations.build_diagnosis_case(template,json.loads(parsed.parameters),workspace_key=resolved['workspaceKey'],
                    datasource=name,database=database,source_evidence=parsed.source_evidence,max_rows=parsed.max_rows)
            out=Path(parsed.case_out).expanduser().resolve()
            from guthon_tool import SOURCE_ROOT
            if out.is_relative_to(SOURCE_ROOT):raise readonly.DatabaseReadonlyError('PRIVATE_OUTPUT_REQUIRED','诊断案例草稿不得写入公开工具源码仓库')
            out.parent.mkdir(parents=True,exist_ok=True)
            import os
            with open(out,'x',encoding='utf-8',opener=lambda path,flags:os.open(path,flags,0o600)) as handle:
                json.dump(case,handle,ensure_ascii=False,indent=2);handle.write('\n')
            result={'ok':True,'workspaceKey':resolved['workspaceKey'],'draft':True,'executed':False,
                    'artifactPath':str(out),'nextAction':'核验源码和业务继续/停止条件，显式将draft设false后通过diagnose执行'}
        elif command in {"database-credentials-export", "database-credentials-import"}:
            import os
            from common import credential_vault
            database_config = artifacts.load_yaml(path)
            artifacts.validate_config(database_config)
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*",parsed.passphrase_env):
                raise readonly.DatabaseReadonlyError("CONFIG_INVALID","Passphrase environment variable name is invalid")
            with file_lock(path.parent / '.configuration.lock'):
                current_tool_config = hub.load_config()
                current_database_config = artifacts.load_yaml(path)
                artifacts.validate_config(current_database_config)
                current_workspace = hub.resolve_workspace(current_tool_config,resolved['workspaceKey'])
                result = credential_vault.transfer(current_tool_config,current_database_config,current_workspace,vault=parsed.vault,
                         refs=parsed.credential_ref,passphrase=os.environ.get(parsed.passphrase_env,""),importing=command.endswith("import"),
                         confirmation=parsed.confirmation,node_path=parsed.node)
        elif command in {'database-history-list', 'diagnosis-list', 'database-history-show', 'diagnosis-show'}:
            if command.endswith('list'):
                result = operations.history_list(resolved['root'], limit=parsed.limit, target_id=target_id)
            else:
                result = operations.history_show(resolved['root'], parsed.id)
        elif command == 'database-dbx-import':
            payload = json.load(sys.stdin)
            if not isinstance(payload, dict):
                raise readonly.DatabaseReadonlyError('CONFIG_INVALID', 'DBX 导入参数必须为 JSON 对象')
            if target_id:
                if payload.get('targetId') not in (None, '', target_id):
                    raise readonly.DatabaseReadonlyError('CONFIG_INVALID', '--target-id 与 JSON targetId 不一致')
                payload['targetId'] = target_id
            if parsed.environment:
                if payload.get('environment') not in (None, '', parsed.environment):
                    raise readonly.DatabaseReadonlyError('ENVIRONMENT_MISMATCH', '--environment 与导入 environment 不一致')
                payload['environment'] = parsed.environment
            metadata = Path(parsed.metadata).expanduser().read_text(encoding='utf-8')
            with file_lock(path.parent / '.configuration.lock'):
                current = artifacts.load_yaml(path) if path.is_file() else {}
                updated = dbx.import_target(current, resolved['workspaceKey'], metadata, payload, source_ref=parsed.source_ref)
                save_config(path, updated)
            result = {'ok': True, 'targetId': payload['targetId'], 'workspaceKey': resolved['workspaceKey'], 'connector': 'dbx', 'identityVerified': False, 'sourceRef': parsed.source_ref, 'nextAction': '执行 database-dbx-handoff 的身份查询，并核对身份后继续查询'}
        elif command == "database-target-configure":
            payload = json.load(sys.stdin)
            if not isinstance(payload, dict):
                raise readonly.DatabaseReadonlyError("CONFIG_INVALID", "数据库配置输入必须是 JSON 对象")
            if target_id and payload.get("targetId") not in (None, "", target_id):
                raise readonly.DatabaseReadonlyError("CONFIG_INVALID", "--target-id 与 JSON targetId 不一致")
            if target_id:
                payload["targetId"] = target_id
            if parsed.environment and not payload.get("environment"):
                payload["environment"] = parsed.environment
            result = configure(path, resolved, payload)
        else:
            if command == 'database-target-list' and not path.exists():
                emit({'ok':True,'workspaceKey':resolved['workspaceKey'],'targets':[], 'configured':False,
                      'selectionSource':'unconfigured','nextAction':'配置此工作区的数据库排查目标'},parsed)
                return 0
            database_config = profile_config or artifacts.load_yaml(path)
            if command == 'database-compare':
                result = operations.compare_counts(database_config, resolved['workspaceKey'], tables=[value.strip() for value in parsed.tables.split(',') if value.strip()], target_ids=[value.strip() for value in parsed.target_ids.split(',') if value.strip()], capture=json.loads(Path(parsed.capture).expanduser().read_text(encoding='utf-8')) if getattr(parsed,'capture','') else None)
            elif command == "database-target-list":
                artifacts.validate_config(database_config)
                result = {"ok":True,"workspaceKey":resolved['workspaceKey'],'targets':[],'configured':False,
                          'selectionSource':'unconfigured'} if resolved['workspaceKey'] not in database_config['databaseTests'] else {
                    "ok": True, "workspaceKey": resolved["workspaceKey"], 'configured':True, **readonly.list_targets(
                    database_config, resolved["workspaceKey"], environment=parsed.environment, target_id=target_id)}
            elif command == "database-target-remove":
                if not target_id:
                    raise readonly.DatabaseReadonlyError("CONFIG_INVALID", "删除目标必须传 --target-id")
                with file_lock(path.parent / ".configuration.lock"):
                    database_config = artifacts.load_yaml(path)
                    updated, credentials = readonly.build_remove_target_config(database_config, resolved["workspaceKey"], target_id)
                    result = {"ok": True, "workspaceKey": resolved["workspaceKey"], "targetId": target_id, "checkOnly": parsed.check}
                    if not parsed.check:
                        if parsed.confirmation != target_id:
                            raise readonly.DatabaseReadonlyError("CONFIRMATION_REQUIRED", "删除目标需要 --confirmation 与 target-id 完全相同")
                        save_config(path, updated)
                        stage = "credential-cleanup"
                        try:
                            for ref in credentials:
                                readonly.delete_password(ref)
                        except readonly.DatabaseReadonlyError as error:
                            raise readonly.DatabaseReadonlyError("CONFIG_SAVED_CREDENTIAL_CLEANUP_FAILED", "目标配置已删除，但凭据清理失败；请检查系统凭据库", detail=error.code) from error
            else:
                target, selection = artifacts.resolve_diagnosis_target(
                    database_config, resolved["workspaceKey"], environment=parsed.environment, target_id=target_id, profile=profile)
                target_id = target["id"]
                history_target = target
                identity = database_config["expectedIdentities"][target["expectedIdentityRef"]]
                result = {"ok": True, "workspaceKey": resolved["workspaceKey"], "workspaceRoot": str(resolved["root"]),
                          "selectionSource": selection, "connector": "builtin-readonly" if target.get("connectionRef") else "dbx",
                          "targetDigest": artifacts.digest(target), "target": target, "expectedIdentity": identity}
                if command == 'database-dbx-handoff':
                    sql, max_rows = _sql_payload(parsed, required=False)
                    result['handoff'] = dbx.handoff(database_config, resolved['workspaceKey'], target, sql=sql, table=parsed.table or '', max_rows=max_rows)
                elif command == "database-target-resolve":
                    if not target.get("connectionRef"):
                        result["builtinAvailable"] = False
                        result["nextAction"] = "此目标仅绑定 DBX；内置命令需要通过 configure 添加 connectionRef，或使用已连接的 DBX。"
                else:
                    stage = "connect"
                    connection = readonly.connection_for_target(database_config, target)
                    if command in {"database-probe", "database-connect-test"}:
                        output = readonly.probe(connection, target)
                        operations.invalidate_describe_cache(resolved['root'], target['id'])
                    elif command == "database-describe":
                        output = operations.describe_cached(resolved['root'], database_config, connection, target, parsed.table, refresh=getattr(parsed, 'refresh', False), ttl=getattr(parsed, 'cache_ttl', operations.CACHE_TTL_SECONDS))
                    else:
                        stage = "query"
                        if command == 'diagnosis-template':
                            if parsed.template_dir:
                                template = operations.load_template(Path(parsed.template_dir).expanduser(), parsed.name)
                            else:
                                if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', parsed.name):
                                    raise readonly.DatabaseReadonlyError('CONFIG_INVALID', '模板名称无效')
                                from guthon_tool import bundled_bytes
                                template = json.loads(bundled_bytes('config/example/diagnosis-templates/' + parsed.name + '.json').decode('utf-8'))
                            sql = operations.compile_template(template, json.loads(parsed.parameters))
                            max_rows = getattr(parsed, 'max_rows', None) or readonly.MAX_ROWS
                        else:
                            sql, max_rows = _sql_payload(parsed, required=command == "database-query-readonly")
                        history_sql = sql
                        explain = bool(getattr(parsed, 'explain', False))
                        output = readonly.diagnose(connection, target, table=parsed.table or "", sql=sql, max_rows=max_rows, explain=explain) if command == "database-diagnose" else readonly.query(connection, target, sql, max_rows, explain=explain)
                    if command == 'database-diagnose':
                        operations.invalidate_describe_cache(resolved['root'], target['id'])
                    result["result"] = output
                    try:
                        result['history'] = operations.record_history(resolved['root'], workspace_key=resolved['workspaceKey'], target=target, command=command, result=output, sql=history_sql)
                    except Exception as history_error:
                        result['historyWarning'] = getattr(history_error, 'code', 'HISTORY_WRITE_FAILED')
        emit(result, parsed)
        return 0
    except (Exception, SystemExit) as error:
        detail = getattr(error, "detail", "")
        code = error_code(error, "CONFIG_INVALID")
        if history_target is not None and command not in {'database-target-resolve', 'database-dbx-handoff'}:
            try:
                operations.record_history(resolved['root'], workspace_key=resolved['workspaceKey'], target=history_target, command=command, sql=history_sql, error_code=code, stage=getattr(error, 'stage', stage))
            except Exception:
                # The original operation error remains the actionable failure.
                pass
        context = f"workspace={resolved['workspaceKey']}, target={target_id}, stage={getattr(error, 'stage', stage)}"
        raise CommandError(code, f"{code}: {error}（{context}）" + (f"（{detail}）" if detail else "")) from error

"""Common workspace identities, provider paths, binding and diagnostic contracts."""

from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from common.runtime_paths import RuntimePath

CONFIG_DIR = RuntimePath("config")
VAR_DIR = RuntimePath("var")
from common.persistence import atomic_text
from common.workspace_identity import validate_config_id, validate_workspace_key
from common.workspace_sources import SOURCE_MODES, legacy_mode, resolve_sources


def resolve_workspace_storage_root(item):
    from common.workspace_layout import registered_project_directory

    if item.get('root'):
        root = Path(item['root']).expanduser()
        if not root.is_absolute() or root.resolve() in {Path('/'), Path.home().resolve(), Path(VAR_DIR).resolve()}:
            raise ValueError('工作区 root 必须为明确的独立绝对路径')
        return root.resolve()
    return registered_project_directory(Path(VAR_DIR), item.get("directory", item.get("name")))


def _entries(config):
    metadata = config.get('_configuration', {})
    if metadata.get('format') != 'legacy-yaml':
        entries = config.get('workspaces')
        if not isinstance(entries, dict) or 'products' in config or 'projects' in config:
            raise ValueError('Missing unified workspaces registry')
        for key, item in entries.items():
            yield key, item, None
        return
    for kind, prefix, layer in (('products', 'PRD', 'PRODUCT'), ('projects', 'PRJ', 'PROJECT')):
        for identifier, item in config[kind][kind].items():
            yield f'{kind}.{identifier}', item, (kind, prefix, layer, identifier)


def _workspace(config, key, item, legacy):
    from common import gusen_hub as hub
    from common.workspace_layout import rules_directory
    key = validate_workspace_key(key)
    metadata = config.get('_configuration', {})
    # Upgraded records retain the old provider options and layout as-is. Their
    # authoritative mode comes from the unified registration.
    mode_override = None
    layout = legacy
    if isinstance(item, dict) and 'legacyConfig' in item and legacy is None:
        if metadata.get('schemaVersion') != 3 or set(item) != {'sourceMode', 'identity', 'legacyConfig'}:
            raise ValueError('Invalid upgraded workspace registration')
        identity = item['identity']
        modes = {'products': ('PRD', 'PRODUCT'), 'projects': ('PRJ', 'PROJECT')}
        kind = identity['kind']
        prefix, layer = modes[kind]
        identifier = validate_config_id(identity['id'])
        if key != f'{kind}.{identifier}' or identity.get('layer') != layer:
            raise ValueError('Upgraded workspace identity does not match its key')
        mode_override = item['sourceMode']
        if mode_override not in {'svn', 'database'}:
            raise ValueError('Old layout requires an SVN or DATABASE provider')
        layout = (kind, prefix, layer, identifier)
        item = item['legacyConfig']
    if not isinstance(item, dict) or not isinstance(item.get('name'), str) or not item['name'].strip():
        raise ValueError('Missing workspace name')
    home = Path(CONFIG_DIR).parent.resolve()
    space = Path(VAR_DIR)
    aliases = item.get('aliases', [])
    if not isinstance(aliases, list) or any(not isinstance(x, str) or not x.strip() for x in aliases):
        raise ValueError('aliases must contain names')
    if layout:
        kind, prefix, layer, identifier = layout
        identifier = validate_config_id(identifier)
        from common.svn_workspace_config import expand_config_value
        parent = expand_config_value(item['workspace_root'], 'workspace_root') if item.get('workspace_root') else space / 'workspace'
        parent = Path(parent).expanduser().absolute()
        if parent.resolve() in {Path('/'), Path.home().resolve()}:
            raise ValueError('Unsafe workspace_root')
        root = (parent / hub.path_part(prefix + ' ' + item['name'].strip())).resolve()
        if mode_override is None:
            mode, mode_source = legacy_mode(root, key, item)
        else:
            mode, mode_source = mode_override, 'unified-config'
        display = prefix + ' ' + item['name'].strip()
    else:
        allowed = {'name', 'directory', 'aliases', 'datasource', 'systems', 'page_origins'}
        if metadata.get('schemaVersion', 2) == 3:
            allowed |= {'sourceMode', 'root', 'paths', 'svn', 'identity', 'include', 'exclude', 'extra_where'}
        if set(item) - allowed:
            raise ValueError('工作区包含未知的配置字段')
        root = resolve_workspace_storage_root(item)
        if not item.get('root') and (root / '.git').exists():
            raise ValueError('新布局项目不能嵌套独立 Git 仓库')
        mode = item.get('sourceMode') if metadata.get('schemaVersion') == 3 else 'api'
        if mode not in SOURCE_MODES:
            raise ValueError('sourceMode 必须明确为 api、svn 或 database')
        mode_source = 'unified-config' if metadata.get('schemaVersion') == 3 else 'api-only'
        display = item['name'].strip()
        identity = item.get('identity', {})
        if not isinstance(identity, dict):raise ValueError('identity 必须为对象')
        if 'displayName' in identity:
            if not isinstance(identity['displayName'], str) or not identity['displayName'].strip():
                raise ValueError('identity.displayName 必须为非空名称')
            display = identity['displayName'].strip()
        identifier = identity.get('id', key)
        kind, layer = identity.get('kind', ''), identity.get('layer', '')
    paths = item.get('paths', {}) if not layout else {}
    permitted = {'contextDir', 'runtimeDir', 'docsDir', 'checkoutPath'}
    if not isinstance(paths, dict) or set(paths) - permitted:
        raise ValueError('paths 包含未知路径')
    if any(not isinstance(value, str) or not Path(value).expanduser().is_absolute() for value in paths.values()):
        raise ValueError('paths 必须使用明确的绝对路径')
    context = Path(paths.get('contextDir', root / 'context')).expanduser().resolve()
    runtime = Path(paths.get('runtimeDir', root / 'runtime')).expanduser().resolve()
    docs = Path(paths.get('docsDir', root / 'docs')).expanduser().resolve()
    source = resolve_sources(home, root, key, identifier, item, mode, config,
                             project_checkout=not layout and not item.get('root'))
    if mode == 'api' and paths.get('checkoutPath'):
        source['providerSourceRoot'] = source['checkoutPath'] = Path(paths['checkoutPath']).expanduser().resolve()
        source['sourceRoots'][0]['path'] = source['providerSourceRoot']
    if len(set((context, runtime, docs))) != 3:
        raise ValueError('context/runtime/docs 必须互不重叠')
    for index, left in enumerate([context, runtime, docs]):
        for right in [context, runtime, docs][index+1:] + [x['path'] for x in source['sourceRoots']]:
            if left == right or left in right.parents or right in left.parents:
                raise ValueError('源码与 context/runtime/docs 路径重叠')
    mode_path = context / 'source-mode.json'
    if not legacy and mode_path.is_file():
        projection = json.loads(mode_path.read_text(encoding='utf-8'))
        if (not isinstance(projection, dict) or projection.get('sourceMode') != mode
                or projection.get('workspaceKey', key) != key):
            raise ValueError('源码模式描述与权威配置冲突，不能接管旧模式')
    datasource_name = item.get('datasource', '')
    datasource = config.get('datasource', {}).get('datasource', {}).get(datasource_name, {})
    if datasource_name and not datasource:
        raise ValueError('Unknown datasource: ' + str(datasource_name))
    mappings = ((item.get('systems') or {}).get('include') or {}).get('mappings') or {}
    if not isinstance(mappings, dict):raise ValueError('systems.include.mappings 必须为对象')
    capabilities = dict(source['providerCapabilities'])
    if mode == 'svn':
        capabilities['source.read'] = capabilities.get('svn.browse', False)
    if mode == 'database':
        capabilities['source.read'] = True
    capabilities['database.diagnose'] = True
    result = {'workspaceKey': key, 'id': identifier, 'name': item['name'].strip(), 'displayName': display,
              'aliases': list(dict.fromkeys(x.strip() for x in aliases)), 'kind': kind, 'layer': layer,
              'scopeId': identifier, 'type': 'project' if layer == 'PROJECT' else 'product' if layer == 'PRODUCT' else '',
              'systemAliases': list(mappings), 'projectId': identifier if layer == 'PROJECT' else '',
              'sourceMode': mode, 'sourceModeSource': mode_source, 'sourceModePath': mode_path,
              'root': root, 'spaceRoot': space, 'rulesDir': rules_directory(space), 'sharedDocsDir': space / 'docs',
              'contextDir': context, 'runtimeDir': runtime, 'docsDir': docs,
              'logsDir': context / 'logs' if layout else runtime / 'logs',
              'indexPath': context / 'index.db', 'statePath': context / 'state.json',
              'config': item, 'configDir': Path(CONFIG_DIR), 'configuration': metadata,
              'datasourceName': datasource_name, 'datasource': datasource,
              'systemMappings': mappings, 'pageOrigins': item.get('page_origins') or [],
              'capabilities': capabilities, 'executionReady': True, **source}
    if mode == 'svn' and result['svn']['checkoutLayout'] == 'legacy-sparse':
        result['workcopyDir'] = root / 'source/workcopy'
        result['readonlyDir'] = root / 'source/readonly'
    if mode == 'database' and not layer:
        result['layer'] = 'PRODUCT'
    if result.get('svn') and result['svn']['scopeConfigPath'] is None:
        result['svn']['scopeConfigPath'] = Path(CONFIG_DIR) / (legacy[0] + '.yaml' if legacy else 'guthon.json')
    result['workspaceBinding'] = workspace_binding(config, result)
    return result


def list_workspaces(config, *, errors=None, strict=False):
    result = []
    diagnostics = errors if errors is not None else []
    for identifier, item, legacy in _entries(config):
        try:
            result.append(_workspace(config, identifier, item, legacy))
        except (SystemExit, ValueError, TypeError, KeyError, AttributeError, OSError) as error:
            record = item.get('legacyConfig', item) if isinstance(item, dict) else None
            name = record.get('name') if isinstance(record, dict) else None
            diagnostic = {"workspaceKey": str(identifier), "code": "CONFIG_INVALID", "message": str(error)}
            if isinstance(name, str) and name.strip():
                diagnostic['name'] = name.strip()
            diagnostics.append(diagnostic)
    invalid = set()
    for index, left in enumerate(result):
        for right in result[index+1:]:
            a = [left['root'], left['contextDir'], left['runtimeDir'], left['docsDir'], *[x['path'] for x in left['sourceRoots']]]
            b = [right['root'], right['contextDir'], right['runtimeDir'], right['docsDir'], *[x['path'] for x in right['sourceRoots']]]
            overlap = any(str(x).casefold() == str(y).casefold() or x in y.parents or y in x.parents for x in a for y in b)
            duplicate_id = config.get('_configuration', {}).get('format') == 'legacy-yaml' and left['id'] == right['id']
            if overlap or duplicate_id:
                for item in (left, right):
                    if item['workspaceKey'] not in invalid:
                        diagnostics.append({'workspaceKey': item['workspaceKey'], 'name': item['name'], 'code': 'CONFIG_AMBIGUOUS',
                                            'message': 'Workspace identities or storage paths overlap'})
                        invalid.add(item['workspaceKey'])
    if strict and diagnostics:
        raise SystemExit('; '.join(x['workspaceKey'] + ': ' + x['message'] for x in diagnostics))
    return [item for item in result if item['workspaceKey'] not in invalid]


def resolve_workspace(config, value=None):
    from common import gusen_hub as hub

    key = value or hub._CURRENT_WORKSPACE.get() or os.environ.get(hub.WORKSPACE_ENV, "")
    validate_workspace_key(key)
    errors = []
    matches = [
        x for x in list_workspaces(config, errors=errors) if x["workspaceKey"] == key
    ]
    if len(matches) != 1:
        problem = next((x for x in errors if x["workspaceKey"] == key), None)
        raise SystemExit(
            problem["message"] if problem else "Unknown explicit workspace: " + key
        )
    return matches[0]


def resolve_workspace_for_path(config, path):
    target = Path(path).expanduser().resolve()
    matches = []
    for item in list_workspaces(config):
        if any(
            target == base or base in target.parents
            for base in (item["root"], *[x['path'] for x in item['sourceRoots']])
        ):
            matches.append(item)
    if len(matches) != 1:
        raise SystemExit("请选择唯一 workspaceKey 或项目目录")
    return matches[0]


def workspace_binding(config, workspace):
    """Fingerprint write identity, not labels, passwords, or unrelated projects."""
    item = workspace['config']
    datasource = workspace['datasource']
    value = {'key': workspace['workspaceKey'], 'mode': workspace['sourceMode'],
             'root': str(workspace['root']), 'context': str(workspace['contextDir']),
             'sources': [str(x['path']) for x in workspace['sourceRoots']],
             'scope': {name: item.get(name) for name in ('systems', 'include', 'exclude', 'extra_where', 'svn', 'identity')},
             'api': config.get('apiWorkspaces', {}).get(workspace['workspaceKey']),
             'datasource': {name: datasource.get(name) for name in ('type', 'host', 'port', 'database', 'schema', 'username')},
             'tables': config.get('source_tables', {}) if workspace['sourceMode'] == 'database' else {}}
    if workspace.get('svn'):
        value['svnIdentity'] = {name: str(workspace['svn'].get(name, '')) for name in ('repositoryUrl', 'scopeRootUrl', 'scopeManifestPath', 'scopeDigest')}
    digest = hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return {'schemaVersion': 1, 'workspaceKey': workspace['workspaceKey'], 'sourceMode': workspace['sourceMode'], 'digest': digest}


def require_workspace_binding(workspace, expected):
    from common import gusen_hub as hub
    if not isinstance(expected, dict) or expected.get('schemaVersion') != 1:
        raise ValueError('WORKSPACE_BINDING_INVALID')
    current = resolve_workspace(hub.load_config(), workspace['workspaceKey'])
    if current['workspaceBinding'] != expected:
        raise ValueError('WORKSPACE_BINDING_STALE: 项目来源或配置绑定已变化，请重新接入')
    return current


def workspace_index_state(workspace):
    if workspace['sourceMode'] != 'api':
        from common.legacy_workspace_state import workspace_index_state as legacy_index_state
        return legacy_index_state(workspace)
    from providers.api.index import health

    path = workspace["indexPath"]
    state = health(workspace)
    return {
        "path": str(path),
        **state,
        "sizeBytes": path.stat().st_size if path.is_file() else 0,
        "requiredAction": ""
        if state.get("ready") and state.get("complete")
        else "api-index",
    }


def workspace_config_digest(config, workspace):
    return hashlib.sha256(
        json.dumps(
            {"key": workspace["workspaceKey"], "config": workspace["config"]},
            sort_keys=True,
            ensure_ascii=False,
        ).encode()
    ).hexdigest()


def load_workspace_state(config, workspace):
    try:
        value = json.loads(workspace["statePath"].read_text(encoding="utf-8"))
        if not isinstance(value, dict) or not isinstance(value.get('steps', {}), dict):
            raise ValueError('工作区同步状态必须为对象：' + str(workspace['statePath']))
        return value
    except FileNotFoundError:
        return {
            "status": "UNINITIALIZED",
            "steps": {},
            "lastFullSyncAt": None,
            "lastFailure": None,
        }


def update_workspace_state(
    config, workspace, step=None, status=None, error="", full_sync=False
):
    from common import gusen_hub as hub

    value = load_workspace_state(config, workspace)
    if step:
        value.setdefault("steps", {})[step] = {
            "status": status,
            "updatedAt": hub._now(),
        }
    value["status"] = status or value.get("status", "UNINITIALIZED")
    if error:
        value["lastFailure"] = {"step": step, "message": str(error), "at": hub._now()}
    elif status == "SUCCESS":
        value["lastFailure"] = None
    if full_sync and status == "SUCCESS":
        value["lastFullSyncAt"] = hub._now()
    atomic_text(
        workspace["statePath"], json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    )
    return value


def workspace_agent_context(config, workspace):
    result = {
        "ok": True,
        "workspaceKey": workspace["workspaceKey"],
        "root": str(workspace["root"]),
        "checkoutPath": str(workspace["checkoutPath"]) if workspace['checkoutPath'] else '',
        "agentsPath": str(workspace["spaceRoot"] / "AGENTS.md"),
        "rulesDir": str(workspace["rulesDir"]),
        "sharedDocsDir": str(workspace["sharedDocsDir"]),
        "sourceMode": workspace['sourceMode'],
        "sourceModeSource": workspace['sourceModeSource'],
        "configuration": workspace['configuration'],
        "workspaceBinding": workspace['workspaceBinding'],
        "capabilities": workspace['capabilities'],
        "executionReady": workspace['executionReady'],
        "sourceRoots": [{**x, 'path': str(x['path'])} for x in workspace['sourceRoots']],
        "index": workspace_index_state(workspace),
        "indexFirst": {
            "available": workspace['sourceMode'] == 'api',
            "command": "api",
            "unknownObject": "search",
            "knownLocalFact": "context",
            "callersOfSharedFunction": "callers",
            "examples": [
                {
                    "intent": "unknownObject",
                    "argv": [
                        "api",
                        "--home",
                        str(CONFIG_DIR.parent),
                        "--workspace",
                        workspace["workspaceKey"],
                        "--",
                        "search",
                        "--stdin",
                    ],
                }
            ],
        },
    }
    if workspace['sourceMode'] != 'api':
        command = 'svn' if workspace['sourceMode'] == 'svn' else 'query'
        args = ['find', '--keyword', '<关键词>'] if command == 'svn' else ['find', '<关键词>']
        result['indexFirst'] = {
            'available': bool(workspace['capabilities'].get('source.read')),
            'command': command, 'unknownObject': 'find',
            'examples': [{'intent': 'unknownObject', 'argv': [
                command, '--home', str(CONFIG_DIR.parent), '--workspace', workspace['workspaceKey'], '--', *args]}],
        }
    return result


def workspace_summary(config, workspace):
    checkout = None
    if workspace['sourceMode'] == 'api':
        state = load_workspace_state(config, workspace)
    else:
        from common.legacy_workspace_state import load_workspace_state as legacy_state
        state = legacy_state(config, workspace)
    index = workspace_index_state(workspace)
    result = {
        k: workspace[k]
        for k in (
            "workspaceKey",
            "id",
            "name",
            "displayName",
            "aliases",
            "sourceMode",
            "capabilities",
            "sourceModeSource",
        )
    }
    result.update(
        root=str(workspace["root"]),
        checkoutPath=str(workspace["checkoutPath"]) if workspace['checkoutPath'] else '',
        providerSourceRoot=str(workspace["providerSourceRoot"]),
        contextDir=str(workspace["contextDir"]),
        docsDir=str(workspace["docsDir"]),
        runtimeDir=str(workspace["runtimeDir"]),
        spaceRoot=str(workspace["spaceRoot"]),
        rulesDir=str(workspace["rulesDir"]),
        sharedDocsDir=str(workspace["sharedDocsDir"]),
        datasourceName=workspace["datasourceName"],
        datasourceReady=bool(workspace['datasource']),
        index=index,
        status=state.get("status", "UNINITIALIZED"),
        lastFullSyncAt=state.get("lastFullSyncAt"),
        lastFailure=state.get("lastFailure"),
        steps=state.get("steps", {}),
        configuration=workspace['configuration'],
        workspaceBinding=workspace['workspaceBinding'],
        executionReady=workspace['executionReady'],
        providerCapabilities=workspace['providerCapabilities'],
        sourceRoots=[{**x, 'path': str(x['path'])} for x in workspace['sourceRoots']],
    )
    if workspace['sourceMode'] == 'svn':
        from providers.svn.nexus import workspace as svn_workspace
        settings = workspace['svn']
        result['checkoutLayout'] = settings['checkoutLayout']
        result['scopeConfigReady'] = bool(settings.get('repositoryUrl') or settings.get('scopeRootUrl') or settings.get('scopeEntries') is not None
                                           or settings.get('scopeConfigExplicit') and settings['scopeConfigPath'].is_file())
        result['scopeManifestReady'] = bool(settings.get('scopeManifestPath') and settings['scopeManifestPath'].is_file())
        if settings['checkoutLayout'] == 'manifest-working-copies':
            checkout = svn_workspace.load_state(workspace, required=False)
            result['workingCopies'] = [{k: item.get(k) for k in ('id','root','localSubdir','category','revision','clean')}
                                       for item in checkout.get('workingCopies', [])]
            result['skippedWorkingCopies'] = checkout.get('skipped', [])
            from common.legacy_workspace_state import _svn_source_control_groups
            result['sourceControlGroups'] = _svn_source_control_groups(workspace, result['workingCopies'])
    elif workspace['sourceMode'] == 'database':
        result['workcopyDir'] = str(workspace['workcopyDir'])
        result['readonlyDir'] = str(workspace['readonlyDir'])
        result['databaseScopeReady'] = bool(workspace['systemMappings'] or workspace['kind'])
    if workspace['sourceMode'] in {'svn', 'database'}:
        from common.legacy_workspace_state import source_summary

        result['sourceSummary'] = source_summary(workspace, index, state, checkout)
        if workspace['configuration'].get('schemaVersion') == 3:
            from common.workspace_source_settings import source_connection_summary

            result['sourceConnection'] = source_connection_summary(
                workspace, svn_scope_ready=result.get('scopeManifestReady', False))
    result["cockpit"] = {
        "health": "READY"
        if index["ready"] and index.get("complete")
        else "ACTION_REQUIRED",
        "indexReady": index["ready"],
        "issueCount": index.get("partialSourceCount", 0) if index["ready"] else 1,
        "messages": (
            ["当前项目索引存在未解析对象"] if index.get("partialSourceCount") else []
        )
        if index["ready"]
        else ["当前项目索引待建立或范围已变化"],
    }
    return result


def workspace_matches_request(workspace, request, config=None):
    requested = request.get('workspaceKey')
    if requested and requested != workspace['workspaceKey']:
        return False
    if workspace['sourceMode'] != 'api':
        from common import legacy_source
        has_identity = any(request.get(field) for field in ('pageOrigin','origin','systemId','systemIds','dataSourceId','dataSourceIds','systemAlias'))
        if not has_identity:
            return bool(requested)
        if not requested and not request.get('pageOrigin') and not request.get('origin'):
            return False
        if config is None:
            from common import gusen_hub
            config = gusen_hub.load_config()
        return legacy_source.workspace_matches_request(config, workspace, {**request, 'pageOrigin': request.get('pageOrigin') or request.get('origin')})
    from providers.api.workspace import settings, active_scope

    origin = request.get("pageOrigin") or request.get("origin")
    config = settings(workspace)
    if origin:
        if not isinstance(origin, str):
            return False
        parsed = urlsplit(config.get("serverUrl") or "")
        if origin.rstrip("/") != (parsed.scheme + "://" + parsed.netloc).rstrip("/"):
            return False
    if not requested and not origin:
        return False
    scope = active_scope(workspace)
    system = request.get("systemId")
    data_source = request.get("dataSourceId")
    if system and str(system) not in scope["systemIds"]:
        return False
    if data_source and str(data_source) not in scope["dataSourceIds"]:
        return False
    return True


def route_workspace_request(config, request):
    if not isinstance(request, dict):
        raise SystemExit("route requires a JSON object")
    matches = [x for x in list_workspaces(config) if workspace_matches_request(x, request, config)]
    if len(matches) != 1:
        return {
            "ok": False,
            "code": "WORKSPACE_AMBIGUOUS" if matches else "WORKSPACE_NOT_FOUND",
            "candidates": [workspace_summary(config, x) for x in matches],
        }
    selected = matches[0]
    return {
        "ok": True,
        "workspaceKey": selected["workspaceKey"],
        "workspace": workspace_summary(config, selected),
        **workspace_summary(config, selected),
    }

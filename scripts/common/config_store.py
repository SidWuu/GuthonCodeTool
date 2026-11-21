"""Versioned unified configuration and read-only legacy configuration adaptation."""
from __future__ import annotations

import copy
import json
from pathlib import Path

from common.persistence import atomic_text, file_lock

NAME='guthon.json'
LEGACY=('products.yaml','projects.yaml','sync.yaml','datasource.yaml','source-tables.yaml','database-testing.yaml')
SECTIONS=('workspaces','sync','datasource','databaseTesting','apiWorkspaces')
SCHEMA_VERSION = 3
UPGRADE_MARKER = '.configuration-upgrade.json'
LEGACY_SECTIONS = {'products':'products.yaml', 'projects':'projects.yaml',
                   'sync':'sync.yaml', 'datasource':'datasource.yaml',
                   'source_tables':'source-tables.yaml'}


def path(home):return Path(home)/'config'/NAME


def unified(home):return path(home).exists()


def require_stable_configuration(home):
    marker = path(home).with_name(UPGRADE_MARKER)
    if marker.exists() or marker.is_symlink():
        raise ValueError('CONFIG_UPGRADE_PENDING: 请先执行 configuration-upgrade status 并核对恢复')


def is_default_database_path(value):
    from common.runtime_paths import tool_home
    try:home=tool_home()
    except SystemExit:return False
    if Path(value).resolve() not in {(home/'config/database-testing.yaml').resolve(),path(home).resolve()}:
        return False
    require_stable_configuration(home)
    return unified(home)


def _unique(pairs):
    value={}
    for key,item in pairs:
        if key in value:raise ValueError('统一配置包含重复字段')
        value[key]=item
    return value


def _validate(value):
    if not isinstance(value,dict) or type(value.get('schemaVersion')) is not int or value['schemaVersion'] not in (2,SCHEMA_VERSION):
        raise ValueError('不支持的统一配置版本；需要 schemaVersion 2 或 3，不会回退到旧配置或自动转换')
    if any(not isinstance(value.get(name),dict) for name in SECTIONS):
        raise ValueError('统一配置缺少必要的对象 section')
    if value['schemaVersion']==SCHEMA_VERSION and not isinstance(value.get('sourceTables'),dict):
        raise ValueError('schemaVersion 3 缺少 sourceTables 源码字段映射对象')
    if 'workspaceDirectory' in value:
        from common.workspace_layout import workspace_directory_name
        if value['schemaVersion'] != SCHEMA_VERSION:
            raise ValueError('当前配置版本不支持自定义开发目录')
        workspace_directory_name(value['workspaceDirectory'])
    if 'products' in value or 'projects' in value:
        raise ValueError('统一配置只接受 workspaces 注册表，不再区分产品和项目')
    if not isinstance(value['datasource'].get('datasource'),dict):raise ValueError('datasource 必须包含 datasource 对象')
    return value


def read(home):
    require_stable_configuration(home)
    if _legacy_files(home):
        raise ValueError('CONFIG_AUTHORITY_CONFLICT: 统一配置与旧配置同时存在；请核对配置来源，不会混读或自动迁移')
    try:value=json.loads(path(home).read_text(encoding='utf-8'),object_pairs_hook=_unique)
    except (ValueError,OSError) as error:raise ValueError('统一配置无法读取或不是有效 JSON') from error
    return _validate(value)


def write(home,value):
    require_stable_configuration(home)
    _validate(value)
    if _legacy_files(home):
        raise ValueError('CONFIG_AUTHORITY_CONFLICT: 不向旧配置空间写入统一配置；显式配置升级属于独立流程')
    atomic_text(path(home),json.dumps(value,ensure_ascii=False,indent=2)+'\n')


def mutate(home,change):
    with file_lock(Path(home)/'config'/'.configuration.lock'):
        value=read(home);result=change(value);write(home,value);return result


def _yaml(text):
    if text.lstrip().startswith(('{','[')):return json.loads(text,object_pairs_hook=_unique)
    try:
        import yaml
    except ImportError:
        from common.workspace_config import _canonical_yaml
        return _canonical_yaml(text)
    return yaml.safe_load(text) or {}


def initialize(home, sync_text=None, *, workspace_name=None, team_source=None):
    """Initialize an empty home; existing legacy homes are not migrated."""
    from common.workspace_layout import initialize_space, workspace_directory
    home=Path(home);directory=home/'config'
    if workspace_name is not None:
        workspace_directory(home, workspace_name)

    def existing_legacy():
        _read_legacy(home)
        if workspace_name not in (None, 'var'):
            raise ValueError('旧配置使用 var 开发目录，自定义名称仅适用于新建数据目录')
        if team_source:
            raise ValueError('旧配置的工作区请使用 guthon-team 独立安装器同步规范')
        return []

    require_stable_configuration(home)
    # Existing/unsupported input is validated before creating a maintenance lock.
    if unified(home):
        read(home)
    elif _legacy_files(home):
        return existing_legacy()
    with file_lock(directory/'.configuration.lock'):
        require_stable_configuration(home)
        if unified(home):
            registered = read(home).get('workspaceDirectory', 'var')
            if workspace_name is not None and workspace_name != registered:
                raise ValueError(f'当前数据目录已绑定开发目录 {registered}，请打开已绑定的目录')
            initialize_space(home, existing=True, directory=registered, team_source=team_source)
            return []
        if _legacy_files(home):
            return existing_legacy()
        if sync_text is None:
            from guthon_tool import bundled_bytes
            sync_text=bundled_bytes('config/example/sync.example.yaml').decode('utf-8')
        value={'schemaVersion':SCHEMA_VERSION,'workspaces':{},'sync':_yaml(sync_text),
               'datasource':{'datasource':{}},'databaseTesting':{'schemaVersion':1,'connections':{},'expectedIdentities':{},'databaseTests':{}},'apiWorkspaces':{}}
        value['sourceTables'] = {}
        if workspace_name not in (None, 'var'):
            value['workspaceDirectory'] = workspace_name
        initialize_space(home, directory=workspace_name or 'var', team_source=team_source)
        write(home,value);return [path(home)]


def resolve_document(home, value, *, legacy=False):
    """Build the runtime view from an already parsed configuration snapshot."""
    from common.gusen_hub import _expand_env
    def expand(value):
        if isinstance(value,str):return _expand_env(value)
        if isinstance(value,list):return [expand(item) for item in value]
        if isinstance(value,dict):return {key:expand(item) for key,item in value.items()}
        return value
    if not legacy:
        _validate(value)
        result={name:expand(copy.deepcopy(value[name])) for name in SECTIONS}
        result['source_tables']={'source_tables':expand(copy.deepcopy(value.get('sourceTables',{})))}
        result['_configuration']={'format':'unified','schemaVersion':value['schemaVersion'],'path':str(path(home).resolve())}
        return result
    result=expand(copy.deepcopy(value))
    result['_configuration']={'format':'legacy-yaml','schemaVersion':0,'path':str((Path(home)/'config').resolve())}
    return result


def runtime_config(home):
    require_stable_configuration(home)
    if unified(home):
        return resolve_document(home, read(home))
    return resolve_document(home, _read_legacy(home), legacy=True)


def _read_legacy(home, files=None):
    directory=Path(home)/'config'
    missing=[name for name in LEGACY_SECTIONS.values()
             if (name not in files if files is not None else not (directory/name).is_file())]
    if missing:
        raise ValueError('旧配置缺少文件：'+', '.join(missing))
    result={}
    for section,name in LEGACY_SECTIONS.items():
        source = files[name].decode('utf-8') if files is not None else (directory/name).read_text(encoding='utf-8')
        value=_yaml(source)
        if not isinstance(value,dict):raise ValueError('旧配置必须为对象：'+name)
        if section in ('products','projects','datasource','source_tables') and not isinstance(value.get(section),dict):
            raise ValueError('旧配置缺少对象 '+section+'：'+name)
        result[section]=value
    return result


def database_testing(home):
    require_stable_configuration(home)
    if unified(home):return copy.deepcopy(read(home)['databaseTesting'])
    return _yaml((Path(home)/'config/database-testing.yaml').read_text(encoding='utf-8'))


def save_database_testing(home,value):
    if not isinstance(value,dict):raise ValueError('数据库测试配置必须是对象')
    from common.gusen_hub import _expand_env
    def preserve(previous,current):
        if isinstance(previous,str) and isinstance(current,str) and '${' in previous and _expand_env(previous)==current:
            return previous
        if isinstance(previous,dict) and isinstance(current,dict):
            return {key:preserve(previous[key],item) if key in previous else copy.deepcopy(item) for key,item in current.items()}
        if isinstance(previous,list) and isinstance(current,list):
            result=[]
            for position,item in enumerate(current):
                candidate=previous[position] if position<len(previous) else None
                if isinstance(item,dict) and item.get('id'):
                    matches=[old for old in previous if isinstance(old,dict) and old.get('id')==item['id']]
                    candidate=matches[0] if len(matches)==1 else None
                result.append(preserve(candidate,item))
            return result
        return copy.deepcopy(current)
    def change(document):document['databaseTesting']=preserve(document['databaseTesting'],value)
    mutate(home,change)


def api_settings(home,workspace_key):
    value=read(home)['apiWorkspaces'].get(workspace_key)
    return copy.deepcopy(value) if value is not None else None


def save_api_settings(home,workspace_key,value):
    def change(document):document['apiWorkspaces'][workspace_key]=copy.deepcopy(value)
    mutate(home,change)


def _legacy_files(home):
    directory=Path(home)/'config'
    return [directory/name for name in LEGACY if (directory/name).is_file()]


def info(home):
    from common.workspace_layout import workspace_directory
    home=Path(home).expanduser().resolve()
    require_stable_configuration(home)
    existing=_legacy_files(home)
    if unified(home):
        document=read(home)
        return {'ok':True,'mode':'unified','path':str(path(home)),
                'schemaVersion':document['schemaVersion'], 'legacyFiles':[],'initialized':True,
                'workspaceSourceModes':['api', 'svn', 'database'] if document['schemaVersion'] == 3 else ['api'],
                'workspaceRoot':str(workspace_directory(home, document.get('workspaceDirectory', 'var')))}
    if existing:
        _read_legacy(home)
    return {'ok':True,'mode':'legacy' if existing else 'uninitialized','path':str(path(home)),
            'schemaVersion':0,'legacyFiles':[str(p) for p in existing],'initialized':bool(existing),
            'workspaceRoot':str(workspace_directory(home, 'var'))}

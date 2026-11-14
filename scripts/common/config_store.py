"""Single-authority configuration and explicit legacy migration for one toolHome."""
from __future__ import annotations

from contextlib import ExitStack
import copy
import hashlib
import json
from pathlib import Path

from common.persistence import atomic_bytes, atomic_text, file_lock
from common.runtime_paths import runtime_home_context

NAME='guthon.json'
LEGACY=('products.yaml','projects.yaml','sync.yaml','datasource.yaml','database-testing.yaml')
SECTIONS=('products','projects','sync','datasource','databaseTesting','apiWorkspaces')


def path(home):return Path(home)/'config'/NAME


def unified(home):return path(home).exists()


def is_default_database_path(value):
    from common.runtime_paths import tool_home
    try:home=tool_home()
    except SystemExit:return False
    return Path(value).resolve() in {(home/'config/database-testing.yaml').resolve(),path(home).resolve()} and unified(home)


def _unique(pairs):
    value={}
    for key,item in pairs:
        if key in value:raise ValueError('统一配置包含重复字段')
        value[key]=item
    return value


def _validate(value):
    if not isinstance(value,dict) or type(value.get('schemaVersion')) is not int or value['schemaVersion']!=1:
        raise ValueError('统一配置 schemaVersion 必须为 1')
    if any(not isinstance(value.get(name),dict) for name in SECTIONS):
        raise ValueError('统一配置缺少必要的对象 section')
    for name in ('products','projects'):
        if not isinstance(value[name].get(name),dict):raise ValueError(name+' 必须包含同名对象')
    if not isinstance(value['datasource'].get('datasource'),dict):raise ValueError('datasource 必须包含 datasource 对象')
    return value


def read(home):
    try:value=json.loads(path(home).read_text(encoding='utf-8'),object_pairs_hook=_unique)
    except (ValueError,OSError) as error:raise ValueError('统一配置无法读取或不是有效 JSON') from error
    return _validate(value)


def write(home,value):
    _validate(value)
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


def initialize(home, sync_text=None):
    """Initialize an empty home; existing legacy homes are not migrated."""
    home=Path(home);directory=home/'config'
    with file_lock(directory/'.configuration.lock'):
        if unified(home):read(home);return []
        if any((directory/name).exists() for name in LEGACY):return []
        if sync_text is None:
            from guthon_tool import bundled_bytes
            sync_text=bundled_bytes('config/example/sync.example.yaml').decode('utf-8')
        value={'schemaVersion':1,'products':{'products':{}},'projects':{'projects':{}},'sync':_yaml(sync_text),
               'datasource':{'datasource':{}},'databaseTesting':{'schemaVersion':1,'connections':{},'expectedIdentities':{},'databaseTests':{}},'apiWorkspaces':{}}
        write(home,value);return [path(home)]


def runtime_config(home):
    from common.gusen_hub import _expand_env
    def expand(value):
        if isinstance(value,str):return _expand_env(value)
        if isinstance(value,list):return [expand(item) for item in value]
        if isinstance(value,dict):return {key:expand(item) for key,item in value.items()}
        return value
    value=read(home)
    return {name:expand(copy.deepcopy(value[name])) for name in ('products','projects','sync','datasource')}


def database_testing(home):return copy.deepcopy(read(home)['databaseTesting'])


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
    home=Path(home).expanduser().resolve();existing=_legacy_files(home)
    if unified(home):
        read(home)
        return {'ok':True,'mode':'unified','path':str(path(home)),'legacyFiles':[str(p) for p in existing],
                'migrationAvailable':False,'initialized':True}
    initialized=(home/'config/products.yaml').is_file() and (home/'config/projects.yaml').is_file()
    available=initialized
    if initialized:
        try:
            _,_,manifest,_,_=_legacy_plan(home)
            existing=[Path(entry['path']) for entry in manifest]
        except (Exception,SystemExit):
            available=False
    return {'ok':True,'mode':'legacy','path':str(path(home)),'legacyFiles':[str(p) for p in existing],
            'migrationAvailable':available,'initialized':initialized}


def _legacy_plan(home):
    from common import gusen_hub
    from providers.api.workspace import FIELDS
    home=Path(home).expanduser().resolve();directory=home/'config'
    if unified(home):raise ValueError('当前已经使用统一配置')
    if not (directory/'products.yaml').is_file() or not (directory/'projects.yaml').is_file():
        raise ValueError('旧配置缺少产品或项目注册文件')
    files=_legacy_files(home)
    if any(file.is_symlink() for file in files):raise ValueError('不能迁移符号链接配置文件')
    raw={file:file.read_bytes() for file in files}
    def load(name,default):
        file=directory/name
        try:
            value=_yaml(raw[file].decode('utf-8')) if file in raw else copy.deepcopy(default)
        except Exception:
            raise ValueError('旧配置格式无效：'+name) from None
        if not isinstance(value,dict):raise ValueError('旧配置顶层必须是对象：'+name)
        return value
    doc={'schemaVersion':1,'products':load('products.yaml',{'products':{}}),'projects':load('projects.yaml',{'projects':{}}),
         'sync':load('sync.yaml',{}),'datasource':load('datasource.yaml',{'datasource':{}}),
         'databaseTesting':load('database-testing.yaml',{'schemaVersion':1,'connections':{},'expectedIdentities':{},'databaseTests':{}}),
         'apiWorkspaces':{}}
    # Legacy readers treat a missing collection as empty; preserve other keys.
    for name in ('products','projects','datasource'):
        doc[name].setdefault(name,{})
    _validate(doc)
    def expand(value):
        if isinstance(value,str):return gusen_hub._expand_env(value)
        if isinstance(value,list):return [expand(item) for item in value]
        if isinstance(value,dict):return {key:expand(item) for key,item in value.items()}
        return value
    with runtime_home_context(home):
        errors=[];workspaces=gusen_hub.list_workspaces(expand({key:doc[key] for key in ('products','projects','sync','datasource')}),errors=errors)
    if errors:raise ValueError('旧工作区配置无效，无法生成完整迁移计划')
    for workspace in workspaces:
        file=workspace['contextDir']/'api/config.json'
        if not file.is_file():continue
        if file.is_symlink():raise ValueError('不能迁移符号链接配置文件')
        content=file.read_bytes()
        try:value=json.loads(content.decode('utf-8'),object_pairs_hook=_unique)
        except (ValueError,UnicodeError):raise ValueError('工作区 API 配置格式无效') from None
        if not isinstance(value,dict) or value.get('workspaceKey')!=workspace['workspaceKey'] or set(value)-FIELDS-{'workspaceKey'}:
            raise ValueError('工作区 API 配置身份或字段无效')
        files.append(file);raw[file]=content;doc['apiWorkspaces'][workspace['workspaceKey']]=value
    manifest=[{'path':str(file.resolve()),'sha256':hashlib.sha256(raw[file]).hexdigest(),
               'backupFile':f'{number:04d}-'+file.name} for number,file in enumerate(sorted(files,key=str))]
    plan_hash=hashlib.sha256(json.dumps({'files':manifest,'document':doc},ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return doc,raw,manifest,plan_hash,len(workspaces)


def migrate(home,payload):
    """Preview or explicitly apply a hash-bound migration with retained backups."""
    if not isinstance(payload,dict) or payload.get('action') not in {'preview','apply'}:
        raise ValueError('迁移 action 必须是 preview 或 apply')
    allowed={'action'} if payload['action']=='preview' else {'action','planHash','confirm'}
    if set(payload)-allowed:raise ValueError('迁移输入包含未知字段')
    home=Path(home).expanduser().resolve()
    if payload['action']=='preview':
        doc,raw,manifest,plan_hash,count=_legacy_plan(home)
        return {'ok':True,'action':'preview','mode':'legacy','path':str(path(home)),
                'legacyFiles':[entry['path'] for entry in manifest],'planHash':plan_hash,'complete':True,
                'summary':{'fileCount':len(raw),'workspaceCount':count}}
    if payload.get('confirm') is not True or not isinstance(payload.get('planHash'),str):
        raise ValueError('执行迁移必须确认并提供预览 planHash')
    with file_lock(home/'config'/'.configuration.lock'):
        doc,raw,manifest,plan_hash,count=_legacy_plan(home)
        if payload['planHash']!=plan_hash:raise ValueError('配置在预览后发生变化，请重新预览')
        # Workspace configuration locks serialize ordinary API configuration writes.
        with ExitStack() as stack:
            for file in sorted((file for file in raw if file.name=='config.json'),key=str):
                stack.enter_context(file_lock(file.parent/'configuration.lock'))
            current,raw,manifest,verified,count=_legacy_plan(home)
            if verified!=plan_hash:raise ValueError('配置在预览后发生变化，请重新预览')
            backup=home/'config'/'archive'/plan_hash[:20]
            if backup.exists():raise ValueError('迁移备份目录已存在，请先检查原迁移记录')
            backup.mkdir(mode=0o700,parents=True)
            for number,file in enumerate(sorted(raw,key=str)):
                atomic_bytes(backup/(f'{number:04d}-'+file.name),raw[file])
            atomic_text(backup/'manifest.json',json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
            current,_,_,verified,_=_legacy_plan(home)
            if verified!=plan_hash:raise ValueError('配置在预览后发生变化，请重新预览')
            write(home,current)
            archived=[];pending=[]
            for file in sorted(raw,key=str):
                try:
                    if file.read_bytes()!=raw[file]:pending.append(str(file));continue
                    file.unlink();archived.append(str(file))
                except OSError:
                    pending.append(str(file))
            result={'ok':True,'action':'apply','mode':'unified','path':str(path(home)),'backupPath':str(backup),
                    'archived':archived,'complete':not pending,'planHash':plan_hash}
            if pending:result['archivePending']=pending
            return result

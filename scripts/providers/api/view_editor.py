"""Hash-bound view SQL editing over the API checkout's existing documents."""
from __future__ import annotations

import json
import hashlib
from pathlib import PurePosixPath

from common.page_projection import _JsonValueLocator, replace_json_strings
from . import documents, xml_source
from .client import ApiError
from .store import ApiStore


def _view(text, metadata):
    view_id=metadata.get('viewId')
    if not isinstance(view_id,(str,int)) or isinstance(view_id,bool) or not str(view_id).strip():
        raise ApiError('API_VIEW_IDENTITY_MISSING','视图缺少平台编码')
    if not isinstance(text,str): raise ApiError('API_VIEW_FORMAT_UNSUPPORTED','视图源码必须是文本')
    try:
        if text.lstrip('\ufeff \t\r\n').startswith('<'):
            raw,root=xml_source.parse(text)
            if root.tag!='view':
                raise ValueError('native view XML root must be view')
            identifiers=[child for child in root.children if child.tag=='viewId']
            scripts=[child for child in root.children if child.tag=='viewSql']
            if len(identifiers)!=1:
                raise ValueError('viewId must occur once at the root')
            identity=xml_source.leaf_text(identifiers[0]).strip()
            if identity!=str(view_id):
                raise ApiError('API_IDENTITY_MISMATCH','视图源码编码与平台对象不一致')
            if len(scripts)!=1:
                raise ValueError('viewSql must occur once at the root')
            sql=xml_source.leaf_text(scripts[0])
            result={'format':'xml','sql':sql,'raw':raw,'node':scripts[0]}
        else:
            _JsonValueLocator(text).locate()
            value=json.loads(text)
            if not isinstance(value,dict) or not isinstance(value.get('viewId'),(str,int)) or isinstance(value.get('viewId'),bool):
                raise ValueError('viewId is required')
            identity=str(value['viewId'])
            if identity!=str(view_id):
                raise ApiError('API_IDENTITY_MISMATCH','视图源码编码与平台对象不一致')
            if not isinstance(value.get('viewSql'),str):
                raise ValueError('string viewSql is required')
            result={'format':'json','sql':value['viewSql']}
    except (ValueError,TypeError,KeyError) as error:
        raise ApiError('API_VIEW_FORMAT_UNSUPPORTED','视图必须包含唯一的视图编码和 SQL 文本') from error
    return result


def extract_sql(text, metadata):
    """Return SQL only after validating the view's native identity."""
    return _view(text,metadata)['sql']


def is_metadata_only(text, metadata, path):
    """Identify unchanged, metadata-bound native views that have no SQL node."""
    if not isinstance(text,str) or metadata.get('sourceType')!='view': return False
    view_id, data_source = metadata.get('viewId'), metadata.get('dataSourceId')
    if not isinstance(view_id,str) or not view_id.strip() or not isinstance(data_source,str) or not data_source.strip(): return False
    expected=PurePosixPath('datasources',data_source,'views',view_id+'.xml').as_posix()
    if path!=expected or hashlib.sha256(text.encode('utf-8')).hexdigest()!=metadata.get('remoteHash'): return False
    try:
        _,root=xml_source.parse(text)
        if root.tag!='view' or root.attrs or ''.join(root.text).strip(): return False
        children={child.tag:child for child in root.children}
        if len(children)!=len(root.children) or set(children)!={'viewName','viewId','fields'}: return False
        if any(child.attrs for child in children.values()): return False
        if xml_source.leaf_text(children['viewId']).strip()!=view_id: return False
        xml_source.leaf_text(children['viewName'])
        fields=children['fields']
        if fields.children or ''.join(fields.text).strip(): return False
    except (ValueError,TypeError):
        return False
    return True


def _candidate(text, metadata, sql):
    if not isinstance(sql,str) or len(sql.encode('utf-8'))>documents._MAX_CONTENT:
        raise ValueError('view SQL must be bounded text')
    parsed=_view(text,metadata)
    if sql==parsed['sql']: return text
    if parsed['format']=='xml':
        raw,node=parsed['raw'],parsed['node']
        replacement=xml_source.render_text_leaf(raw,node,sql,preserve_comments=True)
        result=(raw[:node.start]+replacement+raw[node.end:]).decode('utf-8')
    else:
        result=replace_json_strings(text,{'/viewSql':sql},{'/viewSql':parsed['sql']})
    if extract_sql(result,metadata)!=sql:
        raise ApiError('API_VIEW_VERIFY_FAILED','视图 SQL 回读与预览不一致')
    return result


def _item(workspace,path):
    item=ApiStore(workspace).read(path)
    if item['metadata'].get('sourceType')!='view':
        raise ApiError('API_VIEW_REQUIRED','当前源码不是视图')
    return item


def _lease_record(workspace,edit_token):
    lease=documents._load(documents._directory(workspace)/'leases'/(documents._identifier(edit_token)+'.json'))
    if lease.get('workspaceKey')!=workspace['workspaceKey'] or lease.get('leaseId')!=edit_token:
        raise ApiError('API_DOCUMENT_RECORD_INVALID','租约身份不匹配')
    item=_item(workspace,lease['path'])
    extract_sql(item['content'],item['metadata'])
    return lease


def run(workspace,payload):
    if not isinstance(payload,dict): raise ValueError('view action must be an object')
    action=payload.get('action')
    if action=='open':
        item=_item(workspace,payload.get('path'))
        if is_metadata_only(item['content'],item['metadata'],item['path']):
            return {'sourcePath':item['path'],'sourceHash':item['sourceHash'],'baseHash':item['baseHash'],
                    'editToken':None,'expiresAt':None,'editable':False,'content':None,'baseContentSQL':None,
                    'rawEditable':not item['readonly'],
                    'sourceFormat':'view-no-sql','contentState':'SQL_ABSENT',
                    'identitySource':'SOURCE_AND_API_METADATA','diagnostic':'API_VIEW_SQL_ABSENT',
                    'message':'原始视图未包含 SQL 节点；请使用原始文件进行显式编辑。'}
        sql=extract_sql(item['content'],item['metadata'])
        baseline=ApiStore(workspace).baseline(item['path'])
        base_sql=None if is_metadata_only(baseline,item['metadata'],item['path']) else extract_sql(baseline,item['metadata'])
        response={'sourcePath':item['path'],'sourceHash':item['sourceHash'],'content':sql,
                  'baseHash':item['baseHash'],'baseContentSQL':base_sql}
        if item['readonly']:
            return {**response,'editToken':None,'expiresAt':None,'editable':False}
        lease=documents.open_document(workspace,item['path'])
        if lease['sourceHash']!=item['sourceHash']:
            documents.close_document(workspace,lease['leaseId'])
            raise ApiError('API_SOURCE_STALE','打开期间视图源码已变化，请重新打开')
        return {**response,'editToken':lease['leaseId'],'expiresAt':lease['expiresAt'],'editable':True}
    if action=='preview':
        token=payload.get('editToken');lease=_lease_record(workspace,token)
        if payload.get('path')!=lease['path']:
            raise ApiError('API_IDENTITY_MISMATCH','视图路径与编辑租约不一致')
        if payload.get('expectedHash')!=lease['sourceHash']:
            raise ApiError('API_SOURCE_STALE','视图版本与编辑租约不一致')
        item=_item(workspace,lease['path'])
        if item['sourceHash']!=lease['sourceHash']:
            raise ApiError('API_SOURCE_STALE','视图源码已变化，请重新打开')
        candidate=_candidate(item['content'],item['metadata'],payload.get('content'))
        preview=documents.preview(workspace,token,content=candidate)
        return {'sourcePath':lease['path'],'sourceHash':preview['sourceHash'],'previewId':preview['previewId'],
                'candidateSourceHash':preview['candidateHash'],'changed':preview['changed']}
    if action=='save':
        token=payload.get('editToken');lease=_lease_record(workspace,token)
        result=documents.write(workspace,token,payload.get('previewId'),payload.get('idempotencyKey'),editor_token=payload.get('editorToken'))
        verified=documents.verify(workspace,result['operationId'])
        index_result={'complete':result.get('phase')=='VERIFIED','indexGeneration':result.get('indexGeneration'),
                      'diagnosticCount':result.get('indexDiagnosticCount',0)}
        if result.get('indexError'): index_result['error']=result['indexError']
        return {'sourcePath':lease['path'],'sourceHash':verified['actualHash'],'operationId':result['operationId'],
                'operationComplete':result.get('phase')=='VERIFIED' and verified['matchesAfter'], 'index':index_result}
    if action=='close':
        token=payload.get('editToken');_lease_record(workspace,token)
        lease=documents.close_document(workspace,token)
        return {'sourcePath':lease['path'],'closed':True}
    raise ValueError('unknown view editor action')

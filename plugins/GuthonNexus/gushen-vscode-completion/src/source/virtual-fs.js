const path=require('node:path');
const crypto=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {readInheritance}=require('./inheritance');
const SCHEME='guthon-api-edit';
const utf16Offset=(value,offset)=>Array.from(value).slice(0,offset).join('').length;
function pageDisplayName(source) {
  const ids=new Set([source.sourceId,source.pageId,source.sourceAliasId].filter(x=>typeof x==='string').map(x=>x.trim().toUpperCase()));
  for(const value of [source.treeLabel,source.pageName,source.sourceName]) if(typeof value==='string' && value.trim() && !ids.has(value.trim().toUpperCase()) && !/^PG-[0-9A-F-]+$/i.test(value.trim())) return value.trim();
  return '';
}
function fragmentIdentity(workspaceKey,source,fragment={}) {
  return {workspaceKey,sourceType:'page',sourceId:source.sourceId || '',sourcePath:source.sourcePath || source.path,
    jsonPointer:fragment.jsonPointer || '',fragmentType:fragment.scriptType || '',
    documentName:[pageDisplayName(source),fragment.label].filter(Boolean).join(' · ')};
}
function decodeIdentity(uri) {
  const p=new URLSearchParams(uri.query || '');
  return {workspaceKey:p.get('workspaceKey') || uri.authority,sourceType:p.get('sourceType') || 'page',sourcePath:p.get('path') || '',sourceId:p.get('id') || '',jsonPointer:p.get('pointer') || '',fragmentType:p.get('type') || ''};
}
function scriptType(node) {
  if(node.type==='SQL') return 'sql';
  const key=(node.pointer || '').split('/').at(-1);
  return node.eventScope==='SERVICE' || ['script','doMethodScript','compScript'].includes(key) || /SaveScript/.test(key) ? 'vm' : 'js';
}
function documentFilename(identity) {
  const label=String(identity.documentName || identity.sourceId || '页面代码').replace(/\s+\/\s+/g,' · ').replace(/[<>:"/\\|?*\x00-\x1f]+/g,'_');
  const type=['fields','json'].includes(identity.fragmentType)?'json':identity.fragmentType==='sql'?'sql':['gss','vm'].includes(identity.fragmentType)?'gss':'js';
  return label.toLowerCase().endsWith('.'+type) ? label : `${label}.${type}`;
}
function uriFor(vscode,id) {
  const extension=['fields','json'].includes(id.fragmentType) ? 'json' : id.fragmentType==='sql' ? 'sql' : ['gss','vm'].includes(id.fragmentType) ? 'gss' : 'js';
  const base=path.posix.basename(id.sourcePath);
  const event=(id.jsonPointer || '').split('/').at(-1);
  const label=(event ? `${base} · ${event}` : base.replace(/\.[^.]+$/,'')).replace(/[<>:"/\\|?*\x00-\x1f]+/g,'_');
  const params={workspaceKey:id.workspaceKey,path:id.sourcePath,pointer:id.jsonPointer || '',type:id.fragmentType || ''};
  if(id.sourceType && id.sourceType!=='page') params.sourceType=id.sourceType;
  return vscode.Uri.from({scheme:SCHEME,authority:id.workspaceKey,path:`/${label}.${extension}`,query:new URLSearchParams(params).toString()});
}
function isInlineInherited(_key,sourcePath,item) {
  return !item.readonly && ['procedure','system-script'].includes(item.metadata?.sourceType) && /@?inherit\s*\(/.test(item.content)
    || !item.readonly && item.metadata?.sourceType==='page' && /\.gss$/i.test(sourcePath) && /@?inherit\s*\(/.test(item.content);
}
function inheritedProjection(source,projection,sourceHash,wholeFile) {
  const segments=projection.segments,product=segments?.find(segment=>segment.layer==='product');
  if(!Array.isArray(segments) || segments.length!==3 || !product || segments[0].layer!=='project' || segments[2].layer!=='project') throw new Error('继承源码缺少精确身份，无法编辑');
  if(wholeFile && (!projection.parentPath || !projection.parentHash)) throw new Error('继承源码缺少父层路径或哈希，无法编辑');
  if(!wholeFile && !projection.parentPointer) throw new Error('继承源码缺少父层节点，无法编辑');
  const effective=projection.effective,start=utf16Offset(effective,product.start),end=utf16Offset(effective,product.end);
  const markerStart=utf16Offset(source,segments[0].sourceEnd),markerEnd=utf16Offset(source,segments[2].sourceStart);
  if(start>end || markerStart>markerEnd || !source.slice(markerStart,markerEnd)) throw new Error('继承源码偏移无效');
  return {parentPointer:projection.parentPointer,parentPath:projection.parentPath,parentHash:projection.parentHash || sourceHash,parentHashUsesSource:!projection.parentHash,
    productText:effective.slice(start,end),start,end,marker:source.slice(markerStart,markerEnd),materializable:projection.materializable===true,productTouched:false};
}
class ApiPageVirtualFs {
  constructor({vscode,run,editorState,onWillSave,onSaved,onOpened,onInvalidated}) {
    Object.assign(this,{vscode,run,editorState,onWillSave,onSaved,onOpened,onInvalidated});this.records=new Map();this.inFlight=new Map();this.generations=new Map();this.changed=new vscode.EventEmitter();this.onDidChangeFile=this.changed.event;
  }
  async open(identity,options={}) {
    return (await this.openEditor(identity,options)).document.uri;
  }
  async openEditor(identity,options={}) {
    const uri=uriFor(this.vscode,identity);
    this.editorState.assertNoDirtyDocumentsExcept?.(identity.workspaceKey,identity.sourcePath,uri);
    const editor=await this.vscode.window.showTextDocument(await this.vscode.workspace.openTextDocument(uri),{...options,preview:false});
    this.onOpened?.(editor);return editor;
  }
  async readFile(uri) {
    const key=uri.toString(),cached=this.records.get(key);if(cached) return Buffer.from(cached.content);
    const id=decodeIdentity(uri),generation=this.generations.get(key)||0,existing=this.inFlight.get(key);
    if(existing?.generation===generation) return existing.promise;
    const request={id,generation};
    request.promise=this.loadFile(uri,id).then(({content,record})=>{
      if(this.disposed || (this.generations.get(key)||0)!==generation) {this.releaseProjection(record);throw new Error('源码读取期间已变化，请重新打开');}
      this.records.set(key,record);return content;
    }).finally(()=>{if(this.inFlight.get(key)===request)this.inFlight.delete(key);});
    this.inFlight.set(key,request);return request.promise;
  }
  async loadFile(uri,id) {
    const wholeFile=!id.jsonPointer,collection=id.fragmentType==='fields',view=id.sourceType==='view',module=id.sourceType==='module-parameter';
    let source,sourceHash,editable,inherited,editToken,expiresAt,baseHash,baseContentSQL,baseContentData;
    if(view || module) {
      const item=await this.openProjection(id);({content:source,sourceHash,editable,editToken,expiresAt,baseHash,baseContentSQL,baseContentData}=item);
    } else if(wholeFile) {
      const item=await this.run(id.workspaceKey,'read',{path:id.sourcePath});
      if(item.path!==id.sourcePath || !['procedure','page','system-script'].includes(item.metadata?.sourceType) || (id.sourceType==='procedure' && item.metadata.sourceType!=='procedure')) throw new Error('继承源码身份与当前文件不一致');
      source=item.content;sourceHash=item.sourceHash;editable=!item.readonly;
    } else if(collection) {
      const item=await this.run(id.workspaceKey,'page',{action:'fragment',path:id.sourcePath,jsonPointer:id.jsonPointer});
      if((item.sourcePath || item.path)!==id.sourcePath || item.jsonPointer!==id.jsonPointer || item.fragmentType!=='collection' || typeof item.content!=='string' || !item.sourceHash) throw new Error('字段集合身份或内容无效');
      if(!Array.isArray(JSON.parse(item.content))) throw new Error('字段集合必须是 JSON 数组');
      source=item.content;sourceHash=item.sourceHash;editable=item.editable;
    } else {
      const snapshot=await this.run(id.workspaceKey,'page',{action:'open',path:id.sourcePath});
      if(snapshot.sourcePath!==id.sourcePath) throw new Error('PAGE 来源与请求不一致');
      const node=snapshot.model.nodes.find(x=>x.pointer===id.jsonPointer);if(!node) throw this.vscode.FileSystemError.FileNotFound(uri);
      source=node.content;sourceHash=snapshot.sourceHash;editable=snapshot.editable && node.editable;
      if(snapshot.editable && !node.editable && /@?inherit\s*\(/.test(source)) editable=true;
    }
    if(editable && !view && !module && !collection && /@?inherit\s*\(/.test(source)) {
      const projection=await readInheritance({run:this.run,workspaceKey:id.workspaceKey,path:id.sourcePath,jsonPointer:id.jsonPointer,expectedHash:sourceHash});
      if(projection.status==='ACTIVE') {inherited=inheritedProjection(source,projection,sourceHash,wholeFile);source=projection.effective;}
      else if(projection.status!=='INACTIVE') {editable=false;await this.vscode.window.showWarningMessage(`继承状态 ${projection.status}，暂以只读原文打开`);}
    }
    const content=Buffer.from(source,'utf8');return {content,record:{id,uri,sourceHash,editable,collection,wholeFile,view,module,editToken,expiresAt,baseHash,baseContentSQL,baseContentData,inherited,size:content.length,content}};
  }
  async openProjection(id) {
    const item=await this.run(id.workspaceKey,id.sourceType==='module-parameter'?'module-parameter':'view',{action:'open',path:id.sourcePath});
    if(item.sourcePath!==id.sourcePath || typeof item.content!=='string' || !item.sourceHash || typeof item.editable!=='boolean' || (item.editable && !item.editToken)) {
      this.releaseProjection({id,editToken:item.editToken});throw new Error('源码编辑内容或会话无效');
    }
    return item;
  }
  releaseProjection(record) {
    if(!record?.editToken) return;
    const editToken=record.editToken;record.editToken=undefined;
    void this.run(record.id.workspaceKey,record.id.sourceType==='module-parameter'?'module-parameter':'view',{action:'close',editToken}).catch(error=>this.vscode.window.showErrorMessage?.(`编辑会话关闭失败：${error.message}`));
  }
  async stat(uri) {
    const record=this.records.get(uri.toString());if(!record) await this.readFile(uri);
    const current=this.records.get(uri.toString());return {type:this.vscode.FileType.File,ctime:0,mtime:0,size:current.size,...(!current.editable && this.vscode.FilePermission ? {permissions:this.vscode.FilePermission.Readonly}:{})};
  }
  watch(){return {dispose(){}};}
  trackDocumentChange(event) {
    const inherited=this.records.get(event.document.uri.toString())?.inherited;if(!inherited) return;
    for(const change of event.contentChanges || []) {
      const start=change.rangeOffset,end=start+change.rangeLength,delta=change.text.length-change.rangeLength;
      if(inherited.start===inherited.end && start===inherited.start && change.text.length) {inherited.productTouched=true;inherited.end+=delta;}
      else if(end<=inherited.start) {inherited.start+=delta;inherited.end+=delta;}
      else if(start>=inherited.end) continue;
      else {inherited.productTouched=true;inherited.start=Math.min(inherited.start,start);inherited.end=Math.max(inherited.end+delta,start+change.text.length);}
    }
  }
  invalidate(key,paths) {
    for(const [name,request] of this.inFlight) if(request.id.workspaceKey===key) this.generations.set(name,(this.generations.get(name)||0)+1);
    for(const [name,record] of this.records) {
      if(record.id.workspaceKey!==key || (!paths.includes(record.id.sourcePath) && !paths.includes(record.inherited?.parentPath))) continue;
      if((this.vscode.workspace.textDocuments || []).some(doc=>doc.isDirty && doc.uri.toString()===name)) continue;
      this.records.delete(name);this.releaseProjection(record);this.changed.fire([{type:this.vscode.FileChangeType.Changed,uri:record.uri}]);
    }
    this.onInvalidated?.();
  }
  close(uri){const key=uri.toString();this.generations.set(key,(this.generations.get(key)||0)+1);this.releaseProjection(this.records.get(key));this.records.delete(key);this.onInvalidated?.();}
  checkBuffers(record,uri) {
    this.onWillSave?.(uri);
    this.editorState.assertNoConflictingDrafts(record.id.workspaceKey,record.id.sourcePath,['page']);
    this.editorState.assertNoDirtyDocumentsExcept?.(record.id.workspaceKey,record.id.sourcePath,uri);
    if(record.inherited?.parentPath) this.editorState.assertNoDirtyDocumentsExcept?.(record.id.workspaceKey,record.inherited.parentPath);
  }
  async writeFile(uri,content) {
    const record=this.records.get(uri.toString());if(!record || !record.editable) throw this.vscode.FileSystemError.NoPermissions(uri);
    if(record.uncertain) throw new Error('上次源码保存结果未知，请先核对源码并重新打开');
    if(record.view || record.module) return this.writeProjection(uri,record,content);
    this.checkBuffers(record,uri);const token=await this.editorState.flush(record.id.workspaceKey);
    const snapshot=record.wholeFile ? await this.run(record.id.workspaceKey,'read',{path:record.id.sourcePath}) : await this.run(record.id.workspaceKey,'page',{action:'open',path:record.id.sourcePath});
    if(snapshot.sourceHash!==record.sourceHash || (record.wholeFile ? snapshot.readonly : !snapshot.editable)) throw new Error('源码已变化，请先核对；编辑器输入已保留');
    const text=Buffer.from(content).toString('utf8'),inherited=record.inherited;
    let sourceText=text,inheritance,controlFlowConfirmed=false;
    if(record.collection) {
      let parsed;try {parsed=JSON.parse(text);} catch {throw new Error('字段集合必须是有效的 JSON 数组');}
      if(!Array.isArray(parsed)) throw new Error('字段集合必须是 JSON 数组');
    }
    if(inherited) {
      let found=inherited.start;
      let unchanged=text.slice(inherited.start,inherited.end)===inherited.productText;
      if(!unchanged && !inherited.productTouched && inherited.productText) {found=text.indexOf(inherited.productText);unchanged=found>=0 && text.indexOf(inherited.productText,found+1)<0;}
      if(unchanged) sourceText=text.slice(0,found)+inherited.marker+text.slice(found+inherited.productText.length);
      else if(!inherited.materializable) {
        const choice=await this.vscode.window.showWarningMessage('展开继承后的控制流需要核对，请审查后再保存到项目文件。',{modal:true},'已核对，继续保存');
        if(choice!=='已核对，继续保存') throw this.vscode.FileSystemError.NoPermissions('需要先核对继承函数的控制流');controlFlowConfirmed=true;
      }
      inheritance={jsonPointer:record.id.jsonPointer,parentPointer:inherited.parentPointer,sourceHash:record.sourceHash,parentHash:inherited.parentHash,materialized:!unchanged,...(controlFlowConfirmed ? {controlFlowConfirmed:true} : {})};
    }
    const operations=record.wholeFile ? undefined : [{kind:record.collection?'collection':'text',jsonPointer:record.id.jsonPointer,content:sourceText}];
    if(operations) await this.run(record.id.workspaceKey,'page',{action:'preview',path:record.id.sourcePath,editToken:snapshot.editToken,operations,...(inheritance ? {inheritance} : {})});
    this.checkBuffers(record,uri);const latestToken=await this.editorState.flush(record.id.workspaceKey);
    if(latestToken!==token) throw new Error('编辑会话已变化，请重新打开源码');this.checkBuffers(record,uri);
    try {
      record.uncertain=true;
      let result;
      if(record.wholeFile) {
        result=inherited ? await this.run(record.id.workspaceKey,'inherited-write',{path:record.id.sourcePath,content:sourceText,expectedHash:record.sourceHash,
          parentPath:inherited.parentPath,parentHash:inherited.parentHash,materialized:inheritance.materialized,
          ...(controlFlowConfirmed ? {controlFlowConfirmed:true} : {}),idempotencyKey:'procedure-code-'+crypto.randomUUID(),editorToken:token})
          : await this.run(record.id.workspaceKey,'write',{path:record.id.sourcePath,content:sourceText,expectedHash:record.sourceHash,editorToken:token});
        const fresh=await this.run(record.id.workspaceKey,'read',{path:record.id.sourcePath});
        if(fresh.path!==record.id.sourcePath || fresh.content!==sourceText || (result.sourceHash && result.sourceHash!==fresh.sourceHash)) throw new Error('源码保存回读不一致');
        record.sourceHash=fresh.sourceHash;
      } else {
        result=await this.run(record.id.workspaceKey,'page',{action:'save',path:record.id.sourcePath,editToken:snapshot.editToken,operations,
          idempotencyKey:'page-code-'+crypto.randomUUID(),editorToken:token,...(inheritance ? {inheritance} : {})});
        const fresh=record.collection ? await this.run(record.id.workspaceKey,'page',{action:'fragment',path:record.id.sourcePath,jsonPointer:record.id.jsonPointer}) : await this.run(record.id.workspaceKey,'page',{action:'open',path:record.id.sourcePath});
        if(record.collection && ((fresh.sourcePath || fresh.path)!==record.id.sourcePath || fresh.jsonPointer!==record.id.jsonPointer)) throw new Error('字段集合回读身份不一致');
        const actual=record.collection ? fresh.content : fresh.model.nodes.find(x=>x.pointer===record.id.jsonPointer)?.content;
        if((record.collection ? !isDeepStrictEqual(JSON.parse(actual),JSON.parse(sourceText)) : actual!==sourceText) || (result.sourceHash && result.sourceHash!==fresh.sourceHash)) throw new Error('源码保存回读不一致');
        record.sourceHash=fresh.sourceHash;
      }
      record.size=content.length;record.content=Buffer.from(content);record.uncertain=false;
      if(inherited?.parentHashUsesSource) inherited.parentHash=record.sourceHash;
      if(inherited && inheritance.materialized) record.inherited=undefined;
      else if(inherited) {const found=text.slice(inherited.start,inherited.end)===inherited.productText ? inherited.start : text.indexOf(inherited.productText);inherited.start=found;inherited.end=found+inherited.productText.length;inherited.productTouched=false;}
    } catch(error) {throw error;}
    await this.onSaved?.(uri);
  }
  async writeProjection(uri,record,content) {
    const label=record.module?'模块参数':'视图 SQL';
    this.checkBuffers(record,uri);
    const document=(this.vscode.workspace.textDocuments || []).find(doc=>doc.uri.toString()===uri.toString()),version=document?.version;
    const checkVersion=()=>{if(document && document.version!==version) throw new Error(`保存期间${label} 已变化，请重新保存`);};
    const token=await this.editorState.flush(record.id.workspaceKey);
    if(record.expiresAt && Date.now()>=record.expiresAt*1000) {
      record.editToken=undefined;const fresh=await this.openProjection(record.id);
      if(fresh.sourceHash!==record.sourceHash || !fresh.editable) {this.releaseProjection({id:record.id,editToken:fresh.editToken});throw new Error(`${label}源码已变化，请先核对；编辑器输入已保留`);}
      Object.assign(record,{editToken:fresh.editToken,expiresAt:fresh.expiresAt,baseHash:fresh.baseHash,baseContentSQL:fresh.baseContentSQL,baseContentData:fresh.baseContentData});
    }
    const snapshot=await this.run(record.id.workspaceKey,'read',{path:record.id.sourcePath});
    if(snapshot.path!==record.id.sourcePath || snapshot.sourceHash!==record.sourceHash || snapshot.readonly) throw new Error(`${label}源码已变化，请先核对；编辑器输入已保留`);
    const text=Buffer.from(content).toString('utf8');
    const preview=await this.run(record.id.workspaceKey,record.module?'module-parameter':'view',{action:'preview',path:record.id.sourcePath,editToken:record.editToken,expectedHash:record.sourceHash,content:text});
    if((preview.sourcePath && preview.sourcePath!==record.id.sourcePath) || preview.sourceHash!==record.sourceHash || !preview.previewId || !preview.candidateSourceHash) throw new Error(`${label} 预览身份无效`);
    this.checkBuffers(record,uri);checkVersion();const latest=await this.editorState.flush(record.id.workspaceKey);
    if(latest!==token) throw new Error('编辑会话已变化，请重新打开源码');this.checkBuffers(record,uri);checkVersion();
    record.uncertain=true;
    const result=await this.run(record.id.workspaceKey,record.module?'module-parameter':'view',{action:'save',editToken:record.editToken,previewId:preview.previewId,idempotencyKey:(record.module?'module-data-':'view-sql-')+crypto.randomUUID(),editorToken:token});
    record.editToken=undefined;
    if((result.sourcePath && result.sourcePath!==record.id.sourcePath) || result.operationComplete!==true || result.sourceHash!==preview.candidateSourceHash) throw new Error(`${label} 保存结果未确认，请核对源码`);
    const fresh=await this.openProjection(record.id);
    if(fresh.sourceHash!==result.sourceHash || (record.module?fresh.content.trim()!==text.trim():fresh.content!==text)) {this.releaseProjection({id:record.id,editToken:fresh.editToken});throw new Error(`${label} 保存回读不一致`);}
    Object.assign(record,{editToken:fresh.editToken,expiresAt:fresh.expiresAt,baseHash:fresh.baseHash,baseContentSQL:fresh.baseContentSQL,baseContentData:fresh.baseContentData,sourceHash:fresh.sourceHash,editable:fresh.editable});
    record.size=content.length;record.content=Buffer.from(content);record.uncertain=false;
    await this.onSaved?.(uri);
  }
  async previewProjection(uri,content) {
    await this.readFile(uri);const record=this.records.get(uri.toString());
    if(!record?.module || !record.editable || record.uncertain)throw new Error('请选择可编辑的模块参数');
    return this.run(record.id.workspaceKey,'module-parameter',{action:'preview',path:record.id.sourcePath,editToken:record.editToken,expectedHash:record.sourceHash,content});
  }
  projectBase(uri,physicalBase) {
    const inherited=this.records.get(uri.toString())?.inherited;if(!inherited) return physicalBase;
    const first=physicalBase.indexOf(inherited.marker);
    if(first<0 || physicalBase.indexOf(inherited.marker,first+1)>=0) return undefined;
    return physicalBase.slice(0,first)+inherited.productText+physicalBase.slice(first+inherited.marker.length);
  }
  projectionBase(uri,diff) {
    const record=this.records.get(uri.toString());
    return (record?.view || record?.module) && typeof diff.sourceHash==='string' && !!diff.sourceHash && typeof diff.baseHash==='string' && !!diff.baseHash && record.sourceHash===diff.sourceHash && record.baseHash===diff.baseHash && typeof (record.module?record.baseContentData:record.baseContentSQL)==='string' ? (record.module?record.baseContentData:record.baseContentSQL) : undefined;
  }
  readDirectory(){return [];}
  createDirectory(){throw this.vscode.FileSystemError.NoPermissions();}
  delete(){throw this.vscode.FileSystemError.NoPermissions();}
  rename(){throw this.vscode.FileSystemError.NoPermissions();}
  dispose(){if(this.disposed)return;this.disposed=true;this.changed.dispose();for(const record of this.records.values())this.releaseProjection(record);this.records.clear();this.inFlight.clear();this.generations.clear();}
}
module.exports={SCHEME,pageDisplayName,fragmentIdentity,documentFilename,scriptType,decodeIdentity,uriFor,isInlineInherited,ApiPageVirtualFs};

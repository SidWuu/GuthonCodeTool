const path = require('node:path');
const {isInlineInherited,scriptType}=require('../source/virtual-fs');

function filePath(root, sourcePath) {
  if (typeof sourcePath !== 'string' || !sourcePath || sourcePath.includes('\\') || sourcePath.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('无效的源码路径');
  const result = path.resolve(root, sourcePath);
  const relative = path.relative(path.resolve(root), result);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('源码路径不属于当前 checkout');
  return result;
}
function dirtyDocuments(vscode, root, paths) {
  const selected = paths && new Set(paths.map(p => filePath(root, p)));
  return vscode.workspace.textDocuments.filter(doc => {
    if (!doc.isDirty || doc.uri.scheme !== 'file') return false;
    const absolute = path.resolve(doc.uri.fsPath), relative = path.relative(path.resolve(root), absolute);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && (!selected || selected.has(absolute));
  });
}
function assertClean(vscode, root, paths) {
  if (dirtyDocuments(vscode, root, paths).length) throw new Error('目标源码有未保存文档，请先保存或关闭后重试');
}
function identity(value, sourcePath) {
  if (typeof value === 'string') return {key:value, path:sourcePath};
  if (value?.target?.workspaceKey && value.target.sourcePath) return {key:value.target.workspaceKey,path:value.target.sourcePath};
  if (value?.key && value.object?.path) return {key:value.key,path:value.object.path};
  if (value?.workspaceKey || value?.guthonWorkspaceKey) return {key:value.workspaceKey || value.guthonWorkspaceKey, path:value.path};
  const uri = value?.resourceUri || value;
  if (uri?.scheme === 'guthon-api-change') {
    const query = new URLSearchParams(uri.query);
    return {key:uri.authority, path:query.get('path')};
  }
  throw new Error('请选择 API 源码');
}

function sourceSyncLines(key,result) {
  const state=value=>value===true?'完成':value===false?'未完成':'未返回';
  const index=result.index || {}, diagnostics=index.diagnostics || [];
  const lines=[`工作区：${key}`,`总体结果：${state(result.complete)}`,`文件拉取与合并：${state(result.downloadComplete)}`,
    `索引结果：${state(index.complete)}`,`索引诊断数量：${index.diagnosticCount ?? '未返回'}`,
    `更新 ${result.updated?.length || 0} 个，保留 ${result.preserved?.length || 0} 个，冲突 ${result.conflicts?.length || 0} 个。`];
  if(result.conflicts?.length) lines.push('','## 文件冲突',...result.conflicts.map(x=>`- ${x.path}：${x.reason}`));
  if(index.complete===false || index.diagnosticCount) lines.push('','## 索引诊断','部分源码未完成解析，相关检索和分析可能不完整。',
    ...diagnostics.map(x=>`- ${x.path || '未知文件'}：${x.code || ''} ${x.message || ''}`),
    ...(index.truncated ? ['- 诊断列表已截断，请检查索引状态。'] : []));
  lines.push('','本次未执行上传。');return lines;
}
const UPLOAD_UNVERIFIED_STAGES=new Set(['UNKNOWN','REMOTE_REQUEST_STARTED','REMOTE_ACKNOWLEDGED']);
function needsUploadVerification(item) {
  return item.kind==='upload' && (UPLOAD_UNVERIFIED_STAGES.has(item.stage) || (item.results || []).some(row=>UPLOAD_UNVERIFIED_STAGES.has(row.stage)));
}
async function showReport(vscode,title,lines) {
  const doc=await vscode.workspace.openTextDocument({language:'markdown',content:`# ${title}\n\n${lines.join('\n')}\n`});
  await vscode.window.showTextDocument(doc,{preview:true});
}

class ApiSourceUI {
  constructor({vscode, run, onUpdated, editorState, onSourceChanged, onWorkspace, onOpenVirtual, indexRecovery}) {
    this.vscode=vscode; this.run=run; this.onUpdated=onUpdated; this.editorState=editorState; this.onSourceChanged=onSourceChanged; this.onWorkspace=onWorkspace; this.onOpenVirtual=onOpenVirtual; this.indexRecovery=indexRecovery; this.watchers=new Map(); this.workspaces=new Map(); this.controls=new Map();this.scmGenerations=new Map();this.sourceChanges=new Map();
    this.emitter = vscode.EventEmitter ? new vscode.EventEmitter() : undefined;
    this.onDidChangeTreeData = this.emitter?.event;
    this.readonlyDocuments=new Map();this.rootItems=null;this.treeCache=new Map();this.indexDiagnostics=new Map();
  }
  syncWorkspaces(workspaces) {
    const keys=new Set();
    for (const workspace of workspaces) {
      const key=typeof workspace === 'string' ? workspace : workspace.workspaceKey;
      if (!key || (workspace.sourceMode && workspace.sourceMode !== 'api')) continue;
      keys.add(key); this.workspaces.set(key, typeof workspace === 'string' ? {workspaceKey:key} : workspace);
    }
    for (const key of this.workspaces.keys()) if (!keys.has(key)) {this.workspaces.delete(key);this.scmGenerations.set(key,(this.scmGenerations.get(key)||0)+1);this.controls.get(key)?.control.dispose();this.controls.delete(key);this.sourceChanges.delete(key);this.watchers.get(key)?.dispose();this.watchers.delete(key);}
    this.rootItems=null;this.treeCache.clear();this.emitter?.fire();
  }
  track(key) {if (!this.workspaces.has(key)) {this.workspaces.set(key,{workspaceKey:key});this.rootItems=null;}}
  refresh() {this.rootItems=null;this.treeCache.clear();this.emitter?.fire();}
  getTreeItem(item) {
    const v=this.vscode;
    const isPage=item.object?.sourceType==='page' && (['json','xml','native-xml'].includes(item.object.sourceFormat) || /\.(?:json|xml)$/i.test(item.object.path));
    const tree=new v.TreeItem(item.label, item.children || isPage ? v.TreeItemCollapsibleState.Collapsed : v.TreeItemCollapsibleState.None);
    if(item.kind==='message') {tree.tooltip=item.label;if(item.command) tree.command={command:item.command,title:item.label,arguments:[item.key]};return tree;}
    if(item.kind==='fragment') {
      tree.contextValue=item.target.fragmentType==='fields' ? 'guthonApi.fragment.fields' : 'guthonApi.fragment.script';tree.tooltip=item.target.jsonPointer;
      tree.command={command:'gushenCompletion.openApiFragment',title:'打开源码分块',arguments:[item.target]};return tree;
    }
    tree.contextValue=item.children ? 'guthonApi.directory' : item.object.readonly ? 'guthonApi.readonly' : ['page','procedure','table','view'].includes(item.object.sourceType) ? `guthonApi.${item.object.sourceType}` : 'guthonApi.source';
    tree.tooltip=item.object ? [item.object.path,item.object.diagnostic].filter(Boolean).join(' · ') : item.label;
    const state=this.sourceChanges.get(item.key)?.get(item.object?.path || item.sourcePrefix);
    if(state) {tree.description=({CONFLICT:'冲突',REMOTE_DELETED:'远端已删除',MISSING:'本地缺失',MODIFIED:'有本地修改'})[state] || state;if(v.ThemeIcon) tree.iconPath=new v.ThemeIcon(state==='MODIFIED'?'diff-modified':'warning');}
    if(item.object) tree.command={command:isPage ? 'gushenCompletion.openApiPageEditor' : 'gushenCompletion.openApiSource',title:isPage ? '打开 PAGE 管理器' : '打开源码',arguments:[{workspaceKey:item.key,path:item.object.path}]};
    return tree;
  }
  async getChildren(item) {
    if (!item) return this.rootItems ||= [...this.workspaces].map(([key,w])=>({label:w.displayName || key,key,workspace:true,children:true}));
    if (item.workspace) {
      if(this.treeCache.has(item.key)) return this.treeCache.get(item.key);
      const objects=[];let offset=0,generation,partial=0;
      for(;;) {
        let result;
        try {result=await this.run(item.key,'catalog',{limit:100,offset});}
        catch(error) {if(['API_INDEX_REQUIRED','API_INDEX_SCOPE_STALE'].includes(error.code)) return [{kind:'message',label:error.message,key:item.key,parent:item,command:'gushenCompletion.reindexCalls'}];throw error;}
        if(generation && result.indexGeneration && generation!==result.indexGeneration) throw new Error('目录读取期间索引已变化，请刷新');
        generation ||= result.indexGeneration;partial=Math.max(partial,result.partialSourceCount || 0);
        objects.push(...result.objects);
        if(result.nextOffset == null) break;
        if(!Number.isInteger(result.nextOffset) || result.nextOffset<=offset) throw new Error('目录分页无效');
        offset=result.nextOffset;
      }
      const root={children:[],parent:item};
      for (const object of objects) {
        filePath('/api-root',object.path);
        let parent=root; const parts=object.path.split('/');
        for (const part of parts.slice(0,-1)) {
          let child=parent.children.find(x=>x.children && x.label===part);
          if (!child) {child={label:part,key:item.key,children:[],sourcePrefix:parent===root ? part : `${parent.sourcePrefix}/${part}`,parent:parent===root ? item : parent};parent.children.push(child);} parent=child;
        }
        parent.children.push({label:object.label || object.name || parts.at(-1),key:item.key,object,parent:parent===root ? item : parent});
      }
      const sort = node => {node.children.sort((a,b)=>Boolean(b.children)-Boolean(a.children) || a.label.localeCompare(b.label));node.children.filter(x=>Array.isArray(x.children)).forEach(sort);}; sort(root);const diagnostic=this.indexDiagnostics.get(item.key);const count=Math.max(partial,diagnostic?.diagnosticCount || 0);
      if(count || diagnostic?.complete===false) root.children.push({kind:'message',label:`索引不完整${count ? `：${count} 个诊断` : ''}，点击查看`,key:item.key,parent:item,command:diagnostic ? 'gushenCompletion.showApiIndexDiagnostics' : 'gushenCompletion.reindexCalls'});
      const recovery=this.indexRecovery?.(item.key);if(recovery?.paths.length) root.children.push({kind:'message',label:`${recovery.paths.length} 个源码文件等待索引更新，点击重试`,key:item.key,parent:item,command:'gushenCompletion.retryApiIndexFailures'});
      this.treeCache.set(item.key,root.children);return root.children;
    }
    if(item.object?.sourceType==='page' && (['json','xml','native-xml'].includes(item.object.sourceFormat) || /\.(?:json|xml)$/i.test(item.object.path))) {
      if(item.fragments) return item.fragments;
      if(!item.fragmentPromise) item.fragmentPromise=(async()=>{
        const snapshot=await this.run(item.key,'page',{action:'open',path:item.object.path});
        if(snapshot.sourcePath!==item.object.path) throw new Error('PAGE 来源与目录不一致');
        const fragments=[...snapshot.model.nodes.map(node=>({label:node.label || node.pointer,pointer:node.pointer,type:scriptType(node)})),
          ...snapshot.model.collections.map(collection=>({label:`${collection.label || '集合'} · ${collection.kind==='BUTTONS' ? '按钮' : '字段'} JSON`,pointer:collection.pointer,type:'fields'}))];
        return item.fragments=fragments.length ? fragments.map(fragment=>({kind:'fragment',label:fragment.label,parent:item,target:{workspaceKey:item.key,sourceType:'page',sourcePath:item.object.path,
          path:item.object.path,sourceId:snapshot.sourceId,jsonPointer:fragment.pointer,fragmentType:fragment.type,documentName:fragment.label}}))
          : [{kind:'message',label:'此 PAGE 没有可编辑分块',parent:item}];
      })().finally(()=>{item.fragmentPromise=undefined;});
      return item.fragmentPromise;
    }
    return item.children || [];
  }
  getParent(item) {return item.parent;}
  async revealSource(key,sourcePath) {
    if(!this.treeView) throw new Error('源码视图不可用');
    const workspace=(await this.getChildren()).find(item=>item.key===key);if(!workspace) throw new Error('当前项目未显示在源码树');
    const visit=items=>{for(const item of items) {if(item.object?.path===sourcePath)return item;if(Array.isArray(item.children)){const found=visit(item.children);if(found)return found;}}};
    const found=visit(await this.getChildren(workspace));if(!found) throw new Error('源码不在当前索引目录，请先重建索引');
    await this.treeView.reveal(found,{select:true,focus:true,expand:true});
  }
  setIndexResult(key,index) {
    if(index && (index.complete===false || index.diagnosticCount)) this.indexDiagnostics.set(key,index);
    else if(index?.complete===true) this.indexDiagnostics.delete(key);
    this.refresh();
  }
  async showIndexDiagnostics(key) {
    const index=this.indexDiagnostics.get(key);if(!index) return this.vscode.window.showInformationMessage('当前没有本次操作保留的索引诊断，请检查或重建索引');
    await showReport(this.vscode,'API 索引诊断',sourceSyncLines(key,{index}));
  }
  async status(key) {
    this.track(key); const result=await this.run(key,'status');
    if(this.editorState && !this.editorState.workspaces.has(key)) await this.editorState.add(key,result.checkoutPath);
    this.onWorkspace?.(key,result.checkoutPath);
    if(this.editorState && !this.watchers.has(key) && this.vscode.workspace.createFileSystemWatcher && this.vscode.RelativePattern) {
        const watcher=this.vscode.workspace.createFileSystemWatcher(new this.vscode.RelativePattern(result.checkoutPath,'**/*'));
        const changed=uri=>{const relative=path.relative(result.checkoutPath,uri.fsPath).split(path.sep).join('/');
          if(relative && relative!=='..' && !relative.startsWith('../')) void this.onSourceChanged?.(key,[relative]);};
      watcher.onDidChange(changed);watcher.onDidCreate(changed);watcher.onDidDelete(changed);this.watchers.set(key,watcher);
    }
    return result;
  }
  async open(key, sourcePath, preview=false, {raw=false}={}) {
    const status=await this.status(key); const file=filePath(status.checkoutPath,sourcePath);
    // The backend remains authoritative about object identity and readonly state.
    const source=await this.run(key,'read',{path:sourcePath});
    if(!raw && source.metadata?.sourceType==='view' && this.onOpenVirtual) return this.onOpenVirtual({workspaceKey:key,sourcePath,sourceType:'view',jsonPointer:'/viewSql',fragmentType:'sql'});
    if(!raw && this.onOpenVirtual && isInlineInherited(key,sourcePath,source)) return this.onOpenVirtual({workspaceKey:key,sourcePath,sourceType:source.metadata.sourceType,fragmentType:source.metadata.sourceType==='system-script' ? 'js' : 'gss'});
    let uri=this.vscode.Uri.file(file);
    if(source.readonly) {
      uri=this.vscode.Uri.from({scheme:'guthon-api-readonly',authority:key,path:'/'+sourcePath});
      this.readonlyDocuments.set(uri.toString(),source.content);
    }
    return this.vscode.window.showTextDocument(await this.vscode.workspace.openTextDocument(uri),{preview});
  }
  provideTextDocumentContent(uri) {return this.readonlyDocuments.get(uri.toString()) || ''; }
  async updateScm(key) {
    const generation=(this.scmGenerations.get(key)||0)+1;this.scmGenerations.set(key,generation);
    const state=await this.status(key); const vscode=this.vscode;
    if(this.disposed || this.scmGenerations.get(key)!==generation) return state;
    if (!vscode.scm) {this.refresh();return state;}
    let record=this.controls.get(key);
    if (!record) {
      const control=vscode.scm.createSourceControl(`guthon-api-${key}`,`${key} · 谷神 API 源码`);
      control.guthonWorkspaceKey=key;
      if(this.quickDiff) control.quickDiffProvider=this.quickDiff;
      const group=control.createResourceGroup('changes','本地变更'); group.hideWhenEmpty=false; group.guthonWorkspaceKey=key;
      record={control,group};this.controls.set(key,record);
    }
    const changes=(state.files || []).filter(x=>x.inScope!==false && x.state !== 'CLEAN');
    const sourceChanges=new Map();
    const priority={CONFLICT:3,REMOTE_DELETED:2,MISSING:2,MODIFIED:1};
    for(const change of changes) {const parts=change.path.split('/');for(let i=1;i<=parts.length;i++){const p=parts.slice(0,i).join('/');if(!sourceChanges.has(p) || (priority[change.state] || 0)>(priority[sourceChanges.get(p)] || 0)) sourceChanges.set(p,change.state);}}
    this.sourceChanges.set(key,sourceChanges);
    record.group.resourceStates=changes.map(change=>{
      const uri=vscode.Uri.from({scheme:'guthon-api-change',authority:key,path:'/'+path.posix.basename(change.path),query:new URLSearchParams({path:change.path}).toString()});
      return {resourceUri:uri,contextValue:change.state==='CONFLICT' ? 'guthonApi.conflict' : change.readonly ? 'guthonApi.readonlyChange' : change.state==='MODIFIED' ? 'guthonApi.change' : 'guthonApi.unavailable',
        command:{command:'gushenCompletion.showApiDiff',title:'查看差异',arguments:[{workspaceKey:key,path:change.path}]},
        decorations:{tooltip:`${change.path} · ${change.state}`}};
    });
    record.control.count=changes.length; this.refresh();return state;
  }
  async diff(key, sourcePath) {
    const value=await this.run(key,'diff',{path:sourcePath});
    const left=await this.vscode.workspace.openTextDocument({content:value.before,language:'plaintext'});
    const right=await this.vscode.workspace.openTextDocument({content:value.after,language:'plaintext'});
    await this.vscode.commands.executeCommand('vscode.diff',left.uri,right.uri,`${sourcePath} · API 差异`);
  }
  async revert(key, sourcePaths) {
    const paths=[...new Set(Array.isArray(sourcePaths) ? sourcePaths : [sourcePaths])];
    if(!paths.length || paths.some(p=>!p)) throw new Error('请选择要还原的源码');
    const state=await this.status(key);assertClean(this.vscode,state.checkoutPath,paths);
    const expectedHashes={};
    for(const p of paths) {const current=await this.run(key,'read',{path:p});if(current.readonly) throw new Error(`只读源码不能还原：${p}`);expectedHashes[p]=current.sourceHash;}
    const answer=await this.vscode.window.showWarningMessage(`还原 ${paths.length} 个源码文件的本地修改？\n\n${paths.join('\n')}`,{modal:true},'还原');
    if(answer!=='还原') return;
    assertClean(this.vscode,state.checkoutPath,paths);await this.editorState?.flush(key);
    for(const p of paths) if((await this.run(key,'read',{path:p})).sourceHash!==expectedHashes[p]) throw new Error(`确认后源码已变化，请重新核对：${p}`);
    const results=[];let failure;
    for(const p of paths) {
      try {const result=await this.run(key,'revert',{path:p,expectedHash:expectedHashes[p]});results.push({path:p,stage:'LOCAL_WRITE_VERIFIED',operationId:result.operationId});}
      catch(error) {results.push({path:p,stage:'未确认或失败',message:error.message});failure=error;break;}
    }
    const done=new Set(results.map(x=>x.path));
    await showReport(this.vscode,'API 本地还原结果',[...results.map(x=>`- ${JSON.stringify(x.path)}：${x.stage}${x.operationId ? ` · ${x.operationId}` : ''}${x.message ? ` · ${x.message}` : ''}`),
      ...paths.filter(p=>!done.has(p)).map(p=>`- ${JSON.stringify(p)}：未执行`),'','如结果未确认，请先核对操作历史和本地文件。']);
    await this.updateScm(key);this.onUpdated?.();if(failure) throw failure;return results;
  }
  async upload(key, paths) {
    const state=await this.status(key);
    const chosen=paths?.length ? paths : (state.files || []).filter(x=>x.inScope!==false && x.state === 'MODIFIED' && !x.readonly).map(x=>x.path);
    if (!chosen.length) {await this.vscode.window.showInformationMessage('没有可上传的源码修改');return;}
    assertClean(this.vscode,state.checkoutPath,chosen);
    const expectedHashes={};
    for (const p of chosen) {const result=await this.run(key,'read',{path:p}); if(result.readonly) throw new Error(`只读源码不能上传：${p}`); expectedHashes[p]=result.sourceHash;}
    const answer=await this.vscode.window.showWarningMessage(`上传 ${chosen.length} 个本地源码文件到谷神？`,{modal:true},'上传');
    if (answer !== '上传') return;
    assertClean(this.vscode,state.checkoutPath,chosen);
    await this.editorState?.flush(key);
    for(const p of chosen) if((await this.run(key,'read',{path:p})).sourceHash!==expectedHashes[p]) throw new Error(`确认后源码已变化，请重新核对：${p}`);
    let result;
    try {result=await this.run(key,'upload',{paths:chosen,confirm:true,expectedHashes});}
    catch(error) {
      await showReport(this.vscode,'API 上传结果',['请求未取得完整回执，请先查看操作历史并核对平台状态，勿直接重试。', '', `错误：${error.message}`]);throw error;
    }
    const results=result.results || [], completed=new Set(results.map(x=>x.path));
    const lines=[`工作区：${key}`,`操作编号：${result.operationId || '未返回'}`,`总体状态：${result.stage || '未返回'}`,`完成：${result.complete===true ? '是' : '否'}`,'',
      ...results.map(x=>`- ${JSON.stringify(x.path)}：${x.stage || '未知'}${x.code ? `（${x.code}）` : ''}${x.message ? `：${x.message}` : ''}${x.sourceNormalized===true && x.stage==='REMOTE_READBACK_VERIFIED' ? '；平台已格式化或补全源码，回读结果已同步到本地源码' : ''}`),
      ...chosen.filter(p=>!completed.has(p)).map(p=>`- ${JSON.stringify(p)}：未执行`),
      '', 'REMOTE_READBACK_VERIFIED 表示对应文件已通过平台回读；UNKNOWN 表示结果未知，先查操作历史和平台，不自动重试。', '平台最终提交：未执行。'];
    await showReport(this.vscode,'API 上传结果',lines);
    await this.updateScm(key);this.onUpdated?.();return result;
  }
  async history(key) {
    const result=await this.run(key,'history',{limit:50});
    await showReport(this.vscode,'API 操作历史',[
      `工作区：${key}`, '', '以下是本地持久化的操作回执；UNKNOWN 或已应答但未回读的上传需要核对平台实际状态。', '',
      '```json',JSON.stringify(result.operations || [],null,2),'```']);
    const unknown=(result.operations || []).filter(needsUploadVerification);
    if(unknown.length && await this.vscode.window.showInformationMessage('发现上传结果尚未完成回读的操作，可通过平台核对。','选择核对')==='选择核对') await this.verifyUpload(key,unknown);
    return result;
  }
  async verifyUpload(key,operations) {
    if(!operations) {const history=await this.run(key,'history',{limit:50});operations=(history.operations || []).filter(needsUploadVerification);}
    if(!operations.length) return this.vscode.window.showInformationMessage('最近操作中没有需要核对的上传');
    const selected=await this.vscode.window.showQuickPick(operations.map(item=>({label:item.operationId,description:item.stage,detail:(item.paths || []).join('、'),operation:item})),{title:'选择要回读核对的上传'});
    if(!selected) return;
    const result=await this.run(key,'verify-upload',{operationId:selected.operation.operationId});
    await showReport(this.vscode,'上传回读核对',[`操作编号：${result.operationId || selected.operation.operationId}`,`状态：${result.stage || '未知'}`,`完成：${result.complete===true?'是':'否'}`,`重放上传：${result.mutationRetried===false?'否':'未确认'}`,'','```json',JSON.stringify(result.results || [],null,2),'```']);
    await this.updateScm(key);this.onUpdated?.();return result;
  }
  async exportChanges(key) {
    const state=await this.status(key);assertClean(this.vscode,state.checkoutPath);await this.editorState?.flush(key);
    const registered=this.editorState?.workspaces.get(key);
    if(registered && this.editorState.documents(key,registered).some(item=>item.dirty)) throw new Error('当前项目有未保存输入，请先保存后导出');
    const target=await this.vscode.window.showSaveDialog({title:'导出当前项目的本地修改',filters:{'修改包':['json']}});if(!target) return;
    const result=await this.run(key,'export-changes',{output:target.fsPath});
    await showReport(this.vscode,'API 修改包导出',[`文件：${result.path}`,`源码数：${result.fileCount}`,`修改包 SHA-256：${result.bundleHash}`,'','本次未上传谷神。']);return result;
  }
  async importChanges(key) {
    const state=await this.status(key);const selected=await this.vscode.window.showOpenDialog({title:'选择当前项目修改包',canSelectFiles:true,canSelectFolders:false,canSelectMany:false,filters:{'修改包':['json']}});
    if(!selected?.length) return;const input=selected[0].fsPath;
    const preview=await this.run(key,'import-changes',{input});
    await showReport(this.vscode,'API 修改包预览',['导入只修改本地源码；请先核对以下预览。','','```json',JSON.stringify(preview,null,2),'```']);
    if(preview.complete!==true || !preview.planHash) return;
    if(await this.vscode.window.showWarningMessage(`确认导入 ${preview.changes?.length || 0} 个本地源码修改？`,{modal:true},'确认导入')!=='确认导入') return;
    const paths=(preview.changes || []).map(item=>item.path);assertClean(this.vscode,state.checkoutPath,paths);await this.editorState?.flush(key);
    let result;
    try {result=await this.run(key,'import-changes',{input,apply:true,planHash:preview.planHash});}
    catch(error) {await showReport(this.vscode,'API 修改包导入结果',['未取得完整回执，请查看操作历史并核对本地文件，勿直接重试。','',`错误：${error.message}`]);throw error;}
    await showReport(this.vscode,'API 修改包导入结果',[`操作编号：${result.operationId || '未返回'}`,`状态：${result.stage || '未知'}`,`本地写入：${result.applied?.length || 0} 个`,'','本次未上传谷神。']);
    await this.updateScm(key);this.onUpdated?.();return result;
  }
  async systemMenu(key) {
    const result=await this.run(key,'system-menu');
    const doc=await this.vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(result.menu,null,2)});
    await this.vscode.window.showTextDocument(doc,{preview:true});return result;
  }
  async createFunction(key,sourcePath) {
    const source=await this.run(key,'read',{path:sourcePath});const meta=source.metadata || {};
    if(meta.sourceType!=='procedure' || !meta.procedureId || !meta.dataSourceId) throw new Error('请选择包含明确过程包和数据源的函数');
    const funId=await this.vscode.window.showInputBox({title:'新过程函数编码'});if(!funId) return;
    const funName=await this.vscode.window.showInputBox({title:'新过程函数名称'});if(!funName) return;
    const flags=await this.vscode.window.showQuickPick([{label:'使用事务',id:'isTran'},{label:'有返回值',id:'isReturn'}],{title:'选择函数属性',canPickMany:true});if(!flags)return;
    if(await this.vscode.window.showWarningMessage(`在过程包 ${meta.procedureId} 创建函数 ${funId}？此操作会修改开发平台。`,{modal:true},'创建')!=='创建') return;
    let result;
    try {result=await this.run(key,'create-function',{procedureId:String(meta.procedureId),dataSourceId:String(meta.dataSourceId),funId,funName,
      isTran:flags.some(x=>x.id==='isTran'),isReturn:flags.some(x=>x.id==='isReturn'),confirm:true});}
    catch(error) {await showReport(this.vscode,'创建函数结果',['未取得完整回执，请先查看操作历史并核对平台状态，勿直接重试。','',`错误：${error.message}`]);throw error;}
    await showReport(this.vscode,'创建函数结果',[`函数：${meta.procedureId}.${funId}`,`操作编号：${result.operationId || '未返回'}`,`平台状态：${result.stage || '未知'}`,'','仅 REMOTE_READBACK_VERIFIED 表示已回读平台对象。']);
    await this.updateScm(key);this.onUpdated?.();return result;
  }
  async syncDatabase(key,sourcePath) {
    const state=await this.status(key);assertClean(this.vscode,state.checkoutPath,[sourcePath]);
    const source=await this.run(key,'read',{path:sourcePath});
    if(!['table','view'].includes(source.metadata?.sourceType)) throw new Error('请选择表或视图源码');
    const answer=await this.vscode.window.showWarningMessage(`将 ${sourcePath} 的结构同步到开发数据库？此操作会执行数据库 DDL。`,{modal:true},'执行结构同步');
    if(answer!=='执行结构同步') return;
    assertClean(this.vscode,state.checkoutPath,[sourcePath]);await this.editorState?.flush(key);
    let result;
    try {result=await this.run(key,'sync-database',{path:sourcePath,confirm:true});}
    catch(error) {await showReport(this.vscode,'结构同步结果',['未取得完整回执，请查看操作历史并核对开发数据库，勿直接重试。','',`错误：${error.message}`]);throw error;}
    await showReport(this.vscode,'结构同步结果',[`对象：${sourcePath}`,`操作编号：${result.operationId || '未返回'}`,`平台状态：${result.stage || '未知'}`,`数据库独立验证：${result.databaseVerification || '未返回'}`,'','平台确认不代表数据库结构已独立验证。']);
    return result;
  }
  async resolveConflict(key,sourcePath) {
    const state=await this.status(key);assertClean(this.vscode,state.checkoutPath,[sourcePath]);
    const inspection=await this.run(key,'conflict',{path:sourcePath});
    const current=await this.run(key,'read',{path:sourcePath});
    if(current.sourceHash!==inspection.sourceHash) throw new Error('冲突源码已变化，请重新比较');
    if(inspection.path!==sourcePath || !inspection.sourceHash || !inspection.remoteHash || typeof inspection.local!=='string' || typeof inspection.remote!=='string') throw new Error('冲突检查未返回完整的来源和哈希，不能处理');
    const local=await this.vscode.workspace.openTextDocument({content:inspection.local,language:'plaintext'});
    const remote=await this.vscode.workspace.openTextDocument({content:inspection.remote,language:'plaintext'});
    await this.vscode.commands.executeCommand('vscode.diff',local.uri,remote.uri,`${sourcePath} · 本地 ↔ 平台冲突`);
    const choices=[
      ...(!current.readonly ? [{label:'保留本地内容',choice:'local',description:'以当前本地源码为解决结果，稍后自行上传'}] : []),
      {label:current.readonly ? '恢复平台原文' : '采用平台内容',choice:'remote',description:'以平台源码替换当前文件'},
    ];
    const choice=await this.vscode.window.showQuickPick(choices,{title:'选择冲突解决方式',
      placeHolder:current.readonly ? '只读继承源码仅可恢复平台原文' : '如需手工合并，先保存原文件，再重新检查冲突'});
    if(!choice) return;
    if(!choices.includes(choice)) throw new Error('冲突处理方式无效');
    if(await this.vscode.window.showWarningMessage(`确认对 ${sourcePath} 执行“${choice.label}”？`,{modal:true},'确认解决')!=='确认解决') return;
    assertClean(this.vscode,state.checkoutPath,[sourcePath]);await this.editorState?.flush(key);
    const latest=await this.run(key,'conflict',{path:sourcePath});
    if(latest.sourceHash!==inspection.sourceHash || latest.remoteHash!==inspection.remoteHash) throw new Error('确认期间冲突内容已变化，请重新比较');
    const result=await this.run(key,'resolve-conflict',{path:sourcePath,choice:choice.choice,expectedHash:inspection.sourceHash});
    await showReport(this.vscode,'API 冲突处理结果',[`对象：${sourcePath}`,`本地源码 SHA-256：${result.sourceHash || '未返回'}`,`操作编号：${result.operationId || '未返回'}`,'','此操作未上传谷神。']);
    await this.updateScm(key);this.onUpdated?.();return result;
  }
  clear(){for(const {control,refreshTimer} of this.controls.values()) {clearTimeout(refreshTimer);control.dispose();}this.controls.clear();this.sourceChanges.clear();for(const watcher of this.watchers.values()) watcher.dispose();this.watchers.clear();this.readonlyDocuments.clear();this.indexDiagnostics.clear();this.workspaces.clear();this.refresh();}
  dispose(){if(this.disposed)return;this.disposed=true;this.clear();this.emitter?.dispose();}
}
module.exports={ApiSourceUI,assertClean,dirtyDocuments,filePath,identity,showReport,sourceSyncLines};

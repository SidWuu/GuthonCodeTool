const path=require('node:path');
const crypto=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {filePath,assertClean}=require('./source-ui');

function designerHtml(url, auth) {
  const target=new URL(url);
  if (!['http:','https:'].includes(target.protocol) || target.username || target.password) throw new Error('设计器项目地址无效');
  const origin=target.origin;
  const frame=new URL(target.pathname.replace(/\/$/,'')+'/guthon/index.html#/dev-root',origin).toString();
  const nonce=crypto.randomBytes(18).toString('base64');
  const data=JSON.stringify(auth).replace(/</g,'\\u003c');
  const frameAttr=frame.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'"><style>html,body,iframe{width:100%;height:100%;margin:0;border:0}</style></head><body><iframe id="editor" src="${frameAttr}" title="谷神页面设计器"></iframe><script nonce="${nonce}">
const vscode=acquireVsCodeApi(), frame=document.getElementById('editor'), origin=${JSON.stringify(origin)}, auth=${data};
let documentMessage,ready=false,requested=false,stale=false;
function send(value){frame.contentWindow.postMessage(value,origin)}
function deliver(){if(ready&&requested&&documentMessage&&!stale)send(documentMessage)}
vscode.postMessage({type:'webview-ready'});
window.addEventListener('message',event=>{
 if(event.source===frame.contentWindow && event.origin===origin){const m=event.data;
  if(m?.type==='ready'){ready=true;send({type:'auth',authenticated:true,session:auth});deliver()}
  else if(m?.type==='init-document'){requested=true;deliver()}
  else if(m?.type==='save' && typeof m.text==='string' && documentMessage&&!stale) vscode.postMessage({type:'save',text:m.text,version:documentMessage.version,path:documentMessage.path});
 } else if(event.source!==frame.contentWindow && event.data?.type==='document'){documentMessage=event.data;deliver()}
 else if(event.source!==frame.contentWindow && event.data?.type==='saved-baseline' && documentMessage && event.data.path===documentMessage.path){documentMessage={...documentMessage,text:event.data.text,version:event.data.version}}
 else if(event.source!==frame.contentWindow && event.data?.type==='stale'){stale=true}
});</script></body></html>`;
}
function inheritedMembers(data,pointer='',result={}) {
  if(Array.isArray(data)) data.forEach((value,index)=>inheritedMembers(value,`${pointer}/${index}`,result));
  else if(data && typeof data==='object') for(const [key,value] of Object.entries(data)) {
    const child=`${pointer}/${key.replace(/~/g,'~0').replace(/\//g,'~1')}`;
    if(['superPageEvents','superServiceEvents','superScript'].includes(key)) result[child]=value;
    else inheritedMembers(value,child,result);
  }
  return result;
}
function validateDesignerBody(original,content,metadata) {
  let before,after;
  try {before=JSON.parse(original);after=JSON.parse(content);} catch {throw new Error('设计器返回的 PAGE 内容不是有效 JSON');}
  if(!before || !after || typeof before.pageId!=='string' || after.pageId!==before.pageId
    || (metadata?.pageId != null && String(metadata.pageId)!==before.pageId)) throw new Error('设计器返回的 PAGE 身份不匹配');
  if(!isDeepStrictEqual(inheritedMembers(before),inheritedMembers(after))) throw new Error('设计器修改了只读继承源码，请先核对');
}
function openDesigner(options) {
  const {key,sourcePath,panels,vscode}=options;
  if(!panels) return createDesigner(options);
  const id=JSON.stringify([key,sourcePath]), existing=panels.get(id);
  if(existing) return existing.pending.then(panel=>{
    if(panel) {
      panel.reveal();
      if(existing.stale) void vscode.window.showWarningMessage('页面源码已变化，当前设计器输入保留；请核对后关闭并重新打开');
    }
    return panel;
  });
  const entry={stale:false};
  entry.pending=createDesigner({...options,markStale:()=>{entry.stale=true;},onDisposed:()=>{if(panels.get(id)===entry) panels.delete(id);}});
  panels.set(id,entry);
  void entry.pending.then(panel=>{if(!panel && panels.get(id)===entry) panels.delete(id);},()=>{if(panels.get(id)===entry) panels.delete(id);});
  return entry.pending;
}
async function createDesigner({vscode,run,ui,key,sourcePath,onUpdated,editorState,ensureWorkspace,onDisposed,markStale}) {
  const workspacePromise=ensureWorkspace ? ensureWorkspace(key) : ui.ensureWorkspace(key);
  const readPromise=run(key,'read',{path:sourcePath});
  const sessionPromise=run(key,'designer-context').then(value=>({value}),error=>({error}));
  const [state,source]=await Promise.all([workspacePromise,readPromise]);
  let initial=source;
  assertClean(vscode,state.checkoutPath,[sourcePath]);
  if(initial.metadata?.sourceType && initial.metadata.sourceType !== 'page') throw new Error('请选择可编辑的页面源码');
  let unsupported=['METADATA_ONLY','IDENTITY_MISMATCH'].includes(initial.contentState);
  if(!unsupported && !initial.content.trimStart().startsWith('<')) {
    try {validateDesignerBody(initial.content,initial.content,initial.metadata);} catch {unsupported=true;}
  }
  if(unsupported) {await ui.openReadonly(key,sourcePath,initial.content);return;}
  if(initial.readonly || initial.projectionReadonly) throw new Error('请选择可编辑的页面源码');
  const uri=vscode.Uri.file(filePath(state.checkoutPath,sourcePath));
  const document=await vscode.workspace.openTextDocument(uri);
  let version=document.version;
  if(document.isDirty || document.getText()!==initial.content) throw new Error('编辑器内容与磁盘不一致，请先处理后重试');
  const sessionResult=await sessionPromise;if(sessionResult.error) throw sessionResult.error;
  const session=sessionResult.value;
  const html=designerHtml(session.rootUrl,{accessToken:session.accessToken,user:session.user});
  editorState?.assertNoConflictingDrafts(key,sourcePath);
  editorState?.assertNoDirtyDocumentsExcept(key,sourcePath);
  const draftId=Symbol('online-designer');
  try {await editorState?.setDraft(draftId,key,sourcePath,true,document.version,'online');}
  catch(error) {void editorState?.setDraft(draftId,key,sourcePath,false,document.version).catch(()=>{});throw error;}
  if(document.isDirty || document.version!==version || document.getText()!==initial.content) {await editorState?.setDraft(draftId,key,sourcePath,false,document.version);throw new Error('编辑器内容与磁盘不一致，请先处理后重试');}
  let panel;
  try {panel=vscode.window.createWebviewPanel('guthonApiDesigner',`谷神页面设计器 · ${path.posix.basename(sourcePath)}`,vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true});}
  catch(error) {void editorState?.setDraft(draftId,key,sourcePath,false,document.version).catch(()=>{});throw error;}
  panel.webview.html=html;
  let stale=false, saving=false, busy=false, expectedSave;
  const uriString=uri.toString();
  const send=()=>panel.webview.postMessage({type:'document',fileName:uri.fsPath,text:initial.content,version,path:sourcePath});
  const updateBaseline=()=>panel.webview.postMessage({type:'saved-baseline',text:initial.content,version,path:sourcePath});
  const changed=vscode.workspace.onDidChangeTextDocument(event=>{
    if(event.document.uri.toString()!==uriString) return;
    if(!document.isDirty && document.getText()===(saving ? expectedSave : initial.content)) {
      version=document.version;if(!saving) void updateBaseline();return;
    }
    stale=true;markStale?.();panel.webview.postMessage({type:'stale'});
  });
  const receiver=panel.webview.onDidReceiveMessage(async message=>{
    if(message?.type==='webview-ready') {await send();return;}
    if(message?.type!=='save') return;
    if(busy) {await vscode.window.showErrorMessage('页面设计器：正在处理上一次保存');return;}
    busy=true;
    try {
      if(stale || message.path!==sourcePath || message.version!==version || document.version!==version || document.isDirty) throw new Error('页面文件或编辑器已变化，请重新打开设计器');
      let payload; try {payload=JSON.parse(message.text);} catch {throw new Error('设计器返回的页面数据无效');}
      if(!payload || typeof payload.xml!=='string' || (payload.fileName && payload.fileName!==path.posix.basename(sourcePath))) throw new Error('设计器返回的目标文件身份不匹配');
      if(typeof payload.superScript==='string') {
        const name=payload.superFileName;
        if(!name || name!==path.posix.basename(name)) throw new Error('设计器返回的继承文件身份无效');
        const sibling=path.posix.join(path.posix.dirname(sourcePath),name);
        const original=await run(key,'read',{path:sibling});
        if(original.content!==payload.superScript) throw new Error('设计器更改了继承文件，请先在源码编辑器处理');
      }
      const originalXml=initial.content.trimStart().startsWith('<'), candidateXml=payload.xml.trimStart().startsWith('<');
      if(originalXml!==candidateXml) throw new Error('设计器返回的 PAGE 格式与原文件不一致');
      if(originalXml) {
        const validation=await run(key,'page',{action:'validate',path:sourcePath,content:payload.xml,expectedHash:initial.sourceHash});
        if(validation.valid!==true || validation.sourceHash!==initial.sourceHash || validation.inheritedUnchanged!==true
          || String(validation.pageId || '')!==String(initial.metadata?.pageId || '')) throw new Error('后端未确认 PAGE 身份或只读继承内容，未保存');
      } else validateDesignerBody(initial.content,payload.xml,initial.metadata);
      const current=await run(key,'read',{path:sourcePath});
      if(current.sourceHash!==initial.sourceHash || current.content!==initial.content || document.isDirty || document.version!==version || stale) throw new Error('页面源码已变化，请重新打开设计器');
      editorState?.assertNoConflictingDrafts(key,sourcePath,['online']);
      editorState?.assertNoDirtyDocumentsExcept(key,sourcePath);
      const editorToken=await editorState.flush(key);
      if(document.isDirty || document.version!==version || stale) throw new Error('页面源码已变化，请重新打开设计器');
      editorState?.assertNoConflictingDrafts(key,sourcePath,['online']);
      editorState?.assertNoDirtyDocumentsExcept(key,sourcePath);
      saving=true;expectedSave=payload.xml;
      const expectedHash=crypto.createHash('sha256').update(payload.xml,'utf8').digest('hex');
      const written=await run(key,'write',{path:sourcePath,content:payload.xml,expectedHash:initial.sourceHash,editorToken});
      const verified=await run(key,'read',{path:sourcePath});
      if(written.sourceHash!==expectedHash || verified.sourceHash!==expectedHash || verified.content!==payload.xml) throw new Error('本地写入回读不一致，请先核对操作历史');
      initial={...initial,content:verified.content,sourceHash:verified.sourceHash};
      if(document.isDirty || stale) throw new Error('保存期间编辑器发生其他修改，请先比较当前源码');
      version=document.version;await updateBaseline();
      try {await ui.updateScm(key);onUpdated?.();} catch(error) {await vscode.window.showWarningMessage(`页面已保存，但源码管理刷新失败：${error.message}`);}
      await vscode.window.showInformationMessage('页面已保存并回读，可继续编辑；确认没有后续修改并关闭页面编辑器后，再从源码管理上传');

    } catch(error){
      if(saving) {stale=true;markStale?.();await panel.webview.postMessage({type:'stale'});await vscode.window.showErrorMessage(`页面保存结果未确认，请先查看操作历史和源码，勿直接重试：${error.message}`);}
      else await vscode.window.showErrorMessage(`页面设计器：${error.message}`);
    } finally {saving=false;busy=false;}
  });
  panel.onDidDispose(()=>{onDisposed?.();changed.dispose();receiver.dispose();void editorState?.setDraft(draftId,key,sourcePath,false,document.version).catch(error=>vscode.window.showErrorMessage(error.message));});
  return panel;
}
module.exports={designerHtml,openDesigner,validateDesignerBody};

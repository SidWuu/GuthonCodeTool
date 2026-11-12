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
async function openDesigner({vscode,run,ui,key,sourcePath,onUpdated,editorState}) {
  const state=await ui.status(key); assertClean(vscode,state.checkoutPath,[sourcePath]);
  const initial=await run(key,'read',{path:sourcePath});
  if(initial.readonly || initial.metadata?.sourceType && initial.metadata.sourceType !== 'page') throw new Error('请选择可编辑的页面源码');
  const uri=vscode.Uri.file(filePath(state.checkoutPath,sourcePath));
  const document=await vscode.workspace.openTextDocument(uri);
  if(document.isDirty || document.getText()!==initial.content) throw new Error('编辑器内容与磁盘不一致，请先处理后重试');
  const session=await run(key,'designer-context');
  const html=designerHtml(session.rootUrl,{accessToken:session.accessToken,user:session.user});
  editorState?.assertNoConflictingDrafts(key,sourcePath);
  editorState?.assertNoDirtyDocumentsExcept(key,sourcePath);
  const draftId=Symbol('online-designer');
  try {await editorState?.setDraft(draftId,key,sourcePath,true,document.version,'online');}
  catch(error) {void editorState?.setDraft(draftId,key,sourcePath,false,document.version).catch(()=>{});throw error;}
  let panel;
  try {panel=vscode.window.createWebviewPanel('guthonApiDesigner',`谷神页面设计器 · ${path.posix.basename(sourcePath)}`,vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true});}
  catch(error) {void editorState?.setDraft(draftId,key,sourcePath,false,document.version).catch(()=>{});throw error;}
  panel.webview.html=html;
  let stale=false, saving=false;
  const version=document.version, uriString=uri.toString();
  const send=()=>panel.webview.postMessage({type:'document',fileName:uri.fsPath,text:initial.content,version,path:sourcePath});
  const changed=vscode.workspace.onDidChangeTextDocument(event=>{
    if(event.document.uri.toString()===uriString && !saving){stale=true;panel.webview.postMessage({type:'stale'});}
  });
  const receiver=panel.webview.onDidReceiveMessage(async message=>{
    if(message?.type==='webview-ready') {await send();return;}
    if(message?.type!=='save') return;
    try {
      if(saving || stale || message.path!==sourcePath || message.version!==version || document.version!==version || document.isDirty) throw new Error('页面文件或编辑器已变化，请重新打开设计器');
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
      saving=true;
      const expectedHash=crypto.createHash('sha256').update(payload.xml,'utf8').digest('hex');
      const written=await run(key,'write',{path:sourcePath,content:payload.xml,expectedHash:initial.sourceHash,editorToken});
      const verified=await run(key,'read',{path:sourcePath});
      if(written.sourceHash!==expectedHash || verified.sourceHash!==expectedHash || verified.content!==payload.xml) throw new Error('本地写入回读不一致，请先核对操作历史');
      stale=true;await panel.webview.postMessage({type:'stale'});
      try {await ui.updateScm(key);onUpdated?.();} catch(error) {await vscode.window.showWarningMessage(`页面已保存，但源码管理刷新失败：${error.message}`);}
      if(document.isDirty || document.version!==version) await vscode.window.showWarningMessage('页面已保存到本地；原文件编辑器已有变化，请比较后处理，未覆盖编辑器输入');
      else await vscode.window.showInformationMessage('页面已保存并回读；原文件将由编辑器重新载入，上传谷神请使用源码管理上传');

    } catch(error){
      if(saving) {stale=true;await panel.webview.postMessage({type:'stale'});await vscode.window.showErrorMessage(`页面保存结果未确认，请先查看操作历史和源码，勿直接重试：${error.message}`);}
      else await vscode.window.showErrorMessage(`页面设计器：${error.message}`);
    } finally {saving=false;}
  });
  panel.onDidDispose(()=>{changed.dispose();receiver.dispose();void editorState?.setDraft(draftId,key,sourcePath,false,document.version).catch(error=>vscode.window.showErrorMessage(error.message));});
  return panel;
}
module.exports={designerHtml,openDesigner,validateDesignerBody};

const path=require('node:path');
const {decodeIdentity,SCHEME}=require('../source/virtual-fs');

class ApiEditorState {
  constructor({vscode,run,onError=()=>{}}) {
    Object.assign(this,{vscode,run,onError});this.workspaces=new Map();this.drafts=new Map();this.registrations=[];this.closed=false;
    for(const name of ['onDidChangeTextDocument','onDidOpenTextDocument','onDidSaveTextDocument','onDidCloseTextDocument']) {
      const subscribe=vscode.workspace[name];
      if(subscribe) this.registrations.push(subscribe(event=>{
        const doc=event.document || event;
        // Close events can arrive before the document list has been updated.
        if(name==='onDidCloseTextDocument') queueMicrotask(()=>this.changed(doc));else this.changed(doc);
      }));
    }
  }
  add(key,root) {
    let state=this.workspaces.get(key);
    if(!state) {state={root:path.resolve(root),token:undefined,tail:Promise.resolve()};this.workspaces.set(key,state);}
    else state.root=path.resolve(root);
    return this.flush(key);
  }
  documentPath(key,state,doc) {
    if(doc.uri.scheme===SCHEME) {
      const id=decodeIdentity(doc.uri);return id.workspaceKey===key ? id.sourcePath : '';
    }
    if(doc.uri.scheme!=='file') return '';
    const relative=path.relative(state.root,path.resolve(doc.uri.fsPath));
    return relative && relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : '';
  }
  documents(key,state) {
    const items=new Map();
    for(const doc of this.vscode.workspace.textDocuments || []) {
      const p=this.documentPath(key,state,doc);if(!p) continue;
      const previous=items.get(p);items.set(p,{path:p,dirty:!!doc.isDirty || !!previous?.dirty,version:Math.max(Number(doc.version)||0,previous?.version||0)});
    }
    for(const draft of this.drafts.values()) if(draft.key===key) {
      const old=items.get(draft.path);items.set(draft.path,{path:draft.path,dirty:!!draft.dirty || !!old?.dirty,version:Math.max(Number(draft.version)||0,old?.version||0)});
    }
    return [...items.values()].sort((a,b)=>a.path.localeCompare(b.path));
  }
  changed(doc) {
    for(const [key,state] of this.workspaces) if(this.documentPath(key,state,doc)) this.flush(key).catch(this.onError);
  }
  setDraft(id,key,sourcePath,dirty,version,kind='page') {
    if(dirty) this.drafts.set(id,{key,path:sourcePath,dirty:true,version,kind});else this.drafts.delete(id);
    return this.workspaces.has(key) ? this.flush(key) : Promise.resolve();
  }
  assertNoConflictingDrafts(key,sourcePath,allowedKinds=[]) {
    for(const draft of this.drafts.values()) if(draft.key===key && draft.path===sourcePath && draft.dirty && !allowedKinds.includes(draft.kind))
      throw new Error('该源码的另一个设计器有未保存输入，请先保存或关闭');
  }
  assertNoDirtyDocumentsExcept(key,sourcePath,uri) {
    const state=this.workspaces.get(key);
    if(!state) throw new Error('API 编辑状态尚未初始化');
    if((this.vscode.workspace.textDocuments || []).some(doc=>doc.isDirty && this.documentPath(key,state,doc)===sourcePath && (!uri || doc.uri.toString()!==uri.toString())))
      throw new Error('此源码的其他编辑器有未保存输入');
  }
  flush(key) {
    const state=this.workspaces.get(key);if(!state) return Promise.reject(new Error('API 编辑状态尚未初始化'));
    if(this.closed) return Promise.reject(new Error('API 编辑状态已关闭'));
    const task=state.tail.catch(()=>{}).then(async()=>{
      const payload={pid:process.pid,documents:this.documents(key,state),...(state.token ? {editorToken:state.token} : {})};
      const result=await this.run(key,'editor-state',payload);
      if(!state.token && (!result.editorToken || typeof result.editorToken!=='string')) throw new Error('后端未返回编辑器登记令牌');
      if(result.editorToken && state.token && result.editorToken!==state.token) throw new Error('后端编辑器令牌不一致');
      state.token ||= result.editorToken;return state.token;
    });
    state.tail=task;return task;
  }
  async reset() {
    for(const [key,state] of this.workspaces) {
      await this.flush(key);
      if(this.documents(key,state).some(item=>item.dirty)) throw new Error('存在未保存的 API 源码或页面草稿，请先处理');
    }
    for(const [key,state] of this.workspaces) if(state.token) await this.run(key,'editor-state',{pid:process.pid,documents:[],editorToken:state.token,close:true});
    this.workspaces.clear();this.drafts.clear();
  }
  close() {
    if(this.closing) return this.closing;
    this.closed=true;this.registrations.forEach(x=>x.dispose());
    this.closing=this.closeRegistrations();return this.closing;
  }
  async closeRegistrations() {
    const results=await Promise.allSettled([...this.workspaces].map(async([key,state])=>{
      await state.tail.catch(()=>{});
      if(state.token) await this.run(key,'editor-state',{pid:process.pid,documents:[],editorToken:state.token,close:true});
    }));
    this.workspaces.clear();this.drafts.clear();
    const failed=results.find(x=>x.status==='rejected');if(failed) throw failed.reason;
  }
  dispose(){void this.close().catch(this.onError);}
}
module.exports={ApiEditorState};

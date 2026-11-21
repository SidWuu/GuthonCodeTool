const crypto=require('node:crypto');
const {decodeIdentity,SCHEME}=require('../source/virtual-fs');

function moduleParameterSelector(value) {
  const fields=value?.moduleParameter || value?.object?.referenceFields;
  if(!fields?.snapshotPath)return;
  return {systemId:fields.systemId,configId:fields.configId,snapshotPath:fields.snapshotPath};
}

class ModuleParameterEditor {
  constructor(options){Object.assign(this,options);}
  async open(key,path,selector){
    await this.ui.ensureWorkspace(key);
    if(selector) {
      path=selector.snapshotPath;
      const opened=this.vscode.workspace.textDocuments.find(doc=>{
        if(doc.uri.scheme!==SCHEME)return false;
        const id=decodeIdentity(doc.uri);
        return id.workspaceKey===key && id.sourcePath===path && id.sourceType==='module-parameter';
      });
      if(opened)return this.vscode.window.showTextDocument(opened,{preview:false});
      this.loads ||= new Map();
      const identity=JSON.stringify([key,selector.systemId,selector.configId]);
      if(this.loads.has(identity))return this.loads.get(identity);
      const pending=(async()=>{
        await this.editorState.flush(key);
        const result=await this.run(key,'module-parameter-load',{systemId:selector.systemId,configId:selector.configId});
        if(result.index)this.ui.setIndexResult(key,result.index);
        await this.ui.updateScm(key);this.onUpdated?.();
        if(!result.complete || result.path!==path)throw new Error('模块参数详情加载未完成，请先检查冲突或索引诊断');
        return this.virtualFs.openEditor({workspaceKey:key,sourcePath:path,sourceType:'module-parameter',jsonPointer:'/data',fragmentType:'json'});
      })();
      this.loads.set(identity,pending);
      try{return await pending;}finally{this.loads.delete(identity);}
    }
    return this.virtualFs.openEditor({workspaceKey:key,sourcePath:path,sourceType:'module-parameter',jsonPointer:'/data',fragmentType:'json'});
  }
  async preview(key,path,selector){
    path=selector?.snapshotPath || path;
    let editor=this.vscode.window.activeTextEditor;
    const identity=editor?.document.uri.scheme===SCHEME ? decodeIdentity(editor.document.uri) : undefined;
    if(identity?.sourceType!=='module-parameter' || identity.workspaceKey!==key || identity.sourcePath!==path)editor=await this.open(key,path,selector);
    const preview=await this.virtualFs.previewProjection(editor.document.uri,editor.document.getText());
    const id=crypto.randomUUID(),before=this.ui.readonlyUri(key,`module-preview/${id}/平台基线.json`,preview.beforeContent),after=this.ui.readonlyUri(key,`module-preview/${id}/当前输入.json`,preview.afterContent);
    await this.vscode.commands.executeCommand('vscode.diff',before,after,'模块参数 · 本地差异预览');
    return preview;
  }
  async upload(key,paths,selector){
    if(selector) {
      const status=await this.ui.status(key);
      paths=status.files.filter(item=>item.path===selector.snapshotPath && item.inScope!==false && item.state==='MODIFIED' && !item.readonly).map(item=>item.path);
      if(!paths.length)return this.vscode.window.showInformationMessage('此模块参数没有待上传修改，请先打开参数并编辑保存');
    }
    const state=await this.ui.status(key);
    const chosen=paths?.length ? paths : state.files.filter(item=>item.inScope!==false&&item.state==='MODIFIED'&&item.sourceType==='module-parameter'&&!item.readonly).map(item=>item.path);
    if(!chosen.length)return this.vscode.window.showInformationMessage('没有待上传的模块参数修改');
    await this.editorState.flush(key);
    const plan=await this.run(key,'module-upload',{action:'preview',paths:chosen});
    const lines=['# 模块参数上传预览','',`项目：${key}`,'仅保存参数内容；需要时普通签出，不强制覆盖、不自动签入。',''];
    for(const item of plan.items)lines.push(`## ${item.systemId} / ${item.configId}`,item.name,
      item.alreadyRemote?'平台内容已经一致，不重复保存。':item.checkoutRequired?'本次需签出后保存。':'当前用户已签出，核对后保存。',
      '```diff',item.diff,'```',...(item.diffTruncated?['差异较长，以上内容已截断；请先通过参数差异预览或源代码管理核对完整修改。']:[]),'');
    const id=crypto.randomUUID();await this.ui.openReadonly(key,`module-upload/${id}/上传预览.md`,lines.join('\n'));
    const answer=await this.vscode.window.showWarningMessage(`请核对已打开的 ${chosen.length} 个模块参数差异，确认后上传（不签入）。`,{modal:false},'确认上传','取消');
    if(answer!=='确认上传')return;
    await this.editorState.flush(key);
    let result;
    try {result=await this.run(key,'module-upload',{action:'upload',planId:plan.planId,planHash:plan.planHash,confirm:true});}
    catch(error) {
      const rejectedBeforeUpload=['API_SOURCE_STALE','API_EDITOR_DIRTY','API_MODULE_REMOTE_CHANGED','API_MODULE_UPLOAD_PLAN_MISMATCH','API_MODULE_UPLOAD_PENDING','API_LOGIN_REQUIRED'];
      if(rejectedBeforeUpload.includes(error.code))throw error;
      await this.ui.openReadonly(key,`module-upload/${plan.planId}/待核对.md`,
        `# 模块参数上传待核对\n\n操作编号：${plan.planId}\n\n请求未取得完整回执，请从操作记录核对实际结果，不直接重试。\n\n${error.message}`);
      throw error;
    }
    await this.report(key,result);return result;
  }
  async report(key,result){
    const lines=['# 模块参数上传结果','',`操作编号：${result.operationId}`,`状态：${result.stage}`,
      ...result.results.map(item=>`- ${item.path}：${item.stage}${item.message?' · '+item.message:''}`),'',
      '保存结果未知时，只核对原操作，不重新发送。平台最终签入：未执行。'];
    await this.ui.openReadonly(key,`module-upload/${result.operationId}/结果.md`,lines.join('\n'));
    if(result.index)this.ui.setIndexResult(key,result.index);
    await this.ui.updateScm(key);this.onUpdated?.();
  }
}
module.exports={ModuleParameterEditor,moduleParameterSelector};

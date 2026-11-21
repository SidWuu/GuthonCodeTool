const path=require('node:path');
const VIEW_TYPE='guthon.apiPageEditor';

async function registeredPage(ui,document) {
  if(document.uri.scheme!=='file')throw new Error('请选择当前项目的物理 PAGE 文件');
  for(const key of ui.workspaces.keys()) {
    const workspace=await ui.ensureWorkspace(key);
    const relative=path.relative(workspace.checkoutPath,document.uri.fsPath).split(path.sep).join('/');
    if(!relative || relative==='..' || relative.startsWith('../') || path.isAbsolute(relative))continue;
    const source=await ui.run(key,'read',{path:relative});
    if(source.metadata?.sourceType!=='page' || /\.gss$/i.test(relative)
        || ((source.readonly || source.projectionReadonly) && source.metadata.pageSource!=='batch-export')) {
      throw new Error('此对象不可作为结构化 PAGE 编辑，请使用原始源码入口');
    }
    return {workspaceKey:key,sourceType:'page',sourcePath:relative,sourceId:source.metadata.pageId,sourceName:source.name,
      pendingNative:source.metadata.pageSource==='batch-export'};
  }
  throw new Error('文件不属于当前窗口已登记的 API 项目');
}
function registerPageEditor({vscode,context,ui,getController}) {
  const provider={async resolveCustomTextEditor(document,panel) {
    if(document.isDirty)throw new Error('PAGE 原文有未保存输入，请先保存或保留');
    return getController().open(await registeredPage(ui,document),panel);
  }};
  const registrations=[vscode.window.registerCustomEditorProvider(VIEW_TYPE,provider,{supportsMultipleEditorsPerDocument:false,webviewOptions:{retainContextWhenHidden:true}}),
    vscode.commands.registerCommand('gushenCompletion.openApiPageFile',async uri=>{
      try {
        uri ||= vscode.window.activeTextEditor?.document.uri;
        if (!uri) throw new Error('请选择当前项目的物理 PAGE 文件');
        const document = await vscode.workspace.openTextDocument(uri);
        if(document.isDirty)throw new Error('PAGE 原文有未保存输入，请先保存或保留');
        const identity = await registeredPage(ui,document);
        if(identity.pendingNative) await ui.preparePageForEditing(identity.workspaceKey,identity.sourcePath);
        return await vscode.commands.executeCommand('vscode.openWith',uri,VIEW_TYPE);
      } catch(error) { return vscode.window.showErrorMessage(`无法编辑 PAGE：${error.message}`); }
    })];
  context.subscriptions.push(...registrations);return provider;
}
module.exports={VIEW_TYPE,registeredPage,registerPageEditor};

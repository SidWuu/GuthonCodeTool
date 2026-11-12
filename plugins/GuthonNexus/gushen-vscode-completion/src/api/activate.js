const {ToolJsonClient} = require('../tool-json-client');
const {ToolProcessClient} = require('../tool-process-client');
const {ApiSourceUI,assertClean,identity,showReport,sourceSyncLines,filePath} = require('./source-ui');
const {openDesigner} = require('./designer');
const {ApiEditorState} = require('./editor-state');
const {openProjectWorkspace} = require('./project-workspace');
const {ApiSourceWatcher} = require('./source-watcher');
const {ApiPageVirtualFs,SCHEME,uriFor,isInlineInherited}=require('../source/virtual-fs');
const {InheritanceDecorations}=require('../source/inheritance-decoration');
const {PageEditorController} = require('../page-editor/controller');
const {DIFF_SCHEME,ApiQuickDiff,revertQuickDiffChange}=require('../source/quick-diff');
const {checkOfficialUpdate,rollbackOfficialUpdate} = require('../official-update');

function activateApi({vscode, context, getTool, processClient, onUpdated}) {
  const client = new ToolJsonClient({getTool,processClient,outputLabel:'谷神 API'});
  // Editor coordination must remain responsive while the primary write lane is pulling or indexing.
  const stateProcessClient = new ToolProcessClient();
  const stateClient = new ToolJsonClient({getTool,processClient:stateProcessClient,outputLabel:'谷神 API 编辑状态'});
  const run = async (key,action,input) => {
    if(action==='status') input={...input,changesOnly:true};
    try {return await client.run(key,'api',[action,...(input === undefined ? []:['--stdin'])],input);}
    catch(error) {if(error.code==='API_LOGIN_REQUIRED' && !['session','status'].includes(action)) onUpdated?.();throw error;}
  };
  const editorState = new ApiEditorState({vscode,run:(key,_action,input)=>stateClient.run(key,'api',['editor-state','--stdin'],input),onError:error=>vscode.window.showErrorMessage(`编辑状态登记失败：${error.message}`)});
  let closingEditorState;
  const closeEditorState=()=>closingEditorState ||= editorState.close().finally(()=>stateProcessClient.dispose());
  let pageEditor,virtualFs,virtualRegistration,sourceWatcher,selectWorkspace,inheritanceDecorations;
  const ui = new ApiSourceUI({vscode,run,onUpdated,editorState,onWorkspace:(key,root)=>sourceWatcher.register(key,root),indexRecovery:key=>sourceWatcher.recovery(key),onOpenVirtual:async identity=>{getPageEditor();return virtualFs.open(identity);},onSourceChanged:async(key,paths)=>{
    try {virtualFs?.invalidate(key,paths);for(const p of paths) sourceWatcher.enqueue(key,p);await pageEditor?.sourceChanged(key,paths);} catch(error) {await vscode.window.showErrorMessage(`PAGE 更新核对失败：${error.message}`);}
  }});
  const quickDiff=new ApiQuickDiff({vscode,run,editorState,ui,projectBase:(uri,text)=>virtualFs?.projectBase(uri,text),viewBase:(uri,diff)=>virtualFs?.viewBase(uri,diff)});ui.quickDiff=quickDiff;
  sourceWatcher=new ApiSourceWatcher({run,workspaceState:context.workspaceState,onChanged:async (key,paths,result)=>{ui.setIndexResult(key,result);await ui.updateScm(key);await pageEditor?.statusChanged(key);onUpdated?.();},onError:(key,error)=>{ui.refresh();vscode.window.showErrorMessage(`源码索引更新失败（${key}）：${error.message}；可重试待更新文件`);}});
  function getPageEditor() {
    if (pageEditor) return pageEditor;
    virtualFs=new ApiPageVirtualFs({vscode,run,editorState,onWillSave:uri=>pageEditor.beforeCodeSave(uri),
      onOpened:editor=>inheritanceDecorations?.render(editor),onInvalidated:()=>inheritanceDecorations?.refresh(),
      onSaved:async uri=>{try {const id=require('../source/virtual-fs').decodeIdentity(uri);await ui.updateScm(id.workspaceKey);onUpdated?.();} catch(error) {await vscode.window.showErrorMessage(`SCM 刷新失败：${error.message}`);}}});
    inheritanceDecorations=new InheritanceDecorations(vscode,virtualFs);
    virtualRegistration=vscode.workspace.registerFileSystemProvider(SCHEME,virtualFs,{isCaseSensitive:true});
    context.subscriptions.push(virtualRegistration,virtualFs,inheritanceDecorations);
    pageEditor=new PageEditorController({vscode,context,getTool,virtualFs,
      backend:{run},
      ownsDocument:(identity,doc)=>{const state=editorState.workspaces.get(identity.workspaceKey);return !!state && editorState.documentPath(identity.workspaceKey,state,doc)===identity.sourcePath;},
      onDraftChanged:(identity,dirty,version)=>editorState.setDraft(`page:${identity.workspaceKey}:${identity.sourcePath}`,identity.workspaceKey,identity.sourcePath,dirty,version),
      editorToken:key=>editorState.flush(key),
      assertCanSave:identity=>editorState.assertNoConflictingDrafts(identity.workspaceKey,identity.sourcePath,['page']),
      onSaved:async(key)=>{await ui.updateScm(key);onUpdated?.();}});
    context.subscriptions.push(pageEditor);return pageEditor;
  }
  const handlers = {
    configureApiSource: async key => {
      const current = await run(key,'status');
      const serverUrl = await vscode.window.showInputBox({title:'谷神 API 项目地址',value:current.settings.serverUrl,
        prompt:'例如 https://project.example.com，不包含账号或密码'});
      if (serverUrl === undefined) return;
      await run(key,'configure',{serverUrl});onUpdated?.();
    },
    loginApiSource: async key => {
      const userId = await vscode.window.showInputBox({title:'谷神平台登录账号'});
      if (!userId) return;
      const password = await vscode.window.showInputBox({title:'谷神平台密码',password:true});
      if (password === undefined) return;
      const captcha=await run(key,'captcha');
      let randCode='';
      if (captcha.dataURL) {
        if (!/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(captcha.dataURL)) throw new Error('验证码图片格式无效');
        const panel=vscode.window.createWebviewPanel('guthonApiCaptcha','谷神登录验证码',vscode.ViewColumn.Active,{enableScripts:false});
        panel.webview.html=`<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:"></head><body><img alt="登录验证码" src="${captcha.dataURL}"></body></html>`;
        try {randCode=await vscode.window.showInputBox({title:'输入验证码',prompt:'请查看打开的验证码图片'});} finally {panel.dispose();}
        if (randCode === undefined) return;
      }
      const choice=await vscode.window.showQuickPick([{label:'仅本次登录',remember:false},{label:'记住账号和密码',remember:true}],{title:'登录信息保存方式'});
      if (!choice) return;
      await run(key,'login',{userId,password,randCode,remember:choice.remember});
      ui.track(key);ui.refresh();onUpdated?.();
      await vscode.window.showInformationMessage('谷神 API 登录成功');
    },
    selectApiSystems: async key => {
      const result = await run(key,'systems');
      const current = await run(key,'status');
      const items = [{label:'全部子系统',description:'明确选择后才拉取全部',systemId:'*',picked:current.settings.allSystems},
        ...result.systems.map(s=>({label:s.systemName || s.systemId,description:s.systemId,systemId:s.systemId,picked:current.settings.systemIds.includes(s.systemId)}))];
      const selected = await vscode.window.showQuickPick(items,{title:'选择当前项目需要拉取的子系统',canPickMany:true});
      if (!selected) return;
      const all = selected.some(x=>x.systemId==='*');
      if (all && selected.length!==1) throw new Error('全部子系统不能与指定子系统同时选择');
      const selectedIds = all ? result.systems.map(x=>x.systemId) : selected.map(x=>x.systemId);
      const related = new Set(result.systems.filter(x=>selectedIds.includes(x.systemId)).map(x=>x.dataSourceId).filter(Boolean));
      const sources = await run(key,'data-sources');
      const extraItems = sources.dataSources.filter(x=>!related.has(x.dataSourceId)).map(x=>({
        label:x.dataSourceName || x.dataSourceId,description:x.dataSourceId,dataSourceId:x.dataSourceId,
        picked:current.settings.dataSourceIds.includes(x.dataSourceId),
      }));
      if (!related.size && !extraItems.length) throw new Error('当前项目没有可用的数据源关联，请核对平台配置');
      const extra = extraItems.length ? await vscode.window.showQuickPick(extraItems,{title:related.size ? '选择额外共享数据源（系统关联源自动包含）' : '平台未提供关联，请明确选择数据源',canPickMany:true,
        placeHolder:'共享过程、表和视图按数据源粒度拉取；不默认选择未关联数据源'}) : [];
      if (!extra) return;
      await run(key,'configure',{allSystems:all,systemIds:all ? []:selectedIds,dataSourceIds:extra.map(x=>x.dataSourceId)});onUpdated?.();
    },
    pullApiSource: async key => {
      const state = await ui.status(key);
      assertClean(vscode,state.checkoutPath);
      await editorState.flush(key);
      const result = await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'通过 API 拉取当前范围源码',cancellable:false},()=>run(key,'pull'));
      ui.setIndexResult(key,result.index);await ui.updateScm(key);onUpdated?.();
      await showReport(vscode,'API 源码拉取结果',sourceSyncLines(key,result));

    },
    openApiCheckout: async key => {
      const result = await run(key,'status');
      await openProjectWorkspace(vscode,result);
    },
    showApiStatus: async key => {
      const result = await run(key,'status');
      const doc = await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(result,null,2)});
      await vscode.window.showTextDocument(doc,{preview:true});
    },
  };
  Object.assign(handlers, {
    refreshApiSourceView: async key => {await ui.updateScm(key);onUpdated?.();},
    refreshApiScm: async key => ui.updateScm(key),
    refreshApiObject: async (key,p) => {
      const state=await ui.status(key);assertClean(vscode,state.checkoutPath,[p]);await editorState.flush(key);
      const result=await run(key,'refresh',{path:p});ui.setIndexResult(key,result.index);await ui.updateScm(key);onUpdated?.();
      await showReport(vscode,'API 源码更新结果',sourceSyncLines(key,result));return result;
    },
    showApiIndexDiagnostics: async key => ui.showIndexDiagnostics(key),
    openApiSource: async (key,p) => ui.open(key,p,false),
    previewApiSource: async (key,p) => ui.open(key,p,true,{raw:true}),
    openApiOriginalSource: async (key,p) => ui.open(key,p,false,{raw:true}),
    showApiDiff: async (key,p) => ui.diff(key,p),
    revertApiSource: async (key,p) => ui.revert(key,p),
    uploadApiSource: async (key,p) => ui.upload(key,Array.isArray(p) ? p : p ? [p] : undefined),
    openApiDesigner: async (key,p) => openDesigner({vscode,run,ui,key,sourcePath:p,onUpdated,editorState}),
    openApiFieldCollection: async (key,p,value) => {const target=value.target || value;if(typeof target.jsonPointer!=='string' || !target.jsonPointer.startsWith('/')) throw new Error('请选择明确的字段集合');await ui.status(key);getPageEditor();return virtualFs.open({workspaceKey:key,sourceType:'page',sourcePath:p,jsonPointer:target.jsonPointer,fragmentType:'fields'},{viewColumn:vscode.ViewColumn.Beside});},
    openApiFragment: async (key,p,value) => {const target=value.target || value;if(!target.jsonPointer || !target.jsonPointer.startsWith('/')) throw new Error('请选择明确的源码分块');await ui.status(key);getPageEditor();return virtualFs.open({...target,workspaceKey:key,sourcePath:p},{viewColumn:vscode.ViewColumn.Beside});},
    openApiPageEditor: async (key,p) => {
      await ui.status(key);
      const source=await run(key,'read',{path:p});
      if(source.metadata?.sourceType && source.metadata.sourceType!=='page') throw new Error('请选择 PAGE 源码');
      return getPageEditor().open({workspaceKey:key,sourcePath:p,sourceType:'page',sourceId:source.metadata?.pageId,sourceName:source.metadata?.pageName});
    },
    resolveApiConflict: async (key,p) => ui.resolveConflict(key,p),
    syncApiDatabase: async (key,p) => ui.syncDatabase(key,p),
    createApiFunction: async (key,p) => ui.createFunction(key,p),
    showApiSystemMenu: async key => ui.systemMenu(key),
    exportApiChanges: async key => ui.exportChanges(key),
    importApiChanges: async key => ui.importChanges(key),
    showApiHistory: async key => ui.history(key),
    verifyApiUpload: async key => ui.verifyUpload(key),
    searchApiSource: async key => vscode.commands.executeCommand('gushenCompletion.searchWorkspace',key),
    editApiPage: async (key,p) => handlers.openApiPageEditor(key,p),
  });
  const pathCommands=new Set(['openApiSource','previewApiSource','openApiOriginalSource','showApiDiff','revertApiSource','uploadApiSource','openApiDesigner','openApiFragment','openApiFieldCollection','openApiPageEditor','editApiPage','refreshApiObject','resolveApiConflict','syncApiDatabase','createApiFunction']);
  const execute = name => async (value,sourcePath)=>{
    try {
      if (!value && selectWorkspace) value=(await selectWorkspace(''))?.workspaceKey;
      if (!value) throw new Error('请从具体 API 项目执行操作');
      const {key,path:objectPath}=identity(value,sourcePath);
      if (!key) throw new Error('请从具体 API 项目执行操作');
      if (pathCommands.has(name) && name!=='uploadApiSource' && !objectPath) throw new Error('请选择 API 源码');
      let selected=objectPath;
      if(['uploadApiSource','revertApiSource'].includes(name) && Array.isArray(sourcePath) && sourcePath.length) {
        const entries=sourcePath.map(item=>identity(item));
        if(entries.some(item=>item.key!==key || !item.path)) throw new Error('请选择同一项目内的源码');
        selected=[...new Set([objectPath,...entries.map(item=>item.path)].filter(Boolean))];
      }
      ui.track(key);return await handlers[name](key,selected,value);
    } catch(error) {return vscode.window.showErrorMessage(`谷神 API：${error.message}`);}
  };
  const official = action => async()=>{try {return await action({vscode,context});} catch(error) {return vscode.window.showErrorMessage(`官方能力更新：${error.message}`);}};
  const registrations = [
    vscode.commands.registerCommand('gushenCompletion.configureApiSource',execute('configureApiSource')),
    vscode.commands.registerCommand('gushenCompletion.loginApiSource',execute('loginApiSource')),
    vscode.commands.registerCommand('gushenCompletion.selectApiSystems',execute('selectApiSystems')),
    vscode.commands.registerCommand('gushenCompletion.pullApiSource',execute('pullApiSource')),
    vscode.commands.registerCommand('gushenCompletion.openApiCheckout',execute('openApiCheckout')),
    vscode.commands.registerCommand('gushenCompletion.showApiStatus',execute('showApiStatus')),
    vscode.commands.registerCommand('gushenCompletion.refreshApiSourceView',execute('refreshApiSourceView')),
    vscode.commands.registerCommand('gushenCompletion.refreshApiScm',execute('refreshApiScm')),
    vscode.commands.registerCommand('gushenCompletion.refreshApiObject',execute('refreshApiObject')),
    vscode.commands.registerCommand('gushenCompletion.showApiIndexDiagnostics',execute('showApiIndexDiagnostics')),
    vscode.commands.registerCommand('gushenCompletion.openApiSource',execute('openApiSource')),
    vscode.commands.registerCommand('gushenCompletion.previewApiSource',execute('previewApiSource')),
    vscode.commands.registerCommand('gushenCompletion.openApiOriginalSource',execute('openApiOriginalSource')),
    vscode.commands.registerCommand('gushenCompletion.showApiDiff',execute('showApiDiff')),
    vscode.commands.registerCommand('gushenCompletion.revertApiSource',execute('revertApiSource')),
    vscode.commands.registerCommand('gushenCompletion.uploadApiSource',execute('uploadApiSource')),
    vscode.commands.registerCommand('gushenCompletion.openApiDesigner',execute('openApiDesigner')),
    vscode.commands.registerCommand('gushenCompletion.openApiPageEditor',execute('openApiPageEditor')),
    vscode.commands.registerCommand('gushenCompletion.openApiFragment',execute('openApiFragment')),
    vscode.commands.registerCommand('gushenCompletion.openApiFieldCollection',execute('openApiFieldCollection')),
    vscode.commands.registerCommand('gushenCompletion.searchApiSource',execute('searchApiSource')),
    vscode.commands.registerCommand('gushenCompletion.resolveApiConflict',execute('resolveApiConflict')),
    vscode.commands.registerCommand('gushenCompletion.syncApiDatabase',execute('syncApiDatabase')),
    vscode.commands.registerCommand('gushenCompletion.createApiFunction',execute('createApiFunction')),
    vscode.commands.registerCommand('gushenCompletion.showApiSystemMenu',execute('showApiSystemMenu')),
    vscode.commands.registerCommand('gushenCompletion.exportApiChanges',execute('exportApiChanges')),
    vscode.commands.registerCommand('gushenCompletion.importApiChanges',execute('importApiChanges')),
    vscode.commands.registerCommand('gushenCompletion.showApiHistory',execute('showApiHistory')),
    vscode.commands.registerCommand('gushenCompletion.verifyApiUpload',execute('verifyApiUpload')),
    vscode.commands.registerCommand('gushenCompletion.editApiPage',execute('editApiPage')),
    vscode.commands.registerCommand('gushenCompletion.checkOfficialUpdate',official(checkOfficialUpdate)),
    vscode.commands.registerCommand('gushenCompletion.rollbackOfficialUpdate',official(rollbackOfficialUpdate)),
    vscode.commands.registerCommand('gushenCompletion.revertApiQuickDiffChange',async(resourceUri,changes,changeIndex)=>{try{return await revertQuickDiffChange({vscode,provider:quickDiff,resourceUri,changes,changeIndex});}catch(error){return vscode.window.showErrorMessage(`API 差异：${error.message}`);}}),
  ];
  if (vscode.workspace.registerTextDocumentContentProvider) {registrations.push(vscode.workspace.registerTextDocumentContentProvider('guthon-api-readonly',ui));registrations.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME,quickDiff));}
  if(vscode.window.createTreeView) {ui.treeView=vscode.window.createTreeView('gushenCompletion.sourceView',{treeDataProvider:ui,showCollapseAll:true});registrations.push(ui.treeView);}
  else if (vscode.window.registerTreeDataProvider) registrations.push(vscode.window.registerTreeDataProvider('gushenCompletion.sourceView',ui));
  if (vscode.workspace.onDidSaveTextDocument) registrations.push(vscode.workspace.onDidSaveTextDocument(document=>{
    if (document.uri.scheme===SCHEME) {void pageEditor?.codeSaved(document.uri).catch(error=>vscode.window.showErrorMessage(error.message));return;}
    if (document.uri.scheme!=='file') return;
    for (const [key,record] of ui.controls) {
      if (record.refreshTimer) clearTimeout(record.refreshTimer);
      record.refreshTimer=setTimeout(()=>ui.updateScm(key).catch(()=>{}),300);
    }
  }));
  if(vscode.workspace.onDidChangeTextDocument) registrations.push(vscode.workspace.onDidChangeTextDocument(event=>{if(event.document.uri.scheme===SCHEME) {virtualFs?.trackDocumentChange(event);inheritanceDecorations?.refresh(event.document);}}));
  if(vscode.workspace.onDidCloseTextDocument) registrations.push(vscode.workspace.onDidCloseTextDocument(doc=>{if(doc.uri.scheme===SCHEME) virtualFs?.close(doc.uri);}));
  context.subscriptions.push(...registrations,ui,{dispose:()=>{void closeEditorState().catch(error=>vscode.window.showErrorMessage(`编辑状态关闭失败：${error.message}`));}},sourceWatcher,quickDiff);
  return {run,sourceTree:ui,editorState,sourceUri:async(key,p)=>{const state=await ui.status(key),source=await run(key,'read',{path:p});if(source.metadata?.sourceType==='view' || isInlineInherited(key,p,source)){getPageEditor();const uri=uriFor(vscode,{workspaceKey:key,sourcePath:p,sourceType:source.metadata.sourceType,jsonPointer:source.metadata.sourceType==='view'?'/viewSql':'',fragmentType:source.metadata.sourceType==='view'?'sql':source.metadata.sourceType==='system-script'?'js':'gss'});editorState.assertNoDirtyDocumentsExcept(key,p,uri);return uri;}return vscode.Uri.file(filePath(state.checkoutPath,p));},setSelectWorkspace:selector=>{selectWorkspace=selector;},openFragment:async target=>{await ui.status(target.workspaceKey);getPageEditor();return virtualFs.open(target,{viewColumn:vscode.ViewColumn.Beside});},syncWorkspaces:workspaces=>{ui.syncWorkspaces(workspaces);return Promise.all(workspaces.filter(w=>!w.sourceMode || w.sourceMode==='api').map(w=>ui.updateScm(typeof w==='string'?w:w.workspaceKey)));},refreshWorkspace:key=>ui.updateScm(key),retryIndex:key=>sourceWatcher.retry(key),markIndexed:key=>sourceWatcher.markIndexed(key),reset:async()=>{await sourceWatcher.reset();await editorState.reset();pageEditor?.dispose();if(pageEditor) await Promise.all([...pageEditor.pages.values()].map(session=>session.persistence).filter(Boolean));virtualRegistration?.dispose();inheritanceDecorations?.dispose();virtualFs?.dispose();pageEditor=virtualFs=virtualRegistration=inheritanceDecorations=undefined;ui.clear();},dispose:async()=>{pageEditor?.dispose();await sourceWatcher.close();ui.dispose();await closeEditorState();}};
}
module.exports={activateApi};

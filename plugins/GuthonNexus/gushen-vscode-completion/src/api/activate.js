const path = require('node:path');
const {ToolJsonClient} = require('../tool-json-client');
const {ToolProcessClient} = require('../tool-process-client');
const {operationTimer} = require('../output-logging');
const {ApiLoginStore}=require('./login-store');
const {ApiAuthentication}=require('./authentication');
const {ApiSourceUI,READONLY_SCHEME,assertClean,identity,showReport,sourceSyncLines,filePath} = require('./source-ui');
const {openDesigner} = require('./designer');
const {ApiEditorState} = require('./editor-state');
const {openProjectWorkspace} = require('./project-workspace');
const {ApiSourceWatcher} = require('./source-watcher');
const {ApiPageVirtualFs,SCHEME,uriFor,isInlineInherited}=require('../source/virtual-fs');
const {InheritanceDecorations}=require('../source/inheritance-decoration');
const {PageEditorController} = require('../page-editor/controller');
const {DIFF_SCHEME,ApiQuickDiff,revertQuickDiffChange}=require('../source/quick-diff');
const {checkOfficialUpdate,rollbackOfficialUpdate} = require('../official-update');
const {ViewTree}=require('../view-tree');
const REMOTE_ACTIONS = new Set(['session','captcha','login','logout','systems','data-sources','designer-context','system-menu','pull','scope-apply','refresh','upload','verify-upload','sync-database','platform-request','create-function','reference-sync','module-parameters-sync','module-parameter-load','module-upload']);
const LOGGED_ACTIONS = new Set(['pull','scope-apply','refresh','upload','verify-upload','create-function','module-parameters-sync','module-parameter-load','module-upload']);

function scopeReportLines(key,result) {
  const state=value=>value===true?'完成':value===false?'未完成':'未返回';
  const saved=value=>value===true?'已保存':value===false?'未保存':'未返回';
  const publication=result.publication,index=result.index || publication?.index;
  const lines=[`工作区：${key}`,`操作编号：${result.operationId || '未返回'}`,`操作阶段：${result.stage || '未返回'}`,
    `范围设置：${saved(result.settingsSaved)}`,`总体结果：${state(result.complete)}`,`平台源码读取：${state(result.remoteDownloadComplete)}`,
    `本地发布与合并：${state(result.downloadComplete)}`];
  if(result.failedStage) lines.push(`失败阶段：${result.failedStage}`);
  if(result.error) lines.push(`错误：${result.error.code || '未返回错误码'} · ${result.error.message || '未返回详情'}`);
  lines.push(`源码发布：${result.publicationState || (publication ? state(publication.complete) : '未返回')}`);
  if(publication) {
    const count=name=>Array.isArray(publication[name]) ? String(publication[name].length) : '未返回';
    lines.push(`发布操作编号：${publication.operationId || result.publicationOperationId || '未返回'}`,
      `更新 ${count('updated')} 个，保留 ${count('preserved')} 个，冲突 ${count('conflicts')} 个。`);
    if(publication.conflicts?.length) lines.push('','## 文件冲突',...publication.conflicts.map(item=>`- ${item.path}：${item.reason}`));
  }
  if(result.cleanup) {
    const cleanup=result.cleanup,removed=Number.isInteger(cleanup.removedCount)?cleanup.removedCount:'未返回';
    lines.push('','## 退出范围清理',`已清理文件：${removed} 个`,`备份位置：${cleanup.backupPath || '未返回'}`);
    if(cleanup.removedPaths?.length) lines.push(...cleanup.removedPaths.map(path=>`- ${JSON.stringify(path)}`));
    if(cleanup.truncated) lines.push('- 文件列表已截断，完整清单请查看备份记录。');
    if(cleanup.blocked?.length) lines.push('清理受阻：',...cleanup.blocked.map(item=>typeof item==='string'?`- ${item}`:`- ${item.code || '未知原因'}：${item.message || '未返回详情'}`));
  }
  lines.push(`索引结果：${state(index?.complete)}`,`索引诊断数量：${index?.diagnosticCount ?? '未返回'}`);
  if(index?.diagnostics?.length) lines.push('','## 索引诊断',...index.diagnostics.map(item=>`- ${item.path || '未知文件'}：${item.code || ''} ${item.message || ''}`),...(index.truncated?['- 诊断列表已截断，请检查索引状态。']:[]));
  if(result.complete!==true) lines.push('','请在操作记录中核对操作编号及当前源码和索引状态；索引未完成时可检查诊断并重建。');
  lines.push('','本次未执行上传。');return lines;
}

function activateApi({vscode, context, getTool, processClient, onUpdated, onStatus, getOutput, loginStore}) {
  // Editor coordination must remain responsive while the primary write lane is pulling or indexing.
  const stateProcessClient = new ToolProcessClient();
  const stateClient = new ToolJsonClient({getTool,processClient:stateProcessClient,outputLabel:'谷神 API 编辑状态'});
  // A large checkout status scan must not block opening source on the main lane.
  const statusProcessClient = new ToolProcessClient();
  // Platform calls share one session without occupying the local source lane.
  const remoteProcessClient = new ToolProcessClient({allowReadLane:false});
  const statusRequests = new Map();
  const statusEpochs = new Map();
  const sessionRequests = new Map();
  const lastStatus = new Map();
  let requestLifecycle=0;
  const authentications=new Map();
  const credentialStore=loginStore || new ApiLoginStore(context.globalStorageUri?.fsPath);
  const toolIdentity=tool=>JSON.stringify([tool.toolHome,tool.toolPath,tool.toolEntry || '',tool.mode || '']);
  const switched=()=>Object.assign(new Error('本地数据目录已切换，请重新执行操作'),{code:'API_WORKSPACE_SWITCHED'});
  const resolveRequestContext=async()=>{
    const lifecycle=requestLifecycle,tool=await getTool();
    if(lifecycle!==requestLifecycle)throw switched();
    if(!tool)throw new Error('请先配置 GuthonCodeTool 运行模式和本地数据目录');
    return {lifecycle,tool,identity:toolIdentity(tool)};
  };
  const assertRequestContext=async current=>{
    if(current.lifecycle!==requestLifecycle)throw switched();
    const tool=await getTool();
    if(current.lifecycle!==requestLifecycle || !tool || toolIdentity(tool)!==current.identity)throw switched();
  };
  const boundClient=(current,processClient,outputLabel)=>new ToolJsonClient({getTool:async()=>current.tool,processClient,outputLabel});
  const backendRun=(current,key,action,input,options)=>boundClient(current,REMOTE_ACTIONS.has(action)?remoteProcessClient:processClient,'谷神 API')
    .run(key,'api',[action,...(input === undefined ? []:['--stdin'])],input,options);
  const authenticationFor=current=>{
    const identity=JSON.stringify([current.lifecycle,current.identity]);
    let authentication=authentications.get(identity);
    if(!authentication) {
      authentication=new ApiAuthentication({invoke:async(key,action,input,options)=>{
        await assertRequestContext(current);return backendRun(current,key,action,input,options);
      },store:credentialStore,scopeFor:async key=>{
        await assertRequestContext(current);
        const summary=await readProjectSummary(key,current);
        return {toolHome:current.tool.toolHome,workspaceKey:key,serverUrl:summary.settings.serverUrl};
      },onWarning:message=>vscode.window.showWarningMessage?.(message)});
      authentications.set(identity,authentication);
    }
    return authentication;
  };
  let sourceUpdate;
  const sourceUpdateInProgress=()=>!!sourceUpdate;
  const invalidateStatus=key=>{lastStatus.delete(key);statusEpochs.set(key,(statusEpochs.get(key)||0)+1);};
  const run = async (key,action,input) => {
    if(action==='status') {
      const current=await resolveRequestContext(),epoch=statusEpochs.get(key)||0;
      const requestKey=JSON.stringify([current.lifecycle,current.identity,key,input?.summaryOnly===true,epoch]);
      const pending=statusRequests.get(requestKey);if(pending)return pending;
      const request=boundClient(current,statusProcessClient,'谷神 API 状态').run(key,'api',['status','--stdin'],{...input,changesOnly:true})
        .then(async result=>{await assertRequestContext(current);if((statusEpochs.get(key)||0)!==epoch)return run(key,'status',input);if(!input?.summaryOnly){lastStatus.set(key,{identity:current.identity,result});onUpdated?.();}return result;},
          async error=>{await assertRequestContext(current);if((statusEpochs.get(key)||0)!==epoch)return run(key,'status',input);throw error;})
        .finally(()=>{if(statusRequests.get(requestKey)===request) statusRequests.delete(requestKey);});
      statusRequests.set(requestKey,request);return request;
    }
    const current=await resolveRequestContext();
    if(sourceUpdate && REMOTE_ACTIONS.has(action)) {
      throw Object.assign(new Error('正在更新 API 源码和索引，请在更新完成后再执行此操作。'),{code:'API_SOURCE_UPDATE_RUNNING'});
    }
    const sessionKey=JSON.stringify([current.lifecycle,current.identity,key]);
    const authentication=authenticationFor(current);
    const invoke=async()=>{
      const output=LOGGED_ACTIONS.has(action) ? getOutput?.() : undefined, elapsed=operationTimer();
      if(output) {output.show(true);output.appendLine(`谷神 API · ${action} · ${key} · 已提交执行`);}
      if(['login','logout','configure'].includes(action))sessionRequests.delete(sessionKey);try {
      let result;
      if(action==='login') result=await authentication.login(key,input);
      else if(action==='logout') result=await authentication.logout(key);
      else if(action==='session') result=await authentication.session(key,input);
      else {
        if(REMOTE_ACTIONS.has(action) && action!=='captcha') await authentication.ensure(key);
        await assertRequestContext(current);result=await backendRun(current,key,action,input,{onOutput:text=>output?.append(text)});
      }
      if(action==='session')await assertRequestContext(current);
      if(output) {
        output.appendLine(`谷神 API · ${action} · ${key} · ${result.complete===false?'部分完成，请核对结果':'已返回处理结果'}${result.operationId ? ' · 操作编号 '+result.operationId : ''}`);
        if(result.index) {
          const indexStatus=result.index.complete?'完成':result.index.indexGeneration?'已建立，部分源码待解析':'未完成';
          output.appendLine(`索引${indexStatus} · 诊断 ${result.index.diagnosticCount ?? '未返回'} 项`);
        }
      }
      if(action==='login'){ui.menuAttempts.delete(key);ui.invalidate(key);ui.refresh();}
      if(action==='scope-save')invalidateStatus(key);
      if(action==='configure'){invalidateStatus(key);if(result.index){ui.invalidate(key);ui.setIndexResult(key,result.index);}}
      return result;
    }
    catch(error) {output?.appendLine(`谷神 API · ${action} · ${key} · 失败${error.code ? ' · '+error.code : ''}`);if(action==='configure' && error.code==='API_SCOPE_INDEX_REFRESH_REQUIRED')invalidateStatus(key);if(['API_LOGIN_REQUIRED','API_LOGIN_RESTORE_FAILED'].includes(error.code) && !['session','status'].includes(action)){sessionRequests.delete(sessionKey);onUpdated?.();}throw error;}
    finally {output?.appendLine(`谷神 API · ${action} · ${key} · 耗时 ${elapsed()}`);if(action==='logout')onUpdated?.();if(action==='pull' || action==='scope-apply' || action==='reference-sync' || action==='module-parameters-sync' || action==='module-parameter-load' || (action==='module-upload' && input?.action!=='preview') || (action==='module-parameter' && input?.action==='save'))invalidateStatus(key);}};
    if(action==='session') {
      const pending=sessionRequests.get(sessionKey);if(pending) return pending;
      const request=invoke().finally(()=>{if(sessionRequests.get(sessionKey)===request) sessionRequests.delete(sessionKey);});
      sessionRequests.set(sessionKey,request);return request;
    }
    if(action==='pull' || action==='scope-apply') {
      sourceUpdate=invoke();
      try {return await sourceUpdate;} finally {sourceUpdate=undefined;}
    }
    return invoke();
  };
  let mcpSessionHost=new (require('./mcp-session-host').McpSessionHost)({run});
  const editorState = new ApiEditorState({vscode,run:(key,_action,input)=>stateClient.run(key,'api',['editor-state','--stdin'],input),onError:error=>vscode.window.showErrorMessage(`编辑状态登记失败：${error.message}`)});
  async function readProjectSummary(key,current) {
    current ||= await resolveRequestContext();
    const value=await boundClient(current,stateProcessClient,'谷神 API 编辑状态').run(key,'api',['status','--stdin'],{summaryOnly:true,changesOnly:true});
    await assertRequestContext(current);
    const cached=lastStatus.get(key),scanned=cached?.identity===current.identity ? cached.result : undefined;
    return scanned?.checkoutPath===value.checkoutPath && require('node:util').isDeepStrictEqual(scanned.settings,value.settings)
      ? {...value,summary:scanned.summary,summaryComplete:true,statusKind:'last-scan'} : value;
  }
  let closingEditorState;
  const closeEditorState=()=>closingEditorState ||= editorState.close().finally(()=>stateProcessClient.dispose());
  let pageEditor,virtualFs,virtualRegistration,sourceWatcher,selectWorkspace,inheritanceDecorations,moduleEditor,workspaceSyncGeneration=0;
  const deferredScopeEvents=new Map(),designerPanels=new Map();
  const ui = new ApiSourceUI({vscode,run,onUpdated,onStatus,editorState,canLoadMenu:()=>!sourceUpdateInProgress(),onOpenModule:(key,path)=>getModuleEditor().open(key,path),onModuleUpload:(key,paths)=>getModuleEditor().upload(key,paths),onWorkspace:(key,root)=>sourceWatcher.register(key,root),indexRecovery:key=>sourceWatcher.recovery(key),onOpenVirtual:async identity=>{getPageEditor();return virtualFs.openEditor(identity);},onSourceChanged:async(key,paths)=>{
    try {
      virtualFs?.invalidate(key,paths);
      const deferred=deferredScopeEvents.get(key);
      if(deferred) for(const p of paths) deferred.paths.add(p);
      else sourceWatcher.enqueueMany(key,paths);
      await pageEditor?.sourceChanged(key,paths);
    } catch(error) {await vscode.window.showErrorMessage(`PAGE 更新核对失败：${error.message}`);}
  }});
  if(vscode.window.registerFileDecorationProvider)context.subscriptions.push(vscode.window.registerFileDecorationProvider(ui));
  const quickDiff=new ApiQuickDiff({vscode,run,editorState,ui,projectBase:(uri,text)=>virtualFs?.projectBase(uri,text),projectionBase:(uri,diff)=>virtualFs?.projectionBase(uri,diff)});ui.quickDiff=quickDiff;
  sourceWatcher=new ApiSourceWatcher({run,workspaceState:context.workspaceState,onRecoveryChanged:()=>ui.refresh(),onChanged:async (key,paths,result)=>{const current=ui.indexGenerations.get(key);ui.setIndexResult(key,result);if(paths.length || current!==result.indexGeneration)await ui.updateScm(key);if(paths.length)await pageEditor?.statusChanged(key);onUpdated?.();},onError:(key,error)=>{onStatus?.(key,{summaryComplete:false});ui.refresh();vscode.window.showErrorMessage(`源码索引更新失败（${key}）：${error.message}；可重试待更新文件`);}});
  async function withDeferredIndexEvents(key, operation) {
    let deferred=deferredScopeEvents.get(key);
    if(!deferred) {
      deferred={active:0,paths:new Set()};
      deferredScopeEvents.set(key,deferred);
    }
    deferred.active++;
    try {
      const result=await operation();
      if(result.index?.indexGeneration) await sourceWatcher.markIndexed(key,result.index.indexGeneration);
      return result;
    } finally {
      if(--deferred.active===0) {
        deferredScopeEvents.delete(key);
        sourceWatcher.enqueueMany(key,deferred.paths);
      }
    }
  }
  function getPageEditor() {
    if (pageEditor) return pageEditor;
    virtualFs=new ApiPageVirtualFs({vscode,run,editorState,onWillSave:uri=>pageEditor.beforeCodeSave(uri),
      onOpened:editor=>inheritanceDecorations?.render(editor),onInvalidated:()=>inheritanceDecorations?.refresh(),
      onSaved:async uri=>{try {const id=require('../source/virtual-fs').decodeIdentity(uri);await ui.updateScm(id.workspaceKey);onUpdated?.();} catch(error) {await vscode.window.showErrorMessage(`SCM 刷新失败：${error.message}`);}}});
    inheritanceDecorations=new InheritanceDecorations(vscode,virtualFs);
    virtualRegistration=vscode.workspace.registerFileSystemProvider(SCHEME,virtualFs,{isCaseSensitive:true});
    context.subscriptions.push(virtualRegistration,virtualFs,inheritanceDecorations);
    pageEditor=new PageEditorController({vscode,context,getTool,virtualFs,openReadonly:(identity,snapshot)=>ui.openReadonly(identity.workspaceKey,identity.sourcePath,snapshot.sourceText),
      preparePage: (identity) => ui.preparePageForEditing(identity.workspaceKey, identity.sourcePath),
      openOnline:identity=>handlers.openApiDesigner(identity.workspaceKey,identity.sourcePath),
      backend:{run},
      ownsDocument:(identity,doc)=>{const state=editorState.workspaces.get(identity.workspaceKey);return !!state && editorState.documentPath(identity.workspaceKey,state,doc)===identity.sourcePath;},
      onDraftChanged:(identity,dirty,version)=>editorState.setDraft(`page:${identity.workspaceKey}:${identity.sourcePath}`,identity.workspaceKey,identity.sourcePath,dirty,version),
      editorToken:key=>editorState.flush(key),
      assertCanSave:identity=>editorState.assertNoConflictingDrafts(identity.workspaceKey,identity.sourcePath,['page']),
      onSaved:async(key)=>{await ui.updateScm(key);onUpdated?.();}});
    context.subscriptions.push(pageEditor);return pageEditor;
  }
  function getModuleEditor() {
    getPageEditor();
    return moduleEditor ||= new (require('./module-parameter-editor').ModuleParameterEditor)({vscode,run,ui,virtualFs,editorState,onUpdated});
  }
  const handlers = {
    configureApiSource: async key => {
      const current = await readProjectSummary(key);
      const serverUrl = await vscode.window.showInputBox({title:'开发平台地址',value:current.settings.serverUrl,
        prompt:'例如 https://project.example.com，不包含账号或密码'});
      if (serverUrl === undefined) return;
      const result=await run(key,'configure',{serverUrl});if(result.index) await ui.updateScm(key);onUpdated?.();
    },
    loginApiSource: async key => {
      const userId = await vscode.window.showInputBox({title:'登录账号'});
      if (!userId) return;
      const password = await vscode.window.showInputBox({title:'登录密码',password:true});
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
    logoutApiSource:async key=>{
      if([...designerPanels.keys()].some(id=>JSON.parse(id)[0]===key))throw new Error('请先保存并关闭当前项目的页面编辑器，再退出登录');
      await run(key,'logout');
      await vscode.window.showInformationMessage('已退出当前项目登录，并清除 Nexus 本地保存的账号密码');
    },
    selectApiSystems: async key => {
      const result = await run(key,'systems');
      const current = await readProjectSummary(key);
      const scope=current.pendingScope || current.settings;
      const items = [{label:'全部子系统',description:'明确选择后才拉取全部',systemId:'*',picked:scope.allSystems},
        ...result.systems.map(s=>({label:s.systemName || s.systemId,description:s.systemId,systemId:s.systemId,picked:scope.systemIds.includes(s.systemId)}))];
      const selected = await vscode.window.showQuickPick(items,{title:'选择需要拉取的子系统',canPickMany:true});
      if (!selected) return;
      if(!selected.length)throw new Error('请至少选择一个子系统');
      const all = selected.some(x=>x.systemId==='*');
      if (all && selected.length!==1) throw new Error('全部子系统不能与指定子系统同时选择');
      const selectedIds = all ? result.systems.map(x=>x.systemId) : selected.map(x=>x.systemId);
      const related = new Set(result.systems.filter(x=>selectedIds.includes(x.systemId)).map(x=>x.dataSourceId).filter(Boolean));
      if(!related.size)throw new Error('所选子系统缺少数据源关联，请先核对平台配置');
      const settings={allSystems:all,systemIds:all ? []:selectedIds,dataSourceIds:[]};
      const saved=await run(key,'scope-save',settings);
      onUpdated?.();
      await vscode.window.showInformationMessage('同步范围已保存。点击“更新源码”后开始拉取并更新索引。');
      return saved;
    },
    pullApiSource: async key => {
      if(sourceUpdateInProgress())return vscode.window.showInformationMessage('正在更新 API 源码和索引。');
      const state=await ui.status(key);
      const scopePending=!!state.pendingScope;
      let pulled,refreshError,scopeError;
      try {
        if(!scopePending) assertClean(vscode,state.checkoutPath);
        pulled=await withDeferredIndexEvents(key,async()=>{
          await editorState.flush(key);
          return vscode.window.withProgress({location:vscode.ProgressLocation.Notification,
            title:scopePending?'更新所选范围的源码和索引':'通过 API 拉取当前范围源码',cancellable:false},()=>run(key,'pull'));
        });
      } catch(error) {
        if(!scopePending)throw error;
        scopeError=error;
      }
      const scopeResult=pulled?.kind==='scope-apply';
      if(scopeError || scopeResult)ui.invalidate(key);
      ui.setIndexResult(key,pulled?.index);
      try {await ui.updateScm(key);} catch(error) {refreshError=error;}
      onUpdated?.();
      if(scopeError) {
        if(scopeError.code==='API_SCOPE_LOCAL_CHANGES') {
          const detail=`${scopeError.message}\n\n请先保存未保存文档，处理冲突，并按需上传、撤销或导出本地修改。未登记文件请先移出退出范围并保留。处理完成后再次点击“更新源码”。${refreshError ? `\n\n状态刷新失败：${refreshError.message}` : ''}`;
          const action=await vscode.window.showWarningMessage('退出范围存在未处理的本地内容，已保留这些文件。',{modal:true,detail},'查看本地修改');
          if(action==='查看本地修改')await vscode.commands.executeCommand('workbench.view.scm');
          return;
        }
        await vscode.window.showErrorMessage(`范围更新未完成${scopeError.code ? `（${scopeError.code}）` : ''}：${scopeError.message}；请核对当前范围和源码状态${refreshError ? `；状态刷新失败：${refreshError.message}` : ''}`);
        return;
      }
      if(!scopeResult) {
        if(refreshError)await vscode.window.showErrorMessage(`源码状态刷新失败：${refreshError.message}。拉取与索引结果见报告。`);
        await showReport(vscode,'API 源码拉取结果',sourceSyncLines(key,pulled));return pulled;
      }
      if(refreshError) await vscode.window.showErrorMessage(`${pulled.complete===true?'范围和源码已更新':'范围更新未完成'}，但状态刷新失败：${refreshError.message}`);
      await showReport(vscode,'API 范围更新结果',scopeReportLines(key,pulled));return pulled;
    },
    openApiCheckout: async key => {
      if(selectWorkspace && !await selectWorkspace(key,{switchWindow:true}))return;
      await openProjectWorkspace(vscode);
    },
    showApiStatus: async key => {
      const result = await run(key,'status');
      const doc = await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(result,null,2)});
      await vscode.window.showTextDocument(doc,{preview:true});
    },
  };
  Object.assign(handlers, {
    refreshApiSourceView: async key => {ui.menuAttempts.delete(key);ui.invalidate(key);await ui.updateScm(key);onUpdated?.();},
    refreshApiScm: async key => ui.updateScm(key),
    openApiScmGroupSources: async (key,_path,value) => ui.openScmGroupSources(key,value.id),
    stageApiScmChanges: async (key,p) => ui.applyScmChangeAction(key,'stage',p),
    stageAllApiScmChanges: async key => ui.applyScmChangeAction(key,'stage'),
    unstageApiSource: async (key,p) => ui.applyScmChangeAction(key,'unstage',p),
    unstageApiScmChanges: async key => ui.applyScmChangeAction(key,'unstage'),
    revertApiScmChanges: async key => ui.applyScmChangeAction(key,'revert'),
    uploadStagedApiSources: async key => ui.uploadStaged(key),
    showApiOriginalPath: async (key,p) => ui.showOriginalPath(key,p),
    refreshApiObject: async (key,p,value) => ui.refreshScope(typeof value==='string' ? {workspaceKey:key,path:p} : value),
    showApiIndexDiagnostics: async key => ui.showIndexDiagnostics(key),
    openApiSource: async (key,p,value) => ui.open(key,p,false,{lineNumber:value?.lineNumber}),
    previewApiSource: async (key,p) => ui.open(key,p,true,{raw:true}),
    openApiOriginalSource: async (key,p) => ui.openOriginalSources(key,p),
    showApiDiff: async (key,p) => ui.diff(key,p),
    revertApiSource: async (key,p) => ui.applyScmChangeAction(key,'revert',p),
    uploadApiSource: async (key,p) => ui.upload(key,Array.isArray(p) ? p : p ? [p] : undefined),
    openApiDesigner: async (key,p) => openDesigner({vscode,run,ui,key,sourcePath:p,onUpdated,editorState,panels:designerPanels,
      ensureWorkspace:async key=>{
        const known=ui.workspaces.get(key)?.checkoutPath;
        if(known && require('node:path').isAbsolute(known)) return ui.ensureWorkspace(key);
        const summary=await readProjectSummary(key);
        if(!summary.checkoutPath || !require('node:path').isAbsolute(summary.checkoutPath)) throw new Error('API 工作区路径无效');
        ui.workspaces.set(key,{...ui.workspaces.get(key),checkoutPath:summary.checkoutPath});
        await ui.registerWorkspace(key,summary.checkoutPath);return {checkoutPath:summary.checkoutPath};
      }}),
    openApiFieldCollection: async (key,p,value) => handlers.openApiFragment(key,p,{...value,target:{...(value.target || value),fragmentType:'fields'}}),
    openApiFragment: async (key,p,value) => {
      const target=value.target || value;
      if(typeof target.jsonPointer!=='string' || !target.jsonPointer.startsWith('/'))throw new Error('请选择明确的源码分块');
      await ui.ensureWorkspace(key);
      if(target.pendingNative)await ui.preparePageForEditing(key,p);
      getPageEditor();
      return virtualFs.open({...target,workspaceKey:key,sourcePath:p},{viewColumn:vscode.ViewColumn.Beside});
    },
    openApiPageEditor: async (key,p,value) => {
      await ui.ensureWorkspace(key);
      return getPageEditor().open({workspaceKey:key,sourcePath:p,sourceType:'page',
        ...(value?.pendingNative?{pendingNative:true}:{}),sourceId:value?.object?.sourceId,sourceName:value?.sourceName || value?.object?.name});
    },
    resolveApiConflict: async (key,p) => ui.resolveConflict(key,p),
    syncApiDatabase: async (key,p) => ui.syncDatabase(key,p),
    createApiFunction: async (key,p,value) => ui.createFunction(key,value),
    showApiSystemMenu: async key => ui.systemMenu(key),
    exportApiChanges: async key => ui.exportChanges(key),
    importApiChanges: async key => ui.importChanges(key),
    showApiHistory: async key => ui.history(key),
    showPlatformReference: async key => require('./platform-reference').showPlatformReference({vscode,run,ui,key}),
    editModuleParameter: async (key,path,value)=>getModuleEditor().open(key,path,require('./module-parameter-editor').moduleParameterSelector(value)),
    previewModuleParameter: async (key,path,value)=>getModuleEditor().preview(key,path,require('./module-parameter-editor').moduleParameterSelector(value)),
    uploadModuleParameters: async (key,path,value)=>getModuleEditor().upload(key,Array.isArray(path)?path:path?[path]:undefined,require('./module-parameter-editor').moduleParameterSelector(Array.isArray(path)?undefined:value)),
    syncModuleParameters: async key => {
      await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'同步模块参数',cancellable:false},async()=>{
        const result=await run(key,'module-parameters-sync',{});ui.invalidate(key);ui.setIndexResult(key,result.index);await ui.updateScm(key);onUpdated?.();
        await showReport(vscode,'模块参数同步',[
          `清单包含 ${result.downloadedParameters} 个模块参数，同步 ${result.downloadedFiles} 个文件。`,
          ...result.conflicts.map(item=>`- ${item.path}：${item.reason}`),
          `索引诊断 ${result.index.diagnosticCount || 0} 项。`,
          '按当前子系统范围读取汇总清单；打开具体参数时读取详情，data 可本地编辑。本次同步未修改平台配置。']);
      });
    },
    syncPlatformReferences: async key => {
      await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'同步官方参考资料',cancellable:false},async()=>{
        const result=await run(key,'reference-sync',{});ui.invalidate(key);ui.setIndexResult(key,result.index);await ui.updateScm(key);onUpdated?.();
        await showReport(vscode,'官方参考资料同步',[
          `登记 ${result.registeredReferences} 份资料。`,
          ...(result.preservedLocalReferences.length ? ['以下本地文件与平台版本不同，已保留原文：',...result.preservedLocalReferences.map(path=>'- '+path)] : []),
          '本次未拉取业务源码，未上传平台。',`索引${result.index.complete?'完成':'存在诊断，请从索引管理核对'}`]);
      });
    },
    configureReferenceAssets: async key => {
      const state=await run(key,'status',{summaryOnly:true});
      const choice=await vscode.window.showQuickPick([{label:'启用官方参考资料',value:true,description:'纳入已同步的配置索引和 skills；更新源码时同步资料'},
        {label:'关闭官方参考资料',value:false,description:'保留本地文件，不再纳入当前范围'}],{title:`官方参考资料 · 当前${state.settings.includeProjectFiles?'启用':'关闭'}`});
      if(!choice || choice.value===state.settings.includeProjectFiles)return;
      await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'更新官方参考资料索引',cancellable:false},async()=>{
        const result=await run(key,'configure',{includeProjectFiles:choice.value});ui.invalidate(key);ui.setIndexResult(key,result.index || {});await ui.updateScm(key);onUpdated?.();
      });
    },
    verifyApiUpload: async key => ui.verifyUpload(key),
    searchApiSource: async key => vscode.commands.executeCommand('gushenCompletion.searchWorkspace',key),
    editApiPage: async (key,p,value) => handlers.openApiPageEditor(key,p,value),
  });
  if(vscode.window.registerCustomEditorProvider)require('./page-custom-editor').registerPageEditor({vscode,context,ui,getController:getPageEditor});
  const pathCommands=new Set(['editModuleParameter','previewModuleParameter','openApiSource','previewApiSource','openApiOriginalSource','showApiDiff','showApiOriginalPath','stageApiScmChanges','unstageApiSource','revertApiSource','uploadApiSource','openApiDesigner','openApiFragment','openApiFieldCollection','openApiPageEditor','editApiPage','refreshApiObject','resolveApiConflict','syncApiDatabase','createApiFunction']);
  const batchCommands=new Set(['openApiOriginalSource','stageApiScmChanges','unstageApiSource','revertApiSource','uploadApiSource','uploadModuleParameters']);
  const execute = name => async (value,sourcePath,...remaining)=>{
    try {
      if (!value && selectWorkspace) value=(await selectWorkspace(''))?.workspaceKey;
      if (!value) throw new Error('请从具体 API 项目执行操作');
      const {key,path:objectPath}=identity(value,sourcePath);
      if (!key) throw new Error('请从具体 API 项目执行操作');
      if (pathCommands.has(name) && !['uploadApiSource','refreshApiObject','createApiFunction'].includes(name) && !objectPath) throw new Error('请选择 API 源码');
      let selected=objectPath;
      if(batchCommands.has(name)) {
        // SCM passes positional resources, while custom tree menus pass a selection array.
        const resources=sourcePath && typeof sourcePath==='object' ? [sourcePath,...remaining].flat() : remaining;
        if(resources.length) {
          const entries=resources.map(item=>identity(item));
          if(!objectPath || entries.some(item=>item.key!==key || !item.path)) throw new Error('请选择同一项目内的源码');
          selected=name==='uploadModuleParameters'
            ? [...new Set([value,...resources].map(item=>require('./module-parameter-editor').moduleParameterSelector(item)?.snapshotPath || identity(item).path))]
            : [...new Set([objectPath,...entries.map(item=>item.path)])];
        }
      }
      ui.track(key);return await handlers[name](key,selected,value);
    } catch(error) {return vscode.window.showErrorMessage(`谷神 API：${error.message}`);}
  };
  const official = action => async()=>{try {return await action({vscode,context});} catch(error) {return vscode.window.showErrorMessage(`官方能力更新：${error.message}`);}};
  const registrations = [
    vscode.commands.registerCommand('gushenCompletion.configureApiSource',execute('configureApiSource')),
    vscode.commands.registerCommand('gushenCompletion.loginApiSource',execute('loginApiSource')),
    vscode.commands.registerCommand('gushenCompletion.logoutApiSource',execute('logoutApiSource')),
    vscode.commands.registerCommand('gushenCompletion.selectApiSystems',execute('selectApiSystems')),
    vscode.commands.registerCommand('gushenCompletion.pullApiSource',execute('pullApiSource')),
    vscode.commands.registerCommand('gushenCompletion.openApiCheckout',execute('openApiCheckout')),
    vscode.commands.registerCommand('gushenCompletion.showApiStatus',execute('showApiStatus')),
    vscode.commands.registerCommand('gushenCompletion.refreshApiSourceView',execute('refreshApiSourceView')),
    vscode.commands.registerCommand('gushenCompletion.refreshApiScm',execute('refreshApiScm')),
    vscode.commands.registerCommand('gushenCompletion.openApiScmGroupSources',execute('openApiScmGroupSources')),
    vscode.commands.registerCommand('gushenCompletion.stageApiScmChanges',execute('stageApiScmChanges')),
    vscode.commands.registerCommand('gushenCompletion.stageAllApiScmChanges',execute('stageAllApiScmChanges')),
    vscode.commands.registerCommand('gushenCompletion.unstageApiSource',execute('unstageApiSource')),
    vscode.commands.registerCommand('gushenCompletion.unstageApiScmChanges',execute('unstageApiScmChanges')),
    vscode.commands.registerCommand('gushenCompletion.revertApiScmChanges',execute('revertApiScmChanges')),
    vscode.commands.registerCommand('gushenCompletion.uploadStagedApiSources',execute('uploadStagedApiSources')),
    vscode.commands.registerCommand('gushenCompletion.showApiOriginalPath',execute('showApiOriginalPath')),
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
    vscode.commands.registerCommand('gushenCompletion.showPlatformReference',execute('showPlatformReference')),
    vscode.commands.registerCommand('gushenCompletion.configureReferenceAssets',execute('configureReferenceAssets')),
    vscode.commands.registerCommand('gushenCompletion.syncPlatformReferences',execute('syncPlatformReferences')),
    vscode.commands.registerCommand('gushenCompletion.syncModuleParameters',execute('syncModuleParameters')),
    vscode.commands.registerCommand('gushenCompletion.editModuleParameter',execute('editModuleParameter')),
    vscode.commands.registerCommand('gushenCompletion.previewModuleParameter',execute('previewModuleParameter')),
    vscode.commands.registerCommand('gushenCompletion.uploadModuleParameters',execute('uploadModuleParameters')),
    vscode.commands.registerCommand('gushenCompletion.verifyApiUpload',execute('verifyApiUpload')),
    vscode.commands.registerCommand('gushenCompletion.editApiPage',execute('editApiPage')),
    vscode.commands.registerCommand('gushenCompletion.checkOfficialUpdate',official(checkOfficialUpdate)),
    vscode.commands.registerCommand('gushenCompletion.rollbackOfficialUpdate',official(rollbackOfficialUpdate)),
    vscode.commands.registerCommand('gushenCompletion.revertApiQuickDiffChange',async(resourceUri,changes,changeIndex)=>{try{return await revertQuickDiffChange({vscode,provider:quickDiff,resourceUri,changes,changeIndex});}catch(error){return vscode.window.showErrorMessage(`API 差异：${error.message}`);}}),
  ];
  if (vscode.workspace.registerTextDocumentContentProvider) {registrations.push(vscode.workspace.registerTextDocumentContentProvider(READONLY_SCHEME,ui));registrations.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME,quickDiff));}
  const viewId = 'gushenCompletion.sourceView';
  if (vscode.window.registerWebviewViewProvider) {
    ui.treeView=new ViewTree({vscode,id:viewId,provider:ui,title:'项目源码',extensionPath:context.extensionPath});
    registrations.push(ui.treeView);
  } else if (vscode.window.createTreeView) {
    ui.treeView = vscode.window.createTreeView(viewId, {treeDataProvider:ui,showCollapseAll:true});
    registrations.push(ui.treeView);
  } else if (vscode.window.registerTreeDataProvider) {
    registrations.push(vscode.window.registerTreeDataProvider(viewId,ui));
  }
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
  context.subscriptions.push(...registrations,ui,{dispose:()=>{void closeEditorState().catch(error=>vscode.window.showErrorMessage(`编辑状态关闭失败：${error.message}`));}},statusProcessClient,remoteProcessClient,sourceWatcher,quickDiff);
  async function syncWorkspaces(workspaces,selectedKey) {
    const generation=++workspaceSyncGeneration;
    const visible=selectedKey ? workspaces.filter(w=>(typeof w==='string'?w:w.workspaceKey)===selectedKey) : [];
    ui.syncWorkspaces(workspaces);
    ui.setSelectedWorkspace(selectedKey || '');
    await Promise.all(workspaces.filter(workspace=>typeof workspace!=='string' && workspace.workspaceKey &&
      (!workspace.sourceMode || workspace.sourceMode==='api') && typeof workspace.checkoutPath==='string' && path.isAbsolute(workspace.checkoutPath))
      .map(async workspace=>{try {await ui.registerWorkspace(workspace.workspaceKey,workspace.checkoutPath);}
        catch(error) {error.workspaceKey=workspace.workspaceKey;throw error;}}));
    if(generation!==workspaceSyncGeneration)return;
    const tool=await getTool();
    if(generation!==workspaceSyncGeneration)return;
    if(tool)await mcpSessionHost.sync(tool.toolHome,workspaces.map(w=>typeof w==='string'?w:w.workspaceKey));
    if(generation!==workspaceSyncGeneration)return;
    return Promise.all(visible.map(w=>ui.updateScm(typeof w==='string'?w:w.workspaceKey)));
  }
  return {run,readProjectSummary,sourceUpdateInProgress,sourceTree:ui,editorState,inheritedRange:document=>virtualFs?.records.get(document.uri.toString())?.inherited,sourceUri:async(key,p)=>{const state=await ui.ensureWorkspace(key),source=await run(key,'read',{path:p});if(['METADATA_ONLY','IDENTITY_MISMATCH','SQL_ABSENT'].includes(source.contentState)) return ui.readonlyUri(key,p,source.content);if(source.metadata?.sourceType==='module-parameter'){getPageEditor();return uriFor(vscode,{workspaceKey:key,sourcePath:p,sourceType:'module-parameter',jsonPointer:'/data',fragmentType:'json'});}if(source.metadata?.sourceType==='view' || isInlineInherited(key,p,source)){getPageEditor();const uri=uriFor(vscode,{workspaceKey:key,sourcePath:p,sourceType:source.metadata.sourceType,jsonPointer:source.metadata.sourceType==='view'?'/viewSql':'',fragmentType:source.metadata.sourceType==='view'?'sql':source.metadata.sourceType==='system-script'?'js':'gss'});editorState.assertNoDirtyDocumentsExcept(key,p,uri);return uri;}return vscode.Uri.file(filePath(state.checkoutPath,p));},setSelectWorkspace:selector=>{selectWorkspace=selector;},openFragment:async target=>{await ui.ensureWorkspace(target.workspaceKey);getPageEditor();return virtualFs.open(target,{viewColumn:vscode.ViewColumn.Beside});},syncWorkspaces,refreshWorkspace:key=>ui.updateScm(key),retryIndex:key=>sourceWatcher.retry(key),markIndexed:(key,generation)=>sourceWatcher.markIndexed(key,generation),reset:async()=>{workspaceSyncGeneration++;requestLifecycle++;statusRequests.clear();sessionRequests.clear();statusEpochs.clear();lastStatus.clear();authentications.clear();await sourceWatcher.reset();await editorState.reset();await mcpSessionHost.close();mcpSessionHost=new (require('./mcp-session-host').McpSessionHost)({run});pageEditor?.dispose();if(pageEditor) await Promise.all([...pageEditor.pages.values()].map(session=>session.persistence).filter(Boolean));virtualRegistration?.dispose();inheritanceDecorations?.dispose();virtualFs?.dispose();pageEditor=virtualFs=virtualRegistration=inheritanceDecorations=moduleEditor=undefined;ui.clear();},dispose:async()=>{await mcpSessionHost.close();pageEditor?.dispose();await sourceWatcher.close();ui.dispose();try {await closeEditorState();} finally {statusProcessClient.dispose();try {await remoteProcessClient.stop();} finally {remoteProcessClient.dispose();}}}};
}
module.exports={activateApi};

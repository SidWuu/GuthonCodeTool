const test=require('node:test');
const assert=require('node:assert/strict');
const {activateApi}=require('../src/api/activate');
const {ToolProcessClient,requestKind}=require('../src/tool-process-client');
function mockStateClient(t,record=()=>{},statusRequest,remoteRequest) {
  t.mock.method(ToolProcessClient.prototype,'request',async function(tool,command,args,key,input,options) {
    if(args[0]==='session' && input?.localOnly===true) return {ok:true,authenticated:true,session:{userName:'fixture'}};
    if(args[0]==='status' && statusRequest) return statusRequest(tool,command,args,key,input);
    if(args[0]!=='editor-state' && remoteRequest) return remoteRequest.call(this,tool,command,args,key,input,options);
    assert.deepEqual(args,['editor-state','--stdin']);assert.equal(command,'api');
    record({client:this,tool,command,args,key,input});return {ok:true,editorToken:'token'};
  });
}
function fixture(t,dirty=false) {
  const calls=[],handlers=new Map(),errors=[];
  mockStateClient(t,({command,args})=>calls.push([command,args]),(...args)=>processClient.request(...args));
  const vscode={workspace:{textDocuments:dirty ? [{isDirty:true,uri:{scheme:'file',fsPath:'/checkout/project/a.gss'}}]:[]},
    commands:{registerCommand:(name,handler)=>{handlers.set(name,handler);return {dispose(){}};}},
    window:{showErrorMessage:async m=>errors.push(m)}};
  const processClient={request:async(_tool,cmd,args)=>{
    calls.push([cmd,args]);
    if(args[0]==='editor-state')return {ok:true,editorToken:'token'};
    if(args[0]==='status')return {ok:true,checkoutPath:'/checkout/project',settings:{serverUrl:'https://project.invalid',systemIds:[],dataSourceIds:[],allSystems:false}};
    throw Error('Unexpected mutation');
  }};
  activateApi({vscode,context:{subscriptions:[]},getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient,onUpdated(){}});
  return {calls,handlers,errors,vscode};
}
test('pull is blocked while a current checkout document is dirty',async t=>{
  const f=fixture(t,true);
  await f.handlers.get('gushenCompletion.pullApiSource')('projects.demo');
  assert.deepEqual(f.calls.map(x=>x[1][0]),['status','editor-state']);
  assert.match(f.errors[0],/未保存文档/);
});
test('API command rejects a missing project before running any backend request',async t=>{
  const f=fixture(t);await f.handlers.get('gushenCompletion.loginApiSource')();
  assert.deepEqual(f.calls,[]);assert.match(f.errors[0],/具体 API 项目/);
});
test('cancelled API address prompt does not change configuration',async t=>{
  const f=fixture(t);f.vscode.window.showInputBox=async()=>undefined;
  await f.handlers.get('gushenCompletion.configureApiSource')('projects.demo');
  assert.deepEqual(f.calls,[['api',['status','--stdin']]]);assert.deepEqual(f.errors,[]);
});
test('login shows captcha and keeps remember in Nexus without sending it to the backend',async t=>{
  mockStateClient(t,undefined,undefined,(...args)=>processClient.request(...args));
  const calls=[],handlers=new Map(),secrets=new Map(),saved=[],inputs=['alice','password','1234'];let html='',disposed=false;
  const vscode={workspace:{textDocuments:[]},ViewColumn:{Active:1},commands:{registerCommand:(n,h)=>(handlers.set(n,h),{dispose(){}})},
    window:{showInputBox:async()=>inputs.shift(),showQuickPick:async()=>({remember:true}),showInformationMessage:async()=>{},showErrorMessage:async m=>{throw Error(m)},
      createWebviewPanel:()=>({webview:{set html(x){html=x;}},dispose(){disposed=true;}})}};
  const context={subscriptions:[],secrets:{get:async k=>secrets.get(k),store:async(k,v)=>secrets.set(k,v),delete:async k=>secrets.delete(k)}};
  const processClient={request:async(_tool,_cmd,args,key,input)=>{calls.push({action:args[0],key,input});return args[0]==='captcha'?{ok:true,dataURL:'data:image/png;base64,YQ=='}:args[0]==='status'?{ok:true,checkoutPath:'/checkout',settings:{serverUrl:'https://project.invalid'}}:{ok:true};}};
  activateApi({vscode,context,getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient,onUpdated(){},loginStore:{save:(scope,value)=>saved.push({scope,value}),forget(){},read(){}}});
  await handlers.get('gushenCompletion.loginApiSource')('projects.demo');
  assert.match(html,/data:image\/png;base64,YQ==/);assert.equal(disposed,true);
  assert.deepEqual(calls.find(x=>x.action==='login').input,{userId:'alice',password:'password',randCode:'1234'});
  assert.equal(saved.length,1);assert.equal(saved[0].scope.workspaceKey,'projects.demo');assert.equal(saved[0].value.password,'password');
  assert.equal(secrets.size,0);
});
test('subsystem selection reads lightweight project settings',async t=>{
  const summaries=[],calls=[],handlers=new Map();
  mockStateClient(t,undefined,async(_tool,_command,args,_key,input)=>{assert.equal(args[0],'status');summaries.push(input);return {ok:true,checkoutPath:'/checkout',settings:{allSystems:false,systemIds:['A'],dataSourceIds:[]}};},
    async(_tool,_command,args)=>args[0]==='systems'?{ok:true,systems:[{systemId:'A',systemName:'系统',dataSourceId:'D'}]}:args[0]==='data-sources'?{ok:true,dataSources:[]}:{ok:true,complete:true,downloadComplete:true,index:{complete:true,indexGeneration:'new'}});
  const vscode={ProgressLocation:{Notification:1},workspace:{textDocuments:[],openTextDocument:async value=>value},commands:{registerCommand:(name,handler)=>(handlers.set(name,handler),{dispose(){}})},
    window:{showQuickPick:async items=>items.filter(x=>x.systemId==='A'),withProgress:async(_options,fn)=>fn(),showTextDocument:async()=>{},showErrorMessage:async message=>assert.fail(message)}};
  const primary={request:async(_tool,_command,args,_key,input)=>(calls.push({action:args[0],input}),{ok:true})};
  const api=activateApi({vscode,context:{subscriptions:[]},getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient:primary});
  await handlers.get('gushenCompletion.selectApiSystems')('projects.A');
  assert.deepEqual(summaries[0],{summaryOnly:true,changesOnly:true});assert.deepEqual(calls,[]);await api.dispose();
});
function scopeFixture(t,{cancelAt,scopeFailure,scopeResult,statusFailure=false,partial=false,dirty=false,noIndex=false,watchEvents=false,viewScm=false}={}) {
  const events=[],errors=[],warnings=[],reports=[],handlers=new Map(),documents=dirty?[{uri:{scheme:'file',fsPath:'/checkout/systems/OLD/pages/main/P/p.xml'},isDirty:true,version:3}]:[];
  let picks=0,releaseScope,changeHandler;const settings={allSystems:false,systemIds:['OLD'],dataSourceIds:[],serverUrl:'https://fixture.invalid'};
  mockStateClient(t,({input})=>events.push({action:'editor-state',payload:input}),async(_tool,_command,_args,_key,input)=>{
    events.push({action:input.summaryOnly?'summary':'status'});if(statusFailure && !input.summaryOnly)return {ok:false,error:{code:'STATUS_FAILED',message:'状态暂不可用'}};
    return {ok:true,checkoutPath:'/checkout',settings,files:[],index:noIndex?{ready:false}:{ready:true,indexGeneration:'current'}};
  },async(_tool,_command,args,_key,input)=>{
    events.push({action:args[0],input});
    if(args[0]==='systems')return {ok:true,systems:[{systemId:'NEW',systemName:'新系统',dataSourceId:'D'}]};
    if(args[0]==='data-sources')return {ok:true,dataSources:[{dataSourceId:'EXTRA'}]};
    if(args[0]==='scope-apply') {
      const response=scopeFailure?{ok:false,error:{code:scopeFailure.code,message:scopeFailure.message}}:scopeResult || {ok:true,operationId:'scope-op',stage:partial?'PARTIAL':'COMPLETE',settingsSaved:true,complete:!partial,remoteDownloadComplete:true,downloadComplete:!partial,
        publication:{operationId:'publication-op',updated:['new.xml'],preserved:['existing.xml'],conflicts:partial?[{path:'conflict.xml',reason:'本地与远端均有修改'}]:[]},index:{complete:!partial,diagnosticCount:partial?1:0,indexGeneration:'pulled'}};
      if(watchEvents)return new Promise(resolve=>{releaseScope=()=>resolve(response);});return response;
    }
    throw Error(args[0]);
  });
  const vscode={ProgressLocation:{Notification:1},workspace:{textDocuments:documents,openTextDocument:async value=>(reports.push(value.content),value)},
    commands:{registerCommand:(name,handler)=>(handlers.set(name,handler),{dispose(){}}),executeCommand:async command=>events.push({action:command})},
    window:{showQuickPick:async items=>{picks++;if(cancelAt===picks)return undefined;return picks===1?items.filter(x=>x.systemId==='NEW'):[];},
      withProgress:async(_options,fn)=>{events.push({action:'progress'});return fn();},showTextDocument:async()=>{},showErrorMessage:async message=>errors.push(message),showWarningMessage:async(message,options)=>(warnings.push({message,options}),viewScm?'查看本地修改':undefined)}};
  if(watchEvents) {vscode.RelativePattern=class{};vscode.workspace.createFileSystemWatcher=()=>({onDidChange:fn=>{changeHandler=fn;},onDidCreate(){},onDidDelete(){},dispose(){}});}
  const primary={request:async(_tool,_command,args,_key,input)=>{events.push({action:args[0],input});if(watchEvents && args[0]==='index')return {ok:true,updatedPaths:input.paths.filter(p=>p.endsWith('changed.xml')),indexGeneration:'pulled',unchanged:false,complete:true};throw Error(args[0]);}};
  const api=activateApi({vscode,context:{subscriptions:[]},getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient:primary,onUpdated:()=>events.push({action:'card'})});
  api.sourceTree.syncWorkspaces([{workspaceKey:'projects.A',checkoutPath:'/checkout'}]);
  return {api,events,errors,warnings,reports,handlers,pickCount:()=>picks,releaseScope:()=>releaseScope(),change:path=>changeHandler({fsPath:'/checkout/'+path})};
}
test('scope selection registers dirty buffers, applies scope once, and awaits final status refresh',async t=>{
  const f=scopeFixture(t,{dirty:true});const result=await f.handlers.get('gushenCompletion.selectApiSystems')('projects.A');
  const actions=f.events.map(x=>x.action),apply=actions.indexOf('scope-apply');
  assert.equal(actions.filter(x=>x==='scope-apply').length,1);assert.ok(actions.indexOf('progress')<apply);
  assert.deepEqual(f.events[apply].input,{settings:{allSystems:false,systemIds:['NEW'],dataSourceIds:[]}});
  assert.equal(f.pickCount(),1);assert(!f.events.some(item=>item.action==='data-sources'));
  assert.ok(f.events.slice(0,apply).some(x=>x.action==='editor-state' && x.payload.documents.some(d=>d.dirty && d.path.includes('/OLD/'))));
  assert.ok(actions.lastIndexOf('status')>apply);assert.ok(actions.lastIndexOf('card')>apply);assert.equal(result.complete,true);assert.match(f.reports[0],/总体结果：完成/);assert.deepEqual(f.errors,[]);await f.api.dispose();
});
test('cancelling the subsystem picker never applies the scope',async t=>{
  for(const cancelAt of [1]) {
    const f=scopeFixture(t,{cancelAt});await f.handlers.get('gushenCompletion.selectApiSystems')('projects.A');
    assert.equal(f.events.some(x=>['configure','pull','scope-apply','editor-state'].includes(x.action)),false);assert.equal(f.reports.length,0);await f.api.dispose();t.mock.restoreAll();
  }
});
test('partial scope pull is reported accurately and still refreshes index and status',async t=>{
  const f=scopeFixture(t,{partial:true});const result=await f.handlers.get('gushenCompletion.selectApiSystems')('projects.A');
  assert.equal(result.complete,false);assert.equal(f.api.sourceTree.indexDiagnostics.get('projects.A').diagnosticCount,1);
  assert.ok(f.events.findLastIndex(x=>x.action==='status')>f.events.findIndex(x=>x.action==='scope-apply'));assert.match(f.reports[0],/总体结果：未完成/);assert.match(f.reports[0],/索引诊断数量：1/);
  assert.match(f.reports[0],/更新 1 个，保留 1 个，冲突 1 个/);assert.match(f.reports[0],/conflict\.xml/);assert.match(f.reports[0],/范围设置：已保存/);assert.deepEqual(f.errors,[]);await f.api.dispose();
});
test('scope selection performs the first pull when no index exists',async t=>{
  const f=scopeFixture(t,{noIndex:true});const result=await f.handlers.get('gushenCompletion.selectApiSystems')('projects.A');
  assert.equal(result.complete,true);assert.equal(f.events.filter(x=>x.action==='scope-apply').length,1);
  assert.ok(f.events.findLastIndex(x=>x.action==='status')>f.events.findIndex(x=>x.action==='scope-apply'));assert.deepEqual(f.errors,[]);await f.api.dispose();
});
test('failed scope apply reports its error without claiming whether settings were saved',async t=>{
  const f=scopeFixture(t,{scopeFailure:{code:'API_SOURCE_STALE',message:'目标源码有未保存输入'}});await f.handlers.get('gushenCompletion.selectApiSystems')('projects.A');
  assert.match(f.errors[0],/范围更新未完成.*API_SOURCE_STALE.*未保存/);assert.doesNotMatch(f.errors[0],/范围已保存/);assert.ok(f.events.findLastIndex(x=>x.action==='status')>f.events.findIndex(x=>x.action==='scope-apply'));assert.equal(f.reports.length,0);await f.api.dispose();
});
test('local changes block scope change with clear guidance and no automatic retry',async t=>{
  const f=scopeFixture(t,{viewScm:true,scopeFailure:{code:'API_SCOPE_LOCAL_CHANGES',message:'退出范围存在本地更改：systems/OLD/pages/main/P/page.xml (MODIFIED)'}});await f.handlers.get('gushenCompletion.selectApiSystems')('projects.A');
  assert.match(f.warnings[0].message,/原范围未更改/);assert.equal(f.warnings[0].options.modal,true);
  assert.match(f.warnings[0].options.detail,/systems\/OLD\/pages\/main\/P\/page\.xml \(MODIFIED\)/);assert.match(f.warnings[0].options.detail,/保存到磁盘后源码仍可能属于本地修改/);
  assert.match(f.warnings[0].options.detail,/上传、撤销或导出/);assert.match(f.warnings[0].options.detail,/未登记文件.*移出退出范围并保留/);assert.match(f.warnings[0].options.detail,/重新选择子系统/);
  assert.equal(f.events.filter(x=>x.action==='scope-apply').length,1);assert.ok(f.events.some(x=>x.action==='workbench.view.scm'));assert.ok(f.events.findLastIndex(x=>x.action==='status')>f.events.findIndex(x=>x.action==='scope-apply'));await f.api.dispose();
});
test('scope events are replayed after both successful and rejected publication',async t=>{
  for(const failed of [false,true]) {
    const f=scopeFixture(t,{watchEvents:true,...(failed?{scopeFailure:{code:'API_SCOPE_LOCAL_CHANGES',message:'存在本地更改'}}:{})});
    const pending=f.handlers.get('gushenCompletion.selectApiSystems')('projects.A');while(!f.events.some(x=>x.action==='scope-apply'))await new Promise(resolve=>setImmediate(resolve));
    const downloaded='systems/NEW/pages/main/PG/downloaded.xml',changed='systems/NEW/pages/main/PG/changed.xml';
    f.change(downloaded);f.change(changed);await new Promise(resolve=>setTimeout(resolve,350));assert.equal(f.events.some(x=>x.action==='index'),false);
    f.releaseScope();await pending;await new Promise(resolve=>setTimeout(resolve,400));const indexes=f.events.filter(x=>x.action==='index');
    assert.equal(indexes.length,2);assert.deepEqual(indexes[0].input,{paths:[downloaded,changed],checkOnly:true,compareIndex:true});
    assert.deepEqual(indexes[1].input.paths,[changed]);
    if(failed)assert.match(f.warnings[0].message,/原范围未更改/);else assert.deepEqual(f.errors,[]);await f.api.dispose();t.mock.restoreAll();
  }
});
test('post-save scope failure preserves backend message and refreshes current state',async t=>{
  const f=scopeFixture(t,{scopeFailure:{code:'API_SCOPE_APPLY_PARTIAL',message:'范围可能已保存，索引尚未更新'}});await f.handlers.get('gushenCompletion.selectApiSystems')('projects.A');
  assert.match(f.errors[0],/范围可能已保存.*索引尚未更新/);assert.equal(f.events.filter(x=>x.action==='scope-apply').length,1);assert.ok(f.events.some(x=>x.action==='status'));await f.api.dispose();
});
test('a returned partial receipt shows exact stage, saved state, error and missing publication without inventing counts',async t=>{
  const f=scopeFixture(t,{scopeResult:{ok:true,operationId:'scope-123',stage:'PARTIAL',failedStage:'PUBLISHING',settingsSaved:true,complete:false,remoteDownloadComplete:true,downloadComplete:false,
    publicationState:'PARTIAL_OR_UNKNOWN',error:{code:'API_SOURCE_STALE',message:'发布前源码发生变化'}}});
  const result=await f.handlers.get('gushenCompletion.selectApiSystems')('projects.A');
  assert.equal(result.complete,false);assert.match(f.reports[0],/操作编号：scope-123/);assert.match(f.reports[0],/范围设置：已保存/);
  assert.match(f.reports[0],/失败阶段：PUBLISHING/);assert.match(f.reports[0],/API_SOURCE_STALE.*发布前源码发生变化/);
  assert.match(f.reports[0],/源码发布：PARTIAL_OR_UNKNOWN/);assert.match(f.reports[0],/索引结果：未返回/);assert.doesNotMatch(f.reports[0],/更新 0 个/);
  assert.match(f.reports[0],/平台源码读取：完成/);assert.match(f.reports[0],/本地发布与合并：未完成/);
  assert.match(f.reports[0],/操作记录/);assert.ok(f.events.findLastIndex(x=>x.action==='status')>f.events.findIndex(x=>x.action==='scope-apply'));assert.deepEqual(f.errors,[]);await f.api.dispose();
});
test('a partial receipt after publication reports the actual applied changes and index failure',async t=>{
  const f=scopeFixture(t,{scopeResult:{ok:true,operationId:'scope-456',stage:'PARTIAL',failedStage:'INDEXING',settingsSaved:true,complete:false,remoteDownloadComplete:true,downloadComplete:true,
    publicationState:'COMPLETE',publication:{operationId:'publish-1',updated:['a','b'],preserved:['c'],conflicts:[]},error:{code:'INDEX_FAILED',message:'索引不可用'}}});
  await f.handlers.get('gushenCompletion.selectApiSystems')('projects.A');assert.match(f.reports[0],/发布操作编号：publish-1/);
  assert.match(f.reports[0],/更新 2 个，保留 1 个，冲突 0 个/);assert.match(f.reports[0],/INDEX_FAILED.*索引不可用/);assert.match(f.reports[0],/总体结果：未完成/);await f.api.dispose();
});
test('scope report displays confirmed cleanup count and backup without fabricating paths',async t=>{
  const f=scopeFixture(t,{scopeResult:{ok:true,operationId:'scope-clean',stage:'COMPLETE',settingsSaved:true,complete:true,remoteDownloadComplete:true,downloadComplete:true,
    publicationState:'COMPLETE',publication:{operationId:'publish-1',updated:['a'],preserved:[],conflicts:[]},index:{complete:true,diagnosticCount:0,indexGeneration:'new'},
    cleanup:{removedCount:101,removedPaths:['old/a.xml'],backupPath:'/fixture/backup',blocked:[],truncated:true}}});
  await f.handlers.get('gushenCompletion.selectApiSystems')('projects.A');assert.match(f.reports[0],/已清理文件：101 个/);
  assert.match(f.reports[0],/备份位置：\/fixture\/backup/);assert.match(f.reports[0],/old\/a\.xml/);assert.match(f.reports[0],/文件列表已截断/);await f.api.dispose();
});
test('scope cleanup failure reports saved settings, confirmed removals, backup and blocked reason',async t=>{
  const f=scopeFixture(t,{scopeResult:{ok:true,operationId:'scope-partial',stage:'PARTIAL',failedStage:'CLEANUP',settingsSaved:true,complete:false,remoteDownloadComplete:true,downloadComplete:true,
    publicationState:'COMPLETE',publication:{operationId:'publish-1',updated:[],preserved:[],conflicts:[]},index:{complete:true,diagnosticCount:0,indexGeneration:'new'},
    error:{code:'API_SCOPE_LOCAL_CHANGES',message:'清理前出现未保存草稿'},cleanup:{removedCount:2,removedPaths:['old/a.xml','old/b.xml'],backupPath:'/fixture/backup',blocked:[{code:'API_SCOPE_LOCAL_CHANGES',message:'请处理未保存草稿'}]}}});
  await f.handlers.get('gushenCompletion.selectApiSystems')('projects.A');assert.match(f.reports[0],/范围设置：已保存/);assert.match(f.reports[0],/失败阶段：CLEANUP/);
  assert.match(f.reports[0],/已清理文件：2 个/);assert.match(f.reports[0],/备份位置：\/fixture\/backup/);assert.match(f.reports[0],/请处理未保存草稿/);
  assert.doesNotMatch(f.reports[0],/原范围未更改/);await f.api.dispose();
});
test('partial scope result with a failed SCM refresh never claims source update completed',async t=>{
  const f=scopeFixture(t,{partial:true,statusFailure:true});await f.handlers.get('gushenCompletion.selectApiSystems')('projects.A');
  assert.match(f.errors[0],/范围更新未完成.*状态刷新失败/);assert.doesNotMatch(f.errors[0],/范围和源码已更新/);assert.match(f.reports[0],/总体结果：未完成/);await f.api.dispose();
});
test('a status scan started before scope configuration cannot overwrite the new SCM status',async t=>{
  let releaseOld,statusCalls=0;const controls=[];
  mockStateClient(t,undefined,async()=>{statusCalls++;if(statusCalls===1)return new Promise(resolve=>{releaseOld=resolve;});
    return {ok:true,checkoutPath:'/checkout',settings:{systemIds:['NEW']},files:[{path:'new.gss',state:'MODIFIED',inScope:true}]};});
  const primary={request:async(_tool,_command,args)=>{assert.equal(args[0],'configure');return {ok:true,index:{complete:true,indexGeneration:'new'}};}};
  const vscode={workspace:{textDocuments:[]},commands:{registerCommand:()=>({dispose(){}})},window:{showErrorMessage:async message=>assert.fail(message)},
    Uri:{from:value=>value},scm:{createSourceControl:()=>{const control={createResourceGroup:()=>control.group={resourceStates:[]},dispose(){}};controls.push(control);return control;}}};
  const api=activateApi({vscode,context:{subscriptions:[]},getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient:primary});
  api.sourceTree.syncWorkspaces([{workspaceKey:'projects.A',checkoutPath:'/checkout'}]);
  const old=api.sourceTree.updateScm('projects.A');await new Promise(resolve=>setImmediate(resolve));
  await api.run('projects.A','configure',{systemIds:['NEW']});const refreshed=api.sourceTree.updateScm('projects.A');
  await refreshed;releaseOld({ok:true,checkoutPath:'/checkout',settings:{systemIds:['OLD']},files:[{path:'old.gss',state:'MODIFIED',inScope:true}]});await old;
  assert.equal(statusCalls,3);assert.deepEqual(controls[0].group.resourceStates.map(x=>new URLSearchParams(x.resourceUri.query).get('path')),['new.gss']);await api.dispose();
});
test('a status scan started before pull cannot leave the project card with stale counts',async t=>{
  let releaseOld,statusCalls=0;const settings={systemIds:['A'],allSystems:false,dataSourceIds:[]};
  mockStateClient(t,undefined,async(_tool,_command,_args,_key,input)=>{
    if(input.summaryOnly)return {ok:true,checkoutPath:'/checkout',settings,summary:{sourceCount:2,changedCount:null},summaryComplete:false};
    statusCalls++;if(statusCalls===1)return new Promise(resolve=>{releaseOld=resolve;});
    return {ok:true,checkoutPath:'/checkout',settings,files:[],summary:{sourceCount:2,changedCount:1,uploadableCount:1}};
  },async()=>({ok:true,complete:true,index:{complete:true,indexGeneration:'new'}}));
  const vscode={workspace:{textDocuments:[]},commands:{registerCommand:()=>({dispose(){}})},window:{showErrorMessage:async message=>assert.fail(message)}};
  const api=activateApi({vscode,context:{subscriptions:[]},getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient:{request:()=>assert.fail()}});
  const old=api.run('projects.A','status');await new Promise(resolve=>setImmediate(resolve));await api.run('projects.A','pull');
  const current=await api.run('projects.A','status');releaseOld({ok:true,checkoutPath:'/checkout',settings,files:[],summary:{sourceCount:1,changedCount:0,uploadableCount:0}});
  assert.equal((await old).summary.sourceCount,2);assert.equal(current.summary.sourceCount,2);assert.equal((await api.readProjectSummary('projects.A')).summary.sourceCount,2);await api.dispose();
});
test('manifest exposes API source navigation, PAGE management and SCM actions',()=>{
  const manifest=require('../package.json'),views=manifest.contributes.views.guthon.map(x=>x.id);
  assert.deepEqual(views,['gushenCompletion.projectOverview','gushenCompletion.projectDetails','gushenCompletion.sourceView']);
  const tree=manifest.contributes.menus['view/item/context'].map(x=>x.command),scm=manifest.contributes.menus['scm/resourceState/context'].map(x=>x.command);
  for(const command of ['gushenCompletion.openApiPageEditor','gushenCompletion.showApiPageNodes','gushenCompletion.showApiReferences']) assert.ok(tree.includes(command));
  for(const command of ['gushenCompletion.showApiDiff','gushenCompletion.revertApiSource','gushenCompletion.uploadApiSource','gushenCompletion.resolveApiConflict']) assert.ok(scm.includes(command));
  for(const command of ['gushenCompletion.openSvnDocument','gushenCompletion.saveSvnToGuthon']) assert(manifest.contributes.commands.some(item=>item.command===command));
  assert(!manifest.contributes.commands.some(x=>x.command.includes('selectWorkspaceSourceMode')));
});
test('expired API session refreshes the project card after a failed pull',async t=>{
  mockStateClient(t,undefined,(...args)=>processClient.request(...args),(...args)=>processClient.request(...args));
  const handlers=new Map(),errors=[];let updates=0,updatesBeforeExpiry=0;
  const vscode={ProgressLocation:{Notification:1},workspace:{textDocuments:[]},commands:{registerCommand:(n,h)=>(handlers.set(n,h),{dispose(){}})},
    window:{withProgress:async(_options,action)=>action(),showErrorMessage:async message=>errors.push(message)}};
  const processClient={request:async(_tool,_cmd,args)=>{
    if(args[0]==='status')return {ok:true,checkoutPath:'/checkout',files:[]};
    if(args[0]==='editor-state')return {ok:true,editorToken:'token'};
    if(args[0]==='pull'){updatesBeforeExpiry=updates;return {ok:false,error:{code:'API_LOGIN_REQUIRED',message:'登录已过期'}};}
    throw Error(args[0]);}};
  activateApi({vscode,context:{subscriptions:[]},getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient,onUpdated:()=>updates++});
  await handlers.get('gushenCompletion.pullApiSource')('projects.demo');
  assert.equal(updates,updatesBeforeExpiry+1);assert.match(errors[0],/登录已过期/);
});
test('explicit field collection command opens exact JSON fragment without a picker',async t=>{
  mockStateClient(t,undefined,(...args)=>processClient.request(...args));
  const handlers=new Map(),calls=[],documents=[];let provider;
  class Emitter {constructor(){this.event=()=>({dispose(){}});}fire(){}dispose(){}}
  const vscode={EventEmitter:Emitter,ViewColumn:{Beside:2},FileType:{File:1},FilePermission:{Readonly:1},
    FileSystemError:{FileNotFound:()=>Error('missing'),NoPermissions:()=>Error('readonly')},
    Uri:{from:value=>({...value,toString(){return JSON.stringify(value);}}),file:fsPath=>({scheme:'file',fsPath})},
    commands:{registerCommand:(name,handler)=>(handlers.set(name,handler),{dispose(){}})},
    workspace:{textDocuments:documents,onDidChangeTextDocument:()=>({dispose(){}}),registerFileSystemProvider:(_scheme,p)=>(provider=p,{dispose(){}}),
      openTextDocument:async uri=>{const text=(await provider.readFile(uri)).toString();const doc={uri,version:1,isDirty:false,getText:()=>text};documents.push(doc);return doc;}},
    window:{showQuickPick:()=>assert.fail('field command must not prompt'),showErrorMessage:message=>assert.fail(message),showTextDocument:async doc=>({document:doc})}};
  const processClient={request:async(_tool,_command,args,_key,input)=>{calls.push({action:args[0],input});
    if(args[0]==='status')return {ok:true,checkoutPath:'/checkout',files:[]};
    if(args[0]==='editor-state')return {ok:true,editorToken:'token'};
    if(args[0]==='page' && input.action==='fragment')return {ok:true,sourcePath:input.path,jsonPointer:input.jsonPointer,sourceHash:'hash',editable:true,fragmentType:'collection',content:'[{"fieldId":"A"}]'};
    throw Error(args[0]);}};
  activateApi({vscode,context:{subscriptions:[]},getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient,onUpdated(){}});
  const uri=await handlers.get('gushenCompletion.openApiFieldCollection')({workspaceKey:'projects.demo',path:'page.xml',jsonPointer:'/views/0/fields'});
  assert.equal(uri.scheme,'guthon-api-edit');assert.equal(documents[0].getText(),'[{"fieldId":"A"}]');
  assert.deepEqual(calls.find(x=>x.action==='page').input,{action:'fragment',path:'page.xml',jsonPointer:'/views/0/fields'});
});
test('editor state uses a separate write client while remote pull is pending and closes before disposal',async t=>{
  const states=[],remoteCalls=[],handlers=new Map(),documents=[];let releasePull,remoteProcess;
  mockStateClient(t,entry=>states.push(entry),undefined,function(_tool,command,args,key,input){
    remoteProcess=this;remoteCalls.push({command,action:args[0],key,input});
    if(args[0]==='pull')return new Promise(resolve=>{releasePull=()=>resolve({ok:true});});
    throw Error('unexpected remote request');
  });
  const tool={toolPath:'/fake',toolHome:'/data'};
  const primary={request:()=>assert.fail('pull must not use the primary client')};
  const vscode={workspace:{textDocuments:documents},commands:{registerCommand:(n,h)=>(handlers.set(n,h),{dispose(){}})},window:{showErrorMessage:async message=>assert.fail(message)}};
  const api=activateApi({vscode,context:{subscriptions:[]},getTool:async()=>tool,processClient:primary});
  await api.editorState.add('projects.demo','/checkout');
  const pull=api.run('projects.demo','pull');
  await new Promise(resolve=>setImmediate(resolve));assert.ok(releasePull);
  documents.push({uri:{scheme:'file',fsPath:'/checkout/a.gss'},isDirty:true,version:4});
  await api.editorState.flush('projects.demo');
  assert.equal(states.at(-1).input.documents[0].dirty,true);
  assert.equal(states.at(-1).input.documents[0].version,4);
  assert.equal(states.at(-1).tool,tool);assert.notEqual(states.at(-1).client,primary);
  assert.equal(requestKind('api',states.at(-1).args),'write');
  assert.deepEqual(remoteCalls.map(call=>call.action),['pull']);assert.notEqual(remoteProcess,states.at(-1).client);
  const stateProcess=states.at(-1).client;
  releasePull();await pull;await api.dispose();
  assert.equal(states.at(-1).input.close,true);assert.equal(states.at(-1).input.editorToken,'token');
  assert.equal(stateProcess.disposed,true);assert.equal(remoteProcess.disposed,true);
});
test('virtual source URI retains case-sensitive workspace identity after authority normalization',async()=>{
  const {uriFor,decodeIdentity}=require('../src/source/virtual-fs'),{ApiEditorState}=require('../src/api/editor-state');
  const vscode={Uri:{from:o=>({...o,authority:o.authority.toLowerCase(),toString(){return JSON.stringify(this);}})},workspace:{textDocuments:[]}};
  const uri=uriFor(vscode,{workspaceKey:'products.GuthonOfficial',sourcePath:'page.xml',sourceType:'page',jsonPointer:'/pageEvents/onOpenScript',fragmentType:'js'});
  assert.equal(uri.authority,'products.guthonofficial');assert.equal(decodeIdentity(uri).workspaceKey,'products.GuthonOfficial');
  const calls=[],state=new ApiEditorState({vscode,run:async(key,_action,payload)=>(calls.push({key,payload}),{editorToken:'owner'})});
  await state.add('products.GuthonOfficial','/checkout');vscode.workspace.textDocuments.push({uri,isDirty:true,version:7});await state.flush('products.GuthonOfficial');
  assert.deepEqual(calls.at(-1).payload.documents,[{path:'page.xml',dirty:true,version:7}]);await state.close();
});
test('a long status scan does not block source reads on the primary client',async t=>{
  let finishStatus,statusProcess;const primaryCalls=[];
  t.mock.method(ToolProcessClient.prototype,'request',function(_tool,command,args){
    assert.equal(command,'api');assert.equal(args[0],'status');statusProcess=this;
    return new Promise(resolve=>{finishStatus=()=>resolve({ok:true,checkoutPath:'/checkout'});});
  });
  const primary={request:async(_tool,_command,args)=>{primaryCalls.push(args[0]);return {ok:true,content:'source'};}};
  const vscode={workspace:{textDocuments:[]},commands:{registerCommand:()=>({dispose(){}})},window:{showErrorMessage:async()=>{}}};
  const api=activateApi({vscode,context:{subscriptions:[]},getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient:primary});
  const pending=api.run('projects.demo','status');await new Promise(resolve=>setImmediate(resolve));assert.ok(finishStatus);
  const read=await api.run('projects.demo','read',{path:'a.gss'});assert.equal(read.content,'source');assert.deepEqual(primaryCalls,['read']);
  finishStatus();await pending;await api.dispose();assert.equal(statusProcess.disposed,true);
});
test('a blocked session is deduplicated and does not block local read, catalog, or configuration',async t=>{
  let releaseSession,remoteProcess;const remoteCalls=[],localCalls=[],summaryCalls=[],handlers=new Map();
  const tool={toolPath:'/fake',toolHome:'/data'};
  t.mock.method(ToolProcessClient.prototype,'request',function(actual,command,args,key,input){
    assert.equal(actual,tool);assert.equal(command,'api');
    if(args[0]==='session' && input?.localOnly)return Promise.resolve({ok:true,authenticated:true});
    if(args[0]==='status') {summaryCalls.push(input);return Promise.resolve({ok:true,checkoutPath:'/checkout',settings:{serverUrl:'https://old.invalid'}});}
    remoteProcess ||= this;assert.equal(this,remoteProcess);remoteCalls.push({action:args[0],key,input});
    assert.equal(requestKind(command,args),'write');
    if(args[0]==='session')return new Promise(resolve=>{releaseSession=()=>resolve({ok:true,authenticated:true});});
    return Promise.resolve({ok:true});
  });
  const primary={request:async(_tool,_command,args,key,input)=>(localCalls.push({action:args[0],key,input}),{ok:true})};
  const vscode={workspace:{textDocuments:[]},commands:{registerCommand:(name,handler)=>(handlers.set(name,handler),{dispose(){}})},
    window:{showInputBox:async()=> 'https://new.invalid',showErrorMessage:async message=>assert.fail(message)}};
  const api=activateApi({vscode,context:{subscriptions:[]},getTool:async()=>tool,processClient:primary});
  const one=api.run('projects.A','session'),two=api.run('projects.A','session');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(remoteCalls.length,1);assert.ok(releaseSession);
  await api.run('projects.A','read',{path:'a.gss'});await api.run('projects.A','catalog',{limit:100,offset:0});
  await handlers.get('gushenCompletion.configureApiSource')('projects.A');
  assert.deepEqual(localCalls.map(x=>x.action),['read','catalog','configure']);
  assert.deepEqual(summaryCalls,[{summaryOnly:true,changesOnly:true}]);assert.equal(remoteCalls.length,1);
  releaseSession();assert.deepEqual(await one,await two);
  for(const action of ['captcha','login','systems','data-sources','designer-context','system-menu','pull','scope-apply','refresh','upload','verify-upload','sync-database','platform-request','create-function']) await api.run('projects.A',action,{});
  assert.equal(remoteCalls.length,15);assert.equal(localCalls.length,3);
  assert.equal(remoteProcess.allowReadLane,false);await api.dispose();assert.equal(remoteProcess.disposed,true);
});
test('failed session requests are removed from the deduplication map',async t=>{
  let attempts=0;t.mock.method(ToolProcessClient.prototype,'request',async(_tool,_command,args)=>{
    assert.equal(args[0],'session');attempts++;return attempts===1?{ok:false,error:{code:'API_CONNECTION_FAILED',message:'offline'}}:{ok:true,authenticated:false};
  });
  const vscode={workspace:{textDocuments:[]},commands:{registerCommand:()=>({dispose(){}})},window:{showErrorMessage:async()=>{}}};
  const api=activateApi({vscode,context:{subscriptions:[]},getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient:{request:()=>assert.fail()}});
  await assert.rejects(api.run('projects.A','session'),/offline/);assert.equal((await api.run('projects.A','session')).authenticated,false);assert.equal(attempts,2);await api.dispose();
});
test('session requests for different workspaces are not combined',async t=>{
  const calls=[],releases=[];t.mock.method(ToolProcessClient.prototype,'request',function(_tool,_command,args,key){
    assert.equal(args[0],'session');calls.push(key);return new Promise(resolve=>releases.push(()=>resolve({ok:true,workspace:key})));
  });
  const vscode={workspace:{textDocuments:[]},commands:{registerCommand:()=>({dispose(){}})},window:{showErrorMessage:async()=>{}}};
  const api=activateApi({vscode,context:{subscriptions:[]},getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient:{request:()=>assert.fail()}});
  const first=api.run('projects.A','session'),second=api.run('projects.B','session');await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['projects.A','projects.B']);releases.forEach(release=>release());assert.equal((await first).workspace,'projects.A');assert.equal((await second).workspace,'projects.B');await api.dispose();
});
test('separate ToolHost processes keep local requests responsive while a shared remote session waits', {timeout:12000},async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-remote-lane-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const entry=path.join(home,'host.js');fs.writeFileSync(entry,String.raw`
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const home=process.argv[process.argv.indexOf('--home')+1],queue=[];let busy=false,authenticated=false;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
function pump(){if(busy || !queue.length)return;busy=true;const job=queue.shift(),action=job.args[0];
  const finish=()=>{if(action==='login')authenticated=true;send({type:'result',id:job.id,ok:true,result:{ok:true,action,authenticated,checkoutPath:'/checkout',settings:{serverUrl:'https://fixture.invalid'}}});busy=false;pump();};
  if(action==='session' && !job.input?.localOnly) {fs.appendFileSync(path.join(home,'sessions'),'session\n');const timer=setInterval(()=>{if(fs.existsSync(path.join(home,'release'))){clearInterval(timer);finish();}},10);}else finish();
}
send({type:'ready',protocolVersion:1});readline.createInterface({input:process.stdin}).on('line',line=>{queue.push(JSON.parse(line));pump();});
`);
  const tool={mode:'source-development',toolPath:process.execPath,toolEntry:entry,toolHome:home},primary=new ToolProcessClient();
  const vscode={workspace:{textDocuments:[]},commands:{registerCommand:()=>({dispose(){}})},window:{showErrorMessage:async message=>assert.fail(message)}};
  const api=activateApi({vscode,context:{subscriptions:[]},getTool:async()=>tool,processClient:primary});
  try {
    const first=api.run('projects.A','session'),second=api.run('projects.A','session');
    const deadline=Date.now()+4000;while(!fs.existsSync(path.join(home,'sessions'))) {if(Date.now()>deadline)throw Error('remote session did not start');await new Promise(resolve=>setTimeout(resolve,10));}
    const local=Promise.all([api.run('projects.A','read',{path:'a.gss'}),api.run('projects.A','catalog',{limit:1}),api.run('projects.A','configure',{}),api.readProjectSummary('projects.A')]);
    let timeout;const results=await Promise.race([local,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('local requests blocked by remote session')),4000);})]).finally(()=>clearTimeout(timeout));
    assert.deepEqual(results.map(x=>x.action),['read','catalog','configure','status']);
    assert.equal(fs.readFileSync(path.join(home,'sessions'),'utf8'),'session\n');
    fs.writeFileSync(path.join(home,'release'),'');assert.deepEqual(await first,await second);
    await api.run('projects.A','login',{userId:'synthetic',password:'synthetic'});assert.equal((await api.run('projects.A','systems')).authenticated,true);
    fs.unlinkSync(path.join(home,'release'));const interrupted=api.run('projects.A','session').then(()=>null,error=>error);
    const stopDeadline=Date.now()+4000;while(fs.readFileSync(path.join(home,'sessions'),'utf8').split('\n').length<3) {if(Date.now()>stopDeadline)throw Error('second remote session did not start');await new Promise(resolve=>setTimeout(resolve,10));}
    await api.dispose();assert.match((await interrupted).message,/已停止/);await assert.rejects(api.run('projects.A','session'),/已关闭/);
  } finally {fs.writeFileSync(path.join(home,'release'),'');await api.dispose();await primary.stop();primary.dispose();}
});

test('simultaneous current-project status refreshes share one scan and later calls rescan',async t=>{
  let reads=0,finish;
  mockStateClient(t,()=>{},async()=>{reads++;return await new Promise(resolve=>{finish=resolve;});});
  const vscode={workspace:{textDocuments:[]},commands:{registerCommand:()=>({dispose(){}})},window:{showErrorMessage:async()=>{}}};
  const api=activateApi({vscode,context:{subscriptions:[]},getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient:{request:()=>assert.fail('status must use its own lane')}});
  const one=api.run('projects.A','status'),two=api.run('projects.A','status');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);
  finish({ok:true,summary:{sourceCount:16000}});assert.deepEqual(await one,await two);
  const three=api.run('projects.A','status');await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,2);finish({ok:true,summary:{sourceCount:16001}});assert.equal((await three).summary.sourceCount,16001);
});

test('default PAGE editing opens the Nexus local controller without requesting platform authentication',async t=>{
  const {PageEditorController}=require('../src/page-editor/controller'),opened=[],handlers=new Map();
  t.mock.method(PageEditorController.prototype,'open',async function(identity){opened.push({identity,online:typeof this.openOnline});return 'local';});
  mockStateClient(t,undefined,async()=>({ok:true,checkoutPath:'/checkout',settings:{serverUrl:'https://fixture.invalid'}}),()=>assert.fail('local editing must not request remote authentication'));
  class Emitter {constructor(){this.event=()=>({dispose(){}});}fire(){}dispose(){}}
  const vscode={EventEmitter:Emitter,Uri:{file:fsPath=>({scheme:'file',fsPath})},
    workspace:{textDocuments:[],onDidChangeTextDocument:()=>({dispose(){}}),registerFileSystemProvider:()=>({dispose(){}})},
    commands:{registerCommand:(name,handler)=>(handlers.set(name,handler),{dispose(){}})},window:{showErrorMessage:message=>assert.fail(message)}};
  const api=activateApi({vscode,context:{subscriptions:[]},getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient:{request:()=>assert.fail('stub controller should not read source')}});
  const id={workspaceKey:'projects.A',path:'page.xml',sourceName:'测试页面'};
  assert.equal(await handlers.get('gushenCompletion.openApiPageEditor')(id),'local');
  assert.equal(await handlers.get('gushenCompletion.editApiPage')(id),'local');
  assert.equal(opened.length,2);assert.deepEqual(opened[0],{identity:{workspaceKey:'projects.A',sourcePath:'page.xml',sourceType:'page',sourceId:undefined,sourceName:'测试页面'},online:'function'});
  await api.dispose();
});

test('explicit online commands reuse the official designer and read only a lightweight workspace summary',async t=>{
  const handlers=new Map(),calls=[],panels=[],errors=[],content='{"pageId":"P1"}';
  const doc={uri:{scheme:'file',fsPath:'/checkout/page.json',toString:()=>'/checkout/page.json'},version:1,isDirty:false,getText:()=>content};
  mockStateClient(t,({input})=>calls.push({action:'editor-state',input}),async(_tool,_command,args,_key,input)=>{
    calls.push({action:args[0],input});return {ok:true,checkoutPath:'/checkout',settings:{}};
  },async(_tool,_command,args)=>{calls.push({action:args[0]});assert.equal(args[0],'designer-context');return {ok:true,rootUrl:'https://example.invalid',accessToken:'x',user:{}};});
  const vscode={Uri:{file:p=>({scheme:'file',fsPath:p,toString:()=>p})},ViewColumn:{Active:1},
    workspace:{textDocuments:[doc],openTextDocument:async()=>doc,onDidChangeTextDocument:()=>({dispose(){}})},
    commands:{registerCommand:(name,handler)=>(handlers.set(name,handler),{dispose(){}})},
    window:{showErrorMessage:async message=>errors.push(message),showWarningMessage:async()=>{},createWebviewPanel:()=>{
      const panel={reveal(){this.reveals=(this.reveals||0)+1;},onDidDispose(fn){this.closed=fn;},dispose(){this.closed();},
        webview:{postMessage:async()=>{},onDidReceiveMessage:()=>({dispose(){}})}};panels.push(panel);return panel;}}};
  const primary={request:async(_tool,_command,args,_key,input)=>{calls.push({action:args[0],input});assert.equal(args[0],'read');return {ok:true,content,sourceHash:'h',metadata:{sourceType:'page',pageId:'P1'}};}};
  const api=activateApi({vscode,context:{subscriptions:[]},getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient:primary});
  const identity={workspaceKey:'projects.A',path:'page.json'};
  const [a,b]=await Promise.all(['openApiDesigner','openApiDesigner'].map(name=>handlers.get('gushenCompletion.'+name)(identity)));
  assert.equal(a,b);assert.equal(panels.length,1);assert.equal(panels[0].reveals,1);
  assert.equal(calls.filter(x=>x.action==='read').length,1);assert.equal(calls.filter(x=>x.action==='designer-context').length,1);
  assert.deepEqual(calls.filter(x=>x.action==='status').map(x=>x.input),[{summaryOnly:true,changesOnly:true}]);
  assert.deepEqual(errors,[]);await handlers.get('gushenCompletion.logoutApiSource')('projects.A');
  assert.match(errors[0],/保存并关闭.*页面编辑器/);assert.equal(calls.some(x=>x.action==='logout'),false);
  panels[0].dispose();await api.dispose();
});

test('API operation output streams actual backend progress without logging source input',async t=>{
  const lines=[],output={show:()=>lines.push('show'),append:value=>lines.push(value),appendLine:value=>lines.push(value)};
  mockStateClient(t,undefined,undefined,async(_tool,_command,args,_key,_input,options)=>{
    assert.equal(args[0],'upload');options.onOutput('[谷神 API] 已记录阶段 · op · REMOTE_READBACK_VERIFIED\n');
    return {ok:true,operationId:'op',complete:true};
  });
  const vscode={workspace:{textDocuments:[]},commands:{registerCommand:()=>({dispose(){}})},window:{showErrorMessage:async message=>assert.fail(message)}};
  const api=activateApi({vscode,context:{subscriptions:[]},getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient:{request:()=>assert.fail()},getOutput:()=>output});
  await api.run('projects.A','upload',{content:'private-source',password:'private-password'});
  assert.equal(lines[0],'show');assert.match(lines.join('\n'),/REMOTE_READBACK_VERIFIED/);assert.match(lines.at(-1),/耗时/);
  assert.equal(lines.some(line=>/private-source|private-password/.test(line)),false);await api.dispose();
});

test('tree refresh and function creation preserve the full selected directory node',async t=>{
  const f=fixture(t),api=activateApi({vscode:f.vscode,context:{subscriptions:[]},getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient:{request:()=>assert.fail()}});
  const nodes=[],folder={key:'projects.A',sourcePrefix:'datasources/D/procedures/pkg'};
  api.sourceTree.refreshScope=async node=>nodes.push(node);api.sourceTree.createFunction=async(key,node)=>nodes.push({key,node});
  await f.handlers.get('gushenCompletion.refreshApiObject')(folder);
  await f.handlers.get('gushenCompletion.createApiFunction')(folder);
  assert.equal(nodes[0],folder);assert.deepEqual(nodes[1],{key:'projects.A',node:folder});assert.equal(f.errors.length,0);await api.dispose();
});

test('stored Nexus login restores via stdin and tool-settings logout clears it without stopping editors',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{ApiLoginStore}=require('../src/api/login-store');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-login-integration-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const scope={toolHome:'/data',workspaceKey:'projects.A',serverUrl:'https://fixture.invalid'},store=new ApiLoginStore(directory),handlers=new Map(),calls=[],messages=[];
  store.save(scope,{userId:'fixture',password:'private-secret'});let logged=false;
  t.mock.method(ToolProcessClient.prototype,'request',async function(_tool,_command,args,key,input){
    calls.push({action:args[0],key,input});
    if(args[0]==='status')return {ok:true,checkoutPath:'/checkout',settings:{serverUrl:scope.serverUrl}};
    if(args[0]==='session')return {ok:true,authenticated:logged,session:logged?{userName:'Fixture'}:null};
    if(args[0]==='login'){logged=true;assert.deepEqual(input,{userId:'fixture',password:'private-secret'});return {ok:true,session:{userName:'Fixture'}};}
    if(args[0]==='logout'){logged=false;return {ok:true,authenticated:false,session:null};}
    throw Error(args[0]);
  });
  const vscode={workspace:{textDocuments:[]},commands:{registerCommand:(name,handler)=>(handlers.set(name,handler),{dispose(){}})},window:{showInformationMessage:async text=>messages.push(text),showErrorMessage:async text=>assert.fail(text)}};
  const api=activateApi({vscode,context:{subscriptions:[],globalStorageUri:{fsPath:directory}},getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient:{request:()=>assert.fail()},loginStore:store});
  assert.equal((await api.run('projects.A','session')).authenticated,true);
  const drafts=api.editorState.drafts;drafts.set('existing',{key:'projects.A',path:'page.xml',dirty:true});
  await handlers.get('gushenCompletion.logoutApiSource')('projects.A');
  assert.equal(store.read(scope),undefined);assert.equal((await api.run('projects.A','session')).authenticated,false);assert.equal(drafts.has('existing'),true);
  assert.equal(calls.filter(call=>call.action==='login').length,1);assert.equal(calls.filter(call=>call.action==='logout').length,1);assert.match(messages[0],/已退出当前项目/);
  const menu=require('../package.json').contributes.menus['gushenCompletion.projectSettings'];assert(menu.some(item=>item.command==='gushenCompletion.projectMenuLogout'));
  await api.dispose();
});

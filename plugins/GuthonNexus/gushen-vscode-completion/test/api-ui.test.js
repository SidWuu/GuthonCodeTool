const test=require('node:test');
const assert=require('node:assert/strict');
const {activateApi}=require('../src/api/activate');
const {ToolProcessClient,requestKind}=require('../src/tool-process-client');
function mockStateClient(t,record=()=>{}) {
  t.mock.method(ToolProcessClient.prototype,'request',async function(tool,command,args,key,input) {
    assert.deepEqual(args,['editor-state','--stdin']);assert.equal(command,'api');
    record({client:this,tool,command,args,key,input});return {ok:true,editorToken:'token'};
  });
}
function fixture(t,dirty=false) {
  const calls=[],handlers=new Map(),errors=[];
  mockStateClient(t,({command,args})=>calls.push([command,args]));
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
test('login shows captcha and passes remember to shared backend credential store',async()=>{
  const calls=[],handlers=new Map(),secrets=new Map(),inputs=['alice','password','1234'];let html='',disposed=false;
  const vscode={workspace:{textDocuments:[]},ViewColumn:{Active:1},commands:{registerCommand:(n,h)=>(handlers.set(n,h),{dispose(){}})},
    window:{showInputBox:async()=>inputs.shift(),showQuickPick:async()=>({remember:true}),showInformationMessage:async()=>{},showErrorMessage:async m=>{throw Error(m)},
      createWebviewPanel:()=>({webview:{set html(x){html=x;}},dispose(){disposed=true;}})}};
  const context={subscriptions:[],secrets:{get:async k=>secrets.get(k),store:async(k,v)=>secrets.set(k,v),delete:async k=>secrets.delete(k)}};
  const processClient={request:async(_tool,_cmd,args,key,input)=>{calls.push({action:args[0],key,input});return args[0]==='captcha'?{ok:true,dataURL:'data:image/png;base64,YQ=='}:args[0]==='status'?{ok:true,settings:{serverUrl:'https://project.invalid'}}:{ok:true};}};
  activateApi({vscode,context,getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient,onUpdated(){}});
  await handlers.get('gushenCompletion.loginApiSource')('projects.demo');
  assert.match(html,/data:image\/png;base64,YQ==/);assert.equal(disposed,true);
  assert.deepEqual(calls.find(x=>x.action==='login').input,{userId:'alice',password:'password',randCode:'1234',remember:true});
  assert.equal(secrets.size,0);
});
test('manifest exposes API source navigation, PAGE management and SCM actions',()=>{
  const manifest=require('../package.json'),views=manifest.contributes.views.guthon.map(x=>x.id);
  assert.deepEqual(views,['gushenCompletion.projectDetails','gushenCompletion.toolView','gushenCompletion.sourceView']);
  const tree=manifest.contributes.menus['view/item/context'].map(x=>x.command),scm=manifest.contributes.menus['scm/resourceState/context'].map(x=>x.command);
  for(const command of ['gushenCompletion.openApiPageEditor','gushenCompletion.showApiPageNodes','gushenCompletion.showApiProcedureCallers']) assert.ok(tree.includes(command));
  for(const command of ['gushenCompletion.showApiDiff','gushenCompletion.revertApiSource','gushenCompletion.uploadApiSource','gushenCompletion.resolveApiConflict']) assert.ok(scm.includes(command));
  assert.equal(manifest.contributes.commands.some(x=>/Svn|selectWorkspaceSourceMode/.test(x.command)),false);
});
test('expired API session refreshes the project card after a failed pull',async t=>{
  mockStateClient(t);
  const handlers=new Map(),errors=[];let updates=0;
  const vscode={ProgressLocation:{Notification:1},workspace:{textDocuments:[]},commands:{registerCommand:(n,h)=>(handlers.set(n,h),{dispose(){}})},
    window:{withProgress:async(_options,action)=>action(),showErrorMessage:async message=>errors.push(message)}};
  const processClient={request:async(_tool,_cmd,args)=>{
    if(args[0]==='status')return {ok:true,checkoutPath:'/checkout',files:[]};
    if(args[0]==='editor-state')return {ok:true,editorToken:'token'};
    if(args[0]==='pull')return {ok:false,error:{code:'API_LOGIN_REQUIRED',message:'登录已过期'}};
    throw Error(args[0]);}};
  activateApi({vscode,context:{subscriptions:[]},getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient,onUpdated:()=>updates++});
  await handlers.get('gushenCompletion.pullApiSource')('projects.demo');
  assert.equal(updates,1);assert.match(errors[0],/登录已过期/);
});
test('explicit field collection command opens exact JSON fragment without a picker',async t=>{
  mockStateClient(t);
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
test('editor state uses a separate write client while primary pull is pending and closes before disposal',async t=>{
  const states=[],primaryCalls=[],handlers=new Map(),documents=[];let releasePull;
  mockStateClient(t,entry=>states.push(entry));
  const tool={toolPath:'/fake',toolHome:'/data'};
  const primary={request:async(_tool,command,args,key,input)=>{
    primaryCalls.push({command,action:args[0],key,input});
    if(args[0]==='pull')return new Promise(resolve=>{releasePull=()=>resolve({ok:true});});
    throw Error('unexpected primary request');
  }};
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
  assert.deepEqual(primaryCalls.map(call=>call.action),['pull']);
  const stateProcess=states.at(-1).client;
  releasePull();await pull;await api.dispose();
  assert.equal(states.at(-1).input.close,true);assert.equal(states.at(-1).input.editorToken,'token');
  assert.equal(stateProcess.disposed,true);
});

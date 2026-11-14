const test=require('node:test');
const assert=require('node:assert/strict');
const {activateApi}=require('../src/api/activate');
const {ToolProcessClient,requestKind}=require('../src/tool-process-client');
function mockStateClient(t,record=()=>{},statusRequest,remoteRequest) {
  t.mock.method(ToolProcessClient.prototype,'request',async function(tool,command,args,key,input) {
    if(args[0]==='status' && statusRequest) return statusRequest(tool,command,args,key,input);
    if(args[0]!=='editor-state' && remoteRequest) return remoteRequest.call(this,tool,command,args,key,input);
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
test('login shows captcha and passes remember to shared backend credential store',async t=>{
  mockStateClient(t,undefined,undefined,(...args)=>processClient.request(...args));
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
test('subsystem selection reads lightweight project settings',async t=>{
  const summaries=[],calls=[],handlers=new Map();
  mockStateClient(t,undefined,async(_tool,_command,args,_key,input)=>{assert.equal(args[0],'status');summaries.push(input);return {ok:true,checkoutPath:'/checkout',settings:{allSystems:false,systemIds:['A'],dataSourceIds:[]}};},
    async(_tool,_command,args)=>args[0]==='systems'?{ok:true,systems:[{systemId:'A',systemName:'系统',dataSourceId:'D'}]}:{ok:true,dataSources:[]});
  const vscode={workspace:{textDocuments:[]},commands:{registerCommand:(name,handler)=>(handlers.set(name,handler),{dispose(){}})},
    window:{showQuickPick:async items=>items.filter(x=>x.systemId==='A'),showErrorMessage:async message=>assert.fail(message)}};
  const primary={request:async(_tool,_command,args,_key,input)=>(calls.push({action:args[0],input}),{ok:true})};
  const api=activateApi({vscode,context:{subscriptions:[]},getTool:async()=>({toolPath:'/fake',toolHome:'/data'}),processClient:primary});
  await handlers.get('gushenCompletion.selectApiSystems')('projects.A');
  assert.deepEqual(summaries,[{summaryOnly:true,changesOnly:true}]);assert.deepEqual(calls,[{action:'configure',input:{allSystems:false,systemIds:['A'],dataSourceIds:[]}}]);await api.dispose();
});
test('manifest exposes API source navigation, PAGE management and SCM actions',()=>{
  const manifest=require('../package.json'),views=manifest.contributes.views.guthon.map(x=>x.id);
  assert.deepEqual(views,['gushenCompletion.projectDetails','gushenCompletion.sourceView']);
  const tree=manifest.contributes.menus['view/item/context'].map(x=>x.command),scm=manifest.contributes.menus['scm/resourceState/context'].map(x=>x.command);
  for(const command of ['gushenCompletion.openApiPageEditor','gushenCompletion.showApiPageNodes','gushenCompletion.showApiProcedureCallers']) assert.ok(tree.includes(command));
  for(const command of ['gushenCompletion.showApiDiff','gushenCompletion.revertApiSource','gushenCompletion.uploadApiSource','gushenCompletion.resolveApiConflict']) assert.ok(scm.includes(command));
  assert.equal(manifest.contributes.commands.some(x=>/Svn|selectWorkspaceSourceMode/.test(x.command)),false);
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
  for(const action of ['captcha','login','systems','data-sources','designer-context','system-menu','pull','refresh','upload','verify-upload','sync-database','platform-request','create-function']) await api.run('projects.A',action,{});
  assert.equal(remoteCalls.length,14);assert.equal(localCalls.length,3);
  await api.dispose();assert.equal(remoteProcess.disposed,true);
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
  if(action==='session') {fs.appendFileSync(path.join(home,'sessions'),'session\n');const timer=setInterval(()=>{if(fs.existsSync(path.join(home,'release'))){clearInterval(timer);finish();}},10);}else finish();
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

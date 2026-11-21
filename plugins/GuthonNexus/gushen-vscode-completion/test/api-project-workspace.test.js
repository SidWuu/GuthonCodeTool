const test=require('node:test');
const assert=require('node:assert/strict');
const {openProjectWorkspace}=require('../src/api/project-workspace');
const {activateApi}=require('../src/api/activate');

test('opening source focuses the current view without replacing the window',async()=>{
  const calls=[];const vscode={commands:{executeCommand:async(...args)=>calls.push(args)}};
  await openProjectWorkspace(vscode);
  assert.deepEqual(calls,[['gushenCompletion.sourceView.focus']]);
});

test('opening a workspace selects its explicit identity before focusing the source view',async()=>{
  const handlers=new Map(),calls=[];
  const vscode={workspace:{workspaceFolders:[],textDocuments:[],getConfiguration:()=>({get:(_key,fallback)=>fallback})},
    commands:{registerCommand:(id,handler)=>(handlers.set(id,handler),{dispose(){}}),executeCommand:async(...args)=>calls.push(args)},
    window:{showErrorMessage:async message=>{throw Error(message);}}};
  const api=activateApi({vscode,context:{subscriptions:[]},getTool:async()=>({toolPath:'/test',toolHome:'/test'}),processClient:{}});
  api.setSelectWorkspace(async(key,options)=>{calls.push(['select',key,options]);return {workspaceKey:key};});
  await handlers.get('gushenCompletion.openApiCheckout')('ws_a');
  assert.deepEqual(calls,[['select','ws_a',{switchWindow:true}],['gushenCompletion.sourceView.focus']]);
});

test('root window registers dirty buffers and watchers for both workspaces but scans only the selected one',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const {ToolProcessClient}=require('../src/tool-process-client');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-root-register-'));
  const a=path.join(home,'var','A','checkout'),b=path.join(home,'var','B','checkout');
  const events=[],watchers=[],state=new Map();
  t.mock.method(ToolProcessClient.prototype,'request',async(_tool,_command,args,key,input)=>{
    events.push({action:args[0],key,input});
    if(args[0]==='editor-state')return {ok:true,editorToken:'token-'+key};
    if(args[0]==='status')return {ok:true,checkoutPath:key==='A'?a:b,files:[],settings:{}};
    throw new Error('unexpected request '+args[0]);
  });
  const vscode={RelativePattern:class{constructor(base,pattern){this.base=base;this.pattern=pattern;}},
    workspace:{textDocuments:[{uri:{scheme:'file',fsPath:path.join(b,'systems/S/pages/main/P/page.xml')},isDirty:true,version:4}],
      createFileSystemWatcher:pattern=>{const watcher={pattern,onDidChange(){},onDidCreate(){},onDidDelete(){},dispose(){}};watchers.push(watcher);return watcher;}},
    commands:{registerCommand:()=>({dispose(){}}),executeCommand:async()=>{}},window:{showErrorMessage:async message=>{throw Error(message);}}};
  const context={subscriptions:[],workspaceState:{get:key=>state.get(key),update:async(key,value)=>state.set(key,value)}};
  const api=activateApi({vscode,context,getTool:async()=>({toolPath:'/fake',toolHome:home}),processClient:{}});
  t.after(async()=>{await api.dispose();fs.rmSync(home,{recursive:true,force:true});});
  await api.syncWorkspaces([{workspaceKey:'A',checkoutPath:a},{workspaceKey:'B',checkoutPath:b},{workspaceKey:'bad',checkoutPath:'relative'}],'A');
  assert.deepEqual([...api.editorState.workspaces.keys()].sort(),['A','B']);
  assert.deepEqual(watchers.map(item=>item.pattern.base).sort(),[a,b].sort());
  assert.deepEqual(events.filter(item=>item.action==='status').map(item=>item.key),['A']);
  assert.deepEqual(events.find(item=>item.action==='editor-state' && item.key==='B').input.documents,
    [{path:'systems/S/pages/main/P/page.xml',dirty:true,version:4}]);
  await api.editorState.setDraft('page:A','A','draft.xml',true,2);
  await api.syncWorkspaces([{workspaceKey:'A',checkoutPath:a},{workspaceKey:'B',checkoutPath:b}],'B');
  assert.equal(api.editorState.drafts.get('page:A').dirty,true);assert.equal(watchers.length,2);
  assert.deepEqual(events.filter(item=>item.action==='status').map(item=>item.key),['A','B']);
});

test('old status and session requests cannot merge into a new toolHome with the same key',async t=>{
  const {ToolProcessClient}=require('../src/tool-process-client');
  let tool={toolHome:'/old',toolPath:'/runtime'},updates=0;const pending=[];
  t.mock.method(ToolProcessClient.prototype,'request',async(current,_command,args,key,input)=>{
    if(args[0]==='status' && input?.summaryOnly)return {ok:true,checkoutPath:'/same/checkout',settings:{},summary:{sourceCount:99}};
    if(args[0]==='status' || args[0]==='session')return new Promise(resolve=>pending.push({home:current.toolHome,action:args[0],key,resolve}));
    throw Error('unexpected request '+args[0]);
  });
  const vscode={workspace:{textDocuments:[]},commands:{registerCommand:()=>({dispose(){}})},window:{showErrorMessage:async()=>{}}};
  const api=activateApi({vscode,context:{subscriptions:[]},getTool:async()=>tool,processClient:{},onUpdated:()=>updates++,loginStore:{canRestore:true,read:()=>({userId:'u',password:'p'})}});
  t.after(()=>api.dispose());
  const oldStatus=api.run('same','status'),oldSession=api.run('same','session',{localOnly:true});
  while(pending.length<2)await new Promise(resolve=>setImmediate(resolve));
  await api.reset();tool={toolHome:'/new',toolPath:'/runtime'};
  const newStatus=api.run('same','status'),newSession=api.run('same','session',{localOnly:true});
  while(pending.length<4)await new Promise(resolve=>setImmediate(resolve));
  const oldStatusRejected=assert.rejects(oldStatus,error=>error.code==='API_WORKSPACE_SWITCHED');
  const oldSessionRejected=assert.rejects(oldSession,error=>error.code==='API_WORKSPACE_SWITCHED');
  pending.find(x=>x.home==='/old' && x.action==='status').resolve({ok:true,checkoutPath:'/same/checkout',settings:{},summary:{sourceCount:1}});
  pending.find(x=>x.home==='/old' && x.action==='session').resolve({ok:true,authenticated:false});
  await Promise.all([oldStatusRejected,oldSessionRejected]);
  const duplicateStatus=api.run('same','status'),duplicateSession=api.run('same','session',{localOnly:true});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(pending.length,4);
  pending.find(x=>x.home==='/new' && x.action==='status').resolve({ok:true,checkoutPath:'/same/checkout',settings:{},summary:{sourceCount:2}});
  pending.find(x=>x.home==='/new' && x.action==='session').resolve({ok:true,authenticated:true,session:{userName:'new'}});
  assert.equal((await newStatus).summary.sourceCount,2);assert.equal((await newSession).session.userName,'new');
  assert.equal((await duplicateStatus).summary.sourceCount,2);assert.equal((await duplicateSession).session.userName,'new');
  const summary=await api.readProjectSummary('same');assert.equal(summary.summary.sourceCount,2);assert.equal(summary.summaryComplete,true);
  assert.equal(updates,1);assert.equal(pending.length,4);
});

test('a tool lookup pending across reset cannot start an old status request',async t=>{
  let finish,lookups=0,requests=0;
  const vscode={workspace:{textDocuments:[]},commands:{registerCommand:()=>({dispose(){}})},window:{showErrorMessage:async()=>{}}};
  const api=activateApi({vscode,context:{subscriptions:[]},getTool:()=>{lookups++;return new Promise(resolve=>{finish=resolve;});},processClient:{request:async()=>{requests++;}}});
  t.after(()=>api.dispose());
  const pending=api.run('same','status');assert.equal(lookups,1);await api.reset();finish({toolHome:'/old',toolPath:'/runtime'});
  await assert.rejects(pending,error=>error.code==='API_WORKSPACE_SWITCHED');assert.equal(requests,0);
});

const assert=require('node:assert/strict');const test=require('node:test');
const {createApiNavigation}=require('../src/api/navigation');
const {registerLegacyProjects}=require('../src/legacy-project');

function fixture({legacyWorkspaces=[],legacyDefinitions}={}) {
  const calls=[],disposable={dispose(){}},root='/checkout/demo',state={root};
  const workspace={workspaceKey:'projects.demo',sourceMode:'api',displayName:'Demo',sourceRoots:[{path:root}]};
  const uri=value=>({...value,toString:()=>JSON.stringify(value)});
  const filesystems=new Map(),subscriptions=[],getTool=()=>({toolHome:'/tmp'});
  let selector,provider;
  const vscode={Uri:{from:uri,file:fsPath=>uri({scheme:'file',fsPath})},
    Range:class{constructor(start,end){Object.assign(this,{start,end});}},
    EventEmitter:class{event=()=>disposable;dispose(){}},
    commands:{registerCommand:()=>disposable},window:{showTextDocument:()=>assert.fail('definition lookup must not open an editor')},
    languages:{createDiagnosticCollection:()=>({set(){},delete(){},dispose(){}}),registerCompletionItemProvider:()=>disposable,
      registerDefinitionProvider:(value,handler)=>{selector=value;provider=handler;return disposable;}},
    workspace:{textDocuments:[],onDidOpenTextDocument:()=>disposable,onDidChangeTextDocument:()=>disposable,onDidCloseTextDocument:()=>disposable,
      registerFileSystemProvider:(scheme,filesystem)=>{filesystems.set(scheme,filesystem);return disposable;}}};
  const editorState={workspaces:new Map([['projects.demo',state]]),documentPath:(_key,_state,doc)=>doc.uri.fsPath?.startsWith(root+'/')?doc.uri.fsPath.slice(root.length+1):''};
  const api={editorState,sourceTree:{status:async()=>({checkoutPath:root})},run:async(key,action,input)=>{calls.push({key,action,input});return {indexGeneration:'g1',hits:[
    {sourceType:'procedure',alias:'demo.pkg',funId:'save',path:'datasources/DS/procedures/demo/save.gss'},
    {sourceType:'procedure',alias:'other',funId:'save',path:'datasources/DS/procedures/other/save.gss'},
    {sourceType:'page',sourceId:'PG-COMP',path:'systems/S/pages/comp.gss'},
  ],nextOffset:null};}};
  const getWorkspaces=async()=>[workspace,...legacyWorkspaces];
  const context={subscriptions};
  const nav=createApiNavigation({vscode,context,api,getWorkspaces,legacyDefinitions,getTool,bridge:{}});
  const doc=(text,term,uri=vscode.Uri.file(root+'/caller.gss'))=>({
    uri,getText:()=>text,offsetAt:()=>text.indexOf(term)+1,positionAt:offset=>({offset}),
  });
  return {calls,nav,doc,api,provider,selector,vscode,context,getWorkspaces,getTool,filesystems};
}
test('API procedure definitions use exact alias and function within the current project',async()=>{
  const f=fixture(),source='$vs.proc.invoke("demo.pkg", "save", $args)';
  const links=await f.provider.provideDefinition(f.doc(source,'save'),{});
  assert.deepEqual(links.map(x=>x.targetUri.fsPath),['/checkout/demo/datasources/DS/procedures/demo/save.gss']);
  const range=links[0].originSelectionRange;
  assert.equal(source.slice(range.start.offset,range.end.offset),'save');
  assert.equal(f.calls[0].key,'projects.demo');
  assert.equal(f.calls[0].input.query,'demo.pkg save');
  f.nav.dispose();
});
test('API service component definitions verify the exact PAGE ID',async()=>{
  const f=fixture(),source='$vs.proc.runServiceComp("PG-COMP", $args)';const locations=await f.nav.definition(f.doc(source,'PG-COMP'),{});
  assert.deepEqual(locations.map(x=>x.targetUri.fsPath),['/checkout/demo/systems/S/pages/comp.gss']);f.nav.dispose();
});

test('definition navigation opens an inherited procedure through its editable virtual URI',async()=>{
  const f=fixture(),source='$vs.proc.invoke("demo.pkg", "save", $args)',virtual={scheme:'guthon-api-edit',path:'/save.gss'};let target;
  f.api.sourceUri=async(key,path)=>(target={key,path},virtual);
  const locations=await f.nav.definition(f.doc(source,'save'),{});assert.equal(locations[0].targetUri,virtual);
  assert.deepEqual(target,{key:'projects.demo',path:'datasources/DS/procedures/demo/save.gss'});f.nav.dispose();
});

test('DATABASE and SVN definition links use the source workspace and return openable virtual documents',async t=>{
  const database={workspaceKey:'projects.database',sourceMode:'database',root:'/database/main',
    sourceRoots:[{path:'/database/main/source/workcopy'}],capabilities:{'workcopy.open':true}};
  const svn={workspaceKey:'projects.svn',sourceMode:'svn',checkoutLayout:'manifest-working-copies',
    capabilities:{'svn.browse':true}};
  const databaseRecord={recordId:9,sourceType:'procedure',sourceId:'PROC-DB',funId:'save',
    sourcePath:'system/procedure/demo.pkg/save/source.vm'};
  const svnRecord={sourceType:'procedure',sourceId:'PROC-SVN',funId:'save',workingCopyId:'datasources-D1',
    sourcePath:'datasources/D1/procedures/demo/save.gss'};
  let legacy;
  const f=fixture({legacyWorkspaces:[database,svn],legacyDefinitions:(...args)=>legacy.procedureDefinitionUris(...args)});
  const requests=[];
  legacy=registerLegacyProjects({vscode:f.vscode,context:f.context,sourceTree:f.api.sourceTree,getTool:f.getTool,getWorkspaces:f.getWorkspaces,
    getSelected:async()=>assert.fail('definition must not use the selected project'),
    processClient:{async request(_tool,command,args,key,input){
      requests.push({command,args,key,input});
      if (command==='svn') return {ok:true,content:'return 1;'};
      if (args[0]==='locate') return {ok:true,items:[key===database.workspaceKey ? databaseRecord : svnRecord]};
      return {ok:true,content:'return 2;',editable:true};
    }}});
  t.after(()=>f.context.subscriptions.forEach(subscription=>subscription.dispose()));
  for(const scheme of ['guthon-api-edit','guthon-api-readonly','guthon-svn-edit','guthon-database-edit'])
    assert(f.selector.some(entry=>entry.scheme===scheme && entry.language==='guthon-gss'));
  const dbCaller=f.vscode.Uri.from({scheme:'guthon-database-edit',authority:database.workspaceKey,
    path:'/caller.gss',query:new URLSearchParams({home:'/tmp'}).toString()});
  const svnCaller=legacy.virtualFs.uriFor({workspaceKey:svn.workspaceKey,sourceType:'procedure',sourceId:'caller',funId:'caller'});
  await legacy.virtualFs.readFile(svnCaller);
  requests.length=0;
  const source="#set($proc=$vs.proc.find('demo.pkg'))\n$proc.save($args);";
  const [db]=await f.provider.provideDefinition(f.doc(source,'save',dbCaller),{});
  const [svnLink]=await f.provider.provideDefinition(f.doc(source,'save',svnCaller),{});
  assert.equal(db.targetUri.scheme,'guthon-database-edit');
  assert.equal(db.targetUri.authority,database.workspaceKey);
  assert.equal(String(await f.filesystems.get(db.targetUri.scheme).readFile(db.targetUri)),'return 2;');
  assert.equal(svnLink.targetUri.scheme,'guthon-svn-edit');
  assert.equal(new URLSearchParams(svnLink.targetUri.query).get('workingCopyId'),svnRecord.workingCopyId);
  const direct=f.vscode.Uri.file(database.sourceRoots[0].path+'/caller.vm');
  const [workcopy]=await f.provider.provideDefinition(f.doc(source,'save',direct),{});
  assert.equal(workcopy.targetUri.toString(),db.targetUri.toString());
  assert.deepEqual(requests.filter(call=>call.args[0]==='locate').map(call=>[call.key,call.args]),[
    [database.workspaceKey,['locate','--type','procedure','--alias','demo.pkg','--fun-id','save']],
    [svn.workspaceKey,['locate','--type','procedure','--alias','demo.pkg','--fun-id','save']],
    [database.workspaceKey,['locate','--type','procedure','--alias','demo.pkg','--fun-id','save']],
  ]);
  assert.equal(requests.find(call=>call.args[0]==='edit-read').input.recordId,databaseRecord.recordId);
  assert.equal(f.calls.length,0);
});

test('definition lookup respects readonly URI identity and leaves an unrelated file unlinked',async()=>{
  const f=fixture(),source='$vs.proc.invoke("demo.pkg", "save", $args)';
  const uri=f.vscode.Uri.from({scheme:'guthon-api-readonly',authority:'workspace',query:'workspaceKey=projects.demo'});
  const [link]=await f.provider.provideDefinition(f.doc(source,'save',uri),{});
  assert.equal(link.targetUri.scheme,'file');
  const other=f.vscode.Uri.file('/checkout/demo-other/caller.gss');
  assert.equal(await f.provider.provideDefinition(f.doc(source,'save',other),{}),undefined);
  assert.equal(f.calls.length,1);
  f.nav.dispose();
});

const assert=require('node:assert/strict');
const test=require('node:test');
const path=require('node:path');
const {SvnVirtualFileSystem}=require('../src/svn/virtual-fs');
const {SvnCatalogTreeProvider}=require('../src/svn/catalog-tree');
const {createDatabaseSourceTree}=require('../src/database-source-tree');
const {DatabaseSourceEditor}=require('../src/database-source-editor');
const {registerLegacyProjects}=require('../src/legacy-project');
const {ViewTree}=require('../src/view-tree');
const {createApiNavigation}=require('../src/api/navigation');
const {quickPickFixture,waitFor}=require('./quick-pick-fixture');

const disposable={dispose(){}};
const vscode={
  EventEmitter:class { event=()=>disposable; fire(){} dispose(){} },
  Uri:{from:fields=>({...fields,toString(){return JSON.stringify(fields);}})},
  TreeItem:class { constructor(label,collapsibleState){Object.assign(this,{label,collapsibleState});} },
  TreeItemCollapsibleState:{Collapsed:1,None:0},
  ThemeIcon:class { constructor(id,color){Object.assign(this,{id,color});} },
  ThemeColor:class { constructor(id){this.id=id;} },
  workspace:{textDocuments:[]},window:{},
};

test('SVN expands product code for an opaque workspace key without rewriting the project marker',async()=>{
  const calls=[],marker='@inherit();',body='return 1;';
  const fs=new SvnVirtualFileSystem({vscode,backend:{
    read:async()=>({editable:true,sourceNamespace:'svn:scope',sourceHash:'project',sourcePath:'run.gss',content:marker}),
    pageQuery:async(key,name,input)=>{
      calls.push([key,name,input]);
      return {project:{sourceHash:'project'},product:{sourceHash:'parent'},inheritanceStatus:'ACTIVE',complete:true,
        projectOriginal:{content:marker},productOriginal:{content:body},effective:{content:body},
        segments:[{layer:'project',sourceEnd:0},{layer:'product',start:0,end:body.length},
          {layer:'project',sourceStart:marker.length}]};
    },
  }});
  const uri=fs.uriFor({workspaceKey:'ws_opaque',sourceType:'procedure',sourceId:'PROC',funId:'run',workingCopyId:'root'});
  const result=await fs._load(uri);
  assert.equal(calls[0][0],'ws_opaque');
  assert.equal(calls[0][2].indexedSourceHash,'project');
  assert.equal(result.value.content,body);
  assert.equal(result.inheritance.marker,marker);
  fs.dispose();
});

test('SVN bill types expand directly into named datasource groups with naturally sorted code labels',async()=>{
  const objects=[
    {sourceType:'public',sourceName:'bill-types.json',sourceId:'root:bill-types',sourcePath:'public/bill-types.json',referenceCategory:'bill-type'},
    {sourceType:'procedure',sourceId:'P',treeScopeId:'D1',treePath:['国际贸易','package'],sourcePath:'datasources/D1/procedures/package/save.gss'},
  ];
  const provider=new SvnCatalogTreeProvider({vscode,listSvnWorkspaces:async()=>[{workspaceKey:'ws',displayName:'test'}],
    backend:{catalog:async()=>({objects}),fragments:async()=>({fragments:[
      {label:'后项',code:'B10',jsonPointer:'/comps/0',dataSourceId:'D1',scriptType:'json'},
      {label:'前项',code:'B2',jsonPointer:'/comps/1',dataSourceId:'D1',scriptType:'json'},
    ]})}});
  const [workspace]=await provider.getChildren();
  const category=(await provider.getChildren(workspace)).find(item=>item.category==='bill-type');
  const [group]=await provider.getChildren(category);
  assert.equal(group.label,'贸易系统');
  assert.equal(provider.getTreeItem(group).guthonCode,'D1');
  assert.deepEqual(group.children.map(item=>item.label),['前项','后项']);
  assert.equal(provider.getTreeItem(group.children[0]).guthonCode,'B2');
  assert.equal(group.children[0].command.arguments[0].sourcePath,'public/bill-types.json');
  provider.dispose();
});

test('legacy trees use the current project datasource ID and place unmapped subsystems last',async()=>{
  const navigationGroups={dataSourceIdsBySystem:{'sys-z':'0001','sys-a':'0007'}};
  const objects=['sys-a','sys-custom','sys-z'].map((id,index)=>({
    sourceType:'page',sourceId:`PAGE-${index}`,treeScopeId:id,treePath:[id],sourcePath:`systems/${id}/pages/x.json`,
  }));
  const provider=new SvnCatalogTreeProvider({vscode,listSvnWorkspaces:async()=>[{workspaceKey:'ws',displayName:'test'}],
    backend:{catalog:async()=>({objects,navigationGroups})}});
  const [svn]=await provider.getChildren();
  const [pages]=await provider.getChildren(svn);
  assert.deepEqual((await provider.getChildren(pages)).map(node=>node.code),['sys-z','sys-a','sys-custom']);
  provider.dispose();

  const db={workspaceKey:'ws-db',index:{ready:true}};
  const dbTree=createDatabaseSourceTree({vscode,getTool:()=>({toolHome:'/test'}),run:async(_ws,_command,args)=>
    args[0]==='local-changes' ? {items:[]} : args.length===1 ? {categories:['procedure'],exportIndexReady:true,navigationGroups} : {items:['0007','0001','0002'].map(id=>({
      sourceType:'procedure',sourceId:`FUNC-${id}`,scopeCode:id,groups:[id],sourcePath:`${id}/source.vm`,
    }))}});
  const [procedures]=await dbTree.children(db);
  assert.deepEqual((await dbTree.children(db,procedures)).map(node=>node.code),['0001','0002','0007']);
});

test('DATABASE tree and search open pages and fragments in the corresponding Nexus editor',async t=>{
  const workspace={workspaceKey:'ws-db',sourceMode:'database',root:'/fixture/project',
    workcopyDir:'/fixture/project/source/workcopy',index:{ready:true},capabilities:{'workcopy.open':true}};
  const records=['PG-Service','PG-Form'].map((sourceId,index)=>({
    sourceId,sourceType:'page',sourcePath:`page/${sourceId}/raw.json`,recordId:index+1,
  }));
  const buttons='/views/rows/0/component/buttons';
  const fragments=[
    {pointer:buttons+'/0/serviceEvents/afterSaveScript',content:'#set($enabled = true)\n#return($enabled)',language:'guthon-gss',extension:'.gss',line:2},
    {pointer:buttons+'/0/pageEvents/clickScript',content:'const enabled = true;\nreturn enabled;',language:'javascript',extension:'.js',line:2},
    {pointer:'/views/rows/0/component/sql',content:'SELECT\n  1 AS enabled',language:'sql',extension:'.sql',line:2},
    {pointer:buttons,content:'[{"name":"enabled"}]',language:'json',extension:'.json'},
  ];
  const subscriptions=[],requests=[],opened=[],documents=[],selections=[];
  let databaseFs,picker;
  const host={...vscode,Uri:{...vscode.Uri,file:fsPath=>({fsPath})},ViewColumn:{Active:1},
    Range:class {constructor(start){this.start=start;}},
    workspace:{textDocuments:documents,onDidChangeTextDocument:()=>disposable,
      registerFileSystemProvider(scheme,provider){
        if (scheme==='guthon-database-edit') databaseFs=provider;
        return disposable;
      },
      async openTextDocument(uri){
        const text=String(await databaseFs.readFile(uri));
        const doc={uri,lineCount:text.split('\n').length,text};
        documents.push(doc);
        return doc;
      }},
    window:{createQuickPick:()=>picker.picker,showErrorMessage:assert.fail,
      async showTextDocument(doc,options){opened.push(doc);selections.push(options.selection?.start);},
      createWebviewPanel(viewType){
        const panel={viewType,reveal(){},onDidDispose(){},dispose(){},webview:{
          onDidReceiveMessage(){},postMessage:async()=>true,asWebviewUri:uri=>uri.fsPath,
        }};
        opened.push(panel);
        return panel;
      }}};
  const legacy=registerLegacyProjects({
    vscode:host,context:{subscriptions,extensionPath:'/fixture/extension',workspaceState:{get(){}}},
    getTool:()=>({toolHome:'/fixture'}),getSelected:async()=>workspace,getWorkspaces:async()=>[workspace],
    sourceTree:{refresh(){}},processClient:{async request(_tool,command,args,key,input){
      assert.equal(command,'legacy-source');
      assert.equal(key,workspace.workspaceKey);
      const ok={ok:true};
      if (args[0]==='local-changes') return {...ok,items:[]};
      if (args[0]==='catalog') return args.length===1
        ? {...ok,categories:['page'],exportIndexReady:true} : {...ok,items:records};
      if (args[0]==='search') return {...ok,items:args[1]==='--keyword=PG-Service' ? [records[0]]
        : fragments.map(({pointer,line})=>({...records[1],pointer,line,excerpt:'enabled'}))};
      requests.push({action:args[0],input});
      if (input.resolveDefaultFragment) return {...ok,defaultFragment:input.sourceId==='PG-Service'
        ? {pointer:'/compScript',language:'guthon-gss'} : null};
      if (input.pointer==='/compScript') return {...ok,content:'#return(true)',editable:true,language:'guthon-gss'};
      const fragment=fragments.find(({pointer})=>pointer===input.pointer);
      if (fragment) return {...ok,content:fragment.content,language:fragment.language,editable:true};
      assert.equal(input.sourceId,'PG-Form');
      assert.equal(input.design,true);
      const snapshot={...ok,sourcePath:input.sourcePath,sourceHash:'form'};
      if (args[0]==='edit-comparison') return {...snapshot,available:false};
      return {...snapshot,editable:true,sourceText:JSON.stringify({pageId:input.sourceId}),
        model:{pageId:input.sourceId,collections:[],nodes:[]}};
    }},
  });
  t.after(()=>subscriptions.forEach(subscription=>subscription.dispose()));
  const [pages]=await legacy.children(workspace);
  const [form,service]=await legacy.children(workspace,pages);
  await legacy.openLocal(legacy.treeItem(service).command.arguments[0]);
  assert.equal(opened.length,1);
  assert.match(opened[0].uri.path,/\.gss$/);
  assert.equal(opened[0].text,'#return(true)');
  assert.deepEqual(requests.map(({input})=>input.pointer || input.resolveDefaultFragment),[true,'/compScript']);

  await legacy.openLocal(legacy.treeItem(form).command.arguments[0]);
  assert.equal(opened.length,2);
  assert.equal(opened[1].viewType,'guthon.pageEditor');
  assert.match(opened[1].title,/PG-Form.*本地页面/);

  async function chooseSearchResult(keyword,index,description) {
    picker=quickPickFixture();
    const pending=legacy.action(workspace,'search');
    picker.input(keyword);
    await waitFor(()=>!picker.picker.busy && picker.picker.items.length>index);
    assert.equal(picker.picker.items[index].description,description);
    picker.accept(index);
    return pending;
  }
  await chooseSearchResult('PG-Service',0,records[0].sourcePath);
  assert.equal(opened.at(-1).uri.toString(),opened[0].uri.toString());
  const firstScriptRequest=requests.length;
  for (const [index,fragment] of fragments.entries()) {
    await chooseSearchResult('enabled',index,fragment.pointer);
    const {uri,text}=opened.at(-1);
    assert.equal(uri.scheme,'guthon-database-edit');
    assert.equal(path.extname(uri.path),fragment.extension);
    assert.equal(text,fragment.content);
    assert.equal(selections.at(-1),fragment.line===2 ? 1 : undefined);
  }
  assert.deepEqual(requests.slice(firstScriptRequest).map(({action,input})=>[action,input.pointer]),
    fragments.map(({pointer})=>['edit-read',pointer]));
});

test('project source refresh rereads DATABASE Workcopy changes without watcher events',async t=>{
  const workspace={workspaceKey:'ws-db',sourceMode:'database',index:{ready:true}};
  const record={sourceType:'page',sourceId:'PG-A',sourcePath:'group/page/PG-A/raw.json',groups:['group']};
  const context={subscriptions:[],workspaceState:{get(){}}};
  const commands=new Map();
  const host={...vscode,commands:{registerCommand:(id,handler)=>(commands.set(id,handler),disposable)},
    window:{registerWebviewViewProvider:()=>disposable,showErrorMessage:assert.fail},
    workspace:{...vscode.workspace,onDidOpenTextDocument:()=>disposable,onDidChangeTextDocument:()=>disposable,
      onDidCloseTextDocument:()=>disposable},
    languages:{createDiagnosticCollection:()=>disposable,registerCompletionItemProvider:()=>disposable}};
  let changed=false,conflict=false,rows,render;
  const sourceTree={refresh(){render=view.render();},updateScm(){assert.fail('DATABASE used API status');}};
  const getSelected=async()=>workspace,getTool=()=>({toolHome:'/fixture'});
  const legacy=registerLegacyProjects({vscode:host,context,getTool,getSelected,sourceTree,
    processClient:{async request(_tool,command,args,key){
      assert.equal(command,'legacy-source');
      assert.equal(key,workspace.workspaceKey);
      if(args[0]==='local-changes')return {ok:true,items:changed?[{...record,needsMerge:conflict}]:[]};
      if(args[0]==='fragments')return {ok:true,fragments:[{label:'修改',pointer:'/a'},{label:'原文',pointer:'/b'}],modifiedPointers:changed?['/a']:[]};
      assert.equal(args[0],'catalog');
      return args.length===1?{ok:true,categories:['page'],exportIndexReady:true}
        :{ok:true,items:[record,{...record,sourceId:'PG-B',pageType:'0',sourcePath:'group/page/PG-B/raw.json'}]};
    }}});
  createApiNavigation({vscode:host,context,api:{sourceTree},selectWorkspace:getSelected,getTool,legacyAction:legacy.action});
  const refresh=commands.get('gushenCompletion.refreshAllApiSources');
  const [category]=await legacy.children(workspace);
  const [group]=await legacy.children(workspace,category);
  const [page]=await legacy.children(workspace,group);
  const [,fragment]=await legacy.children(workspace,page);
  const view=new ViewTree({vscode:host,
    id:'gushenCompletion.sourceView',title:'项目源码',extensionPath:path.resolve(__dirname,'..'),provider:{
      getChildren:item=>legacy.children(workspace,item),getTreeItem:legacy.treeItem,getParent:item=>item.parent,
    }});
  t.after(()=>[view,...context.subscriptions].forEach(subscription=>subscription.dispose()));
  view.resolveWebviewView({show(){},onDidDispose(){},webview:{onDidReceiveMessage:()=>disposable,
    postMessage:async message=>{rows=message.rows;}}});
  await view.receive({type:'ready'});
  await view.reveal(fragment);
  assert.ok(rows.every(row=>!row.description));
  assert.equal(rows.find(row=>row.label==='PG-A')?.icon,'layout');
  assert.equal(rows.find(row=>row.label==='PG-B')?.icon,'symbol-event');
  changed=true;
  await refresh();
  await render;
  assert.deepEqual(rows.filter(row=>row.description==='M · 本地修改').map(row=>row.label),['页面','group','PG-A','修改']);
  assert.deepEqual(rows.filter(row=>row.color==='gitDecoration.modifiedResourceForeground').map(row=>row.label),['页面','group','PG-A','修改']);
  for(const name of ['查看原始 JSON','PG-B','原文'])assert.equal(rows.find(row=>row.label===name)?.description,'');
  conflict=true;
  await refresh();
  await render;
  assert.deepEqual(rows.filter(row=>row.color==='gitDecoration.conflictingResourceForeground').map(row=>row.label),['页面','group','PG-A']);
  assert.equal(rows.find(row=>row.label==='PG-A')?.description,'C · 本地和谷神均有改动');
  changed=false;
  await refresh();
  await render;
  assert.ok(rows.every(row=>!row.description && row.color!=='gitDecoration.modifiedResourceForeground'));
  assert.ok(rows.some(row=>row.label==='修改'));
});

test('SVN source refresh reads local status and projects its decoration into the source Webview rows',async t=>{
  const workspace={workspaceKey:'ws-svn',sourceMode:'svn',checkoutLayout:'manifest-working-copies',
    scopeManifestReady:true,workingCopies:[{id:'root'}],capabilities:{'svn.browse':true,'svn.status':true}};
  const sourcePath='systems/S1/pages/page.json';
  const context={subscriptions:[],workspaceState:{get(){}}};
  let changes=[];
  const host={...vscode,window:{showErrorMessage:assert.fail},
    FileDecoration:class {constructor(badge,tooltip,color){Object.assign(this,{badge,tooltip,color});}},
    scm:{createSourceControl:()=>({inputBox:{},createResourceGroup:()=>({dispose(){}}),dispose(){}})}};
  const legacy=registerLegacyProjects({vscode:host,context,getTool:()=>({toolHome:'/fixture'}),
    getSelected:async()=>workspace,sourceTree:{refresh(){}},
    processClient:{async request(_tool,command,args,key){
      assert.equal(command,'svn');
      assert.equal(key,workspace.workspaceKey);
      if(args[0]==='catalog')return {ok:true,objects:[
        {sourceType:'page',sourceId:'PG-A',sourcePath,treeScopeId:'S1',treePath:['S1']},
      ]};
      assert.deepEqual(args,['scm-status']);
      return {ok:true,changes,workingCopies:workspace.workingCopies};
    }}});
  t.after(()=>context.subscriptions.forEach(subscription=>subscription.dispose()));
  const [clean]=await legacy.children(workspace);
  assert.equal(legacy.treeItem(clean).description,'1');
  changes=[{path:sourcePath,state:'EXTERNAL_MODIFIED'}];
  await legacy.action(workspace,'refresh-source-view');
  const [modified]=await legacy.children(workspace);
  const node=legacy.treeItem(modified);
  assert.equal(node.description,'M · SVN 本地修改 · 1');
  assert.equal(node.iconPath.color.id,'gitDecoration.modifiedResourceForeground');
});

test('DATABASE virtual text editor highlights saved changes and preserves unsaved input on refresh',async t=>{
  const contents='first\nchanged\nlast', ranges=new Map();
  let content=contents,lineChanges=[{kind:'replace',start:1,end:2},{kind:'delete',start:3,end:3}];
  let document;
  const editor={get document(){return document;},setDecorations(style,value){ranges.set(style.borderColor.id,value);}};
  const host={...vscode,Range:class {constructor(start,_a,end){Object.assign(this,{start,end});}},
    FileChangeType:{Changed:1},workspace:{textDocuments:[],async openTextDocument(uri){
      document={uri,lineCount:3,getText:()=>contents,isDirty:false};this.textDocuments=[document];return document;
    }},window:{visibleTextEditors:[editor],createTextEditorDecorationType:style=>({...style,dispose(){}}),
      async showTextDocument(){return editor;}}};
  let reads=0;
  const provider=new DatabaseSourceEditor({vscode:host,getTool:()=>({toolHome:'/fixture'}),
    request:async()=>{reads++;return {content,lineChanges,editable:true,language:'guthon-gss'};},onSave(){}});
  t.after(()=>provider.dispose());
  const identity={workspaceKey:'ws',sourcePath:'group/source.vm',sourceType:'procedure'};
  const [opened,linked]=await Promise.all([provider.open(identity),provider.uriFor(identity)]);
  assert.equal(opened,linked);
  assert.equal(reads,1);
  assert.deepEqual(ranges.get('editorGutter.modifiedBackground').map(({start,end})=>[start,end]),[[1,1]]);
  assert.deepEqual(ranges.get('editorGutter.deletedBackground').map(({start,end})=>[start,end]),[[2,2]]);
  document.isDirty=true;
  content='external';lineChanges=[];
  await provider.refresh('ws',new Set([identity.sourcePath]),assert.fail);
  assert.equal(String(await provider.readFile(document.uri)),contents);
  document.isDirty=false;
  await provider.refresh('ws',new Set([identity.sourcePath]),assert.fail);
  assert.equal(String(await provider.readFile(document.uri)),content);
  assert.deepEqual(ranges.get('editorGutter.modifiedBackground'),[]);
});

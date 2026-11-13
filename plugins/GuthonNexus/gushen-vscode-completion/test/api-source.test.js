const test=require('node:test');
const assert=require('node:assert/strict');
const {ApiSourceUI,identity,sourceSyncLines}=require('../src/api/source-ui');
const {designerHtml,openDesigner}=require('../src/api/designer');
function fixture() {
  const calls=[],warnings=[],events={},changes=[];
  const document={uri:{scheme:'file',fsPath:'/checkout/page.gss',toString:()=>'/checkout/page.gss'},isDirty:false,version:1,getText:()=>'{"pageId":"PG-1"}',positionAt:x=>x,save:async()=>true};
  const vscode={Uri:{file:p=>({scheme:'file',fsPath:p,toString:()=>p}),from:x=>x},ViewColumn:{Active:1},
    Range:class {constructor(a,b){this.start=a;this.end=b;}},WorkspaceEdit:class {replace(...args){this.args=args;}},
    workspace:{textDocuments:[document],openTextDocument:async()=>document,onDidChangeTextDocument:f=>(events.changed=f,{dispose(){}}),applyEdit:async edit=>{changes.push(edit);document.version++;return true;}},
    window:{showTextDocument:async()=>{},showWarningMessage:async(...a)=>(warnings.push(a),'上传'),showInformationMessage:async()=>{},showErrorMessage:async x=>warnings.push(x),
      createWebviewPanel:()=>({webview:{html:'',postMessage:async()=>{},onDidReceiveMessage:f=>(events.message=f,{dispose(){}})},onDidDispose(){}})},
  };
  let sourceContent='{"pageId":"PG-1"}', sourceHash='hash';
  const run=async(key,action,input)=>{calls.push({key,action,input});if(action==='status')return {checkoutPath:'/checkout',files:[{path:'page.gss',state:'MODIFIED'}]};if(action==='read') return {path:input.path,content:sourceContent,sourceHash,metadata:{sourceType:'page',pageId:'PG-1'},readonly:false};if(action==='designer-context')return {rootUrl:'https://example.invalid/project',accessToken:'secret',user:{id:'u'}};if(action==='upload')return {ok:true,complete:true,stage:'REMOTE_READBACK_VERIFIED',results:[{path:'page.gss',stage:'REMOTE_READBACK_VERIFIED'}]};if(action==='write'){sourceContent=input.content;sourceHash=require('node:crypto').createHash('sha256').update(sourceContent).digest('hex');return {sourceHash};}throw Error(action)};
  const ui=new ApiSourceUI({vscode,run});return {ui,vscode,run,calls,document,events,changes,warnings};
}
test('SCM upload binds paths and hashes, and blocks dirty documents',async()=>{
  const f=fixture();f.document.isDirty=true;
  await assert.rejects(f.ui.upload('projects.a'),/未保存/);assert.equal(f.calls.some(x=>x.action==='upload'),false);
  f.document.isDirty=false;await f.ui.upload('projects.a');
  assert.deepEqual(f.calls.find(x=>x.action==='upload').input,{paths:['page.gss'],confirm:true,expectedHashes:{'page.gss':'hash'}});
});
test('source catalog builds tree for the selected API workspace',async()=>{
  const f=fixture();f.ui.run=async()=>({objects:[{path:'systems/1/a.gss',label:'页面',readonly:false},{path:'systems/1/b.gss',readonly:true}]});
  f.ui.syncWorkspaces([{workspaceKey:'projects.a',sourceMode:'api'},{workspaceKey:'projects.b',sourceMode:'database'}]);
  const root=await f.ui.getChildren();assert.equal(root.length,1);
  const systems=await f.ui.getChildren(root[0]);assert.equal(systems[0].label,'systems');
  assert.equal(systems[0].children[0].children[0].label,'b.gss');
  assert.throws(()=>identity({resourceUri:{scheme:'file'}}),/请选择/);
});
test('catalog shows system, datasource and nested menu names with exact page identities',async()=>{
  const f=fixture();f.vscode.TreeItem=class{constructor(label,state){this.label=label;this.collapsibleState=state;}};f.vscode.TreeItemCollapsibleState={Collapsed:1,None:0};
  const objects=[{path:'systems/S1/pages/SUB/P1/page.xml',sourceType:'page',name:'页面甲'},
    {path:'systems/S1/pages/SUB/P2/page.xml',sourceType:'page',name:'页面乙'},
    {path:'datasources/D1/procedures/fee/f.gss',sourceType:'procedure',name:'datasources/D1/procedures/fee/f.gss'}];
  const project={systems:[{systemId:'S1',systemName:'风险管理'}],dataSources:[{dataSourceId:'D1',dataSourceName:'公共数据'}],menuTree:[{systemId:'S1',menus:[
    {id:'folder',name:'交易管理',isDir:1,childs:[{id:'m1',name:'同名菜单',isDir:0,pages:[{pageId:'P1',pageSubId:'SUB'}]},{id:'m2',name:'同名菜单',isDir:0,pages:[{pageId:'P2',pageSubId:'SUB'}]}]}]}]};
  f.ui.run=async(_key,action)=>{assert.equal(action,'catalog');return {objects,project};};f.ui.syncWorkspaces(['projects.a']);
  const root=(await f.ui.getChildren())[0],nodes=await f.ui.getChildren(root),systems=nodes.find(x=>x.label==='系统'),data=nodes.find(x=>x.label==='数据源');
  const system=systems.children[0];assert.equal(system.label,'风险管理');assert.equal(f.ui.getTreeItem(system).description,'S1');
  const menus=system.children[0].children[0].children;assert.equal(menus.length,2);assert.deepEqual(menus.map(x=>x.label),['同名菜单','同名菜单']);
  assert.deepEqual(menus.map(x=>x.children[0].object.path).sort(),objects.slice(0,2).map(x=>x.path).sort());
  assert.equal(data.children[0].label,'公共数据');assert.equal(data.children[0].children[0].children[0].children[0].label,'f.gss');
  for(const item of [root,systems,system,...menus,...menus.map(x=>x.children[0])]) assert.doesNotThrow(()=>f.ui.getTreeItem(item));
  assert.equal(f.ui.getTreeItem(menus[0].children[0]).command.command,'gushenCompletion.openApiPageEditor');
});
test('opening a registered checkout uses exact backend read without rescanning all status',async()=>{
  const f=fixture(),calls=[];f.ui.syncWorkspaces([{workspaceKey:'projects.a',checkoutPath:'/checkout',sourceMode:'api'}]);
  f.ui.run=async(key,action,input)=>{calls.push({key,action,input});assert.equal(action,'read');return {path:input.path,metadata:{sourceType:'procedure'},readonly:false,content:'procedure()'};};
  await f.ui.open('projects.a','procedures/demo.gss');assert.deepEqual(calls,[{key:'projects.a',action:'read',input:{path:'procedures/demo.gss'}}]);
});
test('workspace status caches its authoritative checkout for later source opens',async()=>{
  const f=fixture(),calls=[];f.ui.run=async(_key,action,input)=>{calls.push(action);return action==='status'?{checkoutPath:'/checkout'}:{path:input.path,metadata:{sourceType:'procedure'},readonly:false,content:'body'};};
  await f.ui.status('projects.a');await f.ui.open('projects.a','demo.gss');assert.deepEqual(calls,['status','read']);
});
test('readonly preview keeps case-sensitive workspace identity after URI normalization',async()=>{
  const f=fixture(),shown=[];f.ui.syncWorkspaces([{workspaceKey:'products.MixedCase',checkoutPath:'/checkout'}]);
  f.vscode.Uri.from=o=>({...o,authority:o.authority.toLowerCase(),toString(){return JSON.stringify(this);}});
  f.vscode.workspace.openTextDocument=async uri=>({uri});f.vscode.window.showTextDocument=async doc=>shown.push(doc.uri);
  f.ui.run=async()=>({metadata:{sourceType:'procedure'},readonly:true,content:'read-only source'});
  await f.ui.open('products.MixedCase','readonly.gss');const uri=shown[0];assert.equal(new URLSearchParams(uri.query).get('workspaceKey'),'products.MixedCase');
  assert.equal(f.ui.provideTextDocumentContent({...uri,authority:uri.authority.toLowerCase()}),'read-only source');
});
test('explicit original source does not bypass inherited or identity-conflict read-only state',async()=>{
  const f=fixture(),shown=[];f.ui.syncWorkspaces([{workspaceKey:'projects.a',checkoutPath:'/checkout'}]);
  f.vscode.Uri.from=o=>({...o,toString(){return JSON.stringify(o);}});f.vscode.workspace.openTextDocument=async uri=>({uri});f.vscode.window.showTextDocument=async doc=>shown.push(doc.uri);
  for(const source of [
    {readonly:true,metadata:{sourceType:'procedure-inherit'},content:'parent'},
    {readonly:true,storeReadonly:false,projectionReadonly:true,contentState:'IDENTITY_MISMATCH',metadata:{sourceType:'page'},content:'conflicting page'},
    {readonly:true,storeReadonly:true,projectionReadonly:true,contentState:'METADATA_ONLY',metadata:{sourceType:'page'},content:'readonly page'}
  ]) {
    f.ui.run=async()=>source;await f.ui.open('projects.a','source.xml',false,{raw:true});
    assert.equal(shown.at(-1).scheme,'guthon-api-readonly');assert.equal(f.ui.provideTextDocumentContent(shown.at(-1)),source.content);
  }
});
test('menu fetch augments an already displayed catalog and reports failed requests',async()=>{
  const f=fixture();let resolveMenu;f.vscode.EventEmitter=class{constructor(){this.event=()=>{};}fire(){}dispose(){}};
  f.ui.run=async(_key,action)=>action==='catalog'?{objects:[{path:'systems/S/pages/X/P/p.xml',sourceType:'page'}],project:{systems:[{systemId:'S',systemName:'系统甲'}]}}:new Promise(resolve=>{resolveMenu=resolve;});
  f.ui.syncWorkspaces(['projects.a']);const root=(await f.ui.getChildren())[0];await f.ui.getChildren(root);
  resolveMenu({menu:[{systemId:'S',menus:[{id:'m',name:'菜单甲',isDir:0,pages:[{pageId:'P',pageSubId:'X'}]}]}]});await new Promise(resolve=>setImmediate(resolve));
  const tree=await f.ui.getChildren(root);assert.equal(tree[0].children[0].children[0].children[0].label,'菜单甲');
});
test('designer rejects modified buffers and foreign target; save is local only',async()=>{
  const f=fixture();await openDesigner({vscode:f.vscode,run:f.run,ui:f.ui,key:'projects.a',sourcePath:'page.gss',editorState:{assertNoConflictingDrafts(){},assertNoDirtyDocumentsExcept(){},setDraft:async()=>{},flush:async()=> 'editor-token'}});
  await f.events.message({type:'save',path:'other.gss',version:1,text:JSON.stringify({fileName:'page.gss',xml:'{"pageId":"PG-1","name":"new"}'})});
  assert.equal(f.changes.length,0);
  f.document.isDirty=true;
  await f.events.message({type:'save',path:'page.gss',version:1,text:JSON.stringify({fileName:'page.gss',xml:'{"pageId":"PG-1","name":"new"}'})});
  assert.equal(f.changes.length,0);
  f.document.isDirty=false;
  await f.events.message({type:'save',path:'page.gss',version:1,text:JSON.stringify({fileName:'page.gss',xml:'{"pageId":"PG-1","name":"new"}'})});
  assert.equal(f.changes.length,0);assert.equal(f.calls.find(x=>x.action==='write').input.editorToken,'editor-token');assert.equal(f.calls.some(x=>x.action==='upload'),false);
});
test('designer iframe only accepts its configured origin and escapes auth data',()=>{
  const html=designerHtml('https://example.invalid/project',{accessToken:'</script><script>bad</script>',user:{}});
  assert.match(html,/event\.source===frame\.contentWindow && event\.origin===origin/);
  assert.match(html,/\\u003c\/script>/);assert.doesNotMatch(html,/<\/script><script>bad/);
  assert.throws(()=>designerHtml('javascript:alert(1)',{}),/地址/);
});
test('source tree context action retains workspace and exact path',()=>{
  assert.deepEqual(identity({key:'projects.a',object:{path:'systems/a/page.gss'}}),{key:'projects.a',path:'systems/a/page.gss'});
});
test('catalog tree loads every page and rejects a changing index generation',async()=>{
  const f=fixture(),offsets=[];
  f.ui.run=async(_key,_action,input)=>{offsets.push(input.offset);return {indexGeneration:'gen',objects:[{path:`systems/${input.offset}.gss`}],nextOffset:input.offset<200 ? input.offset+100 : null};};
  f.ui.syncWorkspaces([{workspaceKey:'projects.a',sourceMode:'api'}]);const root=(await f.ui.getChildren())[0];
  assert.equal((await f.ui.getChildren(root))[0].children.length,3);assert.deepEqual(offsets,[0,100,200]);
  f.ui.refresh();f.ui.run=async(_key,_action,input)=>({indexGeneration:String(input.offset),objects:[],nextOffset:input.offset===0?100:null});
  await assert.rejects(f.ui.getChildren((await f.ui.getChildren())[0]),/索引已变化/);
});
test('catalog displays the rebuild action when index scope is stale',async()=>{
  const f=fixture();f.ui.syncWorkspaces(['projects.a']);
  f.ui.run=async()=>{throw Object.assign(new Error('索引范围已过期'),{code:'API_INDEX_SCOPE_STALE'});};
  const root=(await f.ui.getChildren())[0],items=await f.ui.getChildren(root);
  assert.equal(items[0].label,'索引范围已过期');assert.equal(items[0].command,'gushenCompletion.reindexCalls');
});

test('reopened source tree shows persisted diagnostics without rebuilding the index',async()=>{
  const f=fixture(),calls=[],reports=[];
  f.ui.run=async(_key,action)=>{calls.push(action);assert.equal(action,'catalog');return {indexGeneration:'g',partialSourceCount:2,objects:[
    {path:'systems/A/incomplete.xml',diagnostic:'API_PAGE_FORMAT_INVALID'},
    {path:'datasources/DS/views/V.xml',diagnostic:'API_VIEW_FORMAT_UNSUPPORTED'}]};};
  f.vscode.workspace.openTextDocument=async data=>{reports.push(data.content);return data;};
  f.ui.syncWorkspaces(['projects.a']);
  const items=await f.ui.getChildren((await f.ui.getChildren())[0]);
  const warning=items.find(item=>item.kind==='message');
  assert.equal(warning.command,'gushenCompletion.showApiIndexDiagnostics');
  await f.ui.showIndexDiagnostics('projects.a');
  assert.match(reports[0],/API_PAGE_FORMAT_INVALID/);assert.match(reports[0],/API_VIEW_FORMAT_UNSUPPORTED/);
  assert.deepEqual(calls,['catalog']);
});
test('partial upload reports unknown and unattempted files without claiming success',async()=>{
  const f=fixture(),reports=[];f.vscode.workspace.openTextDocument=async data=>(reports.push(data.content),data);
  f.ui.run=async(_key,action,input)=>{
    if(action==='status')return {checkoutPath:'/checkout',files:[]};
    if(action==='read')return {path:input.path,sourceHash:'hash',readonly:false};
    if(action==='upload')return {operationId:'op',stage:'PARTIAL',complete:false,results:[{path:'a',stage:'UNKNOWN',message:'未确认'}]};throw Error(action);};
  await f.ui.upload('projects.a',['a','b']);assert.match(reports[0],/UNKNOWN/);assert.match(reports[0],/未执行/);assert.match(reports[0],/完成：否/);
});
test('upload reports platform normalization only for confirmed readback',async()=>{
  const f=fixture(),reports=[];f.vscode.workspace.openTextDocument=async data=>(reports.push(data.content),data);
  f.ui.run=async(_key,action,input)=>{
    if(action==='status')return {checkoutPath:'/checkout',files:[]};
    if(action==='read')return {path:input.path,sourceHash:'hash',readonly:false};
    if(action==='upload')return {stage:'PARTIAL',complete:false,results:[{path:'a',stage:'REMOTE_READBACK_VERIFIED',sourceNormalized:true},{path:'b',stage:'UNKNOWN',sourceNormalized:true}]};throw Error(action);};
  await f.ui.upload('projects.a',['a','b']);assert.match(reports[0],/"a"：REMOTE_READBACK_VERIFIED；平台已格式化或补全源码/);assert.doesNotMatch(reports[0],/"b"：UNKNOWN；平台已格式化/);
});
test('upload recovery selects a receipt and only calls verify-upload',async()=>{
  const f=fixture(),calls=[],reports=[];f.vscode.workspace.openTextDocument=async data=>(reports.push(data.content),data);
  f.vscode.window.showQuickPick=async items=>items[0];f.ui.run=async(_key,action,input)=>{calls.push({action,input});
    if(action==='history')return {operations:[{kind:'upload',operationId:'op',stage:'PARTIAL',paths:['a'],results:[{stage:'UNKNOWN'}]}]};
    if(action==='verify-upload')return {operationId:'op',stage:'PARTIAL',complete:false,mutationRetried:false,results:[{stage:'UNKNOWN'}]};
    if(action==='status')return {checkoutPath:'/checkout',files:[]};throw Error(action);};
  await f.ui.verifyUpload('projects.a');assert.deepEqual(calls.find(x=>x.action==='verify-upload').input,{operationId:'op'});
  assert.equal(calls.some(x=>x.action==='upload'),false);assert.match(reports[0],/重放上传：否/);
});
test('conflict resolution reviews local and remote, confirms and binds current hash',async()=>{
  const f=fixture(),calls=[];f.vscode.workspace.openTextDocument=async data=>({uri:data});f.vscode.commands={executeCommand:async()=>{}};
  f.vscode.window.showQuickPick=async items=>items[0];f.vscode.window.showWarningMessage=async()=> '确认解决';
  f.ui.run=async(_key,action,input)=>{calls.push({action,input});if(action==='status')return {checkoutPath:'/checkout',files:[]};
    if(action==='conflict')return {path:'a',local:'local',remote:'remote',sourceHash:'lh',remoteHash:'rh'};
    if(action==='read')return {sourceHash:'lh',readonly:false};
    if(action==='resolve-conflict')return {sourceHash:'lh',operationId:'op'};throw Error(action);};
  await f.ui.resolveConflict('projects.a','a');assert.deepEqual(calls.find(x=>x.action==='resolve-conflict').input,{path:'a',choice:'local',expectedHash:'lh'});
  assert.equal(calls.some(x=>x.action==='upload'),false);
});
test('database structure sync requires explicit confirmation and reports verification boundary',async()=>{
  const f=fixture(),calls=[],reports=[];f.vscode.workspace.openTextDocument=async data=>(reports.push(data.content),data);
  f.vscode.window.showWarningMessage=async()=> '执行结构同步';
  f.ui.run=async(_key,action,input)=>{calls.push({action,input});if(action==='status')return {checkoutPath:'/checkout',files:[]};
    if(action==='read')return {metadata:{sourceType:'table'}};if(action==='sync-database')return {stage:'PLATFORM_ACKNOWLEDGED',databaseVerification:'NOT_PERFORMED'};throw Error(action);};
  await f.ui.syncDatabase('projects.a','a');assert.deepEqual(calls.find(x=>x.action==='sync-database').input,{path:'a',confirm:true});assert.match(reports[0],/NOT_PERFORMED/);
});
test('PAGE JSON tree opens the page manager and script PAGE opens its original file',()=>{
  const f=fixture();f.vscode.TreeItem=class{constructor(label,state){this.label=label;this.collapsibleState=state;}};f.vscode.TreeItemCollapsibleState={Collapsed:1,None:0};
  const page=f.ui.getTreeItem({key:'projects.a',label:'页面',object:{path:'page.json',sourceType:'page',sourceFormat:'json'}});
  const script=f.ui.getTreeItem({key:'projects.a',label:'组件',object:{path:'component.gss',sourceType:'page',sourceFormat:'script'}});
  assert.equal(page.command.command,'gushenCompletion.openApiPageEditor');assert.equal(script.command.command,'gushenCompletion.openApiSource');
});
test('metadata-only and mismatched PAGE tree entries open raw source instead of empty structure',async()=>{
  const f=fixture();f.vscode.TreeItem=class{constructor(label,state){this.label=label;this.collapsibleState=state;}};f.vscode.TreeItemCollapsibleState={Collapsed:1,None:0};
  for(const sourceFormat of ['native-page-minimal','unsupported']) {
    const item={key:'projects.a',label:'页面',object:{path:'page.xml',sourceType:'page',sourceFormat,readonly:true}};
    const tree=f.ui.getTreeItem(item);assert.equal(tree.collapsibleState,0);assert.equal(tree.command.command,'gushenCompletion.openApiSource');assert.deepEqual(await f.ui.getChildren(item),[]);
  }
});
test('native XML designer validates backend identity then writes and reads back exact XML bytes',async()=>{
  const f=fixture(),calls=[],messages=[];let raw='<page id="PG-1"><rows/></page>';
  const doc={uri:{scheme:'file',fsPath:'/checkout/page.xml',toString:()=>'/checkout/page.xml'},version:1,isDirty:false,getText:()=>raw};
  f.vscode.workspace.openTextDocument=async()=>doc;f.vscode.workspace.textDocuments=[doc];
  f.vscode.window.showErrorMessage=async message=>messages.push(message);f.vscode.window.showWarningMessage=async()=>{};
  const hash=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');
  const originalHash=hash(raw),run=async(_key,action,input)=>{calls.push({action,input});
    if(action==='read')return {path:'page.xml',content:raw,sourceHash:hash(raw),metadata:{sourceType:'page',pageId:'PG-1'},readonly:false};
    if(action==='designer-context')return {rootUrl:'https://example.invalid',accessToken:'secret',user:{}};
    if(action==='page')return {valid:true,sourceHash:originalHash,pageId:'PG-1',inheritedUnchanged:true};
    if(action==='write'){assert.equal(input.expectedHash,originalHash);assert.equal(input.editorToken,'token');raw=input.content;return {sourceHash:hash(raw)};}throw Error(action);};
  const editorState={assertNoConflictingDrafts(){},assertNoDirtyDocumentsExcept(){},setDraft:async()=>{},flush:async()=> 'token'};
  await openDesigner({vscode:f.vscode,run,ui:{status:async()=>({checkoutPath:'/checkout'}),updateScm:async()=>{}},key:'projects.a',sourcePath:'page.xml',editorState});
  const text='<page id="PG-1"><rows><row/></rows></page>';
  await f.events.message({type:'save',path:'page.xml',version:1,text:JSON.stringify({fileName:'page.xml',xml:text})});
  assert.equal(raw,text);assert.deepEqual(calls.map(x=>x.action),['read','designer-context','page','read','write','read']);assert.deepEqual(messages,[]);
});
test('native XML designer refuses a backend identity or inherited-content mismatch',async()=>{
  const f=fixture(),calls=[];const raw='<page id="PG-1"/>';const doc={uri:{scheme:'file',fsPath:'/checkout/page.xml',toString:()=>'/checkout/page.xml'},version:1,isDirty:false,getText:()=>raw};
  f.vscode.workspace.openTextDocument=async()=>doc;f.vscode.workspace.textDocuments=[doc];f.vscode.window.showErrorMessage=async message=>f.warnings.push(message);
  const run=async(_key,action,input)=>{calls.push(action);if(action==='read')return {content:raw,sourceHash:'hash',metadata:{sourceType:'page',pageId:'PG-1'}};
    if(action==='designer-context')return {rootUrl:'https://example.invalid',accessToken:'secret',user:{}};
    if(action==='page')return {valid:true,sourceHash:'hash',pageId:'PG-1',inheritedUnchanged:false};throw Error(action);};
  await openDesigner({vscode:f.vscode,run,ui:{status:async()=>({checkoutPath:'/checkout'})},key:'projects.a',sourcePath:'page.xml',editorState:{assertNoConflictingDrafts(){},assertNoDirtyDocumentsExcept(){},setDraft:async()=>{},flush:async()=> 'token'}});
  await f.events.message({type:'save',path:'page.xml',version:1,text:JSON.stringify({fileName:'page.xml',xml:'<page id="PG-1"><changed/></page>'})});
  assert.equal(calls.includes('write'),false);assert.match(f.warnings.at(-1),/未确认/);
});

test('pull report distinguishes successful downloads from incomplete indexes and lists diagnostics',()=>{
  const lines=sourceSyncLines('projects.a',{complete:false,downloadComplete:true,updated:['a'],preserved:[],conflicts:[],index:{complete:false,diagnosticCount:273,diagnostics:[{path:'a.xml',code:'PARSE',message:'无法解析'}],truncated:true}}).join('\n');
  assert.match(lines,/总体结果：未完成/);assert.match(lines,/文件拉取与合并：完成/);assert.match(lines,/索引结果：未完成/);
  assert.match(lines,/索引诊断数量：273/);assert.match(lines,/a\.xml/);assert.match(lines,/诊断列表已截断/);
});
test('source view retains last partial-index diagnostic count after refresh',async()=>{
  const f=fixture();f.ui.run=async()=>({objects:[{path:'a.gss'}],indexGeneration:'g',partialSourceCount:2});
  f.ui.syncWorkspaces(['projects.a']);f.ui.setIndexResult('projects.a',{complete:false,diagnosticCount:273,diagnostics:[]});
  const root=(await f.ui.getChildren())[0],items=await f.ui.getChildren(root),warning=items.find(x=>x.kind==='message');
  assert.match(warning.label,/273/);assert.equal(warning.command,'gushenCompletion.showApiIndexDiagnostics');
  f.ui.setIndexResult('projects.a',{complete:true,diagnosticCount:0});assert.equal(f.ui.indexDiagnostics.has('projects.a'),false);
});
test('local change bundle import previews and confirms the same plan without uploading',async()=>{
  const f=fixture(),calls=[],reports=[];f.vscode.workspace.openTextDocument=async data=>(reports.push(data.content),data);
  f.vscode.window.showOpenDialog=async()=>[{fsPath:'/tmp/change.json'}];f.vscode.window.showWarningMessage=async()=> '确认导入';
  f.ui.run=async(_key,action,input)=>{calls.push({action,input});if(action==='status')return {checkoutPath:'/checkout',files:[]};
    if(action==='import-changes')return input.apply?{stage:'LOCAL_WRITE_VERIFIED',operationId:'op',applied:[{path:'a'}]}:{complete:true,planHash:'plan',changes:[{path:'a'}],conflicts:[]};throw Error(action);};
  await f.ui.importChanges('projects.a');assert.deepEqual(calls.filter(x=>x.action==='import-changes').map(x=>x.input),[{input:'/tmp/change.json'},{input:'/tmp/change.json',apply:true,planHash:'plan'}]);
  assert.equal(calls.some(x=>x.action==='upload'),false);assert.match(reports.at(-1),/未上传/);
});
test('conflicted change bundle is displayed but never applied',async()=>{
  const f=fixture(),calls=[];f.vscode.workspace.openTextDocument=async data=>data;f.vscode.window.showOpenDialog=async()=>[{fsPath:'/tmp/change.json'}];
  f.ui.run=async(_key,action,input)=>{calls.push({action,input});if(action==='status')return {checkoutPath:'/checkout',files:[]};return {complete:false,conflicts:[{path:'a'}]};};
  await f.ui.importChanges('projects.a');assert.equal(calls.filter(x=>x.action==='import-changes').length,1);
});
test('bulk revert binds every path to its observed hash and reports partial failure',async()=>{
  const f=fixture(),calls=[],reports=[];f.vscode.workspace.openTextDocument=async data=>(reports.push(data.content),data);
  f.vscode.window.showWarningMessage=async()=> '还原';f.ui.run=async(_key,action,input)=>{calls.push({action,input});
    if(action==='status')return {checkoutPath:'/checkout',files:[]};if(action==='read')return {sourceHash:`hash-${input.path}`,readonly:false};
    if(action==='revert'){if(input.path==='b')throw Error('未知');return {operationId:'op'};}throw Error(action);};
  await assert.rejects(f.ui.revert('projects.a',['a','b','c']),/未知/);
  assert.deepEqual(calls.filter(x=>x.action==='revert').map(x=>x.input),[{path:'a',expectedHash:'hash-a'},{path:'b',expectedHash:'hash-b'}]);
  assert.match(reports[0],/未确认或失败/);assert.match(reports[0],/未执行/);
});

test('readonly conflict offers only restoration of the remote original',async()=>{
  const f=fixture(),calls=[];let choices;f.vscode.workspace.openTextDocument=async data=>({uri:data});f.vscode.commands={executeCommand:async()=>{}};
  f.vscode.window.showQuickPick=async items=>(choices=items,items[0]);f.vscode.window.showWarningMessage=async()=> '确认解决';
  f.ui.run=async(_key,action,input)=>{calls.push({action,input});if(action==='status')return {checkoutPath:'/checkout',files:[]};
    if(action==='conflict')return {path:'parent',local:'changed',remote:'original',sourceHash:'lh',remoteHash:'rh'};
    if(action==='read')return {sourceHash:'lh',readonly:true};if(action==='resolve-conflict')return {sourceHash:'rh',operationId:'op'};throw Error(action);};
  await f.ui.resolveConflict('projects.a','parent');assert.deepEqual(choices.map(x=>x.choice),['remote']);
  assert.deepEqual(calls.find(x=>x.action==='resolve-conflict').input,{path:'parent',choice:'remote',expectedHash:'lh'});
  assert.equal(calls.some(x=>x.action==='upload'),false);
});
test('acknowledged but unread uploads appear in both history and verification without replay',async()=>{
  const f=fixture(),calls=[],choices=[];f.vscode.workspace.openTextDocument=async data=>data;
  f.vscode.window.showInformationMessage=async()=> '选择核对';f.vscode.window.showQuickPick=async items=>(choices.push(items.map(x=>x.operation.operationId)),items[0]);
  const operations=[{kind:'upload',operationId:'row-ack',stage:'PARTIAL',results:[{stage:'REMOTE_ACKNOWLEDGED'}]},
    {kind:'upload',operationId:'top-ack',stage:'REMOTE_ACKNOWLEDGED',results:[]},
    {kind:'upload',operationId:'done',stage:'REMOTE_READBACK_VERIFIED',results:[]}];
  f.ui.run=async(_key,action,input)=>{calls.push({action,input});if(action==='history')return {operations};
    if(action==='verify-upload')return {operationId:input.operationId,stage:'REMOTE_READBACK_VERIFIED',complete:true,mutationRetried:false,results:[]};
    if(action==='status')return {checkoutPath:'/checkout',files:[]};throw Error(action);};
  await f.ui.history('projects.a');await f.ui.verifyUpload('projects.a');
  assert.deepEqual(choices,[['row-ack','top-ack'],['row-ack','top-ack']]);
  assert.equal(calls.filter(x=>x.action==='verify-upload').length,2);assert.equal(calls.some(x=>x.action==='upload'),false);
});
test('project inherited procedures open the inline editor while original preview stays physical',async()=>{
  const f=fixture(),opened=[],physical=[];f.ui.onOpenVirtual=async identity=>(opened.push(identity),identity);
  f.ui.run=async(_key,action,input)=>action==='status'?{checkoutPath:'/checkout',files:[]}:{path:input.path,readonly:false,content:'before();\ninherit();\nafter();',metadata:{sourceType:'procedure'}};
  f.vscode.workspace.openTextDocument=async uri=>(physical.push(uri),uri);
  await f.ui.open('projects.a','datasources/DS/procedures/pkg/save.gss');
  assert.equal(opened[0].sourceType,'procedure');assert.equal(opened[0].sourcePath,'datasources/DS/procedures/pkg/save.gss');
  await f.ui.open('projects.a','datasources/DS/procedures/pkg/save.gss',true,{raw:true});
  assert.equal(physical[0].fsPath,'/checkout/datasources/DS/procedures/pkg/save.gss');
});
test('PAGE source tree expands into exact script and fields JSON fragments',async()=>{
  const f=fixture(),calls=[];f.vscode.TreeItem=class{constructor(label,state){this.label=label;this.collapsibleState=state;}};f.vscode.TreeItemCollapsibleState={Collapsed:1,None:0};
  f.ui.run=async(_key,action,input)=>{calls.push({action,input});if(action==='catalog')return {objects:[{path:'page.xml',sourceType:'page',sourceFormat:'native-xml'}]};
    if(action==='page')return {sourcePath:'page.xml',sourceId:'PG-A',model:{nodes:[{pointer:'/events/onOpenScript',label:'打开',type:'SCRIPT'}],collections:[{pointer:'/views/0/fields',label:'表单',kind:'FIELDS'}]}};throw Error(action);};
  f.ui.syncWorkspaces(['projects.a']);const root=(await f.ui.getChildren())[0],page=(await f.ui.getChildren(root))[0];
  assert.equal(f.ui.getTreeItem(page).collapsibleState,1);const [one,two]=await Promise.all([f.ui.getChildren(page),f.ui.getChildren(page)]);
  assert.equal(one,two);assert.equal(calls.filter(x=>x.action==='page').length,1);
  assert.deepEqual(one.map(x=>[x.target.jsonPointer,x.target.fragmentType]),[['/events/onOpenScript','js'],['/views/0/fields','fields']]);
  assert.equal(f.ui.getTreeItem(one[1]).command.command,'gushenCompletion.openApiFragment');assert.equal(f.ui.getParent(one[1]),page);
});

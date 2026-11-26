const test=require('node:test');
const assert=require('node:assert/strict');
const {ApiSourceUI,buildCatalogTree,identity,sourceSyncLines}=require('../src/api/source-ui');
const {designerHtml,openDesigner}=require('../src/api/designer');
function fixture() {
  const calls=[],warnings=[],events={},changes=[];
  const document={uri:{scheme:'file',fsPath:'/checkout/page.gss',toString:()=>'/checkout/page.gss'},isDirty:false,version:1,getText:()=>'{"pageId":"PG-1"}',positionAt:x=>x,save:async()=>true};
  const vscode={Uri:{file:p=>({scheme:'file',fsPath:p,toString:()=>p}),from:x=>x},ViewColumn:{Active:1},
    Range:class {constructor(a,b){this.start=a;this.end=b;}},WorkspaceEdit:class {replace(...args){this.args=args;}},
    workspace:{textDocuments:[document],openTextDocument:async()=>document,registerTextDocumentContentProvider:()=>({dispose(){}}),onDidChangeTextDocument:f=>(events.changed=f,{dispose(){}}),applyEdit:async edit=>{changes.push(edit);document.version++;return true;}},
    window:{showTextDocument:async()=>{},showWarningMessage:async(...a)=>(warnings.push(a),'上传'),showInformationMessage:async()=>{},showErrorMessage:async x=>warnings.push(x),
      createWebviewPanel:()=>({webview:{html:'',postMessage:async()=>{},onDidReceiveMessage:f=>(events.message=f,{dispose(){}})},onDidDispose(){}})},
  };
  let sourceContent='{"pageId":"PG-1"}', sourceHash='hash';
  const run=async(key,action,input)=>{calls.push({key,action,input});if(action==='status')return {checkoutPath:'/checkout',files:[{path:'page.gss',state:'MODIFIED'}]};if(action==='read') return {path:input.path,content:sourceContent,sourceHash,metadata:{sourceType:'page',pageId:'PG-1'},readonly:false};if(action==='designer-context')return {rootUrl:'https://example.invalid/project',accessToken:'secret',user:{id:'u'}};if(action==='upload')return {ok:true,complete:true,stage:'REMOTE_READBACK_VERIFIED',results:[{path:'page.gss',stage:'REMOTE_READBACK_VERIFIED'}]};if(action==='write'){sourceContent=input.content;sourceHash=require('node:crypto').createHash('sha256').update(sourceContent).digest('hex');return {sourceHash};}throw Error(action)};
  const ui=new ApiSourceUI({vscode,run,reviewUpload:async(_v,entries)=>entries.map(x=>x.path)});
  ui.diffProvider.run=(...args)=>ui.run(...args);
  return {ui,vscode,run,calls,document,events,changes,warnings};
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
  const root=await f.ui.getChildren();assert.deepEqual(root.slice(0,5).map(x=>x.label),['页面','过程函数','表','视图','系统脚本']);
  // 默认按平台顺序：没有平台 ID 的源码回落到文件名顺序（a.gss 在 b.gss 之前）。
  assert.deepEqual(root.find(x=>x.label==='其他源码').children[0].children[0].children.map(x=>x.label),['页面','b.gss']);
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
  const nodes=await f.ui.getChildren(),pages=nodes.find(x=>x.label==='页面'),procedures=nodes.find(x=>x.label==='过程函数');
  const system=pages.children[0];assert.equal(system.label,'风险管理');assert.equal(f.ui.getTreeItem(system).guthonCode,'S1');
  const menus=system.children[0].children;assert.equal(menus.length,2);assert.deepEqual(menus.map(x=>x.label),['同名菜单','同名菜单']);
  assert.deepEqual(menus.map(x=>x.children[0].object.path).sort(),objects.slice(0,2).map(x=>x.path).sort());
  assert.equal(procedures.children[0].label,'公共数据');assert.equal(procedures.children[0].children[0].children[0].label,'f.gss');
  for(const item of [pages,system,...menus,...menus.map(x=>x.children[0])]) assert.doesNotThrow(()=>f.ui.getTreeItem(item));
  assert.equal(f.ui.getParent(pages),undefined);
  assert.equal(f.ui.getTreeItem(menus[0].children[0]).command.command,'gushenCompletion.openApiPageEditor');
});
test('API sorts scope groups by local datasource IDs before catalog position',()=>{
  const ids=['10','2','1'];
  const dataSources=ids.map(dataSourceId=>({dataSourceId,dataSourceName:dataSourceId}));
  const systems=ids.map((dataSourceId,i)=>({systemId:`s${i}`,systemName:`s${i}`,dataSourceId}));
  const objects=[...ids.map(dataSourceId=>({sourceType:'procedure',path:`datasources/${dataSourceId}/procedures/pkg/save.gss`})),
    ...systems.map(({systemId})=>({sourceType:'page',path:`systems/${systemId}/pages/a/p/page.xml`}))];
  const categories=buildCatalogTree('a',{},objects,{dataSources,systems});
  assert.deepEqual(categories.find(x=>x.category==='procedures').children.map(x=>x.dataSourceId),['1','2','10']);
  assert.deepEqual(categories.find(x=>x.category==='pages').children.map(x=>x.systemId),['s2','s1','s0']);
});
test('PAGE rows distinguish page and service component icons even when modified',()=>{
  const f=fixture(),key='projects.a';
  f.vscode.TreeItem=class {constructor(label,state){this.label=label;this.collapsibleState=state;}};
  f.vscode.TreeItemCollapsibleState={Collapsed:1,None:0};
  f.vscode.ThemeIcon=class {constructor(id,color){this.id=id;this.color=color;}};
  f.vscode.ThemeColor=class {constructor(id){this.id=id;}};
  const page={sourceType:'page',sourceId:'PG-1',path:'systems/A/pages/S/PG-1/page.xml',sourceFormat:'native-xml'};
  const service={sourceType:'page',sourceId:'PG-2',path:'systems/A/pages/S/PG-2/query.GSS'};
  const indexedService={sourceType:'page',sourceId:'PG-3',path:'systems/A/pages/S/PG-3/query.vm',sourceFormat:'script'};
  const tree=object=>f.ui.getTreeItem({key,object});
  assert.equal(tree(page).iconPath.id,'layout');
  assert.equal(tree(service).iconPath.id,'symbol-event');
  assert.equal(tree(indexedService).iconPath.id,'symbol-event');
  assert.match(tree(service).tooltip,/服务组件/);
  f.ui.sourceChanges.set(key,new Map([[page.path,'MODIFIED'],[service.path,'CONFLICT']]));
  assert.equal(tree(page).iconPath.id,'layout');
  assert.equal(tree(page).description,'有本地修改');
  assert.equal(tree(service).iconPath.id,'symbol-event');
  assert.equal(tree(service).iconPath.color.id,'editorError.foreground');
  assert.equal(tree(service).description,'冲突');
});
test('opening a registered checkout uses exact backend read without rescanning all status',async()=>{
  const f=fixture(),calls=[];f.ui.syncWorkspaces([{workspaceKey:'projects.a',checkoutPath:'/checkout',sourceMode:'api'}]);
  f.ui.run=async(key,action,input)=>{calls.push({key,action,input});assert.equal(action,'read');return {path:input.path,metadata:{sourceType:'procedure'},readonly:false};};
  await f.ui.open('projects.a','procedures/demo.gss');assert.deepEqual(calls,[{key:'projects.a',action:'read',input:{path:'procedures/demo.gss',omitEditableContent:true}}]);
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
test('menu fetch augments an already displayed catalog',async()=>{
  const f=fixture();let resolveMenu;f.vscode.EventEmitter=class{constructor(){this.event=()=>{};}fire(){}dispose(){}};
  f.ui.run=async(_key,action)=>action==='catalog'?{objects:[{path:'systems/S/pages/X/P/p.xml',sourceType:'page'}],project:{systems:[{systemId:'S',systemName:'系统甲'}]}}:new Promise(resolve=>{resolveMenu=resolve;});
  f.ui.syncWorkspaces(['projects.a']);await f.ui.getChildren();
  resolveMenu({menu:[{systemId:'S',menus:[{id:'m',name:'菜单甲',isDir:0,pages:[{pageId:'P',pageSubId:'X'}]}]}]});await new Promise(resolve=>setImmediate(resolve));
  const tree=await f.ui.getChildren();assert.equal(tree[0].children[0].children[0].label,'菜单甲');
});
test('local source remains available before login and reports actual menu failures',async()=>{
  const f=fixture();
  const project={systems:[{systemId:'S',systemName:'系统甲'}]};
  const objects=[{path:'systems/S/pages/X/P/p.xml',sourceType:'page'}];
  let errorCode='API_LOGIN_REQUIRED';
  f.ui.run=async(_key,action)=>{
    if(action==='catalog')return {objects,project};
    throw Object.assign(new Error('菜单请求未完成'),{code:errorCode});
  };
  f.ui.syncWorkspaces(['projects.a']);
  await f.ui.getChildren();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.ui.getChildren())[0].label,'页面');
  assert(!(await f.ui.getChildren()).some(item=>item.kind==='message'));
  errorCode='API_HTTP_ERROR';
  f.ui.menuAttempts.delete('projects.a');
  f.ui.invalidate('projects.a');
  await f.ui.getChildren();
  await new Promise(resolve=>setImmediate(resolve));
  assert((await f.ui.getChildren()).some(item=>item.label.includes('菜单请求未完成')));
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
  f.ui.syncWorkspaces([{workspaceKey:'projects.a',sourceMode:'api'}]);await f.ui.getChildren();assert.deepEqual(offsets,[0,100,200]);
  f.ui.invalidate('projects.a');f.ui.run=async(_key,_action,input)=>({indexGeneration:String(input.offset),objects:[],nextOffset:input.offset===0?100:null});
  await assert.rejects(f.ui.getChildren(),/索引已变化/);
});
test('catalog requests are shared, status redraws reuse them, and a new index generation invalidates them',async()=>{
  const f=fixture(),calls=[];let release,version='g1';const gate=new Promise(resolve=>{release=resolve;});
  f.ui.run=async(_key,action,input)=>{assert.equal(action,'catalog');calls.push([version,input.offset]);if(calls.length===1)await gate;
    return {indexGeneration:version,objects:[{path:`datasources/D/procedures/${input.offset}.gss`,sourceType:'procedure'}],nextOffset:input.offset===0?100:null};};
  f.ui.syncWorkspaces([{workspaceKey:'projects.a',checkoutPath:'/checkout',displayName:'项目甲'}]);
  const first=f.ui.getChildren(),second=f.ui.getChildren();release();const [a,b]=await Promise.all([first,second]);
  assert.equal(a,b);assert.equal(calls.length,2);f.ui.refresh();f.ui.syncWorkspaces([{workspaceKey:'projects.a',checkoutPath:'/checkout',displayName:'项目甲'}]);
  assert.equal(await f.ui.getChildren(),a);assert.equal(calls.length,2);
  f.ui.setIndexResult('projects.a',{indexGeneration:'g1',complete:true});assert.equal(await f.ui.getChildren(),a);assert.equal(calls.length,2);
  version='g2';f.ui.setIndexResult('projects.a',{indexGeneration:'g2',complete:true});const newer=await f.ui.getChildren();assert.notEqual(newer,a);assert.equal(calls.length,4);
});
test('status detects an index generation changed by another process',async()=>{
  const f=fixture();let generation='g1',catalogCalls=0;
  f.ui.run=async(_key,action)=>action==='catalog'?(catalogCalls++,{indexGeneration:generation,objects:[{path:'datasources/D/views/V.xml',sourceType:'view'}]}):{checkoutPath:'/checkout',files:[],index:{indexGeneration:generation}};
  f.ui.syncWorkspaces([{workspaceKey:'projects.a',checkoutPath:'/checkout'}]);const first=await f.ui.getChildren();
  await f.ui.status('projects.a');assert.equal(await f.ui.getChildren(),first);assert.equal(catalogCalls,1);
  generation='g2';await f.ui.status('projects.a');assert.notEqual(await f.ui.getChildren(),first);assert.equal(catalogCalls,2);
});
test('a stale in-flight catalog cannot overwrite a newer index generation',async()=>{
  const f=fixture();let release,calls=0;const gate=new Promise(resolve=>{release=resolve;});
  f.ui.run=async()=>{const current=++calls;if(current===1)await gate;return {indexGeneration:current===1?'old':'new',objects:[{path:`datasources/D/views/${current}.xml`,sourceType:'view'}]};};
  f.ui.syncWorkspaces(['projects.a']);const old=f.ui.getChildren();await new Promise(resolve=>setImmediate(resolve));
  f.ui.invalidate('projects.a');const fresh=await f.ui.getChildren();release();assert.equal(await old,fresh);assert.equal(calls,2);
  assert.equal(fresh.find(x=>x.label==='视图').children[0].children[0].object.path,'datasources/D/views/2.xml');
});
test('a late stale-scope error waits for and returns the current catalog',async()=>{
  const f=fixture();let rejectOld,resolveNew,calls=0;
  f.ui.run=async()=>{calls++;return new Promise((resolve,reject)=>{if(calls===1)rejectOld=reject;else resolveNew=resolve;});};
  f.ui.syncWorkspaces(['projects.a']);const old=f.ui.getChildren();await new Promise(resolve=>setImmediate(resolve));
  f.ui.invalidate('projects.a');const current=f.ui.getChildren();await new Promise(resolve=>setImmediate(resolve));
  rejectOld(Object.assign(new Error('旧范围索引过期'),{code:'API_INDEX_SCOPE_STALE'}));
  resolveNew({indexGeneration:'new',objects:[{path:'datasources/D/views/current.xml',sourceType:'view'}]});
  const [oldResult,newResult]=await Promise.all([old,current]);assert.equal(oldResult,newResult);assert.equal(calls,2);
  assert.equal(newResult.some(item=>item.kind==='message'),false);assert.equal(f.ui.indexGenerations.get('projects.a'),'new');
});
test('a late old diagnostic cannot contaminate the current scope',async()=>{
  const f=fixture();let resolveOld,calls=0;
  f.ui.run=async()=>{calls++;if(calls===1)return new Promise(resolve=>{resolveOld=resolve;});return {indexGeneration:'new',partialSourceCount:0,objects:[]};};
  f.ui.syncWorkspaces(['projects.a']);const old=f.ui.getChildren();await new Promise(resolve=>setImmediate(resolve));
  f.ui.setIndexResult('projects.a',{indexGeneration:'new',complete:true});const current=await f.ui.getChildren();
  resolveOld({indexGeneration:'old',partialSourceCount:1,objects:[{path:'old.xml',status:'PARTIAL',diagnostic:'OLD_ERROR'}]});
  assert.equal(await old,current);assert.equal(f.ui.indexDiagnostics.has('projects.a'),false);assert.equal(current.some(item=>item.kind==='message'),false);assert.equal(calls,2);
});
test('a later stale catalog page stops the old pagination before using its diagnostics',async()=>{
  const f=fixture();let releasePage,calls=0;
  f.ui.run=async(_key,_action,input)=>{calls++;if(calls===1)return {indexGeneration:'old',objects:[],nextOffset:100};
    if(calls===2)return new Promise(resolve=>{releasePage=resolve;});assert.equal(input.offset,0);return {indexGeneration:'new',objects:[],partialSourceCount:0};};
  f.ui.syncWorkspaces(['projects.a']);const old=f.ui.getChildren();while(!releasePage)await new Promise(resolve=>setImmediate(resolve));
  f.ui.invalidate('projects.a');const current=await f.ui.getChildren();releasePage({indexGeneration:'old',objects:[],partialSourceCount:2,nextOffset:200});
  assert.equal(await old,current);assert.equal(calls,3);assert.equal(f.ui.indexDiagnostics.has('projects.a'),false);
});
test('a late catalog after disposal or workspace removal cannot publish diagnostics',async()=>{
  for(const remove of ['dispose','workspace']) {
    const f=fixture();let release;f.ui.run=async()=>new Promise(resolve=>{release=resolve;});
    f.ui.syncWorkspaces(['projects.a']);const pending=f.ui.getChildren();await new Promise(resolve=>setImmediate(resolve));
    if(remove==='dispose')f.ui.dispose();else f.ui.syncWorkspaces([]);
    release({indexGeneration:'old',partialSourceCount:1,objects:[{path:'old.xml',status:'PARTIAL',diagnostic:'OLD_ERROR'}]});
    assert.deepEqual(await pending,[]);assert.equal(f.ui.indexDiagnostics.has('projects.a'),false);assert.equal(f.ui.treeCache.has('projects.a'),false);
  }
});
test('multiple workspaces retain distinct roots and parent chains while one workspace has direct categories',async()=>{
  const f=fixture();f.ui.run=async(key)=>({indexGeneration:key,objects:[{path:'datasources/D/views/V.xml',sourceType:'view',name:key}]});
  f.ui.syncWorkspaces([{workspaceKey:'projects.A',displayName:'甲'},{workspaceKey:'projects.B',displayName:'乙'}]);
  const roots=await f.ui.getChildren();assert.deepEqual(roots.map(x=>x.label),['甲','乙']);
  const category=(await f.ui.getChildren(roots[0])).find(x=>x.label==='视图');assert.equal(category.key,'projects.A');assert.equal(f.ui.getParent(category),roots[0]);
  f.ui.syncWorkspaces([{workspaceKey:'projects.A',displayName:'甲'}]);const single=(await f.ui.getChildren()).find(x=>x.label==='视图');assert.equal(single.key,'projects.A');assert.equal(f.ui.getParent(single),undefined);
});
test('catalog displays the rebuild action when index scope is stale',async()=>{
  const f=fixture();f.ui.syncWorkspaces(['projects.a']);
  f.ui.run=async()=>{throw Object.assign(new Error('索引范围已过期'),{code:'API_INDEX_SCOPE_STALE'});};
  const items=await f.ui.getChildren();
  assert.equal(items[0].label,'索引范围已过期');assert.equal(items[0].command,'gushenCompletion.reindexCalls');
});

test('reopened source tree shows persisted diagnostics without rebuilding the index',async()=>{
  const f=fixture(),calls=[],reports=[];
  f.ui.run=async(_key,action)=>{calls.push(action);assert.equal(action,'catalog');return {indexGeneration:'g',partialSourceCount:2,objects:[
    {path:'systems/A/incomplete.xml',diagnostic:'API_PAGE_FORMAT_INVALID'},
    {path:'datasources/DS/views/V.xml',diagnostic:'API_VIEW_FORMAT_UNSUPPORTED'}]};};
  f.vscode.workspace.openTextDocument=async data=>{reports.push(data.content);return data;};
  f.ui.syncWorkspaces(['projects.a']);
  const items=await f.ui.getChildren();
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
function conflictResponse(input,local,remote,{remoteHash='rh',pageSource,readable}={}) {
  const revision={path:input.path,sourceHash:'lh',remoteHash,metadata:{pageSource}};
  if(!input.view) return revision;
  const projected=readable && input.view!=='raw';
  const [before,after]=projected?readable:[local,remote];
  return {...revision,view:projected?'readable':'raw',language:projected?'markdown':'xml',
    offset:input.offset,before,after,totalBeforeChars:[...before].length,totalAfterChars:[...after].length,
    readonly:true,truncated:false,nextOffset:null};
}
test('PAGE conflict reviews readable and raw snapshots from the same local and platform versions',async()=>{
  const f=fixture(),calls=[],diffs=[];f.vscode.commands={executeCommand:async(...args)=>diffs.push(args)};
  const sourcePath='systems/S/pages/PG/PG.xml';
  f.vscode.window.showQuickPick=async items=>items.find(item=>item.choice==='raw-diff') || items[0];
  f.vscode.window.showWarningMessage=async()=> '确认解决';
  f.ui.run=async(_key,action,input)=>{calls.push({action,input});if(action==='status')return {checkoutPath:'/checkout',files:[]};
    if(action==='conflict')return conflictResponse(input,'<page>local</page>','<page>remote</page>',{readable:['local SQL','platform SQL']});
    if(action==='read')return {sourceHash:'lh',readonly:false};
    if(action==='resolve-conflict')return {sourceHash:'lh',operationId:'op'};throw Error(action);};
  await f.ui.resolveConflict('projects.a',sourcePath);
  const [command,left,right]=diffs[0];
  assert.equal(command,'vscode.diff');
  assert.equal(left.scheme,'guthon-api-review-diff');
  assert.equal(right.scheme,left.scheme);
  assert.match(left.path,/本地\.md$/);
  assert.equal(f.ui.diffProvider.provideTextDocumentContent(left),'local SQL');
  assert.equal(f.ui.diffProvider.provideTextDocumentContent(right),'platform SQL');
  assert.equal(f.ui.diffProvider.provideTextDocumentContent(diffs[1][1]),'<page>local</page>');
  assert.equal(f.ui.diffProvider.provideTextDocumentContent(diffs[1][2]),'<page>remote</page>');
  assert.deepEqual(calls.filter(x=>x.action==='conflict' && x.input.view).map(x=>x.input.view),['auto','raw']);
  assert.deepEqual(calls.find(x=>x.action==='resolve-conflict').input,{path:sourcePath,choice:'local',expectedHash:'lh',expectedRemoteHash:'rh'});
  assert.equal(calls.some(x=>x.action==='upload'),false);
});
test('manual PAGE conflict editing opens the original file and keeps the conflict pending',async t=>{
  const f=fixture(),key='projects.a',sourcePath='systems/S/pages/PG/PG.xml';
  f.vscode.commands={executeCommand:async()=>{}};
  f.vscode.window.showQuickPick=async items=>items.find(item=>item.choice==='edit');
  t.mock.method(f.ui,'openOriginalSources',async(...args)=>assert.deepEqual(args,[key,sourcePath]));
  f.ui.run=async(_key,action,input)=>{
    if(action==='status')return {checkoutPath:'/checkout'};
    if(action==='conflict')return conflictResponse(input,'local','remote');
    if(action==='read')return {sourceHash:'lh',readonly:false,metadata:{sourceType:'page'}};
    assert.fail(action);
  };
  await f.ui.resolveConflict(key,sourcePath);
  assert.equal(f.ui.openOriginalSources.mock.callCount(),1);
});
test('PAGE export conflict refreshes only the selected page and opens the native conflict automatically',async t=>{
  const f=fixture(),key='projects.a',sourcePath='systems/S/pages/PG/PG.xml',diffs=[];
  let refreshed=false;
  f.vscode.commands={executeCommand:async(...args)=>diffs.push(args)};
  const choose=t.mock.fn(async items=>{
    assert.equal(items[0].choice,'local');
    return undefined;
  });
  f.vscode.window.showQuickPick=choose;
  f.vscode.window.showWarningMessage=async()=>assert.fail('native refresh requires no second click');
  f.ui.run=async(workspace,action,input)=>{
    assert.equal(workspace,key);
    if(action==='status')return {checkoutPath:'/checkout',files:[]};
    if(action==='conflict')return conflictResponse(input,'local',refreshed?'native':'export',{
      remoteHash:refreshed?'nh':'eh',pageSource:refreshed?'native-editor':'batch-export'});
    if(action==='refresh') {
      assert.deepEqual(input,{path:sourcePath});
      assert.equal(refreshed,false);
      refreshed=true;
      return {path:sourcePath,downloadComplete:false,updated:[],preserved:[],conflicts:[{path:sourcePath}]};
    }
    if(action==='read')return {sourceHash:'lh',readonly:false,metadata:{sourceType:'page'}};
    assert.fail(action);
  };
  await f.ui.resolveConflict(key,sourcePath);
  assert.equal(choose.mock.callCount(),1);
  const [,,remote]=diffs.find(([command])=>command==='vscode.diff');
  assert.equal(f.ui.diffProvider.provideTextDocumentContent(remote),'native');
});
test('auto refresh reports a resolved PAGE even when a companion still conflicts',async t=>{
  const f=fixture(),sourcePath='systems/S/pages/PG/PG.xml';
  let refreshed=false;
  const notice=t.mock.method(f.vscode.window,'showInformationMessage',async message=>assert.match(message,/无需手工处理冲突/));
  f.ui.run=async(_key,action)=>{
    if(action==='status')return {checkoutPath:'/checkout',files:[]};
    if(action==='conflict') {
      assert.equal(refreshed,false);
      return {path:sourcePath,local:'local',remote:'export',sourceHash:'lh',remoteHash:'rh',metadata:{pageSource:'batch-export'}};
    }
    if(action==='refresh') {
      refreshed=true;
      return {path:sourcePath,downloadComplete:false,updated:[sourcePath],preserved:[],conflicts:[{path:'companion.xml'}]};
    }
    assert.fail(action);
  };
  await f.ui.resolveConflict('projects.a',sourcePath);
  assert.equal(notice.mock.callCount(),1);
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
  await openDesigner({vscode:f.vscode,run,ui:{ensureWorkspace:async()=>({checkoutPath:'/checkout'}),updateScm:async()=>{}},key:'projects.a',sourcePath:'page.xml',editorState});
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
  await openDesigner({vscode:f.vscode,run,ui:{ensureWorkspace:async()=>({checkoutPath:'/checkout'})},key:'projects.a',sourcePath:'page.xml',editorState:{assertNoConflictingDrafts(){},assertNoDirtyDocumentsExcept(){},setDraft:async()=>{},flush:async()=> 'token'}});
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
  const items=await f.ui.getChildren(),warning=items.find(x=>x.kind==='message');
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
    if(action==='conflict')return conflictResponse(input,'changed','original');
    if(action==='read')return {sourceHash:'lh',readonly:true};if(action==='resolve-conflict')return {sourceHash:'rh',operationId:'op'};throw Error(action);};
  await f.ui.resolveConflict('projects.a','parent');assert.deepEqual(choices.map(x=>x.choice),['remote']);
  assert.deepEqual(calls.find(x=>x.action==='resolve-conflict').input,{path:'parent',choice:'remote',expectedHash:'lh',expectedRemoteHash:'rh'});
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
  f.ui.syncWorkspaces(['projects.a']);const root=(await f.ui.getChildren()).find(x=>x.label==='其他源码'),page=(await f.ui.getChildren(root))[0];
  assert.equal(f.ui.getTreeItem(page).collapsibleState,1);const [one,two]=await Promise.all([f.ui.getChildren(page),f.ui.getChildren(page)]);
  assert.equal(one,two);assert.equal(calls.filter(x=>x.action==='page').length,1);
  assert.deepEqual(one.map(x=>[x.target.jsonPointer,x.target.fragmentType]),[['/events/onOpenScript','js'],['/views/0/fields','fields']]);
  assert.equal(f.ui.getTreeItem(one[1]).command.command,'gushenCompletion.openApiFragment');assert.equal(f.ui.getParent(one[1]),page);
});

test('the index diagnostic row opens the report and routes full rebuild and incremental repair separately',async()=>{
  const {createApiNavigation}=require('../src/api/navigation'),{ViewTree}=require('../src/view-tree');
  const f=fixture(),reports=[],menus=[],calls=[],notices=[],commands=new Map(),disposable={dispose(){}};
  const key='products.A';
  f.vscode.TreeItem=class{constructor(label,state){this.label=label;this.collapsibleState=state;}};
  f.vscode.TreeItemCollapsibleState={Collapsed:1,None:0};
  f.vscode.window.registerWebviewViewProvider=()=>disposable;
  f.vscode.window.showErrorMessage=message=>assert.fail(message);
  f.vscode.window.showInformationMessage=message=>notices.push(message);
  f.vscode.workspace.onDidOpenTextDocument=f.vscode.workspace.onDidCloseTextDocument=()=>disposable;
  f.vscode.languages={createDiagnosticCollection:()=>disposable,registerCompletionItemProvider:()=>disposable};
  f.vscode.commands={
    registerCommand:(name,fn)=>(commands.set(name,fn),disposable),
    executeCommand:(name,...args)=>commands.get(name)(...args),
  };
  commands.set('gushenCompletion.showApiIndexDiagnostics',key=>f.ui.showIndexDiagnostics(key));
  f.ui.run=async()=>({indexGeneration:'g',partialSourceCount:1,objects:[
    {path:'systems/S/min.xml',sourceType:'page',status:'OK',diagnostic:'API_PAGE_MINIMAL_SOURCE'},
    {path:'systems/S/conflict.xml',sourceType:'page',status:'PARTIAL',diagnostic:'API_PAGE_IDENTITY_MISMATCH'}]});
  f.vscode.workspace.openTextDocument=async data=>(reports.push(data.content),data);
  f.ui.syncWorkspaces([{workspaceKey:key,checkoutPath:'/checkout'}]);
  const api={sourceTree:f.ui,editorState:{workspaces:new Map()},
    run:async(...args)=>{
      calls.push(args);
      return args[1]==='index-repair'
        ? {complete:false,updatedPaths:['systems/S/conflict.xml'],diagnosticCount:1,indexGeneration:'repaired'}
        : {complete:true,objects:2,indexGeneration:'rebuilt'};
    },
    markIndexed:async(...args)=>calls.push(args)};
  const nav=createApiNavigation({vscode:f.vscode,context:{subscriptions:[]},api,
    selectWorkspace:async requested=>{assert.equal(requested,key);return {workspaceKey:key,sourceMode:'api'};}});
  const tree=new ViewTree({vscode:f.vscode,id:'gushenCompletion.sourceView',provider:f.ui,title:'项目源码',extensionPath:require('node:path').resolve(__dirname,'..')});
  tree.resolveWebviewView({onDidDispose(){},webview:{onDidReceiveMessage:()=>disposable,postMessage:async message=>menus.push(message)}});
  try {
    await tree.receive({type:'ready'});
    const {generation,rows}=menus.at(-1);
    const {id}=rows.find(row=>row.label.startsWith('索引不完整'));
    await tree.receive({type:'open',generation,id});
    assert.match(reports[0],/API_PAGE_IDENTITY_MISMATCH/);
    assert(!reports[0].includes('API_PAGE_MINIMAL_SOURCE'));
    await tree.receive({type:'menu',generation,id});
    const {items}=menus.at(-1);
    assert.deepEqual(items.map(item=>item.label),['重建索引','修复索引']);
    await tree.receive({type:'context',generation,id,command:items[1].command});
    await tree.receive({type:'context',generation,id,command:items[0].command});
    assert.deepEqual(calls,[[key,'index-repair'],[key,'index',{}],[key,'rebuilt']]);
    assert.match(notices[0],/检查 1 个索引项，剩余 1 项诊断/);
  } finally {tree.dispose();nav.dispose();}
});

test('procedure layout retains package identity, signature and physical refresh scope',()=>{
  const {buildCatalogTree}=require('../src/api/source-ui');
  const objects=[{path:'datasources/D/procedures/com/demo/save.gss',sourceType:'procedure',dataSourceId:'D',sourceId:'PKG',funId:'save',name:'保存',procedureSignature:{parameters:['$id'],hasReturn:true,returnExpressions:['$result']}},
    {path:'datasources/D/procedures/com/demo/load.gss',sourceType:'procedure',dataSourceId:'D',sourceId:'PKG',funId:'load',name:'读取',procedureSignature:{parameters:[],hasReturn:false}}];
  const project={dataSources:[{dataSourceId:'D',dataSourceName:'公共数据'},{dataSourceId:'D2',dataSourceName:'其他'}]};
  for(const layout of ['tree','flat']) {
    const root=buildCatalogTree('projects.a',{},objects,project,{procedureLayout:layout});
    const category=root.find(x=>x.category==='procedures'),scope=category.children[0];
    const pkg=layout==='tree'?scope.children[0].children[0]:scope.children[0];
    assert.equal(pkg.label,layout==='tree'?'demo':'com.demo');
    assert.equal(pkg.packageIdentities.size,1);assert.equal(pkg.sourcePrefix,'datasources/D/procedures/com/demo');
    assert.equal(pkg.children.find(x=>x.object.funId==='save').label,'save($id) 保存 [return $result]');
    assert.equal(pkg.children.find(x=>x.object.funId==='load').label,'load() 读取');
    assert.deepEqual([...category.refreshPrefixes].sort(),['datasources/D/procedures','datasources/D2/procedures']);
  }
});
test('unresolved procedure parameters display 无 and layout menus belong only to the top module',()=>{
  const {buildCatalogTree,sourceLabel}=require('../src/api/source-ui'),f=fixture();
  const object={path:'datasources/D/procedures/com/demo/run.gss',sourceType:'procedure',dataSourceId:'D',sourceId:'PKG',funId:'run',name:'执行'};
  assert.equal(sourceLabel(object,{signature:true}),'run(无) 执行');
  assert.equal(sourceLabel({...object,procedureSignature:{parameters:null,hasReturn:null}},{signature:true}),'run(无) 执行');
  f.vscode.TreeItem=class {constructor(label){this.label=label;}};f.vscode.TreeItemCollapsibleState={Collapsed:1,None:0};
  const root=buildCatalogTree('projects.a',{},[object],{dataSources:[{dataSourceId:'D'}]}).find(x=>x.category==='procedures');
  const scope=root.children[0],pkg=scope.children[0].children[0],leaf=pkg.children[0];
  const contexts=[root,scope,pkg,leaf].map(item=>f.ui.getTreeItem(item).contextValue);
  assert.deepEqual(contexts,['guthonApi.category.procedures','guthonApi.procedureScope','guthonApi.procedurePackage','guthonApi.procedure']);
  const menus=require('../package.json').contributes.menus['view/item/context'].filter(item=>/showApiProcedure(?:Flat|Tree)$/.test(item.command));
  for(const menu of menus){assert(menu.when.includes('viewItem == guthonApi.category.procedures'));assert(!/procedurePackage|procedureScope|\|procedure/.test(menu.when));}
  const refresh=require('../package.json').contributes.menus['view/item/context'].find(item=>item.command==='gushenCompletion.refreshApiObject');
  assert.match(refresh.when,/procedureScope/);
});
test('procedure labels preserve declared parameter order and show only an enabled return marker',()=>{
  const {sourceLabel}=require('../src/api/source-ui');
  const object={sourceType:'procedure',funId:'calculate',name:'计算结果',procedureSignature:{parameters:['$second','$first'],hasReturn:true,returnExpressions:['$result']}};
  assert.equal(sourceLabel(object,{signature:true}),'calculate($second, $first) 计算结果 [return $result]');
  assert.equal(sourceLabel({...object,procedureSignature:{parameters:[],hasReturn:true,returnExpressions:['$items']}},{signature:true}),'calculate() 计算结果 [return $items]');
  assert.equal(sourceLabel({...object,procedureSignature:{parameters:['$id'],hasReturn:false}},{signature:true}),'calculate($id) 计算结果');
  assert.equal(sourceLabel({...object,procedureSignature:{parameters:['$id'],hasReturn:null}},{signature:true}),'calculate($id) 计算结果');
  assert.equal(sourceLabel({...object,procedureSignature:{parameters:['$id'],hasReturn:true,returnExpressions:['null','$result']}},{signature:true}),'calculate($id) 计算结果 [return null | $result]');
  assert.equal(sourceLabel({...object,procedureSignature:{parameters:['$id'],hasReturn:true,returnExpressions:null}},{signature:true}),'calculate($id) 计算结果 [return 无]');
  assert.equal(sourceLabel({...object,procedureSignature:{parameters:[],hasReturn:true,returnExpressions:['$vs.dbTools.list(\n $sql,\n $where\n)']}},{signature:true}),'calculate() 计算结果 [return $vs.dbTools.list( $sql, $where )]');
  assert.equal(sourceLabel(object),'calculate · 计算结果');
});
test('menu refresh includes physical directories of not-yet-indexed platform pages',()=>{
  const {buildCatalogTree}=require('../src/api/source-ui');
  const project={systems:[{systemId:'S',systemName:'系统'}],menuTree:[{systemId:'S',menus:[{id:'m',name:'菜单',isDir:0,pages:[{pageSubId:'A',pageId:'P1'},{pageSubId:'B',pageId:'P2'}]}]}]};
  const tree=buildCatalogTree('projects.a',{},[{path:'systems/S/pages/A/P1/page.xml',sourceType:'page',sourceId:'P1',name:'页面'}],project);
  const menu=tree.find(x=>x.category==='pages').children[0].children[0];
  assert.deepEqual([...menu.refreshPrefixes].sort(),['systems/S/pages/A/P1','systems/S/pages/B/P2']);
});
test('unmatched PAGE objects share one menu folder under their system and keep their physical identity',()=>{
  const objects=[
    {path:'systems/S/pages/0F/PG-1/page.xml',sourceType:'page',sourceId:'PG-1',name:'主页面'},
    {path:'systems/S/pages/5F/PG-2/page.xml',sourceType:'page',sourceId:'PG-2',name:'我的收藏'},
  ];
  const project={systems:[{systemId:'S',systemName:'系统'}]};
  const system=menuTree=>buildCatalogTree('projects.a',{},objects,{...project,menuTree})
    .find(node=>node.category==='pages').children[0];
  assert.deepEqual(system(undefined).children.map(node=>node.label),['待匹配菜单']);
  const [menu,unmatched]=system([{systemId:'S',menus:[
    {id:'main',name:'协同工作台',isDir:0,pages:[{pageSubId:'0F',pageId:'PG-1'}]},
  ]}]).children;
  assert.equal(menu.label,'协同工作台');
  assert.equal(menu.children[0].object.path,objects[0].path);
  assert.equal(unmatched.label,'未归入菜单');
  assert.equal(unmatched.children[0].object.path,objects[1].path);
  assert.deepEqual([...unmatched.refreshPrefixes],['systems/S/pages/5F/PG-2']);
});
test('scoped refresh submits a physical prefix and blocks dirty buffers',async()=>{
  const f=fixture();const calls=[];f.ui.workspaces.set('projects.a',{checkoutPath:'/checkout'});f.ui.updateScm=async()=>{};
  f.vscode.workspace.openTextDocument=async value=>value;f.vscode.window.showTextDocument=async()=>{};
  f.ui.run=async(key,action,input)=>(calls.push({key,action,input}),{complete:true,index:{complete:true}});
  const folder={key:'projects.a',sourcePrefix:'datasources/D/procedures/com/demo',refreshPrefixes:new Set(['datasources/D/procedures/com/demo/save.gss'])};
  f.document.uri.fsPath='/checkout/datasources/D/procedures/com/demo/save.gss';f.document.isDirty=true;await assert.rejects(f.ui.refreshScope(folder),/未保存/);assert.equal(calls.length,0);
  f.document.isDirty=false;await f.ui.refreshScope(folder);assert.deepEqual(calls[0].input,{prefix:'datasources/D/procedures/com/demo'});
  await f.ui.refreshScope({key:'projects.a',refreshPrefixes:new Set(['systems/S/pages/A/P1','systems/S/pages/B/P2'])});assert.deepEqual(calls[1].input,{prefixes:['systems/S/pages/A/P1','systems/S/pages/B/P2']});
  await f.ui.refreshScope({key:'projects.a',object:{path:'systems/S/pages/A/P1/page.xml'}});assert.deepEqual(calls[2].input,{path:'systems/S/pages/A/P1/page.xml'});
});
test('create function requires an unambiguous package and verifies its sample identity',async()=>{
  const f=fixture(),calls=[];f.ui.workspaces.set('projects.a',{checkoutPath:'/checkout'});f.ui.run=async(_key,action,input)=>{calls.push({action,input});if(action==='read')return {metadata:{sourceType:'procedure',dataSourceId:'D',procedureId:'PKG'}};return {stage:'REMOTE_READBACK_VERIFIED'};};
  f.vscode.window.showInputBox=async({title})=>title.includes('编码')?'save':'保存';f.vscode.window.showQuickPick=async()=>[];f.vscode.window.showWarningMessage=async()=>'创建';
  f.vscode.workspace.openTextDocument=async value=>value;f.vscode.window.showTextDocument=async()=>{};f.ui.updateScm=async()=>{};
  await assert.rejects(f.ui.createFunction('projects.a',{}),/过程包/);assert.equal(calls.length,0);
  const pkg={packageIdentities:new Map([['D/PKG',{dataSourceId:'D',procedureId:'PKG',samplePath:'datasources/D/procedures/pkg/other.gss'}]])};
  await f.ui.createFunction('projects.a',pkg);assert.equal(calls[1].input.procedureId,'PKG');assert.equal(calls[1].input.dataSourceId,'D');
  pkg.packageIdentities.get('D/PKG').procedureId='WRONG';await assert.rejects(f.ui.createFunction('projects.a',pkg),/身份与源码不一致/);assert.equal(calls.filter(x=>x.action==='create-function').length,1);
});

test('upload review submits only selected files and cancellation never writes',async()=>{
  const f=fixture();f.ui.reviewUpload=async()=>undefined;
  await f.ui.upload('projects.a');assert.equal(f.calls.some(x=>x.action==='upload'),false);
  f.ui.reviewUpload=async()=>['b'];
  await f.ui.upload('projects.a',['a','b']);
  assert.deepEqual(f.calls.find(x=>x.action==='upload').input.paths,['b']);
  assert.deepEqual(f.calls.find(x=>x.action==='upload').input.expectedHashes,{b:'hash'});
});
test('upload review requires a fresh review after the selected source changes',async()=>{
  const f=fixture();let changed=false;const original=f.ui.run;
  f.ui.run=async(key,action,input)=>action==='read'?{path:input.path,sourceHash:changed?'changed':'before',metadata:{sourceType:'procedure'},name:'保存'}:original(key,action,input);
  f.ui.reviewUpload=async()=>{changed=true;return ['page.gss'];};
  await assert.rejects(f.ui.upload('projects.a'),/源码已变化/);
  assert.equal(f.calls.some(x=>x.action==='upload'),false);
});

test('module directory tree keeps same codes in separate systems and passes precise selectors',()=>{
 const {buildCatalogTree}=require('../src/api/source-ui'),f=fixture();
 f.vscode.TreeItem=class{constructor(label){this.label=label;}};f.vscode.TreeItemCollapsibleState={Collapsed:1,None:0};
 const entries=['A','B'].map(systemId=>({path:'otherconfig/module-parameters.json',sourceType:'module-parameter',sourceId:'same',name:'参数',referenceId:systemId,referenceFields:{systemId,configId:'same',snapshotPath:`systems/${systemId}/module-parameters/same.json`}}));
 const tree=buildCatalogTree('projects.a',{},entries,{systems:[{systemId:'A',systemName:'系统甲'},{systemId:'B',systemName:'系统乙'}]});
 const group=tree.find(x=>x.category==='module-parameters');assert.equal(group.children.length,2);assert.equal(group.sourcePrefixes.size,1);
 f.ui.sourceChanges.set('projects.a',new Map([[entries[0].referenceFields.snapshotPath,'MODIFIED']]));assert.equal(f.ui.getTreeItem(group.children[0].children[0]).description,'有本地修改');
 for(const child of group.children){const command=f.ui.getTreeItem(child.children[0]).command;assert.equal(command.command,'gushenCompletion.editModuleParameter');assert.equal(command.arguments[0].moduleParameter.systemId,child.systemId);}
});
test('hundreds of reference rows refresh their single backing file in one typed call',async()=>{
 const {buildCatalogTree}=require('../src/api/source-ui'),f=fixture(),calls=[];
 f.ui.workspaces.set('projects.a',{checkoutPath:'/checkout'});f.ui.updateScm=async()=>{};
 f.vscode.workspace.openTextDocument=async value=>value;f.vscode.window.showTextDocument=async()=>{};
 f.ui.run=async(key,action,input)=>(calls.push({key,action,input}),{complete:true,index:{complete:true}});
 for(const [kind,path] of [['bill-type','otherconfig/bill-type.md'],['dropdown','otherconfig/dropdown.md']]){
   const objects=Array.from({length:272},(_,i)=>({sourceType:kind,path,sourceId:String(i),name:'条目'+i,referenceId:String(i),dataSourceId:kind==='bill-type'?'D':''}));
   const group=buildCatalogTree('projects.a',{},objects).find(x=>x.category===kind);
   await f.ui.refreshScope(group);assert.deepEqual(calls.at(-1),{key:'projects.a',action:'reference-sync',input:{paths:[path]}});
   if(kind==='bill-type'){await f.ui.refreshScope(group.children[0]);assert.deepEqual(calls.at(-1).input,{paths:[path]});}
 }
 const before=calls.length;await f.ui.refreshScope({key:'projects.a',category:'module-parameters',sourcePrefixes:new Set(['otherconfig/module-parameters.json'])});
 assert.equal(calls.length,before+1);assert.equal(calls.at(-1).action,'module-parameters-sync');assert.deepEqual(calls.at(-1).input,{});
});

const test=require('node:test');const assert=require('node:assert/strict');const {ApiSourceUI,identity}=require('../src/api/source-ui');
const {posix}=require('node:path');
function fixture(run) {
 const controls=[],vscode={workspace:{textDocuments:[]},Uri:{from:x=>x},scm:{
  createSourceControl(id,label) {
   const control={id,label,count:0,inputBox:{value:''},groups:{},createResourceGroup(groupId,groupLabel) {
    const group={id:groupId,label:groupLabel,resourceStates:[]};
    this.groups[groupId]=group;
    if(groupId==='changes') this.group=group;
    return group;
   },dispose(){this.disposed=true;}};
   controls.push(control);
   return control;
  },
 }};
 return {ui:new ApiSourceUI({vscode,run}),controls};
}
test('API SCM exposes in-scope modifications, conflicts and noneditable states with exact paths',async()=>{
 const f=fixture(async()=>({checkoutPath:'/checkout',files:[{path:'pkg/a.gss',state:'MODIFIED'},{path:'b',state:'CONFLICT'},{path:'c',state:'MISSING'},{path:'readonly-conflict',state:'CONFLICT',readonly:true},{path:'d',state:'CLEAN'},{path:'e',state:'MODIFIED',inScope:false}]}));
 f.ui.syncWorkspaces([{workspaceKey:'projects.demo',sourceMode:'api'}]);await f.ui.updateScm('projects.demo');
 const c=f.controls[0];assert.equal(c.count,4);assert.deepEqual(c.group.resourceStates.map(x=>x.contextValue),['guthonApi.change','guthonApi.conflict','guthonApi.unavailable','guthonApi.conflict']);
 const change=c.group.resourceStates[0];
 assert.equal(posix.basename(change.resourceUri.path),'a.gss');
 assert.deepEqual(identity(change),{key:'projects.demo',path:'pkg/a.gss'});
 assert.equal(change.command.command,'gushenCompletion.showApiDiff');
 assert.deepEqual(change.command.arguments,[{workspaceKey:'projects.demo',path:'pkg/a.gss'}]);
 f.ui.dispose();assert.equal(c.disposed,true);
});
test('API SCM labels pages in Chinese and uses English identities for services and procedures',async t=>{
 const key='ws_demo';
 const files=[
  {path:'systems/A/pages/main/PG-1/PG-1.xml',sourceType:'page',metadata:{pageType:1,pageName:'采购/审核',title:'采购申请'}},
  {path:'systems/A/pages/main/PG-2/PG-2.xml',sourceType:'page',metadata:{pageType:1,title:'采购/审核'}},
  {path:'systems/A/pages/main/PG-3/PG-3.xml',sourceType:'page',metadata:{pageType:1,pageAliasId:'order'}},
  {path:'systems/A/pages/main/PG-4/legacy.gss',sourceType:'page',metadata:{pageType:'0',pageName:'同步组织',pageAliasId:'com.demo.syncOrganization'}},
  {path:'systems/A/pages/main/PG-5/com.demo.legacy.gss',sourceType:'page',metadata:{pageName:'旧服务'}},
  {path:'datasources/D/procedures/com/demo/old.gss',sourceType:'procedure',metadata:{funId:'processOrder',funName:'处理采购单'}},
 ].map(file=>({...file,state:'MODIFIED',sourceHash:'hash',baseHash:'base'}));
 const project={
  systems:[{systemId:'A',systemName:'采购系统'}],dataSources:[{dataSourceId:'D',dataSourceName:'公用数据'}],
  menuTree:[{systemId:'A',menus:[{id:'review',name:'采购审核',isDir:0,pages:[
   {pageId:'PG-1',pageSubId:'main'},{pageId:'PG-2',pageSubId:'main'},
  ]}]}],
 };
 let catalogCalls=0;
 const f=fixture(async(_key,action)=>{
  if(action==='catalog') {catalogCalls++;return {indexGeneration:'g1',project};}
  assert.equal(action,'status');
  return {checkoutPath:'/checkout',files,index:{ready:true,indexGeneration:'g1'}};
 });
 t.after(()=>f.ui.dispose());
 f.ui.syncWorkspaces([key]);
 await f.ui.updateScm(key);
 const group=f.controls[0].group;
 assert.deepEqual(group.resourceStates.map(row=>posix.basename(row.resourceUri.path)),[
  '采购 · 审核.xml','采购 · 审核.xml','PG-3.xml','com.demo.syncOrganization.gss','com.demo.legacy.gss','processOrder.gss',
 ]);
 assert.notEqual(group.resourceStates[0].resourceUri.path,group.resourceStates[1].resourceUri.path);
 assert.match(group.resourceStates[0].resourceUri.path,/^\/页面\/采购系统\/采购审核\//);
 assert.equal(group.resourceStates[2].resourceUri.path,'/页面/采购系统/PG-3.xml');
 assert.equal(group.resourceStates[5].resourceUri.path,'/过程函数/公用数据/com/demo/processOrder.gss');
 assert.deepEqual(group.resourceStates.map(identity),files.map(file=>({key,path:file.path})));

 files[0].metadata.pageName='采购复核';
 await f.ui.updateScm(key);
 assert.equal(catalogCalls,1);
 assert.equal(posix.basename(group.resourceStates[0].resourceUri.path),'采购复核.xml');
 assert.deepEqual(group.resourceStates[0].command.arguments,[{workspaceKey:key,path:files[0].path}]);
});
test('original path menu displays the physical checkout path and copies the requested form',async t=>{
 const key='ws_demo',sourcePath='systems/A/pages/main/PG-1/PG-1.xml';
 const f=fixture(async()=>assert.fail('a registered checkout already supplies the root'));
 t.after(()=>f.ui.dispose());
 f.ui.syncWorkspaces([{workspaceKey:key,checkoutPath:'/checkout'}]);
 let copied;
 f.ui.vscode.env={clipboard:{writeText:async value=>{copied=value;}}};
 f.ui.vscode.window={showInformationMessage:async(title,options,relative,absolute)=>{
  assert.equal(title,'API 源码原始路径');assert.equal(options.modal,true);
  assert.match(options.detail,/绝对路径：\/checkout\/systems\/A\//);
  assert.equal(relative,'复制相对路径');
  return absolute;
 }};
 await f.ui.showOriginalPath(key,sourcePath);
 assert.equal(copied,'/checkout/'+sourcePath);
});
test('API SCM stages exact files, confirms the entire queue and retains files without successful receipts',async t=>{
 const key='ws_demo',files=['a.gss','b.gss','c.gss','param.json'].map(p=>({
  path:p,state:'MODIFIED',sourceHash:'hash-'+p,sourceType:p==='param.json'?'module-parameter':'procedure',
 }));
 const uploads=[],confirms=[];
 const f=fixture(async(_key,action,input)=>{
  if(action==='status') return {checkoutPath:'/checkout',files};
  if(action==='read') {
   const file=files.find(row=>row.path===input.path);
   return {sourceHash:file.sourceHash,metadata:{sourceType:file.sourceType}};
  }
  if(action==='upload') {
   uploads.push(input);
   files[0].state='CLEAN';
   return {stage:'PARTIAL',remark:input.remark,results:[{path:'a.gss',stage:'REMOTE_READBACK_VERIFIED'},{path:'b.gss',stage:'FAILED'}]};
  }
  assert.fail(action);
 });
 t.after(()=>f.ui.dispose());
 f.ui.syncWorkspaces([{workspaceKey:key,name:'项目甲'}]);
 let answer;
 f.ui.vscode.workspace.openTextDocument=async options=>options;
 f.ui.vscode.window={
  showTextDocument:async()=>{},
  showQuickPick:async()=>assert.fail('SCM scope already supplies the files'),
  showWarningMessage:async(message,options)=>{confirms.push({message,...options});return answer;},
 };
 f.ui.reviewUpload=async()=>assert.fail('staged upload already has an exact file selection');
 await f.ui.applyScmChangeAction(key,'stage',['a.gss','b.gss']);
 const {inputBox,acceptInputCommand}=f.controls[0];
 assert.equal(inputBox.placeholder,'上传备注（可选）');
 assert.deepEqual(acceptInputCommand,{command:'gushenCompletion.uploadStagedApiSources',title:'上传暂存',arguments:[key]});
 inputBox.value='  修订后上传\n已审阅差异  ';
 const {changes,staged}=f.controls[0].groups;
 assert.deepEqual(changes.resourceStates.map(row=>identity(row).path),['c.gss','param.json']);
 assert.deepEqual(changes.resourceStates.map(row=>row.contextValue),['guthonApi.change.stageable','guthonApi.change']);
 assert.deepEqual(staged.resourceStates.map(row=>identity(row).path),['a.gss','b.gss']);
 await assert.rejects(f.ui.applyScmChangeAction(key,'stage',['c.gss','param.json']),/暂存源码：param.json/);
 assert.deepEqual([...f.ui.stagedFiles(key,'/checkout').keys()],['a.gss','b.gss']);
 await f.ui.uploadStaged(key);
 assert.equal(uploads.length,0);
 assert.equal(confirms[0].detail,'a.gss\nb.gss\n\n上传备注（本地操作记录）\n修订后上传\n已审阅差异');
 assert.equal(inputBox.value,'  修订后上传\n已审阅差异  ');
 assert.match(confirms[0].message,/项目甲 暂存区中的全部 2 个文件/);
 assert.equal(confirms[0].modal,true);

 answer='上传';
 files[1].sourceHash='new-b';
 await assert.rejects(f.ui.uploadStaged(key),/重新暂存：b.gss/);
 assert.equal(uploads.length,0);
 await f.ui.applyScmChangeAction(key,'stage','b.gss');
 await f.ui.uploadStaged(key);
 assert.deepEqual(uploads,[{paths:['a.gss','b.gss'],confirm:true,remark:'修订后上传\n已审阅差异',
  expectedHashes:{'a.gss':'hash-a.gss','b.gss':'new-b'}}]);
 assert.equal(inputBox.value,'  修订后上传\n已审阅差异  ');
 assert.deepEqual(staged.resourceStates.map(row=>identity(row).path),['b.gss']);

 await f.ui.applyScmChangeAction(key,'unstage');
 assert.deepEqual(staged.resourceStates,[]);
 assert.deepEqual(changes.resourceStates.map(row=>identity(row).path),['b.gss','c.gss','param.json']);
});
test('API SCM restore confirms the exact selected files in the original project',async t=>{
 const key='ws_demo',files=['a','b','c'].map(name=>({path:name+'.gss',state:'MODIFIED',sourceHash:'hash-'+name,sourceType:'procedure'}));
 const reverts=[];
 const f=fixture(async(_key,action,input)=>{
  if(action==='status') return {checkoutPath:'/checkout',files};
  const file=files.find(row=>row.path===input.path);
  if(action==='read') return {sourceHash:file.sourceHash};
  if(action==='revert') {reverts.push(input);file.state='CLEAN';return {operationId:'revert1'};}
  assert.fail(action);
 });
 t.after(()=>f.ui.dispose());
 f.ui.syncWorkspaces([key,'ws_other']);
 f.ui.setSelectedWorkspace(key);
 await f.ui.applyScmChangeAction(key,'stage','c.gss');
 f.ui.vscode.workspace.openTextDocument=async options=>options;
 let confirmation=()=>undefined;
 f.ui.vscode.window={
  showTextDocument:async()=>{},
  showQuickPick:async()=>assert.fail('SCM scope already supplies the files'),
  showWarningMessage:async(message,options)=>{
   assert.equal(options.modal,true);
   assert.match(message,/a\.gss\nb\.gss$/);
   return confirmation();
  },
 };
 await f.ui.applyScmChangeAction(key,'revert');
 assert.deepEqual(reverts,[]);

 confirmation=()=>{f.ui.setSelectedWorkspace('ws_other');return '还原';};
 await assert.rejects(f.ui.applyScmChangeAction(key,'revert'),/当前项目已切换/);
 assert.deepEqual(reverts,[]);

 f.ui.setSelectedWorkspace(key);
 confirmation=()=> '还原';
 await f.ui.applyScmChangeAction(key,'revert',['a.gss','b.gss']);
 assert.deepEqual(reverts,[{path:'a.gss',expectedHash:'hash-a'},{path:'b.gss',expectedHash:'hash-b'}]);
 assert.deepEqual([...f.ui.stagedFiles(key,'/checkout').keys()],['c.gss']);
});
test('API SCM group actions use every eligible file in the indicated group',async t=>{
 const key='projects.demo';
 const files=[
  ...['a.gss','b.gss','c.gss'].map(path=>({path,state:'MODIFIED',sourceHash:path,sourceType:'procedure'})),
  {path:'param.json',state:'MODIFIED',sourceHash:'param',sourceType:'module-parameter'},
  {path:'missing.xml',state:'MISSING',sourceType:'page'},
 ];
 const f=fixture(async()=>({checkoutPath:'/checkout',files}));
 t.after(()=>f.ui.dispose());
 f.ui.syncWorkspaces([key]);
 f.ui.vscode.window={showQuickPick:async()=>assert.fail('group actions already have their file scope')};
 const opened=[];
 t.mock.method(f.ui,'open',async(workspace,path,preview,options)=>{opened.push(path);assert.deepEqual([workspace,preview,options],[key,false,{raw:true}]);});
 await f.ui.applyScmChangeAction(key,'stage','a.gss');
 await f.ui.openScmGroupSources(key,'staged');
 assert.deepEqual(opened.splice(0),['a.gss']);
 await f.ui.openScmGroupSources(key,'changes');
 assert.deepEqual(opened.splice(0),['b.gss','c.gss','param.json']);

 await f.ui.applyScmChangeAction(key,'stage');
 const {changes,staged}=f.controls[0].groups;
 assert.deepEqual(staged.resourceStates.map(row=>identity(row).path),['a.gss','b.gss','c.gss']);
 assert.deepEqual(changes.resourceStates.map(row=>identity(row).path),['param.json','missing.xml']);
 await f.ui.applyScmChangeAction(key,'unstage',['b.gss','c.gss']);
 assert.deepEqual(staged.resourceStates.map(row=>identity(row).path),['a.gss']);
 await f.ui.applyScmChangeAction(key,'unstage');
 assert.deepEqual(staged.resourceStates,[]);
});
test('SCM remarks follow their project and only the successfully uploaded draft is cleared',async t=>{
 const key='projects.demo',other='projects.other';
 const f=fixture(async workspace=>({checkoutPath:'/checkout/'+workspace,files:[]}));
 t.after(()=>f.ui.dispose());
 f.ui.syncWorkspaces([key,other]);
 f.ui.setSelectedWorkspace(key);
 await f.ui.updateScm(key);
 f.controls.at(-1).inputBox.value='本项目备注';
 f.ui.setSelectedWorkspace(other);
 await f.ui.updateScm(other);
 assert.equal(f.controls.at(-1).inputBox.value,'');
 f.ui.setSelectedWorkspace(key);
 await f.ui.updateScm(key);
 const {inputBox}=f.controls.at(-1);
 assert.equal(inputBox.value,'本项目备注');
 let editOnUpload=true,remarkRecorded=true;
 t.mock.method(f.ui,'upload',async(workspace,_paths,options)=>{
  assert.equal(workspace,key);
  assert.deepEqual(options,{stagedOnly:true,remark:editOnUpload?'本项目备注':'下一批备注'});
  if(editOnUpload) inputBox.value='下一批备注';
  return {complete:true,...(remarkRecorded ? {remark:options.remark} : {})};
 });
 await f.ui.uploadStaged(key);
 assert.equal(inputBox.value,'下一批备注');
 editOnUpload=false;
 remarkRecorded=false;
 await f.ui.uploadStaged(key);
 assert.equal(inputBox.value,'下一批备注');
 remarkRecorded=true;
 await f.ui.uploadStaged(key);
 assert.equal(inputBox.value,'');
});
test('API SCM uses the registered project name and refreshes its label with a stable provider identity',async t=>{
 const key='ws_demo',checkoutPath='/checkout';
 const f=fixture(async()=>({checkoutPath,files:[{path:'a.gss',state:'MODIFIED'}]}));
 t.after(()=>f.ui.dispose());
 f.ui.syncWorkspaces([{workspaceKey:key,sourceMode:'api',checkoutPath,name:'供应链项目'}]);
 await f.ui.updateScm(key);
 assert.equal(f.controls[0].label,'供应链项目 · 谷神 API 源码');
 assert.equal(f.controls[0].id,'guthon-api-ws_demo');
 await f.ui.updateScm(key);
 assert.equal(f.controls.length,1);

 f.ui.syncWorkspaces([{workspaceKey:key,sourceMode:'api',checkoutPath,name:'供应链项目',displayName:'供应链开发项目'}]);
 await f.ui.updateScm(key);
 assert.equal(f.controls.length,2);
 assert.equal(f.controls[0].disposed,true);
 assert.equal(f.controls[1].label,'供应链开发项目 · 谷神 API 源码');
 assert.equal(f.controls[1].id,f.controls[0].id);
 assert.deepEqual(identity(f.controls[1].group.resourceStates[0]),{key,path:'a.gss'});
});
test('SCM preserves the exact workspace key when a URI authority is lowercased',async()=>{
 const f=fixture(async()=>({checkoutPath:'/checkout',files:[{path:'a.gss',state:'MODIFIED'}]}));
 f.ui.vscode.Uri.from=x=>({...x,authority:x.authority.toLowerCase()});
 f.ui.syncWorkspaces([{workspaceKey:'products.GuthonOfficial',sourceMode:'api'}]);await f.ui.updateScm('products.GuthonOfficial');
 const uri=f.controls[0].group.resourceStates[0].resourceUri;assert.equal(uri.authority,'products.guthonofficial');
 assert.deepEqual(identity({resourceUri:uri}),{key:'products.GuthonOfficial',path:'a.gss'});f.ui.dispose();
});
test('newer SCM refresh cannot be overwritten by a late old response',async()=>{
 const releases=[];const f=fixture(async()=>new Promise(resolve=>releases.push(resolve)));f.ui.syncWorkspaces(['projects.demo']);
 const first=f.ui.updateScm('projects.demo'),second=f.ui.updateScm('projects.demo');
 releases[1]({checkoutPath:'/checkout',files:[{path:'new',state:'MODIFIED'}]});await second;
 releases[0]({checkoutPath:'/checkout',files:[{path:'old',state:'MODIFIED'}]});await first;
 assert.equal(new URLSearchParams(f.controls[0].group.resourceStates[0].resourceUri.query).get('path'),'new');f.ui.dispose();
});
test('removing a workspace invalidates a pending SCM result',async()=>{
 let release;const f=fixture(async()=>new Promise(resolve=>release=resolve));f.ui.syncWorkspaces(['projects.demo']);
 const pending=f.ui.updateScm('projects.demo');f.ui.syncWorkspaces([]);release({checkoutPath:'/checkout',files:[{path:'x',state:'MODIFIED'}]});await pending;
 assert.equal(f.controls.length,0);f.ui.dispose();
});
test('source tree marks modified files and propagates conflicts to parent folders',async()=>{
 const f=fixture(async(_key,action)=>action==='status'?{checkoutPath:'/checkout',files:[{path:'systems/A/one.gss',state:'MODIFIED'},{path:'systems/A/two.gss',state:'CONFLICT'}]}:{objects:[{path:'systems/A/one.gss',sourceType:'procedure'},{path:'systems/A/two.gss',sourceType:'procedure'}]});
 f.ui.vscode.TreeItem=class{constructor(label,state){this.label=label;this.collapsibleState=state;}};f.ui.vscode.TreeItemCollapsibleState={Collapsed:1,None:0};f.ui.vscode.ThemeIcon=class{constructor(id,color){this.id=id;this.color=color;}};f.ui.vscode.ThemeColor=class{constructor(id){this.id=id;}};
 f.ui.syncWorkspaces(['projects.demo']);await f.ui.updateScm('projects.demo');const root=(await f.ui.getChildren()).find(x=>x.label==='其他源码'),systems=root.children[0],group=systems.children[0];
 assert.equal(f.ui.getTreeItem(systems).description,'冲突');assert.equal(f.ui.getTreeItem(group).description,'冲突');
 assert.equal(f.ui.getTreeItem(group.children.find(x=>x.object.path.endsWith('one.gss'))).description,'有本地修改');f.ui.dispose();
});
test('unchanged SCM refresh does not emit another tree refresh',async()=>{
 let events=0;const f=fixture(async()=>({checkoutPath:'/checkout',files:[{path:'a',state:'MODIFIED',sourceHash:'one',baseHash:'base'}]}));
 f.ui.emitter={fire(){events++;},dispose(){}};f.ui.syncWorkspaces(['projects.demo']);await f.ui.updateScm('projects.demo');const afterFirst=events;
 await f.ui.updateScm('projects.demo');assert.equal(events,afterFirst);f.ui.dispose();
});

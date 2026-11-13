const test=require('node:test');const assert=require('node:assert/strict');const {ApiSourceUI,identity}=require('../src/api/source-ui');
function fixture(run){const controls=[];const vscode={workspace:{textDocuments:[]},Uri:{from:x=>x},scm:{createSourceControl:(id,label)=>{const control={id,label,count:0,createResourceGroup:()=>control.group={resourceStates:[]},dispose(){this.disposed=true;}};controls.push(control);return control;}}};return {ui:new ApiSourceUI({vscode,run}),controls};}
test('API SCM exposes in-scope modifications, conflicts and noneditable states with exact paths',async()=>{
 const f=fixture(async()=>({checkoutPath:'/checkout',files:[{path:'a',state:'MODIFIED'},{path:'b',state:'CONFLICT'},{path:'c',state:'MISSING'},{path:'readonly-conflict',state:'CONFLICT',readonly:true},{path:'d',state:'CLEAN'},{path:'e',state:'MODIFIED',inScope:false}]}));
 f.ui.syncWorkspaces([{workspaceKey:'projects.demo',sourceMode:'api'}]);await f.ui.updateScm('projects.demo');
 const c=f.controls[0];assert.equal(c.count,4);assert.deepEqual(c.group.resourceStates.map(x=>x.contextValue),['guthonApi.change','guthonApi.conflict','guthonApi.unavailable','guthonApi.conflict']);
 assert.equal(new URLSearchParams(c.group.resourceStates[0].resourceUri.query).get('path'),'a');f.ui.dispose();assert.equal(c.disposed,true);
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
 f.ui.vscode.TreeItem=class{constructor(label,state){this.label=label;this.collapsibleState=state;}};f.ui.vscode.TreeItemCollapsibleState={Collapsed:1,None:0};f.ui.vscode.ThemeIcon=class{constructor(id){this.id=id;}};
 f.ui.syncWorkspaces(['projects.demo']);await f.ui.updateScm('projects.demo');const root=(await f.ui.getChildren())[0],systems=(await f.ui.getChildren(root))[0],group=systems.children[0];
 assert.equal(f.ui.getTreeItem(systems).description,'冲突');assert.equal(f.ui.getTreeItem(group).description,'冲突');
 assert.equal(f.ui.getTreeItem(group.children.find(x=>x.object.path.endsWith('one.gss'))).description,'有本地修改');f.ui.dispose();
});

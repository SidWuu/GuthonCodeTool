const test=require('node:test');
const assert=require('node:assert/strict');
const {ApiSourceUI}=require('../src/api/source-ui');

function fixture(run,execute=async()=>{}) {
  const controls=[];
  const vscode={workspace:{textDocuments:[]},commands:{executeCommand:execute},
    Uri:{from:x=>x},scm:{createSourceControl:(_id,label)=>{
      const control={label,disposed:false,dispose(){this.disposed=true;},createResourceGroup(){return {};}};
      controls.push(control);return control;
    }}};
  const ui=new ApiSourceUI({vscode,run});
  ui.syncWorkspaces([{workspaceKey:'ws_A',displayName:'甲',checkoutPath:'/var/甲/checkout'},
                     {workspaceKey:'ws_B',displayName:'乙',checkoutPath:'/var/乙/checkout'}]);
  return {ui,controls};
}
const status=key=>({checkoutPath:`/var/${key}/checkout`,files:[{path:'a.gss',state:'MODIFIED'}]});

test('window selection limits source roots and SCM while retaining registrations',async()=>{
  const {ui,controls}=fixture(async key=>status(key));
  ui.setSelectedWorkspace('');assert.deepEqual(await ui.getChildren(),[]);
  ui.setSelectedWorkspace('ws_A');assert.deepEqual(ui.workspaceRoots().map(x=>x.key),['ws_A']);
  await ui.updateScm('ws_A');assert.equal(controls.length,1);
  ui.setSelectedWorkspace('ws_B');assert.equal(controls[0].disposed,true);
  await ui.updateScm('ws_B');assert.deepEqual([...ui.controls.keys()],['ws_B']);
  assert.equal(ui.workspaces.size,2);assert.deepEqual(await ui.getChildren({key:'ws_A',workspace:true}),[]);
  ui.dispose();
});
test('late status cannot revive SCM after switching away and back',async()=>{
  let finish;const {ui,controls}=fixture(key=>new Promise(resolve=>{finish=()=>resolve(status(key));}));
  ui.setSelectedWorkspace('ws_A');const pending=ui.updateScm('ws_A');
  ui.setSelectedWorkspace('ws_B');ui.setSelectedWorkspace('ws_A');finish();await pending;
  assert.equal(controls.length,0);ui.dispose();
});
test('selection change while setting UI context cannot recreate former SCM',async()=>{
  let finish,setting=false;
  const {ui,controls}=fixture(async key=>status(key),async(_command,name,value)=>{
    if(name==='gushenCompletion.hasUnknownUpload' && value===false && !setting){setting=true;return new Promise(resolve=>{finish=resolve;});}
  });
  ui.setSelectedWorkspace('ws_A');finish();
  let release,blocked=false;ui.vscode.commands.executeCommand=async()=>{if(!blocked){blocked=true;return new Promise(resolve=>{release=resolve;});}};
  const pending=ui.updateScm('ws_A');while(!release)await new Promise(resolve=>setImmediate(resolve));
  ui.setSelectedWorkspace('ws_B');release();await pending;assert.equal(controls.length,0);ui.dispose();
});

test('old toolHome status cannot overwrite a new registration with the same key',async()=>{
  let finish;const {ui}=fixture(key=>new Promise(resolve=>{finish=()=>resolve(status(key));}));
  ui.setSelectedWorkspace('ws_A');const pending=ui.status('ws_A');
  ui.clear();ui.syncWorkspaces([{workspaceKey:'ws_A',checkoutPath:'/new-home/var/甲/checkout'}]);
  finish();await assert.rejects(pending,/已切换/);
  assert.equal(ui.workspaces.get('ws_A').checkoutPath,'/new-home/var/甲/checkout');
  assert.equal(ui.watchers.size,0);ui.dispose();
});
test('old toolHome summary cannot recreate a checkout after resetting the space',async()=>{
  let finish;const {ui}=fixture(()=>new Promise(resolve=>{finish=resolve;}));
  ui.syncWorkspaces([{workspaceKey:'ws_A'}]);const pending=ui.ensureWorkspace('ws_A');
  ui.clear();ui.syncWorkspaces([{workspaceKey:'ws_A',checkoutPath:'/new-home/checkout'}]);
  finish({checkoutPath:'/old-home/checkout'});await assert.rejects(pending,/已切换/);
  assert.equal(ui.workspaces.get('ws_A').checkoutPath,'/new-home/checkout');ui.dispose();
});

test('late catalog children cannot render after switching to another project or a diagnostic',async()=>{
  const {ui}=fixture(async()=>({files:[]}));let finish;
  ui.setSelectedWorkspace('ws_A');
  ui.unfilteredChildren=()=>new Promise(resolve=>{finish=resolve;});
  const pending=ui.getChildren();
  ui.setSelectedWorkspace('ws_B');finish([{label:'A old item'}]);assert.deepEqual(await pending,[]);
  const next=ui.getChildren();ui.setProjectPresentation(undefined,{workspaceKey:'ws_B',message:'配置异常'});
  finish([{label:'B old item'}]);assert.deepEqual(await next,[]);ui.dispose();
});

test('source filters stay with the project when switching',()=>{
  const {ui}=fixture(async()=>({files:[]}));ui.treeView={};
  ui.filters.set('ws_A','采购');ui.setSelectedWorkspace('ws_A');assert.match(ui.treeView.message,/采购/);
  ui.setSelectedWorkspace('ws_B');assert.equal(ui.treeView.message,undefined);
  ui.setSelectedWorkspace('ws_A');assert.match(ui.treeView.message,/采购/);ui.dispose();
});

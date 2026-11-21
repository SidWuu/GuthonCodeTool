const test=require('node:test');
const assert=require('node:assert/strict');
const {ProjectOverview,registerProjectOverview}=require('../src/project-overview');
const {WindowWorkspaceSelection}=require('../src/tool-workspace');

class EventEmitter {constructor(){this.event=()=>({dispose(){}});}fire(){}dispose(){}}
class TreeItem {constructor(label){this.label=label;}}
const vscode={EventEmitter,TreeItem,TreeItemCollapsibleState:{None:0},ThemeIcon:class {constructor(id){this.id=id;}}};
const snapshot=()=>({workspaces:[
  {workspaceKey:'ws_api',name:'API 产品',aliases:['api-alias'],sourceMode:'api',root:'/home/var/api',workspaceBinding:{digest:'a'}},
  {workspaceKey:'projects.s',name:'旧项目',sourceMode:'svn',executionReady:false,root:'/home/var/s'},
  {workspaceKey:'products.d',name:'旧产品',sourceMode:'database',executionReady:false,root:'/home/var/d'}],
  configErrors:[{workspaceKey:'bad',code:'CONFIG_INVALID',message:'源码路径冲突'}]});

test('project overview registers a webview pane for the host toolbar and renders only project and diagnostic rows',async()=>{
  const messages=[],disposable={dispose(){}};
  const {provider,view}=registerProjectOverview({context:{extensionPath:require('node:path').resolve(__dirname,'..')},vscode:{...vscode,window:{registerWebviewViewProvider:id=>{
    assert.equal(id,'gushenCompletion.projectOverview');
    return disposable;
  }}}});
  provider.setSnapshot(snapshot(),'ws_api');
  const webview={onDidReceiveMessage:()=>disposable,postMessage:async message=>messages.push(message)};
  view.resolveWebviewView({webview,onDidDispose(){}});
  await view.receive({type:'ready'});
  assert(!webview.html.includes('role="toolbar"'));
  const {rows}=messages.at(-1);
  assert.equal(rows.length,4);
  assert.equal(view.nodes.get(rows[0].id).item.contextValue,'guthonProject.project.api');
  assert.equal(view.nodes.get(rows.at(-1).id).item.contextValue,'guthonProject.diagnostic');
  view.dispose();
});

test('overview presents all providers and diagnostic rows without fetching project state',()=>{
  const view=new ProjectOverview({vscode});view.setSnapshot(snapshot(),'ws_api');
  const rows=view.getChildren();assert.equal(rows.length,4);
  const items=rows.map(row=>view.getTreeItem(row));
  assert.equal(items[0].label,'API 产品');assert.match(items[0].description,/API.*待检查/);
  assert.equal(items[0].iconPath.id,'pass-filled');
  assert.match(items[1].description,/SVN.*未接入/);assert.match(items[2].description,/DATABASE/);
  assert.equal(items[3].label,'bad');assert.equal(items[3].description,'配置异常');
  assert.deepEqual(items[3].command.arguments,['bad']);
});

test('project search does not change current selection and a local summary stays with its source',async()=>{
  const view=new ProjectOverview({vscode:{...vscode,window:{showInputBox:async()=> 'api-alias'}}});
  const data=snapshot();view.setSnapshot(data,'projects.s');await view.search();
  assert.equal(view.getChildren().length,1);assert.equal(view.selectedKey,'projects.s');
  view.updateSummary('ws_api',{summary:{changedCount:3},files:[]});
  assert.match(view.getTreeItem(view.getChildren()[0]).description,/3 修改/);
  data.workspaces[0].workspaceBinding={digest:'changed'};
  view.setSnapshot(data,'projects.s');assert.match(view.getTreeItem(view.getChildren()[0]).description,/待检查/);
});

test('overview waits for configuration and searches a diagnostic by its display name',async()=>{
  const view=new ProjectOverview({vscode:{...vscode,window:{showInputBox:async()=> '待修复项目'}}});
  const loading=view.getTreeItem(view.getChildren()[0]);
  assert.match(loading.label,/正在读取项目/);
  assert.equal(loading.command,undefined);
  const data=snapshot();
  data.configErrors[0].name='待修复项目';
  view.setSnapshot(data,'ws_api');
  await view.search();
  assert.equal(view.selectedKey,'ws_api');
  const rows=view.getChildren();assert.equal(rows.length,1);
  assert.equal(view.getTreeItem(rows[0]).label,'待修复项目');
  assert.deepEqual(view.getTreeItem(rows[0]).command.arguments,['bad']);
});

test('unknown or partial source state is never displayed as zero modifications',()=>{
  const view=new ProjectOverview({vscode});view.setSnapshot(snapshot(),'ws_api');
  view.updateSummary('ws_api',{summaryComplete:false,summary:{changedCount:0},files:[]});
  assert.match(view.getTreeItem(view.getChildren()[0]).description,/待检查/);
  view.updateSummary('ws_api',{summary:{changedCount:1},files:[{state:'CONFLICT'}]});
  assert.match(view.getTreeItem(view.getChildren()[0]).description,/冲突/);
});

test('a local project failure isolates that row while global config failure removes stale actions',()=>{
  const view=new ProjectOverview({vscode});view.setSnapshot(snapshot(),'ws_api');
  view.setProjectError('ws_api',new Error('状态文件损坏'));
  assert.equal(view.getChildren().filter(row=>row.kind==='project').length,2);
  assert.equal(view.diagnostic().workspaceKey,'ws_api');
  view.setError(new Error('CONFIG_AUTHORITY_CONFLICT'));
  const item=view.getTreeItem(view.getChildren()[0]);
  assert.equal(item.command.command,'gushenCompletion.openProjectConfiguration');
  assert.match(item.tooltip,/CONFIG_AUTHORITY_CONFLICT/);assert.equal(view.selectedKey,'');
  view.setSnapshot(snapshot(),'projects.s');assert.equal(view.error,undefined);assert.equal(view.getChildren().length,4);
});

test('diagnostic selection clears the actionable and persisted key without retargeting another project',async()=>{
  const state=new Map(),data=snapshot();let changed=0;
  const selection=new WindowWorkspaceSelection({getWorkspaces:async()=>data.workspaces,getScope:()=>'/home',
    getFolders:()=>['/home/var'],state:{get:(key,fallback)=>state.get(key)??fallback,update:async(key,value)=>state.set(key,value)},
    window:{},onChange:()=>changed++});
  await selection.select('ws_api',{switchWindow:true});
  await selection.inspectDiagnostic('bad');
  assert.equal(await selection.current(),undefined);assert.equal(selection.diagnosticKey,'bad');
  assert.deepEqual([...state.values()],[undefined]);
  await selection.select('projects.s',{switchWindow:true});assert.equal((await selection.current()).sourceMode,'svn');
  assert.equal(selection.diagnosticKey,'');assert.equal(changed,3);
  data.workspaces=data.workspaces.filter(item=>item.workspaceKey!=='projects.s');
  assert.equal(await selection.current(),undefined);assert.equal(selection.diagnosticKey,'projects.s');
});


test('project right-click menus attach to the matching provider and keep removal scoped to API',()=>{
  const {workspaceKeyFrom}=require('../src/api/project-actions');
  const view=new ProjectOverview({vscode});view.setSnapshot(snapshot(),'ws_api');
  const contexts=view.getChildren().filter(row=>row.kind==='project').map(row=>view.getTreeItem(row).contextValue);
  assert.deepEqual(contexts,['guthonProject.project.api','guthonProject.project.svn','guthonProject.project.database']);
  assert.equal(workspaceKeyFrom(view.getChildren()[1]),'projects.s');
  assert.equal(view.selectedKey,'ws_api');
  const manifest=require('../package.json');
  const menu=manifest.contributes.menus['view/item/context'].filter(item=>item.when.includes('view == gushenCompletion.projectOverview'));
  assert.deepEqual(menu.map(item=>item.command),['gushenCompletion.deleteWorkspace']);
  assert.match(menu.find(item=>item.command==='gushenCompletion.deleteWorkspace').when,/guthonProject\.project\.api$/);
});

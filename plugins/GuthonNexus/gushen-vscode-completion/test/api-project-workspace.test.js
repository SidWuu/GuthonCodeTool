const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {parse}=require('jsonc-parser');
const {activateApi}=require('../src/api/activate');
const {ToolProcessClient}=require('../src/tool-process-client');

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-project-window-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const workspaceRoot=path.join(root,'project'),checkoutPath=path.join(workspaceRoot,'source','api');
  await fs.mkdir(path.join(workspaceRoot,'context'),{recursive:true});await fs.mkdir(checkoutPath,{recursive:true});
  const filename=path.join(workspaceRoot,'context','nexus.code-workspace'),handlers=new Map(),calls=[],errors=[];
  const settings={executionMode:'script',toolHome:'/configured/home',toolPath:'/configured/tool',developmentRoot:'/configured/source',scriptPythonPath:'/configured/python',scriptToolPath:'/configured/tool.pyz'};
  const vscode={workspace:{workspaceFolders:[],textDocuments:[],getConfiguration:()=>({get:(key,fallback)=>settings[key] ?? fallback})},
    Uri:{file:fsPath=>({scheme:'file',fsPath})},
    commands:{registerCommand:(id,handler)=>(handlers.set(id,handler),{dispose(){}}),executeCommand:async(...args)=>calls.push(args)},
    window:{showErrorMessage:async message=>errors.push(message)}};
  const processClient={request:async(_tool,command,args,key,input)=>{assert.equal(command,'api');assert.equal(args[0],'status');assert.equal(key,'projects.a');assert.deepEqual(input,{summaryOnly:true,changesOnly:true});return {ok:true,workspaceRoot,checkoutPath};}};
  t.mock.method(ToolProcessClient.prototype,'request',(...args)=>processClient.request(...args));
  activateApi({vscode,context:{subscriptions:[]},getTool:async()=>({toolPath:'/test/tool',toolHome:'/test/home'}),processClient});
  return {workspaceRoot,checkoutPath,filename,handlers,calls,errors,settings,vscode};
}
test('first use creates a project workspace with runtime settings and opens a new window',async t=>{
  const f=await fixture(t);await f.handlers.get('gushenCompletion.openApiCheckout')('projects.a');
  const doc=JSON.parse(await fs.readFile(f.filename,'utf8'));
  assert.deepEqual(doc.folders,[{path:f.checkoutPath}]);
  assert.deepEqual(doc.settings,Object.fromEntries(Object.entries(f.settings).map(([key,value])=>[`gushenCompletion.${key}`,value])));
  assert.deepEqual(f.calls,[['vscode.openFolder',{scheme:'file',fsPath:f.filename},{forceNewWindow:true}]]);assert.deepEqual(f.errors,[]);
});
test('existing JSONC workspace keeps user settings and focuses an already open checkout',async t=>{
  const f=await fixture(t);
  await fs.writeFile(f.filename,'{\n  // Keep this user note\n  "folders": [{"path": "old"}],\n  "settings": {"editor.fontSize": 17, "gushenCompletion.toolHome": "old",},\n  "extensions": {"recommendations": ["example.extension"]},\n}\n');
  await f.handlers.get('gushenCompletion.openApiCheckout')('projects.a');
  const text=await fs.readFile(f.filename,'utf8'),doc=parse(text);
  assert.match(text,/Keep this user note/);assert.equal(doc.settings['editor.fontSize'],17);
  assert.equal(doc.settings['gushenCompletion.toolHome'],f.settings.toolHome);assert.deepEqual(doc.extensions.recommendations,['example.extension']);assert.deepEqual(doc.folders,[{path:f.checkoutPath}]);
  f.calls.length=0;f.vscode.workspace.workspaceFolders=[{uri:{scheme:'file',fsPath:f.checkoutPath}}];
  await f.handlers.get('gushenCompletion.openApiCheckout')('projects.a');
  assert.deepEqual(f.calls,[['workbench.view.explorer']]);assert.equal(await fs.readFile(f.filename,'utf8'),text);assert.deepEqual(f.errors,[]);
});
test('a dirty project workspace description is never overwritten',async t=>{
  const f=await fixture(t),text='{"settings":{"editor.fontSize":17}}';await fs.writeFile(f.filename,text);
  f.vscode.workspace.textDocuments=[{uri:{scheme:'file',fsPath:f.filename},isDirty:true}];
  await f.handlers.get('gushenCompletion.openApiCheckout')('projects.a');
  assert.match(f.errors[0],/未保存/);assert.deepEqual(f.calls,[]);assert.equal(await fs.readFile(f.filename,'utf8'),text);
});

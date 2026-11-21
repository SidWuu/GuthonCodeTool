const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {ToolProcessClient}=require('../src/tool-process-client');
const {activateApi}=require('../src/api/activate');

const repo=path.resolve(__dirname,'../../../..'),python=path.join(repo,'.venv/bin/python'),scripts=path.join(repo,'scripts');

test('ToolHost registers all providers and changes only the targeted unused project', {skip:!fs.existsSync(python) && 'repository Python environment unavailable'}, async t=>{
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nexus-mode-toolhost-')));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const toolEntry=path.join(scripts,'guthon_tool.py');
  const setup=spawnSync(python,[toolEntry,'setup','--home',home],{encoding:'utf8'});
  assert.equal(setup.status,0,setup.stderr);
  const tool={mode:'source-development',toolPath:python,toolEntry,toolHome:home};
  const client=new ToolProcessClient();
  try {
    const config=await client.request(tool,'configuration-info');
    assert.deepEqual(config.workspaceSourceModes,['api','svn','database']);
    for (const sourceMode of config.workspaceSourceModes) {
      const result=await client.request(tool,'workspace-create',[],'',{id:sourceMode,name:sourceMode,sourceMode});
      assert.equal(result.workspace.sourceMode,sourceMode);
      assert.equal(result.workspace.root,path.join(home,'var','workspace',sourceMode));
    }
    const api=(input)=>client.request(tool,'api',['editor-state','--stdin'],'api',input);
    const draft=await api({pid:process.pid,documents:[{path:'draft.gss',dirty:true}]});
    const change=(expectedMode,sourceMode)=>client.request(tool,'workspace-source-mode',[],'',{workspaceKey:'api',expectedMode,sourceMode});
    await assert.rejects(change('api','svn'),{code:'API_EDITOR_DIRTY'});
    await api({pid:process.pid,editorToken:draft.editorToken,documents:[]});
    for (const [expectedMode,sourceMode] of [['api','svn'],['svn','database'],['database','api']]) {
      assert.deepEqual(await change(expectedMode,sourceMode),{ok:true,changed:true,workspaceKey:'api',sourceMode});
      const registry=await client.request(tool,'workspaces');
      assert.deepEqual(Object.fromEntries(registry.workspaces.map(w=>[w.workspaceKey,w.sourceMode])),{
        api:sourceMode,svn:'svn',database:'database',
      });
    }
    await assert.rejects(change('svn','api'),{code:'WORKSPACE_SOURCE_MODE_STALE'});
    await api({pid:process.pid,editorToken:draft.editorToken,documents:[],close:true});
    fs.writeFileSync(path.join(home,'var','workspace','api','checkout','source.gss'),'existing source');
    await assert.rejects(change('api','svn'),{code:'WORKSPACE_MODE_MIGRATION_REQUIRED'});
  } finally {await client.stop();client.dispose();}
});

const bootstrap=String.raw`
import json,os,sys
from pathlib import Path
home=Path(sys.argv[1]);os.environ['GUTHON_HOME']=str(home)
import guthon_tool
from common.workspace_config import create_workspace
from common import gusen_hub
from providers.api import workspace,index
from providers.api.store import ApiStore
from providers.api.download import source_file
guthon_tool.setup_config(home)
create_workspace(home,{'id':'MixedCase','name':'Synthetic'},gusen_hub)
w=gusen_hub.resolve_workspace(gusen_hub.load_config(),'MixedCase')
workspace.configure(w,{'serverUrl':'https://example.invalid','systemIds':['S'],'dataSourceIds':['D']})
workspace.save_project(w,[{'systemId':'S','systemName':'系统甲','dataSourceId':'D'}],[{'dataSourceId':'D','dataSourceName':'数据源甲'}],menu_tree=[{'systemId':'S','menus':[{'id':'M','name':'菜单甲','isDir':0,'pages':[{'pageId':'PG-SYNTH','pageSubId':'main'}]}]}])
page='systems/S/pages/main/PG-SYNTH/page.xml';proc='datasources/D/procedures/demo/save.gss'
xml='<page><pageId>PG-SYNTH</pageId><pageType>3</pageType><views><rows><row><guid>R1</guid><component><id>C1</id><guid>G1</guid><name>form</name><type>input-box</type><fields><field><fieldId>A</fieldId><id>I1</id><type>text</type><label>A</label><pageEvents><onChangeScript><![CDATA[old();]]></onChangeScript></pageEvents></field></fields></component></row></rows></views></page>'
files=[source_file(page,xml,'page',{'systemId':'S','pageId':'PG-SYNTH','pageSubId':'main','pageType':3,'fileName':'page.xml','pageName':'页面甲'}),source_file(proc,'return 1;\n','procedure',{'dataSourceId':'D','subPath':'demo','procedureId':'P','funId':'save','funName':'保存'})]
if len(sys.argv)>2 and sys.argv[2]=='placeholders':
 files.extend([source_file('systems/S/pages/main/PG-MIN/PG-MIN.xml','<page><isProduct>0</isProduct></page>','page',{'systemId':'S','pageId':'PG-MIN','pageSubId':'main','pageType':1,'fileName':'PG-MIN.xml'}),source_file('datasources/D/views/V1.xml','<view><viewName>视图</viewName><viewId>V1</viewId><fields/></view>','view',{'dataSourceId':'D','viewId':'V1'}),source_file('datasources/D/views/V2.xml','<view><viewName>视图</viewName><viewId>V2</viewId><viewSql/><fields/></view>','view',{'dataSourceId':'D','viewId':'V2'}),source_file('systems/S/pages/main/PG-BAD/PG-BAD.xml','<page><pageId>OTHER</pageId><pageType>3</pageType></page>','page',{'systemId':'S','pageId':'PG-BAD','pageSubId':'main','pageType':3,'fileName':'PG-BAD.xml'})])
ApiStore(w).publish(files);index.rebuild(w)
print(json.dumps({'root':str(w['providerSourceRoot']),'page':page,'proc':proc}))
`;

test('CodeBuddy-style normalized URIs open tree items and PAGE fragments through real ToolHost', {skip:!fs.existsSync(python) && 'repository Python environment unavailable'},async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-toolhost-ui-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const setup=spawnSync(python,['-c',bootstrap,home],{encoding:'utf8',env:{...process.env,PYTHONPATH:scripts}});
  assert.equal(setup.status,0,setup.stderr);const info=JSON.parse(setup.stdout),key='MixedCase';
  const tool={mode:'source-development',toolPath:python,toolEntry:path.join(scripts,'guthon_tool.py'),toolHome:home,env:{PYTHONPATH:scripts}};
  const processClient=new ToolProcessClient(),originalRequest=processClient.request.bind(processClient),actions=[];
  processClient.request=(tool,command,args,...rest)=>{actions.push(args[0]);return originalRequest(tool,command,args,...rest);};
  const commands=new Map(),documents=[],editors=[],panels=[],errors=[];let provider;
  const disposable={dispose(){}};class Emitter{constructor(){this.event=()=>disposable;}fire(){}dispose(){}}
  const uri=o=>({...o,authority:(o.authority || '').toLowerCase(),toString(){return JSON.stringify({scheme:this.scheme,authority:this.authority,path:this.path,query:this.query});}});
  const vscode={EventEmitter:Emitter,FileType:{File:1},FilePermission:{Readonly:1},ViewColumn:{Active:1,Beside:2},
    FileSystemError:{FileNotFound:()=>Error('missing'),NoPermissions:()=>Error('readonly')},Uri:{from:uri,file:fsPath=>({scheme:'file',fsPath,toString(){return fsPath;}})},
    TreeItem:class{constructor(label,collapsibleState){Object.assign(this,{label,collapsibleState});}},TreeItemCollapsibleState:{Collapsed:1,None:0},
    commands:{registerCommand:(name,handler)=>(commands.set(name,handler),disposable)},
    workspace:{textDocuments:documents,onDidChangeTextDocument:()=>disposable,onDidSaveTextDocument:()=>disposable,onDidCloseTextDocument:()=>disposable,
      registerFileSystemProvider:(_scheme,p)=>(provider=p,disposable),
      openTextDocument:async u=>{const text=u.scheme==='file'?fs.readFileSync(u.fsPath,'utf8'):(await provider.readFile(u)).toString();const doc={uri:u,isDirty:false,version:1,getText:()=>text};documents.push(doc);return doc;}},
    window:{showTextDocument:async document=>{const editor={document};editors.push(editor);return editor;},showErrorMessage:async message=>errors.push(message),
      createWebviewPanel:()=>{const p={webview:{cspSource:'test',asWebviewUri:u=>u,postMessage:async()=>{},onDidReceiveMessage:()=>disposable},onDidDispose:()=>disposable,reveal(){},dispose(){}};panels.push(p);return p;}}};
  const state=new Map(),context={subscriptions:[],extensionPath:path.resolve(__dirname,'..'),globalStorageUri:{fsPath:home},workspaceState:{get:k=>state.get(k),update:async(k,v)=>state.set(k,v)}};
  const api=activateApi({vscode,context,getTool:async()=>tool,processClient});
  try {
    api.sourceTree.syncWorkspaces([{workspaceKey:key,checkoutPath:info.root,sourceMode:'api'}]);
    const tree=await api.sourceTree.getChildren();
    const find=(nodes,p)=>{for(const n of nodes){if(n.object?.path===p)return n;if(Array.isArray(n.children)){const found=find(n.children,p);if(found)return found;}}};
    const procedure=find(tree,info.proc),page=find(tree,info.page);assert.ok(procedure);assert.ok(page);
    const procedureCommand=api.sourceTree.getTreeItem(procedure).command;
    await commands.get(procedureCommand.command)(...procedureCommand.arguments);assert.equal(editors[0].document.uri.fsPath,path.join(info.root,info.proc));
    const pageCommand=api.sourceTree.getTreeItem(page).command;
    await commands.get(pageCommand.command)(...pageCommand.arguments);assert.equal(panels.length,1);
    const fragments=await api.sourceTree.getChildren(page),fragment=fragments.find(x=>x.target?.fragmentType==='js');assert.ok(fragment);
    const fragmentCommand=api.sourceTree.getTreeItem(fragment).command,opened=await commands.get(fragmentCommand.command)(...fragmentCommand.arguments);
    assert.equal(opened.authority,'mixedcase');assert.equal(new URLSearchParams(opened.query).get('workspaceKey'),key);
    assert.match(editors.at(-1).document.getText(),/old\(\)/);assert.equal(actions.includes('status'),false);assert.deepEqual(errors,[]);
  } finally {await api.dispose();await processClient.stop();processClient.dispose();}
});

test('metadata-only projections open read-only while explicit original source respects the store through real ToolHost', {skip:!fs.existsSync(python) && 'repository Python environment unavailable'},async t=>{
  const {ToolJsonClient}=require('../src/tool-json-client'),{ApiSourceUI}=require('../src/api/source-ui');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-placeholder-ui-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const setup=spawnSync(python,['-c',bootstrap,home,'placeholders'],{encoding:'utf8',env:{...process.env,PYTHONPATH:scripts}});assert.equal(setup.status,0,setup.stderr);
  const info=JSON.parse(setup.stdout),key='MixedCase',tool={mode:'source-development',toolPath:python,toolEntry:path.join(scripts,'guthon_tool.py'),toolHome:home,env:{PYTHONPATH:scripts}};
  const processClient=new ToolProcessClient(),client=new ToolJsonClient({getTool:async()=>tool,processClient}),calls=[];
  const run=async(k,action,input)=>{calls.push(action);return client.run(k,'api',[action,'--stdin'],input || {});};
  const opened=[],vscode={workspace:{textDocuments:[],openTextDocument:async uri=>({uri})},Uri:{file:fsPath=>({scheme:'file',fsPath}),from:o=>({...o,authority:o.authority.toLowerCase(),toString(){return JSON.stringify(this);}})},
    window:{showTextDocument:async doc=>(opened.push(doc.uri),{document:doc})}};
  const ui=new ApiSourceUI({vscode,run,onOpenVirtual:()=>assert.fail('placeholder must not open a virtual SQL editor')});
  const paths=['systems/S/pages/main/PG-MIN/PG-MIN.xml','datasources/D/views/V1.xml','systems/S/pages/main/PG-BAD/PG-BAD.xml'];
  const original=paths.map(p=>fs.readFileSync(path.join(info.root,p),'utf8'));
  try {
    ui.syncWorkspaces([{workspaceKey:key,checkoutPath:info.root}]);
    for(let i=0;i<paths.length;i++) {
      const read=await run(key,'read',{path:paths[i]});assert.equal(read.readonly,i===2);assert.equal(read.storeReadonly,false);assert.equal(read.projectionReadonly,true);assert.equal(read.contentState,['METADATA_ONLY','SQL_ABSENT','IDENTITY_MISMATCH'][i]);
      await ui.open(key,paths[i]);assert.equal(opened[i].scheme,'guthon-api-readonly');assert.equal(ui.provideTextDocumentContent(opened[i]),original[i]);
    }
    for(let i=0;i<paths.length;i++) {
      await ui.open(key,paths[i],false,{raw:true});const uri=opened[paths.length+i];
      if(i<2) {assert.equal(uri.scheme,'file');assert.equal(uri.fsPath,path.join(info.root,paths[i]));}
      else {assert.equal(uri.scheme,'guthon-api-readonly');assert.equal(ui.provideTextDocumentContent(uri),original[i]);}
    }
    assert.deepEqual(paths.map(p=>fs.readFileSync(path.join(info.root,p),'utf8')),original);assert.equal(calls.includes('view'),false);assert.equal(calls.includes('write'),false);
    const empty=await run(key,'view',{action:'open',path:'datasources/D/views/V2.xml'});assert.equal(empty.content,'');assert.equal(empty.editable,true);await run(key,'view',{action:'close',editToken:empty.editToken});
    const candidates=[
      ['<page><pageId>OTHER</pageId><pageType>1</pageType><isProduct>0</isProduct></page>','<page><pageId>PG-MIN</pageId><pageType>1</pageType><isProduct>0</isProduct></page>'],
      ['<view><viewId>OTHER</viewId><viewSql>select 1</viewSql><fields/></view>','<view><viewName>视图</viewName><viewId>V1</viewId><viewSql>select 1</viewSql><fields/></view>']
    ];
    for(let i=0;i<candidates.length;i++) {
      const before=await run(key,'read',{path:paths[i]});
      await assert.rejects(run(key,'write',{path:paths[i],content:candidates[i][0],expectedHash:before.sourceHash}));
      assert.equal((await run(key,'read',{path:paths[i]})).content,original[i]);
      const result=await run(key,'write',{path:paths[i],content:candidates[i][1],expectedHash:before.sourceHash});
      const after=await run(key,'read',{path:paths[i]});assert.equal(after.content,candidates[i][1]);assert.equal(after.sourceHash,result.sourceHash);assert.equal(after.readonly,false);assert.notEqual(after.projectionReadonly,true);
    }
    const addedSql=await run(key,'view',{action:'open',path:paths[1]});assert.equal(addedSql.content,'select 1');assert.equal(addedSql.baseContentSQL,null);assert.equal(addedSql.editable,true);await run(key,'view',{action:'close',editToken:addedSql.editToken});
    const conflict=await run(key,'read',{path:paths[2]});await assert.rejects(run(key,'write',{path:paths[2],content:'<page><pageId>PG-BAD</pageId></page>',expectedHash:conflict.sourceHash}));
    assert.equal((await run(key,'read',{path:paths[2]})).content,original[2]);
  } finally {ui.dispose();await processClient.stop();processClient.dispose();}
});

test('menu cache retains official directory identities without copying unrelated response fields', {skip:!fs.existsSync(python) && 'repository Python environment unavailable'},t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-menu-cache-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const setup=spawnSync(python,['-c',bootstrap,home],{encoding:'utf8',env:{...process.env,PYTHONPATH:scripts}});assert.equal(setup.status,0,setup.stderr);
  const verify=String.raw`
import json,os,sys
from pathlib import Path
home=Path(sys.argv[1]);os.environ['GUTHON_HOME']=str(home)
from common import gusen_hub
from providers.api import cli,workspace
w=gusen_hub.resolve_workspace(gusen_hub.load_config(),'MixedCase')
p=w['contextDir']/'api'/'project.json';before=p.read_bytes()
class Client:
 def request(self,path):
  assert path.endswith('/getModuleTree.htm')
  return [{'systemId':'S','ignored':'private','menus':[{'id':'F','name':'一级','isDir':1,'childs':[{'id':'M','name':'菜单','isDir':0,'pages':[{'pageId':'PG-SYNTH','pageSubId':'main','checkOutUserId':'private'}]}]}]}]
cli.client_for=lambda *_args,**_kwargs:Client()
result=cli.execute(w,'system-menu',{})
catalog=cli.execute(w,'catalog',{'limit':100,'offset':0})
print(json.dumps({'sameProject':before==p.read_bytes(),'responsePreserved':result['menu'][0]['ignored']=='private','catalog':catalog['project']['menuTree']},ensure_ascii=False))
`;
  const result=spawnSync(python,['-c',verify,home],{encoding:'utf8',env:{...process.env,PYTHONPATH:scripts}});assert.equal(result.status,0,result.stderr);
  const parsed=JSON.parse(result.stdout);assert.equal(parsed.sameProject,true);assert.equal(parsed.responsePreserved,true);
  assert.deepEqual(parsed.catalog,[{systemId:'S',menus:[{id:'F',name:'一级',isDir:1,childs:[{id:'M',name:'菜单',isDir:0,pages:[{pageId:'PG-SYNTH',pageSubId:'main'}]}]}]}]);
});

test('real ToolHost indexes a clean source edit and missing registered file without status scans', {skip:!fs.existsSync(python) && 'repository Python environment unavailable'},async t=>{
  const {ToolJsonClient}=require('../src/tool-json-client'),{ApiSourceWatcher}=require('../src/api/source-watcher');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-watcher-toolhost-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const setup=spawnSync(python,['-c',bootstrap,home],{encoding:'utf8',env:{...process.env,PYTHONPATH:scripts}});assert.equal(setup.status,0,setup.stderr);
  const info=JSON.parse(setup.stdout),key='MixedCase',tool={mode:'source-development',toolPath:python,toolEntry:path.join(scripts,'guthon_tool.py'),toolHome:home,env:{PYTHONPATH:scripts}};
  const processClient=new ToolProcessClient(),client=new ToolJsonClient({getTool:async()=>tool,processClient}),calls=[],checks=[],changes=[];
  const run=async(k,action,input)=>{calls.push(action);const result=await client.run(k,'api',[action,'--stdin'],input || {});if(input?.checkOnly)checks.push(result);return result;};
  const watcher=new ApiSourceWatcher({run,delay:10000,onChanged:async(_key,paths,result)=>changes.push({paths,result}),onError:(_key,error)=>{throw error;}});
  try {
    watcher.register(key,info.root);fs.writeFileSync(path.join(info.root,info.proc),'uniqueWatcherNeedle();\n');
    watcher.enqueue(key,info.proc);watcher.enqueue(key,'config/sync.yaml');watcher.enqueue(key,'datasources/D/procedures/unregistered.gss');await watcher.flush(key);
    assert.deepEqual(changes[0].paths,[info.proc]);assert.equal(checks[0].ignoredCount,1);assert.equal(calls.includes('status'),false);
    const found=await run(key,'search',{query:'uniqueWatcherNeedle',limit:20});assert.ok(found.hits.some(hit=>hit.path===info.proc));
    watcher.enqueue(key,info.proc);await watcher.flush(key);assert.equal(changes.length,1);
    fs.unlinkSync(path.join(info.root,info.proc));watcher.enqueue(key,info.proc);await watcher.flush(key);
    assert.deepEqual(changes[1].paths,[info.proc]);assert.deepEqual(watcher.recovery(key).paths,[]);
  } finally {await watcher.close();await processClient.stop();processClient.dispose();}
});

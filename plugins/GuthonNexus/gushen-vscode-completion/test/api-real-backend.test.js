const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {ApiPageVirtualFs,uriFor}=require('../src/source/virtual-fs');
const {ApiEditorState}=require('../src/api/editor-state');

const repo=path.resolve(__dirname,'../../../..');
const python=path.join(repo,'.venv','bin','python');
const pythonAvailable=fs.existsSync(python);
const scripts=path.join(repo,'scripts');
const XML=`<?xml version="1.0" encoding="UTF-8"?>
<page><pageId>PG-SYNTH</pageId><pageType>3</pageType><views><rows><row><guid>ROW1</guid><isProduct>0</isProduct><component><id>COMP1</id><guid>CG1</guid><name>form</name><type>input-box</type><isProduct>0</isProduct><params><attrs k="name"><v type="String">form</v></attrs></params><fields>
<!-- keep --><field><fieldId>A</fieldId><id>ID1</id><type>text</type><label>旧&amp;名</label><width>1</width><isProduct>0</isProduct><unknown meta="X"><nested>opaque</nested></unknown><pageEvents><onChangeScript r="1"><![CDATA[old();\n]]></onChangeScript></pageEvents></field>
<field><fieldId>B</fieldId><id>ID2</id><type>text</type><label>B</label><width>2</width><isProduct>0</isProduct><pageEvents/></field>
</fields><buttons/></component></row></rows></views></page>`;
const bootstrap=String.raw`
import json, os, sys
from pathlib import Path
home=Path(sys.argv[1]); os.environ['GUTHON_HOME']=str(home)
import guthon_tool
from common.workspace_config import create_workspace
from common import gusen_hub
from providers.api import workspace, index
from providers.api.store import ApiStore
from providers.api.download import source_file
obj=json.load(sys.stdin)
guthon_tool.setup_config(home)
create_workspace(home,{'kind':'project','id':'api-fixture','name':'API fixture'},gusen_hub)
w=gusen_hub.resolve_workspace(gusen_hub.load_config(),'projects.api-fixture')
workspace.configure(w,{'serverUrl':'https://fixture.invalid','systemIds':['A'],'dataSourceIds':['DS']})
workspace.save_project(w,[{'systemId':'A','dataSourceId':'DS'}],[{'dataSourceId':'DS'}])
page_meta={'systemId':'A','pageId':'PG-SYNTH','pageSubId':'main','pageType':3,'fileName':'page.xml'}
proc_meta={'dataSourceId':'DS','subPath':'pkg','procedureId':'P','funId':'save'}
json_fields_meta={'systemId':'A','pageId':'PG-J','pageSubId':'main','pageType':1,'fileName':'fields.json'}
json_meta={'systemId':'A','pageId':'PG-INH','pageSubId':'main','pageType':1,'fileName':'inherit.json'}
svc_meta={'systemId':'A','pageId':'PG-SVC','pageSubId':'main','pageType':0,'fileName':'service.gss','superFileName':'service.inherit.gss'}
files=[source_file(obj['pagePath'],obj['xml'],'page',page_meta),
 source_file(obj['jsonFieldsPath'],json.dumps({'pageId':'PG-J','opaque':{'keep':'yes'},'views':[{'id':'V','type':'input-box','fields':[{'fieldId':'A','type':'text','label':'old'}]}]},ensure_ascii=False),'page',json_fields_meta),
 source_file(obj['jsonPagePath'],json.dumps({'pageId':'PG-INH','pageEvents':{'onOpenScript':'before();\ninherit();\nafter();'},'superPageEvents':{'onOpenScript':'parent();\n'}}),'page',json_meta),
 source_file(obj['procPath'],obj['project'],'procedure',proc_meta),
 source_file(obj['parentPath'],obj['parent'],'procedure-inherit',proc_meta,True),
 source_file(obj['servicePath'],obj['project'],'page',svc_meta),
 source_file(obj['serviceParentPath'],obj['parent'],'page-inherit',svc_meta,True)]
if obj.get('viewPath'):
 files.append(source_file(obj['viewPath'],obj['viewXml'],'view',{'dataSourceId':'DS','viewId':'V_SYNTH'}))
ApiStore(w).publish(files); index.rebuild(w)
print(json.dumps({'checkoutPath':str(w['providerSourceRoot'])}))
`;
const invoke=String.raw`
import json, os, sys
from pathlib import Path
home=Path(sys.argv[1]); os.environ['GUTHON_HOME']=str(home)
from common import gusen_hub
from providers.api.cli import execute
w=gusen_hub.resolve_workspace(gusen_hub.load_config(),'projects.api-fixture')
try:
 value=execute(w,sys.argv[2],json.load(sys.stdin))
 print(json.dumps({'ok':True,**value},ensure_ascii=False))
except Exception as exc:
 print(json.dumps({'ok':False,'message':str(exc),'code':getattr(exc,'code','')},ensure_ascii=False))
`;
function fixture(t,options={}) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'guthon-node-api-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const pagePath='systems/A/pages/main/PG-SYNTH/page.xml',procPath='datasources/DS/procedures/pkg/save.gss',parentPath='datasources/DS/procedures/pkg/save.inherit.gss',servicePath='systems/A/pages/main/PG-SVC/service.gss',serviceParentPath='systems/A/pages/main/PG-SVC/service.inherit.gss',jsonPagePath='systems/A/pages/main/PG-INH/inherit.json',jsonFieldsPath='systems/A/pages/main/PG-J/fields.json';
  const project=options.project || 'before();\ninherit();\nafter();',parent='parent();\n';
  function process(script,args,input){const result=spawnSync(python,['-c',script,home,...args],{input:JSON.stringify(input),encoding:'utf8',env:{...process.env,PYTHONPATH:scripts},maxBuffer:8*1024*1024});
    if(result.status!==0) throw new Error(result.stderr || `Python exited ${result.status}`);
    const data=JSON.parse(result.stdout);if(data.ok===false){const error=new Error(data.message);error.code=data.code;throw error;}return data;}
  const viewPath=options.includeView?'datasources/DS/views/V_SYNTH.xml':undefined;
  const viewXml='<?xml version="1.0" encoding="UTF-8"?><view><viewId>V_SYNTH</viewId><!-- keep --><viewSql><![CDATA[select 1\n]]></viewSql><other value="keep"/></view>';
  const setup=process(bootstrap,[],{pagePath,procPath,parentPath,servicePath,serviceParentPath,jsonPagePath,jsonFieldsPath,project,parent,xml:XML,viewPath,viewXml});
  const calls=[];const run=async(_key,action,input)=>{calls.push({action,input});return process(invoke,[action],input || {});};
  const docs=[];class Emitter{constructor(){this.event=()=>{};}fire(){}dispose(){}}
  const vscode={EventEmitter:Emitter,workspace:{textDocuments:docs},window:{showWarningMessage:async()=> '已核对，继续保存',showErrorMessage:async()=>{}},
    Uri:{from:o=>({...o,toString(){return JSON.stringify(o);}})},FileType:{File:1},FilePermission:{Readonly:1},FileSystemError:{FileNotFound:()=>Error('missing'),NoPermissions:()=>Error('readonly')}};
  const editorState=new ApiEditorState({vscode,run});
  const virtualFs=new ApiPageVirtualFs({vscode,run,editorState});
  return {home,pagePath,procPath,parentPath,servicePath,serviceParentPath,jsonPagePath,jsonFieldsPath,viewPath,viewXml,project,parent,checkoutPath:setup.checkoutPath,run,calls,docs,vscode,editorState,virtualFs};
}
test('native XML view SQL editor saves through real backend and retains SQL baseline', {skip:!pythonAvailable && 'repository Python environment unavailable'},async t=>{
  const {ApiQuickDiff}=require('../src/source/quick-diff'),f=fixture(t,{includeView:true}),key='projects.api-fixture';await f.editorState.add(key,f.checkoutPath);
  const uri=uriFor(f.vscode,{workspaceKey:key,sourceType:'view',sourcePath:f.viewPath,jsonPointer:'/viewSql',fragmentType:'sql'});
  f.docs.push({uri,isDirty:true,version:1});await f.editorState.flush(key);
  assert.equal((await f.virtualFs.readFile(uri)).toString(),'select 1\n');await f.virtualFs.writeFile(uri,Buffer.from('select 2\n'));
  const after=await f.run(key,'read',{path:f.viewPath});assert.match(after.content,/<!-- keep -->/);assert.match(after.content,/<other value="keep"\/>/);assert.match(after.content,/select 2/);
  const diff=new ApiQuickDiff({vscode:f.vscode,run:f.run,editorState:f.editorState,ui:{scmGenerations:new Map()},viewBase:(uri,result)=>f.virtualFs.viewBase(uri,result)}),original=await diff.provideOriginalResource(uri);
  assert.ok(original);assert.equal(diff.provideTextDocumentContent(original),'select 1\n');
  diff.dispose();f.virtualFs.dispose();await new Promise(resolve=>setImmediate(resolve));await f.editorState.close();
});
test('native XML fields editor uses real fragment and collection save without changing unrelated XML', {skip:!pythonAvailable && 'repository Python environment unavailable'},async t=>{
  const f=fixture(t),key='projects.api-fixture';await f.editorState.add(key,f.checkoutPath);
  const uri=uriFor(f.vscode,{workspaceKey:key,sourceType:'page',sourcePath:f.pagePath,jsonPointer:'/views/rows/0/component/fields',fragmentType:'fields'});
  f.docs.push({uri,isDirty:true,version:1});await f.editorState.flush(key);const original=JSON.parse((await f.virtualFs.readFile(uri)).toString());original[0].label='新<&';
  const before=await f.run(key,'read',{path:f.pagePath});
  await assert.rejects(f.run(key,'write',{path:f.pagePath,content:before.content,expectedHash:before.sourceHash}),/未保存/);
  await f.virtualFs.writeFile(uri,Buffer.from(JSON.stringify(original,null,2)));
  const after=await f.run(key,'read',{path:f.pagePath});assert.match(after.content,/<label>新&lt;&amp;<\/label>/);
  assert.match(after.content,/<!-- keep -->/);assert.match(after.content,/<unknown meta="X"><nested>opaque<\/nested><\/unknown>/);
  const readback=await f.run(key,'page',{action:'fragment',path:f.pagePath,jsonPointer:'/views/rows/0/component/fields'});
  assert.equal(JSON.parse(readback.content)[0].label,'新<&');const save=f.calls.find(x=>x.action==='page'&&x.input.action==='save');assert.equal(save.input.operations[0].kind,'collection');assert.equal(typeof save.input.editorToken,'string');await f.editorState.close();f.virtualFs.dispose();
});
test('project inherited procedure writes real backend receipts and never modifies readonly parent', {skip:!pythonAvailable && 'repository Python environment unavailable'},async t=>{
  const f=fixture(t),key='projects.api-fixture';await f.editorState.add(key,f.checkoutPath);
  const uri=uriFor(f.vscode,{workspaceKey:key,sourceType:'procedure',sourcePath:f.procPath,fragmentType:'gss'});f.docs.push({uri,isDirty:true,version:1});
  const expanded=(await f.virtualFs.readFile(uri)).toString();assert.match(expanded,/parent\(\)/);assert.doesNotMatch(expanded,/inherit\(\)/);
  await f.virtualFs.writeFile(uri,Buffer.from(expanded.replace('before();','changed();')));
  const saved=await f.run(key,'read',{path:f.procPath}),parent=await f.run(key,'read',{path:f.parentPath});
  assert.match(saved.content,/inherit\(\)/);assert.match(saved.content,/changed\(\)/);assert.equal(parent.content,f.parent);assert.equal(parent.readonly,true);
  await f.virtualFs.writeFile(uri,Buffer.from(expanded.replace('before();','changed();').replace('parent();','custom();')));
  const materialized=await f.run(key,'read',{path:f.procPath});assert.match(materialized.content,/custom\(\)/);assert.doesNotMatch(materialized.content,/inherit\(\)/);
  assert.equal((await f.run(key,'read',{path:f.parentPath})).content,f.parent);const writes=f.calls.filter(x=>x.action==='inherited-write');assert.equal(writes.length,2);assert.ok(writes.every(x=>x.input.idempotencyKey.startsWith('procedure-code-') && x.input.parentHash && x.input.editorToken));await f.editorState.close();f.virtualFs.dispose();
});

test('changed readonly parent rejects stale project save without overwriting either file', {skip:!pythonAvailable && 'repository Python environment unavailable'},async t=>{
  const f=fixture(t),key='projects.api-fixture';await f.editorState.add(key,f.checkoutPath);
  const uri=uriFor(f.vscode,{workspaceKey:key,sourceType:'procedure',sourcePath:f.procPath,fragmentType:'gss'});f.docs.push({uri,isDirty:true,version:1});await f.editorState.flush(key);
  const expanded=(await f.virtualFs.readFile(uri)).toString(),parentFile=path.join(f.checkoutPath,f.parentPath);
  fs.chmodSync(parentFile,0o600);fs.writeFileSync(parentFile,'new-parent();\n');fs.chmodSync(parentFile,0o400);
  await assert.rejects(f.virtualFs.writeFile(uri,Buffer.from(expanded.replace('before();','changed();'))),error=>error.code==='API_INHERITANCE_STALE');
  assert.equal((await f.run(key,'read',{path:f.procPath})).content,f.project);assert.equal((await f.run(key,'read',{path:f.parentPath})).content,'new-parent();\n');
  await f.editorState.close();f.virtualFs.dispose();
});
test('another live editor registration blocks real inherited project writes', {skip:!pythonAvailable && 'repository Python environment unavailable'},async t=>{
  const f=fixture(t),key='projects.api-fixture';await f.editorState.add(key,f.checkoutPath);
  const uri=uriFor(f.vscode,{workspaceKey:key,sourceType:'procedure',sourcePath:f.procPath,fragmentType:'gss'});f.docs.push({uri,isDirty:true,version:1});await f.editorState.flush(key);
  const expanded=(await f.virtualFs.readFile(uri)).toString();const other=await f.run(key,'editor-state',{pid:process.pid,documents:[{path:f.procPath,dirty:true,version:7}]});
  try {await assert.rejects(f.virtualFs.writeFile(uri,Buffer.from(expanded.replace('before();','changed();'))),error=>error.code==='API_EDITOR_DIRTY');
    assert.equal((await f.run(key,'read',{path:f.procPath})).content,f.project);
  } finally {await f.run(key,'editor-state',{pid:process.pid,documents:[],editorToken:other.editorToken,close:true});await f.editorState.close();f.virtualFs.dispose();}
});

test('service GSS inherits and saves only the project file through the real backend', {skip:!pythonAvailable && 'repository Python environment unavailable'},async t=>{
  const f=fixture(t),key='projects.api-fixture';await f.editorState.add(key,f.checkoutPath);
  const uri=uriFor(f.vscode,{workspaceKey:key,sourceType:'page',sourcePath:f.servicePath,fragmentType:'gss'});f.docs.push({uri,isDirty:true,version:1});
  const expanded=(await f.virtualFs.readFile(uri)).toString();assert.match(expanded,/parent\(\)/);
  await f.virtualFs.writeFile(uri,Buffer.from(expanded.replace('after();','serviceChange();')));
  const saved=await f.run(key,'read',{path:f.servicePath});assert.match(saved.content,/inherit\(\)/);assert.match(saved.content,/serviceChange/);
  assert.equal((await f.run(key,'read',{path:f.serviceParentPath})).content,f.parent);await f.editorState.close();f.virtualFs.dispose();
});
test('invalid field collection is rejected before changing native PAGE XML', {skip:!pythonAvailable && 'repository Python environment unavailable'},async t=>{
  const f=fixture(t),key='projects.api-fixture';await f.editorState.add(key,f.checkoutPath);
  const uri=uriFor(f.vscode,{workspaceKey:key,sourceType:'page',sourcePath:f.pagePath,jsonPointer:'/views/rows/0/component/fields',fragmentType:'fields'});
  f.docs.push({uri,isDirty:true,version:1});await f.virtualFs.readFile(uri);const before=await f.run(key,'read',{path:f.pagePath});
  await assert.rejects(f.virtualFs.writeFile(uri,Buffer.from('{"not":"a list"}')),/JSON 数组/);
  assert.equal((await f.run(key,'read',{path:f.pagePath})).content,before.content);await f.editorState.close();f.virtualFs.dispose();
});

test('two consecutive inherited PAGE saves refresh the same-file parent hash', {skip:!pythonAvailable && 'repository Python environment unavailable'},async t=>{
  const f=fixture(t),key='projects.api-fixture';await f.editorState.add(key,f.checkoutPath);
  const uri=uriFor(f.vscode,{workspaceKey:key,sourceType:'page',sourcePath:f.jsonPagePath,jsonPointer:'/pageEvents/onOpenScript',fragmentType:'js'});f.docs.push({uri,isDirty:true,version:1});
  const expanded=(await f.virtualFs.readFile(uri)).toString();const first=expanded.replace('before();','one();');await f.virtualFs.writeFile(uri,Buffer.from(first));
  await f.virtualFs.writeFile(uri,Buffer.from(first.replace('after();','two();')));
  const page=JSON.parse((await f.run(key,'read',{path:f.jsonPagePath})).content);
  assert.match(page.pageEvents.onOpenScript,/one\(\)/);assert.match(page.pageEvents.onOpenScript,/two\(\)/);assert.match(page.pageEvents.onOpenScript,/inherit\(\)/);
  assert.equal(page.superPageEvents.onOpenScript,'parent();\n');await f.editorState.close();f.virtualFs.dispose();
});

test('identical parent text elsewhere does not accidentally materialize inherit()', {skip:!pythonAvailable && 'repository Python environment unavailable'},async t=>{
  const project='parent();\ninherit();\nafter();',f=fixture(t,{project}),key='projects.api-fixture';await f.editorState.add(key,f.checkoutPath);
  const uri=uriFor(f.vscode,{workspaceKey:key,sourceType:'procedure',sourcePath:f.procPath,fragmentType:'gss'});f.docs.push({uri,isDirty:true,version:1});
  const expanded=(await f.virtualFs.readFile(uri)).toString();await f.virtualFs.writeFile(uri,Buffer.from(expanded.replace('after();','changed();')));
  const current=(await f.run(key,'read',{path:f.procPath})).content;assert.match(current,/inherit\(\)/);assert.match(current,/changed/);
  assert.equal(f.calls.find(x=>x.action==='inherited-write').input.materialized,false);await f.editorState.close();f.virtualFs.dispose();
});
test('a dirty local parent buffer prevents inherited project save', {skip:!pythonAvailable && 'repository Python environment unavailable'},async t=>{
  const f=fixture(t),key='projects.api-fixture';await f.editorState.add(key,f.checkoutPath);
  const uri=uriFor(f.vscode,{workspaceKey:key,sourceType:'procedure',sourcePath:f.procPath,fragmentType:'gss'});f.docs.push({uri,isDirty:true,version:1});
  const expanded=(await f.virtualFs.readFile(uri)).toString();const parentFile=path.join(f.checkoutPath,f.parentPath);
  f.docs.push({uri:{scheme:'file',fsPath:parentFile,toString:()=>parentFile},isDirty:true,version:2});
  await assert.rejects(f.virtualFs.writeFile(uri,Buffer.from(expanded.replace('after();','changed();'))),/未保存输入/);
  assert.equal(f.calls.some(x=>x.action==='inherited-write'),false);assert.equal((await f.run(key,'read',{path:f.procPath})).content,f.project);
  await f.editorState.close();f.virtualFs.dispose();
});
test('another live editor dirtying the readonly parent blocks project materialization', {skip:!pythonAvailable && 'repository Python environment unavailable'},async t=>{
  const f=fixture(t),key='projects.api-fixture';await f.editorState.add(key,f.checkoutPath);
  const uri=uriFor(f.vscode,{workspaceKey:key,sourceType:'procedure',sourcePath:f.procPath,fragmentType:'gss'});f.docs.push({uri,isDirty:true,version:1});await f.editorState.flush(key);
  const expanded=(await f.virtualFs.readFile(uri)).toString();const other=await f.run(key,'editor-state',{pid:process.pid,documents:[{path:f.parentPath,dirty:true,version:3}]});
  try {
    f.virtualFs.trackDocumentChange({document:{uri},contentChanges:[{rangeOffset:expanded.indexOf('parent();'),rangeLength:'parent();'.length,text:'changed-parent();'}]});
    await assert.rejects(f.virtualFs.writeFile(uri,Buffer.from(expanded.replace('parent();','changed-parent();'))),error=>error.code==='API_EDITOR_DIRTY');
    assert.equal((await f.run(key,'read',{path:f.procPath})).content,f.project);
  } finally {await f.run(key,'editor-state',{pid:process.pid,documents:[],editorToken:other.editorToken,close:true});await f.editorState.close();f.virtualFs.dispose();}
});

test('JSON PAGE fields editor saves a collection through the real backend', {skip:!pythonAvailable && 'repository Python environment unavailable'},async t=>{
  const f=fixture(t),key='projects.api-fixture';await f.editorState.add(key,f.checkoutPath);
  const uri=uriFor(f.vscode,{workspaceKey:key,sourceType:'page',sourcePath:f.jsonFieldsPath,jsonPointer:'/views/0/fields',fragmentType:'fields'});
  f.docs.push({uri,isDirty:true,version:1});const fields=JSON.parse((await f.virtualFs.readFile(uri)).toString());fields[0].label='新标题';
  await f.virtualFs.writeFile(uri,Buffer.from(JSON.stringify(fields,null,2)));
  const page=JSON.parse((await f.run(key,'read',{path:f.jsonFieldsPath})).content);assert.equal(page.views[0].fields[0].label,'新标题');assert.deepEqual(page.opaque,{keep:'yes'});
  await f.editorState.close();f.virtualFs.dispose();
});
test('return-inherit materialization requires explicit review before backend write', {skip:!pythonAvailable && 'repository Python environment unavailable'},async t=>{
  const f=fixture(t,{project:'return inherit();'}),key='projects.api-fixture';await f.editorState.add(key,f.checkoutPath);
  const uri=uriFor(f.vscode,{workspaceKey:key,sourceType:'procedure',sourcePath:f.procPath,fragmentType:'gss'});f.docs.push({uri,isDirty:true,version:1});
  const expanded=(await f.virtualFs.readFile(uri)).toString(),candidate=expanded.replace('parent();','replacement();');
  f.vscode.window.showWarningMessage=async()=>undefined;await assert.rejects(f.virtualFs.writeFile(uri,Buffer.from(candidate)),/readonly/);
  assert.equal(f.calls.some(x=>x.action==='inherited-write'),false);assert.equal((await f.run(key,'read',{path:f.procPath})).content,'return inherit();');
  f.vscode.window.showWarningMessage=async()=> '已核对，继续保存';await f.virtualFs.writeFile(uri,Buffer.from(candidate));
  const sent=f.calls.find(x=>x.action==='inherited-write').input;assert.equal(sent.materialized,true);assert.equal(sent.controlFlowConfirmed,true);
  assert.equal((await f.run(key,'read',{path:f.parentPath})).content,f.parent);await f.editorState.close();f.virtualFs.dispose();
});

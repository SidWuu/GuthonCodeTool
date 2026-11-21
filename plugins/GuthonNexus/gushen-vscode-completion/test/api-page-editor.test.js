const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const {PageEditorController}=require('../src/page-editor/controller');
const {PageDraft}=require('../src/page-editor/model');const {projectNative}=require('../src/page-editor/native-model');
const {ApiEditorState}=require('../src/api/editor-state');const {ApiPageVirtualFs,uriFor}=require('../src/source/virtual-fs');
const clone=x=>JSON.parse(JSON.stringify(x));
const original={pageId:'PG-1',views:[{id:'view',type:'input-box',fields:[{fieldId:'A',type:'text',label:'A',width:1,pageEvents:{onChangeScript:'old();'}},{fieldId:'B',type:'text',label:'B',width:2}],datasource:{sql:'select 1'}}]};
function model(data) {return {pageId:'PG-1',collections:[{pointer:'/views/0/fields',label:'表单',region:'FORM',reorderable:true,fields:data.views[0].fields.map((f,i)=>({key:'fieldId:'+f.fieldId,pointer:'/views/0/fields/'+i,label:f.label,type:f.type,editable:true,properties:[{name:'label',value:f.label},{name:'width',value:f.width}]}))}],nodes:[{key:'/views/0/datasource/sql',pointer:'/views/0/datasource/sql',label:'SQL',content:data.views[0].datasource.sql,type:'SQL',editable:true}]};}
function fixture() {
  const store=new Map(),calls=[],panels=[],documents=[];let data=clone(original),failAfterSave=false;
  const hash=()=>crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const identity={workspaceKey:'projects.demo',sourcePath:'systems/s/pages/p/page.gss',sourceType:'page'};
  const current=()=>({...identity,sourceText:JSON.stringify(data),sourceHash:hash(),editToken:'edit-token',editable:true,model:model(data)});
  const backend={async run(key,args,input){calls.push({key,args,input:clone(input)});if(input.action==='open')return current();
    if(input.action==='comparison')return {sourceHash:hash(),available:true,baseRevision:'api-1',changes:{rows:[],paths:[]}};
    const d=new PageDraft(model(data));d.restore(input.operations);const projected=projectNative(current(),d).data;
    if(input.action==='preview')return {candidateSourceHash:crypto.createHash('sha256').update(JSON.stringify(projected)).digest('hex')};
    if(input.action==='save'){assert.equal(input.editorToken,'editor-token');data=projected;if(failAfterSave)throw Error('result unknown');return {sourceHash:hash()};}
    throw Error(input.action);}};
  const uri=x=>({...x,toString(){return `${this.scheme}://${this.authority}${this.path}?${this.query||''}`;}});
  const vscode={Uri:{from:uri,file:fsPath=>({fsPath})},ViewColumn:{Active:1,Beside:2},commands:{executeCommand:async()=>{}},
    workspace:{textDocuments:documents,onDidChangeTextDocument:()=>({dispose(){}})},window:{showErrorMessage:async()=>{},createWebviewPanel(){
      const panel={webview:{cspSource:'x',asWebviewUri:()=>({toString:()=> 'x'}),postMessage:async()=>{},onDidReceiveMessage(){}},onDidDispose(f){this.close=f;},dispose(){this.close?.();},reveal(){}};panels.push(panel);return panel;}}};
  const context={extensionPath:'/extension',workspaceState:{get:k=>store.get(k),update:async(k,v)=>store.set(k,v)}};
  const registrations=[];const host=new PageEditorController({vscode,context,backend,virtualFs:{open:async x=>uriFor(vscode,x)},resources:{},
    recoveryStore:{head:async(_k,v)=>v,save:async(_k,v)=>v},editorToken:async()=> 'editor-token',onDraftChanged:async(id,dirty,version)=>registrations.push({id,dirty,version})});
  return {host,identity,calls,store,registrations,documents,vscode,backend,current,get data(){return data;},setData:value=>{data=value;},failAfterSave:()=>{failAfterSave=true;}};
}
test('API PAGE manager retains structured draft, undo, redo, code and order and saves with token',async()=>{
  const f=fixture(),session=await f.host.open(f.identity);
  await f.host.message(session,{type:'property',version:0,collectionPointer:'/views/0/fields',fieldKey:'fieldId:A',name:'label',value:'中文'});
  session.draft.text('/views/0/datasource/sql','select 2');
  await f.host.message(session,{type:'order',version:session.draft.version,collectionPointer:'/views/0/fields',fieldKeys:['fieldId:B','fieldId:A']});
  await f.host.message(session,{type:'undo',version:session.draft.version});assert.equal(session.draft.operations().length,2);
  await f.host.message(session,{type:'redo',version:session.draft.version});
  await f.host.save(session);assert.equal(f.data.views[0].fields[1].label,'中文');assert.equal(f.data.views[0].datasource.sql,'select 2');
  assert.equal(session.draft.operations().length,0);assert.equal(session.baselineComparison.apiVersion,'api-1');
  assert.ok(f.calls.filter(c=>['preview','save'].includes(c.input.action)).every(c=>c.input.path===f.identity.sourcePath));
  assert.ok(f.registrations.some(x=>x.dirty));assert.ok(f.registrations.some(x=>!x.dirty));f.host.dispose();
});
test('PAGE manager falls back to immutable original when the backend identifies minimal or mismatched source',async()=>{
  for(const contentState of ['METADATA_ONLY','IDENTITY_MISMATCH']) {
    const f=fixture(),raw='<page><isProduct>0</isProduct></page>',opened=[];
    f.host.backend.run=async()=>({sourcePath:f.identity.sourcePath,sourceText:raw,sourceHash:'hash',editable:false,model:null,contentState});
    f.host.openReadonly=async(identity,snapshot)=>(opened.push({identity,snapshot}),{readonly:true});
    assert.deepEqual(await f.host.open(f.identity),{readonly:true});assert.equal(opened[0].snapshot.sourceText,raw);
    assert.equal(opened[0].snapshot.editable,false);assert.equal(f.host.pages.size,0);f.host.dispose();
  }
});
test('API PAGE external changes merge independent draft and conflict choices remain explicit',async()=>{
  const f=fixture(),s=await f.host.open(f.identity);
  await f.host.message(s,{type:'property',version:0,collectionPointer:'/views/0/fields',fieldKey:'fieldId:A',name:'label',value:'草稿'});
  const other=clone(original);other.views[0].fields[1].width=9;f.setData(other);
  await f.host.sourceChanged(f.identity.workspaceKey,[f.identity.sourcePath]);
  assert.equal(s.sourceStale,false);assert.equal(s.draft.model.collections[0].fields[0].properties[0].value,'草稿');assert.equal(s.draft.model.collections[0].fields[1].properties[1].value,9);
  const conflict=clone(other);conflict.views[0].fields[0].label='外部';f.setData(conflict);await f.host.sourceChanged(f.identity.workspaceKey,[f.identity.sourcePath]);
  assert.equal(s.sourceStale,true);assert.ok(s.sourceMerge.evidence.conflicts.length);f.host.dispose();
});
test('unknown PAGE save is recovered by readback without replaying mutation',async()=>{
  const f=fixture(),s=await f.host.open(f.identity);await f.host.message(s,{type:'property',version:0,collectionPointer:'/views/0/fields',fieldKey:'fieldId:A',name:'label',value:'saved'});
  f.failAfterSave();await assert.rejects(f.host.save(s),/unknown/);assert.ok(s.pending);
  await f.host.message(s,{type:'resume'});assert.equal(s.pending,null);assert.equal(f.calls.filter(x=>x.input.action==='save').length,1);f.host.dispose();
});
test('editor-state registers token, merges drafts and buffers, and closes with same token',async()=>{
  const calls=[],listeners={};const doc={uri:{scheme:'file',fsPath:'/checkout/p.gss'},isDirty:true,version:3};
  const vscode={workspace:{textDocuments:[doc],onDidChangeTextDocument:fn=>(listeners.change=fn,{dispose(){}})}};
  const state=new ApiEditorState({vscode,run:async(key,action,payload)=>{calls.push({key,action,payload});return {editorToken:'secret-token'};}});
  await state.add('projects.demo','/checkout');await state.setDraft('page','projects.demo','p.gss',true,7);await state.flush('projects.demo');
  assert.deepEqual(calls[0].payload.documents,[{path:'p.gss',dirty:true,version:3}]);
  assert.deepEqual(calls.at(-1).payload.documents,[{path:'p.gss',dirty:true,version:7}]);assert.equal(calls.at(-1).payload.editorToken,'secret-token');
  state.assertNoConflictingDrafts('projects.demo','p.gss',['page']);assert.throws(()=>state.assertNoConflictingDrafts('projects.demo','p.gss'),/另一个设计器/);
  await state.close();assert.equal(calls.at(-1).payload.close,true);assert.equal(calls.at(-1).payload.editorToken,'secret-token');
});
test('API code fragment sends hash-bound save with owner token',async()=>{
  const f=fixture();class Emitter {constructor(){this.event=()=>{};}dispose(){}}
  f.vscode.EventEmitter=Emitter;f.vscode.FileType={File:1};f.vscode.FileSystemError={FileNotFound:()=>Error('missing'),NoPermissions:()=>Error('readonly')};
  const state={flush:async()=> 'editor-token',assertNoConflictingDrafts(){}};
  const fs=new ApiPageVirtualFs({vscode:f.vscode,run:(key,_action,input)=>f.backend.run(key,[],input),editorState:state});
  const uri=uriFor(f.vscode,{...f.identity,jsonPointer:'/views/0/datasource/sql',fragmentType:'sql'});
  assert.equal((await fs.readFile(uri)).toString(),'select 1');await fs.writeFile(uri,Buffer.from('select 3'));
  assert.equal(f.data.views[0].datasource.sql,'select 3');assert.equal(f.calls.find(c=>c.input.action==='save').input.editorToken,'editor-token');fs.dispose();
});
test('PAGE manager blocks its save while another source buffer has unsaved text',async()=>{
  const f=fixture();f.host.ownsDocument=()=>true;f.documents.push({uri:{scheme:'file',fsPath:'/checkout/p.gss'},isDirty:true,version:4});
  await assert.rejects(f.host.open(f.identity),/未保存/);f.documents[0].isDirty=false;
  const s=await f.host.open(f.identity);s.draft.text('/views/0/datasource/sql','new');f.documents[0].isDirty=true;
  await assert.rejects(f.host.save(s),/未保存输入/);assert.equal(f.calls.filter(c=>c.input.action==='save').length,0);f.host.dispose();
});
test('PAGE recovery preserves unsaved draft across close and reopening',async()=>{
  const f=fixture(),s=await f.host.open(f.identity);
  await f.host.message(s,{type:'property',version:0,collectionPointer:'/views/0/fields',fieldKey:'fieldId:A',name:'label',value:'保留'});
  s.panel.dispose();await s.persistence;
  const reopened=await f.host.open(f.identity);assert.equal(reopened,s);assert.equal(reopened.draft.operations()[0].value,'保留');f.host.dispose();
});
test('stale PAGE save snapshot cannot silently replace source from a different path',async()=>{
  const f=fixture(),run=f.backend.run;
  f.backend.run=async(...args)=>{const result=await run(...args);if(args[2].action==='open')result.sourcePath='other/page.gss';return result;};
  await assert.rejects(f.host.open(f.identity),/来源与请求不一致/);assert.equal(f.calls.filter(c=>c.input.action==='save').length,0);
});
test('editor-state rejects missing or replaced token and retry preserves the original owner',async()=>{
  let attempt=0;const calls=[];const state=new ApiEditorState({vscode:{workspace:{textDocuments:[]}},run:async(_key,_action,input)=>{
    calls.push(input);attempt++;if(attempt===1)return {};if(attempt===2)return {editorToken:'owner'};if(attempt===3)return {editorToken:'other'};return {editorToken:'owner'};}});
  await assert.rejects(state.add('projects.demo','/checkout'),/未返回/);assert.equal(await state.flush('projects.demo'),'owner');
  await assert.rejects(state.flush('projects.demo'),/不一致/);assert.equal(calls[2].editorToken,'owner');
  assert.equal(await state.flush('projects.demo'),'owner');await state.close();
});
test('inherited PAGE code is expanded and project edits retain the inheritance marker',async()=>{
  let physical='前\ninherit();\n后',version='h1';const calls=[];
  const projectPrefix='前\n',product='上游🧪',suffix='\n后';
  const effective=projectPrefix+product+suffix;
  const cp=x=>Array.from(x).length;
  const segments=[{layer:'project',start:0,end:cp(projectPrefix),sourceStart:0,sourceEnd:cp(projectPrefix)},
    {layer:'product',start:cp(projectPrefix),end:cp(projectPrefix+product),sourceStart:0,sourceEnd:cp(product)},
    {layer:'project',start:cp(projectPrefix+product),end:cp(effective),sourceStart:cp(projectPrefix+'inherit();'),sourceEnd:cp(physical)}];
  const vscode={workspace:{textDocuments:[]},window:{showWarningMessage:async()=>{}},EventEmitter:class{constructor(){this.event=()=>{};}dispose(){}},Uri:{from:o=>({...o,toString(){return `${o.scheme}://${o.authority}${o.path}?${o.query}`;}})},
    FileType:{File:1},FileSystemError:{FileNotFound:()=>Error('missing'),NoPermissions:()=>Error('readonly')}};
  const run=async(_key,action,payload)=>{calls.push({action,payload});
    if(action==='inheritance')return {path:'page.gss',status:'ACTIVE',sourceHash:version,parentPointer:'/superPageEvents/onClickScript',effective,totalChars:cp(effective),segments,materializable:true,truncated:false};
    if(payload.action==='open')return {sourcePath:payload.path,sourceHash:version,editable:true,editToken:'edit',model:{nodes:[{pointer:'/pageEvents/onClickScript',content:physical,editable:false}]}};
    if(payload.action==='save'){physical=payload.operations[0].content;version='h2';return {sourceHash:version};}
    return {candidateSourceHash:'h2'};};
  const fs=new ApiPageVirtualFs({vscode,run,editorState:{flush:async()=> 'editor-token',assertNoConflictingDrafts(){}}});
  const uri=uriFor(vscode,{workspaceKey:'projects.demo',sourcePath:'page.gss',jsonPointer:'/pageEvents/onClickScript',fragmentType:'js'});
  assert.equal((await fs.readFile(uri)).toString(),effective);
  await fs.writeFile(uri,Buffer.from('前后缀\n'+product+suffix));
  assert.equal(physical,'前后缀\ninherit();\n后');const save=calls.find(x=>x.payload.action==='save').payload;
  assert.equal(save.editorToken,'editor-token');assert.deepEqual(save.inheritance,{jsonPointer:'/pageEvents/onClickScript',parentPointer:'/superPageEvents/onClickScript',sourceHash:'h1',parentHash:'h1',materialized:false});fs.dispose();
});
test('PAGE script fragments retain SQL, service VM and page JS language identities',()=>{
 const {scriptType}=require('../src/source/virtual-fs');assert.equal(scriptType({type:'SQL',pointer:'/sql'}),'sql');
 assert.equal(scriptType({type:'SCRIPT',eventScope:'SERVICE',pointer:'/serviceEvents/onSave'}),'vm');
 assert.equal(scriptType({type:'SCRIPT',pointer:'/pageEvents/onClickScript'}),'js');
});
test('XML PAGE merge uses backend JSON projections while hashes track raw XML',async()=>{
  const f=fixture(),originalRun=f.backend.run;let raw='<page id="PG-1"><field label="A"/></page>';
  const rawHash=()=>crypto.createHash('sha256').update(raw).digest('hex');
  f.backend.run=async(key,action,input)=>{const result=await originalRun(key,action,input);
    if(input.action==='open') return {...result,sourceHash:rawHash()};
    if(input.action==='comparison') return {...result,sourceHash:rawHash()};return result;};
  const s=await f.host.open(f.identity);assert.equal(s.snapshot.sourceHash,rawHash());assert.doesNotThrow(()=>JSON.parse(s.snapshot.sourceText));
  await f.host.message(s,{type:'property',version:0,collectionPointer:'/views/0/fields',fieldKey:'fieldId:A',name:'label',value:'草稿'});
  const updated=clone(original);updated.views[0].fields[1].width=9;f.setData(updated);raw='<page id="PG-1"><field label="A" width="9"/></page>';
  await f.host.sourceChanged(f.identity.workspaceKey,[f.identity.sourcePath]);
  assert.equal(s.sourceStale,false);assert.equal(s.snapshot.sourceHash,rawHash());assert.equal(s.draft.operations()[0].value,'草稿');f.host.dispose();
});
test('materializing inherited PAGE code sends parent hash and explicit control-flow confirmation',async()=>{
  let physical='before\ninherit();\nafter',hash='h1';const saved=[];
  const effective='before\nproduct\nafter';
  const segments=[{layer:'project',start:0,end:7,sourceStart:0,sourceEnd:7},{layer:'product',start:7,end:14,sourceStart:0,sourceEnd:7},{layer:'project',start:14,end:20,sourceStart:17,sourceEnd:23}];
  const vscode={workspace:{textDocuments:[]},window:{showWarningMessage:async()=> '已核对，继续保存'},EventEmitter:class{constructor(){this.event=()=>{};}dispose(){}},
    Uri:{from:o=>({...o,toString(){return JSON.stringify(o);}})},FileSystemError:{FileNotFound:()=>Error('missing'),NoPermissions:()=>Error('readonly')}};
  const run=async(_key,action,payload)=>{
    if(action==='inheritance')return {path:'page.json',sourceHash:'h1',parentHash:'parent-hash',parentPointer:'/super',status:'ACTIVE',effective,totalChars:20,truncated:false,segments,materializable:false};
    if(payload.action==='open')return {sourcePath:payload.path,sourceHash:hash,editable:true,editToken:'edit',model:{nodes:[{pointer:'/event',content:physical,editable:false}]}};
    if(payload.action==='save'){saved.push(payload);physical=payload.operations[0].content;hash='h2';return {sourceHash:'h2'};}
    return {candidateSourceHash:'h2'};};
  const fs=new ApiPageVirtualFs({vscode,run,editorState:{flush:async()=> 'editor-token',assertNoConflictingDrafts(){}}});
  const uri=uriFor(vscode,{workspaceKey:'projects.demo',sourcePath:'page.json',jsonPointer:'/event',fragmentType:'js'});
  assert.equal((await fs.readFile(uri)).toString(),effective);await fs.writeFile(uri,Buffer.from('before\nchanged\nafter'));
  assert.equal(physical,'before\nchanged\nafter');assert.deepEqual(saved[0].inheritance,{jsonPointer:'/event',parentPointer:'/super',sourceHash:'h1',parentHash:'parent-hash',materialized:true,controlFlowConfirmed:true});fs.dispose();
});
test('PAGE manager opens the selected fields collection as an editable JSON fragment',async()=>{
  const f=fixture(),s=await f.host.open(f.identity),opened=[];f.host.virtualFs.open=async(identity,options)=>{opened.push({identity,options});};
  await f.host.message(s,{type:'openFields',version:s.draft.version,collectionPointer:'/views/0/fields'});
  assert.equal(opened[0].identity.sourcePath,f.identity.sourcePath);assert.equal(opened[0].identity.jsonPointer,'/views/0/fields');assert.equal(opened[0].identity.fragmentType,'fields');
  await assert.rejects(f.host.message(s,{type:'openFields',version:s.draft.version,collectionPointer:'/other'}),/字段集合已变化/);f.host.dispose();
});
test('concurrent fragment reads share one request and stale in-flight reads cannot publish',async()=>{
  const {ApiPageVirtualFs,uriFor}=require('../src/source/virtual-fs');class Emitter{constructor(){this.event=()=>{};}fire(){}dispose(){}}
  const vscode={EventEmitter:Emitter,workspace:{textDocuments:[]},FileChangeType:{Changed:1},Uri:{from:x=>({...x,toString(){return JSON.stringify(x);}})}};
  let release,started,calls=0;const began=new Promise(resolve=>started=resolve);
  const fs=new ApiPageVirtualFs({vscode,editorState:{},run:async(_key,_action,input)=>{calls++;started();await new Promise(resolve=>release=resolve);return {sourcePath:input.path,sourceHash:'h',editable:true,model:{nodes:[{pointer:'/event',content:'old',editable:true}]}};}});
  const uri=uriFor(vscode,{workspaceKey:'projects.demo',sourcePath:'page.json',jsonPointer:'/event',fragmentType:'js'});
  const first=fs.readFile(uri),second=fs.readFile(uri);await began;assert.equal(calls,1);
  fs.invalidate('projects.demo',['page.json']);release();await assert.rejects(first,/读取期间已变化/);await assert.rejects(second,/读取期间已变化/);
  assert.equal(fs.records.size,0);fs.dispose();
});

const test=require('node:test');
const assert=require('node:assert/strict');
const {ApiPageVirtualFs,uriFor}=require('../src/source/virtual-fs');
const {ApiQuickDiff}=require('../src/source/quick-diff');
const {ApiSourceUI}=require('../src/api/source-ui');

function fixture() {
  const calls=[],documents=[],sessions=new Map();let sql='select 1',hash='h1',number=0,preview,failedSave=false;
  class Emitter {constructor(){this.event=()=>{};}fire(){}dispose(){}}
  const vscode={EventEmitter:Emitter,FileType:{File:1},FilePermission:{Readonly:1},FileSystemError:{NoPermissions:()=>Error('readonly')},
    Uri:{from:o=>({...o,toString(){return JSON.stringify(o);}}),file:fsPath=>({scheme:'file',fsPath})},workspace:{textDocuments:documents},window:{showErrorMessage:async()=>{}}};
  const editorState={flush:async()=> 'owner',assertNoConflictingDrafts(){},assertNoDirtyDocumentsExcept(_key,p,uri){
    if(documents.some(d=>d.isDirty && d.path===p && (!uri || d.uri.toString()!==uri.toString()))) throw Error('未保存输入');}};
  const run=async(key,action,input)=>{
    calls.push({key,action,input});
    if(action==='diff')return {before:'<view><viewSql>select 0</viewSql></view>',baseHash:'base',sourceHash:hash};
    if(action==='read')return {path:input.path,sourceHash:hash,readonly:false};
    assert.equal(action,'view');
    if(input.action==='open') {const editToken='edit-'+ ++number;sessions.set(editToken,true);return {sourcePath:input.path,sourceHash:hash,content:sql,editable:true,editToken,baseHash:'base',baseContentSQL:'select 0'};}
    if(input.action==='close'){sessions.delete(input.editToken);return {};}
    if(input.action==='preview') {assert.ok(sessions.has(input.editToken));assert.equal(input.expectedHash,hash);preview=input.content;return {sourceHash:hash,previewId:'preview',candidateSourceHash:'h2'};}
    if(input.action==='save') {assert.ok(sessions.has(input.editToken));assert.equal(input.editorToken,'owner');assert.equal(input.previewId,'preview');assert.match(input.idempotencyKey,/^view-sql-/);sql=preview;hash='h2';sessions.delete(input.editToken);if(failedSave) throw Error('connection lost');return {sourceHash:hash,operationComplete:true,operationId:'op'};}
    throw Error(input.action);
  };
  const virtualFs=new ApiPageVirtualFs({vscode,run,editorState});
  const id={workspaceKey:'projects.a',sourcePath:'datasources/DS/views/V.xml',sourceType:'view',jsonPointer:'/viewSql',fragmentType:'sql'},uri=uriFor(vscode,id);
  return {vscode,editorState,run,virtualFs,id,uri,calls,documents,sessions,get sql(){return sql;},failSave(){failedSave=true;}};
}
test('view SQL saves via preview and owner-bound save, reads back, and closes sessions',async()=>{
  const f=fixture();assert.match(f.uri.path,/\.sql$/);assert.equal((await f.virtualFs.readFile(f.uri)).toString(),'select 1');
  f.documents.push({uri:f.uri,path:f.id.sourcePath,isDirty:true,version:1});
  await f.virtualFs.writeFile(f.uri,Buffer.from('select 2'));assert.equal(f.sql,'select 2');
  assert.equal(f.calls.filter(x=>x.input.action==='save').length,1);f.virtualFs.close(f.uri);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.sessions.size,0);f.virtualFs.dispose();
});
test('view save blocks dirty raw buffers and changed document versions before mutation',async()=>{
  const f=fixture();await f.virtualFs.readFile(f.uri);
  const doc={uri:f.uri,path:f.id.sourcePath,isDirty:true,version:1};f.documents.push(doc,{uri:{toString:()=> 'raw'},path:f.id.sourcePath,isDirty:true,version:1});
  await assert.rejects(f.virtualFs.writeFile(f.uri,Buffer.from('select 2')),/未保存/);assert.equal(f.calls.some(x=>x.input.action==='save'),false);
  f.documents.pop();const run=f.virtualFs.run;f.virtualFs.run=async(...args)=>{const result=await run(...args);if(args[2]?.action==='preview')doc.version++;return result;};
  await assert.rejects(f.virtualFs.writeFile(f.uri,Buffer.from('select 2')),/保存期间/);assert.equal(f.calls.some(x=>x.input.action==='save'),false);f.virtualFs.dispose();
});
test('unknown view save is not replayed',async()=>{
  const f=fixture();await f.virtualFs.readFile(f.uri);f.failSave();
  await assert.rejects(f.virtualFs.writeFile(f.uri,Buffer.from('select 2')),/connection lost/);
  await assert.rejects(f.virtualFs.writeFile(f.uri,Buffer.from('select 2')),/结果未知/);
  assert.equal(f.calls.filter(x=>x.input.action==='save').length,1);f.virtualFs.dispose();
});
test('view quick diff uses only the matching hash-bound SQL baseline',async()=>{
  const f=fixture();await f.virtualFs.readFile(f.uri);const provider=new ApiQuickDiff({vscode:f.vscode,run:f.run,editorState:f.editorState,ui:{scmGenerations:new Map()},viewBase:(uri,diff)=>f.virtualFs.viewBase(uri,diff)});
  const original=await provider.provideOriginalResource(f.uri);assert.equal(provider.provideTextDocumentContent(original),'select 0');
  provider.run=async(...args)=>{const result=await f.run(...args);if(args[1]==='diff')result.baseHash='different';return result;};
  assert.equal(await provider.provideOriginalResource(f.uri),undefined);provider.dispose();f.virtualFs.dispose();
});
test('source tree opens views as SQL while raw preview and original stay XML',async()=>{
  const f=fixture(),opened=[],shown=[];f.vscode.workspace.openTextDocument=async uri=>({uri});f.vscode.window.showTextDocument=async(doc,options)=>shown.push({doc,options});
  const ui=new ApiSourceUI({vscode:f.vscode,run:async(_key,action)=>action==='status'?{checkoutPath:'/checkout'}:{metadata:{sourceType:'view'},content:'<view/>',readonly:false},onOpenVirtual:async id=>opened.push(id)});
  await ui.open('projects.a',f.id.sourcePath);await ui.open('projects.a',f.id.sourcePath,true,{raw:true});await ui.open('projects.a',f.id.sourcePath,false,{raw:true});
  assert.equal(opened[0].sourceType,'view');assert.equal(opened[0].jsonPointer,'/viewSql');assert.equal(opened[0].fragmentType,'sql');assert.equal(shown.length,2);assert.equal(shown[0].doc.uri.fsPath,'/checkout/'+f.id.sourcePath);assert.equal(shown[0].options.preview,true);
});

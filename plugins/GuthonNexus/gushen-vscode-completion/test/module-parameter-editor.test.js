const test=require('node:test'),assert=require('node:assert/strict');
const {ApiPageVirtualFs,uriFor}=require('../src/source/virtual-fs');
const {ModuleParameterEditor}=require('../src/api/module-parameter-editor');
function fsFixture(){
 const calls=[],events=[];let hash='h1',content='{"limit":1}\n',previewContent,fail=false;
 const vscode={Uri:{from:v=>({...v,toString(){return JSON.stringify(v);}})},FileType:{File:1},FilePermission:{Readonly:1},FileChangeType:{Changed:1},FileSystemError:{NoPermissions:()=>Error('readonly')},EventEmitter:class{constructor(){this.event=()=>({dispose(){}});}fire(v){events.push(v);}dispose(){}},workspace:{textDocuments:[]},window:{showErrorMessage(){}}};
 const editorState={assertNoConflictingDrafts(){},assertNoDirtyDocumentsExcept(){},flush:async()=> 'editor'};
 const run=async(key,action,input)=>{
  calls.push({key,action,input});if(action==='read')return {path:input.path,sourceHash:hash,readonly:false};
  assert.equal(action,'module-parameter');
  if(input.action==='open')return {sourcePath:'systems/A/module-parameters/demo.json',sourceHash:hash,content,editable:true,editToken:'lease',baseHash:'base',baseContentData:'{"limit":1}\n'};
  if(input.action==='close')return {closed:true};
  if(input.action==='preview'){assert.equal(input.expectedHash,hash);previewContent=input.content;return {sourcePath:input.path,sourceHash:hash,previewId:'preview',candidateSourceHash:'h2',beforeContent:'{"limit":1}\n',afterContent:input.content};}
  if(input.action==='save'){if(fail)throw Error('transport unknown');content=previewContent.trim()+'\n';hash='h2';return {sourceHash:hash,sourcePath:'systems/A/module-parameters/demo.json',operationComplete:true};}
  throw Error(input.action);
 };
 const fs=new ApiPageVirtualFs({vscode,run,editorState});const uri=uriFor(vscode,{workspaceKey:'projects.A',sourcePath:'systems/A/module-parameters/demo.json',sourceType:'module-parameter',jsonPointer:'/data',fragmentType:'json'});
 return {fs,uri,calls,vscode,setFail:v=>fail=v};
}
test('module data JSON uses the shared lease projection, local preview and verified save',async()=>{
 const f=fsFixture();assert.match(f.uri.path,/\.json$/);assert.equal((await f.fs.readFile(f.uri)).toString(),'{"limit":1}\n');
 const preview=await f.fs.previewProjection(f.uri,'{"limit":2}\n');assert.equal(preview.afterContent,'{"limit":2}\n');
 await f.fs.writeFile(f.uri,Buffer.from('{"limit":2}\n\n'));
 assert.equal(f.calls.filter(x=>x.input.action==='save').length,1);assert(f.calls.every(x=>!['upload','module-upload'].includes(x.action)));
 assert.equal(f.fs.projectionBase(f.uri,{sourceHash:'h2',baseHash:'base'}),'{"limit":1}\n');
 f.fs.close(f.uri);assert(f.calls.some(x=>x.action==='module-parameter'&&x.input.action==='close'));
});
test('uncertain local save keeps the editor guarded instead of resending',async()=>{
 const f=fsFixture();await f.fs.readFile(f.uri);f.setFail(true);await assert.rejects(f.fs.writeFile(f.uri,Buffer.from('{"limit":2}')),/unknown/);
 await assert.rejects(f.fs.writeFile(f.uri,Buffer.from('{"limit":2}')),/未知/);assert.equal(f.calls.filter(x=>x.input.action==='save').length,1);
});
function uploadFixture(answer){
 const calls=[],reports=[],plan={planId:'id',planHash:'hash',items:[{path:'p',systemId:'A',configId:'C',name:'参数',diff:'-1\n+2',checkoutRequired:true}]};
 const vscode={window:{showWarningMessage:async(...args)=>{calls.push(['confirm',...args]);return answer;},showInformationMessage:async()=>{}}};
 const ui={status:async()=>({files:[{path:'p',sourceType:'module-parameter',state:'MODIFIED'}]}),openReadonly:async(...args)=>reports.push(args),setIndexResult(){},updateScm:async()=>calls.push(['scm'])};
 const run=async(key,action,input)=>{calls.push([action,input]);if(input.action==='preview')return plan;return {operationId:'id',stage:'REMOTE_READBACK_VERIFIED',results:[{path:'p',stage:'REMOTE_READBACK_VERIFIED'}],index:{complete:true}};};
 const controller=new ModuleParameterEditor({vscode,ui,run,editorState:{flush:async()=>calls.push(['flush'])}});
 return {controller,calls,reports};
}
test('upload cancellation occurs after a concrete diff and causes no upload call',async()=>{
 const f=uploadFixture(undefined);await f.controller.upload('projects.A');assert.match(f.reports[0][2],/本次需签出后保存/);
 assert.equal(f.calls.filter(x=>x[0]==='module-upload'&&x[1].action==='upload').length,0);
});
test('confirmed upload passes the exact preview binding and reports no check-in',async()=>{
 const f=uploadFixture('确认上传');await f.controller.upload('projects.A');
 const call=f.calls.find(x=>x[0]==='module-upload'&&x[1].action==='upload');assert.deepEqual(call[1],{action:'upload',planId:'id',planHash:'hash',confirm:true});
 assert.match(f.reports.at(-1)[2],/平台最终签入：未执行/);
});

test('readonly original snapshots retain reviewed bytes when the module changes',()=>{
 const {ApiSourceUI}=require('../src/api/source-ui');const ui=new ApiSourceUI({vscode:{Uri:{from:value=>value}},run:async()=>{}});
 const before=ui.readonlyUri('projects.A','systems/A/module-parameters/demo.json','before');
 const after=ui.readonlyUri('projects.A','systems/A/module-parameters/demo.json','after');
 assert.notEqual(before.query,after.query);assert.equal(ui.provideTextDocumentContent(before),'before');assert.equal(ui.provideTextDocumentContent(after),'after');
});

test('a rejected stale plan keeps its cause rather than claiming an unknown upload',async()=>{
 const f=uploadFixture('确认上传'),run=f.controller.run;f.controller.run=async(key,action,input)=>{
  if(input.action==='upload')throw Object.assign(Error('preview stale'),{code:'API_SOURCE_STALE'});
  return run(key,action,input);
 };
 await assert.rejects(f.controller.upload('projects.A'),/preview stale/);
 assert.equal(f.reports.length,1);assert(!f.reports.some(item=>item[2].includes('请求未取得完整回执')));
});

function lazyFixture(){
 const calls=[],documents=[],shown=[];
 const selector={systemId:'A',configId:'demo',snapshotPath:'systems/A/module-parameters/demo.json'};
 const vscode={workspace:{textDocuments:documents},window:{showTextDocument:async doc=>{shown.push(doc);return {document:doc};},showInformationMessage:async message=>calls.push({message})}};
 const ui={ensureWorkspace:async()=>{},setIndexResult(){},updateScm:async()=>{},status:async()=>({files:[]})};
 const virtualFs={openEditor:async id=>{const doc={uri:uriFor({Uri:{from:value=>({...value,toString(){return JSON.stringify(value);}})}},id),isDirty:false,getText:()=>'{"draft":1}'};documents.push(doc);return {document:doc};}};
 const run=async(key,action,input)=>{calls.push({key,action,input});return {path:selector.snapshotPath,complete:true,index:{complete:true}};};
 const controller=new ModuleParameterEditor({vscode,run,ui,virtualFs,editorState:{flush:async()=>{}}});
 return {calls,documents,shown,selector,controller};
}
test('directory entry loads exactly one detail; repeated click keeps an existing dirty editor',async()=>{
 const f=lazyFixture();const first=await f.controller.open('projects.A','otherconfig/module-parameters.json',f.selector);
 first.document.isDirty=true;
 const second=await f.controller.open('projects.A','otherconfig/module-parameters.json',f.selector);
 assert.equal(first.document,second.document);assert.equal(f.calls.length,1);
 assert.deepEqual(f.calls[0],{key:'projects.A',action:'module-parameter-load',input:{systemId:'A',configId:'demo'}});
 assert.equal(second.document.getText(),'{"draft":1}');
});
test('concurrent opens share one detail load, while old snapshot opens work offline',async()=>{
 const f=lazyFixture();await Promise.all([f.controller.open('projects.A','directory',f.selector),f.controller.open('projects.A','directory',f.selector)]);
 assert.equal(f.calls.length,1);assert.equal(f.documents.length,1);
 const old=lazyFixture();await old.controller.open('projects.A',old.selector.snapshotPath);assert.equal(old.calls.length,0);
});
test('incomplete detail load does not open an editor or silently ignore conflicts',async()=>{
 const f=lazyFixture();f.controller.run=async()=>({path:f.selector.snapshotPath,complete:false,index:{complete:true},conflicts:[{}]});
 await assert.rejects(f.controller.open('projects.A','directory',f.selector),/未完成/);assert.equal(f.documents.length,0);
});
test('directory selection maps upload to cached changed snapshot without fetching or uploading the directory',async()=>{
 const f=lazyFixture();await f.controller.upload('projects.A',['otherconfig/module-parameters.json'],f.selector);
 assert.equal(f.calls.length,1);assert.match(f.calls[0].message,/没有待上传修改/);
 const u=uploadFixture(undefined);u.controller.ui.status=async()=>({files:[{path:f.selector.snapshotPath,state:'MODIFIED',sourceType:'module-parameter'}]});
 await u.controller.upload('projects.A',['otherconfig/module-parameters.json'],f.selector);
 assert.deepEqual(u.calls.find(c=>c[0]==='module-upload')[1].paths,[f.selector.snapshotPath]);
});
test('tree commands and context nodes resolve the same compound parameter selector',()=>{
 const {moduleParameterSelector}=require('../src/api/module-parameter-editor');const f=lazyFixture();
 assert.deepEqual(moduleParameterSelector({moduleParameter:f.selector}),f.selector);
 assert.deepEqual(moduleParameterSelector({object:{referenceFields:f.selector}}),f.selector);
 assert.equal(moduleParameterSelector({path:f.selector.snapshotPath}),undefined);
});

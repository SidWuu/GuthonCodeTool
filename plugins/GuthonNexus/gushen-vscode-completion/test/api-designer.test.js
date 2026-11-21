const test=require('node:test');
const assert=require('node:assert/strict');
const {openDesigner}=require('../src/api/designer');

function fixture() {
  const panels=[],calls=[],warnings=[],drafts=[],messages=[];
  let change,releaseContext,contextStarted,documentOpened;
  const opened=new Promise(resolve=>{documentOpened=resolve;});
  const started=new Promise(resolve=>{contextStarted=resolve;});
  const contextGate=new Promise(resolve=>{releaseContext=resolve;});
  const content='{"pageId":"P1"}';
  const doc={uri:{scheme:'file',fsPath:'/checkout/page.json',toString:()=>'/checkout/page.json'},version:1,isDirty:false,getText:()=>content};
  const vscode={Uri:{file:p=>({scheme:'file',fsPath:p,toString:()=>p})},ViewColumn:{Active:1},
    workspace:{textDocuments:[doc],openTextDocument:async()=>{documentOpened();return doc;},onDidChangeTextDocument:fn=>(change=fn,{dispose(){}})},
    window:{showErrorMessage:async m=>warnings.push(m),showWarningMessage:async m=>warnings.push(m),showInformationMessage:async()=>{},
      createWebviewPanel:()=>{const panel={reveals:0,reveal(){this.reveals++;},onDidDispose(fn){this.closed=fn;},dispose(){this.closed();},
        webview:{postMessage:async m=>messages.push(m),onDidReceiveMessage(fn){panel.receive=fn;return {dispose(){}};}}};panels.push(panel);return panel;}}};
  const run=async(key,action,input)=>{calls.push({key,action,input});
    if(action==='read')return {content,sourceHash:'h',metadata:{sourceType:'page',pageId:'P1'}};
    if(action==='designer-context'){contextStarted();await contextGate;return {rootUrl:'https://example.invalid',accessToken:'x',user:{}};}
    throw Error(action);
  };
  const ui={ensureWorkspace:async()=>({checkoutPath:'/checkout'}),updateScm:async()=>{}};
  const editorState={assertNoConflictingDrafts(){},assertNoDirtyDocumentsExcept(){},setDraft:async(...args)=>drafts.push(args),flush:async()=> 'token'};
  const options={vscode,run,ui,key:'projects.a',sourcePath:'page.json',editorState,panels:new Map()};
  return {options,panels,calls,warnings,drafts,messages,doc,started,opened,releaseContext,changed:()=>change({document:doc})};
}
test('designer shares concurrent opens and retains a stale panel until the user closes it',async()=>{
  const f=fixture(),a=openDesigner(f.options),b=openDesigner(f.options);await f.started;
  assert.deepEqual(f.calls.map(x=>x.action),['read','designer-context']);
  f.releaseContext();const [first,second]=await Promise.all([a,b]);assert.equal(first,second);assert.equal(f.panels.length,1);assert.equal(first.reveals,1);
  f.doc.isDirty=true;f.changed();await openDesigner(f.options);assert.equal(first.reveals,2);assert.match(f.warnings.at(-1),/关闭并重新打开/);
  await first.receive({type:'save',path:'page.json',version:1,text:JSON.stringify({fileName:'page.json',xml:'{"pageId":"P1"}'})});
  assert.equal(f.calls.some(x=>x.action==='write'),false);assert.ok(f.messages.some(x=>x.type==='stale'));
  first.dispose();f.doc.isDirty=false;await openDesigner(f.options);assert.equal(f.panels.length,2);assert.equal(f.drafts.filter(x=>x[3]===true).length,2);
});
test('designer rejects an editor changed while authentication is in flight',async()=>{
  const f=fixture(),opening=openDesigner(f.options);await f.opened;await Promise.resolve();f.doc.version++;f.releaseContext();
  await assert.rejects(opening,/编辑器内容与磁盘不一致/);assert.equal(f.panels.length,0);assert.equal(f.options.panels.size,0);
});
test('minimal and identity-mismatched pages open readonly even when online session fails',async()=>{
  for(const contentState of ['METADATA_ONLY','IDENTITY_MISMATCH','UNSUPPORTED']) {
    const f=fixture(),shown=[];f.options.ui.openReadonly=async(...args)=>shown.push(args);
    f.options.run=async(_key,action)=>{if(action==='read')return {content:'raw',contentState};throw Error('offline');};
    await openDesigner(f.options);assert.deepEqual(shown,[['projects.a','page.json','raw']]);assert.equal(f.panels.length,0);assert.equal(f.options.panels.size,0);
  }
});
test('different workspaces and source identities get separate panels',async()=>{
  const f=fixture();f.releaseContext();await openDesigner(f.options);
  const other={...f.options,key:'projects.b'};await openDesigner(other);
  assert.equal(f.panels.length,2);assert.equal(f.options.panels.size,2);
});
test('concurrent save messages cannot start a second write while validation is pending',async()=>{
  const f=fixture(),hash=text=>require('node:crypto').createHash('sha256').update(text).digest('hex');
  let releaseRead,readStarted,reads=0,writes=0,current='{"pageId":"P1"}',currentHash='h';
  const started=new Promise(resolve=>{readStarted=resolve;});
  f.options.run=async(_key,action,input)=>{
    if(action==='designer-context')return {rootUrl:'https://example.invalid',accessToken:'x',user:{}};
    if(action==='read') {reads++;if(reads===2){readStarted();await new Promise(resolve=>{releaseRead=resolve;});}return {content:current,sourceHash:currentHash,metadata:{sourceType:'page',pageId:'P1'}};}
    if(action==='write'){writes++;current=input.content;currentHash=hash(current);return {sourceHash:currentHash};}
    throw Error(action);
  };
  const panel=await openDesigner(f.options),message={type:'save',path:'page.json',version:1,text:JSON.stringify({fileName:'page.json',xml:'{"pageId":"P1","name":"new"}'})};
  const first=panel.receive(message);await started;await panel.receive(message);assert.match(f.warnings.at(-1),/正在处理上一次保存/);
  releaseRead();await first;assert.equal(writes,1);assert.equal(f.messages.some(x=>x.type==='stale'),false);
  const second={...message,text:JSON.stringify({fileName:'page.json',xml:'{"pageId":"P1","name":"again"}'})};
  await panel.receive(second);assert.equal(writes,2);assert.equal(f.messages.at(-1).text,current);assert.equal(f.messages.at(-1).type,'saved-baseline');assert.equal(f.messages.filter(x=>x.type==='document').length,0);panel.dispose();
});

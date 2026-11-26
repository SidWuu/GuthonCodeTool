const test=require('node:test');
const assert=require('node:assert/strict');
const {SourceDiffProvider,SCHEME}=require('../src/api/source-diff');
const {ApiSourceUI}=require('../src/api/source-ui');

function fixture(run) {
  const commands=[],messages=[],providers=new Map();let close,disposed=false;
  const vscode={Uri:{from:value=>value},workspace:{textDocuments:[],
    registerTextDocumentContentProvider:(scheme,provider)=>(providers.set(scheme,provider),{dispose(){disposed=true;}}),
    onDidCloseTextDocument:fn=>(close=fn,{dispose(){}})},
    commands:{executeCommand:async(...args)=>commands.push(args)},
    window:{showInformationMessage:async(...args)=>(messages.push(args),undefined),showWarningMessage:async(...args)=>messages.push(args),showErrorMessage:async(...args)=>messages.push(args)}};
  return {vscode,commands,messages,providers,close:doc=>close(doc),disposed:()=>disposed,ui:new ApiSourceUI({vscode,run})};
}
function backend(before,after,options={}) {
  const left=[...before],right=[...after];
  return async(key,action,input)=>{
    assert.equal(key,'products.MixedCase');assert.equal(action,options.conflict?'conflict':'diff');
    const {offset,maxChars}=input,end=offset+maxChars,total=Math.max(left.length,right.length);
    return {path:input.path,offset,sourceHash:'source',...(options.conflict?{remoteHash:'remote'}:{baseHash:'base'}),sourceType:'page',readonly:true,
      view:input.view==='raw'?'raw':'readable',language:input.view==='raw'?'xml':'markdown',message:'',
      before:left.slice(offset,end).join(''),after:right.slice(offset,end).join(''),totalBeforeChars:left.length,totalAfterChars:right.length,
      truncated:end<total,nextOffset:end<total?end:null,...(options.change?.(input) || {})};
  };
}
test('reads complete Unicode pages into immutable readonly documents and disposes them',async()=>{
  const a='😀'.repeat(100001),b='汉'.repeat(50004),calls=[];
  const run=backend(a,b);const f=fixture(async(...args)=>(calls.push(args[2]),run(...args)));
  await f.ui.diff('products.MixedCase','systems/P.xml');
  assert.deepEqual(calls.map(x=>x.offset),[0,50000,100000]);
  const [command,left,right,title]=f.commands[0];assert.equal(command,'vscode.diff');assert.equal(left.scheme,SCHEME);assert.match(title,/可读/);
  const provider=f.providers.get(SCHEME);assert.equal(provider.provideTextDocumentContent(left),a);assert.equal(provider.provideTextDocumentContent(right),b);
  assert.equal(provider.writeFile,undefined);f.close({uri:left});assert.throws(()=>provider.provideTextDocumentContent(left),/已关闭/);
  f.ui.dispose();assert.equal(f.disposed(),true);assert.throws(()=>provider.provideTextDocumentContent(right),/已关闭/);
});
test('rejects mixed hashes, bad pagination, and mismatch with upload snapshot',async()=>{
  for(const change of [input=>input.offset?{baseHash:'changed'}:{},input=>input.offset?{sourceHash:'changed'}:{},input=>input.offset?{nextOffset:0}:{}]) {
    const f=fixture(backend('x'.repeat(50001),'y',{change}));
    await assert.rejects(f.ui.diff('products.MixedCase','x.xml'),/变化|不完整/);assert.equal(f.commands.length,0);f.ui.dispose();
  }
  const f=fixture(backend('x','y'));await assert.rejects(f.ui.diff('products.MixedCase','x.xml','different'),/变化/);assert.equal(f.commands.length,0);f.ui.dispose();
});
test('conflict diff rejects a changed platform snapshot on a later page before opening the editor',async()=>{
  const f=fixture(backend('x','汉'.repeat(50001),{
    conflict:true,change:input=>input.offset?{remoteHash:'new-platform'}:{},
  }));
  await assert.rejects(f.ui.diffProvider.open('products.MixedCase','x.xml',{
    expectedSourceHash:'source',expectedRemoteHash:'remote',
  }),/平台冲突版本已变化/);
  assert.equal(f.commands.length,0);
  f.ui.dispose();
});
test('raw choice stays bound to the reviewed hashes and fallback explains itself',async()=>{
  const calls=[];let resolveChoice;
  const f=fixture(async(...args)=>(calls.push(args[2]),backend('a','b')(...args)));
  f.vscode.window.showInformationMessage=()=>new Promise(resolve=>{resolveChoice=resolve;});
  await f.ui.diff('products.MixedCase','x.xml');resolveChoice('查看原始源码对比');await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.map(c=>c.view),['auto','raw']);assert.equal(f.commands.length,2);f.ui.dispose();
  const g=fixture(backend('a','b',{change:()=>({view:'raw',language:'xml',message:'PAGE 投影失败'})}));
  await g.ui.diff('products.MixedCase','x.xml');assert.match(g.messages[0][0],/投影失败/);g.ui.dispose();
});
test('raw choice rejects changed source or baseline',async()=>{
  let resolveChoice;
  const run=backend('a','b',{change:input=>input.view==='raw'?{baseHash:'changed'}:{}});
  const f=fixture(run);f.vscode.window.showInformationMessage=()=>new Promise(resolve=>{resolveChoice=resolve;});
  await f.ui.diff('products.MixedCase','x.xml');resolveChoice('查看原始源码对比');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.commands.length,1);assert.match(f.messages[0][0],/变化/);f.ui.dispose();
});
test('upload review compares the selected source against its original snapshot',async()=>{
  const diff=backend('old','new');const actions=[];
  const f=fixture(async(key,action,input)=>{
    actions.push(action);
    if(action==='status')return {checkoutPath:'/checkout',files:[{path:'x.xml',state:'MODIFIED'}]};
    if(action==='read')return {sourceHash:'different-snapshot',readonly:false,metadata:{sourceType:'page'}};
    if(action==='diff')return diff(key,action,input);
    throw Error(action);
  });
  f.ui.reviewUpload=async(_v,_entries,openDiff)=>{await openDiff('x.xml');return ['x.xml'];};
  await assert.rejects(f.ui.upload('products.MixedCase'),/变化/);
  assert.equal(f.commands.length,0);assert.equal(actions.includes('upload'),false);f.ui.dispose();
});

test('missing workspace APIs leave unrelated UI usable while diff fails explicitly',async()=>{
  const ui=new ApiSourceUI({vscode:{},run:async()=>{throw Error('must not run');}});
  await assert.rejects(ui.diff('products.MixedCase','x.xml'),/只读差异文档不可用/);
  ui.dispose();
});

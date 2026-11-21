const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const file=path.join(__dirname,'../src/extension.js'),nativeRequire=createRequire(file),messages=[];
const vscode={CompletionItemKind:{Function:1,Class:2,Snippet:3},
  Range:class {constructor(...args){this.args=args;}},CompletionItem:class {constructor(label,kind){Object.assign(this,{label,kind});}},
  MarkdownString:class {constructor(value){this.value=value;}},SnippetString:class {constructor(value){this.value=value;}},
  window:{createOutputChannel:()=>({appendLine:line=>messages.push(line)})},
  workspace:{getConfiguration:()=>({get:(_key,fallback)=>fallback})}};
const loaded={exports:{}};
vm.runInNewContext(fs.readFileSync(file,'utf8'),{require:name=>name==='vscode'?vscode:nativeRequire(name),module:loaded,exports:loaded.exports,process,console,Buffer,setTimeout,clearTimeout},{filename:file});
const {createProvider}=loaded.exports,context={extensionPath:path.join(__dirname,'..')};
function document(word,languageId='guthon-gss') {return {languageId,version:1,uri:{scheme:'file',fsPath:'/fixture/source.gss'},lineAt:()=>({text:word})};}
const ref={language:'java',apiPath:'$vs.ai.textTranslation',prefix:'$vs.ai.textTranslation',signature:'$vs.ai.textTranslation($text:string,$toLang:string):string',body:'$vs.ai.textTranslation(text,toLang)'};
test('one provider combines API sources and preserves overload snippets after deduplication',async()=>{
  const provider=createProvider(context,async()=>[ref,{...ref,signature:'$vs.ai.textTranslation($text:string):string',body:'$vs.ai.textTranslation(text)'}]);
  const word='$vs.ai.',items=await provider.provideCompletionItems(document(word),{line:0,character:word.length});
  assert.equal(items.length,6);assert.equal(items.filter(x=>x.detail===ref.apiPath).length,3);
  assert.equal(items.filter(x=>x.detail===ref.apiPath&&x.insertText.value.includes('${2:')&&!x.insertText.value.includes('${3:')).length,1);
  assert.ok(items.every(x=>x.range.args[1]===0));
  const snippets=await provider.provideCompletionItems(document('tryCatchFinally'),{line:0,character:15});
  assert.ok(snippets.some(x=>x.insertText.value.includes('#try')));
});
test('reference languages stay isolated and standalone or routed shortcuts still work',async()=>{
  const provider=createProvider(context,async()=>[{...ref,language:'javascript'}]);
  const word='$vs.ai.',items=await provider.provideCompletionItems(document(word),{line:0,character:word.length});assert.equal(items.length,5);
  const standalone=createProvider(context);
  for(const [word,language] of [['gu.trim','javascript'],['sqltools','guthon-gss'],['db.list','guthon-gss']])
    assert.ok((await standalone.provideCompletionItems(document(word,language),{line:0,character:word.length})).length,word);
});
test('cancelled or edited documents discard stale asynchronous completions',async()=>{
  let finish;const provider=createProvider(context,()=>new Promise(resolve=>finish=resolve)),doc=document('$vs.ai.');
  const pending=provider.provideCompletionItems(doc,{line:0,character:7});doc.version++;finish([ref]);assert.equal((await pending).length,0);
  const cancelled=provider.provideCompletionItems(doc,{line:0,character:7},{isCancellationRequested:true});finish([ref]);assert.equal((await cancelled).length,0);
});
test('reference errors retain bundled completions and identify the unavailable source',async()=>{
  const provider=createProvider(context,async()=>{throw Error('reference unavailable');});
  assert.equal((await provider.provideCompletionItems(document('$vs.ai.'),{line:0,character:7})).length,5);
  assert.ok(messages.some(x=>x.includes('reference unavailable')));
});

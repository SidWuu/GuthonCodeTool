const test=require('node:test');const assert=require('node:assert/strict');const {ApiQuickDiff,documentWithLineChanges}=require('../src/source/quick-diff');
test('quick diff reads exact API baseline for checkout files and PAGE code fragments',async()=>{
  const vscode={workspace:{textDocuments:[]},Uri:{from:o=>({...o,toString(){return JSON.stringify(o);}})}};
  const ui={scmGenerations:new Map()},editorState={workspaces:new Map([['projects.a',{root:'/checkout'}]]),documentPath:(_key,_state,doc)=>doc.uri.fsPath?.replace('/checkout/','')};
  const provider=new ApiQuickDiff({vscode,ui,editorState,run:async()=>({before:JSON.stringify({sql:'select 1'})})});
  const physical=await provider.provideOriginalResource({scheme:'file',fsPath:'/checkout/page.json'});assert.equal(provider.provideTextDocumentContent(physical),'{"sql":"select 1"}');
  const fragment=await provider.provideOriginalResource({scheme:'guthon-api-edit',authority:'projects.a',query:'path=page.json&pointer=%2Fsql'});
  assert.equal(provider.provideTextDocumentContent(fragment),'select 1');provider.dispose();
});
test('quick diff discards an older response after SCM status changes',async()=>{
  let release;const vscode={workspace:{textDocuments:[]},Uri:{from:o=>o}},ui={scmGenerations:new Map([['projects.a',1]])};
  const editorState={workspaces:new Map([['projects.a',{}]]),documentPath:()=> 'a.gss'};
  const provider=new ApiQuickDiff({vscode,ui,editorState,run:async()=>new Promise(resolve=>{release=resolve;})});
  const pending=provider.provideOriginalResource({scheme:'file',fsPath:'/checkout/a.gss'});ui.scmGenerations.set('projects.a',2);release({before:'old'});
  assert.equal(await pending,undefined);provider.dispose();
});
test('reverting one difference retains all other edited blocks',()=>{
  class Range{constructor(a,b,c,d){this.start={line:a,character:b};this.end={line:c,character:d};}}
  function doc(text){const lines=text.split('\n'),offsets=[];let offset=0;for(const line of lines){offsets.push(offset);offset+=line.length+1;}
    return {lineCount:lines.length,lineAt:i=>({range:{end:{character:lines[i].length}}}),getText:r=>text.slice(offsets[r.start.line]+r.start.character,r.end.line>=lines.length?text.length:offsets[r.end.line]+r.end.character)};}
  const original=doc('one\ntwo\nthree\nfour\n'),modified=doc('ONE\ntwo\nTHREE\nfour\n');
  const changes=[{originalStartLineNumber:1,originalEndLineNumber:1,modifiedStartLineNumber:1,modifiedEndLineNumber:1},
    {originalStartLineNumber:3,originalEndLineNumber:3,modifiedStartLineNumber:3,modifiedEndLineNumber:3}];
  assert.equal(documentWithLineChanges({Range},original,modified,changes,0),'one\ntwo\nTHREE\nfour\n');
});
test('XML PAGE quick diff requires a hash-bound baseline projection',async()=>{
  const vscode={workspace:{textDocuments:[]},Uri:{from:o=>({...o,toString(){return JSON.stringify(o);}})}},ui={scmGenerations:new Map()},editorState={workspaces:new Map()};
  let mismatch=false;const provider=new ApiQuickDiff({vscode,ui,editorState,run:async(_key,action,input)=>{
    if(action==='diff')return {before:'<page/>',baseHash:'base',sourceHash:'current'};
    if(input.action==='open')return {sourceHash:'current'};
    return {baseHash:mismatch?'other':'base',baseSourceText:'{"sql":"select 1"}'};}});
  const resource={scheme:'guthon-api-edit',authority:'projects.a',query:'path=page.xml&pointer=%2Fsql'};
  const original=await provider.provideOriginalResource(resource);assert.equal(provider.provideTextDocumentContent(original),'select 1');
  mismatch=true;assert.equal(await provider.provideOriginalResource(resource),undefined);provider.dispose();
});

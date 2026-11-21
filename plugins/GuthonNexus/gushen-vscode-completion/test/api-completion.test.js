const test=require('node:test');
const assert=require('node:assert/strict');
const catalog=require('../data/official-api.json');
const {enrichCompletionData}=require('../src/api-completion');
const {filterItems,itemLabel,itemDocumentation,itemBodyToSnippet,shouldProvideApiCompletions,getCurrentWord}=require('../src/rules');
const legacy={java:[{prefix:'shortcut.invoke',group:'proc',body:'$vs.proc.invoke(alias,fun,args)',description:'保留的说明'},
  {prefix:'custom.keep',body:'custom.keep(value)',group:'custom'}],javascript:[{prefix:'js.keep',body:'gUtil.keep(value)'}],sql:[{prefix:'sql.keep',body:'KEEP()'}]};
const data=enrichCompletionData(legacy,catalog);
const route={source:'java'};
test('official provenance and signature documentation are explicit',()=>{
  assert.equal(catalog.source.version,'1.0.10');
  const item=data.java.find(x=>x.apiPath==='$vs.proc.invoke'&&x.signature);
  assert.equal(item.completionKind,'function');assert.ok(itemLabel(item).label.includes('('));
  assert.match(itemDocumentation(item),/\$vs\.proc\.invoke/);assert.match(itemDocumentation(item),/保留的说明/);
  assert.ok(item.aliases.includes('shortcut.invoke'));
});
test('root and namespace completion show direct children rather than all functions',()=>{
  assert.equal(filterItems(data,route,'$').length,1);
  assert.equal(filterItems(data,route,'$vs').length,1);
  const modules=filterItems(data,route,'$vs.');
  assert.ok(modules.length>20);assert.ok(modules.every(x=>x.completionKind==='module'));
  const methods=filterItems(data,route,'$vs.proc.');
  assert.ok(methods.length>20);assert.ok(methods.every(x=>x.apiPath.startsWith('$vs.proc.')));
});
test('quick function names and legacy shortcut inputs remain available',()=>{
  for(const word of ['invoke','proc','shortcut.invoke'])
    assert.ok(filterItems(data,route,word).some(x=>x.apiPath==='$vs.proc.invoke'),word);
  assert.ok(data.java.some(x=>x.prefix==='custom.keep'));
  assert.deepEqual(data.javascript,legacy.javascript);assert.deepEqual(data.sql,legacy.sql);
});
test('qualified replacement uses one full call and parameter tab stops',()=>{
  const item=filterItems(data,route,'$vs.proc.').find(x=>x.apiPath==='$vs.proc.invoke');
  const typed='$vs.proc.';const word=getCurrentWord(typed,typed.length);
  assert.equal(word,typed);
  const snippet=itemBodyToSnippet(item.body);
  assert.equal((snippet.match(/vs\.proc\.invoke/g)||[]).length,1);
  assert.ok(snippet.includes('${1:'));
});
test('official qualified inputs are accepted without completing unrelated variables',()=>{
  for(const input of ['$','$vs','$vs.','$vs.proc.','invoke'])assert.equal(shouldProvideApiCompletions(input),true,input);
  for(const input of ['$user','$vm','', '...'])assert.equal(shouldProvideApiCompletions(input),false,input);
});

test('API workspace actions never route to old database pull or Workcopy',()=>{
  const {workspaceActions}=require('../src/tool-workspace');
  const actions=workspaceActions({sourceMode:'api'});
  assert.ok(actions.source.some(x=>x[1]==='gushenCompletion.pullApiSource'));
  assert.equal(Object.hasOwn(actions,'workcopy'),false);
  assert.equal(actions.source.some(x=>x[1]==='gushenCompletion.initSourceIndex'),false);
  const {workspaceCockpit}=require('../src/workspace-assistant');
  assert.equal(workspaceCockpit({sourceMode:'api'}).rows.some(x=>x.command==='gushenCompletion.initSourceIndex'),false);
});
test('API source mode is explicit and labelled independently of execution mode',()=>{
  const {normalizeSourceMode,sourceModeLabel}=require('../src/source-mode');
  assert.equal(normalizeSourceMode('API'),'api');assert.equal(sourceModeLabel('api'),'API');
});

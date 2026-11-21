const assert=require('node:assert/strict');const test=require('node:test');const {searchPickItems,workspaceCockpit}=require('../src/workspace-assistant');
test('API workspace exposes source status and index actions',()=>{
  const ready=workspaceCockpit({sourceMode:'api',index:{ready:true}});
  assert.equal(ready.description,'索引可用');assert.equal(ready.rows[0].command,'gushenCompletion.searchWorkspace');
  assert.equal(ready.rows[1].command,'gushenCompletion.showApiStatus');
  const pending=workspaceCockpit({sourceMode:'api',index:{ready:false}});
  assert.equal(pending.description,'索引待建立');assert.equal(pending.rows[0].command,'gushenCompletion.reindexCalls');
});
test('search picks retain exact source identity',()=>{
  const identity={path:'systems/S/pages/page.json',sourceType:'page'};
  const picks=searchPickItems({items:[{label:'页面',description:'path',detail:'evidence',identity}]});
  assert.equal(picks[0].label,'页面');assert.deepEqual(picks[0].item.identity,identity);
});

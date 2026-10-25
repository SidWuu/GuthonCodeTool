const test=require('node:test');const assert=require('node:assert/strict');const {quickOpenSource}=require('../src/svn/quick-open');
const {quickPickFixture,waitFor}=require('./quick-pick-fixture');
test('one workspace opens the exact indexed candidate without extra workspaces/action prompts',async()=>{
 const f=quickPickFixture();let opened;const identity={sourceType:'procedure',sourceId:'same',funId:'save',sourceNamespace:'ns-two',workingCopyId:'wc-two'};
 f.vscode.window.activeTextEditor={selection:{isEmpty:false},document:{getText:()=> 'selectedName'}};
 const pending=quickOpenSource({vscode:f.vscode,listWorkspaces:async()=>[{workspaceKey:'products.demo',displayName:'demo'}],
  search:async(key,query)=>{assert.equal(key,'products.demo');assert.equal(query,'selectedName');return {items:[{kind:'source',label:'source',identity}]};},open:async value=>{opened=value;}});
 await waitFor(()=>f.picker.items.length);f.accept();await pending;
 assert.deepEqual(opened,{workspaceKey:'products.demo',...identity});
});

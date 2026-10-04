const test=require('node:test');const assert=require('node:assert/strict');const {quickOpenSource}=require('../src/svn/quick-open');
test('one workspace opens the exact indexed candidate without extra workspaces/action prompts',async()=>{
 let picks=0;let opened;const identity={sourceType:'procedure',sourceId:'same',funId:'save',sourceNamespace:'ns-two',workingCopyId:'wc-two'};
 const vscode={window:{activeTextEditor:{selection:{isEmpty:false},document:{getText:()=> 'selectedName'}},showInputBox:async options=>{assert.equal(options.value,'selectedName');return options.value;},showQuickPick:async items=>{picks+=1;return items[0];}}};
 await quickOpenSource({vscode,listWorkspaces:async()=>[{workspaceKey:'products.demo',displayName:'demo'}],search:async()=>({items:[{kind:'source',label:'source',identity}]}),open:async value=>{opened=value;}});
 assert.equal(picks,1);assert.deepEqual(opened,{workspaceKey:'products.demo',...identity});
});

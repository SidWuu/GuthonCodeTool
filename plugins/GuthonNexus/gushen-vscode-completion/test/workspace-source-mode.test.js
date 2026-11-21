const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {changeWorkspaceSourceMode,upgradeLegacyConfiguration}=require('../src/workspace-source-mode');

test('resetting an old project requires explicit platform confirmation before any cleanup',async()=>{
  const root=path.resolve('fixture'),checkout=path.join(root,'checkout'),docs=path.join(root,'docs');
  const planId='a'.repeat(64),staged=path.join(root,'.checkout.guthon-api-'+planId.slice(0,16));
  const calls=[];
  let accept=false;
  const vscode={Uri:{file:target=>target},workspace:{fs:{delete:async(target,options)=>calls.push({target,options})}},
    window:{showWarningMessage:async(message,options,action)=>{
      assert.equal(message,'是否确认已将源码改动同步到谷神平台？');
      assert.ok(options.detail.includes(checkout) && options.detail.includes(docs));
      return accept?action:undefined;
    }}};
  const workspace={workspaceKey:'old-project',sourceMode:'svn',name:'旧项目',root};
  const input={workspaceKey:workspace.workspaceKey,expectedMode:'svn',sourceMode:'api'};
  const run=()=>changeWorkspaceSourceMode({vscode,workspace,sourceMode:'api',assertReady:()=>{},
    request:async value=>{
      calls.push(value);
      return value.checkOnly
        ? {workspaceKey:input.workspaceKey,sourceMode:'api',requiresReset:true,planId,paths:[checkout],docsPath:docs}
        : {workspaceKey:input.workspaceKey,sourceMode:'api',changed:true,trashPaths:[staged]};
    }});
  assert.equal(await run(),undefined);
  assert.deepEqual(calls.splice(0),[{...input,checkOnly:true}]);
  accept=true;
  assert.deepEqual((await run()).retained,[]);
  assert.deepEqual(calls,[{...input,checkOnly:true},{...input,planId},
    {target:staged,options:{recursive:true,useTrash:true}}]);
});

test('YAML configuration upgrade uses its reviewed plan and separate confirmation',async()=>{
  const calls=[],root=path.resolve('fixture'),workspace={workspaceKey:'old-project',root};
  const planId='a'.repeat(64);
  let accept=false;
  const options={workspace,assertReady:()=>{},vscode:{window:{showWarningMessage:async(_message,_options,action)=>accept?action:undefined}},
    client:{run:async(_key,command,args)=>{
      calls.push([command,...args]);
      return args[0]==='plan'?{phase:'PREVIEW',planId,target:path.join(root,'guthon.json'),workspaces:[workspace]}:{phase:'PUBLISHED'};
    }}};
  assert.equal(await upgradeLegacyConfiguration(options),false);
  assert.deepEqual(calls.splice(0),[['configuration-upgrade','plan']]);
  accept=true;
  assert.equal(await upgradeLegacyConfiguration(options),true);
  assert.deepEqual(calls,[['configuration-upgrade','plan'],['configuration-upgrade','apply','--offline','--confirm',planId]]);
});

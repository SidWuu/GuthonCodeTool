const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {assertWorkspaceSaved,deleteWorkspace}=require('../src/workspace-delete');

test('dirty project files, provider documents and page drafts block project deletion',()=>{
  const root=path.resolve('projects','fixture');
  const workspace={root,workspaceKey:'fixture',sourceRoots:[{path:path.resolve('external','checkout')}]};
  const editorState={drafts:new Map()};
  const vscode={workspace:{textDocuments:[],notebookDocuments:[]}};
  for(const uri of [
    {scheme:'file',fsPath:path.join(root,'docs','notes.md')},
    {scheme:'file',fsPath:path.resolve('external','checkout','source.gss')},
    {scheme:'guthon-database-edit',authority:'fixture'},
    {scheme:'guthon-svn-edit',authority:'fixture'},
  ]) {
    vscode.workspace.textDocuments=[{uri,isDirty:true}];
    assert.throws(()=>assertWorkspaceSaved(vscode,workspace,editorState),/未保存/);
  }
  vscode.workspace.textDocuments=[{isDirty:true,uri:{scheme:'file',fsPath:path.join(root+'-other','notes.md')}}];
  assert.doesNotThrow(()=>assertWorkspaceSaved(vscode,workspace,editorState));
  editorState.drafts.set('page',{key:'fixture',dirty:true});
  assert.throws(()=>assertWorkspaceSaved(vscode,workspace,editorState),/未保存/);
  editorState.drafts.clear();
  assert.throws(()=>assertWorkspaceSaved(vscode,workspace,editorState,{hasUnsavedDrafts:()=>true}),/未保存/);
});

test('project deletion verifies confirmation and moves the directory before unregistering',async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-trash-test-'));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const root=path.join(temp,'project'),trash=path.join(temp,'trash');
  fs.mkdirSync(root);
  const workspaceKey='fixture',planId='a'.repeat(64),calls=[];
  let decision,stale=false,becameDirty=false,dirtyOnConfirm=false;
  const vscode={Uri:{file:value=>value},workspace:{fs:{delete:async(target,options)=>{
    assert.equal(target,root);
    assert.deepEqual(options,{recursive:true,useTrash:true});
    fs.renameSync(target,trash);
    calls.push('trash');
  }}},window:{
    showWarningMessage:async(_message,options,button)=>{
      assert.equal(button,'确认删除');
      assert.ok(options.detail.includes(root));
      becameDirty=dirtyOnConfirm;
      return decision;
    },
    showErrorMessage:async message=>calls.push(message),
    showInformationMessage:async()=>calls.push('success'),
  }};
  const run=()=>deleteWorkspace({vscode,workspace:{workspaceKey,root},
    request:async payload=>{
      calls.push(payload);
      if(stale && payload.planId)throw new Error('登记已变化');
      return {workspaceKey,planId,paths:[root],retainedPaths:[],displayName:'fixture'};
    },
    assertSaved:()=>{if(becameDirty)throw new Error('未保存');},
    assertTool:()=>{},refresh:async()=>calls.push('refresh'),
  });
  assert.equal(await run(),false);
  assert.deepEqual(calls.splice(0),[{workspaceKey,checkOnly:true}]);
  assert.ok(fs.existsSync(root));
  decision='确认删除';
  dirtyOnConfirm=true;
  await run();
  assert.match(calls.pop(),/未保存/);
  assert.deepEqual(calls.splice(0),[{workspaceKey,checkOnly:true}]);
  assert.ok(fs.existsSync(root));
  becameDirty=dirtyOnConfirm=false;
  stale=true;
  await run();
  assert.match(calls.pop(),/登记已变化/);
  assert.ok(fs.existsSync(root));
  calls.length=0;
  stale=false;
  await run();
  assert.deepEqual(calls,[{workspaceKey,checkOnly:true},{workspaceKey,checkOnly:true,planId},'trash',
    {workspaceKey,checkOnly:false,planId},'refresh','success']);
  assert.ok(fs.existsSync(trash));
});

test('a missing project directory can be unregistered and a restored directory requires a new preview',async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-missing-delete-test-'));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const root=path.join(temp,'project'),retained=path.join(temp,'external-docs');
  const workspaceKey='fixture',planId='a'.repeat(64),calls=[];
  let restoreOnConfirm=true;
  const vscode={workspace:{fs:{delete:async()=>assert.fail('unexpected trash operation')}},window:{
    showWarningMessage:async(_message,{detail},button)=>{
      assert.match(detail,/目录已不存在.*移除项目登记/);
      assert.ok(detail.includes(root));
      assert.ok(detail.includes(retained));
      if(restoreOnConfirm)fs.mkdirSync(root);
      return button;
    },
    showErrorMessage:async message=>calls.push(message),
    showInformationMessage:async message=>calls.push(message),
  }};
  const run=()=>deleteWorkspace({vscode,workspace:{workspaceKey,root},
    request:async payload=>{
      calls.push(payload);
      return {workspaceKey,planId,paths:[root],retainedPaths:[retained],displayName:'fixture'};
    },
    assertSaved:()=>{},assertTool:()=>{},refresh:async()=>calls.push('refresh'),
  });
  await run();
  assert.match(calls.pop(),/重新出现.*重新预览/);
  assert.deepEqual(calls.splice(0),[{workspaceKey,checkOnly:true},{workspaceKey,checkOnly:true,planId}]);
  assert.ok(fs.existsSync(root));
  fs.rmdirSync(root);
  restoreOnConfirm=false;
  await run();
  assert.equal(calls.pop(),'已移除 fixture 的项目登记。');
  assert.deepEqual(calls,[{workspaceKey,checkOnly:true},{workspaceKey,checkOnly:true,planId},
    {workspaceKey,checkOnly:false,planId},'refresh']);
});

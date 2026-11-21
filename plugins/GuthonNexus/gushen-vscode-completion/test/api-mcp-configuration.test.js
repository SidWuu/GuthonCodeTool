const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {configurationFolder,configurationText,generateConfiguration,CLIENTS}=require('../src/api/mcp-configuration');

test('finds only the opened var, workspace root or checkout for MCP configuration',()=>{
  const tool={toolHome:'/fixture'},workspace={spaceRoot:'/fixture/var',root:'/fixture/var/任意',checkoutPath:'/fixture/var/任意/checkout'};
  for(const name of [workspace.spaceRoot,workspace.root,workspace.checkoutPath]) {
    const folder={uri:{scheme:'file',fsPath:name}};
    assert.equal(configurationFolder({workspace:{workspaceFolders:[folder]}},workspace,tool),folder);
  }
  assert.equal(configurationFolder({workspace:{workspaceFolders:[{uri:{scheme:'file',fsPath:'/other'}}]}},workspace,tool),undefined);
  assert.equal(configurationFolder({workspace:{workspaceFolders:[{uri:{scheme:'file',fsPath:'/fixture/var'}}]}},{root:workspace.root},tool).uri.fsPath,'/fixture/var');
});

test('root-window configuration writes to the opened folder and probes the explicit workspace',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-mcp-root-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const spaceRoot=path.join(home,'var');fs.mkdirSync(spaceRoot);let probeKey,preview=0;
  const workspace={workspaceKey:'ws_a',sourceMode:'api',spaceRoot,root:path.join(spaceRoot,'任意'),checkoutPath:path.join(spaceRoot,'任意','checkout')};
  const vscode={workspace:{workspaceFolders:[{uri:{scheme:'file',fsPath:spaceRoot}}],openTextDocument:async()=>({uri:{id:++preview}})},
    window:{showQuickPick:async items=>items===CLIENTS?items[0]:items[0],showWarningMessage:async()=> '合并配置',showInformationMessage:async()=>{}},
    commands:{executeCommand:async()=>{}}};
  await generateConfiguration({vscode,selectWorkspace:async()=>workspace,getTool:async()=>({mode:'packaged',toolPath:'/fixture/tool',toolHome:home}),probe:async(_server,key)=>{probeKey=key;return {sourceMode:'api',workspaceTools:1};}});
  assert.equal(probeKey,'ws_a');assert.ok(fs.existsSync(path.join(spaceRoot,'.mcp.json')));assert.equal(fs.existsSync(path.join(workspace.root,'.mcp.json')),false);
});

test('the backend probe message requires client approval and does not claim the client is connected',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-mcp-approval-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const root=path.join(home,'var');fs.mkdirSync(root);const messages=[];
  const workspace={workspaceKey:'ws_fixture',sourceMode:'database',spaceRoot:root,root:path.join(root,'fixture')};
  const vscode={workspace:{workspaceFolders:[{uri:{scheme:'file',fsPath:root}}],openTextDocument:async()=>({uri:{}})},
    window:{showQuickPick:async items=>items[0],showWarningMessage:async()=> '合并配置',showInformationMessage:async message=>messages.push(message)},
    commands:{executeCommand:async()=>{}}};
  await generateConfiguration({vscode,selectWorkspace:async()=>workspace,getTool:async()=>({mode:'packaged',toolPath:'/fixture/api-tool',toolHome:home}),
    probe:async()=>({sourceMode:'database',workspaceTools:6})});
  assert.match(messages[0],/DATABASE 工作区可用 6 个工具/);assert.match(messages[0],/批准项目 guthon-source-helper 服务/);
  assert(!messages[0].includes('客户端已连接'));
});

test('access levels update a single routing service and preserve the other MCP entries', () => {
  const tool={toolHome:'/fixture',toolPath:'/fixture/tool'};
  for (const client of CLIENTS) {
    const original=JSON.stringify({[client.key]:{other:{command:'/fixture/other'}}});
    const full=configurationText(original,client,tool,false,true);
    assert.deepEqual(full.server.args.slice(-4),['--stdio','--provider','auto','--enable-platform-tools']);
    const writable=configurationText(full.text,client,tool,false);
    assert.deepEqual(writable.server.args.slice(-3),['--stdio','--provider','auto']);
    const readonly=configurationText(writable.text,client,tool,true);
    assert.deepEqual(JSON.parse(readonly.text)[client.key],{other:{command:'/fixture/other'},'guthon-source-helper':readonly.server});
    assert.deepEqual(readonly.server.args.slice(-4),['--stdio','--provider','auto','--read-only']);
  }
  assert.throws(()=>configurationText('{}',CLIENTS[0],tool,true,true),/只读配置不能启用平台工具/);
});

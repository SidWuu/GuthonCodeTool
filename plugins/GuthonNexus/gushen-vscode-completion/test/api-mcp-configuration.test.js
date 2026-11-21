const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {configurationFolder,generateConfiguration,CLIENTS}=require('../src/api/mcp-configuration');

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
  const workspace={workspaceKey:'ws_a',spaceRoot,root:path.join(spaceRoot,'任意'),checkoutPath:path.join(spaceRoot,'任意','checkout')};
  const vscode={workspace:{workspaceFolders:[{uri:{scheme:'file',fsPath:spaceRoot}}],openTextDocument:async()=>({uri:{id:++preview}})},
    window:{showQuickPick:async items=>items===CLIENTS?items[0]:items[0],showWarningMessage:async()=> '合并配置',showInformationMessage:async()=>{}},
    commands:{executeCommand:async()=>{}}};
  await generateConfiguration({vscode,selectWorkspace:async()=>workspace,getTool:async()=>({mode:'packaged',toolPath:'/fixture/tool',toolHome:home}),probe:async(_server,key)=>{probeKey=key;return {tools:1,online:true};}});
  assert.equal(probeKey,'ws_a');assert.ok(fs.existsSync(path.join(spaceRoot,'.mcp.json')));assert.equal(fs.existsSync(path.join(workspace.root,'.mcp.json')),false);
});

test('the backend probe message requires client approval and does not claim the client is connected',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-mcp-approval-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const root=path.join(home,'var');fs.mkdirSync(root);const messages=[];
  const workspace={workspaceKey:'ws_fixture',spaceRoot:root,root:path.join(root,'fixture')};
  const vscode={workspace:{workspaceFolders:[{uri:{scheme:'file',fsPath:root}}],openTextDocument:async()=>({uri:{}})},
    window:{showQuickPick:async items=>items[0],showWarningMessage:async()=> '合并配置',showInformationMessage:async message=>messages.push(message)},
    commands:{executeCommand:async()=>{}}};
  await generateConfiguration({vscode,selectWorkspace:async()=>workspace,getTool:async()=>({mode:'packaged',toolPath:'/fixture/api-tool',toolHome:home}),
    probe:async()=>({tools:36,online:false,onlineError:'fixture login required'})});
  assert.match(messages[0],/后端探测发现 36 个工具/);assert.match(messages[0],/批准项目 guthon-api 服务/);
  assert.match(messages[0],/在线只读检查尚未通过：fixture login required/);assert(!messages[0].includes('客户端已连接'));
});

test('configuration adds the selected legacy MCP service beside the existing API service', () => {
  const {configurationText}=require('../src/api/mcp-configuration');
  const tool={toolHome:'/fixture',toolPath:'/fixture/tool'};
  const original=JSON.stringify({mcpServers:{'guthon-api':{command:'/fixture/api'}}});
  const database=configurationText(original,CLIENTS[0],tool,false,'database');
  assert.deepEqual(database.server.args.slice(-4),['--stdio','--provider','database','--read-only']);
  const svn=configurationText(database.text,CLIENTS[0],tool,true,'svn');
  assert.deepEqual(Object.keys(JSON.parse(svn.text).mcpServers),['guthon-api','guthon-database','guthon-svn']);
  assert.deepEqual(svn.server.args.slice(-4),['--stdio','--provider','svn','--read-only']);
});

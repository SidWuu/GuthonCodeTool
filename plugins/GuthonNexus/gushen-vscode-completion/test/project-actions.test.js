const test=require('node:test'),assert=require('node:assert/strict');
const {showProjectActions,showProjectSettings}=require('../src/api/project-actions');

test('project actions present a short menu and keep rare tools behind named groups',async()=>{
  const calls=[],menus=[],p={workspaceKey:'products.A',name:'A'};
  const vscode={window:{showQuickPick:async items=>{menus.push(items);return items.find(x=>x.label==='导入与导出')||items.find(x=>x.label==='导出本地修改');}},commands:{executeCommand:async(...args)=>calls.push(args)}};
  await showProjectActions({vscode,getWorkspaces:async()=>[p],bridge:{isRunning:()=>false}});
  assert(menus[0].length<=8);assert(!menus[0].some(x=>/yaml|运行模式|工作区/.test(x.label)));
  assert.deepEqual(calls,[['gushenCompletion.exportApiChanges','products.A']]);
});

test('project settings use the existing guided scope entry and cancellation writes nothing',async()=>{
  const calls=[],p={workspaceKey:'products.A',name:'A'};
  const vscode={window:{showQuickPick:async items=>items.find(x=>x.label==='拉取范围')},commands:{executeCommand:async(...args)=>calls.push(args)}};
  await showProjectSettings({vscode,workspace:p,onConfiguration:()=>assert.fail('not selected')});
  assert.deepEqual(calls,[['gushenCompletion.selectApiSystems','products.A']]);
  vscode.window.showQuickPick=async()=>undefined;await showProjectSettings({vscode,workspace:p,onConfiguration:()=>assert.fail('not selected')});assert.equal(calls.length,1);
});

test('single-file migration always previews and cancellation cannot apply changes',async()=>{
  const {showConfiguration}=require('../src/api/project-actions'),calls=[];
  const client={run:async(_key,command,args,input)=>{calls.push({command,input});if(command==='configuration-info')return {mode:'legacy',migrationAvailable:true,path:'/private/config/guthon.json'};if(command==='configuration-migrate'&&input.action==='preview')return {complete:true,planHash:'plan',path:'/private/config/guthon.json',legacyFiles:['/private/config/products.yaml']};assert.fail('must not apply on cancel');}};
  const vscode={window:{showQuickPick:async items=>items.find(x=>x.value==='migrate'),showWarningMessage:async()=>undefined}};
  await showConfiguration({vscode,client,workspace:{workspaceKey:'products.A'}});
  assert.deepEqual(calls.map(x=>x.command),['configuration-info','configuration-migrate']);assert.equal(calls[1].input.action,'preview');
});

test('partially archived migration reports the active file and backup instead of claiming completion',async()=>{
  const {showConfiguration}=require('../src/api/project-actions');let warnings=0,success=0;
  const client={run:async(_key,command,args,input)=>command==='configuration-info'?{mode:'legacy',migrationAvailable:true}:input.action==='preview'?{complete:true,planHash:'p',path:'/private/config/guthon.json',legacyFiles:[]}:{ok:true,complete:false,path:'/private/config/guthon.json',backupPath:'/private/archive',archivePending:['old.yaml']}};
  const vscode={window:{showQuickPick:async items=>items.find(x=>x.value==='migrate'),showWarningMessage:async(message,options)=>{warnings++;if(warnings===1)return '合并配置';assert(message.includes('/private/archive'));assert(options.detail.includes('old.yaml'));},showInformationMessage:async()=>success++}};
  await showConfiguration({vscode,client,workspace:{workspaceKey:'products.A'}});assert.equal(warnings,2);assert.equal(success,0);
});

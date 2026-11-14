const test=require('node:test'),assert=require('node:assert/strict');
const {showProjectActions,showProjectSettings,projectMenuHandler,projectToolHandler,projectDiagnosisHandler}=require('../src/api/project-actions');

test('keyboard fallback presents searchable actions in one grouped picker',async()=>{
  const calls=[],menus=[],p={workspaceKey:'products.A',name:'A'};
  const vscode={QuickPickItemKind:{Separator:-1},window:{showQuickPick:async(items,options)=>{menus.push({items,options});return items.find(x=>x.label==='导出本地修改');}},commands:{executeCommand:async(...args)=>calls.push(args)}};
  await showProjectActions({vscode,getWorkspaces:async()=>[p],bridge:{isRunning:()=>false}});
  assert.equal(menus.length,1);assert.equal(menus[0].options.title,'A · 项目全部操作');assert.equal(menus[0].options.matchOnDescription,true);assert(menus[0].items.some(x=>x.label==='导入与导出'&&x.kind===-1));
  assert(menus[0].items.some(x=>x.label==='启动浏览器增强'));assert(!menus[0].items.some(x=>x.label==='停止浏览器增强'));
  assert.deepEqual(calls,[['gushenCompletion.exportApiChanges','products.A']]);
});
test('keyboard fallback respects project selection and cancellation',async()=>{
  const calls=[],menus=[],items=[{workspaceKey:'products.A',displayName:'A'},{workspaceKey:'projects.B',displayName:'B'}];
  let cancel=false;const vscode={QuickPickItemKind:{Separator:-1},window:{showQuickPick:async choices=>{menus.push(choices);return menus.length%2===1 ? choices.find(x=>x.label==='重建全部索引') : cancel?undefined:choices[1];}},commands:{executeCommand:async(...args)=>calls.push(args)}};
  await showProjectActions({vscode,getWorkspaces:async()=>items,bridge:{isRunning:()=>true}});
  assert.equal(menus.length,2);assert(menus[0].some(x=>x.label==='停止浏览器增强'));assert.deepEqual(calls,[['gushenCompletion.reindexCalls','projects.B']]);
  cancel=true;await showProjectActions({vscode,getWorkspaces:async()=>items,bridge:{isRunning:()=>false}});assert.equal(calls.length,1);
});
test('native project menu and export handlers resolve the current project and preserve explicit identities',async()=>{
  const selected=[],commands=[],tools=[],errors=[];let cancel=false;
  const vscode={commands:{executeCommand:async(...args)=>commands.push(args)},window:{showErrorMessage:async message=>errors.push(message)}};
  const selectWorkspace=async key=>{selected.push(key);if(cancel)return;if(key && key!=='products.A')throw Error('不在当前项目');return {workspaceKey:'products.A'};};
  const menu=projectMenuHandler({vscode,selectWorkspace,command:'showApiIndexDiagnostics'});
  const tool=projectToolHandler({vscode,selectWorkspace,command:'export-schema',runTool:async(...args)=>tools.push(args)});
  await menu({viewId:'gushenCompletion.projectDetails'});await menu('products.A');await tool({viewId:'gushenCompletion.projectDetails'});await tool({workspaceKey:'products.A'});
  assert.deepEqual(selected,['','products.A','','products.A']);assert.deepEqual(commands,[['gushenCompletion.showApiIndexDiagnostics','products.A'],['gushenCompletion.showApiIndexDiagnostics','products.A']]);
  assert.deepEqual(tools,[['export-schema',[],true,'products.A'],['export-schema',[],true,'products.A']]);
  await menu('projects.other');assert.match(errors[0],/不在当前项目/);cancel=true;await tool({viewId:'gushenCompletion.projectDetails'});assert.equal(tools.length,2);
});
test('diagnosis resolves native view context once and never falls back outside the current project',async()=>{
  const selected=[],tools=[],errors=[];let cancel='';
  const vscode={window:{showOpenDialog:async()=>cancel==='file'?undefined:[{fsPath:'/fixture/diagnosis.json'}],showErrorMessage:async message=>errors.push(message)}};
  const selectWorkspace=async key=>{selected.push(key);if(cancel==='project')return;if(key && key!=='products.A')throw Error('不在当前项目');return {workspaceKey:'products.A'};};
  const handler=projectDiagnosisHandler({vscode,selectWorkspace,command:'diagnose',runTool:async(...args)=>tools.push(args)});
  await handler({viewId:'gushenCompletion.projectDetails'});await handler('products.A');
  assert.deepEqual(selected,['','products.A']);assert.deepEqual(tools,[['diagnose',['/fixture/diagnosis.json'],true,'products.A'],['diagnose',['/fixture/diagnosis.json'],true,'products.A']]);
  await handler('projects.B');assert.match(errors[0],/不在当前项目/);cancel='project';await handler({viewId:'gushenCompletion.projectDetails'});cancel='file';await handler('products.A');assert.equal(tools.length,2);
});
test('project view uses one native overflow with a single submenu level and no card-action duplicates',()=>{
  const manifest=require('../package.json'),contributes=manifest.contributes,items=contributes.menus['view/title'].filter(x=>x.when==='view == gushenCompletion.projectDetails');
  assert(items.length>0);assert(items.every(x=>!x.group.startsWith('navigation')));assert(!items.some(x=>x.command==='gushenCompletion.showProjectActions'));
  assert.deepEqual(items.filter(x=>x.submenu).map(x=>x.submenu),['gushenCompletion.projectImportExport','gushenCompletion.projectManagement','gushenCompletion.projectTools']);
  const commands=new Map(contributes.commands.map(x=>[x.command,x]));
  for(const item of items.filter(x=>x.command))assert(commands.get(item.command).shortTitle,item.command);
  for(const item of items.filter(x=>x.submenu))for(const child of contributes.menus[item.submenu]) {assert(!child.submenu);assert(commands.get(child.command).shortTitle,child.command);}
  const listed=items.map(x=>x.command);for(const command of ['searchCurrentApiWorkspace','showApiHistory','selectApiSystems','configureProject','runDoctor'])assert(!listed.includes('gushenCompletion.'+command));
  const bridge=contributes.menus['gushenCompletion.projectTools'].filter(x=>/Bridge$/.test(x.command));
  assert.deepEqual(bridge.map(x=>x.when),['!gushenCompletion.bridgeRunning','gushenCompletion.bridgeRunning']);
  const wrappers=[...commands.keys()].filter(command=>command.startsWith('gushenCompletion.projectMenu'));
  assert.equal(wrappers.length,8);assert.deepEqual(contributes.menus.commandPalette.map(x=>x.command).sort(),wrappers.sort());
  assert(contributes.menus.commandPalette.every(x=>x.when==='false'));assert.equal(commands.get('gushenCompletion.showProjectActions').title,'Guthon Nexus: 项目全部操作');
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

const test=require('node:test'),assert=require('node:assert/strict');
const {showProjectActions,showProjectIndex,projectMenuHandler,projectToolHandler,projectDiagnosisHandler}=require('../src/api/project-actions');

test('keyboard fallback presents searchable actions in one grouped picker',async()=>{
  const calls=[],menus=[],p={workspaceKey:'products.A',name:'A'};
  const vscode={QuickPickItemKind:{Separator:-1},window:{showQuickPick:async(items,options)=>{menus.push({items,options});return items.find(x=>x.label==='选择运行方式');}},commands:{executeCommand:async(...args)=>calls.push(args)}};
  await showProjectActions({vscode,getWorkspaces:async()=>[p],bridge:{isRunning:()=>false}});
  assert.equal(menus.length,1);assert.equal(menus[0].options.title,'A · 项目全部操作');assert.equal(menus[0].options.matchOnDescription,true);assert(!menus[0].items.some(x=>/导入|导出/.test(x.label)));
  assert(menus[0].items.some(x=>x.label==='检查工具组件更新'));
  const labels = menus[0].items.map(x=>x.label);
  assert(labels.indexOf('启动浏览器增强') < labels.indexOf('工具设置'));
  assert(labels.indexOf('团队规则同步') > labels.indexOf('工具设置'));
  assert(labels.indexOf('团队规则同步') < labels.indexOf('检查更新'));
  assert(labels.indexOf('选择更新来源') > labels.indexOf('检查更新'));
  assert.deepEqual(calls,[['gushenCompletion.selectExecutionMode']]);
});
test('keyboard fallback respects project selection and cancellation',async()=>{
  const calls=[],menus=[],items=[{workspaceKey:'products.A',displayName:'A'},{workspaceKey:'projects.B',displayName:'B'}];
  let cancel=false;const vscode={QuickPickItemKind:{Separator:-1},window:{showQuickPick:async choices=>{menus.push(choices);return menus.length%2===1 ? choices.find(x=>x.label==='重建全部索引') : cancel?undefined:choices[1];}},commands:{executeCommand:async(...args)=>calls.push(args)}};
  await showProjectActions({vscode,getWorkspaces:async()=>items,bridge:{isRunning:()=>true}});
  assert.equal(menus.length,2);assert(menus[0].some(x=>x.label==='选择运行方式'));assert.deepEqual(calls,[['gushenCompletion.reindexCalls','projects.B']]);
  cancel=true;await showProjectActions({vscode,getWorkspaces:async()=>items,bridge:{isRunning:()=>false}});assert.equal(calls.length,1);
});
test('runtime settings remain reachable when the current backend fails to load projects',async()=>{
  const calls=[];
  const vscode={QuickPickItemKind:{Separator:-1},window:{showQuickPick:async(items,options)=>{
    assert.match(options.placeHolder,/无法读取项目/);
    assert(!items.some(item=>item.project));
    return items.find(item=>item.command==='selectExecutionMode');
  }},commands:{executeCommand:async(...args)=>calls.push(args)}};
  await showProjectActions({vscode,getWorkspaces:async()=>{throw new Error('debug runtime failed');},bridge:{isRunning:()=>false}});
  assert.deepEqual(calls,[['gushenCompletion.selectExecutionMode']]);
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
test('all three headers use native title actions with global and project submenus separated',()=>{
  const {contributes}=require('../package.json');
  const titleActions=view=>contributes.menus['view/title'].filter(item=>item.when.startsWith('view == gushenCompletion.'+view));
  const items=titleActions('projectDetails'),overview=titleActions('projectOverview'),source=titleActions('sourceView');
  const primary=entries=>entries.filter(item=>item.group.startsWith('navigation')).map(item=>item.command.split('.').at(-1));
  const submenus=entries=>entries.filter(item=>item.submenu).map(item=>item.submenu.split('.').at(-1));
  assert(items.length>0);assert(items.some(x=>x.command==='gushenCompletion.switchWorkspace' && x.group.startsWith('navigation')));assert(!items.some(x=>x.command==='gushenCompletion.showProjectActions'));
  assert.deepEqual(submenus(items),['projectSettings','projectSourceTools']);
  assert.deepEqual(submenus(overview),['toolSettings','updateOptions']);
  assert.deepEqual(primary(overview),['searchProjects','addWorkspace','refreshProjects']);
  const overflowCommands=overview.filter(item=>item.command && !item.group.startsWith('navigation'));
  assert.deepEqual(overflowCommands.map(item=>[item.command,item.when.split(' && ').at(-1)]),[
    ['gushenCompletion.startBridge','!gushenCompletion.bridgeRunning'],
    ['gushenCompletion.stopBridge','gushenCompletion.bridgeRunning'],
  ]);
  assert.deepEqual(primary(source),['locateActiveApiSource','searchCurrentApiWorkspace','refreshAllApiSources','filterApiSources','clearApiSourceFilter','collapseAllSourceNodes']);
  const viewType=name=>contributes.views.guthon.find(view=>view.id==='gushenCompletion.'+name).type || 'tree';
  assert.equal(viewType('projectOverview'),'webview');
  assert.equal(viewType('sourceView'),'webview');
  assert.equal(viewType('projectDetails'),'webview');
  assert(!Object.hasOwn(contributes.configurationDefaults || {},'workbench.view.alwaysShowHeaderActions'));
  const commandsIn = menu => contributes.menus['gushenCompletion.'+menu].map(item=>item.command.replace('gushenCompletion.',''));
  assert.deepEqual(commandsIn('projectSettings'),['projectMenuSourceConnection','projectMenuSvnLoginCache',
    'projectMenuSourceScope','projectMenuConfigureDatabaseDiagnosis','projectMenuReferenceSettings','configureProject',
    'changeWorkspaceSourceMode','projectMenuLogout']);
  assert.deepEqual(commandsIn('projectSourceTools'),['projectMenuSyncModuleParameters','projectMenuSyncPlatformReferences',
    'projectMenuSvnScope','projectMenuSvnRemote']);
  assert.deepEqual(commandsIn('toolSettings'),['selectExecutionMode','setupTool','openToolHome','syncTeamRules']);
  assert.deepEqual(commandsIn('updateOptions'),['checkToolUpdate','checkOfficialUpdate','selectUpdateSource','rollbackOfficialUpdate','rollbackToolUpdate']);
  const commands=new Map(contributes.commands.map(x=>[x.command,x]));
  for(const item of items.filter(x=>x.command))assert(commands.get(item.command).shortTitle,item.command);
  for(const name of ['projectSettings','projectSourceTools','toolSettings','updateOptions']) {
    for(const child of contributes.menus['gushenCompletion.'+name]) {assert(!child.submenu);assert(commands.get(child.command).shortTitle,child.command);}
  }
  const listed=items.map(x=>x.command);for(const command of ['searchCurrentApiWorkspace','showProjectHistory','showProjectIndex','showProjectChecks','reindexCalls'])assert(!listed.includes('gushenCompletion.'+command));
  assert(!contributes.menus['gushenCompletion.projectManagement']);
  assert(!contributes.menus['gushenCompletion.projectImportExport']);
  assert(!contributes.menus['gushenCompletion.projectTools']);
  assert.deepEqual(items.filter(item=>!item.submenu).map(item=>item.command),['gushenCompletion.switchWorkspace',
    'gushenCompletion.openProjectDirectory','gushenCompletion.projectMenuOpenCheckout','gushenCompletion.generateMcpConfiguration',
    'gushenCompletion.migrateProjectDocs']);
  const wrappers=[...commands.keys()].filter(command=>command.startsWith('gushenCompletion.projectMenu'));
  assert.deepEqual(contributes.menus.commandPalette.map(x=>x.command).sort(),
    [...wrappers,'gushenCompletion.exportApiChanges','gushenCompletion.importApiChanges','gushenCompletion.repairApiIndex'].sort());
  assert(contributes.menus.commandPalette.every(x=>x.when==='false'));assert.equal(commands.get('gushenCompletion.showProjectActions').title,'Guthon Nexus: 项目全部操作');
});

test('project index management rebuilds the selected workspace and shows provider-appropriate diagnostics',async()=>{
  for(const sourceMode of ['api','svn','database']) {
    const workspace={workspaceKey:'ws-'+sourceMode,sourceMode,name:'Fixture'};
    const calls=[];
    let pick='重建索引';
    const vscode={window:{showQuickPick:async items=>{
      assert.deepEqual(items.map(item=>item.label),sourceMode==='api'
        ? ['重建索引','查看索引诊断','重试待更新文件'] : ['重建索引','查看索引状态']);
      return items.find(item=>item.label===pick);
    },showTextDocument:async document=>calls.push(JSON.parse(document.content))},
    workspace:{openTextDocument:async document=>document},
    commands:{executeCommand:async(...args)=>calls.push(args)}};
    const client={run:async (key,command)=>{
      assert.equal(key,workspace.workspaceKey);
      assert.equal(command,'index-doctor');
      return {workspaceKey:key,ready:true};
    }};
    await showProjectIndex({vscode,workspace,client});
    assert.deepEqual(calls.shift(),['gushenCompletion.reindexCalls',workspace.workspaceKey]);
    pick=sourceMode==='api'?'查看索引诊断':'查看索引状态';
    await showProjectIndex({vscode,workspace,client});
    assert.deepEqual(calls.shift(),sourceMode==='api'?['gushenCompletion.showApiIndexDiagnostics',workspace.workspaceKey]
      : {workspaceKey:workspace.workspaceKey,ready:true});
  }
});

test('configuration view only reads the current workspace and configuration location',async()=>{
  const {showConfiguration}=require('../src/api/project-actions'),calls=[];let content;
  const client={run:async(key,command,args,input)=>{calls.push({key,command,args,input});return command==='configuration-info'?{path:'/fixture/config/guthon.json'}:{settings:{serverUrl:'https://example.invalid'}};}};
  const vscode={workspace:{openTextDocument:async value=>(content=value, value)},window:{showTextDocument:async()=>{}}};
  await showConfiguration({vscode,client,workspace:{workspaceKey:'ws_a'}});
  assert.deepEqual(calls.map(value=>[value.key,value.command]),[['','configuration-info'],['ws_a','api']]);
  assert.equal(JSON.parse(content.content).configuration,'/fixture/config/guthon.json');
});

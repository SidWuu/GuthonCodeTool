const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const runtime = require('../src/tool-runtime');
const { windowToolHome, workspaceSetupCard, hasWorkspaceConfigFiles, prepareWorkspaceSetup } = require('../src/tool-workspace');
const source = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');
const teamSource = 'ssh://git@example.test/team/guthon-team.git';

test('debug mode prompts only for the pyz and returns settings after preparation succeeds', async () => {
  const start = source.indexOf('async function configuredRuntime(');
  const end = source.indexOf('async function initializationRuntime(', start);
  const picked = path.join(os.tmpdir(), '调试文件', 'GuthonCodeTool-python.pyz');
  const storage = path.join(os.tmpdir(), 'Nexus cache');
  const dialogs = [], errors = [];
  let shouldFail = true;
  const context = { module: { exports: {} }, normalizeExecutionMode: runtime.normalizeExecutionMode,
    vscode: {
      ProgressLocation: { Notification: 1 },
      window: {
        showOpenDialog: async options => { dialogs.push(options); return [{ fsPath: picked }]; },
        withProgress: (_options, callback) => callback({ report() {} }),
        showErrorMessage: message => errors.push(message),
      },
    },
    prepareScriptRuntime: async (file, options) => {
      assert.equal(file, picked);
      assert.equal(options.storageRoot, storage);
      if (shouldFail) throw new Error('fixture install failure');
      return { runtime: { mode: 'script', toolPath: path.join(storage, 'python'), toolEntry: file } };
    },
  };
  vm.runInNewContext(source.slice(start, end) + '\nmodule.exports = configuredRuntime;', context);
  const config = { get: (_key, fallback) => fallback };
  const options = { ...runtime.runtimeSelectionOptions('script'), prepareScript: true, scriptStorageRoot: storage };
  assert.equal(await context.module.exports(config, 'script', options), undefined);
  assert.match(errors[0], /fixture install failure/);
  shouldFail = false;
  const selected = await context.module.exports(config, 'script', options);
  assert.equal(selected.configuration.scriptToolPath, picked);
  assert.equal(selected.configuration.scriptPythonPath, path.join(storage, 'python'));
  assert.equal(dialogs.length, 2);
  for (const dialog of dialogs) assert.equal(Object.values(dialog.filters)[0][0], 'pyz');
});

test('DATABASE source updates reveal live output and report each backend stage before completion', async ()=>{
  const start=source.indexOf('async function runToolCommand(');
  const end=source.indexOf('function configuredToolFromSettings()',start);
  const output=[],messages=[];
  let release, entered;
  const running=new Promise(resolve=>{entered=resolve;});
  const pending=new Promise(resolve=>{release=resolve;});
  const context={module:{exports:{}},toolQueue:Promise.resolve(),TOOL_COMMANDS:{setup:'setup'},
    TOOL_LABELS:{'sync-all':'更新 DATABASE 源码'},claimToolRun:()=>()=>{},
    toolOutput:()=>({show:()=>output.push('shown'),append:value=>output.push(value),appendLine:value=>output.push(value)}),
    operationTimer:()=>()=> 'elapsed',indexResultSummary:()=>undefined,
    vscode:{ProgressLocation:{Notification:1},window:{showInformationMessage(){},
      withProgress:(options,callback)=>{
        assert.equal(options.cancellable,false);assert.match(options.title,/DATABASE/);
        return callback({report:({message})=>messages.push(message)});
      }}},
  };
  vm.runInNewContext(source.slice(start,end)+'\nmodule.exports=runToolCommand;',context);
  const client={request:async(_tool,_command,_args,_key,_payload,{onOutput})=>{
    onOutput('[19:48:27.500] [DATA');onOutput('BASE] 主库连接成功\n');
    entered();
    await pending;
    return {ok:true};
  }};
  const result=context.module.exports(client,'sync-all',[],false,'ws-db',null,undefined,{mode:'source-development'});
  await running;
  assert.deepEqual(messages,['主库连接成功']);
  assert.equal(output[0],'shown');
  assert(!output.some(value=>String(value).includes('GuthonCodeTool 完成')));
  release();
  assert.equal(await result,true);
});

function fixture(t, {cancel = false, confirmed = false, readError = false, setupMode = 'setup',
  workspaceDirectory, namedRootSupported = true, direct = false, localExecutable = false, badExecutable = false,
  preferredMode = 'packaged', workbenchTargetsNewHome = false, invalidFallback = false, cancelTeam = false,
  unified = true, trusted = true, authAction, selectedMode = 'packaged'} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-runtime-selection-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  const oldHome = path.join(directory, 'old-svn'), newHome = path.join(directory, 'new-api');
  const oldTool = path.join(directory, 'old-svn-tool'), apiTool = path.join(directory, 'api-tool');
  fs.writeFileSync(oldTool, 'old fixture');fs.writeFileSync(apiTool, 'api fixture');
  const oldDescriptor = runtime.writeRuntimeDescriptor({mode:'packaged',toolPath:oldTool,toolHome:oldHome});
  const descriptorBefore = fs.readFileSync(oldDescriptor);
  fs.mkdirSync(path.join(oldHome, 'config'));
  fs.writeFileSync(path.join(oldHome, 'config/guthon.json'), '{}');
  const executableName = process.platform === 'win32' ? 'GuthonCodeTool-windows-x64.exe' : 'GuthonCodeTool';
  const fallbackDir = path.join(directory, 'selected runtime');
  const sibling = path.join(newHome, executableName);
  const fallback = path.join(fallbackDir, executableName);
  const opened = direct ? path.join(newHome, workspaceDirectory || 'var') : oldHome;
  const scriptPath = path.join(newHome, 'GuthonCodeTool-python.pyz');
  if (direct) {
    fs.mkdirSync(opened, { recursive: true });
    if (localExecutable) fs.writeFileSync(sibling, 'sibling application');
  }
  if (direct || workspaceDirectory) {
    fs.mkdirSync(fallbackDir);
    if (!invalidFallback) fs.writeFileSync(fallback, 'fallback application');
  }
  const values = {executionMode:preferredMode,toolPath:oldTool,toolHome:workbenchTargetsNewHome ? newHome : oldHome};
  const local = {}, writes = [];
  const config = {get:(key,fallback)=>local[key] ?? values[key] ?? fallback,inspect:key=>({workspaceValue:local[key]}),
    update:async(key,value,scope)=>{writes.push({key,value,scope});(scope===2?local:values)[key]=value;}};
  let pickerCalls = 0;const invocations=[],probes=[],messages=[],modeChoices=[],teamSourceSelections=[],savedSources=new Map(),terminals=[];
  const vscode = {workspace:{isTrusted:trusted,getConfiguration:()=>config,workspaceFolders:[{uri:{scheme:'file',fsPath:opened}}]},
    ConfigurationTarget:{Global:1,Workspace:2,WorkspaceFolder:3},Uri:{file:fsPath=>({fsPath})},ProgressLocation:{Window:10},
    window:{showOpenDialog:async options=>{
      pickerCalls++;assert.equal(options.canSelectFolders,false);
      const file = selectedMode === 'script' ? scriptPath : (direct || workspaceDirectory) ? fallback : apiTool;
      return cancel ? undefined : [{ fsPath: file }];
    },withProgress:async(_options,operation)=>operation(),
      showQuickPick:async modes=>{modeChoices.push(modes.map(mode=>mode.value));return modes.find(mode=>mode.value===selectedMode);},
      showErrorMessage:(message,...actions)=>{
        messages.push(message);
        return actions.includes(authAction) ? authAction : undefined;
      },showInformationMessage:async()=> '稍后'}};
  const context = {module:{exports:{}},process:{ ...process, env:{ ...process.env, GUTHON_TEAM_MARKETPLACE_URL:undefined }},
    path,fs,vscode,...runtime,windowToolHome,workspaceSetupCard,hasWorkspaceConfigFiles,
    context:{globalStorageUri:{fsPath:directory},globalState:{get:key=>savedSources.get(key),update:async(key,value)=>savedSources.set(key,value)}},
    configuredToolFromSettings:()=>({mode:'packaged',toolPath:apiTool,toolHome:newHome}),
    prepareScriptRuntime: async file => ({ runtime: { mode: 'script', toolPath: apiTool, toolEntry: file } }),
    verifyExecutable:async file=>{probes.push(file);assert.ok(fs.existsSync(file));if(badExecutable)throw Error('fixture rejected');},
    prepareWorkspaceSetup:direct ? prepareWorkspaceSetup : async()=>({mode:setupMode,toolHome:newHome,workspaceDirectory}),
    workspaceTeamSource:async(_window,configured,edit)=>{
      teamSourceSelections.push(configured);
      return cancelTeam ? undefined : edit ? teamSource : configured || (authAction ? 'http://example.test/team.git' : teamSource);
    },
    openTeamSyncTerminal:(_window,tool,args)=>terminals.push({tool,args}),
    selection:{clear(){}},refreshGeneration:0,projectCard:{invalidate(){}},apiServices:{reset:async()=>{},sourceTree:{refresh(){}}},
    processClient:{stop:async()=>{},request:async(_tool,command)=>{if(readError)throw new Error('fixture unreadable');return {
      ok:true,workspaces:[], ...(command==='configuration-info' && namedRootSupported
        ? {workspaceRoot:path.join(newHome,'var'),initialized:true,mode:unified?'unified':'legacy'} : {})};}},
    refreshLocalWorkspaceViews:async()=>{},refreshToolData(){},refreshApiWorkspaces:async()=>{},bridge:{isRunning:()=>false},
    runTool:async(...args)=>{
      invocations.push(args);
      if (authAction && invocations.length===1) {
        throw Object.assign(new Error('Git authentication required'),{code:'TEAM_GIT_AUTH_REQUIRED'});
      }
      if(direct && confirmed) {
        fs.mkdirSync(path.join(newHome,'config'));
        fs.writeFileSync(path.join(newHome,'config/guthon.json'),JSON.stringify({schemaVersion:3,workspaceDirectory:path.basename(opened)}));
      }
      return confirmed;
    },TOOL_COMMANDS:{setup:'setup'}};
  const start = source.indexOf('async function configuredRuntime(');
  const end = source.indexOf('async function runToolCommand(', start);
  vm.runInNewContext(source.slice(start,end)+'\nmodule.exports.configuredTool=configuredTool;',context);
  const handlerStart=source.indexOf("vscode.commands.registerCommand('gushenCompletion.setupTool',");
  const handlerEnd=source.indexOf("vscode.commands.registerCommand('gushenCompletion.addWorkspace',",handlerStart);
  const syncStart=source.indexOf("vscode.commands.registerCommand('gushenCompletion.syncTeamRules',");
  vscode.commands={registerCommand:(_name,handler)=>handler};
  const handler=vm.runInNewContext(source.slice(handlerStart,handlerEnd).trim().replace(/,$/,''),context);
  const sync=vm.runInNewContext(source.slice(syncStart,handlerStart).trim().replace(/,$/,''),context);
  const selectModeStart=source.indexOf("vscode.commands.registerCommand('gushenCompletion.selectExecutionMode',");
  const selectModeEnd=source.indexOf("vscode.commands.registerCommand('gushenCompletion.restartDevelopmentToolHost',",selectModeStart);
  const switchMode=vm.runInNewContext(source.slice(selectModeStart,selectModeEnd).trim().replace(/,$/,''),context);
  return {handler,sync,switchMode,modeChoices,teamSourceSelections,configuredTool:context.module.exports.configuredTool,oldHome,newHome,oldTool,apiTool,values,local,writes,
    invocations,probes,messages,sibling,fallback,opened,terminals,scriptPath,
    pickerCalls:()=>pickerCalls,assertOldDescriptor:()=>assert.deepEqual(fs.readFileSync(oldDescriptor),descriptorBefore)};
}

test('setting up a new home explicitly selects an API backend even when the old SVN executable is valid',async t=>{
  const f=fixture(t,{confirmed:true});await f.handler();
  assert.equal(f.pickerCalls(),1);assert.equal(f.invocations.length,1);
  const tool=f.invocations[0].at(-1);assert.equal(tool.toolPath,f.apiTool);assert.equal(tool.toolHome,f.newHome);
  assert.equal(f.local.toolHome,f.newHome);assert.equal(f.local.toolPath,f.apiTool);f.assertOldDescriptor();
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.newHome,'var/nexus/tool-runtime.json'),'utf8')).command[0],f.apiTool);
});

test('first-run setup forwards the opened development directory to a compatible backend',async t=>{
  const f=fixture(t,{confirmed:true,workspaceDirectory:'自主研发'});
  await f.handler();
  assert.equal(f.invocations.length,1);
  assert.deepEqual(Array.from(f.invocations[0][1]),['--workspace-directory','自主研发','--team-source',teamSource]);
  assert.equal(f.local.toolHome,f.newHome);
});

test('cancelling team source selection leaves the workspace association untouched',async t=>{
  const f=fixture(t,{confirmed:true,cancelTeam:true});
  await f.handler();
  assert.equal(f.invocations.length,0);
  assert.equal(f.writes.length,0);
  f.assertOldDescriptor();
});

test('manual team sync reuses the initialized workspace source and never requests a project',async t=>{
  const f=fixture(t,{confirmed:true});
  await f.handler();
  const settingsWrites=f.writes.length;
  await f.sync();
  assert.deepEqual(f.teamSourceSelections,[undefined,teamSource]);
  const [command,args,confirm,workspaceKey,,,tool]=f.invocations[1];
  assert.equal(command,'setup');
  assert.deepEqual(Array.from(args),['--team-source',teamSource]);
  assert.equal(confirm,false);
  assert.equal(workspaceKey,'');
  assert.equal(tool.toolHome,f.newHome);
  assert.equal(f.writes.length,settingsWrites);
});

test('manual team sync does not write in an untrusted workspace or with legacy configuration',async t=>{
  for(const options of [{trusted:false},{unified:false}]) {
    const f=fixture(t,options);
    await f.sync();
    assert.equal(f.invocations.length,0);
    assert.equal(f.teamSourceSelections.length,0);
    assert.match(f.messages[0],/信任|统一工作空间配置/);
  }
});

test('manual team sync can retry a different repository after HTTP authentication fails',async t=>{
  const f=fixture(t,{confirmed:true,authAction:'更换仓库地址'});
  assert.equal(await f.sync(),true);
  assert.deepEqual(f.invocations.map(call=>Array.from(call[1])),[
    ['--team-source','http://example.test/team.git'],
    ['--team-source',teamSource],
  ]);
  await f.sync();
  assert.equal(f.teamSourceSelections.at(-1),teamSource);
});

test('manual team sync can hand authentication to a terminal without reporting success',async t=>{
  const f=fixture(t,{confirmed:true,authAction:'在终端认证并同步'});
  assert.equal(await f.sync(),false);
  assert.equal(f.invocations.length,1);
  assert.equal(f.terminals.length,1);
  assert.equal(f.terminals[0].tool.toolHome,f.newHome);
  assert.deepEqual(Array.from(f.terminals[0].args), ['--team-source','http://example.test/team.git']);
});

test('an older backend is rejected before setup can create a different development directory',async t=>{
  const f=fixture(t,{confirmed:true,workspaceDirectory:'自主研发',namedRootSupported:false});
  await f.handler();
  assert.equal(f.invocations.length,0);
  assert.equal(f.values.toolHome,f.oldHome);
  assert.equal(fs.existsSync(f.newHome),false);
});

test('direct initialization uses the parent executable without a picker even with an inherited development mode',async t=>{
  for (const name of ['var','自主研发']) {
    const f=fixture(t,{direct:true,workspaceDirectory:name,localExecutable:true,preferredMode:'source-development',confirmed:true});
    await f.handler('current');
    assert.equal(f.pickerCalls(),0);
    assert.deepEqual(f.probes,[f.sibling]);
    const tool=f.invocations[0].at(-1);
    assert.equal(tool.toolPath,f.sibling);assert.equal(tool.toolHome,f.newHome);
    assert.equal(f.local.toolHome,f.newHome);assert.equal(f.local.executionMode,'packaged');
    assert.equal(f.values.toolHome,f.oldHome);assert.equal(f.values.executionMode,'source-development');
    assert(f.writes.every(write=>write.scope===2));
    assert(fs.existsSync(path.join(f.opened,'nexus/tool-runtime.json')));
    f.assertOldDescriptor();
  }
});

test('without a neighboring application a new directory can select a packaged binary despite global debug mode',async t=>{
  const f=fixture(t,{direct:true,workspaceDirectory:'var',preferredMode:'script',confirmed:true,workbenchTargetsNewHome:true});
  await f.handler();
  assert.deepEqual(Array.from(f.modeChoices[0]),['packaged','source-development','script']);
  assert.equal(f.pickerCalls(),1);
  assert.deepEqual(f.probes,[f.fallback]);
  assert.equal(f.invocations[0].at(-1).toolHome,f.newHome);
  assert.equal(f.local.toolPath,f.fallback);
  assert.equal(f.local.toolHome,f.newHome);
  assert.equal(f.local.executionMode,'packaged');
  assert.equal(f.values.executionMode,'script');
  f.assertOldDescriptor();
});

test('switching an unbound demo folder to packaged persists both settings locally and reuses the verified selection at initialization',async t=>{
  const f=fixture(t,{direct:true,workspaceDirectory:'var',preferredMode:'script',confirmed:true});
  await f.switchMode();
  assert.equal(f.local.executionMode,'packaged');
  assert.equal(f.local.toolPath,f.fallback);
  assert.equal(f.values.executionMode,'script');
  assert.equal(f.pickerCalls(),1);
  f.assertOldDescriptor();

  await f.handler('current');
  assert.equal(f.pickerCalls(),1);
  assert.equal(f.modeChoices.length,1);
  assert.equal(f.invocations[0].at(-1).toolPath,f.fallback);
  const descriptor=JSON.parse(fs.readFileSync(path.join(f.opened,'nexus/tool-runtime.json'),'utf8'));
  assert.equal(descriptor.mode,'packaged');
  assert.deepEqual(descriptor.command,[f.fallback]);
});

test('an unbound demo folder prefers its own executable even if the global mode is already packaged',async t=>{
  const f=fixture(t,{direct:true,localExecutable:true,preferredMode:'packaged',confirmed:true});
  await f.switchMode();
  assert.equal(f.pickerCalls(),0);
  assert.deepEqual(f.probes,[f.sibling]);
  assert.equal(f.local.toolPath,f.sibling);
  assert.equal(f.local.executionMode,'packaged');
  assert.equal(f.values.toolPath,f.oldTool);

  await f.handler('current');
  assert.equal(f.invocations[0].at(-1).toolPath,f.sibling);
  assert.equal(f.local.toolHome,f.newHome);
  f.assertOldDescriptor();
});

test('an attached workspace can replace its broken debug mode without launching Python',async t=>{
  const f=fixture(t,{direct:true,workspaceDirectory:'var',localExecutable:true,preferredMode:'script',confirmed:true});
  await f.handler('current');
  f.local.executionMode='script';
  f.local.scriptPythonPath=path.join(f.newHome,'missing-python');

  await f.switchMode();
  assert.equal(f.pickerCalls(),0);
  assert.equal(f.local.executionMode,'packaged');
  assert.equal(f.values.executionMode,'script');
  const tool=await f.configuredTool({writeDescriptor:false});
  assert.equal(tool.mode,'packaged');
  assert.equal(tool.toolPath,f.sibling);
  assert.equal(tool.toolHome,f.newHome);
  assert.equal(f.local.scriptPythonPath,path.join(f.newHome,'missing-python'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.opened,'nexus/tool-runtime.json'),'utf8')).command,[f.sibling]);
});

test('debug mode reconnects a window whose saved home points at the opened var', async t => {
  const f = fixture(t, { direct: true, preferredMode: 'script', selectedMode: 'script' });
  fs.mkdirSync(path.join(f.newHome, 'config'));
  const configPath = path.join(f.newHome, 'config/guthon.json');
  const settings = '{"schemaVersion":3}';
  fs.writeFileSync(configPath, settings);
  f.local.toolHome = f.opened;

  await f.switchMode();
  assert.equal(fs.existsSync(path.join(f.opened, 'var')), false);

  await f.handler();
  assert.equal(f.local.toolHome, f.newHome);
  assert.equal(f.invocations.length, 0, 'reconnection must not initialize a workspace');
  assert.equal(fs.readFileSync(configPath, 'utf8'), settings);
  const descriptor = JSON.parse(fs.readFileSync(path.join(f.opened, 'nexus/tool-runtime.json'), 'utf8'));
  assert.equal(descriptor.home, f.newHome);
  assert.equal(descriptor.workspaceRoot, f.opened);
  assert.deepEqual(descriptor.command, [f.apiTool, f.scriptPath]);
  assert.equal(fs.existsSync(path.join(f.opened, 'var')), false);
});

test('a broken neighboring executable reports its path and never starts setup or falls back to an old runtime',async t=>{
  const f=fixture(t,{direct:true,localExecutable:true,badExecutable:true,confirmed:true});
  await f.handler('current');
  assert.equal(f.pickerCalls(),0);
  assert.equal(f.invocations.length,0);
  assert(f.messages[0].includes(f.sibling));
  assert.match(f.messages[0],/fixture rejected/);
  assert.deepEqual(f.writes,[]);
  assert(!fs.existsSync(path.join(f.newHome,'config')));
});

test('a selected executable that is unavailable produces a path-specific error',async t=>{
  const f=fixture(t,{direct:true,invalidFallback:true,confirmed:true});
  await f.handler('current');
  assert.equal(f.pickerCalls(),1);
  assert.equal(f.invocations.length,0);
  assert.deepEqual(f.probes,[]);
  assert(f.messages[0].includes(path.dirname(f.fallback)));
  assert.deepEqual(f.writes,[]);
});

test('canceling the packaged file chooser leaves the target data folder uninitialized',async t=>{
  const f=fixture(t,{direct:true,cancel:true,confirmed:true});
  await f.handler('current');
  assert.equal(f.pickerCalls(),1);
  assert.equal(f.invocations.length,0);
  assert.deepEqual(f.writes,[]);
  assert(!fs.existsSync(path.join(f.newHome,'config')));
});

test('cancelling the backend picker prevents setup and leaves the old runtime and settings intact',async t=>{
  const f=fixture(t,{cancel:true});await f.handler();
  assert.equal(f.pickerCalls(),1);assert.equal(f.invocations.length,0);
  assert.equal(f.values.toolPath,f.oldTool);assert.equal(f.values.toolHome,f.oldHome);f.assertOldDescriptor();
  assert.equal(fs.existsSync(f.newHome),false);
});

test('ordinary tool calls keep the configured backend without showing a new picker',async t=>{
  const f=fixture(t);const tool=await f.configuredTool({writeDescriptor:false});
  assert.equal(f.pickerCalls(),0);assert.equal(tool.toolPath,f.oldTool);assert.equal(tool.toolHome,f.oldHome);f.assertOldDescriptor();
});

test('cancelling the final setup confirmation keeps both backend and home settings untouched',async t=>{
  const f=fixture(t);await f.handler();
  assert.equal(f.invocations.length,1);assert.equal(f.invocations[0].at(-1).toolPath,f.apiTool);
  assert.equal(f.values.toolPath,f.oldTool);assert.equal(f.values.toolHome,f.oldHome);f.assertOldDescriptor();
  assert.equal(fs.existsSync(f.newHome),false);
});

test('failing to read an existing home does not save the selected runtime',async t=>{
  const f=fixture(t,{setupMode:'switch',readError:true});await f.handler();
  assert.equal(f.pickerCalls(),1);assert.equal(f.invocations.length,0);
  assert.equal(f.values.toolPath,f.oldTool);assert.equal(f.values.toolHome,f.oldHome);f.assertOldDescriptor();
});


test('configured runtime discovery lets the selected backend validate its own legacy layout',()=>{
  const values={toolHome:'/configured/legacy-home',executionMode:'packaged',toolPath:'/configured/api-tool'};
  const context={module:{exports:{}},path,fs:{existsSync:p=>p===values.toolPath},
    vscode:{workspace:{getConfiguration:()=>({get:(key,fallback)=>values[key] ?? fallback})}},
    windowToolHome,hasWorkspaceConfigFiles:home=>home==='/configured/legacy-home',localWorkspaceFolders:()=>[values.toolHome],
    normalizeExecutionMode:mode=>mode,resolvePackagedTool:p=>p,installedToolEnvironment:home=>({GUTHON_HOME:home})};
  const start=source.indexOf('function configuredToolFromSettings()');
  const end=source.indexOf('function activate(',start);
  vm.runInNewContext(source.slice(start,end)+'\nmodule.exports=configuredToolFromSettings;',context);
  const tool=context.module.exports();
  assert.equal(tool.toolPath,values.toolPath);assert.equal(tool.toolHome,values.toolHome);assert.equal(tool.env.GUTHON_HOME,values.toolHome);
  values.toolHome='relative-home';assert.equal(context.module.exports(),undefined);
});

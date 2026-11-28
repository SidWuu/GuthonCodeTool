const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {WorkspaceRegistry}=require('../src/workspace-registry');
const {WindowWorkspaceSelection,windowToolHome,workspaceSetupCard}=require('../src/tool-workspace');
const {ApiSourceUI}=require('../src/api/source-ui');
const {ApiEditorState}=require('../src/api/editor-state');

function fixture(t) {
  const extension=path.resolve(__dirname,'../src/extension.js'),requireFromExtension=createRequire(extension);
  const source=fs.readFileSync(extension,'utf8'),activate=fs.readFileSync(path.resolve(__dirname,'../src/api/activate.js'),'utf8');
  const requests=[],commands=[],state=new Map();let registryReads=0;let cardProvider,failedKey;let response={ok:true,workspaces:[
    {workspaceKey:'a',name:'甲',sourceMode:'api',root:'/home/var/a',checkoutPath:'/home/var/a/checkout'},
    {workspaceKey:'b',name:'乙',sourceMode:'api',root:'/home/var/b',checkoutPath:'/home/var/b/checkout'},
    {workspaceKey:'old',name:'旧项目',sourceMode:'svn',root:'/home/var/old',executionReady:false}],configErrors:[]};
  class EventEmitter {constructor(){this.event=()=>({dispose(){}});}fire(){}dispose(){}}
  class TreeItem {constructor(label){this.label=label;}}
  const document={uri:{scheme:'file',fsPath:'/home/var/a/checkout/unsaved.gss'},isDirty:true,version:2};
  const vscode={EventEmitter,TreeItem,TreeItemCollapsibleState:{None:0},
    workspace:{workspaceFolders:[{uri:{scheme:'file',fsPath:'/home/var'}}],textDocuments:[document],getConfiguration:()=>({get:(key,fallback)=>key==='toolHome'?'/home':fallback})},
    commands:{executeCommand:async(...args)=>commands.push(args)},
    window:{createTreeView:()=>({dispose(){}}),registerWebviewViewProvider:(_id,provider)=>{cardProvider=provider;return {dispose(){}};},showErrorMessage:message=>{throw new Error(message);}}};
  const context={extensionPath:path.resolve(__dirname,'..'),workspaceState:{get:(key,fallback)=>state.get(key)??fallback,update:async(key,value)=>state.set(key,value)}};
  const run=async(key,action,payload)=>{
    requests.push({key,action,payload});
    if(action==='status' && key===failedKey)throw new Error('当前项目状态无法读取');
    if(action==='editor-state')return {editorToken:'token-'+key};
    if(action==='session')return {authenticated:true,session:{userName:'Fixture'}};
    if(action==='catalog')return {objects:[{path:'test.gss',sourceType:'procedure'}]};
    return {checkoutPath:`/home/var/${key}/checkout`,settings:{serverUrl:'https://fixture.invalid',systemIds:['A'],allSystems:false},
      summary:{sourceCount:1,changedCount:key==='a'?1:0,uploadableCount:key==='a'?1:0},files:[]};
  };
  const editorState=new ApiEditorState({vscode,run});
  const ui=new ApiSourceUI({vscode,run,editorState});
  const tool={toolPath:'/tool',toolHome:'/home'};
  const syncStart=activate.indexOf('  async function syncWorkspaces('),syncEnd=activate.indexOf('  return {run,readProjectSummary',syncStart);
  const syncContext=vm.createContext({ui,path,getTool:async()=>tool,mcpSessionHost:{sync:async()=>{}},workspaceSyncGeneration:0});
  vm.runInContext(activate.slice(syncStart,syncEnd)+';globalThis.synchronize=syncWorkspaces;',syncContext);
  const api={sourceTree:ui,run,editorState,syncWorkspaces:syncContext.synchronize,readProjectSummary:key=>run(key,'status')};
  const localWorkspaceFolders=()=>vscode.workspace.workspaceFolders.map(item=>item.uri.fsPath);
  const sandbox=vm.createContext({path,vscode,context,WorkspaceRegistry,WindowWorkspaceSelection,
    localWorkspaceFolders,windowToolHome,workspaceSetupCard,
    configuredToolFromSettings:()=>windowToolHome(vscode.workspace.getConfiguration(),localWorkspaceFolders())?tool:undefined,
    processClient:{request:async()=>{registryReads++;if(response instanceof Error)throw response;return response;}},
    runTool:()=>assert.fail('unexpected tool command'),toolOutput:()=>({appendLine(){}}),
    bridgeOutput:{append(){}},resolveBridgeScript:()=>'',createBridgeProcess:()=>({isRunning:()=>false}),
    require:name=>{
      if(name==='./api/activate')return {activateApi:options=>{ui.onStatus=options.onStatus;return api;}};
      if(name==='./legacy-project')return {registerLegacyProjects:()=>({sync:async()=>{},children:async()=>[{label:'旧项目源码'}]})};
      return requireFromExtension(name);
    }});
  const start=source.indexOf('  const workspaceRegistry ='),end=source.indexOf('  // 排序方式变化',start);
  vm.runInContext(source.slice(start,end)+';globalThis.views={refresh:refreshApiWorkspaces,afterDelete:refreshDeletedWorkspace,selection,projectOverview,projectCard,workspaceRegistry};',sandbox);
  const views=sandbox.views;
  views.cardProvider=cardProvider;
  const cardView={webview:{onDidReceiveMessage:callback=>{cardView.receive=callback;return {dispose(){}};},postMessage:async()=>{}}};
  views.cardProvider.resolveWebviewView(cardView);
  t.after(async()=>{views.projectCard.dispose();views.projectOverview.dispose();ui.dispose();await editorState.close();});
  return {views,ui,api,requests,commands,state,document,editorState,cardView,
    setFolder(directory){vscode.workspace.workspaceFolders=[{uri:{scheme:'file',fsPath:directory}}];},
    get registryReads(){return registryReads;},setResponse(value,{invalidate=true}={}){response=value;if(invalidate)views.workspaceRegistry.invalidate();},failStatus(key){failedKey=key;},get response(){return response;}};
}

test('root view lists all projects, keeps one current source and retains dirty A documents when choosing B or SVN',async t=>{
  const f=fixture(t);await f.views.refresh();
  assert.equal(f.views.projectOverview.provider.getChildren().length,3);
  assert.equal(f.views.cardProvider.currentKey,undefined);assert.deepEqual(await f.ui.getChildren(),[]);
  await f.views.selection.select('a',{switchWindow:true});await f.views.refresh();
  assert.equal(f.views.cardProvider.currentKey,'a');assert.equal(f.ui.selectedWorkspaceKey,'a');
  await f.views.selection.select('b',{switchWindow:true});await f.views.refresh();
  assert.equal(f.views.cardProvider.currentKey,'b');assert.equal(f.ui.selectedWorkspaceKey,'b');
  assert.equal(f.editorState.documents('a',f.editorState.workspaces.get('a'))[0].dirty,true);
  await f.views.selection.select('old',{switchWindow:true});await f.views.refresh();
  assert.equal(f.views.cardProvider.currentKey,'old');assert.match(f.cardView.webview.html,/SVN.*源码操作/);
  assert.equal(f.ui.selectedWorkspaceKey,'');assert.match((await f.ui.getChildren())[0].label,/SVN/);
  assert.equal(f.requests.filter(item=>item.key==='old').length,0);
  assert.equal(f.document.isDirty,true);assert.equal(f.ui.workspaces.size,2);
  assert.equal(f.commands.some(args=>args[0]==='vscode.openFolder'),false);
});

test('deleting the current project clears both panels immediately for every source mode',async t=>{
  for(const sourceMode of ['api','svn','database']) {
    const f=fixture(t);
    const key=sourceMode==='api'?'a':'old';
    f.setResponse({...f.response,workspaces:f.response.workspaces.map(workspace=>workspace.workspaceKey===key
      ? {...workspace,sourceMode,executionReady:true}:workspace)});
    await f.views.selection.select(key,{switchWindow:true});
    await f.views.refresh();
    assert.equal(f.views.cardProvider.currentKey,key);
    assert.ok((await f.ui.getChildren()).length);
    const scope=f.views.selection.syncScope();
    f.setResponse({...f.response,workspaces:f.response.workspaces.filter(workspace=>workspace.workspaceKey!==key)},{invalidate:false});
    const refreshing=f.views.afterDelete(key,scope);
    assert.match(f.cardView.webview.html,/请从项目总览选择/);
    assert.deepEqual(await f.ui.getChildren(),[]);
    await refreshing;
    assert.equal(f.views.cardProvider.currentKey,undefined);
    assert.equal(f.views.selection.diagnosticKey,'');
    assert.equal(f.views.projectOverview.provider.selectedKey,'');
    assert.ok(!f.views.projectOverview.provider.getChildren().some(row=>row.key===key));
    assert.equal(f.commands.filter(args=>args[1]==='gushenCompletion.hasCurrentProject').at(-1)[2],false);
    await f.views.selection.select('b',{switchWindow:true});
    await f.views.refresh();
    assert.equal(f.views.cardProvider.currentKey,'b');
  }
});

test('deleting a background project preserves the window selection',async t=>{
  const f=fixture(t);
  await f.views.selection.select('b',{switchWindow:true});
  await f.views.refresh();
  f.setResponse({...f.response,workspaces:f.response.workspaces.filter(workspace=>workspace.workspaceKey!=='a')},{invalidate:false});
  await f.views.afterDelete('a',f.views.selection.syncScope());
  assert.equal(f.views.cardProvider.currentKey,'b');
  assert.equal(f.ui.selectedWorkspaceKey,'b');
});

test('an unrelated folder offers setup and never reads the inherited data directory',async t=>{
  const f=fixture(t);
  f.setFolder('/new-home/new-workspace');
  f.setResponse(new Error('旧配置缺少文件：source-tables.yaml'));
  await f.views.refresh();
  assert.equal(f.registryReads,0);
  assert.deepEqual(f.requests,[]);
  assert.match(f.cardView.webview.html,/当前开发目录尚未初始化/);
  assert.match(f.cardView.webview.html,/初始化此文件夹/);
  assert.doesNotMatch(f.cardView.webview.html,/source-tables/);
  const row=f.views.projectOverview.provider.getChildren()[0];
  assert.equal(f.views.projectOverview.provider.getTreeItem(row).command.command,'gushenCompletion.setupTool');
  await f.cardView.receive({action:'setupCurrent'});
  await f.cardView.receive({action:'setupBrowse'});
  assert.deepEqual(f.commands.filter(args=>args[0]==='gushenCompletion.setupTool'),
    [['gushenCompletion.setupTool','current'],['gushenCompletion.setupTool','browse']]);
});

test('invalid active configuration shows a diagnostic without selecting B or issuing its API calls',async t=>{
  const f=fixture(t);await f.views.selection.select('a',{switchWindow:true});await f.views.refresh();
  f.setResponse({...f.response,workspaces:f.response.workspaces.filter(item=>item.workspaceKey!=='a'),
    configErrors:[{workspaceKey:'a',code:'CONFIG_INVALID',message:'甲的路径无效'}]});
  await f.views.refresh();
  assert.equal(f.views.cardProvider.currentKey,undefined);assert.equal(f.views.selection.diagnosticKey,'a');
  assert.match(f.cardView.webview.html,/甲的路径无效/);assert.equal(f.ui.selectedWorkspaceKey,'');
  assert.equal(f.requests.filter(item=>item.key==='b' && item.action==='session').length,0);
  assert.equal(f.views.projectOverview.provider.getChildren().length,3);
  await f.cardView.receive({workspaceKey:'a',action:'pull'});
  assert.equal(f.commands.some(args=>args[0]==='gushenCompletion.pullApiSource'),false);
});

test('global configuration failure clears stale targets and recovers after a valid refresh',async t=>{
  const f=fixture(t);await f.views.selection.select('a',{switchWindow:true});await f.views.refresh();
  const valid=f.response;f.setResponse(new Error('CONFIG_AUTHORITY_CONFLICT'));await f.views.refresh();
  assert.equal(f.views.projectOverview.provider.getChildren()[0].kind,'global');
  assert.equal(f.views.cardProvider.currentKey,undefined);assert.match(f.cardView.webview.html,/CONFIG_AUTHORITY_CONFLICT/);
  assert.match(f.cardView.webview.html,/title="\/home"/);
  assert.equal(f.ui.selectedWorkspaceKey,'');assert.equal(f.document.isDirty,true);
  f.setResponse(valid);await f.views.refresh();
  assert.equal(f.views.cardProvider.currentKey,'a');assert.equal(f.ui.selectedWorkspaceKey,'a');
});

test('a current-project state failure preserves the other selectable projects',async t=>{
  const f=fixture(t);f.failStatus('a');await f.views.selection.select('a',{switchWindow:true});await f.views.refresh();
  assert.equal(f.views.projectOverview.provider.error,undefined);
  assert.equal(f.views.projectOverview.provider.getChildren().filter(item=>item.kind==='project').length,2);
  assert.equal(f.views.cardProvider.currentKey,undefined);assert.match(f.cardView.webview.html,/状态无法读取/);
  await f.views.selection.select('b',{switchWindow:true});await f.views.refresh();
  assert.equal(f.views.cardProvider.currentKey,'b');assert.equal(f.ui.selectedWorkspaceKey,'b');
});

test('legacy project service sends updates to SVN or DATABASE while keeping the selected key', async () => {
  const {registerLegacyProjects}=require('../src/legacy-project');
  const calls=[],subscriptions=[];
  const output=[];
  class EventEmitter {constructor(){this.event=()=>({dispose(){}});}fire(){}dispose(){}}
  const svn={workspaceKey:'projects.svn',sourceMode:'svn',displayName:'SVN Fixture',
    checkoutLayout:'manifest-working-copies',scopeManifestReady:true,workingCopies:[{id:'root',root:'/fixture/checkout',localSubdir:'.'}]};
  const db={workspaceKey:'projects.db',sourceMode:'database',displayName:'DATABASE Fixture'};
  const legacy=registerLegacyProjects({
    vscode:{EventEmitter,workspace:{textDocuments:[]},
      window:{showInformationMessage(){},showErrorMessage:message=>{throw new Error(message);}}},
    context:{subscriptions},getTool:()=>({toolHome:'/fixture',toolPath:'/tool'}),
    processClient:{request:async (_tool,command,args,key,_input,options)=>{
      calls.push({command,args,key});
      options.onOutput('[SVN] 正在索引\n');
      return {ok:true};
    }},
    sourceTree:{refresh(){}},getWorkspaces:async()=>[svn,db],getSelected:async()=>svn,
    refreshProjects:async()=>{},runTool:async (command,args,_visible,key)=>{calls.push({command,args,key});return true;},
    getOutput:()=>({show:preserve=>output.push(preserve),appendLine:line=>output.push(line),append:text=>output.push(text)}),
  });
  try {
    const beforeCheckout={...svn,scopeManifestReady:false,workingCopies:[],capabilities:{'svn.browse':true}};
    assert.match((await legacy.children(beforeCheckout))[0].label,/尚未签出源码/);
    assert.equal(calls.length,0);
    await legacy.action(svn,'pull');
    await legacy.action(db,'pull');
    assert.deepEqual(calls,[
      {command:'svn',args:['refresh'],key:'projects.svn'},
      {command:'sync-all',args:[],key:'projects.db'},
    ]);
    assert.equal(output[0],true);
    assert.equal(output[2],'[SVN] 正在索引\n');
  } finally {for(const subscription of subscriptions)subscription.dispose();}
});

test('explicit SVN comparison opens both snapshots with PAGE projection, raw override, and remote orientation', async () => {
  const { registerLegacyProjects } = require('../src/legacy-project');
  const subscriptions = [];
  const comparisons = [];
  class EventEmitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
  const workspaceKey = 'projects.demo';
  const sourcePath = 'systems/SYS/pages/PG.json';
  const baseContent = '{"script":"if (a \\u0026\\u0026 b)\\n  return true;"}';
  const workingContent = '{"script":"if (a && b)\\n  return false;"}';
  const readableBaseContent = 'if (a && b)\n  return true;';
  const readableWorkingContent = 'if (a && b)\n  return false;';
  let response = { ok: true, workspaceKey, path: sourcePath,
    baseContent, workingContent, readableBaseContent, readableWorkingContent, diff: 'unified patch' };
  let provider;
  const legacy = registerLegacyProjects({
    vscode: {
      EventEmitter, Uri: { from: value => value }, window: {},
      workspace: { textDocuments: [], registerTextDocumentContentProvider(scheme, candidate) {
        if (scheme === 'guthon-svn-review-diff') provider = candidate;
        return { dispose() {} };
      } },
      commands: { async executeCommand(command, left, right) {
        assert.equal(command, 'vscode.diff');
        assert.equal(left.scheme, 'guthon-svn-review-diff');
        assert.equal(right.scheme, left.scheme);
        comparisons.push({ left, right, contents: [left, right].map(uri => provider.provideTextDocumentContent(uri)) });
      } },
    },
    context: { subscriptions }, getTool: () => ({ toolHome: '/fixture' }), sourceTree: { refresh() {} },
    processClient: { async request(_tool, command, args, key) {
      assert.equal(key, workspaceKey);
      assert.equal(command, 'svn');
      assert.deepEqual(args, ['diff', '--path', sourcePath, ...(response.comparison === 'remote' ? ['--remote'] : [])]);
      return response;
    } },
  });
  try {
    await legacy.diff({ workspaceKey }, sourcePath);
    await legacy.diff({ workspaceKey }, sourcePath, { raw: true });
    // A failed projection on either populated side displays the raw pair.
    response = { ...response, readableWorkingContent: '' };
    await legacy.diff({ workspaceKey }, sourcePath);
    // Remote removal compares the saved working copy with an empty HEAD side.
    response = { ok: true, workspaceKey, path: sourcePath, comparison: 'remote',
      localContent: workingContent, remoteContent: '', readableLocalContent: readableWorkingContent, readableRemoteContent: '' };
    await legacy.diff({ workspaceKey }, sourcePath, { remote: true });
    assert.deepEqual(comparisons.map(value => value.contents), [
      [readableBaseContent, readableWorkingContent], [baseContent, workingContent],
      [baseContent, workingContent], [readableWorkingContent, ''],
    ]);
    assert.match(comparisons[0].left.path, /SVN BASE\.md$/);
    assert.match(comparisons[1].right.path, /工作副本\.json$/);
    assert.match(comparisons[3].right.path, /SVN HEAD\.md$/);
    assert.equal(provider.writeFile, undefined);
  } finally { for (const subscription of subscriptions) subscription.dispose(); }
});

test('SVN submission lists selected paths without opening differences and retains scoped review', async () => {
  const { registerLegacyProjects } = require('../src/legacy-project');
  class EventEmitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
  const subscriptions = [], requests = [], picks = [], confirmations = [], diffTabs = [];
  const workspace = { workspaceKey: 'projects.demo', displayName: 'Demo', checkoutLayout: 'manifest-working-copies' };
  const candidates = [
    { id: 'target', path: 'pages/target.json', workingCopyId: 'trade' },
    { id: 'nearby', path: 'pages/nearby.json', workingCopyId: 'trade' },
    { id: 'other', path: 'pages/other.json', workingCopyId: 'shared' },
  ];
  let accept = true;
  let selectGroup = false;
  const legacy = registerLegacyProjects({
    vscode: { EventEmitter, Uri: { from: value => value },
      workspace: { textDocuments: [], registerTextDocumentContentProvider: () => ({ dispose() {} }),
        openTextDocument: async document => document },
      commands: { async executeCommand(command, _before, _after, title) {
        assert.equal(command, 'vscode.diff');
        diffTabs.push(title);
      } },
      window: {
        showInformationMessage: () => {}, showTextDocument: async () => {},
        showQuickPick: async (items, options) => { picks.push({ items, options }); return selectGroup ? items : items.slice(-1); },
        showInputBox: async () => 'fixture message',
        showWarningMessage: async (title, options, action) => { confirmations.push({ title, options }); return accept ? action : undefined; },
      },
    },
    context: { subscriptions }, getTool: () => ({ toolHome: '/fixture' }), sourceTree: { refresh() {} },
    refreshProjects: async () => {},
    processClient: { async request(_tool, command, args, key, input) {
      assert.equal(command, 'svn');
      assert.equal(key, workspace.workspaceKey);
      requests.push({ args, input });
      if (args[0] === 'scm-session') return { ok: true, sessionId: 'session' };
      if (args[0].endsWith('-preview')) return { ok: true, sessionId: 'session', selectionToken: 'token', candidates };
      if (args[0] === 'diff') return { ok: true, workspaceKey: key, path: args[2], baseContent: 'old', workingContent: 'new' };
      return { ok: true };
    } },
  });
  const writes = () => requests.filter(({ args }) => ['revert', 'platform-save'].includes(args[0]));
  try {
    for (const action of ['revert', 'platform-save']) {
      const previousDiffs = diffTabs.length;
      await legacy.review(workspace, action, { sourcePath: candidates[0].path, workingCopyIds: ['trade'] });
      assert.deepEqual(writes().at(-1).args, [action, '--session', 'session', '--selection-token', 'token', '--candidate', 'target']);
      assert.equal(confirmations.at(-1).options.detail, candidates[0].path);
      assert.equal(diffTabs.length, previousDiffs + Number(action === 'revert'));
    }
    assert.deepEqual(writes()[1].input, { message: 'fixture message' });
    assert.equal(picks.length, 0);
    accept = false;
    await legacy.review(workspace, 'revert', { sourcePath: candidates[0].path });
    assert.equal(writes().length, 2);
    assert.equal(picks.length, 0);

    accept = true;
    selectGroup = true;
    const previousDiffs = diffTabs.length;
    await legacy.review(workspace, 'platform-save', { workingCopyIds: ['trade'], scopeLabel: '贸易系统' });
    assert.deepEqual(picks[0].items.map(({ item }) => item.id), ['target', 'nearby']);
    assert.match(picks[0].options.title, /贸易系统/);
    assert.deepEqual(requests.filter(({ args }) => args[0] === 'platform-save-preview').at(-1).args,
      ['platform-save-preview', '--session', 'session', '--working-copy', 'trade']);
    assert.deepEqual(writes().at(-1).args.slice(-4), ['--candidate', 'target', '--candidate', 'nearby']);
    assert.equal(confirmations.at(-1).options.detail, 'pages/target.json\npages/nearby.json');
    assert.equal(diffTabs.length, previousDiffs);
    selectGroup = false;
    await legacy.review(workspace, 'revert');
    assert.deepEqual(picks[1].items.map(({ item }) => item.id), ['target', 'nearby', 'other']);

    const requestCount = requests.length;
    await legacy.review(workspace, 'revert', { workingCopyIds: [] });
    await legacy.updateRemote({ ...workspace, sourceMode: 'svn' }, '', []);
    assert.equal(requests.length, requestCount);
  } finally { for (const subscription of subscriptions) subscription.dispose(); }
});

test('DATABASE Workcopy delivery opens the checklist and opens the difference only when selected', async t => {
  const { registerLegacyProjects } = require('../src/legacy-project');
  class EventEmitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
  const workspace = { workspaceKey: 'projects.db', displayName: 'Fixture', sourceMode: 'database', workcopyDir: '/fixture/workcopy' };
  const target = workspace.workcopyDir + '/service';
  const subscriptions = [], calls = [], opened = [];
  const selections = ['package', 'diff'];
  const legacy = registerLegacyProjects({
    vscode: { EventEmitter, Uri: { file: fsPath => ({ fsPath }) },
      workspace: { textDocuments: [], openTextDocument: async uri => uri },
      window: {
        showOpenDialog: async () => [{ fsPath: target }],
        showQuickPick: async items => {
          if (!items.some(item => item.action)) return items[0];
          const action = selections.shift();
          return items.find(item => item.action === action);
        },
        showTextDocument: async document => opened.push(document.fsPath),
        showErrorMessage: assert.fail,
      } },
    context: { subscriptions }, getTool: () => ({ toolHome: '/fixture' }), sourceTree: { refresh() {} },
    processClient: { async request(_tool, command, args, key) {
      calls.push({ command, args, key });
      if (command === 'legacy-source') return {ok:true,items:[]};
      return { ok: true, output: target + (args[0] === 'package' ? '/delivery.md' : '/diff.md') };
    } },
  });
  t.after(() => subscriptions.forEach(subscription => subscription.dispose()));
  await legacy.action(workspace, 'changes');
  assert.deepEqual(opened, [target + '/delivery.md']);
  await legacy.action(workspace, 'changes');
  assert.deepEqual(opened, [target + '/delivery.md', target + '/diff.md']);
  assert.deepEqual(calls.map(({ command, args, key }) => [command, args[0], key]), [
    ['legacy-source', 'review-workcopies', workspace.workspaceKey], ['workcopy', 'package', workspace.workspaceKey],
    ['legacy-source', 'review-workcopies', workspace.workspaceKey],
    ['workcopy', 'diff', workspace.workspaceKey],
  ]);
});

test('DATABASE upload shows one approval and rechecks the reviewed mirror before sending', async t => {
    const {registerLegacyProjects} = require('../src/legacy-project');
    const {createHash} = require('node:crypto');
    const workspace = {workspaceKey:'projects.db', sourceMode:'database', root:'/fixture/project',
        workcopyDir:'/fixture/project/source/workcopy', displayName:'Fixture'};
    const record = {recordId:4, sourceId:'FN-1', sourceType:'procedure', sourcePath:'proc/source.vm',
        name:'Example', trustedBaseline:false, needsMerge:true};
    const target = {origin:'https://platform.test', systemId:'SYS-1', dataSourceId:'DS-1',
        procedureAlias:'pkg.proc', funId:'sample', procedureId:'PR-1', version:'native-v1',
        contentHash:createHash('sha256').update('before').digest('hex')};
    const subscriptions = [], calls = [], errors = [], confirmations = [], uploads = [];
    let confirmed = false, stale = false, provider, mode = 'manual', preflights = 0;
    const matchingTab = {...target, pageOrigin:target.origin, contextId:'ctx'};
    let contexts = [matchingTab];
    const legacy = registerLegacyProjects({
        reviewDatabaseUpload:async (_vscode, entries) => entries.map(({path}) => path),
        databasePublicationMode:async () => mode,
        async databaseBridgeRequest(_home, route) {
            if (route.startsWith('/pageContext?')) return {contexts};
            if (route === '/databaseSourcePreflight') {preflights++; return {native:target};}
            assert.fail('unexpected Bridge route');
        },
        async databasePublicationRequest(_home, route, input) {
            assert.equal(route, '/databaseProcedurePublish');
            uploads.push(input);
            return {target, state:'VERIFIED'};
        },
        context:{subscriptions}, getTool:() => ({toolHome:'/fixture'}), getWorkspaces:async () => [workspace],
        sourceTree:{refresh() {}},
        vscode:{EventEmitter:class {event = () => ({dispose() {}}); fire() {} dispose() {}},
            Uri:{from:value => value}, workspace:{textDocuments:[], registerTextDocumentContentProvider(scheme,value) {
                if (scheme === 'guthon-database-review-diff') provider = value;
                return {dispose() {}};
            }}, commands:{async executeCommand(command, left, right) {
                assert.equal(command, 'vscode.diff');
                assert.equal(provider.provideTextDocumentContent(left), 'before');
                assert.equal(provider.provideTextDocumentContent(right), 'after');
            }}, window:{
                showQuickPick:async items => items[0],
                async showWarningMessage(_message, options, action) {
                    confirmations.push(action);
                    assert.match(options.detail, /右侧已经合并/);
                    return confirmed ? action : undefined;
                },
                showInformationMessage(_message, options) {assert.equal(options, undefined);},
                showErrorMessage:message => errors.push(message),
            }},
        processClient:{async request(_tool, command, [action], key, input) {
            assert.equal(command, 'legacy-source');
            assert.equal(key, workspace.workspaceKey);
            calls.push({action,input});
            if (action === 'review-workcopies') return {ok:true, items:[record]};
            if (action === 'catalog') return {ok:true, navigationGroups:{
                systemIdsByName:{'主数据':'SYS-1','交易':'SYS-2'},
                dataSourceIdsByName:{'业务库':'DS-1','其他库':'DS-2'},
            }};
            if (action === 'publish-confirm' && stale) throw new Error('同步镜像已发生变化，请重新审阅');
            return {ok:true, baseContent:'before', content:'after', reviewId:'review-1', sourceHash:'hash-1',
                pageOrigins:[target.origin], databaseIdentity:{system_id:'SYS-1', data_source_id:'DS-1',
                    source_alias_id:'pkg.proc', fun_id:'sample'}};
        }},
    });
    t.after(() => subscriptions.forEach(subscription => subscription.dispose()));
    await legacy.action(workspace, 'upload');
    assert.deepEqual(calls.map(({action}) => action), ['review-workcopies', 'publish-preview']);
    assert.deepEqual(confirmations, ['保存到谷神平台']);
    assert.deepEqual(uploads, []);
    confirmed = true;
    stale = true;
    await legacy.action(workspace, 'upload');
    assert.match(errors.pop(), /同步镜像已发生变化/);
    assert.deepEqual(uploads, []);
    stale = false;
    contexts = [{...matchingTab, systemId:'', dataSourceId:'', mode:'platform'}];
    await legacy.action(workspace, 'upload');
    assert.deepEqual(errors, []);
    assert.equal(confirmations.length, 3);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].compareMirror, true);
    assert.equal(uploads[0].reviewId, 'review-1');

    const priorPreflights = preflights;
    for (const [tabs, message] of [
        [[], /没有收到.*打开 https:\/\/platform\.test.*登录/],
        [[{...matchingTab, pageOrigin:'https://other.test'}], /https:\/\/other\.test.*使用 https:\/\/platform\.test/],
        [[matchingTab, {...matchingTab, contextId:'another'}], /2 个与项目平台地址匹配的页签.*保留一个/],
    ]) {
        contexts = tabs;
        await legacy.action(workspace, 'upload');
        assert.match(errors.pop(), message);
    }
    for (const [availability, message] of [
        ['bridge-stopped', /还没启动.*命令面板/],
        ['bridge-unreachable', /无法通过 Guthon Bridge.*同一端口和配对令牌/],
        ['closed', /没有启用 DATABASE 上传.*检查更新/],
    ]) {
        mode = availability;
        await legacy.action(workspace, 'upload');
        assert.match(errors.pop(), message);
    }
    assert.equal(preflights, priorPreflights);
    assert.equal(uploads.length, 1);
});

test('DATABASE batches PAGE and procedure uploads with one confirmation and no object open in Chrome', async t => {
    const {registerLegacyProjects} = require('../src/legacy-project');
    const {createHash} = require('node:crypto');
    const workspace = {workspaceKey:'projects.db', sourceMode:'database', root:'/fixture/db', displayName:'Fixture'};
    const origin = 'https://platform.test';
    const page = {recordId:1, sourceType:'page', sourceId:'PG-FORM', sourcePath:'form/raw.json', name:'Form'};
    const procedure = {recordId:2, sourceType:'procedure', sourceId:'PR-FN', sourcePath:'proc/source.vm', name:'Function'};
    const blocked = {...page, recordId:3, sourceId:'PG-BLOCKED', sourcePath:'blocked/raw.json', name:'Blocked'};
    const conflicted = {...page, recordId:4, sourceId:'PG-CONFLICT', sourcePath:'conflict/raw.json', name:'Conflict'};
    const nativePage = {pageId:'PG-FORM', pageAlias:'Form', systemId:'SYS-1', origin, version:'page-v1'};
    const nativeProcedure = {procedureId:'PR-1', procedureAlias:'pkg.proc', funId:'fn', systemId:'SYS-1',
        dataSourceId:'DS-1', origin, version:'proc-v1', contentHash:createHash('sha256').update('before').digest('hex')};
    const subscriptions = [], confirmations = [], sends = [], errors = [], reports = [];
    const legacy = registerLegacyProjects({
        context:{subscriptions}, getTool:() => ({toolHome:'/fixture'}), getWorkspaces:async () => [workspace],
        sourceTree:{refresh() {}}, databasePublicationMode:async () => 'manual',
        async reviewDatabaseUpload(_vscode, entries, _openDiff, options) {
            assert.equal(options.selectAll, false);
            return entries.map(item => item.path);
        },
        async databaseBridgeRequest(_home, route, input) {
            if (route.startsWith('/pageContext?')) return {contexts:[
                {contextId:'platform', mode:'platform', pageOrigin:origin, systemId:'', dataSourceId:''},
            ]};
            if (route === '/databaseSourcePreflight') {
                assert.equal(input.contextId, 'platform');
                assert.equal(input.threeWay, true);
                if (input.sourceId === blocked.sourceId) throw new Error('目标页面不在项目同步范围');
                if (input.sourceId === conflicted.sourceId) return {native:{
                    ...nativePage, pageId:'PG-CONFLICT', latestContent:'{"pageType":1}',
                    merge:{state:'CONFLICT', conflicts:[{kind:'value', path:'/views/rows/0/component/fields/1/width'}], conflictCount:1},
                }};
                return {native:input.sourceId === page.sourceId ? nativePage : nativeProcedure};
            }
            assert.fail(route);
        },
        async databasePublicationRequest(_home, route, input) {
            assert.equal(route, '/databaseProcedurePublish');
            sends.push(input.sourceId);
            return input.sourceId === page.sourceId ? {target:nativePage, state:'VERIFIED'}
                : {target:nativeProcedure, state:'NOT_WRITTEN', reason:'CHECKED_OUT_BY_OTHER'};
        },
        vscode:{EventEmitter:class {event = () => ({dispose() {}}); fire() {} dispose() {}},
            Uri:{from:value => value},
            commands:{async executeCommand(command, _left, right) {
                assert.equal(command,'vscode.diff');
                assert.equal(right.scheme,'guthon-database-edit');
            }},
            workspace:{textDocuments:[], async openTextDocument(doc) {return doc;},
                registerTextDocumentContentProvider() {return {dispose() {}};},
                registerFileSystemProvider() {return {dispose() {}};},
            },
            window:{
                async showWarningMessage(message, options, action) {
                    confirmations.push({message, detail:options.detail});
                    return action;
                },
                async showTextDocument(doc) {reports.push(doc.content);},
                showErrorMessage:message => errors.push(message),
            }},
        processClient:{async request(_tool, command, [action], key, input) {
            assert.equal(command, 'legacy-source');
            assert.equal(key, workspace.workspaceKey);
            if (action === 'review-workcopies') return {ok:true, items:[page, procedure, blocked, conflicted]};
            if (action === 'catalog') return {ok:true, navigationGroups:{systemIdsByName:{'Other':'SYS-3'}}};
            if (action === 'edit-read') return {ok:true, language:'json', content:'{"pageType":1}'};
            assert.ok(['publish-preview', 'publish-confirm'].includes(action));
            const isPage = input.sourceId !== procedure.sourceId;
            return {ok:true, sourceHash:'source', reviewId:'review', pageOrigins:[origin],
                baseContent:isPage ? '{"pageType":1}' : 'before', content:isPage ? '{"pageType":1}' : 'after',
                databaseIdentity:{system_id:input.sourceId === blocked.sourceId ? 'SYS-3' : 'SYS-1',
                    data_source_id:isPage ? '' : 'DS-1', source_alias_id:'pkg.proc', fun_id:'fn'}};
        }},
    });
    t.after(() => subscriptions.forEach(subscription => subscription.dispose()));
    await legacy.action(workspace, 'upload');
    assert.deepEqual(errors, []);
    assert.deepEqual(sends, ['PG-FORM', 'PR-FN']);
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0].message, /2 项/);
    assert.match(confirmations[0].detail, /blocked\/raw\.json · 未进入本次上传/);
    assert.match(confirmations[0].detail, /conflict\/raw\.json · 未进入本次上传/);
    assert.match(reports[0], /\/views\/rows\/0\/component\/fields\/1\/width/);
    assert.match(reports[0], /谷神与本地只读源码均已更新/);
    assert.match(reports[0], /这个函数已被其他账号签出/);
});

test('DATABASE can close an unchanged upload only after the user confirms the verified original version', async t => {
    const {registerLegacyProjects} = require('../src/legacy-project');
    const workspace = {workspaceKey:'projects.db', sourceMode:'database', root:'/fixture/db', displayName:'Fixture'};
    const target = {origin:'https://platform.test', systemId:'SYS-1', dataSourceId:'DS-1',
        procedureAlias:'pkg.proc', funId:'example'};
    const operation = {operationId:'a'.repeat(64), state:'PLATFORM_UNKNOWN', target};
    const subscriptions = [], checks = [], notices = [];
    let confirm = false;
    const legacy = registerLegacyProjects({
        context:{subscriptions}, getTool:() => ({toolHome:'/fixture'}), sourceTree:{refresh() {}},
        databasePublicationMode:async () => 'manual',
        async databaseBridgeRequest() {
            return {contexts:[{contextId:'ctx', pageOrigin:target.origin, systemId:'SYS-1', dataSourceId:'DS-1'}]};
        },
        async databasePublicationRequest(_home, route, input) {
            if (route === '/databaseProcedureOperations') return {operations:[operation]};
            assert.equal(route, '/databaseProcedureVerify');
            checks.push(input.closeUnchanged);
            return {...operation, state:input.closeUnchanged ? 'CLOSED_UNCHANGED' : 'PLATFORM_UNKNOWN',
                reason:'PLATFORM_BASE_UNCHANGED'};
        },
        processClient:{async request(_tool, command, args) {
            assert.equal(command, 'legacy-source');
            assert.deepEqual(args, ['review-workcopies']);
            return {ok:true,items:[]};
        }},
        vscode:{EventEmitter:class {event = () => ({dispose() {}}); fire() {} dispose() {}},
            workspace:{textDocuments:[]}, window:{
                showQuickPick:async (items, options) => options.canPickMany ? [items[0]] : items[0],
                showWarningMessage:async (_message, _options, action) => confirm ? action : undefined,
                showInformationMessage:async message => notices.push(message),
                showErrorMessage:assert.fail,
            }},
    });
    t.after(() => subscriptions.forEach(subscription => subscription.dispose()));
    await legacy.action(workspace, 'changes');
    assert.deepEqual(checks, [undefined]);
    assert.match(notices.at(-1), /与上传前一致/);
    confirm = true;
    await legacy.action(workspace, 'changes');
    assert.deepEqual(checks, [undefined, undefined, true]);
    assert.match(notices.at(-1), /上传记录已关闭/);
});

test('DATABASE verifies selected upload records and confirms closure only for unchanged source', async t => {
    const {registerLegacyProjects} = require('../src/legacy-project');
    const workspace = {workspaceKey:'projects.db', sourceMode:'database', root:'/fixture/db', displayName:'Fixture'};
    const origin = 'https://platform.test';
    const operations = ['PG-FIRST', 'PG-SECOND', 'PG-MIRROR', 'PG-ERROR', 'PG-UNSELECTED'].map((pageId, index) => ({
        operationId:String(index + 1).repeat(64),
        state:index === 2 ? 'MIRROR_PENDING' : 'PLATFORM_UNKNOWN',
        target:{origin, systemId:'SYS-1', pageId, pageAlias:pageId},
    }));
    const subscriptions = [], checks = [], reports = [], confirmations = [];
    const legacy = registerLegacyProjects({
        context:{subscriptions}, getTool:() => ({toolHome:'/fixture'}), sourceTree:{refresh() {}},
        databasePublicationMode:async () => 'manual',
        async databaseBridgeRequest() {
            return {contexts:[{contextId:'ctx', pageOrigin:origin, systemId:'SYS-1'}]};
        },
        async databasePublicationRequest(_home, route, input) {
            if (route === '/databaseProcedureOperations') return {operations};
            assert.equal(route, '/databaseProcedureVerify');
            const item = operations.find(item => item.operationId === input.operationId);
            checks.push([item.target.pageId, input.closeUnchanged === true, input.contextId]);
            if (item.target.pageId === 'PG-ERROR') throw new Error('谷神页签已关闭');
            if (item.state === 'MIRROR_PENDING') return {...item, state:'VERIFIED'};
            return {...item, state:input.closeUnchanged ? 'CLOSED_UNCHANGED' : item.state, reason:'PLATFORM_BASE_UNCHANGED'};
        },
        processClient:{async request() {return {ok:true,items:[]};}},
        vscode:{EventEmitter:class {event = () => ({dispose() {}}); fire() {} dispose() {}},
            workspace:{textDocuments:[], openTextDocument:async doc => doc}, window:{
                showQuickPick:async (items, options) => options.canPickMany ? items.slice(0, 4) : items[0],
                showWarningMessage:async (_message, {detail}, action) => { confirmations.push(detail); return action; },
                showTextDocument:async doc => reports.push(doc.content),
                showErrorMessage:assert.fail,
            }},
    });
    t.after(() => subscriptions.forEach(subscription => subscription.dispose()));
    await legacy.action(workspace, 'changes');
    assert.deepEqual(checks, [
        ['PG-FIRST', false, 'ctx'], ['PG-SECOND', false, 'ctx'], ['PG-MIRROR', false, undefined], ['PG-ERROR', false, 'ctx'],
        ['PG-FIRST', true, 'ctx'], ['PG-SECOND', true, 'ctx'],
    ]);
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0], /PG-FIRST\nPG-SECOND/);
    assert.match(reports[0], /PG-MIRROR · 谷神与本地只读源码均已更新/);
    assert.match(reports[0], /PG-ERROR · 未能检查 · 谷神页签已关闭/);
    assert.doesNotMatch(reports[0], /PG-UNSELECTED/);
});

test('successful DATABASE sync opens comparison against the new mirror and keeps Workcopy editable', async t => {
    const {registerLegacyProjects} = require('../src/legacy-project');
    const workspace = {workspaceKey:'projects.db', sourceMode:'database', root:'/fixture/project',
        workcopyDir:'/fixture/project/source/workcopy', displayName:'Fixture'};
    const record = {recordId:4, sourceId:'FN-1', sourceType:'procedure', sourcePath:'proc/source.vm',
        name:'Example', trustedBaseline:false, needsMerge:true};
    const subscriptions = [], calls = [];
    let leftProvider, editor, synced = false, merged;
    const legacy = registerLegacyProjects({
        context:{subscriptions}, getTool:() => ({toolHome:'/fixture'}), getWorkspaces:async () => [workspace],
        getSelected:async () => workspace, sourceTree:{refresh() {}}, refreshProjects:async () => {},
        async runTool() {synced = true; return true;},
        vscode:{EventEmitter:class {event = () => ({dispose() {}}); fire() {} dispose() {}},
            Uri:{from:value => ({...value, toString:() => JSON.stringify(value)})}, FileChangeType:{Changed:1},
            workspace:{textDocuments:[], registerTextDocumentContentProvider(scheme, value) {
                if (scheme === 'guthon-database-review-diff') leftProvider = value;
                return {dispose() {}};
            }, registerFileSystemProvider(_scheme, value) {editor = value; return {dispose() {}};}},
            commands:{async executeCommand(command, left, right) {
                assert.equal(command, 'vscode.diff');
                assert.equal(leftProvider.provideTextDocumentContent(left), 'new mirror');
                assert.equal((await editor.readFile(right)).toString(), 'old local');
                await editor.writeFile(right, Buffer.from('merged result'));
            }}, window:{showErrorMessage:assert.fail}},
        processClient:{async request(_tool, _command, [action], _key, input) {
            assert.equal(synced, true);
            calls.push(action);
            if (action === 'review-workcopies') return {ok:true, items:[record]};
            if (action === 'edit-comparison') {
                assert.equal(input.compareMirror, true);
                return {ok:true, changed:true, available:true, baseContent:'new mirror', content:'old local'};
            }
            if (action === 'edit-read') return {ok:true, editable:true, content:'old local', language:'guthon-gss', sourceHash:'old'};
            if (action === 'edit-save') {
                assert.equal(input.sourceHash, 'old');
                merged = input.content;
                return {ok:true, sourceHash:'merged'};
            }
            assert.fail(action);
        }},
    });
    t.after(() => subscriptions.forEach(subscription => subscription.dispose()));
    await legacy.action(workspace, 'pull');
    assert.deepEqual(calls, ['review-workcopies', 'edit-comparison', 'edit-read', 'edit-save']);
    assert.equal(merged, 'merged result');
});

test('project settings route DATABASE and SVN credentials to the selected source provider', async () => {
  const {registerLegacyProjects}=require('../src/legacy-project');
  class Emitter {constructor(){this.event=()=>({dispose(){}});}fire(){}dispose(){}}
  for (const [mode,address] of [['database','mysql://db.example:3306/master'],['svn','https://svn.example/repos/project']]) {
    const workspace={workspaceKey:'ws-'+mode,displayName:mode,sourceMode:mode,configuration:{schemaVersion:3}};
    const calls=[],fields=[],subscriptions=[];
    const value={ok:true,workspaceKey:workspace.workspaceKey,sourceMode:mode,revision:'rev',
      connection:{},sourceTablesConfigured:false,systemAliases:[]};
    const values=[address,'fixture-user','fixture-private-value'];
    const legacy=registerLegacyProjects({
      vscode:{EventEmitter:Emitter,workspace:{textDocuments:[]},window:{
        showQuickPick:()=>assert.fail('connection menu should go directly to the connection input'),
        showInputBox:async options=>{fields.push(options);return values.shift();},
        showInformationMessage(){},showErrorMessage:assert.fail,showWarningMessage:assert.fail}},
      context:{subscriptions},getTool:()=>({toolHome:'/fixture',toolPath:'/tool'}),
      processClient:{request:async (_tool,command,args,key,input)=>{calls.push({command,args,key,input});return value;}},
      sourceTree:{refresh(){}},getWorkspaces:async()=>[workspace],getSelected:async()=>workspace,
      refreshProjects:async()=>{},runTool:()=>assert.fail('settings do not pull source'),
    });
    try {
      await legacy.action(workspace,'connection');
      assert.match(fields[0].title,mode==='database'?/主数据数据库/:/SVN 仓库地址/);
      assert.equal(fields[2].password,true);
      assert(calls.every(call=>call.key===workspace.workspaceKey));
      assert.equal(calls[0].input.action,'show');
      const settings=calls[1].input.connection;
      assert.equal(settings.username,'fixture-user');
      assert.equal(settings.password,'fixture-private-value');
      assert.equal(calls.length,2);
      if(mode==='database') {
        assert.equal(settings.database,'master');
      } else {
        assert.equal(settings.repositoryUrl,address);
      }
    } finally {for(const subscription of subscriptions)subscription.dispose();}
  }
});

test('DATABASE and SVN scope pickers preserve the selected project and save before pulling', async () => {
  const {configureSourceScope}=require('../src/project-source-settings');
  for(const [mode,selected] of [['database','SYS'],['svn','systems/SYS']]) {
    const workspace={workspaceKey:'ws-'+mode,displayName:'fixture',sourceMode:mode};
    const calls=[];
    const current={workspaceKey:workspace.workspaceKey,sourceMode:mode,revision:'rev',
      options:[{id:selected,label:selected}],systemAliases:[],scopePaths:[]};
    const vscode={window:{showQuickPick:async (rows,options)=>{
      assert.equal(options.canPickMany,true);return rows;
    },showInformationMessage:message=>calls.push(message)}};
    await configureSourceScope({vscode,workspace,request:async input=>{
      calls.push(input);return current;
    },refreshProjects:async()=>calls.push('refresh')});
    assert.deepEqual(calls.slice(0,3),[
      {action:'scope-list'},{action:'scope-save',sourceMode:mode,revision:'rev',selected:[selected]},'refresh',
    ]);
  }
});

test('SVN scope picker shows one flat choice for a shared datasource and its subsystems',async()=>{
  const {configureSourceScope}=require('../src/project-source-settings');
  const workspace={workspaceKey:'ws-svn',displayName:'SVN fixture',sourceMode:'svn'};
  const calls=[];
  const choices=[
    {id:'datasources/trade',label:'贸易系统',paths:['datasources/trade','systems/domestic','systems/global']},
    {id:'public',label:'公共源码',paths:['public']},
    {id:'skill',label:'开发建议',paths:['skill']},
  ];
  await configureSourceScope({workspace,vscode:{QuickPickItemKind:{Separator:-1},window:{
    showQuickPick:async rows=>{
      assert.deepEqual(rows.map(row=>row.label),['贸易系统','公共源码','开发建议']);
      assert(rows.every(row=>!row.picked));
      return [rows[0]];
    },showInformationMessage(){},
  }},request:async payload=>{
    if(payload.action==='scope-save')calls.push([payload.selected,payload.grouped]);
    return {workspaceKey:'ws-svn',sourceMode:'svn',revision:'v1',scopePaths:['.'],scopeConfigured:false,options:choices};
  },refreshProjects:async()=>{}});
  assert.deepEqual(calls,[[['datasources/trade'],true]]);
});

test('inline DATABASE and SVN logins use the configured backend and preserve the exact project identity', async()=>{
  const {registerLegacyProjects}=require('../src/legacy-project');
  class Emitter {constructor(){this.event=()=>({dispose(){}});}fire(){}dispose(){}}
  for (const [mode,serverUrl] of [['database','mysql://db.example:3306/master'],['svn','https://svn.example/repos/project']]) {
    const workspace={workspaceKey:'ws-'+mode,sourceMode:mode,configuration:{schemaVersion:3}};
    const subscriptions=[],calls=[];
    const legacy=registerLegacyProjects({
      vscode:{EventEmitter:Emitter,workspace:{textDocuments:[]},window:{}},
      context:{subscriptions},getTool:()=>({toolHome:'/fixture',toolPath:'/tool'}),
      processClient:{request:async (_tool,command,args,key,input)=>{
        calls.push({command,args,key,input});return {ok:true,workspaceKey:key,sourceMode:mode,revision:'checked'};
      }},
      sourceTree:{refresh(){}},getWorkspaces:async()=>[workspace],getSelected:async()=>workspace,
      refreshProjects:async()=>calls.push('refresh'),runTool:()=>assert.fail('login must not start syncing'),
    });
    try {
      await legacy.login(workspace,{serverUrl,userId:' fixture-user ',password:'fixture-secret'});
      assert.deepEqual(calls.map(item=>item.input?.action || item),['show','login','refresh']);
      assert.equal(calls[1].command,'workspace-source-settings');
      assert.equal(calls[1].key,workspace.workspaceKey);
      assert.equal(calls[1].input.revision,'checked');
      assert.deepEqual(calls[1].input.connection,mode==='database'
        ? {type:'mysql',host:'db.example',port:3306,database:'master',username:'fixture-user',password:'fixture-secret'}
        : {repositoryUrl:serverUrl,username:'fixture-user',password:'fixture-secret'});
    } finally {for(const subscription of subscriptions)subscription.dispose();}
  }
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  prepareWorkspaceSetup,
  windowToolHome,
  workspaceSetupCard,
  promptWorkspaceCreation,
  WindowWorkspaceSelection,
  workspaceActions,
} = require('../src/tool-workspace');

test('only the corresponding folders inherit the global data directory',()=>{
  const config={get:()=>'/work/old'};
  assert.equal(windowToolHome(config,['/work/old']),'/work/old');
  assert.equal(windowToolHome(config,['/work/old/var']),'/work/old');
  assert.equal(windowToolHome(config,['/work/old/var/project/source']),'/work/old');
  assert.equal(windowToolHome(config,['/work/old-new']),'');
  assert.equal(windowToolHome(config,['/work/new']),'');
  assert.equal(windowToolHome(config,[]),'');
  assert.equal(windowToolHome(config,['/work/old/other-project']),'');
  assert.equal(windowToolHome({...config,inspect:()=>({workspaceValue:'/work/old'})},['/work/new']),'/work/old');
});

test('the setup card seeds the exact current directory and recognizes an existing var root',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-first-run-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const folder=path.join(home,'自己的开发目录');
  fs.mkdirSync(folder);
  const initial=workspaceSetupCard([folder],'');
  assert.equal(initial.directory,home);
  assert.equal(initial.workspaceRoot,folder);
  assert.equal(initial.action,'初始化此文件夹');
  const window={showOpenDialog:async()=>{throw new Error('current directory does not need a second picker');}};
  assert.deepEqual(await prepareWorkspaceSetup({get:()=>''},window,initial),
    {mode:'setup',toolHome:home,workspaceDirectory:'自己的开发目录'});
  assert.deepEqual(fs.readdirSync(home),['自己的开发目录']);
  fs.mkdirSync(path.join(home,'config'));
  fs.writeFileSync(path.join(home,'config','guthon.json'),JSON.stringify({
    schemaVersion:3,workspaceDirectory:'自己的开发目录',
  }));
  const ready=workspaceSetupCard([folder],'');
  assert.equal(ready.directory,home);
  assert.equal(ready.action,'连接此目录');
  assert.equal(windowToolHome({get:()=>home},[folder]),home);
  assert.equal(windowToolHome({get:()=>home},[path.join(home,'var')]),'');
  assert.deepEqual(await prepareWorkspaceSetup({get:()=>''},window,{directory:ready.directory}),
    {mode:'switch',toolHome:home});
  await assert.rejects(prepareWorkspaceSetup({get:()=>''},window,{directory:home,workspaceDirectory:'other'}),/已绑定的开发目录/);
});

test('attaches an existing data directory without creating or changing its files', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-existing-'));
  try {
    fs.mkdirSync(path.join(home, 'config'));
    fs.writeFileSync(path.join(home, 'config', 'guthon.json'), '{"schemaVersion":2}');
    const index = path.join(home, 'var', 'workspace', 'product', 'context', 'index.db');
    fs.mkdirSync(path.dirname(index), { recursive: true });
    fs.writeFileSync(index, 'existing-index');
    const before = fs.statSync(index).mtimeMs;
    const selected = await prepareWorkspaceSetup({ get: () => '' }, {
      showOpenDialog: async () => [{ fsPath: home }],
    });
    assert.deepEqual(selected, { mode: 'switch', toolHome: home });
    assert.equal(fs.readFileSync(index, 'utf8'), 'existing-index');
    assert.equal(fs.statSync(index).mtimeMs, before);
  } finally {
    fs.rmSync(home, { recursive: true });
  }
});

test('incomplete legacy configuration is not initialized or converted', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-existing-'));
  try {
    fs.mkdirSync(path.join(home, 'config'));
    fs.writeFileSync(path.join(home, 'config', 'sync.yaml'), 'sync: {}');
    assert.equal(require('../src/tool-workspace').hasWorkspaceConfiguration(home),false);
    assert.throws(()=>require('../src/tool-workspace').existingWorkspaceConfig(home),/缺少已有工作空间配置/);
    await assert.rejects(prepareWorkspaceSetup({get:()=>''},{showOpenDialog:async()=>[{fsPath:home}]}),/旧配置不完整/);
    assert.deepEqual(fs.readdirSync(path.join(home,'config')),['sync.yaml']);
  } finally {fs.rmSync(home,{recursive:true});}
});

test('complete legacy YAML attaches without initialization or changing any file',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'guthon-legacy-attach-'));t.after(()=>fs.rmSync(home,{recursive:true}));
  const directory=path.join(home,'config');fs.mkdirSync(directory);
  const names=['products.yaml','projects.yaml','sync.yaml','datasource.yaml','source-tables.yaml'];
  for(const name of names)fs.writeFileSync(path.join(directory,name),'fixture: preserved\n');
  const selected=await prepareWorkspaceSetup({get:()=>''},{showOpenDialog:async()=>[{fsPath:home}]});
  assert.deepEqual(selected,{mode:'switch',toolHome:home});
  assert.deepEqual(fs.readdirSync(directory).sort(),names.sort());assert.equal(fs.existsSync(path.join(home,'var')),false);
  for(const name of names)assert.equal(fs.readFileSync(path.join(directory,name),'utf8'),'fixture: preserved\n');
});

test('continues normal setup when the workspace is not initialized', async () => {
  const config = { get: () => '' };
  const window = {
    showWarningMessage: async () => {
      throw new Error('switch confirmation should not open');
    },
    showOpenDialog: async () => [{ fsPath: '/new/tool/home' }],
  };

  assert.deepEqual(await prepareWorkspaceSetup(config, window), {
    mode: 'setup',
    toolHome: '/new/tool/home',
  });
});

test('reselects the folder when a previous setup left an uninitialized toolHome', async () => {
  const config = { get: () => '/incomplete/tool/home' };
  const window = {
    showWarningMessage: async () => {
      throw new Error('switch confirmation should not open');
    },
    showOpenDialog: async () => [{ fsPath: '/retry/tool/home' }],
  };

  assert.deepEqual(await prepareWorkspaceSetup(config, window), {
    mode: 'setup',
    toolHome: '/retry/tool/home',
  });
});

test('keeps an initialized workspace unless the user confirms a switch', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-workspace-'));
  fs.mkdirSync(path.join(home, 'config'));
  fs.writeFileSync(path.join(home, 'config', 'guthon.json'), '{"schemaVersion":2}');
  const config = {
    get: () => home,
  };
  const window = {
    showWarningMessage: async () => undefined,
    showOpenDialog: async () => {
      throw new Error('folder picker should not open');
    },
  };

  assert.equal(await prepareWorkspaceSetup(config, window), undefined);
  fs.rmSync(home, { recursive: true });
});

test('returns an existing candidate without persisting an initialized workspace switch', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-workspace-'));
  const nextHome = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-workspace-'));
  fs.mkdirSync(path.join(home, 'config'));
  fs.writeFileSync(path.join(home, 'config', 'guthon.json'), '{"schemaVersion":2}');
  fs.mkdirSync(path.join(nextHome, 'config'));
  fs.mkdirSync(path.join(nextHome, 'var'));
  fs.writeFileSync(path.join(nextHome, 'config', 'guthon.json'), '{"schemaVersion":2}');
  const config = {
    get: () => home,
  };
  const window = {
    showWarningMessage: async () => '切换工作空间',
    showOpenDialog: async () => [{ fsPath: nextHome }],
  };

  assert.deepEqual(await prepareWorkspaceSetup(config, window), {
    mode: 'switch',
    toolHome: nextHome,
  });
  fs.rmSync(home, { recursive: true });
  fs.rmSync(nextHome, { recursive: true });
});

test('refreshes the current data directory without opening a folder picker', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-workspace-'));
  try {
    fs.mkdirSync(path.join(home, 'config'));
    fs.writeFileSync(path.join(home, 'config', 'guthon.json'), '{"schemaVersion":2}');
    const selected = await prepareWorkspaceSetup({ get: () => home }, {
      showWarningMessage: async () => '刷新当前状态',
      showOpenDialog: async () => { throw new Error('folder picker should not open'); },
    });
    assert.deepEqual(selected, { mode: 'refresh', toolHome: home });
  } finally {
    fs.rmSync(home, { recursive: true });
  }
});

test('API workspace exposes source, search, metadata and diagnosis actions',()=>{
  const actions=workspaceActions({sourceMode:'api'}),commands=actions.source.map(item=>item[1]);
  for(const command of ['gushenCompletion.pullApiSource','gushenCompletion.searchWorkspace','gushenCompletion.reindexCalls','gushenCompletion.showApiHistory']) assert.ok(commands.includes(command));
  assert.ok(actions.metadata.some(item=>item[1]==='gushenCompletion.configureDatabaseDiagnosis'));assert.equal(actions.diagnose,true);
});

test('asks for a name and an explicit source mode, and cancels without a definition',async()=>{
  const config={ok:true,initialized:true,mode:'unified',schemaVersion:3,workspaceSourceModes:['api','svn','database']};
  for(const value of config.workspaceSourceModes) {
    const result=await promptWorkspaceCreation({showInputBox:async()=> ' 风险开发 ',
      showQuickPick:async items=>{assert.equal(items.length,3);return items.find(item=>item.sourceMode===value);}},config);
    assert.deepEqual(result,{name:'风险开发',sourceMode:value});
  }
  assert.equal(await promptWorkspaceCreation({showInputBox:async()=> '撤销',showQuickPick:async()=>undefined},config),undefined);
});

test('legacy runtime gets an explicit product/project kind and a neutral generated ID',async()=>{
  for(const [mode,kind] of [['legacy','project'],['unified','product']]){
    const result=await promptWorkspaceCreation({
      showInputBox:async()=> ' 风险开发 ',
      showQuickPick:async items=>items.find(item=>item.sourceMode==='api' || item.kind===kind),
    },{ok:true,initialized:true,mode,migrationAvailable:mode==='legacy'});
    assert.match(result.id,/^ws_[a-f0-9]{32}$/);
    assert.deepEqual({...result,id:undefined},{name:'风险开发',id:undefined,kind,sourceMode:'api'});
  }
});

test('legacy configuration in the unified runtime requires a separate upgrade',async()=>{
  await assert.rejects(promptWorkspaceCreation(
    {showInputBox:async()=>{throw new Error('name prompt must not open');}},
    {ok:true,initialized:true,mode:'legacy',schemaVersion:0}),/先按配置升级流程/);
});

test('root window requires an explicit selection, independent windows do not share it',async()=>{
  const all=[{workspaceKey:'ws_a',name:'A',root:'/home/var/A',checkoutPath:'/home/var/A/checkout'}];
  let changes=0,picks=0;
  const options={getWorkspaces:async()=>all,getFolders:()=>['/home/var'],window:{showQuickPick:async items=>{picks++;return items[0];}},onChange:()=>changes++};
  const first=new WindowWorkspaceSelection(options),second=new WindowWorkspaceSelection(options);
  assert.equal(await first.current(),undefined);
  assert.equal((await first.select()).workspaceKey,'ws_a');
  assert.equal((await first.current()).workspaceKey,'ws_a');
  await first.select('ws_a',{switchWindow:true});
  assert.equal(await second.current(),undefined);assert.equal(picks,1);assert.equal(changes,2);
  const legacy=new WindowWorkspaceSelection({...options,getFolders:()=>['/home/var/A/checkout']});
  assert.equal((await legacy.current()).workspaceKey,'ws_a');
});

test('late workspace picker cannot override a later switch',async()=>{
  let finish;const options={getWorkspaces:async()=>[{workspaceKey:'a'},{workspaceKey:'b'}],getFolders:()=>['/home/var'],
    window:{showQuickPick:items=>items[0].workspace.workspaceKey==='a' && !finish ? new Promise(resolve=>{finish=()=>resolve(items[0]);}) : Promise.resolve(items[1])}};
  const selection=new WindowWorkspaceSelection(options);
  const earlier=selection.select('',{switchWindow:true});await new Promise(resolve=>setImmediate(resolve));
  await selection.select('',{switchWindow:true});finish();await earlier;
  assert.equal((await selection.current()).workspaceKey,'b');
});

test('a single-file initialized home can be selected before generated var data exists',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-one-config-'));
  try {
    fs.mkdirSync(path.join(root,'config'));fs.writeFileSync(path.join(root,'config','guthon.json'),'{}');
    assert.doesNotThrow(()=>require('../src/tool-workspace').existingWorkspaceConfig(root));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('window selection is restored on restart only for a registered key',async()=>{
  const values=new Map(),state={get:(key,fallback)=>values.get(key) ?? fallback,update:async(key,value)=>value===undefined?values.delete(key):values.set(key,value)};
  let workspaces=[{workspaceKey:'same',root:'/a/var/project'}],picks=0;
  const options={state,getScope:()=>'/a',getWorkspaces:async()=>workspaces,getFolders:()=>['/a/var'],window:{showQuickPick:async items=>{picks++;return items[0];}}};
  const first=new WindowWorkspaceSelection(options);assert.equal(await first.current(),undefined);
  await first.select();const reopened=new WindowWorkspaceSelection(options);
  assert.equal((await reopened.current()).workspaceKey,'same');assert.equal(picks,1);
  workspaces=[];assert.equal(await reopened.current(),undefined);
  workspaces=[{workspaceKey:'same',root:'/a/var/project'}];
  assert.equal(await new WindowWorkspaceSelection(options).current(),undefined);
});

test('toolHome scopes isolate identical ids and running windows retain their own selection',async()=>{
  const values=new Map(),state={get:(key,fallback)=>values.get(key) ?? fallback,update:async(key,value)=>value===undefined?values.delete(key):values.set(key,value)};
  let home='/a',choice=0;
  const workspaces=[{workspaceKey:'same',root:'/unrelated/one'},{workspaceKey:'other',root:'/unrelated/two'}];
  const options={state,getScope:()=>home,getWorkspaces:async()=>workspaces,getFolders:()=>[home+'/var'],window:{showQuickPick:async items=>items[choice]}};
  const first=new WindowWorkspaceSelection(options);await first.select();
  const second=new WindowWorkspaceSelection(options);assert.equal((await second.current()).workspaceKey,'same');
  choice=1;await second.select('',{switchWindow:true});
  assert.equal((await first.current()).workspaceKey,'same');
  home='/b';assert.equal(await first.current(),undefined);
  choice=0;await first.select();assert.equal((await first.current()).workspaceKey,'same');
  home='/a';assert.equal((await first.current()).workspaceKey,'other');
  home='/c';assert.equal(await new WindowWorkspaceSelection(options).current(),undefined);
});

test('a picker for an old toolHome cannot save into a new toolHome',async()=>{
  const values=new Map(),state={get:(key,fallback)=>values.get(key) ?? fallback,update:async(key,value)=>values.set(key,value)};
  let home='/a',finish;const selection=new WindowWorkspaceSelection({state,getScope:()=>home,getWorkspaces:async()=>[{workspaceKey:'same'}],getFolders:()=>[],
    window:{showQuickPick:items=>new Promise(resolve=>{finish=()=>resolve(items[0]);})}});
  const pending=selection.select();await new Promise(resolve=>setImmediate(resolve));home='/b';finish();
  assert.equal(await pending,undefined);assert.equal(values.size,0);assert.equal(await selection.current(),undefined);
});

test('temporarily unavailable runtime does not erase the saved selection',async()=>{
  const values=new Map(),state={get:(key,fallback)=>values.get(key) ?? fallback,update:async(key,value)=>value===undefined?values.delete(key):values.set(key,value)};
  let home='/a',available=true;
  const options={state,getScope:()=>available?home:'',getWorkspaces:async()=>available?[{workspaceKey:'same'}]:[],getFolders:()=>['/a/var'],window:{showQuickPick:async items=>items[0]}};
  await new WindowWorkspaceSelection(options).select();
  available=false;const reopened=new WindowWorkspaceSelection(options);assert.equal(await reopened.current(),undefined);
  available=true;assert.equal((await reopened.current()).workspaceKey,'same');
});

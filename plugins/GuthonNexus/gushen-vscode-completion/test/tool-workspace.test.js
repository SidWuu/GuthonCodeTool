const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  prepareWorkspaceSetup,
  promptWorkspaceCreation,
  suggestedWorkspaceId,
  workspaceActions,
} = require('../src/tool-workspace');

test('attaches an existing data directory without creating or changing its files', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-existing-'));
  try {
    fs.mkdirSync(path.join(home, 'config'));
    for (const name of ['sync.yaml', 'products.yaml', 'projects.yaml']) {
      fs.writeFileSync(path.join(home, 'config', name), `${name}: existing\n`);
    }
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

test('rejects a directory without existing workspace configuration', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-existing-'));
  try {
    fs.mkdirSync(path.join(home, 'config'));
    fs.writeFileSync(path.join(home, 'config', 'sync.yaml'), 'sync: {}');
    await assert.rejects(
      prepareWorkspaceSetup({ get: () => '' }, { showOpenDialog: async () => [{ fsPath: home }] }),
      /缺少已有工作空间配置/
    );
    assert.deepEqual(fs.readdirSync(home), ['config']);
  } finally {
    fs.rmSync(home, { recursive: true });
  }
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
  fs.writeFileSync(path.join(home, 'config', 'sync.yaml'), 'sync: {}');
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
  fs.writeFileSync(path.join(home, 'config', 'sync.yaml'), 'sync: {}');
  fs.mkdirSync(path.join(nextHome, 'config'));
  fs.mkdirSync(path.join(nextHome, 'var'));
  for (const name of ['sync.yaml', 'products.yaml', 'projects.yaml']) {
    fs.writeFileSync(path.join(nextHome, 'config', name), `${name}: existing\n`);
  }
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
    fs.writeFileSync(path.join(home, 'config', 'sync.yaml'), 'sync: {}');
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

test('suggests readable ids and stable fallback ids for Chinese names', () => {
  assert.equal(suggestedWorkspaceId('Risk Center', 'product'), 'risk-center');
  assert.equal(
    suggestedWorkspaceId('风险管理', 'project', new Date(2026, 8, 9, 10, 8)),
    'project-202609091008'
  );
});

test('creates an API project without a source selector',async()=>{
  let picks=0;const inputs=['风险开发','risk-dev'];
  const result=await promptWorkspaceCreation({showQuickPick:async()=>{picks++;return {label:'项目',value:'project'};},showInputBox:async()=>inputs.shift()},[], '/not/used');
  assert.deepEqual(result,{kind:'project',id:'risk-dev',name:'风险开发',sourceMode:'api'});assert.equal(picks,1);
});

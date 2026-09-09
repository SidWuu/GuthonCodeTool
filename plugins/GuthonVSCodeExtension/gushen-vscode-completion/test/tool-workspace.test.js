const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  configuredSvnUsername,
  prepareWorkspaceSetup,
  promptWorkspaceCreation,
  suggestedWorkspaceId,
  workspaceActions,
} = require('../src/tool-workspace');

test('continues normal setup when the workspace is not initialized', async () => {
  const config = { get: () => '' };
  const window = {
    showWarningMessage: async () => {
      throw new Error('switch confirmation should not open');
    },
  };

  assert.equal(await prepareWorkspaceSetup(config, window, 'global'), 'setup');
});

test('keeps an initialized workspace unless the user confirms a switch', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-workspace-'));
  fs.mkdirSync(path.join(home, 'config'));
  fs.writeFileSync(path.join(home, 'config', 'sync.yaml'), 'sync: {}');
  const updates = [];
  const config = {
    get: () => home,
    update: async (...args) => updates.push(args),
  };
  const window = {
    showWarningMessage: async () => undefined,
    showOpenDialog: async () => {
      throw new Error('folder picker should not open');
    },
  };

  assert.equal(await prepareWorkspaceSetup(config, window, 'global'), undefined);
  assert.deepEqual(updates, []);
  fs.rmSync(home, { recursive: true });
});

test('updates toolHome after an initialized workspace switch is confirmed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-workspace-'));
  fs.mkdirSync(path.join(home, 'config'));
  fs.writeFileSync(path.join(home, 'config', 'sync.yaml'), 'sync: {}');
  const updates = [];
  const config = {
    get: () => home,
    update: async (...args) => updates.push(args),
  };
  const window = {
    showWarningMessage: async () => '切换工作空间',
    showOpenDialog: async () => [{ fsPath: '/new/tool/home' }],
  };

  assert.equal(await prepareWorkspaceSetup(config, window, 'global'), 'switch');
  assert.deepEqual(updates, [['toolHome', '/new/tool/home', 'global']]);
  fs.rmSync(home, { recursive: true });
});

test('SVN workspace actions come only from effective capabilities', () => {
  const actions = workspaceActions({
    sourceMode: 'svn',
    capabilities: {
      'svn.initialize': true,
      'svn.refresh': true,
      'svn.status': true,
      'svn.reindex': true,
      'svn.browse': true,
      'svn.revert': true,
      'svn.workcopy': true,
      'svn.writeback': false,
    },
  });

  assert.deepEqual(actions.source.map((item) => item[1]), [
    'gushenCompletion.importSvnScope',
    'gushenCompletion.initializeSvn',
    'gushenCompletion.reindexCalls',
    'gushenCompletion.focusSvnSource',
    'gushenCompletion.manageSvnChanges',
    'gushenCompletion.exportMarkdown',
  ]);
  assert.deepEqual(actions.workcopy, []);
  assert.deepEqual(actions.metadata, []);
  assert.equal(actions.diagnose, false);
  assert.equal(actions.syncAll, undefined);
});

test('database workspace keeps pull, metadata and diagnosis actions', () => {
  const actions = workspaceActions({ sourceMode: 'database', capabilities: {} });

  assert.deepEqual(actions, {
    source: [
      ['拉取源码重建索引', 'gushenCompletion.initSourceIndex', 'database'],
      ['拉取源码', 'gushenCompletion.syncWorkspaceSource', 'sync'],
      ['重建索引', 'gushenCompletion.reindexCalls', 'refresh'],
      ['导出源码索引文档', 'gushenCompletion.exportMarkdown', 'book'],
    ],
    workcopy: [['检查或打包 Workcopy', 'gushenCompletion.inspectWorkcopy', 'package']],
    metadata: [
      ['导出表结构', 'gushenCompletion.exportSchema', 'table'],
      ['导出单据类型', 'gushenCompletion.exportBillTypes', 'list-tree'],
      ['导出系统脚本', 'gushenCompletion.exportSystemScripts', 'file-code'],
      ['导出视图源码', 'gushenCompletion.exportViews', 'eye'],
    ],
    diagnose: true,
    syncAll: ['同步工作区全部资料', 'gushenCompletion.syncWorkspaceAll', 'cloud-download'],
  });
});

test('suggests readable ids and stable fallback ids for Chinese names', () => {
  assert.equal(suggestedWorkspaceId('Risk Center', 'product'), 'risk-center');
  assert.equal(
    suggestedWorkspaceId('风险管理', 'project', new Date(2026, 8, 9, 10, 8)),
    'project-202609091008'
  );
});

test('reads an existing shared SVN username', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-workspace-'));
  fs.mkdirSync(path.join(home, 'config'));
  fs.writeFileSync(path.join(home, 'config', 'sync.yaml'), 'svn:\n  username: "u10001"\n\nsync: {}\n');

  assert.equal(configuredSvnUsername(home), 'u10001');
  fs.rmSync(home, { recursive: true });
});

test('prompts an independent SVN project and reuses the shared username', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-workspace-'));
  fs.mkdirSync(path.join(home, 'config'));
  fs.writeFileSync(path.join(home, 'config', 'sync.yaml'), 'svn:\n  username: u10001\n');
  const quickPicks = [
    { label: '项目', value: 'project' },
    { label: 'SVN', value: 'svn' },
  ];
  const inputs = ['风险开发', 'risk-dev'];
  const window = {
    showQuickPick: async () => quickPicks.shift(),
    showInputBox: async () => inputs.shift(),
    showWarningMessage: async () => undefined,
  };

  const result = await promptWorkspaceCreation(window, [], home);

  assert.deepEqual(result, {
    kind: 'project',
    id: 'risk-dev',
    name: '风险开发',
    sourceMode: 'svn',
  });
  fs.rmSync(home, { recursive: true });
});

test('collects a DATABASE connection without environment-variable setup', async () => {
  const quickPicks = [
    { label: '产品', value: 'product' },
    { label: 'DATABASE', value: 'database' },
  ];
  const inputs = ['核心产品', 'core', 'core-dev', 'db.local', '3307', 'core_db', 'dev', 'secret'];
  const result = await promptWorkspaceCreation({
    showQuickPick: async () => quickPicks.shift(),
    showInputBox: async () => inputs.shift(),
  }, [], '/not/used');

  assert.deepEqual(result.datasource, {
    id: 'core-dev',
    host: 'db.local',
    port: 3307,
    database: 'core_db',
    username: 'dev',
    password: 'secret',
    environment: 'dev',
  });
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareWorkspaceSetup } = require('../src/tool-workspace');

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
    showWarningMessage: async () => '切换工作区',
    showOpenDialog: async () => [{ fsPath: '/new/tool/home' }],
  };

  assert.equal(await prepareWorkspaceSetup(config, window, 'global'), 'switch');
  assert.deepEqual(updates, [['toolHome', '/new/tool/home', 'global']]);
  fs.rmSync(home, { recursive: true });
});

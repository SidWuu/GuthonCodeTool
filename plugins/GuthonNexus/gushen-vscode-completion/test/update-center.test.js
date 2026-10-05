const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./update-fixture');
const { createUpdateCenter } = require('../src/update-center');
const { withUpdateLock } = require('../src/tool-updater');
const { updateRoot, readJson } = require('../src/component-update');

function host(t, f, loadedVersion = '2.4.0', profile = loadedVersion, options = {}) {
  const home = path.join(f.root, 'home'), storage = path.join(f.root, 'editor-' + profile), development = path.join(f.root, 'development');
  fs.mkdirSync(storage, { recursive: true }); fs.mkdirSync(development, { recursive: true }); fs.writeFileSync(path.join(development, 'VERSION'), '0.4.0');
  fs.copyFileSync(f.trustFile, path.join(storage, 'release-trust.json'));
  const backend = path.join(f.root, 'backend'); fs.writeFileSync(backend, 'fixture backend');
  const values = { toolHome: home, executionMode: 'packaged', developmentRoot: development, updateSource: 'github', autoCheckUpdates: false };
  const commands = [], busy = [], messages = [];
  let requests = 0;
  const vscode = { version: '1.105.0', ConfigurationTarget: { Global: 1 }, ProgressLocation: { Notification: 1 }, StatusBarAlignment: { Right: 1 },
    Uri: { file: file => ({ fsPath: file }) }, env: { clipboard: { writeText: async () => {} } },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => values[key] ?? fallback, update: async (key, value) => { values[key] = value; } }) },
    commands: { getCommands: async () => ['workbench.extensions.installExtension'], executeCommand: async (command, uri) => {
      commands.push(command);
      if (command === 'workbench.extensions.installExtension') {
        assert.ok(fs.existsSync(uri.fsPath));
        await withUpdateLock(updateRoot(home), async () => {});
        await withUpdateLock(storage, async () => {});
        options.beforeInstall?.();
      }
    } },
    window: { createStatusBarItem: () => ({ show() {}, dispose() {} }),
      withProgress: async (_options, action) => action({ report() {} }),
      showInformationMessage: async message => { messages.push(message); return message.includes('确认更新') ? '下载并更新' : '稍后'; },
      showQuickPick: async list => list[0],
      showWarningMessage: async () => '继续使用核心功能',
      showErrorMessage: async message => { throw new Error(message); },
    } };
  const bridge = { isRunning: () => false, start() {}, stop: async () => {}, request: async () => ({ clients: [] }) };
  const tree = {};
  const center = createUpdateCenter({ vscode, context: { extensionPath: f.root, globalStorageUri: { fsPath: storage } },
    bridge, processClient: { stop: async () => {} },
    getTool: () => ({ mode: 'packaged', toolPath: backend, toolHome: home }),
    processRunner: async () => ({ stdout: '{"version":"0.4.0"}' }),
    loadedVersion, isBusy: () => false, setBusy: value => busy.push(value), refresh() {}, treeView: tree,
    fetchRelease: async () => { requests++; return f.release; }, verify: async () => f.signed(),
  });
  t.after(() => center.dispose());
  return { center, tree, commands, busy, messages, values, storage, home, requests: () => requests };
}

test('daily cached signed metadata is shared while each editor computes its actual Nexus version', async t => {
  const f = fixture(t), first = host(t, f);
  await first.center.check(); assert.equal(first.tree.badge.value, 1); assert.equal(first.requests(), 1);
  await first.center.check(); assert.equal(first.requests(), 1);
  const newer = host(t, f, '2.5.0');
  await newer.center.check(); assert.equal(newer.requests(), 0); assert.equal(newer.tree.badge, undefined);
  assert.equal(newer.center.snapshot.rows.find(item => item.id === 'nexus').current, '2.5.0');
});
test('release modes treat a signed release without catalog as information and never install', async t => {
  const f = fixture(t); f.legacy(); const h = host(t, f);
  await h.center.open();
  assert.equal(h.center.snapshot.error, undefined);
  assert.equal(h.center.snapshot.unavailable, true);
  assert.equal(h.center.snapshot.current.toolVersion, '0.4.0');
  assert.equal(h.center.snapshot.rows.find(row => row.id === 'nexus').current, '2.4.0');
  assert.ok(h.messages.some(message => message.includes('尚未提供三组件更新信息')));
  assert.deepEqual(h.commands, []); assert.deepEqual(h.busy, []);
  const calls = h.requests(); await h.center.check(false);
  assert.equal(h.requests(), calls);
  assert.equal(h.center.snapshot.error, undefined);
});
test('tampered cached catalog is rejected rather than trusted for badges', async t => {
  const f = fixture(t), h = host(t, f); await h.center.check();
  const file = path.join(updateRoot(h.home), 'check.json'), state = readJson(file);
  state.bytes.catalogBytes = Buffer.from('{"schemaVersion":1}').toString('base64');
  fs.writeFileSync(file, JSON.stringify(state));
  await h.center.check(true);
  assert.equal(h.center.snapshot.error, undefined);
  // Force uses fresh signed metadata. Corrupt only the cache for the quiet path.
  fs.writeFileSync(file, JSON.stringify(state));
  const result = await h.center.check(false); assert.match(result.error, /哈希/);
});
test('self-install releases data locks; installation is pending until reload and is not repeated', async t => {
  const f = fixture(t), h = host(t, f);
  // Replace network downloading with a loopback HTTP fixture via the existing
  // injectable preparation dependency in the UI controller.
  const https = require('node:https'), { PassThrough } = require('node:stream'), original = https.get;
  https.get = (url, _options, respond) => {
    const stream = new PassThrough(); stream.statusCode = 200; stream.headers = {};
    const request = { setTimeout() {}, on() {}, destroy() {} };
    queueMicrotask(() => { respond(stream); stream.end(f.data[new URL(url).pathname.slice(1)]); });
    return request;
  };
  t.after(() => { https.get = original; });
  await h.center.open();
  assert.ok(h.commands.includes('workbench.extensions.installExtension'));
  assert.deepEqual(h.busy, [true, false]);
  assert.equal(readJson(path.join(updateRoot(h.home), 'operation.json')).pendingReload, true);
  assert.equal(h.center.snapshot.count, 0); assert.equal(h.center.snapshot.pending, true);
  await h.center.open();
  assert.equal(h.commands.filter(command => command === 'workbench.extensions.installExtension').length, 1);
  const buddy = host(t, f, '2.4.0', 'codebuddy');
  await buddy.center.check();
  assert.equal(buddy.center.snapshot.rows.find(item => item.id === 'nexus').update, true);
});
test('host replacement leaves no data locks and the new host reconciles its own installation', async t => {
  const f = fixture(t);
  let h;
  h = host(t, f, '2.4.0', 'same-profile', { beforeInstall: () => h.center.dispose() });
  const https = require('node:https'), { PassThrough } = require('node:stream'), original = https.get;
  https.get = (url, _options, respond) => {
    const stream = new PassThrough(); stream.statusCode = 200; stream.headers = {};
    queueMicrotask(() => { respond(stream); stream.end(f.data[new URL(url).pathname.slice(1)]); });
    return { setTimeout() {}, on() {}, destroy() {} };
  };
  t.after(() => { https.get = original; });
  await h.center.open();
  assert.equal(fs.existsSync(path.join(updateRoot(h.home), '.application-update.lock')), false);
  assert.equal(fs.existsSync(path.join(h.storage, '.application-update.lock')), false);
  assert.equal(readJson(path.join(h.storage, 'nexus-install.json')).phase, 'INSTALLING');
  const next = host(t, f, '2.5.0', 'same-profile');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(readJson(path.join(next.storage, 'nexus-install.json')).phase, 'ACTIVE');
});

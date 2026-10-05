const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zip, rules } = require('./update-fixture');
const { localRelease, prepareLocalUpdate } = require('../src/local-update');
const { packageFingerprint, chromeFiles } = require('../src/extension-package');
const { updatePlan, applyUpdate, managedChrome } = require('../src/component-update');
const { createUpdateCenter } = require('../src/update-center');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-local-update-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = path.join(home, 'source'), nexus = path.join(source, 'plugins/GuthonNexus/gushen-vscode-completion'), chrome = path.join(source, 'plugins/GuthonBridge/extension');
  function write(relative, value) {
    const file = path.join(source, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
  }
  write('VERSION', '0.3.1');
  write('plugins/GuthonNexus/gushen-vscode-completion/package.json', JSON.stringify({ publisher: 'gushen-local', name: 'guthon-nexus-vscode', version: '2.5.0', engines: { vscode: '^1.75.0' } }));
  write('plugins/GuthonNexus/gushen-vscode-completion/src/main.js', 'local nexus');
  write('plugins/GuthonNexus/gushen-vscode-completion/README.md', 'local readme');
  write('plugins/GuthonBridge/bridge/server.js', 'const CLIENT="../../GuthonNexus/gushen-vscode-completion/src/tool-process-client";');
  write('plugins/GuthonBridge/bridge/page-context.js', 'local contexts');
  write('plugins/GuthonBridge/bridge/browser-updates.js', 'local updates');
  write('scripts/common/command_metadata.json', '{"schemaVersion":1,"defaultTimeoutMs":1000,"commands":{},"svnActions":{}}');
  write('plugins/GuthonBridge/extension/manifest.json', '{"name":"Guthon Bridge","manifest_version":3,"version":"0.3.1"}');
  write('plugins/GuthonBridge/extension/background.js', 'local chrome');
  write('plugins/GuthonBridge/extension/host-settings.js', 'globalThis.GuthonBridgeHostSettings = ' + JSON.stringify(rules) + ';');
  function runner(_command, args, options) {
    const out = args.includes('package') ? args[args.indexOf('--out') + 1] : args[3];
    const directory = args.includes('package') ? options.cwd : path.join(options.cwd, 'extension');
    const entries = {};
    function walk(dir, relative = '') {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const name = relative ? relative + '/' + item.name : item.name;
        if (item.isDirectory()) walk(path.join(dir, item.name), name);
        else entries['extension/' + name] = fs.readFileSync(path.join(dir, item.name));
      }
    }
    walk(directory); fs.writeFileSync(out, zip(entries)); return Promise.resolve({ stdout: '' });
  }
  return { home, source, nexus, chrome, write, runner };
}
test('local versions come from the explicit source tree; generated Bridge source is authoritative without repo writes', t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.nexus, 'src/main.js'));
  const info = localRelease(f.source);
  assert.equal(info.release.source, 'local'); assert.equal(info.catalog.components.nexus.version, '2.5.0');
  assert.ok(info.nexusFiles.get('bridge/server.js').toString().includes('../src/tool-process-client'));
  assert.equal(fs.existsSync(path.join(f.nexus, 'bridge/server.js')), false);
  assert.deepEqual(fs.readFileSync(path.join(f.nexus, 'src/main.js')), before);
  assert.throws(() => localRelease(''), /developmentRoot/);
});
test('same-version code changes are detected, while managed host settings are intentionally preserved', t => {
  const f = fixture(t), original = localRelease(f.source);
  const current = { mode: 'source-development', toolVersion: '0.3.1', nexusVersion: '2.5.0', chromeVersion: '0.3.1',
    nexusBuildId: original.catalog.components.nexus.buildId, chromeBuildId: original.catalog.components.bridge.buildId };
  assert.ok(updatePlan(original.catalog, current).every(row => !row.update));
  f.write('plugins/GuthonNexus/gushen-vscode-completion/src/main.js', 'changed nexus');
  f.write('plugins/GuthonBridge/extension/background.js', 'changed chrome');
  const changed = updatePlan(localRelease(f.source).catalog, current);
  assert.equal(changed[0].update, false); assert.equal(changed[1].codeChanged, true); assert.equal(changed[2].codeChanged, true);
});
test('local build snapshots use installed tools, apply plugin files and never replace backend or source artifacts', async t => {
  const f = fixture(t), local = localRelease(f.source);
  const plan = updatePlan(local.catalog, { mode: 'source-development', nexusVersion: '2.4.0' });
  const before = fs.readFileSync(path.join(f.chrome, 'background.js'));
  const prepared = await prepareLocalUpdate(local, plan, path.join(f.home, 'updates'),
    { pythonPath: '/fixture/python', processRunner: f.runner, packager: '/fixture/vsce' });
  const result = await applyUpdate(prepared, path.join(f.home, 'updates'), { mode: 'source-development',
    installNexus: async file => assert.ok(fs.existsSync(file)), switchBackend: async () => assert.fail('source backend must be retained') });
  assert.deepEqual(result.completed, ['bridge', 'nexus']);
  assert.deepEqual(fs.readFileSync(path.join(f.chrome, 'background.js')), before);
  assert.equal(fs.existsSync(path.join(f.nexus, 'guthon-nexus-vscode.vsix')), false);
  const managed = managedChrome(path.join(f.home, 'updates'));
  assert.equal(packageFingerprint(chromeFiles(managed.directory), new Set(['host-settings.js'])), local.catalog.components.bridge.buildId);
});
test('changing the source after inspection aborts local compilation', async t => {
  const f = fixture(t), local = localRelease(f.source);
  f.write('plugins/GuthonBridge/extension/background.js', 'changed after check');
  await assert.rejects(prepareLocalUpdate(local, updatePlan(local.catalog, { mode: 'source-development', nexusVersion: '2.4.0' }), path.join(f.home, 'updates'),
    { pythonPath: '/fixture/python', processRunner: () => assert.fail('must not build'), packager: '/fixture/vsce' }), /源码已改变/);
});
test('development-mode check never calls release providers and reports local code changes without a remote catalog', async t => {
  const f = fixture(t), values = { executionMode: 'source-development', developmentRoot: f.source, toolHome: f.home, autoCheckUpdates: false };
  const storage = path.join(f.home, 'editor');
  const center = createUpdateCenter({ vscode: { StatusBarAlignment: { Right: 1 }, window: { createStatusBarItem: () => ({ show() {}, dispose() {} }) },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => values[key] ?? fallback }) } },
    context: { extensionPath: f.nexus, globalStorageUri: { fsPath: storage } },
    getTool: () => ({ mode: 'source-development' }), loadedVersion: '2.5.0', loadedBuildId: 'previous-build',
    bridge: { isRunning: () => false }, refresh() {}, isBusy: () => false, setBusy() {},
    fetchRelease: () => assert.fail('must not contact release sources'), verify: () => assert.fail('must not verify remote release') });
  t.after(() => center.dispose());
  await center.check(true);
  assert.equal(center.snapshot.error, undefined);
  assert.equal(center.snapshot.source, 'local');
  assert.equal(center.snapshot.rows.find(row => row.id === 'nexus').codeChanged, true);
  assert.ok(center.snapshot.info.includes(f.source));
});

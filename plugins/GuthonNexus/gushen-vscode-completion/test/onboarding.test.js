const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOnboarding, readiness, page, nextAction } = require('../src/onboarding');

function readyEvidence() {
  return { report: { state: 'environment-ready', version: '0.3.1', nexusVersion: '2.5.0', guardMinimumVersion: '0.2.10', installedAt: '2026-10-08T00:00:00Z' },
    toolVersion: '0.3.1', nexusVersion: '2.5.0',
    hook: { schemaVersion: 1, ready: true, event: 'SessionStart', pluginVersion: '0.2.10', observedAt: '2026-10-08T01:00:00Z' },
    chrome: { installId: 'id', version: '0.3.1' }, clients: [{ installId: 'id', version: '0.3.1', protocolVersion: 2 }] };
}

test('tool and plugin runtime checks are required; configuration files alone do not mean ready', () => {
  assert.equal(readiness(readyEvidence()).complete, true);
  for (const mutation of [
    x => x.hook = {}, x => x.hook.ready = false, x => x.hook.observedAt = '2026-10-07T00:00:00Z',
    x => x.hook.pluginVersion = '0.2.9', x => x.clients = [],
    x => x.clients[0].installId = 'old-install',
    x => x.toolVersion = '0.3.0', x => x.nexusVersion = '2.4.0',
  ]) {
    const evidence = readyEvidence(); mutation(evidence);
    assert.equal(readiness(evidence).complete, false);
  }
});

test('installation steps only check tools, plugins and browser environment', () => {
  assert.equal(nextAction({}), 'refresh');
  assert.equal(nextAction({ tool: true }), 'team');
  assert.equal(nextAction({ tool: true, team: true }), 'chrome');
  assert.equal(nextAction({ tool: true, team: true, bridge: true }), 'finish');
});

test('HTML escapes errors and never emits pairing tokens', () => {
  const html = page({ error: '<img onerror=x>' }, 'nonce');
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes('nonce-nonce'));
});

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-onboarding-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const write = (relative, value) => { const file = path.join(home, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  const evidence = readyEvidence();
  write('var/nexus/setup-result.json', { ...evidence.report, bundleId: 'bundle' });
  write('var/.guthon/hook-runtime.json', evidence.hook);
  write('var/nexus/onboarding.json', { schemaVersion: 1 });
  write('var/nexus/updates/chrome/extension/managed-install.json', { schemaVersion: 1, version: '0.3.1', installId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  write('var/nexus/updates/chrome/extension/manifest.json', { version: '0.3.1' });
  fs.writeFileSync(path.join(home, 'var/nexus/updates/chrome/extension/host-settings.js'), 'globalThis.GuthonBridgeHostSettings = ' + JSON.stringify({ protocols: ['http:', 'https:'], ipRanges: [], domainSuffixes: ['old.example.test'], pathPrefixes: ['/guthon/'] }) + ';');
  let message, disposed = false;
  const panel = { webview: { html: '', onDidReceiveMessage: fn => { message = fn; } }, reveal() {}, onDidDispose: fn => { panel.onDispose = fn; }, dispose() { disposed = true; panel.onDispose?.(); } };
  const calls = [];
  const vscode = { ViewColumn: { One: 1 }, workspace: { isTrusted: true, getConfiguration: () => ({ get: () => true }) },
    window: { createWebviewPanel: () => panel, showInformationMessage: async () => undefined, showQuickPick: async () => undefined },
    commands: { executeCommand: async (...args) => { calls.push(args); return false; } },
    env: { clipboard: { writeText: async text => calls.push(['clipboard', text]) } } };
  const wizard = createOnboarding({ vscode, context: { extension: { packageJSON: { version: '2.5.0' } } },
    getTool: () => ({ toolHome: home, toolPath: '/fixture/tool', mode: 'packaged' }),
    client: { run: async (_key, command) => { assert.equal(command, 'version', 'must not query business workspaces or indexes'); return { version: '0.3.1' }; } },
    getWorkspaces: async () => assert.fail('installation must not enumerate business workspaces'),
    bridge: { isRunning: () => true, request: async () => ({ clients: [{ installId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', version: '0.3.1', protocolVersion: 2 }] }) } });
  t.after(() => wizard.dispose());
  return { home, wizard, vscode, panel, calls, write, disposed: () => disposed, message: value => message(value) };
}

test('successful onboarding persists completion and avoids reopening on later launches', async t => {
  const f = fixture(t);
  await f.wizard.openIfNeeded();
  assert.ok(f.panel.webview.html.includes('后续在 CodeBuddy 中使用 GuthonNexus'));
  assert.ok(!f.panel.webview.html.includes('检出并建立索引'));
  await f.wizard.action('finish');
  assert.equal(f.disposed(), true);
  const state = JSON.parse(fs.readFileSync(path.join(f.home, 'var/nexus/onboarding.json')));
  assert.equal(state.completedBundleId, 'bundle');
  assert.equal(state.workspaceKey, undefined);
  f.vscode.window.createWebviewPanel = () => assert.fail('completed installation must not reopen during normal use');
  await f.wizard.openIfNeeded();
});

test('a pending plugin cannot finish and installation cannot start business operations', async t => {
  const f = fixture(t);
  f.write('var/.guthon/hook-runtime.json', {});
  await f.wizard.open();
  await f.wizard.action('login');
  assert.deepEqual(f.calls, []);
  assert.ok(!f.calls.some(call => call[0] === 'gushenCompletion.initializeSvn'));
  await f.wizard.action('finish');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, 'var/nexus/onboarding.json'))).completedAt, undefined);
  assert.ok(f.panel.webview.html.includes('仍有未通过'));
});

test('untrusted workspaces cannot execute onboarding commands', async t => {
  const f = fixture(t); f.vscode.workspace.isTrusted = false;
  await f.wizard.action('add');
  assert.deepEqual(f.calls, []);
});

test('platform setup removes SPA fragments and retains existing path authorization', async t => {
  const f = fixture(t);
  f.vscode.window.showInputBox = async () => 'https://portal.example.test/guthon/#/login';
  await f.wizard.open();
  await f.wizard.action('hosts');
  const state = JSON.parse(fs.readFileSync(path.join(f.home, 'var/nexus/onboarding.json')));
  assert.equal(state.platformUrl, 'https://portal.example.test/guthon/');
  const source = fs.readFileSync(path.join(f.home, 'var/nexus/updates/chrome/extension/host-settings.js'), 'utf8');
  const rules = require('../src/component-update').hostSettings(source);
  assert.deepEqual(rules.pathPrefixes, ['/guthon/']);
  assert.ok(rules.domainSuffixes.includes('old.example.test'));
  assert.ok(rules.domainSuffixes.includes('portal.example.test'));
});

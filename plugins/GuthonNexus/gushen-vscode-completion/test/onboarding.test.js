const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOnboarding, readiness, page, nextAction } = require('../src/onboarding');

function readyEvidence() {
  return { report: { bundleId: 'bundle', marketplaceUrl: 'ssh://git@example.test/team/guthon-team.git',
      state: 'environment-ready', version: '0.3.1', nexusVersion: '2.5.0', guardMinimumVersion: '0.2.10', installedAt: '2026-10-08T00:00:00Z' },
    governanceBundleId: 'bundle',
    toolVersion: '0.3.1', nexusVersion: '2.5.0',
    hook: { schemaVersion: 1, ready: true, event: 'SessionStart', pluginVersion: '0.2.10', observedAt: '2026-10-08T01:00:00Z' },
    chrome: { installId: 'id', version: '0.3.1' }, clients: [{ installId: 'id', version: '0.3.1', protocolVersion: 2 }] };
}

test('configured team governance gates completion independently of lifecycle hooks', () => {
  assert.equal(readiness(readyEvidence()).complete, true);
  for (const mutation of [
    x => x.governanceBundleId = 'old-bundle',
    x => x.toolVersion = '0.3.0', x => x.nexusVersion = '2.4.0',
  ]) {
    const evidence = readyEvidence(); mutation(evidence);
    assert.equal(readiness(evidence).complete, false);
  }
  const evidence = readyEvidence();
  evidence.hook = {};
  assert.equal(readiness(evidence).complete, true);
  assert.equal(readiness(evidence).team, false);
});

test('installation steps only check tools, plugins and browser environment', () => {
  assert.equal(nextAction({}), 'refresh');
  assert.equal(nextAction({ tool: true }), 'finish');
  const { report } = readyEvidence();
  assert.equal(nextAction({ tool: true, report }), 'repository');
  assert.equal(nextAction({ tool: true, report, governance: true }), 'finish');
});

test('API-only installation completes while optional browser pairing stays independently unverified',()=>{
  const evidence=readyEvidence();evidence.clients=[];
  assert.deepEqual(readiness(evidence),{tool:true,governance:true,team:true,bridge:false,complete:true});
  evidence.clients=[{installId:'other',version:evidence.chrome.version,protocolVersion:2}];
  assert.equal(readiness(evidence).bridge,false);assert.equal(readiness(evidence).complete,true);
});

test('HTML escapes errors and never emits pairing tokens', () => {
  const html = page({ error: '<img onerror=x>' }, 'nonce');
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes('nonce-nonce'));
});

function fixture(t, { marketplace = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-onboarding-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const write = (relative, value) => { const file = path.join(home, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  const evidence = readyEvidence();
  if (!marketplace) {
    delete evidence.report.marketplaceUrl;
    delete evidence.governanceBundleId;
  }
  write('var/nexus/setup-result.json', { ...evidence.report, bundleId: 'bundle' });
  write('var/.guthon/hook-runtime.json', evidence.hook);
  write('var/nexus/onboarding.json', { schemaVersion: 1, governanceBundleId: evidence.governanceBundleId });
  write('var/nexus/updates/chrome/extension/managed-install.json', { schemaVersion: 1, version: '0.3.1', installId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  write('var/nexus/updates/chrome/extension/manifest.json', { version: '0.3.1' });
  fs.writeFileSync(path.join(home, 'var/nexus/updates/chrome/extension/host-settings.js'), 'globalThis.GuthonBridgeHostSettings = ' + JSON.stringify({ protocols: ['http:', 'https:'], ipRanges: [], domainSuffixes: ['old.example.test'], pathPrefixes: ['/guthon/'] }) + ';');
  let message, disposed = false;
  const panel = { webview: { html: '', onDidReceiveMessage: fn => { message = fn; } }, reveal() {}, onDidDispose: fn => { panel.onDispose = fn; }, dispose() { disposed = true; panel.onDispose?.(); } };
  const calls = [];
  const vscode = { ViewColumn: { One: 1 }, workspace: { isTrusted: true, getConfiguration: () => ({ get: () => true }) },
    Uri: { file: fsPath => ({ fsPath }) },
    window: { createWebviewPanel: () => panel, showInformationMessage: async () => undefined, showQuickPick: async () => undefined },
    commands: { executeCommand: async (...args) => { calls.push(args); return false; } },
    env: { clipboard: { writeText: async text => calls.push(['clipboard', text]) } } };
  const wizard = createOnboarding({ vscode, context: { extension: { packageJSON: { version: '2.5.0' } } },
    getTool: () => ({ toolHome: home, toolPath: '/fixture/tool', mode: 'packaged' }),
    repositoryCheck: async source => { assert(marketplace); assert.equal(source, evidence.report.marketplaceUrl); },
    client: { run: async (_key, command, args) => {
      if (command === 'version') return { version: '0.3.1' };
      assert(marketplace, 'installation without a rule source must not call setup');
      assert.equal(command, 'setup', 'must not query business workspaces or indexes');
      assert.deepEqual(args, ['--team-source', evidence.report.marketplaceUrl]);
      return { governance: 'ready' };
    } },
    getWorkspaces: async () => assert.fail('installation must not enumerate business workspaces'),
    bridge: { isRunning: () => true, request: async () => ({ clients: [{ installId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', version: '0.3.1', protocolVersion: 2 }] }) } });
  t.after(() => wizard.dispose());
  return { home, wizard, vscode, panel, calls, write, disposed: () => disposed, message: value => message(value) };
}

test('successful onboarding persists completion and avoids reopening on later launches', async t => {
  const f = fixture(t);
  await f.wizard.openIfNeeded();
  assert.ok(f.panel.webview.html.includes('后续在当前 IDE 中使用 GuthonNexus'));
  assert.ok(!f.panel.webview.html.includes('检出并建立索引'));
  await f.wizard.action('finish');
  assert.equal(f.disposed(), true);
  const state = JSON.parse(fs.readFileSync(path.join(f.home, 'var/nexus/onboarding.json')));
  assert.equal(state.completedBundleId, 'bundle');
  assert.equal(state.workspaceKey, undefined);
  f.vscode.window.createWebviewPanel = () => assert.fail('completed installation must not reopen during normal use');
  await f.wizard.openIfNeeded();
});

test('installation without a team source can open the development directory and finish with manual rules', async t => {
  const f = fixture(t, { marketplace: false });
  const rules = path.join(f.home, 'var/AGENTS.md');
  fs.writeFileSync(rules, 'department rules');
  await f.wizard.openIfNeeded();
  assert.match(f.panel.webview.html, /手动放入部门规则/);
  assert(!f.panel.webview.html.includes('data-action="repository"'));
  assert.equal((await f.wizard.snapshot()).governance, false);
  assert.equal((await f.wizard.snapshot()).complete, true);
  await f.wizard.action('workspace');
  assert.deepEqual(f.calls, [['revealFileInOS', { fsPath: path.join(f.home, 'var') }]]);
  await f.wizard.action('continue');
  assert.equal(f.disposed(), true);
  assert.equal(fs.readFileSync(rules, 'utf8'), 'department rules');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, 'var/nexus/onboarding.json'))).completedBundleId, 'bundle');
});

test('onboarding synchronizes the team bundle before finishing, with no agent hook', async t => {
  const f = fixture(t);
  f.write('var/.guthon/hook-runtime.json', {});
  f.write('var/nexus/onboarding.json', { schemaVersion: 1 });
  await f.wizard.open();
  await f.wizard.action('login');
  assert.deepEqual(f.calls, []);
  assert.ok(!f.calls.some(call => call[0] === 'gushenCompletion.initializeSvn'));
  await f.wizard.action('finish');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, 'var/nexus/onboarding.json'))).completedAt, undefined);
  assert.ok(f.panel.webview.html.includes('仍有未通过'));
  await f.wizard.action('continue');
  assert.equal((await f.wizard.snapshot()).complete, true);
  assert.equal((await f.wizard.snapshot()).team, false);
  await f.wizard.action('finish');
  assert.equal(f.disposed(), true);
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

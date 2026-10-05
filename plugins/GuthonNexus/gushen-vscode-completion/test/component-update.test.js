const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { signingPayload } = require('../src/release-signature');
const { verifiedRelease, ASSETS, CATALOG_ASSET, NEXUS_ID, ReleaseCatalogUnavailable } = require('../src/release-catalog');
const { readArchive } = require('../src/update-archive');
const { updateRoot, saveJson, managedChrome, updatePlan, hostSettings, prepareUpdate, applyUpdate, interruptedUpdate } = require('../src/component-update');
const { localDay, needsDailyCheck, supportsEditor } = require('../src/update-center');

const { fixture, zip, rules } = require('./update-fixture');

test('three-component catalog is signed; versions and per-file hashes cannot be swapped', async t => {
  const f = fixture(t); const verified = await f.signed();
  assert.equal(verified.catalog.components.nexus.version, '2.5.0');
  f.data[CATALOG_ASSET] = Buffer.from(JSON.stringify({ ...f.catalog, releaseVersion: '99.0.0' }));
  await assert.rejects(f.signed(), /哈希/);
});
test('missing mirror assets and missing catalog fail before any install', async t => {
  const f = fixture(t); f.release.assets = f.release.assets.filter(item => item.name !== ASSETS.nexus);
  await assert.rejects(f.signed(), /缺少/);
  f.release.assets = f.release.assets.filter(item => item.name !== CATALOG_ASSET);
  await assert.rejects(f.signed(), /缺少/);
});
test('signed older releases return an explicit unsupported capability; unsigned catalog claims still fail', async t => {
  const f = fixture(t); f.legacy();
  await assert.rejects(f.signed(), error => error instanceof ReleaseCatalogUnavailable && error.release.version === '0.4.0');
  f.release.assets.push({ name: CATALOG_ASSET, url: 'https://fixture.example/catalog' });
  await assert.rejects(f.signed(), /未被签名摘要覆盖/);
});
test('missing catalog does not hide an invalid release signature', async t => {
  const f = fixture(t); f.legacy();
  const value = JSON.parse(f.data['GuthonCodeTool-checksums.signature.json']);
  value.signature = Buffer.alloc(64).toString('base64');
  f.data['GuthonCodeTool-checksums.signature.json'] = Buffer.from(JSON.stringify(value));
  await assert.rejects(f.signed(), /signature verification failed/);
});
test('version planning is independent; source checkout is never updated and newer components are kept', t => {
  const f = fixture(t);
  const plan = updatePlan(f.catalog, { mode: 'source-development', nexusVersion: '2.6.0', toolVersion: '0.5.0', chromeVersion: '0.5.0' });
  assert.ok(plan.every(item => !item.update));
  assert.equal(plan[0].status, '工具源码由开发者管理');
});
test('ZIP traversal, symlink and case-collision inputs are rejected before extraction', t => {
  const f = fixture(t);
  for (const [entries, modes] of [[{ '../escape': 'x' }, {}], [{ 'extension/a': 'x', 'extension/A': 'y' }, {}], [{ 'extension/link': 'outside' }, { 'extension/link': 0xa1ff }]]) {
    const file = path.join(f.root, 'bad.zip'); fs.writeFileSync(file, zip(entries, modes));
    assert.throws(() => readArchive(file), /不安全|重复/);
  }
});
test('downloads and validates all assets before switching; Nexus installs last and partial steps can resume', async t => {
  const f = fixture(t); const verified = await f.signed();
  const plan = updatePlan(f.catalog, f.current);
  const runner = async (_file, args) => ({ stdout: args[0] === 'version' ? '{"version":"0.4.0"}' : '' });
  const prepared = await prepareUpdate(verified, plan, f.root, { platform: 'win32', arch: 'x64', downloader: f.downloader, processRunner: runner });
  const calls = [];
  await assert.rejects(applyUpdate(prepared, f.root, { mode: 'packaged', platform: 'win32', arch: 'x64', bundledTrustFile: f.trustFile,
    switchBackend: async () => { calls.push('tool'); return { toolPath: 'previous' }; },
    installNexus: async () => { calls.push('nexus'); assert.equal(managedChrome(f.root).version, '0.4.0'); throw new Error('fixture editor install failure'); } }), /fixture editor/);
  assert.deepEqual(calls, ['tool', 'nexus']);
  const record = interruptedUpdate(f.root); assert.equal(record.phase, 'PARTIAL'); assert.deepEqual(record.completed, ['tool', 'bridge']);
  const retryPlan = updatePlan(f.catalog, { ...f.current, toolVersion: '0.4.0', chromeVersion: '0.4.0' });
  const retry = await prepareUpdate(verified, retryPlan, f.root, { downloader: f.downloader });
  const done = await applyUpdate(retry, f.root, { mode: 'packaged', installNexus: async () => calls.push('nexus-retry'), switchBackend: async () => assert.fail('already updated') });
  assert.equal(done.phase, 'INSTALLED'); assert.equal(done.pendingReload, true);
  assert.equal(interruptedUpdate(f.root, '2.5.0').pendingReload, false);
});
test('corrupt downloads do not switch runtime or overwrite managed files', async t => {
  const f = fixture(t); const verified = await f.signed();
  await assert.rejects(prepareUpdate(verified, updatePlan(f.catalog, f.current), f.root, { platform: 'win32', arch: 'x64',
    downloader: async (_url, file) => fs.writeFileSync(file, 'tampered') }), /校验/);
  assert.equal(fs.existsSync(path.join(f.root, 'operation.json')), false);
});
test('Chrome host rules and installation identity survive replacement', async t => {
  const f = fixture(t), original = path.join(f.root, 'chrome', 'extension');
  fs.mkdirSync(original, { recursive: true });
  const id = crypto.randomUUID(); saveJson(path.join(original, 'managed-install.json'), { schemaVersion: 1, installId: id, version: '0.3.0' });
  saveJson(path.join(original, 'manifest.json'), { version: '0.3.0' });
  const customized = { ...rules, domainSuffixes: ['custom.example.com'] };
  fs.writeFileSync(path.join(original, 'host-settings.js'), 'globalThis.GuthonBridgeHostSettings = ' + JSON.stringify(customized) + ';');
  const plan = updatePlan(f.catalog, { ...f.current, toolVersion: '0.4.0', nexusVersion: '2.5.0', chromeVersion: '0.3.0' });
  const prepared = await prepareUpdate(await f.signed(), plan, f.root, { downloader: f.downloader });
  await applyUpdate(prepared, f.root, { mode: 'packaged' });
  assert.equal(managedChrome(f.root).installId, id);
  assert.deepEqual(hostSettings(fs.readFileSync(path.join(original, 'host-settings.js'), 'utf8')), customized);
});
test('debug pyz and matching requirements are prepared and probed without running pip', async t => {
  const f = fixture(t); const plan = updatePlan(f.catalog, { ...f.current, mode: 'script', nexusVersion: '2.5.0', chromeVersion: '0.4.0' });
  let probe;
  const prepared = await prepareUpdate(await f.signed(), plan, f.root, { mode: 'script', pythonPath: '/fixture/python', downloader: f.downloader,
    scriptProbe: async runtime => { probe = runtime; return { version: '0.4.0', missingProviders: ['oracledb'] }; } });
  assert.equal(probe.toolPath, '/fixture/python');
  assert.equal(path.basename(probe.toolEntry), ASSETS.script);
  assert.ok(fs.existsSync(path.join(prepared.scriptDirectory, ASSETS.requirements)));
  assert.deepEqual(prepared.missingProviders, ['oracledb']);
});
test('interrupted directory swap restores its owned backup and rejects injected paths', t => {
  const f = fixture(t), parent = path.join(f.root, 'chrome'), backup = path.join(parent, '.backup-fixture');
  fs.mkdirSync(backup, { recursive: true });
  saveJson(path.join(f.root, 'operation.json'), { phase: 'APPLYING', chrome: { directory: path.join(parent, 'extension'), backup } });
  interruptedUpdate(f.root); assert.ok(fs.existsSync(path.join(parent, 'extension')));
  saveJson(path.join(f.root, 'operation.json'), { phase: 'APPLYING', chrome: { directory: '/outside', backup } });
  assert.throws(() => interruptedUpdate(f.root), /路径无效/);
});
test('daily check uses local calendar days, retries failures, and changing source bypasses backoff', () => {
  const now = new Date(2026, 9, 5, 12);
  assert.equal(localDay(now), '2026-10-05');
  assert.equal(needsDailyCheck({ source: 'gitee', day: '2026-10-05' }, 'gitee', now), false);
  assert.equal(needsDailyCheck({ source: 'gitee', lastAttempt: now.getTime() - 1000 }, 'gitee', now), false);
  assert.equal(needsDailyCheck({ source: 'gitee', lastAttempt: now.getTime() }, 'github', now), true);
  assert.equal(supportsEditor('^1.75.0', '1.105.0'), true);
  assert.equal(supportsEditor('^1.75.0', '1.74.0'), false);
});
test('release catalog builder reads actual packaged component versions', t => {
  const f = fixture(t), assets = path.join(f.root, 'release'); fs.mkdirSync(assets);
  for (const name of Object.values(ASSETS)) fs.writeFileSync(path.join(assets, name), f.data[name]);
  const script = path.resolve(__dirname, '../../../../scripts/build_release_catalog.mjs');
  execFileSync(process.execPath, [script, '--release-dir', assets, '--version', '0.4.0']);
  const built = JSON.parse(fs.readFileSync(path.join(assets, CATALOG_ASSET)));
  assert.equal(built.components.nexus.version, '2.5.0');
  assert.equal(built.components.bridge.protocolVersion, 2);
});

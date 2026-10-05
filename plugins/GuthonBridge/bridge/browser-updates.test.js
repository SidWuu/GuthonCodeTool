const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createBrowserUpdates } = require('./browser-updates');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-browser-update-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let time = 1000000, busy = false;
  const registry = createBrowserUpdates(home, { now: () => time, busy: () => busy });
  const parent = path.join(home, 'var/nexus/updates/chrome'), directory = path.join(parent, 'extension');
  fs.mkdirSync(directory, { recursive: true });
  const installId = crypto.randomUUID();
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ version: '0.4.0' }));
  fs.writeFileSync(path.join(directory, 'managed-install.json'), JSON.stringify({ installId, version: '0.4.0' }));
  fs.writeFileSync(path.join(parent, 'reload-request.json'), JSON.stringify({ installId, version: '0.4.0', requestedAt: time }));
  const payload = { clientId: crypto.randomUUID(), extensionId: 'a'.repeat(32), installId, version: '0.3.0', protocolVersion: 2 };
  return { registry, payload, directory, setBusy: value => { busy = value; }, tick: ms => { time += ms; } };
}
test('reload is bound to the managed installation, actual loaded version and idle state', t => {
  const f = fixture(t);
  assert.equal(f.registry.heartbeat(f.payload, 'chrome-extension://' + 'a'.repeat(32)).reload, true);
  f.setBusy(true); assert.equal(f.registry.heartbeat(f.payload).reload, false);
  f.setBusy(false);
  assert.equal(f.registry.heartbeat({ ...f.payload, installId: crypto.randomUUID() }).reload, false);
  assert.equal(f.registry.heartbeat({ ...f.payload, version: '0.4.0' }).reload, false);
  assert.throws(() => f.registry.heartbeat({ ...f.payload, arbitraryPath: '/outside' }), /身份/);
  assert.throws(() => f.registry.heartbeat(f.payload, 'chrome-extension://' + 'b'.repeat(32)), /身份/);
});
test('maintenance admission is atomic, rejects active business work and requires its owner', t => {
  const f = fixture(t); f.setBusy(true); assert.throws(() => f.registry.acquire(), /操作执行中/);
  f.setBusy(false); const guard = f.registry.acquire();
  assert.equal(f.registry.heartbeat(f.payload).reload, false);
  assert.throws(() => f.registry.acquire(), /锁定/);
  assert.throws(() => f.registry.release('other'), /不属于/);
  f.registry.release(guard.id); assert.equal(f.registry.heartbeat(f.payload).reload, true);
  f.tick(150001); assert.deepEqual(f.registry.list(), []);
});
test('same-version local code reload is driven by immutable source build identity', t => {
  const f = fixture(t);
  const desired = 'sha256:' + 'a'.repeat(64);
  // Use the fixture's owned marker file, not a client-provided filesystem path.
  const directory = f.directory;
  const current = JSON.parse(fs.readFileSync(path.join(directory, 'managed-install.json')));
  fs.writeFileSync(path.join(directory, 'managed-install.json'), JSON.stringify({ ...current, sourceBuildId: desired }));
  const payload = { ...f.payload, version: '0.4.0', sourceBuildId: 'sha256:' + 'b'.repeat(64) };
  assert.equal(f.registry.heartbeat(payload).reload, true);
  assert.equal(f.registry.heartbeat(payload).targetBuildId, desired);
  assert.equal(f.registry.heartbeat({ ...payload, sourceBuildId: desired }).reload, false);
});

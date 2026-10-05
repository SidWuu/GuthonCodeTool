const test = require('node:test');
const assert = require('node:assert/strict');
const { heartbeat } = require('./component-client');
test('Chrome reports its own runtime identity and reloads once when idle', async () => {
  const calls = [];
  const chrome = { runtime: { id: 'a'.repeat(32), getURL: file => 'chrome-extension://aaa/' + file,
    getManifest: () => ({ version: '0.3.0' }), reload: () => calls.push('reload') },
    storage: { local: { get: async () => ({ guthonBridgePendingJobs: {} }) } } };
  let posted;
  await heartbeat({ chrome, clientId: async () => 'client-1234567890',
    fetchFile: async () => ({ ok: true, json: async () => ({ installId: 'installation', version: '0.4.0' }) }),
    request: async (route, payload) => { posted = { route, payload }; return { reload: true, targetVersion: '0.4.0' }; } });
  assert.equal(posted.payload.extensionId, chrome.runtime.id);
  assert.equal(posted.payload.version, '0.3.0');
  assert.deepEqual(calls, ['reload']);
});
test('pending or unknown writes defer reload', async () => {
  let reloaded = false, posted;
  const chrome = { runtime: { id: 'a'.repeat(32), getURL: file => file,
    getManifest: () => ({ version: '0.3.0' }), reload: () => { reloaded = true; } },
    storage: { local: { get: async () => ({ guthonBridgePendingJobs: { task: { state: 'UNKNOWN' } } }) } } };
  const result = await heartbeat({ chrome, clientId: async () => 'client-1234567890',
    fetchFile: async () => ({ ok: true, json: async () => ({ installId: 'installation', version: '0.4.0' }) }),
    request: async (_route, payload) => { posted = payload; return { reload: true, targetVersion: '0.4.0' }; } });
  assert.equal(posted.installId, 'installation');
  assert.equal(result.reloadDeferred, true); assert.equal(reloaded, false);
});
test('unmanaged clients cannot be made to reload by a server hint', async () => {
  let reloaded = false, posted;
  const chrome = { runtime: { id: 'a'.repeat(32), getURL: file => file,
    getManifest: () => ({ version: '0.3.0' }), reload: () => { reloaded = true; } },
    storage: { local: { get: async () => ({}) } } };
  await heartbeat({ chrome, clientId: async () => 'client-1234567890',
    fetchFile: async () => { throw new Error('not managed'); },
    request: async (_route, payload) => { posted = payload; return { reload: true, targetVersion: '0.4.0' }; } });
  assert.equal(posted.installId, ''); assert.equal(reloaded, false);
});
test('same manifest version can reload when a local source build has changed', async () => {
  const previous = globalThis.GuthonBridgeSourceBuildId;
  globalThis.GuthonBridgeSourceBuildId = 'sha256:' + 'b'.repeat(64);
  let reloaded = false;
  const desired = 'sha256:' + 'a'.repeat(64);
  const chrome = { runtime: { id: 'a'.repeat(32), getURL: file => file,
    getManifest: () => ({ version: '0.3.1' }), reload: () => { reloaded = true; } },
    storage: { local: { get: async () => ({}) } } };
  try {
    await heartbeat({ chrome, clientId: async () => 'client-1234567890',
      fetchFile: async () => ({ ok: true, json: async () => ({ installId: 'installation', version: '0.3.1', sourceBuildId: desired }) }),
      request: async () => ({ reload: true, targetVersion: '0.3.1', targetBuildId: desired }) });
    assert.equal(reloaded, true);
  } finally {
    if (previous === undefined) delete globalThis.GuthonBridgeSourceBuildId; else globalThis.GuthonBridgeSourceBuildId = previous;
  }
});

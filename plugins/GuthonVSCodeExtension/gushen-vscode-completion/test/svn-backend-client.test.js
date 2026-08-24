const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { SvnBackendClient } = require('../src/svn/backend-client');

function fakeSpawn(calls, payload = { ok: true }) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: (value) => { calls.at(-1).input = value; } };
    calls.push({ command, args, options });
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify(payload)));
      child.emit('close', 0);
    });
    return child;
  };
}

test('routes SVN backend calls through the selected packaged runtime and workspaceKey', async () => {
  const calls = [];
  const client = new SvnBackendClient({
    getTool: async () => ({ toolPath: '/tool', toolHome: '/home' }),
    getEnvironment: async () => ({ GUTHON_NEXUS_SVN_PASSWORD: 'secret' }),
    spawnProcess: fakeSpawn(calls, { ok: true, modules: [] }),
  });
  await client.catalog('projects.demo');
  assert.deepEqual(calls[0].args, ['svn', '--home', '/home', '--workspace', 'projects.demo', '--', 'catalog']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.GUTHON_NEXUS_SVN_PASSWORD, 'secret');
  assert.equal(calls[0].args.includes('secret'), false);
});

test('passes virtual source text only through stdin', async () => {
  const calls = [];
  const client = new SvnBackendClient({
    getTool: async () => ({ toolPath: '/tool', toolHome: '/home' }),
    spawnProcess: fakeSpawn(calls),
  });
  await client.write('projects.demo', 'session', 'document', 'secret source');
  assert.equal(calls[0].args.includes('secret source'), false);
  assert.deepEqual(JSON.parse(calls[0].input), { content: 'secret source' });
});

test('loads page fragments independently from the catalog', async () => {
  const calls = [];
  const client = new SvnBackendClient({
    getTool: async () => ({ toolPath: '/tool', toolHome: '/home' }),
    spawnProcess: fakeSpawn(calls, { ok: true, fragments: [] }),
  });
  await client.fragments('products.demo', { sourceType: 'page', sourceId: 'PG-1', funId: '' });
  assert.deepEqual(calls[0].args, [
    'svn', '--home', '/home', '--workspace', 'products.demo', '--',
    'fragments', '--source-type', 'page', '--source-id', 'PG-1',
  ]);
});

test('decodes UTF-8 output only after joining process chunks', async () => {
  const client = new SvnBackendClient({
    getTool: async () => ({ toolPath: '/tool', toolHome: '/home' }),
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: () => {} };
      process.nextTick(() => {
        const output = Buffer.from(JSON.stringify({ ok: true, label: '国内贸易' }), 'utf8');
        const split = output.indexOf(Buffer.from('贸', 'utf8')) + 1;
        child.stdout.emit('data', output.subarray(0, split));
        child.stdout.emit('data', output.subarray(split));
        child.emit('close', 0);
      });
      return child;
    },
  });
  const result = await client.catalog('products.demo');
  assert.equal(result.label, '国内贸易');
});

test('previews the workspace BAT scope without passing source URLs through arguments', async () => {
  const calls = [];
  const client = new SvnBackendClient({
    getTool: async () => ({ toolPath: '/tool', toolHome: '/home' }),
    spawnProcess: fakeSpawn(calls, { ok: true, entries: 3, added: 3, removed: 0, modified: 0 }),
  });
  const result = await client.scopePreview('products.demo');
  assert.equal(result.entries, 3);
  assert.deepEqual(calls[0].args, [
    'svn', '--home', '/home', '--workspace', 'products.demo', '--', 'scope-preview',
  ]);
});

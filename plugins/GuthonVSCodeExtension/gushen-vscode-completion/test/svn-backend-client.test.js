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
    spawnProcess: fakeSpawn(calls, { ok: true, modules: [] }),
  });
  await client.catalog('projects.demo');
  assert.deepEqual(calls[0].args, ['svn', '--home', '/home', '--workspace', 'projects.demo', '--', 'catalog']);
  assert.equal(calls[0].options.shell, false);
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

test('passes an empty optional SVN commit message through stdin', async () => {
  const calls = [];
  const client = new SvnBackendClient({
    getTool: async () => ({ toolPath: '/tool', toolHome: '/home' }),
    spawnProcess: fakeSpawn(calls),
  });
  await client.platformSave('projects.demo', {
    sessionId: 'session',
    selectionToken: 'token',
  }, ['candidate'], '');
  assert.deepEqual(JSON.parse(calls[0].input), { message: '' });
});

test('streams backend progress from stderr without breaking UTF-8 chunks', async () => {
  const messages = [];
  const client = new SvnBackendClient({
    getTool: async () => ({ toolPath: '/tool', toolHome: '/home' }),
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: () => {} };
      process.nextTick(() => {
        const progress = Buffer.from('[SVN] 提交｜执行 commit\n', 'utf8');
        child.stderr.emit('data', progress.subarray(0, 9));
        child.stderr.emit('data', progress.subarray(9));
        child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true }), 'utf8'));
        child.emit('close', 0);
      });
      return child;
    },
  });

  await client.scmStatus('projects.demo', false, { onOutput: (value) => messages.push(value) });

  assert.equal(messages.join(''), '[SVN] 提交｜执行 commit\n');
});

test('passes scoped working-copy selections to SVN SCM status', async () => {
  const calls = [];
  const client = new SvnBackendClient({
    getTool: async () => ({ toolPath: '/tool', toolHome: '/home' }),
    spawnProcess: fakeSpawn(calls),
  });

  await client.scmStatus('products.demo', true, {
    workingCopyIds: ['datasources-0015', 'systems-SYS-DD01', 'datasources-0015'],
  });

  assert.deepEqual(calls[0].args.slice(-6), [
    'scm-status', '--remote',
    '--working-copy', 'datasources-0015',
    '--working-copy', 'systems-SYS-DD01',
  ]);
});

test('passes scoped working-copy selections to SVN preview', async () => {
  const calls = [];
  const client = new SvnBackendClient({
    getTool: async () => ({ toolPath: '/tool', toolHome: '/home' }),
    spawnProcess: fakeSpawn(calls),
  });

  await client.preview('products.demo', 'platform-save', 'session', {
    workingCopyIds: ['datasources-0015', 'systems-SYS-DD01', 'datasources-0015'],
  });

  assert.deepEqual(calls[0].args.slice(-6), [
    '--session', 'session',
    '--working-copy', 'datasources-0015',
    '--working-copy', 'systems-SYS-DD01',
  ]);
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

test('passes exact-path and working-copy SVN refresh selections', async () => {
  const calls = [];
  const client = new SvnBackendClient({
    getTool: async () => ({ toolPath: '/tool', toolHome: '/home' }),
    spawnProcess: fakeSpawn(calls, { ok: true, updated: [] }),
  });
  await client.refresh('products.demo', {
    sourcePath: 'pages/SYS-1/PG-1.json',
    mergeLocal: true,
  });
  await client.refresh('products.demo', {
    workingCopyIds: ['pages-SYS-1', 'procedures-DS-1'],
  });
  assert.deepEqual(calls[0].args.slice(-3), [
    '--path', 'pages/SYS-1/PG-1.json', '--merge-local',
  ]);
  assert.deepEqual(calls[1].args.slice(-4), [
    '--working-copy', 'pages-SYS-1', '--working-copy', 'procedures-DS-1',
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

test('imports pasted SVN scope through stdin without exposing URLs in arguments', async () => {
  const calls = [];
  const client = new SvnBackendClient({
    getTool: async () => ({ toolPath: '/tool', toolHome: '/home' }),
    spawnProcess: fakeSpawn(calls, { ok: true, added: 2 }),
  });
  await client.scopeImport('projects.demo', 'svn checkout https://example.invalid/repo/skill skill', 'script');
  assert.deepEqual(calls[0].args.slice(-2), ['--', 'scope-import']);
  assert.deepEqual(JSON.parse(calls[0].input), {
    text: 'svn checkout https://example.invalid/repo/skill skill',
    source: 'script',
  });
  assert.equal(calls[0].args.includes('example.invalid'), false);
});

test('passes the one-time SVN password only through stdin for native caching', async () => {
  const calls = [];
  const client = new SvnBackendClient({
    getTool: async () => ({ toolPath: '/tool', toolHome: '/home' }),
    spawnProcess: fakeSpawn(calls, { ok: true, action: 'authentication-cached' }),
  });

  await client.cacheAuthentication('products.demo', 'demo-password');
  assert.deepEqual(calls[0].args, [
    'svn', '--home', '/home', '--workspace', 'products.demo', '--', 'auth-cache',
  ]);
  assert.equal(calls[0].args.includes('demo-password'), false);
  assert.deepEqual(JSON.parse(calls[0].input), { password: 'demo-password' });
});

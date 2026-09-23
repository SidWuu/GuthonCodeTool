const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { readWorkspaces, WorkspaceRegistry } = require('../src/workspace-registry');

function spawnResult({ stdout = '', stderr = '', code = 0 } = {}) {
  return (_command, _args, _options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    return child;
  };
}

test('reads the machine-readable multi-workspace registry', async () => {
  const workspaces = [{ workspaceKey: 'products.a' }, { workspaceKey: 'projects.b' }];
  const result = await readWorkspaces(
    { mode: 'packaged', toolPath: '/tool', toolHome: '/home' },
    spawnResult({ stdout: JSON.stringify({ ok: true, workspaces }) })
  );
  assert.deepEqual(result, workspaces);
});

test('rejects an invalid workspace registry instead of silently showing no projects', async () => {
  await assert.rejects(
    readWorkspaces(
      { mode: 'packaged', toolPath: '/tool', toolHome: '/home' },
      spawnResult({ stdout: JSON.stringify({ ok: true }) })
    ),
    /工作区列表无效/
  );
});

test('shares one request across views and invalidates after a workspace change', async () => {
  let reads = 0;
  let finish;
  const registry = new WorkspaceRegistry(() => {
    reads += 1;
    return new Promise((resolve) => { finish = resolve; });
  });
  const tool = { toolPath: '/tool', toolHome: '/home' };
  const first = registry.get(tool);
  const second = registry.get(tool);
  await Promise.resolve();
  assert.equal(reads, 1);
  finish([{ workspaceKey: 'products.a' }]);
  assert.deepEqual(await first, await second);
  assert.deepEqual(await registry.get(tool), [{ workspaceKey: 'products.a' }]);
  assert.equal(reads, 1);
  registry.invalidate();
  const next = registry.get(tool);
  await Promise.resolve();
  finish([{ workspaceKey: 'products.b' }]);
  assert.deepEqual(await next, [{ workspaceKey: 'products.b' }]);
  assert.equal(reads, 2);
});

test('does not cache a failed request or an old result after invalidation', async () => {
  let reads = 0;
  let finish;
  const registry = new WorkspaceRegistry(() => {
    reads += 1;
    return new Promise((resolve, reject) => { finish = { resolve, reject }; });
  });
  const tool = { toolPath: '/tool', toolHome: '/home' };
  const failed = registry.get(tool);
  await Promise.resolve();
  finish.reject(new Error('offline'));
  await assert.rejects(failed, /offline/);
  const stale = registry.get(tool);
  await Promise.resolve();
  registry.invalidate();
  finish.resolve([{ workspaceKey: 'products.old' }]);
  await stale;
  const current = registry.get(tool);
  await Promise.resolve();
  finish.resolve([{ workspaceKey: 'products.new' }]);
  assert.deepEqual(await current, [{ workspaceKey: 'products.new' }]);
  assert.equal(reads, 3);
});

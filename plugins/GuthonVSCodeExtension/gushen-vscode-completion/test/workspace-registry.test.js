const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { readWorkspaces } = require('../src/workspace-registry');

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

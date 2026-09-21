const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { ToolJsonClient } = require('../src/tool-json-client');

test('routes a generic JSON command through the selected workspace', async () => {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: (input) => { calls[0].input = input; } };
    calls.push({ command, args, options });
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, items: [] })));
      child.emit('close', 0);
    });
    return child;
  };
  const client = new ToolJsonClient({
    getTool: async () => ({ toolPath: '/tool', toolHome: '/home' }),
    spawnProcess,
  });

  await client.run('projects.demo', 'search', ['--query', 'save']);
  assert.deepEqual(calls[0].args, [
    'search', '--home', '/home', '--workspace', 'projects.demo', '--', '--query', 'save',
  ]);
  assert.equal(calls[0].options.shell, false);
});

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createBridgeProcess } = require('../src/bridge-process');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    child.emit('exit', 0, null);
  };
  return child;
}

test('starts Bridge with the selected application and workspace', () => {
  const calls = [];
  const child = fakeChild();
  const bridge = createBridgeProcess({
    executable: '/vscode/node',
    scriptPath: '/extension/bridge/server.js',
    spawnProcess: (...args) => {
      calls.push(args);
      return child;
    },
  });

  assert.equal(bridge.start({ toolPath: '/tool/GuthonCodeTool', toolHome: '/data/workspace' }), true);
  assert.equal(bridge.isRunning(), true);
  assert.equal(calls[0][0], '/vscode/node');
  assert.deepEqual(calls[0][1], ['/extension/bridge/server.js']);
  assert.equal(calls[0][2].env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(calls[0][2].env.GUTHON_TOOL_PATH, '/tool/GuthonCodeTool');
  assert.equal(calls[0][2].env.GUTHON_TOOL_ENTRY, '');
  assert.equal(calls[0][2].env.GUTHON_TOOL_HOME, '/data/workspace');
});

test('passes the Python entry point to Bridge in development mode', () => {
  const calls = [];
  const bridge = createBridgeProcess({
    scriptPath: '/extension/bridge/server.js',
    spawnProcess: (...args) => {
      calls.push(args);
      return fakeChild();
    },
  });

  bridge.start({
    toolPath: '/repo/.venv/bin/python',
    toolEntry: '/repo/scripts/guthon_tool.py',
    toolHome: '/data/workspace',
  });

  assert.equal(calls[0][2].env.GUTHON_TOOL_PATH, '/repo/.venv/bin/python');
  assert.equal(calls[0][2].env.GUTHON_TOOL_ENTRY, '/repo/scripts/guthon_tool.py');
});

test('restarts Bridge with a switched workspace', async () => {
  const children = [];
  const bridge = createBridgeProcess({
    scriptPath: '/extension/bridge/server.js',
    spawnProcess: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });

  bridge.start({ toolPath: '/tool', toolHome: '/old' });
  await bridge.restart({ toolPath: '/tool', toolHome: '/new' });

  assert.equal(children[0].killed, true);
  assert.equal(children.length, 2);
  assert.equal(bridge.isRunning(), true);
});

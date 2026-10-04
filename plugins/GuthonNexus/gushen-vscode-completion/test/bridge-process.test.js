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

test('forces termination when Bridge ignores graceful shutdown', async () => {
  const child = fakeChild();
  const signals = [];
  child.kill = (signal) => { signals.push(signal || 'SIGTERM'); child.killed = true; };
  const bridge = createBridgeProcess({ scriptPath: '/bridge/server.js', spawnProcess: () => child, stopTimeoutMs: 10 });
  bridge.start({ toolPath: '/tool', toolHome: '/home' });
  await assert.rejects(bridge.stop(), /停止超时/);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('bundled Bridge stays identical to its source after import relocation', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(__dirname, '../../../GuthonBridge/bridge/server.js'), 'utf8');
  const generated = fs.readFileSync(path.resolve(__dirname, '../bridge/server.js'), 'utf8');
  assert.equal(generated, '// GENERATED FILE - do not edit. Regenerate with: npm run build:bridge\n// Source: plugins/GuthonBridge/bridge/server.js\n' + source.replace('../../GuthonNexus/gushen-vscode-completion/src/tool-process-client', '../src/tool-process-client'));
});

test('Bridge locators round-trip through the Nexus URI contract', () => {
  const bridge = require('../../../GuthonBridge/extension/nexus-locator');
  const { sourceLocatorFromUri } = require('../src/svn/page-locator');
  for (const target of [ {mode:'page-source',pageId:'PG-Demo-01'}, {mode:'procedure',procedureKeyword:'demo.pkg_$',funId:'save_$'} ]) {
    const uri = new URL(bridge.build(target).uri);
    const resolved = sourceLocatorFromUri({ authority: uri.host, path: uri.pathname, query: uri.search.slice(1) });
    assert.deepEqual(resolved, target.mode === 'page-source' ? {type:'page',pageId:target.pageId} : {type:'procedure',alias:target.procedureKeyword,funId:target.funId});
  }
});

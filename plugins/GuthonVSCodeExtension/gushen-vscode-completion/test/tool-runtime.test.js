const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveDevelopmentRuntime, toolArguments } = require('../src/tool-runtime');

test('resolves the repository virtualenv and Python entry point', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-runtime-'));
  fs.mkdirSync(path.join(root, '.venv', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, '.venv', 'bin', 'python'), '');
  fs.writeFileSync(path.join(root, 'scripts', 'guthon_tool.py'), '');

  const runtime = resolveDevelopmentRuntime(root, 'darwin');

  assert.equal(runtime.mode, 'development');
  assert.equal(runtime.toolPath, path.join(root, '.venv', 'bin', 'python'));
  assert.equal(runtime.toolEntry, path.join(root, 'scripts', 'guthon_tool.py'));
});

test('builds matching packaged and development command arguments', () => {
  assert.deepEqual(
    toolArguments({ toolHome: '/data' }, 'export-view', ['--view-ids', 'V1']),
    ['export-view', '--home', '/data', '--', '--view-ids', 'V1']
  );
  assert.deepEqual(
    toolArguments({ toolEntry: '/repo/scripts/guthon_tool.py', toolHome: '/data' }, 'pull'),
    ['/repo/scripts/guthon_tool.py', 'pull', '--home', '/data']
  );
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extension = () => fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');

test('opening the local data directory reports a missing path instead of doing nothing', () => {
  const command = /registerCommand\('gushenCompletion\.openToolHome'[\s\S]*?\n    \}\),/.exec(extension());
  assert.ok(command, 'openToolHome must stay registered');
  assert.match(command[0], /fs\.existsSync\(toolHome\)/, 'the path must be checked before reveal');
  assert.match(command[0], /本地数据目录不存在/, 'a missing path must produce a visible message');
  assert.match(command[0], /revealFileInOS/);
});

test('the overview keeps rejected and legacy projects instead of filtering them into an empty API list', () => {
  const source = extension();
  assert.match(source, /workspaceSnapshot\(result\)/, 'process-client results must preserve backend diagnostics');
  assert.match(source, /getSnapshot\(tool\)\)\.workspaces/, 'window selection must include legacy projects');
  assert.match(source, /setSnapshot\(snapshot,selected\?\.workspaceKey/, 'the project overview consumes the complete snapshot');
  assert.match(source, /setProjectError\(key,error\)/, 'a local project failure must not hide unrelated projects');
  assert.match(source, /setError\(error, tool\?\.toolHome\)/, 'global configuration failures must have a distinct error state');
});

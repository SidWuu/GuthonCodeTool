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

test('an empty API workspace list explains rejected or non-API projects', () => {
  const source = extension();
  assert.match(source, /configErrors/, 'backend config errors must reach the extension');
  assert.match(source, /个已登记项目不可用/, 'rejected projects must be reported with the backend message');
  assert.match(source, /都不是 API 源码模式/, 'filters that drop every project must be reported');
  assert.match(source, /reportWorkspaceState\(workspaces\.length\)/, 'refresh must report the resolved state');
  // 每个窗口内同一状态只提示一次，避免刷新时反复弹出。
  assert.match(source, /reportedWorkspaceState\.has\(signature\)/);
});

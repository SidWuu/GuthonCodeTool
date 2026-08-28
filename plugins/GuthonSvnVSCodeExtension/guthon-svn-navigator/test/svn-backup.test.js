'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { backupWorkingCopyFiles, changedEntries } = require('../src/svn-backup');

test('backs up Chinese source bytes without invoking svn diff', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'guthon-svn-backup-'));
  const backupDirectory = path.join(root, 'backup');
  const filePath = path.join(root, 'pages', 'SYS-DEMO', 'index.md');
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, '# 中文页面\n本地修改\n', 'utf8');

  const inspections = [{
    target: path.join(root, 'pages', 'SYS-DEMO'),
    entries: [
      { item: 'modified', properties: '', filePath },
      { item: 'unversioned', properties: '', filePath: path.join(root, 'new.txt') }
    ]
  }];
  assert.equal(changedEntries(inspections).length, 1);

  await backupWorkingCopyFiles({
    backupDirectory,
    repository: { root, logicalRoot: root, projectId: 'demo', label: '演示项目' },
    inspections
  });

  assert.equal(
    await fs.promises.readFile(path.join(backupDirectory, 'files', 'pages', 'SYS-DEMO', 'index.md'), 'utf8'),
    '# 中文页面\n本地修改\n'
  );
  const manifest = JSON.parse(await fs.promises.readFile(path.join(backupDirectory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'svn-working-copy-snapshot');
  assert.deepEqual(manifest.entries.map((entry) => entry.status), ['modified']);
  assert.equal(manifest.entries[0].backupPath, 'files/pages/SYS-DEMO/index.md');
});

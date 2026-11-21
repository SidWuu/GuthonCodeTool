const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { copyProjectDocs, migrateProjectDocs } = require('../src/project-docs-migration');

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'guthon-docs-migration-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const backupWorkspace = path.join(home, 'backup', 'workspace');
  const originalProject = path.join(backupWorkspace, '原项目');
  const docsDir = path.join(home, 'var', 'workspace', '新项目', 'docs');
  const source = path.join(originalProject, 'docs');
  await fs.mkdir(path.join(source, '设计', '空子目录'), { recursive: true });
  await fs.mkdir(docsDir, { recursive: true });
  return { home, backupWorkspace, originalProject, docsDir, source };
}

test('migrates only docs, including nested files, empty directories and exact bytes', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from([0x00, 0x0d, 0x0a, 0xe4, 0xb8, 0xad, 0xff]);
  await fs.writeFile(path.join(f.source, '设计', '资料.bin'), bytes);
  await fs.mkdir(path.join(f.originalProject, 'checkout'));
  await fs.writeFile(path.join(f.originalProject, 'checkout', '源码.txt'), '旧源码');
  await fs.writeFile(path.join(f.docsDir, '新项目已有文档.txt'), '保留');

  assert.deepEqual(await copyProjectDocs(f), { files: 1, directories: 2, identical: 0 });
  assert.deepEqual(await fs.readFile(path.join(f.docsDir, '设计', '资料.bin')), bytes);
  assert.deepEqual(await fs.readFile(path.join(f.source, '设计', '资料.bin')), bytes);
  assert.deepEqual(await fs.readdir(path.join(f.docsDir, '设计', '空子目录')), []);
  assert.deepEqual((await fs.readdir(f.docsDir)).sort(), ['新项目已有文档.txt', '设计']);
  assert.deepEqual(await copyProjectDocs(f), { files: 0, directories: 0, identical: 1 });
});

test('detects different destination contents before writing any documents', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, 'a.md'), 'from backup');
  await fs.writeFile(path.join(f.source, 'z.md'), 'old');
  await fs.writeFile(path.join(f.docsDir, 'z.md'), 'new');
  await assert.rejects(copyProjectDocs(f), /已有不同内容.*z\.md/);
  assert.deepEqual(await fs.readdir(f.docsDir), ['z.md']);
  assert.equal(await fs.readFile(path.join(f.docsDir, 'z.md'), 'utf8'), 'new');
});

test('requires an original project directly under the backup workspace', async t => {
  const f = await fixture(t);
  const other = path.join(f.home, 'unrelated');
  await fs.mkdir(path.join(other, 'docs'), { recursive: true });
  await fs.writeFile(path.join(other, 'docs', 'other.md'), 'other');
  await assert.rejects(copyProjectDocs({ ...f, originalProject: other }), /backup\/workspace 下的原项目目录/);
  await assert.rejects(copyProjectDocs({ ...f, docsDir: f.source }), /与备份目录重叠/);
  assert.deepEqual(await fs.readdir(f.docsDir), []);
});

test('uses the registered target and stops when the current project changes during selection', async t => {
  const f = await fixture(t);
  const workspace = { name: '新项目', workspaceKey: 'ws-fixture', docsDir: f.docsDir };
  let current = { ...workspace, workspaceKey: 'ws-other' };
  await fs.writeFile(path.join(f.source, 'manual.md'), 'text');
  const options = {
    workspace, getTool: () => ({ toolHome: f.home }), getCurrentWorkspace: async () => current,
    vscode: {
      ProgressLocation: { Notification: 1 },
      Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
      window: {
        showOpenDialog: async options => {
          assert.equal(options.defaultUri.fsPath, f.backupWorkspace);
          return [{ scheme: 'file', fsPath: f.originalProject }];
        },
        withProgress: async (_options, task) => task(),
        showInformationMessage: async message => message,
      },
    },
  };
  await assert.rejects(migrateProjectDocs(options), /项目或数据目录已变化/);
  assert.deepEqual(await fs.readdir(f.docsDir), []);
  current = workspace;
  assert.match(await migrateProjectDocs(options), /已复制 1 个文件/);
});

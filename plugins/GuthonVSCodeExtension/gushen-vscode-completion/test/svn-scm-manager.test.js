const assert = require('node:assert/strict');
const test = require('node:test');
const { SvnScmManager, changeDisplayName } = require('../src/svn/scm-manager');

function fakeVscode() {
  const controls = [];
  return {
    controls,
    ThemeIcon: class ThemeIcon { constructor(id) { this.id = id; } },
    Uri: {
      file: (value) => ({ fsPath: value }),
      from: (value) => value,
    },
    scm: {
      createSourceControl(id, label, rootUri) {
        const control = {
          id,
          label,
          rootUri,
          inputBox: { value: '' },
          disposed: false,
          createResourceGroup(groupId, groupLabel) {
            return { id: groupId, label: groupLabel, resourceStates: [] };
          },
          dispose() { this.disposed = true; },
        };
        controls.push(control);
        return control;
      },
    },
  };
}

function workspace() {
  return {
    workspaceKey: 'projects.demo',
    displayName: 'Demo',
    checkoutPath: '/checkout/demo',
    capabilities: {},
  };
}

test('SCM always exposes save-to-Guthon in Nexus SVN mode', () => {
  const vscode = fakeVscode();
  const manager = new SvnScmManager({ vscode, backend: {} });
  const record = manager.ensure(workspace());
  assert.equal(record.groups.LOCAL_MODIFIED.guthonWorkspaceKey, 'projects.demo');
  assert.equal(record.groups.REMOTE.guthonWorkspaceKey, 'projects.demo');
  assert.equal(record.sourceControl.acceptInputCommand.command, 'gushenCompletion.saveSvnToGuthon');
  assert.match(record.sourceControl.inputBox.placeholder, /保存到谷神/);

  manager.ensure(workspace());
  assert.equal(record.sourceControl.acceptInputCommand.command, 'gushenCompletion.saveSvnToGuthon');
  manager.dispose();
});

test('applies a managed save to the cached SCM state without a backend scan', () => {
  const vscode = fakeVscode();
  const manager = new SvnScmManager({ vscode, backend: {} });
  const record = manager.ensure(workspace());
  manager._applyStatus(record, {
    ok: true,
    workspaceKey: 'projects.demo',
    clean: true,
    workingCopies: [{ id: 'pages-SYS-1', clean: true }],
    changes: [],
    groups: {},
  });

  assert.equal(manager.applySaved({
    changed: true,
    workspaceKey: 'projects.demo',
    workingCopyId: 'pages-SYS-1',
    sourcePath: 'pages/SYS-1/0/PG-1.json',
    sourceHash: 'after-hash',
  }), true);

  assert.equal(record.status.clean, false);
  assert.equal(record.status.workingCopies[0].clean, false);
  assert.equal(record.status.groups.LOCAL_MODIFIED[0].path, 'pages/SYS-1/0/PG-1.json');
  assert.equal(record.groups.LOCAL_MODIFIED.resourceStates.length, 1);
  manager.dispose();
});

test('uses index-derived Chinese names and includes the module for generic main pages', () => {
  assert.equal(changeDisplayName({
    path: 'systems/SYS-1/pages/PG-1.json',
    sourceType: 'page',
    treePath: ['期现产品', '策略方案'],
    treeLabel: '主页面',
  }), '策略方案 · 主页面.json');
  assert.equal(changeDisplayName({
    path: 'datasources/DS-1/procedures/demo/pkg/save.gss',
    sourceType: 'procedure',
    funId: 'save',
    sourceName: '保存业务数据',
    treeLabel: 'save · 保存业务数据',
  }), 'save · 保存业务数据.gss');
});

test('keeps remote changes across local refreshes and replaces them after a remote check', async () => {
  const vscode = fakeVscode();
  const responses = [
    {
      ok: true,
      workspaceKey: 'projects.demo',
      changes: [],
      groups: {},
      remoteChecked: true,
      remoteChanges: [{ path: 'pages/SYS-1/PG-1.json', item: 'modified', workingCopyId: 'pages-SYS-1' }],
    },
    {
      ok: true,
      workspaceKey: 'projects.demo',
      changes: [],
      groups: {},
      remoteChecked: false,
      remoteChanges: [],
    },
  ];
  const backend = { scmStatus: async () => responses.shift() };
  const manager = new SvnScmManager({ vscode, backend });
  const record = manager.ensure(workspace());

  await manager.refreshRemote(workspace());
  assert.equal(record.groups.REMOTE.resourceStates.length, 1);
  await manager.refresh(workspace());
  assert.equal(record.groups.REMOTE.resourceStates.length, 1);
  assert.equal(record.sourceControl.count, 1);
  manager.dispose();
});

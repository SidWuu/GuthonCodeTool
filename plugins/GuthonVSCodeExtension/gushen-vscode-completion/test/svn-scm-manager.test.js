const assert = require('node:assert/strict');
const test = require('node:test');
const {
  SvnScmManager,
  changeDiffStatus,
  changeDisplayName,
  sourceControlId,
  workspaceKeyFromSourceControlId,
} = require('../src/svn/scm-manager');

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
    sourceControlGroups: [
      {
        id: 'subsystem-flat-0008',
        label: '贸易系统',
        dataSourceId: '0008',
        workingCopyIds: ['datasources-0008', 'systems-domestic', 'systems-international'],
      },
    ],
  };
}

test('SCM always exposes save-to-Guthon in Nexus SVN mode', () => {
  const vscode = fakeVscode();
  const manager = new SvnScmManager({ vscode, backend: {} });
  const record = manager.ensure(workspace());
  assert.equal(record.sourceControl.id, 'guthon-svn-v3-projects.demo');
  const trade = record.groups.get('subsystem-flat-0008');
  assert.equal(trade.label, '贸易系统');
  assert.equal(trade.guthonWorkspaceKey, 'projects.demo');
  assert.equal(trade.hideWhenEmpty, false);
  assert.deepEqual(trade.guthonWorkingCopyIds, [
    'datasources-0008', 'systems-domestic', 'systems-international',
  ]);
  assert.equal(record.sourceControl.acceptInputCommand.command, 'gushenCompletion.saveSvnToGuthon');
  assert.match(record.sourceControl.inputBox.placeholder, /提交说明（可选）/);

  manager.ensure(workspace());
  assert.equal(record.sourceControl.acceptInputCommand.command, 'gushenCompletion.saveSvnToGuthon');
  manager.dispose();
});

test('keeps workspace routing compatible with current and legacy SCM provider IDs', () => {
  assert.equal(sourceControlId('products.demo'), 'guthon-svn-v3-products.demo');
  assert.equal(workspaceKeyFromSourceControlId('guthon-svn-v2-products.demo'), 'products.demo');
  assert.equal(workspaceKeyFromSourceControlId('guthon-svn-products.demo'), 'products.demo');
  assert.equal(workspaceKeyFromSourceControlId('git-demo'), '');
});

test('registers native Quick Diff for physical and virtual SVN documents', () => {
  const vscode = fakeVscode();
  const quickDiffProvider = {
    workspaces: [],
    statuses: [],
    setWorkspace(value) { this.workspaces.push(value.workspaceKey); },
    setStatus(workspaceKey, value) { this.statuses.push([workspaceKey, value]); },
  };
  const manager = new SvnScmManager({ vscode, backend: {}, quickDiffProvider });
  const record = manager.ensure(workspace());

  assert.equal(record.sourceControl.quickDiffProvider, quickDiffProvider);
  assert.equal(record.sourceControl.rootUri, undefined);
  assert.deepEqual(quickDiffProvider.workspaces, ['projects.demo']);
  manager._applyStatus(record, {
    ok: true,
    workspaceKey: 'projects.demo',
    clean: true,
    workingCopies: [],
    changes: [],
    groups: {},
  });
  assert.equal(quickDiffProvider.statuses[0][0], 'projects.demo');
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
    workingCopies: [{ id: 'systems-domestic', clean: true }],
    changes: [],
    groups: {},
  });

  assert.equal(manager.applySaved({
    changed: true,
    workspaceKey: 'projects.demo',
    workingCopyId: 'systems-domestic',
    sourcePath: 'pages/SYS-1/0/PG-1.json',
    sourceHash: 'after-hash',
  }), true);

  assert.equal(record.status.clean, false);
  assert.equal(record.status.workingCopies[0].clean, false);
  assert.equal(record.status.groups.LOCAL_MODIFIED[0].path, 'pages/SYS-1/0/PG-1.json');
  assert.equal(record.groups.get('subsystem-flat-0008').resourceStates.length, 1);
  manager.dispose();
});

test('shows SVN added, deleted and modified status decorations per resource', () => {
  const vscode = fakeVscode();
  const manager = new SvnScmManager({ vscode, backend: {} });
  const record = manager.ensure(workspace());
  manager._applyStatus(record, {
    ok: true,
    workspaceKey: 'projects.demo',
    clean: false,
    workingCopies: [],
    changes: [],
    groups: {
      LOCAL_MODIFIED: [{
        path: 'procedures/DS-1/demo/pkg/save.gss',
        item: 'modified',
        workingCopyId: 'datasources-0008',
        sourceType: 'procedure',
        sourceId: 'demo.pkg#save',
        funId: 'save',
        sourceName: '保存业务数据',
      }],
      EXTERNAL_MODIFIED: [{
        path: 'pages/SYS-1/PG-1.json',
        item: 'added',
        workingCopyId: 'systems-domestic',
        sourceType: 'page',
        sourceId: 'PG-1',
      }, {
        path: 'pages/SYS-1/deleted.json',
        item: 'deleted',
        workingCopyId: 'systems-domestic',
      }],
    },
  });

  const resources = record.groups.get('subsystem-flat-0008').resourceStates;
  const modified = resources.find((item) => item.resourceUri.query.includes('save.gss'));
  const added = resources.find((item) => item.resourceUri.query.includes('PG-1.json'));
  const deleted = resources.find((item) => item.resourceUri.query.includes('deleted.json'));

  assert.equal(changeDiffStatus({ item: 'added' }).id, 'ADDED');
  assert.equal(changeDiffStatus({ item: 'deleted' }).id, 'DELETED');
  assert.equal(changeDiffStatus({ item: 'modified' }).id, 'MODIFIED');
  assert.equal(modified.decorations.iconPath.id, 'diff-modified');
  assert.match(modified.decorations.tooltip, /修改/);
  assert.equal(modified.contextValue, 'guthonSvn.LOCAL_MODIFIED.nexus');
  assert.equal(new URLSearchParams(modified.resourceUri.query).get('sourceType'), 'procedure');
  assert.equal(added.decorations.iconPath.id, 'diff-added');
  assert.match(added.decorations.tooltip, /新增/);
  assert.equal(added.contextValue, 'guthonSvn.EXTERNAL_MODIFIED.nexus');
  assert.equal(deleted.decorations.iconPath.id, 'diff-removed');
  assert.match(deleted.decorations.tooltip, /删除/);
  assert.equal(deleted.contextValue, 'guthonSvn.EXTERNAL_MODIFIED');
  manager.dispose();
});

test('keeps subsystem groups visible beside another SCM repository when the SVN workspace is clean', () => {
  const vscode = fakeVscode();
  const manager = new SvnScmManager({ vscode, backend: {} });
  const record = manager.ensure(workspace());

  manager._applyStatus(record, {
    ok: true,
    workspaceKey: 'projects.demo',
    clean: true,
    workingCopies: [],
    changes: [],
    groups: {},
    remoteChecked: true,
    remoteChanges: [],
  });

  const resources = record.groups.get('subsystem-flat-0008').resourceStates;
  assert.equal(resources.length, 1);
  assert.equal(resources[0].contextValue, 'guthonSvn.PLACEHOLDER');
  assert.equal(resources[0].command, undefined);
  assert.equal(record.sourceControl.count, 0);
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
      remoteChanges: [{ path: 'pages/SYS-1/PG-1.json', item: 'modified', workingCopyId: 'systems-domestic' }],
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
  assert.equal(record.groups.get('subsystem-flat-0008').resourceStates.length, 1);
  assert.deepEqual(record.groups.get('subsystem-flat-0008').resourceStates[0].command.arguments, [
    'projects.demo', 'pages/SYS-1/PG-1.json', true,
  ]);
  await manager.refresh(workspace());
  assert.equal(record.groups.get('subsystem-flat-0008').resourceStates.length, 1);
  assert.equal(record.sourceControl.count, 1);
  manager.dispose();
});

test('scoped remote refresh keeps other local changes but only displays selected remote changes', async () => {
  const vscode = fakeVscode();
  const calls = [];
  const backend = {
    scmStatus: async (workspaceKey, remote, options) => {
      calls.push({ workspaceKey, remote, options });
      return {
        ok: true,
        workspaceKey,
        clean: false,
        workingCopies: [{ id: 'datasources-0008', clean: false }],
        changes: [{
          path: 'procedures/DS-1/local.gss',
          item: 'modified',
          workingCopyId: 'datasources-0008',
        }],
        groups: {
          LOCAL_MODIFIED: [{
            path: 'procedures/DS-1/local.gss',
            item: 'modified',
            workingCopyId: 'datasources-0008',
          }],
        },
        remoteChecked: true,
        remoteChanges: [{
          path: 'procedures/DS-1/remote.gss',
          item: 'modified',
          workingCopyId: 'datasources-0008',
        }],
      };
    },
  };
  const manager = new SvnScmManager({ vscode, backend });
  const record = manager.ensure(workspace());
  manager._applyStatus(record, {
    ok: true,
    workspaceKey: 'projects.demo',
    clean: false,
    workingCopies: [
      { id: 'datasources-0008', clean: true },
      { id: 'systems-domestic', clean: false },
    ],
    changes: [{
      path: 'pages/SYS-1/local-page.json',
      item: 'modified',
      workingCopyId: 'systems-domestic',
    }],
    groups: {
      LOCAL_MODIFIED: [{
        path: 'pages/SYS-1/local-page.json',
        item: 'modified',
        workingCopyId: 'systems-domestic',
      }],
    },
    remoteChecked: true,
    remoteChanges: [{
      path: 'pages/SYS-1/old-remote.json',
      item: 'modified',
      workingCopyId: 'systems-domestic',
    }],
  });

  await manager.refreshRemote(workspace(), { workingCopyIds: ['datasources-0008'] });

  assert.deepEqual(calls[0], {
    workspaceKey: 'projects.demo',
    remote: true,
    options: { workingCopyIds: ['datasources-0008'] },
  });
  assert.deepEqual(record.status.workingCopies.map((item) => item.id), [
    'systems-domestic', 'datasources-0008',
  ]);
  assert.deepEqual(record.status.changes.map((item) => item.path), [
    'pages/SYS-1/local-page.json', 'procedures/DS-1/local.gss',
  ]);
  assert.deepEqual(record.status.remoteChanges.map((item) => item.path), [
    'procedures/DS-1/remote.gss',
  ]);
  assert.equal(record.groups.get('subsystem-flat-0008').resourceStates.length, 3);
  manager.dispose();
});

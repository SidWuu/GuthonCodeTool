const assert = require('node:assert/strict');
const test = require('node:test');
const { SvnScmManager } = require('../src/svn/scm-manager');

function fakeVscode() {
  const controls = [];
  return {
    controls,
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

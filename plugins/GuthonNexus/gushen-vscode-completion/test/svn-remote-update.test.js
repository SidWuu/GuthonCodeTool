const assert = require('node:assert/strict');
const test = require('node:test');
const { updateRemoteChanges } = require('../src/svn/remote-update');

function harness() {
  const first = { path: 'systems/SYS-1/pages/PG-1.json', workingCopyId: 'system-1' };
  const second = { path: 'datasources/DS-1/procedures/save.gss', workingCopyId: 'datasource-1' };
  const calls = [];
  const state = {
    remoteChanges: [first, second], changes: [], shown: [], confirmation: undefined,
    saved: true, localAfterSave: [],
  };
  const deps = {
    workspace: { workspaceKey: 'products.demo' },
    vscode: {
      commands: { async executeCommand(command) { calls.push(command); } },
      window: {
        async showWarningMessage(message, options, button) {
          calls.push('confirm');
          assert.equal(state.shown.length, state.remoteChanges.length);
          assert.equal(calls.at(-2), 'workbench.view.scm');
          assert.match(message, /远程变更/);
          assert.equal(options.modal, true);
          assert.match(options.detail, /取消将保留列表/);
          assert.equal(button, '确认');
          return state.confirmation;
        },
        showInformationMessage(message) { calls.push(['notice', message]); },
      },
    },
    scm: {
      async refreshRemote(workspace, options) {
        calls.push(['remote', workspace.workspaceKey, options]);
        state.shown = [...state.remoteChanges];
        return { remoteChanges: state.remoteChanges, changes: state.changes };
      },
      async refresh() {
        calls.push('local');
        return { changes: state.localAfterSave };
      },
    },
    backend: {
      async refresh(workspaceKey, options) {
        calls.push(['update', workspaceKey, options]);
        state.remoteChanges = [];
        return { updated: [{ id: 'system-1' }] };
      },
    },
    async saveDirtyDocuments() { calls.push('save'); return state.saved; },
    onUpdated() { calls.push('views'); },
    log() {},
    onOutput() {},
  };
  return { deps, state, calls, first, second };
}

for (const confirmation of [undefined, '取消']) {
  test(`cancelling remote update preserves the displayed list without saving (${confirmation})`, async () => {
    const { deps, state, calls, first, second } = harness();
    state.confirmation = confirmation;
    assert.equal(await updateRemoteChanges(deps), undefined);
    assert.deepEqual(state.shown, [first, second]);
    assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), [
      'remote', 'workbench.view.scm', 'confirm',
    ]);
  });
}

test('confirmation saves, rechecks local changes, updates and replaces the remote list', async () => {
  const { deps, state, calls, first } = harness();
  state.confirmation = '确认';
  state.localAfterSave = [first];
  const result = await updateRemoteChanges(deps);
  assert.equal(result.updated.length, 1);
  assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), [
    'remote', 'workbench.view.scm', 'confirm', 'save', 'local', 'update', 'views', 'remote', 'notice',
  ]);
  assert.deepEqual(calls.find((call) => call[0] === 'update'), ['update', 'products.demo', {
    sourcePath: '', workingCopyIds: ['system-1', 'datasource-1'], mergeLocal: true, onOutput: deps.onOutput,
  }]);
  assert.deepEqual(state.shown, []);
});

test('group update checks only its scope and does not merge unrelated local changes', async () => {
  const { deps, state, calls, second } = harness();
  state.confirmation = '确认';
  state.localAfterSave = [second];
  deps.workingCopyIds = ['system-1'];
  await updateRemoteChanges(deps);
  assert.deepEqual(calls[0][2].workingCopyIds, ['system-1']);
  const options = calls.find((call) => call[0] === 'update')[2];
  assert.deepEqual(options.workingCopyIds, ['system-1']);
  assert.equal(options.mergeLocal, false);
});

test('single-file update retains the exact path and ignores other dirty files in its working copy', async () => {
  const { deps, state, calls, first } = harness();
  deps.sourcePath = first.path;
  state.confirmation = '确认';
  state.localAfterSave = [{ path: 'systems/SYS-1/pages/other.json', workingCopyId: first.workingCopyId }];
  await updateRemoteChanges(deps);
  const options = calls.find((call) => call[0] === 'update')[2];
  assert.equal(options.sourcePath, first.path);
  assert.deepEqual(options.workingCopyIds, []);
  assert.equal(options.mergeLocal, false);
});

test('no remote changes updates the display without asking to save or confirm', async () => {
  const { deps, state, calls } = harness();
  state.remoteChanges = [];
  await updateRemoteChanges(deps);
  assert.deepEqual(state.shown, []);
  assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), [
    'remote', 'workbench.view.scm', 'notice',
  ]);
});

test('cancelling document save after confirmation leaves remote changes available', async () => {
  const { deps, state, calls, first, second } = harness();
  state.confirmation = '确认';
  state.saved = false;
  await updateRemoteChanges(deps);
  assert.deepEqual(state.shown, [first, second]);
  assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), [
    'remote', 'workbench.view.scm', 'confirm', 'save',
  ]);
});

test('failed update keeps the preview and does not report completion or refresh source views', async () => {
  const { deps, state, calls, first, second } = harness();
  state.confirmation = '确认';
  deps.backend.refresh = async () => { throw new Error('update failed'); };
  await assert.rejects(updateRemoteChanges(deps), /update failed/);
  assert.deepEqual(state.shown, [first, second]);
  assert.equal(calls.includes('views'), false);
  assert.equal(calls.some((call) => call[0] === 'notice'), false);
});

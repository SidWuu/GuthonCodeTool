const assert = require('node:assert/strict');
const test = require('node:test');
const {
  filterWorkspacesBySourceMode,
  normalizeSourceMode,
  selectWorkspaceSourceMode,
  sourceModeLabel,
} = require('../src/source-mode');

test('source mode defaults to DATABASE independently of execution mode', () => {
  assert.equal(normalizeSourceMode(undefined), 'database');
  assert.equal(normalizeSourceMode('SVN'), 'svn');
  assert.equal(normalizeSourceMode('development'), 'database');
  assert.equal(sourceModeLabel('svn'), 'SVN');
  assert.equal(sourceModeLabel('database'), 'DATABASE');
});

test('filters workspaces for provider-specific services without filtering the project tree', () => {
  const workspaces = [
    { workspaceKey: 'products.database-a', sourceMode: 'database' },
    { workspaceKey: 'projects.svn-a', sourceMode: 'svn' },
    { workspaceKey: 'projects.svn-b', sourceMode: 'SVN' },
  ];
  assert.deepEqual(
    filterWorkspacesBySourceMode(workspaces, 'svn').map((item) => item.workspaceKey),
    ['projects.svn-a', 'projects.svn-b']
  );
  assert.deepEqual(
    filterWorkspacesBySourceMode(workspaces, 'database').map((item) => item.workspaceKey),
    ['products.database-a']
  );
});

test('returns an explicitly changed project source mode without owning persistence', async () => {
  const window = {
    showQuickPick: async (choices) => choices.find((choice) => choice.value === 'svn'),
  };
  assert.equal(await selectWorkspaceSourceMode(window, 'database'), 'svn');
});

test('does not return a project source mode rejected by the pre-change safety check', async () => {
  const window = { showQuickPick: async (choices) => choices.find((choice) => choice.value === 'database') };
  const selected = await selectWorkspaceSourceMode(window, 'svn', async () => false);
  assert.equal(selected, undefined);
});

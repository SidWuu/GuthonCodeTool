const assert = require('node:assert/strict');
const test = require('node:test');
const {
  activeSourceIdentity,
  nexusCandidateIds,
  notifyInformation,
  openSvnConflictMerge,
  referenceTarget,
  resolveSourcePath,
  runFocusedTreeCommand,
  selectCandidates,
  selectEditableIdentity,
  sourceModuleElement,
} = require('../src/svn/activate');

test('shows completion notifications without keeping an SVN operation claimed', () => {
  let resolveNotification;
  const shown = [];
  const vscode = {
    window: {
      showInformationMessage(message) {
        shown.push(message);
        return new Promise((resolve) => { resolveNotification = resolve; });
      },
    },
  };

  assert.equal(notifyInformation(vscode, '更新已完成'), undefined);
  assert.deepEqual(shown, ['更新已完成']);
  assert.equal(typeof resolveNotification, 'function');
  resolveNotification();
});

test('all and single submit selections include Nexus-managed candidates only', () => {
  const preview = {
    candidates: [
      { id: 'nexus-a', path: 'pages/a.json', workingCopyId: 'system-a', sessionManaged: true },
      { id: 'external', path: 'pages/b.json', workingCopyId: 'system-a', sessionManaged: false },
      { id: 'nexus-c', path: 'procedures/c.gss', workingCopyId: 'datasource-c', sessionManaged: true },
    ],
  };
  assert.deepEqual(nexusCandidateIds(preview), ['nexus-a', 'nexus-c']);
  assert.deepEqual(nexusCandidateIds(preview, 'procedures/c.gss'), ['nexus-c']);
  assert.deepEqual(nexusCandidateIds(preview, 'pages/b.json'), []);
  assert.deepEqual(nexusCandidateIds(preview, '', ['system-a']), ['nexus-a']);
  assert.deepEqual(nexusCandidateIds(preview, ['pages/a.json', 'procedures/c.gss']), [
    'nexus-a',
    'nexus-c',
  ]);
});

test('opens the native merge editor with SVN physical conflict artifacts', async () => {
  const calls = [];
  const vscode = {
    Uri: { file: (path) => ({ path }) },
    commands: { executeCommand: async (...args) => calls.push(args) },
  };
  await openSvnConflictMerge(vscode, {
    basePath: '/wc/source.gss.r1',
    input1Path: '/wc/source.gss.mine',
    input2Path: '/wc/source.gss.r2',
    resultPath: '/wc/source.gss',
  });

  assert.deepEqual(calls, [[
    '_open.mergeEditor',
    {
      base: { path: '/wc/source.gss.r1' },
      input1: { uri: { path: '/wc/source.gss.mine' }, title: '本地修改' },
      input2: { uri: { path: '/wc/source.gss.r2' }, title: 'SVN 远程修改' },
      output: { path: '/wc/source.gss' },
    },
  ]]);
});

test('multi-selection can span physical working copies', async () => {
  const calls = [];
  const vscode = {
    window: {
      async showQuickPick(items, options) {
        calls.push({ items, options });
        return items;
      },
    },
  };
  const selected = await selectCandidates(vscode, {
    candidates: [
      { id: 'a', path: 'pages/a.json', workingCopyId: 'wc-a', objectType: 'page', objectId: 'a' },
      { id: 'b', path: 'pages/b.json', workingCopyId: 'wc-b', objectType: 'page', objectId: 'b' },
    ],
  }, '保存到谷神');

  assert.deepEqual(selected, ['a', 'b']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].items.map((item) => item.candidateId), ['a', 'b']);
});

test('selects a supported virtual fragment before opening a PAGE JSON change', async () => {
  const calls = [];
  const fragments = [
    {
      scriptType: 'js',
      jsonPointer: '/pageSetup/pageEvents/onOpenScript',
      label: 'pageSetup / pageEvents / onOpenScript',
    },
    {
      scriptType: 'fields',
      jsonPointer: '/views/0/fields',
      label: '主视图',
    },
  ];
  const vscode = {
    window: {
      async showQuickPick(items, options) {
        calls.push({ items, options });
        return items[1];
      },
    },
  };
  const backend = {
    async fragments(workspaceKey, identity) {
      calls.push({ workspaceKey, identity });
      return { fragments };
    },
  };
  const identity = {
    workspaceKey: 'products.demo',
    sourceType: 'page',
    sourceId: 'PG-1',
    sourcePath: 'pages/SYS-1/PG-1.json',
    jsonPointer: '',
  };

  assert.deepEqual(await selectEditableIdentity(vscode, backend, identity), {
    ...identity,
    jsonPointer: '/views/0/fields',
    fragmentType: 'fields',
  });
  assert.equal(calls[0].workspaceKey, 'products.demo');
  assert.deepEqual(calls[1].items.map((item) => item.label), [
    'JS · pageSetup / pageEvents / onOpenScript',
    '字段 · 主视图',
  ]);
});

test('opens the only PAGE JSON fragment directly and leaves PAGE GSS unchanged', async () => {
  let pickCalled = false;
  const vscode = { window: { showQuickPick: async () => { pickCalled = true; } } };
  const backend = {
    fragments: async () => ({
      fragments: [{ scriptType: 'sql', jsonPointer: '/views/0/datasource/sql', label: '' }],
    }),
  };
  const pageJson = {
    workspaceKey: 'products.demo', sourceType: 'page', sourceId: 'PG-1',
    sourcePath: 'pages/SYS-1/PG-1.json', jsonPointer: '',
  };
  const pageGss = {
    workspaceKey: 'products.demo', sourceType: 'page', sourceId: 'PG-GSS-1',
    sourcePath: 'pages/SYS-1/PG-GSS-1.gss', jsonPointer: '',
  };

  assert.deepEqual(await selectEditableIdentity(vscode, backend, pageJson), {
    ...pageJson,
    jsonPointer: '/views/0/datasource/sql',
    fragmentType: 'sql',
  });
  assert.equal(await selectEditableIdentity(vscode, backend, pageGss), pageGss);
  assert.equal(pickCalled, false);
});

test('find references derives the current procedure identity from a stable virtual URI', () => {
  const uri = {
    authority: 'projects.demo',
    query: new URLSearchParams({
      sourceType: 'procedure',
      sourceId: 'order.service#saveOrder',
      funId: 'saveOrder',
    }).toString(),
  };
  const document = { uri, getText: () => 'plain body', offsetAt: () => 0 };

  assert.deepEqual(referenceTarget(document, {}), {
    alias: 'order.service',
    funId: 'saveOrder',
  });
});

test('resolves a Nexus source module only inside its workspace checkout', () => {
  const workspaces = [{ workspaceKey: 'products.demo', checkoutPath: '/workspace/checkout' }];
  const module = {
    kind: 'object',
    workspaceKey: 'products.demo',
    object: { sourcePath: 'pages/SYS-1/PG-1.json' },
  };
  const fragment = { kind: 'fragment', parent: module };
  assert.equal(
    resolveSourcePath(workspaces, fragment),
    '/workspace/checkout/pages/SYS-1/PG-1.json'
  );
  assert.equal(sourceModuleElement(fragment), module);
  assert.throws(
    () => resolveSourcePath(workspaces, {
      workspaceKey: 'products.demo',
      object: { sourcePath: '../outside.json' },
    }),
    /超出当前 SVN checkout/
  );
});

test('opens native tree search after focusing the SVN source view', async () => {
  const calls = [];
  await runFocusedTreeCommand({
    commands: { executeCommand: async (command) => calls.push(command) },
  }, 'list.find');
  assert.deepEqual(calls, ['gushenCompletion.svnSourceView.focus', 'list.find']);

  const manifest = require('../package.json');
  assert.equal(manifest.contributes.configurationDefaults['workbench.list.horizontalScrolling'], true);
  assert.equal(manifest.contributes.configurationDefaults['workbench.list.defaultFindMode'], 'filter');
  assert.equal(manifest.contributes.configurationDefaults['workbench.list.defaultFindMatchType'], 'fuzzy');
  assert.equal(manifest.contributes.configurationDefaults['scm.alwaysShowActions'], true);
  assert.equal(manifest.contributes.configurationDefaults['scm.repositories.selectionMode'], 'multiple');
  const resourceMenus = manifest.contributes.menus['scm/resourceState/context'];
  assert(resourceMenus.some((item) => item.command === 'gushenCompletion.openSvnChangeInNexus'));
  assert(resourceMenus.some((item) => item.command === 'gushenCompletion.revertSingleSvnChange'));
  assert(resourceMenus.some((item) => item.command === 'gushenCompletion.saveSelectedSvnNexusChanges'));
  assert(resourceMenus.some((item) => item.command === 'gushenCompletion.updateSingleSvnChange'));
  assert(resourceMenus.some((item) => item.command === 'gushenCompletion.openSvnConflictMerge'));
  assert(resourceMenus.some((item) => item.command === 'gushenCompletion.markSvnConflictResolved'));
  const quickDiffMenus = manifest.contributes.menus['scm/change/title'];
  assert(quickDiffMenus.some((item) => item.command === 'gushenCompletion.revertSvnQuickDiffChange'));
  const groupMenus = manifest.contributes.menus['scm/resourceGroup/context'];
  const rootCommands = manifest.contributes.menus['scm/title'].map((item) => item.command);
  const groupCommands = groupMenus.map((item) => item.command);
  assert.deepEqual(groupCommands, rootCommands);
  assert.equal(rootCommands.length, 4);
  assert(groupMenus.every((item) => item.group.startsWith('inline@')));
  assert(!rootCommands.includes('gushenCompletion.refreshSvn'));
});

test('maps the active virtual editor back to its Nexus source identity', () => {
  const uri = {
    scheme: 'guthon-svn-edit',
    authority: 'products.demo',
    query: new URLSearchParams({
      sourceType: 'page',
      sourceId: 'PG-1',
      jsonPointer: '/pageSetup/pageEvents/onOpenScript',
    }).toString(),
  };
  assert.deepEqual(activeSourceIdentity([], { uri }), {
    workspaceKey: 'products.demo',
    sourceType: 'page',
    sourceId: 'PG-1',
    funId: '',
    jsonPointer: '/pageSetup/pageEvents/onOpenScript',
  });
});

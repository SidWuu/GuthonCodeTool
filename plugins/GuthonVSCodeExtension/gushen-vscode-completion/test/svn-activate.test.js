const assert = require('node:assert/strict');
const test = require('node:test');
const {
  activeSourceIdentity,
  referenceTarget,
  resolveSourcePath,
  runFocusedTreeCommand,
  selectCandidates,
  sourceModuleElement,
} = require('../src/svn/activate');

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

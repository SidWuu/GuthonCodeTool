const assert = require('node:assert/strict');
const test = require('node:test');
const {
  activeSourceIdentity,
  callerIdentity,
  callerLabel,
  nexusCandidateIds,
  notifyInformation,
  openSvnConflictMerge,
  procedureIdentityFromElement,
  referenceTarget,
  resolveSourcePath,
  runFocusedTreeCommand,
  selectCandidates,
  selectEditableIdentity,
  showProcedureCallers,
  showPageSemanticNodes,
  sourceModuleElement,
  workspaceKeyFromElement,
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

test('pages through source-checked PAGE nodes before opening the selected virtual fragment', async () => {
  const queries = [];
  const opened = [];
  let picks = 0;
  const vscode = { window: { async showQuickPick(items) {
    picks += 1;
    return picks === 1 ? items.at(-1) : items[0];
  } } };
  const backend = { async pageQuery(workspaceKey, name, args) {
    queries.push({ workspaceKey, name, args });
    if (name === 'read_page_nodes') return { nodes: [{ content: 'return true;' }] };
    if (!args.cursor) return {
      indexedSourceHash: 'hash-1', nextCursor: 'next-page',
      nodes: [{ jsonPointer: '/one', nodeType: 'SCRIPT', label: 'one', semanticNodeId: 'node-1' }],
    };
    return {
      indexedSourceHash: 'hash-1', nextCursor: null,
      nodes: [{ jsonPointer: '/two', nodeType: 'SQL', label: 'two', semanticNodeId: 'node-2' }],
    };
  } };
  const virtualFs = { async open(identity) { opened.push(identity); return identity; } };
  const element = {
    workspaceKey: 'products.demo',
    object: {
      sourceType: 'page', sourceNamespace: 'pages-SYS-1', sourceId: 'PG-1',
      sourcePath: 'pages/SYS-1/PG-1.json', workingCopyId: 'pages-SYS-1',
    },
  };
  const result = await showPageSemanticNodes(vscode, backend, virtualFs, element);
  assert.equal(picks, 2);
  assert.equal(queries[1].args.cursor, 'next-page');
  assert.deepEqual(queries[2].args.targets, [{ semanticNodeId: 'node-2' }]);
  assert.equal(result.jsonPointer, '/two');
  assert.equal(result.fragmentType, 'sql');
  assert.equal(opened[0].workingCopyId, 'pages-SYS-1');
});

test('opens a PAGE field collection as JSON after source verification', async () => {
  const calls = [];
  const vscode = { window: { async showQuickPick(items) { return items[0]; } } };
  const backend = { async pageQuery(_workspaceKey, name, args) {
    calls.push({ name, args });
    return name === 'list_page_nodes'
      ? { indexedSourceHash: 'hash-1', nodes: [{
        jsonPointer: '/fields', nodeType: 'FIELD_COLLECTION', label: 'fields',
      }] }
      : { nodes: [{ content: '[]' }] };
  } };
  const virtualFs = { async open(identity) { return identity; } };
  const selected = await showPageSemanticNodes(vscode, backend, virtualFs, {
    workspaceKey: 'products.demo', object: {
      sourceType: 'page', sourceNamespace: 'pages-SYS-1', sourceId: 'PG-1',
      sourcePath: 'pages/SYS-1/PG-1.json', workingCopyId: 'pages-SYS-1',
    },
  });
  assert.equal(selected.fragmentType, 'fields');
  assert.deepEqual(calls[1].args.targets, [{ jsonPointer: '/fields', indexedSourceHash: 'hash-1' }]);
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

test('derives copyable procedure names only from procedure tree nodes', () => {
  const procedure = {
    kind: 'document',
    workspaceKey: 'products.demo',
    object: {
      sourceType: 'procedure',
      sourceAliasId: 'com.golden.demo.order',
      funId: 'pullData',
    },
  };
  assert.deepEqual(procedureIdentityFromElement(procedure), {
    workspaceKey: 'products.demo',
    alias: 'com.golden.demo.order',
    funId: 'pullData',
  });
  assert.equal(procedureIdentityFromElement({ object: { sourceType: 'page' } }), undefined);
});

test('shows indexed procedure callers and opens the selected exact call line', async () => {
  const calls = [];
  const caller = {
    source_table: 'procedure',
    source_id: 'demo.caller#run',
    source_alias_id: 'demo.caller',
    fun_id: 'run',
    source_name: '调用过程',
    script_type: 'gss',
    json_path: '',
    line_no: 27,
  };
  const vscode = {
    window: {
      async showQuickPick(items, options) {
        calls.push({ items, options });
        return items[0];
      },
    },
  };
  const backend = {
    async callers(...args) {
      calls.push({ backend: args });
      return { callers: [caller] };
    },
  };
  const virtualFs = {
    async open(...args) {
      calls.push({ open: args });
      return 'opened';
    },
  };
  const element = {
    workspaceKey: 'products.demo',
    object: {
      sourceType: 'procedure',
      sourceAliasId: 'demo.target',
      funId: 'save',
    },
  };

  assert.equal(await showProcedureCallers(vscode, backend, virtualFs, element), 'opened');
  assert.deepEqual(calls[0].backend, ['products.demo', 'demo.target', 'save', 500]);
  assert.equal(calls[1].items[0].label, 'demo.caller.run');
  assert.equal(calls[1].options.title, '查看 demo.target.save 的调用方');
  assert.deepEqual(calls[2].open, [
    {
      workspaceKey: 'products.demo',
      sourceType: 'procedure',
      sourceId: 'demo.caller#run',
      funId: 'run',
      jsonPointer: '',
      fragmentType: 'gss',
    },
    { lineNumber: 27 },
  ]);
});

test('formats PAGE caller labels and preserves their fragment identity', () => {
  const caller = {
    source_table: 'page', source_id: 'PG-1', source_alias_id: 'demo.page', fun_id: '',
    source_name: '示例页面', script_type: 'gss', json_path: '/pageSetup/serviceEvents/query',
  };
  assert.equal(callerLabel(caller), 'demo.page');
  assert.deepEqual(callerIdentity('products.demo', caller), {
    workspaceKey: 'products.demo',
    sourceType: 'page',
    sourceId: 'PG-1',
    funId: '',
    jsonPointer: '/pageSetup/serviceEvents/query',
    fragmentType: 'gss',
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
  assert.equal(workspaceKeyFromElement(fragment), 'products.demo');
  assert.throws(
    () => resolveSourcePath(workspaces, {
      workspaceKey: 'products.demo',
      object: { sourcePath: '../outside.json' },
    }),
    /超出当前 SVN checkout/
  );
});

test('runs native tree actions after focusing the SVN source view', async () => {
  const calls = [];
  await runFocusedTreeCommand({
    commands: { executeCommand: async (command) => calls.push(command) },
  }, 'list.expand');
  assert.deepEqual(calls, ['gushenCompletion.svnSourceView.focus', 'list.expand']);

  const manifest = require('../package.json');
  const svnSearch = manifest.contributes.menus['view/title'].find((item) =>
    item.when.includes('gushenCompletion.svnSourceView') && item.group === 'navigation@3'
  );
  assert.equal(svnSearch.command, 'gushenCompletion.searchCurrentSvnWorkspace');
  assert.equal(manifest.contributes.configurationDefaults['workbench.list.horizontalScrolling'], true);
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
  const sourceMenus = manifest.contributes.menus['view/item/context'];
  assert.ok(sourceMenus.some((item) => item.command === 'gushenCompletion.deleteWorkspace'
    && item.when.includes('guthonWorkspace')));
  const procedureMenus = sourceMenus.filter((item) => item.when.includes('guthonSvnProcedure'));
  assert.deepEqual(
    procedureMenus.slice(0, 3).map((item) => item.command),
    [
      'gushenCompletion.copySvnProcedureName',
      'gushenCompletion.copyQualifiedSvnProcedureName',
      'gushenCompletion.showSvnProcedureCallers',
    ]
  );
  assert(procedureMenus.slice(0, 3).every((item) => item.when.includes('guthonSvnProcedure')));
  assert(sourceMenus.some((item) => item.command === 'gushenCompletion.showSvnPageNodes'
    && item.when.includes('guthonSvnPage')));
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

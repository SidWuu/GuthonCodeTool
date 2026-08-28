const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildSourceTree,
  CATEGORY_ICONS,
  fragmentLabel,
  groupCatalog,
  objectLabel,
  SOURCE_ICONS,
  SvnCatalogTreeProvider,
} = require('../src/svn/catalog-tree');

test('uses distinct icons for SVN business categories and source types', () => {
  assert.deepEqual(CATEGORY_ICONS, {
    pages: 'layout',
    procedures: 'symbol-method',
    'system-script': 'terminal',
    tables: 'table',
    views: 'eye',
    skill: 'book',
    public: 'folder-library',
  });
  assert.equal(SOURCE_ICONS.page, 'preview');
  assert.equal(SOURCE_ICONS.procedure, 'symbol-method');
  assert.equal(SOURCE_ICONS['system-script'], 'terminal');
  assert.equal(SOURCE_ICONS.table, 'table');
  assert.equal(SOURCE_ICONS.view, 'eye');
});

test('groups SVN objects by business category without grouping by physical working copy', () => {
  const groups = groupCatalog([
    { sourceType: 'page', sourceName: '页面B', sourceAliasId: 'b', funId: '', workingCopyId: 'wc-2' },
    { sourceType: 'page', sourceName: '页面A', sourceAliasId: 'a', funId: '', workingCopyId: 'wc-1' },
    { sourceType: 'procedure', sourceName: '保存', sourceAliasId: 'demo.pkg', funId: 'save', workingCopyId: 'wc-3' },
    { sourceType: 'public', sourceName: 'README.md', sourceAliasId: 'public-root', funId: '', workingCopyId: 'wc-4' },
  ]);
  assert.deepEqual(groups.map((group) => group.category).sort(), ['pages', 'procedures', 'public']);
  assert.deepEqual(
    groups.find((group) => group.category === 'pages').children.map((item) => item.object.sourceAliasId),
    ['a', 'b']
  );
});

test('builds readable object and fragment labels', () => {
  assert.equal(
    objectLabel({ sourceType: 'procedure', sourceName: '保存', sourceAliasId: 'demo.pkg', sourceId: 'x', funId: 'save' }),
    'save demo.pkg'
  );
  assert.equal(
    objectLabel({ sourceType: 'table', sourceName: '示例表', sourceId: 'T_DEMO', funId: '' }),
    'T_DEMO 示例表'
  );
  assert.equal(fragmentLabel({ jsonPointer: '/pageSetup/pageEvents/onOpenScript', scriptType: 'js' }), 'JS · onOpenScript');
  assert.equal(fragmentLabel({ jsonPointer: '/pageSetup/serviceEvents/beforeSaveScript', scriptType: 'gss' }), 'GSS · beforeSaveScript');
  assert.equal(fragmentLabel({ jsonPointer: '/views/0/fields', scriptType: 'fields', label: '主视图字段' }), '字段 · 主视图字段');
});

test('keeps indexed source directories and sorts folders before leaves', () => {
  const tree = buildSourceTree([
    {
      sourceType: 'procedure', sourceId: 'demo.pkg#save', sourceAliasId: 'demo.pkg', funId: 'save',
      treePath: ['DS-1', 'demo', 'pkg'], treeLabel: 'save demo.pkg',
    },
    {
      sourceType: 'procedure', sourceId: 'root#run', sourceAliasId: 'root', funId: 'run',
      treePath: [], treeLabel: 'run root',
    },
  ]);
  assert.equal(tree[0].kind, 'directory');
  assert.equal(tree[0].label, 'DS-1');
  assert.equal(tree[0].children[0].children[0].label, 'pkg');
  assert.equal(tree[0].children[0].children[0].children[0].label, 'save demo.pkg');
  assert.equal(tree[1].label, 'run root');
});

test('orders PAGE and procedure folders and leaves by index.md position', () => {
  const tree = buildSourceTree([
    {
      sourceType: 'page', sourceId: 'PG-A', sourceAliasId: 'a', funId: '',
      treePath: ['示例系统', '后出现模块'], treeLabel: '字母靠前页面', treeOrder: [0, 30],
    },
    {
      sourceType: 'page', sourceId: 'PG-B', sourceAliasId: 'b', funId: '',
      treePath: ['示例系统', '先出现模块'], treeLabel: '字母靠后页面', treeOrder: [0, 10],
    },
    {
      sourceType: 'page', sourceId: 'PG-C', sourceAliasId: 'c', funId: '',
      treePath: ['示例系统'], treeLabel: '中间页面', treeOrder: [0, 20],
    },
    {
      sourceType: 'page', sourceId: 'PG-Z', sourceAliasId: 'z', funId: '',
      treePath: ['示例系统', '先出现模块'], treeLabel: '第一项', treeOrder: [0, 11],
    },
  ]);

  assert.deepEqual(tree[0].children.map((item) => item.label), [
    '先出现模块',
    '中间页面',
    '后出现模块',
  ]);
  assert.deepEqual(tree[0].children[0].children.map((item) => item.label), [
    '字母靠后页面',
    '第一项',
  ]);
});

test('keeps a lazy PAGE leaf expandable before its fragments are loaded', async () => {
  const fragmentCalls = [];
  const provider = new SvnCatalogTreeProvider({
    vscode: { EventEmitter: class { constructor() { this.event = () => {}; } fire() {} dispose() {} } },
    backend: {
      fragments: async (workspaceKey, identity) => {
        fragmentCalls.push({ workspaceKey, identity });
        return {
          fragments: [
            { scriptType: 'js', jsonPointer: '/pageSetup/pageEvents/onOpenScript', label: 'pageSetup / pageEvents / onOpenScript' },
            { scriptType: 'gss', jsonPointer: '/pageSetup/serviceEvents/query/doMethodScript', label: 'serviceEvents / query / doMethodScript' },
            { scriptType: 'fields', jsonPointer: '/views/0/fields', label: '主视图' },
            { scriptType: 'sql', jsonPointer: '/views/0/datasource/sql', label: '' },
          ],
        };
      },
    },
    listSvnWorkspaces: async () => [],
  });
  const [page] = await provider.getChildren({
    kind: 'directory',
    workspaceKey: 'products.demo',
    children: [{
      kind: 'source',
      label: '示例页面',
      object: { sourceType: 'page', sourceId: 'PG-1', funId: '', fragments: null, status: 'OK' },
    }],
  });
  assert.equal(page.kind, 'object');
  assert.equal(page.command, undefined);
  const fragments = await provider.getChildren(page);
  assert.equal(fragments.length, 4);
  assert.deepEqual(fragments.map((item) => item.label), [
    'JS · pageSetup / pageEvents / onOpenScript',
    'GSS · serviceEvents / query / doMethodScript',
    '字段 · 主视图',
    'SQL · sql',
  ]);
  assert.deepEqual(fragmentCalls, [{
    workspaceKey: 'products.demo',
    identity: { sourceType: 'page', sourceId: 'PG-1', funId: '' },
  }]);
});

test('opens an independent PAGE service component as GSS', async () => {
  const provider = new SvnCatalogTreeProvider({
    vscode: { EventEmitter: class { constructor() { this.event = () => {}; } fire() {} dispose() {} } },
    backend: {},
    listSvnWorkspaces: async () => [],
  });
  const [component] = await provider.getChildren({
    kind: 'directory',
    workspaceKey: 'products.demo',
    children: [{
      kind: 'source',
      label: 'GSS · 保存服务',
      object: {
        sourceType: 'page',
        sourceId: 'PG-GSS-1',
        funId: '',
        fragments: [{ scriptType: 'gss', jsonPointer: '', label: '' }],
        status: 'OK',
      },
    }],
  });

  assert.equal(component.kind, 'document');
  assert.equal(component.command.arguments[0].fragmentType, 'gss');
  assert.equal(component.command.arguments[0].sourceType, 'page');
});

test('locates an active virtual fragment through stable parent nodes', async () => {
  const provider = new SvnCatalogTreeProvider({
    vscode: { EventEmitter: class { constructor() { this.event = () => {}; } fire() {} dispose() {} } },
    backend: {
      catalog: async () => ({
        objects: [{
          sourceType: 'page', sourceId: 'PG-1', sourceAliasId: 'demo.page', funId: '',
          sourcePath: 'pages/SYS-1/PG-1.json', treePath: ['示例系统', '示例目录'],
          treeLabel: '示例页面', fragments: null, status: 'OK',
        }],
      }),
      fragments: async () => ({
        fragments: [{
          scriptType: 'js', jsonPointer: '/pageSetup/pageEvents/onOpenScript',
          label: 'pageSetup / pageEvents / onOpenScript',
        }],
      }),
    },
    listSvnWorkspaces: async () => [{ workspaceKey: 'products.demo', displayName: 'PRD 示例' }],
  });

  const fragment = await provider.locate({
    workspaceKey: 'products.demo',
    sourceType: 'page',
    sourceId: 'PG-1',
    funId: '',
    jsonPointer: '/pageSetup/pageEvents/onOpenScript',
  });

  assert.equal(fragment.kind, 'fragment');
  assert.equal(fragment.parent.kind, 'object');
  assert.equal(provider.getParent(fragment), fragment.parent);
  assert.equal(fragment.parent.parent.label, '示例目录');
});

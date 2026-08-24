const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildSourceTree,
  fragmentLabel,
  groupCatalog,
  objectLabel,
  SvnCatalogTreeProvider,
} = require('../src/svn/catalog-tree');

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

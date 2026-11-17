const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildCatalogTree } = require('../src/api/source-ui');

// 标签统一使用 ASCII 前缀，避免不同系统 locale 下中文排序结果的差异影响断言。
const project = {
  systems: [
    { systemId: 'S2', systemName: 'BSys' },
    { systemId: 'S1', systemName: 'ASys' },
  ],
  dataSources: [{ dataSourceId: '0000', dataSourceName: 'DS0' }],
  menuTree: [
    {
      systemId: 'S1',
      menus: [
        { id: 'MB', name: '菜单B', isDir: 1, childs: [{ id: 'MB1', name: '页签组B', isDir: 0, pages: [
          { pageId: 'PG-1', pageSubId: '0B' },
          { pageId: 'PG-3', pageSubId: '0C' },
        ] }] },
        { id: 'MA', name: '菜单A', isDir: 1, childs: [{ id: 'MA1', name: '页签组A', isDir: 0, pages: [
          { pageId: 'PG-4', pageSubId: '0D' },
        ] }] },
      ],
    },
  ],
};

const page = (id, sub, name) => ({
  path: `systems/S1/pages/${sub}/${id}/${id}.xml`, sourceType: 'page', sourceId: id, name,
});
const objects = [
  page('PG-1', '0B', 'Beta'),
  page('PG-3', '0C', 'Alpha'),
  page('PG-4', '0D', 'Gamma'),
  page('PG-A', '0E', 'Zulu'),
  page('PG-B', '0E', 'Alpha'),
  { path: 'systems/S2/pages/0F/PG-F/PG-F.xml', sourceType: 'page', sourceId: 'PG-F', name: 'Delta' },
  { path: 'datasources/0000/procedures/com/golden/x/bFun.gss', sourceType: 'procedure', sourceId: 'PX', funId: 'bFun', name: 'Alpha' },
  { path: 'datasources/0000/procedures/com/golden/x/AFun.gss', sourceType: 'procedure', sourceId: 'PY', funId: 'AFun', name: 'Zeta' },
];

const labels = (items) => items.map((item) => item.label);
const child = (items, label) => {
  const found = items.find((item) => item.label === label);
  assert.ok(found, `缺少节点 ${label}，实际为 ${labels(items).join(',')}`);
  return found.children;
};
const category = (tree, label) => child(tree, label);

test('platform order follows menu order, page tab order and system order', () => {
  const tree = buildCatalogTree('projects.demo', {}, objects, project, { order: 'platform' });
  const pages = category(tree, '页面');
  assert.deepEqual(labels(pages), ['BSys', 'ASys'], '系统按平台清单顺序');
  const system = child(pages, 'ASys');
  assert.deepEqual(labels(system), ['菜单B', '菜单A', '0E'], '菜单按平台顺序，未挂菜单的目录在后');
  const tabGroup = child(child(system, '菜单B'), '页签组B');
  assert.deepEqual(labels(tabGroup), ['PG-1 · Beta', 'PG-3 · Alpha'], '同一菜单内取平台 pages 数组顺序');
  assert.deepEqual(labels(child(system, '0E')), ['PG-A', 'PG-B'], '未挂菜单的页面按 pageId 顺序');
  assert.deepEqual(labels(child(child(system, '0E'), 'PG-A')), ['PG-A · Zulu']);
  assert.deepEqual(labels(child(child(system, '0E'), 'PG-B')), ['PG-B · Alpha']);
});

test('platform order follows fun id order for procedures', () => {
  const tree = buildCatalogTree('projects.demo', {}, objects, project, { order: 'platform' });
  const procedures = category(tree, '过程函数');
  assert.deepEqual(labels(procedures), ['DS0']);
  const leafDir = child(child(child(child(procedures, 'DS0'), 'com'), 'golden'), 'x');
  assert.deepEqual(labels(leafDir), ['AFun(无) Zeta', 'bFun(无) Alpha'], 'AFun 先于 bFun（忽略大小写的 funId 顺序）');
});

test('changing the order setting rebuilds the cached tree', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');
  assert.match(source, /affectsConfiguration\('gushenCompletion\.sourceTreeOrder'\)/);
  assert.match(source, /sourceTree\.invalidate\(\)[\s\S]{0,80}sourceTree\.refresh\(\)/);
});

test('name order keeps the previous display-name sorting', () => {
  const tree = buildCatalogTree('projects.demo', {}, objects, project, { order: 'name' });
  const pages = category(tree, '页面');
  assert.deepEqual(labels(pages), ['ASys', 'BSys'], '名称模式按显示名排序');
  const system = child(pages, 'ASys');
  assert.deepEqual(labels(system), ['0E', '菜单A', '菜单B']);
  const tabGroup = child(child(system, '菜单B'), '页签组B');
  assert.deepEqual(labels(tabGroup), ['PG-3 · Alpha', 'PG-1 · Beta']);
  const procedures = category(tree, '过程函数');
  const leafDir = child(child(child(child(procedures, 'DS0'), 'com'), 'golden'), 'x');
  assert.deepEqual(labels(leafDir), ['bFun(无) Alpha', 'AFun(无) Zeta']);
});

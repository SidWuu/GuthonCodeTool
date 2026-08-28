'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildAiObjectByFilePath,
  indexedObjectDisplayName,
  isDeletedOrMissingChange,
  readableChangeName
} = require('../src/scm-display');
const { pathKey } = require('../src/path-utils');

test('uses the AI index Chinese name for a changed procedure', () => {
  const root = path.resolve('/project');
  const relativePath = path.join('procedures', '0015', 'com', 'golden', 'createDetail.gss');
  const filePath = path.join(root, relativePath);
  const index = {
    objects: [{
      kind: 'procedure',
      objectId: 'createDetail',
      name: '保存期货交易记录',
      path: relativePath
    }]
  };
  const repository = {
    root: path.join(root, 'procedures', '0015'),
    sourceCategory: 'procedures',
    aiObjectByFilePath: buildAiObjectByFilePath(root, index)
  };
  assert.equal(readableChangeName(repository, { filePath, relativePath }), '保存期货交易记录（createDetail）.gss');
});

test('keeps an indexed Chinese name available when the working file was deleted', () => {
  const root = path.resolve('/project');
  const filePath = path.join(root, 'views', '0015', 'RM_RISK.json');
  const object = { kind: 'view', objectId: 'RM_RISK', name: '风险视图', path: 'views/0015/RM_RISK.json' };
  const map = buildAiObjectByFilePath(root, { objects: [object] });
  assert.equal(indexedObjectDisplayName(map.get(pathKey(filePath)), filePath), '风险视图（RM_RISK）.json');
  assert.equal(isDeletedOrMissingChange({ item: 'deleted' }, false), true);
});

test('prefers the page record when a service component has two index records', () => {
  const root = path.resolve('/project');
  const relativePath = 'pages/SYS-DEMO/1/2/service.gss';
  const map = buildAiObjectByFilePath(root, { objects: [
    { kind: 'service-component', objectId: 'service', name: '服务组件名称', path: relativePath },
    { kind: 'page', objectId: `page:${relativePath}`, name: '页面目录名称', path: relativePath }
  ] });
  assert.equal(map.get(pathKey(path.join(root, relativePath))).kind, 'page');
});

test('uses the Chinese page name for a new systems child checkout', () => {
  const root = path.resolve('/project');
  const filePath = path.join(root, 'systems', 'SYS-DEMO', 'pages', 'E', 'EPG.json');
  const repository = {
    root: path.join(root, 'systems', 'SYS-DEMO'),
    logicalRoot: root,
    sourceCategory: 'systems',
    pageByFilePath: new Map([[pathKey(filePath), { label: '入库验收单' }]])
  };
  assert.equal(
    readableChangeName(repository, {
      filePath,
      relativePath: path.join('pages', 'E', 'EPG.json')
    }),
    '入库验收单（EPG）.json'
  );
});

test('includes the owning module for a main page change', () => {
  const root = path.resolve('/project');
  const filePath = path.join(root, 'systems', 'SYS-DEMO', 'pages', '8', 'PG-MAIN.json');
  const repository = {
    root: path.join(root, 'systems', 'SYS-DEMO'),
    logicalRoot: root,
    sourceCategory: 'systems',
    pageByFilePath: new Map([[
      pathKey(filePath),
      { label: '主页面', pageType: '主页面', breadcrumb: '策略方案 / 主页面' }
    ]])
  };
  assert.equal(
    readableChangeName(repository, {
      filePath,
      relativePath: path.join('pages', '8', 'PG-MAIN.json')
    }),
    '策略方案 · 主页面（PG-MAIN）.json'
  );
});

test('detects an absent working file as a deleted-style comparison', () => {
  assert.equal(isDeletedOrMissingChange({ item: 'modified' }, false), true);
  assert.equal(isDeletedOrMissingChange({ item: 'modified' }, true), false);
});

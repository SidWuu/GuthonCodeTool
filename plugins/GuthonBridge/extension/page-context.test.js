const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./page-bridge.js'), 'utf8');
const code = source.slice(source.indexOf('  function inspectCurrentHubSource('), source.indexOf('  async function openSourceTarget('));

function fixture(systems, pageId = '') {
  const context = {
    document: {querySelector: () => null, querySelectorAll: selector => selector === '*' ? systems.map(systemId => ({systemId})) : []},
    location: {href: 'https://platform.example/guthon/#/gdpaas/dev/modules', hash: '#/gdpaas/dev/modules'},
    getActivePageTabCode: () => pageId, getCurrentPageCode: () => '', getDataSourceId: () => 'DS-1',
    getVueInstance: element => element && ({$store: {state: {modeDev: {systemId: element.systemId}}}}),
    getSelectedTabInfo: () => null, isVisible: () => true,
  };
  vm.runInNewContext(code, context);
  return context;
}

test('module PAGE snapshots use the native system identity, even before a PAGE is selected', () => {
  const f = fixture(['SYS-A', 'SYS-A']);
  assert.throws(() => f.inspectCurrentHubSource(), /页面编码/);
  const context = f.inspectPageContext();
  assert.equal(context.pageId, '');
  assert.equal(context.systemId, 'SYS-A');
  assert.deepEqual(Array.from(context.systemIds), ['SYS-A']);
  assert.equal(context.dataSourceId, 'DS-1');
  assert.equal(fixture(['SYS-A'], 'PG-1').inspectCurrentHubSource().pageId, 'PG-1');
});

test('module snapshots do not invent a unique system when platform identity is missing or ambiguous', () => {
  assert.equal(fixture([]).inspectPageContext().systemId, '');
  assert.deepEqual(Array.from(fixture([null, 'invalid']).inspectPageContext().systemIds), []);
  const ambiguous = fixture(['SYS-A', 'SYS-B']).inspectPageContext();
  assert.equal(ambiguous.systemId, '');
  assert.deepEqual(Array.from(ambiguous.systemIds), ['SYS-A', 'SYS-B']);
});

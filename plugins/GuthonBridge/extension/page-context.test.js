const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./page-bridge.js'), 'utf8');
const code = source.slice(source.indexOf('  function inspectCurrentHubSource('), source.indexOf('  async function openSourceTarget('));
const datasourceCode = source.slice(source.indexOf('  function getDataSourceId('), source.indexOf('  function getLabeledSelectValue('));
const pickCode = source.slice(source.indexOf('  function pickFirst('), source.indexOf('  function findDeepFirst('));

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

function procedureSnapshot(sources, functionOpen = true) {
    const ctx = fixture([]);
    ctx.location = {href:'https://platform.example/guthon/#/gdpaas/dev/procedure_develop', hash:'#/gdpaas/dev/procedure_develop'};
    ctx.document.querySelector = () => functionOpen ? {visible:true} : null;
    ctx.document.querySelectorAll = selector => selector === '.procedure-develop .tree-tool-bar .data-source-select'
        ? sources.map(({value, pageValue, visible}) => ({vm:{value}, visible,
            closest:() => ({vm:{dataSourceId:pageValue}})}))
        : [];
    ctx.getVueInstance = element => element?.vm;
    ctx.isVisible = element => element.visible;
    ctx.getLabeledSelectValue = () => '';
    ctx.getAllVueInstances = () => [{dataSourceId:'stale-editor-source'}];
    ctx.inspectCurrentProcedure = () => ({funId:'billSubmit'});
    vm.runInContext(pickCode + datasourceCode, ctx);
    return ctx.inspectPageContext();
}

test('procedure snapshots read an unlabeled visible data source selector instead of the script editor', () => {
    const result = procedureSnapshot([
        {value:'0000', pageValue:'0000', visible:true},
        {value:'9999', pageValue:'9999', visible:false}
    ]);
    assert.equal(result.mode, 'procedure');
    assert.equal(result.funId, 'billSubmit');
    assert.equal(result.dataSourceId, '0000');
    assert.equal(procedureSnapshot([{pageValue:'0000', visible:true}]).dataSourceId, '0000');
});

test('procedure snapshots do not route on missing or conflicting data source selections', () => {
    assert.equal(procedureSnapshot([{visible:true}]).dataSourceId, '');
    assert.equal(procedureSnapshot([{value:'0000', pageValue:'9999', visible:true}]).dataSourceId, '');
    assert.equal(procedureSnapshot([{value:'0000', visible:true}, {value:'9999', visible:true}]).dataSourceId, '');
});

test('opening the procedure workbench is sufficient to register a selected source without opening a function', () => {
    const result = procedureSnapshot([{value:'0000', visible:true}], false);
    assert.equal(result.mode, 'procedure');
    assert.equal(result.dataSourceId, '0000');
    assert.equal(result.funId, '');
});

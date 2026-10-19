const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(id = 'gdpaas_dev_moduleConfigList', { cards = false } = {}) {
  function element(classes = '', children = []) {
    const names = new Set(classes.split(' ').filter(Boolean));
    const styles = new Map();
    const e = {
      children, hidden: false, scrollTop: 42,
      classList: { contains: c => names.has(c), add: c => names.add(c), remove: c => names.delete(c) },
      style: { getPropertyValue: k => styles.get(k) || '', setProperty: (k,v) => styles.set(k,v), removeProperty: k => styles.delete(k) },
      matches: selector => selector.split(',').some(s => names.has(s.trim().slice(1))),
      getClientRects: () => e.hidden ? [] : [{}],
      getBoundingClientRect: () => ({ top: 80 }),
      contains: node => node === e || children.some(c => c.contains(node)),
      closest: selector => e.matches(selector) ? e : e.parentElement?.closest(selector),
      querySelectorAll: selector => children.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)])
    };
    for (const c of children) c.parentElement = e;
    return e;
  }
  const table = element(cards ? 'table-context' : 'el-table');
  const grid = element(cards ? 'table-free-view' : 'gd-page-data-table', [table]);
  const category = element('tree-box');
  const context = element('context-box', [category, element('main-box', [grid])]);
  const systems = element('', [element('system-tree')]);
  const split = element('', [systems, element('', [element('gd-main-search-box'), context])]);
  const dialogTable = element('el-table');
  const dialog = element('el-dialog__wrapper', [element('gd-page-data-table', [dialogTable])]);
  const root = element('', [split, dialog]);
  const tab = element();
  tab.id = 'tab-' + id;
  const events = new Map();
  let notify, pending, disconnected = false, stoppedFrames = 0;
  const sandbox = {
    document: { body: {}, querySelector: () => root, querySelectorAll: () => [tab] },
    window: { innerHeight: 800, addEventListener: (k,v) => events.set(k,v), removeEventListener: k => events.delete(k) },
    getComputedStyle: () => ({ visibility: 'visible' }),
    requestAnimationFrame: f => { pending = f; return 1; },
    cancelAnimationFrame: () => { pending = null; stoppedFrames++; },
    MutationObserver: class { constructor(f) { notify=f; } observe() {} disconnect() { disconnected=true; } }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('./platform-layout.js'), 'utf8'), sandbox);
  const stop = sandbox.GuthonBridgePlatformLayout.start();
  return {root, grid, table, tab, split, context, systems, dialogTable, events, stop,
    notify: () => notify(), flush: () => { const f=pending; pending=null; f?.(); },
    state: () => ({pending, disconnected, stoppedFrames})};
}

test('only list ancestors are constrained; both trees stay beside the independently scrolling grid', () => {
  const f = fixture();
  assert.ok(f.root.classList.contains('guthon-layout-viewport'));
  assert.ok(f.split.classList.contains('guthon-layout-row'));
  assert.ok(f.context.classList.contains('guthon-layout-row'));
  assert.ok(f.grid.classList.contains('guthon-layout-grid'));
  assert.ok(f.table.classList.contains('guthon-layout-table'));
  assert.equal(f.systems.classList.contains('guthon-layout-column'), false);
  assert.equal(f.dialogTable.classList.contains('guthon-layout-table'), false);
  assert.equal(f.root.style.getPropertyValue('--guthon-layout-height'), '720px');
  assert.equal(f.root.scrollTop, 0);
  f.stop();
});

test('table management main list is enhanced without requiring field-specific headers', () => {
  const f = fixture('gdpaas_sys_tables');
  assert.ok(f.grid.classList.contains('guthon-layout-grid'));
  assert.ok(f.table.classList.contains('guthon-layout-table'));
  assert.ok(f.split.classList.contains('guthon-layout-row'));
  assert.equal(f.dialogTable.classList.contains('guthon-layout-table'), false);
  f.stop();
});

test('table catalog cards scroll below the toolbar and release hidden Vue views', () => {
  const f = fixture('gdpaas_sys_tables', { cards: true });
  assert.ok(f.root.classList.contains('guthon-layout-viewport'));
  assert.ok(f.grid.classList.contains('guthon-layout-column'));
  assert.ok(f.table.classList.contains('guthon-layout-scroller'));
  assert.equal(f.table.classList.contains('guthon-layout-table'), false);
  f.grid.parentElement.style.display = 'none';
  f.notify(); f.flush();
  assert.equal(f.grid.classList.contains('guthon-layout-column'), false);
  assert.equal(f.table.classList.contains('guthon-layout-scroller'), false);
  f.grid.parentElement.style.display = '';
  f.notify(); f.flush();
  assert.ok(f.table.classList.contains('guthon-layout-scroller'));
  f.stop();
  assert.equal(f.table.classList.contains('guthon-layout-scroller'), false);
});

test('unsupported development pages are untouched', () => {
  for (const id of ['gdpaas_dev_modules', 'gdpaas_dev_procedure_develop']) {
    const f=fixture(id);
    assert.equal(f.root.classList.contains('guthon-layout-viewport'), false);
    f.stop();
  }
});

test('page hiding and switching release layout; remount and resize restore it without resetting list scroll', () => {
  const f=fixture('gdpaas_dev_systemscript');
  f.root.scrollTop=7;
  f.notify(); f.notify(); f.flush();
  assert.equal(f.root.scrollTop,7);
  f.grid.hidden=true;
  f.notify(); f.flush();
  assert.equal(f.table.classList.contains('guthon-layout-table'),false);
  f.grid.hidden=false;
  f.events.get('resize')(); f.flush();
  assert.ok(f.table.classList.contains('guthon-layout-table'));
  f.tab.id='tab-gdpaas_dev_modules';
  f.notify(); f.flush();
  assert.equal(f.root.classList.contains('guthon-layout-viewport'),false);
  assert.equal(f.root.style.getPropertyValue('--guthon-layout-height'),'');
  f.stop();
});

test('extension cleanup cancels pending work and removes observers, listeners and layout classes', () => {
  const f=fixture('gdpaas_dev_devLogsList');
  f.notify(); f.stop(); f.flush(); f.notify();
  assert.equal(f.state().disconnected,true);
  assert.equal(f.state().stoppedFrames,1);
  assert.equal(f.state().pending,null);
  assert.equal(f.events.size,0);
  assert.equal(f.table.classList.contains('guthon-layout-table'),false);
  assert.equal(f.root.style.getPropertyValue('--guthon-layout-height'),'');
});

test('automatic and manual injection both load layout before content lifecycle starts', () => {
  const manifest = require('./manifest.json');
  const files = manifest.content_scripts[0].js;
  assert.ok(files.indexOf('platform-layout.js') < files.indexOf('content.js'));
  const background=fs.readFileSync(require.resolve('./background.js'),'utf8');
  assert.match(background,/"platform-layout.js", "content.js"/);
  const content=fs.readFileSync(require.resolve('./content.js'),'utf8');
  assert.ok(content.indexOf('GuthonBridgeHost?.isAllowed') < content.indexOf('GuthonBridgePlatformLayout?.start'));
  assert.match(content,/function stopExtensionLoops\(\) \{\s+stopPlatformLayout\?\.\(\);/);
});

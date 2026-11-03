const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture({saved, delayed = false} = {}) {
  let notify, pending, disconnected = false, resolveStorage;
  const events = new Map(), writes = [];
  let document;
  class Element {
    constructor(classes = '', attrs = {}, children = []) {
      this.names = new Set(classes.split(' ').filter(Boolean));
      this.attrs = {...attrs};
      this.id = attrs.id || '';
      this.children = children;
      this.nodeType = 1;
      this.left = 100;
      this.right = 200;
      for (const child of children) child.parentElement = this;
      this.classList = {contains: c => this.names.has(c), add: (...cs) => cs.forEach(c => this.names.add(c)),
        remove: (...cs) => cs.forEach(c => this.names.delete(c))};
    }
    get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
    matches(selector) {
      return selector.split(',').some(s => {
        s = s.trim();
        const not = s.match(/:not\(([^)]+)\)/);
        if (not && this.matches(not[1])) return false;
        s = s.replace(/:not\([^)]+\)/g, '');
        if (/^[a-z]/i.test(s) && !s.startsWith('div')) return false;
        return [...s.matchAll(/\.([\w-]+)/g)].every(m => this.names.has(m[1]))
          && [...s.matchAll(/\[([\w-]+)="([^"]*)"\]/g)].every(m => this.getAttribute(m[1]) === m[2]);
      });
    }
    closest(s) { return this.matches(s) ? this : this.parentElement?.closest(s) || null; }
    querySelectorAll(s) { return this.children.flatMap(c => [...(c.matches(s) ? [c] : []), ...c.querySelectorAll(s)]); }
    querySelector(s) { return this.querySelectorAll(s)[0] || null; }
    getAttribute(k) { return this.attrs[k] ?? null; }
    hasAttribute(k) { return k in this.attrs; }
    setAttribute(k, v) { this.attrs[k] = v; }
    removeAttribute(k) { delete this.attrs[k]; }
    contains(node) { return node === this || this.children.some(c => c.contains(node)); }
    getBoundingClientRect() { return {left: this.left, right: this.right}; }
    focus() { document.activeElement = this; }
    click() { this.clicks = (this.clicks || 0) + 1; }
    insertBefore(node, before) {
      const previous = node.parentElement;
      if (previous) previous.children.splice(previous.children.indexOf(node), 1);
      this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node);
      node.parentElement = this;
      if (document.activeElement === node) document.activeElement = document.body;
    }
  }
  const tab = (id, attrs = {}) => new Element('el-tabs__item', {id: 'tab-' + id, role: 'tab', ...attrs}, [new Element('el-icon-close')]);
  function row(ids, parentClass, extra = '') {
    const nav = new Element('el-tabs__nav', {role: 'tablist'}, ids.map(id => tab(id)));
    const prev = new Element('el-tabs__nav-prev'), next = new Element('el-tabs__nav-next');
    const wrap = new Element('el-tabs__nav-wrap', {}, [prev, nav, next]);
    wrap.left = 0; wrap.right = 1000;
    const owner = new Element('el-tabs el-tabs--card ' + extra, {}, [wrap]);
    const root = new Element(parentClass, {}, [owner]);
    return {nav, root, prev, next, ids: () => nav.children.map(t => t.id), tab: id => nav.children.find(t => t.id === 'tab-' + id)};
  }
  const main = row(['home', 'gdpaas_sys_tables', 'gdpaas_dev_modules', 'gdpaas_dev_procedure_develop', 'check'], 'pageTabs');
  main.tab('gdpaas_sys_tables').setAttribute('title', '表管理');
  const procedures = row(['PR-A@read', 'PR-B@save', 'PR-C@query'], 'gd-layout-content-main');
  const pages = row(['PG-A', 'PG-B', 'PG-C'], 'gd-layout-content-main');
  const business = row(['tabPage1', 'tabPage2'], 'gd-layout-content-main');
  const dialog = row(['PG-X', 'PG-Y'], 'el-dialog__wrapper gd-layout-content-main');
  const plain = row(['PR-X@a', 'PR-X@b'], 'gd-layout-content-main');
  plain.nav.closest('.el-tabs').names.delete('el-tabs--card');
  const shell = new Element('', {}, [main.root, procedures.root, pages.root, business.root, dialog.root, plain.root]);
  document = {body: shell, activeElement: shell,
    querySelectorAll: s => shell.querySelectorAll(s.replace('#app-main-target ', '')),
    addEventListener: (type, listener) => events.set(type, listener),
    removeEventListener: type => events.delete(type)};
  const key = 'guthonBridgeTabOrder:https://platform.example';
  const context = {location: {origin: 'https://platform.example'}, document, console,
    chrome: {storage: {local: {get: () => delayed ? new Promise(resolve => {resolveStorage = resolve;}) : Promise.resolve({[key]: saved}),
      set: async data => {writes.push(data);}}}},
    requestAnimationFrame: fn => {pending = fn; return 1;}, cancelAnimationFrame: () => {pending = null;},
    MutationObserver: class {constructor(fn) {notify = fn;} observe() {} disconnect() {disconnected = true;}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('./tab-sorter.js'), 'utf8'), context);
  const stop = context.GuthonBridgeTabSorter.start();
  function event(type, target, clientX = 110) {
    const e = {target, clientX, key: type === 'keydown' ? 'Escape' : '', dataTransfer: {setData() {}},
      preventDefault() {this.prevented = true;}, stopPropagation() {this.stopped = true;}};
    events.get(type)?.(e);
    return e;
  }
  return {main, procedures, pages, business, dialog, plain, document, writes, stop, events, tab, event,
    drag(from, to, after = false) {event('pointerdown', from); event('dragstart', from); event('dragover', to, after ? 190 : 110); return event('drop', to);},
    changed(nav) {notify([{target: nav, addedNodes: [], removedNodes: []}]); const fn = pending; pending = null; fn?.();},
    resolveStorage: () => resolveStorage({[key]: saved}), disconnected: () => disconnected};
}

test('main headers reorder with pinned controls; editor rows stay independent and retain selection', async () => {
  const f = fixture();
  await Promise.resolve();
  const active = f.main.tab('gdpaas_dev_procedure_develop');
  active.setAttribute('aria-selected', 'true');
  active.focus();
  const dropped = f.drag(active, f.main.tab('gdpaas_sys_tables'));
  assert.equal(dropped.prevented, true);
  assert.equal(dropped.stopped, true);
  assert.deepEqual(f.main.ids(), ['tab-home', active.id, 'tab-gdpaas_sys_tables', 'tab-gdpaas_dev_modules', 'tab-check']);
  assert.equal(f.document.activeElement, active);
  assert.equal(active.getAttribute('aria-selected'), 'true');
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0]['guthonBridgeTabOrder:https://platform.example'][0], active.id);
  f.drag(f.procedures.tab('PR-A@read'), f.procedures.tab('PR-C@query'), true);
  assert.deepEqual(f.procedures.ids(), ['tab-PR-B@save', 'tab-PR-C@query', 'tab-PR-A@read']);
  assert.deepEqual(f.pages.ids(), ['tab-PG-A', 'tab-PG-B', 'tab-PG-C']);
  assert.equal(f.writes.length, 1, 'editor identifiers are not persisted');
  f.stop();
});

test('cross-row drops, close-button drags, fixed controls and unrelated tabs do not reorder', () => {
  const f = fixture();
  const before = f.main.ids();
  f.drag(f.main.tab('gdpaas_sys_tables'), f.procedures.tab('PR-B@save'));
  assert.deepEqual(f.main.ids(), before);
  const tab = f.main.tab('gdpaas_sys_tables');
  f.event('pointerdown', tab.children[0]);
  assert.equal(f.event('dragstart', tab).prevented, true);
  f.event('dragover', f.main.tab('gdpaas_dev_modules'));
  f.event('drop', f.main.tab('gdpaas_dev_modules'));
  assert.deepEqual(f.main.ids(), before);
  assert.equal(f.event('dragstart', f.main.tab('home')).prevented, true);
  for (const row of [f.business, f.dialog, f.plain]) {
    assert.ok(row.nav.children.every(t => t.getAttribute('draggable') === null));
  }
  assert.equal(f.writes.length, 0);
  f.stop();
});

test('saved order survives native redraw, opening and closing headers without remounting editors', async () => {
  const f = fixture({saved: ['tab-gdpaas_dev_modules', 'tab-gdpaas_sys_tables']});
  await Promise.resolve();
  assert.equal(f.main.ids()[1], 'tab-gdpaas_dev_modules');
  const original = f.procedures.nav.children.slice();
  f.drag(original[2], original[0]);
  // Vue can restore its own header order while retaining keyed editor instances.
  f.procedures.nav.children = original.slice();
  const opened = f.tab('PR-D@new');
  f.procedures.nav.insertBefore(opened, null);
  f.changed(f.procedures.nav);
  assert.deepEqual(f.procedures.ids(), ['tab-PR-C@query', 'tab-PR-A@read', 'tab-PR-B@save', 'tab-PR-D@new']);
  assert.equal(f.procedures.tab('PR-C@query'), original[2]);
  f.procedures.nav.children.splice(f.procedures.nav.children.indexOf(original[0]), 1);
  original[0].parentElement = null;
  f.changed(f.procedures.nav);
  assert.equal(original[0].getAttribute('draggable'), null);
  assert.deepEqual(f.procedures.ids(), ['tab-PR-C@query', 'tab-PR-B@save', 'tab-PR-D@new']);
  f.stop();
});

test('late preference reads do not overwrite a new drag; malformed storage is ignored', async () => {
  const f = fixture({saved: ['tab-gdpaas_dev_modules'], delayed: true});
  f.drag(f.main.tab('gdpaas_dev_procedure_develop'), f.main.tab('gdpaas_sys_tables'));
  f.resolveStorage(); await Promise.resolve();
  assert.equal(f.main.ids()[1], 'tab-gdpaas_dev_procedure_develop');
  f.stop();
  const invalid = fixture({saved: ['tab-PR-PRIVATE', null]});
  await Promise.resolve();
  assert.equal(invalid.main.ids()[1], 'tab-gdpaas_sys_tables');
  invalid.stop();
});

test('edge scrolling, cancellation and extension cleanup remove all transient state', () => {
  const f = fixture();
  const first = f.main.tab('gdpaas_sys_tables'), last = f.main.tab('gdpaas_dev_procedure_develop');
  f.event('pointerdown', first); f.event('dragstart', first);
  f.event('dragover', last, 990);
  assert.equal(f.main.next.clicks, 1);
  assert.equal(last.classList.contains('guthon-tab-drop-after'), true);
  f.event('keydown', first);
  assert.equal(last.classList.contains('guthon-tab-drop-after'), false);
  f.event('drop', last);
  assert.equal(f.writes.length, 0);
  f.drag(last, first);
  f.stop();
  assert.equal(f.events.size, 0);
  assert.equal(f.disconnected(), true);
  assert.equal(first.getAttribute('title'), '表管理');
  assert.equal(last.getAttribute('title'), null);
  assert.equal(first.getAttribute('draggable'), null);
  assert.deepEqual(f.main.ids(), ['tab-home', first.id, 'tab-gdpaas_dev_modules', last.id, 'tab-check']);
});

test('both injection paths load the sorter and content lifecycle owns its cleanup', () => {
  const files = require('./manifest.json').content_scripts[0].js;
  assert.ok(files.indexOf('tab-sorter.js') >= 0 && files.indexOf('tab-sorter.js') < files.indexOf('content.js'));
  assert.match(fs.readFileSync(require.resolve('./background.js'), 'utf8'), /"tab-sorter.js", "content.js"/);
  const content = fs.readFileSync(require.resolve('./content.js'), 'utf8');
  assert.ok(content.indexOf('GuthonBridgeHost?.isAllowed') < content.indexOf('GuthonBridgeTabSorter?.start'));
  assert.match(content, /stopTabSorter\?\.\(\)/);
});

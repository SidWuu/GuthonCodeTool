const test = require('node:test');
const assert = require('node:assert/strict');
const {showWorkspaceSearch} = require('../src/workspace-search');
const {quickPickFixture, waitFor} = require('./quick-pick-fixture');

const item = {kind: 'source', label: '保存函数', identity: {sourceId: 'pkg', funId: 'save', sourceNamespace: 'ns-two'}};

test('live search debounces input and opens the exact backend result on Enter', async () => {
  const f = quickPickFixture(), calls = [];
  const result = showWorkspaceSearch({vscode: f.vscode, title: 'search', debounceMs: 0,
    search: async query => { calls.push(query); return {items: [item], truncated: true}; }});
  assert.equal(f.picker.shown, true);
  f.input('s'); f.input('sa'); f.input('save');
  await waitFor(() => !f.picker.busy);
  assert.deepEqual(calls, ['save']);
  assert.match(f.picker.title, /结果已截断/);
  assert.equal(f.picker.items[0].alwaysShow, true);
  f.accept();
  assert.deepEqual(await result, {item, action: 'open'});
  assert.equal(f.picker.disposed, true);
});

test('only the newest query runs after an in-flight read and stale results cannot be accepted', async () => {
  const f = quickPickFixture(), calls = [];
  let release;
  const pending = showWorkspaceSearch({vscode: f.vscode, title: 'search', debounceMs: 0,
    search: async query => {
      calls.push(query);
      if (query === 'old') return new Promise(resolve => { release = resolve; });
      return {items: [{...item, label: query}]};
    }});
  f.input('old');
  await waitFor(() => release);
  f.input('middle'); f.input('new'); f.accept();
  assert.equal(f.picker.disposed, false);
  release({items: [{...item, label: 'old'}]});
  await waitFor(() => !f.picker.busy);
  assert.deepEqual(calls, ['old', 'new']);
  assert.equal(f.picker.items[0].label, 'new');
  f.accept();
  assert.equal((await pending).item.label, 'new');
});

test('search failures remain in the picker and can be retried without losing the query', async () => {
  const f = quickPickFixture(); let calls = 0;
  const pending = showWorkspaceSearch({vscode: f.vscode, title: 'search', value: 'save',
    search: async () => { if (++calls === 1) throw new Error('index unavailable'); return {items: [item]}; }});
  await waitFor(() => calls === 1 && !f.picker.busy);
  assert.match(f.picker.placeholder, /index unavailable/);
  f.accept();
  await waitFor(() => calls === 2 && !f.picker.busy);
  f.accept();
  assert.deepEqual(await pending, {item, action: 'open'});
});

for (const action of ['context', 'context-detailed', 'context-file']) {
  test(`the ${action} item button retains the exact source identity`, async () => {
    const f = quickPickFixture();
    const pending = showWorkspaceSearch({vscode: f.vscode, title: 'search', value: 'save', search: async () => ({items: [item]})});
    await waitFor(() => f.picker.items.length);
    f.button(0, action);
    assert.deepEqual(await pending, {item, action});
  });
}

test('export-only searches preserve the requested default action', async () => {
  const f = quickPickFixture();
  const pending = showWorkspaceSearch({vscode: f.vscode, title: 'export', value: 'save', defaultAction: 'context-file',
    search: async () => ({items: [item]})});
  await waitFor(() => f.picker.items.length);
  assert.deepEqual(f.picker.items[0].buttons, []);
  f.accept();
  assert.equal((await pending).action, 'context-file');
});

test('source-only searches filter facts and report empty results without closing', async () => {
  const f = quickPickFixture();
  const pending = showWorkspaceSearch({vscode: f.vscode, title: 'open', value: 'fact', sourceOnly: true,
    search: async () => ({items: [{...item, kind: 'fact'}]})});
  await waitFor(() => !f.picker.busy);
  assert.deepEqual(f.picker.items, []);
  assert.match(f.picker.placeholder, /未找到/);
  f.accept();
  assert.equal(f.picker.disposed, false);
  f.hide();
  assert.equal(await pending, undefined);
});

test('closing during a read prevents late results and subsequent queued requests', async () => {
  const f = quickPickFixture(); let release, calls = 0;
  const pending = showWorkspaceSearch({vscode: f.vscode, title: 'search', value: 'old', debounceMs: 0,
    search: async () => { calls++; return new Promise(resolve => { release = resolve; }); }});
  await waitFor(() => release);
  f.input('new'); f.hide();
  assert.equal(await pending, undefined);
  release({items: [item]});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(f.picker.items, []);
});

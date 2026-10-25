const test = require('node:test');
const assert = require('node:assert/strict');
const {PageDraft} = require('../src/page-editor/model');
const {mergePageDraft} = require('../src/page-editor/source-merge');

const clone = value => JSON.parse(JSON.stringify(value));
function source() {
  return {pageId: 'PG-1', views: [{id: 'form', type: 'input-box', fields: [
    {fieldId: 'A', type: 'text', label: '原值', width: 1, pageEvents: {onChangeScript: 'old();'}},
    {fieldId: 'B', type: 'text', label: 'B', width: 2},
  ], datasource: {sql: 'select 1'}}]};
}
function snapshot(data = source(), hash = 'old') {
  const fields = data.views[0].fields;
  return {workspaceKey: 'products.demo', sourceNamespace: 'pages', sourceId: data.pageId, workingCopyId: 'wc',
    sourcePath: 'pages/PG-1.json', editable: true, sourceHash: hash, sourceText: JSON.stringify(data),
    model: {pageId: data.pageId, collections: [{pointer: '/views/0/fields', region: 'FORM', kind: 'FIELDS', reorderable: true,
      fields: fields.map((field, i) => ({key: 'fieldId:' + field.fieldId, pointer: '/views/0/fields/' + i,
        label: field.label, type: field.type, editable: true,
        properties: ['label', 'width'].filter(name => Object.hasOwn(field, name)).map(name => ({name, value: field[name]}))}))}],
    nodes: [{key: 'A-event', pointer: '/views/0/fields/0/pageEvents/onChangeScript', label: 'A / onChange', type: 'SCRIPT', editable: true, content: fields[0].pageEvents?.onChangeScript || ''},
      {key: 'sql', pointer: '/views/0/datasource/sql', type: 'SQL', editable: true, content: data.views[0].datasource.sql}]}};
}

test('independent changes merge onto the fresh baseline without mutating either input', () => {
  const base = snapshot(), draft = new PageDraft(base.model), changed = source();
  draft.property('/views/0/fields', 'fieldId:A', 'label', '窗口值');
  changed.views[0].fields[0].width = 88; changed.views[0].datasource.sql = 'select 2';
  const fresh = snapshot(changed, 'new'), preserved = clone(draft.model);
  const result = mergePageDraft(base, draft, fresh);
  assert.equal(result.blockedReason, ''); assert.deepEqual(result.conflicts, []);
  assert.equal(result.draft.model.collections[0].fields[0].properties[0].value, '窗口值');
  assert.equal(result.draft.model.collections[0].fields[0].properties[1].value, 88);
  assert.equal(result.draft.model.nodes[1].content, 'select 2');
  assert.deepEqual(draft.model, preserved); assert.equal(fresh.model.collections[0].fields[0].properties[0].value, '原值');
});

test('an identical external edit is absorbed while other pending draft edits remain', () => {
  const base = snapshot(), draft = new PageDraft(base.model), changed = source();
  draft.property('/views/0/fields', 'fieldId:A', 'label', 'same'); draft.text('sql', 'select draft');
  changed.views[0].fields[0].label = 'same';
  const result = mergePageDraft(base, draft, snapshot(changed, 'new'));
  assert.equal(result.absorbedCount, 1); assert.equal(result.appliedCount, 1);
  assert.deepEqual(result.draft.operations(), [{kind: 'text', jsonPointer: '/views/0/datasource/sql', content: 'select draft'}]);
});

test('three-way property and script conflicts retain all values until explicitly selected', () => {
  const base = snapshot(), draft = new PageDraft(base.model), changed = source();
  draft.property('/views/0/fields', 'fieldId:A', 'label', '窗口值'); draft.text('sql', 'select draft');
  changed.views[0].fields[0].label = '文件值'; changed.views[0].datasource.sql = 'select file';
  const fresh = snapshot(changed, 'new'), result = mergePageDraft(base, draft, fresh);
  assert.equal(result.conflicts.length, 2);
  assert.deepEqual(result.conflicts.map(item => [item.before, item.file, item.local]),
    [['原值', '文件值', '窗口值'], ['select 1', 'select file', 'select draft']]);
  const choices = {[result.conflicts[0].id]: 'file', [result.conflicts[1].id]: 'draft'};
  const resolved = mergePageDraft(base, draft, fresh, choices);
  assert.ok(resolved.conflicts.every(item => item.choice));
  assert.deepEqual(resolved.draft.operations(), [{kind: 'text', jsonPointer: '/views/0/datasource/sql', content: 'select draft'}]);
  assert.equal(resolved.draft.model.collections[0].fields[0].properties[0].value, '文件值');
});

test('window ordering retains external property edits when the file order is unchanged', () => {
  const base = snapshot(), draft = new PageDraft(base.model), changed = source();
  draft.order('/views/0/fields', ['fieldId:B', 'fieldId:A']); changed.views[0].fields[1].label = '外部 B';
  const result = mergePageDraft(base, draft, snapshot(changed, 'new'));
  assert.equal(result.blockedReason, ''); assert.equal(result.draft.model.collections[0].fields[0].properties[0].value, '外部 B');
});

for (const [name, mutate] of [
  ['field order', data => data.views[0].fields.reverse()],
  ['field insertion', data => data.views[0].fields.push({fieldId: 'C', type: 'text', label: 'C', width: 3})],
  ['field deletion', data => data.views[0].fields.pop()],
  ['field identity', data => {data.views[0].fields[0].fieldId = 'C';}],
  ['field type', data => {data.views[0].fields[0].type = 'number';}],
]) {
  test(`${name} changes prevent automatic migration of a dirty draft`, () => {
    const base = snapshot(), draft = new PageDraft(base.model), changed = source();
    draft.property('/views/0/fields', 'fieldId:A', 'label', 'pending'); mutate(changed);
    const result = mergePageDraft(base, draft, snapshot(changed, 'new'));
    assert.equal(result.draft, null); assert.match(result.blockedReason, /结构|身份/); assert.ok(result.paths.length);
    assert.equal(draft.operations()[0].value, 'pending');
  });
}

test('container replacement, anonymous array owners and duplicate identities are blocked', () => {
  for (const kind of ['replaced', 'anonymous', 'duplicate']) {
    const before = source(), changed = source();
    if (kind === 'anonymous') {delete before.views[0].id; delete changed.views[0].id;}
    if (kind === 'replaced') changed.views[0].id = 'other';
    if (kind === 'duplicate') changed.views.push({...clone(changed.views[0]), fields: []});
    const base = snapshot(before), draft = new PageDraft(base.model); draft.property('/views/0/fields', 'fieldId:A', 'label', 'pending');
    assert.match(mergePageDraft(base, draft, snapshot(changed, 'new')).blockedReason, /身份/);
  }
});

test('missing properties, inherited events and read-only snapshots cannot receive migrated edits', () => {
  const base = snapshot(), draft = new PageDraft(base.model); draft.property('/views/0/fields', 'fieldId:A', 'label', 'pending');
  const changed = source(); delete changed.views[0].fields[0].label;
  assert.match(mergePageDraft(base, draft, snapshot(changed, 'new')).blockedReason, /不存在/);
  const readonly = snapshot(source(), 'new'); readonly.editable = false;
  assert.match(mergePageDraft(base, draft, readonly).blockedReason, /不可编辑/);
  const inherited = snapshot(source(), 'new'); inherited.model.nodes[0].editable = false;
  assert.match(mergePageDraft(base, draft, inherited).blockedReason, /可编辑范围/);
});

test('workspace, path, namespace and checkout identity changes are rejected', () => {
  const base = snapshot(), draft = new PageDraft(base.model); draft.text('sql', 'pending');
  for (const key of ['workspaceKey', 'sourceNamespace', 'sourceId', 'workingCopyId', 'sourcePath']) {
    const fresh = snapshot(source(), 'new'); fresh[key] = 'other';
    assert.match(mergePageDraft(base, draft, fresh).blockedReason, /身份/);
  }
  const fresh = snapshot(source(), 'new'); fresh.model.pageId = 'other';
  assert.match(mergePageDraft(base, draft, fresh).blockedReason, /编码/);
});

test('a clean draft loads a changed structure even when the fresh page is read-only', () => {
  const base = snapshot(), changed = source(); changed.views[0].fields.reverse();
  const fresh = snapshot(changed, 'new'); fresh.editable = false;
  const result = mergePageDraft(base, new PageDraft(base.model), fresh);
  assert.equal(result.blockedReason, ''); assert.deepEqual(result.draft.model, fresh.model);
});

test('property wire types must remain compatible with the fresh source', () => {
  const base = snapshot(), draft = new PageDraft(base.model), changed = source();
  draft.property('/views/0/fields', 'fieldId:A', 'width', 10); changed.views[0].fields[0].width = '20px';
  assert.match(mergePageDraft(base, draft, snapshot(changed, 'new')).blockedReason, /属性类型/);
  changed.views[0].fields[0].width = null;
  assert.equal(mergePageDraft(base, draft, snapshot(changed, 'new')).conflicts.length, 1);
});

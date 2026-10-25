const test = require('node:test');
const assert = require('node:assert/strict');
const {PageDraft} = require('../src/page-editor/model');

function model(count = 2) {
  return {pageId: 'PG-1', collections: [{pointer: '/fields', reorderable: true, fields: Array.from({length: count}, (_, i) => ({
    key: 'field-' + i, editable: true, properties: [{name: 'label', value: i === 0 ? null : String(i)}, {name: 'options', value: {items: [i]}}],
  }))}], nodes: [{key: 'code', pointer: '/script', editable: true, content: 'old();'}]};
}

test('draft operations keep baseline ordering regardless of edit order or field reorder', () => {
  const input = model(), draft = new PageDraft(input);
  draft.text('code', 'next();'); draft.order('/fields', ['field-1', 'field-0']);
  draft.property('/fields', 'field-1', 'label', 'B'); draft.property('/fields', 'field-0', 'label', 'A');
  assert.deepEqual(draft.operations().map(op => op.kind), ['property', 'property', 'order', 'text']);
  assert.deepEqual(draft.operations().slice(0, 2).map(op => op.fieldKey), ['field-0', 'field-1']);
  const restored = new PageDraft(input); restored.restore(draft.operations());
  assert.deepEqual(restored.model, draft.model);
  assert.equal(input.collections[0].fields[0].properties[0].value, null);
});

test('repeated edits in a batch undo to an original null value as one step', () => {
  const draft = new PageDraft(model());
  draft.batch(() => {
    draft.property('/fields', 'field-0', 'label', 'first');
    draft.batch(() => { draft.property('/fields', 'field-0', 'label', 'second'); draft.text('code', 'batch();'); });
    draft.order('/fields', ['field-1', 'field-0']);
  });
  assert.equal(draft.version, 1);
  const changed = structuredClone(draft.model);
  draft.undo(); assert.deepEqual(draft.model, model()); assert.deepEqual(draft.operations(), []);
  draft.redo(); assert.deepEqual(draft.model, changed);
});

test('failed nested edits restore values, order, pending operations and redo history', () => {
  const draft = new PageDraft(model()); draft.text('code', 'saved draft'); draft.undo();
  const version = draft.version;
  assert.throws(() => draft.batch(() => {
    draft.property('/fields', 'field-0', 'label', 'temporary');
    draft.order('/fields', ['field-1', 'field-0']);
    draft.batch(() => { draft.text('code', 'temporary'); draft.text('missing', 'bad'); });
  }), /不可编辑/);
  assert.equal(draft.version, version); assert.deepEqual(draft.model, model()); assert.deepEqual(draft.operations(), []);
  draft.redo(); assert.equal(draft.model.nodes[0].content, 'saved draft');
});

test('a batch with no net change does not consume undo or clear redo', () => {
  const draft = new PageDraft(model()); draft.text('code', 'redo'); draft.undo(); const version = draft.version;
  draft.batch(() => { draft.property('/fields', 'field-0', 'label', 'temporary'); draft.property('/fields', 'field-0', 'label', null); });
  assert.equal(draft.version, version); assert.deepEqual(draft.operations(), []);
  draft.redo(); assert.equal(draft.model.nodes[0].content, 'redo');
});

test('caller mutations cannot alter stored property changes or undo values', () => {
  const draft = new PageDraft(model()), value = {items: [3]};
  draft.property('/fields', 'field-0', 'options', value); value.items.push(4);
  const operations = draft.operations(); operations[0].value.items.push(5);
  assert.deepEqual(draft.operations()[0].value, {items: [3]});
  draft.undo(); assert.deepEqual(draft.model.collections[0].fields[0].properties[1].value, {items: [0]});
  draft.redo(); assert.deepEqual(draft.operations()[0].value, {items: [3]});
});

test('the 500 operation limit rejects one edit and rolls back a whole failed batch', () => {
  const draft = new PageDraft(model(501));
  assert.throws(() => draft.batch(() => {
    for (let i = 0; i < 501; i++) draft.property('/fields', 'field-' + i, 'label', 'changed');
  }), /500/);
  assert.deepEqual(draft.operations(), []); assert.deepEqual(draft.model, model(501)); assert.equal(draft.version, 0);
  for (let i = 0; i < 500; i++) draft.property('/fields', 'field-' + i, 'label', 'changed');
  assert.throws(() => draft.property('/fields', 'field-500', 'label', 'changed'), /500/);
  assert.equal(draft.operations().length, 500);
  assert.equal(draft.model.collections[0].fields[500].properties[0].value, '500');
});

test('large pages retain the existing fifty-step undo boundary and permit new edits after undo', () => {
  const draft = new PageDraft(model(3000));
  for (let i = 1; i <= 60; i++) draft.property('/fields', 'field-2999', 'label', String(i));
  for (let i = 0; i < 60; i++) draft.undo();
  assert.equal(draft.operations()[0].value, '10');
  for (let i = 0; i < 50; i++) draft.redo();
  assert.equal(draft.operations()[0].value, '60');
  draft.undo(); draft.property('/fields', 'field-2999', 'label', 'new'); draft.redo();
  assert.equal(draft.operations()[0].value, 'new');
});

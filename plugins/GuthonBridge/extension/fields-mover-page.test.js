const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const core = require("./fields-mover-core");

function mover(source) {
  let current = source;
  let currentPage = "PG-FIXTURE";
  const code = fs.readFileSync(require.resolve("./page-bridge.js"), "utf8");
  const context = { window: { GuthonFieldsMoverCore: core }, getVueInstance: () => current,
    getCurrentPageCode: () => currentPage, isVisible: () => true,
    document: { querySelectorAll: () => [{ querySelector: selector =>
      current.columns && selector === ".input-box" ? null : { querySelectorAll: () => [] } }] } };
  vm.runInNewContext(code.slice(code.indexOf("  let copiedFields = null;"), code.indexOf("  function getAllVueInstances()")), context);
  return { context, select: (value) => { current = value; }, openPage: id => { currentPage = id; } };
}

test("hidden fields are selectable and paste into hideFields with cross-list deduplication", () => {
  const source = { fields: [{ fieldId: "A", label: "Visible" }], hideFields: [
    { fieldId: "B", label: "Hidden", pageEvents: { onChangeScript: "@inherit();" }, superPageEvents: {} },
    { fieldId: "C" }
  ] };
  const { context, select } = mover(source);
  assert.deepEqual(JSON.parse(JSON.stringify(context.readFieldsMoverSource())), [
    { index: 0, label: "Visible", fieldId: "A", hidden: false },
    { index: 1, label: "Hidden", fieldId: "B", hidden: true },
    { index: 2, label: "C", fieldId: "C", hidden: true }
  ]);
  context.copyFieldsMoverSource({ indexes: [0, 1, 2, 1] });
  const target = { fields: [{ fieldId: "C" }], hideFields: [{ fieldId: "A" }] };
  select(target);
  const result = context.pasteFieldsMoverSource();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { pasted: 1, duplicate: 2, invalid: 0 });
  assert.equal(target.fields.length, 1);
  assert.equal(target.hideFields[1].fieldId, "B");
  assert.equal(target.hideFields[1].pageEvents.onChangeScript, "");
  assert.equal(source.hideFields[0].pageEvents.onChangeScript, "@inherit();");
  assert.equal(context.pasteFieldsMoverSource().pasted, 0);
});

const batch = {
  format: "guthon-database-page-fields-v1", pageId: "PG-FIXTURE", component: "mainTable", componentType: "table-main",
  anchors: [{fieldId: "A", id: "field-a"}, {fieldId: "B", id: "field-b"}],
  updates: [
    {identity: {fieldId: "A", id: "field-a"}, type: "text", changes: [
      {path: ["width"], before: 100, after: 120},
      {path: ["pageEvents", "onChangeScript"], before: "old();", after: "new();"}
    ]},
    {identity: {fieldId: "B", id: "field-b"}, type: "text", changes: [
      {path: ["label"], before: "Old label", after: "New label"}
    ]}
  ],
  additions: [{field: {fieldId: "C", id: "field-c", type: "text"}, hidden: true}]
};

function designerTable() {
  return {columns: [{fieldId: "A", id: "field-a", type: "text", width: 100,
    pageEvents: {onChangeScript: "old();", getCellStyleScript: "keep();"}}],
  hideFields: [{fieldId: "B", id: "field-b", type: "text", label: "Old label", width: 95}]};
}

test("local clipboard preview applies existing and hidden fields together while keeping unrelated settings", () => {
  const table = designerTable();
  const {context} = mover(table);
  const text = JSON.stringify(batch);
  const [visible] = table.columns;
  const preview = context.previewLocalFieldBatch({text});
  assert.equal(preview.changes.length, 3);
  assert.equal(preview.additions.length, 1);
  assert.equal(visible.width, 100);
  assert.equal(table.hideFields[0].label, "Old label");
  const result = context.applyLocalFieldBatch({id: preview.id});
  assert.equal(result.changed, 3);
  assert.equal(result.added, 1);
  assert.equal(table.columns[0], visible);
  assert.equal(visible.width, 120);
  assert.deepEqual(visible.pageEvents, {onChangeScript: "new();", getCellStyleScript: "keep();"});
  assert.equal(table.hideFields[0].width, 95);
  assert.equal(table.hideFields[0].label, "New label");
  assert.equal(table.hideFields[1].fieldId, "C");
  assert.throws(() => context.applyLocalFieldBatch({id: preview.id}), /重新预览/);
  const retry = context.previewLocalFieldBatch({text});
  assert.equal(retry.changes.length + retry.additions.length, 0);
  assert.equal(retry.already, 4);
});

test("local field batch refuses mismatched pages, changed selections and conflicts before any edit", () => {
  const table = designerTable();
  const {context, select, openPage} = mover(table);
  const text = JSON.stringify(batch);
  openPage("PG-OTHER");
  assert.throws(() => context.previewLocalFieldBatch({text}), /PG-FIXTURE/);
  openPage(batch.pageId);
  const preview = context.previewLocalFieldBatch({text});
  select(designerTable());
  assert.throws(() => context.applyLocalFieldBatch({id: preview.id}), /目标组件已变化/);
  select(table);
  const confirmed = context.previewLocalFieldBatch({text});
  table.hideFields[0].label = "Changed in browser";
  assert.throws(() => context.applyLocalFieldBatch({id: confirmed.id}), /字段 B.*已在设计器中变化/);
  assert.equal(table.columns[0].width, 100);
  assert.equal(table.hideFields.length, 1);
  table.columns[0].id = "different-field";
  assert.throws(() => context.previewLocalFieldBatch({text}), /来源组件不匹配/);
  assert.throws(() => context.previewLocalFieldBatch({text: text.replace('"width"', '"__proto__"')}), /请粘贴 Nexus/);
});

test("table columns and missing target hidden array use the same copy flow", () => {
  const source = { columns: [{ fieldId: "A" }], hideFields: [{ fieldId: "B" }] };
  const { context, select } = mover(source);
  context.copyFieldsMoverSource({ indexes: [0, 1] });
  let reactiveSets = 0;
  const target = { columns: [], $set: (object, key, value) => { reactiveSets++; object[key] = value; } };
  select(target);
  assert.equal(context.pasteFieldsMoverSource().pasted, 2);
  assert.equal(target.columns[0].fieldId, "A");
  assert.equal(target.hideFields[0].fieldId, "B");
  assert.equal(reactiveSets, 1);
});

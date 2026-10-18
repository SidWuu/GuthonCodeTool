const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const core = require("./fields-mover-core");

function mover(source) {
  let current = source;
  const code = fs.readFileSync(require.resolve("./page-bridge.js"), "utf8");
  const context = { window: { GuthonFieldsMoverCore: core }, getVueInstance: () => current,
    document: { querySelectorAll: () => [{ querySelector: () => ({ querySelectorAll: () => [] }) }] } };
  vm.runInNewContext(code.slice(code.indexOf("  let copiedFields = null;"), code.indexOf("  function getAllVueInstances()")), context);
  return { context, select: (value) => { current = value; } };
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

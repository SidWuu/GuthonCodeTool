const assert = require("node:assert/strict");
const test = require("node:test");
const core = require("./fields-mover-core");

test("planAppendFields keeps one new field and skips duplicate or invalid fields", () => {
  const plan = core.planAppendFields(
    [{ fieldId: "A" }],
    [{ fieldId: "B" }, { fieldId: "A" }, { fieldId: "B" }, {}]
  );
  assert.deepEqual(plan.toAppend, [{ fieldId: "B" }]);
  assert.equal(plan.skippedDuplicate.length, 2);
  assert.equal(plan.skippedInvalid.length, 1);
});

test("cloneFields keeps nested source fields unchanged", () => {
  const fields = [{ fieldId: "A", nested: { width: 120 } }];
  const copy = core.cloneFields(fields);
  copy[0].nested.width = 240;
  assert.equal(fields[0].nested.width, 120);
});

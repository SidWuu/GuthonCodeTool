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

test("cloneFields clears product field markers for project paste", () => {
  const copy = core.cloneFields([{ fieldId: "A", isProduct: 1 }, { fieldId: "B", isProduct: 0 }]);

  assert.deepEqual(copy, [{ fieldId: "A", isProduct: 0 }, { fieldId: "B", isProduct: 0 }]);
});

test("cloneFields materializes project events and nested scripts without changing their sources", () => {
  const field = { fieldId: "A", isProduct: 1,
    pageEvents: { onChangeScript: "before();\n@inherit();\nafter();", onOpenScript: "inherit();" },
    superPageEvents: { onChangeScript: "product();" },
    serviceEvents: { beforeSave: "return @inherit();" },
    superServiceEvents: { beforeSave: "save();" },
    nested: { script: "inherit();", superScript: "select 1" }
  };
  const copy = core.cloneFields([field])[0];
  assert.equal(copy.pageEvents.onChangeScript, "before();\nproduct();\nafter();");
  assert.equal(copy.pageEvents.onOpenScript, "");
  assert.equal(copy.serviceEvents.beforeSave, "save();");
  assert.equal(copy.nested.script, "select 1");
  assert.equal(copy.isProduct, 0);
  assert.equal(field.pageEvents.onOpenScript, "inherit();");
});

test("empty expanded source stays empty, and project additions remain", () => {
  const copy = core.cloneFields([
    { script: "  @inherit();\r\n", superScript: "" },
    { pageEvents: { onChangeScript: "@inherit();\nproject();" }, superPageEvents: {} }
  ]);
  assert.equal(copy[0].script, "");
  assert.equal(copy[1].pageEvents.onChangeScript, "\nproject();");
});

test("literal and commented inheritance calls remain source text", () => {
  const script = '/*\n@inherit();\n*/\nconst text = "inherit()";\n// inherit();\nproject();';
  assert.equal(core.cloneFields([{ script }])[0].script, script);
});

test("unknown or ambiguous inheritance fails before copying invalid source", () => {
  assert.throws(() => core.cloneFields([{ pageEvents: { onChangeScript: "@inherit();" } }]), /缺少产品/);
  assert.throws(() => core.cloneFields([{ script: "@inherit();\n@inherit();", superScript: "product();" }]), /无法安全展开/);
});

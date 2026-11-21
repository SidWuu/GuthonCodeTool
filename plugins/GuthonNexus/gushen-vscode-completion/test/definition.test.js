const test = require('node:test');
const assert = require('node:assert/strict');
const { serviceComponentTargetAt, localFunctionDefinitionAt, procedureTargetAt } = require('../src/definition');

function at(source, word) {
  return procedureTargetAt(source, source.indexOf(word) + 1);
}

test('resolves invoke and bound procedure calls at the method name', () => {
  assert.deepEqual(at('$vs.proc.invoke("com.golden.demo", "saveData", $form);', 'saveData'), {
    alias: 'com.golden.demo', fun: 'saveData',
  });
  assert.deepEqual(at("#set($proc=$vs.proc.find('com.golden.back'))\n$proc.updateBacknum($map);", 'updateBacknum'), {
    alias: 'com.golden.back', fun: 'updateBacknum',
  });
  assert.equal(at('$vs.proc.invoke($alias, $fun, $form);', '$fun'), null);
});

test('resolves literal thread procedure calls across lines and quote styles', () => {
  for (const method of ['run', 'runFutureTask']) {
    for (const quote of ['"', "'"]) {
      const source = `$vs.thread.${method}(\n ${quote}com.golden.demo${quote},\n ${quote}saveData${quote}, $args);`;
      for (const offset of [source.indexOf('saveData'), source.indexOf('saveData') + 4]) {
        assert.deepEqual(procedureTargetAt(source, offset), { alias: 'com.golden.demo', fun: 'saveData' });
      }
      assert.equal(at(source, 'com.golden.demo'), null);
      assert.equal(at(source, '$args'), null);
    }
  }
});

test('does not guess dynamic thread targets or service component IDs', () => {
  for (const source of [
    '$vs.thread.run($alias, "saveData", $args)',
    '$vs.thread.run("$alias", "saveData", $args)',
    '$vs.thread.run("demo.pkg", $fun, $args)',
    '$vs.thread.runFutureTask("demo.pkg", "saveData" + $suffix, $args)',
    '$vs.thread.runFutureTaskExtra("demo.pkg", "saveData", $args)',
    '$vs.proc.runServiceComp("PG-DEMO", "saveData")',
    '$vs.thread.runServiceComp("PG-DEMO", "saveData")',
  ]) assert.equal(at(source, source.includes('saveData') ? 'saveData' : '$fun'), null);
});

test('uses the latest binding for a procedure variable', () => {
  const source = "#set($proc=$vs.proc.find('first'))\n#setup\n#set($proc=$vs.proc.find('second'))\n$proc.run();";
  assert.deepEqual(at(source, 'run'), { alias: 'second', fun: 'run' });
});

test('resolves a procedure local function call to its #function declaration', () => {
  const source = '@refreshPursaleOccupancy($form);\n#function refreshPursaleOccupancy($form)\n#end';
  assert.equal(localFunctionDefinitionAt(source, source.indexOf('refreshPursaleOccupancy') + 2),
    source.lastIndexOf('refreshPursaleOccupancy'));
  assert.equal(localFunctionDefinitionAt('@missing($form);\n#function other($form)\n#end', 2), null);
  assert.equal(localFunctionDefinitionAt(source, source.indexOf('$form')), null);
});

test('service component calls locate only the complete static first argument', () => {
  for (const scope of ['proc', 'thread']) {
    for (const quote of ['"', "'"]) {
      const source = `$vs.${scope}.runServiceComp(\n ${quote}PG-DEMO-123${quote}, $args, true)`;
      for (const delta of [0, 3, 10]) {
        assert.deepEqual(serviceComponentTargetAt(source, source.indexOf('PG-DEMO-123') + delta), { componentId: 'PG-DEMO-123' });
      }
      assert.equal(serviceComponentTargetAt(source, source.indexOf('$args')), null);
      assert.equal(serviceComponentTargetAt(source, source.indexOf('runServiceComp')), null);
    }
  }
  for (const source of [
    '$vs.proc.runServiceComp($componentId, $args)',
    '$vs.thread.runServiceComp("PG-DEMO" + $suffix, $args)',
    '$vs.proc.runServiceComp("$componentId", $args)',
    '$vs.thread.runServiceCompFutureTask("PG-DEMO", $args)',
    '$vs.proc.invoke("PG-DEMO", "save", $args)',
  ]) assert.equal(serviceComponentTargetAt(source, Math.max(0, source.indexOf('PG-DEMO'))), null);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { procedureTargetAt, selectDefinitionPaths } = require('../src/definition');

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

test('uses the latest binding for a procedure variable', () => {
  const source = "#set($proc=$vs.proc.find('first'))\n#setup\n#set($proc=$vs.proc.find('second'))\n$proc.run();";
  assert.deepEqual(at(source, 'run'), { alias: 'second', fun: 'run' });
});

test('prefers the current project scope before duplicate mirrors', () => {
  const current = '/repo/var/source/readonly/project/鞍钢国贸/国内贸易/page/edit/source.vm';
  const project = '/repo/var/source/readonly/project/鞍钢国贸/国内贸易/procedure/demo/save/source.vm';
  const product = '/repo/var/source/readonly/products/gdrm-product/国内贸易/procedure/demo/save/source.vm';
  assert.deepEqual(selectDefinitionPaths([product, project], current), [project]);
});

test('prefers workcopy outside a source mirror', () => {
  const workcopy = '/repo/var/source/workcopy/products/期现产品/风险管理/procedure/demo/save/source.vm';
  const readonly = '/repo/var/source/readonly/products/gdrm-product/风险管理/procedure/demo/save/source.vm';
  assert.deepEqual(selectDefinitionPaths([readonly, workcopy], '/repo/example.vm'), [workcopy]);
});

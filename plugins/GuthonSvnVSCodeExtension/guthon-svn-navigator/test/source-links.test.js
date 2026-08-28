'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  extractPageFunctionReferences,
  extractSourceReferences,
  pageFunctionReferenceAtOffset,
  referenceAtOffset,
  resolveSourceReference
} = require('../src/source-links');

test('extracts direct procedure and service component calls', () => {
  const source = `
$vs.proc.invoke('com.demo.queryRisk', 'run', $form);
#set($proc = $vs.proc.find('com.demo.common'))
$proc.setMainState($inputForm);
$vs.proc.runServiceComp('com.demo.auditService', $form);
`;
  const references = extractSourceReferences(source);

  assert.deepEqual(references.map((reference) => [reference.kind, reference.name]), [
    ['procedure', 'com.demo.queryRisk'],
    ['procedure', 'com.demo.common'],
    ['procedure', 'com.demo.common'],
    ['system-script', 'com.demo.auditService']
  ]);
  const methodReference = references.find((reference) => reference.binding === 'proc');
  assert.equal(source.slice(methodReference.start, methodReference.end), '$proc.setMainState');
  assert.equal(methodReference.member, 'setMainState');
  assert.equal(references.find((reference) => reference.name === 'com.demo.queryRisk').member, 'run');
  assert.equal(referenceAtOffset(references, methodReference.start + 2), methodReference);
});

test('resolves a variable-bound procedure and an indexed service component', () => {
  const index = {
    objects: [
      { kind: 'procedure', objectId: 'checkMainState', name: '检查主表状态', aliases: [], path: 'datasources/0015/procedures/com/golden/bdp/gdrm/common/checkMainState.gss' },
      { kind: 'procedure', objectId: 'com.demo.common', name: '公共过程', aliases: [] },
      { kind: 'service-component', objectId: 'com.demo.auditService', name: '审计服务', aliases: [], path: 'systems/SYS-DEMO/pages/1/2/com.demo.auditService.gss', systemId: 'SYS-DEMO' },
      { kind: 'system-script', objectId: 'com.demo.auditService', name: '审计服务', aliases: [] }
    ]
  };
  assert.equal(
    resolveSourceReference(index, { kind: 'procedure', name: 'com.demo.common' }).name,
    '公共过程'
  );
  assert.equal(
    resolveSourceReference(index, {
      kind: 'procedure',
      name: 'com.golden.bdp.gdrm.common',
      member: 'checkMainState'
    }).objectId,
    'checkMainState'
  );
  assert.equal(
    resolveSourceReference(index, { kind: 'system-script', name: 'com.demo.auditService' }).name,
    '审计服务'
  );
  assert.equal(
    resolveSourceReference(index, { kind: 'system-script', name: 'com.demo.auditService', systemId: 'SYS-DEMO' }).kind,
    'service-component'
  );
});

test('does not treat ordinary VM variables as procedure links', () => {
  const references = extractSourceReferences(`
$futuresTable.isEmpty();
$partsnameTypeMap.put($key, 1);
`);
  assert.deepEqual(references, []);
  assert.equal(resolveSourceReference({ objects: [{ kind: 'procedure', objectId: 'wrong' }] }, {
    kind: 'procedure',
    name: ''
  }), null);
});

test('uses the nearest preceding procedure binding when a variable is rebound', () => {
  const source = `
#set($proc = $vs.proc.find('com.golden.bdp.gdrm.common'))
$proc.checkMainState($oldMod, $form, '删除');
#set($proc = $vs.proc.find('com.golden.bdp.gdrm.updateBackNum'))
$proc.updateOptBacknum($oldMod, $form);
`;
  const references = extractSourceReferences(source).filter((reference) => reference.binding === 'proc');

  assert.deepEqual(references.map((reference) => [reference.name, reference.member]), [
    ['com.golden.bdp.gdrm.common', 'checkMainState'],
    ['com.golden.bdp.gdrm.updateBackNum', 'updateOptBacknum']
  ]);
});

test('resolves page-local function calls only within the current GSS fragment', () => {
  const source = `
// @ignoredCall();
#set($text = "@alsoIgnored()")
@buildProjectData($form);
#function buildProjectData($form)
  #set($value = "@insideString()")
#end
`;
  const references = extractPageFunctionReferences(source);
  assert.deepEqual(references.map((reference) => [reference.role, reference.name]), [
    ['call', 'buildProjectData'],
    ['definition', 'buildProjectData']
  ]);
  const call = references.find((reference) => reference.role === 'call');
  const definition = references.find((reference) => reference.role === 'definition');
  assert.equal(source.slice(call.start, call.end), 'buildProjectData');
  assert.equal(source.slice(definition.start, definition.end), 'buildProjectData');
  assert.equal(pageFunctionReferenceAtOffset(references, call.start + 2), call);
});

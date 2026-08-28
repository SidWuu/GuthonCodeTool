'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  inheritCalls,
  inspectInheritance,
  isSupportedInheritancePath,
  materializeInheritance,
  stripLeadingGeneratedComment
} = require('../src/gss-inheritance');

const childPath = '/project/datasources/0001/procedures/com/demo/check.gss';
const parentHeader = `/**
 * @functionId check
 * parent
 */
`;

test('recognizes active inheritance while ignoring comments and strings', () => {
  const source = `/** @inherit(); */
// return @inherit();
## @inherit();
#set($text = "@inherit();")
return @inherit();
`;
  const calls = inheritCalls(source);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].returnsValue, true);
  assert.equal(calls[0].arguments, '');
});

test('limits physical inheritance support to procedures and page service components', () => {
  assert.equal(isSupportedInheritancePath('/project/datasources/0001/procedures/com/demo/check.gss'), true);
  assert.equal(isSupportedInheritancePath('C:\\project\\systems\\SYS-1\\pages\\A\\check.gss'), true);
  assert.equal(isSupportedInheritancePath('/project/procedures/0001/com/demo/check.gss'), false);
  assert.equal(isSupportedInheritancePath('/project/pages/SYS-1/A/check.gss'), false);
  assert.equal(isSupportedInheritancePath('/project/system-script/SYS-1/check.gss'), false);
});

test('classifies active, overridden, missing and invalid inheritance', () => {
  assert.equal(inspectInheritance(childPath, '@inherit();', '#set($x=1)', true).state, 'active');
  assert.equal(inspectInheritance(childPath, '#set($x=1)', '#set($x=2)', true).state, 'overridden');
  assert.equal(inspectInheritance(childPath, '@inherit();', '', false).state, 'missing-parent');
  assert.equal(inspectInheritance(childPath, '@inherit();', '@inherit();', true).state, 'invalid-parent');
  assert.equal(inspectInheritance(childPath, '@inherit();\n@inherit();', '#set($x=1)', true).state, 'invalid-parent');
});

test('materializes the parent body at the inheritance call and preserves child code', () => {
  const child = `${parentHeader}@inherit();

// child extension
#set($child = true);`;
  const parent = `${parentHeader}// inherited implementation
#set($value = 1);
return $value;
`;
  const result = materializeInheritance(childPath, child, parent);
  assert.match(result.content, /\/\*\*[\s\S]*@functionId check/);
  assert.doesNotMatch(result.content, /@inherit\s*\(/);
  assert.match(result.content, /\/\/ inherited implementation/);
  assert.match(result.content, /\/\/ child extension/);
  assert.equal(result.content.match(/@functionId/g).length, 1);
});

test('keeps indentation when inheritance is expanded inside a block', () => {
  const child = `#if($enabled)
  @inherit();
#end`;
  const parent = `${parentHeader}#set($value = 1)
#if($value)
  return $value;
#end`;
  const result = materializeInheritance(childPath, child, parent);
  assert.match(result.content, /  #set\(\$value = 1\)\n  #if\(\$value\)\n    return/);
});

test('removes only the leading generated parent comment', () => {
  const parent = `${parentHeader}/** business comment */
#set($value = 1)`;
  assert.equal(stripLeadingGeneratedComment(parent), '/** business comment */\n#set($value = 1)');
  assert.equal(
    stripLeadingGeneratedComment('/** ordinary business note */\n#set($value = 1)'),
    '/** ordinary business note */\n#set($value = 1)'
  );
});

test('rejects recursive parents without changing source text', () => {
  const child = '@inherit();\n#set($child = true);';
  assert.throws(
    () => materializeInheritance(childPath, child, `${parentHeader}@inherit();`),
    /父级实现中仍包含有效/
  );
  assert.equal(child, '@inherit();\n#set($child = true);');
});

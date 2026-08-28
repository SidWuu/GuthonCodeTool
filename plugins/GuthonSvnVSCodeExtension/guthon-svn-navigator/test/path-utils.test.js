'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isPathWithin, pathKey, samePath } = require('../src/path-utils');

test('compares Windows paths without case sensitivity', () => {
  assert.equal(samePath('D:\\Workspaces\\Gme', 'd:\\workspaces\\gme', 'win32'), true);
  assert.equal(isPathWithin('D:\\Workspaces\\Gme', 'd:\\workspaces\\gme\\pages', 'win32'), true);
  assert.equal(isPathWithin('D:\\Workspaces\\Gme', 'D:\\Workspaces\\Gme-old', 'win32'), false);
  assert.equal(pathKey('D:\\Workspaces\\Gme', 'win32'), pathKey('d:\\workspaces\\gme', 'win32'));
});

test('keeps POSIX path comparisons case-sensitive', () => {
  assert.equal(samePath('/workspaces/gme', '/workspaces/GME', 'darwin'), false);
  assert.equal(isPathWithin('/workspaces/gme', '/workspaces/gme/pages', 'darwin'), true);
});

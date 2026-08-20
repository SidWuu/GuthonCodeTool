'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  describeWorkspace,
  findLogicalWorkspaceRoot,
  isLogicalWorkspaceRoot,
  workingCopyForPath
} = require('../src/workspace-layout');

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-svn-layout-'));
}

function directory(target) {
  fs.mkdirSync(target, { recursive: true });
}

test('recognizes the original monolithic SVN working copy', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  directory(path.join(root, '.svn'));
  directory(path.join(root, 'pages', 'SYS-DEMO'));

  const layout = describeWorkspace(root);
  assert.equal(layout.valid, true);
  assert.equal(layout.kind, 'monolithic');
  assert.deepEqual(layout.workingCopies, [root]);
});

test('recognizes a logical project composed of independent child checkouts', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const page = path.join(root, 'pages', 'SYS-DEMO');
  const procedure = path.join(root, 'procedures', '0000');
  const skill = path.join(root, 'skill');
  directory(path.join(page, '.svn'));
  directory(path.join(procedure, '.svn'));
  directory(path.join(skill, '.svn'));

  const layout = describeWorkspace(root);
  assert.equal(layout.valid, true);
  assert.equal(layout.kind, 'composite');
  assert.deepEqual(layout.workingCopies, [skill, page, procedure]);
  assert.equal(findLogicalWorkspaceRoot(path.join(page, 'A', 'B')), root);
  assert.equal(workingCopyForPath(root, path.join(procedure, 'com', 'golden', 'demo.gss')), procedure);
});

test('does not treat a standalone child checkout as a complete Guthon project', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  directory(path.join(root, '.svn'));
  assert.equal(isLogicalWorkspaceRoot(root), false);
});

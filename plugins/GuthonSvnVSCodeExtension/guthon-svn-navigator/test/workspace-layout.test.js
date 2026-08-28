'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  describeWorkspace,
  discoverWorkingCopyRoots,
  discoverProjectRoots,
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

function newLayout(root, system = 'SYS-DEMO', dataSource = '0000') {
  directory(path.join(root, 'systems', system, 'pages'));
  directory(path.join(root, 'datasources', dataSource, 'procedures'));
}

test('recognizes a new monolithic SVN project', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  newLayout(root);
  directory(path.join(root, '.svn'));
  const layout = describeWorkspace(root);
  assert.equal(layout.valid, true);
  assert.equal(layout.kind, 'monolithic');
  assert.deepEqual(layout.workingCopies, [root]);
});

test('recognizes new composite child checkouts', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  newLayout(root);
  const page = path.join(root, 'systems', 'SYS-DEMO');
  const procedure = path.join(root, 'datasources', '0000');
  const skill = path.join(root, 'skill');
  directory(path.join(page, '.svn'));
  directory(path.join(procedure, '.svn'));
  directory(path.join(skill, '.svn'));
  const layout = describeWorkspace(root);
  assert.equal(layout.valid, true);
  assert.equal(layout.kind, 'composite');
  assert.deepEqual(layout.workingCopies, [skill, page, procedure]);
  assert.equal(findLogicalWorkspaceRoot(path.join(page, 'pages', 'A.json')), root);
  assert.equal(workingCopyForPath(root, path.join(procedure, 'procedures', 'demo.gss')), procedure);
});

test('prefers new child checkouts over a stale root .svn', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  newLayout(root);
  const page = path.join(root, 'systems', 'SYS-DEMO');
  directory(path.join(root, '.svn'));
  directory(path.join(page, '.svn'));
  const layout = describeWorkspace(root);
  assert.equal(layout.kind, 'composite');
  assert.deepEqual(layout.workingCopies, [page]);
});

test('does not treat a root .svn without the new layout as a project', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  directory(path.join(root, '.svn'));
  assert.equal(isLogicalWorkspaceRoot(root), false);
  assert.deepEqual(discoverWorkingCopyRoots(root), [root]);
});

test('discovers multiple new-layout projects below a workspace', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'project-one');
  const second = path.join(root, 'project-two');
  newLayout(first, 'SYS-ONE', '0000');
  newLayout(second, 'SYS-TWO', '0001');
  directory(path.join(first, '.svn'));
  directory(path.join(second, 'systems', 'SYS-TWO', '.svn'));
  directory(path.join(second, 'datasources', '0001', '.svn'));
  assert.deepEqual(discoverProjectRoots(root), [first, second]);
});

test('does not scan arbitrary directories without new layout markers', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  directory(path.join(root, 'source', 'checkout', '.svn'));
  assert.deepEqual(discoverWorkingCopyRoots(root), []);
  assert.equal(describeWorkspace(root).valid, false);
});

test('does not descend into SVN administrative metadata', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  newLayout(root);
  directory(path.join(root, '.svn', 'pristine', 'aa', '.svn'));
  assert.deepEqual(discoverWorkingCopyRoots(root), [root]);
});

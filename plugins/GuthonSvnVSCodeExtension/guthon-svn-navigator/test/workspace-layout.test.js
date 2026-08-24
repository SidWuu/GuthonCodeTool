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

test('prefers fragmented child checkouts over a stale SVN directory at the project root', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const page = path.join(root, 'pages', 'SYS-DEMO');
  const procedure = path.join(root, 'procedures', '0000');
  directory(path.join(root, '.svn'));
  directory(path.join(page, '.svn'));
  directory(path.join(procedure, '.svn'));

  const layout = describeWorkspace(root);
  assert.equal(layout.valid, true);
  assert.equal(layout.kind, 'composite');
  assert.deepEqual(layout.workingCopies, [page, procedure]);
});

test('does not treat a standalone child checkout as a complete Guthon project', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  directory(path.join(root, '.svn'));
  assert.equal(isLogicalWorkspaceRoot(root), false);
});

test('discovers multiple projects below a workspace directory without using folder names', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'project-one');
  const second = path.join(root, 'project-two');
  directory(path.join(first, 'pages', 'SYS-ONE', '.svn'));
  directory(path.join(second, '.svn'));
  directory(path.join(second, 'pages', 'SYS-TWO'));

  assert.deepEqual(discoverProjectRoots(root), [first, second]);
});

test('prefers direct child projects over stale project structure at the outer workspace root', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'gmeSvn');
  directory(path.join(root, 'pages', 'SYS-STALE', '.svn'));
  directory(path.join(project, 'pages', 'SYS-ACTIVE', '.svn'));

  assert.equal(isLogicalWorkspaceRoot(root), true);
  assert.deepEqual(discoverProjectRoots(root), [project]);
});

test('recursively discovers a working copy below an arbitrary directory name', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workingCopy = path.join(root, 'source', 'checkout-a', 'nested');
  directory(path.join(root, 'pages'));
  directory(path.join(workingCopy, '.svn'));

  assert.deepEqual(discoverWorkingCopyRoots(root), [workingCopy]);
});

test('does not descend into SVN administrative metadata', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  directory(path.join(root, '.svn', 'pristine', 'aa', '.svn'));
  directory(path.join(root, 'pages', 'SYS-DEMO'));

  assert.deepEqual(discoverWorkingCopyRoots(root), [root]);
});

test('rejects directories without pages before scanning nested folders', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  directory(path.join(root, 'unrelated', 'archive', '.svn'));

  const layout = describeWorkspace(root);
  assert.equal(layout.valid, false);
  assert.deepEqual(layout.workingCopies, []);
});

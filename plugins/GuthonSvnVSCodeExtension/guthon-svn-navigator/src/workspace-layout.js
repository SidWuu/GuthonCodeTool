'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isPathWithin, samePath } = require('./path-utils');

const DIRECT_WORKING_COPIES = ['skill', 'public'];
const GROUPED_WORKING_COPIES = ['systems', 'datasources'];
const IGNORED_SCAN_DIRECTORIES = new Set(['.svn', '.git', '.hg', '.idea', '.vscode', 'node_modules']);

function isWorkingCopyRoot(candidate) {
  return Boolean(candidate) && fs.existsSync(path.join(candidate, '.svn'));
}

function childDirectories(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function discoverNestedWorkingCopyRoots(root) {
  const workingCopies = [];
  for (const name of DIRECT_WORKING_COPIES) {
    const candidate = path.join(root, name);
    if (isWorkingCopyRoot(candidate)) workingCopies.push(path.resolve(candidate));
  }
  for (const name of GROUPED_WORKING_COPIES) {
    const groupRoot = path.join(root, name);
    for (const child of childDirectories(groupRoot)) {
      if (isWorkingCopyRoot(child)) workingCopies.push(path.resolve(child));
    }
  }
  return [...new Set(workingCopies.map((candidate) => path.resolve(candidate)))];
}

function discoverWorkingCopyRoots(logicalRoot) {
  const root = path.resolve(logicalRoot);
  // 新式分片 checkout 优先于项目根目录的 .svn。部分项目根目录会残留无效
  // 的 .svn；若先把根目录当作完整工作副本，svn status 会报 W155007，
  // 同时导致所有真实子工作副本的变更都无法显示。
  const nested = discoverNestedWorkingCopyRoots(root);
  if (nested.length) return nested;
  return isWorkingCopyRoot(root) ? [root] : [];
}

function discoverProjectRoots(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  // 打开多个项目的共同父目录时，优先采用直接子项目。外层目录可能残留
  // 无效 .svn；若先命中外层目录，中文树虽然能读取源码，SCM
  // 却会对错误的父目录执行 svn status。
  const childProjects = childDirectories(root).filter(isLogicalWorkspaceRoot);
  if (childProjects.length) return childProjects;
  return isLogicalWorkspaceRoot(root) ? [root] : [];
}

function describeWorkspace(logicalRoot) {
  const root = path.resolve(logicalRoot);
  const hasProjectLayout = fs.existsSync(path.join(root, 'systems'))
    || fs.existsSync(path.join(root, 'datasources'));
  // The new layout may be a complete root checkout (root/.svn) or a set of
  // child checkouts below systems/ and datasources/. Do not scan arbitrary
  // folders unless the cheap project markers are present.
  const workingCopies = (hasProjectLayout || isWorkingCopyRoot(root))
    ? discoverWorkingCopyRoots(root) : [];
  return {
    root,
    kind: workingCopies.length === 1 && samePath(workingCopies[0], root) ? 'monolithic' : 'composite',
    workingCopies,
    valid: hasProjectLayout && workingCopies.length > 0
  };
}

function isLogicalWorkspaceRoot(candidate) {
  if (!candidate) return false;
  try {
    return describeWorkspace(candidate).valid;
  } catch {
    return false;
  }
}

function findLogicalWorkspaceRoot(startPath) {
  let current = path.resolve(startPath);
  while (true) {
    if (isLogicalWorkspaceRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function workingCopyForPath(logicalRoot, filePath) {
  const target = path.resolve(filePath);
  return discoverWorkingCopyRoots(logicalRoot)
    .filter((candidate) => isPathWithin(candidate, target))
    .sort((left, right) => right.length - left.length)[0] || null;
}

module.exports = {
  DIRECT_WORKING_COPIES,
  GROUPED_WORKING_COPIES,
  describeWorkspace,
  discoverWorkingCopyRoots,
  discoverProjectRoots,
  findLogicalWorkspaceRoot,
  isLogicalWorkspaceRoot,
  isWorkingCopyRoot,
  workingCopyForPath
};

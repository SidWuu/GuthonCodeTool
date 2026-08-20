'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DIRECT_WORKING_COPIES = ['skill', 'public'];
const GROUPED_WORKING_COPIES = ['pages', 'procedures', 'system-script', 'tables', 'views'];

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

function discoverWorkingCopyRoots(logicalRoot) {
  const root = path.resolve(logicalRoot);
  if (isWorkingCopyRoot(root)) return [root];

  const workingCopies = [];
  for (const name of DIRECT_WORKING_COPIES) {
    const candidate = path.join(root, name);
    if (isWorkingCopyRoot(candidate)) workingCopies.push(candidate);
  }
  for (const name of GROUPED_WORKING_COPIES) {
    const group = path.join(root, name);
    if (isWorkingCopyRoot(group)) {
      workingCopies.push(group);
      continue;
    }
    workingCopies.push(...childDirectories(group).filter(isWorkingCopyRoot));
  }
  return [...new Set(workingCopies.map((candidate) => path.resolve(candidate)))];
}

function describeWorkspace(logicalRoot) {
  const root = path.resolve(logicalRoot);
  const workingCopies = discoverWorkingCopyRoots(root);
  const hasPages = fs.existsSync(path.join(root, 'pages'));
  return {
    root,
    kind: isWorkingCopyRoot(root) ? 'monolithic' : 'composite',
    workingCopies,
    valid: hasPages && workingCopies.length > 0
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
    .filter((candidate) => target === candidate || target.startsWith(`${candidate}${path.sep}`))
    .sort((left, right) => right.length - left.length)[0] || null;
}

module.exports = {
  DIRECT_WORKING_COPIES,
  GROUPED_WORKING_COPIES,
  describeWorkspace,
  discoverWorkingCopyRoots,
  findLogicalWorkspaceRoot,
  isLogicalWorkspaceRoot,
  isWorkingCopyRoot,
  workingCopyForPath
};

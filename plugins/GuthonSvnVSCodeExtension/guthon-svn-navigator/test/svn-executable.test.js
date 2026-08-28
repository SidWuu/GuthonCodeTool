'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  expandConfiguredPath,
  resolveSvnExecutable,
  svnExecutableCandidates
} = require('../src/svn-executable');

test('uses an explicitly configured SVN executable before automatic discovery', () => {
  const configured = '/tools/subversion/bin/svn';
  assert.equal(resolveSvnExecutable({
    configuredPath: configured,
    platform: 'darwin',
    env: { PATH: '/usr/bin' },
    isExecutable: (candidate) => candidate === configured
  }), configured);
});

test('discovers Homebrew SVN on macOS when VS Code PATH does not contain it', () => {
  assert.equal(resolveSvnExecutable({
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    isExecutable: (candidate) => candidate === '/opt/homebrew/bin/svn'
  }), '/opt/homebrew/bin/svn');
});

test('discovers TortoiseSVN on Windows outside VS Code PATH', () => {
  const expected = 'C:\\Program Files\\TortoiseSVN\\bin\\svn.exe';
  assert.equal(resolveSvnExecutable({
    platform: 'win32',
    env: { PATH: 'C:\\Windows\\System32', ProgramFiles: 'C:\\Program Files' },
    homeDirectory: 'C:\\Users\\tester',
    isExecutable: (candidate) => candidate === expected
  }), expected);
});

test('expands home and environment variables in a configured executable path', () => {
  assert.equal(
    expandConfiguredPath('~/bin/svn', {}, '/Users/tester', 'darwin'),
    path.posix.join('/Users/tester', 'bin', 'svn')
  );
  assert.equal(
    expandConfiguredPath('%SVN_HOME%\\bin\\svn.exe', { SVN_HOME: 'C:\\svn' }, 'C:\\Users\\tester', 'win32'),
    'C:\\svn\\bin\\svn.exe'
  );
});

test('reports a clear error when no SVN executable can be found', () => {
  assert.throws(() => resolveSvnExecutable({
    platform: 'darwin',
    env: { PATH: '/empty' },
    isExecutable: () => false
  }), (error) => error.code === 'SVN_EXECUTABLE_NOT_FOUND' && /找不到 SVN 命令行/.test(error.message));
});

test('PATH candidates are checked before platform fallback paths', () => {
  const candidates = svnExecutableCandidates({
    platform: 'darwin',
    env: { PATH: '/custom/bin:/usr/bin' }
  });
  assert.equal(candidates[0], '/custom/bin/svn');
});

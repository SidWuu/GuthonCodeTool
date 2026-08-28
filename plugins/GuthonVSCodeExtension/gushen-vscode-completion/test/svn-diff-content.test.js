const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DIFF_SCHEME,
  SvnDiffContentProvider,
  showSvnDiff,
} = require('../src/svn/diff-content');

function fakeUri(value) {
  const uri = { ...value };
  uri.toString = () => `${uri.scheme}://${uri.authority}${uri.path}?${uri.query}`;
  return uri;
}

test('opens SVN BASE and working copy in the native VS Code diff editor', async () => {
  const calls = [];
  const vscode = {
    Uri: { from: fakeUri },
    commands: { executeCommand: async (...args) => calls.push(args) },
  };
  const provider = new SvnDiffContentProvider({ vscode });
  const result = {
    workspaceKey: 'products.demo',
    path: 'procedures/DS-1/demo/pkg/save.gss',
    baseContent: 'return true;\n',
    workingContent: 'return false;\n',
  };

  await showSvnDiff(vscode, provider, result);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'vscode.diff');
  assert.equal(calls[0][1].scheme, DIFF_SCHEME);
  assert.equal(calls[0][2].scheme, DIFF_SCHEME);
  assert.match(calls[0][3], /SVN BASE.*工作副本/);
  assert.equal(provider.provideTextDocumentContent(calls[0][1]), result.baseContent);
  assert.equal(provider.provideTextDocumentContent(calls[0][2]), result.workingContent);
  assert.notEqual(calls[0][1].toString(), calls[0][2].toString());
  provider.dispose();
});

test('prefers PAGE readable projections while retaining an explicit raw diff', async () => {
  const calls = [];
  const vscode = {
    Uri: { from: fakeUri },
    commands: { executeCommand: async (...args) => calls.push(args) },
  };
  const provider = new SvnDiffContentProvider({ vscode });
  const result = {
    workspaceKey: 'products.demo',
    path: 'systems/SYS-1/pages/PG-1.json',
    baseContent: '{"raw":1}',
    workingContent: '{"raw":2}',
    readableBaseContent: '# PAGE 可读源码\nold();\n',
    readableWorkingContent: '# PAGE 可读源码\nnew();\n',
  };

  await showSvnDiff(vscode, provider, result);
  await showSvnDiff(vscode, provider, result, { raw: true });

  assert.match(calls[0][3], /PAGE 可读源码/);
  assert.equal(provider.provideTextDocumentContent(calls[0][1]), result.readableBaseContent);
  assert.doesNotMatch(calls[1][3], /PAGE 可读源码/);
  assert.equal(provider.provideTextDocumentContent(calls[1][1]), result.baseContent);
  provider.dispose();
});

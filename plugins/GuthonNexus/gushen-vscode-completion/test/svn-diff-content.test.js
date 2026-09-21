const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DIFF_SCHEME,
  SvnDiffContentProvider,
  SvnQuickDiffProvider,
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

test('opens working copy and SVN HEAD for a remote change', async () => {
  const calls = [];
  const vscode = {
    Uri: { from: fakeUri },
    commands: { executeCommand: async (...args) => calls.push(args) },
  };
  const provider = new SvnDiffContentProvider({ vscode });
  const result = {
    workspaceKey: 'products.demo',
    path: 'procedures/DS-1/demo/pkg/save.gss',
    comparison: 'remote',
    localContent: 'return "local";\n',
    remoteContent: 'return "remote";\n',
  };

  await showSvnDiff(vscode, provider, result);

  assert.match(calls[0][3], /工作副本.*SVN HEAD/);
  assert.equal(provider.provideTextDocumentContent(calls[0][1]), result.localContent);
  assert.equal(provider.provideTextDocumentContent(calls[0][2]), result.remoteContent);
  provider.dispose();
});

test('retains returned diff snapshots until VS Code closes their documents', () => {
  let onDidCloseTextDocument;
  const vscode = {
    Uri: { from: fakeUri },
    workspace: {
      onDidCloseTextDocument: (listener) => {
        onDidCloseTextDocument = listener;
        return { dispose() {} };
      },
    },
  };
  const provider = new SvnDiffContentProvider({ vscode });
  const first = provider.documents({
    workspaceKey: 'products.demo',
    path: 'procedures/first.gss',
    baseContent: 'first base\n',
    workingContent: 'first working\n',
  });

  for (let index = 0; index < 45; index += 1) {
    provider.documents({
      workspaceKey: 'products.demo',
      path: `procedures/other-${index}.gss`,
      baseContent: `base ${index}\n`,
      workingContent: `working ${index}\n`,
    });
  }

  assert.equal(provider.provideTextDocumentContent(first.base), 'first base\n');
  assert.equal(provider.provideTextDocumentContent(first.working), 'first working\n');

  onDidCloseTextDocument({ uri: first.base });
  assert.equal(provider.provideTextDocumentContent(first.base), '');
  assert.equal(provider.provideTextDocumentContent(first.working), 'first working\n');
  provider.dispose();
});

test('reuses an unchanged snapshot URI for repeated Quick Diff requests', () => {
  const vscode = { Uri: { from: fakeUri } };
  const provider = new SvnDiffContentProvider({ vscode });
  const first = provider.storeOriginal('products.demo', 'procedures/save.gss', 'base\n');
  const second = provider.storeOriginal('products.demo', 'procedures/save.gss', 'base\n');

  assert.equal(first.toString(), second.toString());
  assert.equal(provider.provideTextDocumentContent(first), 'base\n');
  provider.dispose();
});

test('provides SVN BASE to VS Code Quick Diff for virtual documents', async () => {
  const vscode = { Uri: { from: fakeUri } };
  const contentProvider = new SvnDiffContentProvider({ vscode });
  const calls = [];
  const backend = {
    async read(workspaceKey, identity) {
      calls.push([workspaceKey, identity]);
      return {
        sourcePath: 'procedures/DS-1/demo/pkg/save.gss',
        baseContent: 'return true;\n',
      };
    },
  };
  const quickDiff = new SvnQuickDiffProvider({ vscode, backend, contentProvider });
  quickDiff.setWorkspace({ workspaceKey: 'products.demo', checkoutPath: '/checkout/demo' });
  const uri = fakeUri({
    scheme: 'guthon-svn-edit',
    authority: 'products.demo',
    path: '/save.gss',
    query: 'sourceType=procedure&sourceId=demo.pkg%23save&funId=save',
  });

  const original = await quickDiff.provideOriginalResource(uri, { isCancellationRequested: false });

  assert.equal(original.scheme, DIFF_SCHEME);
  assert.equal(contentProvider.provideTextDocumentContent(original), 'return true;\n');
  assert.deepEqual(calls, [[
    'products.demo',
    { workspaceKey: 'products.demo', sourceType: 'procedure', sourceId: 'demo.pkg#save', funId: 'save', jsonPointer: '' },
  ]]);
  quickDiff.dispose();
  contentProvider.dispose();
});

test('provides SVN BASE to VS Code Quick Diff for checkout files', async () => {
  const vscode = {
    Uri: {
      from: fakeUri,
      file: (value) => fakeUri({ scheme: 'file', authority: '', path: value, fsPath: value, query: '' }),
    },
  };
  const contentProvider = new SvnDiffContentProvider({ vscode });
  const calls = [];
  const quickDiff = new SvnQuickDiffProvider({
    vscode,
    backend: {
      async diff(workspaceKey, sourcePath) {
        calls.push([workspaceKey, sourcePath]);
        return { baseContent: 'before\n' };
      },
    },
    contentProvider,
  });
  quickDiff.setWorkspace({ workspaceKey: 'products.demo', checkoutPath: '/checkout/demo' });

  const original = await quickDiff.provideOriginalResource(
    fakeUri({
      scheme: 'file',
      authority: '',
      path: '/checkout/demo/procedures/save.gss',
      fsPath: '/checkout/demo/procedures/save.gss',
      query: '',
    }),
    { isCancellationRequested: false }
  );

  assert.equal(contentProvider.provideTextDocumentContent(original), 'before\n');
  assert.deepEqual(calls, [['products.demo', 'procedures/save.gss']]);
  quickDiff.dispose();
  contentProvider.dispose();
});

test('reverts one native Quick Diff block while preserving the rest of the file', async () => {
  class Range {
    constructor(startLine, startCharacter, endLine, endCharacter) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    }
  }
  class WorkspaceEdit {
    replace(uri, range, text) {
      this.uri = uri;
      this.range = range;
      this.text = text;
    }
  }
  function document(uri, text) {
    const lines = text.split(/\r?\n/);
    const offsets = [];
    let offset = 0;
    for (const line of lines) {
      offsets.push(offset);
      offset += line.length + 1;
    }
    return {
      uri,
      lineCount: lines.length,
      lineAt: (line) => ({
        range: { end: { character: lines[line].length } },
      }),
      getText: (range) => {
        const start = offsets[range.start.line] + range.start.character;
        const end = range.end.line >= lines.length
          ? text.length
          : offsets[range.end.line] + range.end.character;
        return text.slice(start, end);
      },
      async save() { return true; },
    };
  }
  const resourceUri = {
    scheme: 'guthon-svn-edit',
    toString: () => 'guthon-svn-edit://products.demo/save.gss',
  };
  const originalUri = {
    scheme: DIFF_SCHEME,
    toString: () => 'guthon-svn-diff://products.demo/base/save.gss',
  };
  const original = document(originalUri, 'one\ntwo\nthree\n');
  const modified = document(resourceUri, 'one\nTWO\nthree\n');
  const editor = { document: modified, visibleRanges: [] };
  let appliedEdit;
  const vscode = {
    Range,
    WorkspaceEdit,
    Selection: class Selection {},
    window: {
      activeTextEditor: editor,
      visibleTextEditors: [editor],
      showWarningMessage() {},
    },
    workspace: {
      openTextDocument: async () => original,
      applyEdit: async (edit) => {
        appliedEdit = edit;
        return true;
      },
    },
  };

  assert.equal(await require('../src/svn/diff-content').revertQuickDiffChange({
    vscode,
    provider: { provideOriginalResource: async () => originalUri },
    resourceUri,
    changes: [{
      originalStartLineNumber: 2,
      originalEndLineNumber: 2,
      modifiedStartLineNumber: 2,
      modifiedEndLineNumber: 2,
    }],
    changeIndex: 0,
  }), true);
  assert.equal(appliedEdit.text, 'one\ntwo\nthree\n');
});

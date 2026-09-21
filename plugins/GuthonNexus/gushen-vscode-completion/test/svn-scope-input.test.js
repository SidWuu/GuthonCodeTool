const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  SVN_SCOPE_INPUT_HEADER,
  createSvnScopeInputFile,
  hasSvnScopeInput,
  removeSvnScopeInputFile,
  waitForEditorTabClose,
} = require('../src/svn/scope-input');

test('creates a saved multiline SVN input file and removes only its temporary directory', () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-scope-storage-'));
  const input = createSvnScopeInputFile(storage);

  assert.equal(fs.readFileSync(input.file, 'utf8'), SVN_SCOPE_INPUT_HEADER);
  assert.equal(path.dirname(input.directory), storage);
  removeSvnScopeInputFile(input);
  assert.equal(fs.existsSync(input.directory), false);
  assert.equal(fs.existsSync(storage), true);
  fs.rmSync(storage, { recursive: true });
});

test('does not treat blank or comment-only editor content as SVN input', () => {
  assert.equal(hasSvnScopeInput(''), false);
  assert.equal(hasSvnScopeInput(`${SVN_SCOPE_INPUT_HEADER}\n  # note\n`), false);
  assert.equal(hasSvnScopeInput(`${SVN_SCOPE_INPUT_HEADER}https://example.invalid/repo/skill\n`), true);
});

test('waits for the matching SVN input editor tab to close', async () => {
  let listener;
  let disposed = false;
  const vscode = {
    window: {
      tabGroups: {
        onDidChangeTabs(callback) {
          listener = callback;
          return { dispose: () => { disposed = true; } };
        },
      },
    },
  };
  const uri = (value) => ({ toString: () => value });
  let completed = false;
  const waiting = waitForEditorTabClose(vscode, { uri: uri('file:///scope.sh') }).then(() => {
    completed = true;
  });

  listener({ closed: [{ input: { uri: uri('file:///other.sh') } }] });
  await Promise.resolve();
  assert.equal(completed, false);
  listener({ closed: [{ input: { uri: uri('file:///scope.sh') } }] });
  await waiting;
  assert.equal(completed, true);
  assert.equal(disposed, true);
});

test('falls back to document disposal when tab events are unavailable', async () => {
  let listener;
  const vscode = {
    workspace: {
      onDidCloseTextDocument(callback) {
        listener = callback;
        return { dispose() {} };
      },
    },
  };
  const uri = (value) => ({ toString: () => value });
  const waiting = waitForEditorTabClose(vscode, { uri: uri('file:///scope.sh') });
  listener({ uri: uri('file:///scope.sh') });
  await waiting;
});

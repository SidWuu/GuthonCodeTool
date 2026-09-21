const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SVN_SCOPE_INPUT_HEADER = '# 每行粘贴一个 SVN URL、<url> <localSubdir> 或 svn checkout 命令；也支持以 -、*、+ 开头的列表。\n';

function createSvnScopeInputFile(storagePath = '') {
  const basePath = storagePath || os.tmpdir();
  fs.mkdirSync(basePath, { recursive: true });
  const directory = fs.mkdtempSync(path.join(basePath, 'svn-scope-input-'));
  const file = path.join(directory, 'checkout-scope.sh');
  fs.writeFileSync(file, SVN_SCOPE_INPUT_HEADER, 'utf8');
  return { directory, file };
}

function hasSvnScopeInput(text) {
  return String(text || '')
    .split(/\r?\n/)
    .some((line) => line.trim() && !line.trim().startsWith('#'));
}

function waitForEditorTabClose(vscode, document) {
  const expectedUri = document.uri.toString();
  return new Promise((resolve) => {
    const finish = () => {
      registration.dispose();
      resolve();
    };
    const tabEvent = vscode.window?.tabGroups?.onDidChangeTabs;
    const registration = tabEvent
      ? tabEvent((event) => {
        const matched = (event.closed || []).some((tab) => {
          const input = tab?.input || {};
          return [input.uri, input.modified, input.original]
            .filter(Boolean)
            .some((uri) => uri.toString() === expectedUri);
        });
        if (matched) finish();
      })
      : vscode.workspace.onDidCloseTextDocument((closedDocument) => {
        if (closedDocument.uri.toString() === expectedUri) finish();
      });
  });
}

function removeSvnScopeInputFile(input) {
  if (input?.directory) fs.rmSync(input.directory, { recursive: true, force: true });
}

module.exports = {
  SVN_SCOPE_INPUT_HEADER,
  createSvnScopeInputFile,
  hasSvnScopeInput,
  removeSvnScopeInputFile,
  waitForEditorTabClose,
};

const path = require('node:path');
const { SCHEME, decodeIdentity } = require('./virtual-fs');

const DIFF_SCHEME = 'guthon-svn-diff';

function safeDiffName(value) {
  return String(value || 'source').split('/').at(-1).replace(/[^A-Za-z0-9._-]+/g, '_') || 'source';
}

class SvnDiffContentProvider {
  constructor({ vscode }) {
    this.vscode = vscode;
    this.contents = new Map();
    this.snapshotKeys = new Map();
    this.snapshotUris = new Map();
    this.sequence = 0;
    this.closeRegistration = vscode.workspace?.onDidCloseTextDocument?.((document) => {
      this._remove(document?.uri);
    });
  }

  provideTextDocumentContent(uri) {
    return this.contents.get(uri.toString()) || '';
  }

  storeOriginal(workspaceKey, sourcePath, content) {
    return this._store(workspaceKey, sourcePath, 'original', content);
  }

  _remove(uri) {
    if (!uri) return;
    const uriKey = uri.toString();
    this.contents.delete(uriKey);
    const snapshotKey = this.snapshotKeys.get(uriKey);
    this.snapshotKeys.delete(uriKey);
    if (snapshotKey && this.snapshotUris.get(snapshotKey)?.toString() === uriKey) {
      this.snapshotUris.delete(snapshotKey);
    }
  }

  _store(workspaceKey, sourcePath, side, content, extension = '') {
    const text = String(content || '');
    const snapshotKey = [workspaceKey, sourcePath, side, extension, text].join('\0');
    const existingUri = this.snapshotUris.get(snapshotKey);
    if (existingUri && this.contents.has(existingUri.toString())) return existingUri;
    this.sequence += 1;
    const uri = this.vscode.Uri.from({
      scheme: DIFF_SCHEME,
      authority: workspaceKey,
      path: `/${side}/${safeDiffName(sourcePath)}${extension}`,
      query: new URLSearchParams({ path: sourcePath, version: String(this.sequence) }).toString(),
    });
    const uriKey = uri.toString();
    this.contents.set(uriKey, text);
    this.snapshotKeys.set(uriKey, snapshotKey);
    this.snapshotUris.set(snapshotKey, uri);
    return uri;
  }

  documents(result, { raw = false } = {}) {
    const remote = result.comparison === 'remote';
    const leftContent = remote ? result.localContent : result.baseContent;
    const rightContent = remote ? result.remoteContent : result.workingContent;
    const readableLeft = remote ? result.readableLocalContent : result.readableBaseContent;
    const readableRight = remote ? result.readableRemoteContent : result.readableWorkingContent;
    const readable = !raw && readableLeft && readableRight;
    return {
      base: this._store(
        result.workspaceKey,
        result.path,
        remote ? 'local' : 'base',
        readable ? readableLeft : leftContent,
        readable ? '.readable.md' : ''
      ),
      working: this._store(
        result.workspaceKey,
        result.path,
        remote ? 'remote' : 'working',
        readable ? readableRight : rightContent,
        readable ? '.readable.md' : ''
      ),
      readable: Boolean(readable),
      remote,
    };
  }

  dispose() {
    this.closeRegistration?.dispose?.();
    this.contents.clear();
    this.snapshotKeys.clear();
    this.snapshotUris.clear();
  }
}

function relativeSourcePath(rootPath, filePath) {
  if (!rootPath || !filePath) return '';
  const root = path.resolve(rootPath);
  const target = path.resolve(filePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return relative.split(path.sep).join('/');
}

class SvnQuickDiffProvider {
  constructor({ vscode, backend, contentProvider }) {
    this.vscode = vscode;
    this.backend = backend;
    this.contentProvider = contentProvider;
    this.workspaces = new Map();
    this.statuses = new Map();
    this.label = 'SVN 本地更改（工作副本）';
  }

  setWorkspace(workspace) {
    if (!workspace?.workspaceKey) return;
    this.workspaces.set(workspace.workspaceKey, workspace);
  }

  removeWorkspace(workspaceKey) {
    this.workspaces.delete(workspaceKey);
    this.statuses.delete(workspaceKey);
  }

  setStatus(workspaceKey, status) {
    if (workspaceKey) this.statuses.set(workspaceKey, status);
  }

  _sourceFor(uri) {
    if (!uri) return undefined;
    if (uri.scheme === SCHEME) {
      const identity = decodeIdentity(uri);
      if (!this.workspaces.has(identity.workspaceKey) || !identity.sourceType || !identity.sourceId) {
        return undefined;
      }
      return { workspaceKey: identity.workspaceKey, identity };
    }
    if (uri.scheme !== 'file') return undefined;
    for (const [workspaceKey, workspace] of this.workspaces) {
      const sourcePath = relativeSourcePath(workspace.checkoutPath, uri.fsPath);
      if (sourcePath) return { workspaceKey, sourcePath };
    }
    return undefined;
  }

  _isUntracked(workspaceKey, sourcePath) {
    return this.statuses.get(workspaceKey)?.changes?.some((change) => (
      change.path === sourcePath && change.state === 'UNTRACKED'
    )) || false;
  }

  async provideOriginalResource(uri, token) {
    if (token?.isCancellationRequested) return undefined;
    const source = this._sourceFor(uri);
    if (!source || (!source.identity && this._isUntracked(source.workspaceKey, source.sourcePath))) {
      return undefined;
    }
    const result = source.identity
      ? await this.backend.read(source.workspaceKey, source.identity)
      : await this.backend.diff(source.workspaceKey, source.sourcePath);
    if (token?.isCancellationRequested) return undefined;
    const sourcePath = result.sourcePath || source.sourcePath || source.identity.sourceId;
    return this.contentProvider.storeOriginal(
      source.workspaceKey,
      sourcePath,
      result.baseContent || ''
    );
  }

  dispose() {
    this.workspaces.clear();
    this.statuses.clear();
  }
}

function isUri(value) {
  return Boolean(value && typeof value.scheme === 'string' && typeof value.toString === 'function');
}

function documentWithLineChanges(
  vscode,
  originalDocument,
  modifiedDocument,
  changes,
  omittedIndex = -1
) {
  const parts = [];
  let originalLine = 0;
  for (const [changeIndex, change] of changes.entries()) {
    const originalEndLineNumber = Number(change.originalEndLineNumber || 0);
    const modifiedEndLineNumber = Number(change.modifiedEndLineNumber || 0);
    const originalStartLineNumber = Number(change.originalStartLineNumber || 0);
    const modifiedStartLineNumber = Number(change.modifiedStartLineNumber || 0);
    const originalIsEmpty = originalEndLineNumber === 0;
    const modifiedIsEmpty = modifiedEndLineNumber === 0;
    const originalChangeStartLine = originalIsEmpty
      ? originalStartLineNumber
      : originalStartLineNumber - 1;
    let originalStartLine = originalChangeStartLine;
    let originalStartColumn = 0;
    if (modifiedIsEmpty && originalEndLineNumber === originalDocument.lineCount) {
      originalStartLine -= 1;
      originalStartColumn = originalDocument.lineAt(originalStartLine).range.end.character;
    }
    parts.push(originalDocument.getText(new vscode.Range(
      originalLine,
      0,
      originalStartLine,
      originalStartColumn
    )));
    if (changeIndex === omittedIndex) {
      if (!originalIsEmpty) {
        parts.push(originalDocument.getText(new vscode.Range(
          originalChangeStartLine,
          0,
          originalEndLineNumber,
          0
        )));
      }
    } else if (!modifiedIsEmpty) {
      let modifiedStartLine = modifiedStartLineNumber - 1;
      let modifiedStartColumn = 0;
      if (originalIsEmpty && originalStartLineNumber === originalDocument.lineCount) {
        modifiedStartLine -= 1;
        modifiedStartColumn = modifiedDocument.lineAt(modifiedStartLine).range.end.character;
      }
      parts.push(modifiedDocument.getText(new vscode.Range(
        modifiedStartLine,
        modifiedStartColumn,
        modifiedEndLineNumber,
        0
      )));
    }
    originalLine = originalIsEmpty ? originalStartLineNumber : originalEndLineNumber;
  }
  parts.push(originalDocument.getText(new vscode.Range(
    originalLine,
    0,
    originalDocument.lineCount,
    0
  )));
  return parts.join('');
}

async function revertQuickDiffChange({ vscode, provider, resourceUri, changes, changeIndex }) {
  if (!isUri(resourceUri)
    || !Array.isArray(changes)
    || !Number.isInteger(changeIndex)
    || !changes[changeIndex]) {
    void vscode.window.showWarningMessage('未取得当前 SVN 差异块，请重新点击左侧变更标记后再试。');
    return false;
  }
  const editors = [
    vscode.window.activeTextEditor,
    ...(vscode.window.visibleTextEditors || []),
  ].filter((editor, index, all) => (
    editor && all.indexOf(editor) === index
  ));
  const editor = editors.find((candidate) => (
    candidate.document.uri.toString() === resourceUri.toString()
  ));
  if (!editor) {
    void vscode.window.showWarningMessage('当前修改文件未在编辑器中打开，无法撤销这一处变更。');
    return false;
  }
  const originalUri = await provider.provideOriginalResource(resourceUri, {
    isCancellationRequested: false,
  });
  if (!originalUri) {
    void vscode.window.showWarningMessage('当前文件没有可用的 SVN BASE，无法撤销这一处变更。');
    return false;
  }
  const originalDocument = await vscode.workspace.openTextDocument(originalUri);
  const updatedText = documentWithLineChanges(
    vscode,
    originalDocument,
    editor.document,
    changes,
    changeIndex
  );
  const lastLine = Math.max(0, editor.document.lineCount - 1);
  const endCharacter = editor.document.lineAt(lastLine).range.end.character;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    resourceUri,
    new vscode.Range(0, 0, lastLine, endCharacter),
    updatedText
  );
  if (!await vscode.workspace.applyEdit(edit)) {
    throw new Error('VS Code 未能应用当前差异块的撤销编辑');
  }
  if (!await editor.document.save()) throw new Error('撤销后保存文件失败');
  const targetLine = Math.max(0, Math.min(
    editor.document.lineCount - 1,
    Number(changes[changeIndex].modifiedStartLineNumber || 1) - 1
  ));
  if (vscode.Selection) editor.selection = new vscode.Selection(targetLine, 0, targetLine, 0);
  const visibleRange = editor.visibleRanges?.[0];
  if (visibleRange) editor.revealRange?.(visibleRange);
  return true;
}

async function showSvnDiff(vscode, provider, result, options = {}) {
  const documents = provider.documents(result, options);
  const filename = safeDiffName(result.path);
  return vscode.commands.executeCommand(
    'vscode.diff',
    documents.base,
    documents.working,
    `${filename} · ${documents.readable ? 'PAGE 可读源码 · ' : ''}${
      documents.remote ? '工作副本 ↔ SVN HEAD' : 'SVN BASE ↔ 工作副本'
    }`,
    { preview: true }
  );
}

module.exports = {
  DIFF_SCHEME,
  SvnDiffContentProvider,
  SvnQuickDiffProvider,
  relativeSourcePath,
  documentWithLineChanges,
  revertQuickDiffChange,
  safeDiffName,
  showSvnDiff,
};

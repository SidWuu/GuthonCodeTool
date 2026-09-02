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
  safeDiffName,
  showSvnDiff,
};

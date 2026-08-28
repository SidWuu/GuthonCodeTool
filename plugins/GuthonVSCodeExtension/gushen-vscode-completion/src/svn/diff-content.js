const DIFF_SCHEME = 'guthon-svn-diff';

function safeDiffName(value) {
  return String(value || 'source').split('/').at(-1).replace(/[^A-Za-z0-9._-]+/g, '_') || 'source';
}

class SvnDiffContentProvider {
  constructor({ vscode, maxEntries = 40 }) {
    this.vscode = vscode;
    this.maxEntries = maxEntries;
    this.contents = new Map();
    this.sequence = 0;
  }

  provideTextDocumentContent(uri) {
    return this.contents.get(uri.toString()) || '';
  }

  _store(workspaceKey, sourcePath, side, content, extension = '') {
    this.sequence += 1;
    const uri = this.vscode.Uri.from({
      scheme: DIFF_SCHEME,
      authority: workspaceKey,
      path: `/${side}/${safeDiffName(sourcePath)}${extension}`,
      query: new URLSearchParams({ path: sourcePath, version: String(this.sequence) }).toString(),
    });
    this.contents.set(uri.toString(), String(content || ''));
    while (this.contents.size > this.maxEntries) {
      this.contents.delete(this.contents.keys().next().value);
    }
    return uri;
  }

  documents(result, { raw = false } = {}) {
    const readable = !raw && result.readableBaseContent && result.readableWorkingContent;
    return {
      base: this._store(
        result.workspaceKey,
        result.path,
        'base',
        readable ? result.readableBaseContent : result.baseContent,
        readable ? '.readable.md' : ''
      ),
      working: this._store(
        result.workspaceKey,
        result.path,
        'working',
        readable ? result.readableWorkingContent : result.workingContent,
        readable ? '.readable.md' : ''
      ),
      readable: Boolean(readable),
    };
  }

  dispose() {
    this.contents.clear();
  }
}

async function showSvnDiff(vscode, provider, result, options = {}) {
  const documents = provider.documents(result, options);
  const filename = safeDiffName(result.path);
  return vscode.commands.executeCommand(
    'vscode.diff',
    documents.base,
    documents.working,
    `${filename} · ${documents.readable ? 'PAGE 可读源码 · ' : ''}SVN BASE ↔ 工作副本`,
    { preview: true }
  );
}

module.exports = { DIFF_SCHEME, SvnDiffContentProvider, safeDiffName, showSvnDiff };

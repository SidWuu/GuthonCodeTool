const { randomUUID } = require('node:crypto');

class ReadonlyDiffEditor {
  constructor(vscode, scheme) {
    this.vscode = vscode;
    this.scheme = scheme;
    this.documents = new Map();
    this.registration = vscode.workspace?.registerTextDocumentContentProvider?.(scheme, this);
    this.closeListener = vscode.workspace?.onDidCloseTextDocument?.(document => {
      if (document.uri.scheme === scheme) this.documents.delete(document.uri.path);
    });
  }

  provideTextDocumentContent(uri) {
    const content = this.documents.get(uri.path);
    if (content === undefined) throw new Error('差异快照已关闭，请重新比较');
    return content;
  }

  async show(before, after, { beforeName, afterName, title, editorOptions }) {
    if (!this.registration) throw new Error('只读差异文档不可用');
    const id = randomUUID();
    const left = this.vscode.Uri.from({ scheme: this.scheme, path: `/${id}/${beforeName}` });
    const right = this.vscode.Uri.from({ scheme: this.scheme, path: `/${id}/${afterName}` });
    this.documents.set(left.path, before);
    this.documents.set(right.path, after);
    try {
      await this.vscode.commands.executeCommand('vscode.diff', left, right, title, editorOptions);
    } catch (error) {
      this.documents.delete(left.path);
      this.documents.delete(right.path);
      throw error;
    }
  }

  dispose() {
    this.closeListener?.dispose();
    this.registration?.dispose();
    this.documents.clear();
  }
}

module.exports = { ReadonlyDiffEditor };

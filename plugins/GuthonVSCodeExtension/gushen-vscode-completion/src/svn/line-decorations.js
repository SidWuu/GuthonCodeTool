const path = require('node:path');

const TYPES = ['added', 'modified', 'deleted'];

function decorationOptions(vscode, document, changes) {
  const grouped = Object.fromEntries(TYPES.map((type) => [type, []]));
  const lastLine = Math.max(0, document.lineCount - 1);
  for (const change of changes || []) {
    if (!grouped[change.type]) continue;
    const startLine = Math.max(0, Math.min(Number(change.startLine) || 0, lastLine));
    const endLine = Math.max(startLine, Math.min(Number(change.endLine) || startLine, lastLine));
    const endCharacter = document.lineAt(endLine).text.length;
    grouped[change.type].push({
      range: new vscode.Range(startLine, 0, endLine, endCharacter),
      hoverMessage: change.type === 'deleted'
        ? `SVN BASE 中有 ${change.deletedLines || 1} 行在此处被删除`
        : change.type === 'added'
          ? '相对 SVN BASE 新增的行'
          : '相对 SVN BASE 修改的行',
    });
  }
  return grouped;
}

class SvnLineDecorationManager {
  constructor({ vscode }) {
    this.vscode = vscode;
    this.changes = new Map();
    const gutterIcon = (name) => vscode.Uri.file(
      path.join(__dirname, '..', '..', 'resources', `svn-line-${name}.svg`)
    );
    this.decorations = {
      added: vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
        overviewRulerColor: new vscode.ThemeColor('editorGutter.addedBackground'),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        gutterIconPath: gutterIcon('added'),
        gutterIconSize: 'contain',
      }),
      modified: vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
        overviewRulerColor: new vscode.ThemeColor('editorGutter.modifiedBackground'),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        gutterIconPath: gutterIcon('modified'),
        gutterIconSize: 'contain',
      }),
      deleted: vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
        overviewRulerColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        gutterIconPath: gutterIcon('deleted'),
        gutterIconSize: 'contain',
      }),
    };
    this.listeners = [
      vscode.window.onDidChangeVisibleTextEditors?.((editors) => {
        for (const editor of editors) this.apply(editor);
      }),
    ].filter(Boolean);
  }

  update(uri, changes) {
    this.changes.set(uri.toString(), changes || []);
    for (const editor of this.vscode.window.visibleTextEditors || []) {
      if (editor.document.uri.toString() === uri.toString()) this.apply(editor);
    }
  }

  clearWorkspace(workspaceKey, preserveUri) {
    const preserveKey = preserveUri?.toString();
    for (const key of this.changes.keys()) {
      const uri = this.vscode.Uri.parse(key);
      if (uri.authority === workspaceKey && key !== preserveKey) this.changes.delete(key);
    }
    for (const editor of this.vscode.window.visibleTextEditors || []) this.apply(editor);
  }

  apply(editor) {
    if (editor.document.uri.scheme !== 'guthon-svn-edit') return;
    const grouped = decorationOptions(
      this.vscode,
      editor.document,
      this.changes.get(editor.document.uri.toString()) || []
    );
    for (const type of TYPES) editor.setDecorations(this.decorations[type], grouped[type]);
  }

  dispose() {
    for (const listener of this.listeners) listener.dispose();
    for (const decoration of Object.values(this.decorations)) decoration.dispose();
    this.changes.clear();
  }
}

module.exports = { decorationOptions, SvnLineDecorationManager };

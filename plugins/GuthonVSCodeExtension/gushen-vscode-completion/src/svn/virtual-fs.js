const SCHEME = 'guthon-svn-edit';

function documentExtension(identity) {
  const pointer = identity.jsonPointer || '';
  if (identity.fragmentType === 'sql' || pointer.toLowerCase().endsWith('sql')) return 'sql';
  if (identity.fragmentType === 'fields' || pointer.endsWith('/fields')) return 'json';
  if (identity.fragmentType === 'gss' || identity.fragmentType === 'vm') return 'gss';
  if (identity.fragmentType === 'js') return 'js';
  if (identity.sourceType === 'procedure' || identity.sourceType === 'system-script') return 'gss';
  if (identity.sourceType === 'table' || identity.sourceType === 'view') return 'json';
  if (identity.sourceType === 'skill' || identity.sourceType === 'public') return 'txt';
  return 'js';
}

function safeName(value) {
  return String(value || 'source').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '') || 'source';
}

function encodeIdentity(identity) {
  const params = new URLSearchParams();
  params.set('sourceType', identity.sourceType);
  params.set('sourceId', identity.sourceId);
  if (identity.funId) params.set('funId', identity.funId);
  if (identity.jsonPointer) params.set('jsonPointer', identity.jsonPointer);
  return params.toString();
}

function decodeIdentity(uri) {
  const params = new URLSearchParams(uri.query || '');
  return {
    workspaceKey: uri.authority,
    sourceType: params.get('sourceType') || '',
    sourceId: params.get('sourceId') || '',
    funId: params.get('funId') || '',
    jsonPointer: params.get('jsonPointer') || '',
  };
}

class SvnVirtualFileSystem {
  constructor({ vscode, backend, onSaved, onWillSave }) {
    this.vscode = vscode;
    this.backend = backend;
    this.onSaved = onSaved;
    this.onWillSave = onWillSave;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeFile = this.changed.event;
    this.cache = new Map();
  }

  uriFor(identity) {
    const name = safeName(identity.funId || identity.sourceId);
    return this.vscode.Uri.from({
      scheme: SCHEME,
      authority: identity.workspaceKey,
      path: `/${name}.${documentExtension(identity)}`,
      query: encodeIdentity(identity),
    });
  }

  async _load(uri, force = false) {
    const key = uri.toString();
    if (!force && this.cache.has(key)) return this.cache.get(key);
    const identity = decodeIdentity(uri);
    if (!identity.workspaceKey || !identity.sourceType || !identity.sourceId) {
      throw this.vscode.FileSystemError.FileNotFound(uri);
    }
    const value = await this.backend.read(identity.workspaceKey, identity);
    const record = { identity, value, updatedAt: Date.now() };
    this.cache.set(key, record);
    return record;
  }

  async open(identity) {
    const uri = this.uriFor(identity);
    const record = await this._load(uri, true);
    const document = await this.vscode.workspace.openTextDocument(uri);
    await this.vscode.window.showTextDocument(document, { preview: false });
    if (!record.value.editable) {
      const reason = record.value.externalModified
        ? '原文件存在 Nexus 会话外修改，已以只读方式打开'
        : '当前对象在 SVN 模式下只读';
      this.vscode.window.showWarningMessage(reason);
    }
    return uri;
  }

  async stat(uri) {
    const record = await this._load(uri);
    return {
      type: this.vscode.FileType.File,
      ctime: 0,
      mtime: record.updatedAt,
      size: Buffer.byteLength(record.value.content, 'utf8'),
    };
  }

  async readFile(uri) {
    const record = await this._load(uri);
    return Buffer.from(record.value.content, 'utf8');
  }

  async writeFile(uri, content, options) {
    const key = uri.toString();
    const record = await this._load(uri);
    if (!record.value.editable || !record.value.sessionId || !record.value.documentId) {
      throw this.vscode.FileSystemError.NoPermissions('当前 SVN 虚拟文档只读');
    }
    const text = Buffer.from(content).toString('utf8');
    this.onWillSave?.(record.identity.workspaceKey, record.value.sourcePath);
    const result = await this.backend.write(
      record.identity.workspaceKey,
      record.value.sessionId,
      record.value.documentId,
      text
    );
    record.value.content = text;
    this.cache.set(key, record);
    // This write originated from the open VS Code document.  Advancing mtime
    // or firing an external-change event here makes the next save look stale.
    // Checkout changes made outside this provider still flow through
    // invalidate(..., true), which reloads the record and emits Changed.
    await this.onSaved?.(record.identity.workspaceKey, result, uri);
  }

  watch() {
    return new this.vscode.Disposable(() => {});
  }

  readDirectory() { throw this.vscode.FileSystemError.FileNotADirectory(); }
  createDirectory() { throw this.vscode.FileSystemError.NoPermissions(); }
  delete() { throw this.vscode.FileSystemError.NoPermissions(); }
  rename() { throw this.vscode.FileSystemError.NoPermissions(); }

  invalidate(workspaceKey, notify = false, preserveUri) {
    const preserveKey = preserveUri?.toString();
    const changedUris = [];
    for (const [key, record] of this.cache.entries()) {
      if (record.identity.workspaceKey !== workspaceKey) continue;
      if (key === preserveKey) continue;
      if (notify) changedUris.push(this.vscode.Uri.parse(key));
      this.cache.delete(key);
    }
    if (changedUris.length) {
      this.changed.fire(changedUris.map((uri) => ({
        type: this.vscode.FileChangeType.Changed,
        uri,
      })));
    }
  }

  dispose() {
    this.cache.clear();
    this.changed.dispose();
  }
}

module.exports = {
  SCHEME,
  SvnVirtualFileSystem,
  decodeIdentity,
  documentExtension,
  encodeIdentity,
};

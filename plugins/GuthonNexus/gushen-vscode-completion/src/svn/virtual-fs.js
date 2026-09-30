const SCHEME = 'guthon-svn-edit';
const GENERIC_SOURCE_EXTENSIONS = new Set(['json', 'md', 'txt', 'yaml', 'yml', 'gss', 'js', 'vm', 'sql']);

function utf16Offset(value, codePointOffset) {
  return Array.from(value).slice(0, codePointOffset).join('').length;
}

function sourceIdExtension(identity) {
  const match = String(identity.sourceId || '').match(/\.([A-Za-z0-9]+)$/);
  const extension = match?.[1]?.toLowerCase() || '';
  return GENERIC_SOURCE_EXTENSIONS.has(extension) ? extension : '';
}

function documentExtension(identity) {
  const pointer = identity.jsonPointer || '';
  if (identity.fragmentType === 'sql' || pointer.toLowerCase().endsWith('sql')) return 'sql';
  if (identity.fragmentType === 'fields' || pointer.endsWith('/fields')) return 'json';
  if (identity.fragmentType === 'gss' || identity.fragmentType === 'vm') return 'gss';
  if (identity.fragmentType === 'js') return 'js';
  const sourcePathExtension = String(identity.sourcePath || '').match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
  if (sourcePathExtension === 'gss' || sourcePathExtension === 'vm') return 'gss';
  if (sourcePathExtension === 'js' || sourcePathExtension === 'sql') return sourcePathExtension;
  if (identity.sourceType === 'procedure') return 'gss';
  if (identity.sourceType === 'table' || identity.sourceType === 'view') return 'json';
  if (identity.sourceType === 'skill' || identity.sourceType === 'public') {
    return sourceIdExtension(identity) || 'txt';
  }
  return 'js';
}

function safeName(value) {
  return String(value || 'source')
    // Keep Chinese and other readable Unicode characters in the virtual path;
    // only remove characters that cannot safely be used in a file name.
    .replace(/[<>:"/\\|?*\u0000-\u001F\u007F]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    || 'source';
}

function documentFilename(identity) {
  const name = safeName(
    identity.documentName
      || identity.funId
      || identity.sourceId
  );
  const extension = documentExtension(identity);
  return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

function encodeIdentity(identity) {
  const params = new URLSearchParams();
  params.set('sourceType', identity.sourceType);
  params.set('sourceId', identity.sourceId);
  if (identity.funId) params.set('funId', identity.funId);
  if (identity.workingCopyId) params.set('workingCopyId', identity.workingCopyId);
  if (identity.jsonPointer) params.set('jsonPointer', identity.jsonPointer);
  return params.toString();
}

function decodeIdentity(uri) {
  const params = new URLSearchParams(uri.query || '');
  const identity = {
    workspaceKey: uri.authority,
    sourceType: params.get('sourceType') || '',
    sourceId: params.get('sourceId') || '',
    funId: params.get('funId') || '',
    jsonPointer: params.get('jsonPointer') || '',
  };
  const workingCopyId = params.get('workingCopyId') || '';
  if (workingCopyId) identity.workingCopyId = workingCopyId;
  return identity;
}

class SvnVirtualFileSystem {
  constructor({ vscode, backend, onLoaded, onSaved, onWillSave, onInvalidated, onOutput }) {
    this.vscode = vscode;
    this.backend = backend;
    this.onSaved = onSaved;
    this.onWillSave = onWillSave;
    this.onLoaded = onLoaded;
    this.onInvalidated = onInvalidated;
    this.onOutput = onOutput;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeFile = this.changed.event;
    this.cache = new Map();
  }

  uriFor(identity) {
    return this.vscode.Uri.from({
      scheme: SCHEME,
      authority: identity.workspaceKey,
      path: `/${documentFilename(identity)}`,
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
    let inheritance;
    if (value.editable && identity.workspaceKey.startsWith('projects.')
      && ['procedure', 'page'].includes(identity.sourceType)
      && (identity.sourceType === 'procedure' || identity.jsonPointer)
      && /@?inherit\s*\(/.test(value.content)
      && this.backend.pageQuery) {
      let offset = 0;
      let first;
      const chunks = { effective: [], projectOriginal: [], productOriginal: [] };
      for (;;) {
        const result = await this.backend.pageQuery(identity.workspaceKey, 'read_inherited_source', {
          sourceType: identity.sourceType,
          sourceNamespace: value.sourceNamespace || identity.sourceNamespace || '',
          sourceId: identity.sourceId,
          funId: identity.funId || '',
          ...(identity.sourceType === 'procedure'
            ? { workingCopyId: identity.workingCopyId || value.workingCopyId }
            : { jsonPointer: identity.jsonPointer }),
          offset, maxChars: 24_000,
        });
        first ||= result;
        if (result.project?.sourceHash !== first.project?.sourceHash
          || result.product?.sourceHash !== first.product?.sourceHash
          || result.indexGeneration !== first.indexGeneration) {
          throw new Error('继承源码读取期间发生变化，请重新打开项目源码');
        }
        for (const name of Object.keys(chunks)) chunks[name].push(result[name]?.content || '');
        if (result.complete) break;
        offset = result.nextOffset;
        if (!Number.isInteger(offset) || offset > 1_000_000) {
          throw new Error('继承源码超过编辑器展开上限，请使用分段读取接口');
        }
      }
      if (first.inheritanceStatus === 'ACTIVE') {
        const projectOriginal = chunks.projectOriginal.join('');
        if (projectOriginal !== value.content) {
          throw new Error('项目源码与继承索引不一致，请刷新索引后重开');
        }
        const product = first.segments.find((segment) => segment.layer === 'product');
        if (!product || !first.product?.sourceHash) {
          throw new Error('继承产品源码缺少精确来源，无法展开编辑');
        }
        const effective = chunks.effective.join('');
        const markerStart = utf16Offset(projectOriginal, first.segments[0].sourceEnd);
        const markerEnd = utf16Offset(projectOriginal,
          first.segments[first.segments.length - 1].sourceStart);
        const productStart = utf16Offset(effective, product.start);
        const productEnd = utf16Offset(effective, product.end);
        inheritance = {
          projectOriginal,
          productHash: first.product.sourceHash,
          productText: effective.slice(productStart, productEnd),
          start: productStart, end: productEnd,
          marker: projectOriginal.slice(markerStart, markerEnd),
          productTouched: false,
          materializable: !first.diagnostic,
          diagnostic: first.diagnostic || '',
        };
        value.content = effective;
      } else if (first.inheritanceStatus !== 'INACTIVE') {
        value.inheritanceDiagnostic = `继承状态 ${first.inheritanceStatus}：${first.diagnostic || '请核对两层源码和本地索引'}`;
      }
    }
    const record = { identity, value, inheritance, updatedAt: Date.now() };
    this.cache.set(key, record);
    this.onLoaded?.(uri, value);
    return record;
  }

  async open(identity, options = {}) {
    const uri = this.uriFor(identity);
    const alreadyDirty = this.vscode.workspace.textDocuments?.some((document) =>
      document.uri.toString() === uri.toString() && document.isDirty);
    const record = await this._load(uri, !alreadyDirty);
    const document = await this.vscode.workspace.openTextDocument(uri);
    const editor = await this.vscode.window.showTextDocument(document, { preview: false });
    const requestedLine = Number(options.lineNumber);
    if (Number.isFinite(requestedLine) && requestedLine > 0) {
      const line = Math.min(requestedLine - 1, Math.max(0, document.lineCount - 1));
      const position = new this.vscode.Position(line, 0);
      const range = new this.vscode.Range(position, position);
      editor.selection = new this.vscode.Selection(position, position);
      editor.revealRange(range, this.vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
    if (!record.value.editable) {
      const reason = record.value.externalModified
        ? '原文件存在 Nexus 会话外修改，已以只读方式打开'
        : '当前对象在 SVN 模式下只读';
      this.vscode.window.showWarningMessage(reason);
    } else if (record.value.inheritanceDiagnostic) {
      this.vscode.window.showWarningMessage(record.value.inheritanceDiagnostic);
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
    let record = await this._load(uri);
    // A virtual tab can outlive a refresh/reindex that changes a document from
    // read-only back to editable (for example after a clean SVN update or a
    // stale session is discarded).  Revalidate once before rejecting the save;
    // the backend still applies the complete authorization/status/hash checks.
    if (!record.value.editable || !record.value.sessionId || !record.value.documentId) {
      record = await this._load(uri, true);
    }
    if (!record.value.editable || !record.value.sessionId || !record.value.documentId) {
      throw this.vscode.FileSystemError.NoPermissions('当前 SVN 虚拟文档只读');
    }
    const text = Buffer.from(content).toString('utf8');
    const inherited = record.inheritance;
    let unchangedProduct = false;
    if (inherited) {
      const found = inherited.productText ? text.indexOf(inherited.productText) : -1;
      unchangedProduct = Boolean(inherited.productText)
        && !inherited.productTouched
        && text.slice(inherited.start, inherited.end) === inherited.productText;
      if (!unchangedProduct) {
        unchangedProduct = found >= 0 && text.indexOf(inherited.productText, found + 1) < 0;
      }
      if (unchangedProduct) {
        inherited.start = found;
        inherited.end = found + inherited.productText.length;
      } else if (!inherited.productText) {
        unchangedProduct = !inherited.productTouched;
      }
    }
    const productTouched = inherited && !unchangedProduct;
    const sourceText = inherited && !productTouched
      ? text.slice(0, inherited.start) + inherited.marker + text.slice(inherited.end)
      : text;
    if (productTouched && !inherited.materializable) {
      const choice = await this.vscode.window.showWarningMessage(
        '此处的 return inherit 无法自动证明与展开后的控制流等价。请审查完整源码后再保存到项目文件。',
        { modal: true }, '已核对控制流，继续保存'
      );
      if (choice !== '已核对控制流，继续保存') {
        throw this.vscode.FileSystemError.NoPermissions('需要先核对继承函数的控制流');
      }
    }
    this.onWillSave?.(record.identity.workspaceKey, record.value.sourcePath);
    const result = this.onOutput
      ? await this.backend.write(
        record.identity.workspaceKey,
        record.value.sessionId,
        record.value.documentId,
        sourceText,
        { onOutput: this.onOutput,
          ...(productTouched ? { expectedProductHash: inherited.productHash } : {}) }
      )
      : productTouched
        ? await this.backend.write(record.identity.workspaceKey, record.value.sessionId,
          record.value.documentId, sourceText, { expectedProductHash: inherited.productHash })
        : await this.backend.write(record.identity.workspaceKey, record.value.sessionId,
          record.value.documentId, sourceText);
    record.value.content = text;
    if (inherited) {
      if (productTouched) record.inheritance = undefined;
      else {
        inherited.projectOriginal = sourceText;
        if (record.identity.sourceType === 'page' && result.sourceHash) {
          inherited.productHash = result.sourceHash;
        }
      }
    }
    record.value.baseContent = result.baseContent ?? record.value.baseContent;
    record.value.lineChanges = result.lineChanges || [];
    this.cache.set(key, record);
    this.onLoaded?.(uri, record.value);
    // This write originated from the open VS Code document.  Advancing mtime
    // or firing an external-change event here makes the next save look stale.
    // Checkout changes made outside this provider still flow through
    // invalidate(..., true), which reloads the record and emits Changed.
    await this.onSaved?.(record.identity.workspaceKey, result, uri, Boolean(inherited));
  }

  watch() {
    return new this.vscode.Disposable(() => {});
  }

  trackDocumentChange(event) {
    const record = this.cache.get(event.document.uri.toString());
    const inherited = record?.inheritance;
    if (!inherited) return;
    for (const change of event.contentChanges || []) {
      const start = change.rangeOffset;
      const end = start + change.rangeLength;
      const delta = change.text.length - change.rangeLength;
      if (end <= inherited.start) {
        inherited.start += delta;
        inherited.end += delta;
      } else if (start >= inherited.end) {
        continue;
      } else {
        inherited.productTouched = true;
        inherited.start = Math.min(inherited.start, start);
        inherited.end = Math.max(inherited.end + delta, start + change.text.length);
      }
    }
  }

  async diffBaseContent(uri, physicalBase) {
    await this._load(uri);
    const inherited = this.cache.get(uri.toString())?.inheritance;
    const marker = inherited?.marker;
    if (!marker || typeof physicalBase !== 'string') return physicalBase;
    const position = physicalBase.indexOf(marker);
    if (position < 0 || physicalBase.indexOf(marker, position + 1) >= 0) return physicalBase;
    return physicalBase.slice(0, position) + inherited.productText
      + physicalBase.slice(position + marker.length);
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
    this.onInvalidated?.(workspaceKey, preserveUri);
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
  documentFilename,
  encodeIdentity,
  utf16Offset,
};

const crypto = require('node:crypto');
const { BoundedCache } = require('./bounded-cache');
const { utf16Offset } = require('./virtual-fs');
const SCHEME = 'guthon-svn-inherit';
const MAX_VIEW_CHARS = 1_000_000;

function fenced(content) {
  const runs = String(content).match(/`+/g) || [];
  const delimiter = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${delimiter}\n${content}\n${delimiter}`;
}

class SvnInheritanceView {
  constructor({ vscode, backend }) {
    this.vscode = vscode;
    this.backend = backend;
    this.changed = new vscode.EventEmitter();
    this.onDidChange = this.changed.event;
    const pinned=(key)=>this.vscode.workspace?.textDocuments?.some((document)=>document.uri.toString()===key);
    this.identities = new BoundedCache({maxEntries:128,isPinned:pinned});
    this.contents = new BoundedCache({maxEntries:64,maxBytes:32*1024*1024,ttlMs:60_000,sizeOf:Buffer.byteLength,isPinned:pinned});
    this.inFlight = new Map();this.generations=new BoundedCache({maxEntries:512,isPinned:(key)=>this.inFlight.has(key)});
    this.closeRegistration=vscode.workspace.onDidCloseTextDocument?.((document)=>{
      const key=document.uri.toString();this.identities.delete(key);this.contents.delete(key);
      this.generations.set(key,(this.generations.get(key)||0)+1);
    });
  }

  async open(identity) {
    const key = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const uri = this.vscode.Uri.from({
      scheme: SCHEME, authority: identity.workspaceKey,
      path: `/${key}/${encodeURIComponent(identity.funId || identity.sourceId)}.md`,
    });
    this.identities.set(uri.toString(), identity);
    if(!this.identities.has(uri.toString()))throw new Error('继承视图缓存已满，请关闭部分视图后重试');
    const document = await this.vscode.workspace.openTextDocument(uri);
    await this.vscode.window.showTextDocument(document, { preview: false });
    return uri;
  }

  async provideTextDocumentContent(uri) {
    const key=uri.toString();
    const cached=this.contents.get(key);if(cached!==undefined)return cached;
    if(this.inFlight.has(key))return this.inFlight.get(key);
    const generation=this.generations.get(key)||0;
    const pending=this._read(uri).then((text)=>{
      if((this.generations.get(key)||0)!==generation)throw new Error('继承视图读取期间已失效，请重新打开');
      this.contents.set(key,text);return text;
    }).finally(()=>{if(this.inFlight.get(key)===pending)this.inFlight.delete(key);});
    this.inFlight.set(key,pending);return pending;
  }

  async _read(uri) {
    const identity = this.identities.get(uri.toString());
    if (!identity) return '# 继承源码视图已失效\n\n请从谷神源码重新打开。\n';
    let offset = 0;
    let first;
    const chunks = { effective: [], projectOriginal: [], productOriginal: [] };
    try {
      for (;;) {
        const result = await this.backend.pageQuery(identity.workspaceKey, 'read_inherited_source', {
          sourceType: identity.sourceType,
          sourceNamespace: identity.sourceNamespace,
          sourceId: identity.sourceId,
          funId: identity.funId || '',
          ...(identity.sourceType === 'procedure'
            ? { workingCopyId: identity.workingCopyId }
            : { jsonPointer: identity.jsonPointer }),
          offset, maxChars: 24_000,
        });
        first ||= result;
        if (result.project?.sourceHash !== first.project?.sourceHash
          || result.product?.sourceHash !== first.product?.sourceHash
          || result.indexGeneration !== first.indexGeneration) {
          throw new Error('读取期间源码或索引发生变化，请重新打开展开视图');
        }
        for (const name of Object.keys(chunks)) chunks[name].push(result[name]?.content || '');
        if (result.complete) break;
        const nextOffset = result.nextOffset;
        if (!Number.isInteger(nextOffset) || nextOffset <= offset || nextOffset > MAX_VIEW_CHARS) {
          throw new Error('继承分页未前进或结果超过视图上限，请使用有界接口');
        }
        offset = nextOffset;
      }
      const projection = chunks.effective.join('');
      const sections = [];
      if (first.inheritanceStatus === 'ACTIVE') {
        for (const segment of first.segments || []) {
          const source = segment.layer === 'product' ? first.product : first.project;
          sections.push(`### ${segment.layer === 'product' ? '产品继承源码' : '项目源码'} · `
            + `${source?.sourcePath || '未知来源'}${source?.jsonPointer || ''} · 原文第 ${segment.sourceLine} 行 · 展开第 ${segment.effectiveLine} 行\n\n`
            + `${fenced(projection.slice(utf16Offset(projection, segment.start), utf16Offset(projection, segment.end)))}\n`);
        }
      } else {
        sections.push(first.inheritanceStatus === 'INACTIVE'
          ? '当前项目源码没有生效的继承调用，产品层未参与执行。'
          : '继承关系无法完整解析。请读取两层原文核对；禁止据此自动物化写入。');
        sections.push(`### 项目原文\n\n${fenced(chunks.projectOriginal.join(''))}`);
        if (first.productOriginal !== null) {
          sections.push(`### 产品原文（当前不保证生效）\n\n${fenced(chunks.productOriginal.join(''))}`);
        }
      }
      return `# 继承源码（只读派生视图）\n\n`
        + `- 状态：${first.inheritanceStatus}\n`
        + `- 项目：${first.project?.sourcePath || ''}${first.project?.jsonPointer || ''} · ${first.project?.sourceHash || ''}\n`
        + `- 产品：${first.product?.sourcePath || '未找到'}${first.product?.jsonPointer || ''} · ${first.product?.sourceHash || ''}\n`
        + `- 索引快照：${first.indexGeneration || ''}\n`
        + `- 可自动物化：${first.materializable ? '是（仍需审查候选）' : '否或需要完整分段读取'}\n`
        + (first.diagnostic ? `- 诊断：${first.diagnostic}\n` : '')
        + `\n${sections.join('\n')}\n`;
    } catch (error) {
      return `# 继承源码读取失败\n\n${String(error.message || error)}\n\n请刷新索引后重新打开。\n`;
    }
  }

  invalidate(workspaceKey) {
    for (const [value, identity] of this.identities) {
      if (identity.workspaceKey === workspaceKey) {
        this.generations.set(value,(this.generations.get(value)||0)+1);this.contents.delete(value);
        this.changed.fire(this.vscode.Uri.parse(value));
      }
    }
  }

  dispose() {
    this.closeRegistration?.dispose?.();
    for(const key of this.inFlight.keys())this.generations.set(key,(this.generations.get(key)||0)+1);
    this.changed.dispose();this.contents.clear();
    this.identities.clear();
  }
}

module.exports = { SCHEME, SvnInheritanceView };

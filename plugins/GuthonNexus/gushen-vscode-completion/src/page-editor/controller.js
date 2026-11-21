const crypto = require('node:crypto');
const path = require('node:path');
const {PageDraft} = require('./model');
const {buildOutline} = require('./outline');
const {draftChanges} = require('./comparison');
const {mergePageDraft} = require('./source-merge');
const {PageRecoveryStore} = require('./recovery-store');
const {SCHEME, decodeIdentity, fragmentIdentity, pageDisplayName, scriptType} = require('../source/virtual-fs');

const escape = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const pageKey = identity => JSON.stringify([identity.workspaceKey, identity.sourcePath || identity.path]);
const RAW_SOURCE_STATES = new Set(['METADATA_ONLY','IDENTITY_MISMATCH','BATCH_EXPORT']);

class PageEditorController {
  constructor({vscode, context, backend, virtualFs, openReadonly, openOnline, preparePage, requestPage,
    baselineLabel = 'API 基线', platformReference = true,
    recoveryStore = new PageRecoveryStore(context), maxClosedPages = 4, maxClosedBytes = 16 * 1024 * 1024,
    onSaved = async () => {}, ownsDocument = () => false, onDraftChanged = async () => {}, editorToken = async () => undefined, assertCanSave = () => {}}) {
    Object.assign(this, {vscode, context, backend, virtualFs, openReadonly, openOnline, preparePage, onSaved, ownsDocument, onDraftChanged, editorToken, assertCanSave});
    this.requestPage=requestPage || ((identity,payload)=>backend.run(identity.workspaceKey,'page',payload));
    this.baselineLabel=baselineLabel;
    this.platformReference=platformReference;
    Object.assign(this, {recoveryStore, maxClosedPages, maxClosedBytes});
    this.pages = new Map(); this.opening = new Map();
    this.comparisonRefreshes = new Map(); this.disposed = false;
    this.registrations = [vscode.workspace.onDidChangeTextDocument(event => this.documentChanged(event.document)),
      vscode.workspace.onDidSaveTextDocument?.(document=>this.documentChanged(document)),
      vscode.workspace.onDidCloseTextDocument?.(document=>this.documentChanged(document))].filter(Boolean);
  }
  async snapshot(identity, {prepare=false}={}) {
    const result = await this.requestPage(identity, {action:'open',
      path:identity.sourcePath || identity.path});
    if (result.sourcePath !== (identity.sourcePath || identity.path)) throw new Error('PAGE 来源与请求不一致');
    if (prepare && result.contentState === 'BATCH_EXPORT' && this.preparePage) {
      await this.preparePage(identity);
      return this.snapshot(identity);
    }
    if (RAW_SOURCE_STATES.has(result.contentState)) return result;
    const page = JSON.parse(result.sourceText);
    result.model.pageName = pageDisplayName(identity)
      || pageDisplayName({...result,pageName:result.model.pageName}) || pageDisplayName(page);
    result.model.outline = buildOutline(page,result.model);
    result.loadedAt = new Date().toISOString();
    return result;
  }
  async refreshComparison(session) {
    const snapshot=session.snapshot;
    if (session.comparisonRequest?.snapshot === snapshot) return session.comparisonRequest.promise;
    const request = {snapshot};
    session.comparisonRequest = request;
    request.promise = Promise.resolve().then(async () => {
      try {
        const result = await this.requestPage(session.identity, {action:'comparison',
          path:session.snapshot.sourcePath, sourceHash:snapshot.sourceHash});
        if (this.disposed || session.snapshot!==snapshot) return;
        if (result.sourceHash !== snapshot.sourceHash) throw new Error('比较基线与当前页面不一致，请重新载入');
        const {baseRevision, ...comparison}=result;
        session.baselineComparison = {...comparison,apiVersion:baseRevision};
      } catch (error) {
        if (this.disposed || session.snapshot!==snapshot) return;
        session.baselineComparison = {available:false,message:error.message};
      }
      this.publish(session);
    }).finally(() => { if (session.comparisonRequest === request) delete session.comparisonRequest; });
    return request.promise;
  }
  async sourceChanged(workspaceKey, paths) {
    for (const session of this.pages.values()) {
      if (session.identity.workspaceKey !== workspaceKey || !paths.includes(session.snapshot.sourcePath)) continue;
      await this.refreshSource(session);
    }
  }
  archiveDraft(session) {
    session.recovery = {sourceHash: session.snapshot.sourceHash, operations: session.draft.operations(),
      nativeRecovery: session.nativeRecovery, pending: session.pending, sourceMerge: session.sourceMerge?.evidence,
      previous: (session.recovery === session.savedRecovery ? session.recoveryReference : null) || session.recovery || null};
  }
  async refreshSource(session, origin = 'external', expectedMerge) {
    const baseline = session.snapshot, generation = (session.sourceReadGeneration || 0) + 1;
    let ownedSnapshot = baseline;
    session.sourceReadGeneration = generation;
    if (session.busy || session.pending || session.onlineOpening) { session.sourceStale = true; this.publish(session); return; }
    session.sourceReads = (session.sourceReads || 0) + 1;
    try {
      const fresh = await this.snapshot(session.identity);
      if (this.disposed || session.sourceReadGeneration !== generation || session.snapshot !== baseline
        || (expectedMerge && session.sourceMerge !== expectedMerge)) return;
      if (session.busy || session.pending || session.onlineOpening) { session.sourceStale = true; this.publish(session); return; }
      const sameIdentity = ['workspaceKey', 'sourcePath']
        .every(key => (baseline[key] || '') === (fresh[key] || ''));
      if (origin === 'external' && fresh.sourceHash === baseline.sourceHash && sameIdentity && fresh.editable === baseline.editable) {
        if (session.sourceMerge) this.archiveDraft(session);
        if (session.sourceMerge || session.sourceStale) session.draft.version++;
        session.sourceStale = false; session.sourceMerge = null;
        await this.persist(session); await this.refreshComparison(session); this.publish(session); return;
      }
      const previous = session.draft, oldMerge = session.sourceMerge;
      const choices = oldMerge?.draft === previous && oldMerge.evidence.sourceHash === fresh.sourceHash ? oldMerge.evidence.choices : {};
      const dirtyCode = this.vscode.workspace.textDocuments.some(doc => doc.isDirty && this.owns(session.identity, doc));
      const reason = session.blocked || (!fresh.editable && baseline.editable ? 'PAGE 现为只读，请保留草稿并重新载入原生页面'
        : dirtyCode ? '此 PAGE 的代码有未保存输入，请先保留代码和草稿再重新载入'
        : session.nativeRecovery ? '原版设计器仍有待核对候选，请先导出草稿并保留输入，再重新载入' : '');
      const result = reason ? {blockedReason: reason, conflicts: [], paths: []} : mergePageDraft(baseline, previous, fresh, choices);
      const evidence = {baseSourceHash: baseline.sourceHash, sourceHash: fresh.sourceHash,
        blockedReason: result.blockedReason, paths: result.paths, conflicts: result.conflicts, choices};
      if (oldMerge && (oldMerge.evidence.sourceHash !== fresh.sourceHash
        || (result.blockedReason && oldMerge.evidence.conflicts.length))) this.archiveDraft(session);
      if (result.blockedReason || result.conflicts.some(conflict => !conflict.choice)) {
        previous.version++;
        session.sourceStale = true;
        session.sourceMerge = {snapshot: fresh, draft: previous, evidence};
        session.status = result.blockedReason || `${result.conflicts.filter(conflict => !conflict.choice).length} 项外部修改冲突，请查看并逐项选择`;
        session.baselineComparison = {available: false, message: '本地文件已外部更新，请先处理外部修改冲突'};
        await this.persist(session); this.publish(session); return;
      }
      if (Object.keys(choices).length) this.archiveDraft(session);
      result.draft.version = previous.version + 1;
      ownedSnapshot = fresh;
      session.snapshot = fresh; session.draft = result.draft; session.sourceStale = false; session.sourceMerge = null;
      session.status = origin === 'code' ? '代码已通过共用编辑器保存；页面草稿已同步'
        : `外部修改已载入 · ${result.appliedCount} 项窗口调整已保留${result.absorbedCount ? ` · ${result.absorbedCount} 项已包含在文件中` : ''}`;
      await this.persist(session); await this.refreshComparison(session); this.publish(session);
    } catch (error) {
      if (this.disposed || session.sourceReadGeneration !== generation || session.snapshot !== ownedSnapshot) return;
      session.sourceStale = true; session.status = '页面更新核对失败：' + error.message;
      session.baselineComparison = {available: false, message: session.status};
      if (session.sourceMerge) session.sourceMerge.evidence.blockedReason = session.status;
      await this.persist(session); this.publish(session);
    } finally {
      session.sourceReads--; this.pruneClosedPages();
    }
  }
  async statusChanged(workspaceKey) {
    if (this.disposed) return;
    let refresh = this.comparisonRefreshes.get(workspaceKey);
    if (refresh) { refresh.queued = true; return refresh.promise; }
    refresh = {};
    this.comparisonRefreshes.set(workspaceKey, refresh);
    refresh.promise = (async () => {
      do {
        await new Promise(resolve => { refresh.wake = resolve; refresh.timer = setTimeout(resolve, 100); });
        refresh.wake = null; refresh.queued = false;
        if (this.disposed) break;
        for (const session of this.pages.values()) {
          if (session.identity.workspaceKey!==workspaceKey || session.closed || session.busy || session.sourceStale) continue;
          // A pull or upload can change the API baseline without changing the working file.
          await session.comparisonRequest?.promise;
          if (!this.disposed && !session.closed && !session.busy && !session.sourceStale) await this.refreshComparison(session);
        }
      } while (refresh.queued && !this.disposed);
      this.comparisonRefreshes.delete(workspaceKey);
    })().finally(() => {
      if (this.comparisonRefreshes.get(workspaceKey) === refresh) this.comparisonRefreshes.delete(workspaceKey);
    });
    return refresh.promise;
  }
  owns(identity, document) {
    if (document.uri.scheme !== SCHEME) return this.ownsDocument(identity, document);
    const other = decodeIdentity(document.uri);
    return other.workspaceKey === identity.workspaceKey && other.sourcePath === identity.sourcePath;
  }
  documentChanged(document) {
    for (const session of this.pages.values()) if (this.owns(session.identity, document)) this.publish(session);
  }
  beforeCodeSave(uri) {
    for (const session of this.pages.values()) if (this.owns(session.identity,{uri})
      && (session.busy || session.onlineOpening || session.pending || session.sourceStale))
      throw new Error(session.sourceStale ? '本地文件已外部更新，请保留代码输入与页面草稿，重新载入并核对后再保存'
        : '请先完成页面保存检查或在线编辑器切换，再保存代码；当前输入已保留');
  }
  async persist(session) {
    session.persistedClose = false;
    const recovery = session.recovery;
    const previousPersistence = session.persistence;
    const state = {
      sourceHash: session.snapshot.sourceHash, operations: session.draft.operations(),
      pending: session.pending || null, nativeRecovery: session.nativeRecovery || null, recovery: session.recovery || null,
      sourceMerge: session.sourceMerge?.evidence || null,
    };
    const persistence = (previousPersistence || Promise.resolve()).catch(() => {}).then(async () => {
      if (recovery) {
        const saved = recovery === session.savedRecovery && session.recoveryReference
          ? session.recoveryReference : await this.recoveryStore.save(session.storageKey, recovery);
        state.recovery = saved;
        if (session.recovery === recovery) { session.savedRecovery = recovery; session.recoveryReference = saved; }
      }
      await this.context.workspaceState.update(session.storageKey, state);
    });
    session.persistence = persistence;
    await persistence;
    if (session.closed && session.persistence === persistence) {
      session.persistedClose = true;
      const history = [...session.draft.past, ...session.draft.future]
        .flatMap(entries => entries.map(entry => [entry.before, entry.after]));
      session.closedBytes = Buffer.byteLength(JSON.stringify([session.snapshot, session.draft.model,
        session.draft.baseline, session.draft.operations(), session.recovery, history]));
      this.pruneClosedPages();
    }
  }
  pruneClosedPages() {
    if (this.disposed) return;
    const closed = [...this.pages].filter(([, session]) => session.closed && !session.busy && !session.pending && !session.sourceMerge?.applying
      && !session.sourceReads && !session.onlineOpening
      && !session.sourceStale && !session.sourceMerge && !session.draft.operations().length && !session.nativeRecovery && !session.blocked
      && !this.vscode.workspace.textDocuments.some(document => document.isDirty && this.owns(session.identity, document))
      && session.persistedClose).sort(([, left], [, right]) => left.closedAt - right.closedAt);
    let count = closed.length, bytes = closed.reduce((sum, [, session]) => sum + session.closedBytes, 0);
    for (const [key, session] of closed) {
      if (count <= this.maxClosedPages && bytes <= this.maxClosedBytes) break;
      this.pages.delete(key); count--; bytes -= session.closedBytes;
    }
  }
  publish(session) {
    const dirty = !!(session.draft.operations().length || session.pending || session.nativeRecovery);
    const draftSignature=JSON.stringify([dirty,session.draft.version]);
    if(session.draftSignature!==draftSignature) {
      session.draftSignature=draftSignature; session.draftRegistrationError=null;
      const registration=Promise.resolve(this.onDraftChanged(session.identity,dirty,session.draft.version)).catch(error=>{
        if (session.draftRegistration === registration) session.draftRegistrationError=error;
        void this.vscode.window.showErrorMessage(`PAGE 编辑状态登记失败：${error.message}`);
      });
      session.draftRegistration=registration;
    }
    const merge = session.sourceMerge;
    const sourceMerge = merge ? {...merge.evidence, choices: {...merge.evidence.choices}, applying: !!merge.applying,
      conflicts: merge.evidence.conflicts.map(conflict => {
        const display = value => (conflict.kind === 'text' ? String(value) : JSON.stringify(value, null, 2)) ?? '属性不存在';
        const texts = [conflict.before, conflict.file, conflict.local].map(display);
        return {id: conflict.id, label: conflict.label, pointer: conflict.pointer, choice: conflict.choice,
          texts: texts.map(value => value.slice(0, 8000)), truncated: texts.some(value => value.length > 8000)};
      })} : null;
    if (!session.closed) {
      const previous = session.published, operations = session.draft.operations(), signature = JSON.stringify(operations);
      const full = previous?.draft !== session.draft || previous?.snapshot !== session.snapshot;
      const sequence = session.messageSequence = (session.messageSequence || 0) + 1;
      const message = {type: 'state', update: full ? 'full' : 'patch', sequence, baseSequence: previous?.sequence,
      ...(full ? {baseline: session.draft.baseline} : {}), pageName: session.draft.model.pageName,
      ...(full || previous.signature !== signature ? {operations} : {}), version: session.draft.version,
      editable: session.snapshot.editable && !session.blocked && !session.busy && !session.onlineOpening && !session.sourceStale,
      sourceMerge,
      busy: session.busy, blocked: session.blocked, recovery: session.recovery ? {available: true} : null,
      codeDirty: this.vscode.workspace.textDocuments.some(doc=>doc.isDirty && this.owns(session.identity,doc)),
      status: session.status || '', sourceHash: session.snapshot.sourceHash,
      baselineLabel:this.baselineLabel,apiVersion: session.baselineComparison?.apiVersion, pending: session.pending ? {operationId: session.pending.operationId || '', awaitingVerification: true} : null,
      comparison: {...(full || previous.baseline !== session.baselineComparison ? {baseline:session.baselineComparison || {available:false,message:`正在读取${this.baselineLabel}…`}} : {}),
        ...(full || previous.signature !== signature ? {local:draftChanges(session.draft)} : {}),
        savedAt:session.snapshot.loadedAt, sourceStale:!!session.sourceStale}, onlineOpening: !!session.onlineOpening};
      session.published = {draft: session.draft, snapshot: session.snapshot, sequence, signature, baseline: session.baselineComparison};
      void Promise.resolve(session.panel.webview.postMessage(message)).then(delivered => {
        if (delivered === false && session.published?.sequence === sequence) session.published = null;
      }).catch(() => { if (session.published?.sequence === sequence) session.published = null; });
    }
    const pageTitle = [session.draft.model.pageName, session.identity.sourceId].filter(Boolean).join(' · ');
    session.panel.title = `${session.draft.operations().length ? '● ' : ''}${pageTitle} · 本地页面`;
  }
  error(session, error) { session.status = error.message; this.publish(session); }
  async openCode(session, node) {
    const item = session.snapshot.model.nodes.find(item => item.pointer === node.pointer);
    const fragment = item && {...item,jsonPointer:item.pointer,scriptType:scriptType(item)};
    if (!fragment) throw new Error('此事件未出现在源码分块中，请刷新页面和索引');
    const identity = {...session.identity,...fragmentIdentity(session.identity.workspaceKey, {...session.identity,
      sourcePath:session.snapshot.sourcePath, sourceName:session.draft.model.pageName}, fragment)};
    const uri = await this.virtualFs.open(identity, {viewColumn:this.vscode.ViewColumn.Beside});
    const original = session.draft.baseline.nodes.find(item => item.key === node.key);
    if (node.content !== original?.content) {
      const doc = this.vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
      if (!doc || doc.getText() === node.content) return uri;
      if (doc.isDirty || doc.getText() !== original.content)
        throw new Error('代码标签已有不同输入，页面草稿已保留，请先比较两处修改');
      const edit = new this.vscode.WorkspaceEdit();
      edit.replace(uri, new this.vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), node.content);
      if (!await this.vscode.workspace.applyEdit(edit)) throw new Error('未能将代码草稿放入共用编辑器，草稿已保留');
    }
    return uri;
  }
  async codeSaved(uri) {
    for (const session of this.pages.values()) {
      if (!this.owns(session.identity, {uri})) continue;
      if (session.busy || session.pending || session.blocked) {
        session.blocked ||= '代码已保存；页面有待核对操作，请导出草稿后重新载入'; this.publish(session); continue;
      }
      await this.refreshSource(session, 'code');
    }
  }
  async save(session) {
    if (session.busy || session.blocked || session.sourceStale) throw new Error(session.blocked || (session.sourceStale ? '本地文件已外部更新，请保留草稿后重新载入' : '页面正在保存'));
    const operations = session.draft.operations();
    if (!operations.length) { session.status = '当前草稿已保存'; this.publish(session); return; }
    if (!session.snapshot.editable) throw new Error('当前页面只读');
    this.assertCanSave(session.identity);
    if (this.vscode.workspace.textDocuments.some(doc => doc.isDirty && this.owns(session.identity, doc)))
      throw new Error('此 PAGE 的代码有未保存输入，请先保存代码，再保存页面草稿');
    session.busy = true; this.publish(session);
    const version = session.draft.version;
    try {
      if (session.snapshot.expiresAt && session.snapshot.expiresAt * 1000 < Date.now() + 120000) {
        const renewed = await this.snapshot(session.identity);
        if (!renewed.editable || renewed.sourceHash !== session.snapshot.sourceHash
          || renewed.sourcePath !== session.snapshot.sourcePath) throw new Error('PAGE 基线已变化；草稿保留，请导出比较');
        session.snapshot = renewed;
      }
      const preview = await this.requestPage(session.identity, {
        action: 'preview', path:session.snapshot.sourcePath, editToken: session.snapshot.editToken, operations});
      if (session.draft.version !== version) throw new Error('预检期间草稿变化，请重新保存');
      if (operations.some(op=>op.kind==='order')) {
        // Positional script URIs cannot survive a saved collection reorder.
        const tabs = this.vscode.window.tabGroups?.all.flatMap(group=>group.tabs)
          .filter(tab=>{const uri=tab.input?.uri || tab.input?.modified;return uri && this.owns(session.identity,{uri});});
        if (tabs?.length && !await this.vscode.window.tabGroups.close(tabs))
          throw new Error('请关闭此 PAGE 的代码标签后保存排序；页面草稿已保留');
        if (!tabs && this.vscode.workspace.textDocuments.some(doc=>this.owns(session.identity,doc)))
          throw new Error('请关闭此 PAGE 的代码标签后保存排序；页面草稿已保留');
      }
      if (!preview.candidateSourceHash) throw new Error('页面预览未返回候选哈希，不能安全保存');
      const editorToken = await this.editorToken(session.identity.workspaceKey);
      if (session.draft.version !== version) throw new Error('编辑状态登记期间草稿变化，请重新保存');
      session.pending = {idempotencyKey: 'page-editor-' + crypto.randomUUID(), operations,
        editToken: session.snapshot.editToken, sourceHash:session.snapshot.sourceHash, candidateSourceHash: preview.candidateSourceHash};
      await this.persist(session);
      try {
        this.assertCanSave(session.identity);
        if (this.vscode.workspace.textDocuments.some(doc=>doc.isDirty && this.owns(session.identity,doc))) throw new Error('此 PAGE 的代码有未保存输入，请先保存代码');
        if (session.draft.version !== version) throw new Error('草稿已变化，请重新保存');
      } catch(error) {session.pending=null;await this.persist(session);throw error;}
      const result = await this.requestPage(session.identity, {
        action: 'save', path:session.snapshot.sourcePath, editToken: session.pending.editToken, operations, editorToken,
        idempotencyKey: session.pending.idempotencyKey});
      session.pending.operationId = result.operationId;
      await this.persist(session);
      const written=await this.snapshot(session.identity);
      if (written.sourceHash !== session.pending.candidateSourceHash || (result.sourceHash && result.sourceHash !== written.sourceHash)) {
        session.blocked = '本地保存回读不一致，请核对源码';
        return;
      }
      if (session.draft.version !== version) {
        session.blocked = '保存期间有新输入，已保留；请比较后重开'; return;
      }
      await this.reloadSaved(session,written);
    } catch (error) {
      if (session.pending) {
        session.blocked = '保存结果待核对，草稿与请求已保留；使用“恢复保存检查”';
        await this.persist(session);
      }
      throw error;
    } finally { session.busy = false; this.publish(session); }
  }
  async reloadSaved(session,snapshot) {
    snapshot ||= await this.snapshot(session.identity);
    const next = new PageDraft(snapshot.model); next.version = session.draft.version + 1;
    session.snapshot = snapshot; session.draft = next; session.pending = null; session.blocked = '';
    session.sourceStale=false;
    session.sourceMerge=null;
    await this.refreshComparison(session);
    session.status = session.identity.sourceMode==='database' ? '已保存到工作副本并回读' : '本地已保存并回读 · 尚未上传谷神';
    await this.persist(session);
    try { await this.onSaved(session.identity.workspaceKey, session.snapshot.sourcePath); }
    catch (error) { session.status += ' · SCM 界面刷新失败：' + error.message; }
  }
  async message(session, message) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'ready') { session.published = null; this.publish(session); return; }
    if(message.type==='platformReference') {await this.vscode.commands.executeCommand('gushenCompletion.showPlatformReference',session.identity.workspaceKey);return;}
    if (message.type === 'compare') { await this.refreshComparison(session); return; }
    if (message.type === 'export') {
      const recovery = await this.recoveryStore.expand(session.storageKey, session.recovery);
      const doc = await this.vscode.workspace.openTextDocument({language: 'json', content: JSON.stringify(
        {sourceHash: session.snapshot.sourceHash, operations: session.draft.operations(), recovery,
          sourceMerge: session.sourceMerge?.evidence, nativeRecovery: session.nativeRecovery, pending: session.pending}, null, 2)});
      await this.vscode.window.showTextDocument(doc); this.publish(session); return;
    }
    if (message.type === 'reload') {
      if (session.busy || session.onlineOpening) throw new Error('页面正在保存或打开在线编辑器，请稍后重新载入');
      if (session.sourceMerge?.applying) throw new Error('正在核对外部修改，请等待完成后重新载入');
      const snapshot = await this.snapshot(session.identity,{prepare:true});
      if (!snapshot.model) throw new Error(snapshot.message || 'PAGE 当前没有可编辑的原生模型');
      this.archiveDraft(session);
      const draft = new PageDraft(snapshot.model); draft.version = session.draft.version + 1;
      session.snapshot = snapshot; session.draft = draft; session.blocked = ''; session.nativeRecovery = null; session.pending = null;
      session.sourceStale=false; session.sourceMerge=null;
      await this.refreshComparison(session);
      session.status = '已重新载入；旧草稿保留在“导出草稿”中';
      await this.persist(session); this.publish(session); return;
    }
    if (message.type === 'resume' && session.pending && !session.busy && !session.onlineOpening) {
      const pending = session.pending;
      const current=await this.snapshot(session.identity);
      if (current.sourceHash === pending.candidateSourceHash) {
        const preserved = session.recovery?.operations || session.draft.operations();
        if (JSON.stringify(preserved) !== JSON.stringify(pending.operations)) {
          session.blocked = '已确认先前保存；另有新输入保留在草稿中，请先导出再重新载入';
          session.pending = null; await this.persist(session);
        } else await this.reloadSaved(session);
      } else {
        session.status = current.sourceHash === pending.sourceHash
          ? '保存结果尚未出现，请保留草稿并核对操作记录' : '源码已变化，请导出草稿并核对';
      }
      this.publish(session); return;
    }
    if (message.version !== session.draft.version) { this.publish(session); throw new Error('界面版本已变化，请重试'); }
    if (message.type === 'resolveSourceConflict') {
      const merge = session.sourceMerge;
      if (!merge || merge.applying || merge.evidence.blockedReason || session.busy || session.onlineOpening || session.pending || session.blocked
        || message.sourceHash !== merge.evidence.sourceHash || !['draft', 'file'].includes(message.choice))
        throw new Error('外部修改状态已变化，请查看当前冲突');
      const conflict = merge.evidence.conflicts.find(item => item.id === message.id);
      if (!conflict) throw new Error('冲突项已变化，请重新选择');
      conflict.choice = message.choice; merge.evidence.choices[conflict.id] = message.choice;
      session.draft.version++; await this.persist(session);
      const remaining = merge.evidence.conflicts.filter(item => !item.choice).length;
      if (remaining) { session.status = `${remaining} 项外部修改冲突待选择`; this.publish(session); return; }
      merge.applying = true; this.publish(session);
      try { await this.refreshSource(session, 'resolve', merge); }
      finally { merge.applying = false; this.publish(session); }
      return;
    }
    if (message.type === 'online') { await this.openOnlineEditor(session); return; }
    if(message.type==='openFields') {
      if(session.sourceStale) throw new Error('本地文件已外部更新，请先核对页面草稿');
      const collection=session.draft.model.collections.find(item=>item.pointer===message.collectionPointer);
      if(!collection) throw new Error('字段集合已变化，请重新载入');
      await this.virtualFs.open({...session.identity,workspaceKey:session.identity.workspaceKey,sourceType:'page',sourcePath:session.snapshot.sourcePath,
        sourceId:session.identity.sourceId,jsonPointer:collection.pointer,fragmentType:'fields',documentName:collection.label}, {viewColumn:this.vscode.ViewColumn.Beside});
      this.publish(session);return;
    }
    if (message.type === 'openCode' || message.type === 'diff') {
      if (session.sourceStale) throw new Error('本地文件已外部更新，请保留草稿后重新载入再打开代码');
      const node = session.draft.model.nodes.find(item => item.key === message.key);
      if (!node) throw new Error('节点已变化');
      if (message.type === 'diff') await this.vscode.commands.executeCommand('gushenCompletion.showApiDiff',
        session.identity.workspaceKey, session.snapshot.sourcePath);
      else await this.openCode(session, node);
      this.publish(session);
      return;
    }
    if (session.busy || session.onlineOpening || session.blocked || session.sourceStale || !session.snapshot.editable) throw new Error(session.blocked || '页面当前不可修改，请保留草稿后重新载入');
    if (message.type === 'property') session.draft.property(message.collectionPointer, message.fieldKey, message.name, message.value);
    else if (message.type === 'order') session.draft.order(message.collectionPointer, message.fieldKeys);
    else if (message.type === 'undo') session.draft.undo();
    else if (message.type === 'redo') session.draft.redo();
    else if (message.type === 'save') { await this.save(session); return; }
    else return;
    this.publish(session); await this.persist(session);
  }
  async open(identity, panel) {
    const key = pageKey(identity || {});
    if (this.opening.has(key)) {await this.opening.get(key);return this.openPage(identity,panel);}
    const operation = this.openPage(identity,panel);
    this.opening.set(key, operation);
    try { return await operation; } finally { this.opening.delete(key); }
  }
  mount(session, suppliedPanel) {
    const title = [session.draft.model.pageName, session.identity.sourceId].filter(Boolean).join(' · ');
    const panel = suppliedPanel || this.vscode.window.createWebviewPanel('guthon.pageEditor', `${title} · 本地页面`,
      this.vscode.ViewColumn.Active, {enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [this.vscode.Uri.file(path.join(this.context.extensionPath, 'src/page-editor'))]});
    panel.title=`${title} · 本地页面`;
    panel.webview.options={...panel.webview.options,enableScripts:true,localResourceRoots:[this.vscode.Uri.file(path.join(this.context.extensionPath,'src/page-editor'))]};
    session.panel = panel; session.closed = false; session.persistedClose = false; session.published = null;
    panel.webview.onDidReceiveMessage(message => { void this.message(session, message).catch(error => this.error(session, error)); });
    panel.onDidDispose(() => {
      session.closed = true; session.closedAt = Date.now();
      void this.persist(session).catch(error => this.vscode.window.showErrorMessage(error.message));
    });
    panel.webview.html = this.html(panel.webview);
  }
  async openPage(identity, panel) {
    if (!identity?.workspaceKey || !(identity.sourcePath || identity.path) || identity.sourceType !== 'page') throw new Error('请在源码树中选择身份完整的 PAGE');
    identity = {...identity,sourcePath:identity.sourcePath || identity.path};
    const key = pageKey(identity), existing = this.pages.get(key);
    if (existing) {
      const name=pageDisplayName(identity);
      if (name) {
        existing.identity.treeLabel=identity.treeLabel; existing.identity.sourceName=identity.sourceName;
        if (existing.draft.model.pageName!==name) {
          existing.draft.model.pageName=existing.draft.baseline.pageName=existing.snapshot.model.pageName=name;
        }
      }
      const reopening = existing.closed;
      if(panel && panel!==existing.panel) {existing.panel.dispose();this.mount(existing,panel);}
      else if (reopening) this.mount(existing);
      existing.panel.reveal();
      this.publish(existing);
      if (reopening) await this.refreshComparison(existing);
      return existing;
    }
    if (this.vscode.workspace.textDocuments.some(doc => doc.isDirty && this.owns(identity, doc)))
      throw new Error('此 PAGE 的虚拟文档存在未保存输入，请先保存或保留后再打开本地页面');
    if(!panel && identity.pendingNative && this.preparePage)await this.preparePage(identity);
    const snapshot = await this.snapshot(identity,{prepare:!panel});
    if (RAW_SOURCE_STATES.has(snapshot.contentState)) {
      if(!this.openReadonly) throw new Error(snapshot.message || '页面不可编辑，请只读查看原文');
      const opened = await this.openReadonly(identity,snapshot);
      if (snapshot.contentState === 'BATCH_EXPORT') panel?.dispose();
      return opened;
    }
    const session = {identity: {...identity, sourceId:identity.sourceId || snapshot.model.pageId,
      sourcePath:snapshot.sourcePath}, snapshot,
      draft: new PageDraft(snapshot.model), busy: false, blocked: '', status: '',
      storageKey: 'guthon.pageDraft.' + crypto.createHash('sha256').update(key).digest('hex')};
    const recovered = this.context.workspaceState.get(session.storageKey);
    session.recoveryReference = recovered?.recovery?.kind === 'page-recovery-v1' ? recovered.recovery : null;
    session.recovery = await this.recoveryStore.head(session.storageKey, recovered?.recovery);
    session.savedRecovery = session.recovery;
    session.nativeRecovery = recovered?.nativeRecovery;
    if (recovered?.pending) {
      session.pending = recovered.pending; session.recovery = recovered;
      session.blocked = '上次保存结果待核对，草稿已保留；请恢复保存检查或导出草稿';
    } else if (recovered?.operations?.length) {
      if (recovered.sourceHash === snapshot.sourceHash) session.draft.restore(recovered.operations);
      else { session.recovery = recovered; session.status = '发现旧基线草稿，请导出比较；未覆盖当前页面'; }
    }
    if (recovered?.sourceMerge && session.recovery !== recovered) {
      session.recovery = recovered;
      session.status = '上次外部修改报告已保留在“导出草稿”中，请核对当前文件';
    }
    this.pages.set(key, session);
    this.mount(session,panel);
    this.publish(session);
    await this.refreshComparison(session);
    return session;
  }
  async openOnlineEditor(session) {
    if (!this.openOnline) throw new Error('在线编辑器入口未配置');
    if (session.onlineOpening || session.busy || session.pending || session.blocked || session.sourceStale || session.sourceReads
      || session.sourceMerge || session.nativeRecovery)
      throw new Error(session.blocked || '请先处理页面保存或外部修改，再打开在线编辑器');
    if (this.vscode.workspace.textDocuments.some(doc => doc.isDirty && this.owns(session.identity, doc)))
      throw new Error('此 PAGE 的代码有未保存输入，请先保存代码');
    session.onlineOpening = true;
    if (session.draftRegistrationError) session.draftSignature = null;
    this.publish(session);
    try {
      if (session.draft.operations().length) await this.save(session);
      const version = session.draft.version;
      await session.draftRegistration;
      if (session.draftRegistrationError) throw session.draftRegistrationError;
      if (session.busy || session.pending || session.blocked || session.sourceStale || session.sourceMerge
        || session.nativeRecovery || session.draft.version !== version
        || session.draft.operations().length
        || this.vscode.workspace.textDocuments.some(doc => doc.isDirty && this.owns(session.identity, doc)))
        throw new Error(session.blocked || '页面状态已变化，请先核对草稿和源码再打开在线编辑器');
      await this.openOnline(session.identity);
    } finally { session.onlineOpening = false; this.publish(session); }
  }
  html(webview) {
    const uri = name => escape(webview.asWebviewUri(this.vscode.Uri.file(path.join(this.context.extensionPath, 'src/page-editor', name))).toString());
    const nonce = crypto.randomBytes(20).toString('hex');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; img-src data:; connect-src 'none';">
      <link rel="stylesheet" href="${uri('editor.css')}"><title>本地页面</title></head><body>
      <header><div class="heading"><div><span class="eyebrow">GUTHON NEXUS · PAGE WORKSPACE</span><h1 id="title">本地页面</h1></div><span id="status" role="status"></span></div><p id="baseline"></p>
      <div class="toolbar"><div class="action-group" role="group" aria-label="谷神平台与设计器"${this.platformReference?'':' hidden'}><span class="group-label">谷神</span><button id="online" class="primary">在线编辑器</button><button id="platformReference">开发参考</button></div>
      <div class="action-group" role="group" aria-label="本地编辑"><span class="group-label">本地</span><button id="save">保存到本地</button><button id="undo">撤销</button><button id="redo">重做</button><button id="compare" aria-expanded="false" aria-controls="compare-menu">比较改动</button><div id="compare-menu" hidden><button id="compare-baseline">与 ${escape(this.baselineLabel)}比较</button><button id="compare-local">与本地保存版本比较</button></div><button id="source-merge" hidden>外部修改冲突</button><button id="exit-compare" hidden>返回当前草稿</button><button id="export">导出草稿</button><button id="reload">重新载入</button><button id="resume">恢复保存检查</button></div><input id="search" type="search" placeholder="筛选字段名称或编码" aria-label="筛选字段"></div>
      <p class="diff-legend"><span class="diff-baseline">M · 相对${escape(this.baselineLabel)}的本地修改</span><span class="diff-local">● · 窗口未保存</span><span id="comparison-status"></span></p>
      </header>
      <main><nav id="tree" aria-label="页面结构"></nav><section id="canvas" aria-label="字段与代码管理"></section><aside id="properties"></aside></main>
      <details id="changes"><summary>上次本地保存 → 当前草稿 · 修改明细</summary><pre id="delta"></pre></details>
      <script nonce="${nonce}" src="${uri('model.js')}"></script><script nonce="${nonce}" src="${uri('state.js')}"></script>
      <script nonce="${nonce}" src="${uri('editor.js')}"></script></body></html>`;
  }
  async saveDirty(workspaceKey) {
    for (const session of this.pages.values()) if (session.identity.workspaceKey === workspaceKey) {
      if (session.blocked) throw new Error(session.blocked);
      if (session.draft.operations().length) await this.save(session);
    }
  }
  dispose() {
    if(this.disposed) return;
    this.disposed = true;
    for (const refresh of this.comparisonRefreshes.values()) {
      clearTimeout(refresh.timer); refresh.wake?.();
    }
    for (const session of this.pages.values()) {
      session.panel.dispose();
    }
    this.registrations.forEach(item => item.dispose());
  }
}
module.exports = {PageEditorController};

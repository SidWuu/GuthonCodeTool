const crypto = require('node:crypto');
const path = require('node:path');
const {PageDraft} = require('./model');
const {buildOutline} = require('./outline');
const {draftChanges} = require('./comparison');
const {mergePageDraft} = require('./source-merge');
const {PageRecoveryStore} = require('./recovery-store');
const {nativeHtml} = require('./platform-assets');
const {projectNative, nativeChanges} = require('./native-model');
const {DesignerResources} = require('./resource-manager');
const {SCHEME: SVN_SCHEME, decodeIdentity, fragmentIdentity, pageDisplayName} = require('../svn/virtual-fs');

const escape = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const pageKey = identity => JSON.stringify([identity.workspaceKey, identity.sourceNamespace, identity.sourceId, identity.funId || '']);

class PageEditorController {
  constructor({vscode, context, backend, virtualFs, getTool, resources = new DesignerResources({getTool}),
    recoveryStore = new PageRecoveryStore(context), maxClosedPages = 4, maxClosedBytes = 16 * 1024 * 1024,
    onSaved = async () => {}, onResourceOutput = () => {}}) {
    Object.assign(this, {vscode, context, backend, virtualFs, onSaved, onResourceOutput});
    this.resources = resources;
    Object.assign(this, {recoveryStore, maxClosedPages, maxClosedBytes});
    this.pages = new Map(); this.opening = new Map(); this.resourceJobs = new Map();
    this.comparisonRefreshes = new Map(); this.disposed = false;
    this.registrations = [vscode.workspace.onDidChangeTextDocument(event => this.documentChanged(event.document)),
      vscode.workspace.onDidSaveTextDocument?.(document=>this.documentChanged(document)),
      vscode.workspace.onDidCloseTextDocument?.(document=>this.documentChanged(document))].filter(Boolean);
  }
  async snapshot(identity) {
    const result = await this.backend.run(identity.workspaceKey, ['page-editor'], {action:'open',
      sourceNamespace:identity.sourceNamespace, sourceId:identity.sourceId, funId:identity.funId || ''});
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
        const result = await this.backend.run(session.identity.workspaceKey, ['page-editor'], {action:'comparison',
          sourceNamespace:session.identity.sourceNamespace, sourceId:session.identity.sourceId,
          funId:session.identity.funId || '', sourceHash:snapshot.sourceHash});
        if (this.disposed || session.snapshot!==snapshot) return;
        if (result.sourceHash !== snapshot.sourceHash) throw new Error('比较基线与当前页面不一致，请重新载入');
        session.svnComparison = result;
      } catch (error) {
        if (this.disposed || session.snapshot!==snapshot) return;
        session.svnComparison = {available:false,message:error.message};
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
    if (session.busy || session.pending) { session.sourceStale = true; this.publish(session); return; }
    session.sourceReads = (session.sourceReads || 0) + 1;
    try {
      const fresh = await this.snapshot(session.identity);
      if (this.disposed || session.sourceReadGeneration !== generation || session.snapshot !== baseline
        || (expectedMerge && session.sourceMerge !== expectedMerge)) return;
      if (session.busy || session.pending) { session.sourceStale = true; this.publish(session); return; }
      const sameIdentity = ['workspaceKey', 'sourceNamespace', 'sourceId', 'workingCopyId', 'sourcePath', 'funId']
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
      const reason = session.blocked || (dirtyCode ? '此 PAGE 的代码有未保存输入，请先保留代码和草稿再重新载入'
        : session.native?.unconfirmed ? '原版设置对话框尚未确认，请先保留其输入并关闭，再重新载入'
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
        session.svnComparison = {available: false, message: '本地文件已外部更新，请先处理外部修改冲突'};
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
      session.svnComparison = {available: false, message: session.status};
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
          // A commit can change BASE during an earlier read without changing the working file.
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
    if (document.uri.scheme !== SVN_SCHEME) return false;
    try {
      const other = decodeIdentity(document.uri);
      if (other.workspaceKey !== identity.workspaceKey || other.sourceType !== 'page'
        || other.sourceId !== identity.sourceId || (other.funId || '') !== (identity.funId || '')) return false;
      if (other.sourcePath && identity.sourcePath) return other.sourcePath.replace(/\\/g, '/') === identity.sourcePath.replace(/\\/g, '/');
      return !other.workingCopyId || other.workingCopyId === identity.workingCopyId;
    } catch { return false; }
  }
  documentChanged(document) {
    for (const session of this.pages.values()) if (this.owns(session.identity, document)) this.publish(session);
  }
  beforeCodeSave(uri) {
    for (const session of this.pages.values()) if (this.owns(session.identity,{uri})
      && (session.busy || session.pending || session.native?.unconfirmed || session.sourceStale))
      throw new Error(session.sourceStale ? '本地文件已外部更新，请保留代码输入与页面草稿，重新载入并核对后再保存'
        : '请先完成页面保存检查，或确认/取消原版设置对话框，再保存代码；当前输入已保留');
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
    const closed = [...this.pages].filter(([, session]) => session.closed && !session.native && !session.busy && !session.pending && !session.sourceMerge?.applying
      && !session.sourceReads && !this.resourceJobs.has(session.identity.workspaceKey)
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
      editable: session.snapshot.editable && !session.blocked && !session.busy && !session.sourceStale && !session.native?.unconfirmed,
      sourceMerge,
      busy: session.busy, blocked: session.blocked, recovery: session.recovery ? {available: true} : null,
      resourceBusy: this.resourceJobs.has(session.identity.workspaceKey),
      codeDirty: this.vscode.workspace.textDocuments.some(doc=>doc.isDirty && this.owns(session.identity,doc)),
      status: session.status || '', sourceHash: session.snapshot.sourceHash,
      baseRevision: session.snapshot.baseRevision, pending: session.pending ? {operationId: session.pending.operationId || '', awaitingVerification: true} : null,
      comparison: {...(full || previous.svn !== session.svnComparison ? {svn:session.svnComparison || {available:false,message:'正在读取 SVN BASE…'}} : {}),
        ...(full || previous.signature !== signature ? {local:draftChanges(session.draft)} : {}),
        savedAt:session.snapshot.loadedAt, sourceStale:!!session.sourceStale},
      designer: session.resourceInfo ? {app:session.resourceInfo.app,digest:session.resourceInfo.digest,
        platformUrl:session.resourceInfo.platformUrl,build:session.resourceInfo.build,message:session.resourceInfo.message,
        state:session.resourceInfo.state,updateAvailable:session.resourceInfo.updateAvailable} : null};
      session.published = {draft: session.draft, snapshot: session.snapshot, sequence, signature, svn: session.svnComparison};
      void Promise.resolve(session.panel.webview.postMessage(message)).then(delivered => {
        if (delivered === false && session.published?.sequence === sequence) session.published = null;
      }).catch(() => { if (session.published?.sequence === sequence) session.published = null; });
    }
    const pageTitle = [session.draft.model.pageName, session.identity.sourceId].filter(Boolean).join(' · ');
    session.panel.title = `${session.draft.operations().length ? '● ' : ''}${pageTitle} · 本地页面`;
    if (session.native) session.native.panel.title = `${pageTitle} · 原版设计视图`;
    if (session.native && session.sourceStale) {
      void session.native.panel.webview.postMessage({type: 'nativeError', error: '本地文件已外部更新，设计器输入保留；请返回“草稿与代码”核对'});
      return;
    }
    if (session.native && !session.native.unconfirmed && session.native.version !== session.draft.version) {
      const projected = session.native.before
        ? {data: JSON.parse(session.snapshot.sourceText), model: session.draft.baseline}
        : projectNative(session.snapshot, session.draft);
      Object.assign(session.native, {version: session.draft.version, projection: projected, baseline: null});
      void session.native.panel.webview.postMessage({type: 'nativeDocument', version: session.draft.version,
        data: projected.data, systemId: 'offline', before: !!session.native.before,
        pageName: session.draft.model.pageName,
        editable: session.snapshot.editable && !session.blocked && !session.sourceStale && !session.native.before,
        sourceHash: session.snapshot.sourceHash, baseRevision: session.snapshot.baseRevision,
        resourceApp: session.native.assets.app, resourceDigest: session.native.assets.digest,
        resourceStatus: session.sourceStale ? '本地文件已外部更新，草稿基线已过期' : session.resourceInfo?.message || '', platformUrl:session.resourceInfo?.platformUrl || ''});
    }
  }
  error(session, error) { session.status = error.message; this.publish(session); }
  async openCode(session, node) {
    const result = await this.backend.fragments(session.identity.workspaceKey, session.identity);
    if (result.sourcePath && session.snapshot.sourcePath && result.sourcePath !== session.snapshot.sourcePath)
      throw new Error('代码片段与当前 PAGE 来源不一致，请重新载入');
    const fragment = result.fragments.find(item => item.jsonPointer === node.pointer);
    if (!fragment) throw new Error('此事件未出现在源码分块中，请刷新页面和索引');
    const identity = fragmentIdentity(session.identity.workspaceKey, {...session.identity,
      sourcePath:session.snapshot.sourcePath, sourceName:session.draft.model.pageName}, fragment);
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
    if (session.native?.unconfirmed) throw new Error('请先确认或取消原版设置对话框，再保存页面草稿');
    if (session.busy || session.blocked || session.sourceStale) throw new Error(session.blocked || (session.sourceStale ? '本地文件已外部更新，请保留草稿后重新载入' : '页面正在保存'));
    const operations = session.draft.operations();
    if (!operations.length) { session.status = '当前草稿已保存'; this.publish(session); return; }
    if (!session.snapshot.editable) throw new Error('当前页面只读');
    if (this.vscode.workspace.textDocuments.some(doc => doc.isDirty && this.owns(session.identity, doc)))
      throw new Error('此 PAGE 的代码有未保存输入，请先保存代码，再保存页面草稿');
    session.busy = true; this.publish(session);
    const version = session.draft.version;
    try {
      if (session.snapshot.expiresAt && session.snapshot.expiresAt * 1000 < Date.now() + 120000) {
        const renewed = await this.snapshot(session.identity);
        if (!renewed.editable || renewed.sourceHash !== session.snapshot.sourceHash
          || renewed.workingCopyId !== session.snapshot.workingCopyId) throw new Error('PAGE 基线已变化；草稿保留，请导出比较');
        session.snapshot = renewed;
      }
      const preview = await this.backend.run(session.identity.workspaceKey, ['page-editor'], {
        action: 'preview', editToken: session.snapshot.editToken, operations});
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
      session.pending = {idempotencyKey: 'page-editor-' + crypto.randomUUID(), operations,
        editToken: session.snapshot.editToken, candidateSourceHash: preview.candidateSourceHash};
      await this.persist(session);
      const result = await this.backend.run(session.identity.workspaceKey, ['page-editor'], {
        action: 'save', editToken: session.pending.editToken, operations,
        idempotencyKey: session.pending.idempotencyKey});
      session.pending.operationId = result.operationId;
      await this.persist(session);
      if (!result.localVerificationComplete || !result.currentSourceMatches || !result.currentIndexMatches || !result.currentDiffMatches) {
        session.blocked = '本地写入已记录，索引或差异验证待恢复';
        session.status = JSON.stringify(result); return;
      }
      if (session.draft.version !== version) {
        session.blocked = '保存期间有新输入，已保留；请比较后重开'; return;
      }
      await this.reloadSaved(session);
    } catch (error) {
      if (session.pending) {
        session.blocked = '保存结果待核对，草稿与请求已保留；使用“恢复保存检查”';
        await this.persist(session);
      }
      throw error;
    } finally { session.busy = false; this.publish(session); }
  }
  async reloadSaved(session) {
    const snapshot = await this.snapshot(session.identity);
    const next = new PageDraft(snapshot.model); next.version = session.draft.version + 1;
    session.snapshot = snapshot; session.draft = next; session.pending = null; session.blocked = '';
    session.sourceStale=false;
    session.sourceMerge=null;
    await this.refreshComparison(session);
    session.status = '本地已保存 · 索引与差异已验证 · 平台结果待验收';
    await this.persist(session);
    try { await this.onSaved(session.identity.workspaceKey, session.snapshot.sourcePath); }
    catch (error) { session.status += ' · SCM 界面刷新失败：' + error.message; }
  }
  async message(session, message) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'ready') { session.published = null; this.publish(session); return; }
    if (message.type === 'compare') { await this.refreshComparison(session); return; }
    if (message.type === 'manageResources') {
      await this.manageResources(session); this.publish(session); return;
    }
    if (message.type === 'configureAssets') {
      await this.resourceTask(session,()=>this.importAssets(session)); return;
    }
    if (message.type === 'export') {
      const recovery = await this.recoveryStore.expand(session.storageKey, session.recovery);
      const doc = await this.vscode.workspace.openTextDocument({language: 'json', content: JSON.stringify(
        {sourceHash: session.snapshot.sourceHash, operations: session.draft.operations(), recovery,
          sourceMerge: session.sourceMerge?.evidence, nativeRecovery: session.nativeRecovery, pending: session.pending}, null, 2)});
      await this.vscode.window.showTextDocument(doc); this.publish(session); return;
    }
    if (message.type === 'reload') {
      if (session.busy) throw new Error('页面正在保存，请稍后重新载入');
      if (session.sourceMerge?.applying) throw new Error('正在核对外部修改，请等待完成后重新载入');
      if (session.native?.unconfirmed) throw new Error('请先保留原版设置对话框的输入并关闭，再重新载入');
      const snapshot = await this.snapshot(session.identity);
      this.archiveDraft(session);
      const draft = new PageDraft(snapshot.model); draft.version = session.draft.version + 1;
      session.snapshot = snapshot; session.draft = draft; session.blocked = ''; session.nativeRecovery = null; session.pending = null;
      session.sourceStale=false; session.sourceMerge=null;
      await this.refreshComparison(session);
      session.status = '已重新载入；旧草稿保留在“导出草稿”中';
      await this.persist(session); this.publish(session); return;
    }
    if (message.type === 'resume' && session.pending && !session.busy) {
      const pending = session.pending;
      const result = await this.backend.run(session.identity.workspaceKey, ['page-editor'], pending.operationId
        ? {action: 'resume', operationId: pending.operationId}
        : {action: 'save', editToken: pending.editToken, idempotencyKey: pending.idempotencyKey, operations: pending.operations});
      if (result.localVerificationComplete && result.currentSourceMatches && result.currentIndexMatches && result.currentDiffMatches) {
        const preserved = session.recovery?.operations || session.draft.operations();
        if (JSON.stringify(preserved) !== JSON.stringify(pending.operations)) {
          session.blocked = '已确认先前保存；另有新输入保留在草稿中，请先导出再重新载入';
          session.pending = null; await this.persist(session);
        } else await this.reloadSaved(session);
      }
      else session.status = JSON.stringify(result);
      this.publish(session); return;
    }
    if (message.version !== session.draft.version) { this.publish(session); throw new Error('界面版本已变化，请重试'); }
    if (message.type === 'resolveSourceConflict') {
      const merge = session.sourceMerge;
      if (!merge || merge.applying || merge.evidence.blockedReason || session.busy || session.pending || session.blocked
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
    if (message.type === 'native') {
      if (session.sourceStale) throw new Error('请先处理外部修改冲突，再打开原版设计视图');
      await this.openNative(session); this.publish(session); return;
    }
    if (message.type === 'openCode' || message.type === 'diff') {
      if (session.sourceStale) throw new Error('本地文件已外部更新，请保留草稿后重新载入再打开代码');
      const node = session.draft.model.nodes.find(item => item.key === message.key);
      if (!node) throw new Error('节点已变化');
      if (message.type === 'diff') await this.vscode.commands.executeCommand('gushenCompletion.showSvnDiff',
        session.identity.workspaceKey, session.snapshot.sourcePath);
      else await this.openCode(session, node);
      this.publish(session);
      return;
    }
    if (session.busy || session.blocked || session.sourceStale || session.native?.unconfirmed || !session.snapshot.editable) throw new Error(session.blocked || '页面当前不可修改，请保留草稿后重新载入');
    if (message.type === 'property') session.draft.property(message.collectionPointer, message.fieldKey, message.name, message.value);
    else if (message.type === 'order') session.draft.order(message.collectionPointer, message.fieldKeys);
    else if (message.type === 'undo') session.draft.undo();
    else if (message.type === 'redo') session.draft.redo();
    else if (message.type === 'save') { await this.save(session); return; }
    else return;
    await this.persist(session); this.publish(session);
  }
  async open(identity) {
    const key = pageKey(identity || {});
    if (this.opening.has(key)) return this.opening.get(key);
    const operation = this.openPage(identity);
    this.opening.set(key, operation);
    try { return await operation; } finally { this.opening.delete(key); }
  }
  mount(session) {
    const title = [session.draft.model.pageName, session.identity.sourceId].filter(Boolean).join(' · ');
    const panel = this.vscode.window.createWebviewPanel('guthon.pageEditor', `${title} · 本地页面`,
      this.vscode.ViewColumn.Active, {enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [this.vscode.Uri.file(path.join(this.context.extensionPath, 'src/page-editor'))]});
    session.panel = panel; session.closed = false; session.persistedClose = false; session.published = null;
    panel.webview.onDidReceiveMessage(message => { void this.message(session, message).catch(error => this.error(session, error)); });
    panel.onDidDispose(() => {
      session.closed = true; session.closedAt = Date.now();
      void this.persist(session).catch(error => this.vscode.window.showErrorMessage(error.message));
    });
    panel.webview.html = this.html(panel.webview);
  }
  async openPage(identity) {
    if (!identity?.workspaceKey || !identity.sourceNamespace || identity.sourceType !== 'page') throw new Error('请在 SVN 源码树中选择身份完整的 PAGE');
    const key = pageKey(identity), existing = this.pages.get(key);
    if (existing) {
      const name=pageDisplayName(identity);
      if (name) {
        existing.identity.treeLabel=identity.treeLabel; existing.identity.sourceName=identity.sourceName;
        if (existing.draft.model.pageName!==name) {
          existing.draft.model.pageName=existing.draft.baseline.pageName=existing.snapshot.model.pageName=name;
          if (existing.native) void existing.native.panel.webview.postMessage({type:'nativeTitle',pageName:name,pageId:identity.sourceId});
        }
      }
      const reopening = existing.closed;
      if (reopening) this.mount(existing);
      existing.panel.reveal();
      this.publish(existing);
      if (reopening) await this.refreshComparison(existing);
      return existing;
    }
    if (this.vscode.workspace.textDocuments.some(doc => doc.isDirty && this.owns(identity, doc)))
      throw new Error('此 PAGE 的虚拟文档存在未保存输入，请先保存或保留后再打开本地页面');
    const snapshot = await this.snapshot(identity);
    const session = {identity: {...identity, workingCopyId: snapshot.workingCopyId,
      sourcePath:snapshot.sourcePath || identity.sourcePath}, snapshot,
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
    this.mount(session);
    this.publish(session);
    await this.refreshComparison(session);
    return session;
  }
  async importAssets(session) {
    this.requireResourceSwitchSafe(session);
    const selected = await this.vscode.window.showOpenDialog({canSelectFiles: false, canSelectFolders: true,
      canSelectMany: false, title: '选择包含 snapshot.json 和 guthon/ 的原版资源目录'});
    if (!selected?.length) { this.publish(session); return; }
    await this.progress('校验并导入此工作区的原版资源', async () => {
      session.resourceInfo = await this.resources.importLocal(session.identity.workspaceKey, selected[0].fsPath);
    });
    this.replaceNative(session);
    await this.showNative(session, session.resourceInfo); this.publish(session); return;
  }
  async progress(title, action) {
    return this.vscode.window.withProgress({location:this.vscode.ProgressLocation.Notification,title,cancellable:false},action);
  }
  resourceTask(session, action) {
    const key=session.identity.workspaceKey, running=this.resourceJobs.get(key);
    if (running) {
      this.onResourceOutput(key,'正在处理平台资源，已复用当前任务，请等待完成');
      return running;
    }
    const operation=Promise.resolve().then(action).catch(error=>{
      this.onResourceOutput(key,'资源操作失败：'+error.message);throw error;
    }).finally(()=>{
      this.resourceJobs.delete(key);
      for (const page of this.pages.values()) if (page.identity.workspaceKey===key) this.publish(page);
    });
    this.resourceJobs.set(key,operation);
    for (const page of this.pages.values()) if (page.identity.workspaceKey===key) this.publish(page);
    return operation;
  }
  async prepareResources(session, url) {
    const key=session.identity.workspaceKey;
    return this.progress('准备谷神原版资源',async progress=>{
      const report=message=>{session.status=message;progress?.report({message});this.onResourceOutput(key,message);this.publish(session);};
      report('开始准备平台资源：'+require('./asset-snapshot').platformEntry(url).href);
      const info=await this.resources.connect(key,url,{onProgress:report});
      report(`资源准备完成 · ${info.assets.names.size} 项 · ${(info.assets.totalBytes/1024/1024).toFixed(2)} MB · 已绑定当前工作区`);
      void this.vscode.window.showInformationMessage?.('谷神原版资源已准备并校验完成，可打开原版设计视图。');
      return info;
    });
  }
  requireResourceSwitchSafe(session) {
    if(session.busy || session.pending || session.nativeRecovery || session.native?.unconfirmed)
      throw new Error('请先确认或取消原版设置对话框，并完成当前保存检查；草稿已保留');
  }
  replaceNative(session) {
    this.requireResourceSwitchSafe(session);
    session.native?.panel.dispose();
    session.native = null;
  }
  manageResources(session) {
    return this.resourceTask(session,()=>this.manageResourceOptions(session));
  }
  async manageResourceOptions(session) {
    this.requireResourceSwitchSafe(session);
    const key=session.identity.workspaceKey;
    const cached=await this.resources.cached(key);
    const selection=await this.vscode.window.showQuickPick([
      {label:cached?'更改绑定平台并准备资源':'连接谷神平台并准备资源',action:'connect',detail:'输入此工作区的平台地址，自动下载并校验'},
      ...(cached?[{label:'检查平台资源更新',action:'check',detail:cached.platformUrl},
        {label:'选择已缓存版本 / 回退',action:'versions',detail:'保留多个版本，仅切换此工作区'}]:[]),
      {label:'导入已有本地资源包',action:'import',detail:'按来源与指纹导入运行数据目录，不影响其他工作区'},
    ],{title:`原版设计器资源 · ${key}`});
    if(!selection)return;
    let info;
    if(selection.action==='import') {await this.importAssets(session);return;}
    if(selection.action==='connect') {
      const value=await this.vscode.window.showInputBox({title:`绑定谷神平台 · ${key}`,
        prompt:'填写谷神 /guthon/index.html 地址；静态资源下载不读取浏览器登录态。若需登录或鉴权，请导入已有资源包；去平台对照需浏览器已登录',
        value:cached?.platformUrl || '',ignoreFocusOut:true,
        validateInput:value=>{try {require('./asset-snapshot').platformEntry(value);return undefined;}catch(error){return error.message;}}});
      if(!value)return;
      info=await this.prepareResources(session,value);
    } else if(selection.action==='versions') {
      const versions=await this.resources.versions(key);
      const version=await this.vscode.window.showQuickPick(versions.map(item=>({label:`${item.selected?'$(check) ':''}${item.app}`,
        description:item.build.slice(0,12),detail:item.downloadedAt || '导入的资源快照',build:item.build})),{title:`选择缓存资源 · ${key}`});
      if(!version)return;
      info=await this.resources.select(key,version.build);
    } else info=await this.progress('检查平台资源更新',progress=>this.resources.resolve(key,{forceCheck:true,onProgress:message=>{progress?.report({message});this.onResourceOutput(key,message);}}));
    if(info?.updateAvailable && selection.action==='check') {
      const choice=await this.vscode.window.showWarningMessage('平台前端构建已变化，当前工作区仍保留原资源。', '下载并切换此工作区','继续已缓存版本');
      if(choice==='下载并切换此工作区') info=await this.prepareResources(session,info.platformUrl);
      else if(choice==='继续已缓存版本') info=await this.resources.select(key,info.build);
    }
    if(!info)return;
    this.requireResourceSwitchSafe(session); session.resourceInfo=info;
    this.replaceNative(session); await this.showNative(session,info);
  }
  openNative(session) {
    return this.resourceTask(session,()=>this.showNative(session));
  }
  async showNative(session, prepared) {
    if (session.native) { session.native.panel.reveal(); return; }
    let info=prepared || await this.resources.resolve(session.identity.workspaceKey);
    if(!info) {await this.manageResourceOptions(session);return;}
    if(info.updateAvailable && !prepared && !info.upgradeAcknowledged) {
      const choice=await this.vscode.window.showWarningMessage('检测到此工作区平台构建变化。','下载并切换此工作区','继续已缓存版本');
      if(choice==='下载并切换此工作区') info=await this.prepareResources(session,info.platformUrl);
      else if(choice==='继续已缓存版本') info=await this.resources.select(session.identity.workspaceKey,info.build);
      else {session.resourceInfo=info;this.publish(session);return;}
    }
    session.resourceInfo=info;
    const assets = info.assets;
    const title = [session.draft.model.pageName, session.identity.sourceId].filter(Boolean).join(' · ');
    const panel = this.vscode.window.createWebviewPanel('guthon.nativePageDesigner', `${title} · 原版设计视图`,
      this.vscode.ViewColumn.Active, {enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [this.vscode.Uri.file(assets.root), this.vscode.Uri.file(path.join(this.context.extensionPath, 'src/page-editor'))]});
    const native = {panel, version: -1, assets, before: false}; session.native = native;
    panel.onDidDispose(() => { if (session.native === native) session.native = null; this.publish(session); });
    panel.webview.onDidReceiveMessage(message => { void (async () => {
      if (message?.type === 'nativeReady') { native.version = -1; this.publish(session); return; }
      if(message?.type==='nativeEditState') {native.unconfirmed=!!message.unconfirmed;this.publish(session);return;}
      if(message?.type==='nativeResources') {await this.manageResources(session);return;}
      if (message?.type === 'nativeManager') {
        if (session.closed) this.mount(session);
        session.panel.reveal(this.vscode.ViewColumn.Beside); this.publish(session); return;
      }
      if (message?.type === 'nativePlatform') {
        await this.vscode.commands.executeCommand('gushenCompletion.openSvnSourceInBrowser', {
          workspaceKey: session.identity.workspaceKey, object: session.identity});
        return;
      }
      if (message?.version !== session.draft.version) throw new Error('页面草稿已变化，请关闭并重开原版视图');
      if (message.type === 'nativeCompare') {
        native.before = !native.before; native.version = -1; this.publish(session); return;
      }
      if (message.type === 'nativeBaseline') {
        if (message.baseline?.pageId !== session.identity.sourceId) throw new Error('原版设计器身份无效');
        native.baseline = message.baseline; return;
      }
      if (native.before || session.blocked || session.busy || session.sourceStale || !session.snapshot.editable) throw new Error(session.blocked || '当前画面为只读基线或页面不可修改');
      if (message.type === 'nativeCandidate') {
        if (!native.baseline) throw new Error('原版设计器尚未建立基线');
        session.nativeRecovery = message.candidate;
        await this.persist(session);
        const changes = nativeChanges(native.baseline, message.candidate, native.projection.model);
        session.draft.batch(() => {
          for (const op of changes) {
            if (op.kind === 'property') session.draft.property(op.collectionPointer, op.fieldKey, op.property, op.value);
            else if (op.kind === 'order') session.draft.order(op.collectionPointer, op.fieldKeys);
            else session.draft.text(op.key, op.content);
          }
        });
        // Force a new baseline even for normalization-only confirmations.
        native.version = -1;
        session.nativeRecovery = null;
        await this.persist(session); this.publish(session);
        if (message.save) await this.save(session);
      } else if (message.type === 'nativeSave') await this.save(session);
    })().catch(error => {
      void panel.webview.postMessage({type: 'nativeError', error: error.message}); this.error(session, error);
    }); });
    panel.webview.html = await nativeHtml(assets, panel.webview, this.vscode, this.context.extensionPath, crypto.randomBytes(20).toString('hex'));
    this.publish(session);
  }
  html(webview) {
    const uri = name => escape(webview.asWebviewUri(this.vscode.Uri.file(path.join(this.context.extensionPath, 'src/page-editor', name))).toString());
    const nonce = crypto.randomBytes(20).toString('hex');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; img-src data:; connect-src 'none';">
      <link rel="stylesheet" href="${uri('editor.css')}"><title>本地页面</title></head><body>
      <header><div class="heading"><div><span class="eyebrow">GUTHON NEXUS · PAGE WORKSPACE</span><h1 id="title">本地页面</h1></div><span id="status" role="status"></span></div><p id="baseline"></p>
      <div class="toolbar"><div class="action-group" role="group" aria-label="谷神平台与设计器"><span class="group-label">谷神</span><button id="native" class="primary">原版设计视图</button><button id="manageResources">平台资源</button></div>
      <div class="action-group" role="group" aria-label="本地编辑"><span class="group-label">本地</span><button id="save">保存到本地</button><button id="undo">撤销</button><button id="redo">重做</button><button id="compare" aria-expanded="false" aria-controls="compare-menu">比较改动</button><div id="compare-menu" hidden><button id="compare-svn">与 SVN 基线比较</button><button id="compare-local">与本地保存版本比较</button></div><button id="source-merge" hidden>外部修改冲突</button><button id="exit-compare" hidden>返回当前草稿</button><button id="export">导出草稿</button><button id="reload">重新载入</button><button id="resume">恢复保存检查</button></div><input id="search" type="search" placeholder="筛选字段名称或编码" aria-label="筛选字段"></div>
      <p class="diff-legend"><span class="diff-svn">M · SVN 本地未提交</span><span class="diff-local">● · 窗口未保存</span><span id="comparison-status"></span></p>
      <p id="resources" class="resource-note"></p></header>
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
    this.disposed = true;
    for (const refresh of this.comparisonRefreshes.values()) {
      clearTimeout(refresh.timer); refresh.wake?.();
    }
    for (const session of this.pages.values()) {
      session.native?.panel.dispose();
      session.panel.dispose();
    }
    this.registrations.forEach(item => item.dispose());
  }
}
module.exports = {PageEditorController};

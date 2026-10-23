const crypto = require('node:crypto');
const path = require('node:path');
const {PageDraft} = require('./model');
const {buildOutline} = require('./outline');
const {nativeHtml} = require('./platform-assets');
const {projectNative, nativeChanges} = require('./native-model');
const {DesignerResources} = require('./resource-manager');
const {SCHEME: SVN_SCHEME, decodeIdentity, fragmentIdentity, pageDisplayName} = require('../svn/virtual-fs');

const escape = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const pageKey = identity => JSON.stringify([identity.workspaceKey, identity.sourceNamespace, identity.sourceId, identity.funId || '']);

class PageEditorController {
  constructor({vscode, context, backend, virtualFs, getTool, resources = new DesignerResources({getTool}), onSaved = async () => {}, onResourceOutput = () => {}}) {
    Object.assign(this, {vscode, context, backend, virtualFs, onSaved, onResourceOutput});
    this.resources = resources;
    this.pages = new Map(); this.opening = new Map(); this.resourceJobs = new Map();
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
    return result;
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
      && (session.busy || session.pending || session.native?.unconfirmed))
      throw new Error('请先完成页面保存检查，或确认/取消原版设置对话框，再保存代码；当前输入已保留');
  }
  async persist(session) {
    const state = {
      sourceHash: session.snapshot.sourceHash, operations: session.draft.operations(),
      pending: session.pending || null, nativeRecovery: session.nativeRecovery || null, recovery: session.recovery || null,
    };
    session.persistence = (session.persistence || Promise.resolve()).catch(() => {}).then(() =>
      this.context.workspaceState.update(session.storageKey, state));
    await session.persistence;
  }
  publish(session) {
    void session.panel.webview.postMessage({type: 'state', version: session.draft.version,
      model: session.draft.model, baseline: session.draft.baseline,
      operations: session.draft.operations(), editable: session.snapshot.editable && !session.blocked && !session.busy,
      busy: session.busy, blocked: session.blocked, recovery: session.recovery,
      resourceBusy: this.resourceJobs.has(session.identity.workspaceKey),
      codeDirty: this.vscode.workspace.textDocuments.some(doc=>doc.isDirty && this.owns(session.identity,doc)),
      status: session.status || '', sourceHash: session.snapshot.sourceHash,
      baseRevision: session.snapshot.baseRevision, pending: session.pending,
      designer: session.resourceInfo ? {app:session.resourceInfo.app,digest:session.resourceInfo.digest,
        platformUrl:session.resourceInfo.platformUrl,build:session.resourceInfo.build,message:session.resourceInfo.message,
        state:session.resourceInfo.state,updateAvailable:session.resourceInfo.updateAvailable} : null});
    const pageTitle = [session.draft.model.pageName, session.identity.sourceId].filter(Boolean).join(' · ');
    session.panel.title = `${session.draft.operations().length ? '● ' : ''}${pageTitle} · 本地页面`;
    if (session.native) session.native.panel.title = `${pageTitle} · 原版设计视图`;
    if (session.native && session.native.version !== session.draft.version) {
      const projected = session.native.before
        ? {data: JSON.parse(session.snapshot.sourceText), model: session.draft.baseline}
        : projectNative(session.snapshot, session.draft);
      Object.assign(session.native, {version: session.draft.version, projection: projected, baseline: null});
      void session.native.panel.webview.postMessage({type: 'nativeDocument', version: session.draft.version,
        data: projected.data, systemId: 'offline', before: !!session.native.before,
        pageName: session.draft.model.pageName,
        editable: session.snapshot.editable && !session.blocked && !session.native.before,
        sourceHash: session.snapshot.sourceHash, baseRevision: session.snapshot.baseRevision,
        resourceApp: session.native.assets.app, resourceDigest: session.native.assets.digest,
        resourceStatus: session.resourceInfo?.message || '', platformUrl:session.resourceInfo?.platformUrl || ''});
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
      try {
        const snapshot = await this.snapshot(session.identity), previous = session.draft;
        const draft = new PageDraft(snapshot.model);
        for (const op of previous.operations()) {
          if (op.kind === 'text') {
            const old = previous.baseline.nodes.find(item => item.pointer === op.jsonPointer);
            const fresh = draft.model.nodes.find(item => item.key === old?.key);
            if (!fresh || (fresh.content !== old.content && fresh.content !== op.content)) throw new Error('同一脚本存在两份不同修改');
            if (fresh.content !== op.content) draft.text(fresh.key, op.content);
          } else {
            const old = previous.baseline.collections.find(item => item.pointer === op.collectionPointer);
            const fresh = draft.model.collections.find(item => item.pointer === op.collectionPointer);
            if (!fresh) throw new Error('页面区域发生变化');
            if (op.kind === 'order') {
              if (JSON.stringify(old.fields.map(f=>f.key)) !== JSON.stringify(fresh.fields.map(f=>f.key))) throw new Error('字段顺序发生变化');
              draft.order(op.collectionPointer,op.fieldKeys);
            } else {
              const value = collection => collection.fields.find(f=>f.key===op.fieldKey)?.properties.find(p=>p.name===op.property)?.value;
              if (JSON.stringify(value(old)) !== JSON.stringify(value(fresh))) throw new Error('字段属性发生变化');
              draft.property(op.collectionPointer,op.fieldKey,op.property,op.value);
            }
          }
        }
        draft.version = previous.version + 1; session.snapshot = snapshot; session.draft = draft;
        session.status = '代码已通过共用编辑器保存；页面草稿已同步';
      } catch (error) { session.blocked = `${error.message}；代码已保存，页面草稿保留，请导出并比较后重新载入`; }
      await this.persist(session); this.publish(session);
    }
  }
  async save(session) {
    if (session.busy || session.blocked) throw new Error(session.blocked || '页面正在保存');
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
    session.status = '本地已保存 · 索引与差异已验证 · 平台结果待验收';
    await this.persist(session);
    try { await this.onSaved(session.identity.workspaceKey, session.snapshot.sourcePath); }
    catch (error) { session.status += ' · SCM 界面刷新失败：' + error.message; }
  }
  async message(session, message) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'ready') { this.publish(session); return; }
    if (message.type === 'manageResources') {
      await this.manageResources(session); this.publish(session); return;
    }
    if (message.type === 'configureAssets') {
      await this.resourceTask(session,()=>this.importAssets(session)); return;
    }
    if (message.type === 'export') {
      const doc = await this.vscode.workspace.openTextDocument({language: 'json', content: JSON.stringify(
        {sourceHash: session.snapshot.sourceHash, operations: session.draft.operations(), recovery: session.recovery,
          nativeRecovery: session.nativeRecovery, pending: session.pending}, null, 2)});
      await this.vscode.window.showTextDocument(doc); this.publish(session); return;
    }
    if (message.type === 'reload') {
      if (session.busy) throw new Error('页面正在保存，请稍后重新载入');
      const snapshot = await this.snapshot(session.identity);
      session.recovery = {sourceHash: session.snapshot.sourceHash, operations: session.draft.operations(),
        nativeRecovery: session.nativeRecovery, pending: session.pending, previous: session.recovery || null};
      const draft = new PageDraft(snapshot.model); draft.version = session.draft.version + 1;
      session.snapshot = snapshot; session.draft = draft; session.blocked = ''; session.nativeRecovery = null; session.pending = null;
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
    if (message.type === 'native') { await this.openNative(session); this.publish(session); return; }
    if (message.type === 'openCode' || message.type === 'diff') {
      const node = session.draft.model.nodes.find(item => item.key === message.key);
      if (!node) throw new Error('节点已变化');
      if (message.type === 'diff') await this.vscode.commands.executeCommand('gushenCompletion.showSvnDiff',
        session.identity.workspaceKey, session.snapshot.sourcePath);
      else await this.openCode(session, node);
      this.publish(session);
      return;
    }
    if (session.busy || session.blocked || !session.snapshot.editable) throw new Error(session.blocked || '页面当前不可修改');
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
    session.panel = panel; session.closed = false;
    panel.webview.onDidReceiveMessage(message => { void this.message(session, message).catch(error => this.error(session, error)); });
    panel.onDidDispose(() => { session.closed = true; void this.persist(session).catch(error => this.vscode.window.showErrorMessage(error.message)); });
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
      if (existing.closed) this.mount(existing);
      if (existing.native) existing.native.panel.reveal();
      else if (await this.resources.cached(identity.workspaceKey)) await this.openNative(existing);
      else existing.panel.reveal();
      this.publish(existing);
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
    session.recovery = recovered?.recovery;
    session.nativeRecovery = recovered?.nativeRecovery;
    if (recovered?.pending) {
      session.pending = recovered.pending; session.recovery = recovered;
      session.blocked = '上次保存结果待核对，草稿已保留；请恢复保存检查或导出草稿';
    } else if (recovered?.operations?.length) {
      if (recovered.sourceHash === snapshot.sourceHash) session.draft.restore(recovered.operations);
      else { session.recovery = recovered; session.status = '发现旧基线草稿，请导出比较；未覆盖当前页面'; }
    }
    this.pages.set(key, session);
    this.mount(session);
    try { if (await this.resources.cached(identity.workspaceKey)) await this.openNative(session); }
    catch (error) { this.error(session,error); }
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
      if(message?.type==='nativeEditState') {native.unconfirmed=!!message.unconfirmed;return;}
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
      if (native.before || session.blocked || session.busy || !session.snapshot.editable) throw new Error(session.blocked || '当前画面为只读基线或页面不可修改');
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
      <div class="action-group" role="group" aria-label="本地编辑"><span class="group-label">本地</span><button id="save">保存到本地</button><button id="undo">撤销</button><button id="redo">重做</button><button id="before">查看修改前</button><button id="export">导出草稿</button><button id="reload">重新载入</button><button id="resume">恢复保存检查</button></div><input id="search" type="search" placeholder="筛选字段名称或编码" aria-label="筛选字段"></div>
      <p id="resources" class="resource-note"></p></header>
      <main><nav id="tree" aria-label="页面结构"></nav><section id="canvas" aria-label="字段与代码管理"></section><aside id="properties"></aside></main>
      <details id="changes"><summary>上次本地保存 → 当前草稿 · 修改明细</summary><pre id="delta"></pre></details>
      <script nonce="${nonce}" src="${uri('editor.js')}"></script></body></html>`;
  }
  async saveDirty(workspaceKey) {
    for (const session of this.pages.values()) if (session.identity.workspaceKey === workspaceKey) {
      if (session.blocked) throw new Error(session.blocked);
      if (session.draft.operations().length) await this.save(session);
    }
  }
  dispose() {
    for (const session of this.pages.values()) {
      session.native?.panel.dispose();
      session.panel.dispose();
    }
    this.registrations.forEach(item => item.dispose());
  }
}
module.exports = {PageEditorController};

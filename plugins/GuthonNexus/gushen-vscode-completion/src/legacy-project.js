const path = require('node:path');
const {randomUUID} = require('node:crypto');
const { ToolJsonClient } = require('./tool-json-client');
const { SvnBackendClient } = require('./svn/backend-client');
const { SvnCatalogTreeProvider, fragmentLabel } = require('./svn/catalog-tree');
const { SvnScmManager } = require('./svn/scm-manager');
const { SvnVirtualFileSystem, SCHEME, fragmentIdentity,decodeIdentity } = require('./svn/virtual-fs');
const { SvnSourceWatcher } = require('./svn/source-watcher');
const { updateRemoteChanges } = require('./svn/remote-update');
const { ReadonlyDiffEditor } = require('./source/readonly-diff-editor');
const {SvnInheritanceView,SCHEME:SVN_INHERITANCE_SCHEME}=require('./svn/inheritance-view');
const { showPullHistory } = require('./pull-history-view');
const { createDatabaseSourceTree } = require('./database-source-tree');
const {DatabaseSourceEditor,SCHEME:DATABASE_SCHEME,databaseEditIdentity,ownsWorkcopyDocument}=require('./database-source-editor');
const { showWorkspaceSearch } = require('./workspace-search');
const { filterChildren } = require('./api/tree-filter');
const { selectUploadFiles } = require('./api/upload-review');
const { configureSourceConnection, configureSourceScope, parseSourceDatabaseUrl, validateRepositoryUrl } = require('./project-source-settings');

const categoryLabels = {page:'页面', procedure:'过程函数', 'system-script':'系统脚本', table:'表', view:'视图', skill:'Skill', public:'公共源码'};
const manifest = workspace => workspace?.sourceMode === 'svn' && workspace.checkoutLayout === 'manifest-working-copies';

function registerLegacyProjects({ vscode, context, getTool, processClient, sourceTree, getWorkspaces, getSelected, refreshProjects, runTool, getOutput, onStatus, databaseBridgeRequest, databasePublicationRequest, databasePublicationMode, reviewDatabaseUpload = selectUploadFiles }) {
  const client = new ToolJsonClient({ getTool, processClient });
  const backend = new SvnBackendClient({ getTool, processClient });
  const catalog = new SvnCatalogTreeProvider({ vscode, backend, listSvnWorkspaces: async () => {
    const selected = await getSelected();
    return manifest(selected) ? [selected] : [];
  } });
  let selected;
  const scopedScm = new SvnScmManager({ vscode, backend, onStatusChanged(key, status, workspace) {
    catalog.setStatus(key, status);
    onStatus?.(key, status, workspace);
  } });
  const documentHomes = new Map();
  const svnDiffEditor = new ReadonlyDiffEditor(vscode, 'guthon-svn-review-diff');
  const databaseDiffEditor = new ReadonlyDiffEditor(vscode, 'guthon-database-review-diff');
  const inheritedSource=new SvnInheritanceView({vscode,backend});
  const virtualFs = new SvnVirtualFileSystem({ vscode, backend, onLoaded(uri) {
    if (!documentHomes.has(uri.toString())) documentHomes.set(uri.toString(), getTool()?.toolHome);
  }, onWillSave(key, sourcePath, uri) {
    if (documentHomes.get(uri.toString()) !== getTool()?.toolHome) throw new Error('数据目录已切换，请从所属项目重新打开 SVN 源码');
    pageEditors.get('svn')?.beforeCodeSave(uri);
    watcher.suppress(key, sourcePath);
  }, onSaved: async (key, result, uri, wasInherited) => {
    if (wasInherited && result.written) await backend.reindexFile(key, result.sourcePath);
    virtualFs.invalidate(key, false, uri);
    catalog.refresh(key);
    inheritedSource.invalidate(key);
    if (selected?.workspaceKey === key) await scopedScm.refresh(selected);
  } });
  const watcher = new SvnSourceWatcher({ vscode, backend, state: context.workspaceState, onChanged: async key => {
    catalog.refresh(key);
    virtualFs.invalidate(key, true);
    inheritedSource.invalidate(key);
    if (selected?.workspaceKey === key) await scopedScm.refresh(selected);
  } });
  const productDecoration=vscode.window.createTextEditorDecorationType?.({isWholeLine:true,
    backgroundColor:new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    borderLeft:'2px solid rgba(120, 151, 181, 0.65)'});
  function decorateInheritance(editor) {
    if(!productDecoration || editor?.document.uri.scheme!==SCHEME)return;
    const fragment=virtualFs.cache.get(editor.document.uri.toString())?.inheritance;
    editor.setDecorations(productDecoration,fragment?[new vscode.Range(
      editor.document.positionAt(fragment.start),editor.document.positionAt(fragment.end))]:[]);
  }
  const subscriptions = [
    productDecoration,
    vscode.window.onDidChangeActiveTextEditor?.(decorateInheritance),
    vscode.workspace.onDidChangeTextDocument?.(event=>{
      if(event.document.uri.scheme!==SCHEME)return;
      virtualFs.trackDocumentChange(event);
      if(vscode.window.activeTextEditor?.document===event.document)decorateInheritance(vscode.window.activeTextEditor);
    }),
    vscode.workspace.registerTextDocumentContentProvider?.(SVN_INHERITANCE_SCHEME,inheritedSource),
    vscode.workspace.onDidCloseTextDocument?.(doc => documentHomes.delete(doc.uri.toString())),
    vscode.workspace.registerFileSystemProvider?.(SCHEME, virtualFs, { isCaseSensitive: true }),
    vscode.window.registerFileDecorationProvider?.(catalog),
    catalog.onDidChangeTreeData(() => sourceTree.refresh()),
  ];
  const run = (workspace, command, args, input) => client.run(workspace.workspaceKey, command, args, input);
  let databaseEditor,databaseRegistration,databaseWatch,svnCodeSaved;
  const pageEditors=new Map();
  async function databaseChangesChanged(key,paths) {
    databaseTree.refreshChanges();
    sourceTree.refresh();
    await databaseEditor?.refresh(key,paths,error=>getOutput?.()?.appendLine(`DATABASE 差异刷新：${error.message}`));
  }
  function watchDatabase(workspace) {
    const roots=workspace?.sourceMode==='database' ? [workspace.readonlyDir,workspace.workcopyDir].filter(Boolean) : [];
    const watchKey=roots.length ? JSON.stringify([getTool()?.toolHome,workspace.workspaceKey,roots]) : null;
    if(databaseWatch?.key===watchKey)return;
    databaseWatch?.dispose();databaseWatch=undefined;
    if(!watchKey || !vscode.workspace.createFileSystemWatcher || !vscode.RelativePattern)return;
    const pending=new Set();
    const pendingIndex=new Map();
    const home=getTool()?.toolHome;
    let timer,refreshTail=Promise.resolve();
    const watchers=roots.map(root=>{
      const watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root,'**/{raw.json,source.vm,source.css,*.js,*.sql,*.vm}'));
      const changed=(uri,event)=>{
        if(!within(root,uri.fsPath))return;
        pending.add(path.relative(root,uri.fsPath).split(path.sep).join('/'));
        if(root===workspace.workcopyDir && (['source.vm','source.css','source.js'].includes(path.basename(uri.fsPath))
          || path.basename(path.dirname(uri.fsPath))==='scripts' && /\.(js|sql|vm)$/i.test(uri.fsPath))) {
            if(event==='delete') pendingIndex.delete(uri.fsPath);
            else pendingIndex.set(uri.fsPath, pendingIndex.get(uri.fsPath)==='change' ? 'change' : event);
        }
        clearTimeout(timer);
        timer=setTimeout(()=>{
          const paths=new Set(pending);pending.clear();
          const events = new Map(pendingIndex);pendingIndex.clear();
          const files = [...events.keys()];
          void databaseChangesChanged(workspace.workspaceKey,paths);
          void pageEditors.get('database')?.statusChanged(workspace.workspaceKey);
          if(files.length) refreshTail=refreshTail.then(async()=>{
            try {
              if(home!==getTool()?.toolHome || databaseWatch?.key!==watchKey)return;
              const inspected = await run(workspace, 'source-direct-edit', ['inspect'], {files:files.map(path=>({path}))});
              if(home!==getTool()?.toolHome || databaseWatch?.key!==watchKey)return;
              const versions = [];
              for(const item of inspected.files) {
                  if(item.ok) versions.push({path:item.path,sourceHash:item.sourceHash});
                  else if(events.get(item.path)==='change') getOutput?.()?.appendLine(`DATABASE 工作副本索引：${item.path} · ${item.error}`);
              }
              if(!versions.length)return;
              const result = await run(workspace, 'source-direct-edit', ['refresh'], {files:versions});
              for(const item of result.files) {
                  if(!item.ok) getOutput?.()?.appendLine(`DATABASE 工作副本索引：${item.path} · ${item.error}`);
              }
            } catch(error) {
              if(error.code!=='ENOENT')getOutput?.()?.appendLine(`DATABASE 工作副本索引刷新：${error.message}`);
            }
          });
        },150);
      };
      watcher.onDidCreate(uri=>changed(uri,'create'));
      watcher.onDidChange(uri=>changed(uri,'change'));
      watcher.onDidDelete(uri=>changed(uri,'delete'));
      return watcher;
    });
    databaseWatch={key:watchKey,dispose(){clearTimeout(timer);for(const watcher of watchers)watcher.dispose();}};
  }
  async function databaseRequest(identity,action,payload) {
    const workspace=(await getWorkspaces()).find(value=>value.workspaceKey===identity.workspaceKey);
    if(workspace?.sourceMode!=='database' || workspace.root!==identity.root || identity.home!==getTool()?.toolHome)
      throw new Error('DATABASE 项目来源已变化，请重新打开源码');
    const publishing=action==='publish-preview' || action==='publish-confirm';
    if ((action==='edit-save' || publishing) && vscode.workspace.textDocuments.some(doc=>doc.isDirty &&
      (ownsWorkcopyDocument(workspace,identity,doc) || publishing && databaseEditor?.owns(identity,doc)))) {
      throw new Error('工作副本中有未保存的修改，请先保存并核对');
    }
    const {recordId,sourceId,sourcePath}=identity;
    const result = await run(workspace,'legacy-source',[action],{recordId,sourceId,sourcePath,...payload});
    if (result.receiptWarning) vscode.window.showWarningMessage(result.receiptWarning);
    return result;
  }
  function databaseCodeEditor() {
    if(!databaseEditor) {
      databaseEditor=new DatabaseSourceEditor({vscode,getTool,request:databaseRequest,
        beforeSave:uri=>pageEditors.get('database')?.beforeCodeSave(uri),
        onSave:async (uri,identity)=>{
          try {
            await databaseChangesChanged(identity.workspaceKey,new Set([identity.sourcePath]));
            await pageEditors.get('database')?.codeSaved(uri);
          }
          catch(error){vscode.window.showErrorMessage(error.message);}
        }});
      databaseRegistration=vscode.workspace.registerFileSystemProvider(DATABASE_SCHEME,databaseEditor,{isCaseSensitive:true});
    }
    return databaseEditor;
  }
  function pageEditorFor(mode) {
    if(pageEditors.has(mode))return pageEditors.get(mode);
    const {PageEditorController}=require('./page-editor/controller');
    const database=mode==='database';
    const editor=new PageEditorController({vscode,context,platformReference:false,
      baselineLabel:database?'DATABASE 只读源码':'SVN BASE',
      copySavedFragment:database ? async (identity,pointer,sourceHash)=>{
        const result=await databaseRequest(identity,'edit-read',{pointer});
        if(result.sourceHash!==sourceHash || !result.editable || typeof result.content!=='string')
          throw new Error('本地片段已变化或为继承只读内容，请重新比较');
        await vscode.env.clipboard.writeText(result.content);
      } : undefined,
      copySavedFieldBatch:database ? async (identity,fieldBatchPointer,sourceHash,baseRevision)=>{
        const result=await databaseRequest(identity,'edit-comparison',{design:true,fieldBatchPointer,sourceHash,baseRevision});
        if (result.sourceHash!==sourceHash || typeof result.clipboard!=='string')
          throw new Error('字段改动已变化，请重新比较');
        await vscode.env.clipboard.writeText(result.clipboard);
      } : undefined,
      virtualFs:database?databaseCodeEditor():{open:(identity,options)=>virtualFs.open({...identity,sourceNamespace:undefined},options)},
      ownsDocument:(identity,document)=>{
        if(database) {
          if(document.uri.scheme===DATABASE_SCHEME)return databaseCodeEditor().owns(identity,document);
          return ownsWorkcopyDocument({workcopyDir:identity.workcopyDir},identity,document);
        }
        if(document.uri.scheme==='file')return path.resolve(document.uri.fsPath)===path.resolve(identity.checkoutPath,identity.sourcePath);
        if(document.uri.scheme!==SCHEME)return false;
        const other=decodeIdentity(document.uri);
        return other.workspaceKey===identity.workspaceKey && other.sourceId===identity.sourceId
          && other.workingCopyId===identity.workingCopyId;
      },
      requestPage:async (identity,request)=>{
        if(identity.home!==getTool()?.toolHome)throw new Error('本地数据目录已切换，请重新打开页面');
        const {action,sourceHash,editToken,operations,idempotencyKey}=request;
        if(database)return databaseRequest(identity,`edit-${{open:'read',comparison:'comparison',preview:'preview',save:'save'}[action]}`,
          {design:true,sourceHash:sourceHash || editToken,operations});
        const workspace=(await getWorkspaces()).find(value=>value.workspaceKey===identity.workspaceKey);
        if(workspace?.sourceMode!=='svn' || workspace.checkoutPath!==identity.checkoutPath)
          throw new Error('SVN 项目来源已变化，请重新打开页面');
        const payload=action==='open'||action==='comparison' ? {action,sourceNamespace:identity.sourceNamespace,
          sourceId:identity.sourceId,...(sourceHash?{sourceHash}:{})} : {action,editToken,operations,...(idempotencyKey?{idempotencyKey}:{})};
        return backend.run(identity.workspaceKey,['page-editor'],payload);
      },
      onSaved:async (key,sourcePath)=>{
        if(database)return databaseChangesChanged(key,new Set([sourcePath]));
        catalog.refresh(key);virtualFs.invalidate(key,true);
        sourceTree.refresh();
      }});
    pageEditors.set(mode,editor);
    if(!database)svnCodeSaved=vscode.workspace.onDidSaveTextDocument?.(doc=>{
      if(doc.uri.scheme===SCHEME)void editor.codeSaved(doc.uri).catch(error=>vscode.window.showErrorMessage(error.message));
    });
    return editor;
  }
  async function editDatabase(workspace,item) {
    const identity=databaseEditIdentity(workspace,item,getTool()?.toolHome);
    let pointer=item.pointer;
    if (identity.sourceType==='page' && !pointer) {
      const {defaultFragment}=await databaseRequest(identity,'edit-read',{resolveDefaultFragment:true});
      if (!defaultFragment) return pageEditorFor('database').open(identity);
      pointer=defaultFragment.pointer;
    }
    return databaseCodeEditor().open({...identity,jsonPointer:pointer},{lineNumber:item.line});
  }
  function editSvnPage(workspace,object) {
    const identity={...object,workspaceKey:workspace.workspaceKey,checkoutPath:workspace.checkoutPath,
      home:getTool()?.toolHome,workingCopyId:object.workingCopyId || object.scopeEntryId};
    return pageEditorFor('svn').open(identity);
  }
  async function showDatabaseDiff(identity, result, title, editable = false) {
    const isPage = identity.sourceType === 'page';
    const models = isPage ? [result.baseContent, result.content].map(content => JSON.parse(content)) : [];
    const isService = isPage && models.every(model => String(model.pageType) === '0');
    const [before, after] = isService ? models.map(model => model.compScript ?? '')
        : isPage && !result.formattedPage ? models.map(model => JSON.stringify(model, null, 4) + '\n')
          : [result.baseContent, result.content];
    const extension = isPage && !isService ? 'json' : 'gss';
    const rightUri = editable ? await databaseCodeEditor().uriFor({
        ...identity, ...(isService ? {jsonPointer:'/compScript'} : isPage ? {formatPage:true} : {}),
    }) : undefined;
    return databaseDiffEditor.show(before, after, {
        beforeName:`baseline.${extension}`, afterName:`workcopy.${extension}`, title, rightUri,
    });
  }
  async function compareDatabaseSource(workspace,item, compareMirror = false, editable = false) {
    const identity=databaseEditIdentity(workspace,item,getTool()?.toolHome);
    const result=await databaseRequest(identity,'edit-comparison',
      {publicationDiff:identity.sourceType === 'page', compareMirror});
    if (!result.available) return vscode.window.showWarningMessage('同步镜像不可用，无法比较工作副本');
    if (!result.changed) return vscode.window.showInformationMessage('没有本地源码差异');
    const base=compareMirror?'当前同步镜像':result.trustedBaseline?'编辑基线':'当前同步镜像（历史基线未知）';
    return showDatabaseDiff(identity, result, `${identity.documentName} · ${base} ↔ Workcopy`, editable);
  }
  const databaseTree=createDatabaseSourceTree({vscode,run,sourceTree,getWorkspaces,getSelected,getTool,
    edit:editDatabase,compareSource:compareDatabaseSource,
    openCopy:(workspace,item)=>databaseCodeEditor().open(databaseEditIdentity(workspace,item,getTool()?.toolHome))});
  function sourceSettingsRequest(workspace) {
    const home = getTool()?.toolHome;
    return payload => {
      const tool = getTool();
      if (!home || tool?.toolHome !== home) throw new Error('数据目录已切换，请重新打开项目卡片或项目设置');
      return run(workspace,'workspace-source-settings',[],payload);
    };
  }

  async function login(workspace, {serverUrl, userId, password}) {
    if (!['database','svn'].includes(workspace.sourceMode) || workspace.configuration?.schemaVersion!==3) {
      throw new Error('当前项目不支持卡片登录');
    }
    if (typeof serverUrl!=='string' || typeof userId!=='string' || !userId.trim()
        || typeof password!=='string' || !password) throw new Error('请填写连接地址、用户名和密码');
    let connection;
    if (workspace.sourceMode==='database') connection=parseSourceDatabaseUrl(serverUrl);
    else {
      const error=validateRepositoryUrl(serverUrl,false);
      if(error) throw new Error(error);
      connection={repositoryUrl:serverUrl.trim()};
    }
    const request=sourceSettingsRequest(workspace);
    const current=await request({action:'show'});
    if(current?.ok!==true || current.workspaceKey!==workspace.workspaceKey || current.sourceMode!==workspace.sourceMode) {
      throw new Error('源码连接设置与当前项目不一致');
    }
    const saved=await request({action:'login',sourceMode:current.sourceMode,revision:current.revision,
      connection:{...connection,username:userId.trim(),password}});
    if(saved?.ok!==true) throw new Error('后端未确认登录和连接设置保存');
    await refreshProjects();
  }
  const report = async (value, language = 'json') => {
    const content = language === 'json' ? JSON.stringify(value, null, 2) : value;
    return vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language, content }), { preview: true });
  };

  async function pickChange(workspace) {
    const status = manifest(workspace) ? await backend.scmStatus(workspace.workspaceKey)
      : (await backend.run(workspace.workspaceKey, ['status'])).status;
    const entries = status.changes || [];
    if (!entries.length) return vscode.window.showInformationMessage('当前项目没有 SVN 本地变更');
    const choice = await vscode.window.showQuickPick(entries.map(item => ({
      label:item.path, description:item.state || item.item, item,
    })), { title: workspace.displayName + ' · SVN 本地变更' });
    if (!choice) return;
    if (manifest(workspace)) {
      const operations = [{label:'查看差异', value:'diff'}];
      if (workspace.capabilities?.['svn.revert']) operations.push({label:'审阅并撤销修改', value:'revert'});
      if (choice.item.state === 'CONFLICT' && workspace.capabilities?.['svn.edit']) {
        operations.push({label:'标记人工合并已完成', value:'resolve'});
      }
      const operation = await vscode.window.showQuickPick(operations, { title: choice.item.path });
      if (operation?.value === 'diff') return diff(workspace, choice.item.path);
      if (operation?.value === 'revert') return review(workspace, 'revert', { sourcePath: choice.item.path });
      if (operation?.value === 'resolve') return resolveConflict(workspace, choice.item.path);
      return;
    }
    return report((await backend.run(workspace.workspaceKey, ['status', '--diff'])).status.diff || '', 'diff');
  }

  async function diff(workspace, sourcePath, { remote = false, raw = false } = {}) {
    if (!sourcePath) throw new Error('请选择一个 SVN 变更文件');
    const difference = await backend.diff(workspace.workspaceKey, sourcePath, remote);
    const [before, after, readableBefore, readableAfter] = remote
      ? [difference.localContent, difference.remoteContent, difference.readableLocalContent, difference.readableRemoteContent]
      : [difference.baseContent, difference.workingContent, difference.readableBaseContent, difference.readableWorkingContent];
    if (difference.workspaceKey !== workspace.workspaceKey || difference.path !== sourcePath
      || typeof before !== 'string' || typeof after !== 'string') {
      throw new Error('SVN 差异响应与当前文件不一致或缺少源码');
    }
    const readable = !raw && readableBefore !== readableAfter
      && typeof readableBefore === 'string' && (readableBefore !== '' || before === '')
      && typeof readableAfter === 'string' && (readableAfter !== '' || after === '');
    const extension = readable ? '.md' : (path.posix.extname(sourcePath) || '.txt');
    const beforeLabel = remote ? '工作副本' : 'SVN BASE';
    const afterLabel = remote ? 'SVN HEAD' : '工作副本';
    await svnDiffEditor.show(readable ? readableBefore : before, readable ? readableAfter : after, {
      beforeName: `${beforeLabel}${extension}`,
      afterName: `${afterLabel}${extension}`,
      title: `${sourcePath} · ${readable ? 'PAGE 可读差异' : 'SVN 原始差异'} · ${beforeLabel} ↔ ${afterLabel}`,
      editorOptions: { preview: false },
    });
  }

  async function review(workspace, action, { sourcePath, workingCopyIds, scopeLabel } = {}) {
    const key = workspace.workspaceKey;
    const toolHome = getTool()?.toolHome;
    if (workingCopyIds?.length === 0) return vscode.window.showInformationMessage('当前 SVN 分组没有工作副本');
    const dirty = (vscode.workspace.textDocuments || []).some(doc => doc.isDirty &&
      (doc.uri.scheme === SCHEME && doc.uri.authority === key || doc.uri.scheme === 'file' &&
        workspace.sourceRoots?.some(root => within(root.path, doc.uri.fsPath))));
    if (dirty) throw new Error('请先保存当前 SVN 项目的草稿，再审阅文件');
    const session = await backend.run(key, ['scm-session']);
    const preview = await backend.preview(key, action, session.sessionId, { workingCopyIds });
    let candidates = (preview.candidates || []).filter(item =>
      (!sourcePath || item.path === sourcePath) && (!workingCopyIds || workingCopyIds.includes(item.workingCopyId)));
    if (preview.blockers?.length || preview.pendingDeliveries?.length) {
      await report({ blockers:preview.blockers, pendingDeliveries:preview.pendingDeliveries });
      if (preview.pendingDeliveries?.length) throw new Error('存在待核对的 SVN 提交记录，请先查看操作记录');
    }
    if (!candidates.length) return vscode.window.showInformationMessage('当前没有符合条件的 SVN 文件');
    const scope = scopeLabel ? `${workspace.displayName} · ${scopeLabel}` : workspace.displayName;
    if (sourcePath) {
      if (candidates.length !== 1) throw new Error('所选路径对应多个 SVN 候选，请刷新后重试');
    } else {
      const task = action === 'platform-save' ? '选择本次提交到 SVN 的文件' : '选择本次撤回的文件';
      const choices = await vscode.window.showQuickPick(candidates.map(item => ({
        label: item.path, description: item.workingCopyId, item,
      })), { canPickMany: true, title: `${scope} · ${task}` });
      if (!choices?.length) return;
      candidates = choices.map(choice => choice.item);
    }
    if (action === 'revert') {
      for (const candidate of candidates) await diff(workspace, candidate.path);
    }
    const ids = candidates.map(candidate => candidate.id);
    const confirmation = action === 'platform-save' ? '提交 SVN' : '撤回修改';
    let message;
    if (action === 'platform-save') {
      message = await vscode.window.showInputBox({title:'输入 SVN 提交说明',validateInput:value=>value.trim()?'':'请输入提交说明'});
      if (!message?.trim()) return;
    }
    if (await vscode.window.showWarningMessage(
      `${scope} · ${confirmation} ${ids.length} 个文件`,
      { modal: true, detail: candidates.map(candidate => candidate.path).join('\n') }, confirmation) !== confirmation) return;
    if (toolHome !== getTool()?.toolHome) throw new Error('数据目录已切换，请重新审阅 SVN 修改');
    const result = action === 'platform-save'
      ? await backend.platformSave(key, preview, ids, message)
      : await backend.revert(key, preview, ids);
    await report(result);
    await refreshProjects();
  }

  async function update(workspace, sourcePath, nodePaths) {
    const key = workspace.workspaceKey;
    const dirty = (vscode.workspace.textDocuments || []).some(doc => doc.isDirty &&
      (doc.uri.scheme === SCHEME && doc.uri.authority === key ||
       doc.uri.scheme === 'file' && workspace.sourceRoots?.some(root => within(root.path,doc.uri.fsPath))));
    if (dirty) throw new Error('请先保存当前项目相关草稿，再更新源码');
    if (workspace.sourceMode === 'database') {
      const synchronized = await runTool('sync-all', [], true, key);
      await refreshProjects();
      if (synchronized) await reviewDatabaseMerge(workspace);
      return;
    } else {
      const args = nodePaths ? ['refresh-node'] : sourcePath ? ['refresh','--path',sourcePath] : [manifest(workspace) && !workspace.scopeManifestReady ? 'sync-from-config'
        : manifest(workspace) && !workspace.workingCopies?.length ? 'init'
        : !manifest(workspace) && !workspace.index?.ready ? 'init' : 'refresh'];
      const output = getOutput();
      output.show(true);
      output.appendLine(`SVN · ${workspace.displayName} · ${args[0]} · ${workspace.checkoutPath}`);
      try {
        await backend.run(key, args, nodePaths?{paths:nodePaths}:undefined, {onOutput: value => output.append(value)});
        output.appendLine(`SVN · ${workspace.displayName} · 源码与索引已更新`);
      } catch (error) {
        output.appendLine(`SVN · ${workspace.displayName} · 更新失败：${error.message}`);
        throw error;
      }
      catalog.refresh(key);
      virtualFs.invalidate(key, true);
      inheritedSource.invalidate(key);
      vscode.window.showInformationMessage(`${workspace.displayName}：SVN 源码与索引已更新`);
    }
    await refreshProjects();
  }

  async function updateNode(workspace,item) {
    if(workspace.sourceMode==='database') {
      const payload=databaseTree.syncTarget(workspace,item);
      const output=getOutput();output.show(true);
      output.appendLine(`DATABASE · ${workspace.displayName} · 同步 ${item.label}`);
      try {
        await client.run(workspace.workspaceKey,'legacy-source',['sync-node'],payload,{
          onOutput:value=>output.append(value),timeoutMs:1800000});
      } catch(error) {output.appendLine(error.message);throw error;}
      databaseTree.refresh();
      await refreshProjects();
      if (await reviewDatabaseMerge(workspace, item)) return;
      return vscode.window.showInformationMessage(`${workspace.displayName}：源码节点已同步`);
    }
    if(!manifest(workspace))throw new Error('当前 SVN 项目没有按源码节点更新的能力');
    const node=item.svnNode;
    if(!node || node.workspaceKey!==workspace.workspaceKey)throw new Error('请重新选择当前 SVN 源码节点');
    const owner=node.object?node:node.kind==='fragment' && node.parent?.object?node.parent:node;
    const collect=element=>element.object ? [element.object.sourcePath] : element.referenceFiles
      ? element.referenceFiles.map(object=>object.sourcePath)
      : (element.children || []).flatMap(collect);
    let paths=[...new Set(collect(owner).filter(Boolean))];
    if (node.kind==='fragment' && node.command?.arguments?.[0]?.sourcePath)
      paths=[node.command.arguments[0].sourcePath];
    const scopes=owner.kind==='category' || owner.kind==='directory' && owner.parent?.kind==='category';
    if(scopes && ['pages','procedures','system-script','tables','views'].includes(owner.category || owner.parent.category)) {
      paths=[...new Set(paths.map(value=>{
        const parts=value.split('/');
        return parts.slice(0,['systems','datasources'].includes(parts[0])?3:2).join('/');
      }))];
    } else if(owner.kind==='directory' && paths.length) {
      const parent=path.posix.dirname(paths[0]);
      const leafName=path.posix.basename(parent);
      const ownerName=owner.label.split(' · ')[0];
      if(parent!=='.' && paths.every(value=>path.posix.dirname(value)===parent)
        && (ownerName===leafName || parent.endsWith('/'+ownerName.replace(/\./g,'/'))))paths=[parent];
    }
    if(!paths.length)throw new Error('当前节点没有可同步的 SVN 文件');
    return update(workspace,undefined,paths);
  }

  async function updateRemote(workspace, sourcePath, workingCopyIds) {
    if(!manifest(workspace)) throw new Error('当前 SVN 项目没有工作副本远端检查能力');
    if (workingCopyIds?.length === 0) return vscode.window.showInformationMessage('当前 SVN 分组没有工作副本');
    const key=workspace.workspaceKey;
    const output=getOutput();
    output.show(true);
    return updateRemoteChanges({
      vscode,backend,scm:scopedScm,workspace,sourcePath:sourcePath || '',workingCopyIds,
      log:message=>output.appendLine(`SVN · ${workspace.displayName} · ${message}`),
      onOutput:value=>output.append(value),
      saveDirtyDocuments:async()=>{
        const documents=vscode.workspace.textDocuments.filter(doc=>doc.isDirty
          && doc.uri.scheme===SCHEME && doc.uri.authority===key);
        if(documents.length && await vscode.window.showWarningMessage(
          `更新前先将 ${documents.length} 个 SVN 虚拟文档保存到本地工作副本？`,{modal:true},'保存并继续'
        )!=='保存并继续') return false;
        for(const doc of documents) if(!await doc.save())return false;
        await pageEditors.get('svn')?.saveDirty(key);
        return true;
      },
      onUpdated:()=>{
        catalog.refresh(key);
        virtualFs.invalidate(key,true);
        inheritedSource.invalidate(key);
      },
    });
  }

  function showInheritance(item) {
    const node=item?.svnNode,object=node?.object || node?.parent?.object;
    if(!object?.sourceNamespace)throw new Error('请选择已索引的 SVN 源码');
    return inheritedSource.open({...fragmentIdentity(node.workspaceKey,object,node.fragment),sourceNamespace:object.sourceNamespace});
  }

  async function resolveConflict(workspace, sourcePath) {
    if (!sourcePath || await vscode.window.showWarningMessage('确认已人工检查并保存合并结果',
      { modal:true }, '标记为已解决') !== '标记为已解决') return;
    await report(await backend.resolveConflict(workspace.workspaceKey, sourcePath));
    await refreshProjects();
  }

  async function openSvnChange(workspace, sourcePath, identity) {
    const sourceType = identity.get('sourceType'), sourceId = identity.get('sourceId');
    const workingCopyId = identity.get('sourceWorkingCopyId') || identity.get('workingCopyId');
    if (!sourceType || !sourceId || !workingCopyId) throw new Error('SVN 变更缺少源码身份');
    const object = {sourceType,sourceId,workingCopyId,sourcePath,funId:identity.get('funId') || ''};
    return openFragments(workspace, object);
  }

  async function openFragments(workspace, object) {
    const result = await backend.fragments(workspace.workspaceKey,object);
    const fragments = result.fragments || [];
    if (!fragments.length) {
      if(object.sourceType==='page')throw new Error('没有可打开的 SVN 源码分块');
      return virtualFs.open({...fragmentIdentity(workspace.workspaceKey,object),documentName:object.sourceName});
    }
    const fragment = fragments.length === 1 ? fragments[0] : (await vscode.window.showQuickPick(
      fragments.map(value => ({label:fragmentLabel(value),value})),{title:'选择 SVN 源码分块'}))?.value;
    if (fragment) return virtualFs.open({...fragmentIdentity(workspace.workspaceKey,object,fragment),
      ...(fragment.scriptType==='json'?{documentName:fragment.label}:{})});
  }

  async function conflict(workspace, sourcePath) {
    const value = await backend.conflict(workspace.workspaceKey,sourcePath);
    return vscode.commands.executeCommand('_open.mergeEditor', {
      base:vscode.Uri.file(value.basePath),
      input1:{uri:vscode.Uri.file(value.input1Path),title:'本地修改'},
      input2:{uri:vscode.Uri.file(value.input2Path),title:'SVN 远程修改'},
      output:vscode.Uri.file(value.resultPath),
    });
  }

  const databasePublicationLabels = {
    NOT_WRITTEN:'未保存到谷神', PLATFORM_UNKNOWN:'尚未确认谷神是否保存成功',
    MIRROR_PENDING:'谷神已保存，本地只读源码待更新', VERIFIED:'谷神与本地只读源码均已更新',
    SAVED_WITH_DIFFERENCES:'谷神已保存，本地镜像已更新，保存结果与上传候选不同',
    CLOSED_UNCHANGED:'上传记录已关闭，谷神源码仍是上传前的版本',
  };
  const mirroredDatabasePublication = result => ['VERIFIED', 'SAVED_WITH_DIFFERENCES'].includes(result?.state);
  const databasePublicationLabel = result => {
      if (result.state === 'PLATFORM_UNKNOWN' && result.platformVersion) return '谷神已返回保存版本，等待回读核对';
      if (result.state === 'MIRROR_PENDING' && result.platformDiffers) return '谷神已保存有差异的版本，本地只读源码待更新';
      return databasePublicationLabels[result.state];
  };
  const databaseUploadAvailability = {
      'bridge-stopped':'Nexus 中的 Guthon Bridge 还没启动。请在命令面板运行「Guthon Nexus: 启动 Guthon Bridge」。',
      'bridge-unreachable':'Nexus 无法通过 Guthon Bridge 检查上传。请重启桥接服务，并确认 Chrome 扩展使用同一端口和配对令牌。',
      closed:'当前 Bridge 没有启用 DATABASE 上传。使用开发模式时，请在 Nexus 中从本地源码检查更新，再重启 Guthon Bridge。',
  };
  const databaseTargetLabel = target => target.pageId
    ? target.pageAlias === target.pageId ? target.pageId : `${target.pageAlias} (${target.pageId})`
    : `${target.procedureAlias}/${target.funId}`;

  function databasePublicationMessage(result) {
    const reasons = {
      VERSION_RESERVED:'此版本已有上传记录。请在「本地修改 → 继续检查上传结果」查看原来的结果',
      DISPATCH_NOT_RECORDED:'上传在发送保存请求前中断。请重新查看差异，再确认上传',
      PLATFORM_BASE_CHANGED_OR_READONLY:'谷神源码或保存权限与确认上传时不同。请核对平台上的最新源码和签出状态',
      CHECKOUT_REQUIRED:'谷神要求当前账号签出该函数。请核对 Chrome 中登录的账号和签出状态',
      CHECKED_OUT_BY_OTHER:'这个函数已被其他账号签出。请与签出人核对，待其释放后再同步并上传',
      CHECKOUT_UNVERIFIED:'工具未能确认签出成功。请在谷神「过程函数」检查签出人和当前账号权限',
      PLATFORM_LOGIN_REQUIRED:'Chrome 已连接，但当前页签没有有效的谷神登录。请重新登录并刷新页签',
      PLATFORM_VERSION_CHANGED:'谷神上的源码版本与审阅时不同。请在源码树右键「同步此节点源码」，再查看差异',
      PLATFORM_CONTENT_CHANGED:'谷神上的源码正文与审阅时不同。请同步此节点并重新比较',
      PLATFORM_SAVE_REJECTED:`谷神拒绝保存${result.platformCode === undefined ? '' : `（返回码 ${result.platformCode}）`}，且回读确认源码未变。请核对${result.target.pageId ? '页面保存权限和页面配置' : '谷神中的签出和保存权限'}后再上传`,
      PLATFORM_BASE_UNCHANGED:result.state === 'CLOSED_UNCHANGED'
          ? '可从「上传源码」重新审阅' : '已回读谷神，当前版本和正文仍与上传前一致',
      PAGE_DRAFT_PENDING:'谷神页面设计器里还有未保存的编辑。请先处理设计器中的草稿，再同步并审阅',
      MIRROR_VERSION_CHANGED:'本地已同步到其他版本。请比较当前只读源码和本地工作副本',
      MIRROR_PATH_CHANGED:'该对象的本地源码路径已变化。请在当前项目重新查找该对象并核对同步范围',
    };
    const pending = ['PLATFORM_UNKNOWN', 'MIRROR_PENDING'].includes(result.state)
      ? '请在「本地修改 → 继续检查上传结果」选择这次上传' : '';
    const detail = [result.saveBaseVersion ? `保存前正文一致，采用谷神版本 ${result.saveBaseVersion}` : '', reasons[result.reason], pending,
      result.state === 'SAVED_WITH_DIFFERENCES' && result.workcopyState !== 'ABSENT'
        ? '请在「本地修改」比较实际保存源码和保留的 Workcopy，再处理剩余差异' : '',
      result.workcopyState === 'CONFLICT' && !result.platformDiffers ? '请比较本地工作副本和更新后的只读源码' : '',
      result.workcopyState === 'EDITED' && !result.platformDiffers ? '上传后新增的本地修改已保留' : ''].filter(Boolean).join('。');
    return [databaseTargetLabel(result.target), databasePublicationLabel(result), detail].filter(Boolean).join(' · ');
  }

  async function showDatabasePublication(result) {
      if (mirroredDatabasePublication(result)) {
          databaseTree.refreshChanges();
          sourceTree.refresh();
      }
      return vscode.window.showInformationMessage(databasePublicationMessage(result));
  }

  async function verifyDatabaseUploads(workspace) {
      const {workspaceKey} = workspace;
      const home = getTool()?.toolHome;
      const request = (route, input) => {
          if (home !== getTool()?.toolHome) throw new Error('本地数据目录已切换，请重新核对上传结果');
          return databasePublicationRequest(home, route, input);
      };
      const {operations} = await request('/databaseProcedureOperations', {workspaceKey});
      const pending = operations.filter(item => ['PLATFORM_UNKNOWN', 'MIRROR_PENDING'].includes(item.state));
      if (!pending.length) return vscode.window.showInformationMessage('这个项目没有等待检查的上传记录。');
      const selected = await vscode.window.showQuickPick(pending.map(item => ({
          label:databaseTargetLabel(item.target), description:databasePublicationLabel(item),
          detail:item.operationId, item,
      })), {title:'选择要继续检查的上传记录', canPickMany:true});
      if (!selected?.length) return;

      const results = [];
      for (const {item} of selected) {
          const {target, operationId, state} = item;
          const input = {workspaceKey, operationId};
          const outcome = {item, input};
          results.push(outcome);
          try {
              if (state === 'PLATFORM_UNKNOWN') {
                  const tab = await selectDatabaseTab(workspace, route => databaseBridgeRequest(home, route),
                      {origins:[target.origin], systemId:target.systemId, dataSourceId:target.pageId ? undefined : target.dataSourceId});
                  input.contextId = tab.contextId;
              }
              outcome.result = await request('/databaseProcedureVerify', input);
          } catch (error) {
              outcome.error = error.message;
          }
      }

      const unchanged = results.filter(({result}) => result?.state === 'PLATFORM_UNKNOWN'
          && result.reason === 'PLATFORM_BASE_UNCHANGED');
      if (unchanged.length) {
          const close = unchanged.length === 1 ? '关闭这次上传记录' : '关闭这些上传记录';
          const targets = unchanged.map(({item}) => databaseTargetLabel(item.target));
          const choice = await vscode.window.showWarningMessage(
              `谷神上有 ${targets.length} 项仍是上传前的版本和正文。是否关闭对应记录？`,
              {modal:true, detail:[...targets, '', '关闭记录只更新本地状态。之后可在「上传源码」重新审阅。'].join('\n')},
              close);
          if (choice === close) {
              for (const outcome of unchanged) {
                  try {
                      outcome.result = await request('/databaseProcedureVerify', {...outcome.input, closeUnchanged:true});
                  } catch (error) {
                      outcome.error = `未关闭上传记录 · ${error.message}`;
                  }
              }
          }
      }

      if (results.length === 1 && !results[0].error) return showDatabasePublication(results[0].result);
      if (results.some(({result}) => mirroredDatabasePublication(result))) {
          databaseTree.refreshChanges();
          sourceTree.refresh();
      }
      return report([`${workspace.displayName} · DATABASE 上传核查结果`, '',
          ...results.map(({item, result, error}) => [
              result ? databasePublicationMessage(result) : `${databaseTargetLabel(item.target)} · 未能检查`,
              error,
          ].filter(Boolean).join(' · ')),
      ].join('\n'), 'plaintext');
  }

  async function selectDatabaseTab(workspace, request, {origins, systemId, dataSourceId}) {
      const {contexts} = await request(`/pageContext?${new URLSearchParams({workspaceKey:workspace.workspaceKey})}`);
      const tabs = contexts.filter(tab => origins.includes(tab.pageOrigin));
      if (tabs.length === 1) return tabs[0];
      const preferred = tabs.filter(tab => dataSourceId === undefined
          ? tab.mode === 'page-source' && tab.systemId === systemId
          : tab.mode === 'procedure' && tab.dataSourceId === dataSourceId);
      if (preferred.length === 1) return preferred[0];
      if (tabs.length) {
          throw new Error(`Chrome 有 ${tabs.length} 个与项目平台地址匹配的页签。请保留一个已登录的谷神页签再重试。`);
      }
      if (contexts.length) {
          const connected = [...new Set(contexts.map(tab => tab.pageOrigin))].join('、');
          throw new Error(`Chrome 当前连接的是 ${connected}，这个项目使用 ${origins.join('、')}。请打开项目对应的谷神地址后重试。`);
      }
      throw new Error(`Nexus 没有收到这个项目的谷神页签。请在 Chrome 打开 ${origins.join('、')}，登录后刷新页面，并确认 Guthon Bridge 已配对。`);
  }

  async function reviewDatabaseMerge(workspace, node) {
      if (getSelected && (await getSelected())?.workspaceKey !== workspace.workspaceKey) return false;
      const {items} = await run(workspace, 'legacy-source', ['review-workcopies']);
      const candidates = items.filter(record => record.needsMerge && (!node || (node.record
          ? node.record.sourcePath === record.sourcePath
          : node.sourceType === record.sourceType && (node.groups || []).every((part, index) => record.groups?.[index] === part))));
      if (!candidates.length) return false;
      const picked = candidates.length === 1 ? {record:candidates[0]} : await vscode.window.showQuickPick(
          candidates.map(record => ({label:record.name || record.funId, detail:record.sourcePath, record})),
          {title:'与同步后的源码比较并合并'}
      );
      if (picked) await compareDatabaseSource(workspace, picked, true, true);
      return true;
  }

  async function prepareDatabaseUpload(workspace, {identity, preview}, threeWay) {
      const {system_id:systemId, data_source_id:dataSourceId} = preview.databaseIdentity;
      const key = workspace.workspaceKey;
      const isPage = identity.sourceType === 'page';
      if (!systemId) throw new Error(dataSourceId
          ? `项目同步范围无法确定数据源 ${dataSourceId} 的这个函数属于哪个子系统。请在「当前项目 → 同步范围」核对映射后重新同步。`
          : '本地配置无法确定这段源码属于哪个子系统。请在「当前项目 → 同步范围」核对子系统和数据源，然后重新同步。');
      const request = (route, payload) => {
          if (identity.home !== getTool()?.toolHome) throw new Error('本地数据目录已切换，请重新审阅');
          return databaseBridgeRequest(identity.home, route, payload);
      };
      const origins = preview.pageOrigins ?? [];
      if (!origins.length) throw new Error('这个项目还没有登记上传用的谷神地址。请在项目设置中核对项目配置，为此项目登记实际登录的地址（含协议和端口）。');
      const tab = await selectDatabaseTab(workspace, request, {origins, systemId, dataSourceId:isPage ? undefined : dataSourceId});
      const approval = {reviewId:preview.reviewId, sourceHash:preview.sourceHash, compareMirror:true};
      const input = {workspaceKey:key, contextId:tab.contextId, recordId:identity.recordId,
          sourceId:identity.sourceId, sourcePath:identity.sourcePath, ...approval};
      const {native: {latestContent, merge, ...native}} = await request('/databaseSourcePreflight', {
          ...input, includeLatest:true, threeWay,
      });
      return {identity, approval, input, native, latestContent, merge};
  }

  async function uploadDatabaseSources(workspace, records, mode) {
      if (!records.length) return vscode.window.showInformationMessage('当前项目没有已保存的本地源码修改。');
      const byPath = new Map(records.map(record => [record.sourcePath, record]));
      const platformReview = async (sourcePath, threeWay = true) => {
          if (databaseUploadAvailability[mode]) throw new Error(databaseUploadAvailability[mode]);
          const record = byPath.get(sourcePath);
          if (!record) throw new Error('上传选择不属于当前项目的修改清单');
          const identity = databaseEditIdentity(workspace, {record}, getTool()?.toolHome);
          const preview = await databaseRequest(identity, 'publish-preview', {compareMirror:true});
          return {record, preview, ...await prepareDatabaseUpload(workspace, {identity, preview}, threeWay)};
      };
      const describeConflicts = merge => {
          const labels = {collection:'集合成员或顺序', inheritance:'继承脚本', identity:'对象身份', value:'双方修改同一属性', script:'脚本修改重叠'};
          const rows = merge.conflicts.map(conflict => {
              const lines = conflict.lines?.length ? ` · 基线行 ${conflict.lines.join('、')}` : '';
              return `${conflict.path || '正文'} · ${labels[conflict.kind] || '内容冲突'}${lines}`;
          });
          const omitted = merge.conflictCount - rows.length;
          return [`发现 ${merge.conflictCount} 处三方合并冲突`, ...rows, ...(omitted > 0 ? [`另有 ${omitted} 处，打开差异继续核对`] : [])].join('\n');
      };
      const showReview = ({identity, preview, latestContent, merge}) => {
          const merged = merge?.state === 'READY';
          const compare = {
              baseContent:latestContent ?? preview.baseContent,
              content:merged ? merge.content : preview.content,
          };
          const title = `${identity.documentName} · 谷神最新源码 ↔ ${merged ? '三方合并候选' : 'Workcopy'}`;
          return showDatabaseDiff(identity, compare, title, !merged && (latestContent !== undefined || merge?.state === 'CONFLICT'));
      };
      const entries = records.map(record => ({path:record.sourcePath, name:record.name || record.funId,
          type:categoryLabels[record.sourceType], state:record.needsMerge ? '本地和谷神均有改动'
              : record.needsReview ? '历史基线未知，待核对' : '本地修改'}));
      const chosen = await reviewDatabaseUpload(vscode, entries,
          async sourcePath => {
              const review = await platformReview(sourcePath);
              await showReview(review);
              if (review.merge?.state === 'CONFLICT') await report(describeConflicts(review.merge), 'plaintext');
          }, {selectAll:records.length === 1});
      if (!chosen?.length) return;

      const ready = [];
      const outcomes = new Map();
      const paths = [...new Set(chosen)];
      for (const sourcePath of paths) {
          try {
              // Re-read the local candidate and the platform after any earlier diff was opened.
              let review = await platformReview(sourcePath);
              if (review.merge?.state === 'ALREADY_CURRENT') {
                  outcomes.set(sourcePath, '谷神已包含本地改动，无需保存');
                  continue;
              }
              if (paths.length === 1 || review.latestContent !== undefined || review.merge) await showReview(review);
              if (review.merge?.state === 'CONFLICT') {
                  const detail = describeConflicts(review.merge);
                  if (paths.length !== 1 || review.latestContent !== undefined) {
                      outcomes.set(sourcePath, `未进入本次上传 · ${detail}`);
                      continue;
                  }
                  const manual = '审阅已手动合并的 Workcopy';
                  const choice = await vscode.window.showWarningMessage('此项存在三方合并冲突',
                      {modal:true, detail:`${detail}\n\n如已在 Workcopy 中处理冲突，可单独审阅当前内容并确认上传。`}, manual);
                  if (choice !== manual) {
                      outcomes.set(sourcePath, `未进入本次上传 · ${detail}`);
                      continue;
                  }
                  review = await platformReview(sourcePath, false);
                  await showReview(review);
              }
              if (review.latestContent !== undefined && review.merge?.state !== 'READY') {
                  const reason = review.merge?.state === 'NO_BASELINE' ? '缺少可核验的共同基线。' : '';
                  throw new Error(`${reason}已打开与谷神最新源码的比较。请保留所需本地改动，合并后同步此节点并重新上传`);
              }
              ready.push(review);
          } catch (error) {
              if (paths.length === 1) throw error;
              outcomes.set(sourcePath, `未进入本次上传 · ${error.message}`);
          }
      }
      const showResults = () => report([
          `${workspace.displayName} · DATABASE 上传结果`, '',
          ...paths.flatMap(sourcePath => [sourcePath, outcomes.get(sourcePath), '']),
      ].join('\n'), 'plaintext');
      if (!ready.length) return showResults();

      const confirm = mode === 'manual' ? '保存到谷神平台' : '确认模拟上传';
      const edit = '比较并合并';
      const canEdit = paths.length === 1 && !ready[0].merge && (ready[0].record.needsMerge || ready[0].record.needsReview);
      const details = ready.flatMap(({identity, record, native, merge}) => [
          `${identity.documentName} · ${native.origin} · ${databaseTargetLabel(native)} · 谷神源码版本 ${native.version}`,
          ...(identity.sourceType === 'procedure' ? ['未签出的函数会先由当前配对账号签出。'] : []),
          ...(merge?.state === 'READY' ? [`使用共同基线 ${merge.baseVersion} 生成的三方合并候选。`]
              : record.needsMerge ? ['本地工作副本与当前同步版本有差异。请确认右侧已经合并所需改动。']
                  : record.needsReview ? ['历史基线未知。请确认要上传的改动已与当前谷神源码核对。'] : []),
      ]);
      if (outcomes.size) details.push('', ...[...outcomes].map(([sourcePath, reason]) => `${sourcePath} · ${reason}`));
      const choice = await vscode.window.showWarningMessage(
          paths.length === 1 ? `将已审阅的${ready[0].merge ? '三方合并候选' : '本地工作副本'}保存到 ${workspace.displayName}？`
              : `将 ${ready.length} 项源码保存到 ${workspace.displayName}？`,
          {modal:true, detail:details.join('\n')}, confirm, ...(canEdit ? [edit] : [])
      );
      if (choice === edit) return compareDatabaseSource(workspace, {record:ready[0].record}, true, true);
      if (choice !== confirm) return;

      let verified = false;
      for (const {identity, approval, input, native, merge} of ready) {
          try {
              await databaseRequest(identity, 'publish-confirm', approval);
          } catch (error) {
              if (paths.length === 1) throw error;
              outcomes.set(identity.sourcePath, `未发送保存请求 · ${error.message}`);
              continue;
          }
          try {
              const result = await databasePublicationRequest(identity.home, '/databaseProcedurePublish', {
                  ...input, native, confirmationId:randomUUID(),
                  ...(merge?.state === 'READY' ? {mergeReviewId:merge.reviewId} : {}),
              });
              if (paths.length === 1) return showDatabasePublication(result);
              verified ||= mirroredDatabasePublication(result);
              outcomes.set(identity.sourcePath, databasePublicationMessage(result));
          } catch (error) {
              outcomes.set(identity.sourcePath,
                  `未收到保存结果 · ${error.message}。请在「本地修改 → 继续检查上传结果」核对本次记录`);
          }
      }
      if (verified) {
          databaseTree.refreshChanges();
          sourceTree.refresh();
      }
      return showResults();
  }

  async function action(workspace, name) {
    const key = workspace.workspaceKey;
    try {
      if (name === 'pull') return await update(workspace);
      if (name === 'refresh-source-view') {
        if (manifest(workspace)) {
          catalog.refresh(key);
          if (workspace.workingCopies?.length && workspace.capabilities?.['svn.status']) await scopedScm.refresh(workspace);
        } else {
          if (workspace.sourceMode === 'database') databaseTree.refresh();
          sourceTree.refresh();
        }
        return;
      }
      if (name === 'upload' && manifest(workspace)) return await review(workspace, 'platform-save');
      if (name === 'changes' || name === 'upload') {
        if (workspace.sourceMode === 'svn') return await pickChange(workspace);
        const publicationMode = workspace.sourceMode === 'database' && databasePublicationRequest
          ? databasePublicationMode ? await databasePublicationMode(getTool()?.toolHome) : 'simulation'
          : 'closed';
        if (workspace.sourceMode === 'database') {
          const {items} = await run(workspace,'legacy-source',['review-workcopies']);
          if (name === 'upload') return await uploadDatabaseSources(workspace, items, publicationMode);
          const picked = await vscode.window.showQuickPick([
            ...items.map(record => ({label:record.name || record.funId,detail:record.sourcePath,
              description:record.needsMerge?'本地和谷神均有改动':record.needsReview?'历史基线未知，待核对':'可审阅上传',record})),
            ...(!databaseUploadAvailability[publicationMode] ? [{label:'继续检查上传结果', verify:true}] : []),
            {label:'按目录打开已有 Workcopy',description:'查看、比较或导出其他副本'},
          ], {title:`${workspace.displayName} · DATABASE 本地源码变更`});
          if (!picked) return;
          if (picked.verify) return await verifyDatabaseUploads(workspace);
          if (picked.record) {
            return await compareDatabaseSource(workspace, picked, true, true);
          }
        }
        const picked = await vscode.window.showOpenDialog({ canSelectFiles:false,canSelectFolders:true,
          defaultUri:vscode.Uri.file(workspace.workcopyDir),title:'选择当前项目的工作副本' });
        if (!picked?.length) return;
        const choice = await vscode.window.showQuickPick([
          {label:'查看状态',action:'status'}, {label:'比较 readonly 与工作副本',action:'diff'},
          {label:'生成交付材料',action:'package'},
        ], {title:workspace.displayName + ' · 工作副本'});
        if (!choice) return;
        const value = await run(workspace, 'workcopy', [choice.action,picked[0].fsPath,'--json']);
        if (value.output) return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(value.output)),{preview:true});
        return report(value);
      }
      if (name === 'history') {
        if (manifest(workspace)) {
          const chosen = await vscode.window.showQuickPick(['SVN 提交回执','源码同步记录'],{title:workspace.displayName + ' · 操作记录'});
          if (!chosen) return;
          if (chosen === 'SVN 提交回执') return report(await backend.deliveryStatus(key));
        }
        return showPullHistory({vscode,client,workspaceKey:key,workspaceRoot:workspace.root});
      }
      if (name === 'search') {
        if(workspace.sourceMode==='database')return await databaseTree.search(workspace);
        if(manifest(workspace)) {
          const picked=await showWorkspaceSearch({vscode,sourceOnly:true,sourceMode:'svn',title:`搜索当前项目 · ${workspace.displayName}`,
            search:async (text,_offset,sourceType)=>{
              const args=['find','--keyword='+text,'--limit','50'];
              if(sourceType) args.push('--source-type',sourceType);
              const result=await backend.run(key,args);
              return {truncated:result.truncated,items:result.candidates.map(item=>({kind:'source',label:item.source_name || item.fun_id || item.source_id,
                description:item.source_path,object:{sourceType:item.source_table,sourceId:item.source_id,funId:item.fun_id,
                  workingCopyId:item.working_copy_id,sourcePath:item.source_path,sourceName:item.source_name}}))};
            }});
          if(picked && (await getSelected())?.workspaceKey===key)return await openFragments(workspace,picked.item.object);
          return;
        }
        const word = await vscode.window.showInputBox({title:'搜索 '+workspace.displayName+' 的本地索引'});
        if (!word?.trim()) return;
        return report(await run(workspace,'search',['--query',word.trim()]));
      }
      if(name==='reindex') {
        if(await runTool('reindex',[],false,key)) {
          if(workspace.sourceMode==='svn')catalog.refresh(key);
          await refreshProjects();
        }
        return;
      }
      if (name === 'connection' || name === 'scope') {
        const input = workspace.configuration?.schemaVersion === 3;
        const database = workspace.sourceMode === 'database';
        const connectionCommand = sourceSettingsRequest(workspace);
        const configureScope = () => configureSourceScope({vscode,workspace,request:connectionCommand,refreshProjects});
        if (name === 'scope') {
          if (input && (database || manifest(workspace))) return await configureScope();
          return vscode.commands.executeCommand('gushenCompletion.openProjectConfiguration',key);
        }
        if (!input) return vscode.commands.executeCommand('gushenCompletion.openProjectConfiguration',key);
        return await configureSourceConnection({vscode,workspace,
          load:()=>connectionCommand({action:'show'}),save:connectionCommand,refreshProjects});
      }
      if (name === 'svn-scope' && manifest(workspace)) return report(await backend.scopePreview(key));
      if (name === 'svn-remote' && manifest(workspace) && workspace.workingCopies?.length) {
        const status=await scopedScm.refreshRemote(workspace);
        return vscode.window.showInformationMessage('已检查远端变更：'+(status?.remoteChanges?.length || 0)+' 项');
      }
      if (name === 'svn-login-cache' && manifest(workspace)) {
        const password = await vscode.window.showInputBox({ title:'输入当前配置中的 SVN 用户密码', password:true });
        if (password === undefined) return;
        await backend.cacheAuthentication(key,password);
        return vscode.window.showInformationMessage('SVN 登录已验证，可重试更新源码');
      }
      if (name === 'doctor') return vscode.commands.executeCommand('gushenCompletion.runDoctor',key);
    } catch (error) {
      return vscode.window.showErrorMessage(`${workspace.displayName}：${error.message}`);
    }
  }

  async function sync(workspace, workspaces) {
    selected = workspace;
    databaseTree.refresh();
    watchDatabase(workspace);
    const svnWorkspaces = workspaces.filter(manifest);
    watcher.sync(svnWorkspaces);
    scopedScm.syncWorkspaces(manifest(workspace) && workspace.workingCopies?.length ? [workspace] : []);
    catalog.refreshRoots();
    if (manifest(workspace) && workspace.workingCopies?.length && workspace.capabilities?.['svn.status']) {
      try { await scopedScm.refresh(workspace); }
      catch (error) { if (selected === workspace) vscode.window.showWarningMessage(`SVN 本地状态读取失败：${error.message}`); }
    }
  }

  async function children(workspace, item, filter='') {
    try {
      if (workspace.sourceMode==='database') return await databaseTree.children(workspace,item,filter);
      if (manifest(workspace) && workspace.capabilities?.['svn.browse']) {
        if (!workspace.scopeManifestReady || (!workspace.workingCopies?.length && !workspace.index?.ready)) {
          return item ? [] : [{kind:'message',label:'尚未签出源码，请先选择同步范围并更新源码'}];
        }
        const root = item?.svnNode || (await catalog.getChildren())[0];
        if (!root) return [];
        return filterChildren(await catalog.getChildren(root),filter,root).map(svnNode => ({ kind:'legacy-svn', svnNode }));
      }
      if (item && item.kind !== 'legacy-category' && item.kind !== 'legacy-next') return [];
      if (!workspace.index?.ready) return [{kind:'message',label:'本地索引尚未建立，请先更新源码'}];
      const args = ['catalog'];
      if (item) args.push('--type',item.sourceType,'--after',String(item.after || 0));
      const value = await run(workspace,'legacy-source',args);
      if (!item) return (value.categories || []).map(sourceType => ({kind:'legacy-category',label:categoryLabels[sourceType],sourceType}));
      return [...(value.items || []).map(record => ({kind:'legacy-document',label:record.name || record.funId || record.sourceId,record,workspace})),
        ...(value.next ? [{kind:'legacy-next',label:'更多',sourceType:item.sourceType,after:value.next}] : [])];
    } catch (error) {
      return [{kind:'message',label:error.message}];
    }
  }

  function treeItem(item) {
    if(item.kind?.startsWith('legacy-database-'))return databaseTree.treeItem(item);
    if (item.kind === 'legacy-svn') {
      const node = catalog.getTreeItem(item.svnNode);
      const change = catalog.provideFileDecoration(node.resourceUri);
      if (change) {
        node.iconPath = new vscode.ThemeIcon(node.iconPath.id, change.color);
        node.description = [`${change.badge} · ${change.tooltip}`, node.description].filter(Boolean).join(' · ');
      }
      return node;
    }
    const node = new vscode.TreeItem(item.label,item.kind==='legacy-document'
      ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    if (item.kind === 'legacy-document') node.command={command:'gushenCompletion.openLegacyDocument',title:'查看本地源码',arguments:[item]};
    return node;
  }

  async function locateRecords(workspace, identity) {
    const args = identity.pageId ? ['--type','page','--source-id',identity.pageId]
      : ['--type','procedure','--alias',identity.alias,'--fun-id',identity.funId];
    const result = await run(workspace,'legacy-source',['locate',...args]);
    return result.items || [];
  }

  async function procedureDefinitionUris(workspace, target, document) {
    const home = getTool()?.toolHome;
    if (!home || workspace.index?.ready === false
      || document.uri.scheme === SCHEME && documentHomes.get(document.uri.toString()) !== home) return [];
    const records = await locateRecords(workspace, target);
    if (home !== getTool()?.toolHome) return [];
    return Promise.all(records.map(async record => {
      if (workspace.sourceMode === 'database' && workspace.capabilities?.['workcopy.open']) {
        return databaseCodeEditor().uriFor(databaseEditIdentity(workspace, {record}, home));
      }
      if (manifest(workspace) && workspace.capabilities?.['svn.browse'] && record.workingCopyId) {
        return virtualFs.uriFor(fragmentIdentity(workspace.workspaceKey, record));
      }
      const source = await run(workspace,'legacy-source',['read','--record-id',String(record.recordId),'--source-id='+record.sourceId]);
      return sourceTree.readonlyUri(workspace.workspaceKey,
        `${workspace.sourceMode}/${record.sourcePath}/${record.funId}.gss`,source.content);
    }));
  }

  async function locate(workspace, identity) {
    const items = await locateRecords(workspace, identity);
    if (!items.length) throw new Error('当前项目的本地索引没有该源码，请检查同步范围');
    const record = items.length === 1 ? items[0] : (await vscode.window.showQuickPick(
      items.map(item => ({label:item.name || item.sourceId, description:item.sourcePath, item})),
      {title:'选择精确源码对象'}))?.item;
    if (!record) return;
    if (workspace.sourceMode==='database') return databaseTree.open({workspace,record},false);
    if (!manifest(workspace) || !workspace.capabilities?.['svn.browse']) return openLocal({workspace,record});
    return openFragments(workspace,record);
  }

  async function openLocal(item) {
    if(item.workspace?.sourceMode==='database')return databaseTree.open(item);
    const workspace = (await getWorkspaces()).find(value => value.workspaceKey === item.workspace?.workspaceKey);
    if (!workspace || !['database','svn'].includes(workspace.sourceMode)) throw new Error('工作区已切换，请重新选择源码');
    const record = await run(workspace,'legacy-source',['read','--record-id',String(item.record.recordId)]);
    if (record.truncated) vscode.window.showInformationMessage('本地源码预览已截断');
    return report(record.content,'plaintext');
  }

  context.subscriptions.push(...subscriptions.filter(Boolean), {dispose(){
    svnCodeSaved?.dispose();
    for(const editor of pageEditors.values())editor.dispose();
    databaseWatch?.dispose();databaseRegistration?.dispose();databaseEditor?.dispose();
    watcher.dispose();scopedScm.dispose();catalog.dispose();virtualFs.dispose();inheritedSource.dispose();svnDiffEditor.dispose();databaseDiffEditor.dispose();
  }});
  return { action, login, sync, children, treeItem, openLocal, openWorkcopy:databaseTree.workcopy,
    hasUnsavedDrafts:workspace=>!!pageEditors.get(workspace.sourceMode)?.hasUnsavedDrafts(workspace.workspaceKey,getTool()?.toolHome),
    databaseCallers:databaseTree.callers, editSvnPage,locate,procedureDefinitionUris, virtualFs, diff, conflict,updateNode,updateRemote,showInheritance,
    review, update, openSvnChange, resolveConflict,
    history:async (workspace, sourcePath) => report((await backend.history(workspace.workspaceKey,sourcePath)).xml,'xml') };
}

function within(root, target) {
  if (!root || !target) return false;
  const result = path.relative(root, target);
  return result && result !== '..' && !result.startsWith('..' + path.sep) && !path.isAbsolute(result);
}

module.exports = { registerLegacyProjects };

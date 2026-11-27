const path = require('node:path');
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
const { configureSourceConnection, configureSourceScope, parseSourceDatabaseUrl, validateRepositoryUrl } = require('./project-source-settings');

const categoryLabels = {page:'页面', procedure:'过程函数', 'system-script':'系统脚本', table:'表', view:'视图', skill:'Skill', public:'公共源码'};
const manifest = workspace => workspace?.sourceMode === 'svn' && workspace.checkoutLayout === 'manifest-working-copies';

function registerLegacyProjects({ vscode, context, getTool, processClient, sourceTree, getWorkspaces, getSelected, refreshProjects, runTool, getOutput, onStatus }) {
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
    let timer;
    const watchers=roots.map(root=>{
      const watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root,'**/{raw.json,source.vm}'));
      const changed=uri=>{
        if(!within(root,uri.fsPath))return;
        pending.add(path.relative(root,uri.fsPath).split(path.sep).join('/'));
        clearTimeout(timer);
        timer=setTimeout(()=>{
          const paths=new Set(pending);pending.clear();
          void databaseChangesChanged(workspace.workspaceKey,paths);
          void pageEditors.get('database')?.statusChanged(workspace.workspaceKey);
        },150);
      };
      watcher.onDidCreate(changed);watcher.onDidChange(changed);watcher.onDidDelete(changed);
      return watcher;
    });
    databaseWatch={key:watchKey,dispose(){clearTimeout(timer);for(const watcher of watchers)watcher.dispose();}};
  }
  async function databaseRequest(identity,action,payload) {
    const workspace=(await getWorkspaces()).find(value=>value.workspaceKey===identity.workspaceKey);
    if(workspace?.sourceMode!=='database' || workspace.root!==identity.root || identity.home!==getTool()?.toolHome)
      throw new Error('DATABASE 项目来源已变化，请重新打开源码');
    if(action==='edit-save' && vscode.workspace.textDocuments.some(doc=>doc.isDirty && ownsWorkcopyDocument(workspace,identity,doc)))
      throw new Error('工作副本中有未保存的修改，请先保存并核对');
    const {recordId,sourceId,sourcePath}=identity;
    return run(workspace,'legacy-source',[action],{recordId,sourceId,sourcePath,...payload});
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
  const databaseTree=createDatabaseSourceTree({vscode,run,sourceTree,getWorkspaces,getSelected,getTool,edit:editDatabase,
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
      await runTool('sync-all', [], true, key);
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
    watcher.dispose();scopedScm.dispose();catalog.dispose();virtualFs.dispose();inheritedSource.dispose();svnDiffEditor.dispose();
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

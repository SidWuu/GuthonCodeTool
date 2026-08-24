const path = require('node:path');
const { SvnBackendClient } = require('./backend-client');
const { SvnCatalogTreeProvider } = require('./catalog-tree');
const { SvnScmManager } = require('./scm-manager');
const { decodeIdentity, SCHEME, SvnVirtualFileSystem } = require('./virtual-fs');
const { procedureTargetAt } = require('../definition');
const { SvnSourceWatcher } = require('./source-watcher');
const { DIFF_SCHEME, SvnDiffContentProvider, showSvnDiff } = require('./diff-content');

async function selectCandidates(vscode, preview, title) {
  const selected = await vscode.window.showQuickPick(
    preview.candidates.map((candidate) => ({
      label: candidate.path,
      description: candidate.workingCopyId,
      detail: `${candidate.objectType} · ${candidate.objectId}${candidate.funId ? ` · ${candidate.funId}` : ''}`,
      candidateId: candidate.id,
    })),
    { title, canPickMany: true, matchOnDescription: true, matchOnDetail: true }
  );
  return selected?.map((item) => item.candidateId) || [];
}

function showBlockedWorkingCopies(vscode, preview) {
  const blockers = preview.blockers || [];
  if (!blockers.length) return;
  vscode.window.showWarningMessage(
    `另有 ${blockers.length} 个冲突、新增、删除或未跟踪文件仅供查看，本次不可保存或撤销。`
  );
}

function selectedWorkingCopyCount(preview, candidateIds) {
  const selected = new Set(candidateIds);
  return new Set(
    preview.candidates
      .filter((candidate) => selected.has(candidate.id))
      .map((candidate) => candidate.workingCopyId)
  ).size;
}

function referenceTarget(document, position) {
  const invoked = procedureTargetAt(document.getText(), document.offsetAt(position));
  if (invoked) return { alias: invoked.alias, funId: invoked.fun };
  const identity = decodeIdentity(document.uri);
  if (identity.sourceType !== 'procedure' || !identity.funId) return undefined;
  const suffix = `#${identity.funId}`;
  const alias = identity.sourceId.endsWith(suffix)
    ? identity.sourceId.slice(0, -suffix.length)
    : '';
  return alias ? { alias, funId: identity.funId } : undefined;
}

function resolveSourcePath(workspaces, element) {
  const sourceElement = sourceModuleElement(element);
  const workspaceKey = String(sourceElement?.workspaceKey || '');
  const sourcePath = String(sourceElement?.object?.sourcePath || '');
  const workspace = workspaces.find((item) => item.workspaceKey === workspaceKey);
  if (!workspace?.checkoutPath) throw new Error(`找不到 SVN 项目：${workspaceKey}`);
  if (!sourcePath || path.isAbsolute(sourcePath)) throw new Error('源码模块缺少有效的相对路径');
  const checkoutRoot = path.resolve(workspace.checkoutPath);
  const resolved = path.resolve(checkoutRoot, ...sourcePath.split('/'));
  const relative = path.relative(checkoutRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('源码文件超出当前 SVN checkout');
  }
  return resolved;
}

function sourceModuleElement(element) {
  let current = element;
  while (current && !current.object) current = current.parent;
  return current?.object ? current : undefined;
}

async function runFocusedTreeCommand(vscode, command) {
  await vscode.commands.executeCommand('gushenCompletion.svnSourceView.focus');
  return vscode.commands.executeCommand(command);
}

function activeSourceIdentity(workspaces, document) {
  if (!document?.uri) return undefined;
  if (document.uri.scheme === SCHEME) return decodeIdentity(document.uri);
  if (document.uri.scheme !== 'file') return undefined;
  const filePath = path.resolve(document.uri.fsPath);
  for (const workspace of workspaces) {
    if (!workspace.checkoutPath) continue;
    const checkoutRoot = path.resolve(workspace.checkoutPath);
    const relative = path.relative(checkoutRoot, filePath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return {
        workspaceKey: workspace.workspaceKey,
        sourcePath: relative.split(path.sep).join('/'),
        jsonPointer: '',
      };
    }
  }
  return undefined;
}

function activateSvn({ vscode, context, getTool, getEnvironment, listSvnWorkspaces, onToolTreeChanged }) {
  const backend = new SvnBackendClient({ getTool, getEnvironment });
  const scm = new SvnScmManager({ vscode, backend });
  const catalogTree = new SvnCatalogTreeProvider({ vscode, backend, listSvnWorkspaces });
  const diffContent = new SvnDiffContentProvider({ vscode });
  async function refreshWorkspaceScm(workspaceKey) {
    const workspace = (await listSvnWorkspaces()).find((item) => item.workspaceKey === workspaceKey);
    if (!workspace) return undefined;
    return scm.refresh(workspace);
  }
  async function saveDirtyDocuments(workspaceKey, actionLabel) {
    const documents = vscode.workspace.textDocuments.filter(
      (document) => document.uri.scheme === SCHEME
        && document.uri.authority === workspaceKey
        && document.isDirty
    );
    if (!documents.length) return true;
    const confirmed = await vscode.window.showWarningMessage(
      `${actionLabel}前需要先保存 ${documents.length} 个 SVN 虚拟文档到本地 checkout。`,
      { modal: true },
      '全部保存并继续'
    );
    if (confirmed !== '全部保存并继续') return false;
    for (const document of documents) {
      if (!await document.save()) return false;
    }
    return true;
  }
  let sourceWatcher;
  const virtualFs = new SvnVirtualFileSystem({
    vscode,
    backend,
    onWillSave: (workspaceKey, sourcePath) => sourceWatcher?.suppress(workspaceKey, sourcePath),
    onSaved: (workspaceKey, result, uri) => {
      catalogTree.refresh(workspaceKey);
      virtualFs.invalidate(workspaceKey, false, uri);
      if (!scm.applySaved(result)) {
        refreshWorkspaceScm(workspaceKey).catch((error) => {
          vscode.window.showWarningMessage(`SVN 源码已保存，但 SCM 刷新失败：${error.message}`);
        });
      }
      onToolTreeChanged?.();
    },
  });
  sourceWatcher = new SvnSourceWatcher({
    vscode,
    backend,
    onChanged: async (workspaceKey, result) => {
      catalogTree.refresh(workspaceKey);
      virtualFs.invalidate(workspaceKey, true);
      try {
        await refreshWorkspaceScm(workspaceKey);
      } catch (error) {
        vscode.window.showWarningMessage(`SVN 原文件变化后 SCM 刷新失败：${error.message}`);
      }
      onToolTreeChanged?.();
      if (result?.stale || result?.ok === false) {
        vscode.window.showWarningMessage(
          `SVN 原文件变化已识别，但索引保留为 stale：${result.sourcePath}`
        );
      }
    },
  });

  const treeView = vscode.window.createTreeView('gushenCompletion.svnSourceView', {
    treeDataProvider: catalogTree,
  });
  const fileSystemRegistration = vscode.workspace.registerFileSystemProvider(SCHEME, virtualFs, {
    isCaseSensitive: true,
    isReadonly: false,
  });
  const diffContentRegistration = vscode.workspace.registerTextDocumentContentProvider(
    DIFF_SCHEME,
    diffContent
  );
  const definitionRegistration = vscode.languages.registerDefinitionProvider(
    [{ scheme: SCHEME, language: 'java' }, { scheme: SCHEME, language: 'javascript' }],
    {
      async provideDefinition(document, position) {
        const target = procedureTargetAt(document.getText(), document.offsetAt(position));
        if (!target) return undefined;
        const result = await backend.definition(document.uri.authority, target.alias, target.fun);
        if (!result.definition) return undefined;
        const uri = virtualFs.uriFor({
          workspaceKey: document.uri.authority,
          sourceType: result.definition.sourceType,
          sourceId: result.definition.sourceId,
          funId: result.definition.funId || '',
          jsonPointer: '',
        });
        return new vscode.Location(uri, new vscode.Position(0, 0));
      },
    }
  );
  const referenceRegistration = vscode.languages.registerReferenceProvider(
    [{ scheme: SCHEME, language: 'java' }, { scheme: SCHEME, language: 'javascript' }],
    {
      async provideReferences(document, position) {
        const target = referenceTarget(document, position);
        if (!target) return [];
        const result = await backend.callers(document.uri.authority, target.alias, target.funId);
        return result.callers.map((caller) => {
          const uri = virtualFs.uriFor({
            workspaceKey: document.uri.authority,
            sourceType: caller.source_table,
            sourceId: caller.source_id,
            funId: caller.fun_id || '',
            jsonPointer: caller.json_path?.startsWith('/') ? caller.json_path : '',
          });
          return new vscode.Location(
            uri,
            new vscode.Position(Math.max(0, Number(caller.line_no || 1) - 1), 0)
          );
        });
      },
    }
  );

  const withError = (action) => async (...args) => {
    try {
      return await action(...args);
    } catch (error) {
      return vscode.window.showErrorMessage(`Guthon Nexus SVN：${error.message}`);
    }
  };
  const workspaceKeyOf = (value) => {
    if (typeof value === 'string') return value;
    const id = value?.id || value?.sourceControl?.id || '';
    return id.startsWith('guthon-svn-') ? id.slice('guthon-svn-'.length) : '';
  };
  const changeIdentity = (workspaceOrResource, sourcePath) => {
    if (typeof workspaceOrResource === 'string') return { workspaceKey: workspaceOrResource, sourcePath };
    const resourceUri = workspaceOrResource?.resourceUri;
    const params = new URLSearchParams(resourceUri?.query || '');
    return { workspaceKey: resourceUri?.authority || '', sourcePath: params.get('path') || '' };
  };
  const revealSourceFile = async (element) => {
    const sourcePath = resolveSourcePath(await listSvnWorkspaces(), element);
    const uri = vscode.Uri.file(sourcePath);
    await vscode.workspace.fs.stat(uri);
    return vscode.commands.executeCommand('revealInExplorer', uri);
  };
  const manageChanges = async (workspaceValue, requestedAction) => {
    const workspaceKey = workspaceKeyOf(workspaceValue);
    if (!workspaceKey) throw new Error('无法解析 SVN 项目');
    if (!await saveDirtyDocuments(workspaceKey, '管理本地源码变更')) return undefined;
    const current = await refreshWorkspaceScm(workspaceKey);
    if (!current?.changes?.length) {
      return vscode.window.showInformationMessage('当前项目没有本地 SVN 源码变更');
    }
    const action = requestedAction || (await vscode.window.showQuickPick(
      [
        { label: '查看差异', description: '选择一个文件查看 SVN BASE 与工作副本差异', value: 'diff' },
        { label: '保存到谷神（SVN提交）', description: '可多选或全选，并按 working copy 分组保存', value: 'platform-save' },
        { label: '放弃本地修改', description: '可多选或全选，恢复为 SVN BASE', value: 'revert' },
      ],
      { title: '管理本地源码变更' }
    ))?.value;
    if (!action) return undefined;
    if (action === 'diff') {
      const selected = await vscode.window.showQuickPick(
        current.changes.filter((change) => change.diffable).map((change) => ({
          label: change.path,
          description: `${change.workingCopyId} · ${change.state}`,
          change,
        })),
        { title: '选择一个本地修改查看差异', matchOnDescription: true }
      );
      if (!selected) return undefined;
      const result = await backend.diff(workspaceKey, selected.change.path);
      return showSvnDiff(vscode, diffContent, result);
    }
    const preview = await backend.preview(workspaceKey, action, current.sessionId);
    showBlockedWorkingCopies(vscode, preview);
    const isSave = action === 'platform-save';
    const candidateIds = await selectCandidates(
      vscode,
      preview,
      isSave ? '选择要保存到谷神的物理文件' : '选择要放弃的物理文件'
    );
    if (!candidateIds.length) return undefined;
    const workingCopyCount = selectedWorkingCopyCount(preview, candidateIds);
    if (isSave) {
      const message = scm.inputMessage(workspaceKey) || await vscode.window.showInputBox({
        title: '保存到谷神（SVN提交）',
        prompt: '输入 SVN 提交说明',
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? undefined : '提交说明不能为空',
      });
      if (!message?.trim()) return undefined;
      const confirmed = await vscode.window.showWarningMessage(
        `将保存 ${candidateIds.length} 个文件，分为 ${workingCopyCount} 次 SVN 提交；谷神平台仍需最终提交。`,
        { modal: true },
        '保存到谷神'
      );
      if (confirmed !== '保存到谷神') return undefined;
      const result = await backend.platformSave(workspaceKey, preview, candidateIds, message.trim());
      scm.clearInput(workspaceKey);
      catalogTree.refresh(workspaceKey);
      virtualFs.invalidate(workspaceKey);
      await refreshWorkspaceScm(workspaceKey);
      onToolTreeChanged?.();
      return vscode.window.showInformationMessage(
        `已保存到谷神 · ${result.groups.length} 个 working copy · revision ${result.revisions.join('、')} · 待谷神平台最终提交`
      );
    }
    const confirmed = await vscode.window.showWarningMessage(
      `将放弃 ${candidateIds.length} 个文件、涉及 ${workingCopyCount} 个 working copy 的本地 SVN 修改，该操作不可撤销。`,
      { modal: true },
      '放弃修改'
    );
    if (confirmed !== '放弃修改') return undefined;
    await backend.revert(workspaceKey, preview, candidateIds);
    catalogTree.refresh(workspaceKey);
    virtualFs.invalidate(workspaceKey, true);
    await refreshWorkspaceScm(workspaceKey);
    onToolTreeChanged?.();
    return vscode.window.showInformationMessage(`已放弃 ${candidateIds.length} 个文件的本地修改`);
  };

  const commands = [
    vscode.commands.registerCommand('gushenCompletion.openSvnDocument', withError((identity) =>
      virtualFs.open(identity))),
    vscode.commands.registerCommand('gushenCompletion.revealSvnSourceFile', withError(revealSourceFile)),
    vscode.commands.registerCommand('gushenCompletion.jumpSelectedSvnSource', withError(async () => {
      const element = sourceModuleElement(treeView.selection[0]);
      if (!element) throw new Error('请先选择一个 SVN 源码模块或其方法、字段、SQL 节点');
      return revealSourceFile(element);
    })),
    vscode.commands.registerCommand('gushenCompletion.locateActiveSvnSource', withError(async () => {
      const workspaces = await listSvnWorkspaces();
      const identity = activeSourceIdentity(workspaces, vscode.window.activeTextEditor?.document);
      if (!identity) throw new Error('当前编辑器不是已登记的 SVN 源码');
      const element = await catalogTree.locate(identity);
      if (!element) throw new Error('当前源码不在“谷神源码”树中');
      return treeView.reveal(element, { focus: true, select: true, expand: false });
    })),
    vscode.commands.registerCommand('gushenCompletion.expandSelectedSvnSource', withError(() =>
      runFocusedTreeCommand(vscode, 'list.expand'))),
    vscode.commands.registerCommand('gushenCompletion.collapseSelectedSvnSource', withError(() =>
      runFocusedTreeCommand(vscode, 'list.collapse'))),
    vscode.commands.registerCommand('gushenCompletion.searchSvnSource', withError(() =>
      runFocusedTreeCommand(vscode, 'list.find'))),
    vscode.commands.registerCommand('gushenCompletion.refreshSvnSourceView', withError(async (workspaceKey) => {
      catalogTree.refresh(workspaceKey);
      if (workspaceKey) virtualFs.invalidate(workspaceKey, true);
      const workspaces = await listSvnWorkspaces();
      if (workspaceKey) {
        const workspace = workspaces.find((item) => item.workspaceKey === workspaceKey);
        if (workspace) await scm.refresh(workspace);
      } else {
        for (const workspace of workspaces) virtualFs.invalidate(workspace.workspaceKey, true);
        await scm.refreshAll(workspaces);
      }
    })),
    vscode.commands.registerCommand('gushenCompletion.refreshSvnScm', withError(async (workspaceValue) => {
      const workspaceKey = workspaceKeyOf(workspaceValue);
      const workspaces = await listSvnWorkspaces();
      const selected = workspaceKey
        ? workspaces.filter((item) => item.workspaceKey === workspaceKey)
        : workspaces;
      await scm.refreshAll(selected);
    })),
    vscode.commands.registerCommand('gushenCompletion.showSvnDiff', withError(async (workspaceKey, sourcePath) => {
      const result = await backend.diff(workspaceKey, sourcePath);
      return showSvnDiff(vscode, diffContent, result);
    })),
    vscode.commands.registerCommand('gushenCompletion.showSvnHistory', withError(async (
      workspaceValue,
      sourcePathValue
    ) => {
      const { workspaceKey, sourcePath } = changeIdentity(workspaceValue, sourcePathValue);
      if (!workspaceKey || !sourcePath) throw new Error('无法解析 SVN 历史目标');
      const result = await backend.history(workspaceKey, sourcePath);
      const document = await vscode.workspace.openTextDocument({ language: 'xml', content: result.xml });
      return vscode.window.showTextDocument(document, { preview: true });
    })),
    vscode.commands.registerCommand('gushenCompletion.manageSvnChanges', withError(manageChanges)),
    vscode.commands.registerCommand('gushenCompletion.revertSvnChanges', withError((workspaceValue) =>
      manageChanges(workspaceValue, 'revert'))),
    vscode.commands.registerCommand('gushenCompletion.saveSvnToGuthon', withError((workspaceValue) =>
      manageChanges(workspaceValue, 'platform-save'))),
  ];

  async function refresh() {
    catalogTree.refresh();
    const workspaces = await listSvnWorkspaces();
    for (const workspace of workspaces) virtualFs.invalidate(workspace.workspaceKey, true);
    const statuses = await scm.refreshAll(workspaces);
    sourceWatcher.sync(workspaces);
    return statuses;
  }

  const disposable = {
    dispose() {
      treeView.dispose();
      fileSystemRegistration.dispose();
      diffContentRegistration.dispose();
      definitionRegistration.dispose();
      referenceRegistration.dispose();
      for (const command of commands) command.dispose();
      virtualFs.dispose();
      diffContent.dispose();
      sourceWatcher.dispose();
      catalogTree.dispose();
      scm.dispose();
    },
  };
  context.subscriptions.push(disposable);
  refresh().catch(() => {});
  return { backend, catalogTree, refresh, saveDirtyDocuments, scm, virtualFs };
}

module.exports = {
  activeSourceIdentity,
  activateSvn,
  referenceTarget,
  resolveSourcePath,
  runFocusedTreeCommand,
  selectCandidates,
  showBlockedWorkingCopies,
  sourceModuleElement,
};

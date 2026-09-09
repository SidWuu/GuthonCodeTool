const path = require('node:path');
const { SvnBackendClient } = require('./backend-client');
const { SvnCatalogTreeProvider } = require('./catalog-tree');
const { SvnScmManager, workspaceKeyFromSourceControlId } = require('./scm-manager');
const { decodeIdentity, SCHEME, SvnVirtualFileSystem } = require('./virtual-fs');
const { procedureTargetAt } = require('../definition');
const { SvnSourceWatcher } = require('./source-watcher');
const {
  DIFF_SCHEME,
  SvnDiffContentProvider,
  SvnQuickDiffProvider,
  revertQuickDiffChange,
  showSvnDiff,
} = require('./diff-content');

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

function notifyInformation(vscode, message) {
  // Do not return VS Code's notification Thenable: claimed SVN operations must release immediately.
  void vscode.window.showInformationMessage(message);
}

function selectedWorkingCopyCount(preview, candidateIds) {
  const selected = new Set(candidateIds);
  return new Set(
    preview.candidates
      .filter((candidate) => selected.has(candidate.id))
      .map((candidate) => candidate.workingCopyId)
  ).size;
}

function nexusCandidateIds(preview, sourcePath = '', workingCopyIds = []) {
  const selectedWorkingCopies = new Set(workingCopyIds || []);
  const selectedPaths = new Set(
    (Array.isArray(sourcePath) ? sourcePath : [sourcePath]).filter(Boolean)
  );
  return (preview.candidates || [])
    .filter((candidate) => (
      candidate.sessionManaged
      && (!selectedPaths.size || selectedPaths.has(candidate.path))
      && (!selectedWorkingCopies.size || selectedWorkingCopies.has(candidate.workingCopyId))
    ))
    .map((candidate) => candidate.id);
}

function openSvnConflictMerge(vscode, conflict) {
  return vscode.commands.executeCommand('_open.mergeEditor', {
    base: vscode.Uri.file(conflict.basePath),
    input1: { uri: vscode.Uri.file(conflict.input1Path), title: '本地修改' },
    input2: { uri: vscode.Uri.file(conflict.input2Path), title: 'SVN 远程修改' },
    output: vscode.Uri.file(conflict.resultPath),
  });
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

function activateSvn({
  vscode,
  context,
  getTool,
  listSvnWorkspaces,
  onToolTreeChanged,
  claimOperation,
}) {
  const operationOutput = vscode.window.createOutputChannel('GuthonCodeTool');
  const log = (operation, message) => {
    operationOutput.show(true);
    operationOutput.appendLine(`[Nexus SVN] ${operation}｜${message}`);
  };
  const streamBackendOutput = (value) => {
    if (!value) return;
    operationOutput.show(true);
    operationOutput.append(String(value));
  };
  const backendOutput = { onOutput: streamBackendOutput };
  const backend = new SvnBackendClient({ getTool });
  const catalogTree = new SvnCatalogTreeProvider({ vscode, backend, listSvnWorkspaces });
  const diffContent = new SvnDiffContentProvider({ vscode });
  const quickDiff = new SvnQuickDiffProvider({ vscode, backend, contentProvider: diffContent });
  const scm = new SvnScmManager({
    vscode,
    backend,
    quickDiffProvider: quickDiff,
    onStatusChanged: (workspaceKey, status) => catalogTree.setStatus(workspaceKey, status),
  });
  async function refreshWorkspaceScm(workspaceKey, options = {}) {
    const workspace = (await listSvnWorkspaces()).find((item) => item.workspaceKey === workspaceKey);
    if (!workspace) return undefined;
    return scm.refresh(workspace, options);
  }
  async function saveDirtyDocuments(workspaceKey, actionLabel, operation = '') {
    const documents = vscode.workspace.textDocuments.filter(
      (document) => document.uri.scheme === SCHEME
        && document.uri.authority === workspaceKey
        && document.isDirty
    );
    if (!documents.length) {
      if (operation) log(operation, '未发现未保存的 SVN 虚拟文档');
      return true;
    }
    if (operation) log(operation, `发现 ${documents.length} 个未保存的 SVN 虚拟文档`);
    const confirmed = await vscode.window.showWarningMessage(
      `${actionLabel}前需要先保存 ${documents.length} 个 SVN 虚拟文档到本地 checkout。`,
      { modal: true },
      '全部保存并继续'
    );
    if (confirmed !== '全部保存并继续') return false;
    for (const document of documents) {
      if (operation) log(operation, `保存虚拟文档 · ${document.uri.path || document.uri.toString()}`);
      if (!await document.save()) return false;
    }
    if (operation) log(operation, '虚拟文档已保存到本地 checkout');
    return true;
  }
  let sourceWatcher;
  const virtualFs = new SvnVirtualFileSystem({
    vscode,
    backend,
    onWillSave: (workspaceKey, sourcePath) => sourceWatcher?.suppress(workspaceKey, sourcePath),
    onOutput: streamBackendOutput,
    onSaved: (workspaceKey, result, uri) => {
      catalogTree.refresh(workspaceKey);
      virtualFs.invalidate(workspaceKey, false, uri);
      const savedIdentity = decodeIdentity(uri);
      if (!scm.applySaved({ ...result, ...savedIdentity })) {
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
    onOutput: streamBackendOutput,
  });

  const treeView = vscode.window.createTreeView('gushenCompletion.svnSourceView', {
    treeDataProvider: catalogTree,
  });
  const fileDecorationRegistration = vscode.window.registerFileDecorationProvider(catalogTree);
  const fileSystemRegistration = vscode.workspace.registerFileSystemProvider(SCHEME, virtualFs, {
    isCaseSensitive: true,
    isReadonly: false,
  });
  const diffContentRegistration = vscode.workspace.registerTextDocumentContentProvider(
    DIFF_SCHEME,
    diffContent
  );
  const definitionRegistration = vscode.languages.registerDefinitionProvider(
    [{ scheme: SCHEME, language: 'guthon-gss' }, { scheme: SCHEME, language: 'java' }, { scheme: SCHEME, language: 'javascript' }],
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
    [{ scheme: SCHEME, language: 'guthon-gss' }, { scheme: SCHEME, language: 'java' }, { scheme: SCHEME, language: 'javascript' }],
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
      void vscode.window.showErrorMessage(`Guthon Nexus SVN：${error.message}`);
      return undefined;
    }
  };
  const firstResource = (value) => (Array.isArray(value) ? value[0] : value);
  const resourceList = (value) => (Array.isArray(value) ? value.flat().filter(Boolean) : [value].filter(Boolean));
  const singleResource = (value) => {
    if (Array.isArray(value) && value.length !== 1) {
      throw new Error('单文件操作一次只能选择一个 SVN 文件');
    }
    return firstResource(value);
  };
  const resourceUriOf = (value) => {
    const resource = firstResource(value);
    return resource?.resourceUri || (resource?.scheme ? resource : undefined);
  };
  const workspaceKeyOf = (value) => {
    if (typeof value === 'string') return value;
    const resource = firstResource(value);
    if (resource?.guthonWorkspaceKey) return resource.guthonWorkspaceKey;
    const id = resource?.id || resource?.sourceControl?.id || '';
    const providerWorkspaceKey = workspaceKeyFromSourceControlId(id);
    if (providerWorkspaceKey) return providerWorkspaceKey;
    return resourceUriOf(resource)?.authority || '';
  };
  const runClaimed = async (workspaceKey, action) => {
    const claimKey = workspaceKey || '__all__';
    const release = claimOperation ? claimOperation(claimKey, 'Nexus SVN 源码操作') : undefined;
    if (claimOperation && !release) return false;
    try {
      return await action();
    } finally {
      release?.();
    }
  };
  const runClaimedValue = (workspaceValue, action) => (
    runClaimed(workspaceKeyOf(workspaceValue), () => action(workspaceValue))
  );
  const workingCopyIdsOf = (value) => {
    const resource = firstResource(value);
    return Array.isArray(resource?.guthonWorkingCopyIds)
      ? resource.guthonWorkingCopyIds.filter(Boolean)
      : [];
  };
  const scopedBackendOptions = (workingCopyIds) => {
    const selected = [...new Set((workingCopyIds || []).filter(Boolean))];
    return selected.length ? { ...backendOutput, workingCopyIds: selected } : backendOutput;
  };
  const changeIdentity = (workspaceOrResource, sourcePath) => {
    if (typeof workspaceOrResource === 'string') return { workspaceKey: workspaceOrResource, sourcePath };
    const resourceUri = resourceUriOf(workspaceOrResource);
    const params = new URLSearchParams(resourceUri?.query || '');
    return {
      workspaceKey: resourceUri?.authority || '',
      sourcePath: params.get('path') || '',
      state: params.get('state') || '',
      workingCopyId: params.get('workingCopyId') || '',
      sourceType: params.get('sourceType') || '',
      sourceId: params.get('sourceId') || '',
      funId: params.get('funId') || '',
      documentName: params.get('documentName') || '',
      jsonPointer: params.get('jsonPointer') || '',
    };
  };
  const revealSourceFile = async (element) => {
    const sourcePath = resolveSourcePath(await listSvnWorkspaces(), element);
    const uri = vscode.Uri.file(sourcePath);
    await vscode.workspace.fs.stat(uri);
    return vscode.commands.executeCommand('revealInExplorer', uri);
  };
  const completePlatformSave = async (workspaceKey, preview, candidateIds) => {
    const operation = '提交 Nexus 修改';
    const workingCopyCount = selectedWorkingCopyCount(preview, candidateIds);
    const message = (scm.inputMessage(workspaceKey) || '').trim();
    log(operation, `准备提交 ${candidateIds.length} 个文件，涉及 ${workingCopyCount} 个 working copy`);
    const confirmed = await vscode.window.showWarningMessage(
      `将保存 ${candidateIds.length} 个文件，分为 ${workingCopyCount} 次 SVN 提交；谷神平台仍需最终提交。`,
      { modal: true },
      '保存到谷神'
    );
    if (confirmed !== '保存到谷神') return undefined;
    log(operation, '已确认，开始按 working copy 执行 SVN commit');
    const result = await backend.platformSave(
      workspaceKey,
      preview,
      candidateIds,
      message,
      backendOutput
    );
    log(operation, 'SVN commit 完成，刷新源码树、虚拟文档和 SCM 状态');
    scm.clearInput(workspaceKey);
    catalogTree.refresh(workspaceKey);
    virtualFs.invalidate(workspaceKey);
    await refreshWorkspaceScm(workspaceKey, backendOutput);
    onToolTreeChanged?.();
    log(operation, `完成 · ${result.groups.length} 个 working copy · revision ${result.revisions.join('、')}`);
    notifyInformation(vscode,
      `已保存到谷神 · ${result.groups.length} 个 working copy · revision ${result.revisions.join('、')} · 待谷神平台最终提交`
    );
  };
  const saveNexusChanges = async (workspaceValue, sourcePathValue) => {
    const operation = '提交 Nexus 修改';
    const resources = resourceList(workspaceValue);
    const identities = resources.map((resource) => changeIdentity(resource));
    const workspaceKeys = new Set(identities.map((item) => item.workspaceKey).filter(Boolean));
    if (workspaceKeys.size > 1) throw new Error('所选文件必须属于同一个 SVN 项目');
    const identity = identities[0] || {};
    const workspaceKey = identity.workspaceKey || workspaceKeyOf(workspaceValue);
    const sourcePaths = [...new Set([
      sourcePathValue,
      ...identities.map((item) => item.sourcePath),
    ].filter(Boolean))];
    const workingCopyIds = [...new Set([
      ...resources.flatMap((resource) => workingCopyIdsOf(resource)),
      ...identities.map((item) => item.workingCopyId),
    ].filter(Boolean))];
    if (!workspaceKey) throw new Error('无法解析 SVN 项目');
    log(operation, `开始${sourcePaths.length ? `提交所选 ${sourcePaths.length} 个文件` : '提交全部 Nexus 修改'}`);
    if (!await saveDirtyDocuments(workspaceKey, operation, operation)) return undefined;
    log(operation, '检查当前 SCM 状态');
    const current = await refreshWorkspaceScm(workspaceKey, scopedBackendOptions(workingCopyIds));
    const nexusChanges = current?.groups?.LOCAL_MODIFIED || [];
    const selectedChanges = nexusChanges.filter((change) => (
      (!sourcePaths.length || sourcePaths.includes(change.path))
      && (!workingCopyIds.length || workingCopyIds.includes(change.workingCopyId))
    ));
    if (!selectedChanges.length || (sourcePaths.length && selectedChanges.length !== sourcePaths.length)) {
      log(operation, '没有可提交的 Nexus 修改');
      notifyInformation(vscode,
        sourcePaths.length ? '部分所选文件已不是可提交的 Nexus 修改，请刷新后重试' : '当前项目没有可提交的 Nexus 修改'
      );
      return undefined;
    }
    log(operation, '生成提交预览并校验可提交文件');
    const preview = await backend.preview(
      workspaceKey,
      'platform-save',
      current.sessionId,
      scopedBackendOptions(workingCopyIds),
    );
    const candidateIds = nexusCandidateIds(preview, sourcePaths, workingCopyIds);
    if (!candidateIds.length) throw new Error('Nexus 修改状态已变化，请刷新后重试');
    return completePlatformSave(workspaceKey, preview, candidateIds);
  };
  const conflictIdentity = (value) => {
    const resource = singleResource(value);
    const identity = changeIdentity(resource);
    if (!identity.workspaceKey || !identity.sourcePath || identity.state !== 'CONFLICT') {
      throw new Error('所选文件已不是 SVN 冲突文件');
    }
    return { resource, ...identity };
  };
  const openConflictMerge = async (value) => {
    const identity = conflictIdentity(value);
    const conflict = await backend.conflict(identity.workspaceKey, identity.sourcePath);
    await openSvnConflictMerge(vscode, conflict);
    notifyInformation(vscode, '请在合并结果中完成修改并保存，然后执行“标记冲突为已解决”');
  };
  const markConflictResolved = async (value) => {
    const operation = '解决 SVN 冲突';
    const identity = conflictIdentity(value);
    const conflict = await backend.conflict(identity.workspaceKey, identity.sourcePath);
    const resultUri = vscode.Uri.file(conflict.resultPath);
    const resultDocument = vscode.workspace.textDocuments.find((document) => (
      document.uri.toString() === resultUri.toString()
    ));
    if (resultDocument?.isDirty && !await resultDocument.save()) {
      throw new Error('合并结果尚未成功保存');
    }
    const confirmed = await vscode.window.showWarningMessage(
      '确认合并结果已经检查并保存？此操作会将 SVN 冲突标记为已解决，但不会提交文件。',
      { modal: true },
      '标记为已解决'
    );
    if (confirmed !== '标记为已解决') return undefined;
    sourceWatcher?.suppress(identity.workspaceKey, identity.sourcePath, 30 * 60 * 1000);
    log(operation, `执行 svn resolve · ${identity.sourcePath}`);
    const result = await backend.resolveConflict(
      identity.workspaceKey,
      identity.sourcePath,
      backendOutput
    );
    catalogTree.refresh(identity.workspaceKey);
    virtualFs.invalidate(identity.workspaceKey, true);
    await refreshWorkspaceScm(identity.workspaceKey, backendOutput);
    onToolTreeChanged?.();
    notifyInformation(vscode, `SVN 冲突已解决，文件仍保留为本地修改：${identity.sourcePath}`);
    return result;
  };
  const updateRemoteChanges = async (workspaceValue, sourcePathValue) => {
    const operation = '更新 SVN 远程变更';
    const identity = changeIdentity(workspaceValue, sourcePathValue);
    const workspaceKey = identity.workspaceKey || workspaceKeyOf(workspaceValue);
    const sourcePath = identity.sourcePath || sourcePathValue || '';
    const scopedWorkingCopyIds = [...new Set([
      ...workingCopyIdsOf(workspaceValue),
      identity.workingCopyId,
    ].filter(Boolean))];
    if (!workspaceKey) throw new Error('无法解析 SVN 项目');
    const workspace = (await listSvnWorkspaces()).find((item) => item.workspaceKey === workspaceKey);
    if (!workspace) throw new Error(`找不到 SVN 项目：${workspaceKey}`);
    log(operation, `开始${sourcePath ? `更新指定文件 · ${sourcePath}` : '更新远程变更'}`);
    if (!await saveDirtyDocuments(workspaceKey, operation, operation)) return undefined;
    log(operation, '检查 SVN 远程变更和本地修改');
    const current = await scm.refreshRemote(workspace, scopedBackendOptions(scopedWorkingCopyIds));
    const selectedRemote = (current.remoteChanges || []).filter((change) => (
      (!sourcePath || change.path === sourcePath)
      && (!scopedWorkingCopyIds.length || scopedWorkingCopyIds.includes(change.workingCopyId))
    ));
    if (!selectedRemote.length) {
      log(operation, '没有待更新的 SVN 远程变更');
      notifyInformation(vscode,
        sourcePath ? '所选文件已不是 SVN 远程变更' : '当前项目没有待更新的 SVN 远程变更'
      );
      return undefined;
    }
    const workingCopyIds = [...new Set(selectedRemote.map((change) => change.workingCopyId))];
    const relevantLocal = (current.changes || []).filter((change) => (
      sourcePath ? change.path === sourcePath : workingCopyIds.includes(change.workingCopyId)
    ));
    const button = relevantLocal.length ? '更新并合并' : '更新';
    const localNotice = relevantLocal.length
      ? `；其中 ${relevantLocal.length} 个本地修改将交给 SVN 原生合并，Nexus 不自动解决冲突`
      : '';
    const confirmed = await vscode.window.showWarningMessage(
      `将更新 ${selectedRemote.length} 个远程变更${localNotice}。`,
      { modal: true },
      button
    );
    if (confirmed !== button) return undefined;
    // Platform-side pulls and the ensuing SVN update both produce checkout
    // watcher events. The refresh command reindexes these exact files itself,
    // so cancel pending watcher work before it can race for the SVN lock.
    for (const change of selectedRemote) {
      sourceWatcher?.suppress(workspaceKey, change.path, 30 * 60 * 1000);
    }
    log(operation, `已确认，开始更新 ${selectedRemote.length} 个远程文件`);
    const result = await backend.refresh(workspaceKey, {
      sourcePath,
      workingCopyIds: sourcePath ? [] : workingCopyIds,
      mergeLocal: relevantLocal.length > 0,
      onOutput: streamBackendOutput,
    });
    log(operation, 'SVN update 完成，刷新源码树、虚拟文档和 SCM 状态');
    catalogTree.refresh(workspaceKey);
    virtualFs.invalidate(workspaceKey, true);
    await scm.refreshRemote(workspace, scopedBackendOptions(scopedWorkingCopyIds));
    onToolTreeChanged?.();
    log(operation, '完成');
    notifyInformation(vscode,
      sourcePath
        ? `已更新 SVN 文件：${sourcePath}`
        : `已更新 ${result.updated.length} 个 SVN working copy`
    );
  };
  const manageChanges = async (workspaceValue, requestedAction, sourcePathValue = '') => {
    const operation = requestedAction === 'revert' ? '放弃 SVN 本地修改' : '管理本地源码变更';
    const identity = changeIdentity(workspaceValue, sourcePathValue);
    const workspaceKey = identity.workspaceKey || workspaceKeyOf(workspaceValue);
    const sourcePath = identity.sourcePath || sourcePathValue || '';
    const workingCopyIds = [...new Set([
      ...workingCopyIdsOf(workspaceValue),
      identity.workingCopyId,
    ].filter(Boolean))];
    if (!workspaceKey) throw new Error('无法解析 SVN 项目');
    log(operation, '开始检查本地源码变更');
    if (!await saveDirtyDocuments(workspaceKey, operation, operation)) return undefined;
    const current = await refreshWorkspaceScm(workspaceKey, scopedBackendOptions(workingCopyIds));
    const scopedChanges = (current?.changes || []).filter((change) => (
      (!sourcePath || change.path === sourcePath)
      && (!workingCopyIds.length || workingCopyIds.includes(change.workingCopyId))
    ));
    if (!scopedChanges.length) {
      log(operation, '当前项目没有本地 SVN 源码变更');
      notifyInformation(vscode,
        sourcePath ? '所选文件已不是本地 SVN 修改' : '当前项目没有本地 SVN 源码变更'
      );
      return undefined;
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
    log(operation, '生成文件选择预览');
    const preview = await backend.preview(
      workspaceKey,
      action,
      current.sessionId,
      scopedBackendOptions(workingCopyIds),
    );
    showBlockedWorkingCopies(vscode, preview);
    const isSave = action === 'platform-save';
    const candidateIds = sourcePath
      ? nexusCandidateIds(preview, sourcePath, workingCopyIds)
      : await selectCandidates(
        vscode,
        preview,
        isSave ? '选择要保存到谷神的物理文件' : '选择要放弃的物理文件'
      );
    if (!candidateIds.length) return undefined;
    if (isSave) {
      return completePlatformSave(workspaceKey, preview, candidateIds);
    }
    const workingCopyCount = selectedWorkingCopyCount(preview, candidateIds);
    const confirmed = await vscode.window.showWarningMessage(
      `将放弃 ${candidateIds.length} 个文件、涉及 ${workingCopyCount} 个 working copy 的本地 SVN 修改，该操作不可撤销。`,
      { modal: true },
      '放弃修改'
    );
    if (confirmed !== '放弃修改') return undefined;
    log(operation, `已确认，开始恢复 ${candidateIds.length} 个文件到 SVN BASE`);
    await backend.revert(workspaceKey, preview, candidateIds, backendOutput);
    log(operation, '恢复完成，刷新源码树、虚拟文档和 SCM 状态');
    catalogTree.refresh(workspaceKey);
    virtualFs.invalidate(workspaceKey, true);
    await refreshWorkspaceScm(workspaceKey, backendOutput);
    onToolTreeChanged?.();
    log(operation, '完成');
    notifyInformation(vscode, `已放弃 ${candidateIds.length} 个文件的本地修改`);
  };

  const openSvnChangeInNexus = async (value) => {
    const resource = singleResource(value);
    const identity = changeIdentity(resource);
    if (!identity.workspaceKey || !identity.sourceType || !identity.sourceId) {
      throw new Error('所选文件没有对应的 Nexus 源码对象，无法跳转编辑');
    }
    return virtualFs.open(identity);
  };

  const commands = [
    vscode.commands.registerCommand('gushenCompletion.openSvnDocument', withError((identity) =>
      virtualFs.open(identity))),
    vscode.commands.registerCommand('gushenCompletion.openSvnChangeInNexus', withError(openSvnChangeInNexus)),
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
    vscode.commands.registerCommand('gushenCompletion.refreshSvnSourceView', withError((workspaceKey) => runClaimed(
      workspaceKey || '',
      async () => {
        log('刷新 SVN 源码视图', workspaceKey ? `开始 · ${workspaceKey}` : '开始 · 全部工作区');
        catalogTree.refresh(workspaceKey);
        if (workspaceKey) virtualFs.invalidate(workspaceKey, true);
        const workspaces = await listSvnWorkspaces();
        if (workspaceKey) {
          const workspace = workspaces.find((item) => item.workspaceKey === workspaceKey);
          if (workspace) await scm.refresh(workspace, backendOutput);
        } else {
          for (const workspace of workspaces) virtualFs.invalidate(workspace.workspaceKey, true);
          await scm.refreshAll(workspaces, backendOutput);
        }
        log('刷新 SVN 源码视图', '完成');
      }
    ))),
    vscode.commands.registerCommand('gushenCompletion.refreshSvnScm', withError((workspaceValue) => runClaimedValue(
      workspaceValue,
      async () => {
        const workspaceKey = workspaceKeyOf(workspaceValue);
        const workingCopyIds = workingCopyIdsOf(workspaceValue);
        const workspaces = await listSvnWorkspaces();
        const selected = workspaceKey
          ? workspaces.filter((item) => item.workspaceKey === workspaceKey)
          : workspaces;
        log('刷新 SVN SCM 状态', `开始 · ${selected.length} 个工作区`);
        await scm.refreshAll(selected, scopedBackendOptions(workingCopyIds));
        log('刷新 SVN SCM 状态', '完成');
      }
    ))),
    vscode.commands.registerCommand('gushenCompletion.refreshSvnRemoteChanges', withError((workspaceValue) => runClaimedValue(
      workspaceValue,
      async () => {
        const workspaceKey = workspaceKeyOf(workspaceValue);
        const workingCopyIds = workingCopyIdsOf(workspaceValue);
        const workspaces = await listSvnWorkspaces();
        const selected = workspaceKey
          ? workspaces.filter((item) => item.workspaceKey === workspaceKey)
          : workspaces;
        log('检查 SVN 远程变更', `开始 · ${selected.length} 个工作区`);
        const options = scopedBackendOptions(workingCopyIds);
        for (const workspace of selected) await scm.refreshRemote(workspace, options);
        const total = selected.reduce(
          (count, workspace) => count + (scm.status(workspace.workspaceKey)?.remoteChanges?.length || 0),
          0
        );
        log('检查 SVN 远程变更', `完成 · ${total} 个待更新文件`);
        notifyInformation(vscode, `SVN 远程检查完成：${total} 个待更新文件`);
      }
    ))),
    vscode.commands.registerCommand('gushenCompletion.showSvnDiff', withError(async (
      workspaceKey,
      sourcePath,
      remote = false
    ) => {
      const result = await backend.diff(workspaceKey, sourcePath, remote);
      return showSvnDiff(vscode, diffContent, result);
    })),
    vscode.commands.registerCommand('gushenCompletion.showSvnRawDiff', withError(async (
      workspaceValue,
      sourcePathValue
    ) => {
      const { workspaceKey, sourcePath } = changeIdentity(workspaceValue, sourcePathValue);
      if (!workspaceKey || !sourcePath) throw new Error('无法解析 SVN 原始差异目标');
      const result = await backend.diff(workspaceKey, sourcePath);
      return showSvnDiff(vscode, diffContent, result, { raw: true });
    })),
    vscode.commands.registerCommand('gushenCompletion.revertSvnQuickDiffChange', withError(async (
      resourceUri,
      changes,
      changeIndex
    ) => {
      const identity = activeSourceIdentity(
        await listSvnWorkspaces(),
        { uri: resourceUri }
      );
      return runClaimed(identity?.workspaceKey || '', async () => {
        const reverted = await revertQuickDiffChange({
          vscode,
          provider: quickDiff,
          resourceUri,
          changes,
          changeIndex,
        });
        if (!reverted) return reverted;
        if (identity?.workspaceKey) {
          catalogTree.refresh(identity.workspaceKey);
          await refreshWorkspaceScm(identity.workspaceKey, backendOutput);
          onToolTreeChanged?.();
        }
        notifyInformation(vscode, '已撤销当前 SVN 差异块');
        return reverted;
      });
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
    vscode.commands.registerCommand('gushenCompletion.manageSvnChanges', withError((workspaceValue) =>
      runClaimedValue(workspaceValue, manageChanges))),
    vscode.commands.registerCommand('gushenCompletion.revertSvnChanges', withError((workspaceValue) =>
      runClaimedValue(workspaceValue, (value) => manageChanges(value, 'revert')))),
    vscode.commands.registerCommand('gushenCompletion.revertSingleSvnChange', withError((value) => {
      const resource = singleResource(value);
      const { sourcePath } = changeIdentity(resource);
      return runClaimedValue(resource, (value) => manageChanges(value, 'revert', sourcePath));
    })),
    vscode.commands.registerCommand('gushenCompletion.saveSvnToGuthon', withError((workspaceValue) =>
      runClaimedValue(workspaceValue, (value) => manageChanges(value, 'platform-save')))),
    vscode.commands.registerCommand('gushenCompletion.saveAllSvnNexusChanges', withError((workspaceValue) =>
      runClaimedValue(workspaceValue, saveNexusChanges))),
    vscode.commands.registerCommand('gushenCompletion.saveSelectedSvnNexusChanges', withError((...values) => {
      const resources = values.flat().filter(Boolean);
      return runClaimedValue(resources, saveNexusChanges);
    })),
    vscode.commands.registerCommand('gushenCompletion.openSvnConflictMerge', withError((value) => {
      const resource = singleResource(value);
      return runClaimedValue(resource, openConflictMerge);
    })),
    vscode.commands.registerCommand('gushenCompletion.markSvnConflictResolved', withError((value) => {
      const resource = singleResource(value);
      return runClaimedValue(resource, markConflictResolved);
    })),
    vscode.commands.registerCommand('gushenCompletion.updateAllSvnChanges', withError((workspaceValue) =>
      runClaimedValue(workspaceValue, updateRemoteChanges))),
    vscode.commands.registerCommand('gushenCompletion.updateSingleSvnChange', withError((value) => {
      const resource = singleResource(value);
      return runClaimedValue(resource, updateRemoteChanges);
    })),
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
      fileDecorationRegistration.dispose();
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
      operationOutput.dispose();
    },
  };
  context.subscriptions.push(disposable);
  refresh().catch(() => {});
  return {
    backend,
    backendOutput,
    catalogTree,
    log,
    refresh,
    saveDirtyDocuments,
    scm,
    virtualFs,
  };
}

module.exports = {
  activeSourceIdentity,
  activateSvn,
  nexusCandidateIds,
  notifyInformation,
  openSvnConflictMerge,
  referenceTarget,
  resolveSourcePath,
  runFocusedTreeCommand,
  selectCandidates,
  showBlockedWorkingCopies,
  sourceModuleElement,
};

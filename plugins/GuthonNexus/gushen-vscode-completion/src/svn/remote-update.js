async function updateRemoteChanges({
  vscode, backend, scm, workspace, sourcePath = '', workingCopyIds = [],
  saveDirtyDocuments, onUpdated, log, onOutput,
}) {
  const workspaceKey = workspace.workspaceKey;
  const scope = { onOutput, ...(workingCopyIds.length ? { workingCopyIds } : {}) };
  log(`开始${sourcePath ? `更新指定文件 · ${sourcePath}` : '更新远程变更'}`);
  log('检查 SVN 远程变更和本地修改');
  const current = await scm.refreshRemote(workspace, scope);
  const selectedRemote = (current.remoteChanges || []).filter((change) => (
    (!sourcePath || change.path === sourcePath)
    && (!workingCopyIds.length || workingCopyIds.includes(change.workingCopyId))
  ));
  // Publish the SCM resources before asking to update. Cancelling leaves this
  // snapshot available for inspecting individual remote diffs.
  await vscode.commands.executeCommand('workbench.view.scm');
  if (!selectedRemote.length) {
    log('没有待更新的 SVN 远程变更');
    void vscode.window.showInformationMessage(
      sourcePath ? '所选文件已不是 SVN 远程变更' : '当前项目没有待更新的 SVN 远程变更'
    );
    return undefined;
  }
  const updateWorkingCopyIds = [...new Set(selectedRemote.map((change) => change.workingCopyId))];
  const relevantLocal = (current.changes || []).filter((change) => (
    sourcePath ? change.path === sourcePath : updateWorkingCopyIds.includes(change.workingCopyId)
  ));
  const localNotice = relevantLocal.length
    ? `；更新范围内有 ${relevantLocal.length} 个本地修改`
    : '';
  const confirmed = await vscode.window.showWarningMessage(
    `发现 ${selectedRemote.length} 个远程变更${localNotice}，是否更新？`,
    {
      modal: true,
      detail: '远程变更已展示在源代码管理中。取消将保留列表，可点击文件查看差异。\n'
        + '确认后才保存未保存的 SVN 文档并更新；本地修改由 SVN 原生合并，冲突需手动解决。\n\n'
        + selectedRemote.slice(0, 20).map((change) => change.path).join('\n')
        + (selectedRemote.length > 20 ? '\n其余文件请在源代码管理中查看。' : ''),
    },
    '确认'
  );
  if (confirmed !== '确认') {
    log('已取消更新，保留远程变更列表');
    return undefined;
  }
  if (!await saveDirtyDocuments()) return undefined;
  // Saving a previously clean virtual document can introduce a local change.
  // Determine merge requirements from the resulting physical checkout status.
  const local = await scm.refresh(workspace, { onOutput });
  const mergeLocal = (local.changes || []).some((change) => (
    sourcePath ? change.path === sourcePath : updateWorkingCopyIds.includes(change.workingCopyId)
  ));
  log(`已确认，开始更新 ${selectedRemote.length} 个远程文件`);
  const result = await backend.refresh(workspaceKey, {
    sourcePath,
    workingCopyIds: sourcePath ? [] : updateWorkingCopyIds,
    mergeLocal,
    onOutput,
  });
  log('SVN update 完成，刷新源码树、虚拟文档和 SCM 状态');
  onUpdated();
  await scm.refreshRemote(workspace, scope);
  log('完成');
  void vscode.window.showInformationMessage(
    sourcePath ? `已更新 SVN 文件：${sourcePath}` : `已更新 ${result.updated.length} 个 SVN working copy`
  );
  return result;
}

module.exports = { updateRemoteChanges };

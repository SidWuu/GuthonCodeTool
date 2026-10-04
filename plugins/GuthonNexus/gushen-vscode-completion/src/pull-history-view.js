function pullHistoryMarkdown(result) {
  const text = value => String(value ?? '').replace(/[\r\n]/g, ' ').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = ['# 源码拉取历史', '', `工作区：${text(result.workspaceKey)}`, '',
    '| 时间 | 来源 | 触发 | 状态 | 对象 | 变化 / 拉取 |', '|---|---|---|---|---|---|'];
  for (const entry of result.entries || []) {
    const meta = entry.summary || {};
    lines.push(`| ${text(entry.time)} | ${text(entry.log)} | ${text(entry.trigger)} | ${entry.ok ? '成功' : '失败'} | ${text(meta.sourceId || meta.alias || '')} ${text(meta.funId)} | ${text(meta.changed)} / ${text(meta.pulled)} |`);
  }
  if (!result.entries?.length) lines.push('| | | | 无可用记录 | | |');
  if (result.generation) lines.push('', `观察快照：${text(result.generation)}`);
  if (Number.isInteger(result.observed)) lines.push(`观察窗口内共 ${result.observed} 条；${result.complete ? '已到本窗口末页' : '可继续分页'}。`);
  lines.push('', `观察范围：${text(result.coverage)}`, `本页返回 ${result.returned || 0} 条${result.truncated ? '，更多保留记录未展示' : ''}。`);
  for (const scan of result.scan || []) {
    lines.push(`- ${text(scan.log)}${scan.rotated ? ' 轮转文件' : ''}：扫描 ${scan.scannedLines} 行；损坏 ${scan.malformedLines} 行${scan.windowTruncated ? '；较早字节未读取' : ''}。`);
  }
  return lines.join('\n');
}

async function showPullHistory({ vscode, client, workspaceKey, workspaceRoot }) {
  let cursor = '';
  let generation;
  for (;;) {
    const args = ['tail', '--limit', '100'];
    if (cursor) args.push('--cursor', cursor);
    const result = await client.run(workspaceKey, 'pull-log', args);
    if (result.workspaceKey !== workspaceKey || !Array.isArray(result.entries) || result.entries.length > 100
        || (generation && generation !== result.generation)) throw new Error('拉取历史页身份或快照已变化，请重新打开');
    generation = result.generation;
    const document = await vscode.workspace.openTextDocument({language:'markdown',content:pullHistoryMarkdown(result)});
    await vscode.window.showTextDocument(document, {preview:true});
    const choices = [
      ...(result.nextCursor ? [{label:'下一页',value:'next'}] : []),
      {label:'导出此观察快照（Markdown）',value:'markdown'},
      {label:'导出此观察快照（JSON）',value:'json'},
    ];
    const action = await vscode.window.showQuickPick(choices, {title:'拉取历史操作 · 每页最多 100 条'});
    if (!action) return result;
    if (action.value === 'next') {
      if (typeof result.nextCursor !== 'string' || result.nextCursor === cursor || result.nextCursor.length > 8192) throw new Error('拉取历史游标无效');
      cursor = result.nextCursor;
      continue;
    }
    const exportArgs = ['export','--format',action.value];
    if (generation) exportArgs.push('--generation',generation);
    const exported = await client.run(workspaceKey, 'pull-log', exportArgs);
    const artifactPath = await verifyHistoryArtifact(exported, workspaceKey, workspaceRoot);
    const copy = await vscode.window.showInformationMessage(`拉取历史已导出：${artifactPath}`, '复制文件路径');
    if (copy === '复制文件路径') await vscode.env.clipboard.writeText(artifactPath);
    return exported;
  }
}

async function verifyHistoryArtifact(result, workspaceKey, workspaceRoot) {
  const path = require('node:path');
  const fs = require('node:fs/promises');
  if (result.workspaceKey !== workspaceKey || !path.isAbsolute(result.artifactPath || '') || !path.isAbsolute(workspaceRoot || '')) {
    throw new Error('历史导出路径或工作区身份无效');
  }
  const root = await fs.realpath(path.join(workspaceRoot,'context'));
  const artifact = await fs.realpath(result.artifactPath);
  const relative = path.relative(root,artifact);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || !(await fs.stat(artifact)).isFile()) throw new Error('历史导出文件越过当前工作区 context 边界');
  return artifact;
}

async function maintainPullHistory({ vscode, client, workspaceKey, action }) {
  if (!['archive','restore'].includes(action)) throw new Error('未知历史维护动作');
  const isArchive = action === 'archive';
  const value = await vscode.window.showInputBox({
    title: isArchive ? '归档早于指定日期的本地拉取历史' : '恢复拉取历史归档',
    prompt: isArchive ? '仅归档本工作区明确归属的终态记录；Bridge 共享日志保留' : '填写归档操作返回的准确 archiveId；日志变化时后端会阻止覆盖',
    validateInput: (input) => isArchive
      ? /^\d{4}-\d{2}-\d{2}$/.test(input) ? undefined : '请输入 YYYY-MM-DD'
      : /^[A-Za-z0-9._-]+$/.test(input) ? undefined : '请输入准确归档 ID',
  });
  if (!value) return undefined;
  const args = [action, isArchive ? '--before' : '--archive-id', value];
  const preview = await client.run(workspaceKey, 'pull-log', [...args,'--check']);
  if (preview.workspaceKey !== workspaceKey || (!isArchive && preview.archiveId !== value) || !/^[a-f0-9]{64}$/i.test(preview.planHash || '')) throw new Error('历史维护预览身份或计划哈希无效');
  const content = `# 拉取历史${isArchive ? '归档' : '恢复'}预览\n\n`
    + `工作区：${workspaceKey}\n\n计划：${preview.planHash}\n\n`
    + (isArchive ? `候选记录：${preview.candidateCount || 0}\n\n共享 Bridge 日志仅可导出，归档保留完整私有备份。\n` : `归档 ID：${preview.archiveId}\n\n当前状态：${preview.state}\n`);
  const document = await vscode.workspace.openTextDocument({language:'markdown',content});
  await vscode.window.showTextDocument(document,{preview:true});
  if (isArchive && !preview.candidateCount) return preview;
  const confirmation = await vscode.window.showInputBox({
    title: `确认${isArchive ? '归档' : '恢复'}拉取历史`, prompt: `核对预览后输入完整工作区标识：${workspaceKey}`,
    validateInput:(input)=>input === workspaceKey ? undefined : '必须与完整工作区标识完全一致',
  });
  if (confirmation !== workspaceKey) return undefined;
  const result = await client.run(workspaceKey,'pull-log',[...args,'--confirmation',confirmation,'--plan-hash',preview.planHash]);
  if (result.workspaceKey !== workspaceKey || (!isArchive && result.archiveId !== value)) throw new Error('历史维护结果身份不一致，请核验操作状态');
  await vscode.window.showInformationMessage(isArchive
    ? `拉取历史已归档 ${result.archivedCount || 0} 条；归档 ID：${result.archiveId}`
    : `拉取历史已恢复 ${result.restoredCount || 0} 条；归档 ID：${result.archiveId}`);
  return result;
}

module.exports = { pullHistoryMarkdown, showPullHistory, maintainPullHistory, verifyHistoryArtifact };

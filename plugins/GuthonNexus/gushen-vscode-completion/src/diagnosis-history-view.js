const {isWorkspaceKey} = require('./workspace-identity');

function text(value) {
  return String(value ?? '').slice(0, 512).replace(/[\r\n\u0000-\u001f\u007f]/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()!#|]/g, '\\$&');
}
function time(value) {
  const milliseconds = Number(value) * 1000;
  return Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds < 8640000000000000
    ? new Date(milliseconds).toISOString() : '未知时间';
}
function checkEntry(workspaceKey, entry) {
  if (!isWorkspaceKey(workspaceKey) || entry?.workspaceKey !== workspaceKey || !/^[a-f0-9]{32}$/.test(entry.id)) {
    throw new Error('诊断历史身份无效或不属于所选工作区');
  }
  return entry;
}
function historyEntries(workspaceKey, result) {
  if (!isWorkspaceKey(workspaceKey) || !Array.isArray(result?.history) || result.history.length > 100) {
    throw new Error('诊断历史缺少有界记录列表');
  }
  return result.history.map(entry => checkEntry(workspaceKey, entry));
}
function diagnosisHistoryMarkdown(workspaceKey, result) {
  const entries = historyEntries(workspaceKey, result);
  const lines = ['# 最近诊断历史', '', `工作区：${text(workspaceKey)}`, '',
    '| 时间 (UTC) | 目标 / 环境 | 命令 | 状态 | 返回行数 | 完整性 |', '|---|---|---|---|---|---|'];
  for (const entry of entries) lines.push(`| ${time(entry.createdAt)} | ${text(entry.targetId)} / ${text(entry.environment)} | ${text(entry.command)} | ${text(entry.status)} ${text(entry.errorCode)} | ${text(entry.rowCountReturned)} | ${text(entry.truncation)} |`);
  if (!entries.length) lines.push('| | | | 无历史记录 | | |');
  lines.push('', `本次展示 ${entries.length} 条${result.truncated ? '，更多保留记录未展示' : ''}；最多保留 ${Math.min(Number(result.retainedLimit) || 100, 100)} 条。`,
    '', '历史只保留身份、状态、摘要和 SQL 哈希，不包含 SQL、参数、结果行或凭据；历史不证明当前数据库或平台状态。');
  return lines.join('\n');
}
function diagnosisEntryMarkdown(workspaceKey, entry) {
  checkEntry(workspaceKey, entry);
  const lines = ['# 诊断历史记录', '', `工作区：${text(workspaceKey)}`, '', '| 字段 | 元数据 |', '|---|---|'];
  for (const key of ['id', 'targetId', 'environment', 'command', 'status', 'errorCode', 'stage', 'targetDigest', 'sqlDigest', 'rowCountReturned', 'columnCount', 'truncation']) {
    if (entry[key] !== undefined) lines.push(`| ${key} | ${text(entry[key])} |`);
  }
  lines.push(`| createdAt (UTC) | ${time(entry.createdAt)} |`);
  for (const key of ['kind', 'physicalTableCount', 'characters']) {
    if (entry.querySummary?.[key] !== undefined) lines.push(`| querySummary.${key} | ${text(entry.querySummary[key])} |`);
  }
  lines.push('', '此记录仅为已保留的执行元数据；不加载 SQL、结果行或凭据，不重新执行查询。');
  return lines.join('\n');
}
async function showDiagnosisHistory({vscode, client, workspaceKey}) {
  if (!isWorkspaceKey(workspaceKey)) throw new Error('诊断历史需要明确 workspaceKey');
  const listing = await client.run(workspaceKey, 'diagnosis-list', ['--limit', '100']);
  const entries = historyEntries(workspaceKey, listing);
  let content = diagnosisHistoryMarkdown(workspaceKey, listing);
  if (entries.length) {
    const selected = await vscode.window.showQuickPick([
      {label: '$(list-unordered) 查看历史摘要', summary: true},
      ...entries.map(entry => ({label: `${time(entry.createdAt)} · ${entry.targetId} · ${entry.status}`,
        description: `${entry.environment} · ${entry.command}`, detail: `${entry.id}${entry.errorCode ? ` · ${entry.errorCode}` : ''}`, id: entry.id})),
    ], {title: '选择诊断历史记录或查看摘要', matchOnDescription: true, matchOnDetail: true});
    if (!selected) return undefined;
    if (!selected.summary) {
      const details = await client.run(workspaceKey, 'diagnosis-show', ['--id', selected.id]);
      if (details.entry?.id !== selected.id) throw new Error('诊断历史详情与所选记录不一致');
      content = diagnosisEntryMarkdown(workspaceKey, details.entry);
    }
  }
  const document = await vscode.workspace.openTextDocument({language: 'markdown', content});
  return vscode.window.showTextDocument(document, {preview: true});
}

module.exports = {diagnosisHistoryMarkdown, diagnosisEntryMarkdown, showDiagnosisHistory};

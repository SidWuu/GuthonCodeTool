const {isWorkspaceKey} = require('./workspace-identity');

const configFiles = ['datasource.yaml', 'products.yaml', 'projects.yaml', 'source-tables.yaml', 'sync.yaml', 'database-testing.yaml'];
const labels = {python: 'Python 运行环境', config: '工作区配置', 'database-config': '数据库能力配置',
  'database-readonly': '本地数据库依赖', 'vscode-data': '补全与帮助资源', bridge: 'Guthon Bridge'};
const statuses = {PASS: '通过', WARN: '需留意', FAIL: '需处理', SKIP: '本次未使用'};
const icons = {PASS: 'pass', WARN: 'warning', FAIL: 'error', SKIP: 'circle-slash'};
const actions = {
  setup: {label: '设置工作空间', command: 'gushenCompletion.setupTool'},
  runtime: {label: '核对运行入口', command: 'gushenCompletion.selectExecutionMode'},
  bridge: {label: '启动 Guthon Bridge', command: 'gushenCompletion.startBridge'},
};
const markdown = value => String(value ?? '').replace(/[\\`*_\[\]<>|()]/g, '\\$&').replace(/[\r\n]+/g, ' ');

function checkedReport(report, workspaceKey) {
  if (report?.ok !== true || report.coverage !== 'LOCAL_DEPENDENCIES_ONLY' || report.workspaceKey !== (workspaceKey || null)
    || !Array.isArray(report.checks) || !report.checks.length || report.checks.length > 64)
    throw new Error('环境检查报告格式或工作区不一致，请核对后端入口与版本');
  const names = new Set(), summary = {PASS: 0, WARN: 0, FAIL: 0, SKIP: 0};
  for (const check of report.checks) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(check?.name || '') || names.has(check.name)
      || !Object.hasOwn(statuses, check.status) || typeof check.message !== 'string')
      throw new Error('环境检查报告包含无效检查项');
    names.add(check.name); summary[check.status]++;
  }
  const health = summary.FAIL ? 'FAIL' : summary.WARN ? 'WARN' : 'PASS';
  if (report.health !== health) throw new Error('环境检查总状态与检查项不一致');
  return {...report, summary, health};
}

function environmentReportMarkdown(report, workspaceKey = '') {
  const value = checkedReport(report, workspaceKey), lines = [
    '# 本地环境检查', '', `范围：${markdown(workspaceKey || '全部已配置工作区')}`, '',
    `通过 ${value.summary.PASS} · 需留意 ${value.summary.WARN} · 需处理 ${value.summary.FAIL} · 未使用 ${value.summary.SKIP}`, '',
    '仅检查本地依赖和配置；不取用系统凭据库中的密码或密码文件、不连接数据库，也不代表客户端或平台验收。', '',
    '| 检查项 | 状态 | 适用性 | 结果 |', '| --- | --- | --- | --- |',
  ];
  for (const check of value.checks) lines.push(`| ${markdown(labels[check.name] || check.name)} | ${statuses[check.status]} | ${
    check.status === 'SKIP' ? '本次未使用' : check.required === true ? '必需' : check.required === false ? '选用' : '范围未确认'
  } | ${markdown(check.message)} |`);
  if (value.checks.some(check => check.code === 'CREDENTIAL_STORE_UNAVAILABLE')) lines.push('',
    '系统凭据库不可用时，请先恢复当前用户的桌面会话、钥匙串或凭据管理器，再重新检查；已配置的备用密码来源尚未在本检查中核验。');
  return lines.join('\n');
}

async function showEnvironmentCheck({vscode, client, workspaceKey = '', bridgePort = 17361, isCurrent = () => true}) {
  if (workspaceKey && !isWorkspaceKey(workspaceKey)) throw new Error('环境检查需要有效 workspaceKey');
  const report = checkedReport(await vscode.window.withProgress({location: vscode.ProgressLocation.Window,
    title: '检查本地环境', cancellable: false}, () => client.run(workspaceKey, 'doctor', ['--report', '--bridge-port', String(bridgePort)])), workspaceKey);
  if (!isCurrent()) throw new Error('运行入口或数据目录已变化，请重新执行环境检查');
  const rank = {FAIL: 0, WARN: 1, PASS: 2, SKIP: 3};
  const selected = await vscode.window.showQuickPick([
    {label: '$(list-unordered) 查看完整检查报告', summary: true},
    ...[...report.checks].sort((left, right) => rank[left.status] - rank[right.status]).map(check => ({
      label: `$(${icons[check.status]}) ${labels[check.name] || check.name} · ${statuses[check.status]}`,
      description: check.message, detail: check.status === 'FAIL' || check.status === 'WARN'
        ? actions[check.action]?.label || (check.action === 'config' ? '打开配置检查' : '查看说明') : '查看报告', check,
    })),
  ], {title: `环境检查 · ${report.summary.FAIL} 项需处理 · ${report.summary.WARN} 项需留意`,
    placeHolder: workspaceKey || '全部已配置工作区', matchOnDescription: true});
  if (!selected) return;
  if (!isCurrent()) throw new Error('运行入口或数据目录已变化，请重新执行环境检查');
  const check = selected.check;
  if (check && ['FAIL', 'WARN'].includes(check.status)) {
    if (Object.hasOwn(actions, check.action)) return vscode.commands.executeCommand(actions[check.action].command);
    if (check.action === 'config') {
      const file = configFiles.includes(check.configFile) ? check.configFile
        : (await vscode.window.showQuickPick(configFiles, {title: '选择需要核对的配置文件'}));
      if (file && configFiles.includes(file)) {
        if (!isCurrent()) throw new Error('运行入口或数据目录已变化，请重新执行环境检查');
        return vscode.commands.executeCommand('gushenCompletion.editConfig', file);
      }
      return;
    }
  }
  const document = await vscode.workspace.openTextDocument({language: 'markdown', content: environmentReportMarkdown(report, workspaceKey)});
  return vscode.window.showTextDocument(document, {preview: true});
}

module.exports = {environmentReportMarkdown, showEnvironmentCheck};

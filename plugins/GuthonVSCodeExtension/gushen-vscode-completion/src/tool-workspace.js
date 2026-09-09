const fs = require('node:fs');
const path = require('node:path');

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function prepareWorkspaceSetup(config, window, configurationTarget) {
  const toolHome = config.get('toolHome', '');
  if (!toolHome || !fs.existsSync(path.join(toolHome, 'config', 'sync.yaml'))) return 'setup';

  const confirmed = await window.showWarningMessage(
    `当前工作空间已设置：${toolHome}\n是否切换工作空间？`,
    { modal: true },
    '切换工作空间'
  );
  if (confirmed !== '切换工作空间') return undefined;

  const selected = await window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: '选择新的 GuthonCodeTool 本地数据工作空间',
  });
  if (!selected) return undefined;

  await config.update('toolHome', selected[0].fsPath, configurationTarget);
  return 'switch';
}

function workspaceActions(item) {
  const capability = (name) => Boolean(item.capabilities?.[name]);
  if (item.sourceMode === 'svn') {
    return {
      source: [
        capability('svn.initialize') && ['导入 SVN checkout 配置', 'gushenCompletion.importSvnScope', 'file-add'],
        capability('svn.initialize') && ['从 SVN 范围配置检出/更新', 'gushenCompletion.initializeSvn', 'repo-clone'],
        capability('svn.reindex') && ['扫描/重建本地 SVN 索引', 'gushenCompletion.reindexCalls', 'refresh'],
        capability('svn.browse') && ['查看谷神同步源码', 'gushenCompletion.focusSvnSource', 'list-tree'],
        capability('svn.status') && ['管理本地源码变更', 'gushenCompletion.manageSvnChanges', 'source-control'],
        ['导出源码索引文档', 'gushenCompletion.exportMarkdown', 'book'],
      ].filter(Boolean),
      workcopy: [],
      metadata: [],
      diagnose: false,
      syncAll: undefined,
    };
  }
  return {
    source: [
      ['拉取源码重建索引', 'gushenCompletion.initSourceIndex', 'database'],
      ['拉取源码', 'gushenCompletion.syncWorkspaceSource', 'sync'],
      ['重建索引', 'gushenCompletion.reindexCalls', 'refresh'],
      ['导出源码索引文档', 'gushenCompletion.exportMarkdown', 'book'],
    ],
    workcopy: [['检查或打包 Workcopy', 'gushenCompletion.inspectWorkcopy', 'package']],
    metadata: [
      ['导出表结构', 'gushenCompletion.exportSchema', 'table'],
      ['导出单据类型', 'gushenCompletion.exportBillTypes', 'list-tree'],
      ['导出系统脚本', 'gushenCompletion.exportSystemScripts', 'file-code'],
      ['导出视图源码', 'gushenCompletion.exportViews', 'eye'],
    ],
    diagnose: true,
    syncAll: ['同步工作区全部资料', 'gushenCompletion.syncWorkspaceAll', 'cloud-download'],
  };
}

function suggestedWorkspaceId(name, kind, now = new Date()) {
  const normalized = String(name || '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .toLowerCase();
  if (normalized) return normalized;
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
  ].join('');
  return `${kind}-${stamp}`;
}

function configuredSvnUsername(toolHome) {
  const syncPath = path.join(toolHome, 'config', 'sync.yaml');
  if (!fs.existsSync(syncPath)) return '';
  const svn = fs.readFileSync(syncPath, 'utf8').match(/^svn:\s*\n((?:^\s+.*\n?)*)/m);
  const username = svn?.[1].match(/^\s+username:\s*["']?([^\s"']*)/m)?.[1];
  return username || '';
}

async function promptWorkspaceCreation(window, workspaces, toolHome, now = new Date()) {
  const kindChoice = await window.showQuickPick([
    { label: '产品', description: '创建 products.<id>', value: 'product' },
    { label: '项目', description: '创建独立的 projects.<id> 快照工作区', value: 'project' },
  ], { title: '添加谷神产品或项目' });
  if (!kindChoice) return undefined;

  const name = await window.showInputBox({
    title: `输入${kindChoice.label}名称`,
    prompt: '该名称用于 Nexus 显示和本地工作区目录',
    validateInput: (value) => String(value || '').trim() ? undefined : '名称不能为空',
  });
  if (name === undefined) return undefined;
  const ids = new Set((workspaces || []).map((item) => item.id));
  const id = await window.showInputBox({
    title: `确认${kindChoice.label}稳定 ID`,
    value: suggestedWorkspaceId(name, kindChoice.value, now),
    prompt: '创建后保持不变，用于 workspaceKey 和本地配置引用',
    validateInput: (value) => {
      const candidate = String(value || '').trim();
      if (!SAFE_ID.test(candidate) || candidate === '.' || candidate === '..') return '仅允许字母、数字、点、下划线和横线，且须以字母或数字开头';
      return ids.has(candidate) ? '该 ID 已存在' : undefined;
    },
  });
  if (id === undefined) return undefined;
  const source = await window.showQuickPick([
    { label: 'SVN', description: '导入谷神 checkout 配置后检出并建立索引', value: 'svn' },
    { label: 'DATABASE', description: '填写开发库连接后拉取源码与资料', value: 'database' },
  ], { title: '选择源码来源' });
  if (!source) return undefined;

  const result = {
    kind: kindChoice.value,
    id: id.trim(),
    name: name.trim(),
    sourceMode: source.value,
  };
  if (source.value === 'svn') {
    const existingUsername = configuredSvnUsername(toolHome);
    if (!existingUsername) {
      const svnUsername = await window.showInputBox({
        title: '输入公共 SVN 用户名',
        prompt: '仅首次需要，之后新增产品/项目自动复用；密码仍由 SVN 系统凭据保存',
        validateInput: (value) => String(value || '').trim() ? undefined : 'SVN 用户名不能为空',
      });
      if (svnUsername === undefined) return undefined;
      result.svnUsername = svnUsername.trim();
    }
    return result;
  }

  const datasourceId = await window.showInputBox({
    title: '确认本地数据源 ID',
    value: `${result.id}-dev`,
    prompt: '用于 datasource.yaml 和工作区之间的本地引用',
    validateInput: (value) => SAFE_ID.test(String(value || '').trim()) ? undefined : '请输入有效的数据源 ID',
  });
  if (datasourceId === undefined) return undefined;
  const host = await window.showInputBox({ title: '数据库主机', value: '127.0.0.1', validateInput: (value) => String(value || '').trim() ? undefined : '主机不能为空' });
  if (host === undefined) return undefined;
  const port = await window.showInputBox({ title: '数据库端口', value: '3306', validateInput: (value) => /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535 ? undefined : '端口须为 1-65535' });
  if (port === undefined) return undefined;
  const database = await window.showInputBox({ title: '数据库名称', validateInput: (value) => String(value || '').trim() ? undefined : '数据库名称不能为空' });
  if (database === undefined) return undefined;
  const username = await window.showInputBox({ title: '数据库用户名', validateInput: (value) => String(value || '').trim() ? undefined : '用户名不能为空' });
  if (username === undefined) return undefined;
  const password = await window.showInputBox({ title: '数据库密码', password: true, prompt: '保存在本机数据目录的 datasource.yaml 中' });
  if (password === undefined) return undefined;
  result.datasource = {
    id: datasourceId.trim(),
    host: host.trim(),
    port: Number(port),
    database: database.trim(),
    username: username.trim(),
    password,
    environment: 'dev',
  };
  return result;
}

module.exports = {
  configuredSvnUsername,
  prepareWorkspaceSetup,
  promptWorkspaceCreation,
  suggestedWorkspaceId,
  workspaceActions,
};

const fs = require('node:fs');
const path = require('node:path');

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function existingWorkspaceConfig(toolHome) {
  const configDir = path.join(toolHome, 'config');
  const required = ['sync.yaml', 'products.yaml', 'projects.yaml'];
  const missing = required.filter((name) => {
    try { return !fs.statSync(path.join(configDir, name)).isFile(); }
    catch { return true; }
  });
  if (missing.length) throw new Error(`所选目录缺少已有工作空间配置：${missing.join('、')}。请选择包含 config 和 var 的本地数据目录`);
  try {
    if (fs.statSync(path.join(toolHome, 'var')).isDirectory()) return;
  } catch { /* Report the same validation error below. */ }
  throw new Error('所选目录缺少已有的 var 工作空间。请选择包含 config 和 var 的本地数据目录');
}

async function prepareWorkspaceSetup(config, window) {
  const toolHome = config.get('toolHome', '');
  const initialized = Boolean(toolHome && fs.existsSync(path.join(toolHome, 'config', 'sync.yaml')));
  if (initialized) {
    const confirmed = await window.showWarningMessage(
      `当前工作空间已设置：${toolHome}\n请选择刷新当前状态或切换工作空间。`,
      { modal: true },
      '刷新当前状态',
      '切换工作空间'
    );
    if (confirmed === '刷新当前状态') return { mode: 'refresh', toolHome };
    if (confirmed !== '切换工作空间') return undefined;
  }

  const selected = await window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: initialized
      ? '选择新的 GuthonCodeTool 本地数据工作空间'
      : '选择 GuthonCodeTool 本地数据工作空间',
  });
  if (!selected?.length) return undefined;

  const selectedHome = selected[0].fsPath;
  if (fs.existsSync(path.join(selectedHome, 'config', 'sync.yaml'))) {
    existingWorkspaceConfig(selectedHome);
    return { mode: 'switch', toolHome: selectedHome };
  }
  return { mode: 'setup', toolHome: selectedHome };
}

function workspaceActions(item) {
  const capability = (name) => Boolean(item.capabilities?.[name]);
  if (item.sourceMode === 'svn') {
    return {
      source: [
        ['搜索工作区完整索引', 'gushenCompletion.searchWorkspace', 'search'],
        capability('svn.initialize') && ['检出/更新完整 SVN 仓库', 'gushenCompletion.initializeSvn', 'repo-clone'],
        capability('svn.reindex') && ['扫描/重建本地 SVN 索引', 'gushenCompletion.reindexCalls', 'refresh'],
        capability('svn.browse') && ['查看谷神同步源码', 'gushenCompletion.focusSvnSource', 'list-tree'],
        capability('svn.status') && ['管理本地源码变更', 'gushenCompletion.manageSvnChanges', 'source-control'],
        ['导出源码索引文档', 'gushenCompletion.exportMarkdown', 'book'],
      ].filter(Boolean),
      workcopy: [],
      metadata: [['配置数据库排查', 'gushenCompletion.configureDatabaseDiagnosis', 'database']],
      diagnose: false,
      syncAll: undefined,
    };
  }
  return {
    source: [
      ['搜索工作区完整索引', 'gushenCompletion.searchWorkspace', 'search'],
      ['拉取源码重建索引', 'gushenCompletion.initSourceIndex', 'database'],
      ['拉取源码', 'gushenCompletion.syncWorkspaceSource', 'sync'],
      ['重建索引', 'gushenCompletion.reindexCalls', 'refresh'],
      ['导出源码索引文档', 'gushenCompletion.exportMarkdown', 'book'],
    ],
    workcopy: [['检查或打包 Workcopy', 'gushenCompletion.inspectWorkcopy', 'package']],
    metadata: [
      ['配置数据库排查', 'gushenCompletion.configureDatabaseDiagnosis', 'database'],
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

async function promptWorkspaceCreation(window, workspaces, _toolHome, now = new Date()) {
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
    { label: 'SVN', description: '先创建 Nexus，再在项目节点中设置登录和导入范围', value: 'svn' },
    { label: 'DATABASE', description: '先创建 Nexus，后续再补充数据源配置', value: 'database' },
  ], { title: '选择源码来源' });
  if (!source) return undefined;

  return {
    kind: kindChoice.value,
    id: id.trim(),
    name: name.trim(),
    sourceMode: source.value,
  };
}

module.exports = {
  existingWorkspaceConfig,
  prepareWorkspaceSetup,
  promptWorkspaceCreation,
  suggestedWorkspaceId,
  workspaceActions,
};

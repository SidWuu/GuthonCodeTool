const fs = require('node:fs');
const path = require('node:path');

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
        capability('svn.refresh') && ['更新指定 SVN working copy', 'gushenCompletion.refreshSvn', 'repo-sync'],
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

module.exports = { prepareWorkspaceSetup, workspaceActions };

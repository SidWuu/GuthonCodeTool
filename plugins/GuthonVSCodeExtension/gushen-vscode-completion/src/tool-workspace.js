const fs = require('node:fs');
const path = require('node:path');

async function prepareWorkspaceSetup(config, window, configurationTarget) {
  const toolHome = config.get('toolHome', '');
  if (!toolHome || !fs.existsSync(path.join(toolHome, 'config', 'sync.yaml'))) return 'setup';

  const confirmed = await window.showWarningMessage(
    `当前工作区已初始化：${toolHome}\n是否切换工作区？`,
    { modal: true },
    '切换工作区'
  );
  if (confirmed !== '切换工作区') return undefined;

  const selected = await window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: '选择新的 GuthonCodeTool 本地数据目录',
  });
  if (!selected) return undefined;

  await config.update('toolHome', selected[0].fsPath, configurationTarget);
  return 'switch';
}

module.exports = { prepareWorkspaceSetup };

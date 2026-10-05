const fs=require('node:fs');
const path=require('node:path');

const { nexusFiles, packageFingerprint } = require('./extension-package');

function extensionBuildInfo(root) {
  const files = nexusFiles(root);
  const info = JSON.parse(files.get('package.json').toString('utf8'));
  return { version: info.version, buildId: packageFingerprint(files), hashedFiles: files.size };
}

function registerExtensionBuild(vscode,context) {
  const info=extensionBuildInfo(context.extensionPath);
  const item=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,0);
  item.text=`Guthon Nexus ${info.version} · ${info.buildId.slice(7,15)}`;
  item.tooltip=`当前已加载 Nexus\n版本：${info.version}\n构建标识：${info.buildId}\n标识基于公开插件代码及资源；后端 buildId 由独立 runtime status 提供。`;
  item.show();context.subscriptions.push(item);
  return info;
}
module.exports={extensionBuildInfo,registerExtensionBuild};

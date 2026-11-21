const fs = require('node:fs');
const path = require('node:path');

function workspaceRoot(home) {
  let name = 'var';
  try {
    const config = JSON.parse(fs.readFileSync(path.join(home, 'config', 'guthon.json'), 'utf8'));
    if (Object.hasOwn(config, 'workspaceDirectory')) {
      if (config?.schemaVersion !== 3) throw new Error('当前配置版本不支持自定义开发目录');
      name = config.workspaceDirectory;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (typeof name !== 'string' || !name || name.trim() !== name || name === '.' || name.endsWith('.')
      || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(name) || (/^(?:config|guthoncodetool|\.git)$/i.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name))) {
    throw new Error('开发目录名称无效');
  }
  const root = path.join(home, name);
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('开发目录必须是独立真实目录');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return root;
}

module.exports = { workspaceRoot };

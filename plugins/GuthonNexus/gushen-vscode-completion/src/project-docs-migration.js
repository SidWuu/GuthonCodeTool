const fs = require('node:fs/promises');
const { constants, createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');

async function statIfPresent(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

async function copyProjectDocs({ backupWorkspace, originalProject, docsDir }) {
  if (![backupWorkspace, originalProject, docsDir].every(value => typeof value === 'string' && path.isAbsolute(value))) {
    throw new Error('需要明确的备份项目目录和当前项目文档目录');
  }
  if (!(await statIfPresent(path.dirname(backupWorkspace)))?.isDirectory()
    || !(await statIfPresent(backupWorkspace))?.isDirectory()) {
    throw new Error('backup/workspace 必须是实际目录');
  }
  const backup = await fs.realpath(backupWorkspace);
  const original = await fs.realpath(originalProject);
  if (path.relative(backup, path.dirname(original)) || !(await fs.lstat(originalProject)).isDirectory()) {
    throw new Error('请选择 backup/workspace 下的原项目目录');
  }
  const source = path.join(original, 'docs');
  if (!(await statIfPresent(source))?.isDirectory()) {
    throw new Error('所选原项目缺少可读取的 docs 目录');
  }

  const targetStat = await statIfPresent(docsDir);
  if (targetStat && !targetStat.isDirectory()) {
    throw new Error('当前项目的 docs 路径必须是实际目录');
  }
  const target = targetStat ? await fs.realpath(docsDir)
    : path.join(await fs.realpath(path.dirname(docsDir)), path.basename(docsDir));
  if (inside(path.dirname(backup), target) || inside(target, source)) {
    throw new Error('当前项目的 docs 与备份目录重叠');
  }

  const directories = targetStat ? [] : [target];
  const files = [];
  let identical = 0;
  const pending = [''];
  while (pending.length) {
    const parent = pending.pop();
    const entries = await fs.readdir(path.join(source, parent), { withFileTypes: true });
    const names = new Set();
    for (const entry of entries) {
      const relative = path.join(parent, entry.name);
      const input = path.join(source, relative);
      const output = path.join(target, relative);
      const folded = entry.name.normalize('NFC').toLowerCase();
      if (names.has(folded)) throw new Error(`备份中有无法区分的文件名：${relative}`);
      names.add(folded);
      if (!entry.isDirectory() && !entry.isFile()) {
        throw new Error(`备份中有符号链接或特殊文件：${relative}`);
      }
      const present = await statIfPresent(output);
      if (entry.isDirectory() && (!present || present.isDirectory())) {
        if (!present) directories.push(output);
        pending.push(relative);
      } else if (entry.isFile() && !present) {
        files.push({ input, output });
      } else if (entry.isFile() && present?.isFile() && (await fs.stat(input)).size === present.size
        && await fileHash(input) === await fileHash(output)) {
        identical++;
      } else {
        throw new Error(`当前项目已有不同内容或同名路径：${relative}。请核对该项后重试。`);
      }
    }
  }

  for (const directory of directories) await fs.mkdir(directory);
  for (const { input, output } of files) {
    await fs.copyFile(input, output, constants.COPYFILE_EXCL);
  }
  return { files: files.length, directories: directories.length, identical };
}

async function migrateProjectDocs({ vscode, getTool, getCurrentWorkspace, workspace }) {
  const toolHome = getTool()?.toolHome;
  if (!toolHome || !workspace?.docsDir) {
    throw new Error('请先选中已登记的目标项目');
  }
  const backupWorkspace = path.join(toolHome, 'backup', 'workspace');
  if (!(await statIfPresent(backupWorkspace))?.isDirectory()) {
    throw new Error('找不到 backup/workspace，请先将原 var 的内容备份到本地数据目录下的 backup');
  }
  if (workspace.index?.ready === false) {
    void vscode.window.showInformationMessage('请先按原同步方式提交或回写旧源码并确认谷神生效，再在新项目更新源码和重建索引。此入口仅迁移 docs。');
  }
  const picked = await vscode.window.showOpenDialog({
    title: `从原目录迁移文档到「${workspace.name || workspace.displayName}」`,
    defaultUri: vscode.Uri.file(backupWorkspace),
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: '迁移此项目的 docs',
  });
  if (!picked?.length) return;
  if (picked[0].scheme !== 'file') throw new Error('请选择本机备份中的原项目目录');
  const current = await getCurrentWorkspace();
  if (getTool()?.toolHome !== toolHome || current?.workspaceKey !== workspace.workspaceKey
    || current.docsDir !== workspace.docsDir) {
    throw new Error('当前项目或数据目录已变化，请重新执行迁移');
  }
  const result = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `正在迁移「${workspace.name || workspace.displayName}」的文档`,
  }, () => copyProjectDocs({ backupWorkspace, originalProject: picked[0].fsPath, docsDir: current.docsDir }));
  const duplicates = result.identical ? `，已存在 ${result.identical} 个相同文件` : '';
  return vscode.window.showInformationMessage(`文档迁移完成。已复制 ${result.files} 个文件，创建 ${result.directories} 个目录${duplicates}。`);
}

module.exports = { copyProjectDocs, migrateProjectDocs };

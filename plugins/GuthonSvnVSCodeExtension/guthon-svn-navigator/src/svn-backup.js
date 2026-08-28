'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BACKUP_EXCLUDED_ITEMS = new Set(['unversioned', 'conflicted']);

function changedEntries(inspections) {
  return inspections.flatMap((inspection) => inspection.entries
    .filter((entry) => !BACKUP_EXCLUDED_ITEMS.has(entry.item))
    .map((entry) => ({ ...entry, target: inspection.target })));
}

function relativeBackupPath(root, filePath) {
  const relative = path.relative(root, filePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return path.basename(filePath);
  }
  return relative;
}

/**
 * Copy the bytes currently on disk instead of serializing `svn diff`.
 * SVN diff output is locale-sensitive and can fail when a Chinese file
 * cannot be converted to the process locale.
 */
async function backupWorkingCopyFiles({ backupDirectory, repository, inspections }) {
  const root = repository.logicalRoot || repository.root;
  const entries = changedEntries(inspections);
  const manifestEntries = [];

  for (const entry of entries) {
    const relativePath = relativeBackupPath(root, entry.filePath);
    const backupPath = path.join(backupDirectory, 'files', relativePath);
    let exists = false;
    let backedUp = false;
    try {
      const stat = await fs.promises.stat(entry.filePath);
      exists = stat.isFile();
      if (exists) {
        await fs.promises.mkdir(path.dirname(backupPath), { recursive: true });
        await fs.promises.copyFile(entry.filePath, backupPath);
        backedUp = true;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    manifestEntries.push({
      path: relativePath.replace(/\\/g, '/'),
      absolutePath: entry.filePath,
      status: entry.item,
      properties: entry.properties || '',
      exists,
      backupPath: backedUp ? path.relative(backupDirectory, backupPath).replace(/\\/g, '/') : null
    });
  }

  await fs.promises.writeFile(
    path.join(backupDirectory, 'manifest.json'),
    `${JSON.stringify({
      format: 1,
      kind: 'svn-working-copy-snapshot',
      createdAt: new Date().toISOString(),
      projectId: repository.projectId || '',
      projectName: repository.label || '',
      root,
      entries: manifestEntries
    }, null, 2)}\n`,
    'utf8'
  );
  return backupDirectory;
}

module.exports = { backupWorkingCopyFiles, changedEntries, relativeBackupPath };

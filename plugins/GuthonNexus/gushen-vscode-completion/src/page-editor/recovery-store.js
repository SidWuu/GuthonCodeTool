const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function reference(value) {
  if (value?.kind !== 'page-recovery-v1') return false;
  if (!/^[a-f0-9]{64}$/.test(value.id || '')) throw new Error('页面恢复记录引用无效，原状态已保留');
  return true;
}

class PageRecoveryStore {
  constructor(context) { this.root = context?.storageUri?.fsPath || context?.globalStorageUri?.fsPath; }
  directory(key) {
    if (!this.root || !/^guthon\.pageDraft\.[a-f0-9]{64}$/.test(key)) throw new Error('页面恢复记录缺少明确的 IDE 私有存储位置或页面身份');
    return path.join(this.root, 'page-recovery', key.slice('guthon.pageDraft.'.length));
  }
  async save(key, value) {
    if (!value || reference(value)) return value;
    const pending = [], seen = new Set(); let previous = value;
    while (previous && !reference(previous)) {
      if (seen.has(previous)) throw new Error('页面恢复历史包含循环引用');
      seen.add(previous); pending.push(previous); previous = previous.previous || null;
    }
    const directory = this.directory(key);
    await fs.mkdir(directory, {recursive: true, mode: 0o700});
    for (const record of pending.reverse()) {
      const text = JSON.stringify({...record, previous}), id = crypto.createHash('sha256').update(text).digest('hex');
      const target = path.join(directory, id + '.json');
      const temporary = path.join(directory, '.' + id + '.' + crypto.randomUUID() + '.tmp');
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(text); await handle.sync(); }
        finally { await handle.close(); }
        try { await fs.link(temporary, target); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (await fs.readFile(target, 'utf8') !== text) throw new Error('页面恢复记录校验失败，原文件已保留');
        }
      } finally {
        try { await fs.unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      previous = {kind: 'page-recovery-v1', id};
    }
    if (process.platform !== 'win32') for (const name of [directory, path.dirname(directory), this.root]) {
      const handle = await fs.open(name, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    }
    return previous;
  }
  async head(key, value) {
    if (!reference(value)) return value;
    const text = await fs.readFile(path.join(this.directory(key), value.id + '.json'), 'utf8');
    if (crypto.createHash('sha256').update(text).digest('hex') !== value.id) throw new Error('页面恢复记录校验失败，原文件已保留');
    return JSON.parse(text);
  }
  async expand(key, value) {
    const records = [], seen = new Set(); let current = value;
    while (current) {
      if (reference(current)) {
        if (seen.has(current.id)) throw new Error('页面恢复历史引用重复');
        seen.add(current.id); current = await this.head(key, current);
      } else if (seen.has(current)) throw new Error('页面恢复历史包含循环引用');
      else seen.add(current);
      records.push(current); current = current.previous;
    }
    let result = null;
    for (const record of records.reverse()) result = {...record, previous: result};
    return result;
  }
}

module.exports = {PageRecoveryStore};

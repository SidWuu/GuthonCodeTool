const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createBrowserUpdates(home, { now = Date.now, busy = () => false } = {}) {
  const clients = new Map();
  const directory = path.join(home, 'var', 'nexus', 'updates', 'chrome');
  let guard;
  function read(file) {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 65536) throw new Error('浏览器更新记录无效');
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }
  function heartbeat(payload, origin) {
    const keys = ['clientId', 'extensionId', 'version', 'protocolVersion', 'installId', 'sourceBuildId'];
    if (!payload || Object.keys(payload).some(key => !keys.includes(key))
        || !/^[a-zA-Z0-9-]{16,80}$/.test(payload.clientId || '')
        || !/^[a-p]{32}$/.test(payload.extensionId || '') || !/^\d+\.\d+\.\d+$/.test(payload.version || '')
        || payload.protocolVersion !== 2 || (payload.installId && !/^[a-f0-9-]{36}$/.test(payload.installId))
        || (payload.sourceBuildId && !/^sha256:[a-f0-9]{64}$/.test(payload.sourceBuildId))
        || (origin && origin !== 'chrome-extension://' + payload.extensionId)) throw new Error('Chrome 更新客户端身份无效');
    list();
    if (!clients.has(payload.clientId) && clients.size >= 16) throw new Error('Chrome 更新客户端数量超过限制');
    const item = { ...payload, seenAt: now() }; clients.set(item.clientId, item);
    const request = read(path.join(directory, 'reload-request.json'));
    const marker = read(path.join(directory, 'extension', 'managed-install.json'));
    const manifest = read(path.join(directory, 'extension', 'manifest.json'));
    const reload = Boolean(request && marker && request.installId === payload.installId
      && marker.installId === payload.installId && request.version === marker.version
      && marker.version === manifest?.version && (payload.version !== request.version || (marker.sourceBuildId && payload.sourceBuildId !== marker.sourceBuildId))
      && Number.isFinite(request.requestedAt) && request.requestedAt <= now()
      && now() - request.requestedAt < 7 * 86400000 && !maintenance() && !busy());
    return { ok: true, reload, targetVersion: reload ? marker.version : undefined, targetBuildId: reload ? marker.sourceBuildId : undefined };
  }
  function list() {
    for (const [id, client] of clients) if (now() - client.seenAt > 150000) clients.delete(id);
    return [...clients.values()];
  }
  function maintenance() {
    if (guard && guard.expiresAt <= now()) guard = undefined;
    return Boolean(guard);
  }
  function acquire() {
    if (maintenance() || busy()) throw new Error('Bridge 有操作执行中或已被其他窗口锁定，请稍后更新');
    guard = { id: crypto.randomUUID(), expiresAt: now() + 120000 };
    return { ok: true, ...guard };
  }
  function release(id) {
    if (maintenance() && guard.id !== id) throw new Error('更新维护锁不属于此请求');
    guard = undefined; return { ok: true };
  }
  return { heartbeat, list, acquire, release, maintenance };
}
module.exports = { createBrowserUpdates };

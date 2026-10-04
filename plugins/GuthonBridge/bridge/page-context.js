const crypto = require('node:crypto');

const WORKSPACE = /^(products|projects)\.[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const CLIENT = /^[a-zA-Z0-9-]{16,80}$/;
const PAGE = /^PG-[A-Za-z0-9-]{1,96}$/;
const ALIAS = /^[A-Za-z_$][A-Za-z0-9_.$]{0,255}$/;
const FUNCTION = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;

function text(value, max = 256) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';
}

function navigationTarget(value) {
  if (value?.type === 'page' && PAGE.test(value.pageId)) return {type: 'page', pageId: value.pageId};
  if (value?.type === 'procedure' && ALIAS.test(value.alias) && FUNCTION.test(value.funId)) {
    return {type: 'procedure', alias: value.alias, funId: value.funId};
  }
  throw new Error('浏览器定位需要精确 PAGE ID 或过程函数包名和函数名');
}

function snapshot(payload) {
  if (!WORKSPACE.test(payload?.workspaceKey) || !CLIENT.test(payload?.clientId)
      || !Number.isInteger(payload.tabId) || payload.tabId < 0) throw new Error('页面快照缺少有效工作区或页签身份');
  const origin = new URL(payload.pageOrigin);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== payload.pageOrigin) throw new Error('页面来源无效');
  const metadata = payload.metadata || {};
  const mode = text(metadata.mode || 'procedure', 32);
  const data = {};
  // Explicit allowlist: no editor body, SQL, selectedText, credentials or paths.
  for (const key of ['pageId', 'procedureKeyword', 'funId', 'dataSourceId', 'systemId']) data[key] = text(metadata[key]);
  for (const key of ['dataSourceIds', 'systemIds']) data[key] = Array.isArray(metadata[key]) ? metadata[key].slice(0, 32).map(value => text(value, 128)).filter(Boolean) : [];
  const tab = value => ({id: text(value?.id, 128), label: text(value?.label, 128)});
  data.selectedTab = tab(metadata.selectedTab);
  data.openTabs = Array.isArray(metadata.openTabs) ? metadata.openTabs.slice(0, 32).map(tab) : [];
  if (Number.isInteger(metadata.editorCursor?.line) && metadata.editorCursor.line > 0
      && Number.isInteger(metadata.editorCursor?.column) && metadata.editorCursor.column > 0) {
    data.editorCursor = {line: Math.min(metadata.editorCursor.line, 1000000), column: Math.min(metadata.editorCursor.column, 1000000)};
  }
  return {contextId: `${payload.clientId}:${payload.tabId}`, clientId: payload.clientId,
    tabId: payload.tabId, workspaceKey: payload.workspaceKey, pageOrigin: origin.origin,
    hash: text(metadata.hash, 512).split('?')[0], mode, ...data};
}

function createPageContexts({now = Date.now, ttlMs = 150000, limit = 64, commandTtlMs = 30000} = {}) {
  const contexts = new Map();
  const commands = new Map();
  const subscribers = new Set();
  function emit(event, data, filter) {
    for (const subscriber of subscribers) {
      if (!filter(subscriber)) continue;
      if (subscriber.res.destroyed || !subscriber.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) {
        subscriber.res.destroy(); subscribers.delete(subscriber);
      }
    }
  }
  function expire() {
    for (const [id, item] of contexts) if (item.expiresAt <= now()) {
      contexts.delete(id);
      emit('page-context-removed', {contextId: id, workspaceKey: item.workspaceKey}, s => s.workspaceKey === item.workspaceKey);
    }
    for (const [id, item] of commands) if (item.expiresAt <= now()) commands.delete(id);
  }
  function publish(payload) {
    expire();
    const item = snapshot(payload);
    if (!contexts.has(item.contextId) && contexts.size >= limit) throw new Error('页面快照容量已满，请关闭闲置平台页签');
    const previous = contexts.get(item.contextId);
    const changed = !previous || JSON.stringify({...previous, updatedAt: 0, expiresAt: 0}) !== JSON.stringify({...item, updatedAt: 0, expiresAt: 0});
    item.updatedAt = now(); item.expiresAt = now() + ttlMs;
    contexts.set(item.contextId, item);
    if (previous && previous.workspaceKey !== item.workspaceKey) {
      emit('page-context-removed', {contextId: item.contextId, workspaceKey: previous.workspaceKey}, s => s.workspaceKey === previous.workspaceKey);
    }
    if (changed) emit('page-context', item, s => s.workspaceKey === item.workspaceKey);
    return item;
  }
  function list(workspaceKey) {
    if (!WORKSPACE.test(workspaceKey)) throw new Error('必须指定有效 workspaceKey');
    expire(); return [...contexts.values()].filter(item => item.workspaceKey === workspaceKey);
  }
  function remove(clientId, tabId) {
    if (!CLIENT.test(clientId) || !Number.isInteger(tabId)) throw new Error('页签身份无效');
    const item = contexts.get(`${clientId}:${tabId}`);
    if (item) { contexts.delete(item.contextId); emit('page-context-removed', {contextId: item.contextId, workspaceKey: item.workspaceKey}, s => s.workspaceKey === item.workspaceKey); }
  }
  function get(contextId, workspaceKey) {
    const item = list(workspaceKey).find(item => item.contextId === contextId);
    if (!item) throw new Error('平台页签快照已过期或不属于目标工作区，请在平台刷新定位上下文');
    return item;
  }
  function navigate(payload) {
    const context = get(payload.contextId, payload.workspaceKey);
    const target = navigationTarget(payload.target);
    if (![...subscribers].some(s => s.clientId === context.clientId && !s.res.destroyed)) throw new Error('浏览器事件连接未就绪，请刷新平台页签');
    if (commands.size >= 64) throw new Error('浏览器定位请求过多，请等待完成');
    const item = {requestId: crypto.randomUUID(), contextId: context.contextId, clientId: context.clientId,
      tabId: context.tabId, workspaceKey: context.workspaceKey, pageOrigin: context.pageOrigin,
      target, state: 'PENDING', expiresAt: now() + commandTtlMs};
    commands.set(item.requestId, item);
    emit('navigate', item, s => s.clientId === context.clientId);
    return {ok: true, requestId: item.requestId, state: item.state};
  }
  function result(payload) {
    expire();
    const item = commands.get(payload.requestId);
    if (!item || item.workspaceKey !== payload.workspaceKey) throw new Error('定位请求已过期或不属于目标工作区；禁止自动重放');
    return {ok: true, requestId: item.requestId, state: item.state, message: item.message || ''};
  }
  function complete(payload) {
    expire();
    const item = commands.get(payload.requestId);
    if (!item || item.clientId !== payload.clientId || item.tabId !== payload.tabId || item.workspaceKey !== payload.workspaceKey) throw new Error('定位回执身份不匹配');
    if (item.state !== 'PENDING') return result(item);
    item.state = payload.ok === true ? 'SUCCEEDED' : 'FAILED';
    item.message = text(payload.message, 512);
    emit('navigation-result', result(item), s => s.workspaceKey === item.workspaceKey);
    return result(item);
  }
  function subscribe(res, filter) {
    if (!(CLIENT.test(filter.clientId || '') || WORKSPACE.test(filter.workspaceKey || ''))
        || (filter.clientId && filter.workspaceKey)) throw new Error('事件订阅需要唯一 clientId 或 workspaceKey');
    if (subscribers.size >= 32) throw new Error('事件订阅容量已满');
    // A worker reconnect replaces its prior stream. Pending commands are never replayed.
    for (const old of subscribers) if (filter.clientId && old.clientId === filter.clientId) { old.res.end(); subscribers.delete(old); }
    res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no'});
    res.write(': connected\n\n');
    const subscriber = {res, ...filter}; subscribers.add(subscriber);
    const heartbeat = setInterval(() => { expire(); if (!res.destroyed) res.write(': heartbeat\n\n'); }, 20000);
    res.on('close', () => {clearInterval(heartbeat); subscribers.delete(subscriber);});
  }
  function dispose() {for (const s of subscribers) s.res.end(); subscribers.clear();}
  return {publish, list, remove, get, navigate, result, complete, subscribe, expire, dispose};
}

module.exports = {createPageContexts, snapshot, navigationTarget};

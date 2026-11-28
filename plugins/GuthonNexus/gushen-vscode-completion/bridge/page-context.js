const crypto = require('node:crypto');
const {metadataTarget} = require('./native-metadata');

const WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9._-]*$(?![\s\S])/;
const isWorkspaceKey = value => typeof value === 'string' && WORKSPACE.test(value);
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

function lifecycleTarget(value) {
  if (!value || !['inspect', 'create', 'copy', 'delete'].includes(value.action)) throw new Error('无效的 PAGE 生命周期操作');
  if (value.pageId && !PAGE.test(value.pageId)) throw new Error('PAGE 身份无效');
  if (['copy', 'delete'].includes(value.action) && !PAGE.test(value.pageId || '')) throw new Error('必须指定来源 PAGE');
  if (value.sourcePointer !== undefined && (value.action !== 'inspect' || value.sourcePointer !== '/compScript' || !PAGE.test(value.pageId || ''))) {
    throw new Error('只读服务 PAGE 正文需要精确 PAGE ID 和 /compScript');
  }
  if (JSON.stringify(value).length > 12000) throw new Error('PAGE 生命周期参数过大');
  return Object.fromEntries(['action','pageId','properties','expectedVersion','expectedPage','sourcePointer']
    .filter(key => value[key] !== undefined).map(key => [key,value[key]]).concat([['type','page-lifecycle']]));
}

function snapshot(payload) {
  if (!isWorkspaceKey(payload?.workspaceKey) || !CLIENT.test(payload?.clientId)
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

function databaseProcedureSystem(context, systemIds = context.databaseProcedureSystemIds) {
    return context.systemId || (systemIds?.length === 1 ? systemIds[0] : '');
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
  function publish(payload, databaseProcedureSystemIds) {
    expire();
    const item = snapshot(payload);
    if (databaseProcedureSystemIds) item.databaseProcedureSystemIds = databaseProcedureSystemIds;
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
    if (!isWorkspaceKey(workspaceKey)) throw new Error('必须指定有效 workspaceKey');
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
  function dispatch(payload, lifecycle = false, completePrivate) {
    const context = get(payload.contextId, payload.workspaceKey);
    const metadata = lifecycle === 'metadata';
    const target = completePrivate ? payload.target
      : metadata ? metadataTarget(payload.target) : lifecycle ? lifecycleTarget(payload.target) : navigationTarget(payload.target);
    if (![...subscribers].some(s => s.clientId === context.clientId && !s.res.destroyed)) throw new Error('浏览器事件连接未就绪，请刷新平台页签');
    if (commands.size >= 64) throw new Error('浏览器定位请求过多，请等待完成');
    const item = {requestId: crypto.randomUUID(), contextId: context.contextId, clientId: context.clientId,
      tabId: context.tabId, workspaceKey: context.workspaceKey, pageOrigin: context.pageOrigin,
      target, state: 'PENDING', expiresAt: now() + (lifecycle ? 120000 : commandTtlMs)};
    commands.set(item.requestId, {...item, completePrivate});
    const event = completePrivate ? target.type : metadata ? 'native-metadata' : lifecycle ? 'page-lifecycle' : 'navigate';
    const notice = completePrivate ? {...item, target:{...target, evidence:undefined}} : item;
    emit(event, notice, s => s.clientId === context.clientId);
    return {ok: true, requestId: item.requestId, state: item.state};
  }
  function result(payload) {
    expire();
    const item = commands.get(payload.requestId);
    if (!item || item.completePrivate || item.workspaceKey !== payload.workspaceKey) throw new Error('定位请求已过期或不属于目标工作区；禁止自动重放');
    return {ok: true, requestId: item.requestId, state: item.state, message: item.message || '',
      ...(['page-lifecycle','native-metadata'].includes(item.target.type) ? {data: item.data || null} : {})};
  }
  function privatePayload(payload) {
    expire();
    const item = commands.get(payload.requestId);
    if (!item?.completePrivate || item.clientId !== payload.clientId || item.tabId !== payload.tabId
        || item.workspaceKey !== payload.workspaceKey) throw new Error('浏览器 DATABASE 请求身份不匹配');
    return {ok:true, evidence:item.target.evidence};
  }
  function complete(payload, pagePublication = false) {
    expire();
    const item = commands.get(payload.requestId);
    if (!item || item.clientId !== payload.clientId || item.tabId !== payload.tabId || item.workspaceKey !== payload.workspaceKey) throw new Error('定位回执身份不匹配');
    if ((item.target.type === 'database-page') !== pagePublication) throw new Error('DATABASE PAGE 回执类型不匹配');
    if (item.completePrivate) {
      commands.delete(item.requestId);
      item.completePrivate(payload);
      return {ok:true};
    }
    if (item.state !== 'PENDING') return result(item);
    item.state = payload.ok === true ? 'SUCCEEDED' : 'FAILED';
    item.message = text(payload.message, 512);
    if (item.target.type === 'page-lifecycle') {
      const {data} = payload;
      const readPage = item.target.action === 'inspect';
      const pointer = item.target.sourcePointer;
      const validData = data && JSON.stringify(data).length <= 32000;
      if (validData) {
        item.data = Object.fromEntries(['state','action','page','sourceVersion','modules','systemIds','message','platformApplied','pageInfoSource']
          .filter(key => data[key] !== undefined).map(key => [key,data[key]]));
      }
      if (readPage) {
        const validSource = !pointer || (data?.platformApplied === false && data.sourcePointer === pointer
          && typeof data.sourceContent === 'string'
          && JSON.stringify(data.sourceContent).length <= 20000
          && data.page?.pageId === item.target.pageId && typeof data.sourceVersion === 'string'
          && data.sourceVersion.length > 0 && data.sourceVersion.length <= 128);
        if (!validData || data.state !== 'SUCCEEDED' || !validSource) {
          item.state = 'FAILED';
          item.message = text(data?.message, 512) || item.message || 'PAGE 只读回执不完整或身份不一致';
          item.data = {state:'REJECTED',platformApplied:false,message:item.message};
        } else if (pointer) {
          Object.assign(item.data, {sourcePointer:pointer,sourceContent:data.sourceContent});
        }
      }
    }
    if (item.target.action === 'inspect-database-procedure' && item.target.type === 'native-metadata') {
      const {data} = payload;
      const after = data?.after;
      const valid = data?.state === 'SUCCEEDED' && data.platformApplied === false && after?.origin === item.pageOrigin
        && ['systemId','dataSourceId','procedureAlias','funId'].every(key=>after[key] === item.target[key])
        && typeof after.procedureId === 'string' && /^PR-[A-Za-z0-9-]{1,96}$/.test(after.procedureId)
        && typeof after.version === 'string' && after.version.length > 0 && after.version.length <= 128
        && (!item.target.includeSourceHash || (typeof after.contentHash === 'string' && /^[0-9a-f]{64}$/.test(after.contentHash)));
      if (valid) {
        const fields = ['origin','systemId','dataSourceId','procedureAlias','funId','procedureId','version'];
        if (item.target.includeSourceHash) fields.push('contentHash');
        item.data = {state:'SUCCEEDED',platformApplied:false,after:Object.fromEntries(fields.map(key=>[key,after[key]]))};
      } else {
        item.state = 'FAILED';
        item.message = text(data?.message, 512) || item.message || '平台对象身份或正文摘要未通过预检';
        item.data = {state:'REJECTED',platformApplied:false,message:item.message};
      }
    } else if (item.target.type === 'native-metadata' && payload.data && JSON.stringify(payload.data).length <= 32000) {
      item.data = Object.fromEntries(['state','action','field','snapshot','before','after','changed','message','platformApplied','pageId','sourceVersion','projectionCount','guidFlags','autoCompileRequested','savedVersion','runtimePath','scripts']
        .filter(key => payload.data[key] !== undefined).map(key => [key,payload.data[key]]));
    }
    const receipt = result(item);
    const notification = item.target.sourcePointer && receipt.data
      ? {...receipt,data:{...receipt.data,sourceContent:undefined}} : receipt;
    emit('navigation-result', notification, s => s.workspaceKey === item.workspaceKey);
    return receipt;
  }
  function subscribe(res, filter) {
    if (!(CLIENT.test(filter.clientId || '') || isWorkspaceKey(filter.workspaceKey))
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
  function databaseSource(context, action, target, evidence) {
    const current = get(context.contextId, context.workspaceKey);
    const fields = ['pageOrigin','clientId','tabId'];
    if (fields.some(key => current[key] !== context[key])) {
      throw new Error('已配对的发布页签身份发生变化');
    }
    return new Promise((resolve, reject) => {
      const {requestId} = dispatch({contextId:context.contextId, workspaceKey:context.workspaceKey,
        target:{type:target.pageId ? 'database-page' : 'database-procedure',action, target, evidence}}, false, payload => {
        clearTimeout(timeout);
        if (payload.ok === true && payload.data) resolve(payload.data);
        else reject(new Error(text(payload.message, 512) || '浏览器未能完成 DATABASE 源码操作'));
      });
      const timeout = setTimeout(() => {
        commands.delete(requestId);
        reject(new Error('浏览器 DATABASE 源码操作未及时返回'));
      }, commandTtlMs);
      timeout.unref();
    });
  }
  function dispose() {for (const s of subscribers) s.res.end(); subscribers.clear();}
  return {publish, list, remove, get, databaseSource, privatePayload, navigate: payload => dispatch(payload), lifecycle: payload => dispatch(payload, true), metadata: payload => dispatch(payload,'metadata'), result, complete, subscribe, expire, dispose};
}

module.exports = {createPageContexts, snapshot, navigationTarget, isWorkspaceKey, databaseProcedureSystem};

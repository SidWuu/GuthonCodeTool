importScripts("host-settings.js", "host-config.js", "nexus-locator.js", "task-history.js", "event-client.js", "component-client.js");

chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({}, (tabs) => {
    tabs.filter((tab) => tab.id && GuthonBridgeHost.isAllowed(tab.url)).forEach((tab) => {
      chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ["bridge.css"]
      }).catch(() => {});
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["host-settings.js", "host-config.js", "fields-mover-core.js", "page-bridge.js"],
        world: "MAIN"
      }).catch(() => {});
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["host-settings.js", "host-config.js", "nexus-locator.js", "workspace-selection.js", "task-client.js", "content.js"]
      }).catch(() => {});
    });
  });
});

const BRIDGE_ROUTES = {
  "route-workspace": "/routeWorkspace",
  "save-pull-result": "/saveRemoteFile",
  "log-pull-failure": "/logPullFailure",
  "pull-hub-source": "/pullHubSource",
  "export-table-schema": "/exportTableSchema",
  "export-bill-type": "/exportBillType",
  "export-view-sql": "/exportViewSql",
  "export-system-scripts": "/exportSystemScripts",
  "query-procedure-callers": "/queryProcedureCallers"
};

async function bridgeRequest(path, payload) {
  const settings = await chrome.storage.local.get(["guthonBridgeToken", "guthonBridgePort"]);
  const port = Number(settings.guthonBridgePort || 17361);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Bridge 端口无效");
  if (!settings.guthonBridgeToken) throw new Error("请在扩展弹窗中配置 Bridge 配对令牌");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: payload === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${settings.guthonBridgeToken}` },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: controller.signal
    });
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`Bridge 返回了无效响应（HTTP ${response.status}），请检查本机端口配置`); }
    if (!response.ok || (data.ok === false && !data.workspaceSelectionRequired)) {
      throw new Error(data.message || `桥接请求失败：${path}`);
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Bridge 等待超时，执行结果未知，请先检查状态再重试");
    throw error;
  } finally { clearTimeout(timer); }
}

let pendingQueue = Promise.resolve();
let clientIdentity;
let eventConnection;
let eventRetry;
const publishedTabs = new Set();
async function clientId() {
  if (!clientIdentity) clientIdentity = (async () => {
    const stored = await chrome.storage.local.get('guthonBridgeClientId');
    const id = /^[a-zA-Z0-9-]{16,80}$/.test(stored.guthonBridgeClientId || '') ? stored.guthonBridgeClientId : crypto.randomUUID();
    if (id !== stored.guthonBridgeClientId) await chrome.storage.local.set({guthonBridgeClientId: id});
    return id;
  })();
  return clientIdentity;
}
function reportComponent() {
  if (!globalThis.GuthonBridgeComponents || !chrome.runtime.getManifest) return Promise.resolve();
  return GuthonBridgeComponents.heartbeat({ chrome, request: bridgeRequest, clientId }).catch(() => {});
}
chrome.alarms?.create('guthon-component-version', { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener(alarm => { if (alarm.name === 'guthon-component-version') void reportComponent(); });
chrome.runtime.onStartup?.addListener(() => { void reportComponent(); });
void reportComponent();
async function handleBridgeEvent(event, command) {
  if (event !== 'navigate') return;
  const identity = await clientId();
  if (command.clientId !== identity || !Number.isInteger(command.tabId)
      || command.contextId !== `${identity}:${command.tabId}` || !publishedTabs.has(command.tabId)) return;
  let ok = false; let message = '';
  try {
    const tab = await chrome.tabs.get(command.tabId);
    if (!GuthonBridgeHost.isAllowed(tab.url) || new URL(tab.url).origin !== command.pageOrigin) throw new Error('平台页签来源已改变');
    const inspected = await chrome.tabs.sendMessage(tab.id, {type: 'run-page-command', command: 'inspect-page-context'});
    if (!inspected?.ok) throw new Error('无法读取当前平台身份，请刷新页签');
    const route = await bridgeRequest('/routeWorkspace', {...inspected.data, pageOrigin: command.pageOrigin, workspaceKey: command.workspaceKey});
    if (!route.ok || route.workspaceKey !== command.workspaceKey) throw new Error('当前平台身份不属于目标工作区');
    if (!['page', 'procedure'].includes(command.target?.type)) throw new Error('不支持的定位对象类型');
    if (command.target.type === 'procedure' && !inspected.data.dataSourceId) throw new Error('未识别当前平台数据源，请先选择数据源');
    const opened = await chrome.tabs.sendMessage(tab.id, {type: 'run-page-command', command: 'open-source-target',
      payload: {...command.target, dataSourceId: inspected.data.dataSourceId}});
    if (!opened?.ok) throw new Error(opened?.message || '平台定位失败');
    await chrome.tabs.update(tab.id, {active: true});
    if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, {focused: true});
    ok = true;
    void chrome.tabs.sendMessage(tab.id, {type: 'refresh-page-context'}).catch(() => {});
  } catch (error) {message = error.message;}
  await bridgeRequest('/navigationResult', {requestId: command.requestId, clientId: identity,
    tabId: command.tabId, workspaceKey: command.workspaceKey, ok, message});
}
async function ensureEventConnection() {
  if (eventConnection || !publishedTabs.size) return;
  const settings = await chrome.storage.local.get(['guthonBridgeToken', 'guthonBridgePort']);
  const port = Number(settings.guthonBridgePort || 17361);
  if (!settings.guthonBridgeToken || !Number.isInteger(port) || port < 1 || port > 65535) return;
  if (eventRetry) {clearTimeout(eventRetry); eventRetry = undefined;}
  const controller = new AbortController();
  eventConnection = controller;
  void (async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/events?clientId=${encodeURIComponent(await clientId())}`, {
        headers: {Authorization: `Bearer ${settings.guthonBridgeToken}`}, signal: controller.signal,
      });
      await GuthonBridgeEvents.consume(response, handleBridgeEvent);
    } catch { /* The next lease heartbeat also wakes a terminated MV3 worker. */ }
    finally {
      if (eventConnection === controller) eventConnection = undefined;
      if (publishedTabs.size) eventRetry = setTimeout(() => {void ensureEventConnection();}, 3000);
    }
  })();
}
chrome.tabs.onRemoved?.addListener(tabId => {
  if (!publishedTabs.delete(tabId)) return;
  void clientId().then(id => bridgeRequest('/removePageContext', {clientId: id, tabId})).catch(() => {});
  if (!publishedTabs.size) eventConnection?.abort();
});
chrome.tabs.onUpdated?.addListener((tabId, changes) => {
  if (!changes.url || !publishedTabs.delete(tabId)) return;
  void clientId().then(id => bridgeRequest('/removePageContext', {clientId: id, tabId})).catch(() => {});
});
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && (changes.guthonBridgeToken || changes.guthonBridgePort)) {
    eventConnection?.abort();
  }
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (sender.id !== chrome.runtime.id) throw new Error("不允许的扩展消息来源");
    const popup = !sender.tab && sender.url === chrome.runtime.getURL("popup.html");
    if (!popup && (!sender.tab || !GuthonBridgeHost.isAllowed(sender.tab.url))) {
      throw new Error("当前标签页不是受信任的谷神开发平台");
    }
    if (message?.type === 'publish-page-context') {
      if (popup || !Number.isInteger(sender.tab.id)) throw new Error('页面快照只能由平台页签发布');
      const result = await bridgeRequest('/pageContext', {...message.payload, clientId: await clientId(),
        tabId: sender.tab.id, pageOrigin: new URL(sender.tab.url).origin});
      if (result.ok) {publishedTabs.add(sender.tab.id); await ensureEventConnection();}
      return {ok: result.ok, message: result.message};
    }
    if (message?.type?.startsWith("bridge-history-")) {
      const tab = sender.tab || (await chrome.tabs.query({active:true,currentWindow:true}))[0];
      if (!tab || !GuthonBridgeHost.isAllowed(tab.url)) throw new Error('请先打开谷神开发平台页面');
      const origin = new URL(tab.url).origin;
      const action = async () => {
        const stored = await chrome.storage.local.get('guthonBridgeRecentPulls');
        const records = Array.isArray(stored.guthonBridgeRecentPulls) ? stored.guthonBridgeRecentPulls : [];
        if (message.type === 'bridge-history-list') return {ok:true,records:records.filter(item=>item?.pageOrigin===origin).slice(0,20)};
        if (message.type !== 'bridge-history-save') throw new Error('不支持的历史操作');
        const entry = GuthonBridgeTaskHistory.create(message.payload?.record,message.payload?.result,origin);
        if (!entry) return {ok:true,stored:false};
        await chrome.storage.local.set({guthonBridgeRecentPulls:GuthonBridgeTaskHistory.retain(records,entry)});
        return {ok:true,stored:true};
      };
      const pending=pendingQueue.then(action,action);pendingQueue=pending.catch(()=>{});
      return pending;
    }
    if (message?.type?.startsWith("bridge-pending-")) {
      const tab = sender.tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab || !GuthonBridgeHost.isAllowed(tab.url)) throw new Error("请先打开谷神开发平台页面");
      const pageOrigin = new URL(tab.url).origin;
      const action = async () => {
        const stored = await chrome.storage.local.get("guthonBridgePendingJobs");
        const records = stored.guthonBridgePendingJobs || {};
        if (message.type === "bridge-pending-list") return {ok:true,records:Object.values(records).filter((item)=>item.pageOrigin===pageOrigin)};
        const record = {...message.payload,pageOrigin};
        const key = `${pageOrigin}:${record.workspaceKey}:${record.requestId}`;
        if (message.type === "bridge-pending-save") {
          const existing=Object.values(records).find((item)=>item.pageOrigin===pageOrigin && item.identity===record.identity);
          if(existing)return {ok:true,record:existing};
          if (Object.keys(records).length >= 32 && !records[key]) throw new Error("待恢复任务已满，请先查询任务结果");
          records[key]=record;
        } else if (message.type === "bridge-pending-remove") delete records[key];
        else throw new Error("不支持的任务存储操作");
        await chrome.storage.local.set({guthonBridgePendingJobs:records});
        return {ok:true,record};
      };
      const pending = pendingQueue.then(action,action);
      pendingQueue=pending.catch(()=>{});
      return pending;
    }
    if (message?.type === "bridge-health") { await reportComponent(); return bridgeRequest("/status"); }
    if (message?.type === "open-nexus") {
      const locator = GuthonBridgeNexusLocator.build(message.target);
      await chrome.tabs.create({ url: locator.uri });
      return { ok: true, description: locator.description };
    }
    const route = message?.type === "bridge-submit-job" ? "/submitJob"
      : message?.type === "bridge-job-status" ? "/jobStatus" : BRIDGE_ROUTES[message?.type];
    if (!route) throw new Error("不支持的消息类型");
    const tab = sender.tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab || !GuthonBridgeHost.isAllowed(tab.url)) throw new Error("请先打开谷神开发平台页面");
    // The browser owns this identity. Do not trust a page-provided origin.
    const payload = { ...(message.payload || {}), pageOrigin: new URL(tab.url).origin };
    return bridgeRequest(route, payload);
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
  return true;
});

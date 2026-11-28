importScripts("host-settings.js", "host-config.js", "nexus-locator.js", "task-history.js", "event-client.js", "component-client.js", "page-lifecycle.js", "native-metadata.js");

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
        files: ["host-settings.js", "host-config.js", "nexus-locator.js", "workspace-selection.js", "task-client.js", "refresh-target.js", "platform-layout.js", "tab-sorter.js", "content.js"]
      }).catch(() => {});
    });
  });
});

const BRIDGE_ROUTES = {
  "route-workspace": "/routeWorkspace",
  "save-pull-result": "/saveRemoteFile",
  "log-pull-failure": "/logPullFailure",
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
async function handleBridgeEvent(event, command, simulateDatabaseProcedure) {
  const databaseProcedure = event === 'database-procedure';
  if (!databaseProcedure && !['navigate', 'page-lifecycle','native-metadata'].includes(event)) return;
  const identity = await clientId();
  if (command.clientId !== identity || !Number.isInteger(command.tabId)
      || command.contextId !== `${identity}:${command.tabId}` || !publishedTabs.has(command.tabId)) return;
  let ok = false; let message = ''; let data;
  try {
    const tab = await chrome.tabs.get(command.tabId);
    if (!GuthonBridgeHost.isAllowed(tab.url) || new URL(tab.url).origin !== command.pageOrigin) throw new Error('平台页签来源已改变');
    const inspected = await chrome.tabs.sendMessage(tab.id, {type: 'run-page-command', command: 'inspect-page-context'});
    if (!inspected?.ok) throw new Error('无法读取当前平台身份，请刷新页签');
    const route = await bridgeRequest('/routeWorkspace', {...inspected.data, pageOrigin: command.pageOrigin, workspaceKey: command.workspaceKey});
    if (!route.ok || route.workspaceKey !== command.workspaceKey) throw new Error('当前平台身份不属于目标工作区');
    if (databaseProcedure) {
      const {type, action, target} = command.target;
      if (type !== 'database-procedure' || !['read','save'].includes(action)
          || route.workspace?.sourceMode !== 'database' || route.workspace.capabilities?.['database.sourceSync'] !== true
          || target.origin !== command.pageOrigin || target.systemId !== inspected.data.systemId
          || target.dataSourceId !== inspected.data.dataSourceId) throw new Error('DATABASE 过程函数发布页签不匹配');
      const binding = {requestId:command.requestId, clientId:identity, tabId:tab.id, workspaceKey:command.workspaceKey};
      const {evidence} = await bridgeRequest('/databaseProcedurePayload', binding);
      if (simulateDatabaseProcedure) data = await simulateDatabaseProcedure(action, target, evidence);
      else {
        await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',files:['database-procedure.js']});
        const results = await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',
          func:input=>runDatabaseProcedure(input),args:[{action,target,evidence:evidence ?? null,
            systemId:inspected.data.systemId,dataSourceId:inspected.data.dataSourceId}]});
        data = results?.[0]?.result;
        if (!data) throw new Error('DATABASE 原生回执不可用');
      }
      await bridgeRequest('/navigationResult', {...binding, ok:true, data});
      return;
    }
    if (event === 'native-metadata') {
      const target = command.target;
      const databasePreflight = target?.action === 'inspect-database-procedure';
      const allowed = databasePreflight
        ? route.workspace?.sourceMode === 'database' && route.workspace.capabilities?.['database.sourceSync'] === true
          && inspected.data.systemId === target.systemId && inspected.data.dataSourceId === target.dataSourceId
        : route.workspace?.capabilities?.['svn.edit'] === true;
      if (target?.type !== 'native-metadata' || !allowed) throw new Error('原生元数据命令未获工作区授权');
      await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',files:['native-metadata.js']});
      const results=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:payload => runNativeMetadata(payload),
        args:[{...command.target,expectedOrigin:command.pageOrigin,
          dataSourceIds:[inspected.data.dataSourceId,...(inspected.data.dataSourceIds || [])].filter(Boolean),
          systemIds:[inspected.data.systemId,...(inspected.data.systemIds || [])].filter(Boolean)}]});
      const result = results?.[0]?.result;
      if (!result) throw new Error('Native metadata receipt unavailable');
      if (databasePreflight) {
        // Hash in the extension worker. HTTP designers may lack Web Crypto in
        // the page itself, and the source body must stay out of Bridge receipts.
        const {sourceContent, ...receipt} = result;
        if (target.includeSourceHash && receipt.state === 'SUCCEEDED') {
          if (typeof sourceContent !== 'string') throw new Error('平台未返回正文，无法核对编辑基线');
          const bytes = new TextEncoder().encode(sourceContent.replaceAll('\r\n', '\n'));
          if (bytes.byteLength > 196608) throw new Error('平台正文超过预检上限');
          const digest = await crypto.subtle.digest('SHA-256', bytes);
          receipt.after.contentHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        }
        data = receipt;
      } else data = result;
      await bridgeRequest('/navigationResult',{requestId:command.requestId,clientId:identity,tabId:command.tabId,
        workspaceKey:command.workspaceKey,ok:true,data});
      return;
    }
    if (event === 'page-lifecycle') {
      if (command.target?.type !== 'page-lifecycle') throw new Error('PAGE 生命周期命令类型不匹配');
      if (route.workspace?.capabilities?.['source.read'] !== true) throw new Error('当前工作区未授权 PAGE 读取');
      if (!inspected.data.systemId || (inspected.data.systemIds || []).some(id => id !== inspected.data.systemId)) throw new Error('无法确定唯一的平台系统身份，请刷新平台上下文');
      if (command.target.action !== 'inspect' && !['api.edit','svn.edit'].some(capability => route.workspace?.capabilities?.[capability] === true)) throw new Error('当前工作区未授权 PAGE 平台写入');
      const results = await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:runPageLifecycle,
        args:[{...command.target, expectedOrigin:command.pageOrigin, systemIds:[inspected.data.systemId]}]});
      if (!results?.[0]?.result) throw new Error('PAGE 生命周期结果未知');
      data = results[0].result; ok = true;
      await bridgeRequest('/navigationResult', {requestId: command.requestId, clientId: identity,
        tabId: command.tabId, workspaceKey: command.workspaceKey, ok, data});
      return;
    }
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
function removePublishedTab(tabId) {
  if (!publishedTabs.delete(tabId)) return;
  void clientId().then(id => bridgeRequest('/removePageContext', {clientId: id, tabId})).catch(() => {});
  if (!publishedTabs.size) eventConnection?.abort();
}

async function validateEventTabs() {
  // SSE traffic alone does not count as MV3 activity. Verify the tabs that
  // still own this subscription on each heartbeat through the Chrome API.
  for (const tabId of publishedTabs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !GuthonBridgeHost.isAllowed(tab.url)) removePublishedTab(tabId);
  }
}

function ensureEventConnection() {
  if (eventConnection || !publishedTabs.size) return;
  clearTimeout(eventRetry);
  eventRetry = undefined;
  const controller = new AbortController();
  eventConnection = controller;
  void (async () => {
    let reconnect = true;
    try {
      const settings = await chrome.storage.local.get(['guthonBridgeToken', 'guthonBridgePort']);
      const port = Number(settings.guthonBridgePort || 17361);
      if (!settings.guthonBridgeToken || !Number.isInteger(port) || port < 1 || port > 65535) {
        reconnect = false;
        return;
      }
      const response = await fetch(`http://127.0.0.1:${port}/events?clientId=${encodeURIComponent(await clientId())}`, {
        headers: {Authorization: `Bearer ${settings.guthonBridgeToken}`}, signal: controller.signal,
      });
      await GuthonBridgeEvents.consume(response, handleBridgeEvent, validateEventTabs);
    } catch { /* The next lease heartbeat also wakes a terminated MV3 worker. */ }
    finally {
      eventConnection = undefined;
      if (reconnect && publishedTabs.size) eventRetry = setTimeout(ensureEventConnection, 3000);
    }
  })();
}
chrome.tabs.onRemoved?.addListener(removePublishedTab);
chrome.tabs.onUpdated?.addListener((tabId, changes) => {
  if (changes.url) removePublishedTab(tabId);
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
      if (result.ok) {publishedTabs.add(sender.tab.id); ensureEventConnection();}
      return {ok: result.ok, message: result.message};
    }
    if (message?.type?.startsWith("bridge-history-")) {
      const tab = sender.tab || (await chrome.tabs.query({active:true,currentWindow:true}))[0];
      if (!tab || !GuthonBridgeHost.isAllowed(tab.url)) throw new Error('请先打开谷神开发平台页面');
      const origin = new URL(tab.url).origin;
      const action = async () => {
        const stored = await chrome.storage.local.get('guthonBridgeRecentPulls');
        const records = Array.isArray(stored.guthonBridgeRecentPulls) ? stored.guthonBridgeRecentPulls : [];
        if (message.type === 'bridge-history-list') return {ok:true,records:records.filter(item=>item?.pageOrigin===origin && item.operation==='refresh-api-source').slice(0,20)};
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

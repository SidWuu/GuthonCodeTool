const BRIDGE_BASE = "http://127.0.0.1:17361";

importScripts("host-config.js");

chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({}, (tabs) => {
    tabs.filter((tab) => tab.id && GuthonBridgeHost.isAllowed(tab.url)).forEach((tab) => {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["fields-mover-core.js", "page-bridge.js"],
        world: "MAIN"
      }).catch(() => {});
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["host-config.js", "content.js"]
      }).catch(() => {});
    });
  });
});

async function postJson(path, payload) {
  const response = await fetch(`${BRIDGE_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.message || `桥接请求失败：${path}`);
  }
  return data;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "bridge-health") {
      const response = await fetch(`${BRIDGE_BASE}/health`);
      return sendResponse(await response.json());
    }

    if (message.type === "save-pull-result") {
      const payload = message.payload;
      const result = await postJson("/saveRemoteFile", payload);
      return sendResponse(result);
    }

    if (message.type === "log-pull-failure") {
      const result = await postJson("/logPullFailure", message.payload || {});
      return sendResponse(result);
    }

    if (message.type === "pull-hub-source") {
      const result = await postJson("/pullHubSource", message.payload);
      return sendResponse(result);
    }

    if (message.type === "export-table-schema") {
      const result = await postJson("/exportTableSchema", message.payload);
      return sendResponse(result);
    }

    if (message.type === "export-bill-type") {
      const result = await postJson("/exportBillType", message.payload || {});
      return sendResponse(result);
    }

    if (message.type === "export-view-sql") {
      const result = await postJson("/exportViewSql", message.payload || {});
      return sendResponse(result);
    }

    if (message.type === "export-system-scripts") {
      const result = await postJson("/exportSystemScripts", message.payload || {});
      return sendResponse(result);
    }

    if (message.type === "query-procedure-callers") {
      const result = await postJson("/queryProcedureCallers", message.payload || {});
      return sendResponse(result);
    }

    return sendResponse({ ok: false, message: "不支持的消息类型" });
  })().catch((error) => {
    sendResponse({
      ok: false,
      message: error.message
    });
  });

  return true;
});

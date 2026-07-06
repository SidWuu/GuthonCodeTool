const BRIDGE_BASE = "http://127.0.0.1:17361";

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
    throw new Error(data.message || `Bridge call failed: ${path}`);
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

    if (message.type === "pull-hub-source") {
      const result = await postJson("/pullHubSource", message.payload);
      return sendResponse(result);
    }

    return sendResponse({ ok: false, message: "Unknown message type" });
  })().catch((error) => {
    sendResponse({
      ok: false,
      message: error.message
    });
  });

  return true;
});

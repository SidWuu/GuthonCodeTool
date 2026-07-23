const OUTPUT_DIR_STORAGE_KEY = "guthonBridgeOutputDir";
const FLOATING_ROOT_ID = "guthon-bridge-floating-root";
const COPY_OVERLAY_ID = "guthon-bridge-copy-overlay";
const FIELDS_MOVER_OVERLAY_ID = "guthon-bridge-fields-mover-overlay";

let gIntervalId = null;
let gTreeScrollListenerInstalled = false;

function getRuntime() {
  try {
    const runtime = globalThis.chrome?.runtime;
    return runtime?.id ? runtime : null;
  } catch {
    return null;
  }
}

function isExtensionAlive() {
  return Boolean(getRuntime());
}

function getStorageLocal() {
  try {
    return globalThis.chrome?.storage?.local || null;
  } catch {
    return null;
  }
}

function stopExtensionLoops() {
  if (gIntervalId !== null) {
    clearInterval(gIntervalId);
    gIntervalId = null;
  }
}

function isSupportedGuthonPage() {
  return Boolean(globalThis.GuthonBridgeHost?.isAllowed(location.href));
}

async function ensurePageBridge() {
  const runtime = getRuntime();
  if (!runtime?.getURL) {
    throw new Error("扩展已失效，请刷新页面");
  }
  const ready = await new Promise((resolve) => {
    const requestId = `guthon-ready-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve({ ready: false, fieldsMover: false });
    }, 300);

    function onMessage(event) {
      if (event.source !== window) {
        return;
      }
      const data = event.data;
      if (!data || data.source !== "guthon-page-bridge" || data.requestId !== requestId) {
        return;
      }
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve({ ready: Boolean(data.ok), fieldsMover: Boolean(data.data?.fieldsMover) });
    }

    window.addEventListener("message", onMessage);
    window.postMessage({ source: "guthon-extension", requestId, command: "pingPageBridge", payload: {} }, "*");
  });
  if (ready.ready && ready.fieldsMover) {
    return;
  }
  async function injectPageScript(name) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${runtime.getURL(name)}?v=20260721b`;
      script.dataset.source = "guthon-bridge";
      script.onload = () => { script.remove(); resolve(); };
      script.onerror = () => { script.remove(); reject(new Error("页面桥接脚本加载失败")); };
      (document.head || document.documentElement).appendChild(script);
    });
  }
  await injectPageScript("fields-mover-core.js");
  await injectPageScript("page-bridge.js");
}

async function runPageCommand(command, payload = {}) {
  if (!isExtensionAlive()) {
    return { ok: false, message: "扩展已失效，请刷新页面" };
  }
  try {
    await ensurePageBridge();
  } catch (error) {
    return { ok: false, message: error?.message || String(error) };
  }
  return new Promise((resolve) => {
    const requestId = `guthon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve({
        source: "guthon-page-bridge",
        requestId,
        ok: false,
        message: "页面桥接超时，当前编辑器上下文没有及时返回"
      });
    }, 8000);

    function onMessage(event) {
      if (event.source !== window) {
        return;
      }
      const data = event.data;
      if (!data || data.source !== "guthon-page-bridge" || data.requestId !== requestId) {
        return;
      }
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(data);
    }

    window.addEventListener("message", onMessage);
    window.postMessage(
      {
        source: "guthon-extension",
        requestId,
        command,
        payload
      },
      "*"
    );
  });
}

function sendRuntimeMessage(message) {
  const runtime = getRuntime();
  if (!runtime?.sendMessage) {
    return Promise.reject(new Error("扩展已更新，请刷新页面"));
  }
  return new Promise((resolve, reject) => {
    runtime.sendMessage(message, (response) => {
      const error = runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function setButtonTitle(root, message) {
  root.querySelector("button").title = message;
}

function setButtonText(root, text) {
  root.querySelector("button").textContent = text;
}

function setButtonTextNode(button, text) {
  button.textContent = text;
}

function setMessage(root, message, tone = "idle") {
  const messageEl = root.querySelector(".guthon-bridge-message");
  if (!messageEl) {
    return;
  }
  messageEl.textContent = message;
  messageEl.dataset.tone = tone;
  if (message) {
    clearTimeout(root.__guthonMessageTimer);
    root.__guthonMessageTimer = setTimeout(() => {
      messageEl.textContent = "";
    }, 10000);
  }
}

function toErrorMessage(stage, error) {
  return `${stage}: ${error?.message || String(error)}`;
}

function isVisible(element) {
  if (!element) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
}

function isProcedureRoute() {
  return location.hash.includes("/gdpaas/dev/procedure_develop");
}

function isModuleRoute() {
  return location.hash.includes("/gdpaas/dev/modules");
}

function isDataTableRoute() {
  const activeTab = Array.from(document.querySelectorAll(".el-tabs__item, .tabs-item, [role='tab']"))
    .find((item) => isVisible(item) && isActiveTab(item) && /数据表管理/.test(item.innerText || item.textContent || ""));
  return Boolean(activeTab) || (/table/i.test(location.hash) && /数据表管理/.test(document.body?.innerText || ""));
}

function isActiveTab(item) {
  const className = String(item.className || "");
  return item.getAttribute("aria-selected") === "true" || /\b(active|is-active|selected|is-selected)\b/i.test(className);
}

function isBillTypeRoute() {
  return Array.from(document.querySelectorAll(".el-tabs__item, .tabs-item, [role='tab']"))
    .some((item) => isVisible(item) && isActiveTab(item) && /^单据类型/.test(String(item.innerText || item.textContent || "").trim()));
}

function findNativeToolbar(scope = document) {
  return Array.from(scope.querySelectorAll(".tool-menu.tool-box, .gd-function-head, .function.head"))
    .find(isVisible);
}

function makeNativeButton(text, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `el-button el-button--default el-button--mini is-plain ${className}`;
  button.innerHTML = `<span>${text}</span>`;
  return button;
}

function ensureInlineStyles() {
  const existing = document.getElementById("guthon-bridge-inline-style");
  if (existing?.dataset.version === "20260717h") {
    return;
  }
  existing?.remove();
  const style = document.createElement("style");
  style.id = "guthon-bridge-inline-style";
  style.dataset.version = "20260717h";
  style.textContent = `
    .guthon-bridge-inline {
      position: fixed;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 6px;
      width: max-content;
      min-width: 108px;
      padding: 0;
      pointer-events: none;
      user-select: none;
    }
    .guthon-bridge-inline button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 108px;
      min-width: 108px;
      height: 32px;
      margin: 0;
      padding: 7px 10px;
      border: 1px solid #409eff;
      border-radius: 3px;
      background: #409eff;
      box-shadow: none;
      color: #fff;
      font-size: 12px;
      font-weight: 500;
      line-height: 1;
      text-align: center;
      text-decoration: none;
      cursor: pointer;
      pointer-events: auto;
    }
    .guthon-bridge-inline button + button {
      margin-left: 0;
    }
    .guthon-bridge-fields-mover-group {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 6px;
    }
    .guthon-bridge-inline:not([data-mode="module"]) .guthon-bridge-module-only {
      visibility: hidden;
      pointer-events: none;
    }
    .guthon-bridge-fields-mover-group > span {
      width: 108px;
      color: #c0c4cc;
      font-size: 12px;
      text-align: center;
    }
    .guthon-bridge-inline button span {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
    }
    .guthon-bridge-inline button:hover,
    .guthon-bridge-inline button:focus {
      color: #fff;
      background: #337ecc;
      border-color: #337ecc;
    }
    .guthon-bridge-message {
      position: absolute;
      left: 0;
      bottom: calc(100% + 8px);
      box-sizing: border-box;
      width: 140px;
      max-width: calc(100vw - 40px);
      color: #606266;
      font-size: 12px;
      background: rgba(255, 255, 255, 0.92);
      border: 1px solid #ebeef5;
      border-radius: 3px;
      padding: 2px 6px;
      overflow-wrap: anywhere;
      word-break: break-all;
      white-space: normal;
      pointer-events: auto;
      user-select: text;
    }
    .guthon-bridge-message:empty {
      display: none;
    }
    .guthon-bridge-message[data-tone="error"] {
      color: #f56c6c;
    }
    .guthon-bridge-message[data-tone="success"] {
      color: #67c23a;
    }
    #${FIELDS_MOVER_OVERLAY_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: grid;
      place-items: center;
      padding: 24px;
      box-sizing: border-box;
      background: rgba(15, 23, 42, 0.42);
    }
    #${FIELDS_MOVER_OVERLAY_ID} .guthon-bridge-fields-mover-panel {
      width: min(560px, 100%);
      max-height: calc(100vh - 48px);
      display: flex;
      flex-direction: column;
      background: #fff;
      border: 1px solid #dcdfe6;
      box-shadow: 0 12px 30px rgba(15, 23, 42, 0.2);
    }
    #${FIELDS_MOVER_OVERLAY_ID} .guthon-bridge-fields-mover-head,
    #${FIELDS_MOVER_OVERLAY_ID} .guthon-bridge-fields-mover-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 14px;
    }
    #${FIELDS_MOVER_OVERLAY_ID} .guthon-bridge-fields-mover-head { border-bottom: 1px solid #ebeef5; }
    #${FIELDS_MOVER_OVERLAY_ID} .guthon-bridge-fields-mover-list { overflow: auto; padding: 8px 14px; }
    #${FIELDS_MOVER_OVERLAY_ID} .guthon-bridge-fields-mover-item {
      display: flex;
      gap: 8px;
      padding: 7px 0;
      border-bottom: 1px solid #f2f6fc;
      color: #303133;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #${FIELDS_MOVER_OVERLAY_ID} .guthon-bridge-fields-mover-meta { color: #909399; font-size: 12px; }
    #${FIELDS_MOVER_OVERLAY_ID} .guthon-bridge-fields-mover-actions { justify-content: flex-end; border-top: 1px solid #ebeef5; }
    #${COPY_OVERLAY_ID} {
      position: absolute;
      inset: 0;
      z-index: 2147483647;
      min-height: 100vh;
      padding: 42px 56px;
      box-sizing: border-box;
      background: rgba(15, 23, 42, 0.42);
    }
    #${COPY_OVERLAY_ID} .guthon-bridge-copy-panel {
      max-width: 1450px;
      max-height: calc(100vh - 84px);
      margin: 0 auto;
      display: grid;
      grid-template-rows: auto 1fr;
      background: #fff;
      border: 1px solid #dcdfe6;
      box-shadow: 0 12px 30px rgba(15, 23, 42, 0.2);
    }
    #${COPY_OVERLAY_ID} .guthon-bridge-copy-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      border-bottom: 1px solid #ebeef5;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: move;
    }
    #${COPY_OVERLAY_ID} .guthon-bridge-copy-head button {
      cursor: pointer;
    }
    #${COPY_OVERLAY_ID} .guthon-bridge-copy-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #${COPY_OVERLAY_ID} .guthon-bridge-copy-panel[data-minimized="true"] {
      grid-template-rows: auto;
    }
    #${COPY_OVERLAY_ID} .guthon-bridge-copy-panel[data-minimized="true"] .guthon-bridge-copy-body {
      display: none;
    }
    #${COPY_OVERLAY_ID} .guthon-bridge-copy-body {
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
    }
    #${COPY_OVERLAY_ID} .guthon-bridge-copy-groups {
      overflow: auto;
      padding: 8px;
    }
    #${COPY_OVERLAY_ID} details {
      border: 1px solid #dcdfe6;
      margin-bottom: 6px;
      background: #fff;
    }
    #${COPY_OVERLAY_ID} summary {
      cursor: pointer;
      padding: 6px 8px;
      background: #f5f7fa;
      font-weight: 600;
    }
    #${COPY_OVERLAY_ID} .guthon-bridge-field-table {
      width: 100%;
      table-layout: fixed;
      border-collapse: collapse;
      color: #1f2937;
      font: 11px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #${COPY_OVERLAY_ID} .guthon-bridge-field-table th,
    #${COPY_OVERLAY_ID} .guthon-bridge-field-table td {
      border-top: 1px solid #ebeef5;
      border-right: 1px solid #ebeef5;
      padding: 5px 4px;
      vertical-align: middle;
      overflow: hidden;
      white-space: nowrap;
    }
    #${COPY_OVERLAY_ID} .guthon-bridge-field-table th:last-child,
    #${COPY_OVERLAY_ID} .guthon-bridge-field-table td:last-child {
      border-right: 0;
    }
    #${COPY_OVERLAY_ID} .guthon-bridge-field-table th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: #f8fafc;
      color: #606266;
      font-weight: 600;
      text-align: left;
      white-space: nowrap;
    }
    #${COPY_OVERLAY_ID} .guthon-bridge-resize-handle {
      position: absolute;
      top: 0;
      right: 0;
      width: 6px;
      height: 100%;
      cursor: col-resize;
      user-select: none;
    }
    #${COPY_OVERLAY_ID} .guthon-bridge-resize-handle:hover {
      background: rgba(64, 158, 255, 0.18);
    }
    #${COPY_OVERLAY_ID} .guthon-bridge-field-table tr[data-hidden="true"] {
      color: #909399;
      background: #fafafa;
    }
    #${COPY_OVERLAY_ID} .guthon-bridge-cell-value {
      overflow: hidden;
      text-overflow: ellipsis;
      user-select: text;
      white-space: nowrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    #${COPY_OVERLAY_ID} .guthon-bridge-cell-value.guthon-bridge-cell-selected {
      background: rgba(64, 158, 255, 0.32);
      outline: 1px solid rgba(64, 158, 255, 0.6);
    }
    #${COPY_OVERLAY_ID} .guthon-bridge-copy-text {
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      min-height: 360px;
      resize: none;
      border: 0;
      border-left: 1px solid #dcdfe6;
      padding: 12px;
      font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: #1f2937;
      outline: none;
    }
  `;
  document.documentElement.appendChild(style);
}

function positionBridgeRoot(root, toolbar, ratio = 0.72, row = 0) {
  if (!root) {
    return false;
  }
  void toolbar;
  void ratio;
  return positionFloatingRoot(root, row);
}

function positionFloatingRoot(root, row = 0) {
  if (!root) {
    return false;
  }
  void row;
  root.style.left = "20px";
  root.style.right = "auto";
  root.style.top = "auto";
  root.style.bottom = "150px";
  root.style.zIndex = "2147483646";
  return true;
}

async function pullCurrentProcedure(root, button = root.querySelector("button"), force = false) {
  try {
    button.disabled = true;
    setButtonTextNode(button, "源码拉取");
    button.title = "正在从源码表拉取...";
    setMessage(root, "正在从源码表拉取...", "busy");

    let bridgeHealth;
    try {
      bridgeHealth = await sendRuntimeMessage({ type: "bridge-health" });
    } catch (error) {
      throw new Error(toErrorMessage("连接本地服务失败", error));
    }
    if (!bridgeHealth?.ok) {
      throw new Error(`本地桥接服务不可用：${bridgeHealth?.message || "未知错误"}`);
    }

    const inspected = await runPageCommand(isModuleRoute() ? "inspect-hub-source" : "inspectCurrentProcedure");
    if (!inspected?.ok) {
      throw new Error(`${isModuleRoute() ? "识别当前页面失败" : "识别当前函数失败"}: ${inspected?.message || (isModuleRoute() ? "未识别到当前页面" : "未识别到当前过程函数")}`);
    }

    let target = inspected.data;
    if (!target.procedureId) {
      const resolved = await runPageCommand("pullProcedure", {
        procedureKeyword: target.procedureKeyword || target.procedureName || "",
        funId: target.funId || ""
      });
      if (resolved?.ok && resolved.data?.procedureId) {
        target = {
          ...target,
          procedureId: resolved.data.procedureId,
          procedureName: resolved.data.procedureName || target.procedureName,
          procedureKeyword: resolved.data.procedureName || target.procedureKeyword
        };
      }
    }
    let pullResult;
    try {
      pullResult = await sendRuntimeMessage({
        type: "pull-hub-source",
        payload: {
          sourceType: target.mode === "page-source" ? "page" : "procedure",
          sourceId: target.mode === "page-source" ? target.pageId || "" : target.procedureId || "",
          alias: target.procedureKeyword || target.procedureName || "",
          funId: target.mode === "page-source" ? "" : target.funId || "",
          force
        }
      });
    } catch (error) {
      throw new Error(toErrorMessage("源码表拉取失败", error));
    }
    if (!pullResult?.ok) {
      throw new Error(`源码表拉取失败: ${pullResult?.message || "拉取失败"}`);
    }

    button.textContent = "成功";
    const successMessage = pullResult.message || "源码拉取成功";
    button.title = `${successMessage}: ${pullResult.workCopyPath}`;
    setMessage(root, `${successMessage}: ${pullResult.workCopyPath}`, "success");
    setTimeout(() => setButtonTextNode(button, "源码拉取"), 1600);
  } catch (error) {
    console.error("谷神桥接：源码拉取失败", error);
    button.textContent = "失败";
    const message = error?.message || String(error);
    button.title = message;
    setMessage(root, message, "error");
    setTimeout(() => setButtonTextNode(button, "源码拉取"), 2200);
  } finally {
    button.disabled = false;
  }
}

async function exportCurrentTableSchema(root, button = root.querySelector("button")) {
  try {
    button.disabled = true;
    setButtonText(root, "源码拉取");
    setButtonTitle(root, "正在拉取表结构...");
    setMessage(root, "正在拉取表结构...", "busy");

    const bridgeHealth = await sendRuntimeMessage({ type: "bridge-health" });
    if (!bridgeHealth?.ok) {
      throw new Error(`本地桥接服务不可用：${bridgeHealth?.message || "未知错误"}`);
    }

    const inspected = await runPageCommand("inspectTableSchemaTarget");
    if (!inspected?.ok) {
      throw new Error(`识别数据表失败: ${inspected?.message || "未识别到数据源"}`);
    }

    const result = await sendRuntimeMessage({
      type: "export-table-schema",
      payload: inspected.data
    });
    if (!result?.ok) {
      throw new Error(result?.message || "表结构拉取失败");
    }

    button.textContent = "成功";
    const selected = Array.isArray(inspected.data.tableIds) && inspected.data.tableIds.length > 0;
    const detail = selected ? `已拉取选中表: ${inspected.data.tableIds.join(", ")}` : `已拉取数据源 ${inspected.data.dataSourceId} 全部表`;
    setButtonTitle(root, `${detail}: ${result.outputDir}`);
    setMessage(root, `${detail}: ${result.exported_table_count}`, "success");
    setTimeout(() => setButtonText(root, "源码拉取"), 1600);
  } catch (error) {
    console.error("谷神桥接：表结构拉取失败", error);
    button.textContent = "失败";
    const message = error?.message || String(error);
    setButtonTitle(root, message);
    setMessage(root, message, "error");
    setTimeout(() => setButtonText(root, "源码拉取"), 2200);
  } finally {
    button.disabled = false;
  }
}

async function exportCurrentBillType(root, button = root.querySelector("button")) {
  try {
    button.disabled = true;
    setButtonText(root, "源码拉取");
    setButtonTitle(root, "正在拉取单据类型...");
    setMessage(root, "正在拉取单据类型...", "busy");

    const bridgeHealth = await sendRuntimeMessage({ type: "bridge-health" });
    if (!bridgeHealth?.ok) {
      throw new Error(`本地桥接服务不可用：${bridgeHealth?.message || "未知错误"}`);
    }

    const inspected = await runPageCommand("inspectBillTypeTarget");
    if (!inspected?.ok) {
      throw new Error(`识别单据类型失败: ${inspected?.message || "未识别到数据源"}`);
    }

    const result = await sendRuntimeMessage({
      type: "export-bill-type",
      payload: {
        dataSourceIds: [inspected.data.dataSourceId],
        billTypeCodes: inspected.data.billTypeCodes || []
      }
    });
    if (!result?.ok) {
      throw new Error(result?.message || "单据类型拉取失败");
    }

    button.textContent = "成功";
    const selected = Array.isArray(inspected.data.billTypeCodes) && inspected.data.billTypeCodes.length > 0;
    const source = [inspected.data.dataSourceId, inspected.data.dataSourceName].filter(Boolean).join(" ");
    const detail = selected ? `已拉取选中单据类型: ${inspected.data.billTypeCodes.join(", ")}` : `已拉取数据源 ${source} 全部单据类型`;
    setButtonTitle(root, `${detail}: ${result.outputDir}`);
    setMessage(root, `${detail}: ${result.exported_bill_type_count}`, "success");
    setTimeout(() => setButtonText(root, "源码拉取"), 1600);
  } catch (error) {
    console.error("谷神桥接：单据类型拉取失败", error);
    button.textContent = "失败";
    const message = error?.message || String(error);
    setButtonTitle(root, message);
    setMessage(root, message, "error");
    setTimeout(() => setButtonText(root, "源码拉取"), 2200);
  } finally {
    button.disabled = false;
  }
}

function removeNode(id) {
  document.getElementById(id)?.remove();
}

function installSourcePullButton() {
  if (!isSupportedGuthonPage() || (!isProcedureRoute() && !isModuleRoute() && !isDataTableRoute() && !isBillTypeRoute())) {
    return;
  }

  ensureInlineStyles();
  let root = document.getElementById(FLOATING_ROOT_ID);
  if (root && root.dataset.sharedButtons !== "true") {
    root.remove();
    root = null;
  }
  document.getElementById("guthon-bridge-schema-root")?.remove();
  document.getElementById("guthon-bridge-billtype-root")?.remove();
  const mode = isModuleRoute() ? "module" : isProcedureRoute() ? "procedure" : isDataTableRoute() ? "table" : "billtype";
  if (!root) {
    root = document.createElement("div");
    root.id = FLOATING_ROOT_ID;
    root.className = "guthon-bridge-inline";
    root.dataset.mode = mode;
    root.dataset.sharedButtons = "true";
    const sourceButton = makeNativeButton("源码拉取", "guthon-bridge-inline-button guthon-bridge-source-button");
    root.appendChild(sourceButton);
    const copyButton = makeNativeButton("复制模式", "guthon-bridge-copy-button guthon-bridge-module-only");
    copyButton.addEventListener("click", async () => {
      try {
        await showCopyOverlay();
      } catch (error) {
        setButtonTitle(root, error?.message || String(error));
        setMessage(root, error?.message || String(error), "error");
      }
    });
    root.appendChild(copyButton);
    const fieldsMover = document.createElement("div");
    fieldsMover.className = "guthon-bridge-fields-mover-group guthon-bridge-module-only";
    fieldsMover.innerHTML = "<span>字段平移</span>";
    const copyFieldsButton = makeNativeButton("复制字段", "guthon-bridge-copy-fields-button");
    const pasteFieldsButton = makeNativeButton("粘贴字段", "guthon-bridge-paste-fields-button");
    copyFieldsButton.addEventListener("click", async () => {
      try {
        await showFieldsMoverOverlay(root);
      } catch (error) {
        setMessage(root, error?.message || String(error), "error");
      }
    });
    pasteFieldsButton.addEventListener("click", async () => {
      try {
        await pasteCopiedFields(root);
      } catch (error) {
        setMessage(root, error?.message || String(error), "error");
      }
    });
    fieldsMover.append(copyFieldsButton, pasteFieldsButton);
    root.appendChild(fieldsMover);
    const message = document.createElement("div");
    message.className = "guthon-bridge-message";
    message.dataset.tone = "idle";
    root.appendChild(message);

    sourceButton.addEventListener("click", () => {
      if (isDataTableRoute()) exportCurrentTableSchema(root, sourceButton);
      else if (isBillTypeRoute()) exportCurrentBillType(root, sourceButton);
      else pullCurrentProcedure(root, sourceButton);
    });
    document.body.appendChild(root);
  }
  root.dataset.mode = mode;
  positionBridgeRoot(root);
}

function scrollCurrentTreeNode() {
  const selectedNode = document.querySelector(".el-tree-node.is-current, .el-tree-node .is-current");
  const target = selectedNode?.closest?.(".el-tree-node") || selectedNode;
  target?.scrollIntoView?.({ block: "center", inline: "nearest" });
}

function scheduleCurrentTreeScroll() {
  [0, 120, 360].forEach((delay) => {
    setTimeout(scrollCurrentTreeNode, delay);
  });
}

function installTreeAutoScroll() {
  if (gTreeScrollListenerInstalled) {
    return;
  }
  document.addEventListener("click", (event) => {
    if (!isSupportedGuthonPage() || (!isProcedureRoute() && !isModuleRoute())) {
      return;
    }
    const button = event.target?.closest?.(
      ".location-bnt, .gd-function-head button, .function.head button, .procedure-script-editor button, .tool-menu.tool-box button, .work-context button"
    );
    if (button) {
      scheduleCurrentTreeScroll();
    }
  }, true);
  gTreeScrollListenerInstalled = true;
}

async function showFieldsMoverOverlay(root) {
  if (!isModuleRoute()) {
    throw new Error("字段平移只支持模块开发页面");
  }
  const source = await runPageCommand("readFieldsMoverSource");
  if (!source?.ok) {
    throw new Error(source?.message || "读取当前组件字段失败");
  }
  const fields = source.data || [];
  removeNode(FIELDS_MOVER_OVERLAY_ID);
  const overlay = document.createElement("div");
  overlay.id = FIELDS_MOVER_OVERLAY_ID;
  overlay.innerHTML = `
    <div class="guthon-bridge-fields-mover-panel">
      <div class="guthon-bridge-fields-mover-head"><strong>复制字段</strong><button type="button" class="guthon-bridge-fields-mover-close">关闭</button></div>
      <div class="guthon-bridge-fields-mover-list">${fields.map((field) => `<label class="guthon-bridge-fields-mover-item"><input type="checkbox" data-index="${field.index}" /><span>${escapeHtml(field.label)} <span class="guthon-bridge-fields-mover-meta">${escapeHtml(field.fieldId || "无字段编码")}</span></span></label>`).join("") || "当前组件没有字段"}</div>
      <div class="guthon-bridge-fields-mover-actions"><button type="button" class="guthon-bridge-fields-mover-select-all">全选字段</button><button type="button" class="guthon-bridge-fields-mover-cancel">取消</button><button type="button" class="guthon-bridge-fields-mover-copy">复制</button></div>
    </div>`;
  const close = () => removeNode(FIELDS_MOVER_OVERLAY_ID);
  overlay.querySelector(".guthon-bridge-fields-mover-close").addEventListener("click", close);
  overlay.querySelector(".guthon-bridge-fields-mover-cancel").addEventListener("click", close);
  overlay.querySelector(".guthon-bridge-fields-mover-select-all").addEventListener("click", () => {
    overlay.querySelectorAll("input[data-index]").forEach((item) => { item.checked = true; });
  });
  overlay.querySelector(".guthon-bridge-fields-mover-copy").addEventListener("click", async () => {
    const indexes = Array.from(overlay.querySelectorAll("input[data-index]:checked")).map((item) => Number(item.dataset.index));
    const copied = await runPageCommand("copyFieldsMoverSource", { indexes });
    if (!copied?.ok) {
      setMessage(root, copied?.message || "复制字段失败", "error");
      return;
    }
    setMessage(root, `已复制 ${copied.data.copied} 个字段`, "success");
    close();
  });
  document.body.appendChild(overlay);
}

async function pasteCopiedFields(root) {
  const pasted = await runPageCommand("pasteFieldsMoverSource");
  if (!pasted?.ok) {
    throw new Error(pasted?.message || "粘贴字段失败");
  }
  setMessage(root, `已粘贴 ${pasted.data.pasted} 个，跳过重复 ${pasted.data.duplicate} 个，无效 ${pasted.data.invalid} 个`, "success");
  return pasted.data;
}
function selectNodeText(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function clearCellSelection(overlay) {
  overlay.querySelectorAll(".guthon-bridge-cell-selected").forEach((node) => {
    node.classList.remove("guthon-bridge-cell-selected");
  });
}

function paintCellSelection(overlay, table, columnIndex, startRowIndex, endRowIndex) {
  clearCellSelection(overlay);
  const rows = Array.from(table.tBodies[0]?.rows || []);
  const from = Math.min(startRowIndex, endRowIndex);
  const to = Math.max(startRowIndex, endRowIndex);
  rows.slice(from, to + 1).forEach((row) => {
    row.cells[columnIndex]?.querySelector(".guthon-bridge-cell-value")?.classList.add("guthon-bridge-cell-selected");
  });
}

function copySelectedCells(overlay, event) {
  const text = Array.from(overlay.querySelectorAll(".guthon-bridge-cell-selected"))
    .map((node) => String(node.innerText || node.textContent || ""))
    .join("\n");
  if (!text) {
    return;
  }
  event.clipboardData.setData("text/plain", text);
  event.preventDefault();
}

async function copyLocalContext(overlay) {
  await navigator.clipboard.writeText(overlay.querySelector(".guthon-bridge-copy-text").value);
}

function installCellSelection(overlay) {
  let drag = null;

  function getCell(target) {
    const valueNode = target.closest?.(".guthon-bridge-cell-value");
    const cell = valueNode?.closest("td");
    const table = cell?.closest(".guthon-bridge-field-table");
    if (!cell || !table) {
      return null;
    }
    return { cell, table, rows: Array.from(table.tBodies[0]?.rows || []) };
  }

  overlay.addEventListener("mousedown", (event) => {
    const hit = getCell(event.target);
    if (!hit || event.button !== 0) {
      return;
    }
    const rowIndex = hit.rows.indexOf(hit.cell.parentElement);
    if (rowIndex < 0) {
      return;
    }
    drag = { table: hit.table, columnIndex: hit.cell.cellIndex, startRowIndex: rowIndex };
    paintCellSelection(overlay, drag.table, drag.columnIndex, drag.startRowIndex, rowIndex);
    window.getSelection()?.removeAllRanges();
    overlay.focus({ preventScroll: true });
    document.addEventListener("mouseup", stopDrag, { once: true });
    event.preventDefault();
  });

  overlay.addEventListener("mouseover", (event) => {
    if (!drag) {
      return;
    }
    const hit = getCell(event.target);
    if (!hit || hit.table !== drag.table) {
      return;
    }
    const rowIndex = hit.rows.indexOf(hit.cell.parentElement);
    if (rowIndex >= 0) {
      paintCellSelection(overlay, drag.table, drag.columnIndex, drag.startRowIndex, rowIndex);
    }
  });

  function stopDrag() {
    drag = null;
  }

  overlay.addEventListener("copy", (event) => copySelectedCells(overlay, event));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderTableCell(value) {
  const text = escapeHtml(value);
  return `<td><div class="guthon-bridge-cell-value" title="${text}">${text}</div></td>`;
}

function renderTableHeader(label, index) {
  return `<th>${escapeHtml(label)}<span class="guthon-bridge-resize-handle" data-col-index="${index}"></span></th>`;
}

function renderFieldRow(field) {
  return `
    <tr data-hidden="${String(Boolean(field.hidden))}">
      ${renderTableCell(field.index || "")}
      ${renderTableCell(field.field)}
      ${renderTableCell(field.label)}
      ${renderTableCell(field.type)}
      ${renderTableCell(field.format)}
      ${renderTableCell(field.template)}
      ${renderTableCell(field.width)}
      ${renderTableCell(field.align)}
      ${renderTableCell(field.selectType)}
      ${renderTableCell(field.valueField)}
      ${renderTableCell(field.otherFill)}
      ${renderTableCell(field.queryParams)}
      ${renderTableCell(field.required ? "是" : "否")}
      ${renderTableCell(field.sum ? "是" : "否")}
      ${renderTableCell(field.hidden ? "否" : "是")}
    </tr>
  `;
}

function renderCopyData(overlay, data, text) {
  const groupsEl = overlay.querySelector(".guthon-bridge-copy-groups");
  const textarea = overlay.querySelector(".guthon-bridge-copy-text");
  textarea.value = text;
  textarea.selectionStart = 0;
  textarea.selectionEnd = 0;
  textarea.scrollTop = 0;
  textarea.scrollLeft = 0;
  groupsEl.innerHTML = "";
  if (!data?.groups?.length) {
    groupsEl.textContent = "未识别到字段信息";
    return;
  }
  data.groups.forEach((group, groupIndex) => {
    const details = document.createElement("details");
    details.open = groupIndex === 0;
    details.innerHTML = `
      <summary>${escapeHtml(group.title)}</summary>
      <table class="guthon-bridge-field-table">
        <colgroup>
          <col style="width: 3%" />
          <col style="width: 11%" />
          <col style="width: 11%" />
          <col style="width: 6%" />
          <col style="width: 7%" />
          <col style="width: 11%" />
          <col style="width: 4%" />
          <col style="width: 6%" />
          <col style="width: 9%" />
          <col style="width: 8%" />
          <col style="width: 7%" />
          <col style="width: 8%" />
          <col style="width: 3%" />
          <col style="width: 3%" />
          <col style="width: 3%" />
        </colgroup>
        <thead>
          <tr>
            ${["", "字段", "显示名称", "显示类型", "显示格式", "字段模板", "宽度", "数据对齐", "下拉类型", "数值字段", "其他填值", "查询参数", "必填", "合计", "显示"].map(renderTableHeader).join("")}
          </tr>
        </thead>
        <tbody>
          ${group.fields.map(renderFieldRow).join("")}
        </tbody>
      </table>
    `;
    groupsEl.appendChild(details);
  });
}

function installCopyOverlayInteractions(overlay) {
  const panel = overlay.querySelector(".guthon-bridge-copy-panel");
  const head = overlay.querySelector(".guthon-bridge-copy-head");

  head.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) {
      return;
    }
    const rect = panel.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    panel.style.position = "fixed";
    panel.style.width = `${rect.width}px`;
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.margin = "0";
    const move = (moveEvent) => {
      const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, moveEvent.clientX - offsetX));
      const top = Math.max(8, Math.min(window.innerHeight - 40, moveEvent.clientY - offsetY));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    const stop = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", stop);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stop);
    event.preventDefault();
  });

  overlay.addEventListener("mousedown", (event) => {
    const handle = event.target.closest(".guthon-bridge-resize-handle");
    if (!handle || event.button !== 0) {
      return;
    }
    const table = handle.closest("table");
    const col = table?.querySelectorAll("col")[Number(handle.dataset.colIndex)];
    if (!table || !col) {
      return;
    }
    const tableWidth = table.getBoundingClientRect().width || 1;
    const startX = event.clientX;
    const startWidth = handle.closest("th").getBoundingClientRect().width;
    const move = (moveEvent) => {
      const width = Math.max(32, startWidth + moveEvent.clientX - startX);
      col.style.width = `${(width / tableWidth) * 100}%`;
    };
    const stop = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", stop);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stop);
    event.preventDefault();
  });
}

async function showCopyOverlay() {
  if (!isSupportedGuthonPage() || !isModuleRoute()) {
    throw new Error("复制模式只支持模块开发页面");
  }
  removeNode(COPY_OVERLAY_ID);
  ensureInlineStyles();
  const overlay = document.createElement("div");
  overlay.id = COPY_OVERLAY_ID;
  overlay.tabIndex = -1;
  overlay.innerHTML = `
    <div class="guthon-bridge-copy-panel">
      <div class="guthon-bridge-copy-head">
        <strong>复制模式</strong>
        <div class="guthon-bridge-copy-actions">
          <button type="button" class="el-button el-button--default el-button--mini is-plain guthon-bridge-copy-context">复制局部上下文</button>
          <button type="button" class="el-button el-button--default el-button--mini is-plain guthon-bridge-copy-minimize">缩小</button>
          <button type="button" class="el-button el-button--default el-button--mini is-plain guthon-bridge-copy-close">关闭</button>
        </div>
      </div>
      <div class="guthon-bridge-copy-body">
        <div class="guthon-bridge-copy-groups">正在识别字段信息...</div>
        <textarea class="guthon-bridge-copy-text" readonly></textarea>
      </div>
    </div>
  `;
  const panel = overlay.querySelector(".guthon-bridge-copy-panel");
  const minimizeButton = overlay.querySelector(".guthon-bridge-copy-minimize");
  overlay.querySelector(".guthon-bridge-copy-context").addEventListener("click", () => copyLocalContext(overlay));
  minimizeButton.addEventListener("click", () => {
    const minimized = panel.dataset.minimized !== "true";
    panel.dataset.minimized = String(minimized);
    minimizeButton.textContent = minimized ? "展开" : "缩小";
  });
  overlay.querySelector(".guthon-bridge-copy-close").addEventListener("click", () => removeNode(COPY_OVERLAY_ID));
  installCopyOverlayInteractions(overlay);
  installCellSelection(overlay);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      removeNode(COPY_OVERLAY_ID);
    }
  });
  overlay.addEventListener("dblclick", (event) => {
    const valueNode = event.target.closest(".guthon-bridge-cell-value");
    if (valueNode) {
      selectNodeText(valueNode);
    }
  });
  overlay.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      const textarea = overlay.querySelector(".guthon-bridge-copy-text");
      textarea.focus();
      textarea.select();
      event.preventDefault();
    }
  });
  document.body.appendChild(overlay);
  const copied = await runPageCommand("collectModuleCopyText");
  if (!copied?.ok) {
    removeNode(COPY_OVERLAY_ID);
    throw new Error(copied?.message || "读取页面字段失败");
  }
  renderCopyData(overlay, copied.data.data, copied.data.text);
}

async function refreshToolbarButtons() {
  try {
    if (!isExtensionAlive()) {
      removeNode(FLOATING_ROOT_ID);
      stopExtensionLoops();
      return;
    }

    if (!isSupportedGuthonPage()) {
      removeNode(FLOATING_ROOT_ID);
      return;
    }

    installTreeAutoScroll();

    if (isModuleRoute() || isProcedureRoute()) {
      await ensurePageBridge();
    }
    if (isModuleRoute() || isProcedureRoute() || isDataTableRoute() || isBillTypeRoute()) {
      installSourcePullButton();
    } else {
      removeNode(FLOATING_ROOT_ID);
    }
  } catch (error) {
    console.warn("谷神桥接：刷新工具栏失败", error);
    if (!isExtensionAlive()) {
      removeNode(FLOATING_ROOT_ID);
      stopExtensionLoops();
    }
  }
}

getRuntime()?.onMessage?.addListener((message, sender, sendResponse) => {
  const root = document.getElementById(FLOATING_ROOT_ID) || document.body;
  const action = message?.type === "run-page-command"
    ? () => runPageCommand(message.command, message.payload)
    : message?.type === "show-copy-overlay"
    ? async () => ({ ok: true, data: await showCopyOverlay() })
    : message?.type === "show-fields-mover"
      ? async () => ({ ok: true, data: await showFieldsMoverOverlay(root) })
      : message?.type === "paste-fields-mover"
        ? async () => ({ ok: true, data: await pasteCopiedFields(root) })
        : null;
  if (!action) {
    return false;
  }
  action()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, message: error?.message || String(error) }));
  return true;
});

refreshToolbarButtons().catch(() => {});
gIntervalId = setInterval(refreshToolbarButtons, 1800);

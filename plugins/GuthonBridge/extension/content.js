(function () {
if (!globalThis.GuthonBridgeHost?.isAllowed(location.href)) return;
globalThis.__guthonContentCleanup?.();
for (const id of ['guthon-bridge-floating-root', 'guthon-bridge-copy-overlay', 'guthon-bridge-fields-mover-overlay', 'guthon-bridge-callers-overlay']) document.getElementById(id)?.remove();
const stopPlatformLayout = globalThis.GuthonBridgePlatformLayout?.start();
const stopTabSorter = globalThis.GuthonBridgeTabSorter?.start();
const documentListeners = [];
function listenDocument(type, listener, options) {
  document.addEventListener(type, listener, options);
  documentListeners.push([type, listener, options]);
}
function blockSyntheticClick(event) {
  if (!event.isTrusted && event.target?.closest?.('[id^="guthon-bridge-"]')) event.stopImmediatePropagation();
}
listenDocument("click", blockSyntheticClick, true);
const OUTPUT_DIR_STORAGE_KEY = "guthonBridgeOutputDir";
const FLOATING_ROOT_ID = "guthon-bridge-floating-root";
const COPY_OVERLAY_ID = "guthon-bridge-copy-overlay";
const FIELDS_MOVER_OVERLAY_ID = "guthon-bridge-fields-mover-overlay";
const CALLERS_OVERLAY_ID = "guthon-bridge-callers-overlay";
const PAGE_CONTEXT_HEARTBEAT_MS = 60000;

let gIntervalId = null;
let gRefreshInFlight = null;
let gRefreshRequested = false;
let gToolbarObserver = null;
let gToolbarRefreshTimer = null;
let gObservedToolbarContext = "";
let gTreeScrollListenerInstalled = false;
let gSystemScriptSelectionInstalled = false;

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
  stopPlatformLayout?.();
  stopTabSorter?.();
  if (gIntervalId !== null) {
    clearInterval(gIntervalId);
    gIntervalId = null;
  }
  if (gToolbarRefreshTimer !== null) {
    clearTimeout(gToolbarRefreshTimer);
    gToolbarRefreshTimer = null;
  }
  gToolbarObserver?.disconnect();
  gToolbarObserver = null;
  window.removeEventListener("hashchange", refreshToolbarButtonsSafely);
  window.removeEventListener("popstate", refreshToolbarButtonsSafely);
  window.removeEventListener("message", onPageCallersMessage);
  getRuntime()?.onMessage?.removeListener(onExtensionMessage);
  for (const [type, listener, options] of documentListeners) document.removeEventListener(type, listener, options);
  documentListeners.length = 0;
  for (const id of [FLOATING_ROOT_ID, COPY_OVERLAY_ID, FIELDS_MOVER_OVERLAY_ID, CALLERS_OVERLAY_ID]) document.getElementById(id)?.remove();
}
globalThis.__guthonContentCleanup = stopExtensionLoops;

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
      if (event.source !== window || event.origin !== location.origin) {
        return;
      }
      const data = event.data;
      if (!data || data.source !== "guthon-page-bridge" || data.requestId !== requestId) {
        return;
      }
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve({ ready: Boolean(data.ok), fieldsMover: Boolean(data.data?.fieldsMover) && data.data?.ready === "20261127" });
    }

    window.addEventListener("message", onMessage);
    window.postMessage({ source: "guthon-extension", requestId, command: "pingPageBridge", payload: {} }, location.origin);
  });
  if (ready.ready && ready.fieldsMover) {
    return;
  }
  async function injectPageScript(name) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${runtime.getURL(name)}?v=20261127`;
      script.dataset.source = "guthon-bridge";
      script.onload = () => { script.remove(); resolve(); };
      script.onerror = () => { script.remove(); reject(new Error("页面桥接脚本加载失败")); };
      (document.head || document.documentElement).appendChild(script);
    });
  }
  await injectPageScript("host-settings.js");
  await injectPageScript("host-config.js");
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
    }, 20000);

    function onMessage(event) {
      if (event.source !== window || event.origin !== location.origin) {
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
      location.origin
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

async function sendWorkspaceRequest(type, payload, { allowWorkspaceSelection = true } = {}) {
  const dispatch = (message) => GuthonBridgeTasks.run(message.type,message.payload,sendRuntimeMessage);
  const request = { pageOrigin: location.origin, ...payload };
  const cachedWorkspaceKey = await GuthonBridgeWorkspace.storedWorkspaceKey(location.href);
  if (cachedWorkspaceKey) {
    const cachedResult = await dispatch({
      type,
      payload: { ...request, workspaceKey: cachedWorkspaceKey }
    });
    if (cachedResult?.ok !== false || (type !== "route-workspace" && !GuthonBridgeWorkspace.isWorkspaceCacheError(cachedResult))) {
      return cachedResult;
    }
  }
  const result = await dispatch({ type, payload: request });
  if (!result?.workspaceSelectionRequired || !allowWorkspaceSelection) {
    return result;
  }
  if (!result.candidates?.length) {
    throw new Error(result.message || "页面身份未匹配到工作区");
  }
  const workspaceKey = await GuthonBridgeWorkspace.select(result.candidates, location.href);
  return dispatch({
    type,
    payload: { ...request, workspaceKey }
  });
}

function setButtonTitle(root, message) {
  root.querySelector("button").title = message;
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

function pageActionError(error) {
  const message = String(error?.message || "");
  if (/选择一个具体对象/.test(message)) return "请先选择一个具体对象；不会自动拉取全部。";
  if (/不支持 API 源码刷新/.test(message)) return "当前对象暂不支持 API 源码刷新。";
  if (/未识别到|缺少应用系统或数据源身份/.test(message)) return "未识别到完整对象身份，请选择对象后重试。";
  if (/冲突/.test(message)) return "刷新存在冲突，本地修改已保留；请在 Nexus 检查结果。";
  if (/配对令牌/.test(message)) return "请在 Guthon Bridge 扩展弹窗配置配对令牌。";
  if (/端口|无法连接|fetch/i.test(message)) return "Bridge 连接失败，请检查 Nexus 服务与配对端口。";
  if (/工作区|workspace/i.test(message)) return "请在 Guthon Bridge 扩展弹窗核对工作区与页面身份。";
  return "操作失败，请在 Guthon Bridge 扩展弹窗核对状态，或查看 Nexus 输出。";
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
  return location.hash.includes("/gdpaas/dev/procedure_develop") || isVisible(
    document.querySelector('[role="tab"][aria-selected="true"][id^="tab-PR-"]')
  );
}

function isModuleRoute() {
  if (isVisible(document.querySelector('[role="tab"][aria-selected="true"][id^="tab-PR-"]'))) return false;
  if (location.hash.includes("/gdpaas/dev/modules")) return true;
  const activePageTab = document.querySelector('[role="tab"][aria-selected="true"][id^="tab-PG-"]');
  return Boolean(activePageTab && isVisible(activePageTab)) || Array.from(
    document.querySelectorAll('[role="tabpanel"][id^="pane-PG-"]')
  ).some(isVisible);
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

function isViewRoute() {
  return location.hash.includes("/gdpaas/sys/views") || Array.from(document.querySelectorAll(".el-tabs__item, .tabs-item, [role='tab']"))
    .some((item) => isVisible(item) && isActiveTab(item) && /^视图管理/.test(String(item.innerText || item.textContent || "").trim()));
}

function isSystemScriptRoute() {
  return location.hash.includes("/gdpaas/dev/systemscript") || Array.from(document.querySelectorAll(".el-tabs__item, .tabs-item, [role='tab']"))
    .some((item) => isVisible(item) && isActiveTab(item) && /^系统脚本/.test(String(item.innerText || item.textContent || "").trim()));
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

async function refreshCurrentSource(root, button) {
  button.disabled = true;
  try {
    setMessage(root, "正在刷新选中的源码对象...", "busy");
    const inspected = await runPageCommand("inspect-hub-source");
    if (!inspected?.ok) throw new Error(inspected?.message || "未识别到当前对象");
    const target = GuthonBridgeRefreshTarget.build(inspected.data);
    const result = await sendWorkspaceRequest("refresh-api-source", target);
    if (!result?.ok) throw new Error(result?.message || "源码刷新失败");
    setMessage(root, result.message || "刷新请求已完成，请在 Nexus 查看结果和本地修改状态。", "success");
  } catch (error) {
    setMessage(root, pageActionError(error), "error");
  } finally {
    button.disabled = false;
  }
}

function removeNode(id) {
  document.getElementById(id)?.remove();
}

async function locateCurrentInNexus(root, button) {
  button.disabled = true;
  try {
    const inspected = await runPageCommand("inspect-hub-source");
    if (!inspected?.ok) throw new Error(inspected?.message || "未识别到当前谷神对象");
    const result = await sendRuntimeMessage({ type: "open-nexus", target: inspected.data });
    if (!result?.ok) throw new Error(result?.message || "未能打开 Nexus");
    setMessage(root, `已发送 ${result.description}，请在 Nexus 选择工作区`, "success");
  } catch (error) {
    setMessage(root, `Nexus 定位失败：${error?.message || String(error)}`, "error");
  } finally {
    button.disabled = false;
  }
}

function installSourcePullButton() {
  if (!isSupportedGuthonPage() || (!isProcedureRoute() && !isModuleRoute() && !isDataTableRoute() && !isBillTypeRoute() && !isViewRoute() && !isSystemScriptRoute())) {
    return;
  }

  let root = document.getElementById(FLOATING_ROOT_ID);
  if (root && (root.dataset.sharedButtons !== "true" || !root.querySelector(".guthon-bridge-nexus-button"))) {
    root.remove();
    root = null;
  }
  document.getElementById("guthon-bridge-schema-root")?.remove();
  document.getElementById("guthon-bridge-billtype-root")?.remove();
  const mode = isModuleRoute() ? "module" : isProcedureRoute() ? "procedure" : isDataTableRoute() ? "table" : isBillTypeRoute() ? "billtype" : isSystemScriptRoute() ? "system-scripts" : "views";
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
    const localFieldsButton = makeNativeButton("粘贴本地改动", "guthon-bridge-paste-local-fields-button");
    localFieldsButton.addEventListener("click", () => showLocalFieldBatch(root));
    fieldsMover.append(copyFieldsButton, pasteFieldsButton, localFieldsButton);
    root.appendChild(fieldsMover);
    const nexusButton = makeNativeButton("Nexus 定位", "guthon-bridge-nexus-button");
    nexusButton.title = "在 Nexus 中定位当前 PAGE 或过程函数";
    nexusButton.addEventListener("click", () => locateCurrentInNexus(root, nexusButton));
    root.appendChild(nexusButton);
    const message = document.createElement("div");
    message.className = "guthon-bridge-message";
    message.dataset.tone = "idle";
    root.appendChild(message);

    sourceButton.addEventListener("click", () => refreshCurrentSource(root, sourceButton));
    document.body.appendChild(root);
  }
  if (root.dataset.mode !== mode) {
    delete root.dataset.workspaceMode;
    delete root.dataset.workspaceModeKey;
    delete root.dataset.workspaceModeCheckedAt;
  }
  root.dataset.mode = mode;
  root.querySelector(".guthon-bridge-source-button").textContent = "刷新当前对象";
}

async function applyInlineWorkspaceMode() {
  const root = document.getElementById(FLOATING_ROOT_ID);
  if (!root) return;
  const cacheKey = `${location.origin}${location.pathname}${location.hash}#${root.dataset.mode}`;
  const checkedAt = Number(root.dataset.workspaceModeCheckedAt || 0);
  if (root.dataset.workspaceModeKey === cacheKey && Date.now() - checkedAt < 10000) return;
  if (root.dataset.workspaceModeChecking === "true") return;
  root.dataset.workspaceModeChecking = "true";
  try {
    const inspected = await runPageCommand("inspect-page-context");
    // Keep discovery quiet until the platform identity is available.
    if (!inspected?.ok) return;
    const route = await sendWorkspaceRequest(
      "route-workspace",
      inspected.data || {},
      { allowWorkspaceSelection: false }
    );
    if (!route?.ok || !route.workspaceKey) return;
    root.dataset.workspaceModeKey = cacheKey;
    root.dataset.workspaceModeCheckedAt = String(Date.now());
    await publishPageContext(route.workspaceKey).catch(() => {});
  } finally {
    delete root.dataset.workspaceModeChecking;
  }
}

async function publishPageContext(workspaceKey) {
  const inspected = await runPageCommand('inspect-page-context');
  if (!inspected?.ok) return;
  let key = workspaceKey;
  if (!key) {
    const route = await sendWorkspaceRequest('route-workspace', inspected.data || {}, {allowWorkspaceSelection: false});
    if (!route?.ok || !route.workspaceKey) return;
    key = route.workspaceKey;
  }
  return sendRuntimeMessage({type: 'publish-page-context', payload: {workspaceKey: key, metadata: inspected.data}});
}

function installSystemScriptSelection() {
  if (gSystemScriptSelectionInstalled) {
    return;
  }
  listenDocument("click", (event) => {
    if (!isSupportedGuthonPage() || !isSystemScriptRoute()) {
      return;
    }
    const clickedRow = event.target?.closest?.(".gd-data-table .el-table__body tr");
    const table = clickedRow?.closest?.(".gd-data-table");
    if (!clickedRow || !table) {
      return;
    }
    const clickedRows = Array.from(clickedRow.parentElement?.children || []);
    const rowIndex = clickedRows.indexOf(clickedRow);
    const mainBody = Array.from(table.children)
      .find((child) => child.classList?.contains("el-table__body-wrapper"))
      ?.querySelector("tbody");
    const row = mainBody?.children?.[rowIndex];
    if (!row || !Number(String(row.cells?.[2]?.innerText || "").trim())) {
      return;
    }
    const wasSelected = row.dataset.guthonBridgeSystemScriptSelected === "true";
    mainBody.querySelectorAll('tr[data-guthon-bridge-system-script-selected="true"]')
      .forEach((item) => delete item.dataset.guthonBridgeSystemScriptSelected);
    if (!wasSelected) {
      row.dataset.guthonBridgeSystemScriptSelected = "true";
    }
  }, true);
  gSystemScriptSelectionInstalled = true;
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
  listenDocument("click", (event) => {
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
      <div class="guthon-bridge-fields-mover-head"><strong>复制字段</strong><button type="button" class="el-button el-button--default el-button--mini is-plain guthon-bridge-fields-mover-close">关闭</button></div>
      <div class="guthon-bridge-fields-mover-list">${fields.map((field) => `<label class="guthon-bridge-fields-mover-item${field.hidden ? " is-hidden" : ""}"><input type="checkbox" data-index="${field.index}" /><span>${escapeHtml(field.label)}${field.hidden ? "（隐藏）" : ""} <span class="guthon-bridge-fields-mover-meta">${escapeHtml(field.fieldId || "无字段编码")}</span></span></label>`).join("") || "当前组件没有字段"}</div>
      <div class="guthon-bridge-fields-mover-actions"><button type="button" class="el-button el-button--default el-button--mini is-plain guthon-bridge-fields-mover-select-all">全选</button><button type="button" class="el-button el-button--default el-button--mini is-plain guthon-bridge-fields-mover-copy">复制</button><button type="button" class="el-button el-button--default el-button--mini is-plain guthon-bridge-fields-mover-cancel">取消</button></div>
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

function showLocalFieldBatch(root) {
  removeNode(FIELDS_MOVER_OVERLAY_ID);
  const overlay = document.createElement("div");
  overlay.id = FIELDS_MOVER_OVERLAY_ID;
  overlay.innerHTML = `
    <div class="guthon-bridge-fields-mover-panel" role="dialog" aria-label="粘贴本地字段改动">
      <div class="guthon-bridge-fields-mover-head"><strong>粘贴本地字段改动</strong></div>
      <div class="guthon-bridge-fields-mover-list">
        <label>粘贴从 Nexus 复制的字段改动
          <textarea rows="4" spellcheck="false" class="guthon-bridge-local-fields-input"></textarea>
        </label>
        <div role="status"></div>
        <ul class="guthon-bridge-local-fields-preview"></ul>
      </div>
      <div class="guthon-bridge-fields-mover-actions">
        <button type="button" class="el-button el-button--default el-button--mini" data-action="preview">预览</button>
        <button type="button" class="el-button el-button--primary el-button--mini" data-action="apply" disabled>应用到设计器</button>
        <button type="button" class="el-button el-button--default el-button--mini" data-action="close">关闭</button>
      </div>
    </div>`;
  const input = overlay.querySelector("textarea");
  const status = overlay.querySelector('[role="status"]');
  const list = overlay.querySelector("ul");
  const preview = overlay.querySelector('[data-action="preview"]');
  const apply = overlay.querySelector('[data-action="apply"]');
  const close = () => overlay.remove();
  let previewId;
  const invalidate = () => {
    apply.disabled = true;
    previewId = undefined;
    list.replaceChildren();
    status.textContent = "";
  };
  input.addEventListener("input", invalidate);
  overlay.querySelector('[data-action="close"]').addEventListener("click", close);
  overlay.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
  preview.addEventListener("click", async () => {
    invalidate();
    input.disabled = preview.disabled = true;
    try {
      const result = await runPageCommand("previewLocalFieldBatch", {text: input.value});
      if (!result.ok) throw new Error(result.message);
      const data = result.data;
      const display = value => {
        const formatted = JSON.stringify(value) ?? "（无）";
        return formatted.length > 100 ? formatted.slice(0, 100) + "…" : formatted;
      };
      for (const text of [
        ...data.changes.map(change => `${change.fieldId} · ${change.path.join(".")} · ${display(change.before)} → ${display(change.after)}`),
        ...data.additions.map(field => `新增 ${field.fieldId}${field.hidden ? "（隐藏）" : ""}`)
      ]) {
        const item = document.createElement("li");
        item.textContent = text;
        list.append(item);
      }
      status.textContent = `${data.pageId} · ${data.component} · ${data.changes.length} 项属性或事件改动，${data.additions.length} 个新增字段，${data.already} 项已一致`;
      previewId = data.id;
      apply.disabled = !data.changes.length && !data.additions.length;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      input.disabled = preview.disabled = false;
    }
  });
  apply.addEventListener("click", async () => {
    if (previewId === undefined) return;
    input.disabled = preview.disabled = apply.disabled = true;
    try {
      const result = await runPageCommand("applyLocalFieldBatch", {id: previewId});
      if (!result.ok) throw new Error(result.message);
      const {changed, added} = result.data;
      setMessage(root, `已应用 ${changed} 项改动、${added} 个新增字段，请核对并在谷神设计器中保存`, "success");
      close();
    } catch (error) {
      invalidate();
      status.textContent = error.message;
    } finally {
      input.disabled = preview.disabled = false;
    }
  });
  document.body.appendChild(overlay);
  input.focus();
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
    listenDocument("mouseup", stopDrag, { once: true });
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

function callerLabel(caller) {
  if (caller.source_table === "page") {
    return `模块开发 · ${caller.source_name || caller.source_alias_id || caller.source_id}`;
  }
  return `过程函数 · ${caller.source_alias_id}.${caller.fun_id}`;
}

function callerMeta(caller) {
  const layer = caller.source_layer === "PROJECT" ? "项目层" : "产品层";
  const location = caller.line_no ? `第 ${caller.line_no} 行` : "未记录行号";
  return `${layer} · ${location}`;
}

async function showProcedureCallers(target) {
  removeNode(CALLERS_OVERLAY_ID);
  const overlay = document.createElement("div");
  overlay.id = CALLERS_OVERLAY_ID;
  overlay.innerHTML = `
    <div class="guthon-bridge-callers-panel">
      <div class="guthon-bridge-callers-head">
        <strong>${escapeHtml(target.procedureKeyword)}.${escapeHtml(target.funId)} 的调用方</strong>
        <button type="button" class="el-button el-button--default el-button--mini is-plain">关闭</button>
      </div>
      <div class="guthon-bridge-callers-list">
        <div class="guthon-bridge-callers-state">正在查询调用方...</div>
      </div>
    </div>
  `;
  overlay.querySelector(".guthon-bridge-callers-head button").addEventListener("click", () => removeNode(CALLERS_OVERLAY_ID));
  document.body.appendChild(overlay);

  const list = overlay.querySelector(".guthon-bridge-callers-list");
  list.innerHTML = '<button type="button">查询调用方</button>';
  await new Promise((resolve) => list.querySelector("button").addEventListener("click", (event) => {
    if (event.isTrusted) resolve();
  }));
  list.textContent = "正在查询调用方...";
  const result = await sendWorkspaceRequest(
    "query-procedure-callers",
    { alias: target.procedureKeyword, funId: target.funId }
  );
  if (!result?.ok) {
    throw new Error(result?.message || "调用方查询失败");
  }
  const callers = Array.isArray(result.callers) ? result.callers : [];
  if (!callers.length) {
    list.innerHTML = '<div class="guthon-bridge-callers-state">未找到静态调用方</div>';
    return;
  }
  list.innerHTML = callers.map((caller, index) => `
    <button type="button" class="guthon-bridge-caller" data-index="${index}">
      <strong>${escapeHtml(callerLabel(caller))}</strong>
      <span class="guthon-bridge-caller-meta">${escapeHtml(callerMeta(caller))}</span>
    </button>
  `).join("");
  list.addEventListener("click", async (event) => {
    const button = event.target.closest(".guthon-bridge-caller");
    if (!button) {
      return;
    }
    const caller = callers[Number(button.dataset.index)];
    button.disabled = true;
    try {
      const opened = await runPageCommand(
        caller.source_table === "page" ? "open-module-caller" : "open-procedure-caller",
        caller
      );
      if (!opened?.ok) {
        throw new Error(opened?.message || "跳转失败");
      }
      removeNode(CALLERS_OVERLAY_ID);
    } catch (error) {
      button.disabled = false;
      list.insertAdjacentHTML("afterbegin", `<div class="guthon-bridge-callers-state">${escapeHtml(error?.message || "跳转失败")}</div>`);
    }
  });
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
          <col class="guthon-bridge-col-3" />
          <col class="guthon-bridge-col-11" />
          <col class="guthon-bridge-col-11" />
          <col class="guthon-bridge-col-6" />
          <col class="guthon-bridge-col-7" />
          <col class="guthon-bridge-col-11" />
          <col class="guthon-bridge-col-4" />
          <col class="guthon-bridge-col-6" />
          <col class="guthon-bridge-col-9" />
          <col class="guthon-bridge-col-8" />
          <col class="guthon-bridge-col-7" />
          <col class="guthon-bridge-col-8" />
          <col class="guthon-bridge-col-3" />
          <col class="guthon-bridge-col-3" />
          <col class="guthon-bridge-col-3" />
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
    listenDocument("mousemove", move);
    listenDocument("mouseup", stop);
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
    listenDocument("mousemove", move);
    listenDocument("mouseup", stop);
    event.preventDefault();
  });
}

async function showCopyOverlay() {
  if (!isSupportedGuthonPage() || !isModuleRoute()) {
    throw new Error("复制模式只支持模块开发页面");
  }
  removeNode(COPY_OVERLAY_ID);
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
    installSystemScriptSelection();

    if (isModuleRoute() || isProcedureRoute() || isDataTableRoute() || isBillTypeRoute() || isViewRoute() || isSystemScriptRoute()) {
      installSourcePullButton();
      await applyInlineWorkspaceMode();
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

function refreshToolbarButtonsSafely() {
  if (gRefreshInFlight) {
    gRefreshRequested = true;
    return gRefreshInFlight;
  }
  gRefreshInFlight = refreshToolbarButtons()
    .catch(() => {})
    .finally(() => {
      gRefreshInFlight = null;
      if (gRefreshRequested) {
        gRefreshRequested = false;
        refreshToolbarButtonsSafely();
      }
    });
  return gRefreshInFlight;
}

function toolbarContextMarker() {
  const activeTabs = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]'))
    .map((tab) => tab.id || tab.textContent?.trim() || "");
  return `${location.hash}\n${activeTabs.join("|")}`;
}

function observeToolbarContext() {
  if (!document.body || gToolbarObserver) return;
  gObservedToolbarContext = toolbarContextMarker();
  gToolbarObserver = new MutationObserver((mutations) => {
    const rootMissingAfterPageChange = location.hash.includes("/gdpaas/")
      && !document.getElementById(FLOATING_ROOT_ID)
      && mutations.some((mutation) => mutation.type === "childList"
        && !mutation.target.closest?.(`#${COPY_OVERLAY_ID}, #${FIELDS_MOVER_OVERLAY_ID}, #${CALLERS_OVERLAY_ID}`));
    const tabsChanged = mutations.some((mutation) => {
      if (mutation.type === "attributes") {
        return mutation.target.matches?.('[role="tab"], [role="tabpanel"]')
          || mutation.target.closest?.('[role="tablist"]');
      }
      return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => node.nodeType === 1
        && (node.matches?.('[role="tab"], [role="tabpanel"], [role="tablist"]')
          || node.querySelector?.('[role="tab"], [role="tabpanel"], [role="tablist"]')));
    });
    if (!tabsChanged && !rootMissingAfterPageChange) return;
    const context = toolbarContextMarker();
    const contextChanged = context !== gObservedToolbarContext;
    gObservedToolbarContext = context;
    if (!contextChanged && !rootMissingAfterPageChange) return;
    if (gToolbarRefreshTimer !== null) return;
    gToolbarRefreshTimer = setTimeout(() => {
      gToolbarRefreshTimer = null;
      refreshToolbarButtonsSafely();
    }, 80);
  });
  gToolbarObserver.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-selected", "class", "style"]
  });
}

window.addEventListener("hashchange", refreshToolbarButtonsSafely);
window.addEventListener("popstate", refreshToolbarButtonsSafely);

function onExtensionMessage(message, sender, sendResponse) {
  if (sender.id !== getRuntime()?.id || !isSupportedGuthonPage()) return false;
  const root = document.getElementById(FLOATING_ROOT_ID) || document.body;
  const action = message?.type === "run-page-command"
    ? () => runPageCommand(message.command, message.payload)
    : message?.type === 'refresh-page-context'
    ? async () => {await refreshToolbarButtonsSafely(); await publishPageContext(); return {ok: true};}
    : message?.type === "show-copy-overlay"
    ? async () => ({ ok: true, data: await showCopyOverlay() })
    : message?.type === "show-fields-mover"
      ? async () => ({ ok: true, data: await showFieldsMoverOverlay(root) })
      : message?.type === "paste-fields-mover"
        ? async () => ({ ok: true, data: await pasteCopiedFields(root) })
        : message?.type === "show-local-field-batch"
          ? async () => {
            if (!isModuleRoute()) throw new Error("字段平移只支持模块开发页面");
            showLocalFieldBatch(root);
            return {ok: true};
          }
        : null;
  if (!action) {
    return false;
  }
  action()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, message: error?.message || String(error) }));
  return true;
}
getRuntime()?.onMessage?.addListener(onExtensionMessage);

function onPageCallersMessage(event) {
  const message = event.data;
  if (
    event.source === window
    && event.origin === location.origin
    && message?.source === "guthon-page-bridge"
    && message?.event === "procedure-callers-request"
  ) {
    showProcedureCallers(message.data).catch((error) => {
      const state = document.querySelector(`#${CALLERS_OVERLAY_ID} .guthon-bridge-callers-state`);
      if (state) {
        state.textContent = pageActionError(error);
      }
      console.error("谷神桥接：调用方查询失败");
    });
  }
}
window.addEventListener("message", onPageCallersMessage);

observeToolbarContext();
refreshToolbarButtonsSafely();
// A bounded metadata lease heartbeat restores a suspended MV3 worker or restarted
// Bridge. Route/tab UI changes are observed above instead of repeatedly rescanning.
gIntervalId = setInterval(() => {void publishPageContext().catch(() => {});}, PAGE_CONTEXT_HEARTBEAT_MS);

})();

const OUTPUT_DIR_STORAGE_KEY = "guthonBridgeOutputDir";
const FLOATING_ROOT_ID = "guthon-bridge-floating-root";
const COPY_OVERLAY_ID = "guthon-bridge-copy-overlay";
const FIELDS_MOVER_OVERLAY_ID = "guthon-bridge-fields-mover-overlay";
const CALLERS_OVERLAY_ID = "guthon-bridge-callers-overlay";

let gIntervalId = null;
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
      script.src = `${runtime.getURL(name)}?v=20260723d`;
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

async function sendWorkspaceRequest(type, payload) {
  const request = { pageOrigin: location.origin, ...payload };
  const result = await sendRuntimeMessage({ type, payload: request });
  if (!result?.workspaceSelectionRequired) {
    return result;
  }
  if (!result.candidates?.length) {
    throw new Error(result.message || "页面身份未匹配到工作区");
  }
  const workspaceKey = await GuthonBridgeWorkspace.select(result.candidates, location.href);
  return sendRuntimeMessage({
    type,
    payload: { ...request, workspaceKey }
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
      pullResult = await sendWorkspaceRequest(
        "pull-hub-source",
        {
          sourceType: target.mode === "page-source" ? "page" : "procedure",
          sourceId: target.mode === "page-source" ? target.pageId || "" : target.procedureId || "",
          alias: target.procedureKeyword || target.procedureName || "",
          funId: target.mode === "page-source" ? "" : target.funId || "",
          dataSourceId: target.dataSourceId || "",
          systemId: target.systemId || "",
          force
        }
      );
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

    const result = await sendWorkspaceRequest("export-table-schema", inspected.data);
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

    const result = await sendWorkspaceRequest(
      "export-bill-type",
      {
        dataSourceIds: [inspected.data.dataSourceId],
        billTypeCodes: inspected.data.billTypeCodes || []
      }
    );
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

async function exportCurrentViewSql(root, button = root.querySelector("button")) {
  try {
    button.disabled = true;
    setButtonText(root, "源码拉取");
    setButtonTitle(root, "正在拉取视图源码...");
    setMessage(root, "正在拉取视图源码...", "busy");

    const bridgeHealth = await sendRuntimeMessage({ type: "bridge-health" });
    if (!bridgeHealth?.ok) {
      throw new Error(`本地桥接服务不可用：${bridgeHealth?.message || "未知错误"}`);
    }

    const inspected = await runPageCommand("inspectViewTarget");
    if (!inspected?.ok) {
      throw new Error(`识别视图失败: ${inspected?.message || "未识别到数据源"}`);
    }

    const result = await sendWorkspaceRequest(
      "export-view-sql",
      {
        dataSourceIds: [inspected.data.dataSourceId],
        viewIds: inspected.data.viewIds || []
      }
    );
    if (!result?.ok) {
      throw new Error(result?.message || "视图源码拉取失败");
    }

    button.textContent = "成功";
    const selected = Array.isArray(inspected.data.viewIds) && inspected.data.viewIds.length > 0;
    const source = [inspected.data.dataSourceId, inspected.data.dataSourceName].filter(Boolean).join(" ");
    const detail = selected ? `已拉取选中视图: ${inspected.data.viewIds.join(", ")}` : `已拉取数据源 ${source} 全部视图`;
    setButtonTitle(root, `${detail}: ${result.outputDir}`);
    setMessage(root, `${detail}: ${result.exported_view_count}`, "success");
    setTimeout(() => setButtonText(root, "源码拉取"), 1600);
  } catch (error) {
    console.error("谷神桥接：视图源码拉取失败", error);
    button.textContent = "失败";
    const message = error?.message || String(error);
    setButtonTitle(root, message);
    setMessage(root, message, "error");
    setTimeout(() => setButtonText(root, "源码拉取"), 2200);
  } finally {
    button.disabled = false;
  }
}

async function exportCurrentSystemScripts(root, button, pullAll = false) {
  const idleText = pullAll ? "全部拉取" : "选中拉取";
  try {
    button.disabled = true;
    setButtonTextNode(button, "拉取中");
    button.title = "正在拉取系统脚本...";
    setMessage(root, "正在拉取系统脚本...", "busy");

    const bridgeHealth = await sendRuntimeMessage({ type: "bridge-health" });
    if (!bridgeHealth?.ok) {
      throw new Error(`本地桥接服务不可用：${bridgeHealth?.message || "未知错误"}`);
    }

    const inspected = await runPageCommand("inspectSystemScriptTarget");
    if (!inspected?.ok) {
      throw new Error(`识别系统脚本失败: ${inspected?.message || "未识别到应用系统"}`);
    }
    const scriptTypes = pullAll ? [] : inspected.data.scriptTypes || [];
    if (!pullAll && scriptTypes.length === 0) {
      throw new Error("请先点击脚本行进行选中，或使用“全部拉取”");
    }

    const result = await sendWorkspaceRequest(
      "export-system-scripts",
      {
        dataSourceId: inspected.data.dataSourceId || "",
        systemIds: [inspected.data.systemId],
        scriptTypes
      }
    );
    if (!result?.ok) {
      throw new Error(result?.message || "系统脚本拉取失败");
    }

    button.textContent = "成功";
    const target = [inspected.data.systemName, inspected.data.systemId].filter(Boolean).join(" ");
    const detail = pullAll ? `已拉取 ${target} 全部系统脚本` : `已拉取脚本类型 ${scriptTypes.join(", ")}`;
    const outputPath = pullAll ? result.outputDir : result.work_copy_paths?.[0] || result.outputDir;
    button.title = `${detail}: ${outputPath}`;
    setMessage(root, `${detail}: ${outputPath}`, "success");
    setTimeout(() => setButtonTextNode(button, idleText), 1600);
  } catch (error) {
    console.error("谷神桥接：系统脚本拉取失败", error);
    button.textContent = "失败";
    const message = error?.message || String(error);
    button.title = message;
    setMessage(root, message, "error");
    setTimeout(() => setButtonTextNode(button, idleText), 2200);
  } finally {
    button.disabled = false;
  }
}

function removeNode(id) {
  document.getElementById(id)?.remove();
}

function installSourcePullButton() {
  if (!isSupportedGuthonPage() || (!isProcedureRoute() && !isModuleRoute() && !isDataTableRoute() && !isBillTypeRoute() && !isViewRoute() && !isSystemScriptRoute())) {
    return;
  }

  let root = document.getElementById(FLOATING_ROOT_ID);
  if (root && root.dataset.sharedButtons !== "true") {
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
    const systemAllButton = makeNativeButton("全部拉取", "guthon-bridge-system-script-all guthon-bridge-system-script-only");
    systemAllButton.addEventListener("click", () => exportCurrentSystemScripts(root, systemAllButton, true));
    root.appendChild(systemAllButton);
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
      else if (isViewRoute()) exportCurrentViewSql(root, sourceButton);
      else if (isSystemScriptRoute()) exportCurrentSystemScripts(root, sourceButton, false);
      else pullCurrentProcedure(root, sourceButton);
    });
    document.body.appendChild(root);
  }
  root.dataset.mode = mode;
  root.querySelector(".guthon-bridge-source-button").textContent = mode === "system-scripts" ? "选中拉取" : "源码拉取";
}

function installSystemScriptSelection() {
  if (gSystemScriptSelectionInstalled) {
    return;
  }
  document.addEventListener("click", (event) => {
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

  const result = await sendWorkspaceRequest(
    "query-procedure-callers",
    { alias: target.procedureKeyword, funId: target.funId }
  );
  if (!result?.ok) {
    throw new Error(result?.message || "调用方查询失败");
  }
  const callers = Array.isArray(result.callers) ? result.callers : [];
  const list = overlay.querySelector(".guthon-bridge-callers-list");
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

    if (isModuleRoute() || isProcedureRoute()) {
      await ensurePageBridge();
    }
    if (isModuleRoute() || isProcedureRoute() || isDataTableRoute() || isBillTypeRoute() || isViewRoute() || isSystemScriptRoute()) {
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

window.addEventListener("message", (event) => {
  const message = event.data;
  if (
    event.source === window
    && message?.source === "guthon-page-bridge"
    && message?.event === "procedure-callers-request"
  ) {
    showProcedureCallers(message.data).catch((error) => {
      const state = document.querySelector(`#${CALLERS_OVERLAY_ID} .guthon-bridge-callers-state`);
      if (state) {
        state.textContent = error?.message || "调用方查询失败";
      }
      console.error("谷神桥接：调用方查询失败", error);
    });
  }
});

refreshToolbarButtons().catch(() => {});
gIntervalId = setInterval(refreshToolbarButtons, 1800);

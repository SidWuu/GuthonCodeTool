const statusEl = document.getElementById("status");
const procedureEl = document.getElementById("procedureKeyword");
const funIdEl = document.getElementById("funId");
const procedureLabelEl = document.getElementById("procedureLabel");
const funIdLabelEl = document.getElementById("funIdLabel");
const outputDirEl = document.getElementById("outputDir");
const pullPageBtn = document.getElementById("pullPageBtn");
const pullHubBtn = document.getElementById("pullHubBtn");
const copyFieldsBtn = document.getElementById("copyFieldsBtn");
const pasteFieldsBtn = document.getElementById("pasteFieldsBtn");
const forceRefreshBtn = document.getElementById("forceRefreshBtn");
const closeBtn = document.getElementById("closeBtn");
const OUTPUT_DIR_STORAGE_KEY = "guthonBridgeOutputDir";

function setStatus(message) {
  statusEl.textContent = message;
}

function setResolvedTarget(target) {
  if (target?.mode === "table-schema") {
    procedureEl.value = [target.dataSourceId, target.dataSourceName].filter(Boolean).join(" ");
    funIdEl.value = Array.isArray(target.tableIds) && target.tableIds.length > 0 ? target.tableIds.join(", ") : "当前数据源全部表";
    return;
  }
  if (target?.mode === "billtype") {
    procedureEl.value = [target.dataSourceId, target.dataSourceName].filter(Boolean).join(" ");
    funIdEl.value = Array.isArray(target.billTypeCodes) && target.billTypeCodes.length > 0 ? target.billTypeCodes.join(", ") : "当前数据源全部单据类型";
    return;
  }
  procedureEl.value = target?.procedureKeyword || "";
  funIdEl.value = target?.funId || "";
}

function buildObjectKey(target) {
  if (target?.mode === "page-source") {
    return `page:${target.pageId}#${target.funId}`;
  }
  return `${target?.procedureKeyword || ""}#${target?.funId || ""}`;
}

function isSupportedGuthonUrl(url) {
  return Boolean(globalThis.GuthonBridgeHost?.isAllowed(url));
}

function isModuleUrl(url) {
  return String(url || "").includes("/gdpaas/dev/modules");
}

function isProcedureUrl(url) {
  return String(url || "").includes("/gdpaas/dev/procedure_develop");
}

function setPopupMode(mode) {
  const isModule = mode === "module";
  const isTableSchema = mode === "table-schema";
  const isBillType = mode === "billtype";
  const canPullSource = !isTableSchema && !isBillType;
  document.querySelector(".title").textContent = "Guthon Bridge";
  procedureEl.closest("label").style.display = isModule ? "none" : "";
  funIdEl.closest("label").style.display = isModule ? "none" : "";
  outputDirEl.closest("label").style.display = isModule || isTableSchema || isBillType ? "none" : "";
  procedureLabelEl.textContent = isTableSchema || isBillType ? "数据源" : "包名";
  funIdLabelEl.textContent = isTableSchema ? "数据表" : isBillType ? "单据类型" : "函数名";
  pullPageBtn.textContent = isModule ? "打开复制模式" : "拉取页面当前源码";
  pullPageBtn.style.display = isTableSchema || isBillType ? "none" : "";
  pullHubBtn.textContent = isTableSchema ? "拉取表结构" : isBillType ? "拉取单据类型" : "拉取源码表版本";
  copyFieldsBtn.style.display = isModule ? "" : "none";
  pasteFieldsBtn.style.display = isModule ? "" : "none";
  forceRefreshBtn.style.display = canPullSource ? "" : "none";
  pullHubBtn.parentElement.classList.toggle("full-width", !canPullSource);
}

async function persistOutputDir(outputDir) {
  localStorage.setItem(OUTPUT_DIR_STORAGE_KEY, outputDir);
  await chrome.storage?.local?.set?.({ [OUTPUT_DIR_STORAGE_KEY]: outputDir });
}

async function persistCurrentOutputDir() {
  const outputDir = outputDirEl.value.trim();
  if (outputDir) {
    await persistOutputDir(outputDir);
  }
}

async function getOutputDir() {
  const outputDir = outputDirEl.value.trim();
  if (!outputDir) {
    throw new Error("请先填写保存目录");
  }
  if (!outputDir.startsWith("/")) {
    throw new Error("保存目录必须是本机绝对路径");
  }
  await persistOutputDir(outputDir);
  return outputDir;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  if (!tab || !tab.id) {
    throw new Error("没有找到当前标签页");
  }
  return tab;
}

async function runInMainWorld(tabId, command, payload) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      type: "run-page-command",
      command,
      payload
    });
    return result || { ok: false, message: "页面桥接未返回结果" };
  } catch (error) {
    return {
      ok: false,
      message: error?.message || String(error),
      stack: error?.stack || ""
    };
  }
}
async function resolveCurrentTarget() {
  const tab = await getActiveTab();
  if (!tab.url || !isSupportedGuthonUrl(tab.url)) {
    throw new Error("请先打开谷神开发平台页面");
  }
  const result = await runInMainWorld(tab.id, "inspect-current", {});
  if (!result?.ok) {
    throw new Error(result?.message || "未识别到当前过程函数");
  }
  const target = {
    mode: result.data.mode || "procedure",
    pageId: result.data.pageId || "",
    pageVersion: result.data.pageVersion || "",
    procedureKeyword: result.data.procedureKeyword || result.data.procedureName || "",
    funId: result.data.funId || ""
  };
  if (!target.procedureKeyword || !target.funId) {
    throw new Error("当前过程函数信息不完整");
  }
  setResolvedTarget(target);
  return target;
}

async function resolveHubSourceTarget() {
  const tab = await getActiveTab();
  if (!tab.url || !isSupportedGuthonUrl(tab.url)) {
    throw new Error("请先打开谷神开发平台页面");
  }
  const result = await runInMainWorld(tab.id, "inspect-hub-source", {});
  if (!result?.ok) {
    throw new Error(result?.message || "未识别到源码表查询条件");
  }
  const target = {
    mode: result.data.mode || "procedure",
    pageId: result.data.pageId || "",
    procedureId: result.data.procedureId || "",
    procedureKeyword: result.data.procedureKeyword || result.data.procedureName || "",
    funId: result.data.funId || "",
    dataSourceId: result.data.dataSourceId || "",
    dataSourceName: result.data.dataSourceName || "",
    tableIds: Array.isArray(result.data.tableIds) ? result.data.tableIds : [],
    billTypeCodes: Array.isArray(result.data.billTypeCodes) ? result.data.billTypeCodes : []
  };
  if (target.mode === "billtype") {
    if (!target.dataSourceId) {
      throw new Error("当前单据类型页签没有识别到数据源");
    }
  } else if (target.mode === "table-schema") {
    if (!target.dataSourceId) {
      throw new Error("当前数据表管理页面没有识别到数据源");
    }
  } else if (target.mode === "page-source") {
    if (!target.pageId && !target.procedureKeyword) {
      throw new Error("当前模块开发页面没有识别到页面编码");
    }
  } else if ((!target.procedureId && !target.procedureKeyword) || !target.funId) {
    throw new Error("当前过程函数信息不完整");
  }
  setResolvedTarget(target);
  return target;
}

async function runCommand(command) {
  if (command !== "pull") {
    throw new Error("本插件已屏蔽本地文件回推到谷神代码平台的功能");
  }

  const bridgeHealth = await chrome.runtime.sendMessage({ type: "bridge-health" });
  if (!bridgeHealth.ok) {
    throw new Error(`本地桥接服务不可用：${bridgeHealth.message || "未知错误"}`);
  }

  const tab = await getActiveTab();
  if (!tab.url || !isSupportedGuthonUrl(tab.url)) {
    throw new Error("请先打开谷神开发平台页面");
  }
  const target = await resolveCurrentTarget();
  const outputDir = await getOutputDir();

  const remoteCommand = target.mode === "page-source" ? "pull-page-source" : command;
  const result = await runInMainWorld(tab.id, remoteCommand, {
    procedureKeyword: procedureEl.value.trim(),
    funId: funIdEl.value.trim()
  });

  if (!result?.ok) {
    throw new Error(result?.message || result?.stack || "执行失败");
  }

  if (command === "pull") {
    const objectKey = buildObjectKey(target);
    const saveResult = await chrome.runtime.sendMessage({
      type: "save-pull-result",
      payload: {
        objectKey,
        outputDir,
        content: result.data.script,
        metadata: {
          extension: target.mode === "page-source" ? "xml" : "java",
          mode: target.mode,
          procedureId: result.data.procedureId,
          pageId: result.data.pageId || "",
          pageVersion: result.data.pageVersion || "",
          procedureName: result.data.procedureName || procedureEl.value.trim(),
          funId: funIdEl.value.trim(),
          versionMac: result.data.versionMac || "",
          flag: result.data.flag ?? 0
        }
      }
    });
    return { ok: true, remote: result.data, local: saveResult };
  }

  return result;
}

async function openCopyMode() {
  const tab = await getActiveTab();
  if (!tab.url || !isSupportedGuthonUrl(tab.url) || !isModuleUrl(tab.url)) {
    throw new Error("当前标签页不是模块开发页面");
  }
  const response = await chrome.tabs.sendMessage(tab.id, { type: "show-copy-overlay" });
  if (!response?.ok) {
    throw new Error(response?.message || "打开复制模式失败，请刷新谷神页面后重试");
  }
  return tab;
}

async function runFieldsMover(type) {
  const tab = await getActiveTab();
  if (!tab.url || !isSupportedGuthonUrl(tab.url) || !isModuleUrl(tab.url)) {
    throw new Error("当前标签页不是模块开发页面");
  }
  const response = await chrome.tabs.sendMessage(tab.id, { type });
  if (!response?.ok) {
    throw new Error(response?.message || "字段平移失败，请刷新谷神页面后重试");
  }
  return response.data;
}

async function runHubPull(force = false) {
  const target = await resolveHubSourceTarget();
  if (target.mode === "billtype") {
    return chrome.runtime.sendMessage({
      type: "export-bill-type",
      payload: {
        dataSourceIds: [target.dataSourceId],
        billTypeCodes: target.billTypeCodes
      }
    });
  }
  if (target.mode === "table-schema") {
    return chrome.runtime.sendMessage({
      type: "export-table-schema",
      payload: {
        dataSourceId: target.dataSourceId,
        tableIds: target.tableIds
      }
    });
  }
  const payload = {
    sourceType: target.mode === "page-source" ? "page" : "procedure",
    sourceId: target.mode === "page-source" ? target.pageId || "" : target.procedureId || "",
    alias: target.procedureKeyword || "",
    funId: target.mode === "page-source" ? "" : target.funId || "",
    force
  };
  if (payload.sourceType === "page" && !payload.sourceId && !payload.alias) {
    throw new Error("当前页面没有识别到页面源码表查询条件");
  }
  if (payload.sourceType === "procedure" && ((!payload.sourceId && !payload.alias) || !payload.funId)) {
    throw new Error("当前页面没有识别到过程函数源码表查询条件");
  }
  return chrome.runtime.sendMessage({ type: "pull-hub-source", payload });
}

pullPageBtn.addEventListener("click", async () => {
  let pageUrl = "";
  try {
    const tab = await getActiveTab();
    pageUrl = tab.url || "";
    if (isModuleUrl(tab.url)) {
      setStatus(`正在打开复制模式...\n${tab.url}`);
      await openCopyMode();
      setStatus("复制模式已打开");
      return;
    }
    setStatus(`正在拉取远端脚本并写入本地...\n${tab.url}`);
    const result = await runCommand("pull");
    setStatus(
      [
        "拉取成功",
        result.remote?.pageId
          ? `页面编码：${result.remote.pageId}`
          : `过程函数编码：${result.remote.procedureId}`,
        `本地文件：${result.local.filePath}`
      ].join("\n")
    );
  } catch (error) {
    try {
      await chrome.runtime.sendMessage({
        type: "log-pull-failure",
        payload: {
          pullType: "page-source",
          summary: { url: pageUrl },
          message: error?.message || String(error)
        }
      });
    } catch {
      // Bridge 不可用时无法写入本地日志，保留原错误提示。
    }
    setStatus(`拉取失败\n${error.message}`);
  }
});

pullHubBtn.addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    if (!tab.url || !isSupportedGuthonUrl(tab.url)) {
      throw new Error("请先打开谷神开发平台页面");
    }
    const isTableSchema = pullHubBtn.textContent.includes("表结构");
    const isBillType = pullHubBtn.textContent.includes("单据类型");
    setStatus(`${isBillType ? "正在拉取单据类型" : isTableSchema ? "正在拉取表结构" : "正在从源码表拉取"}...\n${tab.url}`);
    const result = await runHubPull();
    if (!result?.ok) {
      throw new Error(result?.message || (isBillType ? "单据类型拉取失败" : isTableSchema ? "表结构拉取失败" : "源码表拉取失败"));
    }
    if (isBillType) {
      setStatus(["单据类型拉取成功", `输出目录：${result.outputDir}`, `数量：${result.exported_bill_type_count ?? ""}`].join("\n"));
      return;
    }
    if (isTableSchema) {
      setStatus(["表结构拉取成功", `输出目录：${result.outputDir}`, `表数量：${result.exported_table_count ?? ""}`].join("\n"));
      return;
    }
    setStatus([result.message || "源码表拉取成功", `工作副本：${result.workCopyPath}`].join("\n"));
  } catch (error) {
    const isTableSchema = pullHubBtn.textContent.includes("表结构");
    const isBillType = pullHubBtn.textContent.includes("单据类型");
    setStatus(`${isBillType ? "单据类型拉取失败" : isTableSchema ? "表结构拉取失败" : "源码表拉取失败"}\n${error.message}`);
  }
});

copyFieldsBtn.addEventListener("click", async () => {
  try {
    await runFieldsMover("show-fields-mover");
    setStatus("请选择需要复制的字段");
  } catch (error) {
    setStatus(`复制字段失败\n${error.message}`);
  }
});

pasteFieldsBtn.addEventListener("click", async () => {
  try {
    const result = await runFieldsMover("paste-fields-mover");
    setStatus(`已粘贴 ${result.pasted} 个，跳过重复 ${result.duplicate} 个，无效 ${result.invalid} 个`);
  } catch (error) {
    setStatus(`粘贴字段失败\n${error.message}`);
  }
});

forceRefreshBtn.addEventListener("click", async () => {
  try {
    setStatus("正在强制刷新源码表版本...");
    const result = await runHubPull(true);
    if (!result?.ok) {
      throw new Error(result?.message || "强制刷新失败");
    }
    setStatus([result.message || "强制刷新成功", `工作副本：${result.workCopyPath}`].join("\n"));
  } catch (error) {
    setStatus(`强制刷新失败\n${error.message}`);
  }
});

outputDirEl.addEventListener("change", persistCurrentOutputDir);
outputDirEl.addEventListener("blur", persistCurrentOutputDir);
closeBtn.addEventListener("click", () => window.close());

async function initializePopup() {
  pullPageBtn.disabled = true;
  pullHubBtn.disabled = true;
  copyFieldsBtn.disabled = true;
  pasteFieldsBtn.disabled = true;
  forceRefreshBtn.disabled = true;
  const stored = await chrome.storage?.local?.get?.(OUTPUT_DIR_STORAGE_KEY);
  outputDirEl.value =
    stored?.[OUTPUT_DIR_STORAGE_KEY] || localStorage.getItem(OUTPUT_DIR_STORAGE_KEY) || "";
  const tab = await getActiveTab();
  if (tab.url && isSupportedGuthonUrl(tab.url) && isModuleUrl(tab.url)) {
    setPopupMode("module");
    setStatus("当前页面是模块开发");
    pullPageBtn.disabled = false;
    pullHubBtn.disabled = false;
    copyFieldsBtn.disabled = false;
    pasteFieldsBtn.disabled = false;
    forceRefreshBtn.disabled = false;
    return;
  }
  setPopupMode("procedure");
  setStatus(isProcedureUrl(tab.url) ? "正在识别当前过程函数..." : "正在识别当前谷神对象...");
  try {
    const target = await resolveHubSourceTarget();
    setPopupMode(target.mode === "table-schema" ? "table-schema" : target.mode === "billtype" ? "billtype" : "procedure");
    setStatus(
      [
        target.mode === "billtype"
          ? "已识别当前单据类型页签"
          : target.mode === "table-schema"
          ? "已识别当前数据表管理页面"
          : target.mode === "page-source"
            ? "已识别当前模块源码片段"
            : "已识别当前过程函数",
        target.mode === "billtype"
          ? `数据源：${[target.dataSourceId, target.dataSourceName].filter(Boolean).join(" ")}`
          : target.mode === "table-schema"
          ? `数据源：${[target.dataSourceId, target.dataSourceName].filter(Boolean).join(" ")}`
          : target.mode === "page-source"
            ? `页面：${target.procedureKeyword}`
            : `包名：${target.procedureKeyword}`,
        target.mode === "billtype"
          ? `单据类型：${target.billTypeCodes.length > 0 ? target.billTypeCodes.join(", ") : "当前数据源全部单据类型"}`
          : target.mode === "table-schema"
          ? `数据表：${target.tableIds.length > 0 ? target.tableIds.join(", ") : "当前数据源全部表"}`
          : target.mode === "page-source"
            ? `片段：${target.funId}`
            : `函数名：${target.funId}`
      ].join("\n")
    );
    pullPageBtn.disabled = target.mode === "table-schema" || target.mode === "billtype";
    pullHubBtn.disabled = false;
    forceRefreshBtn.disabled = target.mode === "table-schema" || target.mode === "billtype";
  } catch (error) {
    setResolvedTarget(null);
    setStatus(`识别失败\n${error.message}`);
  }
}

initializePopup();

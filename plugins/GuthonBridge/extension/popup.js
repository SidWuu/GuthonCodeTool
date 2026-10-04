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
const locateNexusBtn = document.getElementById("locateNexusBtn");
const forceRefreshBtn = document.getElementById("forceRefreshBtn");
const closeBtn = document.getElementById("closeBtn");

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
  if (target?.mode === "views") {
    procedureEl.value = [target.dataSourceId, target.dataSourceName].filter(Boolean).join(" ");
    funIdEl.value = Array.isArray(target.viewIds) && target.viewIds.length > 0 ? target.viewIds.join(", ") : "当前数据源全部视图";
    return;
  }
  if (target?.mode === "system-scripts") {
    procedureEl.value = [target.systemName, target.systemId].filter(Boolean).join(" ");
    funIdEl.value = Array.isArray(target.scriptTypes) && target.scriptTypes.length > 0 ? target.scriptTypes.join(", ") : "未选中脚本";
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

function isProcedureUrl(url) {
  return String(url || "").includes("/gdpaas/dev/procedure_develop");
}

function setPopupMode(mode) {
  pullHubBtn.dataset.mode = mode;
  forceRefreshBtn.dataset.mode = mode;
  const isModule = mode === "module";
  const isTableSchema = mode === "table-schema";
  const isBillType = mode === "billtype";
  const isViews = mode === "views";
  const isSystemScripts = mode === "system-scripts";
  const canPullSource = !isTableSchema && !isBillType && !isViews && !isSystemScripts;
  document.querySelector(".title").textContent = "Guthon Bridge";
  procedureEl.closest("label").hidden = isModule;
  funIdEl.closest("label").hidden = isModule;
  outputDirEl.closest("label").hidden = isModule || isTableSchema || isBillType || isViews || isSystemScripts;
  procedureLabelEl.textContent = isSystemScripts ? "应用系统" : isTableSchema || isBillType || isViews ? "数据源" : "包名";
  funIdLabelEl.textContent = isSystemScripts ? "脚本类型" : isTableSchema ? "数据表" : isBillType ? "单据类型" : isViews ? "视图" : "函数名";
  pullPageBtn.textContent = isModule ? "打开复制模式" : "拉取页面当前源码";
  pullPageBtn.hidden = isTableSchema || isBillType || isViews || isSystemScripts;
  pullHubBtn.textContent = isSystemScripts ? "拉取选中脚本" : isTableSchema ? "拉取表结构" : isBillType ? "拉取单据类型" : isViews ? "拉取视图源码" : "拉取源码表版本";
  copyFieldsBtn.hidden = !isModule;
  pasteFieldsBtn.hidden = !isModule;
  forceRefreshBtn.textContent = isSystemScripts ? "拉取全部脚本" : "强制刷新";
  forceRefreshBtn.hidden = !canPullSource && !isSystemScripts;
  pullHubBtn.parentElement.classList.toggle("full-width", !canPullSource);
}

function isAbsolutePath(value) {
  return /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(value);
}

async function getOutputDir() {
  const status = await chrome.runtime.sendMessage({ type: "bridge-health" });
  if (!status?.ok) throw new Error(status?.message || "Bridge 尚未配对");
  outputDirEl.value = status.exportRoot;
  const outputDir = outputDirEl.value.trim();
  if (!outputDir) {
    throw new Error("请先填写保存目录");
  }
  if (!isAbsolutePath(outputDir)) {
    throw new Error("保存目录必须是本机绝对路径");
  }
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

async function sendWorkspaceRequest(type, payload) {
  const dispatch = (message) => GuthonBridgeTasks.run(message.type,message.payload);
  const tab = await getActiveTab();
  const pageOrigin = tab.url ? new URL(tab.url).origin : "";
  const request = { pageOrigin, ...payload };
  const cachedWorkspaceKey = await GuthonBridgeWorkspace.storedWorkspaceKey(tab.url || pageOrigin);
  if (cachedWorkspaceKey) {
    const cachedResult = await dispatch({
      type,
      payload: { ...request, workspaceKey: cachedWorkspaceKey }
    });
    if (!GuthonBridgeWorkspace.isWorkspaceCacheError(cachedResult)) {
      return cachedResult;
    }
  }
  const result = await dispatch({ type, payload: request });
  if (!result?.workspaceSelectionRequired) {
    return result;
  }
  if (!result.candidates?.length) {
    throw new Error(result.message || "页面身份未匹配到工作区");
  }
  const workspaceKey = await GuthonBridgeWorkspace.select(result.candidates, tab.url || pageOrigin);
  return dispatch({
    type,
    payload: { ...request, workspaceKey }
  });
}

async function resolveWorkspaceSummary(tab, target) {
  const pageOrigin = tab.url ? new URL(tab.url).origin : "";
  const cachedWorkspaceKey = await GuthonBridgeWorkspace.storedWorkspaceKey(tab.url || pageOrigin);
  const identity = {
    pageOrigin,
    dataSourceId: target.dataSourceId || "",
    systemId: target.systemId || ""
  };
  if (cachedWorkspaceKey) {
    const result = await chrome.runtime.sendMessage({
      type: "route-workspace",
      payload: { ...identity, workspaceKey: cachedWorkspaceKey }
    });
    if (result?.ok) return result.workspace;
  }
  const route = await chrome.runtime.sendMessage({
    type: "route-workspace",
    payload: identity
  });
  if (route?.ok) return route.workspace;
  if (!route?.candidates?.length) return null;
  const workspaceKey = await GuthonBridgeWorkspace.select(route.candidates, tab.url || pageOrigin);
  const result = await chrome.runtime.sendMessage({
    type: "route-workspace",
    payload: { ...identity, workspaceKey }
  });
  return result?.workspace || null;
}

function applyWorkspaceSourceMode(workspace) {
  if (workspace?.sourceMode !== "svn") return false;
  pullPageBtn.hidden = true;
  pullHubBtn.hidden = true;
  forceRefreshBtn.hidden = true;
  setStatus(`当前工作区使用 SVN 源码模式\n请在 Guthon Nexus 中扫描索引、打开 Workcopy 或预检/写回 SVN`);
  return true;
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
    billTypeCodes: Array.isArray(result.data.billTypeCodes) ? result.data.billTypeCodes : [],
    viewIds: Array.isArray(result.data.viewIds) ? result.data.viewIds : [],
    systemId: result.data.systemId || "",
    systemName: result.data.systemName || "",
    scriptTypes: Array.isArray(result.data.scriptTypes) ? result.data.scriptTypes : []
  };
  if (target.mode === "system-scripts") {
    if (!target.systemId) {
      throw new Error("当前系统脚本页面没有识别到应用系统");
    }
  } else if (target.mode === "views") {
    if (!target.dataSourceId) {
      throw new Error("当前视图管理页面没有识别到数据源");
    }
  } else if (target.mode === "billtype") {
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
    const savedTarget = { ...target, ...result.data,
      procedureKeyword: result.data.procedureName || target.procedureKeyword,
      funId: result.data.funId || target.funId };
    const objectKey = buildObjectKey(savedTarget);
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
          funId: savedTarget.funId,
          versionMac: result.data.versionMac || "",
          flag: result.data.flag ?? 0
        }
      }
    });
    if (!saveResult?.ok) throw new Error(saveResult?.message || "保存页面源码失败");
    return { ok: true, remote: result.data, local: saveResult };
  }

  return result;
}

async function openCopyMode() {
  const tab = await getActiveTab();
  if (!tab.url || !isSupportedGuthonUrl(tab.url)) {
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
  if (!tab.url || !isSupportedGuthonUrl(tab.url) || (await resolveHubSourceTarget()).mode !== "page-source") {
    throw new Error("当前标签页不是模块开发页面");
  }
  const response = await chrome.tabs.sendMessage(tab.id, { type });
  if (!response?.ok) {
    throw new Error(response?.message || "字段平移失败，请刷新谷神页面后重试");
  }
  return response.data;
}

async function runHubPull(force = false, pullAllSystemScripts = false) {
  const target = await resolveHubSourceTarget();
  if (target.mode === "system-scripts") {
    const scriptTypes = pullAllSystemScripts ? [] : target.scriptTypes;
    if (!pullAllSystemScripts && scriptTypes.length === 0) {
      throw new Error("请先点击脚本行进行选中，或使用“拉取全部脚本”");
    }
    return sendWorkspaceRequest(
      "export-system-scripts",
      {
        dataSourceId: target.dataSourceId || "",
        systemIds: [target.systemId],
        scriptTypes
      }
    );
  }
  if (target.mode === "views") {
    return sendWorkspaceRequest(
      "export-view-sql",
      {
        dataSourceIds: [target.dataSourceId],
        viewIds: target.viewIds
      }
    );
  }
  if (target.mode === "billtype") {
    return sendWorkspaceRequest(
      "export-bill-type",
      {
        dataSourceIds: [target.dataSourceId],
        billTypeCodes: target.billTypeCodes
      }
    );
  }
  if (target.mode === "table-schema") {
    return sendWorkspaceRequest(
      "export-table-schema",
      {
        dataSourceId: target.dataSourceId,
        tableIds: target.tableIds
      }
    );
  }
  const pageSource = target.mode === "page-source";
  const payload = {
    sourceType: pageSource ? "page" : "procedure",
    sourceId: pageSource ? target.pageId || target.procedureId || "" : target.procedureId || "",
    alias: target.procedureKeyword || "",
    funId: pageSource ? "" : target.funId || "",
    dataSourceId: target.dataSourceId || "",
    systemId: target.systemId || "",
    force
  };
  if (payload.sourceType === "page" && !payload.sourceId && !payload.alias) {
    throw new Error("当前页面没有识别到页面源码表查询条件");
  }
  if (payload.sourceType === "procedure" && ((!payload.sourceId && !payload.alias) || !payload.funId)) {
    throw new Error("当前页面没有识别到过程函数源码表查询条件");
  }
  if (force) {
    const workspace = await resolveWorkspaceSummary(await getActiveTab(), target);
    if (!workspace?.workspaceKey) throw new Error("强制刷新前必须明确选择工作区");
    const key = workspace.workspaceKey;
    const typed = window.prompt(`强制刷新将备份并覆盖工作副本。请输入工作区 ${key} 确认：`, "");
    if (typed !== key) throw new Error("已取消强制刷新");
    payload.workspaceKey = key;
    payload.confirmation = key;
  }
  return sendWorkspaceRequest("pull-hub-source", payload);
}

pullPageBtn.addEventListener("click", async () => {
  let pageUrl = "";
  try {
    const tab = await getActiveTab();
    pageUrl = tab.url || "";
    if ((await resolveHubSourceTarget()).mode === "page-source") {
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
    const isTableSchema = pullHubBtn.dataset.mode === "table-schema";
    const isBillType = pullHubBtn.dataset.mode === "billtype";
    const isViews = pullHubBtn.dataset.mode === "views";
    const isSystemScripts = pullHubBtn.dataset.mode === "system-scripts";
    setStatus(`${isSystemScripts ? "正在拉取选中系统脚本" : isViews ? "正在拉取视图源码" : isBillType ? "正在拉取单据类型" : isTableSchema ? "正在拉取表结构" : "正在从源码表拉取"}...\n${tab.url}`);
    const result = await runHubPull();
    if (!result?.ok) {
      throw new Error(result?.message || (isSystemScripts ? "系统脚本拉取失败" : isViews ? "视图源码拉取失败" : isBillType ? "单据类型拉取失败" : isTableSchema ? "表结构拉取失败" : "源码表拉取失败"));
    }
    if (isSystemScripts) {
      setStatus(["系统脚本拉取成功", `工作副本：${result.work_copy_paths?.[0] || ""}`, `数量：${result.exported_system_script_count ?? ""}`].join("\n"));
      return;
    }
    if (isViews) {
      setStatus(["视图源码拉取成功", `输出目录：${result.outputDir}`, `数量：${result.exported_view_count ?? ""}`].join("\n"));
      return;
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
    const isTableSchema = pullHubBtn.dataset.mode === "table-schema";
    const isBillType = pullHubBtn.dataset.mode === "billtype";
    const isViews = pullHubBtn.dataset.mode === "views";
    const isSystemScripts = pullHubBtn.dataset.mode === "system-scripts";
    setStatus(`${isSystemScripts ? "系统脚本拉取失败" : isViews ? "视图源码拉取失败" : isBillType ? "单据类型拉取失败" : isTableSchema ? "表结构拉取失败" : "源码表拉取失败"}\n${error.message}`);
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

locateNexusBtn.addEventListener("click", async () => {
  try {
    const target = await resolveHubSourceTarget();
    const locator = GuthonBridgeNexusLocator.build(target);
    await chrome.tabs.create({ url: locator.uri });
    setStatus(`已向 Nexus 发送 ${locator.description}\n请在 Nexus 中选择 SVN 工作区和源码`);
  } catch (error) {
    setStatus(`定位失败\n${error.message}\n可在 Nexus 命令面板手动定位 PAGE 或过程函数`);
  }
});

forceRefreshBtn.addEventListener("click", async () => {
  try {
    if (forceRefreshBtn.dataset.mode === "system-scripts") {
      setStatus("正在拉取当前应用系统全部脚本...");
      const result = await runHubPull(false, true);
      if (!result?.ok) {
        throw new Error(result?.message || "系统脚本拉取失败");
      }
      setStatus(["系统脚本拉取成功", `输出目录：${result.outputDir}`, `数量：${result.exported_system_script_count ?? ""}`].join("\n"));
      return;
    }
    setStatus("正在强制刷新源码表版本...");
    const result = await runHubPull(true);
    if (!result?.ok) {
      throw new Error(result?.message || "强制刷新失败");
    }
    setStatus([result.message || "强制刷新成功", `工作副本：${result.workCopyPath}`].join("\n"));
  } catch (error) {
    const action = forceRefreshBtn.dataset.mode === "system-scripts" ? "系统脚本拉取失败" : "强制刷新失败";
    setStatus(`${action}\n${error.message}`);
  }
});

document.getElementById("resumeBridgeJobsBtn").addEventListener("click", async () => {
  setStatus("正在查询原任务；不会重新执行写入...");
  const results = await GuthonBridgeTasks.resume(undefined,(job)=>setStatus(`任务 ${job.workspaceKey}：${job.state}`));
  setStatus(results.length ? results.map((result)=>result?.ok===false ? result.message : "原任务已完成").join("\n") : "当前页面没有待恢复任务");
});

async function refreshRecentPulls() {
  const response = await chrome.runtime.sendMessage({type:'bridge-history-list'});
  if (!response?.ok) throw new Error(response?.message || '历史读取失败');
  const list = document.getElementById('recentPulls');
  list.replaceChildren();
  for (const entry of response.records || []) {
    const item = document.createElement('div');
    const identity = entry.payload?.sourceId || entry.payload?.alias || entry.payload?.systemId || entry.payload?.dataSourceId
      || entry.payload?.dataSourceIds?.join(', ') || '导出对象';
    const description = `${entry.workspaceKey} · ${identity}${entry.payload?.funId ? '.'+entry.payload.funId : ''}`;
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = `再次拉取：${description}`;
    button.addEventListener('click', async () => {
      try {
        const tab = await getActiveTab();
        const request = GuthonBridgeTaskHistory.replay(entry,new URL(tab.url).origin);
        if (!window.confirm(`再次拉取 ${description}？\n按当前工作区规则保护本地修改，不沿用旧的强制覆盖确认。`)) return;
        button.disabled = true;
        setStatus('正在再次拉取历史对象...');
        const result = await GuthonBridgeTasks.run(request.type,request.payload);
        setStatus(result?.ok ? '历史对象再次拉取完成' : result?.message || '再次拉取失败，请先核验状态');
      } catch (error) {setStatus(error.message);}
      finally {button.disabled=false;}
    });
    item.appendChild(button);
    if (entry.outputDir) {
      const folder=document.createElement('p');folder.textContent=`上次导出目录：${entry.outputDir}`;item.appendChild(folder);
    }
    list.appendChild(item);
  }
  if (!(response.records || []).length) list.textContent='此平台暂无最近成功拉取记录';
}
document.getElementById('refreshRecentPullsBtn').addEventListener('click', () => {
  refreshRecentPulls().catch(error=>setStatus(error.message));
});

document.getElementById("pairBridgeBtn").addEventListener("click", async () => {
  try {
    const token = document.getElementById("bridgeToken").value.trim();
    const port = Number(document.getElementById("bridgePort").value);
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("请粘贴 Nexus 复制的完整配对令牌");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须在 1 到 65535 之间");
    await chrome.storage.local.set({ guthonBridgeToken: token, guthonBridgePort: port });
    const result = await chrome.runtime.sendMessage({ type: "bridge-health" });
    if (!result?.ok) throw new Error(result?.message || "连接失败");
    outputDirEl.value = result.exportRoot;
    setStatus("Bridge 配对成功");
  } catch (error) { setStatus(error.message); }
});
closeBtn.addEventListener("click", () => window.close());

async function initializePopup() {
  pullPageBtn.disabled = true;
  pullHubBtn.disabled = true;
  copyFieldsBtn.disabled = true;
  pasteFieldsBtn.disabled = true;
  forceRefreshBtn.disabled = true;
  locateNexusBtn.hidden = true;
  const settings = await chrome.storage.local.get(["guthonBridgeToken", "guthonBridgePort"]);
  document.getElementById("bridgeToken").value = settings.guthonBridgeToken || "";
  document.getElementById("bridgePort").value = settings.guthonBridgePort || 17361;
  const bridgeStatus = await chrome.runtime.sendMessage({ type: "bridge-health" });
  if (bridgeStatus?.ok) outputDirEl.value = bridgeStatus.exportRoot;
  const tab = await getActiveTab();
  setPopupMode("procedure");
  setStatus(isProcedureUrl(tab.url) ? "正在识别当前过程函数..." : "正在识别当前谷神对象...");
  try {
    const target = await resolveHubSourceTarget();
    setPopupMode(target.mode === "table-schema" ? "table-schema" : target.mode === "billtype" ? "billtype" : target.mode === "views" ? "views" : target.mode === "system-scripts" ? "system-scripts" : target.mode === "page-source" ? "module" : "procedure");
    locateNexusBtn.hidden = !GuthonBridgeNexusLocator.isSupported(target);
    locateNexusBtn.querySelector(".action-nexus-label").textContent = target.mode === "page-source"
      ? "在 Nexus 中打开 PAGE" : "在 Nexus 中打开过程函数";
    setStatus(
      [
        target.mode === "system-scripts"
          ? "已识别当前系统脚本页面"
          : target.mode === "views"
          ? "已识别当前视图管理页面"
          : target.mode === "billtype"
          ? "已识别当前单据类型页签"
          : target.mode === "table-schema"
          ? "已识别当前数据表管理页面"
          : target.mode === "page-source"
            ? "已识别当前模块源码片段"
            : "已识别当前过程函数",
        target.mode === "system-scripts"
          ? `应用系统：${[target.systemName, target.systemId].filter(Boolean).join(" ")}`
          : target.mode === "views"
          ? `数据源：${[target.dataSourceId, target.dataSourceName].filter(Boolean).join(" ")}`
          : target.mode === "billtype"
          ? `数据源：${[target.dataSourceId, target.dataSourceName].filter(Boolean).join(" ")}`
          : target.mode === "table-schema"
          ? `数据源：${[target.dataSourceId, target.dataSourceName].filter(Boolean).join(" ")}`
          : target.mode === "page-source"
            ? `页面：${target.procedureKeyword}`
            : `包名：${target.procedureKeyword}`,
        target.mode === "system-scripts"
          ? `脚本类型：${target.scriptTypes.length > 0 ? target.scriptTypes.join(", ") : "未选中，可使用全部拉取"}`
          : target.mode === "views"
          ? `视图：${target.viewIds.length > 0 ? target.viewIds.join(", ") : "当前数据源全部视图"}`
          : target.mode === "billtype"
          ? `单据类型：${target.billTypeCodes.length > 0 ? target.billTypeCodes.join(", ") : "当前数据源全部单据类型"}`
          : target.mode === "table-schema"
          ? `数据表：${target.tableIds.length > 0 ? target.tableIds.join(", ") : "当前数据源全部表"}`
          : target.mode === "page-source"
            ? `片段：${target.funId}`
            : `函数名：${target.funId}`
      ].join("\n")
    );
    const workspace = await resolveWorkspaceSummary(tab, target);
    if (applyWorkspaceSourceMode(workspace)) {
      return;
    }
    pullPageBtn.disabled = target.mode === "table-schema" || target.mode === "billtype" || target.mode === "views" || target.mode === "system-scripts";
    pullHubBtn.disabled = false;
    forceRefreshBtn.disabled = target.mode === "table-schema" || target.mode === "billtype" || target.mode === "views";
    copyFieldsBtn.disabled = target.mode !== "page-source";
    pasteFieldsBtn.disabled = target.mode !== "page-source";
  } catch (error) {
    setResolvedTarget(null);
    setStatus(`识别失败\n${error.message}`);
  }
}

initializePopup();

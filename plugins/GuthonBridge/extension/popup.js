const statusEl = document.getElementById("status");
const procedureEl = document.getElementById("procedureKeyword");
const funIdEl = document.getElementById("funId");
const procedureLabelEl = document.getElementById("procedureLabel");
const funIdLabelEl = document.getElementById("funIdLabel");
const outputDirEl = document.getElementById("outputDir");
const pullPageBtn = document.getElementById("pullPageBtn");
const pullHubBtn = document.getElementById("pullHubBtn");
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
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:" &&
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(parsed.hostname) &&
      parsed.pathname.startsWith("/guthon/")
    );
  } catch {
    return false;
  }
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
  document.querySelector(".title").textContent = "Guthon Bridge";
  procedureEl.closest("label").style.display = isModule ? "none" : "";
  funIdEl.closest("label").style.display = isModule ? "none" : "";
  outputDirEl.closest("label").style.display = isModule || isTableSchema || isBillType ? "none" : "";
  procedureLabelEl.textContent = isTableSchema || isBillType ? "数据源" : "包名";
  funIdLabelEl.textContent = isTableSchema ? "数据表" : isBillType ? "单据类型" : "函数名";
  pullPageBtn.textContent = isModule ? "打开复制模式" : "拉取页面当前源码";
  pullPageBtn.style.display = isTableSchema || isBillType ? "none" : "";
  pullHubBtn.textContent = isTableSchema ? "拉取表结构" : isBillType ? "拉取单据类型" : "拉取源码表版本";
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
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [{ command, payload }],
      func: async ({ command, payload }) => {
        try {
      function toFormBody(data) {
        const params = new URLSearchParams();
        Object.entries(data || {}).forEach(([key, value]) => {
          if (value === undefined || value === null) {
            return;
          }
          params.append(key, String(value));
        });
        return params;
      }

      async function postForm(url, data) {
        const response = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
          },
          body: toFormBody(data)
        });
        const text = await response.text();
        try {
          return JSON.parse(text);
        } catch {
          return { code: -1, message: text };
        }
      }

      function encodeScriptPayload(script) {
        const json = JSON.stringify({ script });
        return btoa(unescape(encodeURIComponent(json)));
      }

      function getVueInstance(element) {
        if (!element || typeof element !== "object") {
          return null;
        }
        return element.__vue__ || element.__vueParentComponent?.proxy || null;
      }

      function getEditorInstances() {
        const scopeRoot =
          document.querySelector(".procedure-script-editor") ||
          document.querySelector(".gd-script-editor") ||
          document.body;
        const elements = scopeRoot.querySelectorAll("*");
        const instances = [];
        elements.forEach((element) => {
          const vm = getVueInstance(element);
          if (vm) {
            instances.push(vm);
          }
        });
        return instances;
      }

      function getSelectedTabInfo() {
        const scopedRoots = [
          document.querySelector(".procedure-script-editor"),
          document.querySelector(".gd-function-head")?.closest("div"),
          document.querySelector(".el-tabs__content")?.previousElementSibling,
          document.body
        ].filter(Boolean);

        let selectedTab = null;
        for (const root of scopedRoots) {
          const candidates = Array.from(
            root.querySelectorAll('[aria-selected="true"]')
          ).filter((node) => {
            const label = String(node.innerText || node.textContent || "").trim();
            if (!label) {
              return false;
            }
            return !["过程函数", "模块开发", "服务日志", "开发日志"].includes(label);
          });
          selectedTab =
            candidates.find((node) => {
              const label = String(node.innerText || node.textContent || "").trim();
              return !label.includes("过程函数");
            }) || candidates[candidates.length - 1] || null;
          if (selectedTab) {
            break;
          }
        }

        if (!selectedTab) {
          return null;
        }
        const label = String(selectedTab.innerText || selectedTab.textContent || "").trim();
        const controlsId =
          selectedTab.getAttribute("aria-controls") ||
          selectedTab.getAttribute("aria-owns") ||
          "";
        const panel =
          (controlsId && document.getElementById(controlsId)) ||
          (selectedTab.id &&
            document.querySelector(`[role="tabpanel"][aria-labelledby="${selectedTab.id}"]`)) ||
          null;
        return {
          element: selectedTab,
          label,
          panel
        };
      }

      function getCurrentPageCode() {
        const pane = Array.from(document.querySelectorAll('[role="tabpanel"][id^="pane-PG-"]')).find((node) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        });
        if (pane) {
          return pane.id.replace(/^pane-/, "");
        }
        const selected = document.querySelector('.el-tabs__item[aria-selected="true"][id^="tab-PG-"]');
        if (selected?.id) {
          return selected.id.replace(/^tab-/, "");
        }
        const params = new URLSearchParams(location.search);
        return (
          params.get("pageId") ||
          params.get("sourceId") ||
          params.get("id") ||
          params.get("page_id") ||
          ""
        );
      }

      function getPageFunctionTitle() {
        const selectedTab = getSelectedTabInfo();
        const candidates = [
          selectedTab?.panel,
          ".gd-function-head",
          ".procedure-script-editor",
          ".el-tabs__content",
          "body"
        ];
        for (const candidate of candidates) {
          const node =
            typeof candidate === "string" ? document.querySelector(candidate) : candidate;
          const text = node?.innerText || "";
          const match = text.match(/function\s+([A-Za-z0-9_$.]+)\s*\(/);
          if (match) {
            return match[1];
          }
        }
        return "";
      }

      function parseFullFunctionName(fullName) {
        const normalized = String(fullName || "").trim();
        if (!normalized) {
          return null;
        }
        const lastDotIndex = normalized.lastIndexOf(".");
        if (lastDotIndex <= 0 || lastDotIndex === normalized.length - 1) {
          return null;
        }
        return {
          fullName: normalized,
          procedureKeyword: normalized.slice(0, lastDotIndex),
          funId: normalized.slice(lastDotIndex + 1)
        };
      }

      function inspectCurrentProcedureContext() {
        const selectedTab = getSelectedTabInfo();
        const selectedFunId = String(selectedTab?.label || "").trim();
        const pageTitle = getPageFunctionTitle();
        const titleInfo = parseFullFunctionName(pageTitle);
        const candidates = [];

        for (const vm of getEditorInstances()) {
          const fun = vm.fun;
          const form = vm.form;
          const localFun = vm.localFun;
          if (!form || typeof form.script !== "string") {
            continue;
          }
          const rawFullName = String(fun?.id || fun?.fullName || pageTitle || "").trim();
          const parsed = parseFullFunctionName(rawFullName) || titleInfo;
          if (!parsed) {
            continue;
          }
          const candidateFunId = String(fun?.funId || parsed.funId || "").trim();
          const procedureKeyword =
            (parsed.funId === (candidateFunId || selectedFunId) ? parsed.procedureKeyword : "") ||
            String(fun?.procedureName || fun?.className || "").trim();
          if (!procedureKeyword || !(candidateFunId || selectedFunId)) {
            continue;
          }
          if (
            selectedFunId &&
            candidateFunId &&
            candidateFunId !== selectedFunId &&
            !rawFullName.toLowerCase().includes(`.${selectedFunId.toLowerCase()}`)
          ) {
            continue;
          }
          candidates.push({
            vm,
            procedureId: fun?.procedureId,
            procedureName: procedureKeyword,
            procedureKeyword,
            fullName: parsed.fullName,
            funId: candidateFunId || selectedFunId,
            script: form.script || localFun?.funScript || "",
            flag: localFun?.flag ?? 0,
            versionMac: localFun?.versionMac || "",
            resolvedBy: rawFullName ? "current-editor" : "page-title"
          });
        }

        if (candidates.length > 0) {
          return candidates[0];
        }

        if (selectedFunId && titleInfo && selectedFunId === titleInfo.funId) {
          return {
            procedureId: "",
            procedureName: titleInfo.procedureKeyword,
            procedureKeyword: titleInfo.procedureKeyword,
            fullName: `${titleInfo.procedureKeyword}.${selectedFunId}`,
            funId: selectedFunId,
            script: "",
            flag: 0,
            versionMac: "",
            resolvedBy: "selected-tab+page-title"
          };
        }

        if (titleInfo) {
          return {
            procedureId: "",
            procedureName: titleInfo.procedureKeyword,
            procedureKeyword: titleInfo.procedureKeyword,
            fullName: titleInfo.fullName,
            funId: selectedFunId || titleInfo.funId,
            script: "",
            flag: 0,
            versionMac: "",
            resolvedBy: "page-title"
          };
        }

        return null;
      }

      function inspectCurrentPageSourceContext() {
        const selectedTab = getSelectedTabInfo();
        const sourceName = String(selectedTab?.label || "").trim() || "源码片段";
        const candidates = [];

        for (const vm of getEditorInstances()) {
          if (vm.fun || vm.localFun) {
            continue;
          }
          const pageId = findDeepFirst(vm, ["pageId"]);
          if (!pageId) {
            continue;
          }
          const pageVersion =
            findDeepFirst(vm, ["pageVersion", "versionMac", "version"]) || "";
          const pageName =
            findDeepFirst(vm, ["pageName", "pageTitle", "title", "label", "name"]) || "";
          const content =
            pickFirst(vm.form, [
              "xml",
              "script",
              "content",
              "source",
              "pageModuleXml",
              "moduleXml"
            ]) ||
            findDeepFirst(vm, [
              "pageModuleXml",
              "moduleXml",
              "xml",
              "script",
              "content",
              "source"
            ]) ||
            "";
          candidates.push({
            vm,
            mode: "page-source",
            pageId: String(pageId),
            pageVersion: String(pageVersion || ""),
            procedureId: String(pageId),
            procedureName: String(pageName || pageId),
            procedureKeyword: String(pageName || pageId),
            fullName: String(pageName || pageId),
            funId: sourceName,
            script: String(content || ""),
            sourceName,
            resolvedBy: "page-source"
          });
        }

        const candidateWithContent = candidates.find((item) => item.script);
        return candidateWithContent || candidates[0] || null;
      }

      function inspectCurrentHubSourceContext() {
        if (isBillTypePage()) {
          return inspectBillTypeTarget();
        }
        if (isDataTableManagementPage()) {
          return inspectTableSchemaTarget();
        }
        if (location.href.includes("/gdpaas/dev/modules")) {
          const pageCode = getCurrentPageCode();
          if (!pageCode) {
            throw new Error("当前模块开发页面没有识别到页面编码");
          }
          return {
            mode: "page-source",
            pageId: pageCode,
            procedureId: pageCode,
            procedureName: pageCode,
            procedureKeyword: pageCode,
            fullName: pageCode,
            funId: "",
            resolvedBy: "module-page-code"
          };
        }
        return inspectCurrentProcedureContext();
      }

      function getMatchingEditorContexts() {
        const targetFullName = `${payload.procedureKeyword}.${payload.funId}`.toLowerCase();
        const pageTitle = getPageFunctionTitle().toLowerCase();
        const matches = [];
        for (const vm of getEditorInstances()) {
          const fun = vm.fun;
          const form = vm.form;
          const localFun = vm.localFun;
          if (!form || typeof form.script !== "string") {
            continue;
          }

          const fullName = String(fun?.id || fun?.fullName || pageTitle || "").toLowerCase();
          const shortFunId = String(fun?.funId || payload.funId).toLowerCase();
          const hasProcedureId = Boolean(fun?.procedureId);
          const hasVersion = Boolean(localFun?.versionMac);
          const matchesTitle = pageTitle.includes(targetFullName);
          const matchesVm =
            fullName.includes(targetFullName) ||
            (fullName.includes(String(payload.procedureKeyword).toLowerCase()) &&
              shortFunId === String(payload.funId).toLowerCase());
          const looksLikeEditor = hasProcedureId || hasVersion || form.script.length > 0;

          const isMatch = (matchesTitle || matchesVm) && looksLikeEditor;
          if (!isMatch) {
            continue;
          }
          matches.push({
            vm,
            procedureId: fun?.procedureId,
            procedureName: String(fun?.id || pageTitle || "").replace(new RegExp(`\\.${payload.funId}$`), ""),
            procedureKeyword: String(fun?.id || pageTitle || "").replace(new RegExp(`\\.${payload.funId}$`), ""),
            fullName: fun?.id || pageTitle || "",
            funId: fun?.funId || payload.funId,
            script: form.script || localFun?.funScript || "",
            flag: localFun?.flag ?? 0,
            versionMac: localFun?.versionMac || "",
            resolvedBy: "current-editor"
          });
        }
        return matches;
      }

      function findCurrentEditorContext() {
        return getMatchingEditorContexts()[0] || null;
      }

      function syncPageSourceVm(vm, content, pageVersion) {
        if (!vm) {
          return;
        }
        const refs = Object.values(vm.$refs || {}).filter(Boolean);
        const updateStringField = (holder, keys, value) => {
          if (!holder || typeof holder !== "object") {
            return;
          }
          keys.forEach((key) => {
            if (typeof holder[key] === "string") {
              holder[key] = value;
            }
          });
        };
        const updateVersionField = (holder) => {
          if (!holder || typeof holder !== "object") {
            return;
          }
          ["pageVersion", "versionMac", "version"].forEach((key) => {
            if (holder[key] !== undefined) {
              holder[key] = pageVersion;
            }
          });
        };
        const maybeNotify = (target) => {
          if (!target) {
            return;
          }
          ["handerCodeChange", "setValue", "setScript", "refresh"].forEach((method) => {
            if (typeof target[method] === "function") {
              try {
                if (method === "refresh") {
                  target[method]();
                } else {
                  target[method](content);
                }
              } catch (error) {
                console.warn(`guthon bridge page-source ${method} failed`, error);
              }
            }
          });
          if (target.editor && typeof target.editor.setValue === "function") {
            try {
              target.editor.setValue(content);
            } catch (error) {
              console.warn("guthon bridge page-source editor.setValue failed", error);
            }
          }
        };

        updateStringField(vm.form, ["xml", "script", "content", "source", "pageModuleXml", "moduleXml"], content);
        updateStringField(vm.page, ["xml", "script", "content", "source", "pageModuleXml", "moduleXml"], content);
        updateStringField(vm.localPage, ["xml", "script", "content", "source", "pageModuleXml", "moduleXml"], content);
        updateVersionField(vm.form);
        updateVersionField(vm.page);
        updateVersionField(vm.localPage);
        if (typeof vm.$forceUpdate === "function") {
          vm.$forceUpdate();
        }
        refs.forEach((ref) => maybeNotify(ref));
        vm.$nextTick?.(() => refs.forEach((ref) => maybeNotify(ref)));
      }

      function syncEditorVm(vm, script, versionMac) {
        if (!vm) {
          return;
        }
        const editorRef = vm.$refs?.editor;
        const refs = Object.values(vm.$refs || {}).filter(Boolean);
        const maybeNotifyScriptChanged = (target) => {
          if (!target) {
            return;
          }
          const methods = [
            "handerCodeChange",
            "setValue",
            "setScript",
            "refresh",
            "focus"
          ];
          methods.forEach((method) => {
            if (typeof target[method] === "function") {
              try {
                if (method === "refresh" || method === "focus") {
                  target[method]();
                } else {
                  target[method](script);
                }
              } catch (error) {
                console.warn(`guthon bridge ${method} failed`, error);
              }
            }
          });
          if (target.editor && typeof target.editor.setValue === "function") {
            try {
              target.editor.setValue(script);
            } catch (error) {
              console.warn("guthon bridge editor.setValue failed", error);
            }
          }
        };

        if (editorRef && typeof editorRef.handerCodeChange === "function") {
          try {
            editorRef.handerCodeChange(script);
          } catch (error) {
            console.warn("guthon bridge handerCodeChange failed", error);
          }
        }
        if (vm.form) {
          vm.form.script = script;
          vm.form.isChange = false;
        }
        if (vm.localFun) {
          vm.localFun.funScript = script;
          vm.localFun.versionMac = versionMac;
        }
        if (vm.fun) {
          vm.fun.versionMac = versionMac;
        }
        if (vm.localFunInfo) {
          vm.localFunInfo.funScript = script;
          vm.localFunInfo.versionMac = versionMac;
        }
        if (typeof vm.handerCodeChange === "function") {
          try {
            vm.handerCodeChange(script);
          } catch (error) {
            console.warn("guthon bridge vm.handerCodeChange failed", error);
          }
        }
        if (typeof vm.$forceUpdate === "function") {
          vm.$forceUpdate();
        }
        maybeNotifyScriptChanged(editorRef);
        refs.forEach((ref) => maybeNotifyScriptChanged(ref));
        vm.$nextTick?.(() => {
          maybeNotifyScriptChanged(editorRef);
          refs.forEach((ref) => maybeNotifyScriptChanged(ref));
          const textarea = vm.$el?.querySelector?.("textarea");
          if (textarea) {
            textarea.value = script;
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
            textarea.dispatchEvent(new Event("change", { bubbles: true }));
          }
        });
      }

      async function reloadAndSyncCurrentEditor(procedureId, funId, fallbackVm) {
        const refreshed = await postForm("/develop/procedure/admin/getFunInfo.htm", {
          procedureId,
          funId
        });
        if (refreshed.code && refreshed.code !== 0) {
          throw new Error(refreshed.message || "保存成功，但重新读取函数内容失败");
        }
        const latestScript =
          findDeepFirst(refreshed, ["funScript", "script", "content", "source"]) || "";
        const latestVersion =
          findDeepFirst(refreshed, ["versionMac", "version", "mac"]) || "";

        const contexts = getMatchingEditorContexts();
        const seen = new Set();
        const targetVms = contexts
          .map((item) => item?.vm)
          .concat(fallbackVm ? [fallbackVm] : [])
          .filter((vm) => {
            if (!vm || seen.has(vm)) {
              return false;
            }
            seen.add(vm);
            return true;
          });
        targetVms.forEach((vm) => syncEditorVm(vm, latestScript, latestVersion));

        return {
          script: latestScript,
          versionMac: latestVersion,
          syncedEditors: targetVms.length
        };
      }

      async function reloadAndSyncCurrentPageSource(pageId, fallbackVm) {
        const refreshed = await postForm("/develop/dev/pages/getPageModuleXml.htm", {
          pageId
        });
        if (refreshed.code && refreshed.code !== 0) {
          throw new Error(refreshed.message || "保存成功，但重新读取页面源码失败");
        }
        const latestContent =
          findDeepFirst(refreshed, ["pageModuleXml", "moduleXml", "xml", "content", "source"]) || "";
        const latestVersion =
          String(findDeepFirst(refreshed, ["pageVersion", "versionMac", "version"]) || "");
        const contexts = [inspectCurrentPageSourceContext()]
          .concat(fallbackVm ? [{ vm: fallbackVm }] : [])
          .filter(Boolean);
        const seen = new Set();
        contexts
          .map((item) => item.vm)
          .filter((vm) => {
            if (!vm || seen.has(vm)) {
              return false;
            }
            seen.add(vm);
            return true;
          })
          .forEach((vm) => syncPageSourceVm(vm, latestContent, latestVersion));
        return {
          script: latestContent,
          pageVersion: latestVersion
        };
      }

      function walk(value, visitor, seen = new WeakSet()) {
        if (Array.isArray(value)) {
          value.forEach((item) => walk(item, visitor, seen));
          return;
        }
        if (!value || typeof value !== "object") {
          return;
        }
        if (seen.has(value)) {
          return;
        }
        seen.add(value);
        visitor(value);
        Object.values(value).forEach((item) => walk(item, visitor, seen));
      }

      function pickFirst(obj, keys) {
        for (const key of keys) {
          if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
            return obj[key];
          }
        }
        return undefined;
      }

      function findDeepFirst(root, keys) {
        let found;
        walk(root, (obj) => {
          if (found !== undefined) {
            return;
          }
          const value = pickFirst(obj, keys);
          if (value !== undefined) {
            found = value;
          }
        });
        return found;
      }

      function getAllVueInstances() {
        const instances = [];
        document.body.querySelectorAll("*").forEach((element) => {
          const vm = getVueInstance(element);
          if (vm) {
            instances.push(vm);
          }
        });
        return instances;
      }

      function isVisible(element) {
        if (!element) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }

      function isDataTableManagementPage() {
        if (location.href.includes("/gdpaas/dev/table") || location.href.includes("/basesetup/table")) {
          return true;
        }
        const activeNodes = Array.from(document.querySelectorAll('[aria-selected="true"], .is-active, .active'));
        return activeNodes.some((node) => String(node.innerText || node.textContent || "").includes("数据表管理"));
      }

      function getActiveText(pattern) {
        const activeNodes = Array.from(document.querySelectorAll('[aria-selected="true"], .is-active, .active')).filter(isVisible);
        const node = activeNodes.find((item) => pattern.test(String(item.innerText || item.textContent || "")));
        return String(node?.innerText || node?.textContent || "").trim();
      }

      function isBillTypePage() {
        const activeNodes = Array.from(document.querySelectorAll('[aria-selected="true"], .is-active, .active'));
        return activeNodes.some((node) => /^单据类型/.test(String(node.innerText || node.textContent || "").trim()));
      }

      function getDataSourceId() {
        const selectedValue = getLabeledSelectValue("数据源");
        if (/^\d{4}$/.test(selectedValue)) {
          return selectedValue;
        }
        for (const vm of getAllVueInstances()) {
          const dataSourceId =
            vm?.$store?.state?.modeDev?.dataSourceId ||
            vm?.dataSourceId ||
            vm?.form?.dataSourceId ||
            vm?.page?.dataSourceId;
          if (dataSourceId) {
            return String(dataSourceId);
          }
        }
        return "";
      }

      function getLabeledSelectValue(labelText) {
        const labels = Array.from(document.querySelectorAll(".el-form-item__label,label,span,div")).filter((item) => isVisible(item) && String(item.innerText || item.textContent || "").trim() === labelText);
        for (const label of labels) {
          const scope = label.closest(".el-form-item") || label.parentElement;
          const select = scope?.querySelector(".el-select");
          const vm = getVueInstance(select);
          const value = pickFirst(vm, ["value", "modelValue", "selected", "currentValue"]);
          if (value !== undefined) {
            return String(value);
          }
        }
        return "";
      }

      function getDataSourceName() {
        const inputValue = getLabeledInputValue("数据源");
        const dataSourceId = getDataSourceId();
        if (inputValue && inputValue !== dataSourceId && !/请选择/.test(inputValue)) {
          return inputValue;
        }
        const pageText = String(document.body?.innerText || "");
        const sourceMatch = dataSourceId ? pageText.match(new RegExp("\\b" + dataSourceId + "\\b\\s*[—-]\\s*([^\\n\\r]+)")) : null;
        if (sourceMatch) {
          return sourceMatch[1].trim();
        }
        const pageMatch = pageText.match(/数据源\s+([^\s]+)\s+(?:表名|类型编码|名称|审核通道|说明)/);
        return pageMatch ? pageMatch[1] : "";
      }

      function getLabeledInputValue(labelText) {
        const labels = Array.from(document.querySelectorAll(".el-form-item__label,label,span,div")).filter((item) => isVisible(item) && String(item.innerText || item.textContent || "").trim() === labelText);
        for (const label of labels) {
          const scope = label.closest(".el-form-item") || label.parentElement;
          const input = scope?.querySelector("input");
          const value = String(input?.value || "").trim();
          if (value) {
            return value;
          }
        }
        return "";
      }

      function extractTableId(text) {
        const match = String(text || "").match(/\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/);
        return match ? match[0] : "";
      }

      function isSelectedTableElement(element) {
        const className = String(element.className || "");
        if (element.getAttribute("aria-selected") === "true" || /\b(active|current|selected|is-selected|is-active)\b/i.test(className)) {
          return true;
        }
        const style = getComputedStyle(element);
        return /rgb\(64,\s*158,\s*255\)|rgb\(30,\s*144,\s*255\)|rgb\(45,\s*140,\s*240\)/.test(style.backgroundColor);
      }

      function getSelectedTableIds() {
        const ids = [];
        Array.from(document.querySelectorAll("body *")).forEach((element) => {
          if (!isVisible(element) || !isSelectedTableElement(element)) {
            return;
          }
          const tableId = extractTableId(element.innerText || element.textContent || "");
          if (tableId && !ids.includes(tableId)) {
            ids.push(tableId);
          }
        });
        return ids;
      }

      function extractBillTypeCode(text) {
        const match = String(text || "").match(/\bBT[A-Z0-9_]*\b/);
        return match ? match[0] : "";
      }

      function getSelectedBillTypeCodes() {
        const codes = [];
        Array.from(document.querySelectorAll("body *")).forEach((element) => {
          if (!isVisible(element) || !isSelectedTableElement(element)) {
            return;
          }
          const row = element.closest("tr");
          const code = extractBillTypeCode(row?.innerText || row?.textContent || element.innerText || element.textContent || "");
          if (code && !codes.includes(code)) {
            codes.push(code);
          }
        });
        return codes;
      }

      function inspectTableSchemaTarget() {
        const dataSourceId = getDataSourceId();
        if (!dataSourceId) {
          throw new Error("当前数据表管理页面没有识别到数据源");
        }
        const dataSourceName = getDataSourceName();
        const tableIds = getSelectedTableIds();
        return {
          mode: "table-schema",
          dataSourceId,
          dataSourceName,
          tableIds,
          procedureKeyword: [dataSourceId, dataSourceName].filter(Boolean).join(" "),
          funId: tableIds.length > 0 ? tableIds.join(", ") : "当前数据源全部表",
          resolvedBy: "data-table-management"
        };
      }

      function inspectBillTypeTarget() {
        const dataSourceId = getDataSourceId();
        if (!dataSourceId) {
          throw new Error("当前单据类型页签没有识别到数据源");
        }
        const dataSourceName = getDataSourceName();
        const billTypeCodes = getSelectedBillTypeCodes();
        return {
          mode: "billtype",
          dataSourceId,
          dataSourceName,
          billTypeCodes,
          procedureKeyword: [dataSourceId, dataSourceName].filter(Boolean).join(" "),
          funId: billTypeCodes.length > 0 ? billTypeCodes.join(", ") : "当前数据源全部单据类型",
          resolvedBy: "bill-type-tab"
        };
      }

      function resolveProcedure(searchResult, packageName, funId) {
        const matches = [];
        walk(searchResult, (obj) => {
          const joined = Object.values(obj)
            .filter((value) => typeof value === "string")
            .join(" ")
            .toLowerCase();
          if (joined && joined.includes(String(funId).toLowerCase())) {
            matches.push(obj);
          }
        });
        const packageLower = String(packageName || "").toLowerCase();
        const chosen =
          matches.find((obj) => {
            const joined = Object.values(obj)
              .filter((value) => typeof value === "string")
              .join(" ")
              .toLowerCase();
            return joined.includes(packageLower);
          }) || matches[0];
        if (!chosen) {
          throw new Error(`未找到过程函数: ${packageName}.${funId}`);
        }
        const procedureId = pickFirst(chosen, ["procedureId", "procId", "id", "value"]);
        if (!procedureId) {
          throw new Error(`已找到候选项，但无法解析 procedureId: ${packageName}.${funId}`);
        }
        return {
          procedureId,
          procedureName:
            pickFirst(chosen, ["procedureName", "fullName", "className", "procName", "name", "label"]) ||
            packageName
        };
      }

      async function pullProcedure() {
        const current = findCurrentEditorContext();
        if (current?.procedureId) {
          const { vm, ...safeCurrent } = current;
          void vm;
          return safeCurrent;
        }
        const searchResult = await postForm("/develop/procedure/admin/search.htm", {
          keyword: payload.funId
        });
        if (searchResult.code && searchResult.code !== 0) {
          throw new Error(searchResult.message || "搜索过程函数失败");
        }
        const procedure = resolveProcedure(searchResult, payload.procedureKeyword, payload.funId);
        const funInfo = await postForm("/develop/procedure/admin/getFunInfo.htm", {
          procedureId: procedure.procedureId,
          funId: payload.funId
        });
        if (funInfo.code && funInfo.code !== 0) {
          throw new Error(funInfo.message || "读取函数内容失败");
        }
        const script = findDeepFirst(funInfo, ["funScript", "script", "content", "source"]) || "";
        if (!script) {
          throw new Error(`已找到函数，但没有解析出脚本文本: ${payload.funId}`);
        }
        return {
          procedureId: procedure.procedureId,
          procedureName: procedure.procedureName,
          funId: payload.funId,
          script,
          flag: findDeepFirst(funInfo, ["flag", "scriptType"]) ?? 0,
          versionMac: findDeepFirst(funInfo, ["versionMac", "version", "mac"]) || "",
          resolvedBy: "search"
        };
      }

      async function pullPageSource() {
        const current = inspectCurrentPageSourceContext();
        if (!current?.pageId) {
          throw new Error("当前页面没有识别到模块源码片段");
        }
        const refreshed = await postForm("/develop/dev/pages/getPageModuleXml.htm", {
          pageId: current.pageId
        });
        if (refreshed.code && refreshed.code !== 0) {
          throw new Error(refreshed.message || "读取页面源码失败");
        }
        const script =
          findDeepFirst(refreshed, ["pageModuleXml", "moduleXml", "xml", "content", "source"]) ||
          current.script ||
          "";
        return {
          ...current,
          script,
          pageVersion:
            String(findDeepFirst(refreshed, ["pageVersion", "versionMac", "version"]) || current.pageVersion || ""),
          resolvedBy: `${current.resolvedBy || "page-source"}+read`
        };
      }

      if (command === "pull") {
        const pulled = await pullProcedure();
        return {
          ok: true,
          data: {
            procedureId: pulled.procedureId,
            procedureName: pulled.procedureName,
            funId: payload.funId,
            script: pulled.script,
            flag: pulled.flag ?? 0,
            versionMac: pulled.versionMac || "",
            resolvedBy: `${pulled.resolvedBy || "unknown"}+read`
          }
        };
      }

      if (command === "pull-page-source") {
        const pulled = await pullPageSource();
        return {
          ok: true,
          data: pulled
        };
      }

      if (command === "checkout" || command === "push" || command === "push-page-source") {
        return { ok: false, message: "本插件已屏蔽签出和回推功能" };
      }

      if (command === "inspect-current") {
        const current = inspectCurrentProcedureContext() || inspectCurrentPageSourceContext();
        if (!current) {
          throw new Error("当前页面没有识别到可编辑对象");
        }
        const { vm, ...safeCurrent } = current;
        void vm;
        return {
          ok: true,
          data: safeCurrent
        };
      }

      if (command === "inspect-hub-source") {
        const current = inspectCurrentHubSourceContext();
        if (!current) {
          throw new Error("当前页面没有识别到源码表查询条件");
        }
        const { vm, ...safeCurrent } = current;
        void vm;
        return {
          ok: true,
          data: safeCurrent
        };
      }

      return { ok: false, message: `Unsupported command: ${command}` };
        } catch (error) {
          return {
            ok: false,
            message: error?.message || String(error),
            stack: error?.stack || ""
          };
        }
      }
    });

    const [{ result }] = injectionResults;
    return result;
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
    throw new Error("当前标签页不是 Guthon 开发平台页面，请先切到在线开发平台页面");
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
    throw new Error("当前标签页不是 Guthon 开发平台页面，请先切到在线开发平台页面");
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
  } else if (!target.procedureKeyword || !target.funId) {
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
    throw new Error(`本地桥接服务不可用: ${bridgeHealth.message || "unknown"}`);
  }

  const tab = await getActiveTab();
  if (!tab.url || !isSupportedGuthonUrl(tab.url)) {
    throw new Error("当前标签页不是 Guthon 开发平台页面，请先切到在线开发平台页面");
  }
  await resolveCurrentTarget();

  let result;
  const target = await resolveCurrentTarget();
  const outputDir = await getOutputDir();

  const remoteCommand = target.mode === "page-source" ? "pull-page-source" : command;
  result = await runInMainWorld(tab.id, remoteCommand, {
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

async function runHubPull() {
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
    funId: target.mode === "page-source" ? "" : target.funId || ""
  };
  if (payload.sourceType === "page" && !payload.sourceId && !payload.alias) {
    throw new Error("当前页面没有识别到页面源码表查询条件");
  }
  if (payload.sourceType === "procedure" && (!payload.alias || !payload.funId)) {
    throw new Error("当前页面没有识别到过程函数源码表查询条件");
  }
  return chrome.runtime.sendMessage({ type: "pull-hub-source", payload });
}

pullPageBtn.addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
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
          ? `pageId: ${result.remote.pageId}`
          : `procedureId: ${result.remote.procedureId}`,
        `本地文件: ${result.local.filePath}`
      ].join("\n")
    );
  } catch (error) {
    setStatus(`拉取失败\n${error.message}`);
  }
});

pullHubBtn.addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    if (!tab.url || !isSupportedGuthonUrl(tab.url)) {
      throw new Error("当前标签页不是 Guthon 开发平台页面");
    }
    const isTableSchema = pullHubBtn.textContent.includes("表结构");
    const isBillType = pullHubBtn.textContent.includes("单据类型");
    setStatus(`${isBillType ? "正在拉取单据类型" : isTableSchema ? "正在拉取表结构" : "正在从源码表拉取"}...\n${tab.url}`);
    const result = await runHubPull();
    if (!result?.ok) {
      throw new Error(result?.message || (isBillType ? "单据类型拉取失败" : isTableSchema ? "表结构拉取失败" : "Hub 拉取失败"));
    }
    if (isBillType) {
      setStatus(["单据类型拉取成功", `输出目录: ${result.outputDir}`, `数量: ${result.exported_bill_type_count ?? ""}`].join("\n"));
      return;
    }
    if (isTableSchema) {
      setStatus(["表结构拉取成功", `输出目录: ${result.outputDir}`, `表数量: ${result.exported_table_count ?? ""}`].join("\n"));
      return;
    }
    setStatus(["源码表拉取成功", `工作副本: ${result.workCopyPath}`].join("\n"));
  } catch (error) {
    const isTableSchema = pullHubBtn.textContent.includes("表结构");
    const isBillType = pullHubBtn.textContent.includes("单据类型");
    setStatus(`${isBillType ? "单据类型拉取失败" : isTableSchema ? "表结构拉取失败" : "源码表拉取失败"}\n${error.message}`);
  }
});

outputDirEl.addEventListener("change", persistCurrentOutputDir);
outputDirEl.addEventListener("blur", persistCurrentOutputDir);
closeBtn.addEventListener("click", () => window.close());

async function initializePopup() {
  pullPageBtn.disabled = true;
  pullHubBtn.disabled = true;
  const stored = await chrome.storage?.local?.get?.(OUTPUT_DIR_STORAGE_KEY);
  outputDirEl.value =
    stored?.[OUTPUT_DIR_STORAGE_KEY] || localStorage.getItem(OUTPUT_DIR_STORAGE_KEY) || "";
  const tab = await getActiveTab();
  if (tab.url && isSupportedGuthonUrl(tab.url) && isModuleUrl(tab.url)) {
    setPopupMode("module");
    setStatus("当前页面是模块开发，可打开复制模式");
    pullPageBtn.disabled = false;
    pullHubBtn.disabled = false;
    return;
  }
  setPopupMode("procedure");
  setStatus(isProcedureUrl(tab.url) ? "正在识别当前打开的过程函数..." : "正在识别当前打开的 Guthon 对象...");
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
          ? `数据源: ${[target.dataSourceId, target.dataSourceName].filter(Boolean).join(" ")}`
          : target.mode === "table-schema"
          ? `数据源: ${[target.dataSourceId, target.dataSourceName].filter(Boolean).join(" ")}`
          : target.mode === "page-source"
            ? `页面: ${target.procedureKeyword}`
            : `包名: ${target.procedureKeyword}`,
        target.mode === "billtype"
          ? `单据类型: ${target.billTypeCodes.length > 0 ? target.billTypeCodes.join(", ") : "当前数据源全部单据类型"}`
          : target.mode === "table-schema"
          ? `数据表: ${target.tableIds.length > 0 ? target.tableIds.join(", ") : "当前数据源全部表"}`
          : target.mode === "page-source"
            ? `片段: ${target.funId}`
            : `函数名: ${target.funId}`
      ].join("\n")
    );
    pullPageBtn.disabled = target.mode === "table-schema" || target.mode === "billtype";
    pullHubBtn.disabled = false;
  } catch (error) {
    setResolvedTarget(null);
    setStatus(`识别失败\n${error.message}`);
  }
}

initializePopup();

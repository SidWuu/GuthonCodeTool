(function () {
  if (window.__guthonPageBridgeCleanup) {
    try {
      window.__guthonPageBridgeCleanup();
    } catch (error) {
      console.warn("guthon bridge cleanup failed", error);
    }
  }

  function toFormBody(payload) {
    const params = new URLSearchParams();
    Object.entries(payload || {}).forEach(([key, value]) => {
      if (value === undefined || value === null) {
        return;
      }
      params.append(key, String(value));
    });
    return params;
  }

  async function postForm(url, payload) {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
      },
      body: toFormBody(payload)
    });
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return { code: -1, message: text };
    }
  }

  function walk(value, visitor) {
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, visitor));
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    visitor(value);
    Object.values(value).forEach((item) => walk(item, visitor));
  }

  function collectMatches(root, keyword) {
    const matches = [];
    const lowerKeyword = String(keyword || "").toLowerCase();
    walk(root, (obj) => {
      const joined = Object.values(obj)
        .filter((value) => typeof value === "string")
        .join(" ")
        .toLowerCase();
      if (joined && joined.includes(lowerKeyword)) {
        matches.push(obj);
      }
    });
    return matches;
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

  function getVueInstance(element) {
    if (!element || typeof element !== "object") {
      return null;
    }
    return element.__vue__ || element.__vueParentComponent?.proxy || null;
  }

  function getAllVueInstances() {
    const instances = [];
    const scopeRoot =
      document.querySelector(".procedure-script-editor") ||
      document.querySelector(".gd-script-editor") ||
      document.body;
    const elements = scopeRoot.querySelectorAll("*");
    elements.forEach((element) => {
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

  function readFirst(obj, keys) {
    for (const key of keys) {
      const value = obj?.[key];
      if (value !== undefined && value !== null && value !== "") {
        if (typeof value === "object") {
          return JSON.stringify(value);
        }
        return String(value);
      }
    }
    return "";
  }

  function readNestedFirst(obj, paths) {
    for (const path of paths) {
      const value = path.split(".").reduce((holder, key) => holder?.[key], obj);
      if (value !== undefined && value !== null && value !== "") {
        if (typeof value === "object") {
          return JSON.stringify(value);
        }
        return String(value);
      }
    }
    return "";
  }

  function extractList(response) {
    if (Array.isArray(response)) {
      return response;
    }
    if (Array.isArray(response?.data?.list)) {
      return response.data.list;
    }
    if (Array.isArray(response?.data)) {
      return response.data;
    }
    if (Array.isArray(response?.list)) {
      return response.list;
    }
    return [];
  }

  function getDataSourceId() {
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
    return {
      dataSourceId,
      dataSourceName: getDataSourceName(),
      tableIds: getSelectedTableIds(),
      resolvedBy: "data-table-management"
    };
  }

  function inspectBillTypeTarget() {
    const dataSourceId = getDataSourceId();
    if (!dataSourceId) {
      throw new Error("当前单据类型页签没有识别到数据源");
    }
    return {
      dataSourceId,
      dataSourceName: getDataSourceName(),
      billTypeCodes: getSelectedBillTypeCodes(),
      resolvedBy: "bill-type-tab"
    };
  }

  function putMapValue(map, key, value) {
    if (key !== undefined && key !== null && key !== "" && value !== undefined && value !== null && value !== "") {
      map.set(String(key), String(value));
    }
  }

  function getTemplateLabel(item) {
    const name = item.templateName || item.fieldTemplateName || item.name || "";
    const display = item.disName || item.displayName || item.defName || "";
    if (name && display && name !== display) {
      return `${name} - ${display}`;
    }
    if (name) {
      return `${name} -`;
    }
    return display;
  }

  let displayMapsPromise;
  async function getDisplayMaps() {
    if (displayMapsPromise) {
      return displayMapsPromise;
    }
    displayMapsPromise = (async () => {
      const dataSourceId = getDataSourceId();
      const [templateResponse, codeTitleResponse, compResponse] = await Promise.all([
        postForm("/develop/basesetup/fieldTemplate/admin/getAllList.htm", {}),
        dataSourceId ? postForm("/develop/basesetup/codes/getCodesTitles.htm", { dataSourceId }) : Promise.resolve({}),
        dataSourceId ? postForm("/develop/uicomp/getCompNames.htm", { dataSourceId, compType: 2 }) : Promise.resolve({})
      ]);
      const templateMap = new Map();
      const selectMap = new Map();

      extractList(templateResponse).forEach((item) => {
        putMapValue(templateMap, item.templateId || item.fieldTemplateId || item.id, getTemplateLabel(item));
      });
      extractList(codeTitleResponse).forEach((item) => {
        putMapValue(selectMap, item.typId || item.typeId || item.id, item.typ || item.typeName || item.name);
      });
      extractList(compResponse).forEach((item) => {
        putMapValue(selectMap, item.compId || item.id, item.compName || item.name);
      });

      return { templateMap, selectMap };
    })();
    return displayMapsPromise;
  }

  function readMappedFirst(obj, paths, map) {
    const raw = readNestedFirst(obj, paths);
    return map.get(raw) || raw;
  }

  function isTruthy(value) {
    return value === true || value === 1 || value === "1" || value === "true" || value === "Y" || value === "yes";
  }

  function isFalsy(value) {
    return value === false || value === 0 || value === "0" || value === "false" || value === "N" || value === "no";
  }

  function makeFieldInfo(obj, maps = { templateMap: new Map(), selectMap: new Map() }, extra = {}) {
    const field = readFirst(obj, ["fieldId", "field", "prop", "property", "columnName", "colName", "name", "id"]);
    const label = readFirst(obj, ["label", "title", "disName", "displayName", "name"]);
    if (!field || !label || field.startsWith("el-table_")) {
      return null;
    }
    const requiredValue =
      obj?.nullable === false || obj?.allowNull === false || obj?.allowBlank === false
        ? true
        : pickFirst(obj, ["required", "isRequired", "mustInput", "notNull", "isMust", "must", "require"]);
    const hiddenValue = pickFirst(obj, ["hidden", "isHidden", "hide", "isHide", "visible"]);
    return {
      field,
      label,
      type: readFirst(obj, ["type", "colType", "displayMode", "controlType"]),
      format: readFirst(obj, ["format", "formatter", "formatType"]),
      template: readMappedFirst(obj, ["fieldTemplateName", "templateName", "fieldTemplateId"], maps.templateMap),
      selectType: readMappedFirst(obj, ["selectCompName", "selectBox.selectCompName", "selectCompId", "selectBox.selectCompId", "selectBox.typId", "selectBox.codeId", "typId", "codeId", "selectType", "dropType", "dataSourceType"], maps.selectMap),
      valueField: readNestedFirst(obj, ["selectBox.selectCodefieldId", "valueField", "valueName", "valueCol", "codeField"]),
      otherFill: readNestedFirst(obj, ["selectBox.otherSetFields", "otherFill", "otherValue", "fillFields", "fillField"]),
      queryParams: readNestedFirst(obj, ["selectBox.queryParams", "selectBox.queryParam", "queryParams", "queryParam", "params", "param"]),
      width: readFirst(obj, ["disWidth", "displayWidth", "width", "labelWidth", "textWidth", "colWidth"]),
      sum: isTruthy(pickFirst(obj, ["isSum", "sum", "summary", "isSummary", "total", "isTotal"])),
      align: readFirst(obj, ["align", "dataAlign", "textAlign", "headerAlign"]),
      required: requiredValue === "nullable" ? false : isTruthy(requiredValue),
      hidden: extra.hidden || isTruthy(hiddenValue) || (hiddenValue !== undefined && hiddenValue !== "" && isFalsy(hiddenValue)),
      index: 0
    };
  }

  function collectControlFields(root, options = {}, maps) {
    const fields = [];
    const selector = "[data-control-name], .input-box, .data-table, .data-table-control, .detail-table, .el-table";
    const controls = (root.matches?.(selector) ? [root] : []).concat(Array.from(root.querySelectorAll(selector)));
    controls.forEach((element) => {
      if (options.excludeTabPages && element.closest('[role="tabpanel"][id^="pane-tabPage"]')) {
        return;
      }
      let vm = getVueInstance(element);
      for (let depth = 0; vm && depth < 4; depth += 1, vm = vm.$parent) {
        [
          { items: vm.fields, hidden: false },
          { items: vm.columns, hidden: false },
          { items: vm.hideFields, hidden: true }
        ].forEach(({ items, hidden }) => {
          if (!Array.isArray(items)) {
            return;
          }
          items.forEach((item) => {
            const info = makeFieldInfo(item, maps, { hidden });
            if (info) {
              fields.push(info);
            }
          });
        });
      }
    });
    return fields;
  }

  function getControlName(element) {
    const ownName = readElementName(element);
    if (element.matches(".input-box")) {
      return /(Form)$/i.test(ownName) ? ownName : "form";
    }
    if (element.matches(".data-table, .data-table-control, .detail-table, .el-table")) {
      return /(Table)$/i.test(ownName) ? ownName : "table";
    }
    const attrNode = element.closest("[data-control-name]") || element;
    const attrName = readElementName(attrNode);
    if (/(Form|Table)$/i.test(attrName)) {
      return attrName;
    }
    let vm = getVueInstance(element);
    for (let depth = 0; vm && depth < 5; depth += 1, vm = vm.$parent) {
      const vmName =
        readFirst(vm, ["controlName", "ctrlName", "ctName", "controlCode", "controlId", "code", "name", "id"]) ||
        readFirst(vm.$attrs, ["data-control-name", "controlName", "name", "id"]) ||
        findControlNameInObject(vm);
      if (/(Form|Table)$/i.test(vmName)) {
        return vmName;
      }
    }
    return "";
  }

  function isControlGroup(controlName, element) {
    return (
      /(Form|Table)$/i.test(controlName) ||
      /^(form|table)$/i.test(controlName) ||
      element.matches(".input-box, .data-table, .data-table-control, .detail-table, .el-table")
    );
  }

  function readElementName(element) {
    const raw =
      element.getAttribute("data-control-name") ||
      element.getAttribute("name") ||
      element.getAttribute("data-name") ||
      element.getAttribute("aria-label") ||
      element.id ||
      "";
    return String(raw).replace(/^pane-/, "").replace(/^tab-/, "").trim();
  }

  function findControlNameInObject(obj) {
    if (!obj || typeof obj !== "object") {
      return "";
    }
    for (const [key, value] of Object.entries(obj)) {
      if (!/name|code|id|control|form|table/i.test(key) || typeof value !== "string") {
        continue;
      }
      if (/(Form|Table)$/i.test(value)) {
        return value;
      }
    }
    return "";
  }

  function getTabPageLabel(pane, index) {
    const tabId = pane.getAttribute("aria-labelledby");
    const label = tabId ? String(document.getElementById(tabId)?.innerText || "").trim() : "";
    return label || readElementName(pane) || `tabPage${index}`;
  }

  function getControlTitle(prefix, pane, controlName) {
    if (!prefix) {
      return controlName;
    }
    return controlName ? `${prefix}.${controlName}` : prefix;
  }

  function collectControlGroups(root, options = {}, maps) {
    const selector = "[data-control-name], .input-box, .data-table, .data-table-control, .detail-table, .el-table";
    const seen = new Set();
    const groups = [];
    const candidates = (root.matches?.(selector) ? [root] : []).concat(Array.from(root.querySelectorAll(selector)));
    candidates.forEach((element, index) => {
      const groupElement = element.matches(".input-box, .data-table, .data-table-control, .detail-table, .el-table")
        ? element
        : element.closest("[data-control-name]") || element;
      if (groupElement !== element && root.contains(groupElement)) {
        return;
      }
      if (options.excludeTabPages && element.closest('[role="tabpanel"][id^="pane-tabPage"]')) {
        return;
      }
      const controlName = getControlName(element);
      if (!isControlGroup(controlName, element)) {
        return;
      }
      const fields = dedupeFields(collectControlFields(groupElement, {}, maps));
      if (fields.length) {
        const key = `${controlName}|${fields.map((field) => field.field).join(",")}`;
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        groups.push({ controlName, fields });
      }
    });
    return groups;
  }

  function dedupeFields(fields) {
    const seen = new Set();
    return fields.filter((field) => {
      const key = `${field.field}|${field.label}|${field.type}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function getCurrentPageCode() {
    const pane = Array.from(document.querySelectorAll('[role="tabpanel"][id^="pane-PG-"]')).find(isVisible);
    if (pane) {
      return pane.id.replace(/^pane-/, "");
    }
    const selected = document.querySelector('.el-tabs__item[aria-selected="true"][id^="tab-PG-"]');
    return selected?.id?.replace(/^tab-/, "") || "";
  }

  function formatFieldLine(field) {
    const lines = [
      `序号: ${field.index || ""}`,
      `字段: ${field.field || ""}`,
      `显示名称: ${field.required ? "* " : ""}${field.label}`,
      `显示类型: ${field.type}`,
      `显示格式: ${field.format}`,
      `字段模板: ${field.template}`,
      `显示宽度: ${field.width || ""}`,
      `是否必填: ${field.required ? "是" : "否"}`,
      `是否合计: ${field.sum ? "是" : "否"}`,
      `数据对齐: ${field.align || ""}`,
      `显示: ${field.hidden ? "否" : "是"}`
    ];
    if (field.type === "select" || field.selectType || field.valueField || field.otherFill || field.queryParams) {
      lines.push(
        `下拉类型: ${field.selectType}`,
        `数值字段: ${field.valueField}`,
        `其他填值: ${field.otherFill}`,
        `查询参数: ${field.queryParams}`
      );
    }
    return lines.map((line) => `|  |- ${line}`).join("\n");
  }

  function normalizeGroups(groups) {
    const seen = new Set();
    return groups
      .filter((group) => {
        const groupKind = /form$/i.test(group.title) ? "form" : /table$/i.test(group.title) ? "table" : group.title;
        const fieldKey = group.fields.map((field) => field.field).join(",");
        const key = `${groupKind}|${fieldKey}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .map((group) => ({
        ...group,
        fields: group.fields.map((field, index) => ({ ...field, index: index + 1 }))
      }));
  }

  function formatModuleCopyText(data) {
    const lines = [`|- 当前页面编码 ${data.pageCode || ""}`];
    data.groups.forEach((group) => {
      lines.push(`|- ${group.title}`);
      group.fields.forEach((field) => lines.push(formatFieldLine(field)));
    });
    if (!data.groups.length) {
      lines.push("|- 未识别到字段信息");
    }
    return lines.join("\n");
  }

  async function collectModuleCopyText() {
    const maps = await getDisplayMaps();
    const activePane =
      Array.from(document.querySelectorAll('[role="tabpanel"][id^="pane-PG-"]')).find(isVisible) ||
      Array.from(document.querySelectorAll('[role="tabpanel"]')).find(isVisible);
    const activeWorkContext = Array.from((activePane || document).querySelectorAll(".work-context")).find(isVisible);
    const pageCode = getCurrentPageCode();
    const groups = [];

    if (activeWorkContext) {
      const mainRoot = activeWorkContext.querySelector(".tool-menu.tool-box")?.closest(".el-tab-pane") || activeWorkContext;
      collectControlGroups(mainRoot, { excludeTabPages: true }, maps).forEach((group) => {
        groups.push({
          title: getControlTitle("", null, group.controlName),
          fields: group.fields
        });
      });
    }

    Array.from((activeWorkContext || activePane || document).querySelectorAll('[role="tabpanel"][id^="pane-tabPage"]')).forEach((pane, index) => {
      const paneGroups = collectControlGroups(pane, {}, maps);
      paneGroups.forEach((group) => {
        groups.push({
          title: getControlTitle(getTabPageLabel(pane, index), pane, group.controlName),
          fields: group.fields
        });
      });
      if (!paneGroups.length) {
        const fields = dedupeFields(collectControlFields(pane, {}, maps));
        if (fields.length) {
          groups.push({
            title: getTabPageLabel(pane, index),
            fields
          });
        }
      }
    });

    if (!groups.length && activeWorkContext) {
      const fields = dedupeFields(collectControlFields(activeWorkContext, { excludeTabPages: true }, maps));
      if (fields.length) {
        groups.push({ title: readElementName(activeWorkContext) || "form", fields });
      }
    }

    const data = { pageCode, groups: normalizeGroups(groups) };
    return { text: formatModuleCopyText(data), data };
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
    return {
      label: String(selectedTab.innerText || selectedTab.textContent || "").trim()
    };
  }

  function getPageFunctionTitle() {
    const candidates = [
      ".gd-function-head",
      ".procedure-script-editor",
      ".el-tabs__content",
      "body"
    ];
    for (const selector of candidates) {
      const text = document.querySelector(selector)?.innerText || "";
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

  function inspectCurrentProcedure() {
    const selectedFunId = String(getSelectedTabInfo()?.label || "").trim();
    const titleInfo = parseFullFunctionName(getPageFunctionTitle());

    for (const vm of getAllVueInstances()) {
      const fun = vm.fun;
      const form = vm.form;
      const localFun = vm.localFun;
      if (!form || typeof form.script !== "string") {
        continue;
      }

      const rawFullName = String(fun?.id || fun?.fullName || titleInfo?.fullName || "").trim();
      const parsed = parseFullFunctionName(rawFullName) || titleInfo;
      if (!parsed) {
        continue;
      }
      const funId = String(fun?.funId || parsed.funId || selectedFunId || "").trim();
      const procedureKeyword =
        (parsed.funId === funId ? parsed.procedureKeyword : "") ||
        String(fun?.procedureName || fun?.className || "").trim();
      if (!procedureKeyword || !funId) {
        continue;
      }
      if (
        selectedFunId &&
        funId &&
        funId !== selectedFunId &&
        !rawFullName.toLowerCase().includes(`.${selectedFunId.toLowerCase()}`)
      ) {
        continue;
      }

      return {
        procedureId: fun?.procedureId,
        procedureName: procedureKeyword,
        procedureKeyword,
        fullName: parsed.fullName,
        funId,
        script: form.script || localFun?.funScript || "",
        flag: localFun?.flag ?? 0,
        versionMac: localFun?.versionMac || "",
        resolvedBy: rawFullName ? "current-editor" : "page-title"
      };
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

    throw new Error("当前页面没有识别到过程函数");
  }

  function findCurrentProcedureEditorContext(payload) {
    const targetFullName = `${payload.procedureKeyword}.${payload.funId}`.toLowerCase();
    const instances = getAllVueInstances();

    for (const vm of instances) {
      const fun = vm.fun;
      const form = vm.form;
      const localFun = vm.localFun;
      if (!fun || !form) {
        continue;
      }

      const fullName = String(fun.id || fun.fullName || "").toLowerCase();
      const shortFunId = String(fun.funId || "").toLowerCase();
      const matchesCurrentEditor =
        fullName.includes(targetFullName) ||
        (fullName.includes(String(payload.procedureKeyword).toLowerCase()) &&
          shortFunId === String(payload.funId).toLowerCase());

      if (!matchesCurrentEditor) {
        continue;
      }

      const script = form.script || localFun?.funScript || "";
      return {
        procedureId: fun.procedureId,
        procedureName: String(fun.id || "").replace(new RegExp(`\\.${payload.funId}$`), ""),
        fullName: fun.id || "",
        funId: fun.funId || payload.funId,
        script,
        flag: localFun?.flag ?? 0,
        versionMac: localFun?.versionMac || "",
        resolvedBy: "current-editor",
        raw: {
          fun,
          localFun
        }
      };
    }

    return null;
  }

  function resolveProcedure(searchResult, procedureKeyword, funId) {
    const matches = collectMatches(searchResult, funId);
    const packageLower = String(procedureKeyword || "").toLowerCase();
    const chosen =
      matches.find((item) => {
        const joined = Object.values(item)
          .filter((value) => typeof value === "string")
          .join(" ")
          .toLowerCase();
        return joined.includes(packageLower);
      }) || matches[0];
    if (!chosen) {
      throw new Error(`未找到过程函数: ${procedureKeyword}.${funId}`);
    }
    const procedureId = pickFirst(chosen, ["procedureId", "procId", "id", "value"]);
    if (!procedureId) {
      throw new Error(`已找到候选项，但无法解析 procedureId: ${procedureKeyword}.${funId}`);
    }
    return {
      procedureId,
      procedureName:
        pickFirst(chosen, [
          "procedureName",
          "fullName",
          "className",
          "procName",
          "name",
          "label"
        ]) || procedureKeyword
    };
  }

  function resolveProcedureByPackage(searchResult, procedureKeyword) {
    const matches = collectMatches(searchResult, procedureKeyword);
    const exact = matches.find((item) => {
      const name = [
        item.procedureName,
        item.fullName,
        item.className,
        item.procName,
        item.name,
        item.label
      ]
        .filter(Boolean)
        .join(" ");
      return name.includes(procedureKeyword);
    });
    const chosen = exact || matches[0];
    if (!chosen) {
      throw new Error(`未找到过程函数: ${procedureKeyword}`);
    }
    const procedureId = pickFirst(chosen, ["procedureId", "procId", "id", "value"]);
    if (!procedureId) {
      throw new Error(`已找到候选项，但无法解析 procedureId: ${procedureKeyword}`);
    }
    return {
      procedureId,
      procedureName:
        pickFirst(chosen, ["procedureName", "fullName", "className", "procName", "name", "label"]) ||
        procedureKeyword
    };
  }

  async function pullProcedure(payload) {
    const currentEditor = findCurrentProcedureEditorContext(payload);
    if (currentEditor && currentEditor.procedureId) {
      return currentEditor;
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

    const script =
      findDeepFirst(funInfo, ["funScript", "script", "content", "source"]) || "";
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
      resolvedBy: "search",
      raw: funInfo
    };
  }

  async function disabledWriteCommand() {
    throw new Error("本插件已屏蔽签出和回推功能");
  }

  const handlers = {
    inspectCurrentProcedure,
    pullProcedure,
    collectModuleCopyText,
    inspectTableSchemaTarget,
    inspectBillTypeTarget,
    checkOutProcedure: disabledWriteCommand,
    pushProcedure: disabledWriteCommand
  };

  const onMessage = async (event) => {
    if (event.source !== window) {
      return;
    }
    const message = event.data;
    if (!message || message.source !== "guthon-extension") {
      return;
    }

    const { requestId, command, payload } = message;
    const handler = handlers[command];
    if (!handler) {
      window.postMessage(
        {
          source: "guthon-page-bridge",
          requestId,
          ok: false,
          message: `未知命令: ${command}`
        },
        "*"
      );
      return;
    }

    try {
      const data = await handler(payload);
      window.postMessage(
        {
          source: "guthon-page-bridge",
          requestId,
          ok: true,
          data
        },
        "*"
      );
    } catch (error) {
      window.postMessage(
        {
          source: "guthon-page-bridge",
          requestId,
          ok: false,
          message: error.message
        },
        "*"
      );
    }
  };

  window.addEventListener("message", onMessage);
  window.__guthonPageBridgeCleanup = function () {
    window.removeEventListener("message", onMessage);
  };
  window.__guthonPageBridgeReady = "20260630b";
})();

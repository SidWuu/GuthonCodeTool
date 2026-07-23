(function () {
  if (window.__guthonPageBridgeCleanup) {
    try {
      window.__guthonPageBridgeCleanup();
    } catch (error) {
      console.warn("谷神桥接：清理页面桥接失败", error);
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
    const pending = [value];
    const seen = new WeakSet();
    while (pending.length) {
      const current = pending.pop();
      if (!current || typeof current !== "object" || seen.has(current)) {
        continue;
      }
      seen.add(current);
      if (!Array.isArray(current) && visitor(current) === false) {
        return;
      }
      const children = Array.isArray(current) ? current : Object.values(current);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push(children[index]);
      }
    }
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
        return false;
      }
      return undefined;
    });
    return found;
  }

  function getVueInstance(element) {
    if (!element || typeof element !== "object") {
      return null;
    }
    return element.__vue__ || element.__vueParentComponent?.proxy || null;
  }

  function normalizePageCode(value) {
    if (typeof value !== "string" && typeof value !== "number") {
      return "";
    }
    return String(value).trim();
  }

  function readPageCodeFromVm(vm) {
    const directCode = normalizePageCode(vm?.pageId || vm?.pageCode);
    if (directCode) {
      return directCode;
    }
    for (const model of [
      vm?.page,
      vm?.localPage,
      vm?.pageInfo,
      vm?.currentPage,
      vm?.selectedPage,
      vm?.modulePage,
      vm?.module,
      vm?.form
    ]) {
      const modelCode = normalizePageCode(model?.pageId || model?.pageCode);
      if (modelCode) {
        return modelCode;
      }
    }
    return "";
  }

  function getPageCodeFromVue() {
    const activePane = Array.from(document.querySelectorAll('[role="tabpanel"]')).find(isVisible);
    const scopeRoot = activePane || document.querySelector(".work-context");
    if (!scopeRoot) {
      return "";
    }
    const elements = [scopeRoot, ...scopeRoot.querySelectorAll("*")];
    const seen = new Set();
    for (const element of elements) {
      let vm = getVueInstance(element);
      let depth = 0;
      while (vm && depth < 16 && !seen.has(vm)) {
        seen.add(vm);
        const pageCode = readPageCodeFromVm(vm);
        if (pageCode) {
          return pageCode;
        }
        vm = vm.$parent;
        depth += 1;
      }
    }
    return "";
  }

  function getPageCodeFromUrl() {
    const searchParams = new URLSearchParams(location.search);
    const hashQuery = location.hash.includes("?")
      ? location.hash.slice(location.hash.indexOf("?") + 1)
      : "";
    const hashParams = new URLSearchParams(hashQuery);
    for (const key of ["pageId", "sourceId", "id", "page_id"]) {
      const value = normalizePageCode(searchParams.get(key) || hashParams.get(key));
      if (value) {
        return value;
      }
    }
    return "";
  }

  function resolveProcedureTarget(source, offset) {
    if (typeof source !== "string" || !Number.isInteger(offset)) {
      return null;
    }
    const invoke = /\$vs\.proc\.invoke\s*\(\s*(['"])([^'"]+)\1\s*,\s*(['"])([A-Za-z_]\w*)\3/g;
    for (const match of source.matchAll(invoke)) {
      const methodStart = match.index + match[0].lastIndexOf(match[4]);
      if (offset >= methodStart && offset <= methodStart + match[4].length) {
        return { procedureKeyword: match[2], funId: match[4] };
      }
    }

    const before = source.slice(0, offset);
    const call = before.match(/\$([A-Za-z_]\w*)\.\s*$/);
    if (!call) {
      return null;
    }
    const word = source.slice(offset).match(/^[A-Za-z_]\w*/)?.[0];
    if (!word) {
      return null;
    }
    const variable = call[1];
    const binding = new RegExp(
      `#set\\s*\\(\\s*\\$${variable}\\s*=\\s*\\$vs\\.proc\\.find\\s*\\(\\s*(['"])([^'"]+)\\1`,
      "g"
    );
    let procedureKeyword = "";
    for (const match of before.matchAll(binding)) {
      procedureKeyword = match[2];
    }
    return procedureKeyword ? { procedureKeyword, funId: word } : null;
  }

  function resolveProcedureDefinitionTarget(source, offset) {
    if (typeof source !== "string" || !Number.isInteger(offset)) {
      return null;
    }
    const definition = /\bfunction\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g;
    for (const match of source.matchAll(definition)) {
      const fullName = match[1];
      const start = match.index + match[0].indexOf(fullName);
      if (offset < start || offset > start + fullName.length) {
        continue;
      }
      const separator = fullName.lastIndexOf(".");
      return {
        procedureKeyword: fullName.slice(0, separator),
        funId: fullName.slice(separator + 1)
      };
    }
    return null;
  }

  function resolveProcedureDefinitionText(text) {
    const match = String(text || "").match(
      /\bfunction\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\(/
    );
    if (!match) {
      return null;
    }
    const separator = match[1].lastIndexOf(".");
    return {
      procedureKeyword: match[1].slice(0, separator),
      funId: match[1].slice(separator + 1)
    };
  }

  function resolveLocalFunctionTarget(source, offset) {
    if (typeof source !== "string" || !Number.isInteger(offset) || source[offset - 1] !== "@") {
      return null;
    }
    const funId = source.slice(offset).match(/^[A-Za-z_]\w*/)?.[0];
    const definition = funId && new RegExp(`^[\\t ]*#function\\s+${funId}\\s*\\(`, "m").exec(source);
    return definition ? {
      funId,
      lineNumber: source.slice(0, definition.index).split(/\r?\n/).length
    } : null;
  }

  function getProcedureTargetAtPosition(editor, position) {
    const model = editor.getModel?.();
    const word = model?.getWordAtPosition?.(position);
    if (!model || !word) {
      return null;
    }
    const offset = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.startColumn });
    const local = resolveLocalFunctionTarget(model.getValue(), offset);
    if (local) {
      return { local, word, lineNumber: position.lineNumber };
    }
    const definition = resolveProcedureDefinitionTarget(model.getValue(), offset);
    if (definition) {
      return { definition: true, target: definition, word, lineNumber: position.lineNumber };
    }
    const target = resolveProcedureTarget(model.getValue(), offset);
    return target ? { target, word, lineNumber: position.lineNumber } : null;
  }

  function findProcedureDevelopVm() {
    return Array.from(document.querySelectorAll("*")).flatMap((element) => {
      const vm = getVueInstance(element);
      return [vm, vm?._vnode?.componentInstance];
    }).find(
      (vm) => vm?.$options?.name === "gdpaas_dev_procedure_develop" && typeof vm.onOpenPage === "function"
    );
  }

  function findVueRouter() {
    return Array.from(document.querySelectorAll("*")).map(getVueInstance).find((vm) => vm?.$router)?.$router;
  }

  async function openProcedureInVm(developVm, target) {
    const tabId = `${target.procedureId}@${target.funId}`;
    developVm.dataSourceId = target.dataSourceId;
    let treeNode = developVm.getScriptTreeNode?.(target.procedureId, target.funId);
    const openNode = treeNode || developVm.parseProcFunInfo?.(
      { procedureId: target.procedureId, procedureAliasId: target.procedureName },
      { ...target.fun, procedureId: target.procedureId, funId: target.funId }
    );
    if (!openNode) {
      throw new Error(`无法构造过程函数节点: ${target.procedureName}.${target.funId}`);
    }
    developVm.handleNodeClick(openNode);
    if (!developVm.openTabs?.some((tab) => tab.id === tabId)) {
      throw new Error(`打开过程函数失败: ${target.procedureName}.${target.funId}`);
    }
    if (!treeNode) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("过程树加载超时")), 8000);
        developVm.loadProcTree(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      treeNode = developVm.getScriptTreeNode?.(target.procedureId, target.funId);
    }
    if (!treeNode) {
      throw new Error(`过程树中未找到函数: ${target.procedureName}.${target.funId}`);
    }
    treeNode.dataSourceId = target.dataSourceId;
    if (treeNode !== openNode) {
      developVm.handleNodeClick(treeNode);
    }
    developVm.toLocation?.(treeNode);
    setTimeout(() => {
      developVm.$refs?.tree?.$el?.querySelector(".el-tree-node.is-current")?.scrollIntoView?.({ block: "center", inline: "nearest" });
    });
  }

  async function openProcedureTarget(target) {
    let developVm = findProcedureDevelopVm();
    const routed = !developVm;
    if (!developVm) {
      const router = findVueRouter();
      if (!router) {
        throw new Error("未找到谷神页面路由");
      }
      try {
        await router.push({ name: "gdpaas_dev_procedure_develop" });
      } catch (error) {
        if (!/redundant|duplicated/i.test(error?.message || "")) {
          throw error;
        }
      }
      const deadline = Date.now() + 8000;
      while ((!developVm || !developVm.datasources?.length) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        developVm = findProcedureDevelopVm();
      }
    }
    if (!developVm || (routed && !developVm.datasources?.length)) {
      throw new Error("过程函数页面加载超时");
    }
    await openProcedureInVm(developVm, target);
  }

  async function navigateToProcedure(target, editorElement) {
    const searchResult = await postForm("/develop/procedure/admin/search.htm", { keyword: target.funId });
    if (searchResult.code && searchResult.code !== 0) {
      throw new Error(searchResult.message || "搜索过程函数失败");
    }
    const procedure = resolveProcedure(searchResult, target.procedureKeyword, target.funId, true);
    if (!procedure.dataSourceId) {
      throw new Error(`未解析到过程函数数据源: ${target.procedureKeyword}.${target.funId}`);
    }
    minimizeScriptEditor(editorElement);
    await openProcedureTarget({ ...procedure, funId: target.funId });
  }

  function requestProcedureCallers(target) {
    const key = `${target.procedureKeyword}.${target.funId}`;
    if (lastCallersRequest === key) {
      return;
    }
    lastCallersRequest = key;
    setTimeout(() => {
      if (lastCallersRequest === key) {
        lastCallersRequest = "";
      }
    }, 500);
    window.postMessage(
      {
        source: "guthon-page-bridge",
        event: "procedure-callers-request",
        data: target
      },
      "*"
    );
  }

  async function openProcedureCaller(payload) {
    await navigateToProcedure(
      {
        procedureKeyword: payload.source_alias_id,
        funId: payload.fun_id
      },
      null
    );
  }

  async function openModuleCaller(payload) {
    const router = findVueRouter();
    if (!router) {
      throw new Error("未找到谷神页面路由");
    }
    try {
      await router.push({ name: "gdpaas_dev_modules" });
    } catch (error) {
      if (!/redundant|duplicated/i.test(error?.message || "")) {
        throw error;
      }
    }
    const labels = [payload.source_id, payload.source_alias_id, payload.source_name]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const pageTab = document.getElementById(`tab-${payload.source_id}`);
      if (pageTab) {
        pageTab.click();
        return;
      }
      const instances = Array.from(document.querySelectorAll("*")).map(getVueInstance).filter(Boolean);
      const treeVm = instances.find((vm) => Array.isArray(vm.modules));
      const developVm = instances.find(
        (vm) => vm?.$options?.name === "gdpaas_dev_modules" && typeof vm.onOpenPage === "function"
      ) || (typeof treeVm?.$parent?.onOpenPage === "function" ? treeVm.$parent : null);
      let page;
      walk(treeVm?.modules, (item) => {
        if (String(item.pageId || "") === String(payload.source_id || "")) {
          page = item;
          return false;
        }
        return undefined;
      });
      if (developVm && page) {
        await Promise.resolve(developVm.onOpenPage(page));
        return;
      }
      const treeItem = Array.from(
        document.querySelectorAll(".el-tree-node__content, [role='treeitem']")
      ).find((element) => {
        const text = String(element.innerText || element.textContent || "").trim();
        return labels.some((label) => text === label || text.includes(label));
      });
      if (treeItem) {
        treeItem.click();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("已打开模块开发，但未找到调用页面");
  }

  const navigationEditors = new WeakSet();
  const navigationDisposables = [];
  const navigationDecorations = new Map();
  let navigationBusy = false;
  let minimizedScriptEditor = null;
  let suppressContextMenuUntil = 0;
  let lastCallersRequest = "";
  let procedureTitleLink = null;
  const procedureTitleHighlight = "guthon-procedure-title-link";

  function setProcedureLink(editor, hit) {
    if (!editor?.deltaDecorations) {
      return;
    }
    const decorations = hit ? [{
      range: {
        startLineNumber: hit.lineNumber,
        startColumn: hit.word.startColumn,
        endLineNumber: hit.lineNumber,
        endColumn: hit.word.endColumn
      },
      options: { inlineClassName: "guthon-procedure-link" }
    }] : [];
    navigationDecorations.set(editor, editor.deltaDecorations(navigationDecorations.get(editor) || [], decorations));
  }

  function clearProcedureLinks() {
    navigationDecorations.forEach((_decorations, editor) => setProcedureLink(editor, null));
  }

  function isProcedureNavigationModifier(event) {
    return Boolean(/Mac|iPhone|iPad|iPod/.test(window.navigator?.platform || "")
      ? event?.metaKey
      : event?.ctrlKey);
  }

  function minimizeScriptEditor(element) {
    const wrapper = element?.closest?.(".el-dialog__wrapper");
    if (!wrapper || minimizedScriptEditor?.wrapper === wrapper) {
      return;
    }
    const editorVm = getVueInstance(element);
    const editor = editorVm?.editor || editorVm?.$refs?.editor?.editor;
    let component = getVueInstance(wrapper);
    let owner;
    let buttonSetup;
    while (component) {
      if (!owner && typeof component.showScriptEditPage === "function") {
        owner = component;
      }
      if (!buttonSetup && component.$options?.name === "gd-button-setup") {
        buttonSetup = component;
      }
      component = component.$parent;
    }
    const scriptKey = owner?.script
      ? `${owner.script.id}:${owner.script.scriptItem?.name}`
      : "";
    if (!editor?.getValue || (!scriptKey && !buttonSetup)) {
      return;
    }
    const mask = Array.from(document.querySelectorAll(".v-modal")).find(
      (item) => item.offsetWidth || item.offsetHeight || item.getClientRects?.().length
    );
    const bar = document.createElement("div");
    bar.className = "guthon-minimized-script-bar";
    bar.textContent = "双击还原模块开发编辑器";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "guthon-minimized-script-close";
    closeButton.title = "关闭编辑器";
    closeButton.setAttribute("aria-label", "关闭编辑器");
    closeButton.textContent = "×";
    bar.appendChild(closeButton);
    const sourceDialog = buttonSetup?.$refs?.editor || owner?.$refs?.scriptEditPage?.$refs?.editor;
    const finish = () => {
      Array.from(document.querySelectorAll(".guthon-minimized-script-mask"))
        .forEach((item) => item.classList.remove("guthon-minimized-script-mask"));
      wrapper.classList.remove("guthon-minimized-script-editor");
      bar.remove();
      minimizedScriptEditor = null;
    };
    const restore = async (event) => {
      if (event?.target?.closest?.("button")) {
        return;
      }
      event?.preventDefault?.();
      event?.stopPropagation?.();
      const router = findVueRouter();
      if (!router) {
        return;
      }
      try {
        await router.push({ name: "gdpaas_dev_modules" });
      } catch (error) {
        if (!/redundant|duplicated/i.test(error?.message || "")) {
          return;
        }
      }
      const deadline = Date.now() + 8000;
      let opener;
      if (buttonSetup) {
        while (!wrapper.isConnected && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        wrapper.classList.remove("guthon-minimized-script-editor");
      } else {
        while (!opener && Date.now() < deadline) {
          opener = Array.from(document.querySelectorAll("*")).map(getVueInstance).find((vm) =>
            typeof vm?.showScriptEditPage === "function"
            && vm.script
            && `${vm.script.id}:${vm.script.scriptItem?.name}` === scriptKey
          );
          if (!opener) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        if (!opener) {
          return;
        }
      }
      const inputDialog = buttonSetup?.$refs?.editor || opener.$refs?.scriptEditPage?.$refs?.editor;
      if (inputDialog?.isDialogShow) {
        inputDialog.isDialogShow = false;
        await new Promise((resolve) => {
          const vm = buttonSetup || opener;
          if (typeof vm.$nextTick === "function") {
            vm.$nextTick(resolve);
          } else {
            setTimeout(resolve);
          }
        });
      }
      if (buttonSetup) {
        inputDialog?.show?.();
      } else {
        opener.showScriptEditPage();
      }
      if (buttonSetup && !minimizedScriptEditor.editorWasVisible) {
        finish();
        return;
      }
      let restoredEditor;
      while (!restoredEditor && Date.now() < deadline) {
        const restoredElements = buttonSetup
          ? wrapper.querySelectorAll(".script-editor")
          : document.querySelectorAll(".el-dialog__wrapper .script-editor");
        const restoredElement = Array.from(restoredElements).find(
          (item) => item.offsetWidth || item.offsetHeight || item.getClientRects?.().length
        );
        const vm = getVueInstance(restoredElement);
        restoredEditor = vm?.editor || vm?.$refs?.editor?.editor;
        if (!restoredEditor) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (!restoredEditor) {
        return;
      }
      if (restoredEditor.getValue() !== minimizedScriptEditor.text) {
        restoredEditor.setValue(minimizedScriptEditor.text);
      }
      restoredEditor.layout?.();
      finish();
    };
    closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      sourceDialog?.close?.();
      finish();
    });
    bar.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) {
        return;
      }
      const rect = bar.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      bar.style.left = `${rect.left}px`;
      bar.style.top = `${rect.top}px`;
      bar.style.transform = "none";
      const move = (moveEvent) => {
        bar.style.left = `${Math.max(8, Math.min(window.innerWidth - rect.width - 8, moveEvent.clientX - offsetX))}px`;
        bar.style.top = `${Math.max(8, Math.min(window.innerHeight - rect.height - 8, moveEvent.clientY - offsetY))}px`;
      };
      const stop = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", stop);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", stop);
      event.preventDefault();
    });
    wrapper.classList.add("guthon-minimized-script-editor");
    mask?.classList.add("guthon-minimized-script-mask");
    bar.addEventListener("dblclick", restore);
    document.body.appendChild(bar);
    minimizedScriptEditor = {
      wrapper,
      mask,
      bar,
      restore,
      scriptKey,
      text: editor.getValue(),
      editorWasVisible: Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects?.().length)
    };
  }

  function installScriptEditorMinimizeButtons() {
    Array.from(document.querySelectorAll(".el-dialog__wrapper.gd-script-dialog")).forEach((wrapper) => {
      const header = wrapper.querySelector(":scope > .el-dialog > .el-dialog__header");
      if (!header) {
        return;
      }
      let button = header.querySelector(".guthon-script-editor-minimize");
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "el-dialog__headerbtn guthon-script-editor-minimize";
        button.title = "缩小编辑器";
        button.setAttribute("aria-label", "缩小编辑器");
        const icon = document.createElement("i");
        icon.className = "el-dialog__close el-icon el-icon-minus";
        button.appendChild(icon);
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const editors = Array.from(wrapper.querySelectorAll(".script-editor"));
          const editor = editors.find(isVisible) || editors[0];
          if (editor) {
            minimizeScriptEditor(editor);
          }
        });
        header.appendChild(button);
      }
    });
  }

  function onNavigationKeyUp(event) {
    if (event.key === "Control" || event.key === "Meta") {
      clearProcedureLinks();
      highlightProcedureTitle(null);
    }
  }

  function onContextMenu(event) {
    if (Date.now() > suppressContextMenuUntil) {
      return;
    }
    suppressContextMenuUntil = 0;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onProcedureTitleClick(event) {
    if (
      event.button !== 0
      || !isProcedureNavigationModifier(event)
      || !event.target?.closest?.(".script-editor, .monaco-editor, .gd-function-head, .function.head")
    ) {
      return;
    }
    const line = event.target.closest(
      ".sticky-widget, .sticky-line-content, .monaco-sticky-scroll, .view-line, .gd-function-head, .function.head"
    );
    const target = resolveProcedureDefinitionText(line?.innerText || line?.textContent || "");
    if (!target) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    requestProcedureCallers(target);
  }

  function onProcedureTitleMove(event) {
    const line = isProcedureNavigationModifier(event)
      && event.target?.closest?.(".script-editor, .monaco-editor, .gd-function-head, .function.head")
      && event.target.closest(
        ".sticky-widget, .sticky-line-content, .monaco-sticky-scroll, .view-line, .gd-function-head, .function.head"
      );
    const next = line && resolveProcedureDefinitionText(line.innerText || line.textContent || "") ? line : null;
    highlightProcedureTitle(next);
  }

  function highlightProcedureTitle(line) {
    if (line === procedureTitleLink) {
      return;
    }
    procedureTitleLink?.classList.remove("guthon-procedure-title-cursor");
    CSS.highlights?.delete(procedureTitleHighlight);
    procedureTitleLink = line;
    const match = String(line?.textContent || line?.innerText || "").match(
      /\bfunction\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\(/
    );
    if (!match || !CSS.highlights || typeof Highlight !== "function") {
      return;
    }
    const start = match.index + match[0].indexOf(match[1]);
    const end = start + match[1].length;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let offset = 0;
    let node;
    let started = false;
    while ((node = walker.nextNode())) {
      const nextOffset = offset + node.textContent.length;
      if (!started && start >= offset && start < nextOffset) {
        range.setStart(node, start - offset);
        started = true;
      }
      if (started && end > offset && end <= nextOffset) {
        range.setEnd(node, end - offset);
        CSS.highlights.set(procedureTitleHighlight, new Highlight(range));
        line.classList.add("guthon-procedure-title-cursor");
        return;
      }
      offset = nextOffset;
    }
  }

  function installProcedureNavigation() {
    Array.from(document.querySelectorAll(".script-editor")).forEach((element) => {
      const vm = getVueInstance(element);
      [vm?.editor || vm?.$refs?.editor?.editor, vm?.viewer].filter(Boolean).forEach((editor) => {
        if (!editor?.onMouseDown || navigationEditors.has(editor)) {
          return;
        }
        navigationEditors.add(editor);
        navigationDisposables.push(editor.onMouseMove?.((event) => {
          const browserEvent = event.event?.browserEvent;
          const hit = isProcedureNavigationModifier(browserEvent) && event.target?.position
            ? getProcedureTargetAtPosition(editor, event.target.position)
            : null;
          setProcedureLink(editor, hit);
        }));
        navigationDisposables.push(editor.onMouseLeave?.(() => setProcedureLink(editor, null)));
        navigationDisposables.push(editor.onMouseDown(async (event) => {
          const browserEvent = event.event?.browserEvent;
          const position = event.target?.position;
          if (!isProcedureNavigationModifier(browserEvent) || browserEvent.button !== 0 || !position || navigationBusy) {
            return;
          }
          const hit = getProcedureTargetAtPosition(editor, position);
          if (!hit) {
            return;
          }
          browserEvent.preventDefault();
          browserEvent.stopPropagation();
          suppressContextMenuUntil = Date.now() + 500;
          navigationBusy = true;
          try {
            if (hit.local) {
              editor.setPosition?.({ lineNumber: hit.local.lineNumber, column: 1 });
              editor.revealLineInCenter?.(hit.local.lineNumber);
              editor.focus?.();
            } else if (hit.definition) {
              requestProcedureCallers(hit.target);
            } else {
              await navigateToProcedure(hit.target, element);
            }
          } catch {
            // 跳转结果由平台页面本身体现，不占用源码拉取提示区域。
          } finally {
            navigationBusy = false;
          }
        }));
      });
    });
    installScriptEditorMinimizeButtons();
  }

  let copiedFields = null;

  function findFieldsMoverContext() {
    const selected = Array.from(document.querySelectorAll(".base-control-box.row-box.selected"));
    if (selected.length !== 1) {
      throw new Error(selected.length ? "请只选中一个组件" : "请先选中组件");
    }
    for (const [selector, fieldsKey] of [[".input-box", "fields"], [".coust-table", "columns"]]) {
      const host = selected[0].querySelector(selector);
      const vue = host && [host, ...host.querySelectorAll("*")]
        .map(getVueInstance)
        .find((item) => Array.isArray(item?.[fieldsKey]));
      if (vue) return { fields: vue[fieldsKey] };
    }
    throw new Error("当前组件不支持字段平移");
  }

  function getFieldsMoverLabel(field, index) {
    return field?.label || field?.name || field?.title || field?.fieldName || field?.fieldId || `字段 ${index + 1}`;
  }

  function readFieldsMoverSource() {
    return findFieldsMoverContext().fields.map((field, index) => ({ index, label: getFieldsMoverLabel(field, index), fieldId: field?.fieldId || "" }));
  }

  function copyFieldsMoverSource(payload) {
    const fields = findFieldsMoverContext().fields;
    const indexes = Array.isArray(payload?.indexes) ? payload.indexes : [];
    const chosen = indexes.map(Number).filter((index) => Number.isInteger(index) && fields[index]);
    if (!chosen.length) throw new Error("请至少选择一个字段");
    copiedFields = window.GuthonFieldsMoverCore.cloneFields(chosen.map((index) => fields[index]));
    return { copied: copiedFields.length };
  }

  function pasteFieldsMoverSource() {
    if (!copiedFields?.length) throw new Error("没有已复制的字段");
    const fields = findFieldsMoverContext().fields;
    const result = window.GuthonFieldsMoverCore.planAppendFields(fields, window.GuthonFieldsMoverCore.cloneFields(copiedFields));
    fields.push(...result.toAppend);
    return { pasted: result.toAppend.length, duplicate: result.skippedDuplicate.length, invalid: result.skippedInvalid.length };
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

  function isDataTableManagementPage() {
    if (location.href.includes("/gdpaas/dev/table") || location.href.includes("/basesetup/table")) {
      return true;
    }
    return Array.from(document.querySelectorAll('[aria-selected="true"], .is-active, .active'))
      .some((node) => String(node.innerText || node.textContent || "").includes("数据表管理"));
  }

  function isBillTypePage() {
    return Array.from(document.querySelectorAll('[aria-selected="true"], .is-active, .active'))
      .some((node) => /^单据类型/.test(String(node.innerText || node.textContent || "").trim()));
  }

  function isViewManagementPage() {
    return location.href.includes("/gdpaas/sys/views") || Array.from(document.querySelectorAll('[aria-selected="true"], .is-active, .active'))
      .some((node) => /^视图管理/.test(String(node.innerText || node.textContent || "").trim()));
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

  function getSelectedViewIds() {
    const ids = [];
    Array.from(document.querySelectorAll("body *")).forEach((element) => {
      if (!isVisible(element) || !isSelectedTableElement(element)) {
        return;
      }
      const row = element.closest("tr");
      const viewId = String(row?.innerText || row?.textContent || element.innerText || element.textContent || "")
        .match(/\bV_[A-Z0-9_]+\b/)?.[0];
      if (viewId && !ids.includes(viewId)) {
        ids.push(viewId);
      }
    });
    return ids;
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

  function inspectCurrentPageSource() {
    const selectedTab = getSelectedTabInfo();
    const sourceName = String(selectedTab?.label || "").trim() || "源码片段";
    const candidates = [];
    for (const vm of getAllVueInstances()) {
      if (vm.fun || vm.localFun) {
        continue;
      }
      const pageId = findDeepFirst(vm, ["pageId"]);
      if (!pageId) {
        continue;
      }
      const pageVersion = findDeepFirst(vm, ["pageVersion", "versionMac", "version"]) || "";
      const pageName = findDeepFirst(vm, ["pageName", "pageTitle", "title", "label", "name"]) || "";
      const script =
        pickFirst(vm.form, ["xml", "script", "content", "source", "pageModuleXml", "moduleXml"]) ||
        findDeepFirst(vm, ["pageModuleXml", "moduleXml", "xml", "script", "content", "source"]) ||
        "";
      candidates.push({
        mode: "page-source",
        pageId: String(pageId),
        pageVersion: String(pageVersion),
        procedureId: String(pageId),
        procedureName: String(pageName || pageId),
        procedureKeyword: String(pageName || pageId),
        fullName: String(pageName || pageId),
        funId: sourceName,
        script: String(script),
        sourceName,
        resolvedBy: "page-source"
      });
    }
    const current = candidates.find((item) => item.script) || candidates[0];
    if (current) {
      return current;
    }
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

  function inspectViewTarget() {
    const dataSourceId = getDataSourceId();
    if (!dataSourceId) {
      throw new Error("当前视图管理页面没有识别到数据源");
    }
    return {
      dataSourceId,
      dataSourceName: getDataSourceName(),
      viewIds: getSelectedViewIds(),
      resolvedBy: "view-management"
    };
  }

  function inspectCurrentHubSource() {
    if (isViewManagementPage()) {
      return { mode: "views", ...inspectViewTarget() };
    }
    if (isBillTypePage()) {
      return { mode: "billtype", ...inspectBillTypeTarget() };
    }
    if (isDataTableManagementPage()) {
      return { mode: "table-schema", ...inspectTableSchemaTarget() };
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
    return inspectCurrentProcedure();
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

  function collectHiddenFieldIds(root) {
    const hiddenFields = new Set();
    const selector = ".input-hide-area, .hide-field-list";
    const areas = (root.matches?.(selector) ? [root] : []).concat(Array.from(root.querySelectorAll(selector)));
    areas.forEach((area) => {
      Array.from(area.querySelectorAll("*")).forEach((node) => {
        const ownText = Array.from(node.childNodes)
          .filter((child) => child.nodeType === Node.TEXT_NODE)
          .map((child) => child.textContent)
          .join(" ");
        const text = [
          node.getAttribute?.("data-field"),
          node.getAttribute?.("data-field-id"),
          node.getAttribute?.("prop"),
          node.getAttribute?.("title"),
          ownText
        ].filter(Boolean).join(" ");
        const normalized = String(text).replace(/\s+/g, " ").trim();
        if (normalized) {
          hiddenFields.add(normalized);
        }
        normalized.match(/[A-Za-z0-9_]{2,}/g)?.forEach((token) => hiddenFields.add(token));
      });
    });
    return hiddenFields;
  }

  function isDomHiddenField(info, hiddenFields) {
    return Array.from(hiddenFields).some((value) => value === info.field || value === info.label || value.includes(info.field) || value.includes(info.label));
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
    const configuredHidden =
      isTruthy(hiddenValue) || (hiddenValue !== undefined && hiddenValue !== "" && isFalsy(hiddenValue));
    const info = {
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
      hidden: extra.hidden ? isDomHiddenField({ field, label }, extra.hiddenFields || new Set()) : configuredHidden,
      index: 0
    };
    return info;
  }

  function collectControlFields(root, options = {}, maps, hiddenFields = collectHiddenFieldIds(root)) {
    const fields = [];
    const selector = "[data-control-name], .input-box, .data-table, .data-table-control, .detail-table, .el-table";
    const controls = (root.matches?.(selector) ? [root] : []).concat(Array.from(root.querySelectorAll(selector)));
    controls.forEach((element) => {
      if (!options.includeHiddenControls && !isVisible(element)) {
        return;
      }
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
            const info = makeFieldInfo(item, maps, { hidden, hiddenFields });
            if (info && hidden && !isDomHiddenField(info, hiddenFields)) {
              return;
            }
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
    const rootHiddenFields = collectHiddenFieldIds(root);
    const candidates = (root.matches?.(selector) ? [root] : []).concat(Array.from(root.querySelectorAll(selector)));
    candidates.forEach((element, index) => {
      if (!options.includeHiddenControls && !isVisible(element)) {
        return;
      }
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
      const groupHiddenFields = collectHiddenFieldIds(groupElement);
      const fields = dedupeFields(collectControlFields(groupElement, { includeHiddenControls: options.includeHiddenControls }, maps, groupHiddenFields.size ? groupHiddenFields : rootHiddenFields));
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
    if (selected?.id) {
      return selected.id.replace(/^tab-/, "");
    }
    return getPageCodeFromVue() || getPageCodeFromUrl();
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
      const paneGroups = collectControlGroups(pane, { includeHiddenControls: true }, maps);
      paneGroups.forEach((group) => {
        groups.push({
          title: getControlTitle(getTabPageLabel(pane, index), pane, group.controlName),
          fields: group.fields
        });
      });
      if (!paneGroups.length) {
        const fields = dedupeFields(collectControlFields(pane, { includeHiddenControls: true }, maps));
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
    const label = String(selectedTab.innerText || selectedTab.textContent || "").trim();
    const controlsId = selectedTab.getAttribute("aria-controls") || selectedTab.getAttribute("aria-owns") || "";
    const panel =
      (controlsId && document.getElementById(controlsId)) ||
      (selectedTab.id && document.querySelector(`[role="tabpanel"][aria-labelledby="${selectedTab.id}"]`)) ||
      null;
    const tabId = String(selectedTab.id || "").replace(/^tab-/, "");
    const separator = tabId.lastIndexOf("@");
    return {
      label,
      panel,
      procedureId: separator > 0 ? tabId.slice(0, separator) : "",
      funId: separator > 0 ? tabId.slice(separator + 1) : label
    };
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
      const node = typeof candidate === "string" ? document.querySelector(candidate) : candidate;
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

  function inspectCurrentProcedure() {
    const selectedTab = getSelectedTabInfo();
    const selectedFunId = String(selectedTab?.funId || selectedTab?.label || "").trim();
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
        procedureId: fun?.procedureId || (funId === selectedFunId ? selectedTab?.procedureId : ""),
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
        procedureId: selectedTab?.procedureId || "",
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

    if (selectedTab?.procedureId && selectedFunId) {
      return {
        procedureId: selectedTab.procedureId,
        procedureName: "",
        procedureKeyword: "",
        fullName: "",
        funId: selectedFunId,
        script: "",
        flag: 0,
        versionMac: "",
        resolvedBy: "selected-tab-id"
      };
    }

    if (titleInfo) {
      return {
        procedureId: "",
        procedureName: titleInfo.procedureKeyword,
        procedureKeyword: titleInfo.procedureKeyword,
        fullName: titleInfo.fullName,
        funId: titleInfo.funId,
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

  function resolveProcedure(searchResult, procedureKeyword, funId, strict = false) {
    const matches = collectMatches(searchResult, funId);
    const packageLower = String(procedureKeyword || "").toLowerCase();
    const exactFun = matches.find((item) => {
      const joined = Object.values(item)
        .filter((value) => typeof value === "string")
        .join(" ")
        .toLowerCase();
      return String(item.funId || "").toLowerCase() === String(funId || "").toLowerCase()
        && joined.includes(packageLower);
    });
    const exact = exactFun || matches.find((item) => Object.values(item)
      .filter((value) => typeof value === "string")
      .join(" ")
      .toLowerCase()
      .includes(packageLower));
    const chosen = exact || (!strict && matches[0]);
    if (!chosen) {
      throw new Error(`未找到过程函数: ${procedureKeyword}.${funId}`);
    }
    const procedureId = pickFirst(chosen, ["procedureId", "procId", "id", "value"]);
    if (!procedureId) {
      throw new Error(`已找到候选项，但无法解析过程函数编码：${procedureKeyword}.${funId}`);
    }
    return {
      procedureId,
      dataSourceId: pickFirst(chosen, ["dataSourceId", "datasourceId", "data_source_id"]),
      fun: chosen,
      procedureName:
        pickFirst(chosen, [
          "procedureName",
          "procedureAliasId",
          "fullName",
          "className",
          "procName",
          "name",
          "label"
        ]) || procedureKeyword
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

  async function pullCurrentProcedure(payload) {
    const pulled = await pullProcedure(payload);
    return {
      procedureId: pulled.procedureId,
      procedureName: pulled.procedureName,
      funId: payload.funId,
      script: pulled.script,
      flag: pulled.flag ?? 0,
      versionMac: pulled.versionMac || "",
      resolvedBy: `${pulled.resolvedBy || "unknown"}+read`
    };
  }

  async function pullPageSource() {
    const current = inspectCurrentPageSource();
    if (!current?.pageId) {
      throw new Error("当前页面没有识别到模块源码片段");
    }
    const refreshed = await postForm("/develop/dev/pages/getPageModuleXml.htm", {
      pageId: current.pageId
    });
    if (refreshed.code && refreshed.code !== 0) {
      throw new Error(refreshed.message || "读取页面源码失败");
    }
    return {
      ...current,
      script:
        findDeepFirst(refreshed, ["pageModuleXml", "moduleXml", "xml", "content", "source"]) ||
        current.script ||
        "",
      pageVersion: String(
        findDeepFirst(refreshed, ["pageVersion", "versionMac", "version"]) ||
        current.pageVersion ||
        ""
      ),
      resolvedBy: `${current.resolvedBy || "page-source"}+read`
    };
  }

  function inspectCurrent() {
    return location.href.includes("/gdpaas/dev/modules")
      ? inspectCurrentPageSource()
      : inspectCurrentProcedure();
  }

  async function disabledWriteCommand() {
    throw new Error("本插件已屏蔽签出和回推功能");
  }

  function pingPageBridge() {
    return { ready: window.__guthonPageBridgeReady, fieldsMover: Boolean(window.GuthonFieldsMoverCore) };
  }

  const handlers = {
    pingPageBridge,
    inspectCurrentProcedure,
    pullProcedure,
    collectModuleCopyText,
    readFieldsMoverSource,
    copyFieldsMoverSource,
    pasteFieldsMoverSource,
    inspectCurrentPageSource,
    inspectTableSchemaTarget,
    inspectBillTypeTarget,
    inspectViewTarget,
    "inspect-current": inspectCurrent,
    "inspect-hub-source": inspectCurrentHubSource,
    "pull": pullCurrentProcedure,
    "pull-page-source": pullPageSource,
    "open-procedure-caller": openProcedureCaller,
    "open-module-caller": openModuleCaller,
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
  document.addEventListener("contextmenu", onContextMenu, true);
  document.addEventListener("click", onProcedureTitleClick, true);
  document.addEventListener("mousemove", onProcedureTitleMove, true);
  document.addEventListener("keyup", onNavigationKeyUp);
  const navigationStyle = document.createElement("style");
  navigationStyle.textContent = `
    .guthon-procedure-link{color:#409eff!important;cursor:pointer!important}
    ::highlight(guthon-procedure-title-link){color:#409eff}
    .guthon-procedure-title-cursor,.guthon-procedure-title-cursor *{cursor:pointer!important}
    .guthon-minimized-script-mask{display:none!important}
    .guthon-minimized-script-editor{display:none!important}
    .guthon-script-editor-minimize{right:42px!important}
    .guthon-minimized-script-bar{position:fixed;top:12px;left:50%;display:flex;align-items:center;gap:10px;width:auto;max-width:calc(100vw - 32px);height:36px;transform:translateX(-50%);box-sizing:border-box;padding:6px 7px 6px 14px;border:1px solid #409eff;border-radius:4px;background:#fff;color:#409eff;white-space:nowrap;font-size:14px;cursor:move;box-shadow:0 2px 12px rgba(0,0,0,.25);z-index:3000}
    .guthon-minimized-script-close{width:22px;height:22px;padding:0;border:0;border-radius:3px;background:transparent;color:#909399;font-size:20px;line-height:20px;cursor:pointer}
    .guthon-minimized-script-close:hover{background:#f2f6fc;color:#f56c6c}
  `;
  (document.head || document.documentElement).appendChild(navigationStyle);
  const navigationApi = {
    resolveProcedureTarget,
    resolveProcedureDefinitionTarget,
    resolveProcedureDefinitionText,
    resolveLocalFunctionTarget,
    findProcedureDevelopVm,
    isProcedureNavigationModifier,
    minimizeScriptEditor,
    openProcedureInVm,
    openModuleCaller,
    highlightProcedureTitle
  };
  window.GuthonProcedureNavigation = navigationApi;
  installProcedureNavigation();
  const navigationInterval = setInterval(installProcedureNavigation, 1000);
  window.__guthonPageBridgeCleanup = function () {
    window.removeEventListener("message", onMessage);
    document.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("click", onProcedureTitleClick, true);
    document.removeEventListener("mousemove", onProcedureTitleMove, true);
    document.removeEventListener("keyup", onNavigationKeyUp);
    clearInterval(navigationInterval);
    clearProcedureLinks();
    highlightProcedureTitle(null);
    navigationDisposables.forEach((disposable) => disposable?.dispose?.());
    navigationStyle.remove();
    if (window.GuthonProcedureNavigation === navigationApi) {
      delete window.GuthonProcedureNavigation;
    }
  };
  window.__guthonPageBridgeReady = "20260717i";
})();

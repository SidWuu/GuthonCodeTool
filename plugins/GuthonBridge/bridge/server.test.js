const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const MANIFEST_PATH = path.join(__dirname, "workspace", "manifest.json");
const EXTENSION_MANIFEST_PATH = path.join(ROOT, "extension", "manifest.json");
const CONTENT_SCRIPT_PATH = path.join(ROOT, "extension", "content.js");

function waitForHealth(port) {
  const url = `http://127.0.0.1:${port}/health`;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    async function poll() {
      try {
        const response = await fetch(url);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {
        // Retry until timeout.
      }

      if (Date.now() - startedAt > 3000) {
        reject(new Error("Bridge server did not become healthy"));
        return;
      }
      setTimeout(poll, 50);
    }
    poll();
  });
}

test("saveRemoteFile writes directly into the requested absolute output directory", async () => {
  const port = 17461;
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "guthon-bridge-output-"));
  const originalManifest = fs.existsSync(MANIFEST_PATH)
    ? fs.readFileSync(MANIFEST_PATH, "utf8")
    : null;
  const server = spawn(process.execPath, ["bridge/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GUTHON_BRIDGE_PORT: String(port)
    },
    stdio: "ignore"
  });

  try {
    await waitForHealth(port);
    const response = await fetch(`http://127.0.0.1:${port}/saveRemoteFile`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        objectKey: "demo.pkg#doPreRequestScript",
        outputDir,
        content: "function body",
        metadata: {
          extension: "java",
          procedureName: "demo.pkg",
          funId: "doPreRequestScript"
        }
      })
    });

    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.filePath, path.join(outputDir, "doPreRequestScript.java"));
    assert.equal(fs.readFileSync(data.filePath, "utf8"), "function body");
    assert.equal(fs.existsSync(path.join(outputDir, "demo.pkg")), false);
  } finally {
    server.kill();
    if (originalManifest === null) {
      fs.rmSync(MANIFEST_PATH, { force: true });
    } else {
      fs.writeFileSync(MANIFEST_PATH, originalManifest);
    }
  }
});

test("extension manifest injects the floating pull button on Guthon pages", () => {
  const manifest = JSON.parse(fs.readFileSync(EXTENSION_MANIFEST_PATH, "utf8"));

  assert.deepEqual(manifest.permissions.includes("storage"), true);
  assert.deepEqual(manifest.host_permissions.includes("http://*/*"), true);
  assert.deepEqual(manifest.content_scripts, [
    {
      matches: ["http://*/*"],
      js: ["content.js"],
      run_at: "document_idle"
    }
  ]);
  assert.deepEqual(manifest.web_accessible_resources, [
    {
      resources: ["page-bridge.js"],
      matches: ["http://*/*"]
    }
  ]);
});

test("floating pull button stays compact with pull text only", () => {
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");

  assert.equal(contentScript.includes("<button type=\"button\">拉取</button>"), true);
  assert.equal(contentScript.includes("拉取到本地</button>"), false);
  assert.equal(contentScript.includes('button.textContent = "成功";'), true);
  assert.equal(contentScript.includes('button.textContent = "失败";'), true);
});

test("pull button floats over the current Guthon toolbar without changing toolbar layout", () => {
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");

  assert.equal(contentScript.includes("positionBridgeRoot"), true);
  assert.equal(contentScript.includes("installTreeAutoScroll"), true);
  assert.equal(contentScript.includes("scrollIntoView?.({ block: \"center\", inline: \"nearest\" })"), true);
  assert.equal(contentScript.includes(".location-bnt"), true);
  assert.equal(contentScript.includes(".tool-menu.tool-box button"), true);
  assert.equal(contentScript.includes("position: fixed"), true);
  assert.equal(contentScript.includes("guthon-bridge-inline-button"), true);
  assert.equal(contentScript.includes(".function.head"), true);
  assert.equal(contentScript.includes('document.querySelector(".procedure-script-editor")'), false);
});

test("copy mode button and overlay are available on module page editors", () => {
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");
  const renderCopyDataScript = contentScript.slice(
    contentScript.indexOf("function renderCopyData"),
    contentScript.indexOf("async function showCopyOverlay")
  );

  assert.equal(contentScript.includes("复制模式"), true);
  assert.equal(contentScript.includes('runPageCommand("collectModuleCopyText")'), true);
  assert.equal(contentScript.includes("collectModulePageFields"), true);
  assert.equal(contentScript.includes("guthon-bridge-copy-overlay"), true);
  assert.equal(contentScript.includes("当前页面编码"), true);
  assert.equal(contentScript.includes("findCurrentPageToolbar"), true);
  assert.equal(contentScript.includes("collectControlFields"), true);
  assert.equal(contentScript.includes(".el-table"), true);
  assert.equal(contentScript.includes("vm = vm.$parent"), true);
  assert.equal(contentScript.includes('key === "datasource"'), true);
  assert.equal(contentScript.includes("复制模式只支持模块开发页面"), true);
  assert.equal(contentScript.includes("readElementName"), true);
  assert.equal(contentScript.includes("字段: ${field.field"), true);
  assert.equal(contentScript.includes("guthon-bridge-copy-text"), true);
  assert.equal(contentScript.includes("guthon-bridge-field-table"), true);
  assert.equal(contentScript.includes("guthon-bridge-cell-value"), true);
  assert.equal(contentScript.includes("guthon-bridge-copy-minimize"), true);
  assert.equal(contentScript.includes('data-minimized="true"'), true);
  assert.equal(contentScript.includes('minimizeButton.textContent = minimized ? "展开" : "缩小";'), true);
  assert.equal(contentScript.includes("installCopyOverlayInteractions"), true);
  assert.equal(contentScript.includes("guthon-bridge-resize-handle"), true);
  assert.equal(contentScript.includes('cursor: col-resize'), true);
  assert.equal(contentScript.includes('cursor: move'), true);
  assert.equal(contentScript.includes('panel.style.position = "fixed";'), true);
  assert.equal(contentScript.includes("max-width: 1450px"), true);
  assert.equal(contentScript.includes("text-overflow: ellipsis"), true);
  assert.equal(contentScript.includes("white-space: nowrap"), true);
  assert.equal(contentScript.includes("<th>行号</th>"), false);
  assert.equal(contentScript.includes('"字段", "显示名称", "显示类型"'), true);
  assert.equal(contentScript.includes('"查询参数", "必填", "合计", "显示"'), true);
  assert.equal(contentScript.includes("<th>显示宽度</th>"), false);
  assert.equal(contentScript.includes("<th>显示状态</th>"), false);
  assert.equal(contentScript.includes("<th>是否必填</th>"), false);
  assert.equal(contentScript.includes("<th>是否合计</th>"), false);
  assert.equal(contentScript.includes("field.required ? \"* \" : \"\""), false);
  assert.equal(contentScript.includes("renderTableCell(field.selectType)"), true);
  assert.equal(contentScript.includes("renderTableCell(field.valueField)"), true);
  assert.equal(contentScript.includes("renderTableCell(field.otherFill)"), true);
  assert.equal(contentScript.includes("renderTableCell(field.queryParams)"), true);
  const queryParamsIndex = contentScript.indexOf("renderTableCell(field.queryParams)");
  const requiredIndex = contentScript.indexOf('renderTableCell(field.required ? "是" : "否")');
  const sumIndex = contentScript.indexOf('renderTableCell(field.sum ? "是" : "否")');
  const visibleIndex = contentScript.indexOf('renderTableCell(field.hidden ? "否" : "是")');
  assert.equal(queryParamsIndex < requiredIndex && requiredIndex < sumIndex && sumIndex < visibleIndex, true);
  assert.equal(contentScript.includes("数据对齐"), true);
  assert.equal(contentScript.includes("details.open = groupIndex === 0"), true);
  assert.equal(contentScript.includes("textarea.scrollTop = 0;"), true);
  assert.equal(renderCopyDataScript.includes("textarea.focus();"), false);
  assert.equal(contentScript.includes("textarea.select();"), true);
  assert.equal(contentScript.includes("window.__guthonBridgeLoaded"), false);
  assert.equal(contentScript.includes('message?.type !== "show-copy-overlay"'), true);
  assert.equal(contentScript.includes("removeNode(COPY_ROOT_ID);\n      stopExtensionLoops();"), true);

  const pageBridge = fs.readFileSync(path.join(ROOT, "extension", "page-bridge.js"), "utf8");
  assert.equal(pageBridge.includes("collectModuleCopyText"), true);
  assert.equal(pageBridge.includes(".el-table"), true);
  assert.equal(pageBridge.includes("function collectControlGroups"), true);
  assert.equal(pageBridge.includes('root.matches?.(selector) ? [root] : []'), true);
  assert.equal(pageBridge.includes('[role="tabpanel"][id^="pane-PG-"]'), true);
  assert.equal(pageBridge.includes("/(Form|Table)$/"), true);
  assert.equal(pageBridge.includes("getControlTitle"), true);
  assert.equal(pageBridge.includes('return controlName ? `${prefix}.${controlName}` : prefix;'), true);
  assert.equal(pageBridge.includes('element.matches(".input-box")'), true);
  assert.equal(pageBridge.includes('return /(Form)$/i.test(ownName) ? ownName : "form";'), true);
  assert.equal(pageBridge.includes('return /(Table)$/i.test(ownName) ? ownName : "table";'), true);
  assert.equal(pageBridge.includes('? element\n        : element.closest("[data-control-name]")'), true);
  assert.equal(pageBridge.includes("function isControlGroup"), true);
  assert.equal(pageBridge.includes("/^(form|table)$/i.test(controlName)"), true);
  assert.equal(pageBridge.includes("if (!paneGroups.length)"), true);
  assert.equal(pageBridge.includes('`${controlName}|${fields.map((field) => field.field).join(",")}`'), true);
  assert.equal(pageBridge.includes('const groupKind = /form$/i.test(group.title) ? "form" : /table$/i.test(group.title) ? "table" : group.title;'), true);
  assert.equal(pageBridge.includes("const fieldKey = group.fields.map((field) => field.field).join(\",\");"), true);
  assert.equal(pageBridge.includes("`${controlName}|${index}`"), false);
  assert.equal(pageBridge.includes('"[data-control-name], .input-box'), true);
  assert.equal(pageBridge.includes("主表 inputForm"), false);
  assert.equal(pageBridge.includes("detailTable"), false);
  assert.equal(pageBridge.includes("normalizeGroups"), true);
  assert.equal(pageBridge.includes("显示宽度"), true);
  assert.equal(pageBridge.includes("是否必填"), true);
  assert.equal(pageBridge.includes("是否合计"), true);
  assert.equal(pageBridge.includes("数据对齐"), true);
  assert.equal(pageBridge.includes("显示:"), true);
  assert.equal(pageBridge.includes("序号:"), true);
  assert.equal(pageBridge.includes("/develop/basesetup/fieldTemplate/admin/getAllList.htm"), true);
  assert.equal(pageBridge.includes("/develop/basesetup/codes/getCodesTitles.htm"), true);
  assert.equal(pageBridge.includes("/develop/uicomp/getCompNames.htm"), true);
  assert.equal(pageBridge.includes("selectCompId"), true);
  assert.equal(pageBridge.includes("selectBox.codeType"), false);
  assert.equal(contentScript.includes("root.style.zIndex = toolbarZIndex"), true);
  assert.equal(contentScript.includes("2147483646"), false);
});

test("floating pull waits for page bridge injection before posting commands", () => {
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");

  assert.equal(contentScript.includes("function getRuntime()"), true);
  assert.equal(contentScript.includes("globalThis.chrome?.runtime"), true);
  assert.equal(contentScript.includes("async function ensurePageBridge"), true);
  assert.equal(contentScript.includes("try {\n    await ensurePageBridge();"), true);
  assert.equal(contentScript.includes("return { ok: false, message: error?.message || String(error) };"), true);
  assert.equal(contentScript.includes("runtime.getURL(\"page-bridge.js\")"), true);
});

test("popup waits for storage.local output directory persistence", () => {
  const popupScript = fs.readFileSync(path.join(ROOT, "extension", "popup.js"), "utf8");

  assert.equal(popupScript.includes("function isModuleUrl"), true);
  assert.equal(popupScript.includes("打开复制模式"), true);
  assert.equal(popupScript.includes('chrome.tabs.sendMessage(tab.id, { type: "show-copy-overlay" })'), true);
  assert.equal(popupScript.includes("async function persistOutputDir"), true);
  assert.equal(popupScript.includes("await persistOutputDir(outputDir);"), true);
  assert.equal(popupScript.includes('outputDirEl.addEventListener("change", persistCurrentOutputDir);'), true);
  assert.equal(popupScript.includes('outputDirEl.addEventListener("blur", persistCurrentOutputDir);'), true);
});

test("page bridge uses popup-compatible procedure search strategy", () => {
  const pageBridge = fs.readFileSync(path.join(ROOT, "extension", "page-bridge.js"), "utf8");

  assert.equal(pageBridge.includes("keyword: payload.funId"), true);
  assert.equal(pageBridge.includes("resolveProcedure(searchResult, payload.procedureKeyword, payload.funId)"), true);
});

test("floating pull shows a visible diagnostic message", () => {
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");

  assert.equal(contentScript.includes("guthon-bridge-message"), true);
  assert.equal(contentScript.includes("setMessage(root,"), true);
  assert.equal(contentScript.includes("console.error(\"Guthon Bridge pull failed\""), true);
});

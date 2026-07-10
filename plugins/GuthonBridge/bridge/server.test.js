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
const POPUP_HTML_PATH = path.join(ROOT, "extension", "popup.html");
const POPUP_SCRIPT_PATH = path.join(ROOT, "extension", "popup.js");

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

    assert.equal(response.status, 200, data.message);
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

test("pullHubSource delegates structured payload to the configured hub command", async () => {
  const port = 17462;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guthon-hub-command-"));
  const hubScript = path.join(tmp, "fake-hub.js");
  const workCopyPath = path.join(tmp, "work-copy");
  const logPath = path.join(tmp, "pull-log.ndjson");
  fs.writeFileSync(
    hubScript,
    `
process.stdin.setEncoding("utf8");
let raw = "";
process.stdin.on("data", (chunk) => raw += chunk);
process.stdin.on("end", () => {
  const payload = JSON.parse(raw || "{}");
  if (payload.sourceType !== "procedure" || payload.alias !== "demo.pkg" || payload.funId !== "save") {
    process.stderr.write("bad payload");
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ ok: true, workCopyPath: ${JSON.stringify(workCopyPath)} }));
});
`,
    "utf8",
  );
  const server = spawn(process.execPath, ["bridge/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GUTHON_BRIDGE_PORT: String(port),
      GUTHON_HUB_PYTHON: process.execPath,
      GUTHON_HUB_PULL_SCRIPT: hubScript,
      GUTHON_PULL_LOG_PATH: logPath
    },
    stdio: "ignore"
  });

  try {
    await waitForHealth(port);
    const response = await fetch(`http://127.0.0.1:${port}/pullHubSource`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        scope: "project",
        projectId: "demo-project",
        sourceType: "procedure",
        alias: "demo.pkg",
        funId: "save"
      })
    });
    const data = await response.json();

    assert.equal(response.status, 200, data.message);
    assert.equal(data.ok, true);
    assert.equal(data.workCopyPath, workCopyPath);
    const log = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    assert.equal(log.pullType, "source");
    assert.equal(log.trigger, "manual");
    assert.equal(log.ok, true);
    assert.deepEqual(log.summary, {
      sourceType: "procedure",
      sourceId: "",
      alias: "demo.pkg",
      funId: "save",
      pulled: "",
      workCopyPath
    });
  } finally {
    server.kill();
  }
});

test("exportTableSchema delegates data source and table filters to script", async () => {
  const port = 17463;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guthon-schema-command-"));
  const schemaScript = path.join(tmp, "fake-schema.js");
  const logPath = path.join(tmp, "pull-log.ndjson");
  fs.writeFileSync(
    schemaScript,
    `
const args = process.argv.slice(2);
if (!args.includes("--data-source-ids") || !args.includes("0015") || !args.includes("--table-ids") || !args.includes("RM_TEST")) {
  process.stderr.write("bad args: " + args.join(" "));
  process.exit(2);
}
process.stdout.write(JSON.stringify({ ok: true, exported_table_count: 1, outputDir: "/tmp/schema" }));
`,
    "utf8",
  );
  const server = spawn(process.execPath, ["bridge/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GUTHON_BRIDGE_PORT: String(port),
      GUTHON_HUB_PYTHON: process.execPath,
      GUTHON_TABLE_SCHEMA_SCRIPT: schemaScript,
      GUTHON_PULL_LOG_PATH: logPath
    },
    stdio: "ignore"
  });

  try {
    await waitForHealth(port);
    const response = await fetch(`http://127.0.0.1:${port}/exportTableSchema`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        dataSourceId: "0015",
        tableIds: ["RM_TEST"]
      })
    });
    const data = await response.json();

    assert.equal(response.status, 200, data.message);
    assert.equal(data.ok, true);
    assert.equal(data.exported_table_count, 1);
    const log = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    assert.equal(log.pullType, "database");
    assert.equal(log.trigger, "manual");
    assert.equal(log.ok, true);
    assert.deepEqual(log.summary, {
      dataSourceId: "0015",
      tableIds: ["RM_TEST"],
      exported_table_count: 1,
      outputDir: "/tmp/schema"
    });
  } finally {
    server.kill();
  }
});

test("exportBillType delegates to script and writes pull log", async () => {
  const port = 17464;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guthon-billtype-command-"));
  const billTypeScript = path.join(tmp, "fake-billtype.js");
  const logPath = path.join(tmp, "pull-log.ndjson");
  fs.writeFileSync(
    billTypeScript,
    `
const args = process.argv.slice(2);
if (!args.includes("--data-source-ids") || !args.includes("0015,0008")) {
  process.stderr.write("bad args: " + args.join(" "));
  process.exit(2);
}
if (!args.includes("--bill-type-codes") || !args.includes("BT_A,BT_B")) {
  process.stderr.write("bad bill type args: " + args.join(" "));
  process.exit(2);
}
process.stdout.write(JSON.stringify({ ok: true, exported_bill_type_count: 3, outputDir: "/tmp/billtype" }));
`,
    "utf8",
  );
  const server = spawn(process.execPath, ["bridge/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GUTHON_BRIDGE_PORT: String(port),
      GUTHON_HUB_PYTHON: process.execPath,
      GUTHON_BILL_TYPE_SCRIPT: billTypeScript,
      GUTHON_PULL_LOG_PATH: logPath
    },
    stdio: "ignore"
  });

  try {
    await waitForHealth(port);
    const response = await fetch(`http://127.0.0.1:${port}/exportBillType`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        dataSourceIds: ["0015", "0008"],
        billTypeCodes: ["BT_A", "BT_B"]
      })
    });
    const data = await response.json();

    assert.equal(response.status, 200, data.message);
    assert.equal(data.ok, true);
    assert.equal(data.exported_bill_type_count, 3);
    const log = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    assert.equal(log.pullType, "billtype");
    assert.equal(log.trigger, "manual");
    assert.equal(log.ok, true);
    assert.deepEqual(log.summary, {
      dataSourceIds: ["0015", "0008"],
      billTypeCodes: ["BT_A", "BT_B"],
      exported_bill_type_count: 3,
      outputDir: "/tmp/billtype"
    });
  } finally {
    server.kill();
  }
});

test("bridge defaults hub python to repo venv when present", () => {
  const serverScript = fs.readFileSync(path.join(ROOT, "bridge", "server.js"), "utf8");

  assert.equal(serverScript.includes('path.join(ROOT, ".venv", "bin", "python")'), true);
  assert.equal(serverScript.includes("fs.existsSync(DEFAULT_HUB_PYTHON)"), true);
});

test("popup exposes separate page and hub pull actions without hub target input", () => {
  const html = fs.readFileSync(POPUP_HTML_PATH, "utf8");
  const script = fs.readFileSync(POPUP_SCRIPT_PATH, "utf8");
  const runHubPullScript = script.slice(script.indexOf("async function runHubPull"), script.indexOf("pullPageBtn.addEventListener"));

  assert.equal(html.includes("pullPageBtn"), true);
  assert.equal(html.includes("pullHubBtn"), true);
  assert.equal(html.includes("hubTarget"), false);
  assert.equal(script.includes("pull-hub-source"), true);
  assert.equal(script.includes("parseHubTarget"), false);
  assert.equal(script.includes("inspect-hub-source"), true);
  assert.equal(script.includes("function inspectCurrentHubSourceContext"), true);
  assert.equal(script.includes("function inspectTableSchemaTarget"), true);
  assert.equal(script.includes("function getDataSourceName"), true);
  assert.equal(script.includes("function getLabeledSelectValue"), true);
  assert.equal(script.includes("[A-Z][A-Z0-9]+_[A-Z0-9_]"), true);
  assert.equal(script.includes('mode === "table-schema"'), true);
  assert.equal(script.includes('mode === "billtype"'), true);
  assert.equal(script.includes('type: "export-table-schema"'), true);
  assert.equal(script.includes('type: "export-bill-type"'), true);
  assert.equal(script.includes("拉取单据类型"), true);
  assert.equal(runHubPullScript.includes("resolveCurrentTarget"), false);
  assert.equal(html.includes("closeBtn"), true);
  assert.equal(script.includes("window.close()"), true);
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
      resources: ["fields-mover-core.js", "page-bridge.js"],
      matches: ["http://*/*"]
    }
  ]);
});

test("floating procedure button pulls hub source", () => {
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");
  const pullScript = contentScript.slice(
    contentScript.indexOf("async function pullCurrentProcedure"),
    contentScript.indexOf("function removeNode")
  );

  assert.equal(contentScript.includes('makeNativeButton("源码拉取"'), true);
  assert.equal(contentScript.includes("拉取到本地</button>"), false);
  assert.equal(contentScript.includes('button.textContent = "成功";'), true);
  assert.equal(contentScript.includes('button.textContent = "失败";'), true);
  assert.equal(pullScript.includes('type: "pull-hub-source"'), true);
  assert.equal(pullScript.includes('type: "save-pull-result"'), false);
  assert.equal(pullScript.includes('runPageCommand("pullProcedure"'), true);
});

test("data table page exposes table schema export action", () => {
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");
  const backgroundScript = fs.readFileSync(path.join(ROOT, "extension", "background.js"), "utf8");
  const pageBridge = fs.readFileSync(path.join(ROOT, "extension", "page-bridge.js"), "utf8");

  assert.equal(contentScript.includes("拉取表结构"), true);
  assert.equal(contentScript.includes("inspectTableSchemaTarget"), true);
  assert.equal(contentScript.includes('type: "export-table-schema"'), true);
  assert.equal(contentScript.includes("isDataTableRoute"), true);
  assert.equal(contentScript.includes("positionFloatingRoot"), true);
  assert.equal(contentScript.includes('root.style.left = "20px"'), true);
  assert.equal(contentScript.includes('root.style.bottom = "260px"'), true);
  assert.equal(backgroundScript.includes("/exportTableSchema"), true);
  assert.equal(pageBridge.includes("inspectTableSchemaTarget"), true);
  assert.equal(pageBridge.includes("getLabeledSelectValue"), true);
  assert.equal(pageBridge.includes("getSelectedTableIds"), true);
});

test("bill type tab exposes bill type export action", () => {
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");
  const backgroundScript = fs.readFileSync(path.join(ROOT, "extension", "background.js"), "utf8");

  assert.equal(contentScript.includes("拉取单据类型"), true);
  assert.equal(contentScript.includes("isBillTypeRoute"), true);
  assert.equal(contentScript.includes("inspectBillTypeTarget"), true);
  assert.equal(contentScript.includes('type: "export-bill-type"'), true);
  assert.equal(contentScript.includes("billTypeCodes"), true);
  assert.equal(backgroundScript.includes("/exportBillType"), true);
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
  assert.equal(contentScript.includes("字段平移"), true);
  assert.equal(contentScript.includes("复制字段"), true);
  assert.equal(contentScript.includes("粘贴字段"), true);
  assert.equal(contentScript.includes("全选字段"), true);
  assert.equal(contentScript.includes("guthon-bridge-fields-mover-select-all"), true);
  assert.equal(contentScript.includes("item.checked = true"), true);
  assert.equal(contentScript.includes("showFieldsMoverOverlay"), true);
  assert.equal(contentScript.includes("pasteCopiedFields"), true);
  assert.equal(contentScript.includes('runPageCommand("readFieldsMoverSource")'), true);
  assert.equal(contentScript.includes('runPageCommand("copyFieldsMoverSource"'), true);
  assert.equal(contentScript.includes('runPageCommand("pasteFieldsMoverSource")'), true);
  assert.equal(contentScript.indexOf("root.appendChild(sourceButton);") < contentScript.indexOf("root.appendChild(copyButton);"), true);
  assert.equal(contentScript.includes("root.dataset.mode = mode;"), true);
  assert.equal(contentScript.includes('makeNativeButton("复制模式"'), true);
  assert.equal(contentScript.includes("flex-direction: column"), true);
  assert.equal(contentScript.includes("display: inline-flex"), true);
  assert.equal(contentScript.includes("min-width: 108px"), true);
  assert.equal(contentScript.includes("background: #409eff"), true);
  assert.equal(contentScript.includes("bottom: calc(100% + 8px)"), true);
  assert.equal(contentScript.includes("user-select: text"), true);
  assert.equal(contentScript.includes("width: 140px"), true);
  assert.equal(contentScript.includes("word-break: break-all"), true);
  assert.equal(contentScript.includes("installFloatingDrag"), false);
  assert.equal(contentScript.includes("pullCurrentProcedure(root, sourceButton)"), true);
  assert.equal(contentScript.includes('isModuleRoute() ? "inspectCurrentPageSource" : "inspectCurrentProcedure"'), true);
  assert.equal(contentScript.includes('sourceType: target.mode === "page-source" ? "page" : "procedure"'), true);
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
  assert.equal(contentScript.includes("pingPageBridge"), true);
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
  assert.equal(contentScript.includes("guthon-bridge-cell-selected"), true);
  assert.equal(contentScript.includes("installCellSelection"), true);
  assert.equal(contentScript.includes("copySelectedCells"), true);
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
  assert.equal(contentScript.includes("removeNode(COPY_ROOT_ID);\n  installProcedurePullButton();"), true);
  assert.equal(contentScript.includes("removeNode(COPY_ROOT_ID);"), true);
  assert.equal(contentScript.includes("removeNode(SCHEMA_ROOT_ID);"), true);
  assert.equal(contentScript.includes("stopExtensionLoops();"), true);

  const pageBridge = fs.readFileSync(path.join(ROOT, "extension", "page-bridge.js"), "utf8");
  assert.equal(pageBridge.includes("function inspectCurrentPageSource"), true);
  assert.equal(pageBridge.includes('mode: "page-source"'), true);
  assert.equal(pageBridge.includes("collectModuleCopyText"), true);
  assert.equal(pageBridge.includes(".el-table"), true);
  assert.equal(pageBridge.includes("collectHiddenFieldIds"), true);
  assert.equal(pageBridge.includes(".input-hide-area, .hide-field-list"), true);
  assert.equal(pageBridge.includes("vm.hideFields"), true);
  assert.equal(pageBridge.includes('pickFirst(obj, ["hidden", "isHidden", "hide", "isHide", "visible"])'), true);
  assert.equal(pageBridge.includes("isDomHiddenField(info, hiddenFields)"), true);
  assert.equal(pageBridge.includes("value.includes(info.label)"), true);
  assert.equal(pageBridge.includes("collectHiddenFieldIds(groupElement)"), true);
  assert.equal(pageBridge.includes("includeHiddenControls"), true);
  assert.equal(pageBridge.includes("collectHiddenFieldIds(root)"), true);
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
  assert.equal(pageBridge.includes("!options.includeHiddenControls && !isVisible(element)"), true);
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
  assert.equal(contentScript.includes("root.style.zIndex = \"2147483646\""), true);
});

test("floating pull waits for page bridge injection before posting commands", () => {
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");

  assert.equal(contentScript.includes("function getRuntime()"), true);
  assert.equal(contentScript.includes("globalThis.chrome?.runtime"), true);
  assert.equal(contentScript.includes("async function ensurePageBridge"), true);
  assert.equal(contentScript.includes("try {\n    await ensurePageBridge();"), true);
  assert.equal(contentScript.includes("return { ok: false, message: error?.message || String(error) };"), true);
  assert.equal(contentScript.includes('injectPageScript("fields-mover-core.js")'), true);
  assert.equal(contentScript.includes('injectPageScript("page-bridge.js")'), true);
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

test("page bridge does not mix stale fullName package with current function id", () => {
  const pageBridge = fs.readFileSync(path.join(ROOT, "extension", "page-bridge.js"), "utf8");
  const popupScript = fs.readFileSync(path.join(ROOT, "extension", "popup.js"), "utf8");

  assert.equal(pageBridge.includes("parsed.funId === funId"), true);
  assert.equal(pageBridge.includes("selectedFunId === titleInfo.funId"), true);
  assert.equal(popupScript.includes("parsed.funId === (candidateFunId || selectedFunId)"), true);
  assert.equal(popupScript.includes("selectedFunId === titleInfo.funId"), true);
});

test("floating pull shows a visible diagnostic message", () => {
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");

  assert.equal(contentScript.includes("guthon-bridge-message"), true);
  assert.equal(contentScript.includes("setMessage(root,"), true);
  assert.equal(contentScript.includes("}, 10000);"), true);
  assert.equal(contentScript.includes("console.error(\"Guthon Bridge pull failed\""), true);
});

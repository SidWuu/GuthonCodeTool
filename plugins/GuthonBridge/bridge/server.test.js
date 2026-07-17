const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const MANIFEST_PATH = path.join(__dirname, "workspace", "manifest.json");
const EXTENSION_MANIFEST_PATH = path.join(ROOT, "extension", "manifest.json");
const CONTENT_SCRIPT_PATH = path.join(ROOT, "extension", "content.js");
const POPUP_HTML_PATH = path.join(ROOT, "extension", "popup.html");
const POPUP_SCRIPT_PATH = path.join(ROOT, "extension", "popup.js");
const HOST_CONFIG_PATH = path.join(ROOT, "extension", "host-config.js");

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

test("logPullFailure records the page pull failure reason", async () => {
  const port = 17465;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guthon-page-pull-failure-"));
  const logPath = path.join(tmp, "pull-log.ndjson");
  const server = spawn(process.execPath, ["bridge/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GUTHON_BRIDGE_PORT: String(port),
      GUTHON_PULL_LOG_PATH: logPath
    },
    stdio: "ignore"
  });

  try {
    await waitForHealth(port);
    const response = await fetch(`http://127.0.0.1:${port}/logPullFailure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pullType: "page-source",
        summary: { url: "http://guthon.example/#/gdpaas/dev/procedure_develop" },
        message: "读取函数内容失败"
      })
    });
    const data = await response.json();
    const log = JSON.parse(fs.readFileSync(logPath, "utf8").trim());

    assert.equal(response.status, 200, data.message);
    assert.equal(log.pullType, "page-source");
    assert.equal(log.ok, false);
    assert.equal(log.message, "读取函数内容失败");
    assert.equal(log.summary.url, "http://guthon.example/#/gdpaas/dev/procedure_develop");
  } finally {
    server.kill();
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
  process.stdout.write(JSON.stringify({
    ok: true,
    changed: false,
    workCopyPath: ${JSON.stringify(workCopyPath)},
    workCopyStatus: "LOCAL_CHANGED",
    workCopyAction: "PRESERVED",
    localChanged: true
  }));
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
    assert.match(log.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.deepEqual(log.summary, {
      sourceType: "procedure",
      sourceId: "",
      alias: "demo.pkg",
      funId: "save",
      changed: false,
      pulled: "",
      workCopyPath,
      workCopyStatus: "LOCAL_CHANGED",
      workCopyAction: "PRESERVED",
      localChanged: true
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
  const background = fs.readFileSync(path.join(ROOT, "extension", "background.js"), "utf8");
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
  assert.equal(script.includes('type: "log-pull-failure"'), true);
  assert.equal(background.includes('postJson("/logPullFailure"'), true);
  assert.equal(background.includes('chrome.runtime.onInstalled.addListener'), true);
  assert.equal(background.includes('files: ["fields-mover-core.js", "page-bridge.js"]'), true);
  assert.equal(background.includes('files: ["host-config.js", "content.js"]'), true);
  assert.equal(background.includes('world: "MAIN"'), true);
  assert.equal(script.includes("拉取单据类型"), true);
  assert.equal(runHubPullScript.includes("resolveCurrentTarget"), false);
  assert.equal(html.includes("closeBtn"), true);
  assert.equal(script.includes("window.close()"), true);
});

test("extension manifest injects the floating pull button on Guthon pages", () => {
  const manifest = JSON.parse(fs.readFileSync(EXTENSION_MANIFEST_PATH, "utf8"));

  assert.deepEqual(manifest.permissions.includes("storage"), true);
  assert.deepEqual(manifest.host_permissions.includes("http://*/*"), true);
  assert.deepEqual(manifest.host_permissions.includes("https://*/*"), true);
  assert.deepEqual(manifest.content_scripts, [
    {
      matches: ["http://*/*", "https://*/*"],
      js: ["host-config.js", "content.js"],
      run_at: "document_idle"
    }
  ]);
  assert.deepEqual(manifest.web_accessible_resources, [
    {
      resources: ["fields-mover-core.js", "page-bridge.js"],
      matches: ["http://*/*", "https://*/*"]
    }
  ]);
});

test("configured IP ranges and domain suffixes control Guthon URLs", () => {
  delete require.cache[require.resolve(HOST_CONFIG_PATH)];
  const hosts = require(HOST_CONFIG_PATH);
  const popupHtml = fs.readFileSync(POPUP_HTML_PATH, "utf8");
  const popupScript = fs.readFileSync(POPUP_SCRIPT_PATH, "utf8");
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");
  const rules = {
    protocols: ["http:", "https:"],
    ipRanges: ["192.0.2.0/24"],
    domainSuffixes: ["dev.example.com"],
    pathPrefixes: ["/guthon/"]
  };

  assert.equal(hosts.isAllowed("http://192.0.2.4/guthon/home", rules), true);
  assert.equal(hosts.isAllowed("http://192.0.3.4/guthon/home", rules), false);
  assert.equal(hosts.isAllowed("https://team.dev.example.com/guthon/home", rules), true);
  assert.equal(hosts.isAllowed("https://dev.example.com/other", rules), false);
  assert.equal(hosts.isAllowed("https://notdev.example.com/guthon/home", rules), false);
  assert.equal(popupHtml.indexOf("host-config.js") < popupHtml.indexOf("popup.js"), true);
  assert.equal(popupScript.includes("GuthonBridgeHost?.isAllowed"), true);
  assert.equal(contentScript.includes("GuthonBridgeHost?.isAllowed"), true);
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
  assert.equal(contentScript.includes('root.style.bottom = "150px"'), true);
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
  assert.equal(contentScript.includes("复制局部上下文"), true);
  assert.equal(contentScript.includes("navigator.clipboard.writeText"), true);
  assert.equal(contentScript.includes("pullCurrentProcedure(root, refreshButton, true)"), false);
  const pullScript = contentScript.slice(contentScript.indexOf("async function pullCurrentProcedure"), contentScript.indexOf("function removeNode"));
  assert.equal(pullScript.includes("module_page_sql"), false);
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
  assert.equal(contentScript.includes('message?.type === "show-copy-overlay"'), true);
  assert.equal(contentScript.includes("function installSourcePullButton"), true);
  assert.equal(contentScript.includes("guthon-bridge-module-only"), true);
  assert.equal(contentScript.includes("SCHEMA_ROOT_ID"), false);
  assert.equal(contentScript.includes("BILLTYPE_ROOT_ID"), false);
  assert.equal(contentScript.includes('style.dataset.version = "20260717h"'), true);
  assert.equal(contentScript.includes("visibility: hidden"), true);
  assert.equal(contentScript.includes("root.dataset.positioned"), false);
  assert.equal(contentScript.includes('root.dataset.sharedButtons = "true"'), true);
  assert.equal(contentScript.includes("exportCurrentTableSchema(root, sourceButton)"), true);
  assert.equal(contentScript.includes("exportCurrentBillType(root, sourceButton)"), true);
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
  assert.equal(contentScript.includes("if (isModuleRoute() || isProcedureRoute())"), true);
});

test("popup waits for storage.local output directory persistence", () => {
  const popupScript = fs.readFileSync(path.join(ROOT, "extension", "popup.js"), "utf8");
  const popupHtml = fs.readFileSync(path.join(ROOT, "extension", "popup.html"), "utf8");
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");

  assert.equal(popupScript.includes("function isModuleUrl"), true);
  assert.equal(popupScript.includes("打开复制模式"), true);
  assert.equal(popupScript.includes('chrome.tabs.sendMessage(tab.id, { type: "show-copy-overlay" })'), true);
  assert.equal(popupScript.includes("async function persistOutputDir"), true);
  assert.equal(popupScript.includes("await persistOutputDir(outputDir);"), true);
  assert.equal(popupScript.includes('outputDirEl.addEventListener("change", persistCurrentOutputDir);'), true);
  assert.equal(popupScript.includes('outputDirEl.addEventListener("blur", persistCurrentOutputDir);'), true);
  assert.equal(popupHtml.includes('id="copyFieldsBtn"'), true);
  assert.equal(popupHtml.includes('id="pasteFieldsBtn"'), true);
  assert.equal(popupHtml.includes('id="forceRefreshBtn"'), true);
  assert.equal(popupHtml.includes("background: #409eff"), true);
  assert.equal(popupHtml.includes(".action-force"), true);
  assert.equal(popupHtml.includes("grid-template-columns: 3fr 1fr"), true);
  assert.equal(popupHtml.includes(".source-actions.full-width"), true);
  assert.equal(popupHtml.includes("border: 0;"), true);
  assert.equal(popupScript.includes('runFieldsMover("show-fields-mover")'), true);
  assert.equal(popupScript.includes('runFieldsMover("paste-fields-mover")'), true);
  assert.equal(popupScript.includes("runHubPull(true)"), true);
  assert.equal(popupScript.includes('forceRefreshBtn.style.display = canPullSource ? "" : "none"'), true);
  assert.equal(popupScript.includes('pullHubBtn.parentElement.classList.toggle("full-width", !canPullSource)'), true);
  assert.equal(popupScript.includes('setStatus("当前页面是模块开发")'), true);
  assert.equal(popupScript.includes('copyFieldsBtn.style.display = isModule ? "" : "none"'), true);
  assert.equal(popupScript.includes('pasteFieldsBtn.style.display = isModule ? "" : "none"'), true);
  assert.equal(contentScript.includes('message?.type === "show-fields-mover"'), true);
  assert.equal(contentScript.includes('message?.type === "paste-fields-mover"'), true);
  assert.equal(contentScript.includes('makeNativeButton("强制刷新"'), false);
});

test("page bridge uses popup-compatible procedure search strategy", () => {
  const pageBridge = fs.readFileSync(path.join(ROOT, "extension", "page-bridge.js"), "utf8");

  assert.equal(pageBridge.includes("keyword: payload.funId"), true);
  assert.equal(pageBridge.includes("resolveProcedure(searchResult, payload.procedureKeyword, payload.funId)"), true);
  assert.equal(pageBridge.includes("[vm?.editor || vm?.$refs?.editor?.editor, vm?.viewer].filter(Boolean)"), true);
});

test("page bridge resolves and opens native-modifier procedure targets", async () => {
  const pageBridge = fs.readFileSync(path.join(ROOT, "extension", "page-bridge.js"), "utf8");
  const window = {
    addEventListener() {},
    removeEventListener() {},
    postMessage() {}
  };
  const context = {
    window,
    document: {
      querySelectorAll: () => [],
      createElement: () => ({ remove() {} }),
      head: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {}
    },
    console,
    URLSearchParams,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(pageBridge, context);
  const resolve = window.GuthonProcedureNavigation.resolveProcedureTarget;
  const resolveLocal = window.GuthonProcedureNavigation.resolveLocalFunctionTarget;
  const isModifier = window.GuthonProcedureNavigation.isProcedureNavigationModifier;
  const invoke = '$vs.proc.invoke("com.golden.demo.common", "saveForecast", $params);';
  const binding = "#set($proc=$vs.proc.find('com.golden.demo.back'))\n$proc.updateBacknum($map);";

  assert.deepEqual(
    { ...resolve(invoke, invoke.indexOf("saveForecast")) },
    { procedureKeyword: "com.golden.demo.common", funId: "saveForecast" }
  );
  assert.deepEqual(
    { ...resolve(binding, binding.indexOf("updateBacknum")) },
    { procedureKeyword: "com.golden.demo.back", funId: "updateBacknum" }
  );
  assert.equal(resolve("$vs.proc.invoke($package, $method, $params);", 25), null);
  const local = "@insertBankrollTmp($form);\n\n#function insertBankrollTmp($form)\n#end";
  assert.deepEqual(
    { ...resolveLocal(local, local.indexOf("insertBankrollTmp")) },
    { funId: "insertBankrollTmp", lineNumber: 3 }
  );
  assert.equal(resolveLocal("insertBankrollTmp($form);", 0), null);
  window.navigator = { platform: "MacIntel" };
  assert.equal(isModifier({ metaKey: true }), true);
  assert.equal(isModifier({ ctrlKey: true }), false);
  window.navigator = { platform: "Win32" };
  assert.equal(isModifier({ ctrlKey: true }), true);
  let treeNode = null;
  let located = null;
  const developVm = {
    dataSourceId: "",
    openTabs: [],
    getScriptTreeNode: () => treeNode,
    parseProcFunInfo: (_procedure, fun) => ({ id: `PR-1@${fun.funId}`, data: fun }),
    handleNodeClick(node) {
      this.openTabs.push(node);
    },
    loadProcTree(callback) {
      treeNode = { id: "PR-1@saveForecast", data: { procedureId: "PR-1", funId: "saveForecast" } };
      callback();
    },
    toLocation(node) {
      located = node;
    },
    $refs: { tree: { $el: { querySelector: () => null } } }
  };
  await window.GuthonProcedureNavigation.openProcedureInVm(developVm, {
    dataSourceId: "0015",
    procedureId: "PR-1",
    procedureName: "com.golden.demo.common",
    funId: "saveForecast",
    fun: { funId: "saveForecast" }
  });
  assert.equal(developVm.openTabs[0].id, "PR-1@saveForecast");
  assert.equal(located.id, "PR-1@saveForecast");
  assert.equal(located.dataSourceId, "0015");
  const liveDevelopVm = { $options: { name: "gdpaas_dev_procedure_develop" }, onOpenPage() {} };
  context.document.querySelectorAll = () => [{ __vue__: { _vnode: { componentInstance: liveDevelopVm } } }];
  assert.equal(window.GuthonProcedureNavigation.findProcedureDevelopVm(), liveDevelopVm);
  const classes = new Set();
  const maskClasses = new Set();
  let restore;
  let routedBack = false;
  let editorLayout = false;
  let restoredText = "saved";
  let dialogReset = false;
  let editorOpened = false;
  let dragStart;
  let closeBar;
  const bar = {
    style: {},
    addEventListener: (event, handler) => {
      if (event === "dblclick") restore = handler;
      if (event === "mousedown") dragStart = handler;
    },
    appendChild() {},
    getBoundingClientRect: () => ({ left: 100, top: 12, width: 300, height: 36 }),
    remove() {}
  };
  const closeButton = {
    addEventListener: (_event, handler) => { closeBar = handler; },
    setAttribute() {}
  };
  const owner = {
    script: { id: "save", scriptItem: { name: "beforeSave" } },
    $refs: { scriptEditPage: { $refs: { editor: { isDialogShow: true } } } },
    $nextTick(callback) { callback(); },
    showScriptEditPage() {
      dialogReset = this.$refs.scriptEditPage.$refs.editor.isDialogShow === false;
      editorOpened = true;
    }
  };
  const dialogWrapper = {
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
    __vue__: { $parent: owner }
  };
  const dialogMask = {
    offsetWidth: 1,
    classList: { add: (name) => maskClasses.add(name), remove: (name) => maskClasses.delete(name) }
  };
  const editorElement = {
    __vue__: { editor: { getValue: () => "unsaved" } },
    closest: () => dialogWrapper
  };
  const restoredElement = {
    offsetWidth: 1,
    __vue__: { editor: {
      getValue: () => restoredText,
      setValue: (value) => { restoredText = value; },
      layout: () => { editorLayout = true; }
    } }
  };
  context.document.createElement = (tag) => tag === "button" ? closeButton : bar;
  context.document.body = { appendChild() {} };
  context.document.querySelectorAll = (selector) => {
    if (selector === ".v-modal" || selector === ".guthon-minimized-script-mask") return [dialogMask];
    if (selector === ".el-dialog__wrapper .script-editor") return [restoredElement];
    return [
      { __vue__: { $router: { push: async () => { routedBack = true; } } } },
      { __vue__: owner }
    ];
  };
  window.innerWidth = 1200;
  window.innerHeight = 800;
  window.GuthonProcedureNavigation.minimizeScriptEditor(editorElement);
  assert.equal(classes.has("guthon-minimized-script-editor"), true);
  assert.equal(maskClasses.has("guthon-minimized-script-mask"), true);
  dragStart({ button: 0, target: { closest: () => null }, clientX: 120, clientY: 20, preventDefault() {} });
  assert.equal(bar.style.transform, "none");
  await restore({ preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve));
  assert.equal(routedBack, true);
  assert.equal(classes.size, 0);
  assert.equal(maskClasses.size, 0);
  assert.equal(restoredText, "unsaved");
  assert.equal(editorLayout, true);
  assert.equal(dialogReset, true);
  assert.equal(editorOpened, true);
  let buttonEditorOpened = false;
  let buttonEditorClosed = false;
  let buttonRestoredText = "button-saved";
  const buttonClasses = new Set();
  const buttonSetup = {
    $options: { name: "gd-button-setup" },
    $refs: { editor: {
      isDialogShow: false,
      show: () => { buttonEditorOpened = true; },
      close: () => { buttonEditorClosed = true; }
    } }
  };
  const buttonWrapper = {
    isConnected: true,
    classList: { add: (name) => buttonClasses.add(name), remove: (name) => buttonClasses.delete(name) },
    querySelectorAll: () => [{
      offsetWidth: 1,
      __vue__: { editor: {
        getValue: () => buttonRestoredText,
        setValue: (value) => { buttonRestoredText = value; },
        layout() {}
      } }
    }],
    __vue__: buttonSetup
  };
  window.GuthonProcedureNavigation.minimizeScriptEditor({
    __vue__: { editor: { getValue: () => "button-unsaved" } },
    closest: () => buttonWrapper
  });
  assert.equal(buttonClasses.has("guthon-minimized-script-editor"), true);
  await restore({ preventDefault() {}, stopPropagation() {} });
  assert.equal(buttonEditorOpened, true);
  assert.equal(buttonRestoredText, "button-unsaved");
  assert.equal(buttonClasses.size, 0);
  window.GuthonProcedureNavigation.minimizeScriptEditor({
    __vue__: { editor: { getValue: () => "button-unsaved" } },
    closest: () => buttonWrapper
  });
  closeBar({ preventDefault() {}, stopPropagation() {} });
  assert.equal(buttonEditorClosed, true);
  assert.equal(buttonClasses.size, 0);
  assert.equal(pageBridge.includes('document.addEventListener("contextmenu", onContextMenu, true)'), true);
  assert.equal(pageBridge.includes("editor.onMouseMove?.("), true);
  assert.equal(pageBridge.includes("color:#409eff!important;cursor:pointer!important"), true);
  assert.equal(pageBridge.includes("developVm.handleNodeClick(openNode)"), true);
  assert.equal(pageBridge.includes("developVm.loadProcTree(() =>"), true);
  assert.equal(pageBridge.includes("developVm.toLocation?.(treeNode)"), true);
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

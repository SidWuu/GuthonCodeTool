const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn: spawnChild } = require("child_process");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const TEST_TOOL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "guthon-bridge-test-home-"));
process.env.GUTHON_TOOL_HOME = TEST_TOOL_HOME;
test.after(() => fs.rmSync(TEST_TOOL_HOME, { recursive: true, force: true }));
const EXTENSION_MANIFEST_PATH = path.join(ROOT, "extension", "manifest.json");
const CONTENT_SCRIPT_PATH = path.join(ROOT, "extension", "content.js");
const POPUP_HTML_PATH = path.join(ROOT, "extension", "popup.html");
const POPUP_SCRIPT_PATH = path.join(ROOT, "extension", "popup.js");
const HOST_CONFIG_PATH = path.join(ROOT, "extension", "host-config.js");
const WORKSPACE_SELECTION_PATH = path.join(ROOT, "extension", "workspace-selection.js");
const BRIDGE_CSS_PATH = path.join(ROOT, "extension", "bridge.css");

const serverHomes = new Map();
function spawn(executable, args, options) {
  if (args[0] === "bridge/server.js") {
    const env = options.env;
    serverHomes.set(Number(env.GUTHON_BRIDGE_PORT), env.GUTHON_TOOL_HOME);
    const legacy = Object.entries({ pull: "TEST_PULL_SCRIPT", "export-schema": "TEST_SCHEMA_SCRIPT", "export-bill-type": "TEST_BILL_TYPE_SCRIPT", "export-view": "TEST_VIEW_SCRIPT", "export-system-script": "TEST_SYSTEM_SCRIPT", query: "TEST_QUERY_SCRIPT" }).find(([, key]) => env[key]);
    if (legacy) {
      const fixture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-fixture-")), "host.js");
      fs.writeFileSync(fixture, `
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
process.stdout.write(JSON.stringify({type:'ready',protocolVersion:1})+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  let result;
  if (request.command === 'route') result = {ok:true,workspaceKey:request.input.workspaceKey};
  else {
    const argv = ${JSON.stringify(legacy[0])} === 'pull' ? ['--json-stdin'] : ['--workspace',request.workspaceKey,...request.args];
    const out = spawnSync(${JSON.stringify(env.TEST_EXECUTABLE)},[${JSON.stringify(env[legacy[1]])},...argv],{input:JSON.stringify(request.input)});
    if (out.status !== 0) { process.stdout.write(JSON.stringify({type:'result',id:request.id,ok:false,error:{message:out.stderr.toString()}})+'\\n'); return; }
    result = JSON.parse(out.stdout.toString());
  }
  process.stdout.write(JSON.stringify({type:'result',id:request.id,ok:true,result})+'\\n');
});`);
      options.env = { ...env, GUTHON_TOOL_PATH: process.execPath, GUTHON_TOOL_ENTRY: fixture };
    }
  }
  return spawnChild(executable, args, options);
}
async function bridgeFetch(url, options) {
  if (options?.method === "POST") {
    const home = serverHomes.get(Number(new URL(url).port));
    const token = fs.readFileSync(path.join(home, "var", "nexus", "bridge", "token"), "utf8");
    options.headers = { ...options.headers, Authorization: `Bearer ${token}` };
  }
  return fetch(url, options);
}

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

test("saveRemoteFile writes only into the configured export root", async () => {
  const port = 17461;
  const toolHome = fs.mkdtempSync(path.join(os.tmpdir(), "guthon-bridge-home-"));
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "guthon-bridge-output-"));
  const server = spawn(process.execPath, ["bridge/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GUTHON_BRIDGE_PORT: String(port),
      GUTHON_TOOL_HOME: toolHome,
      GUTHON_BRIDGE_EXPORT_ROOT: outputDir
    },
    stdio: "ignore"
  });

  try {
    await waitForHealth(port);
    const response = await bridgeFetch(`http://127.0.0.1:${port}/saveRemoteFile`, {
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
    assert.equal(data.filePath, path.join(fs.realpathSync(outputDir), "doPreRequestScript.java"));
    assert.equal(fs.readFileSync(data.filePath, "utf8"), "function body");
    assert.equal(fs.existsSync(path.join(outputDir, "demo.pkg")), false);
  } finally {
    server.kill();
    fs.rmSync(toolHome, { recursive: true, force: true });
  }
});

test("saveRemoteFile rejects a path-traversal extension", async () => {
  const port = 17471;
  const toolHome = fs.mkdtempSync(path.join(os.tmpdir(), "guthon-bridge-home-"));
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "guthon-bridge-output-"));
  const server = spawn(process.execPath, ["bridge/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GUTHON_BRIDGE_PORT: String(port),
      GUTHON_TOOL_HOME: toolHome,
      GUTHON_BRIDGE_EXPORT_ROOT: outputDir
    },
    stdio: "ignore"
  });

  try {
    await waitForHealth(port);
    const response = await bridgeFetch(`http://127.0.0.1:${port}/saveRemoteFile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objectKey: "demo.pkg#escape",
        outputDir,
        content: "function body",
        metadata: { extension: "txt/../../../.zshrc", funId: "escape" }
      })
    });
    const data = await response.json();
    assert.equal(response.status, 500, data.message);
    assert.equal(data.ok, false);
  } finally {
    server.kill();
    fs.rmSync(toolHome, { recursive: true, force: true });
  }
});

test("saveRemoteFile rejects an oversized request body", async () => {
  const port = 17472;
  const toolHome = fs.mkdtempSync(path.join(os.tmpdir(), "guthon-bridge-home-"));
  const server = spawn(process.execPath, ["bridge/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GUTHON_BRIDGE_PORT: String(port),
      GUTHON_TOOL_HOME: toolHome
    },
    stdio: "ignore"
  });

  try {
    await waitForHealth(port);
    const response = await bridgeFetch(`http://127.0.0.1:${port}/saveRemoteFile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objectKey: "big", content: "x".repeat(2 * 1024 * 1024) })
    });
    const data = await response.json();
    assert.equal(response.status, 500, data.message);
    assert.equal(data.ok, false);
  } finally {
    server.kill();
    fs.rmSync(toolHome, { recursive: true, force: true });
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
    const response = await bridgeFetch(`http://127.0.0.1:${port}/logPullFailure`, {
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
    localChanged: true,
    gitAddStatus: "ADDED",
    gitAdded: 4
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
      TEST_EXECUTABLE: process.execPath,
      TEST_PULL_SCRIPT: hubScript,
      GUTHON_PULL_LOG_PATH: logPath
    },
    stdio: "ignore"
  });

  try {
    await waitForHealth(port);
    const response = await bridgeFetch(`http://127.0.0.1:${port}/pullHubSource`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        workspaceKey: "projects.demo-project",
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
      workspaceKey: "projects.demo-project",
      sourceType: "procedure",
      sourceId: "",
      alias: "demo.pkg",
      funId: "save",
      changed: false,
      pulled: "",
      workCopyPath,
      workCopyStatus: "LOCAL_CHANGED",
      workCopyAction: "PRESERVED",
      localChanged: true,
      gitAddStatus: "ADDED",
      gitAdded: 4
    });
  } finally {
    server.kill();
  }
});

test("pullHubSource uses the configured Python tool entry in development mode", async () => {
  const port = 17466;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guthon-development-tool-"));
  const toolEntry = path.join(tmp, "fake-tool.js");
  const toolHome = path.join(tmp, "home");
  const logPath = path.join(tmp, "pull-log.ndjson");
  const startsPath = path.join(tmp, "tool-starts.txt");
  fs.writeFileSync(
    toolEntry,
    `
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(startsPath)}, 'start\\n');
if (JSON.stringify(args) !== JSON.stringify(["serve", "--stdio", "--home", ${JSON.stringify(toolHome)}])) {
  process.stderr.write(JSON.stringify(args));
  process.exit(2);
}
const readline = require('node:readline');
process.stdout.write(JSON.stringify({ type: 'ready', protocolVersion: 1 }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.command === 'route') { process.stdout.write(JSON.stringify({ id: request.id, type: 'result', ok: true, result: {ok:true,workspaceKey:request.input.workspaceKey} }) + '\\n'); return; }
  if (request.command !== 'pull' || request.workspaceKey !== 'projects.demo-project') process.exit(3);
  process.stdout.write(JSON.stringify({ id: request.id, type: 'result', ok: true, result: { ok: true, mode: 'development' } }) + '\\n');
});
`,
    "utf8",
  );
  const server = spawn(process.execPath, ["bridge/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GUTHON_BRIDGE_PORT: String(port),
      GUTHON_TOOL_PATH: process.execPath,
      GUTHON_TOOL_ENTRY: toolEntry,
      GUTHON_TOOL_HOME: toolHome,
      GUTHON_PULL_LOG_PATH: logPath,
    },
    stdio: "ignore",
  });

  try {
    await waitForHealth(port);
    const response = await bridgeFetch(`http://127.0.0.1:${port}/pullHubSource`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceKey: "projects.demo-project", sourceType: "procedure", alias: "demo.pkg", funId: "save" }),
    });
    const data = await response.json();

    assert.equal(response.status, 200, data.message);
    assert.equal(data.ok, true);
    assert.equal(data.mode, "development");
    const second = await bridgeFetch(`http://127.0.0.1:${port}/pullHubSource`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceKey: "projects.demo-project", sourceType: "procedure", alias: "demo.pkg", funId: "save" }),
    });
    assert.equal((await second.json()).mode, "development");
    assert.equal(fs.readFileSync(startsPath, "utf8").trim().split("\n").length, 1);
  } finally {
    server.kill();
  }
});

test("routeWorkspace validates page identity and strips local paths", async () => {
  const port = 17468;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guthon-workspace-summary-"));
  const toolEntry = path.join(tmp, "fake-tool.js");
  const toolHome = path.join(tmp, "home");
  fs.writeFileSync(
    toolEntry,
    `
const args = process.argv.slice(2);
const expected = ["serve", "--stdio", "--home", ${JSON.stringify(toolHome)}];
if (JSON.stringify(args) !== JSON.stringify(expected)) {
  process.stderr.write(JSON.stringify(args));
  process.exit(2);
}
const readline = require('node:readline');
process.stdout.write(JSON.stringify({ type: 'ready', protocolVersion: 1 }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const payload = request.input;
  if (request.command !== 'route') process.exit(3);
  if (payload.workspaceKey !== "products.demo" || payload.checkoutPath !== "/must/not/be/forwarded") process.exit(3);
  process.stdout.write(JSON.stringify({ id: request.id, type: 'result', ok: true, result: {
    ok: true, workspaceKey: "products.demo",
    workspace: { workspaceKey: "products.demo", sourceMode: "svn", root: "/private/root", checkoutPath: "/private/checkout" }
  } }) + '\\n');
});
`,
    "utf8",
  );
  const server = spawn(process.execPath, ["bridge/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GUTHON_BRIDGE_PORT: String(port),
      GUTHON_TOOL_PATH: process.execPath,
      GUTHON_TOOL_ENTRY: toolEntry,
      GUTHON_TOOL_HOME: toolHome,
    },
    stdio: "ignore",
  });

  try {
    await waitForHealth(port);
    const response = await bridgeFetch(`http://127.0.0.1:${port}/routeWorkspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceKey: "products.demo", checkoutPath: "/must/not/be/forwarded" }),
    });
    const data = await response.json();
    assert.equal(response.status, 200, data.message);
    assert.equal(data.workspace.sourceMode, "svn");
    assert.equal(data.workspace.root, undefined);
    assert.equal(data.workspace.checkoutPath, undefined);
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
      TEST_EXECUTABLE: process.execPath,
      TEST_SCHEMA_SCRIPT: schemaScript,
      GUTHON_PULL_LOG_PATH: logPath
    },
    stdio: "ignore"
  });

  try {
    await waitForHealth(port);
    const response = await bridgeFetch(`http://127.0.0.1:${port}/exportTableSchema`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        workspaceKey: "products.demo-product",
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

test("database connection failures return a friendly message", async () => {
  const port = 17469;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guthon-database-error-"));
  const schemaScript = path.join(tmp, "fake-schema.js");
  fs.writeFileSync(
    schemaScript,
    'process.stderr.write("Traceback (most recent call last):\\npymysql.err.OperationalError: (2013, \\\"Lost connection to MySQL server during query\\\")"); process.exit(1);',
    "utf8",
  );
  const server = spawn(process.execPath, ["bridge/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GUTHON_BRIDGE_PORT: String(port),
      TEST_EXECUTABLE: process.execPath,
      TEST_SCHEMA_SCRIPT: schemaScript,
    },
    stdio: "ignore",
  });

  try {
    await waitForHealth(port);
    const response = await bridgeFetch(`http://127.0.0.1:${port}/exportTableSchema`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceKey: "products.demo-product", dataSourceId: "0015" }),
    });
    const data = await response.json();

    assert.equal(response.status, 500);
    assert.equal(data.message, "无法连接源码数据库，请确认已连接公司内网或 VPN 后重试");
    assert.equal(data.message.includes("Traceback"), false);
  } finally {
    server.kill();
  }
});

test("PostgreSQL connection failures return the same friendly message", async () => {
  const port = 17470;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guthon-postgresql-error-"));
  const schemaScript = path.join(tmp, "fake-schema.js");
  fs.writeFileSync(
    schemaScript,
    'process.stderr.write("psycopg.OperationalError: connection failed: Connection refused"); process.exit(1);',
    "utf8",
  );
  const server = spawn(process.execPath, ["bridge/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GUTHON_BRIDGE_PORT: String(port),
      TEST_EXECUTABLE: process.execPath,
      TEST_SCHEMA_SCRIPT: schemaScript,
    },
    stdio: "ignore",
  });

  try {
    await waitForHealth(port);
    const response = await bridgeFetch(`http://127.0.0.1:${port}/exportTableSchema`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceKey: "products.demo-product", dataSourceId: "0015" }),
    });
    const data = await response.json();
    assert.equal(response.status, 500);
    assert.equal(data.message, "无法连接源码数据库，请确认已连接公司内网或 VPN 后重试");
  } finally {
    server.kill();
    fs.rmSync(tmp, { recursive: true });
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
      TEST_EXECUTABLE: process.execPath,
      TEST_BILL_TYPE_SCRIPT: billTypeScript,
      GUTHON_PULL_LOG_PATH: logPath
    },
    stdio: "ignore"
  });

  try {
    await waitForHealth(port);
    const response = await bridgeFetch(`http://127.0.0.1:${port}/exportBillType`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        workspaceKey: "products.demo-product",
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

test("exportViewSql delegates view filters to script", async () => {
  const port = 17467;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guthon-view-command-"));
  const viewScript = path.join(tmp, "fake-views.js");
  const logPath = path.join(tmp, "pull-log.ndjson");
  fs.writeFileSync(
    viewScript,
    `
const args = process.argv.slice(2);
if (!args.includes("--data-source-ids") || !args.includes("0015")) {
  process.stderr.write("bad data source args: " + args.join(" "));
  process.exit(2);
}
if (!args.includes("--view-ids") || !args.includes("V_RM_TEST")) {
  process.stderr.write("bad view args: " + args.join(" "));
  process.exit(2);
}
process.stdout.write(JSON.stringify({ ok: true, exported_view_count: 1, outputDir: "/tmp/views" }));
`,
    "utf8",
  );
  const server = spawn(process.execPath, ["bridge/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GUTHON_BRIDGE_PORT: String(port),
      TEST_EXECUTABLE: process.execPath,
      TEST_VIEW_SCRIPT: viewScript,
      GUTHON_PULL_LOG_PATH: logPath
    },
    stdio: "ignore"
  });

  try {
    await waitForHealth(port);
    const response = await bridgeFetch(`http://127.0.0.1:${port}/exportViewSql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceKey: "products.demo-product",
        dataSourceIds: ["0015"],
        viewIds: ["V_RM_TEST"]
      })
    });
    const data = await response.json();
    const log = JSON.parse(fs.readFileSync(logPath, "utf8").trim());

    assert.equal(response.status, 200, data.message);
    assert.equal(data.exported_view_count, 1);
    assert.equal(log.pullType, "views");
    assert.deepEqual(log.summary, {
      dataSourceIds: ["0015"],
      viewIds: ["V_RM_TEST"],
      exported_view_count: 1,
      outputDir: "/tmp/views"
    });
  } finally {
    server.kill();
  }
});

test("exportSystemScripts delegates selected system and script types", async () => {
  const port = 17468;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guthon-system-script-command-"));
  const exportScript = path.join(tmp, "fake-system-scripts.js");
  const logPath = path.join(tmp, "pull-log.ndjson");
  fs.writeFileSync(
    exportScript,
    `
const args = process.argv.slice(2);
if (!args.includes("--system-ids") || !args.includes("SYS-DD01-06B1-6B6C4E52")) {
  process.stderr.write("bad system args: " + args.join(" "));
  process.exit(2);
}
if (!args.includes("--script-types") || !args.includes("20") || !args.includes("--workcopy")) {
  process.stderr.write("bad script type args: " + args.join(" "));
  process.exit(2);
}
process.stdout.write(JSON.stringify({ ok: true, exported_system_script_count: 1, work_copy_paths: ["/tmp/workcopy"], outputDir: "/tmp/system-scripts" }));
`,
    "utf8",
  );
  const server = spawn(process.execPath, ["bridge/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GUTHON_BRIDGE_PORT: String(port),
      TEST_EXECUTABLE: process.execPath,
      TEST_SYSTEM_SCRIPT: exportScript,
      GUTHON_PULL_LOG_PATH: logPath
    },
    stdio: "ignore"
  });

  try {
    await waitForHealth(port);
    const response = await bridgeFetch(`http://127.0.0.1:${port}/exportSystemScripts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceKey: "products.demo-product",
        systemIds: ["SYS-DD01-06B1-6B6C4E52"],
        scriptTypes: [20]
      })
    });
    const data = await response.json();
    const log = JSON.parse(fs.readFileSync(logPath, "utf8").trim());

    assert.equal(response.status, 200, data.message);
    assert.equal(data.exported_system_script_count, 1);
    assert.equal(log.pullType, "system-scripts");
    assert.deepEqual(log.summary, {
      systemIds: ["SYS-DD01-06B1-6B6C4E52"],
      scriptTypes: [20],
      exported_system_script_count: 1,
      workCopyPaths: ["/tmp/workcopy"],
      outputDir: "/tmp/system-scripts"
    });
  } finally {
    server.kill();
  }
});

test("queryProcedureCallers delegates target identity to hub query", async () => {
  const port = 17466;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guthon-callers-query-"));
  const queryScript = path.join(tmp, "fake-query.js");
  fs.writeFileSync(
    queryScript,
    `
const args = process.argv.slice(2);
if (!args.includes("callers") || !args.includes("--alias") || !args.includes("demo.target") || !args.includes("--fun") || !args.includes("run")) {
  process.stderr.write("bad args: " + args.join(" "));
  process.exit(2);
}
process.stdout.write(JSON.stringify({
  target: { alias: "demo.target", funId: "run" },
  callers: [{ source_table: "procedure", source_id: "PROC-1", source_alias_id: "demo.caller", fun_id: "start" }]
}));
`,
    "utf8",
  );
  const server = spawn(process.execPath, ["bridge/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GUTHON_BRIDGE_PORT: String(port),
      TEST_EXECUTABLE: process.execPath,
      TEST_QUERY_SCRIPT: queryScript
    },
    stdio: "ignore"
  });

  try {
    await waitForHealth(port);
    const response = await bridgeFetch(`http://127.0.0.1:${port}/queryProcedureCallers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceKey: "products.demo-product", alias: "demo.target", funId: "run" })
    });
    const data = await response.json();

    assert.equal(response.status, 200, data.message);
    assert.equal(data.ok, true);
    assert.equal(data.callers[0].source_alias_id, "demo.caller");
  } finally {
    server.kill();
  }
});

test("bridge defaults hub python to repo venv when present", () => {
  const serverScript = fs.readFileSync(path.join(ROOT, "bridge", "server.js"), "utf8");

  assert.equal(serverScript.includes('path.join(ROOT, ".venv", "bin", "python")'), true);
  assert.equal(serverScript.includes("fs.existsSync(DEFAULT_HUB_PYTHON)"), true);
  assert.equal(serverScript.includes('path.join(HUB_TOOL_HOME, "var", "nexus", "bridge")'), true);
});

test("user-facing messages use concise Chinese", () => {
  const files = [
    path.join(ROOT, "bridge", "server.js"),
    path.join(ROOT, "extension", "background.js"),
    CONTENT_SCRIPT_PATH,
    path.join(ROOT, "extension", "page-bridge.js"),
    POPUP_HTML_PATH,
    POPUP_SCRIPT_PATH
  ];
  const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  for (const message of [
    "Bridge call failed",
    "Unknown message type",
    "extension context invalid",
    "extension invalid",
    "outputDir is required",
    "outputDir must be an absolute path",
    "No local file mapped",
    "Local file not found"
  ]) {
    assert.equal(source.includes(message), false, message);
  }
  const manifest = JSON.parse(fs.readFileSync(EXTENSION_MANIFEST_PATH, "utf8"));
  assert.equal(manifest.name, "Guthon Bridge");
  assert.equal(manifest.action.default_title, "Guthon Bridge");
});

test("popup exposes separate page and hub pull actions without hub target input", () => {
  const html = fs.readFileSync(POPUP_HTML_PATH, "utf8");
  const script = fs.readFileSync(POPUP_SCRIPT_PATH, "utf8");
  const background = fs.readFileSync(path.join(ROOT, "extension", "background.js"), "utf8");
  const content = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");
  const css = fs.readFileSync(BRIDGE_CSS_PATH, "utf8");
  const pageBridge = fs.readFileSync(path.join(ROOT, "extension", "page-bridge.js"), "utf8");
  const runHubPullScript = script.slice(script.indexOf("async function runHubPull"), script.indexOf("pullPageBtn.addEventListener"));
  const callersScript = content.slice(content.indexOf("async function showProcedureCallers"), content.indexOf("function renderTableCell"));

  assert.equal(html.includes("pullPageBtn"), true);
  assert.equal(html.includes("pullHubBtn"), true);
  assert.equal(html.includes("hubTarget"), false);
  assert.equal(script.includes("pull-hub-source"), true);
  assert.equal(script.includes("parseHubTarget"), false);
  assert.equal(script.includes("inspect-hub-source"), true);
  assert.equal(script.includes('type: "run-page-command"'), true);
  assert.equal(content.includes('message?.type === "run-page-command"'), true);
  assert.equal(background.includes('"query-procedure-callers": "/queryProcedureCallers"'), true);
  assert.equal(content.includes('"procedure-callers-request"'), true);
  assert.equal(content.includes('"open-procedure-caller"'), true);
  assert.equal(content.includes('"open-module-caller"'), true);
  assert.equal(css.includes("place-items: start center"), true);
  assert.equal(callersScript.includes('overlay.addEventListener("click"'), false);
  assert.equal(pageBridge.includes("function inspectCurrentHubSource"), true);
  assert.equal(pageBridge.includes("function inspectTableSchemaTarget"), true);
  assert.equal(pageBridge.includes("function inspectViewTarget"), true);
  assert.equal(pageBridge.includes("function getDataSourceName"), true);
  assert.equal(pageBridge.includes("function getLabeledSelectValue"), true);
  assert.equal(pageBridge.includes("[A-Z][A-Z0-9]+_[A-Z0-9_]"), true);
  assert.equal(script.includes('mode === "table-schema"'), true);
  assert.equal(script.includes('mode === "billtype"'), true);
  assert.equal(script.includes('"export-table-schema"'), true);
  assert.equal(script.includes('"export-bill-type"'), true);
  assert.equal(script.includes('"export-view-sql"'), true);
  assert.equal(script.includes('type: "log-pull-failure"'), true);
  assert.equal(background.includes('"log-pull-failure": "/logPullFailure"'), true);
  assert.equal(background.includes('chrome.runtime.onInstalled.addListener'), true);
  assert.equal(background.includes('files: ["bridge.css"]'), true);
  assert.equal(background.includes('files: ["host-config.js", "fields-mover-core.js", "page-bridge.js"]'), true);
  assert.equal(background.includes('files: ["host-config.js", "nexus-locator.js", "workspace-selection.js", "task-client.js", "content.js"]'), true);
  assert.equal(background.includes('world: "MAIN"'), true);
  assert.equal(script.includes("拉取单据类型"), true);
  assert.equal(script.includes("workspaceSelectionRequired"), true);
  assert.equal(script.includes("GuthonBridgeWorkspace.select"), true);
  assert.equal(content.includes("workspaceSelectionRequired"), true);
  assert.equal(content.includes("GuthonBridgeWorkspace.select"), true);
  assert.equal(css.includes(".guthon-bridge-workspace-dialog"), true);
  assert.equal(html.includes('src="workspace-selection.js"'), true);
  assert.equal(html.includes('href="bridge.css"'), true);
  assert.equal(runHubPullScript.includes("resolveCurrentTarget"), false);
  assert.equal(runHubPullScript.includes('const pageSource = target.mode === "page-source";'), true);
  assert.equal(script.includes('mode: result.data.mode || "procedure"'), true);
  assert.equal(pageBridge.includes('getActivePageTabCode()'), true);
  assert.equal(html.includes('id="locateNexusBtn"'), true);
  assert.equal(script.includes('chrome.tabs.create({ url: locator.uri })'), true);
  assert.equal(html.includes("closeBtn"), true);
  assert.equal(script.includes("window.close()"), true);
});

test("Nexus links carry only the current PAGE or procedure identity", () => {
  const locator = require("../extension/nexus-locator.js");
  const page = locator.build({ mode: "page-source", pageId: "PG-1234-5678", workspaceKey: "products.demo" });
  assert.equal(page.uri, "vscode://gushen-local.guthon-nexus-vscode/locate-page?pageId=PG-1234-5678");
  const procedure = locator.build({ mode: "procedure", procedureId: "PR-1",
    procedureKeyword: "com.golden.demo.common", funId: "saveForecast", workspaceKey: "products.demo" });
  assert.equal(procedure.uri, "vscode://gushen-local.guthon-nexus-vscode/locate-procedure?alias=com.golden.demo.common&funId=saveForecast");
  assert.equal(procedure.uri.includes("PR-1"), false);
  assert.equal(procedure.uri.includes("products.demo"), false);
  assert.equal(locator.isSupported({ mode: "procedure", procedureKeyword: "com.demo", funId: "" }), false);
  assert.throws(() => locator.build({ mode: "table-schema" }), /暂不支持/);
});

test("SPA module tab is identified by the active PAGE tab without the old route", () => {
  const script = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");
  const start = script.indexOf("function isModuleRoute()");
  const end = script.indexOf("function isDataTableRoute()", start);
  const context = {
    location: { hash: "#/admin" },
    isVisible: (element) => Boolean(element?.visible),
    document: {
      querySelector: (selector) => selector.includes('tab-PG-') ? { id: "tab-PG-1234", visible: true } : null,
      querySelectorAll: () => []
    }
  };
  vm.runInNewContext(`${script.slice(start, end)}\nglobalThis.isModuleRoute = isModuleRoute;`, context);
  assert.equal(context.isModuleRoute(), true);
  context.document.querySelector = () => null;
  context.document.querySelectorAll = () => [{ id: "pane-PG-OLD", visible: false }];
  assert.equal(context.isModuleRoute(), false);
});

test("late SPA tabs trigger the floating toolbar refresh without waiting for the fallback interval", () => {
  const script = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");
  const start = script.indexOf("function toolbarContextMarker()");
  const end = script.indexOf('window.addEventListener("hashchange"', start);
  const scheduled = [];
  let observer;
  let refreshes = 0;
  let activeTabs = [];
  let root = null;
  const context = {
    location: { hash: "#/gdpaas/dev/modules" },
    FLOATING_ROOT_ID: "guthon-bridge-floating-root",
    COPY_OVERLAY_ID: "guthon-bridge-copy-overlay",
    FIELDS_MOVER_OVERLAY_ID: "guthon-bridge-fields-mover-overlay",
    CALLERS_OVERLAY_ID: "guthon-bridge-callers-overlay",
    gToolbarObserver: null,
    gToolbarRefreshTimer: null,
    gObservedToolbarContext: "",
    document: {
      body: {},
      querySelectorAll: () => activeTabs,
      getElementById: () => root,
    },
    MutationObserver: class {
      constructor(callback) { observer = callback; }
      observe() {}
    },
    setTimeout: (callback) => { scheduled.push(callback); return scheduled.length; },
    refreshToolbarButtonsSafely: () => { refreshes += 1; },
  };
  vm.runInNewContext(`${script.slice(start, end)}\nglobalThis.observeToolbarContext = observeToolbarContext;`, context);
  context.observeToolbarContext();
  activeTabs = [{ id: "tab-gdpaas_dev_modules" }, { id: "tab-PG-1234" }];
  const childListChange = { type: "childList", target: { closest: () => null }, addedNodes: [], removedNodes: [] };
  observer([childListChange]);
  observer([childListChange]);
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.equal(refreshes, 1);
  root = {};
  observer([childListChange]);
  assert.equal(scheduled.length, 0);
});

test("active PAGE identity wins over stale management navigation state", () => {
  const script = fs.readFileSync(path.join(ROOT, "extension", "page-bridge.js"), "utf8");
  const start = script.indexOf("  function inspectCurrentHubSource()");
  const end = script.indexOf("  function putMapValue", start);
  const context = {
    location: { href: "https://example.test/guthon/index.html#/admin" },
    document: { querySelector: () => null },
    isVisible: () => false,
    getActivePageTabCode: () => "PG-1234-5678",
    getCurrentPageCode: () => "PG-OLD",
    getDataSourceId: () => "DS-1",
    isSystemScriptPage: () => false,
    isViewManagementPage: () => false,
    isBillTypePage: () => false,
    isDataTableManagementPage: () => true
  };
  vm.runInNewContext(`${script.slice(start, end)}\nglobalThis.inspectCurrentHubSource = inspectCurrentHubSource;`, context);
  const result = context.inspectCurrentHubSource();
  assert.equal(result.mode, "page-source");
  assert.equal(result.pageId, "PG-1234-5678");
});

test("active procedure identity wins over stale module URL", () => {
  const script = fs.readFileSync(path.join(ROOT, "extension", "page-bridge.js"), "utf8");
  const start = script.indexOf("  function inspectCurrentHubSource()");
  const end = script.indexOf("  function putMapValue", start);
  const context = {
    location: { href: "https://example.test/guthon/index.html#/gdpaas/dev/modules" },
    document: { querySelector: () => ({ id: "tab-PR-123@save", visible: true }) },
    isVisible: (node) => node.visible,
    getDataSourceId: () => "DS-1",
    inspectCurrentProcedure: () => ({ procedureKeyword: "demo.pkg", funId: "save" }),
    getActivePageTabCode: () => "PG-OLD"
  };
  vm.runInNewContext(`${script.slice(start, end)}\nglobalThis.inspectCurrentHubSource = inspectCurrentHubSource;`, context);
  assert.equal(context.inspectCurrentHubSource().funId, "save");
});

test("workspace selection reuses the same Guthon address and an available candidate", () => {
  delete require.cache[require.resolve(WORKSPACE_SELECTION_PATH)];
  const { cachedWorkspaceKey, guthonAddress, isWorkspaceCacheError } = require(WORKSPACE_SELECTION_PATH);
  const css = fs.readFileSync(BRIDGE_CSS_PATH, "utf8");
  const candidates = [{ workspaceKey: "projects.demo" }];
  const firstPage = "https://example.test/guthon/gdpaas/dev/modules?id=1";
  const selection = { address: "https://example.test/guthon", workspaceKey: "projects.demo" };

  assert.equal(guthonAddress(firstPage), selection.address);
  assert.equal(cachedWorkspaceKey(selection, firstPage, candidates), "projects.demo");
  assert.equal(cachedWorkspaceKey(selection, "https://example.test/guthon/gdpaas/dev/procedure_develop", candidates), "projects.demo");
  assert.equal(cachedWorkspaceKey(selection, "https://other.test/guthon/gdpaas/dev/modules", candidates), "");
  assert.equal(cachedWorkspaceKey(selection, firstPage, []), "");
  assert.equal(isWorkspaceCacheError({ ok: false, message: "Page identity does not match workspace: projects.demo" }), true);
  assert.equal(isWorkspaceCacheError({ ok: false, message: "源码表拉取失败" }), false);
  assert.equal(css.includes(".guthon-bridge-workspace-select"), true);
  assert.equal(css.includes("background: #409eff"), true);
  assert.equal(css.includes("top: 50% !important"), true);
  assert.equal(css.includes("inset: 0 !important"), false);
});

test("workspace selection reads the cached key for the current Guthon address", async () => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({
          guthonBridgeWorkspaceSelection: {
            address: "https://example.test/guthon",
            workspaceKey: "projects.demo"
          }
        })
      }
    }
  };
  delete require.cache[require.resolve(WORKSPACE_SELECTION_PATH)];
  try {
    const { storedWorkspaceKey } = require(WORKSPACE_SELECTION_PATH);
    assert.equal(await storedWorkspaceKey("https://example.test/guthon/gdpaas/dev/modules"), "projects.demo");
    assert.equal(await storedWorkspaceKey("https://other.test/guthon/gdpaas/dev/modules"), "");
  } finally {
    delete require.cache[require.resolve(WORKSPACE_SELECTION_PATH)];
    if (previousChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = previousChrome;
    }
  }
});

test("extension static styles live only in bridge.css", () => {
  const css = fs.readFileSync(BRIDGE_CSS_PATH, "utf8");
  const sources = [
    CONTENT_SCRIPT_PATH,
    POPUP_SCRIPT_PATH,
    POPUP_HTML_PATH,
    WORKSPACE_SELECTION_PATH,
    path.join(ROOT, "extension", "page-bridge.js")
  ].map((file) => fs.readFileSync(file, "utf8"));

  assert.equal(css.includes(".guthon-bridge-inline"), true);
  assert.equal(css.includes(".guthon-minimized-script-bar"), true);
  assert.equal(css.includes("body.guthon-bridge-popup"), true);
  for (const source of sources) {
    assert.equal(source.includes('createElement("style")'), false);
    assert.equal(source.includes("style.textContent"), false);
    assert.equal(source.includes("<style>"), false);
    assert.equal(source.includes('style="'), false);
  }
});

test("extension manifest injects the floating pull button on Guthon pages", () => {
  const manifest = JSON.parse(fs.readFileSync(EXTENSION_MANIFEST_PATH, "utf8"));

  assert.deepEqual(manifest.permissions.includes("storage"), true);
  assert.deepEqual(manifest.host_permissions, ["http://*/guthon/*", "https://*/guthon/*", "http://127.0.0.1/*"]);
  assert.deepEqual(manifest.content_scripts[0].matches, ["http://*/guthon/*", "https://*/guthon/*"]);
  assert.deepEqual(manifest.web_accessible_resources[0].matches, ["http://*/guthon/*", "https://*/guthon/*"]);
  assert.ok(manifest.web_accessible_resources[0].resources.includes("host-config.js"));
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
  assert.equal(pullScript.includes('"pull-hub-source"'), true);
  assert.equal(pullScript.includes('type: "save-pull-result"'), false);
  assert.equal(pullScript.includes('runPageCommand("pullProcedure"'), true);
});

test("data table page exposes table schema export action", () => {
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");
  const css = fs.readFileSync(BRIDGE_CSS_PATH, "utf8");
  const backgroundScript = fs.readFileSync(path.join(ROOT, "extension", "background.js"), "utf8");
  const pageBridge = fs.readFileSync(path.join(ROOT, "extension", "page-bridge.js"), "utf8");

  assert.equal(contentScript.includes("拉取表结构"), true);
  assert.equal(contentScript.includes("inspectTableSchemaTarget"), true);
  assert.equal(contentScript.includes('sendWorkspaceRequest("export-table-schema"'), true);
  assert.equal(contentScript.includes("isDataTableRoute"), true);
  assert.equal(contentScript.includes("positionFloatingRoot"), false);
  assert.equal(css.includes("left: 20px"), true);
  assert.equal(css.includes("bottom: 150px"), true);
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
  assert.equal(contentScript.includes('"export-bill-type"'), true);
  assert.equal(contentScript.includes("billTypeCodes"), true);
  assert.equal(backgroundScript.includes("/exportBillType"), true);
});

test("view management page exposes view source export action", () => {
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");
  const backgroundScript = fs.readFileSync(path.join(ROOT, "extension", "background.js"), "utf8");
  const pageBridge = fs.readFileSync(path.join(ROOT, "extension", "page-bridge.js"), "utf8");
  const refreshScript = contentScript.slice(
    contentScript.indexOf("async function refreshToolbarButtons"),
    contentScript.indexOf("function onExtensionMessage")
  );

  assert.equal(contentScript.includes("拉取视图源码"), true);
  assert.equal(contentScript.includes("isViewRoute"), true);
  assert.equal(refreshScript.includes("isViewRoute()"), true);
  assert.equal(contentScript.includes("inspectViewTarget"), true);
  assert.equal(contentScript.includes('"export-view-sql"'), true);
  assert.equal(backgroundScript.includes("/exportViewSql"), true);
  assert.equal(pageBridge.includes("getSelectedViewIds"), true);
  assert.equal(pageBridge.includes('mode: "views"'), true);
});

test("system script page exposes selected and all export actions", () => {
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");
  const backgroundScript = fs.readFileSync(path.join(ROOT, "extension", "background.js"), "utf8");
  const pageBridge = fs.readFileSync(path.join(ROOT, "extension", "page-bridge.js"), "utf8");

  assert.equal(contentScript.includes("isSystemScriptRoute"), true);
  assert.equal(contentScript.includes("installSystemScriptSelection"), true);
  assert.equal(contentScript.includes("选中拉取"), true);
  assert.equal(contentScript.includes("全部拉取"), true);
  assert.equal(contentScript.includes("inspectSystemScriptTarget"), true);
  assert.equal(contentScript.includes('"export-system-scripts"'), true);
  assert.equal(backgroundScript.includes("/exportSystemScripts"), true);
  assert.equal(pageBridge.includes("getCurrentSystemScriptTarget"), true);
  assert.equal(pageBridge.includes("getSelectedSystemScriptTypes"), true);
  assert.equal(pageBridge.includes('mode: "system-scripts"'), true);
});

test("pull button floats over the current Guthon toolbar without changing toolbar layout", () => {
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");
  const css = fs.readFileSync(BRIDGE_CSS_PATH, "utf8");

  assert.equal(contentScript.includes("positionBridgeRoot"), false);
  assert.equal(contentScript.includes("installTreeAutoScroll"), true);
  assert.equal(contentScript.includes("scrollIntoView?.({ block: \"center\", inline: \"nearest\" })"), true);
  assert.equal(contentScript.includes(".location-bnt"), true);
  assert.equal(contentScript.includes(".tool-menu.tool-box button"), true);
  assert.equal(css.includes(".guthon-bridge-inline"), true);
  assert.equal(css.includes("position: fixed"), true);
  assert.equal(contentScript.includes("guthon-bridge-inline-button"), true);
  assert.equal(contentScript.includes(".function.head"), true);
  assert.equal(contentScript.includes('document.querySelector(".procedure-script-editor")'), false);
});

test("copy mode button and overlay are available on module page editors", () => {
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");
  const css = fs.readFileSync(BRIDGE_CSS_PATH, "utf8");
  const pageBridge = fs.readFileSync(path.join(ROOT, "extension", "page-bridge.js"), "utf8");
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
  assert.equal(css.includes("flex-direction: column"), true);
  assert.equal(css.includes("display: inline-flex"), true);
  assert.equal(css.includes("min-width: 108px"), true);
  assert.equal(css.includes("background: #409eff"), true);
  assert.equal(css.includes("bottom: calc(100% + 8px)"), true);
  assert.equal(css.includes("user-select: text"), true);
  assert.equal(css.includes("width: 140px"), true);
  assert.equal(css.includes("word-break: break-all"), true);
  assert.equal(contentScript.includes("installFloatingDrag"), false);
  assert.equal(contentScript.includes("pullCurrentProcedure(root, sourceButton)"), true);
  assert.equal(contentScript.includes('isModuleRoute() ? "inspect-hub-source" : "inspectCurrentProcedure"'), true);
  assert.equal(contentScript.includes('const pageSource = isModuleRoute() || target.mode === "page-source";'), true);
  assert.equal(contentScript.includes('root.dataset.workspaceMode !== "database"'), true);
  assert.equal(contentScript.includes('sourceButton.hidden = true'), true);
  assert.equal(contentScript.includes('svnMode && previousMode !== "svn"'), true);
  assert.equal(contentScript.includes('allowWorkspaceSelection = true'), true);
  assert.equal(contentScript.includes('allowWorkspaceSelection: false'), true);
  assert.equal(contentScript.includes('const candidateModes = new Set'), true);
  assert.equal(contentScript.includes('location.pathname}${location.hash}#${root.dataset.mode'), true);
  assert.equal(contentScript.includes('window.addEventListener("hashchange", refreshToolbarButtonsSafely)'), true);
  assert.equal(contentScript.includes('window.addEventListener("popstate", refreshToolbarButtonsSafely)'), true);
  assert.equal(contentScript.includes('const PAGE_CONTEXT_HEARTBEAT_MS = 60000'), true);
  assert.equal(contentScript.includes('setInterval(() => {void publishPageContext().catch(() => {});}, PAGE_CONTEXT_HEARTBEAT_MS)'), true);
  assert.equal(contentScript.includes('if (!pageSource && !target.procedureId)'), true);
  assert.equal(contentScript.includes('sourceType: pageSource ? "page" : "procedure"'), true);
  assert.equal(css.includes('.guthon-bridge-inline [hidden]'), true);
  assert.equal(css.includes('display: none !important'), true);
  assert.equal(contentScript.includes('runPageCommand("collectModuleCopyText")'), true);
  assert.equal(contentScript.includes("collectModulePageFields"), false);
  assert.equal(contentScript.includes("guthon-bridge-copy-overlay"), true);
  assert.equal(pageBridge.includes("当前页面编码"), true);
  assert.equal(contentScript.includes("findCurrentPageToolbar"), false);
  assert.equal(pageBridge.includes("collectControlFields"), true);
  assert.equal(pageBridge.includes(".el-table"), true);
  assert.equal(pageBridge.includes("vm = vm.$parent"), true);
  assert.equal(contentScript.includes("复制模式只支持模块开发页面"), true);
  assert.equal(pageBridge.includes("readElementName"), true);
  assert.equal(pageBridge.includes("字段: ${field.field"), true);
  assert.equal(contentScript.includes("guthon-bridge-copy-text"), true);
  assert.equal(contentScript.includes("guthon-bridge-field-table"), true);
  assert.equal(contentScript.includes("guthon-bridge-cell-value"), true);
  assert.equal(contentScript.includes("pingPageBridge"), true);
  assert.equal(contentScript.includes("guthon-bridge-copy-minimize"), true);
  assert.equal(contentScript.includes("panel.dataset.minimized = String(minimized)"), true);
  assert.equal(css.includes('[data-minimized="true"]'), true);
  assert.equal(contentScript.includes('minimizeButton.textContent = minimized ? "展开" : "缩小";'), true);
  assert.equal(contentScript.includes("installCopyOverlayInteractions"), true);
  assert.equal(contentScript.includes("guthon-bridge-resize-handle"), true);
  assert.equal(css.includes("cursor: col-resize"), true);
  assert.equal(css.includes("cursor: move"), true);
  assert.equal(contentScript.includes('panel.style.position = "fixed";'), true);
  assert.equal(css.includes("max-width: 1450px"), true);
  assert.equal(css.includes("text-overflow: ellipsis"), true);
  assert.equal(css.includes("white-space: nowrap"), true);
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
  assert.equal(contentScript.includes('style.dataset.version = "20260723c"'), false);
  assert.equal(css.includes('.guthon-bridge-inline:not([data-mode="module"]) .guthon-bridge-module-only {\n  display: none;'), true);
  assert.equal(contentScript.includes("root.dataset.positioned"), false);
  assert.equal(contentScript.includes('root.dataset.sharedButtons = "true"'), true);
  assert.equal(contentScript.includes("exportCurrentTableSchema(root, sourceButton)"), true);
  assert.equal(contentScript.includes("exportCurrentBillType(root, sourceButton)"), true);
  assert.equal(contentScript.includes("stopExtensionLoops();"), true);

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
  assert.equal(pageBridge.includes("function getPageCodeFromVue"), true);
  assert.equal(pageBridge.includes("function readPageCodeFromVm"), true);
  assert.equal(pageBridge.includes("vm?.pageId || vm?.pageCode"), true);
  assert.equal(pageBridge.includes("getPageCodeFromVue() || getPageCodeFromUrl()"), true);
  assert.equal(pageBridge.includes('resolvedBy: "module-page-code"'), true);
  assert.equal(pageBridge.includes('location.hash.includes("?")'), true);
  assert.equal(contentScript.includes('?v=20261003'), true);
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
  assert.equal(fs.readFileSync(BRIDGE_CSS_PATH, "utf8").includes("z-index: 2147483646"), true);
});

test("floating controls mount before workspace checks while commands inject the page bridge on demand", () => {
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");

  assert.equal(contentScript.includes("function getRuntime()"), true);
  assert.equal(contentScript.includes("globalThis.chrome?.runtime"), true);
  assert.equal(contentScript.includes("async function ensurePageBridge"), true);
  assert.equal(contentScript.includes("try {\n    await ensurePageBridge();"), true);
  assert.equal(contentScript.includes("return { ok: false, message: error?.message || String(error) };"), true);
  assert.equal(contentScript.includes('injectPageScript("fields-mover-core.js")'), true);
  assert.equal(contentScript.includes('injectPageScript("page-bridge.js")'), true);
  const refresh = contentScript.slice(contentScript.indexOf("async function refreshToolbarButtons()"),
    contentScript.indexOf("function refreshToolbarButtonsSafely()"));
  assert.ok(refresh.indexOf("installSourcePullButton();") < refresh.indexOf("await applyInlineWorkspaceMode();"));
  assert.equal(refresh.includes("await ensurePageBridge();"), false);
});

test("popup stores pairing settings and obtains the authorized export directory", () => {
  const popup = fs.readFileSync(POPUP_SCRIPT_PATH, "utf8");
  assert.ok(popup.includes('chrome.storage.local.set({ guthonBridgeToken: token, guthonBridgePort: port })'));
  assert.ok(popup.includes('outputDirEl.value = status.exportRoot'));
  assert.ok(fs.readFileSync(POPUP_HTML_PATH, "utf8").includes('readonly placeholder="连接 Bridge 后显示导出目录"'));
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
    location: { href: "https://gusen.steel56.com.cn/guthon/" },
    GuthonBridgeHost: require(HOST_CONFIG_PATH),
    CSS: { highlights: new Map() },
    Highlight: class Highlight {
      constructor(range) { this.range = range; }
    },
    NodeFilter: { SHOW_TEXT: 4 },
    document: {
      querySelectorAll: () => [],
      createElement: () => ({ remove() {} }),
      createTreeWalker: (root) => {
        let index = 0;
        return { nextNode: () => root.textNodes[index++] || null };
      },
      createRange: () => ({
        setStart(node, offset) { this.start = [node, offset]; },
        setEnd(node, offset) { this.end = [node, offset]; }
      }),
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
  const resolveDefinition = window.GuthonProcedureNavigation.resolveProcedureDefinitionTarget;
  const resolveDefinitionText = window.GuthonProcedureNavigation.resolveProcedureDefinitionText;
  const resolveLocal = window.GuthonProcedureNavigation.resolveLocalFunctionTarget;
  const isModifier = window.GuthonProcedureNavigation.isProcedureNavigationModifier;
  const exactProcedure = window.GuthonProcedureNavigation.resolveProcedure;
  const procedures = [{procedureId: 'PR-1', procedureAliasId: 'demo.pkg', procedureName: '中文包', funId: 'save', dataSourceId: 'DS-1'},
    {procedureId: 'PR-2', procedureAliasId: 'demo.pkg.extra', funId: 'save', dataSourceId: 'DS-1'}];
  assert.equal(exactProcedure(procedures, 'demo.pkg', 'save', true).procedureId, 'PR-1');
  assert.equal(exactProcedure(procedures, 'demo.pkg', 'save', true).procedureName, 'demo.pkg');
  procedures.push({...procedures[0], procedureId: 'PR-3', dataSourceId: 'DS-2'});
  assert.throws(() => exactProcedure(procedures, 'demo.pkg', 'save', true), /多个精确候选/);
  assert.equal(exactProcedure(procedures, 'demo.pkg', 'save', true, 'DS-2').procedureId, 'PR-3');
  assert.throws(() => exactProcedure(procedures, 'demo.pkg', 'save', true, 'DS-3'), /未找到/);
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
  const definition = "function com.golden.demo.common.saveForecast() {";
  assert.deepEqual(
    { ...resolveDefinition(definition, definition.indexOf("saveForecast")) },
    { procedureKeyword: "com.golden.demo.common", funId: "saveForecast" }
  );
  assert.deepEqual(
    { ...resolveDefinitionText(definition) },
    { procedureKeyword: "com.golden.demo.common", funId: "saveForecast" }
  );
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
  const titleClasses = new Set();
  const titleName = { textContent: "com.golden.demo.common.saveForecast" };
  const titleLine = {
    textContent: `function ${titleName.textContent}($form) { // 注释`,
    textNodes: [
      { textContent: "function " },
      titleName,
      { textContent: "($form) { // 注释" }
    ],
    classList: {
      add: (name) => titleClasses.add(name),
      remove: (name) => titleClasses.delete(name)
    }
  };
  window.GuthonProcedureNavigation.highlightProcedureTitle(titleLine);
  const titleRange = context.CSS.highlights.get("guthon-procedure-title-link").range;
  assert.deepEqual(titleRange.start, [titleName, 0]);
  assert.deepEqual(titleRange.end, [titleName, titleName.textContent.length]);
  assert.equal(titleClasses.has("guthon-procedure-title-cursor"), true);
  let openedPage = null;
  const moduleVm = {
    $options: { name: "gdpaas_dev_modules" },
    onOpenPage(page) { openedPage = page; }
  };
  const page = { pageId: "PG-1", pageName: "调用页面" };
  const treeVm = { $parent: moduleVm, modules: [{ children: [page] }] };
  context.document.getElementById = () => null;
  context.document.querySelectorAll = () => [
    { __vue__: { $router: { push: async () => {} } } },
    { __vue__: treeVm }
  ];
  await window.GuthonProcedureNavigation.openModuleCaller({ source_id: "PG-1" });
  assert.equal(openedPage, page);
  const otherTree = {modules: [{pageId: 'PG-1'}], $parent: moduleVm};
  context.document.querySelectorAll = () => [
    {__vue__: {$router: {push: async () => {}}}}, {__vue__: treeVm}, {__vue__: otherTree},
  ];
  await assert.rejects(() => window.GuthonProcedureNavigation.openModuleCaller({source_id: 'PG-1', exact: true}), /多个精确 PAGE 候选/);
  let treeNode = null;
  let located = null;
  const openedNodes = [];
  const developVm = {
    dataSourceId: "",
    openTabs: [],
    getScriptTreeNode: () => treeNode,
    parseProcFunInfo: (_procedure, fun) => ({ id: `PR-1@${fun.funId}`, data: fun }),
    handleNodeClick(node) {
      openedNodes.push(node);
      if (!this.openTabs.some((tab) => tab.id === node.id)) {
        this.openTabs.push(node);
      }
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
  assert.equal(openedNodes.length, 2);
  assert.equal(openedNodes[1], treeNode);
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
    offsetWidth: 1,
    __vue__: { editor: { getValue: () => "button-unsaved" } },
    closest: () => buttonWrapper
  });
  assert.equal(buttonClasses.has("guthon-minimized-script-editor"), true);
  await restore({ preventDefault() {}, stopPropagation() {} });
  assert.equal(buttonEditorOpened, true);
  assert.equal(buttonRestoredText, "button-unsaved");
  assert.equal(buttonClasses.size, 0);
  buttonEditorOpened = false;
  window.GuthonProcedureNavigation.minimizeScriptEditor({
    __vue__: { editor: { getValue: () => "button-hidden" } },
    closest: () => buttonWrapper
  });
  await restore({ preventDefault() {}, stopPropagation() {} });
  assert.equal(buttonEditorOpened, true);
  assert.equal(buttonClasses.size, 0);
  window.GuthonProcedureNavigation.minimizeScriptEditor({
    offsetWidth: 1,
    __vue__: { editor: { getValue: () => "button-unsaved" } },
    closest: () => buttonWrapper
  });
  closeBar({ preventDefault() {}, stopPropagation() {} });
  assert.equal(buttonEditorClosed, true);
  assert.equal(buttonClasses.size, 0);
  assert.equal(pageBridge.includes('document.addEventListener("contextmenu", onContextMenu, true)'), true);
  assert.equal(pageBridge.includes('document.addEventListener("mousemove", onProcedureTitleMove, true)'), true);
  assert.equal(fs.readFileSync(BRIDGE_CSS_PATH, "utf8").includes("::highlight(guthon-procedure-title-link)"), true);
  assert.equal(pageBridge.includes("installScriptEditorMinimizeButtons();"), true);
  assert.equal(pageBridge.includes('document.querySelectorAll(".el-dialog__wrapper")'), true);
  assert.equal(pageBridge.includes('wrapper.querySelector(".script-editor")'), true);
  assert.equal(pageBridge.includes('button.className = "el-dialog__headerbtn guthon-script-editor-minimize"'), true);
  assert.equal(pageBridge.includes('icon.className = "el-dialog__close el-icon el-icon-minus"'), true);
  assert.equal(fs.readFileSync(BRIDGE_CSS_PATH, "utf8").includes(".el-dialog__wrapper .el-dialog__header .el-dialog__headerbtn.guthon-script-editor-minimize"), true);
  assert.equal(pageBridge.includes("const editor = editors.find(isVisible) || editors[0]"), true);
  assert.equal(pageBridge.includes("buttonSetup && !minimizedScriptEditor.editorWasVisible"), true);
  assert.equal(pageBridge.includes("editor.onMouseMove?.("), true);
  assert.equal(fs.readFileSync(BRIDGE_CSS_PATH, "utf8").includes(".guthon-procedure-link"), true);
  assert.equal(pageBridge.includes("developVm.handleNodeClick(openNode)"), true);
  assert.equal(pageBridge.includes("developVm.loadProcTree(() =>"), true);
  assert.equal(pageBridge.includes("developVm.toLocation?.(treeNode)"), true);
});

test("page bridge does not mix stale fullName package with current function id", () => {
  const pageBridge = fs.readFileSync(path.join(ROOT, "extension", "page-bridge.js"), "utf8");
  const popupScript = fs.readFileSync(path.join(ROOT, "extension", "popup.js"), "utf8");

  assert.equal(pageBridge.includes("parsed.funId === funId"), true);
  assert.equal(pageBridge.includes("selectedFunId === titleInfo.funId"), true);
  assert.equal(pageBridge.includes('resolvedBy: "selected-tab-id"'), true);
  assert.equal(pageBridge.includes("selectedTab?.panel"), true);
  assert.equal(popupScript.includes("function inspectCurrentProcedureContext"), false);
  assert.equal(popupScript.includes('type: "run-page-command"'), true);
  assert.equal(popupScript.includes("(!payload.sourceId && !payload.alias)"), true);
  assert.equal(pageBridge.includes('document.addEventListener("click", onProcedureTitleClick, true)'), true);
});

test("page bridge traverses deep cyclic Vue data without overflowing the call stack", () => {
  const pageBridge = fs.readFileSync(path.join(ROOT, "extension", "page-bridge.js"), "utf8");
  const helperSource = pageBridge.slice(
    pageBridge.indexOf("function walk"),
    pageBridge.indexOf("function getVueInstance")
  );
  const context = {};
  vm.runInNewContext(`${helperSource}\nglobalThis.walk = walk;\nglobalThis.findDeepFirst = findDeepFirst;`, context);
  const root = {};
  let current = root;
  for (let index = 0; index < 20000; index += 1) {
    current.next = {};
    current = current.next;
  }
  current.root = root;
  let visited = 0;
  context.walk(root, () => { visited += 1; });
  assert.equal(visited, 20001);

  root.pageId = "PG-1";
  Object.defineProperty(root.next, "blocked", {
    get() {
      throw new Error("findDeepFirst continued after finding pageId");
    }
  });
  assert.equal(context.findDeepFirst(root, ["pageId"]), "PG-1");
});

test("floating pull shows a visible diagnostic message", () => {
  const contentScript = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");

  assert.equal(contentScript.includes("guthon-bridge-message"), true);
  assert.equal(contentScript.includes("setMessage(root,"), true);
  assert.equal(contentScript.includes("}, 10000);"), true);
  assert.equal(contentScript.includes("console.error(\"谷神桥接：源码拉取失败\""), true);
});

test("Bridge pairing blocks web origins and unpaired writes and confines file mappings", async () => {
  const port = 17473;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-security-"));
  const server = spawn(process.execPath, ["bridge/server.js"], { cwd: ROOT, env: { ...process.env, GUTHON_TOOL_HOME: home, GUTHON_BRIDGE_PORT: String(port) }, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(port);
    const tokenPath = path.join(home, "var", "nexus", "bridge", "token");
    const token = fs.readFileSync(tokenPath, "utf8");
    assert.equal(token.length, 64);
    if (process.platform !== "win32") assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
    const payload = { objectKey: "demo#run", content: "body", metadata: { funId: "run", extension: "js" } };
    const post = (headers, body = payload) => fetch(`${url}/saveRemoteFile`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const denied = await post({});
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    assert.equal((await post({ Authorization: `Bearer ${token}`, Origin: "https://malicious.example" })).status, 403);
    assert.equal((await post({ Authorization: `Bearer ${token}`, "Content-Type": "text/plain" })).status, 415);
    assert.equal((await post({ Authorization: `Bearer ${token}` }, { ...payload, outputDir: os.tmpdir() })).status, 500);
    const saved = await (await post({ Authorization: `Bearer ${token}`, Origin: `chrome-extension://${"a".repeat(32)}` })).json();
    assert.equal(saved.ok, true);
    assert.equal(fs.readFileSync(saved.filePath, "utf8"), "body");
    const outside = path.join(home, "outside.txt");
    fs.writeFileSync(outside, "unchanged");
    fs.unlinkSync(saved.filePath);
    fs.symlinkSync(outside, saved.filePath);
    assert.equal((await post({ Authorization: `Bearer ${token}` })).status, 500);
    const read = await fetch(`${url}/readRemoteFile`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({objectKey:payload.objectKey}) });
    assert.equal(read.status, 403);
    assert.equal(fs.readFileSync(outside, "utf8"), "unchanged");
  } finally {
    await new Promise((resolve) => { server.once("exit", resolve); server.kill(); });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("force refresh dispatches only after typing the routed workspace key", async () => {
  const source = fs.readFileSync(POPUP_SCRIPT_PATH, "utf8");
  const body = source.slice(source.indexOf("async function runHubPull("), source.indexOf('pullPageBtn.addEventListener("click"'));
  const calls = [];
  const context = {
    resolveHubSourceTarget: async () => ({mode:"procedure",procedureId:"PR-1",procedureKeyword:"demo.pkg",funId:"save",dataSourceId:"DS1"}),
    getActiveTab: async () => ({id:1}),
    resolveWorkspaceSummary: async () => ({workspaceKey:"products.demo"}),
    sendWorkspaceRequest: async (type, payload) => { calls.push({type,payload}); return {ok:true}; },
    window: {prompt:()=>null}
  };
  vm.runInNewContext(`${body}\nglobalThis.pull = runHubPull;`,context);
  await assert.rejects(context.pull(true), /已取消强制刷新/);
  assert.equal(calls.length,0);
  context.window.prompt = () => "products.demo";
  await context.pull(true);
  assert.equal(calls[0].payload.confirmation,"products.demo");
  assert.equal(calls[0].payload.workspaceKey,"products.demo");
  context.window.prompt = () => { throw new Error("ordinary pull must not prompt"); };
  await context.pull(false);
  assert.equal(calls[1].payload.force,false);
});

test("source Bridge and packaged Nexus use the same generated ToolHost command metadata", () => {
  const source = fs.readFileSync(path.join(ROOT, "bridge/server.js"), "utf8");
  assert.ok(source.includes('const TOOL_CLIENT_MODULE = "../../GuthonNexus/gushen-vscode-completion/src/tool-process-client";'));
  assert.ok(source.includes('require(TOOL_CLIENT_MODULE)'));
  const authority = fs.readFileSync(path.resolve(ROOT, '../../scripts/common/command_metadata.json'));
  const bundled = fs.readFileSync(path.resolve(ROOT, '../GuthonNexus/gushen-vscode-completion/data/tool-command-metadata.json'));
  assert.ok(authority.equals(bundled), "Run Nexus npm run build:bridge to refresh metadata");
  const client = require('../../GuthonNexus/gushen-vscode-completion/src/tool-process-client');
  assert.equal(client.requestTimeoutMs('svn',['sync-from-script']),1800000);
  assert.equal(client.requestKind('svn',['auth-cache']),'write');
});


test("HTTP JSON preserves split UTF-8 code points and rejects invalid bytes", async () => {
  const { EventEmitter } = require("node:events");
  const { TextDecoder } = require("node:util");
  const source = fs.readFileSync(path.join(ROOT, "bridge/server.js"), "utf8");
  const body = source.slice(source.indexOf("function readBody("), source.indexOf("function pullLogRecord("));
  const context = { Buffer, TextDecoder, MAX_BODY_BYTES: 1024 * 1024, BODY_TIMEOUT_MS: 1000, setTimeout, clearTimeout };
  vm.runInNewContext(`${body}\nglobalThis.read = readBody;`, context);
  const request = new EventEmitter();
  request.destroy = () => {};
  const pending = context.read(request);
  const input = Buffer.from(JSON.stringify({ content: "谷神测试🌙" }));
  for (const byte of input) request.emit("data", Buffer.from([byte]));
  request.emit("end");
  assert.equal((await pending).content, "谷神测试🌙");
  const invalid = new EventEmitter();
  invalid.destroy = () => {};
  const failed = context.read(invalid);
  invalid.emit("data", Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
  invalid.emit("end");
  await assert.rejects(failed, /encoded data was not valid/);
});


test("platform page feedback never exposes local paths or raw exception details", () => {
  const script = fs.readFileSync(CONTENT_SCRIPT_PATH, "utf8");
  const helper = script.slice(script.indexOf("function pageActionError("), script.indexOf("function isVisible("));
  const context = {};
  vm.runInNewContext(`${helper}\nglobalThis.feedback = pageActionError;`, context);
  assert.equal(context.feedback({ message: "permission denied /Users/private/path password=secret" }).includes("private"), false);
  assert.match(context.feedback({ message: "配对令牌无效 /Users/private" }), /扩展弹窗/);
  assert.equal(script.includes("pullResult.workCopyPath"), false);
  assert.equal(script.includes("result.outputDir"), false);
  assert.equal(/console\.error\([^\n]*, error\)/.test(script), false);
});

test('durable Bridge jobs acknowledge promptly, enforce identity, deduplicate and never replay after restart', async()=>{
  const port=17476;const home=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-jobs-'));const tool=path.join(home,'tool.js');const count=path.join(home,'executions');const pidPath=path.join(home,'host-pid');
  fs.writeFileSync(tool,`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.stdout.write(JSON.stringify({type:'ready',protocolVersion:1})+'\\n');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.command==='route'){process.stdout.write(JSON.stringify({id:r.id,type:'result',ok:true,result:{ok:true,workspaceKey:r.input.workspaceKey}})+'\\n');return;}fs.appendFileSync(${JSON.stringify(count)},'execute\\n');setTimeout(()=>process.stdout.write(JSON.stringify({id:r.id,type:'result',ok:true,result:{ok:true,workspaceKey:r.workspaceKey,message:'finished'}})+'\\n'),r.input.alias==='slow'?10000:200);});`);
  const start=()=>spawn(process.execPath,['bridge/server.js'],{cwd:ROOT,env:{...process.env,GUTHON_TOOL_HOME:home,GUTHON_BRIDGE_PORT:String(port),GUTHON_TOOL_PATH:process.execPath,GUTHON_TOOL_ENTRY:tool},stdio:'ignore'});
  let server=start();
  const stop=async(signal)=>{if(server.exitCode===null)await new Promise(resolve=>{server.once('exit',resolve);server.kill(signal);});};
  try{
    await waitForHealth(port);
    const token=fs.readFileSync(path.join(home,'var/nexus/bridge/token'),'utf8');
    const post=async(route,body)=>{const response=await fetch(`http://127.0.0.1:${port}${route}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,...await response.json()};};
    const body={requestId:`${Date.now()}_${require('node:crypto').randomUUID()}`,workspaceKey:'products.demo',pageOrigin:'https://gusen.steel56.com.cn',operation:'pull-hub-source',payload:{sourceType:'procedure',alias:'demo',funId:'save'}};
    const first=await post('/submitJob',body);assert.equal(first.status,202);assert.equal(first.state,'QUEUED');
    const duplicate=await post('/submitJob',body);assert.equal(duplicate.jobId,first.jobId);
    assert.equal((await post('/submitJob',{...body,payload:{...body.payload,funId:'other'}})).status,400);
    assert.equal((await post('/jobStatus',{...body,workspaceKey:'projects.other'})).status,404);
    let done;for(let attempt=0;attempt<30;attempt++){done=await post('/jobStatus',body);if(done.state==='COMPLETED')break;await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal(done.state,'COMPLETED');assert.equal(fs.readFileSync(count,'utf8').trim().split('\n').length,1);
    const slow={...body,requestId:`${Date.now()}_${require('node:crypto').randomUUID()}`,payload:{...body.payload,alias:'slow'}};
    await post('/submitJob',slow);for(let attempt=0;attempt<30;attempt++){if((await post('/jobStatus',slow)).state==='RUNNING')break;await new Promise(resolve=>setTimeout(resolve,20));}
    // RUNNING marks queue dispatch; wait for host execution evidence before the
    // crash so the replay assertion has a deterministic execution boundary.
    const executionDeadline = Date.now() + 3000;
    while (fs.readFileSync(count, 'utf8').trim().split('\n').length < 2 && Date.now() < executionDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(fs.readFileSync(count, 'utf8').trim().split('\n').length, 2);
    await stop('SIGKILL');try{process.kill(Number(fs.readFileSync(pidPath,'utf8')),'SIGKILL');}catch{}
    server=start();await waitForHealth(port);
    assert.equal((await post('/jobStatus',slow)).state,'UNKNOWN');assert.equal((await post('/submitJob',slow)).state,'UNKNOWN');
    assert.equal(fs.readFileSync(count,'utf8').trim().split('\n').length,2);
  }finally{await stop();fs.rmSync(home,{recursive:true,force:true});}
});

test('explicit workspaces execute concurrently in separate hosts while each workspace stays serial',async()=>{
 const port=17479;const home=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-parallel-'));
 const tool=path.join(home,'tool.js');const events=path.join(home,'events.ndjson');
 fs.writeFileSync(tool,`const fs=require('node:fs');process.stdout.write(JSON.stringify({type:'ready',protocolVersion:1})+'\\n');
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
 if(r.command==='route'){process.stdout.write(JSON.stringify({id:r.id,type:'result',ok:true,result:{ok:true,workspaceKey:r.input.workspaceKey}})+'\\n');return;}
 fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({phase:'start',key:r.workspaceKey,alias:r.input.alias,pid:process.pid})+'\\n');
 setTimeout(()=>{fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({phase:'end',key:r.workspaceKey,alias:r.input.alias,pid:process.pid})+'\\n');
 process.stdout.write(JSON.stringify({id:r.id,type:'result',ok:true,result:{ok:true,workspaceKey:r.workspaceKey}})+'\\n');},r.input.alias==='first'?300:20);});`);
 const server=spawn(process.execPath,['bridge/server.js'],{cwd:ROOT,env:{...process.env,GUTHON_TOOL_HOME:home,GUTHON_BRIDGE_PORT:String(port),GUTHON_TOOL_PATH:process.execPath,GUTHON_TOOL_ENTRY:tool},stdio:'ignore'});
 try {
  await waitForHealth(port);const token=fs.readFileSync(path.join(home,'var/nexus/bridge/token'),'utf8');
  const post=async(route,body)=>await(await fetch(`http://127.0.0.1:${port}${route}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
  const job=(key,alias)=>({requestId:`${Date.now()}_${require('node:crypto').randomUUID()}`,workspaceKey:key,pageOrigin:'https://gusen.steel56.com.cn',operation:'pull-hub-source',payload:{sourceType:'procedure',alias,funId:'save'}});
  const requests=[job('products.first','first'),job('products.first','second'),job('projects.other','other')];
  await Promise.all(requests.map(request=>post('/submitJob',request)));
  for(let attempt=0;attempt<60;attempt++) {
   const status=await Promise.all(requests.map(request=>post('/jobStatus',request)));
   if(status.every(value=>value.state==='COMPLETED'))break;
   if(attempt===59)throw new Error('Parallel jobs did not finish');
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  const rows=fs.readFileSync(events,'utf8').trim().split('\n').map(JSON.parse);
  const index=(phase,alias)=>rows.findIndex(row=>row.phase===phase && row.alias===alias);
  assert.ok(index('end','other')<index('end','first'));
  assert.ok(index('start','second')>index('end','first'));
  assert.notEqual(rows.find(row=>row.alias==='first').pid,rows.find(row=>row.alias==='other').pid);
 } finally {
  if(server.exitCode===null)await new Promise(resolve=>{server.once('exit',resolve);server.kill('SIGTERM');});
  fs.rmSync(home,{recursive:true,force:true});
 }
});


test('one data home has one live Bridge owner and malformed job receipts stay unknown',async()=>{
 const crypto=require('node:crypto');const http=require('node:http');
 const socket=http.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-instance-'));const requestId=`${Date.now()}_${crypto.randomUUID()}`;const workspaceKey='products.demo';const pageOrigin='https://gusen.steel56.com.cn';
 const id=crypto.createHash('sha256').update(JSON.stringify([requestId,workspaceKey,pageOrigin])).digest('hex');const jobs=path.join(home,'var/nexus/bridge/jobs');fs.mkdirSync(jobs,{recursive:true});fs.writeFileSync(path.join(jobs,id+'.json'),'{broken');
 const options={cwd:ROOT,env:{...process.env,GUTHON_TOOL_HOME:home,GUTHON_BRIDGE_PORT:String(port)},stdio:['ignore','pipe','pipe']};
 const owner=spawnChild(process.execPath,['bridge/server.js'],options);let ownerErrors='';owner.stderr.on('data',data=>ownerErrors+=data.toString());
 try{
  await waitForHealth(port);const reused=spawnChild(process.execPath,['bridge/server.js'],options);let output='';reused.stdout.on('data',data=>output+=data.toString());
  const reusedExit=await new Promise(resolve=>reused.once('exit',resolve));assert.equal(reusedExit,0,ownerErrors);assert.match(output,/BRIDGE_REUSE/);
  const token=fs.readFileSync(path.join(home,'var/nexus/bridge/token'),'utf8');const status=await (await fetch(`http://127.0.0.1:${port}/status`,{headers:{Authorization:`Bearer ${token}`}})).json();assert.equal(status.invalidJobRecords.length,1);
  const state=await (await fetch(`http://127.0.0.1:${port}/jobStatus`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({requestId,workspaceKey,pageOrigin})})).json();assert.equal(state.state,'UNKNOWN');
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).ok,true);
 }finally{owner.kill('SIGTERM');await new Promise(resolve=>owner.once('exit',resolve));fs.rmSync(home,{recursive:true,force:true});}
});

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.GUTHON_BRIDGE_PORT || 17361);
const ROOT = path.resolve(__dirname, "..", "..", "..");
const BRIDGE_ROOT = __dirname;
const WORKSPACE_DIR = path.join(BRIDGE_ROOT, "workspace", "procedures");
const MANIFEST_PATH = path.join(BRIDGE_ROOT, "workspace", "manifest.json");
const DEFAULT_HUB_PYTHON = path.join(ROOT, ".venv", "bin", "python");
const HUB_PYTHON = process.env.GUTHON_HUB_PYTHON || (fs.existsSync(DEFAULT_HUB_PYTHON) ? DEFAULT_HUB_PYTHON : "python3");
const HUB_PULL_SCRIPT = process.env.GUTHON_HUB_PULL_SCRIPT || path.join(ROOT, "scripts", "pull_source_to_work_copy.py");
const TABLE_SCHEMA_SCRIPT = process.env.GUTHON_TABLE_SCHEMA_SCRIPT || path.join(ROOT, "scripts", "export_table_schema_sql.py");
const BILL_TYPE_SCRIPT = process.env.GUTHON_BILL_TYPE_SCRIPT || path.join(ROOT, "scripts", "export_bill_type_sql.py");
const VIEW_SQL_SCRIPT = process.env.GUTHON_VIEW_SQL_SCRIPT || path.join(ROOT, "scripts", "export_view_sql.py");
const SYSTEM_SCRIPT_EXPORT_SCRIPT = process.env.GUTHON_SYSTEM_SCRIPT_EXPORT_SCRIPT || path.join(ROOT, "scripts", "export_system_script_sql.py");
const HUB_QUERY_SCRIPT = process.env.GUTHON_HUB_QUERY_SCRIPT || path.join(ROOT, "scripts", "query_hub_context.py");
const PULL_LOG_PATH = process.env.GUTHON_PULL_LOG_PATH || path.join(ROOT, "var", "runtime", "logs", "pull-log.ndjson");

fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeManifest(manifest) {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

function sanitizeSegment(input) {
  return String(input || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}

function buildFilePath(payload) {
  const outputDir = String(payload.outputDir || "").trim();
  if (!outputDir) {
    throw new Error("缺少保存目录");
  }
  if (!path.isAbsolute(outputDir)) {
    throw new Error("保存目录必须是绝对路径");
  }

  const funId = payload.metadata?.funId || "unknownFun";
  const ext = payload.metadata?.extension || "java";
  fs.mkdirSync(outputDir, { recursive: true });
  return path.join(outputDir, `${sanitizeSegment(funId)}.${ext}`);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function pullLogRecord({ pullType, trigger = "manual", summary = {}, payload = {}, result = {}, ok = true, message = "" }, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(now).map(({ type, value }) => [type, value])
  );
  return {
    time: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
    trigger,
    pullType,
    ok: Boolean(ok),
    summary,
    payload,
    result,
    message
  };
}

function appendPullLog(options) {
  fs.mkdirSync(path.dirname(PULL_LOG_PATH), { recursive: true });
  const record = pullLogRecord(options);
  fs.appendFileSync(PULL_LOG_PATH, `${JSON.stringify(record)}\n`, "utf8");
}

function sourceSummary(payload, result = {}) {
  const summary = {
    sourceType: payload.sourceType || "",
    sourceId: payload.sourceId || "",
    alias: payload.alias || "",
    funId: payload.funId || "",
    changed: result.changed ?? "",
    pulled: result.pulled ?? "",
    workCopyPath: result.workCopyPath || "",
    workCopyStatus: result.workCopyStatus || "",
    workCopyAction: result.workCopyAction || "",
    localChanged: result.localChanged ?? ""
  };
  if ("gitAddStatus" in result) {
    summary.gitAddStatus = result.gitAddStatus;
    summary.gitAdded = result.gitAdded ?? 0;
  }
  return summary;
}

function tableSchemaSummary(payload, result = {}) {
  return {
    dataSourceId: payload.dataSourceId || "",
    tableIds: Array.isArray(payload.tableIds) ? payload.tableIds : [],
    exported_table_count: result.exported_table_count ?? "",
    outputDir: result.outputDir || ""
  };
}

function billTypeSummary(payload, result = {}) {
  return {
    dataSourceIds: Array.isArray(payload.dataSourceIds) ? payload.dataSourceIds : [],
    billTypeCodes: Array.isArray(payload.billTypeCodes) ? payload.billTypeCodes : [],
    exported_bill_type_count: result.exported_bill_type_count ?? "",
    outputDir: result.outputDir || ""
  };
}

function viewSqlSummary(payload, result = {}) {
  return {
    dataSourceIds: Array.isArray(payload.dataSourceIds) ? payload.dataSourceIds : [],
    viewIds: Array.isArray(payload.viewIds) ? payload.viewIds : [],
    exported_view_count: result.exported_view_count ?? "",
    outputDir: result.outputDir || ""
  };
}

function systemScriptSummary(payload, result = {}) {
  return {
    systemIds: Array.isArray(payload.systemIds) ? payload.systemIds : [],
    scriptTypes: Array.isArray(payload.scriptTypes) ? payload.scriptTypes : [],
    exported_system_script_count: result.exported_system_script_count ?? "",
    workCopyPaths: Array.isArray(result.work_copy_paths) ? result.work_copy_paths : [],
    outputDir: result.outputDir || ""
  };
}

function runJsonCommand(args, errorLabel, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(HUB_PYTHON, args, {
      cwd: ROOT,
      env: { ...process.env, GUTHON_SUPPRESS_PULL_LOG: "1" },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || `${errorLabel}失败，退出码：${code}`).trim()));
        return;
      }
      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (error) {
        reject(new Error(`${errorLabel}返回的 JSON 无效：${error.message}`));
      }
    });
    if (input !== undefined) {
      child.stdin.end(JSON.stringify(input));
    }
  });
}

function runHubPull(payload) {
  return runJsonCommand([HUB_PULL_SCRIPT, "--json-stdin"], "源码拉取", payload);
}

function runTableSchemaExport(payload) {
  const args = [TABLE_SCHEMA_SCRIPT];
  if (payload.dataSourceId) {
    args.push("--data-source-ids", String(payload.dataSourceId));
  }
  if (Array.isArray(payload.tableIds) && payload.tableIds.length > 0) {
    args.push("--table-ids", payload.tableIds.join(","));
  }
  return runJsonCommand(args, "表结构拉取");
}

function runBillTypeExport(payload) {
  const args = [BILL_TYPE_SCRIPT];
  if (Array.isArray(payload.dataSourceIds) && payload.dataSourceIds.length > 0) {
    args.push("--data-source-ids", payload.dataSourceIds.join(","));
  }
  if (Array.isArray(payload.billTypeCodes) && payload.billTypeCodes.length > 0) {
    args.push("--bill-type-codes", payload.billTypeCodes.join(","));
  }
  return runJsonCommand(args, "单据类型拉取");
}

function runViewSqlExport(payload) {
  const args = [VIEW_SQL_SCRIPT];
  if (Array.isArray(payload.dataSourceIds) && payload.dataSourceIds.length > 0) {
    args.push("--data-source-ids", payload.dataSourceIds.join(","));
  }
  if (Array.isArray(payload.viewIds) && payload.viewIds.length > 0) {
    args.push("--view-ids", payload.viewIds.join(","));
  }
  return runJsonCommand(args, "视图源码拉取");
}

function runSystemScriptExport(payload) {
  const args = [SYSTEM_SCRIPT_EXPORT_SCRIPT];
  if (Array.isArray(payload.systemIds) && payload.systemIds.length > 0) {
    args.push("--system-ids", payload.systemIds.join(","));
  }
  if (Array.isArray(payload.scriptTypes) && payload.scriptTypes.length > 0) {
    args.push("--script-types", payload.scriptTypes.join(","));
    args.push("--workcopy");
  }
  return runJsonCommand(args, "系统脚本拉取");
}

function runProcedureCallers(payload) {
  const alias = String(payload.alias || "").trim();
  const funId = String(payload.funId || "").trim();
  if (!alias || !funId) {
    throw new Error("缺少过程别名或函数名");
  }
  return runJsonCommand(
    [HUB_QUERY_SCRIPT, "callers", "--alias", alias, "--fun", funId, "--limit", "100"],
    "调用方查询"
  );
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, {
      ok: true,
      workspaceDir: WORKSPACE_DIR,
      manifestPath: MANIFEST_PATH
    });
  }

  if (req.method === "POST" && req.url === "/saveRemoteFile") {
    try {
      const payload = await readBody(req);
      if (!payload.objectKey || typeof payload.content !== "string") {
        return sendJson(res, 400, { ok: false, message: "缺少对象标识或文件内容" });
      }
      const filePath = buildFilePath(payload);
      fs.writeFileSync(filePath, payload.content, "utf8");

      const manifest = readManifest();
      manifest[payload.objectKey] = {
        objectKey: payload.objectKey,
        filePath,
        outputDir: payload.outputDir,
        metadata: payload.metadata || {},
        updatedAt: new Date().toISOString()
      };
      writeManifest(manifest);

      return sendJson(res, 200, {
        ok: true,
        filePath,
        objectKey: payload.objectKey
      });
    } catch (error) {
      return sendJson(res, 500, { ok: false, message: error.message });
    }
  }

  if (req.method === "POST" && req.url === "/readRemoteFile") {
    try {
      const payload = await readBody(req);
      if (!payload.objectKey) {
        return sendJson(res, 400, { ok: false, message: "缺少对象标识" });
      }

      const manifest = readManifest();
      const entry = manifest[payload.objectKey];
      if (!entry) {
        return sendJson(res, 404, { ok: false, message: `未找到本地文件映射：${payload.objectKey}` });
      }
      if (!fs.existsSync(entry.filePath)) {
        return sendJson(res, 404, { ok: false, message: `本地文件不存在：${entry.filePath}` });
      }

      return sendJson(res, 200, {
        ok: true,
        objectKey: payload.objectKey,
        filePath: entry.filePath,
        content: fs.readFileSync(entry.filePath, "utf8"),
        metadata: entry.metadata || {}
      });
    } catch (error) {
      return sendJson(res, 500, { ok: false, message: error.message });
    }
  }

  if (req.method === "POST" && req.url === "/logPullFailure") {
    try {
      const payload = await readBody(req);
      appendPullLog({
        pullType: payload.pullType || "page-source",
        trigger: payload.trigger || "manual",
        summary: payload.summary || {},
        payload: payload.payload || {},
        ok: false,
        message: payload.message || "页面源码拉取失败"
      });
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, 500, { ok: false, message: error.message });
    }
  }

  if (req.method === "POST" && req.url === "/pullHubSource") {
    let payload = {};
    try {
      payload = await readBody(req);
      const result = await runHubPull(payload);
      appendPullLog({
        pullType: "source",
        summary: sourceSummary(payload, result),
        payload,
        result,
        ok: result?.ok
      });
      return sendJson(res, 200, result);
    } catch (error) {
      appendPullLog({
        pullType: "source",
        summary: sourceSummary(payload),
        payload,
        ok: false,
        message: error.message
      });
      return sendJson(res, 500, { ok: false, message: error.message });
    }
  }

  if (req.method === "POST" && req.url === "/exportTableSchema") {
    let payload = {};
    try {
      payload = await readBody(req);
      const result = await runTableSchemaExport(payload);
      appendPullLog({
        pullType: "database",
        summary: tableSchemaSummary(payload, result),
        payload,
        result,
        ok: result?.ok
      });
      return sendJson(res, 200, result);
    } catch (error) {
      appendPullLog({
        pullType: "database",
        summary: tableSchemaSummary(payload),
        payload,
        ok: false,
        message: error.message
      });
      return sendJson(res, 500, { ok: false, message: error.message });
    }
  }

  if (req.method === "POST" && req.url === "/exportBillType") {
    let payload = {};
    try {
      payload = await readBody(req);
      const result = await runBillTypeExport(payload);
      appendPullLog({
        pullType: "billtype",
        summary: billTypeSummary(payload, result),
        payload,
        result,
        ok: result?.ok
      });
      return sendJson(res, 200, result);
    } catch (error) {
      appendPullLog({
        pullType: "billtype",
        summary: billTypeSummary(payload),
        payload,
        ok: false,
        message: error.message
      });
      return sendJson(res, 500, { ok: false, message: error.message });
    }
  }

  if (req.method === "POST" && req.url === "/exportViewSql") {
    let payload = {};
    try {
      payload = await readBody(req);
      const result = await runViewSqlExport(payload);
      appendPullLog({
        pullType: "views",
        summary: viewSqlSummary(payload, result),
        payload,
        result,
        ok: result?.ok
      });
      return sendJson(res, 200, result);
    } catch (error) {
      appendPullLog({
        pullType: "views",
        summary: viewSqlSummary(payload),
        payload,
        ok: false,
        message: error.message
      });
      return sendJson(res, 500, { ok: false, message: error.message });
    }
  }

  if (req.method === "POST" && req.url === "/exportSystemScripts") {
    let payload = {};
    try {
      payload = await readBody(req);
      const result = await runSystemScriptExport(payload);
      appendPullLog({
        pullType: "system-scripts",
        summary: systemScriptSummary(payload, result),
        payload,
        result,
        ok: result?.ok
      });
      return sendJson(res, 200, result);
    } catch (error) {
      appendPullLog({
        pullType: "system-scripts",
        summary: systemScriptSummary(payload),
        payload,
        ok: false,
        message: error.message
      });
      return sendJson(res, 500, { ok: false, message: error.message });
    }
  }

  if (req.method === "POST" && req.url === "/queryProcedureCallers") {
    try {
      const payload = await readBody(req);
      return sendJson(res, 200, { ok: true, ...(await runProcedureCallers(payload)) });
    } catch (error) {
      return sendJson(res, 500, { ok: false, message: error.message });
    }
  }

  return sendJson(res, 404, { ok: false, message: "接口不存在" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`谷神桥接服务已启动：http://127.0.0.1:${PORT}`);
  console.log(`工作目录：${WORKSPACE_DIR}`);
});

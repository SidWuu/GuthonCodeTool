// GENERATED FILE - do not edit. Regenerate with: npm run build:bridge
// Source: plugins/GuthonBridge/bridge/server.js
const http = require("http");
const TOOL_CLIENT_MODULE = "../src/tool-process-client";
const { ToolProcessClient, WorkspaceQueue, WorkspaceToolPool } = require(TOOL_CLIENT_MODULE);
const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");
const {createPageContexts, snapshot} = require('./page-context');
const pageContexts = createPageContexts();

const MAX_BODY_BYTES = 1024 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const EXTENSION_WHITELIST = new Set(["java", "js", "gss", "sql", "json", "xml", "txt"]);

const PORT = Number(process.env.GUTHON_BRIDGE_PORT || 17361);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("Bridge 端口必须在 1 到 65535 之间");
const ROOT = path.resolve(__dirname, "..", "..", "..");
const HUB_TOOL_HOME = process.env.GUTHON_TOOL_HOME || "";
if (!HUB_TOOL_HOME || !path.isAbsolute(HUB_TOOL_HOME)) {
  throw new Error("GUTHON_TOOL_HOME 必须是显式本地数据目录绝对路径");
}
const BRIDGE_STATE_DIR = path.join(HUB_TOOL_HOME, "var", "nexus", "bridge");
const TOKEN_PATH = path.join(BRIDGE_STATE_DIR, "token");
if (process.env.GUTHON_BRIDGE_EXPORT_ROOT && !path.isAbsolute(process.env.GUTHON_BRIDGE_EXPORT_ROOT)) throw new Error("导出目录配置必须是绝对路径");
const configuredExportRoot = path.resolve(process.env.GUTHON_BRIDGE_EXPORT_ROOT || path.join(BRIDGE_STATE_DIR, "exports"));
fs.mkdirSync(configuredExportRoot, { recursive: true });
if (fs.lstatSync(configuredExportRoot).isSymbolicLink()) throw new Error("导出目录不能通过符号链接重定向");
const EXPORT_ROOT = fs.realpathSync(configuredExportRoot);
fs.mkdirSync(BRIDGE_STATE_DIR, { recursive: true, mode: 0o700 });
try {
  fs.writeFileSync(TOKEN_PATH, crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
if (fs.lstatSync(TOKEN_PATH).isSymbolicLink()) throw new Error("Bridge 令牌文件不能是符号链接");
const BRIDGE_TOKEN = fs.readFileSync(TOKEN_PATH, "utf8").trim();
if (!/^[a-f0-9]{64}$/.test(BRIDGE_TOKEN)) throw new Error("Bridge 配对令牌文件无效，请在停止服务后删除并重新生成");
fs.chmodSync(TOKEN_PATH, 0o600);
const INSTANCE_ID = crypto.randomUUID();
const INSTANCE_LOCK = path.join(BRIDGE_STATE_DIR, "instance.lock");
const bridgeCode = fs.readFileSync(__filename,"utf8")
  .replace(/^\/\/ GENERATED FILE[^\n]*\n\/\/ Source:[^\n]*\n/,"")
  .replace(/^const TOOL_CLIENT_MODULE = .*;$/m, 'const TOOL_CLIENT_MODULE = "tool-process-client";');
const toolClientFile = require.resolve(TOOL_CLIENT_MODULE);
const libraryHashes = [require.resolve('./page-context'), toolClientFile, path.join(path.dirname(toolClientFile), 'workspace-scheduler.js'),
  path.join(path.dirname(toolClientFile), '../data/tool-command-metadata.json')]
  .map(file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
const runtimeFingerprint = crypto.createHash("sha256").update(JSON.stringify([
  process.env.GUTHON_TOOL_PATH || "", process.env.GUTHON_TOOL_ENTRY || "", process.env.GUTHON_TOOL_MODE || "packaged",
  crypto.createHash("sha256").update(bridgeCode).digest("hex"), libraryHashes
])).digest("hex");
function releaseInstanceLock() {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(INSTANCE_LOCK,"owner.json"),"utf8"));
    if(owner.instanceId !== INSTANCE_ID)return;
    fs.unlinkSync(path.join(INSTANCE_LOCK,"owner.json"));
    fs.rmdirSync(INSTANCE_LOCK);
  } catch { /* Preserve damaged/foreign lease evidence rather than deleting it. */ }
}
try {
  fs.mkdirSync(INSTANCE_LOCK,{mode:0o700});
} catch (error) {
  if(error.code !== "EEXIST")throw error;
  if(fs.lstatSync(INSTANCE_LOCK).isSymbolicLink())throw new Error("Bridge 实例锁不能是符号链接");
  const ownerPath=path.join(INSTANCE_LOCK,"owner.json");
  if(!fs.existsSync(ownerPath) || fs.statSync(ownerPath).size>4096)throw new Error("Bridge 实例锁损坏，请先核查后恢复");
  const owner=JSON.parse(fs.readFileSync(ownerPath,"utf8"));
  if(!Number.isInteger(owner.pid)||owner.pid<=0||typeof owner.instanceId!=="string")throw new Error("Bridge 实例锁身份无效");
  let alive=true;
  try { process.kill(owner.pid,0); } catch(e) { if(e.code==="ESRCH")alive=false;else if(e.code!=="EPERM")throw e; }
  if(alive) {
    if(owner.port!==PORT || owner.runtimeFingerprint!==runtimeFingerprint)throw new Error(`同一数据目录已有 Bridge 实例（端口 ${owner.port}），请核对原实例运行模式后再启动`);
    console.log("BRIDGE_REUSE " + JSON.stringify({port:owner.port,instanceId:owner.instanceId,pid:owner.pid}));
    process.exit(0);
  }
  if(fs.readdirSync(INSTANCE_LOCK).some(name=>name!=="owner.json"))throw new Error("Bridge 实例锁含未知文件，请人工核查");
  fs.unlinkSync(ownerPath);fs.rmdirSync(INSTANCE_LOCK);fs.mkdirSync(INSTANCE_LOCK,{mode:0o700});
}
fs.writeFileSync(path.join(INSTANCE_LOCK,"owner.json"),JSON.stringify({pid:process.pid,instanceId:INSTANCE_ID,port:PORT,runtimeFingerprint}),{flag:"wx",mode:0o600});
process.on("exit",releaseInstanceLock);
fs.writeFileSync(path.join(BRIDGE_STATE_DIR,"port.json"),JSON.stringify({port:PORT,instanceId:INSTANCE_ID}),{mode:0o600});
const MANIFEST_PATH = path.join(BRIDGE_STATE_DIR, "manifest.json");
const DEFAULT_HUB_PYTHON = path.join(ROOT, ".venv", "bin", "python");
const HUB_PYTHON = process.env.GUTHON_HUB_PYTHON || (fs.existsSync(DEFAULT_HUB_PYTHON) ? DEFAULT_HUB_PYTHON : "python3");
const HUB_TOOL = process.env.GUTHON_TOOL_PATH || "";
const HUB_TOOL_ENTRY = process.env.GUTHON_TOOL_ENTRY || "";
const HUB_TOOL_MODE = process.env.GUTHON_TOOL_MODE || "packaged";
const DEFAULT_TOOL_ENTRY = path.join(ROOT, "scripts", "guthon_tool.py");
const PULL_LOG_PATH = process.env.GUTHON_PULL_LOG_PATH || path.join(BRIDGE_STATE_DIR, "pull-log.ndjson");
const workspaceQueue = new WorkspaceQueue({limit:32,concurrency:4});
const toolProcessClient = new WorkspaceToolPool({limit:8,createClient:()=>new ToolProcessClient({
  env: { ...process.env, GUTHON_SUPPRESS_PULL_LOG: "1" },
})});

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return {};
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Bridge 文件映射无效，请先修复映射文件");
  return Object.assign(Object.create(null), manifest);
}

function writeManifest(manifest) {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  const temporary = `${MANIFEST_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, MANIFEST_PATH);
}

function sanitizeSegment(input) {
  return String(input || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}

function buildFilePath(payload) {
  const requested = payload.outputDir ? path.resolve(String(payload.outputDir)) : EXPORT_ROOT;
  const outputDir = fs.existsSync(requested) ? fs.realpathSync(requested) : requested;
  if (outputDir !== EXPORT_ROOT) throw new Error("保存目录必须使用 Bridge 本地配置的导出目录");
  fs.mkdirSync(EXPORT_ROOT, { recursive: true });
  if (fs.realpathSync(EXPORT_ROOT) !== EXPORT_ROOT) throw new Error("导出目录不能通过符号链接重定向");

  const funId = payload.metadata?.funId || "unknownFun";
  const ext = String(payload.metadata?.extension || "java");
  if (!EXTENSION_WHITELIST.has(ext)) {
    throw new Error("扩展名不受支持");
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `${sanitizeSegment(funId)}.${ext}`);
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) throw new Error("不能写入符号链接");
  return filePath;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("请求体读取超时"));
      req.destroy();
    }, BODY_TIMEOUT_MS);
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error("请求体过大"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
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
  const redact = (value) => {
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/(?:password|secret|token|credential|content|sql|stack)/i.test(key))
      .map(([key, item]) => [key, redact(item)]));
    return typeof value === "string" ? value.slice(0, 2000) : value;
  };
  if (fs.existsSync(PULL_LOG_PATH) && fs.statSync(PULL_LOG_PATH).size >= 5 * 1024 * 1024) {
    const previous = `${PULL_LOG_PATH}.1`;
    fs.rmSync(previous, { force: true });
    fs.renameSync(PULL_LOG_PATH, previous);
  }
  fs.appendFileSync(PULL_LOG_PATH, `${JSON.stringify(redact(record))}\n`, { encoding: "utf8", mode: 0o600 });
}

function sourceSummary(payload, result = {}) {
  const summary = {
    workspaceKey: payload.workspaceKey || result.workspaceKey || "",
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

function commandErrorMessage(errorLabel, output, code) {
  const message = String(output || "").trim();
  if (/(?:pymysql\.err\.(?:Operational|Interface)Error|psycopg\.(?:Operational|Interface)Error|CR_SERVER_LOST|Can't connect to MySQL server|Lost connection to MySQL server|connection (?:failed|refused)|server closed the connection unexpectedly|\((?:2003|2006|2013),)/i.test(message)) {
    return "无法连接源码数据库，请确认已连接公司内网或 VPN 后重试";
  }
  return message || `${errorLabel}失败，退出码：${code}`;
}

function runToolCommand(command, args, errorLabel, input, workspaceKey = "") {
  const executable = HUB_TOOL || HUB_PYTHON;
  const entry = HUB_TOOL ? HUB_TOOL_ENTRY : DEFAULT_TOOL_ENTRY;
  const home = HUB_TOOL_HOME;
  return toolProcessClient.request(
    { mode: HUB_TOOL_MODE, toolPath: executable, toolEntry: entry, toolHome: home },
    command, args, workspaceKey, input
  ).catch((error) => {
    throw new Error(commandErrorMessage(errorLabel, error.message));
  });
}

async function resolveRequestWorkspace(payload) {
  const route = await runToolCommand("route", [], "工作区路由", payload, payload.workspaceKey || "");
  if (route.ok && payload.workspaceKey && route.workspaceKey !== payload.workspaceKey) throw new Error("工作区路由不能改变已指定的工作区");
  return route;
}

function enqueue(action, workspaceKey='') {
  if (workspaceKey && !/^(products|projects)\.[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(workspaceKey)) return Promise.reject(new Error('工作区键无效'));
  return workspaceQueue.enqueue(workspaceKey || '__unresolved__',action);
}

async function runHubPull(payload) {
  const route = await resolveRequestWorkspace(payload);
  if (!route.ok) return route;
  const routed = { ...payload, workspaceKey: route.workspaceKey, client: "bridge-legacy-pull" };
  return runToolCommand("pull", [], "源码拉取", routed, route.workspaceKey);
}

async function runTableSchemaExport(payload) {
  const route = await resolveRequestWorkspace(payload);
  if (!route.ok) return route;
  const toolArgs = [];
  if (payload.dataSourceId) {
    toolArgs.push("--data-source-ids", String(payload.dataSourceId));
  }
  if (Array.isArray(payload.tableIds) && payload.tableIds.length > 0) {
    toolArgs.push("--table-ids", payload.tableIds.join(","));
  }
  return runToolCommand("export-schema", toolArgs, "表结构拉取", undefined, route.workspaceKey);
}

async function runBillTypeExport(payload) {
  const route = await resolveRequestWorkspace(payload);
  if (!route.ok) return route;
  const toolArgs = [];
  if (Array.isArray(payload.dataSourceIds) && payload.dataSourceIds.length > 0) {
    toolArgs.push("--data-source-ids", payload.dataSourceIds.join(","));
  }
  if (Array.isArray(payload.billTypeCodes) && payload.billTypeCodes.length > 0) {
    toolArgs.push("--bill-type-codes", payload.billTypeCodes.join(","));
  }
  return runToolCommand("export-bill-type", toolArgs, "单据类型拉取", undefined, route.workspaceKey);
}

async function runViewSqlExport(payload) {
  const route = await resolveRequestWorkspace(payload);
  if (!route.ok) return route;
  const toolArgs = [];
  if (Array.isArray(payload.dataSourceIds) && payload.dataSourceIds.length > 0) {
    toolArgs.push("--data-source-ids", payload.dataSourceIds.join(","));
  }
  if (Array.isArray(payload.viewIds) && payload.viewIds.length > 0) {
    toolArgs.push("--view-ids", payload.viewIds.join(","));
  }
  return runToolCommand("export-view", toolArgs, "视图源码拉取", undefined, route.workspaceKey);
}

async function runSystemScriptExport(payload) {
  const route = await resolveRequestWorkspace(payload);
  if (!route.ok) return route;
  const toolArgs = [];
  if (Array.isArray(payload.systemIds) && payload.systemIds.length > 0) {
    toolArgs.push("--system-ids", payload.systemIds.join(","));
  }
  if (Array.isArray(payload.scriptTypes) && payload.scriptTypes.length > 0) {
    toolArgs.push("--script-types", payload.scriptTypes.join(","), "--workcopy");
  }
  return runToolCommand("export-system-script", toolArgs, "系统脚本拉取", undefined, route.workspaceKey);
}

async function runProcedureCallers(payload) {
  const alias = String(payload.alias || "").trim();
  const funId = String(payload.funId || "").trim();
  if (!alias || !funId) {
    throw new Error("缺少过程别名或函数名");
  }
  const route = await resolveRequestWorkspace(payload);
  if (!route.ok) return route;
  const args = ["callers", "--alias", alias, "--fun", funId, "--limit", "100"];
  return runToolCommand("query", args, "调用方查询", undefined, route.workspaceKey);
}

function publicWorkspace(workspace) {
  if (!workspace) return workspace;
  return Object.fromEntries([
    "workspaceKey", "type", "id", "name", "displayName", "sourceMode", "capabilities", "status"
  ].filter((key) => workspace[key] !== undefined).map((key) => [key, workspace[key]]));
}

function publicRoute(route) {
  return {
    ...route,
    workspace: publicWorkspace(route.workspace),
    candidates: Array.isArray(route.candidates) ? route.candidates.map(publicWorkspace) : route.candidates,
  };
}

const JOB_OPERATIONS = {
  "pull-hub-source": { run: runHubPull, pullType: "source", summary: sourceSummary },
  "export-table-schema": { run: runTableSchemaExport, pullType: "database", summary: tableSchemaSummary },
  "export-bill-type": { run: runBillTypeExport, pullType: "billtype", summary: billTypeSummary },
  "export-view-sql": { run: runViewSqlExport, pullType: "views", summary: viewSqlSummary },
  "export-system-scripts": { run: runSystemScriptExport, pullType: "system-scripts", summary: systemScriptSummary },
  "query-procedure-callers": { run: runProcedureCallers },
};
const JOB_DIR = path.join(BRIDGE_STATE_DIR, "jobs");
const jobs = new Map();
const jobLoadErrors = [];
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
fs.mkdirSync(JOB_DIR, { recursive: true, mode: 0o700 });
if(fs.lstatSync(JOB_DIR).isSymbolicLink())throw new Error("任务记录目录不能是符号链接");
function writeJob(job) {
  const target = path.join(JOB_DIR, `${job.id}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(job), { mode: 0o600 });
  fs.renameSync(temporary, target);
}
// Durable identity records prevent automatic re-execution after a service crash.
// Old queued/running jobs are unknown; they are never enqueued on startup.
for (const name of fs.readdirSync(JOB_DIR)) {
  if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
  const target = path.join(JOB_DIR, name);
  let job;
  try {
    if(fs.lstatSync(target).isSymbolicLink() || fs.statSync(target).size>2*MAX_BODY_BYTES)throw new Error("invalid job file");
    job=JSON.parse(fs.readFileSync(target,"utf8"));
    if(job.id!==name.slice(0,-5) || requestJobIdentity(job)!==job.id || !Number.isSafeInteger(job.createdAt)
        || !Number.isSafeInteger(job.updatedAt) || !/^[a-f0-9]{64}$/.test(job.fingerprint || "")
        || !Object.hasOwn(JOB_OPERATIONS,job.operation) || !["QUEUED","RUNNING","COMPLETED","FAILED","UNKNOWN"].includes(job.state))throw new Error("invalid job identity/state");
  } catch {
    jobLoadErrors.push({jobId:name.slice(0,-5),code:"INVALID_JOB_RECORD"});
    continue;
  }
  if (Date.now() - job.createdAt > JOB_RETENTION_MS) { fs.unlinkSync(target); continue; }
  if (["QUEUED", "RUNNING"].includes(job.state)) {
    job.state = "UNKNOWN";
    job.message = "Bridge 已重启，任务结果未知；请检查工作副本或导出结果，不会自动重新执行";
    writeJob(job);
  }
  jobs.set(job.id, job);
}
function jobId(requestId, workspaceKey, pageOrigin) {
  return crypto.createHash("sha256").update(JSON.stringify([requestId, workspaceKey, pageOrigin])).digest("hex");
}
function requestJobIdentity(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("任务请求必须是 JSON 对象");
  const { requestId, workspaceKey, pageOrigin } = body;
  if (typeof requestId !== "string" || !/^\d{13}_[a-f0-9-]{36}$/.test(requestId)) throw new Error("任务请求标识无效");
  if (!/^(products|projects)\.[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(workspaceKey || "")) throw new Error("任务需要固定的工作区键");
  const origin = new URL(pageOrigin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== pageOrigin) throw new Error("任务页面来源无效");
  return jobId(requestId, workspaceKey, pageOrigin);
}
function publicJob(job) {
  return { ok: true, jobId: job.id, requestId: job.requestId, workspaceKey: job.workspaceKey,
    state: job.state, createdAt: job.createdAt, updatedAt: job.updatedAt,
    ...(job.result !== undefined ? { result: job.result } : {}), ...(job.message ? { message: job.message } : {}) };
}
function submitJob(body) {
  const id = requestJobIdentity(body);
  const operation = Object.hasOwn(JOB_OPERATIONS,body.operation) ? JOB_OPERATIONS[body.operation] : undefined;
  if (!operation) throw new Error("不支持的任务操作");
  if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) throw new Error("任务参数必须是 JSON 对象");
  const payload = { ...(body.payload || {}), workspaceKey: body.workspaceKey, pageOrigin: body.pageOrigin };
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify([body.operation, payload])).digest("hex");
  if(jobLoadErrors.some(record=>record.jobId===id))throw new Error("任务记录损坏，禁止重用请求标识或自动重放；请核查输出");
  const existing = jobs.get(id);
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new Error("同一请求标识不能用于不同操作或参数");
    return publicJob(existing);
  }
  const submittedAt = Number(body.requestId.split("_")[0]);
  if (Date.now() - submittedAt > 24 * 60 * 60 * 1000 || submittedAt > Date.now() + 60_000) throw new Error("请求标识已过期，禁止自动重放任务");
  for (const [key, job] of jobs) {
    if (Date.now() - job.createdAt > JOB_RETENTION_MS) { jobs.delete(key); fs.unlinkSync(path.join(JOB_DIR, `${key}.json`)); }
  }
  if (jobs.size >= 256 || workspaceQueue.size >= 32) throw new Error("Bridge 任务容量已满，请先等待或清理过期记录");
  const job = { id, requestId: body.requestId, workspaceKey: body.workspaceKey, pageOrigin: body.pageOrigin,
    fingerprint, operation: body.operation, state: "QUEUED", createdAt: Date.now(), updatedAt: Date.now() };
  writeJob(job);
  jobs.set(id, job);
  void enqueue(async () => {
    job.state = "RUNNING"; job.updatedAt = Date.now(); writeJob(job);
    try {
      // run implementations revalidate origin/identity against this fixed key
      // before any database command. A route result cannot retarget the job.
      const result = await operation.run(payload);
      if (result.workspaceKey && result.workspaceKey !== job.workspaceKey) throw new Error("任务工作区归属发生变化");
      if(Buffer.byteLength(JSON.stringify(result)) > MAX_BODY_BYTES) {
        job.state="UNKNOWN";job.message="任务已返回，但结果超过保存上限，请核对输出文件；禁止自动重放";
      } else {
        job.result = result;
        job.state = result.ok === false ? "FAILED" : "COMPLETED";
        job.message = result.message || "";
      }
      if (operation.pullType) appendPullLog({ pullType: operation.pullType, summary: operation.summary(payload, result), payload, result, ok: result.ok !== false });
    } catch (error) {
      job.state = /超时|结果未知|ToolHost 已退出|ToolHost 已停止/.test(error.message) ? "UNKNOWN" : "FAILED";
      job.message = error.message;
      if (operation.pullType) appendPullLog({ pullType: operation.pullType, summary: operation.summary(payload), payload, ok: false, message: error.message });
    }
    job.updatedAt = Date.now(); writeJob(job);
  }, job.workspaceKey).catch((error) => { job.state = "UNKNOWN"; job.message = error.message; job.updatedAt = Date.now(); writeJob(job); });
  return publicJob(job);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, { ok: true, instanceId: INSTANCE_ID });
  }

  // Chrome background requests carry the extension Origin; ordinary web origins
  // are rejected even if a copied token is presented. Native clients may omit Origin.
  const origin = req.headers.origin;
  if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
    return sendJson(res, 403, { ok: false, message: "不允许的请求来源" });
  }
  const supplied = Buffer.from(String(req.headers.authorization || ""));
  const expected = Buffer.from(`Bearer ${BRIDGE_TOKEN}`);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return sendJson(res, 401, { ok: false, message: "请在扩展弹窗中配置 Bridge 配对令牌" });
  }
  if (req.method === "GET" && req.url === "/status") {
    return sendJson(res, 200, { ok: true, port: PORT, instanceId: INSTANCE_ID, invalidJobRecords: jobLoadErrors.slice(0,20), exportRoot: EXPORT_ROOT, queueLength: workspaceQueue.size, activeWorkspaces: [...workspaceQueue.activeKeys].filter(key=>key!=="__unresolved__"), workspaceKey: workspaceQueue.activeKeys.size===1 ? ([...workspaceQueue.activeKeys][0]==="__unresolved__" ? "" : [...workspaceQueue.activeKeys][0]) : "" });
  }
  if (req.method === "OPTIONS") return sendJson(res, 403, { ok: false, message: "不支持网页跨域调用" });

  const requestUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === 'GET' && ['/events', '/pageContext', '/navigationResult'].includes(requestUrl.pathname)) {
    try {
      const params = Object.fromEntries(requestUrl.searchParams);
      if ([...requestUrl.searchParams.keys()].some(key => requestUrl.searchParams.getAll(key).length !== 1)) throw new Error('请求身份字段不能重复');
      if (requestUrl.pathname === '/events') return pageContexts.subscribe(res, params);
      if (requestUrl.pathname === '/pageContext') return sendJson(res, 200, {ok: true, contexts: pageContexts.list(params.workspaceKey)});
      return sendJson(res, 200, pageContexts.result(params));
    } catch (error) { return sendJson(res, 400, {ok: false, message: error.message}); }
  }

  if (req.method === "POST" && !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
    return sendJson(res, 415, { ok: false, message: "仅支持 JSON 请求" });
  }

  if (req.method === 'POST' && ['/pageContext', '/removePageContext', '/navigate', '/navigationResult'].includes(req.url)) {
    try {
      const payload = await readBody(req);
      if (req.url === '/pageContext') {
        const item = snapshot(payload);
        const route = await resolveRequestWorkspace(item);
        if (!route.ok) return sendJson(res, 200, publicRoute(route));
        if (route.workspaceKey !== item.workspaceKey) throw new Error('页面快照工作区身份不匹配');
        return sendJson(res, 200, {ok: true, context: pageContexts.publish(payload)});
      }
      if (req.url === '/removePageContext') {pageContexts.remove(payload.clientId, payload.tabId); return sendJson(res, 200, {ok: true});}
      if (req.url === '/navigationResult') return sendJson(res, 200, pageContexts.complete(payload));
      const context = pageContexts.get(payload.contextId, payload.workspaceKey);
      const route = await resolveRequestWorkspace(context);
      if (!route.ok || route.workspaceKey !== context.workspaceKey) throw new Error('页面身份已不属于目标工作区，请刷新平台上下文');
      return sendJson(res, 202, pageContexts.navigate(payload));
    } catch (error) { return sendJson(res, 400, {ok: false, message: error.message}); }
  }

  if (req.method === "POST" && ["/submitJob", "/jobStatus"].includes(req.url)) {
    try {
      const body = await readBody(req);
      const id = requestJobIdentity(body);
      if (req.url === "/submitJob") return sendJson(res, 202, submitJob(body));
      const job = jobs.get(id);
      if (!job && jobLoadErrors.some(record=>record.jobId===id)) return sendJson(res,200,{ok:true,jobId:id,requestId:body.requestId,workspaceKey:body.workspaceKey,state:'UNKNOWN',message:'任务记录损坏，执行结果未知；请核查输出，禁止自动重放'});
      if (!job) return sendJson(res, 404, { ok: false, jobNotFound: true, message: "未找到任务记录，请保持请求标识并核查提交状态" });
      return sendJson(res, 200, publicJob(job));
    } catch (error) { return sendJson(res, 400, { ok: false, message: error.message }); }
  }

  if (req.method === "POST" && req.url === "/routeWorkspace") {
    try {
      const payload = await readBody(req);
      const route = await runToolCommand("route", [], "工作区路由", payload);
      return sendJson(res, 200, publicRoute(route));
    } catch (error) {
      return sendJson(res, 500, { ok: false, message: error.message });
    }
  }

  if (req.method === "POST" && req.url === "/saveRemoteFile") {
    try {
      const payload = await readBody(req);
      if (!payload.objectKey || typeof payload.content !== "string") {
        return sendJson(res, 400, { ok: false, message: "缺少对象标识或文件内容" });
      }
      const manifest = readManifest();
      const filePath = buildFilePath(payload);
      const temporary = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, payload.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, filePath);

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
      if (path.dirname(path.resolve(entry.filePath || "")) !== EXPORT_ROOT ||
          (fs.existsSync(entry.filePath) && fs.realpathSync(entry.filePath) !== path.resolve(entry.filePath))) {
        return sendJson(res, 403, { ok: false, message: "本地文件映射不在授权导出目录中" });
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
      const result = await enqueue(() => runHubPull(payload), payload.workspaceKey || "");
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
      const result = await enqueue(() => runTableSchemaExport(payload), payload.workspaceKey || "");
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
      const result = await enqueue(() => runBillTypeExport(payload), payload.workspaceKey || "");
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
      const result = await enqueue(() => runViewSqlExport(payload), payload.workspaceKey || "");
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
      const result = await enqueue(() => runSystemScriptExport(payload), payload.workspaceKey || "");
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
      return sendJson(res, 200, { ok: true, ...(await enqueue(() => runProcedureCallers(payload), payload.workspaceKey || "")) });
    } catch (error) {
      return sendJson(res, 500, { ok: false, message: error.message });
    }
  }

  return sendJson(res, 404, { ok: false, message: "接口不存在" });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`谷神桥接服务启动失败：端口 ${PORT} 已被占用`);
  } else {
    console.error(`谷神桥接服务启动失败：${error.message}`);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`谷神桥接服务已启动：http://127.0.0.1:${PORT}`);
  console.log(`配对令牌文件：${TOKEN_PATH}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  pageContexts.dispose();
  console.log(`收到 ${signal}，正在停止谷神桥接服务`);
  const finish = () => {
    server.close(() => process.exit(0));
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    // Fallback exit if in-flight ToolHost or keep-alive connections never settle.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  // Install the deadline before awaiting child shutdown, which itself can hang.
  setTimeout(() => process.exit(0), 5000).unref();
  void toolProcessClient.stop().catch(() => {}).finally(finish);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

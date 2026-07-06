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
    throw new Error("outputDir is required");
  }
  if (!path.isAbsolute(outputDir)) {
    throw new Error("outputDir must be an absolute path");
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

function runHubPull(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(HUB_PYTHON, [HUB_PULL_SCRIPT, "--json-stdin"], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"]
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
        reject(new Error((stderr || stdout || `Hub command failed with exit code ${code}`).trim()));
        return;
      }
      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (error) {
        reject(new Error(`Hub command returned invalid JSON: ${error.message}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function runTableSchemaExport(payload) {
  return new Promise((resolve, reject) => {
    const args = [TABLE_SCHEMA_SCRIPT];
    if (payload.dataSourceId) {
      args.push("--data-source-ids", String(payload.dataSourceId));
    }
    if (Array.isArray(payload.tableIds) && payload.tableIds.length > 0) {
      args.push("--table-ids", payload.tableIds.join(","));
    }
    const child = spawn(HUB_PYTHON, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"]
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
        reject(new Error((stderr || stdout || `Table schema command failed with exit code ${code}`).trim()));
        return;
      }
      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (error) {
        reject(new Error(`Table schema command returned invalid JSON: ${error.message}`));
      }
    });
  });
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
        return sendJson(res, 400, { ok: false, message: "objectKey and content are required" });
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
        return sendJson(res, 400, { ok: false, message: "objectKey is required" });
      }

      const manifest = readManifest();
      const entry = manifest[payload.objectKey];
      if (!entry) {
        return sendJson(res, 404, { ok: false, message: `No local file mapped for ${payload.objectKey}` });
      }
      if (!fs.existsSync(entry.filePath)) {
        return sendJson(res, 404, { ok: false, message: `Local file not found: ${entry.filePath}` });
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

  if (req.method === "POST" && req.url === "/pullHubSource") {
    try {
      const payload = await readBody(req);
      const result = await runHubPull(payload);
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, 500, { ok: false, message: error.message });
    }
  }

  if (req.method === "POST" && req.url === "/exportTableSchema") {
    try {
      const payload = await readBody(req);
      const result = await runTableSchemaExport(payload);
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, 500, { ok: false, message: error.message });
    }
  }

  return sendJson(res, 404, { ok: false, message: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Guthon bridge listening at http://127.0.0.1:${PORT}`);
  console.log(`Workspace: ${WORKSPACE_DIR}`);
});

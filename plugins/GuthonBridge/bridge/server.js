const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.GUTHON_BRIDGE_PORT || 17361);
const ROOT = __dirname;
const WORKSPACE_DIR = path.join(ROOT, "workspace", "procedures");
const MANIFEST_PATH = path.join(ROOT, "workspace", "manifest.json");

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

  return sendJson(res, 404, { ok: false, message: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Guthon bridge listening at http://127.0.0.1:${PORT}`);
  console.log(`Workspace: ${WORKSPACE_DIR}`);
});

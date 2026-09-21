const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const UPDATE_SOURCES = {
  github: {
    label: 'GitHub',
    latestUrl: 'https://api.github.com/repos/SidWuu/GuthonCodeTool/releases/latest',
  },
  gitee: {
    label: 'Gitee',
    latestUrl: 'https://gitee.com/api/v5/repos/sidwu/GuthonCodeTool/releases/latest',
  },
};
const CHECKSUM_ASSET = 'GuthonCodeTool-checksums.txt';
const STATE_FILE = 'tool-update-state.json';
const LEGACY_BASELINE_VERSION = '0.2.1';
const versionCache = new Map();

function normalizeVersion(value) {
  const version = String(value || '').trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`无效版本号：${value || '空'}`);
  return version;
}

function compareVersions(left, right) {
  const a = normalizeVersion(left).split('.').map(Number);
  const b = normalizeVersion(right).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function assetNameFor(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return 'GuthonCodeTool-windows-x64.exe';
  if (platform === 'darwin' && arch === 'arm64') return 'GuthonCodeTool-macos-arm64.zip';
  throw new Error(`当前系统没有 GuthonCodeTool 发行版本：${platform}-${arch}`);
}

function request(url, redirectCount = 0) {
  if (redirectCount > 8) return Promise.reject(new Error('更新下载重定向次数过多'));
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'http:' ? http : https;
    const req = transport.get(target, {
      headers: {
        Accept: 'application/json, application/octet-stream, text/plain',
        'User-Agent': 'Guthon-Nexus',
      },
    }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        resolve(request(new URL(response.headers.location, target).toString(), redirectCount + 1));
        return;
      }
      if (status < 200 || status >= 300) {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => reject(new Error(`更新服务返回 HTTP ${status}：${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`)));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(30000, () => req.destroy(new Error('访问更新源超时')));
    req.on('error', reject);
  });
}

async function fetchLatestRelease(source) {
  const provider = UPDATE_SOURCES[source];
  if (!provider) throw new Error(`不支持的更新源：${source}`);
  const payload = JSON.parse((await request(provider.latestUrl)).toString('utf8'));
  const version = normalizeVersion(payload.tag_name);
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  return {
    source,
    sourceLabel: provider.label,
    version,
    notes: String(payload.body || '').trim(),
    assets: assets.map((asset) => ({
      name: asset.name,
      size: Number(asset.size || 0),
      digest: asset.digest || '',
      url: asset.browser_download_url,
    })),
  };
}

function releaseAsset(release, name) {
  const asset = release.assets.find((candidate) => candidate.name === name && candidate.url);
  if (!asset) throw new Error(`${release.sourceLabel} Release 缺少 ${name}`);
  return asset;
}

function parseChecksums(value) {
  const result = new Map();
  for (const line of String(value || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match) result.set(match[2], match[1].toLowerCase());
  }
  return result;
}

function sha256(filePath) {
  const digest = crypto.createHash('sha256');
  digest.update(fs.readFileSync(filePath));
  return digest.digest('hex');
}

async function downloadAsset(url, destination) {
  const content = await request(url);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
  return content.length;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data) => { stdout += data.toString(); });
    child.stderr?.on('data', (data) => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout).trim() || `${path.basename(command)} 退出码 ${code}`));
    });
  });
}

async function verifyExecutable(executablePath, expectedVersion, processRunner) {
  const versionResult = await processRunner(executablePath, ['version']);
  const packagedVersion = normalizeVersion(JSON.parse(versionResult.stdout).version);
  if (packagedVersion !== expectedVersion) {
    throw new Error(`应用版本不一致：Release ${expectedVersion}，应用 ${packagedVersion}`);
  }
  const selfTestHome = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-update-test-'));
  try {
    await processRunner(executablePath, ['self-test', '--home', selfTestHome]);
  } finally {
    fs.rmSync(selfTestHome, { recursive: true, force: true });
  }
}

async function installRelease({
  release,
  storageRoot,
  platform = process.platform,
  arch = process.arch,
  onProgress = () => {},
  processRunner = runProcess,
}) {
  const assetName = assetNameFor(platform, arch);
  const asset = releaseAsset(release, assetName);
  const checksumAsset = releaseAsset(release, CHECKSUM_ASSET);
  onProgress(`读取 ${release.sourceLabel} 校验信息`);
  const checksums = parseChecksums((await request(checksumAsset.url)).toString('utf8'));
  const expectedHash = checksums.get(assetName);
  if (!expectedHash) throw new Error(`校验文件缺少 ${assetName} 的 SHA-256`);

  const downloadDir = path.join(storageRoot, 'downloads');
  const runtimeRoot = path.join(storageRoot, 'runtime');
  const archivePath = path.join(downloadDir, `${release.version}-${assetName}.part`);
  const finalDir = path.join(runtimeRoot, release.version);
  const stagingDir = path.join(runtimeRoot, `.${release.version}-${process.pid}.staging`);
  const installedExecutable = path.join(
    finalDir,
    platform === 'darwin' ? 'GuthonCodeTool' : 'GuthonCodeTool.exe'
  );
  if (fs.existsSync(installedExecutable)) {
    onProgress('验证已下载版本');
    await verifyExecutable(installedExecutable, release.version, processRunner);
    return {
      version: release.version,
      toolPath: installedExecutable,
      assetName,
      sha256: expectedHash,
    };
  }
  if (fs.existsSync(finalDir)) throw new Error(`版本目录不完整，未覆盖：${finalDir}`);

  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    onProgress(`下载 ${assetName}`);
    const downloadedSize = await downloadAsset(asset.url, archivePath);
    if (asset.size && downloadedSize !== asset.size) {
      throw new Error(`下载文件大小不一致：期望 ${asset.size}，实际 ${downloadedSize}`);
    }
    onProgress('校验 SHA-256');
    const actualHash = sha256(archivePath);
    if (actualHash !== expectedHash) throw new Error(`SHA-256 校验失败：${assetName}`);

    let executablePath;
    if (platform === 'darwin') {
      onProgress('解压 macOS 应用');
      await processRunner('/usr/bin/ditto', ['-x', '-k', archivePath, stagingDir]);
      executablePath = path.join(stagingDir, 'GuthonCodeTool');
      if (!fs.existsSync(executablePath)) throw new Error('macOS 压缩包中缺少 GuthonCodeTool');
      fs.chmodSync(executablePath, 0o755);
    } else {
      executablePath = path.join(stagingDir, 'GuthonCodeTool.exe');
      fs.copyFileSync(archivePath, executablePath);
    }

    onProgress('核对版本并运行新版本自检');
    await verifyExecutable(executablePath, release.version, processRunner);
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.renameSync(stagingDir, finalDir);
    return {
      version: release.version,
      toolPath: path.join(finalDir, path.basename(executablePath)),
      assetName,
      sha256: actualHash,
    };
  } finally {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function readBundledVersion(extensionPath) {
  return normalizeVersion(JSON.parse(fs.readFileSync(path.join(extensionPath, 'tool-version.json'), 'utf8')).version);
}

function statePath(storageRoot) {
  return path.join(storageRoot, STATE_FILE);
}

function readUpdateState(storageRoot) {
  const target = statePath(storageRoot);
  if (!fs.existsSync(target)) return {};
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return {};
  }
}

function writeUpdateState(storageRoot, state) {
  fs.mkdirSync(storageRoot, { recursive: true });
  const target = statePath(storageRoot);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.rmSync(target, { force: true });
  fs.renameSync(temporary, target);
}

async function detectCurrentVersion(extensionPath, storageRoot, toolPath, processRunner = runProcess) {
  const state = readUpdateState(storageRoot);
  if (state.activePath && path.resolve(state.activePath) === path.resolve(toolPath || '') && state.activeVersion) {
    return normalizeVersion(state.activeVersion);
  }
  if (!toolPath || !fs.existsSync(toolPath)) return readBundledVersion(extensionPath);
  const stats = fs.statSync(toolPath);
  const cacheKey = `${path.resolve(toolPath)}:${stats.size}:${stats.mtimeMs}`;
  if (!versionCache.has(cacheKey)) {
    versionCache.set(cacheKey, (async () => {
      try {
        const result = await processRunner(toolPath, ['version']);
        return normalizeVersion(JSON.parse(result.stdout).version);
      } catch {
        return LEGACY_BASELINE_VERSION;
      }
    })());
  }
  return versionCache.get(cacheKey);
}

module.exports = {
  CHECKSUM_ASSET,
  UPDATE_SOURCES,
  assetNameFor,
  compareVersions,
  detectCurrentVersion,
  fetchLatestRelease,
  installRelease,
  normalizeVersion,
  parseChecksums,
  readBundledVersion,
  readUpdateState,
  releaseAsset,
  sha256,
  writeUpdateState,
};

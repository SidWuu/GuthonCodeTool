const crypto = require('node:crypto');
const fs = require('node:fs');
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
const versionCache = new Map();
const { SIGNATURE_ASSET, readTrust, verifySignature } = require('./release-signature');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const MAX_METADATA_BYTES = 4 * 1024 * 1024;

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

function updateUrl(value) {
  const target = new URL(value);
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('更新地址必须使用 HTTPS，且不能包含凭据');
  return target;
}

function openResponse(url, redirectCount = 0) {
  if (redirectCount > 8) return Promise.reject(new Error('更新下载重定向次数过多'));
  return new Promise((resolve, reject) => {
    let target;
    try { target = updateUrl(url); } catch (error) { reject(error); return; }
    const req = https.get(target, { headers: {
      Accept: 'application/json, application/octet-stream, text/plain', 'User-Agent': 'Guthon-Nexus',
    } }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        resolve(openResponse(new URL(response.headers.location, target).toString(), redirectCount + 1));
      } else if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`更新服务返回 HTTP ${status}`));
      } else resolve(response);
    });
    req.setTimeout(30000, () => req.destroy(new Error('访问更新源超时')));
    req.on('error', reject);
  });
}

async function request(url) {
  const response = await openResponse(url);
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > MAX_METADATA_BYTES) { response.destroy(); throw new Error('更新元数据超过大小限制'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
    prerelease: Boolean(payload.prerelease),
    notes: String(payload.body || '').trim().slice(0, 16384),
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
    if (match) {
      const hash = match[1].toLowerCase();
      if (result.has(match[2]) && result.get(match[2]) !== hash) throw new Error(`校验文件存在冲突摘要：${match[2]}`);
      result.set(match[2], hash);
    }
  }
  return result;
}

// Script runtime verification is synchronous; keep that public contract while
// hashing bounded chunks instead of loading the complete pyz into memory.
function sha256(filePath) {
  const digest = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, count));
    return digest.digest('hex');
  } finally { fs.closeSync(descriptor); }
}

async function sha256Stream(filePath) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}

async function downloadAsset(url, destination, { maxBytes = 256 * 1024 * 1024 } = {}) {
  const response = await openResponse(url);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  let count = 0;
  const limit = new Transform({ transform(chunk, encoding, callback) {
    count += chunk.length;
    callback(count > maxBytes ? new Error('更新附件超过声明大小限制') : null, chunk);
  } });
  await pipeline(response, limit, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  return fs.statSync(destination).size;
}

function assetDigest(asset) {
  if (!asset.digest) return '';
  const match = String(asset.digest).match(/^sha256:([a-fA-F0-9]{64})$/);
  if (!match) throw new Error(`不支持或无效的资产摘要：${asset.name}`);
  return match[1].toLowerCase();
}

async function withUpdateLock(storageRoot, action) {
  fs.mkdirSync(storageRoot, { recursive: true });
  const lockPath = path.join(storageRoot, '.application-update.lock');
  try { fs.mkdirSync(lockPath); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`其它窗口正在更新或回退应用；若更新进程已退出，请先检查 ${lockPath} 再移除锁目录`);
    throw error;
  }
  try {
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await action();
  } finally { fs.rmSync(lockPath, { recursive: true, force: true }); }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, ...options });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let processFailure;
    const deadline = setTimeout(() => {
      processFailure = new Error('更新应用验证超时');
      child.kill('SIGKILL');
    }, 120000);
    const collect = (data, stream) => {
      bytes += data.length;
      if (bytes > MAX_METADATA_BYTES) { processFailure = new Error('更新应用验证输出超过限制'); child.kill('SIGKILL'); return; }
      if (stream === 'stdout') stdout += data.toString(); else stderr += data.toString();
    };
    child.stdout?.on('data', (data) => collect(data, 'stdout'));
    child.stderr?.on('data', (data) => collect(data, 'stderr'));
    child.on('error', (error) => { clearTimeout(deadline); reject(error); });
    child.on('close', (code) => {
      clearTimeout(deadline);
      if (processFailure) { reject(processFailure); return; }
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout).trim() || `${path.basename(command)} 退出码 ${code}`));
    });
  });
}

async function verifyExecutable(executablePath, expectedVersion, processRunner = runProcess) {
  const versionResult = await processRunner(executablePath, ['version']);
  const packagedVersion = normalizeVersion(JSON.parse(versionResult.stdout).version);
  if (expectedVersion && packagedVersion !== expectedVersion) {
    throw new Error(`应用版本不一致：Release ${expectedVersion}，应用 ${packagedVersion}`);
  }
  const selfTestHome = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-update-test-'));
  try {
    await processRunner(executablePath, ['self-test', '--home', selfTestHome]);
  } finally {
    fs.rmSync(selfTestHome, { recursive: true, force: true });
  }
  return packagedVersion;
}

async function installRelease({
  release,
  storageRoot,
  platform = process.platform,
  arch = process.arch,
  onProgress = () => {},
  processRunner = runProcess,
  downloader = downloadAsset,
  requester = request,
  bundledTrustFile,
  trustStorageRoot = storageRoot,
  alreadyLocked = false,
}) {
  if (!alreadyLocked) return withUpdateLock(storageRoot, () => installRelease({
    release, storageRoot, platform, arch, onProgress, processRunner, downloader, requester, bundledTrustFile, trustStorageRoot, alreadyLocked: true,
  }));
  normalizeVersion(release.version);
  const assetName = assetNameFor(platform, arch);
  const asset = releaseAsset(release, assetName);
  const checksumAsset = releaseAsset(release, CHECKSUM_ASSET);
  onProgress(`读取 ${release.sourceLabel} 校验信息`);
  updateUrl(asset.url);
  updateUrl(checksumAsset.url);
  const checksumBytes = await requester(checksumAsset.url);
  const checksumDigest = assetDigest(checksumAsset);
  if (checksumDigest && crypto.createHash('sha256').update(checksumBytes).digest('hex') !== checksumDigest) throw new Error('校验文件与 Release 资产摘要不一致');
  const trust = readTrust(trustStorageRoot, bundledTrustFile);
  let signatureEvidence = {verified:false,reason:'NO_PINNED_TRUST_KEY'};
  const signedAsset = release.assets.find(item=>item.name===SIGNATURE_ASSET);
  if(Object.keys(trust.keys).length && signedAsset) {
    updateUrl(signedAsset.url);
    signatureEvidence = verifySignature(release.version, checksumBytes, JSON.parse((await requester(signedAsset.url)).toString('utf8')), trust);
  } else if(trust.requireSignature) {
    throw new Error('发行包缺少必需的独立签名；禁止下载执行');
  } else {
    onProgress('尚未启用独立签名校验；仅使用 HTTPS 与同源摘要，不能抵抗发行账户被接管');
  }
  const checksums = parseChecksums(checksumBytes.toString('utf8'));
  const expectedHash = checksums.get(assetName);
  if (!expectedHash) throw new Error(`校验文件缺少 ${assetName} 的 SHA-256`);
  const apiDigest = assetDigest(asset);
  if (apiDigest && apiDigest !== expectedHash) throw new Error(`Release 资产摘要与校验文件不一致：${assetName}`);

  const downloadDir = path.join(storageRoot, 'downloads');
  const runtimeRoot = path.join(storageRoot, 'runtime');
  const unique = `${process.pid}-${crypto.randomUUID()}`;
  const archivePath = path.join(downloadDir, `${release.version}-${unique}-${assetName}.part`);
  const finalDir = path.join(runtimeRoot, release.version);
  const stagingDir = path.join(runtimeRoot, `.${release.version}-${unique}.staging`);
  const installedExecutable = path.join(
    finalDir,
    platform === 'darwin' ? 'GuthonCodeTool' : 'GuthonCodeTool.exe'
  );
  if (platform === 'win32' && fs.existsSync(installedExecutable)) {
    onProgress('验证已下载版本');
    try {
      if (platform === 'win32' && await sha256Stream(installedExecutable) !== expectedHash) throw new Error('已安装文件 SHA-256 不匹配');
      await verifyExecutable(installedExecutable, release.version, processRunner);
      return {
        version: release.version,
        toolPath: installedExecutable,
        assetName,
        sha256: expectedHash,
        signatureEvidence,
      };
    } catch (error) { onProgress(`现有版本验证失败，重新下载并保留旧目录：${error.message}`); }
  }
  let recoveryPath = '';

  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    onProgress(`下载 ${assetName}`);
    const downloadedSize = await downloader(asset.url, archivePath);
    if (asset.size && downloadedSize !== asset.size) {
      throw new Error(`下载文件大小不一致：期望 ${asset.size}，实际 ${downloadedSize}`);
    }
    onProgress('校验 SHA-256');
    const actualHash = await sha256Stream(archivePath);
    if (actualHash !== expectedHash) throw new Error(`SHA-256 校验失败：${assetName}`);

    let executablePath;
    if (platform === 'darwin') {
      onProgress('解压 macOS 应用');
      await processRunner('/usr/bin/ditto', ['-x', '-k', archivePath, stagingDir]);
      executablePath = path.join(stagingDir, 'GuthonCodeTool');
      if (!fs.existsSync(executablePath)) {
        const legacyExecutable = path.join(stagingDir, 'dist', 'GuthonCodeTool');
        if (!fs.existsSync(legacyExecutable)) throw new Error('macOS 压缩包中缺少 GuthonCodeTool');
        fs.renameSync(legacyExecutable, executablePath);
        fs.rmdirSync(path.join(stagingDir, 'dist'));
      }
      fs.chmodSync(executablePath, 0o755);
    } else {
      executablePath = path.join(stagingDir, 'GuthonCodeTool.exe');
      fs.copyFileSync(archivePath, executablePath);
    }

    onProgress('核对版本并运行新版本自检');
    await verifyExecutable(executablePath, release.version, processRunner);
    fs.mkdirSync(runtimeRoot, { recursive: true });
    if (fs.existsSync(finalDir)) {
      recoveryPath = path.join(runtimeRoot, `.${release.version}-${unique}.recovery`);
      fs.renameSync(finalDir, recoveryPath);
    }
    try { fs.renameSync(stagingDir, finalDir); }
    catch (error) { if (recoveryPath) fs.renameSync(recoveryPath, finalDir); throw error; }
    return {
      version: release.version,
      toolPath: path.join(finalDir, path.basename(executablePath)),
      assetName,
      sha256: actualHash,
      signatureEvidence,
      recoveryPath,
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
  const temporary = `${target}.${process.pid}-${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try { fs.renameSync(temporary, target); }
  finally { fs.rmSync(temporary, { force: true }); }
}

function versionCachePath(storageRoot, resolvedPath) {
  const key = crypto.createHash('sha256').update(resolvedPath).digest('hex');
  return path.join(storageRoot, 'version-cache', `${key}.json`);
}

function cacheDetectedVersion(storageRoot, resolvedPath, stats, version) {
  const target = versionCachePath(storageRoot, resolvedPath);
  const temporary = `${target}.${process.pid}-${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ path: resolvedPath, size: stats.size, mtimeMs: stats.mtimeMs, version }));
    fs.renameSync(temporary, target);
  } catch {
    // Probe caches must not overwrite application update/rollback state.
  } finally { fs.rmSync(temporary, {force:true}); }
}

async function detectCurrentVersion(extensionPath, storageRoot, toolPath, processRunner = runProcess) {
  if (!toolPath) return readBundledVersion(extensionPath);
  if (!fs.existsSync(toolPath)) throw new Error('当前应用路径不存在，无法探测版本');
  const stats = fs.statSync(toolPath);
  const resolved = path.resolve(toolPath);
  // 探测要启动一次应用；命中持久化结果时不再为每次窗口重载重复启动。
  let detected;
  try { detected = JSON.parse(fs.readFileSync(versionCachePath(storageRoot, resolved), 'utf8')); }
  catch { /* A missing or invalid cache requires a fresh executable probe. */ }
  if (detected && detected.path === resolved && detected.version
    && detected.size === stats.size && detected.mtimeMs === stats.mtimeMs) {
    return normalizeVersion(detected.version);
  }
  const cacheKey = `${resolved}:${stats.size}:${stats.mtimeMs}`;
  if (!versionCache.has(cacheKey)) {
    versionCache.set(cacheKey, (async () => {
      let version;
      try {
        const result = await processRunner(toolPath, ['version']);
        version = normalizeVersion(JSON.parse(result.stdout).version);
      } catch (error) {
        versionCache.delete(cacheKey);
        throw new Error(`无法探测当前应用版本，请检查应用后重试：${error.message}`);
      }
      cacheDetectedVersion(storageRoot, resolved, stats, version);
      return version;
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
  verifyExecutable,
  normalizeVersion,
  parseChecksums,
  readBundledVersion,
  readUpdateState,
  releaseAsset,
  sha256,
  writeUpdateState,
  updateUrl,
  withUpdateLock,
  downloadAsset,
  request,
  runProcess,
  sha256Stream,
};

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ASSETS, NEXUS_ID } = require('./release-catalog');
const { readArchive, archiveJson, extractArchive } = require('./update-archive');
const { compareVersions, assetNameFor, downloadAsset, sha256Stream, request,
  runProcess, installRelease, withUpdateLock } = require('./tool-updater');
const { probeScriptRuntime } = require('./script-runtime');

function updateRoot(home) {
  if (!home || !path.isAbsolute(home)) throw new Error('请先设置明确的本地数据目录');
  let directory = fs.existsSync(home) ? fs.realpathSync(home) : path.resolve(home);
  for (const part of ['var', 'nexus', 'updates']) {
    directory = path.join(directory, part);
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('更新运行目录不能通过符号链接重定向');
  }
  return directory;
}

function readJson(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('更新记录不安全或过大');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.lstatSync(path.dirname(file)).isSymbolicLink()) throw new Error('更新目录不能是符号链接');
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(temporary, file); } finally { fs.rmSync(temporary, { force: true }); }
}

function ownedDirectory(root, ...parts) {
  let directory = root;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const part of ['', ...parts]) {
    directory = part ? path.join(directory, part) : directory;
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('更新托管目录不能是链接或文件');
  }
  return directory;
}

function managedChrome(root) {
  const directory = path.join(root, 'chrome', 'extension');
  for (const candidate of [path.dirname(directory), directory]) {
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw new Error('Chrome 托管目录不能是链接');
  }
  const marker = readJson(path.join(directory, 'managed-install.json'));
  if (!marker) return { directory, status: '未托管' };
  if (marker.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(marker.installId || '')) throw new Error('Chrome 托管标识无效');
  const manifest = readJson(path.join(directory, 'manifest.json'));
  if (!manifest?.version || marker.version !== manifest.version) throw new Error('Chrome 托管文件版本不一致');
  compareVersions(manifest.version, manifest.version);
  return { directory, version: manifest.version, installId: marker.installId, status: '已托管' };
}

function updatePlan(catalog, current) {
  const tool = { id: 'tool', label: 'GuthonCodeTool' + (current.mode === 'script' ? '（调试 pyz）' : ''),
    current: current.toolVersion, target: catalog.components.tool.version, unknown: !current.toolVersion,
    update: current.mode !== 'source-development' && (!current.toolVersion || compareVersions(catalog.components.tool.version, current.toolVersion) > 0) };
  const nexus = { id: 'nexus', label: 'Guthon Nexus', current: current.nexusVersion, target: catalog.components.nexus.version,
    update: compareVersions(catalog.components.nexus.version, current.nexusVersion) > 0 };
  const chrome = { id: 'bridge', label: 'Chrome Guthon Bridge', current: current.chromeVersion,
    target: catalog.components.bridge.version, unknown: !current.chromeVersion,
    update: Boolean(current.chromeVersion && compareVersions(catalog.components.bridge.version, current.chromeVersion) > 0),
    bootstrap: !current.chromeVersion };
  if (catalog.local) {
    nexus.codeChanged = nexus.target === nexus.current && catalog.components.nexus.buildId !== current.nexusBuildId;
    if (nexus.codeChanged) { nexus.update = true; nexus.status = '本地源码有改动'; }
    chrome.codeChanged = chrome.target === chrome.current && catalog.components.bridge.buildId !== current.chromeBuildId;
    if (chrome.codeChanged) { chrome.update = true; chrome.status = '本地源码有改动'; }
  }
  if (tool.current && compareVersions(tool.target, tool.current) < 0) tool.status = '当前版本较新';
  if (current.mode === 'source-development') tool.status = '工具源码由开发者管理';
  return [tool, nexus, chrome];
}

function hostSettings(source) {
  let value;
  if (/^\s*globalThis\.GuthonBridgeHostSettings\s*=/.test(source)) {
    value = JSON.parse(source.replace(/^\s*globalThis\.GuthonBridgeHostSettings\s*=\s*/, '').replace(/;\s*$/, ''));
  } else {
    const body = /\bconst\s+config\s*=\s*\{([\s\S]*?)\}\s*;/.exec(source)?.[1];
    if (!body) throw new Error('无法读取原主机规则；请保留原文件并使用独立 host-settings.js 配置');
    value = {}; let remaining = body;
    remaining = remaining.replace(/(protocols|ipRanges|domainSuffixes|pathPrefixes)\s*:\s*(\[[\s\S]*?\])\s*,?/g, (_, key, array) => {
      if (Object.hasOwn(value, key)) throw new Error('主机配置字段重复');
      value[key] = JSON.parse(array); return '';
    });
    if (remaining.trim()) throw new Error('主机配置含无法安全导入的代码；仅支持字符串数组');
  }
  const keys = ['protocols', 'ipRanges', 'domainSuffixes', 'pathPrefixes'];
  if (!value || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key =>
    !Array.isArray(value[key]) || value[key].length > 64 || value[key].some(item => typeof item !== 'string' || !item || item.length > 256 || /[\x00-\x1f]/.test(item)))
    || value.protocols.some(item => !['http:', 'https:'].includes(item))
    || value.pathPrefixes.some(item => !item.startsWith('/'))) throw new Error('主机规则配置无效');
  return value;
}

async function prepareUpdate(verified, plan, root, { downloader = downloadAsset, onProgress = () => {},
  mode = 'packaged', pythonPath, importedHosts, platform = process.platform, arch = process.arch,
  processRunner = runProcess, scriptProbe = probeScriptRuntime } = {}) {
  const selected = plan.filter(item => item.update || item.bootstrap);
  const names = new Set();
  for (const item of selected) {
    if (item.id === 'tool') {
      names.add(mode === 'script' ? ASSETS.script : assetNameFor(platform, arch));
      if (mode === 'script') names.add(ASSETS.requirements);
    } else names.add(ASSETS[item.id === 'bridge' ? 'bridge' : 'nexus']);
  }
  const directory = ownedDirectory(root, 'downloads', verified.release.version);
  const files = {};
  for (const name of names) {
    const expected = verified.catalog.assets[name];
    const target = path.join(directory, expected.sha256 + '-' + name);
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('更新缓存不能是链接');
    if (!fs.existsSync(target) || await sha256Stream(target) !== expected.sha256) {
      const temporary = target + '.' + crypto.randomUUID() + '.part';
      onProgress((verified.origin === 'local' ? '复制并校验本地构建 ' : '下载并校验 ') + name);
      try {
        await downloader(verified.release.assets.find(asset => asset.name === name).url, temporary, { maxBytes: expected.size });
        if (fs.statSync(temporary).size !== expected.size || await sha256Stream(temporary) !== expected.sha256) throw new Error('发行附件校验失败：' + name);
        fs.renameSync(temporary, target);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    files[name] = target;
  }
  let chromeStage, scriptDirectory, missingProviders = [];
  try {
    if (files[ASSETS.nexus]) {
      const entries = readArchive(files[ASSETS.nexus]);
      const manifest = archiveJson(entries, 'extension/package.json');
      if (manifest.publisher + '.' + manifest.name !== NEXUS_ID || manifest.version !== verified.catalog.components.nexus.version) throw new Error('Nexus VSIX 身份或版本不一致');
    }
    if (files[ASSETS.bridge]) {
      const entries = readArchive(files[ASSETS.bridge]);
      const manifest = archiveJson(entries, 'extension/manifest.json');
      if (manifest.manifest_version !== 3 || manifest.name !== 'Guthon Bridge' || manifest.version !== verified.catalog.components.bridge.version) throw new Error('Chrome 扩展身份或版本不一致');
      const parent = ownedDirectory(root, 'chrome');
      chromeStage = path.join(parent, '.staging-' + crypto.randomUUID());
      extractArchive(entries, chromeStage, 'extension/');
      const previous = managedChrome(root);
      const originalSettings = path.join(previous.directory, 'host-settings.js');
      const rules = importedHosts || (previous.version ? hostSettings(fs.readFileSync(originalSettings, 'utf8')) : hostSettings(fs.readFileSync(path.join(chromeStage, 'host-settings.js'), 'utf8')));
      fs.writeFileSync(path.join(chromeStage, 'host-settings.js'), 'globalThis.GuthonBridgeHostSettings = ' + JSON.stringify(rules, null, 2) + ';\n');
      saveJson(path.join(chromeStage, 'managed-install.json'), { schemaVersion: 1,
        installId: previous.installId || crypto.randomUUID(), version: manifest.version,
        sourceBuildId: verified.catalog.components.bridge.buildId,
        archiveSha256: verified.catalog.assets[ASSETS.bridge].sha256 });
    }
    if (mode === 'script' && files[ASSETS.script]) {
      if (!pythonPath) throw new Error('调试模式未配置 Python');
      scriptDirectory = path.join(root, 'scripts', verified.release.version + '-' + crypto.randomUUID());
      ownedDirectory(root, 'scripts', path.basename(scriptDirectory));
      for (const name of [ASSETS.script, ASSETS.requirements]) fs.copyFileSync(files[name], path.join(scriptDirectory, name));
      fs.writeFileSync(path.join(scriptDirectory, 'GuthonCodeTool-checksums.txt'), verified.checksumsBytes);
      fs.writeFileSync(path.join(scriptDirectory, 'GuthonCodeTool-checksums.signature.json'), verified.signatureBytes);
      const probe = await scriptProbe({ mode: 'script', toolPath: pythonPath, toolEntry: path.join(scriptDirectory, ASSETS.script) });
      if (probe.version !== verified.catalog.components.tool.version) throw new Error('调试脚本版本不一致');
      missingProviders = probe.missingProviders;
    }
    return { verified, plan, files, chromeStage, scriptDirectory, processRunner, missingProviders };
  } catch (error) {
    if (chromeStage) fs.rmSync(chromeStage, { recursive: true, force: true });
    if (scriptDirectory) fs.rmSync(scriptDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function applyUpdate(prepared, root, { mode, platform = process.platform, arch = process.arch,
  bundledTrustFile, trustStorageRoot = root, installNexus, switchBackend, previousBackend, deferNexus = false, onProgress = () => {} } = {}) {
  const { verified, files, plan } = prepared;
  const record = { schemaVersion: 1, operationId: crypto.randomUUID(), release: verified.release, phase: 'APPLYING',
    startedAt: new Date().toISOString(), completed: [], pendingReload: false,
    nexusVersion: verified.catalog.components.nexus.version, previousBackend };
  const journal = path.join(root, 'operation.json');
  saveJson(journal, record);
  try {
    if (plan.find(item => item.id === 'tool')?.update) {
      let backend;
      if (mode === 'script') backend = { mode, toolEntry: path.join(prepared.scriptDirectory, ASSETS.script), version: verified.catalog.components.tool.version };
      else {
        const downloader = async (_, target) => { const source = files[assetNameFor(platform, arch)]; fs.copyFileSync(source, target); return fs.statSync(target).size; };
        const requester = async url => {
          const item = verified.release.assets.find(asset => asset.url === url);
          if (item?.name === 'GuthonCodeTool-checksums.txt') return verified.checksumsBytes;
          if (item?.name === 'GuthonCodeTool-checksums.signature.json') return verified.signatureBytes;
          throw new Error('未准备的更新元数据');
        };
        backend = await installRelease({ release: verified.release, storageRoot: root, alreadyLocked: true,
          platform, arch, bundledTrustFile, trustStorageRoot, downloader, requester, processRunner: prepared.processRunner, onProgress });
      }
      const previous = await switchBackend(backend);
      record.previousBackend = previous;
      record.completed.push('tool'); saveJson(journal, record);
    }
    if (prepared.chromeStage) {
      const chrome = managedChrome(root);
      if (fs.existsSync(chrome.directory) && !chrome.version) throw new Error('目标 Chrome 目录未托管，禁止覆盖');
      const backup = path.join(root, 'chrome', '.backup-' + crypto.randomUUID());
      record.chrome = { directory: chrome.directory, backup, stage: prepared.chromeStage, previousVersion: chrome.version };
      saveJson(journal, record);
      if (fs.existsSync(chrome.directory)) fs.renameSync(chrome.directory, backup);
      try { fs.renameSync(prepared.chromeStage, chrome.directory); }
      catch (error) { if (fs.existsSync(backup)) fs.renameSync(backup, chrome.directory); throw error; }
      const installed = managedChrome(root);
      saveJson(path.join(root, 'chrome', 'reload-request.json'), { installId: installed.installId,
        version: installed.version, requestedAt: Date.now() });
      record.completed.push('bridge'); saveJson(journal, record);
    }
    if (files[ASSETS.nexus]) {
      if (deferNexus) {
        record.phase = 'READY_NEXUS'; saveJson(journal, record); return record;
      }
      record.phase = 'INSTALLING_NEXUS'; saveJson(journal, record);
      await installNexus(files[ASSETS.nexus]);
      record.completed.push('nexus'); record.pendingReload = true;
    }
    record.phase = 'INSTALLED'; record.finishedAt = new Date().toISOString();
    saveJson(journal, record);
    return record;
  } catch (error) {
    record.phase = 'PARTIAL'; record.error = error.message;
    saveJson(journal, record); throw error;
  } finally {
    if (prepared.chromeStage && fs.existsSync(prepared.chromeStage)) fs.rmSync(prepared.chromeStage, { recursive: true, force: true });
  }
}

function interruptedUpdate(root, loadedNexusVersion) {
  const record = readJson(path.join(root, 'operation.json'));
  if (!record) return undefined;
  // An interrupted directory swap can be restored using only our exact owned paths.
  const item = record.chrome;
  if (item && ['APPLYING', 'PARTIAL', 'INSTALLING_NEXUS'].includes(record.phase)) {
    const parent = path.join(root, 'chrome');
    if (item.directory !== path.join(parent, 'extension') || path.dirname(item.backup) !== parent
        || !path.basename(item.backup).startsWith('.backup-')) throw new Error('更新恢复记录路径无效');
    if (fs.existsSync(item.backup) && fs.lstatSync(item.backup).isSymbolicLink()) throw new Error('更新备份不能是链接');
    if (!fs.existsSync(item.directory) && fs.existsSync(item.backup)) fs.renameSync(item.backup, item.directory);
  }
  if (loadedNexusVersion && record.nexusVersion && compareVersions(loadedNexusVersion, record.nexusVersion) >= 0
      && ['INSTALLING_NEXUS', 'INSTALLED'].includes(record.phase)) {
    record.phase = 'INSTALLED'; record.pendingReload = false;
    if (!record.completed.includes('nexus')) record.completed.push('nexus');
    saveJson(path.join(root, 'operation.json'), record);
  }
  return record;
}

module.exports = { updateRoot, readJson, saveJson, managedChrome, updatePlan, hostSettings,
  prepareUpdate, applyUpdate, interruptedUpdate, withUpdateLock, ownedDirectory };

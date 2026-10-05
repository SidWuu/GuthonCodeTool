const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { nexusFiles, chromeFiles, packageFingerprint, bridgeBundle } = require('./extension-package');
const { ASSETS, NEXUS_ID } = require('./release-catalog');
const { normalizeVersion, runProcess, sha256Stream } = require('./tool-updater');
const { prepareUpdate, ownedDirectory } = require('./component-update');

function localRelease(developmentRoot) {
  if (!developmentRoot || !path.isAbsolute(developmentRoot)) throw new Error('开发模式需要明确的 developmentRoot 源码目录，不使用发行源回退');
  const sourceRoot = fs.realpathSync(developmentRoot);
  const nexusRoot = path.join(sourceRoot, 'plugins', 'GuthonNexus', 'gushen-vscode-completion');
  const chromeRoot = path.join(sourceRoot, 'plugins', 'GuthonBridge', 'extension');
  const version = normalizeVersion(fs.readFileSync(path.join(sourceRoot, 'VERSION'), 'utf8'));
  const overrides = bridgeBundle(sourceRoot);
  overrides.set('tool-version.json', Buffer.from(JSON.stringify({ version }, null, 2) + '\n'));
  const nexus = nexusFiles(nexusRoot, overrides), chrome = chromeFiles(chromeRoot);
  const packageInfo = JSON.parse(nexus.get('package.json').toString('utf8'));
  const manifest = JSON.parse(chrome.get('manifest.json').toString('utf8'));
  if (packageInfo.publisher + '.' + packageInfo.name !== NEXUS_ID || manifest.name !== 'Guthon Bridge' || manifest.manifest_version !== 3) throw new Error('本地插件源码身份无效');
  normalizeVersion(packageInfo.version); normalizeVersion(manifest.version);
  const nexusBuildId = packageFingerprint(nexus);
  // This file is intentionally editable in the managed installation.
  const chromeBuildId = packageFingerprint(chrome, new Set(['host-settings.js']));
  return { origin: 'local', sourceRoot, nexusRoot, nexusFiles: nexus, chromeFiles: chrome,
    release: { source: 'local', sourceLabel: '本地源码', version, assets: [] },
    catalog: { schemaVersion: 1, local: true, releaseVersion: version,
      components: { tool: { version, pythonMinimum: '3.12' },
        nexus: { id: NEXUS_ID, version: packageInfo.version, vscodeEngine: packageInfo.engines.vscode, buildId: nexusBuildId },
        bridge: { version: manifest.version, protocolVersion: 2, buildId: chromeBuildId } }, assets: {} },
    fingerprint: packageFingerprint(new Map([...nexus].map(([name, bytes]) => ['nexus/' + name, bytes])
      .concat([...chrome].map(([name, bytes]) => ['chrome/' + name, bytes])))) };
}

function findVsce(sourceRoot, env = process.env) {
  const candidates = [
    path.join(sourceRoot, 'node_modules', '@vscode', 'vsce', 'vsce'),
    path.join(sourceRoot, 'plugins', 'GuthonNexus', 'gushen-vscode-completion', 'node_modules', '@vscode', 'vsce', 'vsce'),
  ];
  for (const directory of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(directory, 'node_modules', '@vscode', 'vsce', 'vsce'), path.join(directory, 'vsce'));
  }
  const found = candidates.find(file => {
    try { return fs.statSync(file).isFile() && /^#!.*node\b/.test(fs.readFileSync(file, 'utf8').slice(0, 160)); } catch { return false; }
  });
  if (!found) throw new Error('本地构建缺少已安装的 @vscode/vsce，请先安装开发依赖；不会联网下载构建工具');
  return fs.realpathSync(found);
}

async function prepareLocalUpdate(local, plan, root, { pythonPath, importedHosts, onProgress = () => {},
  processRunner = runProcess, packager } = {}) {
  if (local.origin !== 'local') throw new Error('本地更新必须来自明确源码快照');
  const now = localRelease(local.sourceRoot);
  if (now.fingerprint !== local.fingerprint) throw new Error('本地源码已改变，请重新检查后构建');
  const work = ownedDirectory(root, 'local-builds', crypto.randomUUID());
  function write(files, directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const [name, bytes] of files) {
      const file = path.join(directory, name);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    }
  }
  const artifacts = {};
  try {
    if (plan.find(item => item.id === 'nexus')?.update) {
      const directory = path.join(work, 'nexus');
      write(local.nexusFiles, directory);
      artifacts[ASSETS.nexus] = path.join(work, ASSETS.nexus);
      onProgress('从本地源码快照构建 Nexus VSIX');
      await processRunner(process.execPath, [packager || findVsce(local.sourceRoot), 'package', '--no-dependencies', '--no-rewrite-relative-links',
        '--readme-path', 'readme.md', '--allow-missing-repository', '--skip-license', '--out', artifacts[ASSETS.nexus]],
      { cwd: directory, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    }
    if (plan.find(item => item.id === 'bridge')?.update || plan.find(item => item.id === 'bridge')?.bootstrap) {
      if (!pythonPath) throw new Error('开发模式需要已配置的 .venv Python 来构建 Chrome ZIP');
      write(local.chromeFiles, path.join(work, 'extension'));
      const background = path.join(work, 'extension', 'background.js');
      fs.writeFileSync(background, 'globalThis.GuthonBridgeSourceBuildId = ' + JSON.stringify(local.catalog.components.bridge.buildId) + ';\n' + local.chromeFiles.get('background.js').toString('utf8'));
      artifacts[ASSETS.bridge] = path.join(work, ASSETS.bridge);
      onProgress('从本地源码快照构建 Chrome 扩展');
      await processRunner(pythonPath, ['-m', 'zipfile', '-c', artifacts[ASSETS.bridge], 'extension'], { cwd: work });
    }
    const verified = { ...local, release: { ...local.release, assets: [] },
      catalog: { ...local.catalog, assets: {} } };
    for (const [name, file] of Object.entries(artifacts)) {
      const size = fs.statSync(file).size;
      if (!size || size > 64 * 1024 * 1024) throw new Error('本地插件构建结果无效或过大');
      verified.catalog.assets[name] = { size, sha256: await sha256Stream(file) };
      verified.release.assets.push({ name, url: 'local:' + name, size });
    }
    const downloader = async (url, destination) => {
      const name = url.replace(/^local:/, ''), file = artifacts[name];
      if (!file) throw new Error('未知本地构建附件');
      fs.copyFileSync(file, destination);
    };
    return await prepareUpdate(verified, plan, root, { mode: 'source-development', importedHosts, downloader, onProgress });
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
module.exports = { localRelease, prepareLocalUpdate, findVsce };

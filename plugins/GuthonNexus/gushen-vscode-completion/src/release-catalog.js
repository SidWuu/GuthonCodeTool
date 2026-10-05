const crypto = require('node:crypto');
const { normalizeVersion, releaseAsset, parseChecksums, request, updateUrl } = require('./tool-updater');
const { readTrust, verifySignature, SIGNATURE_ASSET } = require('./release-signature');

const CATALOG_ASSET = 'GuthonCodeTool-release.json';
const NEXUS_ID = 'gushen-local.guthon-nexus-vscode';
const ASSETS = {
  windows: 'GuthonCodeTool-windows-x64.exe', macos: 'GuthonCodeTool-macos-arm64.zip',
  script: 'GuthonCodeTool-python.pyz', requirements: 'GuthonCodeTool-python-requirements.txt',
  nexus: 'guthon-nexus-vscode.vsix', bridge: 'GuthonCodeTool-chrome.zip',
};
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

class ReleaseCatalogUnavailable extends Error {
  constructor(release, checksumsBytes, signatureBytes) {
    super('更新源当前发行 ' + release.version + ' 尚未提供三组件更新信息，请在新版发行后重新检查');
    this.name = 'ReleaseCatalogUnavailable';
    this.release = release;
    this.bytes = { checksumsBytes, signatureBytes };
  }
}

function signedChecksums(release, storageRoot, bytes, bundledTrustFile) {
  const { checksumsBytes, signatureBytes } = bytes;
  if ([checksumsBytes, signatureBytes].some(item => !Buffer.isBuffer(item) || item.length > 65536)) throw new Error('发行元数据无效或过大');
  verifySignature(release.version, checksumsBytes, JSON.parse(signatureBytes.toString('utf8')), readTrust(storageRoot, bundledTrustFile));
  const checksums = parseChecksums(checksumsBytes.toString('utf8'));
  if (!checksums.has(CATALOG_ASSET)) {
    if (release.assets.some(asset => asset.name === CATALOG_ASSET)) throw new Error('发行清单未被签名摘要覆盖');
    throw new ReleaseCatalogUnavailable(release, checksumsBytes, signatureBytes);
  }
  return checksums;
}

function validateCatalog(catalog, release, checksums) {
  if (catalog?.schemaVersion !== 1 || catalog.releaseVersion !== release.version || catalog.channel !== 'stable'
      || !catalog.components || !catalog.assets) throw new Error('三组件发行清单无效或版本不一致');
  const { tool, nexus, bridge } = catalog.components;
  for (const item of [tool, nexus, bridge]) normalizeVersion(item?.version);
  if (tool.version !== release.version || nexus.id !== NEXUS_ID || bridge.protocolVersion !== 2
      || tool.pythonMinimum !== '3.12') throw new Error('三组件身份或更新协议不受支持');
  for (const name of Object.values(ASSETS)) {
    const item = catalog.assets[name];
    if (!item || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 256 * 1024 * 1024
        || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || checksums.get(name) !== item.sha256) throw new Error('发行清单与签名摘要不一致：' + name);
    updateUrl(releaseAsset(release, name).url);
  }
  return catalog;
}

function verifyReleaseBytes(release, storageRoot, bytes, bundledTrustFile) {
  const { checksumsBytes, signatureBytes, catalogBytes } = bytes;
  const checksums = signedChecksums(release, storageRoot, bytes, bundledTrustFile);
  if (!Buffer.isBuffer(catalogBytes) || catalogBytes.length > 65536) throw new Error('发行元数据无效或过大');
  const evidence = verifySignature(release.version, checksumsBytes, JSON.parse(signatureBytes.toString('utf8')), readTrust(storageRoot, bundledTrustFile));
  if (hash(catalogBytes) !== checksums.get(CATALOG_ASSET)) throw new Error('三组件发行清单哈希校验失败');
  const catalog = validateCatalog(JSON.parse(catalogBytes.toString('utf8')), release, checksums);
  return { release, catalog, evidence, checksumsBytes, signatureBytes, catalogBytes };
}

async function verifiedRelease(release, storageRoot, { requester = request, bundledTrustFile } = {}) {
  normalizeVersion(release.version);
  if (release.prerelease) throw new Error('自动更新只使用稳定发行版本');
  const get = async name => {
    const asset = releaseAsset(release, name); updateUrl(asset.url);
    const bytes = await requester(asset.url);
    if (bytes.length > 65536) throw new Error('发行更新元数据超过大小限制');
    return bytes;
  };
  const checksumsBytes = await get('GuthonCodeTool-checksums.txt');
  const signatureBytes = await get(SIGNATURE_ASSET);
  const checksums = signedChecksums(release, storageRoot, { checksumsBytes, signatureBytes }, bundledTrustFile);
  const catalogBytes = await get(CATALOG_ASSET);
  if (hash(catalogBytes) !== checksums.get(CATALOG_ASSET)) throw new Error('三组件发行清单哈希校验失败');
  return verifyReleaseBytes(release, storageRoot, { checksumsBytes, signatureBytes, catalogBytes }, bundledTrustFile);
}

module.exports = { CATALOG_ASSET, NEXUS_ID, ASSETS, hash, validateCatalog, verifiedRelease, verifyReleaseBytes, ReleaseCatalogUnavailable };

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { signingPayload } = require('../src/release-signature');
const { verifiedRelease, ASSETS, CATALOG_ASSET, NEXUS_ID } = require('../src/release-catalog');
function zip(files, modes = {}) {
  let offset = 0; const local = [], central = [];
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.from(value), head = Buffer.alloc(30), index = Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(filename.length, 26);
    index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 6); index.writeUInt32LE(data.length, 20); index.writeUInt32LE(data.length, 24);
    index.writeUInt16LE(filename.length, 28); index.writeUInt32LE(offset, 42); index.writeUInt32LE(((modes[name] || 0) << 16) >>> 0, 38);
    local.push(head, filename, data); central.push(index, filename); offset += head.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const rules = { protocols: ['https:'], ipRanges: [], domainSuffixes: ['dev.example.com'], pathPrefixes: ['/guthon/'] };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-components-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = crypto.generateKeyPairSync('ed25519');
  const trustFile = path.join(root, 'trust.json');
  fs.writeFileSync(trustFile, JSON.stringify({ schemaVersion: 1, requireSignature: true, keys: { fixture: key.publicKey.export({ type: 'spki', format: 'pem' }) } }));
  const data = Object.fromEntries(Object.values(ASSETS).map(name => [name, Buffer.from('fixture-' + name)]));
  data[ASSETS.nexus] = zip({
    'extension/package.json': JSON.stringify({ name: 'guthon-nexus-vscode', publisher: 'gushen-local', version: '2.5.0', engines: { vscode: '^1.75.0' } }),
    'extension/tool-version.json': '{"version":"0.4.0"}',
  });
  data[ASSETS.bridge] = zip({
    'extension/manifest.json': '{"manifest_version":3,"name":"Guthon Bridge","version":"0.4.0"}',
    'extension/host-settings.js': 'globalThis.GuthonBridgeHostSettings = ' + JSON.stringify(rules) + ';\n',
    'extension/background.js': 'fixture',
  });
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const catalog = { schemaVersion: 1, releaseVersion: '0.4.0', channel: 'stable',
    components: { tool: { version: '0.4.0', pythonMinimum: '3.12' }, nexus: { version: '2.5.0', id: NEXUS_ID, vscodeEngine: '^1.75.0' }, bridge: { version: '0.4.0', protocolVersion: 2 } },
    assets: Object.fromEntries(Object.entries(data).map(([name, bytes]) => [name, { size: bytes.length, sha256: hash(bytes) }])) };
  data[CATALOG_ASSET] = Buffer.from(JSON.stringify(catalog));
  const sums = Buffer.from(Object.entries(data).map(([name, bytes]) => hash(bytes) + '  ' + name + '\n').join(''));
  const signature = { schemaVersion: 1, algorithm: 'ed25519', version: '0.4.0', keyId: 'fixture', signature: crypto.sign(null, signingPayload('0.4.0', sums), key.privateKey).toString('base64') };
  data['GuthonCodeTool-checksums.txt'] = sums;
  data['GuthonCodeTool-checksums.signature.json'] = Buffer.from(JSON.stringify(signature));
  const release = { version: '0.4.0', source: 'github', sourceLabel: 'Fixture',
    assets: Object.keys(data).map(name => ({ name, url: 'https://fixture.example/' + name })) };
  const request = async url => data[url.split('/').pop()];
  const downloader = async (url, file) => { fs.writeFileSync(file, await request(url)); };
  const current = { mode: 'packaged', toolVersion: '0.3.0', nexusVersion: '2.4.0' };
  const signed = () => verifiedRelease(release, root, { requester: request, bundledTrustFile: trustFile });
  function legacy() {
    delete data[CATALOG_ASSET];
    release.assets = release.assets.filter(item => item.name !== CATALOG_ASSET);
    const sums = Buffer.from(Object.entries(data).filter(([name]) => !name.startsWith('GuthonCodeTool-checksums.'))
      .map(([name, bytes]) => hash(bytes) + '  ' + name + '\n').join(''));
    data['GuthonCodeTool-checksums.txt'] = sums;
    data['GuthonCodeTool-checksums.signature.json'] = Buffer.from(JSON.stringify({ ...signature,
      signature: crypto.sign(null, signingPayload(release.version, sums), key.privateKey).toString('base64') }));
  }
  return { root, trustFile, data, catalog, release, downloader, signed, current, legacy };
}

module.exports = { fixture, zip, rules };

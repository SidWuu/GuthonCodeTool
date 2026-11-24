#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readArchive, archiveJson, extractArchive } = require('../plugins/GuthonNexus/gushen-vscode-completion/src/update-archive');
const { nexusFiles, chromeFiles, packageFingerprint } = require('../plugins/GuthonNexus/gushen-vscode-completion/src/extension-package');
const { ASSETS, CATALOG_ASSET, NEXUS_ID, releaseAssetNames } = require('../plugins/GuthonNexus/gushen-vscode-completion/src/release-catalog');
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--release-dir' || args[2] !== '--version' || !/^\d+\.\d+\.\d+$/.test(args[3])) throw new Error('Use --release-dir DIR --version VERSION');
const root = fs.realpathSync(args[1]), version = args[3];
const nexusArchive = readArchive(path.join(root, ASSETS.nexus));
const bridgeArchive = readArchive(path.join(root, ASSETS.bridge));
const nexus = archiveJson(nexusArchive, 'extension/package.json');
const tool = archiveJson(nexusArchive, 'extension/tool-version.json');
const bridge = archiveJson(bridgeArchive, 'extension/manifest.json');
if (nexus.publisher + '.' + nexus.name !== NEXUS_ID || tool.version !== version || bridge.version !== version) throw new Error('Packaged component identities or versions differ from the release');
const assets = {};
const publishedFiles = { assets: fs.readdirSync(root, { withFileTypes: true }).map(file => ({ name: file.name })) };
for (const name of releaseAssetNames(publishedFiles)) {
  const file = path.join(root, name), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid release asset ' + name);
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  assets[name] = { size: stat.size, sha256: hash.digest('hex') };
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-release-catalog-'));
try {
  const nexusDir = path.join(temporary, 'nexus'), bridgeDir = path.join(temporary, 'bridge');
  extractArchive(new Map([...nexusArchive].filter(([name]) => name.startsWith('extension/'))), nexusDir, 'extension/');
  extractArchive(bridgeArchive, bridgeDir, 'extension/');
  const catalog = { schemaVersion: 1, channel: 'stable', releaseVersion: version,
    components: { tool: { version, pythonMinimum: '3.12' },
      nexus: { id: NEXUS_ID, version: nexus.version, vscodeEngine: nexus.engines.vscode,
        buildId: packageFingerprint(nexusFiles(nexusDir)) },
      bridge: { version: bridge.version, protocolVersion: 2,
        buildId: packageFingerprint(chromeFiles(bridgeDir), new Set(['host-settings.js'])) } }, assets };
  fs.writeFileSync(path.join(root, CATALOG_ASSET), JSON.stringify(catalog, null, 2) + '\n', { flag: 'wx' });
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
console.log('Generated release catalog from packaged VSIX and Chrome metadata');

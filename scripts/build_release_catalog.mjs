#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readArchive, archiveJson } = require('../plugins/GuthonNexus/gushen-vscode-completion/src/update-archive');
const { ASSETS, CATALOG_ASSET, NEXUS_ID } = require('../plugins/GuthonNexus/gushen-vscode-completion/src/release-catalog');
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--release-dir' || args[2] !== '--version' || !/^\d+\.\d+\.\d+$/.test(args[3])) throw new Error('Use --release-dir DIR --version VERSION');
const root = fs.realpathSync(args[1]), version = args[3];
const nexus = archiveJson(readArchive(path.join(root, ASSETS.nexus)), 'extension/package.json');
const tool = archiveJson(readArchive(path.join(root, ASSETS.nexus)), 'extension/tool-version.json');
const bridge = archiveJson(readArchive(path.join(root, ASSETS.bridge)), 'extension/manifest.json');
if (nexus.publisher + '.' + nexus.name !== NEXUS_ID || tool.version !== version || bridge.version !== version) throw new Error('Packaged component identities or versions differ from the release');
const assets = {};
for (const name of Object.values(ASSETS)) {
  const file = path.join(root, name), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid release asset ' + name);
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  assets[name] = { size: stat.size, sha256: hash.digest('hex') };
}
const catalog = { schemaVersion: 1, channel: 'stable', releaseVersion: version,
  components: { tool: { version, pythonMinimum: '3.12' },
    nexus: { id: NEXUS_ID, version: nexus.version, vscodeEngine: nexus.engines.vscode },
    bridge: { version: bridge.version, protocolVersion: 2 } }, assets };
fs.writeFileSync(path.join(root, CATALOG_ASSET), JSON.stringify(catalog, null, 2) + '\n', { flag: 'wx' });
console.log('Generated release catalog from packaged VSIX and Chrome metadata');

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(extensionRoot, '..', '..', 'GuthonBridge', 'bridge', 'server.js');
const target = path.join(extensionRoot, 'bridge', 'server.js');

const original = fs.readFileSync(source, 'utf8');
const sourceImport = '../../GuthonNexus/gushen-vscode-completion/src/tool-process-client';
if (!original.includes(sourceImport)) throw new Error('Bridge ToolProcessClient import was not found');
const generated = `// GENERATED FILE - do not edit. Regenerate with: npm run build:bridge\n// Source: plugins/GuthonBridge/bridge/server.js\n${original.replace(sourceImport, '../src/tool-process-client')}`;

fs.mkdirSync(path.dirname(target), { recursive: true });
for (const name of ['page-context.js']) {
  const moduleSource = path.join(path.dirname(source), name);
  const moduleTarget = path.join(path.dirname(target), name);
  const bytes = fs.readFileSync(moduleSource);
  if (!fs.existsSync(moduleTarget) || !fs.readFileSync(moduleTarget).equals(bytes)) fs.writeFileSync(moduleTarget, bytes);
}
if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === generated) {
  console.log(`Bundled Guthon Bridge unchanged: ${target}`);
} else {
  fs.writeFileSync(target, generated, 'utf8');
  console.log(`Bundled Guthon Bridge: ${target}`);
}

// This public protocol metadata is shared by Python and both Node entry points.
// Copy bytes verbatim so contract tests can detect stale or reformatted bundles.
const metadataSource = path.resolve(extensionRoot, '../../..', 'scripts/common/command_metadata.json');
const metadataTarget = path.join(extensionRoot, 'data/tool-command-metadata.json');
const metadataBytes = fs.readFileSync(metadataSource);
const metadata = JSON.parse(metadataBytes.toString('utf8'));
if (metadata.schemaVersion !== 1 || !Number.isInteger(metadata.defaultTimeoutMs) || metadata.defaultTimeoutMs <= 0) {
  throw new Error('Invalid ToolHost command metadata schema or default timeout');
}
for (const registry of [metadata.commands, metadata.svnActions]) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error('Invalid ToolHost command metadata registry');
  for (const [name, entry] of Object.entries(registry)) {
    if (!entry || !['read', 'write'].includes(entry.kind) || !Number.isInteger(entry.timeoutMs) || entry.timeoutMs <= 0) {
      throw new Error(`Invalid ToolHost command metadata: ${name}`);
    }
  }
}
fs.mkdirSync(path.dirname(metadataTarget), { recursive: true });
if (!fs.existsSync(metadataTarget) || !fs.readFileSync(metadataTarget).equals(metadataBytes)) {
  fs.writeFileSync(metadataTarget, metadataBytes);
  console.log(`Bundled ToolHost command metadata: ${metadataTarget}`);
}

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
if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === generated) {
  console.log(`Bundled Guthon Bridge unchanged: ${target}`);
} else {
  fs.writeFileSync(target, generated, 'utf8');
  console.log(`Bundled Guthon Bridge: ${target}`);
}

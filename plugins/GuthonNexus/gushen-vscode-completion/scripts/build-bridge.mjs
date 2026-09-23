import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(extensionRoot, '..', '..', 'GuthonBridge', 'bridge', 'server.js');
const target = path.join(extensionRoot, 'bridge', 'server.js');

fs.mkdirSync(path.dirname(target), { recursive: true });
const original = fs.readFileSync(source, 'utf8');
const sourceImport = '../../GuthonNexus/gushen-vscode-completion/src/tool-process-client';
if (!original.includes(sourceImport)) throw new Error('Bridge ToolProcessClient import was not found');
fs.writeFileSync(target, original.replace(sourceImport, '../src/tool-process-client'), 'utf8');
console.log(`Bundled Guthon Bridge: ${target}`);

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(extensionRoot, '..', '..', 'GuthonBridge', 'bridge', 'server.js');
const target = path.join(extensionRoot, 'bridge', 'server.js');

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
console.log(`Bundled Guthon Bridge: ${target}`);

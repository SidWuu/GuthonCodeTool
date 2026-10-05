import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { bridgeBundle } = require('../src/extension-package');
const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.resolve(extensionRoot, '../../..');
for (const [name, bytes] of bridgeBundle(sourceRoot)) {
  const target = path.join(extensionRoot, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) {
    fs.writeFileSync(target, bytes);
    console.log('Bundled shared source: ' + name);
  }
}

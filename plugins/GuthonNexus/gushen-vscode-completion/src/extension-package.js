const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readFiles(root, folders, allowed) {
  const files = new Map();
  function walk(relative) {
    const directory = path.join(root, relative);
    if (!fs.existsSync(directory)) return;
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.name.startsWith('.')) continue;
      const name = relative ? relative + '/' + item.name : item.name;
      if (item.isSymbolicLink()) throw new Error('插件源码不能包含符号链接：' + name);
      if (item.isDirectory()) { if (!['node_modules', 'test', 'tests', 'scripts', 'var', 'config'].includes(item.name)) walk(name); }
      else if (item.isFile() && allowed(name)) {
        const file = path.join(root, name), size = fs.statSync(file).size;
        if (size > 32 * 1024 * 1024) throw new Error('插件源码文件过大：' + name);
        files.set(name, fs.readFileSync(file));
      }
    }
  }
  for (const folder of folders) walk(folder);
  return files;
}

function nexusFiles(root, overrides = new Map()) {
  const files = readFiles(root, ['src', 'bridge', 'data', 'resources', 'syntaxes'], name =>
    !/\.test\.js$/.test(name) && !['data/java.json', 'data/javascript.json', 'data/sql.json'].includes(name)
    && /\.(js|json|png|svg|jpg|css|html|xml)$/.test(name));
  for (const name of ['package.json', 'tool-version.json', 'rules.json']) {
    const file = path.join(root, name); if (fs.existsSync(file)) files.set(name, fs.readFileSync(file));
  }
  const readme = ['readme.md', 'README.md'].find(name => fs.existsSync(path.join(root, name)));
  if (readme) files.set('readme.md', fs.readFileSync(path.join(root, readme)));
  for (const [name, bytes] of overrides) files.set(name, bytes);
  if (files.has('package.json')) {
    const manifest = JSON.parse(files.get('package.json').toString('utf8'));
    // Editors add installation metadata and reformat the manifest after VSIX install.
    delete manifest.__metadata;
    files.set('package.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  }
  return files;
}

function chromeFiles(root) {
  const files = readFiles(root, [''], name => !/\.test\.js$/.test(name)
    && (name === 'manifest.json' || /\.(js|css|html|png|svg|jpg)$/.test(name)));
  if (files.has('background.js')) files.set('background.js', Buffer.from(files.get('background.js').toString('utf8')
    .replace(/^globalThis\.GuthonBridgeSourceBuildId = "sha256:[a-f0-9]{64}";\n/, '')));
  return files;
}

function packageFingerprint(files, excluded = new Set()) {
  const hash = crypto.createHash('sha256');
  for (const name of [...files.keys()].filter(name => !excluded.has(name)).sort((a, b) => a.localeCompare(b, 'en'))) {
    hash.update(name + '\0'); hash.update(files.get(name)); hash.update('\0');
  }
  return 'sha256:' + hash.digest('hex');
}

function bridgeBundle(sourceRoot) {
  const directory = path.join(sourceRoot, 'plugins', 'GuthonBridge', 'bridge');
  const original = fs.readFileSync(path.join(directory, 'server.js'), 'utf8');
  const sourceImport = '../../GuthonNexus/gushen-vscode-completion/src/tool-process-client';
  if (!original.includes(sourceImport)) throw new Error('Bridge ToolProcessClient import was not found');
  const files = new Map([
    ['bridge/server.js', Buffer.from('// GENERATED FILE - do not edit. Regenerate with: npm run build:bridge\n// Source: plugins/GuthonBridge/bridge/server.js\n' + original.replace(sourceImport, '../src/tool-process-client'))],
  ]);
  for (const name of ['page-context.js', 'browser-updates.js']) files.set('bridge/' + name, fs.readFileSync(path.join(directory, name)));
  const bytes = fs.readFileSync(path.join(sourceRoot, 'scripts', 'common', 'command_metadata.json'));
  const metadata = JSON.parse(bytes.toString('utf8'));
  if (metadata.schemaVersion !== 1 || !Number.isInteger(metadata.defaultTimeoutMs) || metadata.defaultTimeoutMs <= 0) throw new Error('Invalid ToolHost command metadata');
  for (const registry of [metadata.commands, metadata.svnActions]) {
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error('Invalid ToolHost command registry');
    for (const value of Object.values(registry)) if (!value || !['read', 'write'].includes(value.kind) || !Number.isInteger(value.timeoutMs) || value.timeoutMs <= 0) throw new Error('Invalid ToolHost command entry');
  }
  files.set('data/tool-command-metadata.json', bytes);
  return files;
}
module.exports = { nexusFiles, chromeFiles, packageFingerprint, bridgeBundle };

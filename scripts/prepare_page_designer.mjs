#!/usr/bin/env node
// Maintenance entry; Nexus uses the same packaged snapshot implementation.
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require = createRequire(import.meta.url);
const snapshot = require('../plugins/GuthonNexus/gushen-vscode-completion/src/page-editor/asset-snapshot.js');
export const {download,prepare} = snapshot;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    if (args.includes('--help')) console.log('node scripts/prepare_page_designer.mjs --source /absolute/platform-assets [--output /absolute/new-directory]\nnode scripts/prepare_page_designer.mjs --platform-url https://platform.example/guthon/index.html --output /absolute/new-directory');
    else {
      while (args.length) {
        const key = args.shift();
        if (!['--source', '--output', '--platform-url'].includes(key) || options[key] || !args.length) throw new Error('参数无效，使用 --help 查看用法');
        options[key] = args.shift();
      }
      if (Boolean(options['--source']) === Boolean(options['--platform-url'])) throw new Error('需要指定 --source 或 --platform-url 其中一项');
      console.log(JSON.stringify(options['--platform-url'] ? await download(options['--platform-url'], options['--output'])
        : await prepare(options['--source'], options['--output'])));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

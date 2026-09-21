import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const sources = [
  ['java', 'java.md'],
  ['javascript', 'javascript.md'],
  ['sql', 'sql.md'],
];

// API 文档只来自显式目录或 toolHome（<toolHome>/var/docs/谷神方言API），
// 不再从插件目录向上数层去找源码仓库里的 var。
function resolveApiDir(explicitDir, env = process.env) {
  if (explicitDir) return path.resolve(explicitDir);
  const toolHome = String(env.GUTHON_TOOL_HOME || env.GUTHON_HOME || '').trim();
  if (!toolHome) {
    throw new Error(
      '缺少 API 文档目录：请传入 <api-docs-dir>，或设置 GUTHON_TOOL_HOME / GUTHON_HOME 以使用 <toolHome>/var/docs/谷神方言API。'
    );
  }
  return path.join(path.resolve(toolHome), 'var', 'docs', '谷神方言API');
}

function stripCell(value) {
  return String(value || '')
    .trim()
    .replace(/^`|`$/g, '')
    .replace(/\\`/g, '`')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

function parseTableLine(line) {
  if (!line.startsWith('|')) {
    return undefined;
  }

  const cells = line.split('|');
  if (cells.length < 4) {
    return undefined;
  }

  const snippet = stripCell(cells[1]);
  const body = stripCell(cells[2]);
  const description = stripCell(cells.slice(3, -1).join('|'));

  if (!snippet || snippet === 'Snippet' || snippet.includes('---')) {
    return undefined;
  }

  return { snippet, body, description };
}

function parseMarkdown(markdown, language) {
  const items = [];
  let group = '';

  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      group = heading[1].trim();
      continue;
    }

    const row = parseTableLine(line);
    if (!row || !group) {
      continue;
    }

    items.push({
      language,
      group,
      prefix: row.snippet,
      body: row.body,
      description: row.description,
    });
  }

  return items;
}

function buildIndex(apiDir) {
  const index = {};
  for (const [language, fileName] of sources) {
    const markdown = fs.readFileSync(path.join(apiDir, fileName), 'utf8');
    index[language] = parseMarkdown(markdown, language);
  }
  return index;
}

function build(explicitApiDir, explicitOutputDir) {
  const apiDir = resolveApiDir(explicitApiDir);
  const outputDir = explicitOutputDir ? path.resolve(explicitOutputDir) : path.join(rootDir, 'data');
  const index = buildIndex(apiDir);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  console.log(
    sources
      .map(([language]) => `${language}: ${index[language].length}`)
      .join(', ')
  );
}

function selfTest() {
  assert.throws(() => resolveApiDir('', {}), /缺少 API 文档目录/);
  assert.equal(
    resolveApiDir('', { GUTHON_TOOL_HOME: '/tmp/guthon-tool-home' }),
    path.join('/tmp/guthon-tool-home', 'var', 'docs', '谷神方言API')
  );
  assert.equal(
    resolveApiDir('', { GUTHON_HOME: '/tmp/guthon-home' }),
    path.join('/tmp/guthon-home', 'var', 'docs', '谷神方言API')
  );
  assert.equal(resolveApiDir('/tmp/api-docs', {}), path.resolve('/tmp/api-docs'));

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-build-data-'));
  try {
    const apiDir = path.join(tempRoot, 'api');
    const outputDir = path.join(tempRoot, 'out');
    fs.mkdirSync(apiDir);
    fs.writeFileSync(
      path.join(apiDir, 'java.md'),
      '## 命名空间索引\n\n## Demo\n\n| Snippet | API 调用模板 | 说明 |\n|---|---|---|\n| `demo.run` | `demo.run(x)` | 示例 |\n'
    );
    fs.writeFileSync(path.join(apiDir, 'javascript.md'), '## JS\n\n| Snippet | API 调用模板 | 说明 |\n|---|---|---|\n| `a` | `a()` | b |\n');
    fs.writeFileSync(path.join(apiDir, 'sql.md'), '## SQL\n\n| Snippet | API 调用模板 | 说明 |\n|---|---|---|\n| `c` | `c()` | d |\n');
    build(apiDir, outputDir);
    const index = JSON.parse(fs.readFileSync(path.join(outputDir, 'index.json'), 'utf8'));
    assert.deepEqual(index.java, [
      { language: 'java', group: 'Demo', prefix: 'demo.run', body: 'demo.run(x)', description: '示例' },
    ]);
    assert.equal(index.javascript.length, 1);
    assert.equal(index.sql.length, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log('build-data self-test: ok');
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  build(process.argv[2], process.argv[3]);
}

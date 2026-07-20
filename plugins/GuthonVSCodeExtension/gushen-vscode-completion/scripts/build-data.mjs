import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const defaultApiDir = path.resolve(rootDir, '..', '..', '..', 'var', 'docs', '谷神方言API');
const apiDir = process.argv[2] ? path.resolve(process.argv[2]) : defaultApiDir;
const outputDir = process.argv[3] ? path.resolve(process.argv[3]) : path.join(rootDir, 'data');

const sources = [
  ['java', 'java.md'],
  ['javascript', 'javascript.md'],
  ['sql', 'sql.md'],
];

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

fs.mkdirSync(outputDir, { recursive: true });

const index = {};
for (const [language, fileName] of sources) {
  const filePath = path.join(apiDir, fileName);
  const markdown = fs.readFileSync(filePath, 'utf8');
  const items = parseMarkdown(markdown, language);
  index[language] = items;
  fs.writeFileSync(
    path.join(outputDir, `${language}.json`),
    `${JSON.stringify(items, null, 2)}\n`
  );
}

fs.writeFileSync(path.join(outputDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);

console.log(
  sources
    .map(([language]) => `${language}: ${index[language].length}`)
    .join(', ')
);

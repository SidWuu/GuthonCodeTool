#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(root, 'docs');
const pageNames = [
  'GuthonCodeTool_使用手册.html',
  'GuthonCodeTool_全功能说明.html',
  'GuthonCodeTool_QA.html',
];
const pages = new Map();
const errors = [];
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const readmeDocsMarker = '\n## 文档\n';
const readmeDocsStart = readme.lastIndexOf(readmeDocsMarker);
const readmeDocs = readmeDocsStart < 0 ? '' : readme.slice(readmeDocsStart + readmeDocsMarker.length).trim();
if (readmeDocs !== '- [在线文档](https://sidwuu.github.io/GuthonCodeTool/)') {
  errors.push('README.md: final 文档 section must contain only the online documentation link');
}

for (const name of pageNames) {
  const html = fs.readFileSync(path.join(docsDir, name), 'utf8');
  const body = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const ids = [...body.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  if (new Set(ids).size !== ids.length) errors.push(`${name}: duplicate HTML id`);
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [index, script] of scripts.entries()) {
    try { new vm.Script(script[1], { filename: `${name}:script${index + 1}` }); }
    catch (error) { errors.push(`${name}: ${error.message}`); }
  }
  if (/\/Users\/[^/\s<"']+\//.test(html) || /ssh:\/\/git@/i.test(html)) {
    errors.push(`${name}: possible private path or repository URL`);
  }
  pages.set(name, { html, body, ids: new Set(ids) });
}

function checkLink(source, href) {
  if (/^(https?:|mailto:|data:)/i.test(href)) return;
  const url = new URL(href, `https://docs.example/${source}`);
  const targetName = decodeURIComponent(url.pathname.slice(1));
  const target = targetName === 'index.html' ? pageNames[0] : targetName || source;
  if (!pages.has(target)) {
    errors.push(`${source}: missing page ${href}`);
    return;
  }
  const anchor = decodeURIComponent(url.hash.slice(1));
  if (anchor && !pages.get(target).ids.has(anchor)) errors.push(`${source}: missing anchor ${href}`);
}

for (const [name, page] of pages) {
  for (const [, href] of page.body.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)) checkLink(name, href);
}

const qaScript = pages.get('GuthonCodeTool_QA.html').html.match(
  /const qaItems=(\[[\s\S]*?\]);\s*const categoryOrder=(\[[^\n]+\]);/
);
let qaCount = 0;
if (!qaScript) {
  errors.push('GuthonCodeTool_QA.html: QA data not found');
} else {
  const items = vm.runInNewContext(`(${qaScript[1]})`);
  const categories = vm.runInNewContext(`(${qaScript[2]})`);
  qaCount = items.length;
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) errors.push('QA: duplicate item id');
  for (const item of items) {
    if (!categories.includes(item.category)) errors.push(`QA ${item.id}: unknown category`);
    if (!['all', 'database', 'svn'].includes(item.mode)) errors.push(`QA ${item.id}: unknown mode`);
    if (!item.os?.length || item.os.some((os) => !['mac', 'windows'].includes(os))) {
      errors.push(`QA ${item.id}: unknown OS`);
    }
    for (const [, href] of item.links || []) checkLink('GuthonCodeTool_QA.html', href);
  }
}

if (errors.length) {
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Public docs: ${pages.size} pages, ${qaCount} QA items, syntax and links OK\n`);
}

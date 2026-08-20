'use strict';

const path = require('node:path');

function decodeXml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attributes(text) {
  const result = {};
  const pattern = /([:\w-]+)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = pattern.exec(text))) result[match[1]] = decodeXml(match[2]);
  return result;
}

function parseSvnStatusXml(xml, repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const entries = [];
  const pattern = /<entry\b([^>]*)>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = pattern.exec(String(xml || '')))) {
    const entry = attributes(match[1]);
    const statusMatch = match[2].match(/<wc-status\b([^>]*)\/?\s*>/);
    if (!statusMatch) continue;
    const status = attributes(statusMatch[1]);
    const rawItem = status.item || 'normal';
    const props = status.props || 'none';
    const propertyChanged = props !== 'normal' && props !== 'none';
    if ((rawItem === 'normal' && !propertyChanged) || rawItem === 'ignored' || rawItem === 'external') continue;
    const item = rawItem === 'normal' && propertyChanged ? 'modified' : rawItem;
    const relativePath = entry.path || '';
    const filePath = path.resolve(root, relativePath);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) continue;
    entries.push({
      filePath,
      relativePath: path.relative(root, filePath) || path.basename(filePath),
      item,
      props,
      locked: status.locked === 'true',
      switched: status.switched === 'true'
    });
  }
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

module.exports = { parseSvnStatusXml };

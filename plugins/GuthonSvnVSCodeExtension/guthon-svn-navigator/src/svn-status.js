'use strict';

const path = require('node:path');
const { isPathWithin } = require('./path-utils');

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

function changelistAt(source, index) {
  const opening = source.lastIndexOf('<changelist', index);
  const closing = source.lastIndexOf('</changelist>', index);
  if (opening <= closing) return '';
  const end = source.indexOf('>', opening);
  if (end === -1 || end > index) return '';
  return attributes(source.slice(opening + '<changelist'.length, end)).name || '';
}

function parseEntries(xml, repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const source = String(xml || '');
  const againstRevision = source.match(/<against\b[^>]*\brevision="([^"]+)"/)?.[1] || '';
  const entries = [];
  const pattern = /<entry\b([^>]*)>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = pattern.exec(source))) {
    const entry = attributes(match[1]);
    const statusMatch = match[2].match(/<wc-status\b([^>]*)\/?\s*>/);
    if (!statusMatch) continue;
    const status = attributes(statusMatch[1]);
    const repositoryStatusMatch = match[2].match(/<repos-status\b([^>]*)\/?\s*>/);
    const repositoryStatus = repositoryStatusMatch ? attributes(repositoryStatusMatch[1]) : {};
    const rawItem = status['tree-conflicted'] === 'true' ? 'conflicted' : status.item || 'normal';
    const props = status.props || 'none';
    const propertyChanged = props !== 'normal' && props !== 'none';
    const item = rawItem === 'normal' && propertyChanged ? 'modified' : rawItem;
    const rawRemoteItem = repositoryStatus.item || 'none';
    const remoteProps = repositoryStatus.props || 'none';
    const remotePropertyChanged = remoteProps !== 'normal' && remoteProps !== 'none';
    const remoteItem = ['none', 'normal'].includes(rawRemoteItem) && remotePropertyChanged
      ? 'modified'
      : rawRemoteItem;
    const relativePath = entry.path || '';
    const filePath = path.resolve(root, relativePath);
    if (!isPathWithin(root, filePath)) continue;
    entries.push({
      filePath,
      relativePath: path.relative(root, filePath) || path.basename(filePath),
      item,
      props,
      remoteItem,
      remoteProps,
      againstRevision,
      changelist: changelistAt(source, match.index),
      locked: status.locked === 'true',
      wcLocked: status['wc-locked'] === 'true',
      switched: status.switched === 'true'
    });
  }
  return entries;
}

function parseSvnStatusXml(xml, repositoryRoot) {
  const entries = parseEntries(xml, repositoryRoot).filter((entry) => (
    !['normal', 'ignored', 'external'].includes(entry.item)
  ));
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function parseSvnRemoteStatusXml(xml, repositoryRoot) {
  const entries = parseEntries(xml, repositoryRoot).filter((entry) => (
    !['none', 'normal', 'ignored', 'external'].includes(entry.remoteItem)
  ));
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function parseSvnWorkingCopyHealthXml(xml, repositoryRoot) {
  return parseEntries(xml, repositoryRoot).filter((entry) => (
    entry.item === 'incomplete' || entry.locked || entry.wcLocked
  ));
}

module.exports = {
  parseSvnRemoteStatusXml,
  parseSvnStatusXml,
  parseSvnWorkingCopyHealthXml
};

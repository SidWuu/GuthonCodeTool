'use strict';

const path = require('node:path');

function pathApiFor(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function normalizedPath(value, platform = process.platform) {
  const pathApi = pathApiFor(platform);
  const resolved = pathApi.resolve(String(value || ''));
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left, right, platform = process.platform) {
  return normalizedPath(left, platform) === normalizedPath(right, platform);
}

function isPathWithin(parent, target, platform = process.platform) {
  const pathApi = pathApiFor(platform);
  const normalizedParent = normalizedPath(parent, platform);
  const normalizedTarget = normalizedPath(target, platform);
  return normalizedTarget === normalizedParent
    || normalizedTarget.startsWith(`${normalizedParent}${pathApi.sep}`);
}

function pathKey(value, platform = process.platform) {
  return normalizedPath(value, platform);
}

module.exports = { isPathWithin, normalizedPath, pathKey, samePath };

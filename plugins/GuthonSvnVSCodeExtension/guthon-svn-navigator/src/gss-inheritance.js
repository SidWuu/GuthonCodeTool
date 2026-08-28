'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CHILD_SUFFIX = '.gss';
const PARENT_SUFFIX = '.inherit.gss';

function isGssFile(filePath) {
  return String(filePath || '').toLowerCase().endsWith(CHILD_SUFFIX);
}

function isInheritanceParent(filePath) {
  return String(filePath || '').toLowerCase().endsWith(PARENT_SUFFIX);
}

function isSupportedInheritancePath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/datasources/') && normalized.includes('/procedures/')
    || normalized.includes('/systems/') && normalized.includes('/pages/')
    || normalized.startsWith('datasources/') && normalized.includes('/procedures/')
    || normalized.startsWith('systems/') && normalized.includes('/pages/');
}

function inheritanceParentPath(childPath) {
  if (!isGssFile(childPath) || isInheritanceParent(childPath)) return '';
  return String(childPath).slice(0, -CHILD_SUFFIX.length) + PARENT_SUFFIX;
}

function inheritanceChildPath(parentPath) {
  if (!isInheritanceParent(parentPath)) return '';
  return String(parentPath).slice(0, -PARENT_SUFFIX.length) + CHILD_SUFFIX;
}

function maskCommentsAndStrings(source) {
  const text = String(source || '');
  const masked = text.split('');
  let state = 'code';
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];
    if (state === 'line-comment') {
      if (current === '\n' || current === '\r') state = 'code';
      else masked[index] = ' ';
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        masked[index] = ' ';
        masked[index + 1] = ' ';
        index += 1;
        state = 'code';
      } else if (current !== '\n' && current !== '\r') masked[index] = ' ';
      continue;
    }
    if (state === 'velocity-comment') {
      if (current === '*' && next === '#') {
        masked[index] = ' ';
        masked[index + 1] = ' ';
        index += 1;
        state = 'code';
      } else if (current !== '\n' && current !== '\r') masked[index] = ' ';
      continue;
    }
    if (state === 'single-quote' || state === 'double-quote') {
      if (current === '\\') {
        masked[index] = ' ';
        if (index + 1 < text.length) {
          if (text[index + 1] !== '\n' && text[index + 1] !== '\r') masked[index + 1] = ' ';
          index += 1;
        }
      } else if ((state === 'single-quote' && current === "'")
        || (state === 'double-quote' && current === '"')) {
        masked[index] = ' ';
        state = 'code';
      } else if (current !== '\n' && current !== '\r') masked[index] = ' ';
      continue;
    }
    if (current === '/' && next === '/') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      index += 1;
      state = 'line-comment';
    } else if (current === '/' && next === '*') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      index += 1;
      state = 'block-comment';
    } else if (current === '#' && next === '*') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      index += 1;
      state = 'velocity-comment';
    } else if (current === '#' && next === '#') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      index += 1;
      state = 'line-comment';
    } else if (current === "'") {
      masked[index] = ' ';
      state = 'single-quote';
    } else if (current === '"') {
      masked[index] = ' ';
      state = 'double-quote';
    }
  }
  return masked.join('');
}

function inheritCalls(source) {
  const text = String(source || '');
  const code = maskCommentsAndStrings(text);
  const calls = [];
  const pattern = /(?:\breturn[ \t]+)?@inherit[ \t]*\(([^)]*)\)[ \t]*;/g;
  let match;
  while ((match = pattern.exec(code))) {
    const nameOffset = match[0].indexOf('@inherit');
    calls.push({
      start: match.index,
      end: pattern.lastIndex,
      nameStart: match.index + nameOffset,
      nameEnd: match.index + nameOffset + '@inherit'.length,
      arguments: match[1].trim(),
      returnsValue: /^return\b/.test(match[0].trim())
    });
  }
  return calls;
}

function stripLeadingGeneratedComment(source) {
  const text = String(source || '').replace(/^\uFEFF/, '');
  const match = text.match(/^\s*\/\*\*[\s\S]*?\*\/[ \t]*(?:\r?\n)?/);
  if (!match) return text;
  const generated = /@(packageId|functionId|pageId|pageAliasId|pageName|description|param|return)\b|继承关系说明|本文件继承自|代码修改说明/.test(match[0]);
  return generated ? text.slice(match[0].length) : text;
}

function inspectInheritance(childPath, childSource, parentSource, parentExists) {
  const parentPath = inheritanceParentPath(childPath);
  const childCalls = inheritCalls(childSource);
  const parentCalls = parentExists ? inheritCalls(parentSource) : [];
  const unsupportedChild = childCalls.some((call) => call.arguments);
  const unsupportedParent = parentCalls.some((call) => call.arguments);
  if (!parentPath) return null;
  if (!childCalls.length && !parentExists) return null;
  if (!childCalls.length) {
    return {
      state: 'overridden',
      parentPath,
      parentReadOnly: true,
      resolvable: true,
      calls: [],
      reason: '子文件未启用 @inherit()，父级实现当前不参与运行。'
    };
  }
  if (!parentExists) {
    return {
      state: 'missing-parent',
      parentPath,
      parentReadOnly: true,
      resolvable: false,
      calls: childCalls,
      reason: `继承源不存在：${parentPath}`
    };
  }
  if (childCalls.length !== 1 || unsupportedChild || parentCalls.length || unsupportedParent) {
    return {
      state: 'invalid-parent',
      parentPath,
      parentReadOnly: true,
      resolvable: false,
      calls: childCalls,
      reason: childCalls.length !== 1
        ? `子文件必须且只能包含一个有效 @inherit()，当前为 ${childCalls.length} 个。`
        : unsupportedChild
          ? '@inherit() 不支持传入参数。'
          : '父级实现中仍包含有效 @inherit()，无法安全解析。'
    };
  }
  return {
    state: 'active',
    parentPath,
    parentReadOnly: true,
    resolvable: true,
    calls: childCalls,
    reason: ''
  };
}

function inspectInheritanceFile(childPath) {
  if (!isGssFile(childPath) || isInheritanceParent(childPath) || !isSupportedInheritancePath(childPath)) return null;
  let childSource;
  try { childSource = fs.readFileSync(childPath, 'utf8'); } catch { return null; }
  const parentPath = inheritanceParentPath(childPath);
  const parentExists = fs.existsSync(parentPath);
  let parentSource = '';
  if (parentExists) {
    try { parentSource = fs.readFileSync(parentPath, 'utf8'); } catch { return null; }
  }
  return inspectInheritance(childPath, childSource, parentSource, parentExists);
}

function indentBody(body, indent) {
  const normalized = String(body || '').replace(/^\s*\r?\n/, '').replace(/[ \t\r\n]+$/, '');
  if (!normalized) return '';
  return normalized.split(/\r?\n/).map((line, index) => (
    index === 0 || !line ? line : `${indent}${line}`
  )).join('\n');
}

function materializeInheritance(childPath, childSource, parentSource) {
  const inspection = inspectInheritance(childPath, childSource, parentSource, true);
  if (!inspection || inspection.state !== 'active') {
    const error = new Error(inspection?.reason || '当前文件没有可展开的有效继承关系。');
    error.code = 'INVALID_GSS_INHERITANCE';
    throw error;
  }
  const call = inspection.calls[0];
  const lineStart = Math.max(childSource.lastIndexOf('\n', call.start - 1) + 1, 0);
  const prefix = childSource.slice(lineStart, call.start);
  const indent = /^\s*$/.test(prefix) ? prefix : '';
  const parentBody = indentBody(stripLeadingGeneratedComment(parentSource), indent);
  if (!parentBody.trim()) {
    const error = new Error('父级实现去除生成注释后没有可展开的脚本。');
    error.code = 'EMPTY_GSS_INHERITANCE';
    throw error;
  }
  return {
    content: `${childSource.slice(0, call.start)}${parentBody}${childSource.slice(call.end)}`,
    replacement: { start: call.start, end: call.end, text: parentBody },
    inspection
  };
}

function relativeInheritance(parentPath, root) {
  return path.relative(root, parentPath).replace(/\\/g, '/');
}

module.exports = {
  inheritCalls,
  inheritanceChildPath,
  inheritanceParentPath,
  inspectInheritance,
  inspectInheritanceFile,
  isInheritanceParent,
  isSupportedInheritancePath,
  materializeInheritance,
  maskCommentsAndStrings,
  relativeInheritance,
  stripLeadingGeneratedComment
};

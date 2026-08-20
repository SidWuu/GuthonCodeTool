'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PAGE_TYPES = new Map([
  ['🏠', '主页面'],
  ['📦', '子页面'],
  ['🧊', '弹窗'],
  ['🔰', '选窗'],
  ['⚡', '服务组件'],
  ['📊', '元组件'],
  ['🐳', '侧边框']
]);

function createNode(kind, label, extra = {}) {
  return { kind, label, children: [], ...extra };
}

class JsonLocationParser {
  constructor(source) {
    this.source = String(source || '');
    this.index = 0;
  }

  parse() {
    this.skipWhitespace();
    const node = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      throw new SyntaxError(`JSON 末尾存在无效内容（偏移 ${this.index}）`);
    }
    return node;
  }

  skipWhitespace() {
    while (/\s/.test(this.source[this.index] || '')) this.index += 1;
  }

  parseValue() {
    this.skipWhitespace();
    const char = this.source[this.index];
    if (char === '{') return this.parseObject();
    if (char === '[') return this.parseArray();
    if (char === '"') return this.parseString();
    if (char === '-' || /\d/.test(char || '')) return this.parseNumber();
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]]) {
      if (this.source.startsWith(literal, this.index)) {
        const start = this.index;
        this.index += literal.length;
        return { type: 'literal', value, start, end: this.index };
      }
    }
    throw new SyntaxError(`无法解析 JSON 值（偏移 ${this.index}）`);
  }

  parseObject() {
    const start = this.index;
    const value = {};
    const properties = [];
    this.index += 1;
    this.skipWhitespace();
    if (this.source[this.index] === '}') {
      this.index += 1;
      return { type: 'object', value, properties, start, end: this.index };
    }
    while (this.index < this.source.length) {
      const keyNode = this.parseString();
      this.skipWhitespace();
      if (this.source[this.index] !== ':') {
        throw new SyntaxError(`JSON 对象属性缺少冒号（偏移 ${this.index}）`);
      }
      this.index += 1;
      const child = this.parseValue();
      value[keyNode.value] = child.value;
      properties.push({ key: keyNode.value, keyNode, value: child });
      this.skipWhitespace();
      const separator = this.source[this.index];
      if (separator === '}') {
        this.index += 1;
        return { type: 'object', value, properties, start, end: this.index };
      }
      if (separator !== ',') {
        throw new SyntaxError(`JSON 对象属性之间缺少逗号（偏移 ${this.index}）`);
      }
      this.index += 1;
      this.skipWhitespace();
    }
    throw new SyntaxError(`JSON 对象未结束（偏移 ${start}）`);
  }

  parseArray() {
    const start = this.index;
    const value = [];
    const items = [];
    this.index += 1;
    this.skipWhitespace();
    if (this.source[this.index] === ']') {
      this.index += 1;
      return { type: 'array', value, items, start, end: this.index };
    }
    while (this.index < this.source.length) {
      const child = this.parseValue();
      value.push(child.value);
      items.push(child);
      this.skipWhitespace();
      const separator = this.source[this.index];
      if (separator === ']') {
        this.index += 1;
        return { type: 'array', value, items, start, end: this.index };
      }
      if (separator !== ',') {
        throw new SyntaxError(`JSON 数组元素之间缺少逗号（偏移 ${this.index}）`);
      }
      this.index += 1;
      this.skipWhitespace();
    }
    throw new SyntaxError(`JSON 数组未结束（偏移 ${start}）`);
  }

  parseString() {
    const start = this.index;
    if (this.source[this.index] !== '"') {
      throw new SyntaxError(`JSON 属性名必须是字符串（偏移 ${this.index}）`);
    }
    this.index += 1;
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === '\\') {
        this.index += 2;
      } else if (char === '"') {
        this.index += 1;
        const raw = this.source.slice(start, this.index);
        return { type: 'string', value: JSON.parse(raw), start, end: this.index };
      } else {
        this.index += 1;
      }
    }
    throw new SyntaxError(`JSON 字符串未结束（偏移 ${start}）`);
  }

  parseNumber() {
    const start = this.index;
    const match = this.source.slice(start).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) throw new SyntaxError(`JSON 数字无效（偏移 ${start}）`);
    this.index += match[0].length;
    return { type: 'number', value: Number(match[0]), start, end: this.index };
  }
}

function objectProperty(node, key) {
  if (node?.type !== 'object') return null;
  return node.properties.find((property) => property.key === key) || null;
}

function locatedNode(kind, label, filePath, node, extra = {}) {
  return createNode(kind, label, {
    filePath,
    offset: node?.start || 0,
    endOffset: node?.end || node?.start || 0,
    ...extra
  });
}

const COMPONENT_LABELS = {
  'search-box': '查询区',
  'table-main': '主表',
  'table-item': '明细表',
  'input-box': '表单',
  'tab-page': '页签',
  'tab-item': '页签项'
};

const BACKEND_SCRIPT_KEYS = new Set([
  'script',
  'compScript',
  'doMethodScript',
  'beforeSaveScript',
  'afterSaveScript',
  'complateSaveScript'
]);

function isScriptKey(key) {
  return key !== 'superScript' && (key === 'script' || key.endsWith('Script'));
}

function fieldScriptContext(node) {
  const value = node?.value;
  if (!value || typeof value !== 'object' || !value.fieldId) return '';
  return [value.fieldId, value.label].filter(Boolean).join(' · ');
}

function collectScriptNodes(node, filePath, parentPath, options = {}, state = {}) {
  if (!node) return [];
  const runtime = state.runtime || 'pageEvents';
  const trail = state.trail || '';
  const depth = state.depth || 0;
  if (node.type === 'array') {
    return node.items.flatMap((child, index) => collectScriptNodes(child, filePath, parentPath, options, {
      runtime,
      trail: `${trail}/${index}`,
      depth: depth + 1,
      fieldContext: state.fieldContext || fieldScriptContext(child)
    }));
  }
  if (node.type !== 'object') return [];
  const fieldContext = state.fieldContext || fieldScriptContext(node);
  return node.properties.flatMap((property) => {
    if (depth === 0 && options.excludeKeys?.has(property.key)) return [];
    const nextRuntime = ['serviceEvents', 'superServiceEvents'].includes(property.key)
      ? 'serviceEvents'
      : ['pageEvents', 'superPageEvents'].includes(property.key)
        ? 'pageEvents'
        : runtime;
    const nextTrail = `${trail}/${property.key}`;
    if (isScriptKey(property.key)
      && typeof property.value.value === 'string'
      && property.value.value.trim()) {
      const scriptRuntime = BACKEND_SCRIPT_KEYS.has(property.key) ? 'serviceEvents' : nextRuntime;
      const label = fieldContext ? fieldContext + ' · ' + property.key : property.key;
      return [locatedNode('event', label, filePath, property.value, {
        description: scriptRuntime,
        virtualPath: `${parentPath}/scripts${nextTrail}`
      })];
    }
    return collectScriptNodes(property.value, filePath, parentPath, options, {
      runtime: nextRuntime,
      trail: nextTrail,
      depth: depth + 1,
      fieldContext
    });
  });
}

function scriptGroups(node, filePath, parentPath, options = {}) {
  const scripts = collectScriptNodes(node, filePath, parentPath, options);
  return [
    ['pageEvents', '页面脚本'],
    ['serviceEvents', '服务脚本']
  ].flatMap(([runtime, label]) => {
    const children = scripts.filter((script) => script.description === runtime);
    return children.length
      ? [locatedNode('control-group', `${label}（${children.length}）`, filePath, node, {
        children,
        virtualPath: `${parentPath}/scripts/${runtime}`
      })]
      : [];
  });
}

function fieldGroup(arrayNode, filePath, parentPath) {
  if (arrayNode?.type !== 'array' || !arrayNode.items.length) return null;
  const virtualPath = `${parentPath}/fields`;
  return locatedNode('control-group', `字段（${arrayNode.items.length}）`, filePath, arrayNode, {
    // 字段整体只显示一个虚拟片段；字段内部的 Script 仍按运行时分组。
    children: scriptGroups(arrayNode, filePath, virtualPath),
    virtualPath
  });
}

function buttonNodes(arrayNode, filePath, parentPath) {
  if (arrayNode?.type !== 'array') return [];
  return arrayNode.items.map((node, index) => {
    const button = node.value || {};
    const name = String(button.name || button.aliasName || button.id || `button-${index + 1}`);
    const virtualPath = `${parentPath}/buttons/${index}:${name}`;
    return locatedNode('button', name, filePath, node, {
      description: [button.aliasName, button.bntType].filter(Boolean).join(' · '),
      children: scriptGroups(node, filePath, virtualPath),
      virtualPath
    });
  });
}

function buildComponent(componentNode, filePath, parentPath, index) {
  const component = componentNode.value || {};
  const type = String(component.type || 'component');
  const name = String(component.name || component.id || `${type}-${index + 1}`);
  const virtualPath = `${parentPath}/component/${index}:${name}`;
  const children = [];
  const fieldsNode = objectProperty(componentNode, 'fields')?.value;
  const fields = fieldGroup(fieldsNode, filePath, virtualPath);
  if (fields) children.push(fields);
  const buttonsNode = objectProperty(componentNode, 'buttons')?.value;
  const buttons = buttonNodes(buttonsNode, filePath, virtualPath);
  if (buttons.length) {
    children.push(locatedNode('control-group', `按钮（${buttons.length}）`, filePath, buttonsNode, {
      children: buttons,
      virtualPath: `${virtualPath}/buttons`
    }));
  }
  children.push(...scriptGroups(componentNode, filePath, virtualPath, {
    excludeKeys: new Set(['fields', 'buttons', 'datasource'])
  }));

  const datasourceNode = objectProperty(componentNode, 'datasource')?.value;
  const sqlNode = objectProperty(datasourceNode, 'sql')?.value;
  if (sqlNode && typeof sqlNode.value === 'string' && sqlNode.value.trim()) {
    children.push(locatedNode('datasource', '数据源 SQL', filePath, sqlNode, {
      description: datasourceNode.value?.saveTableId || '',
      virtualPath: `${virtualPath}/datasource/sql`
    }));
  }

  return locatedNode('component', COMPONENT_LABELS[type] || '组件', filePath, componentNode, {
    description: `${name} · ${type}`,
    componentType: type,
    children,
    virtualPath
  });
}

function buildLayoutEntry(entryNode, filePath, parentPath, index) {
  if (entryNode?.type !== 'object') return [];
  const nodes = [];
  const componentNode = objectProperty(entryNode, 'component')?.value;
  if (componentNode?.type === 'object') {
    nodes.push(buildComponent(componentNode, filePath, parentPath, index));
  }
  const tabsNode = objectProperty(entryNode, 'tabs')?.value;
  if (tabsNode?.type === 'object') nodes.push(buildTabs(tabsNode, filePath, `${parentPath}/tabs/${index}`));
  for (const key of ['rows', 'columns']) {
    const nested = objectProperty(entryNode, key)?.value;
    if (nested?.type === 'array') {
      nested.items.forEach((child, childIndex) => {
        nodes.push(...buildLayoutEntry(child, filePath, `${parentPath}/${key}/${index}`, childIndex));
      });
    }
  }
  return nodes;
}

function buildRows(containerNode, filePath, parentPath) {
  const rowsNode = objectProperty(containerNode, 'rows')?.value;
  if (rowsNode?.type !== 'array') return [];
  return rowsNode.items.flatMap((row, index) => buildLayoutEntry(row, filePath, `${parentPath}/rows`, index));
}

function buildTabs(tabsNode, filePath, parentPath) {
  const tabs = tabsNode.value || {};
  const name = String(tabs.name || tabs.id || 'tabPage');
  const pagesNode = objectProperty(tabsNode, 'tabPages')?.value;
  const tabItems = pagesNode?.type === 'array'
    ? pagesNode.items.map((pageNode, index) => {
      const page = pageNode.value || {};
      const pageName = String(page.name || page.id || `tab-${index + 1}`);
      return locatedNode('tab-item', page.label || pageName, filePath, pageNode, {
        description: pageName,
        children: [
          ...scriptGroups(pageNode, filePath, `${parentPath}/${index}:${pageName}`, {
            excludeKeys: new Set(['rows'])
          }),
          ...buildRows(pageNode, filePath, `${parentPath}/${index}:${pageName}`)
        ],
        virtualPath: `${parentPath}/${index}:${pageName}`
      });
    })
    : [];
  const children = [
    ...scriptGroups(tabsNode, filePath, parentPath, { excludeKeys: new Set(['tabPages']) }),
    ...tabItems
  ];
  return locatedNode('component', COMPONENT_LABELS[tabs.type] || '页签', filePath, tabsNode, {
    description: `${name} · ${tabs.type || 'tab-page'}`,
    componentType: tabs.type || 'tab-page',
    children,
    virtualPath: parentPath
  });
}

function parsePageComponents(source, filePath = '') {
  const root = new JsonLocationParser(source).parse();
  if (root.type !== 'object') return [];
  const viewsNode = objectProperty(root, 'views')?.value;
  if (viewsNode?.type !== 'object') return [];
  return [
    ...buildRows(viewsNode, filePath, '$.views'),
    ...scriptGroups(root, filePath, '$.page', { excludeKeys: new Set(['views']) })
  ];
}

function formatJavaScript(source) {
  const text = String(source || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';
  const lines = [];
  const stack = [];
  let line = '';
  let index = 0;
  let indent = 0;
  let parenDepth = 0;
  let pendingSpace = false;
  let lastWord = '';

  const flush = () => {
    const value = line.trim();
    if (value) lines.push(`${'  '.repeat(Math.max(0, indent))}${value}`);
    line = '';
    pendingSpace = false;
  };
  const append = (value) => {
    if (pendingSpace && line && !/[\s([{.]$/.test(line) && !/^[,;.)\]}]/.test(value)) line += ' ';
    line += value;
    pendingSpace = false;
  };
  const readQuoted = (quote) => {
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === '\\') index += 2;
      else if (text[index] === quote) {
        index += 1;
        break;
      } else index += 1;
    }
    return text.slice(start, index);
  };
  const previousSignificant = () => {
    const current = line.trimEnd();
    return current[current.length - 1] || '';
  };
  const canStartRegex = () => {
    const previous = previousSignificant();
    return !previous || /[({[=:;,!?&|+\-*%^~<>]/.test(previous)
      || ['return', 'case', 'throw', 'delete', 'typeof', 'void', 'new', 'in', 'of'].includes(lastWord);
  };
  const readRegex = () => {
    const start = index;
    let inClass = false;
    index += 1;
    while (index < text.length) {
      const char = text[index];
      if (char === '\\') index += 2;
      else if (char === '[') {
        inClass = true;
        index += 1;
      } else if (char === ']') {
        inClass = false;
        index += 1;
      } else if (char === '/' && !inClass) {
        index += 1;
        while (/[a-z]/i.test(text[index] || '')) index += 1;
        break;
      } else index += 1;
    }
    return text.slice(start, index);
  };

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (/\s/.test(char)) {
      if (char === '\n' && line.trim()) flush();
      else pendingSpace = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      append(readQuoted(char));
      lastWord = '';
      continue;
    }
    if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      append(text.slice(index, end < 0 ? text.length : end).trimEnd());
      index = end < 0 ? text.length : end;
      flush();
      continue;
    }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      const comment = text.slice(index, end < 0 ? text.length : end + 2);
      const commentLines = comment.split('\n');
      append(commentLines.shift());
      if (commentLines.length) {
        flush();
        for (const commentLine of commentLines) {
          line = commentLine.trim();
          flush();
        }
      }
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (char === '/' && canStartRegex()) {
      append(readRegex());
      lastWord = '';
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const match = text.slice(index).match(/^[A-Za-z_$][\w$]*/);
      append(match[0]);
      lastWord = match[0];
      index += match[0].length;
      continue;
    }
    const operator = text.slice(index).match(/^(?:===|!==|>>>|\*\*|==|!=|<=|>=|=>|\+=|-=|\*=|\/=|%=|&&|\|\||\?\?|=)/);
    if (operator) {
      if (line && !/\s$/.test(line)) line += ' ';
      line += operator[0];
      pendingSpace = true;
      lastWord = '';
      index += operator[0].length;
      continue;
    }
    if (char === '(') {
      if (['if', 'for', 'while', 'switch', 'catch', 'with'].includes(lastWord) && !/\s$/.test(line)) line += ' ';
      append(char);
      parenDepth += 1;
    } else if (char === ')') {
      append(char);
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (char === '{') {
      const emptyObject = text.slice(index + 1).match(/^\s*}/);
      if (emptyObject) {
        append('{}');
        index += emptyObject[0].length + 1;
        lastWord = '';
        continue;
      }
      if (line && !/\s$/.test(line) && previousSignificant() === ')') line += ' ';
      append(char);
      flush();
      stack.push('{');
      indent += 1;
    } else if (char === '}') {
      flush();
      indent = Math.max(0, indent - 1);
      if (stack.at(-1) === '{') stack.pop();
      append(char);
      const remainder = text.slice(index + 1).match(/^\s*(?:(else|catch|finally)\b|([;,\)\]]))/);
      if (!remainder) flush();
      else if (remainder[1]) pendingSpace = true;
    } else if (char === '[') {
      append(char);
      stack.push('[');
    } else if (char === ']') {
      append(char);
      if (stack.at(-1) === '[') stack.pop();
    } else if (char === ';') {
      append(char);
      if (parenDepth === 0) flush();
      else pendingSpace = true;
    } else if (char === ',') {
      append(char);
      if (stack.at(-1) === '{' && parenDepth === 0) flush();
      else pendingSpace = true;
    } else if (char === ':') {
      append(char);
      pendingSpace = true;
    } else {
      append(char);
    }
    if (!/\s/.test(char)) lastWord = '';
    index += 1;
  }
  flush();
  return `${lines.join('\n')}\n`;
}

function velocityLogicalLines(source) {
  const text = String(source || '').replace(/\r\n?/g, '\n').trim();
  const lines = [];
  let buffer = '';
  let index = 0;
  const flush = () => {
    for (const line of buffer.split('\n')) {
      if (line.trim()) lines.push(line.trim());
    }
    buffer = '';
  };
  const readQuoted = (quote) => {
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === '\\') index += 2;
      else if (text[index] === quote) {
        index += 1;
        break;
      } else index += 1;
    }
    return text.slice(start, index);
  };
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'" || char === '`') {
      buffer += readQuoted(char);
      continue;
    }
    if (char === '#' && text[index + 1] === '#') {
      flush();
      const end = text.indexOf('\n', index);
      lines.push(text.slice(index, end < 0 ? text.length : end).trim());
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (char === '#' && text[index + 1] === '*') {
      flush();
      const end = text.indexOf('*#', index + 2);
      const comment = text.slice(index, end < 0 ? text.length : end + 2);
      lines.push(...comment.split('\n').map((line) => line.trim()).filter(Boolean));
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (char === '#') {
      const directive = text.slice(index).match(/^#(set|if|elseif|else|foreach|while|try|catch|finally|function|end|continue|break)\b/);
      if (directive) {
        flush();
        const start = index;
        index += directive[0].length;
        while (/\s/.test(text[index] || '') && text[index] !== '\n') index += 1;
        if (text[index] === '(') {
          let depth = 0;
          while (index < text.length) {
            const current = text[index];
            if (current === '"' || current === "'" || current === '`') {
              readQuoted(current);
              continue;
            }
            if (current === '(') depth += 1;
            if (current === ')') {
              depth -= 1;
              index += 1;
              if (depth === 0) break;
              continue;
            }
            index += 1;
          }
        }
        if (text[index] === ';') index += 1;
        lines.push(text.slice(start, index).trim());
        continue;
      }
    }
    buffer += char;
    index += 1;
  }
  flush();
  return lines;
}

function formatServiceScript(source) {
  const output = [];
  let indent = 0;
  const closing = /^#(?:end|elseif|else|catch|finally)\b/;
  const opening = /^#(?:if|foreach|while|try|function|elseif|else|catch|finally)\b/;
  for (const line of velocityLogicalLines(source)) {
    if (closing.test(line)) indent = Math.max(0, indent - 1);
    output.push(`${'  '.repeat(indent)}${line}`);
    if (opening.test(line)) indent += 1;
  }
  return output.length ? `${output.join('\n')}\n` : '';
}

function extractPageSegment(source, element) {
  if (!Number.isInteger(element?.offset) || !Number.isInteger(element?.endOffset)) return '';
  const raw = String(source || '').slice(element.offset, element.endOffset);
  if (!raw.trim()) return '';
  try {
    const value = JSON.parse(raw);
    if (element.kind === 'event' || element.kind === 'datasource') {
      const script = String(value);
      if (element.kind === 'event') {
        // Keep the original script text intact so saving one edit does not
        // reformat the whole JSON string.
        return script;
      }
      return `${script}\n`;
    }
    return `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    return `${raw.trim()}\n`;
  }
}

const READABLE_SCRIPT_KEYS = new Set([
  'script',
  'superScript',
  'beforeSaveScript',
  'afterSaveScript',
  'onClickScript',
  'onOpenScript',
  'onCreateScript',
  'onAfterLoadScript',
  'onChangeScript',
  'onBeforeWinCloseScript',
  'doMethodScript',
  'compScript',
  'complateSaveScript',
  'sql'
]);

function readableScriptKey(key) {
  return READABLE_SCRIPT_KEYS.has(key) || String(key).endsWith('Script');
}

const READABLE_SERVICE_SCRIPT_KEYS = new Set([
  'beforeSaveScript',
  'afterSaveScript',
  'doMethodScript',
  'compScript',
  'complateSaveScript'
]);

function formatReadableScript(key, value) {
  if (key === 'sql') return String(value || '').replace(/\r\n?/g, '\n').trim();
  const formatter = READABLE_SERVICE_SCRIPT_KEYS.has(key) ? formatServiceScript : formatJavaScript;
  return formatter(value).replace(/\n$/, '');
}

function collectReadablePageScripts(value, parts = [], runtime = 'pageEvents', output = []) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectReadablePageScripts(child, [...parts, index], runtime, output));
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) {
    const nextRuntime = ['serviceEvents', 'superServiceEvents'].includes(key)
      ? 'serviceEvents'
      : ['pageEvents', 'superPageEvents'].includes(key)
        ? 'pageEvents'
        : runtime;
    const nextParts = [...parts, key];
    if (readableScriptKey(key) && typeof child === 'string') {
      output.push({
        key,
        parts: nextParts,
        runtime: key === 'sql' ? 'SQL' : READABLE_SERVICE_SCRIPT_KEYS.has(key) ? 'serviceEvents' : nextRuntime,
        source: child
      });
    } else {
      collectReadablePageScripts(child, nextParts, nextRuntime, output);
    }
  }
  return output;
}

function formatReadablePageScripts(source) {
  let value = JSON.parse(String(source || ''));
  if (typeof value === 'string') value = JSON.parse(value);
  const scripts = collectReadablePageScripts(value);
  if (!scripts.length) return '// 当前页面没有事件 Script。\n';
  const lines = [];
  for (const script of scripts) {
    lines.push(`// ===== ${script.parts.join(' > ')} · ${script.runtime} =====`);
    lines.push(formatReadableScript(script.key, script.source) || '// （空脚本）');
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function findPageNode(nodes, virtualPath) {
  for (const node of nodes || []) {
    if (node.virtualPath === virtualPath) return node;
    const found = findPageNode(node.children, virtualPath);
    if (found) return found;
  }
  return null;
}

function pageSegmentFingerprint(source, element) {
  if (!element || !Number.isInteger(element.offset) || !Number.isInteger(element.endOffset)) return '';
  return crypto.createHash('sha256')
    .update(String(source || '').slice(element.offset, element.endOffset))
    .digest('hex');
}

function encodeJsonStringLike(value, template) {
  const raw = String(template || '');
  const useCrLf = /\\r\\n/.test(raw);
  const useUnicodeSingleQuote = /\\u0027/i.test(raw);
  const useUnicodeDoubleQuote = /\\u0022/i.test(raw);
  const unicodeStyles = new Map();
  for (const match of raw.matchAll(/\\u([0-9a-f]{4})/gi)) {
    const character = String.fromCharCode(parseInt(match[1], 16));
    if (!unicodeStyles.has(character)) unicodeStyles.set(character, match[0]);
  }
  let encoded = '"';
  for (const character of String(value || '')) {
    if (character === '\n') {
      encoded += useCrLf ? '\\r\\n' : '\\n';
    } else if (character === '\r') {
      encoded += '\\r';
    } else if (character === '\\') {
      encoded += '\\\\';
    } else if (character === '"') {
      encoded += useUnicodeDoubleQuote ? '\\u0022' : '\\"';
    } else if (character === "'") {
      encoded += useUnicodeSingleQuote ? '\\u0027' : "'";
    } else if (character === '\b') {
      encoded += '\\b';
    } else if (character === '\f') {
      encoded += '\\f';
    } else if (character === '\t') {
      encoded += '\\t';
    } else if (character < ' ') {
      encoded += `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
    } else if (unicodeStyles.has(character)) {
      encoded += unicodeStyles.get(character);
    } else {
      encoded += character;
    }
  }
  return `${encoded}"`;
}

function serializeEditedSegment(source, node, content) {
  const edited = String(content || '').replace(/\r\n?/g, '\n');
  if (node.kind === 'event' || node.kind === 'datasource') {
    const rawSegment = source.slice(node.offset, node.endOffset);
    let originalValue = '';
    try {
      originalValue = String(JSON.parse(rawSegment));
    } catch {
      // The page parser already validates this node; keep a safe fallback for callers.
    }
    const withoutEditorNewline = edited.endsWith('\n') ? edited.slice(0, -1) : edited;
    const value = originalValue.endsWith('\n') && edited.endsWith('\n')
      ? `${withoutEditorNewline}\n`
      : withoutEditorNewline;
    if (value === originalValue) return rawSegment;
    if (node.kind === 'event' && node.description === 'pageEvents') {
      try {
        // Page scripts are function bodies in the platform runtime.
        // This catches accidental broken braces before touching the source JSON.
        Function(value); // eslint-disable-line no-new-func
      } catch (error) {
        throw new SyntaxError(`页面 JavaScript 语法错误：${error.message}`);
      }
    }
    return encodeJsonStringLike(value, source.slice(node.offset, node.endOffset));
  }

  let value;
  try {
    value = JSON.parse(edited);
  } catch (error) {
    throw new SyntaxError(`当前虚拟片段不是合法 JSON：${error.message}`);
  }
  const pretty = JSON.stringify(value, null, 2);
  const lineStart = source.lastIndexOf('\n', node.offset - 1) + 1;
  const prefix = source.slice(lineStart, node.offset).match(/^[ \t]*/)?.[0] || '';
  return pretty.split('\n').map((line, index) => index ? `${prefix}${line}` : line).join('\n');
}

function rewritePageSegment(source, virtualPath, content, filePath = '') {
  const tree = parsePageComponents(source, filePath);
  const node = findPageNode(tree, virtualPath);
  if (!node) throw new Error(`原 JSON 中找不到虚拟节点：${virtualPath}`);
  const isFieldCollection = node.kind === 'control-group' && node.virtualPath.endsWith('/fields');
  if (node.kind !== 'event' && node.kind !== 'datasource' && !isFieldCollection) {
    throw new Error('目前只允许回写脚本、数据源 SQL 和字段集合；组件或按钮请在原始 JSON 中修改。');
  }
  const replacement = serializeEditedSegment(source, node, content);
  const updatedSource = source.slice(0, node.offset)
    + replacement
    + source.slice(node.endOffset);
  try {
    JSON.parse(updatedSource);
  } catch (error) {
    throw new SyntaxError(`回写后页面 JSON 校验失败：${error.message}`);
  }
  return {
    source: updatedSource,
    node,
    replacement
  };
}

function resolveIndexLink(indexPath, target) {
  let value = String(target || '').trim();
  if (value.startsWith('<') && value.endsWith('>')) {
    value = value.slice(1, -1);
  }
  value = value.split('#', 1)[0].split('?', 1)[0];
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep the original path when an old index contains a literal percent sign.
  }
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
    return null;
  }

  const systemRoot = path.resolve(path.dirname(indexPath));
  const resolved = path.resolve(systemRoot, value);
  const relative = path.relative(systemRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

function parseLeafLabel(rawLabel) {
  const trimmed = rawLabel.trim();
  const icon = [...PAGE_TYPES.keys()].find((candidate) => trimmed.startsWith(candidate)) || '';
  return {
    icon,
    label: icon ? trimmed.slice(icon.length).trim() : trimmed,
    pageType: PAGE_TYPES.get(icon) || '页面对象'
  };
}

function parsePageIndex(markdown, indexPath) {
  const fallbackSystemId = path.basename(path.dirname(indexPath));
  let system = createNode('system', fallbackSystemId, {
    systemId: fallbackSystemId,
    indexPath
  });
  const stack = [system];
  let currentMenu = null;

  for (const line of String(markdown || '').split(/\r?\n/)) {
    const systemMatch = line.match(/^###\s+🌏\s+(.+?)\s*\((SYS-[^)]+)\)\s*$/);
    if (systemMatch) {
      system.label = systemMatch[1].trim();
      system.systemId = systemMatch[2].trim();
      continue;
    }

    const summaryMatch = line.match(/<summary>\s*(?:-\s*)?📂\s*(.*?)\s*<\/summary>/i);
    if (summaryMatch) {
      const directory = createNode('directory', summaryMatch[1].trim(), {
        systemId: system.systemId,
        indexPath
      });
      stack[stack.length - 1].children.push(directory);
      stack.push(directory);
      currentMenu = null;
      continue;
    }

    if (/<\/details>/i.test(line)) {
      if (stack.length > 1) stack.pop();
      currentMenu = null;
      continue;
    }

    const leafMatch = line.match(/^\s*-\s+\[(.+)\]\((.+)\)\s*$/);
    if (leafMatch) {
      const parsed = parseLeafLabel(leafMatch[1]);
      const filePath = resolveIndexLink(indexPath, leafMatch[2]);
      const leaf = createNode('page', parsed.label, {
        systemId: system.systemId,
        indexPath,
        filePath,
        linkTarget: leafMatch[2].trim(),
        pageType: parsed.pageType,
        pageIcon: parsed.icon
      });
      (currentMenu || stack[stack.length - 1]).children.push(leaf);
      continue;
    }

    const menuMatch = line.match(/^\s*-\s+📄\s+(.+?)\s*$/);
    if (menuMatch) {
      currentMenu = createNode('menu', menuMatch[1].trim(), {
        systemId: system.systemId,
        indexPath
      });
      stack[stack.length - 1].children.push(currentMenu);
    }
  }

  return system;
}

function loadPageIndexes(pagesRoot) {
  if (!fs.existsSync(pagesRoot)) return [];
  return fs.readdirSync(pagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(pagesRoot, entry.name, 'index.md'))
    .filter((indexPath) => fs.existsSync(indexPath))
    .map((indexPath) => parsePageIndex(fs.readFileSync(indexPath, 'utf8'), indexPath))
    .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
}

function collectPages(nodes, ancestors = [], output = []) {
  for (const node of nodes || []) {
    const nextAncestors = node.kind === 'page' ? ancestors : [...ancestors, node.label];
    if (node.kind === 'page') {
      output.push({ ...node, breadcrumb: [...ancestors, node.label].join(' / ') });
    }
    collectPages(node.children, nextAncestors, output);
  }
  return output;
}

function readProductInfo(repositoryRoot) {
  const infoPath = path.join(repositoryRoot, 'info.json');
  try {
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    return { productId: String(info.proId || ''), infoPath };
  } catch {
    return { productId: '', infoPath };
  }
}

module.exports = {
  PAGE_TYPES,
  collectPages,
  extractPageSegment,
  findPageNode,
  formatJavaScript,
  formatServiceScript,
  formatReadablePageScripts,
  loadPageIndexes,
  parsePageComponents,
  pageSegmentFingerprint,
  parsePageIndex,
  readProductInfo,
  rewritePageSegment,
  resolveIndexLink
};

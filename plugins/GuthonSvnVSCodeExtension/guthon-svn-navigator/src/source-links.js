'use strict';

function normalizeLinkText(value) {
  return String(value || '').trim().toLocaleLowerCase('zh-CN');
}

function maskGssCommentsAndStrings(source) {
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
      } else if (current !== '\n' && current !== '\r') {
        masked[index] = ' ';
      }
      continue;
    }
    if (state === 'velocity-comment') {
      if (current === '*' && next === '#') {
        masked[index] = ' ';
        masked[index + 1] = ' ';
        index += 1;
        state = 'code';
      } else if (current !== '\n' && current !== '\r') {
        masked[index] = ' ';
      }
      continue;
    }
    if (state === 'single-quote' || state === 'double-quote') {
      if (current === '\\') {
        if (current !== '\n' && current !== '\r') masked[index] = ' ';
        if (index + 1 < text.length && text[index + 1] !== '\n' && text[index + 1] !== '\r') {
          masked[index + 1] = ' ';
          index += 1;
        }
      } else if ((state === 'single-quote' && current === "'")
        || (state === 'double-quote' && current === '"')) {
        masked[index] = ' ';
        state = 'code';
      } else if (current !== '\n' && current !== '\r') {
        masked[index] = ' ';
      }
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

function extractPageFunctionReferences(text) {
  const source = String(text || '');
  const code = maskGssCommentsAndStrings(source);
  const references = [];
  const definitions = /#function\s+([A-Za-z_]\w*)\s*\(/g;
  const calls = /@([A-Za-z_]\w*)\s*\(/g;
  let match;
  while ((match = definitions.exec(code))) {
    const nameStart = match.index + match[0].indexOf(match[1]);
    references.push({
      kind: 'page-function',
      role: 'definition',
      name: match[1],
      start: nameStart,
      end: nameStart + match[1].length,
      callStart: match.index,
      callEnd: definitions.lastIndex
    });
  }
  while ((match = calls.exec(code))) {
    const nameStart = match.index + match[0].indexOf(match[1]);
    references.push({
      kind: 'page-function',
      role: 'call',
      name: match[1],
      start: nameStart,
      end: nameStart + match[1].length,
      callStart: match.index,
      callEnd: calls.lastIndex
    });
  }
  return references.sort((left, right) => left.start - right.start);
}

function pageFunctionReferenceAtOffset(references, offset) {
  return references.find((reference) => offset >= reference.start && offset <= reference.end)
    || references.find((reference) => offset >= reference.callStart && offset <= reference.callEnd)
    || null;
}

function extractSourceReferences(text) {
  const source = String(text || '');
  const references = [];
  const procBindings = new Map();
  const bindingPattern = /\$([A-Za-z_]\w*)\s*=\s*\$vs\.proc\.find\s*\(\s*(['"])([^'"]+)\2/g;
  let binding;
  while ((binding = bindingPattern.exec(source))) {
    const bindings = procBindings.get(binding[1]) || [];
    bindings.push({
      name: binding[3].trim(),
      index: binding.index,
      start: binding.index + binding[0].indexOf(`$${binding[1]}`) + 1,
      end: binding.index + binding[0].indexOf(`$${binding[1]}`) + 1 + binding[1].length
    });
    procBindings.set(binding[1], bindings);
  }
  const patterns = [
    {
      kind: 'procedure',
      regex: /\$vs\.proc\.invoke\s*\(\s*(['"])([^'"]+)\1\s*,\s*(['"])([^'"]+)\3/g
    },
    {
      kind: 'procedure',
      regex: /\$vs\.proc\.find\s*\(\s*(['"])([^'"]+)\1/g
    },
    {
      kind: 'system-script',
      regex: /\$vs\.proc\.runServiceComp\s*\(\s*(['"])([^'"]+)\1/g
    }
  ];
  for (const { kind, regex } of patterns) {
    let match;
    while ((match = regex.exec(source))) {
      const valueStart = match.index + match[0].lastIndexOf(match[2]);
      references.push({
        kind,
        name: match[2].trim(),
        member: kind === 'procedure' && match[4] ? match[4].trim() : '',
        start: valueStart,
        end: valueStart + match[2].length,
        callStart: match.index,
        callEnd: regex.lastIndex
      });
    }
  }
  for (const [variable, bindings] of procBindings) {
    const methodPattern = new RegExp(`\\$${variable}\\s*\\.\\s*([A-Za-z_]\\w*)\\s*\\(`, 'g');
    let method;
    while ((method = methodPattern.exec(source))) {
      const bindingInfo = bindings
        .filter((candidate) => candidate.index < method.index)
        .at(-1);
      if (!bindingInfo) continue;
      const variableStart = method.index + method[0].indexOf(`$${variable}`);
      const memberStart = method.index + method[0].indexOf(method[1], method[0].indexOf('.') + 1);
      references.push({
        kind: 'procedure',
        name: bindingInfo.name,
        start: variableStart,
        end: memberStart + method[1].length,
        callStart: method.index,
        callEnd: methodPattern.lastIndex,
        binding: variable,
        member: method[1]
      });
    }
  }
  return references.sort((left, right) => left.start - right.start);
}

function procedureMethodMatches(object, reference) {
  if (reference.kind !== 'procedure' || !reference.member || !object?.path) return false;
  const namespace = normalizeLinkText(reference.name).replace(/\\/g, '/').replace(/\./g, '/');
  const member = normalizeLinkText(reference.member);
  const objectPath = normalizeLinkText(object.path).replace(/\\/g, '/');
  const fileName = objectPath.split('/').pop().replace(/\.[^.]+$/, '');
  return fileName === member && (
    objectPath.includes(`/${namespace}/`) ||
    objectPath.endsWith(`/${namespace}/${member}.gss`)
  );
}

function objectMatchesReference(object, reference) {
  const kindMatches = reference.kind === 'system-script'
    ? object?.kind === 'system-script' || object?.kind === 'service-component'
    : object?.kind === reference.kind;
  if (!kindMatches) return false;
  const target = normalizeLinkText(reference.name);
  const values = [object.objectId, object.name, object.path, ...(object.aliases || [])]
    .map(normalizeLinkText)
    .filter(Boolean);
  if (values.includes(target)) return true;
  const fileName = String(object.path || '').split('/').pop().replace(/\.[^.]+$/, '');
  return normalizeLinkText(fileName) === target;
}

function resolveSourceReference(index, reference) {
  if (!index || !reference || (!reference.name && !reference.member)) return null;
  const objects = index.objects || [];
  const scopedObjects = reference.systemId
    ? objects.filter((object) => !object.systemId || object.systemId === reference.systemId)
    : objects;
  const procedureMethod = scopedObjects.find((object) => procedureMethodMatches(object, reference))
    || objects.find((object) => procedureMethodMatches(object, reference));
  if (procedureMethod) return procedureMethod;
  const exact = scopedObjects.find((object) => objectMatchesReference(object, reference))
    || objects.find((object) => objectMatchesReference(object, reference));
  if (exact) return exact;
  const target = normalizeLinkText(reference.name);
  const candidates = scopedObjects.filter((object) => reference.kind === 'system-script'
    ? object.kind === 'system-script' || object.kind === 'service-component'
    : object.kind === reference.kind);
  return candidates.find((object) => [object.objectId, object.name, object.path, ...(object.aliases || [])]
    .some((value) => normalizeLinkText(value).includes(target))) || null;
}

function referenceAtOffset(references, offset) {
  return references.find((reference) => offset >= reference.start && offset <= reference.end)
    || references.find((reference) => offset >= reference.callStart && offset <= reference.callEnd)
    || null;
}

module.exports = {
  extractSourceReferences,
  extractPageFunctionReferences,
  normalizeLinkText,
  objectMatchesReference,
  pageFunctionReferenceAtOffset,
  referenceAtOffset,
  resolveSourceReference
};

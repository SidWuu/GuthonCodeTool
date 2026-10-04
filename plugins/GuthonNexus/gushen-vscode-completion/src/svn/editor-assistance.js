const { decodeIdentity, SCHEME } = require('./virtual-fs');

function documentKind(document) {
  if (document?.uri?.scheme !== SCHEME) return '';
  const identity = decodeIdentity(document.uri);
  if (identity.sourceType === 'page' && identity.jsonPointer.endsWith('/fields')) return 'fields';
  return document.languageId === 'guthon-gss' ? 'gss' : '';
}

function localFunctions(source) {
  const matches = [];
  const pattern = /^[ \t]*#function[ \t]+([A-Za-z_][\w]*)[ \t]*\(/gm;
  for (const match of source.matchAll(pattern)) {
    const offset = match.index + match[0].indexOf(match[1]);
    matches.push({ name: match[1], start: offset, end: offset + match[1].length });
  }
  return matches;
}

function pageFieldIds(source) {
  let fields;
  try {
    fields = JSON.parse(source);
  } catch {
    return [];
  }
  if (!Array.isArray(fields)) return [];
  return fields
    .map((field) => field && typeof field === 'object' && !Array.isArray(field)
      && typeof field.fieldId === 'string' ? field.fieldId.trim() : '')
    .filter(Boolean);
}

function fieldReferencePrefix(source, offset) {
  const match = source.slice(0, offset).match(/"selectCodefieldId"\s*:\s*"([^"\\]*)$/);
  if (!match) return null;
  try {
    if (!Array.isArray(JSON.parse(source))) return null;
  } catch {
    return null;
  }
  return match[1];
}

function pageFieldOccurrences(source) {
  const ids = pageFieldIds(source);
  const matches = [...source.matchAll(/"fieldId"\s*:\s*"((?:\\.|[^"\\])*)"/g)]
    .map((match) => {
      const name = JSON.parse(`"${match[1]}"`).trim();
      const start = match.index + match[0].lastIndexOf(`"${match[1]}"`) + 1;
      return { name, start, end: start + match[1].length };
    })
    .filter((item) => item.name);
  if (matches.length !== ids.length || matches.some((item, index) => item.name !== ids[index])) {
    return ids.map((name) => ({ name }));
  }
  return matches;
}

function diagnostics(kind, source) {
  const names = kind === 'gss' ? localFunctions(source) : [];
  if (kind === 'fields') {
    const fields = pageFieldOccurrences(source);
    const seen = new Set();
    return fields.flatMap((item) => {
      if (seen.has(item.name)) return [{ ...item, message: `同一字段集合中重复的 fieldId：${item.name}`, code: 'GUTHON_DUPLICATE_FIELD_ID' }];
      seen.add(item.name);
      return [];
    });
  }
  const seen = new Set();
  return names.flatMap((item) => {
    if (seen.has(item.name)) return [{ ...item, message: `重复的本地函数定义：${item.name}`, code: 'GUTHON_DUPLICATE_FUNCTION' }];
    seen.add(item.name);
    return [];
  });
}

function completions(kind, source, offset) {
  const before = source.slice(0, offset);
  if (kind === 'gss') {
    const match = before.match(/@([A-Za-z_]\w*)?$/);
    if (!match) return [];
    const prefix = match[1] || '';
    const names = [...new Set(localFunctions(source).map((item) => item.name))];
    return names.filter((name) => name.startsWith(prefix))
      .map((name) => ({ name, start: offset - prefix.length, end: offset }));
  }
  if (kind === 'fields') {
    const prefix = fieldReferencePrefix(source, offset);
    if (prefix === null) return [];
    return [...new Set(pageFieldIds(source))].filter((name) => name.startsWith(prefix))
      .map((name) => ({ name, start: offset - prefix.length, end: offset }));
  }
  return [];
}

function procedureCompletionTarget(source, offset) {
  const before = source.slice(Math.max(0, offset - 1024), offset);
  const match = before.match(/\$vs\.proc\.(invoke|find)\(\s*(["'])([A-Za-z0-9_.$]*)(?:\2\s*,\s*(["'])([A-Za-z0-9_$]*))?$/);
  if (!match) return null;
  // The second proc.find argument is timeout, not a function name (API data).
  if (match[4] && match[1] !== 'invoke') return null;
  const argument = match[4] ? 'function' : 'alias';
  const prefix = argument === 'alias' ? match[3] : match[5];
  if (match[3].length < 2) return null;
  return {argument, alias: argument === 'function' ? match[3] : '', keyword: match[3], prefix,
    start: offset - prefix.length, end: offset};
}

function registerEditorAssistance(vscode, { pageFieldCandidates, procedureCandidates } = {}) {
  const collection = vscode.languages.createDiagnosticCollection('Guthon Nexus');
  const pending = new Map();
  const update = (document) => {
    const kind = documentKind(document);
    if (!kind) return;
    const source = document.getText();
    const items = diagnostics(kind, source).map((item) => {
      const range = item.start === undefined
        ? new vscode.Range(0, 0, 0, 0)
        : new vscode.Range(document.positionAt(item.start), document.positionAt(item.end));
      const diagnostic = new vscode.Diagnostic(range, item.message, vscode.DiagnosticSeverity.Warning);
      diagnostic.code = item.code;
      diagnostic.source = 'Guthon Nexus';
      return diagnostic;
    });
    collection.set(document.uri, items);
  };
  for (const document of vscode.workspace.textDocuments) update(document);
  const open = vscode.workspace.onDidOpenTextDocument(update);
  const change = vscode.workspace.onDidChangeTextDocument((event) => {
    if (!documentKind(event.document)) return;
    const key = event.document.uri.toString();
    clearTimeout(pending.get(key));
    pending.set(key, setTimeout(() => {
      pending.delete(key);
      update(event.document);
    }, 150));
  });
  const close = vscode.workspace.onDidCloseTextDocument((document) => {
    const key = document.uri.toString();
    clearTimeout(pending.get(key));
    pending.delete(key);
    collection.delete(document.uri);
  });
  const completion = vscode.languages.registerCompletionItemProvider(
    ['guthon-gss', 'json', 'javascript', 'java'].map(language => ({scheme:SCHEME, language})),
    {
      async provideCompletionItems(document, position, token) {
        const kind = documentKind(document);
        if (!kind && (document.uri?.scheme !== SCHEME || !['javascript', 'java'].includes(document.languageId))) return [];
        const version = document.version;
        const source = document.getText();
        const offset = document.offsetAt(position);
        const local = completions(kind, source, offset);
        const prefix = kind === 'fields' ? fieldReferencePrefix(source, offset) : null;
        let indexed = { fields: [], truncated: false };
        const target = ['guthon-gss', 'javascript', 'java'].includes(document.languageId) ? procedureCompletionTarget(source, offset) : null;
        let procedures = {sources:[], truncated:false};
        if (target && procedureCandidates && !token?.isCancellationRequested) {
          try {procedures = await procedureCandidates(document, target, token);} catch {
            // API and current-document completions still work without a ready index.
          }
        }
        if (prefix !== null && prefix.length >= 2 && pageFieldCandidates) {
          try {
            indexed = await pageFieldCandidates(document, prefix, token);
          } catch {
            // Keep current-document suggestions available when the index is stale or unavailable.
          }
        }
        if (token?.isCancellationRequested || document.version !== version) return [];
        const items = local.map((item) => {
          const result = new vscode.CompletionItem(
            item.name,
            kind === 'gss' ? vscode.CompletionItemKind.Function : vscode.CompletionItemKind.Field
          );
          result.range = new vscode.Range(document.positionAt(item.start), document.positionAt(item.end));
          result.insertText = item.name;
          result.detail = kind === 'gss' ? '当前 GSS 文档中的本地函数' : '当前 PAGE 字段集合中的 fieldId';
          return result;
        });
        if (prefix !== null) {
          const localNames = new Set(local.map((item) => item.name));
          for (const field of indexed?.fields || []) {
            const name = String(field.fieldId || '');
            if (!name.startsWith(prefix) || localNames.has(name)) continue;
            const result = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);
            result.range = new vscode.Range(document.positionAt(offset - prefix.length), position);
            result.insertText = name;
            result.detail = `${field.label || field.regionType || 'PAGE 字段'} · ${field.collectionPointer}`;
            items.push(result);
          }
        }
        if (target) {
          const seen = new Set();
          for (const candidate of procedures?.sources || []) {
            if (candidate.status !== 'OK' || candidate.sourceType !== 'procedure') continue;
            if (target.argument === 'function' && candidate.sourceAliasId !== target.alias) continue;
            const name = target.argument === 'alias' ? candidate.sourceAliasId : candidate.funId;
            if (typeof name !== 'string') continue;
            if (!/^[A-Za-z_$][A-Za-z0-9_.$]*$/.test(name) || !name.startsWith(target.prefix)) continue;
            const key = `${name}\0${candidate.sourceNamespace}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const result = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
            result.range = new vscode.Range(document.positionAt(target.start), position);
            result.insertText = name;
            result.detail = `${candidate.sourceName || candidate.sourceId} · ${candidate.sourceNamespace}（索引候选）`;
            items.push(result);
          }
        }
        return indexed?.truncated || procedures?.truncated ? new vscode.CompletionList(items, true) : items;
      },
    },
    '@', '"', "'"
  );
  return { dispose() {
    for (const timer of pending.values()) clearTimeout(timer);
    completion.dispose(); close.dispose(); change.dispose(); open.dispose(); collection.dispose();
  } };
}

module.exports = {
  completions, diagnostics, documentKind, fieldReferencePrefix,
  localFunctions, pageFieldIds, registerEditorAssistance,
  procedureCompletionTarget,
};

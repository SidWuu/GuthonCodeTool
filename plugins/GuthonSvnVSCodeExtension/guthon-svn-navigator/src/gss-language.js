const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const {
  filterItems,
  findHoverItems,
  getCurrentWord,
  itemBodyToSnippet,
  itemDocumentation,
  itemFilterText,
  itemLabel,
  itemSortText,
  mergeCompletionData,
  resolveRoute,
  shouldProvideApiCompletions,
} = require('./gss-rules');
const { readProjectAiIndex } = require('./ai-index');
const { discoverProjectLayout } = require('./project-layout');
const {
  inheritCalls,
  inheritanceParentPath,
  isInheritanceParent,
  isSupportedInheritancePath
} = require('./gss-inheritance');
const {
  extractPageFunctionReferences,
  extractSourceReferences,
  pageFunctionReferenceAtOffset,
  referenceAtOffset,
  resolveSourceReference
} = require('./source-links');

const sourceIndexCache = new Map();

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadCompletionData(extensionPath) {
  const generated = readJson(path.join(extensionPath, 'data', 'index.json'));
  const manualPath = path.join(extensionPath, 'data', 'manual.json');
  const manual = fs.existsSync(manualPath) ? readJson(manualPath) : {};
  return mergeCompletionData(generated, manual);
}

function completionRange(position, currentWord) {
  return new vscode.Range(
    position.line,
    position.character - currentWord.length,
    position.line,
    position.character
  );
}

function toCompletionItem(item, range, route, currentWord) {
  const completion = new vscode.CompletionItem(itemLabel(item), vscode.CompletionItemKind.Snippet);
  completion.detail = `${item.language}/${item.group}`;
  completion.documentation = new vscode.MarkdownString(itemDocumentation(item));
  completion.insertText = new vscode.SnippetString(itemBodyToSnippet(item.body));
  completion.range = range;
  completion.sortText = itemSortText(item, route, currentWord);
  completion.filterText = itemFilterText(item, currentWord);
  return completion;
}

function sourcePathForDocument(document) {
  if (document.uri.scheme === 'file') return document.uri.fsPath;
  if (document.uri.query) {
    try {
      const source = new URLSearchParams(document.uri.query).get('source');
      if (source) return source;
    } catch {
      // A normal file document does not need query parsing.
    }
  }
  return '';
}

function isGssDocument(document) {
  return Boolean(document?.uri?.path?.toLowerCase().endsWith('.gss'));
}

async function readSourceIndex(root) {
  if (!root) return null;
  const manifestPath = path.join(root, 'docs', 'ai-index', 'manifest.json');
  let stat;
  try { stat = await fs.promises.stat(manifestPath); } catch { return null; }
  const cached = sourceIndexCache.get(root);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.index;
  const index = await readProjectAiIndex(root);
  if (index) sourceIndexCache.set(root, { mtimeMs: stat.mtimeMs, size: stat.size, index });
  return index;
}

async function findPageBinding(sourcePath, binding) {
  if (!sourcePath || !binding || !sourcePath.toLowerCase().endsWith('.json')) return '';
  let source;
  try { source = await fs.promises.readFile(sourcePath, 'utf8'); } catch { return ''; }
  let json;
  try { json = JSON.parse(source); } catch { return ''; }
  const texts = [];
  const collect = (value) => {
    if (typeof value === 'string') {
      texts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(json);
  for (const text of texts) {
    const reference = extractSourceReferences(text).find((item) => item.binding === binding && item.name);
    if (reference) return reference.name;
  }
  return '';
}

async function walkFiles(directory, output = []) {
  let entries;
  try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    if (entry.name === '.svn' || entry.name === '.git' || entry.name === 'node_modules') continue;
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkFiles(filePath, output);
    else output.push(filePath);
  }
  return output;
}

async function fallbackSourceObject(root, reference) {
  if (!root || !reference?.name) return null;
  const layout = discoverProjectLayout(root);
  if (reference.kind === 'procedure' && reference.member) {
    const namespace = String(reference.name).trim().replace(/\\/g, '.').split('.').filter(Boolean);
    const member = String(reference.member).trim();
    for (const scope of layout.sourceRoots.procedures || []) {
      const filePath = path.join(scope.root, ...namespace, `${member}.gss`);
      if (!fs.existsSync(filePath)) continue;
      return {
        kind: 'procedure',
        objectId: member,
        name: member,
        path: path.relative(root, filePath).replace(/\\/g, '/')
      };
    }
  }
  if (reference.kind === 'system-script') {
    const pageFiles = [];
    for (const pageRoot of layout.pageRoots || []) await walkFiles(pageRoot.root, pageFiles);
    const target = String(reference.name).trim().toLocaleLowerCase('zh-CN');
    for (const filePath of pageFiles) {
      if (path.extname(filePath).toLowerCase() !== '.gss') continue;
      const fileName = path.basename(filePath, '.gss').toLocaleLowerCase('zh-CN');
      let source = '';
      try { source = await fs.promises.readFile(filePath, 'utf8'); } catch { continue; }
      const alias = source.match(/^\s*\*\s*@pageAliasId\s+([^\r\n]*)$/mi)?.[1]?.trim().toLocaleLowerCase('zh-CN');
      if (fileName !== target && alias !== target) continue;
      const relative = path.relative(root, filePath).replace(/\\/g, '/');
      return {
        kind: 'service-component',
        objectId: reference.name,
        name: source.match(/^\s*\*\s*@pageName\s+([^\r\n]*)$/mi)?.[1]?.trim() || reference.name,
        systemId: relative.match(/^systems\/([^/]+)\/pages\//)?.[1] || '',
        path: relative
      };
    }
  }
  return null;
}

function sourceLinkProvider(options = {}) {
  const repositoryRootFor = options.repositoryRootFor || (() => '');

  function inheritanceLocation(document, offset) {
    const sourcePath = sourcePathForDocument(document);
    if (!sourcePath || isInheritanceParent(sourcePath) || !isSupportedInheritancePath(sourcePath)) return null;
    const call = inheritCalls(document.getText()).find((candidate) => (
      offset >= candidate.nameStart && offset <= candidate.nameEnd
      || offset >= candidate.start && offset <= candidate.end
    ));
    if (!call) return null;
    const parentPath = inheritanceParentPath(sourcePath);
    if (!parentPath || !fs.existsSync(parentPath)) return null;
    const uri = options.inheritanceUriFor
      ? options.inheritanceUriFor(parentPath, sourcePath)
      : vscode.Uri.file(parentPath);
    return { call, location: new vscode.Location(uri, new vscode.Position(0, 0)) };
  }

  async function resolveReference(document, reference) {
    const sourcePath = sourcePathForDocument(document);
    const root = repositoryRootFor(sourcePath);
    if (reference?.binding && !reference.name) {
      reference = { ...reference, name: await findPageBinding(sourcePath, reference.binding) };
    }
    if (!root) return null;
    if (reference?.kind === 'system-script' && sourcePath) {
      const relative = path.relative(root, sourcePath).replace(/\\/g, '/');
      const systemId = relative.match(/^systems\/([^/]+)\/pages\//)?.[1] || '';
      if (systemId) reference = { ...reference, systemId };
    }
    const index = await readSourceIndex(root);
    const object = resolveSourceReference(index, reference)
      || await fallbackSourceObject(root, reference);
    if (!object?.path) return null;
    const targetPath = path.resolve(root, object.path);
    if (!fs.existsSync(targetPath)) return null;
    let line = 0;
    try {
      const targetSource = await fs.promises.readFile(targetPath, 'utf8');
      const marker = object.objectId || object.name;
      const offset = marker ? targetSource.indexOf(marker) : -1;
      if (offset >= 0) line = targetSource.slice(0, offset).split('\n').length - 1;
    } catch {
      // Opening the file is still useful when the target line cannot be found.
    }
    return {
      object,
      location: new vscode.Location(vscode.Uri.file(targetPath), new vscode.Position(line, 0))
    };
  }

  return {
    definition: {
      async provideDefinition(document, position) {
        if (isGssDocument(document)) {
          const inherited = inheritanceLocation(document, document.offsetAt(position));
          if (inherited) return inherited.location;
          const pageFunctions = extractPageFunctionReferences(document.getText());
          const pageReference = pageFunctionReferenceAtOffset(
            pageFunctions,
            document.offsetAt(position)
          );
          if (pageReference?.role === 'call') {
            const definition = pageFunctions.find((reference) => (
              reference.role === 'definition' && reference.name === pageReference.name
            ));
            if (definition) {
              return new vscode.Location(
                document.uri,
                new vscode.Position(
                  document.positionAt(definition.start).line,
                  document.positionAt(definition.start).character
                )
              );
            }
          }
        }
        const reference = referenceAtOffset(
          extractSourceReferences(document.getText()),
          document.offsetAt(position)
        );
        const resolved = await resolveReference(document, reference);
        return resolved?.location;
      }
    },
    documentLinks: {
      async provideDocumentLinks(document) {
        const references = extractSourceReferences(document.getText());
        const links = [];
        if (isGssDocument(document)) {
          for (const call of inheritCalls(document.getText())) {
            const inherited = inheritanceLocation(document, call.nameStart);
            if (!inherited) continue;
            const link = new vscode.DocumentLink(
              new vscode.Range(document.positionAt(call.nameStart), document.positionAt(call.nameEnd)),
              inherited.location.uri
            );
            link.tooltip = '只读查看父级继承实现';
            links.push(link);
          }
        }
        for (const reference of references) {
          const resolved = await resolveReference(document, reference);
          if (!resolved) continue;
          const link = new vscode.DocumentLink(
            new vscode.Range(document.positionAt(reference.start), document.positionAt(reference.end)),
            resolved.location.uri
          );
          link.tooltip = `跳转到${resolved.object.kind === 'procedure' ? '过程函数' : '服务组件'}：${resolved.object.name}`;
          links.push(link);
        }
        return links;
      }
    },
    codeLens: {
      provideCodeLenses(document) {
        if (!isGssDocument(document)) return [];
        return extractPageFunctionReferences(document.getText())
          .filter((reference) => reference.role === 'definition')
          .map((reference) => {
            const position = document.positionAt(reference.start);
            return new vscode.CodeLens(
              new vscode.Range(position, position),
              {
                title: '返回调用位置',
                command: 'workbench.action.navigateBack'
              }
            );
          });
      }
    }
  };
}

function createGssLanguageProviders(context, options = {}) {
  const data = loadCompletionData(context.extensionPath);
  const rules = readJson(path.join(context.extensionPath, 'gss-rules.json'));
  const sourceLanguage = 'gushen-vm';

  return {
    completion: {
      provideCompletionItems(document, position) {
        const currentWord = getCurrentWord(document.lineAt(position.line).text, position.character);
        if (!shouldProvideApiCompletions(currentWord)) return [];

        const route = resolveRoute(rules, sourceLanguage, currentWord);
        const range = completionRange(position, currentWord);
        return filterItems(data, route, currentWord)
          .map((item) => toCompletionItem(item, range, route, currentWord));
      },
    },
    hover: {
      provideHover(document, position) {
        const range = document.getWordRangeAtPosition(
          position,
          /[$A-Za-z_][\w$]*(?:\.[A-Za-z_]\w*)+/
        );
        if (!range) return undefined;

        const items = findHoverItems(data, 'java', document.getText(range));
        if (!items.length) return undefined;

        const documentation = [...new Set(items.map(itemDocumentation))].join('\n\n---\n\n');
        return new vscode.Hover(new vscode.MarkdownString(documentation), range);
      },
    },
    ...sourceLinkProvider(options),
  };
}

module.exports = { createGssLanguageProviders };

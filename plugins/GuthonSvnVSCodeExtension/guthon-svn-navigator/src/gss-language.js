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

function createGssLanguageProviders(context) {
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
  };
}

module.exports = { createGssLanguageProviders };

const test = require('node:test');
const assert = require('node:assert/strict');
const { SvnInheritanceView } = require('../src/svn/inheritance-view');

test('inheritance view renders project and product origins from a bounded read', async () => {
  const vscode = {
    EventEmitter: class { dispose() {} fire() {} },
    Uri: {
      from: (parts) => ({ ...parts, toString: () => JSON.stringify(parts) }),
      parse: (value) => ({ toString: () => value }),
    },
    workspace: { openTextDocument: async (uri) => ({ uri }) },
    window: { showTextDocument: async () => {} },
  };
  const calls = [];
  const backend = {
    pageQuery: async (_workspaceKey, name, args) => {
      calls.push({ name, args });
      return {
        project: { sourcePath: 'procedures/pkg/save.gss', sourceHash: 'a' },
        product: { sourcePath: 'procedures/pkg/save.inherit.gss', sourceHash: 'b' },
        indexGeneration: 'gen', inheritanceStatus: 'ACTIVE', segments: [
          { layer: 'product', start: 0, end: 10, sourceLine: 5, effectiveLine: 1 },
          { layer: 'project', start: 10, end: 20, sourceLine: 7, effectiveLine: 2 },
        ],
        effective: { content: 'product();\nproject();', complete: true },
        projectOriginal: { content: '@inherit();\nproject();', complete: true },
        productOriginal: { content: 'product();', complete: true },
        complete: true,
      };
    },
  };
  const view = new SvnInheritanceView({ vscode, backend });
  const uri = await view.open({ workspaceKey: 'projects.demo', sourceType: 'procedure',
    sourceNamespace: 'datasources/1', sourceId: 'pkg#save', funId: 'save', workingCopyId: 'root' });
  const content = await view.provideTextDocumentContent(uri);
  assert.match(content, /产品继承源码/);
  assert.match(content, /项目源码/);
  assert.match(content, /原文第 5 行/);
  assert.equal(calls[0].name, 'read_inherited_source');
  assert.equal(calls[0].args.workingCopyId, 'root');
  view.dispose();
});

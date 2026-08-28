const assert = require('node:assert/strict');
const test = require('node:test');
const {
  decodeIdentity,
  documentExtension,
  documentFilename,
  encodeIdentity,
  SvnVirtualFileSystem,
} = require('../src/svn/virtual-fs');

test('encodes only stable object identity in SVN virtual URIs', () => {
  const identity = {
    workspaceKey: 'projects.demo',
    sourceType: 'page',
    sourceId: 'PG-1',
    funId: '',
    jsonPointer: '/pageSetup/pageEvents/onOpenScript',
  };
  const query = encodeIdentity(identity);
  assert.equal(query.includes('/checkout/'), false);
  assert.deepEqual(decodeIdentity({ authority: identity.workspaceKey, query }), identity);
});

test('selects a readable virtual filename extension', () => {
  assert.equal(documentExtension({ sourceType: 'page', jsonPointer: '/sources/0/sql' }), 'sql');
  assert.equal(documentExtension({ sourceType: 'view', jsonPointer: '/viewSql' }), 'sql');
  assert.equal(documentExtension({ sourceType: 'page', jsonPointer: '/views/0/fields' }), 'json');
  assert.equal(documentExtension({ sourceType: 'procedure' }), 'gss');
  assert.equal(documentExtension({ sourceType: 'public' }), 'txt');
  assert.equal(documentExtension({ sourceType: 'public', sourceId: 'public:bill-types.json' }), 'json');
  assert.equal(documentExtension({ sourceType: 'public', sourceId: 'public:module-comps.json' }), 'json');
  assert.equal(documentExtension({ sourceType: 'skill', sourceId: 'skill:README.md' }), 'md');
  assert.equal(
    documentFilename({ sourceType: 'public', sourceId: 'public:bill-types.json' }),
    'public_bill-types.json'
  );
  assert.equal(documentExtension({ sourceType: 'page', jsonPointer: '/events/onClickScript' }), 'js');
  assert.equal(documentExtension({ sourceType: 'page', fragmentType: 'gss' }), 'gss');
  assert.equal(documentExtension({ sourceType: 'page', fragmentType: 'vm' }), 'gss');
});

test('registers a dedicated GSS language while retaining legacy VM as Java', () => {
  const manifest = require('../package.json');
  const gss = manifest.contributes.languages.find((language) => language.id === 'guthon-gss');
  const java = manifest.contributes.languages.find((language) => language.id === 'java');
  assert.deepEqual(gss.extensions, ['.gss']);
  assert.deepEqual(java.extensions, ['.vm']);
  assert.equal(manifest.contributes.grammars.length, 2);
});

test('accepts VS Code create-and-overwrite flags only for an existing backend object', async () => {
  class EventEmitter {
    constructor() { this.event = () => {}; this.events = []; }
    fire(value) { this.events.push(value); }
    dispose() {}
  }
  const vscode = {
    EventEmitter,
    FileType: { File: 1 },
    FileChangeType: { Changed: 1 },
    FileSystemError: { NoPermissions: (message) => new Error(message) },
  };
  const writes = [];
  const lifecycle = [];
  const backend = {
    async read() {
      return {
        editable: true,
        sessionId: 'session',
        documentId: 'document',
        sourcePath: 'procedures/DS-1/demo/pkg/save.gss',
        content: 'before',
      };
    },
    async write(...args) {
      writes.push(args);
      return { ok: true, changed: true };
    },
  };
  const provider = new SvnVirtualFileSystem({
    vscode,
    backend,
    onWillSave: (workspaceKey, sourcePath) => lifecycle.push(['before', workspaceKey, sourcePath]),
    onSaved: (workspaceKey, result) => lifecycle.push(['after', workspaceKey, result.changed]),
  });
  const uri = {
    authority: 'projects.demo',
    query: 'sourceType=procedure&sourceId=demo.pkg%23save&funId=save',
    toString: () => 'guthon-svn-edit://projects.demo/save.gss?sourceType=procedure',
  };

  await provider.writeFile(uri, Buffer.from('after'), { create: true, overwrite: true });
  const afterFirstSave = await provider.stat(uri);
  await provider.writeFile(uri, Buffer.from('after again'), { create: true, overwrite: true });
  const afterSecondSave = await provider.stat(uri);

  assert.deepEqual(writes[0], ['projects.demo', 'session', 'document', 'after']);
  assert.deepEqual(writes[1], ['projects.demo', 'session', 'document', 'after again']);
  assert.equal(afterFirstSave.mtime, afterSecondSave.mtime);
  assert.equal(provider.changed.events.length, 0);
  assert.deepEqual(lifecycle, [
    ['before', 'projects.demo', 'procedures/DS-1/demo/pkg/save.gss'],
    ['after', 'projects.demo', true],
    ['before', 'projects.demo', 'procedures/DS-1/demo/pkg/save.gss'],
    ['after', 'projects.demo', true],
  ]);
  provider.dispose();
});

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  decodeIdentity,
  documentExtension,
  documentFilename,
  encodeIdentity,
  SvnVirtualFileSystem,
  utf16Offset,
} = require('../src/svn/virtual-fs');

test('maps Python source offsets after non-BMP characters into editor offsets', () => {
  assert.equal(utf16Offset('项目😀@inherit();', 3), 4);
});

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
  const namespaced = {...identity, sourceNamespace:'ds-one:pages/SYS-1',workingCopyId:'copy-one'};
  assert.deepEqual(decodeIdentity({authority:identity.workspaceKey,query:encodeIdentity(namespaced)}), namespaced);
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
  assert.equal(
    documentExtension({ sourceType: 'system-script', sourcePath: 'system-script/SYS-1/20.js' }),
    'js'
  );
  assert.equal(
    documentExtension({ sourceType: 'system-script', sourcePath: 'system-script/SYS-1/21.gss' }),
    'gss'
  );
  assert.equal(
    documentExtension({ sourceType: 'page', sourcePath: 'pages/PG-1.gss' }),
    'gss'
  );
  assert.equal(
    documentFilename({ sourceType: 'page', sourceId: 'PG-1', sourcePath: 'pages/PG-1.gss' }),
    'PG-1.gss'
  );
  assert.equal(
    documentFilename({
      sourceType: 'page', sourceId: 'PG-1', sourcePath: 'pages/PG-1.gss', documentName: '拉取记录',
    }),
    '拉取记录.gss'
  );
  assert.equal(
    documentFilename({
      sourceType: 'procedure', sourceId: 'demo.pkg#save', funId: 'save', sourceName: '保存业务数据',
    }),
    'save.gss'
  );
});

test('registers a dedicated GSS language while retaining legacy VM as Java', () => {
  const manifest = require('../package.json');
  const gss = manifest.contributes.languages.find((language) => language.id === 'guthon-gss');
  const java = manifest.contributes.languages.find((language) => language.id === 'java');
  assert.deepEqual(gss.extensions, ['.gss']);
  assert.deepEqual(java.extensions, ['.vm']);
  assert.equal(manifest.contributes.grammars.length, 2);
});

test('opens a virtual source at a requested indexed line', async () => {
  class EventEmitter {
    constructor() { this.event = () => {}; }
    dispose() {}
  }
  class Position {
    constructor(line, character) { Object.assign(this, { line, character }); }
  }
  class Range {
    constructor(start, end) { Object.assign(this, { start, end }); }
  }
  class Selection extends Range {}
  const editor = { revealRangeCalls: [], revealRange(...args) { this.revealRangeCalls.push(args); } };
  const document = { lineCount: 10 };
  let uri;
  const vscode = {
    EventEmitter,
    Position,
    Range,
    Selection,
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    Uri: {
      from(value) {
        uri = { ...value, toString: () => 'guthon-svn-edit://products.demo/save.gss' };
        return uri;
      },
    },
    workspace: { openTextDocument: async () => document },
    window: {
      showTextDocument: async () => editor,
      showWarningMessage() {},
    },
  };
  const provider = new SvnVirtualFileSystem({
    vscode,
    backend: { read: async () => ({ editable: true, content: 'source' }) },
  });

  await provider.open({
    workspaceKey: 'products.demo', sourceType: 'procedure', sourceId: 'demo#save', funId: 'save',
  }, { lineNumber: 27 });

  assert.equal(editor.selection.start.line, 9);
  assert.equal(editor.selection.start.character, 0);
  assert.equal(editor.revealRangeCalls[0][1], 2);
  provider.dispose();
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

test('revalidates a stale readonly virtual tab before rejecting save', async () => {
  class EventEmitter {
    constructor() { this.event = () => {}; }
    dispose() {}
  }
  const vscode = {
    EventEmitter,
    FileType: { File: 1 },
    FileChangeType: { Changed: 1 },
    FileSystemError: { NoPermissions: (message) => new Error(message) },
  };
  const uri = {
    authority: 'products.demo',
    query: 'sourceType=page&sourceId=PG-GSS-1&workingCopyId=systems-SYS-1',
    toString: () => 'guthon-svn-edit://products.demo/采购计划删除.gss?sourceType=page',
  };
  let reads = 0;
  const writes = [];
  const backend = {
    async read() {
      reads += 1;
      return reads === 1
        ? { editable: false, content: 'before' }
        : {
          editable: true,
          sessionId: 'session',
          documentId: 'document',
          sourcePath: 'systems/SYS-1/pages/采购计划删除.gss',
          content: 'before',
        };
    },
    async write(...args) {
      writes.push(args);
      return { ok: true, changed: true };
    },
  };
  const provider = new SvnVirtualFileSystem({ vscode, backend });

  await provider.readFile(uri);
  await provider.writeFile(uri, Buffer.from('after'), { overwrite: true });

  assert.equal(reads, 2);
  assert.deepEqual(writes, [['products.demo', 'session', 'document', 'after']]);
  provider.dispose();
});

test('opens inherited source inline and preserves marker when only project text changes', async () => {
  class EventEmitter { constructor() { this.event = () => {}; } dispose() {} }
  const vscode = { EventEmitter, FileType: { File: 1 },
    FileSystemError: { NoPermissions: (message) => new Error(message) } };
  const uri = { authority: 'projects.demo', query: 'sourceType=procedure&sourceId=pkg%23save&funId=save&workingCopyId=wc',
    toString: () => 'guthon-svn-edit://projects.demo/save.gss' };
  const project = 'before();\n@inherit();\nafter();';
  const effective = 'before();\nproduct();\nafter();';
  const writes = [];
  const backend = {
    read: async () => ({ editable: true, sessionId: 's', documentId: 'd',
      sourceNamespace: 'datasources/1', sourcePath: 'pkg/save.gss', content: project }),
    pageQuery: async (_workspace, name, args) => {
      assert.equal(name, 'read_inherited_source');
      assert.equal(args.sourceNamespace, 'datasources/1');
      return { inheritanceStatus: 'ACTIVE', indexGeneration: 'gen',
        project: { sourceHash: 'project-hash' }, product: { sourceHash: 'product-hash' },
        segments: [
          { layer: 'project', start: 0, end: 10, sourceStart: 0, sourceEnd: 10 },
          { layer: 'product', start: 10, end: 20, sourceStart: 10, sourceEnd: 21 },
          { layer: 'project', start: 20, end: effective.length, sourceStart: 21, sourceEnd: project.length },
        ],
        effective: { content: effective }, projectOriginal: { content: project },
        productOriginal: { content: 'product();' }, complete: true };
    },
    write: async (...args) => { writes.push(args); return { changed: true }; },
  };
  const provider = new SvnVirtualFileSystem({ vscode, backend });
  assert.equal((await provider.readFile(uri)).toString(), effective);
  assert.equal(await provider.diffBaseContent(uri, project), effective);
  provider.trackDocumentChange({ document: { uri }, contentChanges: [
    { rangeOffset: 0, rangeLength: 0, text: 'custom();\n' },
  ] });
  await provider.writeFile(uri, Buffer.from(`custom();\n${effective}`), {});
  assert.equal(writes[0][3], `custom();\n${project}`);
  assert.equal(writes[0][4], undefined);
  await provider.writeFile(uri, Buffer.from(`new();\ncustom();\n${effective}`), {});
  assert.equal(writes[1][3], `new();\ncustom();\n${project}`);
  provider.trackDocumentChange({ document: { uri }, contentChanges: [
    { rangeOffset: 0, rangeLength: `new();\ncustom();\n${effective}`.length,
      text: `other();\n${effective}` },
  ] });
  await provider.writeFile(uri, Buffer.from(`other();\n${effective}`), {});
  assert.equal(writes[2][3], `other();\n${project}`);
  provider.dispose();
});

test('materializes edited product source with its checked hash', async () => {
  class EventEmitter { constructor() { this.event = () => {}; } dispose() {} }
  const vscode = { EventEmitter, FileType: { File: 1 },
    FileSystemError: { NoPermissions: (message) => new Error(message) } };
  const uri = { authority: 'projects.demo', query: 'sourceType=page&sourceId=PG-1&jsonPointer=%2FpageEvents%2FonOpen%2Fscript',
    toString: () => 'guthon-svn-edit://projects.demo/onOpen.gss' };
  const writes = [];
  const provider = new SvnVirtualFileSystem({ vscode, backend: {
    read: async () => ({ editable: true, sessionId: 's', documentId: 'd',
      sourceNamespace: 'pages/1', sourcePath: 'PG-1.json', content: '@inherit();' }),
    pageQuery: async () => ({ inheritanceStatus: 'ACTIVE', indexGeneration: 'gen',
      project: { sourceHash: 'page-hash' }, product: { sourceHash: 'page-hash' },
      segments: [
        { layer: 'project', start: 0, end: 0, sourceStart: 0, sourceEnd: 0 },
        { layer: 'product', start: 0, end: 10, sourceStart: 0, sourceEnd: 11 },
        { layer: 'project', start: 10, end: 10, sourceStart: 11, sourceEnd: 11 },
      ], effective: { content: 'product();' }, projectOriginal: { content: '@inherit();' },
      productOriginal: { content: 'product();' }, complete: true }),
    write: async (...args) => { writes.push(args); return { changed: true }; },
  } });
  assert.equal((await provider.readFile(uri)).toString(), 'product();');
  provider.trackDocumentChange({ document: { uri }, contentChanges: [
    { rangeOffset: 0, rangeLength: 7, text: 'changed' },
  ] });
  await provider.writeFile(uri, Buffer.from('changed();'), {});
  assert.equal(writes[0][3], 'changed();');
  assert.deepEqual(writes[0][4], { expectedProductHash: 'page-hash' });
  provider.dispose();
});

test('deduplicates loads, rejects invalidated in-flight reads and pins live document leases', async () => {
  class EventEmitter{constructor(){this.event=()=>{};}fire(){}dispose(){}}
  const documents=[];
  const Uri={from:value=>({...value,toString(){return JSON.stringify(value);}}),parse:text=>Uri.from(JSON.parse(text))};
  let reads=0;let release;
  const backend={read:async()=>{reads+=1;return new Promise(resolve=>{release=resolve;});}};
  const provider=new SvnVirtualFileSystem({vscode:{EventEmitter,Uri,workspace:{textDocuments:documents},FileSystemError:{FileNotFound:()=>new Error('missing')}},backend});
  const identity={workspaceKey:'products.demo',sourceType:'procedure',sourceId:'demo#save',funId:'save'};const uri=provider.uriFor(identity);
  const first=provider.readFile(uri);const second=provider.stat(uri);assert.equal(reads,1);
  provider.invalidate('products.demo');release({content:'stale',sourcePath:'stale.gss'});
  await assert.rejects(first,/已失效/);await assert.rejects(second,/已失效/);assert.equal(provider.cache.size,0);
  backend.read=async(key,item)=>({content:item.sourceId,sourcePath:item.sourceId,sessionId:item.sourceId,editable:true});
  documents.push({uri,isDirty:true});provider.cache.maxEntries=1;
  await provider.readFile(uri);
  await provider.readFile(provider.uriFor({...identity,sourceId:'other'}));
  assert.equal(provider.cache.get(uri.toString()).value.sessionId,'demo#save');
  provider.invalidate('products.demo',false,undefined,['unrelated']);assert.equal(provider.cache.has(uri.toString()),true);
  provider.dispose();
});


test('closing an editable virtual document releases exactly its backend lease',async()=>{
 let closed;const released=[];
 class EventEmitter{constructor(){this.event=()=>{};}fire(){}dispose(){}}
 const vscode={EventEmitter,workspace:{textDocuments:[],onDidCloseTextDocument:fn=>{closed=fn;return {dispose(){}};}}};
 const backend={releaseLease:async(...args)=>released.push(args)};
 const provider=new SvnVirtualFileSystem({vscode,backend});
 const uri={toString:()=> 'guthon-svn://products.demo/procedure'};
 provider.cache.set(uri.toString(),{identity:{workspaceKey:'products.demo'},value:{editable:true,sessionId:'session',documentId:'document',content:'source'}});
 closed({uri});await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(released,[['products.demo','session','document']]);
 assert.equal(provider.cache.has(uri.toString()),false);provider.dispose();
});

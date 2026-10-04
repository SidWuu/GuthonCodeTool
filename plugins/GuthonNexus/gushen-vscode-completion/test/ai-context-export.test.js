const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { exportAiContext, validateContextResult, writePrivateContext } = require('../src/ai-context-export');

const identity = { sourceId: 'PX', funId: 'run', sourceType: 'procedure', sourceNamespace: 'projects.demo.systems.S', workingCopyId: 'S', sourcePath: 'systems/S/procedures/PX/run.gss' };
const response = () => ({ ok: true, workspaceKey: 'projects.demo', markdown: '# 有界索引摘要\n', source: {
  source_id: 'PX', fun_id: 'run', source_table: 'procedure', source_namespace: identity.sourceNamespace,
  working_copy_id: 'S', source_path: identity.sourcePath,
} });
async function fixture(t) {
  const toolHome = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-context-'));
  t.after(() => fs.rm(toolHome, { recursive: true, force: true }));
  const root = path.join(toolHome, 'var', 'workspace', 'demo');
  await fs.mkdir(root, { recursive: true });
  return { toolHome, workspace: { root, workspaceKey: 'projects.demo' }, identity };
}

test('exports indexed metadata by default, preserving namespace and working copy without source reads', async (t) => {
  const options = await fixture(t);
  const calls = [];
  const client = { run: async (...args) => { calls.push(args); return response(); } };
  const result = await exportAiContext({ ...options, client, backend: { pageQuery() { throw new Error('unexpected source read'); } } });
  assert.equal(path.dirname(result.artifactPath), await fs.realpath(path.join(options.workspace.root, 'context', 'ai')));
  assert.ok(path.isAbsolute(result.artifactPath));
  assert.match(await fs.readFile(result.artifactPath, 'utf8'), /workingCopyId/);
  assert.ok(calls[0][2].includes('--source-namespace'));
  assert.ok(!calls[0][2].includes('--include-source'));
  assert.equal((await fs.stat(result.artifactPath)).mode & 0o777, 0o600);
});

test('refuses ambiguous or mismatched working copy/source identities before writing', async (t) => {
  const options = await fixture(t);
  const wrong = response(); wrong.source.working_copy_id = 'other';
  await assert.rejects(exportAiContext({ ...options, client: {run: async () => wrong} }), /workingCopyId/);
  await assert.rejects(fs.stat(path.join(options.workspace.root, 'context')), { code: 'ENOENT' });
  assert.throws(() => validateContextResult({ ...response(), sourceContent: {content:'PAGE'} }, options.workspace.workspaceKey, identity), /正文/);
});

test('does not overwrite previous exports, and fingerprints namespaces/working copies', async (t) => {
  const options = await fixture(t);
  const a = await writePrivateContext({ ...options, markdown: 'a' });
  const b = await writePrivateContext({ ...options, identity: {...identity, sourceNamespace:'products.other', workingCopyId:'P'}, markdown: 'b' });
  assert.notEqual(path.basename(a).split('-')[1], path.basename(b).split('-')[1]);
  const c = await writePrivateContext({ ...options, markdown: 'c' });
  assert.notEqual(c, a);
  assert.equal(await fs.readFile(a,'utf8'), 'a');
});

test('rejects out-of-workspace roots, directory symlinks and oversized content', async (t) => {
  const options = await fixture(t);
  await assert.rejects(writePrivateContext({...options, workspace:{...options.workspace,root:options.toolHome},markdown:'x'}), /var/);
  await fs.symlink(options.toolHome, path.join(options.workspace.root, 'context'));
  await assert.rejects(writePrivateContext({...options,markdown:'x'}), /边界/);
  await assert.rejects(writePrivateContext({...options,markdown:'x'.repeat(128*1024+1)}), /上限/);
});

test('inheritance is explicit, bounded, identity checked and never reads entire PAGE', async (t) => {
  const options = await fixture(t);
  let request;
  const inherited = {sourceNamespace:identity.sourceNamespace,sourceId:'PX',funId:'run',workingCopyId:'S',project:{sourcePath:identity.sourcePath,sourceHash:'a'},product:{sourcePath:'base/run.gss',sourceHash:'b'},effective:{content:'callBase();'},complete:false,inheritanceStatus:'ACTIVE'};
  const result = await exportAiContext({...options, client:{run:async()=>response()},includeInheritance:true,backend:{pageQuery:async(...args)=>{request=args;return inherited;}}});
  assert.equal(request[2].maxChars, 8000);
  assert.equal(request[2].offset, 0);
  assert.match(result.markdown,/已截断/);
  assert.match(result.markdown,/callBase/);
  await assert.rejects(exportAiContext({...options,identity:{...identity,sourceType:'page',jsonPointer:''},client:{run:async()=>({...response(),source:{...response().source,source_table:'page'}})},includeInheritance:true}),/选定/);
});

test('impact context refuses stale source hash before publishing a mixed snapshot', async (t) => {
  const options = await fixture(t);
  const summary=response();summary.source.source_hash='old';
  const context={source:{...summary.source,source_hash:'new'},incoming:[],outgoing:[],dynamic:[]};
  await assert.rejects(exportAiContext({...options,client:{run:async()=>summary},backend:{context:async()=>context},includeImpact:true}),/快照/);
  await assert.rejects(fs.stat(path.join(options.workspace.root,'context')), {code:'ENOENT'});
});

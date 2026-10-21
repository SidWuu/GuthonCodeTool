const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// Load the actual provider with only its filesystem/editor boundaries mocked.
function loadProvider(findFiles) {
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8'), {
    module, exports:module.exports,
    require(name) {
      if (name === 'vscode') return {
        workspace:{findFiles},
        Location:class {constructor(uri, position) {this.uri = uri; this.position = position;}},
        Position:class {constructor(line, character) {this.line = line; this.character = character;}},
      };
      if (name === './definition') return require('../src/definition');
      if (name.startsWith('node:')) return require(name);
      return {};
    },
  });
  return module.exports.createDefinitionProvider();
}

test('DATABASE service definitions verify metadata before selecting the current source scope', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-component-definition-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  function component(owner, layer, directory, meta) {
    const base = path.join(root, 'workspace', owner, 'source', layer, 'demo', 'page', directory);
    fs.mkdirSync(path.join(base, 'scripts'), {recursive:true});
    if (meta) fs.writeFileSync(path.join(base, 'meta.json'), JSON.stringify(meta));
    return {fsPath:path.join(base, 'scripts', 'compScript.vm')};
  }
  const meta = {source_table:'page', source_id:'PG-COMP'};
  const current = component('PRJ 示例', 'workcopy', '服务 PG-COMP', meta);
  const baseline = component('PRJ 示例', 'readonly', '服务 PG-COMP', meta);
  const product = component('PRD 产品', 'workcopy', '服务 PG-COMP', meta);
  const wrongId = component('PRJ 示例', 'workcopy', '同名 PG-COMP', {...meta, source_id:'PG-OTHER'});
  const wrongType = component('PRJ 示例', 'workcopy', '其他 PG-COMP', {...meta, source_table:'procedure'});
  const missing = component('PRJ 示例', 'workcopy', '旧路径 PG-COMP');
  const provider = loadProvider(async (pattern, exclude) => {
    assert.equal(pattern, '**/page/**/* PG-COMP/scripts/compScript.vm');
    assert.equal(exclude, '**/.guthon-baseline/**');
    return [product, baseline, wrongId, wrongType, missing, current];
  });
  for (const scope of ['proc', 'thread']) {
    const source = `$vs.${scope}.runServiceComp("PG-COMP", $args)`;
    const locations = await provider.provideDefinition({getText:() => source,
      offsetAt:() => source.indexOf('PG-COMP'), uri:{fsPath:current.fsPath}}, {});
    assert.deepEqual(Array.from(locations, location => location.uri.fsPath), [current.fsPath]);
  }
});

test('DATABASE procedure navigation retains its existing path lookup', async () => {
  const uri = {fsPath:'/repo/workspace/PRJ 示例/source/workcopy/demo/procedure/demo.pkg/save/source.vm'};
  const provider = loadProvider(async pattern => {
    assert.equal(pattern, '**/procedure/demo.pkg/save/source.vm');
    return [uri];
  });
  const source = '$vs.thread.run("demo.pkg", "save", $args)';
  const locations = await provider.provideDefinition({getText:() => source,
    offsetAt:() => source.indexOf('save'), uri:{fsPath:uri.fsPath}}, {});
  assert.equal(locations[0].uri, uri);
});

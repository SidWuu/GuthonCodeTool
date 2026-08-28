'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildProjectAiIndex, readProjectAiIndex, searchAiIndex, writeProjectAiIndex } = require('../src/ai-index');
const { discoverProjectLayout } = require('../src/project-layout');
const { loadPageIndexes } = require('../src/page-index');

function write(root, relative, content) {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

test('indexes only the new systems and datasources layout', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-ai-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'systems/SYS-DEMO/$.风险管理/.keep', '');
  write(root, 'systems/SYS-DEMO/pages/index.md', `### 🌏 风险管理 (SYS-DEMO)
- [🏠 策略方案](8/6/PG-DEMO.json)
`);
  write(root, 'systems/SYS-DEMO/pages/8/6/PG-DEMO.json', JSON.stringify({
    views: { rows: [
      { component: { pageEvents: { onClickScript: "gUtil.request('com.demo.queryRisk', param);" }, datasource: { sql: 'SELECT * FROM RM_PROJECT_RISK' } } },
      { component: { name: 'scriptTable', datasource: { dsType: 1, script: "#set($rows = $vs.dbTools.list('SELECT * FROM RM_SCRIPT_DS'));" } } }
    ] }
  }));
  write(root, 'systems/SYS-DEMO/pages/8/6/com.demo.auditService.gss', `/**
 * @pageAliasId com.demo.auditService
 * @pageName 审计服务
 */
`);
  write(root, 'datasources/0000/$.主数据源/.keep', '');
  write(root, 'datasources/0000/procedures/index.md', `### 主数据源 (0000)
- [⚡ com.demo.queryRisk - 查询风险](com/demo/queryRisk.gss)
- [⚡ inheritedRisk - 继承风险查询](com/demo/inheritedRisk.gss)
- [⚡ overriddenRisk - 已覆盖风险查询](com/demo/overriddenRisk.gss)
- [⚡ missingRisk - 缺失继承源](com/demo/missingRisk.gss)
`);
  write(root, 'datasources/0000/procedures/com/demo/queryRisk.gss', `/**
 * @functionId com.demo.queryRisk
 * @description 查询风险
 */
#set($rows = $vs.dbTools.list('SELECT * FROM RM_PROJECT_RISK'))
`);
  write(root, 'datasources/0000/procedures/com/demo/inheritedRisk.gss', `/**
 * @functionId inheritedRisk
 * @description 继承风险查询
 */
@inherit();
$vs.proc.invoke('com.demo.child', 'afterRun');
`);
  write(root, 'datasources/0000/procedures/com/demo/inheritedRisk.inherit.gss', `/**
 * @functionId inheritedRisk
 * @description 继承风险查询
 */
$vs.proc.invoke('com.demo.parent', 'run');
#set($rows = $vs.dbTools.list('SELECT * FROM RM_INHERITED_RISK'))
`);
  write(root, 'datasources/0000/procedures/com/demo/overriddenRisk.gss', `/**
 * @functionId overriddenRisk
 * @description 已覆盖风险查询
 */
#set($rows = $vs.dbTools.list('SELECT * FROM RM_CHILD_ONLY'))
`);
  write(root, 'datasources/0000/procedures/com/demo/overriddenRisk.inherit.gss', `/** parent */
#set($rows = $vs.dbTools.list('SELECT * FROM RM_UNUSED_PARENT'))
`);
  write(root, 'datasources/0000/procedures/com/demo/missingRisk.gss', `/**
 * @functionId missingRisk
 * @description 缺失继承源
 */
@inherit();
`);
  write(root, 'systems/SYS-DEMO/system-script/init.gss', "gUtil.request('com.demo.queryRisk', param);");
  write(root, 'datasources/0000/tables/RM_PROJECT_RISK.json', JSON.stringify({ tableId: 'RM_PROJECT_RISK', tableName: '策略风险表' }));
  write(root, 'datasources/0000/views/RM_PROJECT_RISK_VIEW.json', JSON.stringify({ viewId: 'RM_PROJECT_RISK_VIEW', viewName: '策略风险视图' }));

  const layout = discoverProjectLayout(root);
  const systems = loadPageIndexes(layout.pageRoots.map((entry) => entry.root));
  const repository = { root, projectId: 'demo', label: '演示项目', layoutData: layout, systems };
  const index = await buildProjectAiIndex(repository);

  assert.equal(index.manifest.schemaVersion, 3);
  assert.equal(index.manifest.layout, 'systems-datasources');
  assert.deepEqual(new Set(index.objects.map((object) => object.kind)), new Set([
    'page', 'procedure', 'service-component', 'system-script', 'table', 'view'
  ]));
  assert.ok(index.objects.some((object) => object.kind === 'service-component' && object.objectId === 'com.demo.auditService'));
  assert.ok(index.objects.some((object) => object.name === '策略风险表' && object.dataSourceId === '0000'));
  assert.ok(index.objects.some((object) => object.name === '查询风险' && object.path.startsWith('datasources/0000/procedures/')));
  assert.ok(index.objects.some((object) => object.kind === 'page' && object.path.startsWith('systems/SYS-DEMO/pages/')));
  const inherited = index.objects.find((object) => object.objectId === 'inheritedRisk');
  assert.equal(inherited.inheritance.state, 'active');
  assert.deepEqual(inherited.effectiveSourcePaths, [
    'datasources/0000/procedures/com/demo/inheritedRisk.gss',
    'datasources/0000/procedures/com/demo/inheritedRisk.inherit.gss'
  ]);
  assert.equal(index.objects.some((object) => object.path.endsWith('.inherit.gss')), false);
  assert.ok(index.relations.some((relation) => relation.from === 'procedure:inheritedRisk' && relation.relation === 'inherits'));
  assert.ok(index.relations.some((relation) => relation.from === 'procedure:inheritedRisk' && relation.to.includes('com.demo.parent')));
  assert.ok(index.relations.some((relation) => relation.from === 'procedure:inheritedRisk' && relation.to.includes('RM_INHERITED_RISK')));
  assert.equal(index.manifest.counts.inheritedObjects, 1);
  assert.equal(index.manifest.counts.overriddenObjects, 1);
  assert.equal(index.manifest.counts.inheritanceWarnings, 1);
  assert.equal(index.objects.find((object) => object.objectId === 'overriddenRisk').inheritance.state, 'overridden');
  assert.equal(index.objects.find((object) => object.objectId === 'missingRisk').inheritance.state, 'missing-parent');

  const indexRoot = await writeProjectAiIndex(repository, index);
  assert.equal(indexRoot, path.join(root, 'docs/ai-index'));
  const loaded = await readProjectAiIndex(root);
  assert.equal(loaded.objects.length, index.objects.length);
  assert.equal(searchAiIndex(loaded, '策略风险表')[0].kind, 'table');
  assert.equal(searchAiIndex(loaded, '风险管理')[0].systemId, 'SYS-DEMO');
  assert.equal(searchAiIndex(loaded, 'inheritedRisk.inherit.gss')[0].objectId, 'inheritedRisk');
});

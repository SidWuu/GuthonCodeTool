'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildProjectAiIndex,
  readProjectAiIndex,
  searchAiIndex,
  writeProjectAiIndex
} = require('../src/ai-index');

function write(root, relative, content) {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

test('generates a project-local multi-object AI index without requiring docs first', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-ai-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  write(root, 'guthon-projects.yaml', `
projects:
  demo:
    name: 演示项目
    data_sources:
      - data_source_id: "0000"
        data_source_name: "主数据"
        systems:
          - system_id: SYS-DEMO
            system_name: "风险管理"
`);
  write(root, 'pages/SYS-DEMO/index.md', `### 🌏 风险管理 (SYS-DEMO)
- [🏠 策略方案](8/6/PG-DEMO.json)
`);
  write(root, 'pages/SYS-DEMO/8/6/PG-DEMO.json', JSON.stringify({
    views: { rows: [{ component: { pageEvents: { onClickScript: "gUtil.request('com.demo.queryRisk', param);" }, datasource: { sql: 'SELECT * FROM RM_PROJECT_RISK' } } }] }
  }));
  write(root, 'pages/SYS-DEMO/8/6/com.demo.auditService.gss', `/**
 * @pageAliasId com.demo.auditService
 * @pageName 审计服务
 */
`);
  write(root, 'procedures/0000/com.demo.queryRisk.gss', `/**
 * @functionId com.demo.queryRisk
 * @description 查询风险
 */
#set($rows = $vs.dbTools.list('SELECT * FROM RM_PROJECT_RISK'))
`);
  write(root, 'system-script/SYS-DEMO/init.gss', "gUtil.request('com.demo.queryRisk', param);");
  write(root, 'tables/0000/RM_PROJECT_RISK.json', JSON.stringify({ tableId: 'RM_PROJECT_RISK', tableName: '策略风险表' }));
  write(root, 'views/0000/RM_PROJECT_RISK_VIEW.json', JSON.stringify({ viewId: 'RM_PROJECT_RISK_VIEW', viewName: '策略风险视图' }));

  const repository = {
    root,
    projectId: 'demo',
    label: '演示项目',
    systems: [{
      kind: 'system',
      systemId: 'SYS-DEMO',
      label: '风险管理',
      indexPath: path.join(root, 'pages/SYS-DEMO/index.md'),
      repositoryRoot: root,
      children: [{
        kind: 'page',
        label: '策略方案',
        pageType: '主页面',
        systemId: 'SYS-DEMO',
        filePath: path.join(root, 'pages/SYS-DEMO/8/6/PG-DEMO.json'),
        indexPath: path.join(root, 'pages/SYS-DEMO/index.md'),
        linkTarget: '8/6/PG-DEMO.json',
        children: []
      }]
    }]
  };
  const index = await buildProjectAiIndex(repository);

  assert.equal(fs.existsSync(path.join(root, 'docs')), false);
  assert.equal(index.manifest.projectId, 'demo');
  assert.deepEqual(new Set(index.objects.map((object) => object.kind)), new Set(['page', 'procedure', 'service-component', 'system-script', 'table', 'view']));
  assert.ok(index.objects.some((object) => object.kind === 'service-component' && object.objectId === 'com.demo.auditService'));
  assert.ok(index.objects.some((object) => object.name === '策略风险表' && object.aliases.includes('RM_PROJECT_RISK')));
  assert.ok(index.objects.some((object) => object.name === '查询风险' && object.kind === 'procedure'));
  assert.ok(index.relations.some((relation) => relation.relation === 'calls' && relation.unresolved === false));
  assert.ok(index.relations.some((relation) => relation.relation === 'uses' && relation.unresolved === false));

  const indexRoot = await writeProjectAiIndex(repository, index);
  assert.equal(indexRoot, path.join(root, 'docs/ai-index'));
  assert.equal(fs.existsSync(path.join(indexRoot, 'manifest.json')), true);
  assert.equal(fs.existsSync(path.join(indexRoot, 'objects.jsonl')), true);
  assert.equal(fs.existsSync(path.join(indexRoot, 'relations.jsonl')), true);
  assert.equal(fs.readdirSync(path.join(indexRoot, 'pages')).length, 1);

  const loaded = await readProjectAiIndex(root);
  assert.equal(loaded.objects.length, index.objects.length);
  assert.equal(searchAiIndex(loaded, '策略风险表')[0].kind, 'table');
  assert.equal(searchAiIndex(loaded, 'SYS-DEMO')[0].kind, 'page');
});

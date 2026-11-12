const assert=require('node:assert/strict');const test=require('node:test');
const {normalizeSourceMode,filterWorkspacesBySourceMode,sourceModeLabel}=require('../src/source-mode');
test('new workspace uses API and unsupported legacy modes are not silently converted',()=>{
  assert.equal(normalizeSourceMode(undefined),'api');assert.equal(normalizeSourceMode('API'),'api');
  assert.equal(normalizeSourceMode('database'),'database');assert.equal(sourceModeLabel('database'),'不支持的旧源码配置');
});
test('API services use only API workspaces',()=>{
  const items=[{workspaceKey:'projects.a',sourceMode:'api'},{workspaceKey:'projects.b',sourceMode:'database'}];
  assert.deepEqual(filterWorkspacesBySourceMode(items).map(x=>x.workspaceKey),['projects.a']);
});

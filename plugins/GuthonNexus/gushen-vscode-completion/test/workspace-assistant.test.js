const assert = require('node:assert/strict');
const test = require('node:test');
const { searchPickItems, workspaceCockpit } = require('../src/workspace-assistant');

test('builds an actionable SVN workspace cockpit', () => {
  const cockpit = workspaceCockpit({
    sourceMode: 'svn',
    index: { ready: true, sizeBytes: 512 },
    delivery: {
      deliveryCount: 2,
      deliveries: [{ deliveryId: 'd2', files: ['one.gss'], groups: [{ revision: '42' }] }],
    },
    cockpit: {
      health: 'ACTION_REQUIRED',
      issueCount: 2,
      workingCopyCount: 3,
      dirtyWorkingCopies: 1,
      messages: ['工作区资料尚未达到完整一致状态', '1 个 SVN scope 无权限或不存在，已跳过'],
    },
  });

  assert.equal(cockpit.description, '2 项待处理');
  assert.equal(cockpit.rows[0].label, '本地事实索引：可用');
  assert.ok(cockpit.rows.some((item) => item.command === 'gushenCompletion.manageSvnChanges'));
  assert.ok(cockpit.rows.some((item) => item.label === '最近 SVN 提交：r42'));
  assert.equal(cockpit.rows.at(-1).command, 'gushenCompletion.showSvnDeliveryReceipt');
});

test('preserves backend result identity in unified search picks', () => {
  const identity = { sourceType: 'procedure', sourceId: 'pkg#save', funId: 'save' };
  const picks = searchPickItems({
    items: [{ label: '保存', description: 'procedure', detail: 'evidence', identity }],
  });
  assert.equal(picks[0].label, '保存');
  assert.deepEqual(picks[0].item.identity, identity);
});

test('a ready workspace keeps local changes visible without a warning icon', () => {
  const cockpit = workspaceCockpit({sourceMode: 'svn', index: {ready: true},
    cockpit: {health: 'READY', issueCount: 0, workingCopyCount: 3, dirtyWorkingCopies: 2}});
  assert.equal(cockpit.description, '就绪 · 有本地修改');
  assert.equal(cockpit.icon, 'dashboard');
  assert.equal(cockpit.rows[1].label, 'SVN 本地变更：2 个工作副本');
  assert.equal(cockpit.rows[1].command, 'gushenCompletion.manageSvnChanges');
});

test('failed index batches override a ready SVN cockpit with a targeted recovery action', () => {
  const workspace = {sourceMode: 'svn', index: {ready: true}, cockpit: {health: 'READY', issueCount: 0}};
  const cockpit = workspaceCockpit(workspace, {failedCount: 3, retryScheduled: false});
  assert.equal(cockpit.description, '1 项待处理');
  assert.equal(cockpit.rows[0].label, '本地事实索引：待恢复');
  assert.equal(cockpit.rows[0].command, 'gushenCompletion.retrySvnIndexFailures');
  assert.match(cockpit.rows[0].description, /3 个文件/);
  assert.match(workspaceCockpit(workspace, {failedCount: 3, retryScheduled: true}).rows[0].description, /自动重试/);
  assert.match(workspaceCockpit(workspace, {failedCount: 3, retrying: true}).rows[0].description, /正在/);
  assert.equal(workspaceCockpit(workspace, {failedCount: 0}).rows[0].command, 'gushenCompletion.searchWorkspace');
});

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
      messages: ['存在本地变更'],
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

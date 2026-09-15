function workspaceCockpit(item) {
  const cockpit = item.cockpit || {};
  const health = cockpit.health || 'ACTION_REQUIRED';
  const indexReady = Boolean(item.index?.ready);
  const rows = [
    {
      label: `本地事实索引：${indexReady ? '可用' : '待建立'}`,
      description: indexReady ? '点击搜索全部本地索引' : '点击建立索引',
      icon: indexReady ? 'pass-filled' : 'warning',
      command: indexReady
        ? 'gushenCompletion.searchWorkspace'
        : item.sourceMode === 'svn'
          ? 'gushenCompletion.reindexCalls'
          : 'gushenCompletion.initSourceIndex',
    },
  ];
  if (item.sourceMode === 'database') {
    const statusLabel = {
      SYNCED: '完整', PARTIAL: '部分完成', FAILED: '失败', UNINITIALIZED: '未初始化',
    }[item.status] || item.status;
    rows.push({
      label: `工作区资料：${statusLabel}`,
      description: item.status === 'SYNCED' ? item.lastFullSyncAt || '' : (cockpit.messages || []).join('；'),
      icon: item.status === 'SYNCED' ? 'pass' : item.status === 'FAILED' ? 'error' : 'sync',
      command: item.status === 'SYNCED' ? undefined : 'gushenCompletion.syncWorkspaceAll',
    });
  }
  if (item.sourceMode === 'svn') {
    rows.push({
      label: `SVN 本地变更：${cockpit.dirtyWorkingCopies || 0}`,
      description: `${cockpit.workingCopyCount || 0} 个 working copy · 点击查看实时状态`,
      icon: cockpit.dirtyWorkingCopies ? 'source-control' : 'pass',
      command: 'gushenCompletion.manageSvnChanges',
    });
    const latest = item.delivery?.deliveries?.at(-1);
    if (latest) {
      const revisions = (latest.groups || []).map((group) => group.revision).filter(Boolean);
      rows.push({
        label: `最近 SVN 提交：${revisions.length ? revisions.map((value) => `r${value}`).join(' / ') : '已完成'}`,
        description: `${latest.files?.length || 0} 个文件 · 点击查看交付记录`,
        icon: 'history',
        command: 'gushenCompletion.showSvnDeliveryReceipt',
      });
    }
  }
  return {
    label: '工作区驾驶舱',
    description: health === 'READY' ? '就绪' : health === 'FAILED' ? '需处理失败' : `${cockpit.issueCount || 0} 项待处理`,
    icon: health === 'READY' ? 'dashboard' : health === 'FAILED' ? 'error' : 'warning',
    rows,
  };
}

function searchPickItems(result) {
  return (result?.items || []).map((item) => ({
    label: item.label,
    description: item.description,
    detail: item.detail,
    buttons: [],
    item,
  }));
}

module.exports = { searchPickItems, workspaceCockpit };

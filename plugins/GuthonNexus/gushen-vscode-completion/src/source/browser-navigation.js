const {isWorkspaceKey} = require('../workspace-identity');

function browserTarget(identity) {
  if (!isWorkspaceKey(identity?.workspaceKey)) throw new Error('浏览器定位需要明确工作区');
  if (identity.sourceType === 'page' && /^PG-[A-Za-z0-9-]{1,96}$/.test(identity.sourceId)) {
    return {type: 'page', pageId: identity.sourceId};
  }
  if (identity.sourceType === 'procedure' && /^[A-Za-z_$][A-Za-z0-9_.$]{0,255}$/.test(identity.sourceAliasId)
      && /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(identity.funId)) {
    return {type: 'procedure', alias: identity.sourceAliasId, funId: identity.funId};
  }
  throw new Error('所选源码没有有效的 PAGE 或过程函数平台身份');
}

async function navigateInBrowser({vscode, bridge, tool, identity, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  const target = browserTarget(identity);
  if (!tool) throw new Error('请先配置 Guthon 工具工作空间');
  bridge.start(tool);
  await bridge.waitForReady(tool.toolHome);
  const params = new URLSearchParams({workspaceKey: identity.workspaceKey});
  const result = await bridge.request(tool.toolHome, `/pageContext?${params}`);
  const contexts = (result.contexts || []).filter(item => item.workspaceKey === identity.workspaceKey);
  if (!contexts.length) throw new Error('未找到此工作区的平台页签；请打开平台并在 Bridge 弹窗选择工作区、配置配对令牌');
  const context = contexts.length === 1 ? contexts[0] : (await vscode.window.showQuickPick(
    contexts.map(item => ({label: item.selectedTab?.label || item.pageId || `${item.procedureKeyword || ''}.${item.funId || ''}`,
      description: item.pageOrigin, detail: `${item.workspaceKey} · 页签 ${item.tabId}`, context: item})),
    {title: '选择要定位的谷神平台页签', matchOnDescription: true, matchOnDetail: true}
  ))?.context;
  if (!context) return undefined;
  const accepted = await bridge.request(tool.toolHome, '/navigate', {workspaceKey: identity.workspaceKey,
    contextId: context.contextId, target});
  const statusParams = new URLSearchParams({requestId: accepted.requestId, workspaceKey: identity.workspaceKey});
  const deadline = now() + 30000;
  while (now() < deadline) {
    const status = await bridge.request(tool.toolHome, `/navigationResult?${statusParams}`);
    if (status.state === 'SUCCEEDED') return status;
    if (status.state !== 'PENDING') throw new Error(status.message || '平台定位失败');
    await sleep(250);
  }
  throw new Error('平台定位结果未知，请检查浏览器；不会自动重放定位指令');
}

module.exports = {browserTarget, navigateInBrowser};

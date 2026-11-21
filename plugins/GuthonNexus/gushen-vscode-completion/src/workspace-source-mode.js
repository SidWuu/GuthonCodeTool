const path=require('node:path');

async function upgradeLegacyConfiguration({vscode,client,workspace,assertReady}) {
  const plan=await client.run('','configuration-upgrade',['plan']);
  if(plan.phase!=='PREVIEW' || !/^[a-f0-9]{64}$/.test(plan.planId)
      || !plan.workspaces?.some(item=>item.workspaceKey===workspace.workspaceKey && item.root===workspace.root)) {
    throw new Error('配置升级预览与当前项目不一致');
  }
  const confirmed=await vscode.window.showWarningMessage('先升级旧项目登记？',{
    modal:true,detail:`请关闭使用同一数据目录的其他编辑器窗口及写入工具。升级会备份旧配置，并登记 ${plan.workspaces.length} 个项目。\n\n${plan.target}`,
  },'确认升级配置');
  if(confirmed!=='确认升级配置')return false;
  await assertReady();
  const result=await client.run('','configuration-upgrade',['apply','--offline','--confirm',plan.planId]);
  if(result.phase!=='PUBLISHED')throw new Error('配置升级尚未发布，请核对配置升级状态');
  return true;
}

async function changeWorkspaceSourceMode({vscode,workspace,sourceMode,request,assertReady}) {
  const workspaceKey=workspace.workspaceKey,expectedMode=workspace.sourceMode || 'api';
  const mode={workspaceKey,expectedMode,sourceMode};
  await assertReady();
  const plan=await request({...mode,checkOnly:true});
  if(plan.workspaceKey!==workspaceKey || plan.sourceMode!==sourceMode || typeof plan.requiresReset!=='boolean') {
    throw new Error('同步方式预览与当前项目不一致，请核对后端版本');
  }
  if(!plan.requiresReset) {
    const confirmed=await vscode.window.showWarningMessage(
      `将「${workspace.name}」的同步方式从 ${expectedMode.toUpperCase()} 改为 ${sourceMode.toUpperCase()}？`,
      {modal:true,detail:'切换后按所选方式配置连接和范围。'},'确认修改');
    if(confirmed!=='确认修改')return;
    await assertReady();
    return request(mode);
  }

  if(sourceMode!=='api' || !/^[a-f0-9]{64}$/.test(plan.planId) || !Array.isArray(plan.paths)
      || !plan.paths.length || !plan.paths.every(path.isAbsolute) || !path.isAbsolute(plan.docsPath)) {
    throw new Error('旧源码清理范围无效');
  }
  const confirmed=await vscode.window.showWarningMessage('是否确认已将源码改动同步到谷神平台？',{
    modal:true,detail:`「${workspace.name}」将切换到 API。确认后会移走以下本地源码、索引和运行目录。\n${plan.paths.join('\n')}\n\n保留文档目录\n${plan.docsPath}\n\n切换后重新登录、选择同步范围，再点击“更新源码”重建索引。`,
  },'已同步，确认切换');
  if(confirmed!=='已同步，确认切换')return;
  await assertReady();
  const result=await request({...mode,planId:plan.planId});
  if(!result.changed || result.workspaceKey!==workspaceKey || result.sourceMode!=='api') {
    throw new Error('后端未确认 API 登记已发布，请先刷新项目状态');
  }
  const approved=new Set(plan.paths.map(target=>path.join(path.dirname(target),
    `.${path.basename(target)}.guthon-api-${plan.planId.slice(0,16)}`)));
  const retained=[];
  for(const target of result.trashPaths || []) {
    if(!approved.has(target)) {retained.push(target);continue;}
    try {await vscode.workspace.fs.delete(vscode.Uri.file(target),{recursive:true,useTrash:true});}
    catch {retained.push(target);}
  }
  return {...result,retained};
}

module.exports={changeWorkspaceSourceMode,upgradeLegacyConfiguration};

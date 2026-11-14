async function showProjectActions({vscode,getWorkspaces,bridge}) {
  const workspaces=await getWorkspaces();
  const project=workspaces.length===1 ? workspaces[0] : undefined;
  const item=(label,command,{project=false,description='',args=[]}={})=>({label,command,project,description,args});
  const groups={
    '检查与恢复':[
      item('查看索引问题','showApiIndexDiagnostics',{project:true}),
      item('重试待更新文件','retryApiIndexFailures',{project:true}),
      item('重建全部索引','reindexCalls',{project:true,description:'仅在索引丢失或需要完整重建时使用'}),
      item('核对未确认的上传','verifyApiUpload',{project:true}),
      item('检查运行环境','runDoctor',{project:true}),
      item('执行源码排查','runDiagnosis',{project:true}),
      item('查看排查记录','showDiagnosisHistory',{project:true}),
    ],
    '导入与导出':[
      item('导出本地修改','exportApiChanges',{project:true}),
      item('导入本地修改','importApiChanges',{project:true}),
      item('导出源码说明','exportMarkdown',{project:true}),
      item('导出表结构','exportSchema',{project:true}),
      item('导出视图','exportViews',{project:true}),
      item('导出系统脚本','exportSystemScripts',{project:true}),
      item('导出单据类型','exportBillTypes',{project:true}),
      item('导出 AI 上下文','exportAiContext',{project:true}),
    ],
    '项目管理':[
      item('打开项目目录','openApiCheckout',{project:true}),
      item('添加项目','addWorkspace'),
      item('删除当前项目','deleteWorkspace',{project:true}),
    ],
    '工具与更新':[
      item('检查工具更新','checkToolUpdate'),
      item('检查官方补全更新','checkOfficialUpdate'),
      item('回退官方补全','rollbackOfficialUpdate'),
      item('回退后端版本','rollbackToolUpdate'),
      item('选择运行方式','selectExecutionMode'),
      item('选择更新来源','selectUpdateSource'),
      item('切换本地数据目录','setupTool'),
      item('打开本地数据目录','openToolHome'),
      item(bridge.isRunning()?'停止浏览器增强':'启动浏览器增强',bridge.isRunning()?'stopBridge':'startBridge'),
    ],
  };
  const common=project ? [item('项目设置','configureProject',{project:true}),
    {label:'查看本地修改',command:'workbench.view.scm',builtin:true},item('查看操作记录','showApiHistory',{project:true})]
    : [item('设置本地数据目录','setupTool')];
  const choices=[{label:'常用',kind:vscode.QuickPickItemKind.Separator},...common,
    ...Object.entries(groups).flatMap(([label,items])=>[{label,kind:vscode.QuickPickItemKind.Separator},...items])];
  const selected=await vscode.window.showQuickPick(choices,{title:project ? `${project.name || project.displayName} · 项目全部操作` : '项目全部操作',placeHolder:'搜索项目操作、检查、导入导出与设置',matchOnDescription:true});
  if(!selected || selected.kind===vscode.QuickPickItemKind.Separator)return;
  let workspace=project;
  if(selected.project && !workspace) {
    workspace=(await vscode.window.showQuickPick(workspaces.map(value=>({label:value.displayName || value.name,description:value.workspaceKey,value})),{title:'选择当前操作的项目'}))?.value;
    if(!workspace)return;
  }
  return vscode.commands.executeCommand(selected.builtin ? selected.command : 'gushenCompletion.'+selected.command,
    ...(selected.project ? [workspace.workspaceKey] : selected.args || []));
}

// View title actions may pass an opaque view context instead of a workspace key.
function workspaceKeyFrom(value) {
  return typeof value==='string' ? (value==='gushenCompletion.projectDetails' ? '' : value) : value?.workspaceKey || value?.guthonWorkspaceKey || '';
}
function projectMenuHandler({vscode,selectWorkspace,command}) {
  return async value=>{
    try {
      const workspace=await selectWorkspace(workspaceKeyFrom(value));if(!workspace)return;
      return await vscode.commands.executeCommand('gushenCompletion.'+command,workspace.workspaceKey);
    } catch(error) {return vscode.window.showErrorMessage(`项目操作失败：${error.message}`);}
  };
}

function projectToolHandler({vscode,selectWorkspace,runTool,command}) {
  return async value=>{
    try {const workspace=await selectWorkspace(workspaceKeyFrom(value));if(workspace)return await runTool(command,[],true,workspace.workspaceKey);}
    catch(error) {return vscode.window.showErrorMessage(`项目操作失败：${error.message}`);}
  };
}

function projectDiagnosisHandler({vscode,selectWorkspace,runTool,command}) {
  return async value=>{
    let workspace;
    try {workspace=await selectWorkspace(workspaceKeyFrom(value));}
    catch(error) {return vscode.window.showErrorMessage(`无法选择项目：${error.message}`);}
    if(!workspace)return;
    const selected=await vscode.window.showOpenDialog({canSelectFiles:true,canSelectFolders:false,canSelectMany:false,filters:{JSON:['json']},title:'选择排查定义 JSON'});
    if(selected?.length)return runTool(command,[selected[0].fsPath],true,workspace.workspaceKey);
  };
}

async function showProjectSettings({vscode,workspace,onConfiguration}) {
  const entries=[
    {label:'拉取范围',description:'选择需要下载的子系统和共享数据源',command:'selectApiSystems'},
    {label:'平台连接',description:'查看或修改当前项目的开发平台地址',command:'configureApiSource'},
    {label:'数据库查询与验证',description:'按向导配置只读连接和验证目标',command:'configureDatabaseDiagnosis'},
    {label:'配置文件',description:'查看配置位置或迁移到单一配置文件',configuration:true},
  ];
  const selected=await vscode.window.showQuickPick(entries,{title:`${workspace.name || workspace.displayName} · 项目设置`,placeHolder:'选择需要调整的设置；取消不会保存'});
  if(!selected)return;
  if(selected.configuration)return onConfiguration(workspace);
  return vscode.commands.executeCommand('gushenCompletion.'+selected.command,workspace.workspaceKey);
}

async function showConfiguration({vscode,client,workspace}) {
  const info=await client.run('','configuration-info');
  const choices=[{label:'查看当前项目设置',value:'view',description:'预览平台地址与拉取范围，不直接编辑配置文件'},
    ...(info.migrationAvailable ? [{label:'合并为单一配置文件',value:'migrate',description:'先预览，再确认；原配置保留备份'}] : [])];
  const selected=await vscode.window.showQuickPick(choices,{title:info.mode==='unified'?'项目使用单一配置文件':'项目配置',placeHolder:'向导保存设置；取消不会修改文件'});
  if(!selected)return;
  if(selected.value==='view') {
    const state=await client.run(workspace.workspaceKey,'api',['status','--stdin'],{summaryOnly:true,changesOnly:true});
    const doc=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify({configuration:info.mode==='unified'?info.path:'现有配置保持原样，可从向导合并为单一文件',settings:state.settings},null,2)});
    return vscode.window.showTextDocument(doc,{preview:true});
  }
  const plan=await client.run('','configuration-migrate',['--stdin'],{action:'preview'});
  if(!plan.complete || !plan.planHash)throw new Error('配置合并预览未完成，未修改配置');
  const detail=`本地数据目录中的 ${plan.summary?.workspaceCount ?? 0} 个项目设置将合并。\n目标：${plan.path}\n\n原配置：\n${(plan.legacyFiles || []).join('\n')}\n\n确认后写入一个配置文件，并备份原配置。`;
  const answer=await vscode.window.showWarningMessage('将现有设置合并为一个配置文件？',{modal:true,detail},'合并配置');
  if(answer!=='合并配置')return;
  const result=await client.run('','configuration-migrate',['--stdin'],{action:'apply',planHash:plan.planHash,confirm:true});
  if(!result.complete) {
    return vscode.window.showWarningMessage(`单一配置已启用，但部分旧配置尚未归档。备份：${result.backupPath}`,
      {modal:true,detail:(result.archivePending || []).join('\n')});
  }
  return vscode.window.showInformationMessage(`已合并配置：${result.path}`);
}

module.exports={showProjectActions,showProjectSettings,showConfiguration,workspaceKeyFrom,projectMenuHandler,projectToolHandler,projectDiagnosisHandler};

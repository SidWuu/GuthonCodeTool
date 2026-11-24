async function showProjectActions({vscode,getWorkspaces,bridge}) {
  let workspaces, projectsUnavailable=false;
  try {workspaces=await getWorkspaces();}
  catch {workspaces=[];projectsUnavailable=true;}
  const project=workspaces.length===1 ? workspaces[0] : undefined;
  const item=(label,command,{project=false,description='',args=[]}={})=>({label,command,project,description,args});
  const groups={
    '检查与恢复':[
      item('生成 MCP 客户端配置','generateMcpConfiguration',{project:true}),
      item('查看索引问题','showApiIndexDiagnostics',{project:true}),
      item('重试待更新文件','retryApiIndexFailures',{project:true}),
      item('重建全部索引','reindexCalls',{project:true,description:'仅在索引丢失或需要完整重建时使用'}),
      item('核对未确认的上传','verifyApiUpload',{project:true}),
      item('检查运行环境','runDoctor',{project:true}),
      item('执行源码排查','runDiagnosis',{project:true}),
      item('查看排查记录','showDiagnosisHistory',{project:true}),
    ],
    '项目管理':[
      item('查看工作区源码','openApiCheckout',{project:true}),
      item('添加项目','addWorkspace'),
      item('删除当前项目','deleteWorkspace',{project:true}),
    ],
    '工具设置':[
      item('选择运行方式','selectExecutionMode'),item('团队规则同步','syncTeamRules'),
      item('切换本地数据目录','setupTool'),item('打开本地数据目录','openToolHome'),
      item('退出登录','logoutApiSource',{project:true}),
    ],
    '检查更新':[
      item('检查工具组件更新','checkToolUpdate'),item('检查官方补全更新','checkOfficialUpdate'),
      item('选择更新来源','selectUpdateSource'),
      item('回退官方补全','rollbackOfficialUpdate'),item('回退后端版本','rollbackToolUpdate'),
    ],
  };
  const common=project ? [item('查看项目配置','configureProject',{project:true}),
    {label:'查看本地修改',command:'workbench.view.scm',builtin:true},item('查看操作记录','showApiHistory',{project:true})]
    : [item('设置本地数据目录','setupTool')];
  const browser=bridge.isRunning()?item('停止浏览器增强','stopBridge'):item('启动浏览器增强','startBridge');
  const choices=[{label:'常用',kind:vscode.QuickPickItemKind.Separator},...common,browser,
    ...Object.entries(groups).flatMap(([label,items])=>{
      const available=projectsUnavailable ? items.filter(action=>!action.project) : items;
      return available.length ? [{label,kind:vscode.QuickPickItemKind.Separator},...available] : [];
    })];
  const selected=await vscode.window.showQuickPick(choices,{title:project ? `${project.name || project.displayName} · 项目全部操作` : '项目全部操作',
    placeHolder:projectsUnavailable ? '当前后端无法读取项目，可切换运行方式或重新连接数据目录' : '搜索项目操作、检查与设置',matchOnDescription:true});
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
  return typeof value==='string' ? (value==='gushenCompletion.projectDetails' ? '' : value) : value?.workspaceKey || value?.guthonWorkspaceKey || value?.key || '';
}
function projectMenuHandler({vscode,selectWorkspace,command}) {
  return async value=>{
    try {
      const workspace=await selectWorkspace(workspaceKeyFrom(value));if(!workspace)return;
      return await vscode.commands.executeCommand('gushenCompletion.'+command,workspace.workspaceKey);
    } catch(error) {return vscode.window.showErrorMessage(`项目操作失败：${error.message}`);}
  };
}

function sourceExportArgs(command,value) {
  if(!value || typeof value==='string' || (!value.object && !value.category))return [];
  const object=value.object || {},category=value.category;
  const expected={'export-schema':['tables','table'],'export-view':['views','view'],'export-system-script':['system-script','system-script'],'export-bill-type':['bill-type','bill-type']}[command];
  if(!expected || (object.path ? object.sourceType!==expected[1] : category!==expected[0]))throw new Error('导出类型与所选源码不匹配');
  const args=[];
  const source=object.dataSourceId || value.dataSourceId,system=object.systemId || value.systemId;
  if(source)args.push('--data-source-ids',source);
  if(system)args.push('--system-ids',system);
  if(object.path) {
    const flag={'export-schema':'--table-ids','export-view':'--view-ids','export-system-script':'--script-types','export-bill-type':'--bill-type-codes'}[command];
    if(!object.sourceId)throw new Error('所选源码缺少导出身份');
    args.push(flag,object.sourceId);
  }
  return args;
}

async function showProjectIndex({vscode,workspace,client}) {
  const api=!workspace.sourceMode || workspace.sourceMode==='api';
  const key=workspace.workspaceKey;
  const canReindex=workspace.capabilities?.[workspace.sourceMode==='svn'?'svn.reindex':'source.reindex']!==false;
  const entries=[
    ...(canReindex?[{label:'重建索引',command:'reindexCalls'}]:[]),
    ...(api
      ? [{label:'查看索引诊断',command:'showApiIndexDiagnostics'},
         {label:'重试待更新文件',command:'retryApiIndexFailures'}]
      : [{label:'查看索引状态'}]),
  ];
  const selected=await vscode.window.showQuickPick(entries,{title:`${workspace.name || workspace.displayName} · 索引管理`});
  if(!selected)return;
  if(selected.command)return vscode.commands.executeCommand('gushenCompletion.'+selected.command,key);
  const status=await client.run(key,'index-doctor');
  const document=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(status,null,2)});
  return vscode.window.showTextDocument(document,{preview:true});
}
async function showProjectHistory({vscode,workspace}) {
  const selected=await vscode.window.showQuickPick([{label:'源码同步与上传记录',command:'showApiHistory'},
    {label:'数据库排查记录',command:'showDiagnosisHistory'}],{title:'当前项目操作记录'});
  if(selected)return vscode.commands.executeCommand('gushenCompletion.'+selected.command,workspace.workspaceKey);
}

function projectToolHandler({vscode,selectWorkspace,runTool,command}) {
  return async value=>{
    try {const workspace=await selectWorkspace(workspaceKeyFrom(value));if(workspace)return await runTool(command,sourceExportArgs(command,value),true,workspace.workspaceKey);}
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

async function showConfiguration({vscode,client,workspace}) {
  const info=await client.run('','configuration-info');
  const state=await client.run(workspace.workspaceKey,'api',['status','--stdin'],{summaryOnly:true,changesOnly:true});
  const doc=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify({configuration:info.path,settings:state.settings},null,2)});
  return vscode.window.showTextDocument(doc,{preview:true});
}

module.exports={showProjectActions,showConfiguration,sourceExportArgs,showProjectIndex,showProjectHistory,workspaceKeyFrom,projectMenuHandler,projectToolHandler,projectDiagnosisHandler};

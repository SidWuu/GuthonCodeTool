const fs=require('node:fs/promises');
const path=require('node:path');
const {SCHEME:API_SCHEME,decodeIdentity:decodeApiIdentity}=require('./source/virtual-fs');
const {SCHEME:SVN_SCHEME}=require('./svn/virtual-fs');
const {SCHEME:DATABASE_SCHEME}=require('./database-source-editor');

function assertWorkspaceSaved(vscode,workspace,editorState,legacyProjects) {
  const key=workspace.workspaceKey;
  const directories=[workspace.root,workspace.docsDir,workspace.contextDir,workspace.runtimeDir,
    ...(workspace.sourceRoots || []).map(entry=>entry.path)].filter(Boolean);
  const {textDocuments=[],notebookDocuments=[]}=vscode.workspace;
  const dirty=[...textDocuments,...notebookDocuments].some(({uri,isDirty})=>{
    if(!isDirty)return false;
    if(uri.scheme===API_SCHEME) return decodeApiIdentity(uri).workspaceKey===key;
    if([SVN_SCHEME,DATABASE_SCHEME].includes(uri.scheme))return uri.authority===key;
    if(uri.scheme!=='file')return false;
    return directories.some(directory=>{
      const relative=path.relative(directory,uri.fsPath);
      return relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative);
    });
  });
  if(dirty || [...editorState.drafts.values()].some(draft=>draft.key===key && draft.dirty)
      || legacyProjects?.hasUnsavedDrafts(workspace)) {
    throw new Error('该项目有未保存的编辑器或页面草稿，请先处理');
  }
}

async function deleteWorkspace({vscode,workspace,request,assertSaved,assertTool,refresh}) {
  const workspaceKey=workspace.workspaceKey;
  let plan;
  try {
    assertSaved();
    plan=await request({workspaceKey,checkOnly:true});
    if(plan.workspaceKey!==workspaceKey || !/^[a-f0-9]{64}$/.test(plan.planId)
        || !Array.isArray(plan.paths) || plan.paths.length!==1 || !path.isAbsolute(plan.paths[0])
        || path.relative(workspace.root,plan.paths[0])!=='' || !Array.isArray(plan.retainedPaths)) {
      throw new Error('删除预览身份或路径无效，请核对项目配置及后端版本');
    }
  } catch(error) {return vscode.window.showErrorMessage(`无法读取删除范围：${error.message}`);}
  const target=plan.paths[0];
  const retained=plan.retainedPaths.length ? `\n\n项目目录之外保留的路径\n${plan.retainedPaths.join('\n')}` : '';
  const confirmed=await vscode.window.showWarningMessage(
    `确认删除 ${plan.displayName}（${workspaceKey}）？`,
    {modal:true,detail:`以下项目目录及其中的本地改动将移入系统废纸篓\n${target}${retained}`},'确认删除');
  if(confirmed!=='确认删除')return false;
  try {
    assertSaved();
    await request({workspaceKey,checkOnly:true,planId:plan.planId});
    const info=await fs.lstat(target).catch(error=>{if(error.code!=='ENOENT')throw error;});
    if(info && !info.isDirectory())throw new Error('项目目录已变化，请重新预览');
    assertSaved();
    assertTool();
    if(info)await vscode.workspace.fs.delete(vscode.Uri.file(target),{recursive:true,useTrash:true});
  } catch(error) {
    return vscode.window.showErrorMessage(`删除已停止：${error.message}`);
  }
  try {await request({workspaceKey,checkOnly:false,planId:plan.planId});}
  catch(error) {return vscode.window.showErrorMessage(`移除项目登记失败：${error.message}。可从系统废纸篓恢复已移走的目录。`);}
  await refresh();
  return vscode.window.showInformationMessage(`已删除 ${plan.displayName}，本地项目目录可从系统废纸篓恢复。`);
}

module.exports={assertWorkspaceSaved,deleteWorkspace};

const {showWorkspaceSearch} = require('../workspace-search');

async function quickOpenSource({vscode,listWorkspaces,search,open,workspaceKey=''}) {
  const workspaces=await listWorkspaces();let workspace=workspaceKey?workspaces.find(item=>item.workspaceKey===workspaceKey):undefined;
  if(workspaceKey && !workspace)throw new Error('目标 SVN 工作区不存在');
  if(!workspace){
    if(workspaces.length===1)workspace=workspaces[0];
    else workspace=(await vscode.window.showQuickPick(workspaces.map(item=>({label:item.displayName,description:item.workspaceKey,workspace:item})),{title:'选择 SVN 源码工作区'}))?.workspace;
  }
  if(!workspace)return;
  const editor=vscode.window.activeTextEditor;
  const selected=editor?.selection && !editor.selection.isEmpty ? editor.document.getText(editor.selection).trim().slice(0,100) : '';
  const picked=await showWorkspaceSearch({vscode,title:`快速打开 SVN 源码 · ${workspace.displayName}`,value:selected,
    sourceOnly:true,search:query=>search(workspace.workspaceKey,query)});
  if(!picked)return;
  return open({workspaceKey:workspace.workspaceKey,...picked.item.identity});
}
module.exports={quickOpenSource};

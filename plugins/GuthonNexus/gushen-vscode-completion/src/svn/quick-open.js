// One action after selecting a bounded source candidate; no extra action picker.
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
  const keyword=await vscode.window.showInputBox({title:'快速打开 SVN 源码',prompt:'名称、路径、ID 或函数关键词',value:selected,validateInput:value=>String(value||'').trim()?undefined:'请输入关键词'});
  if(!keyword)return;
  const result=await search(workspace.workspaceKey,keyword);
  const sources=(result.items||[]).filter(item=>item.kind==='source');
  if(!sources.length)return vscode.window.showInformationMessage('未找到索引对象；请检查关键词和索引状态');
  const picked=await vscode.window.showQuickPick(sources.map(item=>({label:item.label,description:item.identity?.sourcePath||item.description,detail:item.identity?.sourceNamespace||'',item})),{title:'选择源码',matchOnDescription:true,matchOnDetail:true});
  if(!picked)return;
  return open({workspaceKey:workspace.workspaceKey,...picked.item.identity});
}
module.exports={quickOpenSource};

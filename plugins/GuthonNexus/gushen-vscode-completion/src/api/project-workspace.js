const fs=require('node:fs/promises');
const path=require('node:path');
const {parse,modify,applyEdits}=require('jsonc-parser');

const RUNTIME_SETTINGS=['executionMode','toolHome','toolPath','developmentRoot','scriptPythonPath','scriptToolPath'];

async function openProjectWorkspace(vscode,{workspaceRoot,checkoutPath}) {
  if(!path.isAbsolute(workspaceRoot || '') || !path.isAbsolute(checkoutPath || '')) throw new Error('后端未提供有效的项目目录和 checkout 路径');
  const samePath=(a,b)=>{
    const left=path.resolve(a),right=path.resolve(b);
    return process.platform==='win32' ? left.toLowerCase()===right.toLowerCase() : left===right;
  };
  if((vscode.workspace.workspaceFolders || []).some(folder=>folder.uri.scheme==='file' && samePath(folder.uri.fsPath,checkoutPath))) {
    await vscode.commands.executeCommand('workbench.view.explorer');return;
  }
  const filename=path.join(workspaceRoot,'context','nexus.code-workspace');
  if((vscode.workspace.textDocuments || []).some(doc=>doc.uri.scheme==='file' && samePath(doc.uri.fsPath,filename) && doc.isDirty)) throw new Error('项目工作区文件有未保存的修改，请先保存');
  let text;
  try {text=await fs.readFile(filename,'utf8');}
  catch(error) {if(error.code!=='ENOENT') throw error;text='{}\n';}
  const errors=[],workspace=parse(text,errors,{allowTrailingComma:true});
  if(errors.length || !workspace || typeof workspace!=='object' || Array.isArray(workspace) || (workspace.settings!==undefined && (!workspace.settings || typeof workspace.settings!=='object' || Array.isArray(workspace.settings)))) throw new Error('项目工作区文件格式无效，请修正后重试');
  const config=vscode.workspace.getConfiguration('gushenCompletion');
  const updates=[['folders',[{path:checkoutPath}]],...RUNTIME_SETTINGS.map(name=>[`settings.gushenCompletion.${name}`,config.get(name,name==='executionMode'?'packaged':'')])];
  const original=text;
  for(const [key,value] of updates) {
    const segments=key==='folders' ? ['folders'] : ['settings',key.slice('settings.'.length)];
    text=applyEdits(text,modify(text,segments,value,{formattingOptions:{insertSpaces:true,tabSize:2}}));
  }
  if(text!==original) await fs.writeFile(filename,text,'utf8');
  await vscode.commands.executeCommand('vscode.openFolder',vscode.Uri.file(filename),{forceNewWindow:true});
}

module.exports={openProjectWorkspace};

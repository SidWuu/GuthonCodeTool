const fs=require('node:fs');
const path=require('node:path');
const { workspaceRoot } = require('../workspace-root');
const crypto=require('node:crypto');
const jsonc=require('jsonc-parser');
const {spawn}=require('node:child_process');
const {toolArguments}=require('../tool-runtime');
const CLIENTS=[{label:'CodeBuddy',file:'.mcp.json',key:'mcpServers'},
  {label:'Trae',file:'.trae/mcp.json',key:'mcpServers'},
  {label:'VS Code',file:'.vscode/mcp.json',key:'servers'}];

function configurationText(original,client,tool,readOnly=true,provider='api') {
  if(!['api','svn','database'].includes(provider))throw new Error('不支持的 MCP 源码模式');
  const errors=[];
  const document=jsonc.parse(original || '{}',errors,{allowTrailingComma:true});
  if(errors.length || !document || typeof document!=='object' || Array.isArray(document))throw new Error('已有 MCP 配置无效，请先修复 JSON/JSONC');
  if(document[client.key]!==undefined && (!document[client.key] || typeof document[client.key]!=='object' || Array.isArray(document[client.key])))throw new Error('已有 MCP 服务列表不是对象');
  const server={type:'stdio',command:tool.toolPath,args:toolArguments(tool,'mcp',['--stdio',...(provider==='api'?[]:['--provider',provider]),...(readOnly || provider==='database'?['--read-only']:[])])};
  return {server,text:jsonc.applyEdits(original || '{}\n',jsonc.modify(original || '{}\n',[client.key,'guthon-'+provider],server,
    {formattingOptions:{insertSpaces:true,tabSize:2,eol:original.includes('\r\n')?'\r\n':'\n'}}))};
}
function probeMcp(server,workspaceKey,spawnProcess=spawn) {
  return new Promise((resolve,reject)=>{
    const child=spawnProcess(server.command,server.args,{shell:false});let stdout='',stderr='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('MCP 只读连接检查超时'));},15000);
    child.stdout.on('data',data=>{stdout+=data;if(stdout.length>2097152){child.kill();reject(new Error('MCP 检查输出过大'));}});
    child.stderr.on('data',data=>{stderr+=data;});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.stdin.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('exit',code=>{
      clearTimeout(timer);
      if(code)return reject(new Error('MCP 进程检查失败：'+stderr.slice(0,1000)));
      try {
        const messages=stdout.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
        const discovered=messages.find(message=>message.id===2)?.result?.tools;
        if(!Array.isArray(discovered))throw new Error('MCP 未返回工具清单');
        const online=messages.find(message=>message.id===3)?.result;
        resolve({tools:discovered.length,online:online && !online.isError,
          onlineError:online?.isError ? online.structuredContent?.error?.message || '在线查询失败，请登录对应 Nexus 项目后重试' : undefined});
      }catch(error){reject(error);}
    });
    for(const request of [
      {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'nexus-connection-check',version:'1'}}},
      {jsonrpc:'2.0',method:'notifications/initialized'},
      {jsonrpc:'2.0',id:2,method:'tools/list'},
      ...(workspaceKey?[{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_platform_system_menu',arguments:{workspaceKey,offset:0,maxChars:1000}}}]:[]),
    ])child.stdin.write(JSON.stringify(request)+'\n');
    child.stdin.end();
  });
}
function configurationFolder(vscode,workspace,tool) {
  const roots=[workspace.spaceRoot,tool.toolHome && workspaceRoot(tool.toolHome),workspace.root,workspace.checkoutPath].filter(Boolean).map(value=>path.resolve(value));
  const normalize=value=>process.platform==='win32'?value.toLowerCase():value;
  return (vscode.workspace.workspaceFolders || []).find(folder=>folder.uri.scheme==='file' && roots.some(root=>normalize(root)===normalize(path.resolve(folder.uri.fsPath))));
}
async function generateConfiguration({vscode,getTool,selectWorkspace,probe=probeMcp}) {
  const workspace=await selectWorkspace('');if(!workspace)return;
  const tool=await getTool();if(!tool)throw new Error('请先选择实际运行入口和本地数据目录');
  const folder=configurationFolder(vscode,workspace,tool);
  if(!folder)throw new Error('请在当前窗口打开本地数据目录的 var、工作区目录或 checkout');
  const client=await vscode.window.showQuickPick(CLIENTS,{title:'选择 MCP 客户端'});if(!client)return;
  const provider=workspace.sourceMode || 'api';
  const access=provider==='database'?{readOnly:true}:await vscode.window.showQuickPick([{label:'仅查询',readOnly:true},{label:'允许受控本地修改及已确认的平台操作',readOnly:false}],{title:'选择 MCP 能力范围'});if(!access)return;
  const file=path.join(folder.uri.fsPath,client.file),original=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
  const result=configurationText(original,client,tool,access.readOnly,provider);
  const before=await vscode.workspace.openTextDocument({language:'jsonc',content:original || '{}'});
  const after=await vscode.workspace.openTextDocument({language:'jsonc',content:result.text});
  await vscode.commands.executeCommand('vscode.diff',before.uri,after.uri,`${client.label} MCP 配置预览`);
  if(await vscode.window.showWarningMessage('将预览的 Guthon MCP 服务合并到当前打开目录的配置？',{modal:true,detail:client.file},'合并配置')!=='合并配置')return;
  if((fs.existsSync(file)?fs.readFileSync(file,'utf8'):'')!==original)throw new Error('审阅期间配置发生变化，请重新生成');
  if(result.text!==original) {
    fs.mkdirSync(path.dirname(file),{recursive:true});
    if(original)fs.writeFileSync(file+'.backup-'+crypto.randomUUID(),original,{flag:'wx',mode:0o600});
    const temporary=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temporary,result.text,{flag:'wx',mode:0o600});fs.renameSync(temporary,file);
  }
  const checked=await probe(result.server,provider==='api'?workspace.workspaceKey:'');
  const clientCheck = client.label === 'CodeBuddy'
    ? `请在 CodeBuddy 的 MCP 页面审查并批准项目 guthon-${provider} 服务，再在新对话中回读确认`
    : '请在客户端完成服务信任或重连，再验证实际工具调用';
  await vscode.window.showInformationMessage(`MCP 配置已保存；后端探测发现 ${checked.tools} 个工具。${clientCheck}。${provider!=='api'?'本地 MCP 工具发现通过':checked.online?'在线只读检查通过':'在线只读检查尚未通过：'+(checked.onlineError || '尚未验证')}`);
  return checked;
}
module.exports={CLIENTS,configurationText,probeMcp,configurationFolder,generateConfiguration};

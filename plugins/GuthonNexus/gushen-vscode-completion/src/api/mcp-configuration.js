const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const jsonc=require('jsonc-parser');
const {spawn}=require('node:child_process');
const {toolArguments}=require('../tool-runtime');
const CLIENTS=[{label:'CodeBuddy',file:'.mcp.json',key:'mcpServers'},
  {label:'Trae',file:'.trae/mcp.json',key:'mcpServers'},
  {label:'VS Code',file:'.vscode/mcp.json',key:'servers'}];

function configurationText(original,client,tool,readOnly=true) {
  const errors=[];
  const document=jsonc.parse(original || '{}',errors,{allowTrailingComma:true});
  if(errors.length || !document || typeof document!=='object' || Array.isArray(document))throw new Error('已有 MCP 配置无效，请先修复 JSON/JSONC');
  if(document[client.key]!==undefined && (!document[client.key] || typeof document[client.key]!=='object' || Array.isArray(document[client.key])))throw new Error('已有 MCP 服务列表不是对象');
  const server={type:'stdio',command:tool.toolPath,args:toolArguments(tool,'mcp',['--stdio',...(readOnly?['--read-only']:[])])};
  return {server,text:jsonc.applyEdits(original || '{}\n',jsonc.modify(original || '{}\n',[client.key,'guthon-api'],server,
    {formattingOptions:{insertSpaces:true,tabSize:2,eol:original.includes('\r\n')?'\r\n':'\n'}}))};
}
function probeMcp(server,workspaceKey,spawnProcess=spawn) {
  return new Promise((resolve,reject)=>{
    const child=spawnProcess(server.command,server.args,{shell:false});let stdout='',stderr='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('MCP 只读连接检查超时'));},15000);
    child.stdout.on('data',data=>{stdout+=data;if(stdout.length>2097152){child.kill();reject(new Error('MCP 检查输出过大'));}});
    child.stderr.on('data',data=>{stderr+=data;});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
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
async function generateConfiguration({vscode,getTool,selectWorkspace}) {
  const workspace=await selectWorkspace('');if(!workspace)return;
  const folder=vscode.workspace.workspaceFolders?.find(item=>path.resolve(item.uri.fsPath)===path.resolve(workspace.checkoutPath || workspace.root));
  if(!folder)throw new Error('请先在当前窗口打开目标项目源码根目录');
  const client=await vscode.window.showQuickPick(CLIENTS,{title:'选择 MCP 客户端'});if(!client)return;
  const access=await vscode.window.showQuickPick([{label:'仅查询',readOnly:true},{label:'允许受控本地修改及已确认的平台操作',readOnly:false}],{title:'选择 MCP 能力范围'});if(!access)return;
  const tool=await getTool();if(!tool)throw new Error('请先选择实际运行入口和本地数据目录');
  const file=path.join(folder.uri.fsPath,client.file),original=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
  const result=configurationText(original,client,tool,access.readOnly);
  const before=await vscode.workspace.openTextDocument({language:'jsonc',content:original || '{}'});
  const after=await vscode.workspace.openTextDocument({language:'jsonc',content:result.text});
  await vscode.commands.executeCommand('vscode.diff',before.uri,after.uri,`${client.label} MCP 配置预览`);
  if(await vscode.window.showWarningMessage('将预览的 Guthon MCP 服务合并到当前项目配置？',{modal:true,detail:client.file},'合并配置')!=='合并配置')return;
  if((fs.existsSync(file)?fs.readFileSync(file,'utf8'):'')!==original)throw new Error('审阅期间配置发生变化，请重新生成');
  if(result.text!==original) {
    fs.mkdirSync(path.dirname(file),{recursive:true});
    if(original)fs.writeFileSync(file+'.backup-'+crypto.randomUUID(),original,{flag:'wx',mode:0o600});
    const temporary=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temporary,result.text,{flag:'wx',mode:0o600});fs.renameSync(temporary,file);
  }
  const checked=await probeMcp(result.server,workspace.workspaceKey);
  await vscode.window.showInformationMessage(`MCP 配置已保存，发现 ${checked.tools} 个工具；${checked.online?'在线只读查询通过':checked.onlineError || '在线查询尚未验证'}`);
  return checked;
}
module.exports={CLIENTS,configurationText,probeMcp,generateConfiguration};

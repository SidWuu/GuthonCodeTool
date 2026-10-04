const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

function extensionBuildInfo(root) {
  const hash=crypto.createHash('sha256');
  const files=[];
  function walk(directory) {
    if(!fs.existsSync(directory))return;
    for(const item of fs.readdirSync(directory,{withFileTypes:true})) {
      const file=path.join(directory,item.name);
      if(item.isSymbolicLink())throw new Error('Nexus 构建标识不接受符号链接资源');
      if(item.isDirectory())walk(file);
      else if(item.isFile() && /\.(?:js|json)$/.test(item.name))files.push(file);
    }
  }
  for(const folder of ['src','bridge','data'])walk(path.join(root,folder));
  for(const name of ['package.json','tool-version.json'])if(fs.existsSync(path.join(root,name)))files.push(path.join(root,name));
  for(const file of files.sort((a,b)=>a.localeCompare(b,'en'))) {
    const name=path.relative(root,file).split(path.sep).join('/');
    hash.update(name+'\0');hash.update(fs.readFileSync(file));hash.update('\0');
  }
  const info=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  return {version:info.version,buildId:'sha256:'+hash.digest('hex'),hashedFiles:files.length};
}

function registerExtensionBuild(vscode,context) {
  const info=extensionBuildInfo(context.extensionPath);
  const item=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,0);
  item.text=`Guthon Nexus ${info.version} · ${info.buildId.slice(7,15)}`;
  item.tooltip=`当前已加载 Nexus\n版本：${info.version}\n构建标识：${info.buildId}\n标识基于公开插件代码及资源；后端 buildId 由独立 runtime status 提供。`;
  item.show();context.subscriptions.push(item);
  return info;
}
module.exports={extensionBuildInfo,registerExtensionBuild};

const {decodeIdentity}=require('../source/virtual-fs');

class PlatformReferences {
  constructor(api) {this.api=api;this.cache=new Map();}
  workspace(document) {
    const uri=document.uri;
    if(uri.scheme==='guthon-api-edit')return decodeIdentity(uri).workspaceKey;
    if(uri.scheme==='file')for(const [key,state] of this.api.editorState.workspaces)
      if(this.api.editorState.documentPath(key,state,document))return key;
    return undefined;
  }
  async data(document) {
    const key=this.workspace(document);if(!key)return [];
    const generation=this.api.sourceTree.indexGenerations.get(key);
    const cached=this.cache.get(key);if(cached && cached.generation===generation)return cached.promise;
    const promise=this.api.run(key,'reference',{kind:'api',limit:1000}).then(result=>result.items)
      .catch(error=>{if(this.cache.get(key)?.promise===promise)this.cache.delete(key);throw error;});
    this.cache.set(key,{generation,promise});return promise;
  }
}

async function showPlatformReference({vscode,run,ui,key}) {
  const choice=await vscode.window.showQuickPick([
    {label:'前端 JavaScript API',kind:'api',selector:'javascript'},
    {label:'服务端谷神脚本 API',kind:'api',selector:'guthonscript'},
    {label:'页面结构与属性',kind:'schema'}, {label:'控件事件与上下文',kind:'events'},
    {label:'编写规则',kind:'rules'}, {label:'资料覆盖与缺失项',kind:'overview'},
  ],{title:'当前项目开发参考'});
  if(!choice)return;
  const result=await run(key,'reference',{kind:choice.kind,selector:choice.selector || '',limit:1000});
  if(choice.kind==='overview') {
    const content=['# 当前项目开发参考',`已登记 ${result.paths.length} 份平台资料。`,
      '上游说明作为参考资料，不覆盖本项目目录、文件格式及写入规则。',...result.warnings.map(x=>'- '+x)].join('\n\n');
    return vscode.window.showTextDocument(await vscode.workspace.openTextDocument({language:'markdown',content}),{preview:true});
  }
  let selected;
  if(choice.kind==='api')selected=await vscode.window.showQuickPick(result.items.map(item=>({label:item.signature,description:item.description,path:item.referencePath,lineNumber:item.lineNumber})),{title:choice.label,matchOnDescription:true});
  else if(choice.kind==='schema' || choice.kind==='events') {
    const entries=choice.kind==='schema' ? result.data.kinds : result.data.groups;
    const group=await vscode.window.showQuickPick(Object.entries(entries).map(([id,value])=>({label:value.title || id,description:value.note || value.mountPath,id})),{title:choice.label,matchOnDescription:true});
    if(group)selected=await run(key,'reference',{kind:choice.kind,selector:group.id});
  } else selected=result;
  if(selected?.path)return ui.open(key,selected.path,true,{raw:true,lineNumber:selected.lineNumber});
}

module.exports={PlatformReferences,showPlatformReference};

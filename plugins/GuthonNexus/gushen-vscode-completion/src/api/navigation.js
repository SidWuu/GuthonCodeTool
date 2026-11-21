const path=require('node:path');
const {showWorkspaceSearch}=require('../workspace-search');
const {procedureTargetAt,serviceComponentTargetAt,localFunctionDefinitionAt,localFunctionAt,inheritCallAt}=require('../definition');
const {apiContext,exportAiContext}=require('../ai-context-export');
const {registerEditorAssistance}=require('../source/editor-assistance');
const {decodeIdentity,SCHEME,scriptType}=require('../source/virtual-fs');
const {navigateInBrowser}=require('../source/browser-navigation');
const {isWorkspaceKey}=require('../workspace-identity');
const {filePath,identity:fromElement,sourceLabel}=require('./source-ui');
const {readInheritance}=require('../source/inheritance');

async function allPages(run,key,action,payload,listName) {
  let offset=0,generation,partial=false;const items=[];
  for(;;) {
    const result=await run(key,action,{...payload,limit:100,offset});
    if(generation && result.indexGeneration && generation!==result.indexGeneration) throw new Error('查询期间索引已变化，请重新查询');
    generation ||= result.indexGeneration;items.push(...(result[listName] || []));partial ||= !!result.partialSourceCount;
    if(result.nextOffset == null) return {items,truncated:partial || (!!result.truncated && !result.nextOffset)};
    if(!Number.isInteger(result.nextOffset) || result.nextOffset<=offset) throw new Error('查询分页无效');
    offset=result.nextOffset;
  }
}
async function findExactCandidates(run,key,type,query,matches) {
  const result=await allPages(run,key,'search',{query},'hits');
  return {items:[...new Map(result.items.filter(item=>item.sourceType===type && item.path && matches(item)).map(item=>[item.path,item])).values()],truncated:result.truncated};
}
function sourceLink(key,sourcePath) {
  if(!isWorkspaceKey(key)) throw new Error('缺少明确项目身份');
  filePath('/api-root',sourcePath);
  return `vscode://gushen-local.guthon-nexus-vscode/open-source?${new URLSearchParams({workspaceKey:key,path:sourcePath})}`;
}
function parseSourceLink(uri) {
  if(uri.authority!=='gushen-local.guthon-nexus-vscode' || !['/open-source','/locate-page','/locate-procedure'].includes(uri.path)) throw new Error('源码定位链接无效');
  const params=new URLSearchParams(uri.query || '');
  const keys=uri.path==='/open-source' ? ['workspaceKey','path'] : uri.path==='/locate-page' ? ['workspaceKey','pageId'] : ['workspaceKey','alias','funId'];
  if([...params.keys()].some(k=>!keys.includes(k) || params.getAll(k).length!==1)) throw new Error('源码定位链接字段无效');
  const value=Object.fromEntries(params);
  if(value.workspaceKey && !isWorkspaceKey(value.workspaceKey)) throw new Error('链接工作区无效');
  if(uri.path==='/open-source') {if(!value.workspaceKey || !value.path) throw new Error('链接缺少项目或路径');filePath('/api-root',value.path);}
  else if(uri.path==='/locate-page' && !/^PG-[\w-]{1,96}$/i.test(value.pageId || '')) throw new Error('页面编码无效');
  else if(uri.path==='/locate-procedure' && (!/^[\w.$-]{1,256}$/.test(value.alias || '') || !/^[\w$]{1,128}$/.test(value.funId || ''))) throw new Error('过程函数身份无效');
  return {type:uri.path.slice(1),...value};
}
async function sourceTreeAction(vscode,tree,command) {
  if (tree?.setExpanded && await tree.setExpanded(command==='list.expand')) return;
  const selected = tree?.selection?.[0];
  if (!selected) return vscode.window.showInformationMessage('请先选择源码树节点');
  await tree.reveal(selected,{select:true,focus:true});return vscode.commands.executeCommand(command);
}
function createApiNavigation({vscode,context,api,selectWorkspace,getTool,bridge,locateLegacy,legacyAction}) {
  const {run,sourceTree:ui,editorState}=api;
  async function workspaceForDocument(document) {
    if(document?.uri?.scheme===SCHEME) return selectWorkspace(decodeIdentity(document.uri).workspaceKey);
    if(document?.uri?.scheme==='file') for(const [key,state] of editorState.workspaces) if(editorState.documentPath(key,state,document)) return selectWorkspace(key);
    return undefined;
  }
  async function open(key,item) {
    const sourcePath=item.path || item.sourcePath;
    if(!sourcePath) throw new Error('结果缺少源码路径');
    if(item.sourceType==='module-parameter' && item.referenceFields?.snapshotPath)
      return vscode.commands.executeCommand('gushenCompletion.editModuleParameter',{workspaceKey:key,path:sourcePath,moduleParameter:item.referenceFields});
    if(item.jsonPointer && !item.sourceType) {const source=await run(key,'read',{path:sourcePath});item={...item,sourceType:source.metadata?.sourceType};}
    if(item.sourceType==='page' && item.jsonPointer) {
      const snapshot=await run(key,'page',{action:'open',path:sourcePath});
      const node=snapshot.model.nodes.find(n=>n.pointer===item.jsonPointer);
      if(node) return api.openFragment({workspaceKey:key,sourceType:'page',sourcePath,sourceId:snapshot.sourceId,jsonPointer:node.pointer,
        fragmentType:scriptType(node),documentName:node.label});
    }
    const editor=await ui.open(key,sourcePath,false,{lineNumber:item.lineNumber});
    if(item.line>0 && editor?.document) {
      const line=Math.min(item.line-1,Math.max(0,editor.document.lineCount-1));
      editor.selection=new vscode.Selection(line,0,line,0);editor.revealRange(new vscode.Range(line,0,line,0));
    }
    return editor;
  }
  async function inheritancePointer(key,sourcePath,source,existingPointer='') {
    if(existingPointer) return existingPointer;
    if(source.metadata?.sourceType!=='page' || /\.gss$/i.test(sourcePath)) return '';
    const snapshot=await run(key,'page',{action:'open',path:sourcePath});
    if(snapshot.sourcePath!==sourcePath || snapshot.sourceHash!==source.sourceHash) throw new Error('PAGE 已变化，请重新选择继承脚本');
    const candidates=snapshot.model.nodes.filter(node=>/@?inherit\s*\(/.test(node.content));
    if(!candidates.length) {await vscode.window.showInformationMessage('无继承源码');return undefined;}
    if(candidates.length===1) return candidates[0].pointer;
    return (await vscode.window.showQuickPick(candidates.map(node=>({label:node.label || node.pointer,description:node.pointer,node})),{title:'选择要展开的继承脚本'}))?.node.pointer;
  }
  async function saveContext(workspace,identity) {
    const sourcePath=identity.sourcePath || identity.path,source=await run(workspace.workspaceKey,'read',{path:sourcePath});
    const choices=[{label:'索引摘要',value:'metadata'},{label:'摘要与影响预览',value:'impact'}];
    if(['page','procedure','system-script'].includes(source.metadata?.sourceType)) choices.push({label:'摘要、影响与继承上下文',value:'inheritance'});
    const selected=await vscode.window.showQuickPick(choices,{title:'选择 AI 上下文文件内容'});if(!selected) return;
    let pointer=identity.jsonPointer || '';
    if(selected.value==='inheritance') {pointer=await inheritancePointer(workspace.workspaceKey,sourcePath,source,pointer);if(pointer===undefined) return;}
    const tool=getTool();if(!tool) throw new Error('请先配置 GuthonCodeTool');
    const result=await exportAiContext({run,toolHome:tool.toolHome,workspace,identity:{...identity,sourcePath,sourceType:source.metadata.sourceType,jsonPointer:pointer},
      includeImpact:selected.value!=='metadata',includeInheritance:selected.value==='inheritance'});
    return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(result.artifactPath)),{preview:true});
  }
  async function search(value,exportOnly=false) {
    let key=typeof value==='string' ? value : value?.workspaceKey || value?.guthonWorkspaceKey || value?.key || '';
    const workspace=await selectWorkspace(key);if(!workspace) return;
    if(!exportOnly && workspace.sourceMode && workspace.sourceMode!=='api' && legacyAction)return legacyAction(workspace,'search');
    const selected=await showWorkspaceSearch({vscode,title:`搜索当前项目 · ${workspace.displayName}`,
      defaultAction:exportOnly?'context-file':'open',search:async query=>{
        const result=await allPages(run,workspace.workspaceKey,'search',{query},'hits');
        return {truncated:result.truncated,items:result.items.map(hit=>({kind:'source',label:sourceLabel(hit) || hit.path,
          description:hit.path,detail:hit.excerpt || hit.jsonPointer || '',identity:{...hit,sourcePath:hit.path}}))};
      }});
    if(!selected) return;
    const object=selected.item.identity;
    if(selected.action==='open') return open(workspace.workspaceKey,object);
    const detailed=selected.action!=='context';
    if(selected.action==='context-file') return saveContext(workspace,object);
    const result=await apiContext({run,workspaceKey:workspace.workspaceKey,identity:object,includeImpact:detailed});
    await vscode.env.clipboard.writeText(result.markdown);return vscode.window.showInformationMessage('源码上下文已复制');
  }
  async function exact(workspace,type,query,match) {
    const result=await findExactCandidates(run,workspace.workspaceKey,type,query,match);
    const values=result.items;
    if(!values.length) throw new Error(result.truncated?'未找到完整匹配；索引包含未解析对象，请先检查索引':'当前项目未找到匹配源码');
    if(values.length===1) return values[0];
    return (await vscode.window.showQuickPick(values.map(item=>({label:sourceLabel(item) || item.path,description:item.path,item})),{title:'选择精确源码对象'}))?.item;
  }
  async function locatePage(key,pageId) {
    const workspace=await selectWorkspace(key);if(!workspace) return;
    const id=pageId || await vscode.window.showInputBox({title:'输入 PAGE 编码'});if(!id) return;
    if(workspace.sourceMode && workspace.sourceMode!=='api' && locateLegacy)return locateLegacy(workspace,{pageId:id});
    const item=await exact(workspace,'page',id,x=>String(x.sourceId).toUpperCase()===id.toUpperCase());
    if(item) {
      if(/\.(?:xml|json)$/i.test(item.path)) return vscode.commands.executeCommand('gushenCompletion.openApiPageEditor',{workspaceKey:workspace.workspaceKey,path:item.path});
      return open(workspace.workspaceKey,{...item,jsonPointer:'',line:undefined});
    }
  }
  async function locateProcedure(key,alias,funId) {
    const workspace=await selectWorkspace(key);if(!workspace) return;
    if(!alias) {const full=await vscode.window.showInputBox({title:'输入包名和函数名',placeHolder:'demo.pkg.save'});if(!full) return;const i=full.lastIndexOf('.');if(i<1) throw new Error('请输入完整包名和函数名');alias=full.slice(0,i);funId=full.slice(i+1);}
    if(workspace.sourceMode && workspace.sourceMode!=='api' && locateLegacy)return locateLegacy(workspace,{alias,funId});
    const item=await exact(workspace,'procedure',funId,x=>x.alias===alias && x.funId===funId);if(item) return open(workspace.workspaceKey,item);
  }
  async function selectedObject(value) {
    const {key,path:sourcePath}=fromElement(value);if(!key || !sourcePath) throw new Error('请选择当前项目中的源码文件');
    const result=await run(key,'read',{path:sourcePath});return {key,path:sourcePath,result};
  }
  async function showNodes(value) {
    const {key,path:p}=await selectedObject(value);const result=await run(key,'page',{action:'open',path:p});
    const choices=[...result.model.nodes.map(node=>({label:node.label || node.pointer,description:node.pointer,node})),
      ...result.model.collections.map(collection=>({label:collection.label || (collection.kind==='BUTTONS'?'按钮集合':'字段集合'),description:collection.pointer,collection}))];
    const chosen=await vscode.window.showQuickPick(choices,{title:'PAGE 代码与字段集合'});
    if(chosen?.collection) return api.openFragment({workspaceKey:key,sourceType:'page',sourcePath:p,sourceId:result.sourceId,jsonPointer:chosen.collection.pointer,fragmentType:'fields',documentName:chosen.collection.label});
    if(chosen?.node) return open(key,{sourceType:'page',path:p,jsonPointer:chosen.node.pointer});
  }
  async function copyProcedure(value,qualified) {
    const {key,path:p,result}=await selectedObject(value);const context=await run(key,'context',{path:p,limit:1});
    const source=context.source;if(source?.sourceHash!==result.sourceHash) throw new Error('索引与源码不一致，请先重建索引');
    if(source.sourceType!=='procedure' || !source.funId || (qualified && !source.alias)) throw new Error('请选择身份明确的过程函数');
    await vscode.env.clipboard.writeText(qualified ? `${source.alias}.${source.funId}` : source.funId);
    return vscode.window.showInformationMessage('过程函数名称已复制');
  }
  async function showCallers(value) {
    const {key,path:p,result}=await selectedObject(value);const contextResult=await run(key,'context',{path:p,limit:100});
    const source=contextResult.source;if(source?.sourceHash!==result.sourceHash) throw new Error('索引与源码不一致，请先重建索引');
    const values=await allPages(run,key,'callers',{alias:source.alias,funId:source.funId},'callers');
    const chosen=await vscode.window.showQuickPick(values.items.map(item=>({label:sourceLabel(item) || item.path,description:`${item.path}:${item.line}`,item})),{title:`调用方${values.truncated?' · 部分索引待恢复':''}`});
    if(chosen) return open(key,chosen.item);
  }
  async function showReferences(value) {
    const {key,path:p,result}=await selectedObject(value);
    const contextResult=await run(key,'context',{path:p,limit:1});
    const source=contextResult.source;
    if(source?.sourceHash!==result.sourceHash) throw new Error('索引与源码不一致，请先重建索引');
    if(!['page','procedure'].includes(source.sourceType)) throw new Error('请选择页面或过程函数');
    const values=await allPages(run,key,'callers',{path:p},'callers');
    const chosen=await vscode.window.showQuickPick(values.items.map(item=>({label:sourceLabel(item) || item.path,description:`${item.path}:${item.line || 1}`,item})),{title:`静态索引引用（不保证包含运行时动态调用）${values.truncated?' · 索引不完整':''}`,placeHolder:'未列出的动态调用无法由静态索引确认'});
    if(chosen) return open(key,chosen.item);
  }
  async function setProcedureLayout(layout) {
    const config=vscode.workspace.getConfiguration('gushenCompletion');
    const target=config.inspect?.('procedureTreeLayout')?.workspaceValue!==undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update('procedureTreeLayout',layout,target);
    ui.invalidate();ui.refresh();
  }
  async function showContext(value) {
    const {key,path:p}=await selectedObject(value);const result=await apiContext({run,workspaceKey:key,identity:{path:p},includeImpact:true});
    return vscode.window.showTextDocument(await vscode.workspace.openTextDocument({language:'markdown',content:result.markdown}),{preview:true});
  }
  async function browseImpact(value) {
    const {key,path:p,result}=await selectedObject(value);
    const context=await run(key,'context',{path:p,limit:100});if(context.source?.sourceHash!==result.sourceHash) throw new Error('索引与源码不一致，请先重建索引');
    const facts=await allPages(run,key,'facts',{path:p,keyword:''},'facts');
    const chosen=await vscode.window.showQuickPick(facts.items.map(item=>({label:`${item.operation || item.kind} · ${item.subject || ''}`,description:`${item.jsonPointer || p}:${item.line || 1}`,detail:item.evidence,item})),{title:`源码影响证据${facts.truncated?' · 索引不完整':''}`});
    if(chosen) return open(key,chosen.item);
  }
  async function fields(value) {
    const {key,path:p}=await selectedObject(value);const query=await vscode.window.showInputBox({title:'搜索当前项目的页面字段'});if(!query) return;
    const found=await allPages(run,key,'facts',{keyword:query},'facts');
    const chosen=await vscode.window.showQuickPick(found.items.filter(x=>x.kind==='field').map(item=>({label:item.subject,description:item.path,detail:item.evidence,item})),{title:'页面字段'});
    if(chosen) return open(key,chosen.item);
  }
  async function locateActive() {
    const document=vscode.window.activeTextEditor?.document,workspace=await workspaceForDocument(document);if(!workspace || !document) throw new Error('当前编辑器不属于已登记的 API 项目');
    const state=editorState.workspaces.get(workspace.workspaceKey),p=editorState.documentPath(workspace.workspaceKey,state,document);
    if(!p) throw new Error('当前文档不属于 API 源码');return ui.revealSource(workspace.workspaceKey,p);
  }
  async function inheritanceDefinition(document) {
    const workspace=await workspaceForDocument(document);if(!workspace)return;
    const key=workspace.workspaceKey,state=editorState.workspaces.get(key);
    const id=document.uri.scheme===SCHEME ? decodeIdentity(document.uri) : {sourcePath:editorState.documentPath(key,state,document),jsonPointer:''};
    const source=await run(key,'read',{path:id.sourcePath});
    const parent=await readInheritance({run,workspaceKey:key,path:id.sourcePath,jsonPointer:id.jsonPointer,expectedHash:source.sourceHash});
    if(!parent.parentPath) {await vscode.window.showInformationMessage('未找到可定位的产品层源码，请查看继承源码诊断');return;}
    const original=await run(key,'read',{path:parent.parentPath});
    if(!original.readonly || original.sourceHash!==parent.parentHash) throw new Error('产品层源码已变化或未确认为只读，请重新同步');
    return new vscode.Location(ui.readonlyUri(key,parent.parentPath,original.content),new vscode.Position(0,0));
  }
  async function definition(document,position) {
    const content=document.getText(),offset=document.offsetAt(position);
    if(inheritCallAt(content,offset))return inheritanceDefinition(document);
    const local=localFunctionDefinitionAt(content,offset);
    if(local!=null) return new vscode.Location(document.uri,document.positionAt(local));
    const target=procedureTargetAt(content,offset),component=serviceComponentTargetAt(content,offset);if(!target && !component) return;
    const workspace=await workspaceForDocument(document);if(!workspace) return;
    const result=await allPages(run,workspace.workspaceKey,'search',{query:target?.fun || component.componentId},'hits');
    const matches=result.items.filter(x=>target ? x.sourceType==='procedure' && x.alias===target.alias && x.funId===target.fun : x.sourceType==='page' && x.sourceId===component.componentId);
    const unique=[...new Map(matches.map(x=>[x.path,x])).values()];const state=await ui.status(workspace.workspaceKey);
    return Promise.all(unique.map(async x=>new vscode.Location(api.sourceUri ? await api.sourceUri(workspace.workspaceKey,x.path) : vscode.Uri.file(filePath(state.checkoutPath,x.path)),new vscode.Position(0,0))));
  }
  async function fileAction(value,action) {
    const {key,path:sourcePath}=await selectedObject(value);
    const workspace=await ui.ensureWorkspace(key),absolute=filePath(workspace.checkoutPath,sourcePath);
    if(action==='reveal')return vscode.commands.executeCommand('revealFileInOS',vscode.Uri.file(absolute));
    await vscode.env.clipboard.writeText(action==='name' ? path.basename(absolute) : action==='absolute' ? absolute : sourcePath);
  }
  const commands={
    filterApiSources:async value=>{const workspace=await selectWorkspace(typeof value==='string'?value:value?.key || '');if(!workspace)return;const text=await vscode.window.showInputBox({title:'过滤当前源码树',prompt:'按名称、编码或相对路径过滤；留空清除，不改变拉取或上传范围',value:ui.filters.get(workspace.workspaceKey)||''});if(text!==undefined)ui.setFilter(workspace.workspaceKey,text);},
    clearApiSourceFilter:async value=>{const workspace=await selectWorkspace(typeof value==='string'?value:value?.key || '');if(workspace)ui.setFilter(workspace.workspaceKey,'');},
    copyApiFileName:value=>fileAction(value,'name'),copyApiAbsolutePath:value=>fileAction(value,'absolute'),copyApiRelativePath:value=>fileAction(value,'relative'),revealApiFileInOS:value=>fileAction(value,'reveal'),
    searchWorkspace:search,searchCurrentApiWorkspace:()=>search(),quickOpenApiSource:search,
    locateApiPageById:locatePage,locateApiProcedureByName:locateProcedure,showApiPageNodes:showNodes,showApiProcedureCallers:showCallers,showApiReferences:showReferences,showApiProcedureTree:()=>setProcedureLayout('tree'),showApiProcedureFlat:()=>setProcedureLayout('flat'),copyApiProcedureName:value=>copyProcedure(value,false),copyApiQualifiedProcedureName:value=>copyProcedure(value,true),
    showApiImpact:showContext,browseApiImpactEvidence:browseImpact,searchApiPageFields:fields,locateActiveApiSource:locateActive,
    focusApiSource:()=>vscode.commands.executeCommand('gushenCompletion.sourceView.focus'),
    expandApiSelectedSource:()=>sourceTreeAction(vscode,ui.treeView,'list.expand'),
    collapseApiSelectedSource:()=>sourceTreeAction(vscode,ui.treeView,'list.collapseAllToFocus'),
    collapseAllSourceNodes:()=>ui.treeView?.collapseAll?.(),
    refreshAllApiSources:async()=>{const workspace=await selectWorkspace('');if(workspace) return ui.updateScm(workspace.workspaceKey);},
    retryApiIndexFailures:async value=>{const workspace=await selectWorkspace(typeof value==='string'?value:value?.guthonWorkspaceKey || '');if(!workspace)return;const result=await api.retryIndex(workspace.workspaceKey);ui.refresh();return vscode.window.showInformationMessage(result.attempted ? `已更新 ${result.attempted} 个待处理源码文件` : '没有待更新的源码文件');},
    reindexCalls:async value=>{const workspace=await selectWorkspace(typeof value==='string'?value:value?.guthonWorkspaceKey || '');if(!workspace)return;if(workspace.sourceMode && workspace.sourceMode!=='api' && legacyAction)return legacyAction(workspace,'reindex');const result=await run(workspace.workspaceKey,'index',{});ui.setIndexResult(workspace.workspaceKey,result);if(result.complete===true) await api.markIndexed(workspace.workspaceKey,result.indexGeneration);return vscode.window.showInformationMessage(`索引已更新：${result.objects ?? result.updatedPaths?.length ?? 0} 个对象${result.complete===false?'，存在待处理项':''}`);},
    showApiInheritance:async value=>{
      const {key,path:p,result:source}=await selectedObject(value);const target=value.target || value;
      if(String(source.metadata?.isInhert)==='0' && !/@?inherit\s*\(/.test(source.content)) return vscode.window.showInformationMessage('无继承源码');
      const pointer=await inheritancePointer(key,p,source,target.jsonPointer || '');if(pointer===undefined) return;
      const result=await readInheritance({run,workspaceKey:key,path:p,jsonPointer:pointer,expectedHash:source.sourceHash});
      if(result.status==='INACTIVE' && !result.parentPath && !result.parentPointer) return vscode.window.showInformationMessage('无继承源码');
      const body=result.effective || '',fence='`'.repeat(Math.max(3,...(body.match(/`+/g) || []).map(x=>x.length+1)));
      const doc=await vscode.workspace.openTextDocument({language:'markdown',content:`# 继承源码\n\n状态：${result.status}\n\n来源哈希：${result.sourceHash}\n\n父层：${result.parentPath || result.parentPointer || '未提供'}\n\n父层哈希：${result.parentHash || result.sourceHash}\n\n${fence}\n${body}\n${fence}\n`});
      return vscode.window.showTextDocument(doc,{preview:true});
    },
    copyApiLocatorLink:async value=>{const {key,path:p}=await selectedObject(value);await vscode.env.clipboard.writeText(sourceLink(key,p));return vscode.window.showInformationMessage('源码定位链接已复制');},
    copyApiAiContext:async value=>{const {key,path:p}=await selectedObject(value);const result=await apiContext({run,workspaceKey:key,identity:{path:p}});await vscode.env.clipboard.writeText(result.markdown);return vscode.window.showInformationMessage('源码上下文已复制');},
    exportAiContext:async value=>{if(!value?.object && !value?.target) return search(value,true);const {key,path:p}=await selectedObject(value);const workspace=await selectWorkspace(key);if(!workspace)return;const target=value.target || value.object;return saveContext(workspace,{...target,path:p,sourcePath:p});},
    openApiSourceInBrowser:async value=>{const {key,path:p,result}=await selectedObject(value);const source=await run(key,'context',{path:p,limit:1});if(source.source.sourceHash!==result.sourceHash) throw new Error('索引与源码不一致');const info=source.source;return navigateInBrowser({vscode,bridge,tool:getTool(),identity:{workspaceKey:key,sourceType:info.sourceType,sourceId:info.sourceId,sourceAliasId:info.alias,funId:info.funId}});},
  };
  const execute=name=>async(...args)=>{try{return await commands[name](...args);}catch(error){return vscode.window.showErrorMessage(`API 源码：${error.message}`);}};
  const registrations=[
    vscode.commands.registerCommand('gushenCompletion.openApiParentSource',async uri=>{
      const document=await vscode.workspace.openTextDocument(uri),location=await inheritanceDefinition(document);
      if(location)return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(location.uri),{preview:true});
    }),
    vscode.commands.registerCommand('gushenCompletion.generateMcpConfiguration',()=>require('./mcp-configuration').generateConfiguration({vscode,getTool,selectWorkspace}).catch(error=>vscode.window.showErrorMessage(error.message))),
    ...['filterApiSources','clearApiSourceFilter','copyApiFileName','copyApiAbsolutePath','copyApiRelativePath','revealApiFileInOS'].map(name=>vscode.commands.registerCommand(`gushenCompletion.${name}`,execute(name))),
    vscode.commands.registerCommand('gushenCompletion.searchWorkspace',execute('searchWorkspace')),
    vscode.commands.registerCommand('gushenCompletion.searchCurrentApiWorkspace',execute('searchCurrentApiWorkspace')),
    vscode.commands.registerCommand('gushenCompletion.quickOpenApiSource',execute('quickOpenApiSource')),
    vscode.commands.registerCommand('gushenCompletion.locateApiPageById',execute('locateApiPageById')),
    vscode.commands.registerCommand('gushenCompletion.locateApiProcedureByName',execute('locateApiProcedureByName')),
    vscode.commands.registerCommand('gushenCompletion.showApiPageNodes',execute('showApiPageNodes')),
    vscode.commands.registerCommand('gushenCompletion.showApiProcedureCallers',execute('showApiProcedureCallers')),
    vscode.commands.registerCommand('gushenCompletion.showApiReferences',execute('showApiReferences')),
    vscode.commands.registerCommand('gushenCompletion.showApiProcedureTree',execute('showApiProcedureTree')),
    vscode.commands.registerCommand('gushenCompletion.showApiProcedureFlat',execute('showApiProcedureFlat')),
    vscode.commands.registerCommand('gushenCompletion.copyApiProcedureName',execute('copyApiProcedureName')),
    vscode.commands.registerCommand('gushenCompletion.copyApiQualifiedProcedureName',execute('copyApiQualifiedProcedureName')),
    vscode.commands.registerCommand('gushenCompletion.showApiImpact',execute('showApiImpact')),
    vscode.commands.registerCommand('gushenCompletion.browseApiImpactEvidence',execute('browseApiImpactEvidence')),
    vscode.commands.registerCommand('gushenCompletion.searchApiPageFields',execute('searchApiPageFields')),
    vscode.commands.registerCommand('gushenCompletion.locateActiveApiSource',execute('locateActiveApiSource')),
    vscode.commands.registerCommand('gushenCompletion.focusApiSource',execute('focusApiSource')),
    vscode.commands.registerCommand('gushenCompletion.expandApiSelectedSource',execute('expandApiSelectedSource')),
    vscode.commands.registerCommand('gushenCompletion.collapseApiSelectedSource',execute('collapseApiSelectedSource')),
    vscode.commands.registerCommand('gushenCompletion.collapseAllSourceNodes',execute('collapseAllSourceNodes')),
    vscode.commands.registerCommand('gushenCompletion.refreshAllApiSources',execute('refreshAllApiSources')),
    vscode.commands.registerCommand('gushenCompletion.reindexCalls',execute('reindexCalls')),
    vscode.commands.registerCommand('gushenCompletion.retryApiIndexFailures',execute('retryApiIndexFailures')),
    vscode.commands.registerCommand('gushenCompletion.showApiInheritance',execute('showApiInheritance')),
    vscode.commands.registerCommand('gushenCompletion.copyApiLocatorLink',execute('copyApiLocatorLink')),
    vscode.commands.registerCommand('gushenCompletion.copyApiAiContext',execute('copyApiAiContext')),
    vscode.commands.registerCommand('gushenCompletion.exportAiContext',execute('exportAiContext')),
    vscode.commands.registerCommand('gushenCompletion.openApiSourceInBrowser',execute('openApiSourceInBrowser')),
  ];
  if(vscode.window.registerUriHandler) registrations.push(vscode.window.registerUriHandler({handleUri:async uri=>{
    try {const value=parseSourceLink(uri);if(value.type==='open-source'){const workspace=await selectWorkspace(value.workspaceKey);if(workspace)return open(workspace.workspaceKey,{path:value.path});}
      else if(value.type==='locate-page') return locatePage(value.workspaceKey,value.pageId);
      else return locateProcedure(value.workspaceKey,value.alias,value.funId);
    } catch(error){return vscode.window.showErrorMessage(`源码定位失败：${error.message}`);}
  }}));
  const assistance=registerEditorAssistance(vscode,{
    matchesDocument:doc=>doc.uri.scheme===SCHEME || (doc.uri.scheme==='file' && [...editorState.workspaces].some(([key,state])=>editorState.documentPath(key,state,doc))),
    procedureCandidates:async(doc,target)=>{const workspace=await workspaceForDocument(doc);if(!workspace)return {sources:[]};const found=await allPages(run,workspace.workspaceKey,'search',{query:target.keyword},'hits');return {truncated:found.truncated,sources:found.items.map(x=>({...x,sourceAliasId:x.alias,sourceName:x.name,status:'OK'}))};},
    pageFieldCandidates:async(doc,prefix)=>{const workspace=await workspaceForDocument(doc);if(!workspace)return {fields:[]};const found=await allPages(run,workspace.workspaceKey,'facts',{keyword:prefix},'facts');return {truncated:found.truncated,fields:found.items.filter(x=>x.kind==='field').map(x=>({fieldId:x.subject,label:x.evidence,collectionPointer:x.jsonPointer}))};},
  });
  context.subscriptions.push(...registrations,assistance);
  function hover(document,position) {
    const source=document.getText(),offset=document.offsetAt(position);
    const info=localFunctionAt(source,offset);
    if(!info && !inheritCallAt(source,offset))return;
    const content=new vscode.MarkdownString();
    content.appendCodeblock(info ? info.signature : '@inherit()','guthon-gss');
    content.appendText(info ? info.comment : '调用产品层源码；Ctrl/Cmd 点击打开对应的只读产品文件');
    return new vscode.Hover(content);
  }
  if(vscode.languages.registerCodeLensProvider)registrations.push(vscode.languages.registerCodeLensProvider(
    [{scheme:SCHEME,language:'guthon-gss'}],{provideCodeLenses:document=>{
      const inherited=api.inheritedRange?.(document);if(!inherited)return [];
      const position=document.positionAt(inherited.start);
      return [new vscode.CodeLens(new vscode.Range(position,position),{title:'打开只读产品源码',command:'gushenCompletion.openApiParentSource',arguments:[document.uri]})];
    }}));
  if(vscode.languages.registerHoverProvider)registrations.push(vscode.languages.registerHoverProvider(
    ['guthon-gss','java'].flatMap(language=>['file',SCHEME].map(scheme=>({scheme,language}))),{provideHover:hover}));
  return {definition,hover,workspaceForDocument,search,dispose(){for(const item of registrations)item.dispose();assistance.dispose();}};
}
module.exports={allPages,findExactCandidates,sourceLink,parseSourceLink,sourceTreeAction,createApiNavigation};

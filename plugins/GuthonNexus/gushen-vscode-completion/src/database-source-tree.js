const path=require('node:path');
const {MODULE_STYLES,SOURCE_CATEGORIES,sourceTreeIcon,sourceTreeIdentity,datasourceTreeName,sourceGroupDatasourceId,compareDatasourceIds}=require('./source/tree-styles');
const {filterChildren}=require('./api/tree-filter');
const {showWorkspaceSearch}=require('./workspace-search');

function label(record) {
  const id=record.funId || record.sourceId;
  return record.name || id;
}

function isServiceComponent(record) {
    return record?.sourceType === 'page' && String(record.pageType) === '0';
}

function buildTree(records, category, byName, changes) {
  const directories=new Map();
  category.children=[];
  for(const record of records) {
    let parent=category;
    for(const [depth,segment] of (record.groups || []).entries()) {
      const id=JSON.stringify([category.sourceType,record.groups.slice(0,depth+1)]);
      if(!directories.has(id)) {
        const order=category.sourceType==='page' && depth>0 ? /^(\d{3,})_(.+)$/.exec(segment) : undefined;
        const byDatasource=depth===0 && ['procedure','table','view','bill-type'].includes(category.sourceType);
        const scope=byDatasource ? /^(\d{4})_(.+)$/.exec(segment) : undefined;
        const display=scope?.[2] || order?.[2] || segment;
        const code=depth===0?(record.scopeCode || scope?.[1]):undefined;
        const datasourceOrderId=depth===0 && !byName
          ? sourceGroupDatasourceId(category.navigationGroups,SOURCE_CATEGORIES[category.sourceType],code,display) : undefined;
        const folder={...category,id,kind:'legacy-database-folder',label:byDatasource?datasourceTreeName(display):display,
          groups:record.groups.slice(0,depth+1),
          code,datasourceOrderId,sortKey:code || segment,children:[],parent,modified:false,conflict:false};
        directories.set(id,folder);
        parent.children.push(folder);
      }
      parent=directories.get(id);
    }
    const change = changes.get(record.sourcePath);
    const node={kind:'legacy-database-object',label:label(record),record,parent,workspace:category.workspace,
      sortKey:record.funId || record.sourceId,modified:!!change,conflict:change?.needsMerge,needsReview:change?.needsReview,
      object:{name:record.name,sourceId:record.sourceId,funId:record.funId,path:record.sourcePath}};
    if(node.modified) {
        for(let folder=parent;folder && folder!==category;folder=folder.parent) {
            folder.modified=true;
            folder.conflict ||= node.conflict;
        }
    }
    parent.children.push(node);
  }
  for(const node of [category,...directories.values()]) {
    node.children.sort((a,b)=>Number(!!b.children)-Number(!!a.children)
      || compareDatasourceIds(a.datasourceOrderId,b.datasourceOrderId)
      || Number(isServiceComponent(a.record))-Number(isServiceComponent(b.record))
      || (byName ? a.label.localeCompare(b.label,'zh-CN') : 0)
      || a.sortKey.localeCompare(b.sortKey,'zh-CN',{numeric:true})
      || a.label.localeCompare(b.label,'zh-CN',{numeric:true}));
  }
  return category.children;
}

function createDatabaseSourceTree({vscode,run,sourceTree,getWorkspaces,getSelected,getTool,edit,openCopy,compareSource}) {
  const catalog=new Map();
  const changes=new Map();
  const query=(workspace,...args)=>run(workspace,'legacy-source',args);
  function loadChanges(workspace) {
    const key=JSON.stringify([getTool()?.toolHome,workspace.workspaceKey,workspace.root]);
    if(!changes.has(key)) changes.set(key,query(workspace,'local-changes').then(result=>({items:result.items || []}),
      error=>({items:[],diagnostic:`DATABASE 本地改动读取失败：${error.message}`})));
    return changes.get(key);
  }
  const identityArgs=record=>record.exportKey ? ['--export-key',record.exportKey]
    : ['--record-id',String(record.recordId),'--source-id='+record.sourceId];
  async function children(workspace,item,filter='') {
    if (!workspace.index?.ready) return [{kind:'message',label:'本地索引尚未建立，请先更新源码'}];
    if(!item) {
      const [result,local]=await Promise.all([query(workspace,'catalog'),loadChanges(workspace)]);
      const populated=new Set(result.categories);
      const modifiedTypes=new Set(local.items.map(entry=>entry.sourceType));
      const conflictTypes=new Set(local.items.filter(entry=>entry.needsMerge).map(entry=>entry.sourceType));
      const categories=Object.keys(MODULE_STYLES).map(key=>Object.keys(SOURCE_CATEGORIES)
        .find(type=>SOURCE_CATEGORIES[type]===key && populated.has(type))).filter(Boolean).map(sourceType=>({sourceType,kind:'legacy-database-category',workspace,
        label:MODULE_STYLES[SOURCE_CATEGORIES[sourceType]].label,navigationGroups:result.navigationGroups,
        modified:modifiedTypes.has(sourceType),conflict:conflictTypes.has(sourceType)}));
      if(filter) await Promise.all(categories.map(category=>load(workspace,category)));
      return [...filterChildren(categories,filter),...(local.diagnostic ? [{kind:'message',label:local.diagnostic}] : []),...(result.exportIndexReady ? [] : [{
        kind:'message',key:workspace.workspaceKey,label:'重建本地索引以显示表、视图、系统脚本和单据类型',
        command:'gushenCompletion.reindexCalls',
      }])];
    }
    if(item.kind==='legacy-database-category') return filterChildren(await load(workspace,item),filter,item);
    if(item.children) return filterChildren(item.children,filter,item);
    if(item.kind!=='legacy-database-object' || item.record.sourceType!=='page') return [];
    const result=await query(workspace,'fragments',...identityArgs(item.record));
    const modified=new Set(result.modifiedPointers);
    const raw={...item,kind:'legacy-database-preview',label:'查看原始 JSON',parent:item,modified:false,conflict:false,needsReview:false};
    return [raw,...result.fragments.map(fragment=>({...raw,...fragment,kind:'legacy-database-fragment',modified:modified.has(fragment.pointer)})),
      ...(result.diagnostic ? [{kind:'message',label:result.diagnostic}] : [])];
  }
  async function load(workspace,item) {
    const cacheKey=JSON.stringify([getTool()?.toolHome,workspace.workspaceKey,workspace.index?.generation,item.sourceType]);
    if(!catalog.has(cacheKey)) {
      const pending=(async()=>{
        const records=[];
        let after=0;
        do {
          const page=await query(workspace,'catalog','--type',item.sourceType,'--after',String(after),'--limit','500');
          records.push(...page.items);
          after=page.next;
        } while(after);
        return records;
      })();
      catalog.set(cacheKey,pending);
      pending.catch(()=>{if(catalog.get(cacheKey)===pending)catalog.delete(cacheKey);});
    }
    const [records,local]=await Promise.all([catalog.get(cacheKey),loadChanges(workspace)]);
    const modified=new Map(local.items.filter(entry=>entry.sourceType===item.sourceType).map(entry=>[entry.sourcePath,entry]));
    return buildTree(records,item,vscode.workspace.getConfiguration?.('gushenCompletion')?.get('sourceTreeOrder')==='name',modified);
  }
  function treeItem(item) {
    const {sourceType}=item.record || item;
    const category=SOURCE_CATEGORIES[sourceType] || 'public';
    const branch=['legacy-database-category','legacy-database-folder'].includes(item.kind)
      || item.kind==='legacy-database-object' && sourceType==='page';
    const display=sourceTreeIdentity(item.label,item.kind==='legacy-database-object'?item.record.funId || item.record.sourceId:item.code,item.label);
    const node=new vscode.TreeItem(display.label,branch?vscode.TreeItemCollapsibleState.Collapsed:vscode.TreeItemCollapsibleState.None);
    if(display.code)node.guthonCode=display.code;
    node.contextValue='guthonDatabaseSource';
    const serviceComponent=item.kind==='legacy-database-object' && isServiceComponent(item.record);
    const icon=serviceComponent?'symbol-event'
      : item.kind==='legacy-database-folder'?'folder'
      : item.kind==='legacy-database-preview'?'json'
      : item.kind==='legacy-database-fragment'?({json:'symbol-field',sql:'database'}[item.language] || 'code'):undefined;
    node.iconPath=sourceTreeIcon(vscode,category,icon);
    if(item.modified) {
      // The source Webview renders the icon and description fields.
      const color = item.conflict ? 'gitDecoration.conflictingResourceForeground' : 'gitDecoration.modifiedResourceForeground';
      node.iconPath=new vscode.ThemeIcon(node.iconPath.id,new vscode.ThemeColor(color));
    }
    node.description=[item.conflict?'C · 本地和谷神均有改动':item.needsReview?'待核对 · 基线未知':item.modified?'M · 本地修改':'',
      item.inherited?'继承 · 只读':''].filter(Boolean).join(' · ') || undefined;
    const record=item.record;
    node.id=JSON.stringify([item.kind,item.id,item.workspace.workspaceKey,sourceType,record?.sourcePath,item.pointer,record?.exportKey]);
    if(record) {
      node.tooltip=[record.sourcePath,item.pointer].filter(Boolean).join('\n');
      if(!branch || item.kind==='legacy-database-object')node.command={command:'gushenCompletion.openLegacyDocument',title:'打开本地源码',arguments:[item]};
      if(item.kind==='legacy-database-object' && item.workspace.capabilities?.['workcopy.open']) {
        if(sourceType==='page')node.contextValue='guthonDatabaseWorkcopySource';
        if(sourceType==='procedure')node.contextValue='guthonDatabaseProcedure';
      }
    }
    return node;
  }
  async function current(item, requireCurrent=true) {
    const workspace=requireCurrent ? await getSelected()
      : (await getWorkspaces()).find(value=>value.workspaceKey===item.workspace?.workspaceKey);
    if(workspace?.sourceMode!=='database' || workspace.workspaceKey!==item.workspace?.workspaceKey || workspace.root!==item.workspace?.root)
      throw new Error('当前项目已切换，请重新选择源码');
    return workspace;
  }
  async function open(item, requireCurrent=true) {
    const workspace=await current(item,requireCurrent);
    if(workspace.capabilities?.['workcopy.open'] && !item.record.exportKey && item.kind!=='legacy-database-preview'
      && (item.record.sourceType==='procedure' || item.record.sourceType==='page' && (item.kind==='legacy-database-object' || item.pointer))) {
      return edit(workspace,item);
    }
    const home=getTool()?.toolHome;
    const result=await query(workspace,'read',...identityArgs(item.record),...(item.pointer?['--pointer='+item.pointer]:[]));
    if(home!==getTool()?.toolHome)throw new Error('本地数据目录已切换，请重新打开源码');
    await current(item,requireCurrent);
    if(result.truncated)vscode.window.showInformationMessage('本地源码预览已截断');
    const params=result.procedureSignature?.parameters;
    const title=params ? `${item.record.funId}(${params.join(', ')})` : item.label || label(item.record);
    const extension=({json:'json',sql:'sql',javascript:'js','guthon-gss':'gss'})[result.language] || 'txt';
    const filename=(title || '源码').replace(/[\\/:*?"<>|]/g,'_')+'.'+extension;
    const source=item.record.sourcePath || item.record.sourceId;
    const previewPath=`database/${source}/${encodeURIComponent(item.pointer || '')}/${filename}`;
    return sourceTree.openReadonly(workspace.workspaceKey,previewPath,result.content,item.line);
  }
  async function search(workspace) {
    const chosen=await showWorkspaceSearch({vscode,sourceOnly:true,sourceMode:'database',title:`搜索当前项目 · ${workspace.displayName}`,
      search:async (text,_offset,sourceType)=>{
        const args=['search','--keyword='+text];
        if(sourceType) args.push('--type',sourceType);
        const result=await query(workspace,...args);
        return {...result,items:result.items.map(record=>({kind:'source',label:label(record),
          description:[record.sourceLayer==='workcopy'?'Workcopy':'',record.pointer || record.sourcePath].filter(Boolean).join(' · '),detail:record.excerpt,record}))};
      }});
    if(chosen) {
      const record=chosen.item.record;
      if(record.sourceLayer==='workcopy' && record.workcopyPath) {
        await current({workspace});
        const file=path.resolve(workspace.workcopyDir,record.workcopyPath);
        const relative=path.relative(workspace.workcopyDir,file);
        if(!relative || relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative))
          throw new Error('工作副本路径不属于当前项目');
        const document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        return vscode.window.showTextDocument(document);
      }
      const kind=record.pointer?'legacy-database-fragment':'legacy-database-object';
      return open({...record,workspace,record,kind});
    }
  }
  async function callers(item) {
    const workspace=await current(item);
    const result=await query(workspace,'callers','--locations','--alias='+item.record.alias,'--fun-id='+item.record.funId);
    if(!result.callers.length)return vscode.window.showInformationMessage('当前同步范围内没有已索引的静态调用');
    const chosen=await vscode.window.showQuickPick(result.callers.map(record=>({label:label(record),
      description:[record.pointer || record.sourcePath,record.line].filter(Boolean).join(' · '),record})),
    {title:`${item.record.funId} · 调用方`});
    if(chosen)return open({...chosen.record,record:chosen.record,workspace});
  }
  async function workcopy(item,diff=false) {
    const workspace=await current(item);
    if(!workspace.capabilities?.['workcopy.open'])throw new Error('当前项目没有 DATABASE Workcopy 能力');
    const record=item.record;
    if(diff) return compareSource(workspace,item,true);
    await run(workspace,'create-workcopy',['--type',record.sourceType,'--source-id='+record.sourceId,
      ...(record.funId?['--fun='+record.funId]:[]),'--json']);
    return openCopy(workspace,item);
  }
  function syncTarget(workspace,item) {
    if(item.workspace?.workspaceKey!==workspace.workspaceKey || item.workspace.root!==workspace.root)
      throw new Error('请重新选择当前项目源码节点');
    return item.record ? {sourceType:item.record.sourceType,recordId:item.record.recordId,exportKey:item.record.exportKey}
      : {sourceType:item.sourceType,groups:item.groups || []};
  }
  return {children,treeItem,open,search,callers,workcopy,syncTarget,
    refreshChanges:()=>changes.clear(),refresh(){catalog.clear();changes.clear();}};
}

module.exports={createDatabaseSourceTree};

const path = require('node:path');
const crypto = require('node:crypto');
const {isInlineInherited,scriptType}=require('../source/virtual-fs');
const {sourcePathAllowed}=require('./source-watcher');
const {selectUploadFiles}=require('./upload-review');
const {filterChildren}=require('./tree-filter');

const MODULE_STYLES={
  pages:{icon:'layout',color:'charts.blue'},
  procedures:{icon:'symbol-method',color:'charts.purple'},
  tables:{icon:'table',color:'charts.green'},
  views:{icon:'symbol-structure',color:'charts.yellow'},
  'system-script':{icon:'code',color:'charts.orange'},
  'module-parameters':{icon:'settings-gear',color:'charts.purple'},
  'bill-type':{icon:'symbol-enum',color:'charts.yellow'},
  dropdown:{icon:'list-selection',color:'charts.orange'},
  skills:{icon:'book',color:'charts.blue'},
};
const SOURCE_CATEGORIES={page:'pages',procedure:'procedures',table:'tables',view:'views',
  'system-script':'system-script','module-parameter':'module-parameters','bill-type':'bill-type',dropdown:'dropdown',skill:'skills'};

function filePath(root, sourcePath) {
  if (typeof sourcePath !== 'string' || !sourcePath || sourcePath.includes('\\') || sourcePath.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('无效的源码路径');
  const result = path.resolve(root, sourcePath);
  const relative = path.relative(path.resolve(root), result);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('源码路径不属于当前 checkout');
  return result;
}
function dirtyDocuments(vscode, root, paths) {
  const selected = paths && new Set(paths.map(p => filePath(root, p)));
  return vscode.workspace.textDocuments.filter(doc => {
    if (!doc.isDirty || doc.uri.scheme !== 'file') return false;
    const absolute = path.resolve(doc.uri.fsPath), relative = path.relative(path.resolve(root), absolute);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && (!selected || selected.has(absolute));
  });
}
function assertClean(vscode, root, paths) {
  if (dirtyDocuments(vscode, root, paths).length) throw new Error('目标源码有未保存文档，请先保存或关闭后重试');
}
function identity(value, sourcePath) {
  if (typeof value === 'string') return {key:value, path:sourcePath};
  if (value?.target?.workspaceKey && value.target.sourcePath) return {key:value.target.workspaceKey,path:value.target.sourcePath};
  if (value?.key) return {key:value.key,path:value.object?.path || sourcePath};
  if (value?.workspaceKey || value?.guthonWorkspaceKey) return {key:value.workspaceKey || value.guthonWorkspaceKey, path:value.path};
  const uri = value?.resourceUri || value;
  if (uri?.scheme === 'guthon-api-change') {
    const query = new URLSearchParams(uri.query);
    return {key:query.get('workspaceKey') || uri.authority, path:query.get('path')};
  }
  throw new Error('请选择 API 源码');
}

function sourceLabel(object,{signature=false}={}) {
  const id=object.sourceType==='procedure' ? object.funId : object.sourceId;
  const name=object.name && object.name!==object.path ? object.name : '';
  const label=[id,name && name!==id ? name : ''].filter(Boolean).join(' · ') || name;
  if(!signature || object.sourceType!=='procedure' || !id) return label;
  const declared=object.procedureSignature;
  const parameters=declared?.parameters == null ? '无' : declared.parameters.join(', ');
  const returned=declared?.returnExpressions?.length ? declared.returnExpressions.map(value=>value.replace(/\s*\r?\n\s*/g,' ')).join(' | ') : '无';
  return `${id}(${parameters})${name && name!==id ? ' '+name : ''}${declared?.hasReturn===true ? ` [return ${returned}]` : ''}`;
}

function buildCatalogTree(key, workspace, objects, project={}, options={}) {
  // platform：菜单层级按平台菜单顺序、同级对象按平台接口顺序（页面 pageId、函数 funId）；
  // name：沿用按显示名排序。
  const byPlatform=options.order!=='name';
  const systems=project.systems || [], dataSources=project.dataSources || [];
  const root={children:[],parent:workspace}, systemNames=new Map(systems.map(x=>[String(x.systemId),x.systemName])),
    sourceNames=new Map(dataSources.map(x=>[String(x.dataSourceId),x.dataSourceName])),
    systemOrder=new Map(systems.map((x,index)=>[String(x.systemId),index])),
    sourceOrder=new Map(dataSources.map((x,index)=>[String(x.dataSourceId),index])), menuPaths=new Map();
  const menus=(system,nodes,ancestors=[])=>{(nodes || []).forEach((node,index)=>{
    const branch=[...ancestors,{id:String(node.id),name:node.name || String(node.id),order:index}];
    if(Number(node.isDir)===1) menus(system,node.childs,branch);
    else (node.pages || []).forEach((page,pageIndex)=>{
      const identity=JSON.stringify([system,String(page.pageSubId),String(page.pageId)]);
      if(!menuPaths.has(identity)) menuPaths.set(identity,[]);
      menuPaths.get(identity).push({branch,pageIndex});
    });
  })};
  for(const system of project.menuTree || []) menus(String(system.systemId),system.menus);
  const labels={pages:'页面',procedures:'过程函数',tables:'表',views:'视图','system-script':'系统脚本','module-parameters':'模块参数','bill-type':'单据类型',dropdown:'下拉组件',skills:'开发参考'};
  root.childIndex=new Map();for(const [type,label] of Object.entries(labels)) {
    const child={label,key,children:[],category:type,icon:MODULE_STYLES[type].icon,sourcePrefixes:new Set(),parent:workspace};root.children.push(child);root.childIndex.set('category:'+type,child);
  }
  for(const [type,kind,entries,id] of [['pages','systems',systems,'systemId'],['system-script','systems',systems,'systemId'],['procedures','datasources',dataSources,'dataSourceId'],['tables','datasources',dataSources,'dataSourceId'],['views','datasources',dataSources,'dataSourceId']]) {
    const category=root.childIndex.get('category:'+type);
    category.refreshPrefixes=new Set(entries.map(entry=>`${kind}/${entry[id]}/${type}`));
  }
  const add=(object,dirs,platformOrder)=>{
    let parent=root;
    for(const dir of dirs) {
      parent.childIndex ||= new Map();let child=parent.childIndex.get(dir.key);
      if(!child) {child={label:dir.label,key,children:[],sourcePrefix:dir.sourcePrefix,description:dir.description,category:dir.category,dataSourceId:dir.dataSourceId,systemId:dir.systemId,order:dir.order,sortKey:dir.sortKey,parent:parent===root?workspace:parent};parent.children.push(child);parent.childIndex.set(dir.key,child);}
      child.sourcePrefixes ||= new Set();if(dir.affectedPrefix)child.sourcePrefixes.add(dir.affectedPrefix);
      child.refreshPrefixes ||= new Set();if(dir.refreshPrefix)child.refreshPrefixes.add(dir.refreshPrefix);
      parent=child;
    }
    const filename=object.path.split('/').at(-1),candidate=object.label || sourceLabel(object,{signature:true}) || filename;
    const label=typeof candidate==='string' && (candidate===object.path || candidate.endsWith('/'+filename)) ? filename : candidate;
    if(object.sourceType==='procedure' && object.path.split('/').length>4 && parent.sourcePrefix===object.path.split('/').slice(0,-1).join('/') && object.sourceId && object.dataSourceId) {
      parent.packageIdentities ||= new Map();
      parent.packageIdentities.set(JSON.stringify([object.dataSourceId,object.sourceId]),{dataSourceId:String(object.dataSourceId),procedureId:String(object.sourceId),samplePath:object.path});
    }
    parent.children.push({label,key,object,order:platformOrder,sortKey:String(object.funId || object.sourceId || filename).toLowerCase(),parent:parent===root?workspace:parent});
  };
  for(const object of objects) {
    filePath('/api-root',object.path);
    const parts=object.path.split('/');
    const referenceType=object.sourceType==='bill-type' || object.path==='otherconfig/bill-type.md' ? 'bill-type'
      : object.sourceType==='dropdown' || object.path==='otherconfig/dropdown.md' ? 'dropdown' : parts[0]==='skills' ? 'skills' : '';
    if(referenceType) {
      const dirs=[{key:'category:'+referenceType,label:labels[referenceType],category:referenceType,affectedPrefix:object.path}];
      if(referenceType==='bill-type' && object.dataSourceId) dirs.push({key:'source:'+object.dataSourceId,label:sourceNames.get(object.dataSourceId)||object.dataSourceId,dataSourceId:object.dataSourceId,category:referenceType,description:object.dataSourceId});
      if(referenceType==='skills') dirs.push(...parts.slice(1,-1).map(part=>({key:'path:'+part,label:part})));
      add({...object,label:object.referenceId ? `${object.sourceId} · ${object.name}` : object.name || parts.at(-1)},dirs);
      continue;
    }
    const category=labels[parts[2]], scoped=category && ['systems','datasources'].includes(parts[0]);
    const physical=scoped ? [
      {key:'category:'+parts[2],label:category,category:parts[2],affectedPrefix:object.path,refreshPrefix:parts.slice(0,3).join('/')},
      {key:'scope:'+parts[1],label:(parts[0]==='systems'?systemNames:sourceNames).get(parts[1]) || parts[1],description:parts[1],category:parts[2],systemId:parts[0]==='systems'?parts[1]:undefined,dataSourceId:parts[0]==='datasources'?parts[1]:undefined,sourcePrefix:parts.slice(0,3).join('/'),affectedPrefix:object.path,refreshPrefix:parts.slice(0,3).join('/'),order:(parts[0]==='systems'?systemOrder:sourceOrder).get(parts[1]),sortKey:parts[1]},
      ...(parts[2]==='procedures' && options.procedureLayout==='flat' && parts.length>4
        ? [{key:'package:'+parts.slice(3,-1).join('/'),label:parts.slice(3,-1).join('.'),sourcePrefix:parts.slice(0,-1).join('/'),affectedPrefix:object.path,refreshPrefix:parts.slice(0,-1).join('/'),sortKey:parts.slice(3,-1).join('.')}]
        : parts.slice(3,-1).map((part,i)=>({key:'path:'+part,label:part,sourcePrefix:parts.slice(0,i+4).join('/'),affectedPrefix:object.path,refreshPrefix:parts.slice(0,i+4).join('/'),sortKey:part})))
    ] : [{key:'other',label:'其他源码',affectedPrefix:object.path,sortKey:''},...parts.slice(0,-1).map((part,i)=>({key:'path:'+part,label:part,sourcePrefix:parts.slice(0,i+1).join('/'),affectedPrefix:object.path,sortKey:part}))];
    const routes=parts[0]==='systems' && parts[2]==='pages' && parts.length>=6 ? menuPaths.get(JSON.stringify([parts[1],parts[3],parts[4]])) : undefined;
    if(routes?.length) for(const route of routes) add(object,[...physical.slice(0,2),...route.branch.map(x=>({key:'menu:'+x.id,label:x.name,affectedPrefix:object.path,refreshPrefix:parts.slice(0,5).join('/'),order:x.order,sortKey:x.name}))],route.pageIndex);
    else add(object,physical);
  }
  // A menu can contain indexed and not-yet-indexed pages. Use its platform
  // identities to include their physical page directories in a scoped refresh.
  for(const [identity,routes] of menuPaths) {
    const [system,sub,page]=JSON.parse(identity),category=root.childIndex.get('category:pages');
    const scope=category.childIndex?.get('scope:'+system);
    for(const route of routes) {
      let parent=scope;
      for(const branch of route.branch) {
        parent=parent?.childIndex?.get('menu:'+branch.id);
        if(!parent) break;
        parent.refreshPrefixes.add(`systems/${system}/pages/${sub}/${page}`);
      }
    }
  }
  const categoryOrder=Object.keys(labels);
  const rank=item=>item.category ? categoryOrder.indexOf(item.category) : categoryOrder.length;
  const compare=(a,b,isRoot)=>{
    if(isRoot) return rank(a)-rank(b) || a.label.localeCompare(b.label);
    const folder=Boolean(b.children)-Boolean(a.children);
    if(folder) return folder;
    if(byPlatform) {
      const ao=Number.isInteger(a.order) ? a.order : null, bo=Number.isInteger(b.order) ? b.order : null;
      if(ao!==null && bo!==null && ao!==bo) return ao-bo;
      if((ao===null)!==(bo===null)) return ao===null ? 1 : -1;
      const ak=a.sortKey || '', bk=b.sortKey || '';
      if(ak!==bk) return ak<bk ? -1 : 1;
      const ap=a.object?.path || '', bp=b.object?.path || '';
      if(ap!==bp) return ap<bp ? -1 : 1;
    }
    const name=item=>item.object?.name && item.object.name!==item.object.path ? item.object.name : item.label;
    return name(a).localeCompare(name(b));
  };
  const sort=node=>{node.children.sort((a,b)=>compare(a,b,node===root));for(const child of node.children) if(Array.isArray(child.children)) sort(child);};
  root.children=root.children.filter(child=>!['module-parameters','bill-type','dropdown','skills'].includes(child.category)||child.children.length);
  sort(root);return root.children;
}

function sourceSyncLines(key,result) {
  const state=value=>value===true?'完成':value===false?'未完成':'未返回';
  const index=result.index || {}, diagnostics=index.diagnostics || [];
  const lines=[`工作区：${key}`,`总体结果：${state(result.complete)}`,`文件拉取与合并：${state(result.downloadComplete)}`,
    `索引结果：${state(index.complete)}`,`索引诊断数量：${index.diagnosticCount ?? '未返回'}`,
    `更新 ${result.updated?.length || 0} 个，保留 ${result.preserved?.length || 0} 个，冲突 ${result.conflicts?.length || 0} 个。`];
  if(result.conflicts?.length) lines.push('','## 文件冲突',...result.conflicts.map(x=>`- ${x.path}：${x.reason}`));
  if(index.complete===false || index.diagnosticCount) lines.push('','## 索引诊断','部分源码未完成解析，相关检索和分析可能不完整。',
    ...diagnostics.map(x=>`- ${x.path || '未知文件'}：${x.code || ''} ${x.message || ''}`),
    ...(index.truncated ? ['- 诊断列表已截断，请检查索引状态。'] : []));
  lines.push('','本次未执行上传。');return lines;
}
const UPLOAD_UNVERIFIED_STAGES=new Set(['UNKNOWN','REMOTE_REQUEST_STARTED','REMOTE_ACKNOWLEDGED','SAVE_REQUEST_STARTED','CHECKOUT_REQUEST_STARTED']);
function needsUploadVerification(item) {
  return ['upload','module-upload'].includes(item.kind) && (UPLOAD_UNVERIFIED_STAGES.has(item.stage) || (item.results || []).some(row=>UPLOAD_UNVERIFIED_STAGES.has(row.stage)) || item.kind==='module-upload' && (item.stage==='PREPARED' || (item.results || []).some(row=>row.stage==='PREPARED')));
}
async function showReport(vscode,title,lines) {
  const doc=await vscode.workspace.openTextDocument({language:'markdown',content:`# ${title}\n\n${lines.join('\n')}\n`});
  await vscode.window.showTextDocument(doc,{preview:true});
}

class ApiSourceUI {
  constructor({vscode, run, onUpdated, editorState, onSourceChanged, onWorkspace, onOpenVirtual, onOpenModule, onModuleUpload, indexRecovery, reviewUpload=selectUploadFiles}) {
    this.vscode=vscode; this.run=run; this.reviewUpload=reviewUpload; this.onUpdated=onUpdated; this.editorState=editorState; this.onSourceChanged=onSourceChanged; this.onWorkspace=onWorkspace; this.onOpenVirtual=onOpenVirtual; this.indexRecovery=indexRecovery;this.onOpenModule=onOpenModule;this.onModuleUpload=onModuleUpload; this.watchers=new Map(); this.workspaces=new Map(); this.controls=new Map();this.scmGenerations=new Map();this.sourceChanges=new Map();
    this.emitter = vscode.EventEmitter ? new vscode.EventEmitter() : undefined;
    this.onDidChangeTreeData = this.emitter?.event;
    this.filters=new Map();this.sourceNames=new Map();
    this.decorationEmitter=vscode.EventEmitter ? new vscode.EventEmitter() : undefined;
    this.onDidChangeFileDecorations=this.decorationEmitter?.event;
    this.readonlyDocuments=new Map();this.rootItems=null;this.treeCache=new Map();this.treeLoads=new Map();this.treeEpoch=new Map();this.indexGenerations=new Map();this.indexDiagnostics=new Map();this.menuAttempts=new Set();this.treeVersion=0;
    this.configurationListener=vscode.workspace?.onDidChangeConfiguration?.(event=>{
      if(event.affectsConfiguration('gushenCompletion.procedureTreeLayout')) {this.invalidate();this.refresh();}
    });
  }
  syncWorkspaces(workspaces) {
    const keys=new Set();
    let changed=false;for (const workspace of workspaces) {
      const key=typeof workspace === 'string' ? workspace : workspace.workspaceKey;
      if (!key || (workspace.sourceMode && workspace.sourceMode !== 'api')) continue;
      keys.add(key);const previous=this.workspaces.get(key),next=typeof workspace === 'string' ? (previous || {workspaceKey:key}) : workspace;
      if(!previous || previous.checkoutPath!==next.checkoutPath || previous.displayName!==next.displayName) changed=true;
      this.workspaces.set(key,next);
    }
    for (const key of this.workspaces.keys()) if (!keys.has(key)) {changed=true;this.workspaces.delete(key);this.invalidate(key);this.menuAttempts.delete(key);this.scmGenerations.set(key,(this.scmGenerations.get(key)||0)+1);this.controls.get(key)?.control.dispose();this.controls.delete(key);this.sourceChanges.delete(key);this.watchers.get(key)?.dispose();this.watchers.delete(key);}
    if(changed) {this.invalidate();this.rootItems=null;this.emitter?.fire();}
  }
  track(key) {if (!this.workspaces.has(key)) {this.workspaces.set(key,{workspaceKey:key});this.invalidate();this.rootItems=null;}}
  refresh() {this.emitter?.fire();}
  invalidate(key) {if(key){this.treeCache.delete(key);this.treeEpoch.set(key,(this.treeEpoch.get(key)||0)+1);}else for(const k of this.workspaces.keys())this.invalidate(k);this.treeVersion++;}
  getTreeItem(item) {
    const v=this.vscode;
    const isPage=item.object?.sourceType==='page' && !['native-page-minimal','unsupported'].includes(item.object.sourceFormat) && (['json','xml','native-xml'].includes(item.object.sourceFormat) || /\.(?:json|xml)$/i.test(item.object.path));
    const tree=new v.TreeItem(item.label, item.children || isPage ? v.TreeItemCollapsibleState.Collapsed : v.TreeItemCollapsibleState.None);
    if(item.kind==='message') {tree.tooltip=item.label;if(item.command) tree.command={command:item.command,title:item.label,arguments:[item.key]};return tree;}
    if(item.kind==='fragment') {
      if(v.ThemeIcon)tree.iconPath=new v.ThemeIcon(item.target.fragmentType==='fields'?'symbol-field':'code',new v.ThemeColor('charts.blue'));
      tree.contextValue=item.target.fragmentType==='fields' ? 'guthonApi.fragment.fields' : 'guthonApi.fragment.script';tree.tooltip=item.target.jsonPointer;
      tree.command={command:'gushenCompletion.openApiFragment',title:'打开源码分块',arguments:[item.target]};return tree;
    }
    tree.contextValue=item.children ? item.packageIdentities?.size===1 ? 'guthonApi.procedurePackage' : item.category ? `guthonApi.category.${item.category}` : 'guthonApi.directory' : item.object?.readonly ? 'guthonApi.readonly' : ['page','procedure','table','view'].includes(item.object?.sourceType) ? `guthonApi.${item.object.sourceType}` : 'guthonApi.source';
    if(item.children && item.category==='procedures' && item.sourcePrefix)tree.contextValue='guthonApi.procedureScope';
    if(item.object && ['bill-type','dropdown','system-script','module-parameter'].includes(item.object.sourceType))tree.contextValue='guthonApi.'+item.object.sourceType;
    tree.guthonWorkspaceKey=item.key;
    tree.description=item.description;
    let owner=item;
    while(owner && !owner.category)owner=owner.parent;
    const style=MODULE_STYLES[owner?.category || SOURCE_CATEGORIES[item.object?.sourceType]];
    if(v.ThemeIcon)tree.iconPath=new v.ThemeIcon(item.icon || (item.children?'folder':style?.icon || 'file'),style?new v.ThemeColor(style.color):undefined);
    const pageOrigin=item.object?.sourceType==='page' && item.object.sourceFormat!=='script'
      ? (item.object.pageSource==='native-editor'?(item.object.nativeState==='METADATA_ONLY'?'原生元数据 · 尚无源码版本，仅可查看':'原生编辑模型 · 原生 JSON 保存'):'原文来源待核验 · 上传前核对原生模型') : '';
    tree.tooltip=item.object ? [item.object.path,pageOrigin,item.object.diagnostic].filter(Boolean).join(' · ') : item.label;
    const changes=this.sourceChanges.get(item.key),priority={CONFLICT:3,REMOTE_DELETED:2,MISSING:2,MODIFIED:1};
    let state=changes?.get(item.object?.path || item.sourcePrefix);
    if(item.sourcePrefixes) for(const prefix of item.sourcePrefixes) {const value=changes?.get(prefix);if((priority[value]||0)>(priority[state]||0))state=value;}
    if(state) {tree.description=({CONFLICT:'冲突',REMOTE_DELETED:'远端已删除',MISSING:'本地缺失',MODIFIED:'有本地修改'})[state] || state;if(v.ThemeIcon) tree.iconPath=new v.ThemeIcon(state==='MODIFIED'?'diff-modified':'warning',new v.ThemeColor(state==='MODIFIED'?'gitDecoration.modifiedResourceForeground':state==='CONFLICT'?'editorError.foreground':'editorWarning.foreground'));}
    if(item.object) tree.command={command:isPage ? 'gushenCompletion.openApiPageEditor' : item.object.sourceType==='module-parameter'?'gushenCompletion.editModuleParameter':'gushenCompletion.openApiSource',title:isPage ? '编辑页面' : '打开源码',arguments:[{workspaceKey:item.key,path:item.object.path,lineNumber:item.object.lineNumber,...(isPage && item.object.name ? {sourceName:item.object.name} : {})}]};
    return tree;
  }
  setFilter(key,text) {
    if(text.trim())this.filters.set(key,text.trim());else this.filters.delete(key);
    if(this.treeView)this.treeView.message=text.trim() ? `过滤：${text.trim()}（仅影响显示）` : undefined;
    void this.vscode.commands?.executeCommand?.('setContext','gushenCompletion.hasSourceFilter',this.filters.size>0);
    this.refresh();
  }
  async getChildren(item) {
    const values=await this.unfilteredChildren(item);
    if(!item && this.workspaces.size>1)return values;
    return filterChildren(values,this.filters.get(item?.key || values[0]?.key) || '',item);
  }
  async unfilteredChildren(item) {
    if (!item) {const roots=this.rootItems ||= [...this.workspaces].map(([key,w])=>({label:w.displayName || key,key,workspace:true,children:true}));return roots.length===1 ? this.getChildren(roots[0]) : roots;}
    if (item.workspace) {
      if(this.treeCache.has(item.key)) return this.treeCache.get(item.key);
      const epoch=this.treeEpoch.get(item.key)||0,existing=this.treeLoads.get(item.key);
      if(existing?.epoch===epoch) return existing.promise;
      const promise=this.loadCatalog(item,epoch).finally(()=>{if(this.treeLoads.get(item.key)?.promise===promise)this.treeLoads.delete(item.key);});
      this.treeLoads.set(item.key,{epoch,promise});return promise;
    }
    if(item.object?.sourceType==='page' && !['native-page-minimal','unsupported'].includes(item.object.sourceFormat) && (['json','xml','native-xml'].includes(item.object.sourceFormat) || /\.(?:json|xml)$/i.test(item.object.path))) {
      if(item.fragments) return item.fragments;
      if(!item.fragmentPromise) item.fragmentPromise=(async()=>{
        const snapshot=await this.run(item.key,'page',{action:'open',path:item.object.path});
        if(snapshot.sourcePath!==item.object.path) throw new Error('PAGE 来源与目录不一致');
        const fragments=[...snapshot.model.nodes.map(node=>({label:node.label || node.pointer,pointer:node.pointer,type:scriptType(node)})),
          ...snapshot.model.collections.map(collection=>({label:`${collection.label || '集合'} · ${collection.kind==='BUTTONS' ? '按钮' : '字段'} JSON`,pointer:collection.pointer,type:'fields'}))];
        return item.fragments=fragments.length ? fragments.map(fragment=>({kind:'fragment',label:fragment.label,parent:item,target:{workspaceKey:item.key,sourceType:'page',sourcePath:item.object.path,
          path:item.object.path,sourceId:snapshot.sourceId,jsonPointer:fragment.pointer,fragmentType:fragment.type,documentName:fragment.label}}))
          : [{kind:'message',label:'此 PAGE 没有可编辑分块',parent:item}];
      })().finally(()=>{item.fragmentPromise=undefined;});
      return item.fragmentPromise;
    }
    return item.children || [];
  }
  async loadCatalog(item,epoch) {
      const config=this.vscode.workspace.getConfiguration?.('gushenCompletion');
      const treeOrder=config?.get?.('sourceTreeOrder','platform') || 'platform',procedureLayout=config?.get?.('procedureTreeLayout','tree') || 'tree';
      const replacement=()=>{
        if(this.disposed || !this.workspaces.has(item.key)) return [];
        if((this.treeEpoch.get(item.key)||0)===epoch) return undefined;
        const roots=this.rootItems ||= [...this.workspaces].map(([key,w])=>({label:w.displayName || key,key,workspace:true,children:true}));
        const current=roots.find(root=>root.key===item.key);
        return current ? this.getChildren(current) : [];
      };
      const objects=[];let offset=0,generation,partial=0,project;
      for(;;) {
        let result;
        try {result=await this.run(item.key,'catalog',{limit:100,offset});}
        catch(error) {const current=replacement();if(current!==undefined)return current;if(['API_INDEX_REQUIRED','API_INDEX_SCOPE_STALE'].includes(error.code)) return [{kind:'message',label:error.message,key:item.key,parent:item,command:'gushenCompletion.reindexCalls'}];throw error;}
        const current=replacement();if(current!==undefined)return current;
        if(generation && result.indexGeneration && generation!==result.indexGeneration) throw new Error('目录读取期间索引已变化，请刷新');
        generation ||= result.indexGeneration;partial=Math.max(partial,result.partialSourceCount || 0);project ||= result.project;
        objects.push(...result.objects);
        if(result.nextOffset == null) break;
        if(!Number.isInteger(result.nextOffset) || result.nextOffset<=offset) throw new Error('目录分页无效');
        offset=result.nextOffset;
      }
      const current=replacement();if(current!==undefined)return current;
      const root={children:buildCatalogTree(item.key,item,objects,project,{order:treeOrder,procedureLayout})};
      if(partial && !this.indexDiagnostics.has(item.key)) {
        const diagnostics=objects.filter(object=>object.diagnostic && object.status!=='OK').map(object=>({path:object.path,code:object.diagnostic}));
        this.indexDiagnostics.set(item.key,{complete:false,diagnosticCount:partial,diagnostics:diagnostics.slice(0,100),truncated:diagnostics.length>100});
      }
      const diagnostic=this.indexDiagnostics.get(item.key);const count=Math.max(partial,diagnostic?.diagnosticCount || 0);
      if(count || diagnostic?.complete===false) root.children.push({kind:'message',label:`索引不完整${count ? `：${count} 个诊断` : ''}，点击查看`,key:item.key,parent:item,command:diagnostic ? 'gushenCompletion.showApiIndexDiagnostics' : 'gushenCompletion.reindexCalls'});
      const recovery=this.indexRecovery?.(item.key);if(recovery?.paths.length) root.children.push({kind:'message',label:`${recovery.paths.length} 个源码文件等待索引更新，点击重试`,key:item.key,parent:item,command:'gushenCompletion.retryApiIndexFailures'});
      this.sourceNames.set(item.key,new Map(objects.map(object=>[object.path,sourceLabel(object)])));
      this.decorationEmitter?.fire();
      this.indexGenerations.set(item.key,generation);this.treeCache.set(item.key,root.children);
      if(project?.systems?.length && !Array.isArray(project.menuTree) && !this.menuAttempts.has(item.key)) {
        this.menuAttempts.add(item.key);const version=this.treeVersion;
        void this.run(item.key,'system-menu').then(result=>{
          const menu=Array.isArray(result.menu) ? result.menu : result.menu?.list;
          if(this.disposed || version!==this.treeVersion || !Array.isArray(menu)) return;
          const messages=root.children.filter(child=>child.kind==='message');
          this.treeCache.set(item.key,[...buildCatalogTree(item.key,item,objects,{...project,menuTree:menu},{order:treeOrder,procedureLayout}),...messages]);this.emitter?.fire();
        }).catch(error=>{
          if(this.disposed || version!==this.treeVersion) return;
          const items=this.treeCache.get(item.key);if(!items)return;
          items.push({kind:'message',label:`菜单加载失败：${error.message}；点击刷新重试`,key:item.key,parent:item,command:'gushenCompletion.refreshApiSourceView'});this.emitter?.fire();
        });
      }
      return root.children;
  }
  getParent(item) {return item.parent?.workspace && this.workspaces.size===1 ? undefined : item.parent;}
  async revealSource(key,sourcePath) {
    if(!this.treeView) throw new Error('源码视图不可用');
    const workspace=(this.rootItems ||= [...this.workspaces].map(([key,w])=>({label:w.displayName || key,key,workspace:true,children:true}))).find(item=>item.key===key);if(!workspace) throw new Error('当前项目未显示在源码树');
    const visit=items=>{for(const item of items) {if(item.object?.path===sourcePath)return item;if(Array.isArray(item.children)){const found=visit(item.children);if(found)return found;}}};
    const found=visit(await this.getChildren(workspace));if(!found) throw new Error(this.filters.has(key) ? '源码被当前过滤条件隐藏，请先清除过滤再定位' : '源码不在当前索引目录，请先重建索引');
    await this.treeView.reveal(found,{select:true,focus:true,expand:true});
  }
  setIndexResult(key,index) {
    const previous=this.indexDiagnostics.get(key);
    if(index && (index.complete===false || index.diagnosticCount)) this.indexDiagnostics.set(key,index);
    else if(index?.complete===true) this.indexDiagnostics.delete(key);
    const current=this.indexDiagnostics.get(key),signature=value=>JSON.stringify(value ? [value.complete,value.diagnosticCount,value.diagnostics,value.truncated] : null);
    if((index?.indexGeneration && index.indexGeneration!==this.indexGenerations.get(key)) || signature(previous)!==signature(current)) this.invalidate(key);
    this.refresh();
  }
  async showIndexDiagnostics(key) {
    const index=this.indexDiagnostics.get(key);if(!index) return this.vscode.window.showInformationMessage('当前没有本次操作保留的索引诊断，请检查或重建索引');
    await showReport(this.vscode,'API 索引诊断',sourceSyncLines(key,{index}));
  }
  async registerWorkspace(key,checkoutPath) {
    if(this.editorState && !this.editorState.workspaces.has(key)) await this.editorState.add(key,checkoutPath);
    this.onWorkspace?.(key,checkoutPath);
    if(this.editorState && !this.watchers.has(key) && this.vscode.workspace.createFileSystemWatcher && this.vscode.RelativePattern) {
        const watcher=this.vscode.workspace.createFileSystemWatcher(new this.vscode.RelativePattern(checkoutPath,'**/*'));
        const changed=uri=>{const relative=path.relative(checkoutPath,uri.fsPath).split(path.sep).join('/');
          if(sourcePathAllowed(relative)) void this.onSourceChanged?.(key,[relative]);};
      watcher.onDidChange(changed);watcher.onDidCreate(changed);watcher.onDidDelete(changed);this.watchers.set(key,watcher);
    }
  }
  async status(key) {
    this.track(key); const result=await this.run(key,'status');
    if(!this.workspaces.has(key)) return result;
    const generation=result.index?.indexGeneration;
    if(this.treeCache.has(key) && ((generation && this.indexGenerations.get(key)!==generation) || result.index?.ready===false)) {this.invalidate(key);this.refresh();}
    this.workspaces.set(key,{...this.workspaces.get(key),checkoutPath:result.checkoutPath});
    await this.registerWorkspace(key,result.checkoutPath);
    return result;
  }
  async ensureWorkspace(key) {
    let checkoutPath=this.workspaces.get(key)?.checkoutPath;
    if(!checkoutPath || !path.isAbsolute(checkoutPath)) {
      const summary=await this.run(key,'status',{summaryOnly:true});checkoutPath=summary.checkoutPath;
      if(!checkoutPath || !path.isAbsolute(checkoutPath)) throw new Error('API 工作区路径无效');
      this.workspaces.set(key,{...this.workspaces.get(key),checkoutPath});
    }
    await this.registerWorkspace(key,checkoutPath);return {checkoutPath};
  }
  async open(key, sourcePath, preview=false, {raw=false,lineNumber=0}={}) {
    const status=await this.ensureWorkspace(key); const file=filePath(status.checkoutPath,sourcePath);
    // The backend remains authoritative about object identity and readonly state.
    const source=await this.run(key,'read',{path:sourcePath});
    if(!raw && source.metadata?.sourceType==='module-parameter' && this.onOpenModule)return this.onOpenModule(key,sourcePath);
    if(!raw && source.contentState!=='SQL_ABSENT' && source.metadata?.sourceType==='view' && this.onOpenVirtual) return this.onOpenVirtual({workspaceKey:key,sourcePath,sourceType:'view',jsonPointer:'/viewSql',fragmentType:'sql'});
    if(!raw && this.onOpenVirtual && isInlineInherited(key,sourcePath,source)) return this.onOpenVirtual({workspaceKey:key,sourcePath,sourceType:source.metadata.sourceType,fragmentType:source.metadata.sourceType==='system-script' ? 'js' : 'gss'});
    let uri=this.vscode.Uri.file(file);
    if(source.readonly || source.metadata?.sourceType==='module-parameter' || (!raw && source.projectionReadonly)) {
      uri=this.readonlyUri(key,sourcePath,source.content);
    }
    return this.vscode.window.showTextDocument(await this.vscode.workspace.openTextDocument(uri),{preview,...(Number.isInteger(lineNumber)&&lineNumber>0 ? {selection:new this.vscode.Range(lineNumber-1,0,lineNumber-1,0)} : {})});
  }
  readonlyUri(key,sourcePath,content) {
    const revision=crypto.createHash('sha256').update(content).digest('hex');
    const uri=this.vscode.Uri.from({scheme:'guthon-api-readonly',authority:'workspace',path:'/'+sourcePath,query:new URLSearchParams({workspaceKey:key,path:sourcePath,revision}).toString()});
    this.readonlyDocuments.set(JSON.stringify([key,sourcePath,revision]),content);return uri;
  }
  async openReadonly(key,sourcePath,content) {
    return this.vscode.window.showTextDocument(await this.vscode.workspace.openTextDocument(this.readonlyUri(key,sourcePath,content)),{preview:true});
  }
  provideTextDocumentContent(uri) {const query=new URLSearchParams(uri.query || '');return this.readonlyDocuments.get(JSON.stringify([query.get('workspaceKey') || uri.authority,query.get('path') || uri.path.slice(1),query.get('revision') || ''])) || ''; }
  async updateScm(key) {
    const generation=(this.scmGenerations.get(key)||0)+1;this.scmGenerations.set(key,generation);
    const state=await this.status(key); const vscode=this.vscode;
    if(this.disposed || this.scmGenerations.get(key)!==generation) return state;
    await vscode.commands?.executeCommand?.('setContext','gushenCompletion.hasUnknownUpload',state.unverifiedUploadCount>0);
    if (!vscode.scm) return state;
    let record=this.controls.get(key);
    if (!record) {
      const control=vscode.scm.createSourceControl(`guthon-api-${key}`,`${key} · 谷神 API 源码`);
      control.guthonWorkspaceKey=key;
      if(this.quickDiff) control.quickDiffProvider=this.quickDiff;
      const group=control.createResourceGroup('changes','本地变更'); group.hideWhenEmpty=false; group.guthonWorkspaceKey=key;
      record={control,group};this.controls.set(key,record);
    }
    const changes=(state.files || []).filter(x=>x.inScope!==false && x.state !== 'CLEAN');
    const signature=JSON.stringify(changes.map(x=>[x.path,x.state,!!x.readonly,x.sourceHash,x.baseHash]));
    if(record.signature===signature) return state;
    record.signature=signature;
    const sourceChanges=new Map();
    const priority={CONFLICT:3,REMOTE_DELETED:2,MISSING:2,MODIFIED:1};
    for(const change of changes) {const parts=change.path.split('/');for(let i=1;i<=parts.length;i++){const p=parts.slice(0,i).join('/');if(!sourceChanges.has(p) || (priority[change.state] || 0)>(priority[sourceChanges.get(p)] || 0)) sourceChanges.set(p,change.state);}}
    this.sourceChanges.set(key,sourceChanges);this.decorationEmitter?.fire();
    record.group.resourceStates=changes.map(change=>{
      const uri=vscode.Uri.from({scheme:'guthon-api-change',authority:key,path:'/'+path.posix.basename(change.path),query:new URLSearchParams({workspaceKey:key,path:change.path}).toString()});
      return {resourceUri:uri,contextValue:change.state==='CONFLICT' ? 'guthonApi.conflict' : change.readonly ? 'guthonApi.readonlyChange' : change.state==='MODIFIED' ? 'guthonApi.change' : 'guthonApi.unavailable',
        command:{command:'gushenCompletion.showApiDiff',title:'查看差异',arguments:[{workspaceKey:key,path:change.path}]},
        decorations:{tooltip:`${change.path} · ${change.state}`}};
    });
    record.control.count=changes.length; this.refresh();return state;
  }
  provideFileDecoration(uri) {
    if(uri.scheme!=='file')return;
    for(const [key,workspace] of this.workspaces) {
      if(!workspace.checkoutPath)continue;
      const relative=path.relative(workspace.checkoutPath,uri.fsPath).split(path.sep).join('/');
      if(!relative || relative==='..' || relative.startsWith('../') || path.isAbsolute(relative))continue;
      const state=this.sourceChanges.get(key)?.get(relative),name=this.sourceNames.get(key)?.get(relative);
      if(!state && !name)return;
      const states={MODIFIED:['M','本地修改','gitDecoration.modifiedResourceForeground'],CONFLICT:['C','冲突','gitDecoration.conflictingResourceForeground'],MISSING:['D','本地缺失','gitDecoration.deletedResourceForeground'],REMOTE_DELETED:['D','平台已删除','gitDecoration.deletedResourceForeground']};
      const value=states[state];
      return {tooltip:[name,value?.[1]].filter(Boolean).join(' · '),...(value ? {badge:value[0],color:new this.vscode.ThemeColor(value[2])} : {}),propagate:false};
    }
  }
  async diff(key, sourcePath) {
    const value=await this.run(key,'diff',{path:sourcePath});
    const left=await this.vscode.workspace.openTextDocument({content:value.before,language:'plaintext'});
    const right=await this.vscode.workspace.openTextDocument({content:value.after,language:'plaintext'});
    await this.vscode.commands.executeCommand('vscode.diff',left.uri,right.uri,`${sourcePath} · API 差异`);
  }
  async revert(key, sourcePaths) {
    const paths=[...new Set(Array.isArray(sourcePaths) ? sourcePaths : [sourcePaths])];
    if(!paths.length || paths.some(p=>!p)) throw new Error('请选择要还原的源码');
    const state=await this.status(key);assertClean(this.vscode,state.checkoutPath,paths);
    const expectedHashes={};
    for(const p of paths) {const current=await this.run(key,'read',{path:p});if(current.readonly) throw new Error(`只读源码不能还原：${p}`);expectedHashes[p]=current.sourceHash;}
    const answer=await this.vscode.window.showWarningMessage(`还原 ${paths.length} 个源码文件的本地修改？\n\n${paths.join('\n')}`,{modal:true},'还原');
    if(answer!=='还原') return;
    assertClean(this.vscode,state.checkoutPath,paths);await this.editorState?.flush(key);
    for(const p of paths) if((await this.run(key,'read',{path:p})).sourceHash!==expectedHashes[p]) throw new Error(`确认后源码已变化，请重新核对：${p}`);
    const results=[];let failure;
    for(const p of paths) {
      try {const result=await this.run(key,'revert',{path:p,expectedHash:expectedHashes[p]});results.push({path:p,stage:'LOCAL_WRITE_VERIFIED',operationId:result.operationId});}
      catch(error) {results.push({path:p,stage:'未确认或失败',message:error.message});failure=error;break;}
    }
    const done=new Set(results.map(x=>x.path));
    await showReport(this.vscode,'API 本地还原结果',[...results.map(x=>`- ${JSON.stringify(x.path)}：${x.stage}${x.operationId ? ` · ${x.operationId}` : ''}${x.message ? ` · ${x.message}` : ''}`),
      ...paths.filter(p=>!done.has(p)).map(p=>`- ${JSON.stringify(p)}：未执行`),'','如结果未确认，请先核对操作历史和本地文件。']);
    await this.updateScm(key);this.onUpdated?.();if(failure) throw failure;return results;
  }
  async upload(key, paths) {
    const state=await this.status(key);
    let chosen=paths?.length ? [...new Set(paths)] : (state.files || []).filter(x=>x.inScope!==false && x.state === 'MODIFIED' && !x.readonly).map(x=>x.path);
    if (!chosen.length) {await this.vscode.window.showInformationMessage('没有可上传的源码修改');return;}
    const modules=[];
    for(const path of chosen)if((await this.run(key,'read',{path})).metadata?.sourceType==='module-parameter')modules.push(path);
    if(modules.length) {
      if(modules.length<chosen.length) {
        const choice=await this.vscode.window.showQuickPick([{label:`模块参数 (${modules.length})`,module:true},{label:`其他源码 (${chosen.length-modules.length})`,module:false}],{title:'选择本次上传范围'});
        if(!choice)return;
        if(!choice.module)return this.upload(key,chosen.filter(path=>!modules.includes(path)));
      }
      if(!this.onModuleUpload)throw new Error('模块参数上传入口尚未就绪');
      return this.onModuleUpload(key,modules);
    }
    const snapshots=new Map(),entries=[];
    const types={page:'页面',procedure:'过程函数',table:'表',view:'视图','system-script':'系统脚本'};
    for (const p of chosen) {
      const result=await this.run(key,'read',{path:p});
      if(result.readonly) throw new Error(`只读源码不能上传：${p}`);
      snapshots.set(p,result.sourceHash);
      entries.push({path:p,name:result.name || p,type:types[result.metadata?.sourceType] || '源码',state:'本地修改'});
    }
    const reviewed=await this.reviewUpload(this.vscode,entries,p=>this.diff(key,p));
    if(!reviewed?.length) return;
    if(reviewed.some(p=>!snapshots.has(p))) throw new Error('上传选择不属于本次审阅清单');
    chosen=[...new Set(reviewed)];
    assertClean(this.vscode,state.checkoutPath,chosen);
    for(const p of chosen) this.editorState?.assertNoConflictingDrafts(key,p);
    const expectedHashes=Object.fromEntries(chosen.map(p=>[p,snapshots.get(p)]));
    const answer=await this.vscode.window.showWarningMessage(`上传 ${chosen.length} 个已审阅的源码文件到谷神？`,{modal:true,detail:chosen.join('\n')},'上传');
    if (answer !== '上传') return;
    assertClean(this.vscode,state.checkoutPath,chosen);
    await this.editorState?.flush(key);
    for(const p of chosen) if((await this.run(key,'read',{path:p})).sourceHash!==expectedHashes[p]) throw new Error(`确认后源码已变化，请重新核对：${p}`);
    let result;
    try {result=await this.run(key,'upload',{paths:chosen,confirm:true,expectedHashes});}
    catch(error) {
      await showReport(this.vscode,'API 上传结果',['请求未取得完整回执，请先查看操作历史并核对平台状态，勿直接重试。', '', `错误：${error.message}`]);throw error;
    }
    const results=result.results || [], completed=new Set(results.map(x=>x.path));
    const lines=[`工作区：${key}`,`操作编号：${result.operationId || '未返回'}`,`总体状态：${result.stage || '未返回'}`,`完成：${result.complete===true ? '是' : '否'}`,'',
      ...results.map(x=>`- ${JSON.stringify(x.path)}：${x.stage || '未知'}${x.code ? `（${x.code}）` : ''}${x.message ? `：${x.message}` : ''}${x.sourceNormalized===true && x.stage==='REMOTE_READBACK_VERIFIED' ? '；平台已格式化或补全源码，回读结果已同步到本地源码' : ''}`),
      ...chosen.filter(p=>!completed.has(p)).map(p=>`- ${JSON.stringify(p)}：未执行`),
      '', 'REMOTE_READBACK_VERIFIED 表示对应文件已通过平台回读；UNKNOWN 表示结果未知，先查操作历史和平台，不自动重试。', '平台最终提交：未执行。'];
    await showReport(this.vscode,'API 上传结果',lines);
    await this.updateScm(key);this.onUpdated?.();return result;
  }
  async history(key) {
    const result=await this.run(key,'history',{limit:50});
    await showReport(this.vscode,'API 操作历史',[
      `工作区：${key}`, '', '以下是本地持久化的操作回执；UNKNOWN 或已应答但未回读的上传需要核对平台实际状态。', '',
      '```json',JSON.stringify(result.operations || [],null,2),'```']);
    const unknown=(result.operations || []).filter(needsUploadVerification);
    if(unknown.length && await this.vscode.window.showInformationMessage('发现上传结果尚未完成回读的操作，可通过平台核对。','选择核对')==='选择核对') await this.verifyUpload(key,unknown);
    return result;
  }
  async verifyUpload(key,operations) {
    if(!operations) {const history=await this.run(key,'history',{limit:50});operations=(history.operations || []).filter(needsUploadVerification);}
    if(!operations.length) return this.vscode.window.showInformationMessage('最近操作中没有需要核对的上传');
    const selected=await this.vscode.window.showQuickPick(operations.map(item=>({label:item.operationId,description:item.stage,detail:(item.paths || []).join('、'),operation:item})),{title:'选择要回读核对的上传'});
    if(!selected) return;
    const result=await this.run(key,selected.operation.kind==='module-upload'?'module-upload':'verify-upload',{...(selected.operation.kind==='module-upload'?{action:'verify'}:{}),operationId:selected.operation.operationId});
    await showReport(this.vscode,'上传回读核对',[`操作编号：${result.operationId || selected.operation.operationId}`,`状态：${result.stage || '未知'}`,`完成：${result.complete===true?'是':'否'}`,`重放上传：${result.mutationRetried===false?'否':'未确认'}`,'','```json',JSON.stringify(result.results || [],null,2),'```']);
    await this.updateScm(key);this.onUpdated?.();return result;
  }
  async exportChanges(key) {
    const state=await this.status(key);assertClean(this.vscode,state.checkoutPath);await this.editorState?.flush(key);
    const registered=this.editorState?.workspaces.get(key);
    if(registered && this.editorState.documents(key,registered).some(item=>item.dirty)) throw new Error('当前项目有未保存输入，请先保存后导出');
    const target=await this.vscode.window.showSaveDialog({title:'导出当前项目的本地修改',filters:{'修改包':['json']}});if(!target) return;
    const result=await this.run(key,'export-changes',{output:target.fsPath});
    await showReport(this.vscode,'API 修改包导出',[`文件：${result.path}`,`源码数：${result.fileCount}`,`修改包 SHA-256：${result.bundleHash}`,'','本次未上传谷神。']);return result;
  }
  async importChanges(key) {
    const state=await this.status(key);const selected=await this.vscode.window.showOpenDialog({title:'选择当前项目修改包',canSelectFiles:true,canSelectFolders:false,canSelectMany:false,filters:{'修改包':['json']}});
    if(!selected?.length) return;const input=selected[0].fsPath;
    const preview=await this.run(key,'import-changes',{input});
    await showReport(this.vscode,'API 修改包预览',['导入只修改本地源码；请先核对以下预览。','','```json',JSON.stringify(preview,null,2),'```']);
    if(preview.complete!==true || !preview.planHash) return;
    if(await this.vscode.window.showWarningMessage(`确认导入 ${preview.changes?.length || 0} 个本地源码修改？`,{modal:true},'确认导入')!=='确认导入') return;
    const paths=(preview.changes || []).map(item=>item.path);assertClean(this.vscode,state.checkoutPath,paths);await this.editorState?.flush(key);
    let result;
    try {result=await this.run(key,'import-changes',{input,apply:true,planHash:preview.planHash});}
    catch(error) {await showReport(this.vscode,'API 修改包导入结果',['未取得完整回执，请查看操作历史并核对本地文件，勿直接重试。','',`错误：${error.message}`]);throw error;}
    await showReport(this.vscode,'API 修改包导入结果',[`操作编号：${result.operationId || '未返回'}`,`状态：${result.stage || '未知'}`,`本地写入：${result.applied?.length || 0} 个`,'','本次未上传谷神。']);
    await this.updateScm(key);this.onUpdated?.();return result;
  }
  async systemMenu(key) {
    const result=await this.run(key,'system-menu');
    this.invalidate(key);this.refresh();
    const doc=await this.vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(result.menu,null,2)});
    await this.vscode.window.showTextDocument(doc,{preview:true});return result;
  }
  async refreshScope(value) {
    const {key,path:sourcePath}=identity(value);
    if(!key) throw new Error('请选择 API 项目');
    const prefixes=value?.refreshPrefixes ? [...value.refreshPrefixes] : [];
    const selector=sourcePath ? {path:sourcePath} : value?.sourcePrefix ? {prefix:value.sourcePrefix} : prefixes.length ? {prefixes} : undefined;
    if(!selector) throw new Error('当前节点没有明确的物理源码范围');
    const state=await this.ensureWorkspace(key);
    const selectedPrefixes=selector.prefix ? [selector.prefix] : selector.prefixes || [];
    const dirtyPaths=sourcePath ? [sourcePath] : dirtyDocuments(this.vscode,state.checkoutPath)
      .map(doc=>path.relative(state.checkoutPath,doc.uri.fsPath).split(path.sep).join('/'))
      .filter(p=>selectedPrefixes.some(prefix=>p.startsWith(prefix+'/')));
    assertClean(this.vscode,state.checkoutPath,dirtyPaths);
    await this.editorState?.flush(key);
    const result=await this.run(key,'refresh',selector);this.invalidate(key);this.setIndexResult(key,result.index);await this.updateScm(key);this.onUpdated?.();
    await showReport(this.vscode,'API 源码更新结果',sourceSyncLines(key,result));return result;
  }
  async createFunction(key,value) {
    if(value?.packageIdentities?.size!==1) throw new Error('请选择身份明确的过程包');
    await this.ensureWorkspace(key);
    const target=[...value.packageIdentities.values()][0];
    const source=await this.run(key,'read',{path:target.samplePath});const meta=source.metadata || {};
    if(meta.sourceType!=='procedure' || String(meta.procedureId)!==target.procedureId || String(meta.dataSourceId)!==target.dataSourceId) throw new Error('过程包身份与源码不一致，请刷新索引');
    const funId=await this.vscode.window.showInputBox({title:'新过程函数编码'});if(!funId) return;
    const funName=await this.vscode.window.showInputBox({title:'新过程函数名称'});if(!funName) return;
    const flags=await this.vscode.window.showQuickPick([{label:'使用事务',id:'isTran'},{label:'有返回值',id:'isReturn'}],{title:'选择函数属性',canPickMany:true});if(!flags)return;
    if(await this.vscode.window.showWarningMessage(`在过程包 ${meta.procedureId} 创建函数 ${funId}？此操作会修改开发平台。`,{modal:true},'创建')!=='创建') return;
    let result;
    await this.editorState?.flush(key);
    try {result=await this.run(key,'create-function',{procedureId:String(meta.procedureId),dataSourceId:String(meta.dataSourceId),funId,funName,
      isTran:flags.some(x=>x.id==='isTran'),isReturn:flags.some(x=>x.id==='isReturn'),confirm:true});}
    catch(error) {await showReport(this.vscode,'创建函数结果',['未取得完整回执，请先查看操作历史并核对平台状态，勿直接重试。','',`错误：${error.message}`]);throw error;}
    await showReport(this.vscode,'创建函数结果',[`函数：${meta.procedureId}.${funId}`,`操作编号：${result.operationId || '未返回'}`,`平台状态：${result.stage || '未知'}`,'','仅 REMOTE_READBACK_VERIFIED 表示已回读平台对象。']);
    await this.updateScm(key);this.onUpdated?.();return result;
  }
  async syncDatabase(key,sourcePath) {
    const state=await this.status(key);assertClean(this.vscode,state.checkoutPath,[sourcePath]);
    const source=await this.run(key,'read',{path:sourcePath});
    if(!['table','view'].includes(source.metadata?.sourceType)) throw new Error('请选择表或视图源码');
    const answer=await this.vscode.window.showWarningMessage(`将 ${sourcePath} 的结构同步到开发数据库？此操作会执行数据库 DDL。`,{modal:true},'执行结构同步');
    if(answer!=='执行结构同步') return;
    assertClean(this.vscode,state.checkoutPath,[sourcePath]);await this.editorState?.flush(key);
    let result;
    try {result=await this.run(key,'sync-database',{path:sourcePath,confirm:true});}
    catch(error) {await showReport(this.vscode,'结构同步结果',['未取得完整回执，请查看操作历史并核对开发数据库，勿直接重试。','',`错误：${error.message}`]);throw error;}
    await showReport(this.vscode,'结构同步结果',[`对象：${sourcePath}`,`操作编号：${result.operationId || '未返回'}`,`平台状态：${result.stage || '未知'}`,`数据库独立验证：${result.databaseVerification || '未返回'}`,'','平台确认不代表数据库结构已独立验证。']);
    return result;
  }
  async resolveConflict(key,sourcePath) {
    const state=await this.status(key);assertClean(this.vscode,state.checkoutPath,[sourcePath]);
    const inspection=await this.run(key,'conflict',{path:sourcePath});
    const current=await this.run(key,'read',{path:sourcePath});
    if(current.sourceHash!==inspection.sourceHash) throw new Error('冲突源码已变化，请重新比较');
    if(inspection.path!==sourcePath || !inspection.sourceHash || !inspection.remoteHash || typeof inspection.local!=='string' || typeof inspection.remote!=='string') throw new Error('冲突检查未返回完整的来源和哈希，不能处理');
    const local=await this.vscode.workspace.openTextDocument({content:inspection.local,language:'plaintext'});
    const remote=await this.vscode.workspace.openTextDocument({content:inspection.remote,language:'plaintext'});
    await this.vscode.commands.executeCommand('vscode.diff',local.uri,remote.uri,`${sourcePath} · 本地 ↔ 平台冲突`);
    const choices=[
      ...(!current.readonly ? [{label:'保留本地内容',choice:'local',description:'以当前本地源码为解决结果，稍后自行上传'}] : []),
      {label:current.readonly ? '恢复平台原文' : '采用平台内容',choice:'remote',description:'以平台源码替换当前文件'},
    ];
    const choice=await this.vscode.window.showQuickPick(choices,{title:'选择冲突解决方式',
      placeHolder:current.readonly ? '只读继承源码仅可恢复平台原文' : '如需手工合并，先保存原文件，再重新检查冲突'});
    if(!choice) return;
    if(!choices.includes(choice)) throw new Error('冲突处理方式无效');
    if(await this.vscode.window.showWarningMessage(`确认对 ${sourcePath} 执行“${choice.label}”？`,{modal:true},'确认解决')!=='确认解决') return;
    assertClean(this.vscode,state.checkoutPath,[sourcePath]);await this.editorState?.flush(key);
    const latest=await this.run(key,'conflict',{path:sourcePath});
    if(latest.sourceHash!==inspection.sourceHash || latest.remoteHash!==inspection.remoteHash) throw new Error('确认期间冲突内容已变化，请重新比较');
    const result=await this.run(key,'resolve-conflict',{path:sourcePath,choice:choice.choice,expectedHash:inspection.sourceHash});
    await showReport(this.vscode,'API 冲突处理结果',[`对象：${sourcePath}`,`本地源码 SHA-256：${result.sourceHash || '未返回'}`,`操作编号：${result.operationId || '未返回'}`,'','此操作未上传谷神。']);
    await this.updateScm(key);this.onUpdated?.();return result;
  }
  clear(){this.invalidate();this.treeCache.clear();this.treeLoads.clear();this.indexGenerations.clear();this.rootItems=null;for(const {control,refreshTimer} of this.controls.values()) {clearTimeout(refreshTimer);control.dispose();}this.controls.clear();this.sourceChanges.clear();for(const watcher of this.watchers.values()) watcher.dispose();this.watchers.clear();this.readonlyDocuments.clear();this.indexDiagnostics.clear();this.menuAttempts.clear();this.workspaces.clear();this.sourceNames.clear();this.filters.clear();this.decorationEmitter?.fire();this.refresh();}
  dispose(){if(this.disposed)return;this.disposed=true;this.clear();this.configurationListener?.dispose();this.emitter?.dispose();this.decorationEmitter?.dispose();}
}
module.exports={ApiSourceUI,assertClean,buildCatalogTree,dirtyDocuments,filePath,identity,showReport,sourceLabel,sourceSyncLines};

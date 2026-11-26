const path = require('node:path');
const crypto = require('node:crypto');
const {isInlineInherited,scriptType}=require('../source/virtual-fs');
const {sourcePathAllowed}=require('./source-watcher');
const {selectUploadFiles}=require('./upload-review');
const {filterChildren}=require('./tree-filter');
const {SourceDiffProvider}=require('./source-diff');
const {MODULE_STYLES,SOURCE_CATEGORIES,sourceTreeIcon,sourceTreeIdentity,datasourceTreeName,compareDatasourceIds}=require('../source/tree-styles');

const INHERITED_COMPANION_TYPES=new Set(['page-inherit','procedure-inherit','system-script-inherit']);
const API_UPLOAD_TYPES={page:'页面',procedure:'过程函数',table:'表',view:'视图','system-script':'系统脚本'};
const READONLY_SCHEME='guthon-api-readonly';

function isLocalModification(change) {
  return change.inScope!==false && change.state==='MODIFIED' && !change.readonly;
}
function canStage(change) {
  return isLocalModification(change) && Object.hasOwn(API_UPLOAD_TYPES,change.sourceType) && !!change.sourceHash;
}

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

function scmFilename({path:sourcePath,sourceType,state,metadata={}}) {
  const extension=path.posix.extname(sourcePath);
  let candidates=[];
  if(sourceType==='page') {
    const isService=String(metadata.pageType)==='0' || extension.toLowerCase()==='.gss';
    candidates=isService ? [metadata.pageAliasId] : [metadata.pageName,metadata.title];
  } else if(sourceType==='procedure') {
    candidates=[metadata.funId];
  }
  const name=candidates.find(value=>typeof value==='string' && value.trim())?.trim().replace(/[\\/]+/g,' · ');
  const filename=name ? (name.toLowerCase().endsWith(extension.toLowerCase()) ? name : name+extension)
    : path.posix.basename(sourcePath);
  return state==='CONFLICT' ? `【冲突】${filename}` : filename;
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
    sourceNames=new Map(dataSources.map(x=>[String(x.dataSourceId),datasourceTreeName(x.dataSourceName)])),
    systemOrder=new Map(systems.map((x,index)=>[String(x.systemId),index])),
    systemDatasources=new Map(systems.filter(x=>x.dataSourceId!=null).map(x=>[String(x.systemId),String(x.dataSourceId)])), menuPaths=new Map();
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
  const labels=Object.fromEntries(Object.entries(MODULE_STYLES).filter(([category])=>category!=='public')
    .map(([category,style])=>[category,style.label]));
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
      if(!child) {child={label:dir.label,key,children:[],icon:dir.icon,sourcePrefix:dir.sourcePrefix,description:dir.description,category:dir.category,dataSourceId:dir.dataSourceId,systemId:dir.systemId,order:dir.order,sortKey:dir.sortKey,parent:parent===root?workspace:parent};parent.children.push(child);parent.childIndex.set(dir.key,child);}
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
    if(INHERITED_COMPANION_TYPES.has(object.sourceType)) continue;
    filePath('/api-root',object.path);
    const parts=object.path.split('/');
    if(object.sourceType==='module-parameter' && object.referenceFields?.snapshotPath) {
      const sid=object.referenceFields.systemId;
      add(object,[{key:'category:module-parameters',label:labels['module-parameters'],category:'module-parameters',affectedPrefix:object.path},
        {key:'scope:'+sid,label:systemNames.get(sid)||sid,description:sid,category:'module-parameters',systemId:sid,affectedPrefix:object.path,order:systemOrder.get(sid),sortKey:sid}]);
      continue;
    }
    const referenceType=object.sourceType==='bill-type' || object.path==='otherconfig/bill-type.md' ? 'bill-type'
      : object.sourceType==='dropdown' || object.path==='otherconfig/dropdown.md' ? 'dropdown' : parts[0]==='skills' ? 'skills' : '';
    if(referenceType) {
      const dirs=[{key:'category:'+referenceType,label:labels[referenceType],category:referenceType,affectedPrefix:object.path}];
      if(referenceType==='bill-type' && object.dataSourceId) dirs.push({key:'source:'+object.dataSourceId,label:sourceNames.get(object.dataSourceId)||object.dataSourceId,dataSourceId:object.dataSourceId,category:referenceType,description:object.dataSourceId,affectedPrefix:object.path,sortKey:object.dataSourceId});
      if(referenceType==='skills') dirs.push(...parts.slice(1,-1).map(part=>({key:'path:'+part,label:part,affectedPrefix:object.path})));
      add({...object,label:object.referenceId ? `${object.sourceId} · ${object.name}` : object.name || parts.at(-1)},dirs);
      continue;
    }
    const category=labels[parts[2]], scoped=category && ['systems','datasources'].includes(parts[0]);
    const physical=scoped ? [
      {key:'category:'+parts[2],label:category,category:parts[2],affectedPrefix:object.path,refreshPrefix:parts.slice(0,3).join('/')},
      {key:'scope:'+parts[1],label:(parts[0]==='systems'?systemNames:sourceNames).get(parts[1]) || parts[1],description:parts[1],category:parts[2],systemId:parts[0]==='systems'?parts[1]:undefined,dataSourceId:parts[0]==='datasources'?parts[1]:undefined,sourcePrefix:parts.slice(0,3).join('/'),affectedPrefix:object.path,refreshPrefix:parts.slice(0,3).join('/'),order:parts[0]==='systems'?systemOrder.get(parts[1]):undefined,sortKey:parts[1]},
      ...(parts[2]==='procedures' && options.procedureLayout==='flat' && parts.length>4
        ? [{key:'package:'+parts.slice(3,-1).join('/'),label:parts.slice(3,-1).join('.'),sourcePrefix:parts.slice(0,-1).join('/'),affectedPrefix:object.path,refreshPrefix:parts.slice(0,-1).join('/'),sortKey:parts.slice(3,-1).join('.')}]
        : parts.slice(3,-1).map((part,i)=>({key:'path:'+part,label:part,sourcePrefix:parts.slice(0,i+4).join('/'),affectedPrefix:object.path,refreshPrefix:parts.slice(0,i+4).join('/'),sortKey:part})))
    ] : [{key:'other',label:'其他源码',icon:'files',affectedPrefix:object.path,sortKey:''},...parts.slice(0,-1).map((part,i)=>({key:'path:'+part,label:part,sourcePrefix:parts.slice(0,i+1).join('/'),affectedPrefix:object.path,sortKey:part}))];
    if(object.sourceType==='page' && parts[0]==='systems' && parts[2]==='pages' && parts.length>=6) {
      const pageDirectory=parts.slice(0,5).join('/');
      const routes=menuPaths.get(JSON.stringify([parts[1],parts[3],parts[4]]));
      const systemDirs=physical.slice(0,2);
      if(routes) {
        for(const route of routes) add(object,[...systemDirs,...route.branch.map(x=>({key:'menu:'+x.id,label:x.name,affectedPrefix:object.path,refreshPrefix:pageDirectory,order:x.order,sortKey:x.name}))],route.pageIndex);
      } else {
        add(object,[...systemDirs,{key:'unmatched-pages',label:Array.isArray(project.menuTree)?'未归入菜单':'待匹配菜单',
          affectedPrefix:object.path,refreshPrefix:pageDirectory}]);
      }
    } else add(object,physical);
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
      const datasourceOrder=compareDatasourceIds(a.dataSourceId || systemDatasources.get(a.systemId),b.dataSourceId || systemDatasources.get(b.systemId));
      if(datasourceOrder)return datasourceOrder;
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

function scmResourcePaths(key, changes, project, options) {
  const paths=new Map(),counts=new Map();
  const visit=(nodes,parents=[])=>{
    for(const node of nodes) {
      if(node.children) {
        const label=String(node.label).replace(/[\\/]+/g,' · ');
        const rawPageDirectory=node.sourcePrefix?.split('/');
        const showLabel=rawPageDirectory?.[2]!=='pages' || rawPageDirectory.length<4;
        visit(node.children,showLabel ? [...parents,label] : parents);
      } else if(node.object) {
        const sourcePath=node.object.referenceFields?.snapshotPath || node.object.path;
        if(paths.has(sourcePath)) continue;
        const file=path.posix.join('/',...parents,scmFilename(node.object));
        paths.set(sourcePath,file);
        counts.set(file,(counts.get(file)||0)+1);
      }
    }
  };
  visit(buildCatalogTree(key,{},changes,project,options));
  for(const change of changes) {
    const sourcePath=change.path,resourcePath=paths.get(sourcePath);
    if(!resourcePath) paths.set(sourcePath,'/'+scmFilename(change));
    else if(counts.get(resourcePath)>1) {
      // Native SCM tree mode keys files by URI path, without the query.
      const folder=change.metadata?.pageId || path.posix.basename(sourcePath);
      paths.set(sourcePath,path.posix.join(path.posix.dirname(resourcePath),String(folder).replace(/[\\/]+/g,' · '),path.posix.basename(resourcePath)));
    }
  }
  return paths;
}

function uploadRecoveryLines(recovery) {
  if(!recovery?.length) return [];
  return ['','## 先前 PAGE 上传回读',...recovery.map(item=>
    `- ${item.path} · ${item.stage==='REMOTE_READBACK_VERIFIED'?'已确认保存并更新本地基线':`仍待处理（${item.code}）`} · ${item.operationId}`)];
}

function sourceSyncLines(key,result) {
  const state=value=>value===true?'完成':value===false?'未完成':'未返回';
  const index=result.index || {}, diagnostics=index.diagnostics || [];
  const lines=[`工作区：${key}`,`总体结果：${state(result.complete)}`,`文件拉取与合并：${state(result.downloadComplete)}`,
    `索引结果：${state(index.complete)}`,`索引诊断数量：${index.diagnosticCount ?? '未返回'}`,
    `更新 ${result.updated?.length || 0} 个文件，保留 ${result.preserved?.length || 0} 个文件，冲突 ${result.conflicts?.length || 0} 个文件。`,
    ...(result.downloadedParameters!==undefined ? [`清单包含 ${result.downloadedParameters} 个模块参数，同步 ${result.downloadedFiles} 个文件。`] : [])];
  if(result.menuError) lines.push(`菜单更新未完成：${result.menuError.code} · ${result.menuError.message}`);
  lines.push(...uploadRecoveryLines(result.uploadRecovery));
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
  constructor({vscode, run, onUpdated, onStatus, editorState, onSourceChanged, onWorkspace, onOpenVirtual, onOpenModule, onModuleUpload, indexRecovery, canLoadMenu=()=>true, reviewUpload=selectUploadFiles}) {
    this.onStatus=onStatus;
    this.canLoadMenu=canLoadMenu;
    this.vscode=vscode; this.run=run; this.reviewUpload=reviewUpload; this.onUpdated=onUpdated; this.editorState=editorState; this.onSourceChanged=onSourceChanged; this.onWorkspace=onWorkspace; this.onOpenVirtual=onOpenVirtual; this.indexRecovery=indexRecovery;this.onOpenModule=onOpenModule;this.onModuleUpload=onModuleUpload; this.scopeGeneration=0;this.watchers=new Map(); this.workspaces=new Map(); this.controls=new Map();this.scmGenerations=new Map();this.sourceChanges=new Map();
    this.diffProvider=new SourceDiffProvider(vscode,run);
    this.emitter = vscode.EventEmitter ? new vscode.EventEmitter() : undefined;
    this.onDidChangeTreeData = this.emitter?.event;
    this.filters=new Map();this.sourceNames=new Map();
    this.scmProjects=new Map();this.stagedChanges=new Map();this.scmUploadRequests=new Map();
    this.activeUploads=new Set();this.scmUploadDrafts=new Map();
    this.decorationEmitter=vscode.EventEmitter ? new vscode.EventEmitter() : undefined;
    this.onDidChangeFileDecorations=this.decorationEmitter?.event;
    this.readonlyDocuments=new Map();this.rootItems=null;this.treeCache=new Map();this.treeLoads=new Map();this.treeEpoch=new Map();this.indexGenerations=new Map();this.indexDiagnostics=new Map();this.menuAttempts=new Set();this.treeVersion=0;
    this.pagePreparations=new Map();
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
    for (const key of this.workspaces.keys()) if (!keys.has(key)) {changed=true;this.workspaces.delete(key);this.invalidate(key);this.menuAttempts.delete(key);this.scmGenerations.set(key,(this.scmGenerations.get(key)||0)+1);this.controls.get(key)?.control.dispose();this.controls.delete(key);this.sourceChanges.delete(key);this.stagedChanges.delete(key);this.scmUploadRequests.delete(key);this.scmUploadDrafts.delete(key);this.watchers.get(key)?.dispose();this.watchers.delete(key);}
    if(changed) {this.invalidate();this.rootItems=null;this.emitter?.fire();}
  }
  setSelectedWorkspace(key) {
    if(key && !this.workspaces.has(key)) throw new Error('当前工作区未注册');
    if(this.selectedWorkspaceKey===key) return;
    this.selectedWorkspaceKey=key;
    this.selectionVersion=(this.selectionVersion || 0)+1;
    for(const [current,record] of this.controls) if(current!==key) {
      const value=record.control.inputBox.value;
      if(value) this.scmUploadDrafts.set(current,{checkoutPath:record.checkoutPath,value});
      clearTimeout(record.refreshTimer);record.control.dispose();this.controls.delete(current);
    }
    for(const current of this.scmGenerations.keys()) this.scmGenerations.set(current,this.scmGenerations.get(current)+1);
    this.rootItems=null;this.treeVersion++;
    void this.vscode.commands?.executeCommand?.('setContext','gushenCompletion.hasUnknownUpload',false);
    const query=this.filters.get(this.legacyWorkspace?.workspaceKey || key) || '';
    if(this.treeView)this.treeView.message=query?`过滤：${query}（仅影响显示）`:undefined;
    void this.vscode.commands?.executeCommand?.('setContext','gushenCompletion.hasSourceFilter',!!query);
    this.refresh();
  }
  setProjectPresentation(workspace,diagnostic,legacy) {
    const previousLegacy=this.legacyWorkspace;
    this.legacyWorkspace=workspace?.sourceMode && workspace.sourceMode!=='api' && legacy && workspace.executionReady
      ? workspace : undefined;
    this.legacyProvider=legacy;
    const label=diagnostic?diagnostic.message:workspace?.sourceMode && workspace.sourceMode!=='api' && !this.legacyWorkspace
      ?`此版本尚未接入 ${workspace.sourceMode.toUpperCase()} 源码浏览，请使用原有入口。`:undefined;
    const message=label?{kind:'message',label,key:workspace?.workspaceKey || diagnostic?.workspaceKey || '',command:'gushenCompletion.openProjectConfiguration'}:undefined;
    const changed=previousLegacy!==this.legacyWorkspace || JSON.stringify(message)!==JSON.stringify(this.projectMessage);
    if(previousLegacy?.workspaceKey!==this.legacyWorkspace?.workspaceKey) {
      const query=this.filters.get(workspace?.workspaceKey) || '';
      if(this.treeView)this.treeView.message=query?`过滤：${query}（仅影响显示）`:undefined;
      void this.vscode.commands?.executeCommand?.('setContext','gushenCompletion.hasSourceFilter',!!query);
    }
    this.projectMessage=message;
    if(this.treeView) {
      this.treeView.title=workspace?`项目源码 · ${workspace.name || workspace.displayName}`:'项目源码';
      this.treeView.setScope?.(JSON.stringify([workspace?.workspaceKey,workspace?.root,workspace?.sourceMode]));
    }
    if(changed || this.treeView) this.refresh();
  }
  workspaceRoots() {
    return this.rootItems ||= [...this.workspaces]
      .filter(([key])=>this.selectedWorkspaceKey===undefined || key===this.selectedWorkspaceKey)
      .map(([key,w])=>({label:w.displayName || key,key,workspace:true,children:true}));
  }
  track(key) {if (!this.workspaces.has(key)) {this.workspaces.set(key,{workspaceKey:key});this.invalidate();this.rootItems=null;}}
  refresh() {this.emitter?.fire();}
  invalidate(key) {if(key){this.treeCache.delete(key);this.scmProjects.delete(key);this.treeEpoch.set(key,(this.treeEpoch.get(key)||0)+1);}else for(const k of this.workspaces.keys())this.invalidate(k);this.treeVersion++;}
  getTreeItem(item) {
    if(item.kind?.startsWith("legacy-"))return this.legacyProvider?.treeItem(item) || new this.vscode.TreeItem(item.label || "旧项目源码");
    const v=this.vscode;
    const object=item.object;
    const isPageObject=object?.sourceType==='page';
    const serviceComponent=isPageObject && (object.sourceFormat==='script' || /\.gss$/i.test(object.path));
    const pageIcon=isPageObject ? (serviceComponent ? 'symbol-event' : MODULE_STYLES.pages.icon) : undefined;
    const pendingPage=isPageObject && object.pageSource==='batch-export';
    const isPage=isPageObject && !['native-page-minimal','unsupported'].includes(object.sourceFormat) && (['json','xml','native-xml'].includes(object.sourceFormat) || /\.(?:json|xml)$/i.test(object.path));
    const name=object?.name===object?.path ? '' : object?.name;
    const display=object ? sourceTreeIdentity(name,object.sourceType==='procedure'
      ? sourceLabel({...object,name:''},{signature:true}) : object.sourceId,item.label)
      : sourceTreeIdentity(item.label,item.systemId || item.dataSourceId,item.label);
    const tree=new v.TreeItem(display.label, item.children || isPage ? v.TreeItemCollapsibleState.Collapsed : v.TreeItemCollapsibleState.None);
    if(display.code)tree.guthonCode=display.code;
    if(item.kind==='message') {
      tree.tooltip=item.label;
      if(item.contextValue)tree.contextValue=item.contextValue;
      if(item.command)tree.command={command:item.command,title:item.label,arguments:[item.key]};
      return tree;
    }
    if(item.kind==='fragment') {
      if(v.ThemeIcon)tree.iconPath=new v.ThemeIcon(item.target.fragmentType==='fields'?'symbol-field':'code',new v.ThemeColor('charts.blue'));
      tree.contextValue=item.target.fragmentType==='fields' ? 'guthonApi.fragment.fields' : 'guthonApi.fragment.script';tree.tooltip=item.target.jsonPointer;
      tree.command={command:'gushenCompletion.openApiFragment',title:'打开源码分块',arguments:[item.target]};return tree;
    }
    tree.contextValue=item.children ? item.packageIdentities?.size===1 ? 'guthonApi.procedurePackage' : item.category ? `guthonApi.category.${item.category}` : 'guthonApi.directory' : item.object?.readonly ? 'guthonApi.readonly' : ['page','procedure','table','view'].includes(item.object?.sourceType) ? `guthonApi.${item.object.sourceType}` : 'guthonApi.source';
    if(pendingPage)tree.contextValue='guthonApi.page';
    if(item.children && item.category==='procedures' && item.sourcePrefix)tree.contextValue='guthonApi.procedureScope';
    if(item.object && ['bill-type','dropdown','system-script','module-parameter'].includes(item.object.sourceType))tree.contextValue='guthonApi.'+item.object.sourceType;
    tree.guthonWorkspaceKey=item.key;
    tree.description=item.description===display.code?undefined:item.description;
    let owner=item;
    while(owner && !owner.category)owner=owner.parent;
    const category=owner?.category || SOURCE_CATEGORIES[item.object?.sourceType];
    if(v.ThemeIcon)tree.iconPath=sourceTreeIcon(v,category,item.icon || pageIcon || (item.children?'folder':category?undefined:'file'));
    const pageOrigin=pendingPage?'批量下载 XML · 只读 · 编辑时加载原生 PAGE':isPageObject && !serviceComponent
      ? (item.object.pageSource==='native-editor'?(item.object.nativeState==='METADATA_ONLY'?'原生元数据 · 尚无源码版本，仅可查看':'原生编辑模型 · 原生 JSON 保存'):'原文来源待核验 · 上传前核对原生模型') : '';
    tree.tooltip=object ? [object.path,serviceComponent?'服务组件':'',pageOrigin,object.diagnostic].filter(Boolean).join(' · ') : item.label;
    const changes=this.sourceChanges.get(item.key),priority={CONFLICT:3,REMOTE_DELETED:2,MISSING:2,MODIFIED:1};
    const sourcePath=object?.referenceFields?.snapshotPath || object?.path;
    let state=changes?.get(sourcePath || item.sourcePrefix);
    if(sourcePath && state==='CONFLICT')tree.contextValue+='.conflict';
    if(item.sourcePrefixes) for(const prefix of item.sourcePrefixes) {const value=changes?.get(prefix);if((priority[value]||0)>(priority[state]||0))state=value;}
    if(state) {
      tree.description=({CONFLICT:'冲突',REMOTE_DELETED:'远端已删除',MISSING:'本地缺失',MODIFIED:'有本地修改'})[state] || state;
      if(v.ThemeIcon) tree.iconPath=new v.ThemeIcon(pageIcon || (state==='MODIFIED'?'diff-modified':'warning'),
        new v.ThemeColor(state==='MODIFIED'?'gitDecoration.modifiedResourceForeground':state==='CONFLICT'?'editorError.foreground':'editorWarning.foreground'));
    }
    if(item.object) tree.command={command:isPage || pendingPage ? 'gushenCompletion.openApiPageEditor' : item.object.sourceType==='module-parameter'?'gushenCompletion.editModuleParameter':'gushenCompletion.openApiSource',title:isPage || pendingPage ? '编辑页面' : '打开源码',arguments:[{workspaceKey:item.key,path:item.object.path,lineNumber:item.object.lineNumber,...(pendingPage?{pendingNative:true}:{}),...(item.object.sourceType==='module-parameter' && item.object.referenceFields?.snapshotPath ? {moduleParameter:item.object.referenceFields}:{}),...((isPage || pendingPage) && item.object.name ? {sourceName:item.object.name} : {})}]};
    return tree;
  }
  setFilter(key,text) {
    if(text.trim())this.filters.set(key,text.trim());else this.filters.delete(key);
    if(this.treeView)this.treeView.message=text.trim() ? `过滤：${text.trim()}（仅影响显示）` : undefined;
    void this.vscode.commands?.executeCommand?.('setContext','gushenCompletion.hasSourceFilter',this.filters.size>0);
    this.refresh();
  }
  async getChildren(item) {
    const version=this.selectionVersion,message=this.projectMessage,legacy=this.legacyWorkspace;
    const filter=this.filters.get(legacy?.workspaceKey) || '';
    const values=legacy?await this.legacyProvider.children(legacy,item,filter):await this.unfilteredChildren(item);
    if(version!==this.selectionVersion || message!==this.projectMessage || legacy!==this.legacyWorkspace)return [];
    if(legacy)return values;
    if(!item && this.workspaceRoots().length>1)return values;
    return filterChildren(values,this.filters.get(item?.key || values[0]?.key) || '',item);
  }
  async unfilteredChildren(item) {
    if(this.projectMessage)return item?[]:[this.projectMessage];
    if(item?.key && this.selectedWorkspaceKey!==undefined && item.key!==this.selectedWorkspaceKey) return [];
    if (!item) {const roots=this.workspaceRoots();return roots.length===1 ? this.getChildren(roots[0]) : roots;}
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
        const snapshot=await this.run(item.key,'page',{action:'outline',path:item.object.path});
        if(snapshot.sourcePath!==item.object.path) throw new Error('PAGE 来源与目录不一致');
        const fragments=[...snapshot.model.nodes.map(node=>({label:node.label || node.pointer,pointer:node.pointer,type:scriptType(node)})),
          ...snapshot.model.collections.map(collection=>({label:`${collection.label || '集合'} · ${collection.kind==='BUTTONS' ? '按钮' : '字段'} JSON`,pointer:collection.pointer,type:'fields'}))];
        return item.fragments=fragments.length ? fragments.map(fragment=>({kind:'fragment',label:fragment.label,parent:item,target:{workspaceKey:item.key,sourceType:'page',sourcePath:item.object.path,
          path:item.object.path,sourceId:snapshot.sourceId,pendingNative:snapshot.pendingNative===true,jsonPointer:fragment.pointer,fragmentType:fragment.type,documentName:fragment.label}}))
          : [{kind:'message',label:'此 PAGE 没有可编辑分块',parent:item}];
      })().catch(error=>[{kind:'message',label:`无法读取页面分块：${error.message}`,parent:item}])
        .finally(()=>{item.fragmentPromise=undefined;});
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
        const roots=this.workspaceRoots();
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
      if(project) this.scmProjects.set(item.key,{generation,project});
      const root={children:buildCatalogTree(item.key,item,objects,project,{order:treeOrder,procedureLayout})};
      if(partial && !this.indexDiagnostics.has(item.key)) {
        const diagnostics=objects.filter(object=>object.diagnostic && object.status!=='OK').map(object=>({path:object.path,code:object.diagnostic}));
        this.indexDiagnostics.set(item.key,{complete:false,diagnosticCount:partial,diagnostics:diagnostics.slice(0,100),truncated:diagnostics.length>100});
      }
      const diagnostic=this.indexDiagnostics.get(item.key);const count=Math.max(partial,diagnostic?.diagnosticCount || 0);
      if(count || diagnostic?.complete===false) root.children.push({
        kind:'message',contextValue:'guthonApi.indexIncomplete',
        label:`索引不完整${count ? `：${count} 个诊断` : ''}，点击查看`,
        key:item.key,parent:item,command:'gushenCompletion.showApiIndexDiagnostics',
      });
      const recovery=this.indexRecovery?.(item.key);if(recovery?.paths.length) root.children.push({kind:'message',label:`${recovery.paths.length} 个源码文件等待索引更新，点击重试`,key:item.key,parent:item,command:'gushenCompletion.retryApiIndexFailures'});
      this.sourceNames.set(item.key,new Map(objects.map(object=>[object.referenceFields?.snapshotPath || object.path,sourceLabel(object)])));
      this.decorationEmitter?.fire();
      this.indexGenerations.set(item.key,generation);this.treeCache.set(item.key,root.children);
      if(project && this.controls.get(item.key)?.control.count) void this.updateScm(item.key).catch(error=>this.vscode.window.showErrorMessage(`无法刷新源码管理：${error.message}`));
      if(project?.systems?.length && !Array.isArray(project.menuTree) && !this.menuAttempts.has(item.key) && this.canLoadMenu()) {
        this.menuAttempts.add(item.key);const version=this.treeVersion;
        void this.run(item.key,'system-menu').then(result=>{
          const menu=Array.isArray(result.menu) ? result.menu : result.menu?.list;
          if(this.disposed || version!==this.treeVersion || !Array.isArray(menu)) return;
          const messages=root.children.filter(child=>child.kind==='message');
          const withMenu={...project,menuTree:menu};
          this.scmProjects.set(item.key,{generation,project:withMenu});
          this.treeCache.set(item.key,[...buildCatalogTree(item.key,item,objects,withMenu,{order:treeOrder,procedureLayout}),...messages]);this.emitter?.fire();
          if(this.controls.get(item.key)?.control.count) void this.updateScm(item.key).catch(error=>this.vscode.window.showErrorMessage(`无法刷新源码管理：${error.message}`));
        }).catch(error=>{
          if(this.disposed || version!==this.treeVersion || ['API_LOGIN_REQUIRED','API_LOGIN_RESTORE_FAILED'].includes(error.code)) return;
          const items=this.treeCache.get(item.key);if(!items)return;
          items.push({kind:'message',label:`菜单加载失败：${error.message}；点击刷新重试`,key:item.key,parent:item,command:'gushenCompletion.refreshApiSourceView'});this.emitter?.fire();
        });
      }
      return root.children;
  }
  getParent(item) {if(item.svnNode?.parent && item.kind==="legacy-svn")return {kind:"legacy-svn",svnNode:item.svnNode.parent};return item.parent?.workspace && this.workspaceRoots().length===1 ? undefined : item.parent;}
  async revealSource(key,sourcePath) {
    if(!this.treeView) throw new Error('源码视图不可用');
    const workspace=this.workspaceRoots().find(item=>item.key===key);if(!workspace) throw new Error('当前项目未显示在源码树');
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
    const generation=this.scopeGeneration;
    if(this.editorState && !this.editorState.workspaces.has(key)) await this.editorState.add(key,checkoutPath);
    if(generation!==this.scopeGeneration || this.workspaces.get(key)?.checkoutPath!==checkoutPath) throw new Error('工作空间或工作区目录已切换，请重试');
    this.onWorkspace?.(key,checkoutPath);
    if(this.editorState && !this.watchers.has(key) && this.vscode.workspace.createFileSystemWatcher && this.vscode.RelativePattern) {
        const watcher=this.vscode.workspace.createFileSystemWatcher(new this.vscode.RelativePattern(checkoutPath,'**/*'));
        const changed=uri=>{const relative=path.relative(checkoutPath,uri.fsPath).split(path.sep).join('/');
          if(sourcePathAllowed(relative)) void this.onSourceChanged?.(key,[relative]);};
      watcher.onDidChange(changed);watcher.onDidCreate(changed);watcher.onDidDelete(changed);this.watchers.set(key,watcher);
    }
  }
  async status(key) {
    this.track(key);
    const scope=this.scopeGeneration,binding=this.workspaces.get(key);
    const result=await this.run(key,'status'),current=this.workspaces.get(key);
    if(scope!==this.scopeGeneration) throw new Error('工作空间或工作区目录已切换，请重试');
    if(!current) return result;
    if(binding.root && binding.root!==current.root || binding.checkoutPath && binding.checkoutPath!==current.checkoutPath) throw new Error('工作空间或工作区目录已切换，请重试');
    const generation=result.index?.indexGeneration;
    if(this.treeCache.has(key) && ((generation && this.indexGenerations.get(key)!==generation) || result.index?.ready===false)) {this.invalidate(key);this.refresh();}
    this.workspaces.set(key,{...this.workspaces.get(key),checkoutPath:result.checkoutPath});
    await this.registerWorkspace(key,result.checkoutPath);
    return result;
  }
  async ensureWorkspace(key) {
    const scope=this.scopeGeneration,binding=this.workspaces.get(key);
    let checkoutPath=binding?.checkoutPath;
    if(!checkoutPath || !path.isAbsolute(checkoutPath)) {
      const summary=await this.run(key,'status',{summaryOnly:true});
      if(scope!==this.scopeGeneration || binding?.root && this.workspaces.get(key)?.root!==binding.root) throw new Error('工作空间或工作区目录已切换，请重试');
      checkoutPath=summary.checkoutPath;
      if(!checkoutPath || !path.isAbsolute(checkoutPath)) throw new Error('API 工作区路径无效');
      this.workspaces.set(key,{...this.workspaces.get(key),checkoutPath});
    }
    await this.registerWorkspace(key,checkoutPath);
    if(scope!==this.scopeGeneration || this.workspaces.get(key)?.checkoutPath!==checkoutPath) throw new Error('工作空间或工作区目录已切换，请重试');
    return {checkoutPath};
  }
  async open(key, sourcePath, preview=false, {raw=false,lineNumber=0}={}) {
    const scope=this.scopeGeneration;
    const status=await this.ensureWorkspace(key); const file=filePath(status.checkoutPath,sourcePath);
    // The backend remains authoritative about object identity and readonly state.
    const source=await this.run(key,'read',{path:sourcePath,omitEditableContent:true});
    if(scope!==this.scopeGeneration || this.workspaces.get(key)?.checkoutPath!==status.checkoutPath) throw new Error('工作空间或工作区目录已切换，请重试');
    if(!raw && source.metadata?.sourceType==='module-parameter' && this.onOpenModule)return this.onOpenModule(key,sourcePath);
    if(!raw && source.contentState!=='SQL_ABSENT' && source.metadata?.sourceType==='view' && this.onOpenVirtual) return this.onOpenVirtual({workspaceKey:key,sourcePath,sourceType:'view',jsonPointer:'/viewSql',fragmentType:'sql'});
    if(!raw && this.onOpenVirtual && isInlineInherited(key,sourcePath,source)) return this.onOpenVirtual({workspaceKey:key,sourcePath,sourceType:source.metadata.sourceType,fragmentType:source.metadata.sourceType==='system-script' ? 'js' : 'gss'});
    let uri=this.vscode.Uri.file(file);
    if(source.readonly || source.metadata?.sourceType==='module-parameter' || (!raw && source.projectionReadonly)) {
      uri=this.readonlyUri(key,sourcePath,source.content);
    }
    return this.vscode.window.showTextDocument(await this.vscode.workspace.openTextDocument(uri),{preview,...(Number.isInteger(lineNumber)&&lineNumber>0 ? {selection:new this.vscode.Range(lineNumber-1,0,lineNumber-1,0)} : {})});
  }
  async openOriginalSources(key, sourcePaths) {
    let editor;
    for(const sourcePath of Array.isArray(sourcePaths) ? sourcePaths : [sourcePaths]) {
      editor=await this.open(key,sourcePath,false,{raw:true});
    }
    return editor;
  }
  readonlyUri(key,sourcePath,content) {
    const revision=crypto.createHash('sha256').update(content).digest('hex');
    const uri=this.vscode.Uri.from({scheme:READONLY_SCHEME,authority:'workspace',path:'/'+sourcePath,query:new URLSearchParams({workspaceKey:key,path:sourcePath,revision}).toString()});
    this.readonlyDocuments.set(JSON.stringify([key,sourcePath,revision]),content);return uri;
  }
  async openReadonly(key,sourcePath,content,lineNumber) {
    const document=await this.vscode.workspace.openTextDocument(this.readonlyUri(key,sourcePath,content));
    const line=Number.isInteger(lineNumber) && lineNumber>0 ? Math.min(lineNumber-1,document.lineCount-1) : undefined;
    return this.vscode.window.showTextDocument(document,{preview:true,
      ...(line>=0?{selection:new this.vscode.Range(line,0,line,0)}:{})});
  }
  provideTextDocumentContent(uri) {const query=new URLSearchParams(uri.query || '');return this.readonlyDocuments.get(JSON.stringify([query.get('workspaceKey') || uri.authority,query.get('path') || uri.path.slice(1),query.get('revision') || ''])) || ''; }
  stagedFiles(key, checkoutPath) {
    const stage=this.stagedChanges.get(key);
    return stage?.checkoutPath===checkoutPath ? stage.files : undefined;
  }
  async updateScm(key, checkedState) {
    const generation=(this.scmGenerations.get(key)||0)+1;this.scmGenerations.set(key,generation);
    const state=checkedState || await this.status(key); const vscode=this.vscode;
    if(!this.disposed && this.scmGenerations.get(key)===generation)this.onStatus?.(key,state);
    if(this.disposed || this.scmGenerations.get(key)!==generation || this.selectedWorkspaceKey!==undefined && this.selectedWorkspaceKey!==key) return state;
    await vscode.commands?.executeCommand?.('setContext','gushenCompletion.hasUnknownUpload',state.unverifiedUploadCount>0);
    if(this.disposed || this.scmGenerations.get(key)!==generation || this.selectedWorkspaceKey!==undefined && this.selectedWorkspaceKey!==key) return state;
    if (!vscode.scm) return state;
    const changes=(state.files || []).filter(x=>x.inScope!==false && x.state!=='CLEAN');
    const indexGeneration=state.index?.indexGeneration;
    let project=this.scmProjects.get(key);
    if(changes.length && state.index?.ready && indexGeneration && project?.generation!==indexGeneration) {
      try {
        const first=await this.run(key,'catalog',{limit:1,offset:0});
        if(first.indexGeneration===indexGeneration) project={generation:indexGeneration,project:first.project};
      } catch(error) {
        if(!['API_INDEX_REQUIRED','API_INDEX_SCOPE_STALE','API_INDEX_INVALID'].includes(error.code)) throw error;
      }
      if(this.disposed || this.scmGenerations.get(key)!==generation || this.selectedWorkspaceKey!==undefined && this.selectedWorkspaceKey!==key) return state;
      if(this.scmProjects.get(key)?.generation===indexGeneration) project=this.scmProjects.get(key);
      else if(project?.generation===indexGeneration) this.scmProjects.set(key,project);
    }
    const config=vscode.workspace.getConfiguration?.('gushenCompletion');
    const resourcePaths=scmResourcePaths(key,changes,project?.project,{
      order:config?.get?.('sourceTreeOrder','platform'),procedureLayout:config?.get?.('procedureTreeLayout','tree'),
    });
    const workspace=this.workspaces.get(key);
    const label=`${workspace?.displayName || workspace?.name || key} · 谷神 API 源码`;
    let record=this.controls.get(key);
    if (record?.control.label!==label || record.checkoutPath!==state.checkoutPath) {
      // SourceControl labels are read-only, so a project rename requires a new instance.
      const saved=this.scmUploadDrafts.get(key);
      const draft=record && record.checkoutPath===state.checkoutPath ? record.control.inputBox.value
        : saved && saved.checkoutPath===state.checkoutPath ? saved.value : undefined;
      this.scmUploadDrafts.delete(key);
      record?.control.dispose();
      const control=vscode.scm.createSourceControl(`guthon-api-${key}`,label);
      control.guthonWorkspaceKey=key;
      control.inputBox.placeholder='上传备注（可选）';
      if(draft) control.inputBox.value=draft;
      control.acceptInputCommand={command:'gushenCompletion.uploadStagedApiSources',title:'上传源码',arguments:[key]};
      if(this.quickDiff) control.quickDiffProvider=this.quickDiff;
      const stagedGroup=control.createResourceGroup('staged','暂存区');stagedGroup.hideWhenEmpty=true;stagedGroup.guthonWorkspaceKey=key;
      const group=control.createResourceGroup('changes','本地变更'); group.hideWhenEmpty=false; group.guthonWorkspaceKey=key;
      record={control,group,stagedGroup,checkoutPath:state.checkoutPath};this.controls.set(key,record);
    }
    const staged=this.stagedFiles(key,state.checkoutPath);
    if(staged?.size) {
      const changed=new Set(changes.map(change=>change.path));
      for(const p of staged.keys()) if(!changed.has(p)) staged.delete(p);
    }
    const signature=JSON.stringify(changes.map(x=>[x.path,resourcePaths.get(x.path),x.state,!!x.readonly,x.sourceType,x.sourceHash,x.baseHash,staged?.get(x.path)]));
    if(record.signature===signature) return state;
    record.signature=signature;
    const sourceChanges=new Map();
    const priority={CONFLICT:3,REMOTE_DELETED:2,MISSING:2,MODIFIED:1};
    for(const change of changes) {const parts=change.path.split('/');for(let i=1;i<=parts.length;i++){const p=parts.slice(0,i).join('/');if(!sourceChanges.has(p) || (priority[change.state] || 0)>(priority[sourceChanges.get(p)] || 0)) sourceChanges.set(p,change.state);}}
    this.sourceChanges.set(key,sourceChanges);this.decorationEmitter?.fire();
    const localRows=[],stagedRows=[];
    for(const change of changes) {
      const stagedHash=staged?.get(change.path);
      const uri=vscode.Uri.from({scheme:'guthon-api-change',authority:key,path:resourcePaths.get(change.path),query:new URLSearchParams({workspaceKey:key,path:change.path}).toString()});
      const conflict=change.state==='CONFLICT';
      const contextValue=conflict ? 'guthonApi.conflict'
        : change.readonly ? 'guthonApi.readonlyChange'
        : canStage(change) ? 'guthonApi.change.stageable'
        : change.state==='MODIFIED' ? 'guthonApi.change' : 'guthonApi.unavailable';
      const row={resourceUri:uri,contextValue,
        command:{command:conflict ? 'gushenCompletion.resolveApiConflict' : 'gushenCompletion.showApiDiff',
          title:conflict ? '处理 API 源码冲突' : '查看差异',arguments:[{workspaceKey:key,path:change.path}]},
        decorations:{
          ...(conflict && vscode.ThemeIcon ? {iconPath:new vscode.ThemeIcon('warning',new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'))} : {}),
          tooltip:[conflict ? `源码冲突 · ${change.path}` : change.state,stagedHash && stagedHash!==change.sourceHash ? '源码已变化，请重新暂存' : ''].filter(Boolean).join(' · '),
        }};
      (stagedHash ? stagedRows : localRows).push(row);
    }
    record.group.resourceStates=localRows;
    record.stagedGroup.resourceStates=stagedRows;
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
  async diff(key, sourcePath, expectedSourceHash) {
    const value=await this.diffProvider.open(key,sourcePath,{expectedSourceHash});
    if(value.sourceType==='page' && value.view==='readable') {
      void this.vscode.window.showInformationMessage('PAGE 可读差异忽略原文格式和键顺序。','查看原始源码对比').then(async choice=>{
        if(choice==='查看原始源码对比') await this.diffProvider.open(key,sourcePath,{view:'raw',expectedSourceHash:value.sourceHash,expectedBaseHash:value.baseHash});
      }).catch(error=>this.vscode.window.showErrorMessage(`API 差异：${error.message}`));
    } else if(value.message) {
      void this.vscode.window.showWarningMessage(value.message);
    }
  }
  scmScope(key, checkoutPath, selectionVersion, scopeGeneration) {
    if(this.disposed || this.scopeGeneration!==scopeGeneration || this.selectionVersion!==selectionVersion
      || this.selectedWorkspaceKey!==undefined && this.selectedWorkspaceKey!==key
      || this.workspaces.get(key)?.checkoutPath!==checkoutPath) throw new Error('当前项目已切换，请重新选择 API 源码');
  }
  assertUploadIdle(checkoutPath) {
    if(this.activeUploads.has(checkoutPath)) throw new Error('正在上传当前项目的 API 源码，请等本次上传完成');
  }
  async openScmGroupSources(key,groupId) {
    const record=this.controls.get(key);
    const group=groupId==='staged' ? record?.stagedGroup : groupId==='changes' ? record?.group : undefined;
    if(!group) throw new Error('请选择当前 API 项目的源码分组');
    const paths=group.resourceStates.filter(row=>row.contextValue!=='guthonApi.unavailable').map(row=>identity(row).path);
    if(!paths.length) return this.vscode.window.showInformationMessage('本组没有可打开的原始源码');
    return this.openOriginalSources(key,paths);
  }
  async applyScmChangeAction(key,action,sourcePaths) {
    const {selectionVersion,scopeGeneration}=this;
    const scmGeneration=this.scmGenerations.get(key);
    const state=await this.status(key);
    const checkScope=()=>{
      this.scmScope(key,state.checkoutPath,selectionVersion,scopeGeneration);
      this.assertUploadIdle(state.checkoutPath);
    };
    checkScope();
    const staged=this.stagedFiles(key,state.checkoutPath);
    const {title,matches}={
      stage:{title:'暂存源码',matches:canStage},
      unstage:{title:'取消暂存',matches:change=>staged?.has(change.path)},
      revert:{title:'还原本地修改',matches:isLocalModification},
    }[action];
    const changes=(state.files || []).filter(matches);
    let selected;
    if(sourcePaths) {
      const byPath=new Map(changes.map(change=>[change.path,change]));
      const paths=Array.isArray(sourcePaths) ? sourcePaths : [sourcePaths];
      const unavailable=paths.find(p=>!byPath.has(p));
      if(unavailable) throw new Error(`当前无法${title}：${unavailable}`);
      selected=paths.map(p=>byPath.get(p));
    } else {
      selected=action==='unstage' ? changes : changes.filter(change=>!staged?.has(change.path));
    }
    if(!selected.length) return this.vscode.window.showInformationMessage(`本组没有可${title}的文件`);
    const paths=selected.map(change=>change.path);
    if(action==='revert') return this.revert(key,paths,checkScope,state.checkoutPath);
    const files=this.stagedFiles(key,state.checkoutPath) || new Map();
    if(action==='unstage') for(const p of paths) files.delete(p);
    else {
      assertClean(this.vscode,state.checkoutPath,paths);
      for(const p of paths) this.editorState?.assertNoConflictingDrafts(key,p);
      for(const change of selected) files.set(change.path,change.sourceHash);
    }
    this.stagedChanges.set(key,{checkoutPath:state.checkoutPath,files});
    // Staging changes only the session queue. Reuse the status that checked
    // the selection, unless a refresh has already requested a newer snapshot.
    await this.updateScm(key,this.scmGenerations.get(key)===scmGeneration ? state : undefined);
  }
  async uploadScm(key,scmMode='auto') {
    const {scopeGeneration,selectionVersion}=this;
    const pending=this.scmUploadRequests.get(key);
    if(pending && pending.selectionVersion===selectionVersion) return;
    const record=this.controls.get(key);
    const draft=record?.control.inputBox.value;
    const remark=draft?.trim() || '';
    const request=this.upload(key,undefined,{scmMode,remark}).then(result=>{
      if(result?.complete===true && draft && (!remark || result.remark===remark) && this.scopeGeneration===scopeGeneration) {
        const current=this.controls.get(key);
        if(current?.checkoutPath===record.checkoutPath && current.control.inputBox.value===draft) current.control.inputBox.value='';
        const saved=this.scmUploadDrafts.get(key);
        if(saved?.checkoutPath===record.checkoutPath && saved.value===draft) this.scmUploadDrafts.delete(key);
      }
      return result;
    }).finally(()=>{
      if(this.scmUploadRequests.get(key)?.request===request) this.scmUploadRequests.delete(key);
    });
    this.scmUploadRequests.set(key,{selectionVersion,request});
    return request;
  }
  async showOriginalPath(key, sourcePath) {
    const {checkoutPath}=await this.ensureWorkspace(key);
    const absolute=filePath(checkoutPath,sourcePath);
    const answer=await this.vscode.window.showInformationMessage('API 源码原始路径',{
      modal:true,detail:`相对路径：${sourcePath}\n绝对路径：${absolute}`,
    },'复制相对路径','复制绝对路径');
    if(answer) await this.vscode.env.clipboard.writeText(answer==='复制相对路径' ? sourcePath : absolute);
  }
  async revert(key, sourcePaths, checkScope, checkoutPath) {
    const paths=[...new Set(Array.isArray(sourcePaths) ? sourcePaths : [sourcePaths])];
    if(!paths.length || paths.some(p=>!p)) throw new Error('请选择要还原的源码');
    checkoutPath ??= (await this.status(key)).checkoutPath;
    assertClean(this.vscode,checkoutPath,paths);
    const expectedHashes={};
    for(const p of paths) {const current=await this.run(key,'read',{path:p,omitEditableContent:true});if(current.readonly) throw new Error(`只读源码不能还原：${p}`);expectedHashes[p]=current.sourceHash;}
    const answer=await this.vscode.window.showWarningMessage(`还原 ${paths.length} 个源码文件的本地修改？\n\n${paths.join('\n')}`,{modal:true},'还原');
    if(answer!=='还原') return;
    assertClean(this.vscode,checkoutPath,paths);await this.editorState?.flush(key);
    for(const p of paths) if((await this.run(key,'read',{path:p,omitEditableContent:true})).sourceHash!==expectedHashes[p]) throw new Error(`确认后源码已变化，请重新核对：${p}`);
    checkScope?.();
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
  async upload(key, paths, {scmMode,remark=''}={}) {
    const {selectionVersion,scopeGeneration}=this;
    const state=await this.status(key);
    const files=state.files || [];
    const staged=scmMode ? new Map(this.stagedFiles(key,state.checkoutPath)) : undefined;
    const useStaged=scmMode==='auto' && staged.size>0;
    let chosen;
    if(staged) {
      this.scmScope(key,state.checkoutPath,selectionVersion,scopeGeneration);
      const uploadable=files.filter(canStage);
      chosen=useStaged ? [...staged.keys()] : uploadable.filter(change=>!staged.has(change.path)).map(change=>change.path);
      if(!chosen.length) return this.vscode.window.showInformationMessage('没有可上传的未暂存 API 源码');
      if(chosen.length>200) throw new Error('一次最多上传 200 个源码，请分批选择需要上传的文件');
      if(useStaged) {
        const current=new Map(uploadable.map(change=>[change.path,change.sourceHash]));
        const outdated=chosen.find(p=>current.get(p)!==staged.get(p));
        if(outdated) throw new Error(`暂存源码已变化或不可上传，请检查并重新暂存：${outdated}`);
      }
    } else {
      chosen=paths?.length ? [...new Set(paths)] : files.filter(isLocalModification).map(change=>change.path);
    }
    if (!chosen.length) {await this.vscode.window.showInformationMessage('没有可上传的源码修改');return;}
    const sources=new Map();
    for(const p of chosen) sources.set(p,await this.run(key,'read',{path:p,omitEditableContent:true}));
    const modules=staged ? [] : chosen.filter(p=>sources.get(p).metadata?.sourceType==='module-parameter');
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
    for (const p of chosen) {
      const result=sources.get(p);
      if(result.readonly) throw new Error(`只读源码不能上传：${p}`);
      if(staged && !Object.hasOwn(API_UPLOAD_TYPES,result.metadata?.sourceType)) throw new Error(`当前源码不可通过源代码管理批量上传：${p}`);
      if(useStaged && result.sourceHash!==staged.get(p)) {
        throw new Error(`暂存源码已变化或不可上传，请检查并重新暂存：${p}`);
      }
      snapshots.set(p,result.sourceHash);
      entries.push({path:p,name:result.name || p,type:API_UPLOAD_TYPES[result.metadata?.sourceType] || '源码',state:'本地修改'});
    }
    if(!staged) {
      const reviewed=await this.reviewUpload(this.vscode,entries,p=>this.diff(key,p,snapshots.get(p)));
      if(!reviewed?.length) return;
      if(reviewed.some(p=>!snapshots.has(p))) throw new Error('上传选择不属于本次审阅清单');
      chosen=[...new Set(reviewed)];
    }
    assertClean(this.vscode,state.checkoutPath,chosen);
    for(const p of chosen) this.editorState?.assertNoConflictingDrafts(key,p);
    const expectedHashes=Object.fromEntries(chosen.map(p=>[p,snapshots.get(p)]));
    const project=this.workspaces.get(key);
    const projectName=project?.displayName || project?.name || key;
    const target=useStaged ? `${projectName} 暂存区中的全部 ${chosen.length} 个文件`
      : staged ? `${projectName} 全部 ${chosen.length} 个可上传的未暂存文件` : `${chosen.length} 个已审阅的源码文件`;
    const detail=chosen.join('\n')+(remark ? `\n\n上传备注（本地操作记录）\n${remark}` : '');
    const answer=await this.vscode.window.showWarningMessage(`上传 ${target} 到谷神？`,{modal:true,detail},'上传');
    if (answer !== '上传') return;
    assertClean(this.vscode,state.checkoutPath,chosen);
    await this.editorState?.flush(key);
    for(const p of chosen) if((await this.run(key,'read',{path:p,omitEditableContent:true})).sourceHash!==expectedHashes[p]) throw new Error(`确认后源码已变化，请重新核对：${p}`);
    if(staged) {
      this.scmScope(key,state.checkoutPath,selectionVersion,scopeGeneration);
      const latest=this.stagedFiles(key,state.checkoutPath);
      if((latest?.size || 0)!==staged.size || [...staged].some(([p,hash])=>latest?.get(p)!==hash)) throw new Error('暂存区已变化，请重新确认');
    }
    this.assertUploadIdle(state.checkoutPath);
    let result,requestError;
    this.activeUploads.add(state.checkoutPath);
    try {
      result=await this.run(key,'upload',{paths:chosen,confirm:true,expectedHashes,...(remark?{remark}:{})});
    }
    catch(error) {requestError=error;}
    finally {this.activeUploads.delete(state.checkoutPath);}
    if(requestError) {
      await showReport(this.vscode,'API 上传结果',['请求未取得完整回执，请先查看操作历史并核对平台状态，勿直接重试。', '', `错误：${requestError.message}`]);throw requestError;
    }
    const results=result.results || [], completed=new Set(results.map(x=>x.path));
    if(useStaged) {
      const latest=this.stagedFiles(key,state.checkoutPath);
      for(const {path:p,stage} of results) {
        if(latest && latest.get(p)===staged.get(p) && staged.has(p) && ['REMOTE_READBACK_VERIFIED','UNCHANGED','ALREADY_REMOTE'].includes(stage)) latest.delete(p);
      }
    }
    const lines=[`工作区：${key}`,`操作编号：${result.operationId || '未返回'}`,`总体状态：${result.stage || '未返回'}`,`完成：${result.complete===true ? '是' : '否'}`,
      ...(result.remark ? [`上传备注：${JSON.stringify(result.remark)}`]
        : remark ? ['上传回执未包含备注，备注输入已保留。'] : []),'',
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
  async preparePageForEditing(key, sourcePath) {
    const identity=JSON.stringify([this.scopeGeneration,key,sourcePath]);
    if(this.pagePreparations.has(identity))return this.pagePreparations.get(identity);
    const operation=this.refreshScope({workspaceKey:key,path:sourcePath},{showResult:false,waitForPresentation:false})
      .then(result=>{if(!result.downloadComplete)throw new Error('原生 PAGE 未能更新，请核对当前页面的源码冲突');})
      .finally(()=>this.pagePreparations.delete(identity));
    this.pagePreparations.set(identity,operation);
    return operation;
  }
  async refreshScope(value, {showResult=true,waitForPresentation=true}={}) {
    const {key,path:sourcePath}=identity(value);
    if(!key) throw new Error('请选择 API 项目');
    const prefixes=value?.refreshPrefixes ? [...value.refreshPrefixes] : [];
    const references=new Set(['bill-type','dropdown','skills']);
    let category=value;
    while(category && !category.category)category=category.parent;
    const moduleDirectory=sourcePath==='otherconfig/module-parameters.json' || category?.category==='module-parameters';
    const parameter=value?.object?.sourceType==='module-parameter' ? value.object.referenceFields : undefined;
    const referencePaths=references.has(category?.category) && !sourcePath ? [...new Set(value.sourcePrefixes || [])] : [];
    const action=parameter ? 'module-parameter-load' : moduleDirectory ? 'module-parameters-sync' : referencePaths.length ? 'reference-sync' : 'refresh';
    const selector=parameter ? {systemId:parameter.systemId,configId:parameter.configId}
      : moduleDirectory ? (value?.systemId ? {systemId:value.systemId} : {})
      : referencePaths.length ? {paths:referencePaths} : sourcePath ? {path:sourcePath} : value?.sourcePrefix ? {prefix:value.sourcePrefix}
      : prefixes.length ? {prefixes} : undefined;
    if(!selector) throw new Error('当前节点没有明确的物理源码范围');
    const state=await this.ensureWorkspace(key);
    const selectedPrefixes=selector.prefix ? [selector.prefix] : selector.prefixes || [];
    const dirtyPaths=parameter?.snapshotPath ? [parameter.snapshotPath] : referencePaths.length ? referencePaths : sourcePath ? [sourcePath] : dirtyDocuments(this.vscode,state.checkoutPath)
      .map(doc=>path.relative(state.checkoutPath,doc.uri.fsPath).split(path.sep).join('/'))
      .filter(p=>selectedPrefixes.some(prefix=>p.startsWith(prefix+'/')));
    assertClean(this.vscode,state.checkoutPath,dirtyPaths);
    await this.editorState?.flush(key);
    const result=await this.run(key,action,selector);this.invalidate(key);this.setIndexResult(key,result.index);
    const presentation=this.updateScm(key).then(()=>this.onUpdated?.());
    if(waitForPresentation)await presentation;
    else void presentation.catch(error=>this.vscode.window.showWarningMessage(`源码状态刷新失败：${error.message}`));
    if(showResult) await showReport(this.vscode,'API 源码更新结果',sourceSyncLines(key,result));
    return result;
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
    const scope=this.scopeGeneration;
    const {checkoutPath}=await this.ensureWorkspace(key);
    const assertCurrentSource=()=>{
      if(scope!==this.scopeGeneration || this.workspaces.get(key)?.checkoutPath!==checkoutPath) throw new Error('工作空间或工作区目录已切换，请重试');
      if(this.editorState) {
        this.editorState.assertNoConflictingDrafts(key,sourcePath);
        this.editorState.assertNoDirtyDocumentsExcept(key,sourcePath);
      } else assertClean(this.vscode,checkoutPath,[sourcePath]);
    };
    assertCurrentSource();
    const conflictTarget={path:sourcePath,summaryOnly:true};
    let inspection=await this.run(key,'conflict',conflictTarget);
    if(inspection.path===sourcePath && inspection.metadata?.pageSource==='batch-export') {
      assertCurrentSource();
      const refresh=await this.refreshScope({workspaceKey:key,path:sourcePath},{showResult:false});
      assertCurrentSource();
      if(refresh.path!==sourcePath) throw new Error('原生 PAGE 更新结果与冲突文件不一致');
      if(refresh.updated.includes(sourcePath) || refresh.preserved.includes(sourcePath)) {
        void this.vscode.window.showInformationMessage('已更新此页面的原生源码，当前页面无需手工处理冲突。');
        return;
      }
      inspection=await this.run(key,'conflict',conflictTarget);
      assertCurrentSource();
    }
    if(inspection.path!==sourcePath || !inspection.sourceHash || !inspection.remoteHash) throw new Error('冲突检查未返回完整的来源和哈希，不能处理');
    if(inspection.metadata?.pageSource==='batch-export') {
      throw new Error('未取得此页面的原生源码，已保留冲突。请检查当前项目的平台连接和更新结果后重试。');
    }
    const current=await this.run(key,'read',{path:sourcePath,omitEditableContent:true});
    if(current.sourceHash!==inspection.sourceHash) throw new Error('冲突源码已变化，请重新比较');
    const readonly=current.readonly || inspection.readonly;
    const expectedVersions={expectedSourceHash:inspection.sourceHash,expectedRemoteHash:inspection.remoteHash};
    const comparison=await this.diffProvider.open(key,sourcePath,expectedVersions);
    if(comparison.message) void this.vscode.window.showWarningMessage(comparison.message);
    const choices=[
      ...(!readonly ? [{label:'保留本地内容',choice:'local',description:'使用已保存的源码，可以是手工合并后的结果'}] : []),
      {label:readonly ? '恢复平台原文' : '采用平台内容',choice:'remote',description:'以平台源码替换当前文件'},
      ...(!readonly && current.metadata?.sourceType!=='module-parameter' ? [
        {label:'打开原始源码手工合并',choice:'edit',description:'保存合并结果后，再次处理冲突并选择保留本地内容'},
      ] : []),
    ];
    const originalDiff={label:'查看原始源码对比',choice:'raw-diff'};
    const options={title:'选择冲突解决方式',placeHolder:'左侧为本地已保存版本，右侧为本次同步记录的平台版本'};
    let choice=await this.vscode.window.showQuickPick(comparison.view==='readable' ? [...choices,originalDiff] : choices,options);
    if(choice===originalDiff) {
      assertCurrentSource();
      await this.diffProvider.open(key,sourcePath,{...expectedVersions,view:'raw'});
      choice=await this.vscode.window.showQuickPick(choices,options);
    }
    if(!choice) return;
    if(!choices.includes(choice)) throw new Error('冲突处理方式无效');
    if(choice.choice==='edit') {
      assertCurrentSource();
      return this.openOriginalSources(key,sourcePath);
    }
    if(await this.vscode.window.showWarningMessage(`确认对 ${sourcePath} 执行“${choice.label}”？`,{modal:true},'确认解决')!=='确认解决') return;
    await this.editorState?.flush(key);
    const latest=await this.run(key,'conflict',conflictTarget);
    assertCurrentSource();
    if(latest.sourceHash!==inspection.sourceHash || latest.remoteHash!==inspection.remoteHash) throw new Error('确认期间冲突内容已变化，请重新比较');
    const result=await this.run(key,'resolve-conflict',{
      path:sourcePath,choice:choice.choice,expectedHash:inspection.sourceHash,expectedRemoteHash:inspection.remoteHash,
    });
    this.setIndexResult(key,result.index);
    await showReport(this.vscode,'API 冲突处理结果',[`对象：${sourcePath}`,`本地源码 SHA-256：${result.sourceHash || '未返回'}`,`操作编号：${result.operationId || '未返回'}`,'','此操作未上传谷神。']);
    await this.updateScm(key);this.onUpdated?.();return result;
  }
  clear(){this.treeView?.setScope?.(undefined);this.scopeGeneration++;for(const [key,generation] of this.scmGenerations)this.scmGenerations.set(key,generation+1);this.invalidate();this.treeCache.clear();this.treeLoads.clear();this.indexGenerations.clear();this.rootItems=null;for(const {control,refreshTimer} of this.controls.values()) {clearTimeout(refreshTimer);control.dispose();}this.controls.clear();this.sourceChanges.clear();this.stagedChanges.clear();this.scmUploadRequests.clear();this.scmUploadDrafts.clear();this.scmProjects.clear();for(const watcher of this.watchers.values()) watcher.dispose();this.watchers.clear();this.readonlyDocuments.clear();this.indexDiagnostics.clear();this.menuAttempts.clear();this.workspaces.clear();this.sourceNames.clear();this.filters.clear();this.decorationEmitter?.fire();this.refresh();}
  dispose(){if(this.disposed)return;this.disposed=true;this.clear();this.diffProvider.dispose();this.configurationListener?.dispose();this.emitter?.dispose();this.decorationEmitter?.dispose();}
}
module.exports={ApiSourceUI,READONLY_SCHEME,assertClean,buildCatalogTree,dirtyDocuments,filePath,identity,showReport,sourceLabel,sourceSyncLines,uploadRecoveryLines};

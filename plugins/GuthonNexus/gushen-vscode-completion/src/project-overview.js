const {ViewTree}=require('./view-tree');

class ProjectOverview {
  constructor({vscode}) {
    this.vscode=vscode;this.snapshot={workspaces:[],configErrors:[]};this.summaries=new Map();this.query='';this.loading=true;
    this.emitter=new vscode.EventEmitter();this.onDidChangeTreeData=this.emitter.event;
  }
  setSnapshot(snapshot,selectedKey,diagnosticKey='',setup) {
    this.setup=setup;
    this.snapshot=snapshot;this.selectedKey=selectedKey;this.diagnosticKey=diagnosticKey;this.error=undefined;this.errorDirectory=undefined;this.loading=false;
    for(const [key,record] of this.summaries) {
      const workspace=snapshot.workspaces.find(item=>item.workspaceKey===key);
      if(!workspace || JSON.stringify(workspace.workspaceBinding)!==record.binding)this.summaries.delete(key);
    }
    this.emitter.fire();
  }
  setError(error,directory) {this.setup=undefined;this.loading=false;this.errorDirectory=directory;this.error=error.message || String(error);this.snapshot={workspaces:[],configErrors:[]};this.selectedKey='';this.summaries.clear();this.emitter.fire();}
  setProjectError(key,error) {
    const workspace=this.snapshot.workspaces.find(item=>item.workspaceKey===key);
    const diagnostic={workspaceKey:key,name:workspace?.name,code:error.code || 'PROJECT_STATE_UNAVAILABLE',message:error.message || String(error)};
    this.snapshot={workspaces:this.snapshot.workspaces.filter(item=>item.workspaceKey!==key),
      configErrors:[...this.snapshot.configErrors.filter(item=>item.workspaceKey!==key),diagnostic]};
    this.diagnosticKey=key;this.selectedKey='';this.emitter.fire();
  }
  updateSummary(key,status) {
    const workspace=this.snapshot.workspaces.find(item=>item.workspaceKey===key);
    if(!workspace || workspace.sourceMode==='database')return;
    const files=status.files || status.changes || [];
    const changed=status.summaryComplete===false ? null : status.summary?.changedCount ?? (Array.isArray(status.changes)?status.changes.length:null);
    const conflict=files.some(file=>file.inScope!==false && file.state==='CONFLICT');
    this.summaries.set(key,{binding:JSON.stringify(workspace.workspaceBinding),changed,conflict});this.emitter.fire();
  }
  async search() {
    const query=await this.vscode.window.showInputBox({title:'搜索项目',prompt:'按项目名称、别名或 key 搜索；清空显示全部',value:this.query});
    if(query!==undefined){this.query=query.trim();if(this.view)this.view.message=this.query?'筛选：'+this.query:undefined;this.emitter.fire();}
  }
  getChildren() {
    if(this.loading)return [{kind:'loading',label:'正在读取项目…'}];
    if(this.setup)return [{kind:'setup',label:this.setup.action || '选择数据目录',message:this.setup.message}];
    if(this.error)return [{kind:'global',label:'工作空间配置不可用',message:this.error}];
    const rows=[...this.snapshot.workspaces.map(workspace=>({kind:'project',workspace,key:workspace.workspaceKey})),
      ...this.snapshot.configErrors.map(error=>({kind:'diagnostic',key:error.workspaceKey,error}))];
    const query=this.query.toLocaleLowerCase();
    const filtered=rows.filter(row=>!query || [row.key,row.workspace?.name,row.workspace?.displayName,...(row.workspace?.aliases || []),row.error?.name,row.error?.message].filter(Boolean).some(value=>value.toLocaleLowerCase().includes(query)));
    return filtered.length ? filtered : [{kind:'empty',label:query?'没有匹配项目，清空搜索查看全部':'尚未登记项目',message:query?'项目筛选不改变当前项目或操作范围':'通过“添加项目”选择同步方式并登记项目'}];
  }
  getTreeItem(row) {
    const v=this.vscode,key=row.key;
    const label=row.workspace?.name || row.workspace?.displayName || row.error?.name || key || row.label;
    const item=new v.TreeItem(label,v.TreeItemCollapsibleState.None);
    item.id='guthon-project-'+(key || row.kind);item.contextValue='guthonProject.'+row.kind;
    if(row.kind==='loading')return item;
    if(row.kind==='setup') {
      item.tooltip=row.message;
      item.command={command:'gushenCompletion.setupTool',title:label,arguments:[this.setup.directory?'current':'browse']};
      if(v.ThemeIcon)item.iconPath=new v.ThemeIcon('folder-opened');
      return item;
    }
    if(row.kind==='project') {
      const w=row.workspace,summary=this.summaries.get(key),mode=(w.sourceMode || 'api').toUpperCase();
      item.contextValue='guthonProject.project.'+mode.toLowerCase();
      const state=summary?.conflict?'有冲突':summary?.changed!=null?`${summary.changed} 修改`:w.executionReady===false?'此版本未接入': w.status==='FAILED'?'同步失败': '状态待检查';
      item.description=`${mode} · ${state}`;
      item.tooltip=[label,key,mode,w.root,w.index?.path].filter(Boolean).join('\n');
      item.command={command:'gushenCompletion.switchWorkspace',title:'选择当前项目',arguments:[key]};
      if(v.ThemeIcon)item.iconPath=new v.ThemeIcon(this.selectedKey===key?'pass-filled':'project');
    } else if(row.kind==='diagnostic') {
      item.description='配置异常';item.tooltip=[key,row.error.code,row.error.message].join('\n');
      item.command={command:'gushenCompletion.switchWorkspace',title:'查看项目诊断',arguments:[key]};
      if(v.ThemeIcon)item.iconPath=new v.ThemeIcon('warning');
    } else {
      item.tooltip=row.message;
      item.command={command:row.kind==='global'?'gushenCompletion.openProjectConfiguration':this.query?'gushenCompletion.searchProjects':'gushenCompletion.addWorkspace',title:row.kind==='global'?'检查配置':'项目操作',arguments:[]};
      if(v.ThemeIcon)item.iconPath=new v.ThemeIcon(row.kind==='global'?'error':'info');
    }
    return item;
  }
  diagnostic() {
    if(this.error)return {message:this.error,directory:this.errorDirectory,code:'CONFIG_UNAVAILABLE',workspaceKey:'',name:'工作空间配置不可用'};
    return this.snapshot.configErrors.find(item=>item.workspaceKey===this.diagnosticKey);
  }
  dispose(){this.emitter.dispose();}
}

function registerProjectOverview({vscode,context}) {
  const provider=new ProjectOverview({vscode});
  const id='gushenCompletion.projectOverview';
  const view=vscode.window.registerWebviewViewProvider
    ? new ViewTree({vscode,id,provider,title:'项目总览',extensionPath:context.extensionPath})
    : vscode.window.createTreeView(id,{treeDataProvider:provider});
  provider.view=view;
  return {provider,view,dispose(){view.dispose();provider.dispose();}};
}

module.exports={ProjectOverview,registerProjectOverview};

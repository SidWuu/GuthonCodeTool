const {randomBytes}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {contributes}=require('../package.json');

const commands=new Map(contributes.commands.map(command=>[command.command,command]));
const labels=title=>typeof title==='string'?title:title?.label || '';
function treeHtml(assetRoot) {
  const nonce=randomBytes(18).toString('base64');
  const read=name=>fs.readFileSync(path.join(assetRoot,'src',name),'utf8');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<style nonce="${nonce}">${read('view-tree.css')}</style></head><body>
<div id="tree" role="tree" tabindex="0"></div>
<aside id="menu" role="menu" hidden></aside>
<script nonce="${nonce}">${read('view-tree-webview.js')}</script></body></html>`;
}

function contextCommands(viewId, contextValue, vscode) {
  const applicable=[];
  for (const {when, command, group} of contributes.menus['view/item/context']) {
    const [view, item, config]=when.split(' && ');
    if (view!=='view == '+viewId || !contextValue) continue;
    if (item.startsWith('viewItem == ')) {
      if (item.slice('viewItem == '.length)!==contextValue) continue;
    } else {
      const pattern=/^viewItem =~ \/(.+)\/$/.exec(item);
      if (!pattern || !new RegExp(pattern[1]).test(contextValue)) continue;
    }
    if (config) {
      const setting=/^config\.gushenCompletion\.(\w+) == (\w+)$/.exec(config);
      if (!setting || vscode.workspace.getConfiguration('gushenCompletion').get(setting[1])!==setting[2]) continue;
    }
    const info=commands.get(command);
    applicable.push({command, label:info.shortTitle || info.title.replace(/^Guthon Nexus: /,''), group});
  }
  const order=entry=>Number(entry.group.split('@')[1]) || 0;
  applicable.sort((a,b)=>a.group.split('@')[0].localeCompare(b.group.split('@')[0]) || order(a)-order(b));
  return [...new Map(applicable.map(entry=>[entry.command,entry])).values()];
}

function identity(element, item) {
  return JSON.stringify([item.id, element.key, element.workspaceKey, element.svnNode?.path,
    element.svnNode?.id, element.object?.path, element.sourcePrefix, element.target?.jsonPointer,
    labels(item.label), element.object?.path ? undefined : item.contextValue]);
}

class ViewTree {
  constructor({vscode,id,provider,title,extensionPath}) {
    Object.assign(this,{vscode,id,provider,extensionPath});
    this.baseTitle=title;
    this.label=title;
    this.expanded=new Set();
    this.nodes=new Map();
    this.version=0;
    this.disposables=[vscode.window.registerWebviewViewProvider(id,this,{webviewOptions:{retainContextWhenHidden:true}})];
    if(provider.onDidChangeTreeData) this.disposables.push(provider.onDidChangeTreeData(()=>this.refresh()));
  }
  get selection() {
    const current=this.nodes.get(this.selected);
    return current?[current.element]:[];
  }
  get message() {return this.notice;}
  set message(value) {this.notice=value;this.refresh();}
  get title() {return this.label;}
  set title(value) {
    this.label=value;
    if(this.view) this.view.description=this.projectDescription;
  }
  get projectDescription() {
    return this.label.startsWith(this.baseTitle+' · ') ? this.label.slice(this.baseTitle.length+3) : undefined;
  }
  setScope(value) {
    if(value===this.scope)return;
    this.scope=value;
    this.version++;
    this.expanded.clear();
    this.selected=undefined;
    this.pendingReveal=undefined;
    this.nodes.clear();
  }
  resolveWebviewView(view) {
    this.view=view;
    view.description=this.projectDescription;
    this.ready=false;
    view.webview.options={enableScripts:true,localResourceRoots:[]};
    const listener=view.webview.onDidReceiveMessage(message=>{
      void this.receive(message).catch(error=>this.vscode.window.showErrorMessage(error.message));
    });
    view.onDidDispose(()=>{listener.dispose();if(this.view===view){this.view=undefined;this.ready=false;this.version++;}});
    view.webview.html=treeHtml(this.extensionPath);
  }
  refresh() {
    void this.render().catch(error=>this.vscode.window.showErrorMessage(error.message));
  }
  async render(reveal=[],focus=false) {
    if(!this.ready || !this.view)return false;
    const generation=++this.version,view=this.view;
    const nodes=new Map(), rows=[];
    let revealed;
    const visit=async(parent, parentId, depth, route)=>{
      const elements=await this.provider.getChildren(parent);
      if(generation!==this.version)return;
      const copies=new Map();
      const target=route.length?identity(route[0],this.provider.getTreeItem(route[0])):undefined;
      for(const element of elements) {
        const item=this.provider.getTreeItem(element);
        const key=identity(element,item), duplicate=copies.get(key)||0;
        copies.set(key,duplicate+1);
        const id=parentId+'/'+key+':'+duplicate;
        const capable=!!item.collapsibleState;
        const follows=target===key;
        if(follows && route.length>1)this.expanded.add(id);
        if(follows && route.length===1)revealed=id;
        const open=capable && this.expanded.has(id);
        nodes.set(id,{element,item,parentId});
        rows.push({id,parentId,depth,label:labels(item.label),code:item.guthonCode,description:typeof item.description==='string'?item.description:'',
          tooltip:typeof item.tooltip==='string'?item.tooltip:labels(item.label), icon:item.iconPath?.id,
          color:item.iconPath?.color?.id,capable,open,action:!!item.command,
          status:element.kind==='empty' || element.kind==='loading'});
        if(open)await visit(element,id,depth+1,follows?route.slice(1):[]);
        if(generation!==this.version)return;
      }
    };
    let error;
    try {await visit(undefined,'',0,reveal);}
    catch(reason) {error=reason.message;nodes.clear();rows.length=0;}
    if(generation!==this.version || view!==this.view)return false;
    this.nodes=nodes;
    this.publishedGeneration=generation;
    if(revealed)this.selected=revealed;
    if(!nodes.has(this.selected))this.selected=undefined;
    await view.webview.postMessage({type:'tree',generation,rows,title:this.title,
      selected:this.selected,reveal:revealed,focus,notice:this.notice,error});
    return !!revealed;
  }
  async receive(message) {
    if(message?.type==='ready'){
      this.ready=true;
      const pending=this.pendingReveal;
      this.pendingReveal=undefined;
      await this.render(pending?.route,pending?.focus);
      return;
    }
    if(message?.generation!==this.publishedGeneration)return;
    const {type,id,command}=message;
    const node=this.nodes.get(id);
    if(node) {
      this.selected=id;
      if(type==='toggle' && node.item.collapsibleState) {
        if(this.expanded.has(id))this.expanded.delete(id);else this.expanded.add(id);
        await this.render();
      } else if(type==='open' && node.item.command) {
        await this.vscode.commands.executeCommand(node.item.command.command,...(node.item.command.arguments || []));
      } else if(type==='menu'){
        await this.view.webview.postMessage({type:'menu',id,generation:this.publishedGeneration,
          items:contextCommands(this.id,node.item.contextValue,this.vscode)});
      } else if(type==='context' && contextCommands(this.id,node.item.contextValue,this.vscode).some(item=>item.command===command)){
        await this.vscode.commands.executeCommand(command,node.element);
      }
    }
  }
  async reveal(element,{focus=true}={}) {
    const route=[element];
    for(let parent=await this.provider.getParent?.(element);parent;parent=await this.provider.getParent(parent))route.unshift(parent);
    if(!this.ready || !this.view){
      this.pendingReveal={route,focus};
      await this.vscode.commands.executeCommand(this.id+'.focus');
      return;
    }
    this.view.show(!focus);
    if(!await this.render(route,focus))throw new Error('目标节点已不在当前树中，请刷新后重试');
  }
  async setExpanded(value) {
    const node=this.nodes.get(this.selected);
    if(!node)return false;
    if(value && node.item.collapsibleState)this.expanded.add(this.selected);
    else if(!value && !this.expanded.delete(this.selected) && node.parentId){
      this.expanded.delete(node.parentId);this.selected=node.parentId;
    }
    await this.render();
    return true;
  }
  async collapseAll() {this.expanded.clear();await this.render();}
  dispose() {
    this.version++;
    this.ready=false;
    for(const disposable of this.disposables)disposable.dispose();
    this.view=undefined;
  }
}

module.exports={ViewTree,treeHtml,contextCommands};

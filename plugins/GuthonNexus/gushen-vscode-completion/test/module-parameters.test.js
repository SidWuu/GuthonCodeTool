const test=require('node:test'),assert=require('node:assert/strict');
const {ApiSourceUI,buildCatalogTree,identity}=require('../src/api/source-ui');
const vscode={TreeItem:class{constructor(label,state){this.label=label;this.collapsibleState=state;}},TreeItemCollapsibleState:{Collapsed:1,None:0},
 ThemeIcon:class{constructor(id,color){this.id=id;this.color=color;}},ThemeColor:class{constructor(id){this.id=id;}}};
function tree() {
 const object=(path,sourceType,extra={})=>({path,sourceType,name:'对象',sourceId:'ID',...extra});
 return buildCatalogTree('projects.A',{},[
  object('systems/A/pages/G/P/P.xml','page'),object('datasources/D/procedures/com/demo/f.gss','procedure'),
  object('datasources/D/tables/T.json','table'),object('datasources/D/views/V.xml','view'),
  object('systems/A/system-script/1.js','system-script'),
  object('systems/A/module-parameters/demo.config.json','module-parameter',{sourceId:'demo.config',name:'参数甲',readonly:true}),
  object('otherconfig/bill-type.md','bill-type',{referenceId:'D:BT',dataSourceId:'D',readonly:true}),
  object('otherconfig/dropdown.md','dropdown',{referenceId:'C1',readonly:true}),
  object('skills/platform-kit/apis/javascript/self.md','skill',{readonly:true}),
 ],{systems:[{systemId:'A',systemName:'系统甲'}]});
}
test('all source modules and their descendants use theme-aware icon colours',()=>{
 const ui=new ApiSourceUI({vscode,run:async()=>{}}),roots=tree();assert.equal(roots.length,9);
 for(const root of roots) {
  const icon=ui.getTreeItem(root).iconPath;assert.match(icon.color.id,/^charts\./);
  let child=root.children[0];assert.equal(ui.getTreeItem(child).iconPath.color.id,icon.color.id);
  while(child.children?.length)child=child.children[0];
  assert.equal(ui.getTreeItem(child).iconPath.color.id,icon.color.id);
 }
});
test('module parameters group by subsystem, retain code and open editable data with readonly original',()=>{
 const ui=new ApiSourceUI({vscode,run:async()=>{}}),root=tree().find(x=>x.label==='模块参数');
 assert.equal(root.children[0].label,'系统甲');const leaf=root.children[0].children[0];assert.equal(leaf.label,'demo.config · 参数甲');
 const item=ui.getTreeItem(leaf);assert.equal(item.contextValue,'guthonApi.module-parameter');
 assert.equal(item.command.command,'gushenCompletion.editModuleParameter');assert.equal(item.command.arguments[0].path,leaf.object.path);
 assert.deepEqual(identity(root),{key:'projects.A',path:undefined});
 const menus=require('../package.json').contributes.menus['view/item/context'];
 assert(menus.some(x=>x.command==='gushenCompletion.syncModuleParameters'&&x.when.includes('category.module-parameters')));
 assert(menus.some(x=>x.command==='gushenCompletion.uploadModuleParameters'&&x.when.includes('module-parameter')));
 assert(!menus.some(x=>x.command==='gushenCompletion.uploadApiSource'&&x.when.includes('module-parameter')));
});
test('SCM conflict and modification colours take priority over module colours',()=>{
 const ui=new ApiSourceUI({vscode,run:async()=>{}}),root=tree().find(x=>x.label==='模块参数'),leaf=root.children[0].children[0];
 ui.sourceChanges.set('projects.A',new Map([[leaf.object.path,'CONFLICT']]));
 assert.equal(ui.getTreeItem(leaf).iconPath.color.id,'editorError.foreground');
 ui.sourceChanges.set('projects.A',new Map([[leaf.object.path,'MODIFIED']]));
 assert.equal(ui.getTreeItem(leaf).iconPath.color.id,'gitDecoration.modifiedResourceForeground');
});

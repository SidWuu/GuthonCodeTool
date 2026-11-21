const MODULE_STYLES={
  pages:{label:'页面',icon:'layout',color:'charts.blue'},
  procedures:{label:'过程函数',icon:'symbol-method',color:'charts.purple'},
  tables:{label:'表',icon:'table',color:'charts.green'},
  views:{label:'视图',icon:'symbol-structure',color:'charts.yellow'},
  'system-script':{label:'系统脚本',icon:'code',color:'charts.orange'},
  'module-parameters':{label:'模块参数',icon:'settings-gear',color:'charts.purple'},
  'bill-type':{label:'单据类型',icon:'symbol-enum',color:'charts.yellow'},
  dropdown:{label:'下拉组件',icon:'list-selection',color:'charts.orange'},
  skills:{label:'开发参考',icon:'book',color:'charts.blue'},
  public:{label:'其他源码',icon:'file-code',color:'descriptionForeground'},
};
const SOURCE_CATEGORIES={page:'pages',procedure:'procedures',table:'tables',view:'views',
  'system-script':'system-script','module-parameter':'module-parameters','bill-type':'bill-type',dropdown:'dropdown',
  skill:'skills',public:'public'};

function sourceTreeIcon(vscode, category, icon) {
  const style=MODULE_STYLES[category];
  return new vscode.ThemeIcon(icon || style?.icon || 'file-code',
    style && vscode.ThemeColor ? new vscode.ThemeColor(style.color) : undefined);
}

function sourceTreeIdentity(name, code, fallback) {
  const caption=String(name || '').trim();
  const identity=String(code || '').trim();
  return {label:caption || identity || fallback,code:caption && caption!==identity ? identity : ''};
}

function datasourceTreeName(name) {
  return ['贸易','国内贸易','国际贸易'].includes(name) ? '贸易系统' : name;
}

function sourceGroupDatasourceId(groups, category, code, name) {
  if (['pages', 'system-script', 'module-parameters'].includes(category)) {
    return groups?.dataSourceIdsBySystem?.[code || groups.systemIdsByName?.[name]];
  }
  if (['procedures', 'tables', 'views', 'bill-type'].includes(category)) {
    return code || groups?.dataSourceIdsByName?.[name];
  }
}

const datasourceCollator=new Intl.Collator('en',{numeric:true});
function compareDatasourceIds(left,right) {
  return !left || !right ? Number(!left)-Number(!right) : datasourceCollator.compare(left,right);
}

module.exports={MODULE_STYLES,SOURCE_CATEGORIES,sourceTreeIcon,sourceTreeIdentity,datasourceTreeName,sourceGroupDatasourceId,compareDatasourceIds};

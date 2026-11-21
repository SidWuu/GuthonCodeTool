const crypto=require('node:crypto');
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
function contract(manifest,bundle) {
  return {version:manifest.version,minDateVersion:manifest.guthonConfig?.minDateVersion || null,
    commands:Object.fromEntries((manifest.contributes?.commands || []).map(item=>[item.command,item.title])),
    customEditors:manifest.contributes?.customEditors || [],languages:manifest.contributes?.languages || [],
    grammars:manifest.contributes?.grammars || [],
    endpoints:[...new Set(bundle.match(/\/develop\/[A-Za-z0-9_./-]+\.htm/g) || [])].sort()};
}
function changes(before,after) {
  const left=before || {},right=after || {};
  return {added:Object.keys(right).filter(key=>!Object.hasOwn(left,key)),
    removed:Object.keys(left).filter(key=>!Object.hasOwn(right,key)),
    changed:Object.keys(right).filter(key=>Object.hasOwn(left,key) && digest(left[key])!==digest(right[key]))};
}
function apiEntries(catalog) {
  return Object.fromEntries(Object.entries(catalog.modules).flatMap(([name,module])=>
    module.functions.map(fn=>[name+'.'+fn.label,{doc:fn.doc,params:fn.params}])));
}
function assessOfficial(baseline,next,previousCatalog,nextCatalog) {
  const commandChanges=changes(baseline.commands,next.commands),apiChanges=changes(apiEntries(previousCatalog),apiEntries(nextCatalog));
  const surfaces=['customEditors','languages','grammars','endpoints','minDateVersion']
    .filter(key=>digest(baseline[key])!==digest(next[key]));
  const excluded=baseline.unnecessaryCommands || [];
  const unnecessary=next.version===baseline.version ? excluded.filter(key=>Object.hasOwn(next.commands,key)) : [];
  return {baselineVersion:baseline.version,upstreamVersion:next.version,commandChanges,apiChanges,surfaces,
    implemented:Object.keys(next.commands).filter(key=>Object.hasOwn(baseline.commands,key) && !commandChanges.changed.includes(key) && !excluded.includes(key)),
    pending:[...commandChanges.added,...commandChanges.changed,...surfaces.map(key=>'contract:'+key),...excluded.filter(key=>Object.hasOwn(next.commands,key) && !unnecessary.includes(key))],
    unnecessary,
    verification:'命令入口对应不等同协议或实机验收；变化需由 Nexus 适配并验证，未运行官方可执行代码'};
}
function assessmentMarkdown(result) {
  const list=values=>values.length ? values.map(value=>'- '+value).join('\n') : '- 无';
  return `## 官方版本差异评估\n\n比较基线：${result.baselineVersion}；本次来源：${result.upstreamVersion}\n\n`+
    `已有对应入口：${result.implemented.length} 项（代码适配状态，实机验收另行记录）。\n\n`+
    `待适配或核验：\n${list(result.pending)}\n\n已移除的上游命令：\n${list(result.commandChanges.removed)}\n\n`+
    `无需直接采用：\n${list(result.unnecessary)}\n\n`+
    `API 资源：新增 ${result.apiChanges.added.length}，移除 ${result.apiChanges.removed.length}，文档或参数变化 ${result.apiChanges.changed.length}。\n`+
    `${list([...result.apiChanges.added,...result.apiChanges.removed,...result.apiChanges.changed])}\n\n`+
    `${result.verification}。兼容的 API 静态资源按下方实际结果生效；协议、命令、设计器及语法变化不会自动启用。\n`;
}
module.exports={contract,changes,assessOfficial,assessmentMarkdown};

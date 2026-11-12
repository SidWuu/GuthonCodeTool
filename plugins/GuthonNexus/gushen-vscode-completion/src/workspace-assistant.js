const {sourceModeLabel}=require('./source-mode');

function workspaceCockpit(item) {
  const indexReady=Boolean(item.index?.ready);
  return {label:`${sourceModeLabel(item.sourceMode)} 源码`,description:indexReady ? '索引可用' : '索引待建立',icon:'code',rows:[
    {label:`本地事实索引：${indexReady ? '可用' : '待建立'}`,description:indexReady ? '索引快照可供搜索' : '点击重建索引',
      icon:indexReady ? 'pass-filled' : 'warning',command:indexReady ? 'gushenCompletion.searchWorkspace' : 'gushenCompletion.reindexCalls'},
    {label:'查看当前源码状态',description:'仅当前项目',icon:'info',command:'gushenCompletion.showApiStatus'},
  ]};
}

function searchPickItems(result) {
  return (result?.items || []).map((item) => ({
    label: item.label,
    description: item.description,
    detail: item.detail,
    buttons: [],
    item,
  }));
}

module.exports = { searchPickItems, workspaceCockpit };

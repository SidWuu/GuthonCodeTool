(function (root) {
  function build(target) {
    const identity = { dataSourceId: target.dataSourceId || '', systemId: target.systemId || '' };
    if (target.mode === 'page-source') {
      if (!target.pageId) throw new Error('未识别到当前 PAGE ID，请先选择页面');
      return { ...identity, sourceType: 'page', pageId: target.pageId, sourceId: target.pageId };
    }
    if (!target.mode || target.mode === 'procedure') {
      const alias = target.procedureKeyword || target.procedureName || '';
      if ((!target.procedureId && !alias) || !target.funId) throw new Error('未识别到完整的过程包和函数，请先选择函数');
      return { ...identity, sourceType: 'procedure', sourceId: target.procedureId || '', procedureId: target.procedureId || '', alias, funId: target.funId };
    }
    const modes = {
      'table-schema': ['table', 'tableIds'],
      views: ['view', 'viewIds'],
      'system-scripts': ['system-script', 'scriptTypes']
    };
    const spec = modes[target.mode];
    if (!spec) throw new Error('当前对象暂不支持 API 源码刷新');
    const selected = target[spec[1]];
    if (!Array.isArray(selected) || selected.length !== 1 || !selected[0]) throw new Error('请先选择一个具体对象，再刷新；不会自动拉取全部');
    if (spec[0] === 'system-script' ? !identity.systemId : !identity.dataSourceId) throw new Error('当前对象缺少应用系统或数据源身份');
    return { ...identity, sourceType: spec[0], sourceId: selected[0], ...(spec[0] === 'system-script' ? {scriptType: selected[0]} : {}) };
  }
  const api = { build };
  root.GuthonBridgeRefreshTarget = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);

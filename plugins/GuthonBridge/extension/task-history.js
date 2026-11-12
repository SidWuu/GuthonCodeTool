(function initializeTaskHistory(root) {
  const operations = new Set(['refresh-api-source']);
  const fields = ['sourceType','sourceId','pageId','procedureId','alias','funId','dataSourceId','systemId','scriptType'];
  function create(record, result, pageOrigin) {
    if (!operations.has(record?.operation) || result?.ok !== true
        || !/^\d{13}_[a-f0-9-]{36}$/.test(record?.requestId || '')
        || !/^(products|projects)\.[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(record.workspaceKey || '')) return null;
    const payload = {workspaceKey:record.workspaceKey};
    for (const key of fields) {
      const value = record.payload?.[key];
      if (value !== undefined) {
        if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) return null;
        payload[key] = value;
      }
    }
    return {requestId:record.requestId,workspaceKey:record.workspaceKey,pageOrigin,operation:record.operation,
      payload,completedAt:Date.now(),outputDir:typeof result.outputDir === 'string' ? result.outputDir.slice(0,2000) : ''};
  }
  function replay(entry, pageOrigin) {
    if (!entry || entry.pageOrigin !== pageOrigin) throw new Error('请在原谷神平台来源下重拉此对象');
    const sanitized = create(entry,{ok:true,outputDir:entry.outputDir},pageOrigin);
    if (!sanitized) throw new Error('历史对象身份无效或超出可重拉范围');
    return {type:sanitized.operation,payload:{...sanitized.payload,pageOrigin}};
  }
  function retain(records, entry) {
    return [entry,...(Array.isArray(records)?records:[]).filter(item=>item && Number.isFinite(item.completedAt) && item.requestId!==entry.requestId)]
      .sort((a,b)=>b.completedAt-a.completedAt).slice(0,20);
  }
  const api={create,replay,retain};root.GuthonBridgeTaskHistory=api;
  if(typeof module==='object' && module.exports)module.exports=api;
})(globalThis);

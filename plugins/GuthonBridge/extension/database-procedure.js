/* Executed only for a paired DATABASE request issued by the local Bridge. */
async function runDatabaseProcedure({action, target, evidence, systemId, dataSourceId}) {
  if (!['read', 'save'].includes(action) || location.origin !== target.origin || !/\/guthon\//.test(location.pathname)
      || systemId !== target.systemId || dataSourceId !== target.dataSourceId
      || !/^PR-[A-Za-z0-9-]{1,96}$/.test(target.procedureId)
      || !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(target.funId)) throw new Error('DATABASE 发布页签或对象身份不一致');
  const identity = {procedureId:target.procedureId, funId:target.funId};
  async function request(endpoint, fields, method = 'POST') {
    const response = await fetch(endpoint, {method, credentials:'include', redirect:'error',
      headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},
      ...(method === 'POST' ? {body:new URLSearchParams(fields)} : {}), signal:AbortSignal.timeout(12000)});
    if (!response.ok) throw new Error(`DATABASE 原生接口返回 HTTP ${response.status}`);
    const result = await response.json();
    if (typeof result?.code !== 'number') throw new Error('DATABASE 原生接口缺少状态码');
    return result;
  }
  async function read(endpoint, fields, method) {
    const result = await request(endpoint, fields, method);
    if (result.code !== 0 || !result.data) throw new Error('DATABASE 原生只读核对失败');
    return result.data;
  }
  const tree = await read('/develop/procedure/admin/getProcTree.htm', {dataSourceId});
  const parents = tree.list?.filter(row => row.procedureAliasId === target.procedureAlias);
  if (parents?.length !== 1 || parents[0].procedureId !== identity.procedureId) throw new Error('DATABASE 父过程不再唯一匹配');
  const {bean} = await read('/develop/procedure/admin/getFunInfo.htm', identity);
  if (bean?.funId !== identity.funId || (bean.procedureId && bean.procedureId !== identity.procedureId)
      || typeof bean.versionMac !== 'string' || !bean.versionMac || typeof bean.funScript !== 'string') {
    throw new Error('DATABASE 原生函数缺少已核验身份、版本或正文');
  }
  let canSave = false;
  if (action === 'save' || !evidence) {
    const login = await read('/develop/login/isLogin.htm', undefined, 'GET');
    canSave = typeof login.user?.userId === 'string' && !!login.user.userId && bean.checkOutUserId === login.user.userId;
  }
  if (action === 'read') return {...target, version:bean.versionMac, content:bean.funScript, canSave};
  if (!/^[0-9a-f]{64}$/.test(evidence?.operationId || '') || typeof evidence?.expectedVersion !== 'string'
      || !evidence.expectedVersion || typeof evidence.content !== 'string') throw new Error('缺少已确认的 DATABASE 保存候选');
  if (!canSave) return {operationId:evidence.operationId, rejected:'CHECKOUT_REQUIRED'};
  if (bean.versionMac !== evidence.expectedVersion) return {operationId:evidence.operationId, rejected:'PLATFORM_VERSION_CHANGED'};
  const bytes = new TextEncoder().encode(JSON.stringify({script:evidence.content}));
  if (bytes.byteLength > 400000) throw new Error('DATABASE 候选超出保存上限');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const result = await request('/develop/procedure/admin/saveFunScript.htm', {...identity,
    funScript:encodeURIComponent(btoa(binary)), isBase64:'1', flag:'0', versionMac:evidence.expectedVersion});
  if (result.code === 1 && /函数已被其他人修改/.test(result.message || '')) {
    return {operationId:evidence.operationId, rejected:'PLATFORM_VERSION_CHANGED'};
  }
  if (result.code !== 0) throw new Error('DATABASE 原生保存结果尚未核验');
  return {operationId:evidence.operationId, acknowledged:true};
}

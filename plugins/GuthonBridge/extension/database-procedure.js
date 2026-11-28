/* Executed only for a paired DATABASE request issued by the local Bridge. */
async function runDatabaseProcedure({action, target, evidence, systemId, dataSourceId}) {
  if (!['read', 'save'].includes(action) || location.origin !== target.origin || !/\/guthon\//.test(location.pathname)
      || systemId !== target.systemId || dataSourceId !== target.dataSourceId
      || ((action === 'save' || target.procedureId) && !/^PR-[A-Za-z0-9-]{1,96}$/.test(target.procedureId || ''))
      || !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(target.funId)) throw new Error('DATABASE 发布页签或对象身份不一致');
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
  if (parents?.length !== 1 || !/^PR-[A-Za-z0-9-]{1,96}$/.test(parents[0].procedureId || '')
      || (target.procedureId && parents[0].procedureId !== target.procedureId)) throw new Error('DATABASE 父过程不再唯一匹配');
  const identity = {procedureId:parents[0].procedureId, funId:target.funId};
  function comparableScript(content) {
    const normalized = content.replace(/\r\n?/g, '\n');
    return normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  }
  function effectiveScript(bean) {
      const raw = bean.funScript.replaceAll('\r\n', '\n');
      const marker = /^[ \t]*(?:return[ \t]+)?@?inherit\(\);[ \t]*(?=\n?$)/.exec(raw);
      return marker && typeof bean.prodScript === 'string'
          ? bean.prodScript.replaceAll('\r\n', '\n').replace(/[\r\n]+$/, '') + raw.slice(marker[0].length)
          : raw;
  }
  async function readFunction() {
      const {bean} = await read('/develop/procedure/admin/getFunInfo.htm', identity);
      if (bean?.funId !== identity.funId || (bean.procedureId && bean.procedureId !== identity.procedureId)
          || typeof bean.versionMac !== 'string' || !bean.versionMac || typeof bean.funScript !== 'string') {
          throw new Error('DATABASE 原生函数缺少已核验身份、版本或正文');
      }
      return bean;
  }
  const bean = await readFunction();
  if (action === 'read' && evidence) {
      return {...target, ...identity, version:bean.versionMac, content:effectiveScript(bean)};
  }
  const login = await read('/develop/login/isLogin.htm', undefined, 'GET');
  const userId = login.user?.userId;
  const blockedReason = typeof userId !== 'string' || !userId ? 'PLATFORM_LOGIN_REQUIRED'
      : bean.checkOutUserId && bean.checkOutUserId !== userId ? 'CHECKED_OUT_BY_OTHER' : undefined;
  if (action === 'read') {
      return {...target, ...identity, version:bean.versionMac, content:effectiveScript(bean), canSave:!blockedReason, blockedReason};
  }
  if (!/^[0-9a-f]{64}$/.test(evidence?.operationId || '') || typeof evidence?.expectedVersion !== 'string'
      || !evidence.expectedVersion || typeof evidence.content !== 'string') throw new Error('缺少已确认的 DATABASE 保存候选');
  const {operationId, expectedVersion, expectedContent} = evidence;
  if (blockedReason) return {operationId, rejected:blockedReason};
  if (bean.versionMac !== expectedVersion) return {operationId, rejected:'PLATFORM_VERSION_CHANGED'};
  const baseContent = effectiveScript(bean);
  if (typeof expectedContent === 'string' && comparableScript(baseContent) !== comparableScript(expectedContent)) {
      return {operationId, rejected:'PLATFORM_CONTENT_CHANGED'};
  }
  const funScript = JSON.stringify({script:evidence.content});
  if (new TextEncoder().encode(funScript).byteLength > 400000) throw new Error('DATABASE 候选超出保存上限');
  if (!bean.checkOutUserId) {
      let checkout, checked;
      try {
          checkout = await request('/develop/procedure/admin/checkOut.htm', identity);
          checked = await readFunction();
      } catch {
          return {operationId, rejected:'CHECKOUT_UNVERIFIED'};
      }
      if (checked.checkOutUserId && checked.checkOutUserId !== userId) {
          return {operationId, rejected:'CHECKED_OUT_BY_OTHER'};
      }
      if (checkout.code !== 0 || checked.checkOutUserId !== userId) {
          return {operationId, rejected:'CHECKOUT_UNVERIFIED'};
      }
      if (checked.versionMac !== expectedVersion) return {operationId, rejected:'PLATFORM_VERSION_CHANGED'};
      if (comparableScript(effectiveScript(checked)) !== comparableScript(baseContent)) {
          return {operationId, rejected:'PLATFORM_CONTENT_CHANGED'};
      }
  }
  const result = await request('/develop/procedure/admin/saveFunScript.htm', {...identity,
    funScript, flag:'0', versionMac:expectedVersion});
  if (result.code === 1 && /函数已被其他人修改/.test(result.message || '')) {
    return {operationId, rejected:'PLATFORM_VERSION_CHANGED'};
  }
  if (result.code !== 0) return {operationId, rejected:'PLATFORM_SAVE_REJECTED', platformCode:result.code};
  return {operationId, acknowledged:true};
}

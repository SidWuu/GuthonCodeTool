(function initializeBridgeTasks(root) {
  const operations = new Set(['pull-hub-source', 'export-table-schema', 'export-bill-type', 'export-view-sql', 'export-system-scripts', 'query-procedure-callers']);
  const waits = new Map();
  const running = new Map();
  const sendDefault = (message) => root.chrome.runtime.sendMessage(message);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function wait(record, send = sendDefault, onStatus = () => {}) {
    if (waits.has(record.requestId)) return waits.get(record.requestId);
    const pending = (async () => {
      const deadline = Date.now() + 2 * 60 * 60 * 1000;
      let latest;
      let failures = 0;
      while (Date.now() < deadline) {
        try {
          latest = await send({ type: 'bridge-job-status', payload: record });
          if (!latest?.ok) throw new Error(latest?.message || '任务状态不可用');
          failures = 0;
          onStatus(latest);
          if (['COMPLETED', 'FAILED', 'UNKNOWN'].includes(latest.state)) {
            if (latest.state === 'COMPLETED' && latest.result?.ok === true) {
              // A history storage failure must not turn a confirmed operation
              // into an unknown write or cause a replay.
              try { await send({type:'bridge-history-save',payload:{record,result:latest.result}}); } catch {}
            }
            await send({type:'bridge-pending-remove', payload:record});
            if (latest.state === 'COMPLETED') return latest.result;
            return {ok:false, resultUnknown:latest.state==='UNKNOWN', message:latest.message || '任务失败'};
          }
        } catch (error) {
          // Polling only reads an existing durable request; it never replays a write.
          failures += 1;
          if (failures >= 3) return {ok:false, taskPending:true, message:`任务仍可恢复：${error.message}。重新打开扩展弹窗可查询原任务。`};
        }
        await delay(1000);
      }
      return {ok:false, taskPending:true, message:'任务等待已结束；重新打开扩展弹窗查询原任务，禁止重复发起写入。'};
    })().finally(() => waits.delete(record.requestId));
    waits.set(record.requestId, pending);
    return pending;
  }
  async function perform(type, payload, send = sendDefault) {
    if (!operations.has(type)) return send({type,payload});
    let workspaceKey = payload.workspaceKey;
    if (!workspaceKey) {
      const route = await send({type:'route-workspace',payload});
      if (!route?.ok) return route;
      workspaceKey = route.workspaceKey;
    }
    const fixedPayload = {...payload, workspaceKey};
    const identity = JSON.stringify([type,fixedPayload]);
    const stored = await send({type:'bridge-pending-list',payload:{}});
    const existing = (stored.records || []).find((item) => item.identity === identity);
    if (existing) return wait(existing,send);
    const record = {requestId:`${Date.now()}_${crypto.randomUUID()}`,workspaceKey,
      pageOrigin:payload.pageOrigin,identity,operation:type,payload:fixedPayload};
    const saved=await send({type:'bridge-pending-save',payload:record});
    if(!saved?.ok)return {ok:false,message:saved?.message||'任务恢复信息保存失败，尚未提交写入'};
    if(saved.record && saved.record.requestId!==record.requestId)return wait(saved.record,send);
    let submitted;
    try { submitted = await send({type:'bridge-submit-job',payload:record}); }
    catch (error) { return {ok:false,taskPending:true,message:`任务提交状态未知：${error.message}。保留请求标识，请在弹窗查询，勿重复执行。`}; }
    if (!submitted?.ok) {
      // A lost submission response is ambiguous. Keep the record and only poll.
      return {ok:false,taskPending:true,message:submitted?.message || '提交状态未知，请在弹窗恢复查询'};
    }
    return wait(record,send);
  }
  function run(type, payload, send = sendDefault) {
    const key = JSON.stringify([type, payload]);
    if (running.has(key)) return running.get(key);
    const pending = perform(type, payload, send).finally(() => {
      if (running.get(key) === pending) running.delete(key);
    });
    running.set(key, pending);
    return pending;
  }
  async function resume(send = sendDefault, onStatus = () => {}) {
    const stored = await send({type:'bridge-pending-list',payload:{}});
    return Promise.all((stored.records || []).map((record) => wait(record,send,onStatus)));
  }
  const api = {run,resume,wait,isLongOperation:(type)=>operations.has(type)};
  root.GuthonBridgeTasks = api;
  if (typeof module === 'object' && module.exports) module.exports=api;
})(globalThis);

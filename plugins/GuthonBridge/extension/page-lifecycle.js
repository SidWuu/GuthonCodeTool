/* Injected only by the authenticated extension worker; never registered as a window-message command. */
async function runPageLifecycle(payload) {
    let dispatched = false;
    const clean = value => Object.fromEntries(['pageId', 'pageType', 'pageName', 'pageAliasId', 'title', 'systemId', 'mkId', 'version', 'isProduct', 'accessTag', 'bntAuth', 'runInTran', 'isCanInter', 'isTextResponse']
      .filter(key => ['string', 'number', 'boolean'].includes(typeof value?.[key])).map(key => [key, value[key]]));
    const checked = async (url, body) => {
      const response = await fetch(url, {method:'POST', credentials:'include',
        headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},
        body:new URLSearchParams(Object.entries(body).filter(([,value])=>value !== undefined && value !== null).map(([key,value])=>[key,String(value)])),
        signal:AbortSignal.timeout(30000)});
      if (!response.ok) throw new Error('平台请求失败');
      const result = await response.json();
      if (result.code && result.code !== 0) throw new Error(String(result.message || '平台拒绝 PAGE 操作').slice(0, 512));
      if (!result.data || typeof result.data !== 'object') throw new Error('平台没有返回有效数据回执');
      return result.data;
    };
    try {
      if (!['inspect', 'create', 'copy', 'delete'].includes(payload?.action)) throw new Error('无效 PAGE 生命周期操作');
      if (location.origin !== payload.expectedOrigin || !/\/guthon\//.test(location.pathname)) throw new Error('平台来源或路径已变化');
      const instances = [...new Set(Array.from(document.querySelectorAll('*')).map(element => element.__vue__ || element.__vueParentComponent?.proxy).filter(Boolean))];
      const currentSystems = new Set(instances.map(instance => instance.$store?.state?.modeDev?.systemId).filter(Boolean));
      const systems = new Set((payload.systemIds || []).filter(id => currentSystems.has(id)));
      if (!systems.size) throw new Error('平台当前系统与工作区上下文不匹配');
      const modules = new Map();
      for (const vm of instances) {
        if (!Array.isArray(vm.data) || typeof vm.getTreeNodeData !== 'function') continue;
        let count = 0;
        const pending=[...vm.data], seen=new Set();
        while(pending.length) {
          const node=pending.pop();
          if (!node || typeof node !== 'object' || seen.has(node)) continue;
          seen.add(node);
          if (++count > 2000 || modules.size >= 64) break;
          const item = node.item;
          if (node.t === 2 && item?.mkId && systems.has(item.systemId)) modules.set(item.mkId, {systemId:item.systemId, mkId:item.mkId, name:item.mkName || node.label || ''});
          if (Array.isArray(node.children)) pending.push(...node.children);
        }
      }
      let page, sourceVersion;
      if (payload.pageId) {
        if (!/^PG-[A-Za-z0-9-]{1,96}$/.test(payload.pageId)) throw new Error('PAGE 身份无效');
        page = (await checked('/develop/dev/pages/getPageBaseInfo.htm', {pageId:payload.pageId})).page;
        if (page?.pageId !== payload.pageId || !systems.has(page.systemId)) throw new Error('PAGE 不属于当前平台系统上下文');
        const source = await checked('/develop/dev/pages/getPageModuleXml.htm', {pageId:payload.pageId});
        if (source.version === undefined || source.version === null) throw new Error('平台未返回 PAGE 源码版本，不能取得生命周期租约');
        sourceVersion = String(source.version);
      }
      if (payload.action === 'inspect') return {state:'SUCCEEDED', page:clean(page), sourceVersion, modules:[...modules.values()], systemIds:[...systems]};
      if (['copy', 'delete'].includes(payload.action)) {
        if (!page || sourceVersion !== payload.expectedVersion) throw new Error('PAGE 源码版本已变化，请重新预览');
        const metadata = clean(page), expected = payload.expectedPage;
        if (!expected || Object.keys(metadata).some(key => metadata[key] !== expected[key]) || Object.keys(expected).some(key => expected[key] !== metadata[key])) throw new Error('PAGE 元数据已变化，请重新预览');
        for (const vm of instances) if (vm.pageId === page.pageId && vm.page?.getPageVersion && vm.version && vm.page.getPageVersion(true) !== vm.version) {
          throw new Error('平台存在未保存的 PAGE 草稿，请先处理');
        }
      }
      if (payload.action === 'delete') {
        if (page.isProduct) throw new Error('产品 PAGE 不允许删除');
        dispatched = true;
        await checked('/develop/dev/pages/remove.htm', {pageId:page.pageId});
        return {state:'SUCCEEDED', action:'delete', page:clean(page), platformApplied:true};
      }
      const keys = ['systemId','mkId','pageType','pageName','pageAliasId','title','accessTag','bntAuth','runInTran','isCanInter','isTextResponse','pageTemplateType'];
      const properties = payload.properties || {};
      if (Object.keys(properties).some(key => !keys.includes(key))) throw new Error('未知 PAGE 创建属性');
      const form = payload.action === 'copy' ? Object.fromEntries(keys.filter(key => page[key] !== undefined).map(key => [key,page[key]]))
        : {accessTag:10,runInTran:0,isCanInter:0,isTextResponse:0,pageTemplateType:0};
      Object.assign(form, properties);
      if (payload.action === 'copy' && form.pageType !== page.pageType) throw new Error('复制页面不能改变原页面类型');
      if (form.accessTag === 500) form.isCanInter = 1;
      if (!systems.has(form.systemId) || !modules.has(form.mkId) || modules.get(form.mkId).systemId !== form.systemId) throw new Error('目标模块不在当前已加载的系统目录内，请刷新平台模块树');
      if (!Number.isInteger(form.pageType) || form.pageType < 0 || form.pageType > 6 || !form.pageName?.trim()) throw new Error('必须指定平台页面类型和名称');
      if (![1,5].includes(form.pageType) && !form.pageAliasId?.trim()) throw new Error('此页面类型必须指定别名');
      if (![0,5].includes(form.pageType) && !form.title?.trim()) throw new Error('此页面类型必须指定显示标题');
      if (payload.action === 'copy') {form.pageId=page.pageId;form.xml=null;}
      dispatched = true;
      const saved = await checked(payload.action === 'copy' ? '/develop/dev/models/pastePageInfo.htm' : '/develop/dev/pages/savePages.htm', form);
      const created = saved.bean || saved.page;
      return {state:created?.pageId && created.pageId !== page?.pageId ? 'SUCCEEDED' : 'APPLIED_UNVERIFIED',
        action:payload.action, page:clean(created), platformApplied:true,
        message:created?.pageId ? '' : '平台已返回成功，但未提供新 PAGE 身份；先核对模块树，禁止重试写入'};
    } catch (error) {
      return {state:dispatched ? 'UNKNOWN' : 'REJECTED', platformApplied:dispatched ? null : false,
        message:String(error.message || error).slice(0,512)};
    }
  }
if (typeof module === "object" && module.exports) module.exports = {runPageLifecycle};

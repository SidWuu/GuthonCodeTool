/* Injected only by the authenticated extension worker; never registered as a window-message command. */
async function runPageLifecycle(payload) {
    let dispatched = false;
    const databasePage = ['database-read', 'database-save'].includes(payload?.action);
    const clean = value => Object.fromEntries(['pageId', 'pageType', 'pageName', 'pageAliasId', 'title', 'systemId', 'mkId', 'version', 'isProduct', 'accessTag', 'bntAuth', 'runInTran', 'isCanInter', 'isTextResponse']
      .filter(key => ['string', 'number', 'boolean'].includes(typeof value?.[key])).map(key => [key, value[key]]));
    const checked = async (url, body, {allowEmpty = false, saveReply = false} = {}) => {
      const response = await fetch(url, {method:'POST', credentials:'include',
        headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},
        body:new URLSearchParams(Object.entries(body).filter(([,value])=>value !== undefined && value !== null).map(([key,value])=>[key,String(value)])),
        signal:AbortSignal.timeout(30000)});
      const endpoint = url.split('/').at(-1);
      if (!response.ok) throw new Error(`${endpoint} 返回 HTTP ${response.status}`);
      const raw = await response.text();
      if (!raw.trim()) {
        if (allowEmpty) return null;
        throw new Error(`${endpoint} 返回空响应`);
      }
      let result;
      try {
        const text = databasePage ? raw.replace(/("(?:\\.|[^"\\])*")|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
          (token, quoted, number) => quoted || (/^-?\d{16,}$/.test(number) ? JSON.stringify(number) : number)) : raw;
        result = JSON.parse(text);
      }
      catch { throw new Error(`${endpoint} 未返回有效 JSON`); }
      if (saveReply) {
        if (!Number.isSafeInteger(result?.code)) throw new Error(`${endpoint} 未返回有效保存状态码`);
        return result;
      }
      if (result?.code && result.code !== 0) throw new Error(String(result.message || '平台拒绝 PAGE 操作').slice(0, 512));
      if (!result?.data || typeof result.data !== 'object') throw new Error(`${endpoint} 未返回有效数据回执`);
      return result.data;
    };
    function locatePageInModules(pending, pageId, systemId) {
      const seen = new Set(), matches = [];
      while (pending.length) {
        const item = pending.pop();
        if (!item || typeof item !== 'object' || seen.has(item)) continue;
        if (seen.size >= 10000) throw new Error('已加载的模块树超出 PAGE 身份核对范围');
        seen.add(item);
        if (item.pageId === pageId && (item.systemId || systemId)) {
          matches.push({...item, systemId:item.systemId || systemId});
          continue;
        }
        for (const value of Object.values(item)) {
          if (value && typeof value === 'object') pending.push(value);
        }
      }
      if (matches.length !== 1) throw new Error('PAGE 基本信息为空，模块树未提供唯一的 PAGE 身份');
      return matches[0];
    }
    try {
      if (!databasePage && !['inspect', 'create', 'copy', 'delete'].includes(payload?.action)) throw new Error('无效 PAGE 生命周期操作');
      const pointer = payload.sourcePointer;
      if (pointer !== undefined && (payload.action !== 'inspect' || pointer !== '/compScript' || !payload.pageId)) {
        throw new Error('只读服务 PAGE 正文需要精确 PAGE ID 和 /compScript');
      }
      if (location.origin !== payload.expectedOrigin || !/\/guthon\//.test(location.pathname)) throw new Error('平台来源或路径已变化');
      const instances = [...new Set(Array.from(document.querySelectorAll('*')).map(element => element.__vue__ || element.__vueParentComponent?.proxy).filter(Boolean))];
      const currentSystems = new Set(instances.map(instance => instance.$store?.state?.modeDev?.systemId).filter(Boolean));
      const systems = new Set((payload.systemIds || []).filter(id => databasePage ? id === payload.systemId : currentSystems.has(id)));
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
      let page, sourceVersion, nativeModel, recoveredPageInfo = false, sourceContent;
      if (payload.pageId) {
        if (!/^PG-[A-Za-z0-9-]{1,96}$/.test(payload.pageId)) throw new Error('PAGE 身份无效');
        if (databasePage) {
          const tree = await checked('/develop/dev/models/list.htm', {systemId:payload.systemId});
          if (!Array.isArray(tree.list)) throw new Error('谷神未返回目标子系统的模块目录');
          page = locatePageInModules([...tree.list], payload.pageId, payload.systemId);
        } else {
          const info = await checked('/develop/dev/pages/getPageBaseInfo.htm', {pageId:payload.pageId},
            {allowEmpty:payload.action === 'inspect'});
          recoveredPageInfo = info === null;
          page = recoveredPageInfo
            ? locatePageInModules(instances.flatMap(vm => Array.isArray(vm.modules) ? vm.modules : []), payload.pageId)
            : info.page;
        }
        if (page?.pageId !== payload.pageId || !systems.has(page.systemId)) throw new Error('PAGE 不属于当前平台系统上下文');
        const source = await checked('/develop/dev/pages/getPageModuleXml.htm', {pageId:payload.pageId});
        if (source.version === undefined || source.version === null) throw new Error('平台未返回 PAGE 源码版本，不能取得生命周期租约');
        sourceVersion = String(source.version);
        nativeModel = source.bean;
        if (recoveredPageInfo || pointer || databasePage) {
          const bean = source.bean;
          if (bean?.pageId !== page.pageId || (bean.systemId && bean.systemId !== page.systemId)
              || (bean.pageType != null && page.pageType != null && String(bean.pageType) !== String(page.pageType))
              || (bean.pageAliasId && page.pageAliasId && bean.pageAliasId !== page.pageAliasId)) {
            throw new Error('PAGE 原生源码与已核对的页面身份不一致');
          }
          if (pointer) {
            if (String(bean.pageType) !== '0' || typeof bean.compScript !== 'string') throw new Error('平台未返回服务 PAGE 正文');
            sourceContent = bean.compScript;
            if (JSON.stringify(sourceContent).length > 20000) throw new Error('服务 PAGE 正文超出 Bridge 单次回读上限');
          }
        }
      }
      if (databasePage) {
        const {pageId, pageAlias, pageType, evidence} = payload;
        if (!page || (page.pageAliasId || nativeModel.pageAliasId || pageId) !== pageAlias
            || String(page.pageType ?? nativeModel.pageType) !== pageType) {
          throw new Error('平台 PAGE 编码或类型与审阅目标不一致');
        }
        const hasDraft = instances.some(vm => vm.pageId === pageId && vm.page?.getPageVersion && vm.version
          && vm.page.getPageVersion(true) !== vm.version);
        if (payload.action === 'database-read') {
          const content = JSON.stringify(nativeModel);
          if (new TextEncoder().encode(content).byteLength > 4 * 1024 * 1024) throw new Error('PAGE 超出回读大小限制');
          return {origin:location.origin, systemId:page.systemId, pageId, pageAlias, pageType, version:sourceVersion,
            content, canSave:!hasDraft};
        }
        if (!/^[0-9a-f]{64}$/.test(evidence?.operationId || '') || typeof evidence.content !== 'string'
            || typeof evidence.expectedVersion !== 'string') throw new Error('缺少已确认的 PAGE 候选');
        if (hasDraft) return {operationId:evidence.operationId, rejected:'PAGE_DRAFT_PENDING'};
        if (sourceVersion !== evidence.expectedVersion) {
          return {operationId:evidence.operationId, rejected:'PLATFORM_VERSION_CHANGED'};
        }
        const candidate = JSON.parse(evidence.content);
        if (candidate?.pageId !== pageId || String(candidate.pageType) !== pageType
            || (candidate.pageAliasId && candidate.pageAliasId !== pageAlias)
            || (candidate.systemId && candidate.systemId !== page.systemId)
            || (pageType === '0' && typeof candidate.compScript !== 'string')) {
          throw new Error('PAGE 候选身份与平台不一致');
        }
        const model = pageType === '0' ? {...nativeModel, compScript:candidate.compScript} : candidate;
        // The PAGE designer posts plain JSON as a form field with flag=0.
        const json = JSON.stringify(model);
        if (new TextEncoder().encode(json).byteLength > 4 * 1024 * 1024) throw new Error('PAGE 超出上传大小限制');
        dispatched = true;
        const {code, data:saved} = await checked('/develop/dev/models/savePageModuleXml.htm',
          {pageId, pageVersion:sourceVersion, json, flag:0, isAutoCompile:pageType === '0' ? undefined : 1},
          {saveReply:true});
        if (code !== 0) return {operationId:evidence.operationId, rejected:'PLATFORM_SAVE_REJECTED', platformCode:code};
        if (!saved || typeof saved !== 'object') throw new Error('谷神未返回 PAGE 保存回执');
        return {operationId:evidence.operationId, acknowledged:true,
          ...(saved.version != null && String(saved.version) !== sourceVersion ? {version:String(saved.version)} : {})};
      }
      if (payload.action === 'inspect') return {state:'SUCCEEDED', platformApplied:false, page:clean(page), sourceVersion,
        ...(recoveredPageInfo ? {pageInfoSource:'module-tree'} : {}),
        ...(pointer ? {sourcePointer:pointer, sourceContent} : {modules:[...modules.values()], systemIds:[...systems]})};
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
        try {
          const after = await checked('/develop/dev/pages/getPageBaseInfo.htm', {pageId:page.pageId});
          if (Object.hasOwn(after, 'page') && after.page === null) return {state:'SUCCEEDED', action:'delete', page:clean(page), platformApplied:true};
        } catch { /* A failed lookup does not prove that the PAGE was deleted. */ }
        return {state:'APPLIED_UNVERIFIED', action:'delete', page:clean(page), platformApplied:true,
          message:'平台已响应删除，但未能确认 PAGE 已消失；请核对平台，禁止重试写入'};
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
      if (created?.pageId && created.pageId !== page?.pageId) {
        try {
          const after = (await checked('/develop/dev/pages/getPageBaseInfo.htm', {pageId:created.pageId})).page;
          if (after?.pageId === created.pageId && after.systemId === form.systemId && after.mkId === form.mkId) {
            return {state:'SUCCEEDED', action:payload.action, page:clean(after), platformApplied:true};
          }
        } catch { /* Acknowledgement without readback must not trigger another write. */ }
      }
      return {state:'APPLIED_UNVERIFIED', action:payload.action, page:clean(created), platformApplied:true,
        message:'平台已响应，但新 PAGE 身份或所属模块未通过回读；请核对平台，禁止重试写入'};
    } catch (error) {
      return {state:dispatched ? 'UNKNOWN' : 'REJECTED', platformApplied:dispatched ? null : false,
        message:String(error.message || error).slice(0,512)};
    }
  }
if (typeof module === "object" && module.exports) module.exports = {runPageLifecycle};

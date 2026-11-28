function canonicalNative(value) {
    if (Array.isArray(value)) return '[' + value.map(canonicalNative).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ':' + canonicalNative(value[key])).join(',') + '}';
    return JSON.stringify(value);
}

function comparableNativePage(value) {
  return canonicalNative(JSON.parse(JSON.stringify(value),(key,item)=>{
    if(item && typeof item==='object' && item.tbId && item.fdId){
      if(item.scale===0)delete item.scale;
      if(item.length===0)delete item.length;
    }
    return item;
  }));
}

/* Explicit native metadata API adapter. No DOM actions, arbitrary URLs or SQL. */
async function runNativeMetadata(payload) {
  let dispatched = false;
  const canonical = canonicalNative;
  const summary = field => Object.fromEntries(['pkid','tableId','fieldId','fieldName','dataType',
    'isPrimary','isIncrement','isCanNull','dataLength','dataPrecision'].filter(key => field[key] !== undefined)
    .map(key => [key, field[key]]));
  const checked = async (route, body, contextHeaders = {}, timeoutMs = 30000) => {
    const response = await fetch(route, {method:'POST', credentials:'include',
      headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8',...contextHeaders},
      body:new URLSearchParams(Object.entries(body).filter(([,value]) => value !== undefined && value !== null)
        .map(([key,value]) => [key, String(value)])), signal:AbortSignal.timeout(timeoutMs)});
    if (!response.ok) throw new Error('Native metadata HTTP ' + response.status);
    const raw = await response.text();
    const preserved = raw.replace(/("(?:\\.|[^"\\])*")|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (token, quoted, number) => quoted || (/^-?\d{16,}$/.test(number) ? JSON.stringify(number) : number));
    const result = JSON.parse(preserved);
    if (result.code && result.code !== 0) throw new Error(String(result.message || 'Native metadata request rejected').slice(0,512));
    if (!result.data || typeof result.data !== 'object') throw new Error('Native metadata response has no data');
    return result.data;
  };
  try {
    if (!['inspect-guid','set-guid','inspect-page-guid','sync-page-guid','inspect-runtime','save-native-record','prepare-native-record','apply-page-script','inspect-page-script','inspect-declared-step','run-declared-step','inspect-native-source','apply-native-source','inspect-database-procedure'].includes(payload?.action)) throw new Error('Unsupported native metadata action');
    if (location.origin !== payload.expectedOrigin || !/\/guthon\//.test(location.pathname)) throw new Error('Platform origin changed');
    if (!payload.dataSourceIds?.includes(payload.dataSourceId)) throw new Error('Datasource is not selected in the paired context');
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(payload.dataSourceId || ''))throw new Error('Invalid datasource identity');
    if (['save-native-record','prepare-native-record'].includes(payload.action)) return runNativeRecordSave(payload,checked);
    if (['apply-page-script','inspect-page-script'].includes(payload.action)) return runNativePageScript(payload,checked);
    if (['inspect-declared-step','run-declared-step'].includes(payload.action)) return runDeclaredNativeStep(payload,checked);
    if (['inspect-native-source','apply-native-source'].includes(payload.action)) return runFrozenNativeSource(payload,checked);
    if (payload.action === 'inspect-database-procedure') {
      const {systemId, dataSourceId, procedureAlias, funId} = payload;
      if (!payload.systemIds?.includes(systemId)
          || !/^[A-Za-z_$][A-Za-z0-9_.$]{0,255}$/.test(procedureAlias || '')
          || !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(funId || '')) throw new Error('DATABASE preflight target changed');
      const tree = await checked('/develop/procedure/admin/getProcTree.htm', {dataSourceId});
      const matches = tree.list?.filter(row => row.procedureAliasId === procedureAlias);
      if (matches?.length !== 1 || !/^PR-[A-Za-z0-9-]{1,96}$/.test(matches[0].procedureId || '')) throw new Error('Native procedure alias is absent or ambiguous');
      const {procedureId} = matches[0];
      const catalog = await checked('/develop/procedure/admin/getFunList.htm', {procedureId});
      if (catalog.list?.filter(row=>row.funId === funId).length !== 1) throw new Error('Native function is absent or ambiguous');
      const {bean} = await checked('/develop/procedure/admin/getFunInfo.htm', {procedureId,funId});
      if (bean?.funId !== funId || (bean.procedureId !== undefined && bean.procedureId !== procedureId)
          || typeof bean.versionMac !== 'string' || !bean.versionMac || bean.versionMac.length > 128) throw new Error('Native function/version does not match');
      let sourceContent;
      if (payload.includeSourceHash === true) {
        if (typeof bean.funScript !== 'string' || bean.funScript.length > 196608) {
          throw new Error('平台未返回有界的过程函数正文，无法核对编辑基线');
        }
        sourceContent = bean.funScript;
      }
      return {state:'SUCCEEDED',action:payload.action,platformApplied:false,
        after:{origin:location.origin,systemId,dataSourceId,procedureId,procedureAlias,funId,version:bean.versionMac},
        ...(payload.includeSourceHash === true ? {sourceContent} : {})};
    }
    for (const key of ['tableId','fieldId']) if (!/^[A-Za-z0-9_]{1,128}$/.test(payload[key] || '')) throw new Error('Invalid metadata identity');
    if (payload.action === 'inspect-runtime') {
      const response = await fetch('/develop/systems/apps/view.htm', {credentials:'include',signal:AbortSignal.timeout(30000)});
      if (!response.ok) throw new Error('Native runtime entry HTTP ' + response.status);
      const html = await response.text();
      if (html.length > 1000000) throw new Error('Runtime entry exceeds the inspection limit');
      if (/^\s*\{/.test(html)) {const result = JSON.parse(html);throw new Error(String(result.message || 'Runtime entry did not return HTML'));}
      const finalUrl = new URL(response.url || '/develop/systems/apps/view.htm', location.origin);
      if (finalUrl.origin !== location.origin) throw new Error('Native runtime redirected outside the paired platform origin');
      const scripts = Array.from(html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/gi),match => {
        const url = new URL(match[1],finalUrl);
        return url.origin === location.origin ? url.pathname : null;
      }).filter(Boolean).slice(0,128);
      const runtimeLogin=await checked('/gdpaas/home/isLogin.htm',{});
      return {state:'SUCCEEDED',action:payload.action,runtimePath:finalUrl.pathname,scripts,
        after:{bootstrapModules:Array.from(html.matchAll(/seajs\.use\s*\(\s*(?:\[\s*)?(?:ROOT_PATH\s*\+\s*)?["']([^"']+)["']/g),match=>match[1].split('?')[0]).filter(path=>/^[A-Za-z0-9_.\/-]+$/.test(path)).slice(0,20),runtimeIdentity:runtimeLogin.user?{userId:runtimeLogin.user.userId,userName:runtimeLogin.user.userName}:null,
          bootstrapPaths:[...new Set(Array.from(html.matchAll(/["']([^"'\r\n]{1,180}\.(?:js|html))["']/g),match=>match[1]))]
            .filter(path=>!path.includes('?') && !path.includes('<') && !path.includes('>')).slice(-40)},platformApplied:false};
    }
    const fields = await checked('/develop/systems/tables/getTableFields.htm', {dataSourceId:payload.dataSourceId,tableId:payload.tableId});
    if (!Array.isArray(fields.list)) throw new Error('Native field catalog has no list');
    const matches = fields.list.filter(field => field.fieldId === payload.fieldId);
    if (matches.length !== 1) throw new Error('Native field identity is not unique');
    const before = matches[0];
    if (before.tableId && before.tableId !== payload.tableId) throw new Error('Native field belongs to another table');
    if (before.dataSourceId && before.dataSourceId !== payload.dataSourceId) throw new Error('Native field belongs to another datasource');
    if (Number(before.isPrimary) !== 1 || before.dataType !== 'BIGINT' || Number(before.isCanNull) !== 0) throw new Error('Only an existing non-null BIGINT primary key is supported');
    if (![0,2].includes(Number(before.isIncrement || 0))) throw new Error('Database identity fields cannot be changed');
    if (payload.action.endsWith('page-guid')) {
      if (!/^PG-[A-Za-z0-9-]{1,96}$/.test(payload.pageId || '')) throw new Error('An exact PAGE identity is required');
      if (Number(before.isIncrement) !== 2) throw new Error('Table GUID metadata must be corrected before syncing a PAGE');
      const page = (await checked('/develop/dev/pages/getPageBaseInfo.htm', {pageId:payload.pageId})).page;
      if (page?.pageId !== payload.pageId || !payload.systemIds?.includes(page.systemId)) throw new Error('PAGE is outside the selected system');
      const source = await checked('/develop/dev/pages/getPageModuleXml.htm', {pageId:payload.pageId});
      if (!source.bean || source.bean.pageId !== payload.pageId || source.version == null) throw new Error('Native PAGE source/version is unavailable');
      const projections = [];
      const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (value.tbId === payload.tableId && value.fdId === payload.fieldId) projections.push(value);
        for (const child of Object.values(value)) visit(child);
      };
      visit(source.bean);
      if (!projections.length || projections.length > 4 || projections.some(field => Number(field.isPk) !== 1 || ![0,2].includes(Number(field.isIncrement || 0)))) throw new Error('PAGE primary key projection is missing, ambiguous or not a GUID candidate');
      // Native version remains the write precondition; this content fingerprint detects a stale or inconsistent read.
      // Unlike SubtleCrypto it is also available on the platform's HTTP development origin.
      let sourceFingerprint = 0xcbf29ce484222325n;
      for (const character of canonical(source.bean)) sourceFingerprint = BigInt.asUintN(64,
        (sourceFingerprint ^ BigInt(character.codePointAt(0))) * 0x100000001b3n);
      const snapshot = canonical({pageId:payload.pageId,version:String(source.version),sourceFingerprint:sourceFingerprint.toString(16),projections});
      const detail = {pageId:payload.pageId,sourceVersion:String(source.version),projectionCount:projections.length,
        guidFlags:projections.map(field => Number(field.isIncrement || 0))};
      if (payload.action === 'inspect-page-guid') return {state:'SUCCEEDED',action:payload.action,...detail,snapshot,platformApplied:false};
      if (payload.expectedSnapshot !== snapshot) throw new Error('PAGE changed since inspection; inspect again');
      if (projections.every(field => Number(field.isIncrement) === 2)) return {state:'SUCCEEDED',action:payload.action,...detail,changed:false,platformApplied:false};
      projections.forEach(field => {field.isIncrement = 2;});
      // The native serializer omits zero length/scale on field descriptors; their meaning is unchanged.
      const candidate = comparableNativePage(source.bean);
      const bytes = new TextEncoder().encode(JSON.stringify(source.bean));
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      dispatched = true;
      const saved = await checked('/develop/dev/models/savePageModuleXml.htm', {pageId:payload.pageId,
        pageVersion:source.version,json:encodeURIComponent(btoa(binary)),isBase64:1,flag:0,isAutoCompile:1});
      const after = await checked('/develop/dev/pages/getPageModuleXml.htm', {pageId:payload.pageId});
      if (!after.bean || comparableNativePage(after.bean) !== candidate) throw new Error('Native PAGE readback does not match the single GUID correction');
      return {state:'SUCCEEDED',action:payload.action,before:detail,after:{pageId:payload.pageId,sourceVersion:String(after.version),
        guidFlags:projections.map(field => Number(field.isIncrement))},changed:true,platformApplied:true,
        autoCompileRequested:true,savedVersion:saved.version};
    }
    const snapshot = canonical(before);
    if (payload.action === 'inspect-guid') return {state:'SUCCEEDED',action:payload.action,field:summary(before),snapshot,platformApplied:false};
    if (payload.expectedSnapshot !== snapshot) throw new Error('Native field changed after inspection; inspect again');
    if (Number(before.isIncrement) === 2) return {state:'SUCCEEDED',action:payload.action,before:summary(before),after:summary(before),changed:false,platformApplied:false};
    const tables = await checked('/develop/systems/tables/list.htm', {dataSourceId:payload.dataSourceId});
    if (!Array.isArray(tables.list)) throw new Error('Native table catalog has no list');
    const tableMatches = tables.list.filter(table => table.tableId === payload.tableId);
    if (tableMatches.length !== 1 || !tableMatches[0].pkid || !before.pkid) throw new Error('Native table/field primary identity is missing or ambiguous');
    const table = tableMatches[0];
    if (table.dataSourceId !== payload.dataSourceId) throw new Error('Native table datasource does not match');
    const form = {...before,isIncrement:2,tablePkid:table.pkid,tableId:table.tableId,dataSourceId:table.dataSourceId};
    if (Object.values(form).some(value => value !== null && typeof value === 'object')) throw new Error('Native field form requires an unsupported structured value');
    dispatched = true;
    await checked('/develop/systems/tables/saveTableField.htm', form);
    const reread = await checked('/develop/systems/tables/getTableFields.htm', {dataSourceId:payload.dataSourceId,tableId:payload.tableId});
    const after = reread.list?.filter(field => field.fieldId === payload.fieldId);
    if (after?.length !== 1 || Number(after[0].isIncrement) !== 2) throw new Error('Native GUID flag has not been confirmed after save');
    for (const key of ['pkid','fieldId','dataType','isPrimary','isCanNull','dataLength','dataPrecision']) {
      if (canonical(before[key]) !== canonical(after[0][key])) throw new Error('Unexpected native field change: ' + key);
    }
    return {state:'SUCCEEDED',action:payload.action,before:summary(before),after:summary(after[0]),changed:true,platformApplied:true};
  } catch (error) {
    return {state:dispatched ? 'UNKNOWN' : 'REJECTED',platformApplied:dispatched ? null : false,
      message:String(error.message || error).slice(0,512)};
  }
}
if (typeof module === 'object' && module.exports) module.exports = {runNativeMetadata};

// Native single-form creation: preserves the platform save endpoint and its server lifecycle.
// No SQL, arbitrary service components, updates, detail-grid payloads or caller-owned identity.
async function runNativeRecordSave(payload, checked) {
  let dispatched = false;
  try {
    const page = (await checked('/develop/dev/pages/getPageBaseInfo.htm',{pageId:payload.pageId})).page;
    if (page?.pageId !== payload.pageId || page.pageType !== 3 || !payload.systemIds.includes(page.systemId)) throw new Error('Record PAGE is outside the current system or is not a single-form dialog');
    const parent = (await checked('/develop/dev/pages/getPageBaseInfo.htm',{pageId:payload.parentPageId})).page;
    if (parent?.pageType !== 1 || parent.systemId !== page.systemId || parent.mkId !== page.mkId) throw new Error('Native parent PAGE is outside the target module');
    const parentSource = await checked('/develop/dev/pages/getPageModuleXml.htm',{pageId:payload.parentPageId});
    const parentText = JSON.stringify(parentSource.bean);
    if (!parentText.includes(page.pageAliasId) && !parentText.includes(payload.pageId)) throw new Error('Native parent does not declare this dialog');
    const recordHeaders = {pageId:payload.parentPageId.replaceAll('-','_'),parentId:'',menuId:page.mkId};
    const browseId = localStorage.getItem('BROWSE_ID');
    if (browseId) recordHeaders.browseId = browseId;
    const source = await checked('/develop/dev/pages/getPageModuleXml.htm',{pageId:payload.pageId});
    if (String(source.version) !== payload.expectedVersion || source.bean?.pageId !== payload.pageId) throw new Error('Native record PAGE changed since inspection');
    const nodes=[];
    const visit=value=>{if(!value || typeof value!=='object')return;nodes.push(value);for(const child of Object.values(value))visit(child);};
    visit(source.bean);
    const forms=nodes.filter(node=>node.name==='inputForm' && node.datasource);
    const datasources=nodes.filter(node=>node.datasource?.saveTableId);
    const buttons=nodes.filter(node=>node.id===payload.bntId && node.bntType==='save' && node.bntAuth==='edit');
    if (forms.length!==1 || datasources.length!==1 || buttons.length!==1) throw new Error('Only one native inputForm datasource and an exact edit/save button are supported');
    const form=forms[0],columns=form.datasource.fields,keys=form.datasource.pks;
    if (!Array.isArray(columns) || !Array.isArray(keys) || !keys.length || keys.some(key=>Number(columns.find(column=>column.label===key.label)?.isIncrement)!==2)) throw new Error('Native form must have platform-generated primary keys');
    const allowed=new Set([...columns.map(field=>field.label),...form.fields.map(field=>field.fieldId)]);
    const values={...payload.inputForm};
    for(const key of Object.keys(values)) if(!allowed.has(key) || keys.some(field=>field.label===key)) throw new Error('Unknown or platform-generated form field: '+key);
    const login=await checked('/gdpaas/home/isLogin.htm',{});
    if (!login.user?.userId) throw new Error('Native session identity is unavailable');
    if(allowed.has('OPERATOR_CODE'))values.OPERATOR_CODE=login.user.userId;
    if(allowed.has('OPERATOR_NAME'))values.OPERATOR_NAME=login.user.userName;
    const selections=[];
    for(const field of form.fields){
      const select=field.selectBox;
      if(!field.selectCompId || ![1,2].includes(Number(select?.codeType)))continue;
      const codeField=select.selectCodefieldId || field.fieldId;
      if (/^OPERATOR_/.test(codeField)) continue; // Native session defaults are assigned directly by onOpen, not chosen from the staff directory.
      const value=values[codeField];
      if(value===undefined || value===null || value==='')continue;
      const selected=await checked('/gdpaas/select/list.htm',{page:1,pageSize:100,code:String(value),isMustPick:1,
        compId:field.selectCompId,codeType:select.codeType,systemId:select.ownerSystemId || page.systemId,json:'{}'},recordHeaders);
      const matches=selected.page?.result?.filter(row=>String(row.code)===String(value));
      if(matches?.length!==1)throw new Error('Native candidate is unavailable or ambiguous: '+codeField);
      if(codeField!==field.fieldId)values[field.fieldId]=matches[0].name;
      selections.push({fieldId:field.fieldId,code:String(matches[0].code),name:matches[0].name});
    }
    for(const field of form.fields)if(Number(field.isMust)===1 && (values[field.fieldId]===undefined || values[field.fieldId]===null || values[field.fieldId]===''))throw new Error('Required native field is missing: '+field.fieldId);
    if (payload.action === 'prepare-native-record') return {state:'SUCCEEDED',action:payload.action,
      after:{pageId:payload.pageId,parentPageId:payload.parentPageId,selections,validatedFieldNames:Object.keys(values)},platformApplied:false};
    const bean={inputForm:values};
    dispatched=true;
    const result=await checked('/gdpaas/editpage/save.htm?_p_='+encodeURIComponent(payload.pageId),
      {pageId:payload.pageId,bntId:payload.bntId,json:JSON.stringify(bean),isNew:1},recordHeaders);
    const saved=result.bean?.inputForm;
    if(!saved || keys.some(field=>saved[field.label]===undefined || saved[field.label]===null))throw new Error('Native save receipt has no generated primary key; do not replay');
    const primary=Object.fromEntries(keys.map(field=>[field.label,saved[field.label]]));
    const readback=await checked('/gdpaas/editpage/get.htm?_p_='+encodeURIComponent(payload.pageId),
      {pageId:payload.pageId,ctrlId:'inputForm',json:JSON.stringify(primary),isClone:0},recordHeaders);
    if(readback.list?.length!==1)throw new Error('Native record readback is not unique; do not replay');
    const row=readback.list[0];
    for(const column of columns){const key=column.label;
      if(column.tbId===form.datasource.saveTableId && payload.inputForm[key]!==undefined && payload.inputForm[key]!==null && String(row[key])!==String(payload.inputForm[key]))throw new Error('Native saved field mismatch: '+key);
    }
    return {state:'SUCCEEDED',action:payload.action,after:{pageId:payload.pageId,inputForm:row,selections},platformApplied:true};
  } catch(error) {
    return {state:dispatched?'UNKNOWN':'REJECTED',platformApplied:dispatched?null:false,message:String(error.message || error).slice(0,512)};
  }
}

// Publish one already-reviewed source node; never execute arbitrary scripts through a testing endpoint.
async function runNativePageScript(payload, checked) {
  let dispatched=false;
  try {
    const page=(await checked('/develop/dev/pages/getPageBaseInfo.htm',{pageId:payload.pageId})).page;
    if(page?.pageId!==payload.pageId || !payload.systemIds.includes(page.systemId))throw new Error('Script PAGE is outside the selected system');
    const source=await checked('/develop/dev/pages/getPageModuleXml.htm',{pageId:payload.pageId});
    if(source.bean?.pageId!==payload.pageId || source.version==null)throw new Error('Native PAGE source/version unavailable');
    const tokens=payload.jsonPointer.split('/').slice(1),name=tokens.pop();
    if(tokens.pop()!=='serviceEvents')throw new Error('Native save hook must belong to serviceEvents');
    let button=source.bean;
    for(const token of tokens)button=button?.[token];
    if(button?.bntType!=='save')throw new Error('Native script owner is not an existing save button');
    const current=button.serviceEvents?.[name]===undefined?null:button.serviceEvents[name];
    if(current!==null && typeof current!=='string')throw new Error('Native script node is not text');
    if(payload.action==='inspect-page-script')return {state:'SUCCEEDED',action:payload.action,after:{pageId:payload.pageId,
      sourceVersion:String(source.version),jsonPointer:payload.jsonPointer,content:current},platformApplied:false};
    const normalized=text=>text==null?null:text.replaceAll('\r\n','\n');
    if(String(source.version)!==payload.expectedVersion || normalized(current)!==normalized(payload.expectedContent))throw new Error('Native PAGE/version/script changed since source review');
    if(!button.serviceEvents)button.serviceEvents={};
    button.serviceEvents[name]=payload.content;
    const candidate=comparableNativePage(source.bean),bytes=new TextEncoder().encode(JSON.stringify(source.bean));
    let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
    dispatched=true;
    const saved=await checked('/develop/dev/models/savePageModuleXml.htm',{pageId:payload.pageId,pageVersion:source.version,
      json:encodeURIComponent(btoa(binary)),isBase64:1,flag:0,isAutoCompile:1});
    const after=await checked('/develop/dev/pages/getPageModuleXml.htm',{pageId:payload.pageId});
    if(!after.bean || comparableNativePage(after.bean)!==candidate)throw new Error('Native published PAGE does not match the single reviewed script change');
    return {state:'SUCCEEDED',action:payload.action,before:{sourceVersion:String(source.version)},after:{pageId:payload.pageId,
      sourceVersion:String(after.version),jsonPointer:payload.jsonPointer,sourceOperationId:payload.sourceOperationId},
      autoCompileRequested:true,savedVersion:saved.version,platformApplied:true};
  } catch(error) {return {state:dispatched?'UNKNOWN':'REJECTED',platformApplied:dispatched?null:false,message:String(error.message || error).slice(0,512)};}
}

// Only a server-frozen, explicitly configured native component request is callable here.
async function runDeclaredNativeStep(payload,checked) {
  let dispatched=false;
  try {
    const step=payload.definition;
    if(step.origin!==location.origin || step.dataSourceId!==payload.dataSourceId || !payload.systemIds.includes(step.systemId))throw new Error('Declared native step is outside the current platform context');
    const page=(await checked('/develop/dev/pages/getPageBaseInfo.htm',{pageId:step.pageId})).page;
    if(page?.pageId!==step.pageId || page.systemId!==step.systemId || (step.kind==='page-query' ? ![1,4].includes(page.pageType) || step.alias && page.pageAliasId!==step.alias : page.pageType!==0 || page.pageAliasId!==step.alias))throw new Error('Registered native component identity changed');
    const source=await checked('/develop/dev/pages/getPageModuleXml.htm',{pageId:step.pageId});
    if(String(source.version)!==step.sourceVersion)throw new Error('Registered native component source version changed');
    const parent=(await checked('/develop/dev/pages/getPageBaseInfo.htm',{pageId:step.parentPageId})).page;
    if(parent?.pageId!==step.parentPageId || parent.pageType!==1 || parent.systemId!==step.systemId)throw new Error('Native component parent PAGE is outside the selected system');
    const after={step:payload.step,pageId:step.pageId,alias:step.alias,sourceVersion:step.sourceVersion,manifestHash:step.manifestHash};
    if(payload.action==='inspect-declared-step')return {state:'SUCCEEDED',action:payload.action,after,platformApplied:false};
    const headers={pageId:step.parentPageId.replaceAll('-','_'),parentId:'',menuId:parent.mkId};
    const browseId=localStorage.getItem('BROWSE_ID');if(browseId)headers.browseId=browseId;
    dispatched=step.mutates;
    const result=step.kind==='page-query'
      ? await checked('/gdpaas/mainpage/findPage.htm?_p_='+encodeURIComponent(step.pageId),
        {pageId:step.pageId,ctrlId:step.ctrlId,searchBoxId:step.searchBoxId,json:JSON.stringify(step.arguments),
          page:1,pageSize:100,isPageNoChange:0,groupSubFields:'[]',groupSumFields:'[]'},headers,step.timeoutMs)
      : await checked('/gdpaas/jscomp/run.htm?_p_='+encodeURIComponent(step.alias),
        {compId:step.alias,params:JSON.stringify(step.arguments)},headers,step.timeoutMs);
    return {state:'SUCCEEDED',action:payload.action,after:{...after,result},platformApplied:step.mutates};
  } catch(error) {return {state:dispatched?'UNKNOWN':'REJECTED',platformApplied:dispatched?null:false,message:String(error.message || error).slice(0,512)};}
}

// Maintain a declared function through designer APIs; never run source through a test endpoint.
async function runFrozenNativeSource(payload,checked) {
  let dispatched=false,publishedSource=null;
  try {
    const step=payload.definition;
    if(step.origin!==location.origin || step.dataSourceId!==payload.dataSourceId
      || !['CREATE_FUNCTION','SAVE_PARAMETERS','SAVE_SOURCE','SAVE_SOURCE_PATCH'].includes(step.operation) && !payload.systemIds.includes(step.systemId))throw new Error('Frozen source is outside the selected platform context');
    if(step.operation==='SAVE_PAGE_SOURCE_PATCH') {
      const page=(await checked('/develop/dev/pages/getPageBaseInfo.htm',{pageId:step.pageId})).page;
      if(page?.pageId!==step.pageId || page.systemId!==step.systemId || page.pageType!==0 || page.pageAliasId!==step.alias
        || !Object.hasOwn(page,'runInTran') || String(page.runInTran)!==String(step.expectedRunInTran))throw new Error('Native service PAGE identity or transaction mode changed');
      const source=await checked('/develop/dev/pages/getPageModuleXml.htm',{pageId:step.pageId});
      const normalize=text=>(text || '').replaceAll('\r\n','\n');
      if(source.version==null || String(source.version)!==step.expectedVersion || source.bean?.pageId!==step.pageId
        || source.bean.pageType!==0 || source.bean.pageAliasId!==step.alias || typeof source.bean.compScript!=='string'
        || normalize(source.bean.compScript)!==normalize(step.expectedContent))throw new Error('Native service source/version changed since review');
      let published=normalize(source.bean.compScript);
      for(const r of step.replacements) {
        if(published.split(r.old).length-1!==r.expectedCount)throw new Error('Native service patch no longer uniquely matches reviewed source');
        published=published.replace(r.old,r.new);
      }
      if(published.length>196608)throw new Error('Patched service source exceeds publication bound');
      if(payload.action==='inspect-native-source')return {state:'SUCCEEDED',action:payload.action,platformApplied:false,
        after:{step:payload.step,sourceVersion:String(source.version),sourceHash:step.sourceHash,runInTran:page.runInTran,ready:true,manifestHash:step.manifestHash}};
      source.bean.compScript=published;
      const candidate=canonicalNative(source.bean),bytes=new TextEncoder().encode(JSON.stringify(source.bean));let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
      dispatched=true;
      await checked('/develop/dev/models/savePageModuleXml.htm',{pageId:step.pageId,pageVersion:source.version,
        json:encodeURIComponent(btoa(binary)),isBase64:1,flag:0,isAutoCompile:1});
      const after=await checked('/develop/dev/pages/getPageModuleXml.htm',{pageId:step.pageId});
      const afterPage=(await checked('/develop/dev/pages/getPageBaseInfo.htm',{pageId:step.pageId})).page;
      if(after.version==null || String(after.version)===String(source.version) || canonicalNative(after.bean)!==candidate
        || afterPage?.pageId!==step.pageId || afterPage.systemId!==step.systemId || afterPage.pageAliasId!==step.alias || afterPage.pageType!==0
        || !Object.hasOwn(afterPage,'runInTran') || String(afterPage.runInTran)!==String(step.expectedRunInTran))throw new Error('Native service source or transaction readback differs');
      return {state:'SUCCEEDED',action:payload.action,platformApplied:true,autoCompileRequested:true,
        after:{step:payload.step,sourceVersion:String(after.version),sourceHash:step.sourceHash,runInTran:afterPage.runInTran,sourceVerified:true,manifestHash:step.manifestHash}};
    }
    if(step.operation==='INSPECT_PAGE_SOURCE') {
      if(payload.action!=='inspect-native-source')throw new Error('PAGE source inspection is read-only');
      const page=(await checked('/develop/dev/pages/getPageBaseInfo.htm',{pageId:step.pageId})).page;
      if(page?.pageId!==step.pageId || page.systemId!==step.systemId || page.pageType!==0 || page.pageAliasId!==step.alias)
        throw new Error('Native service PAGE identity changed');
      const source=await checked('/develop/dev/pages/getPageModuleXml.htm',{pageId:step.pageId});
      if(!source.bean || typeof source.bean!=='object' || Array.isArray(source.bean) || source.version==null)
        throw new Error('Native service PAGE source/version unavailable');
      // Return structure and transaction metadata without copying scripts into the persistent receipt.
      const describe=value=>Object.fromEntries(Object.entries(value).map(([key,item])=>[key,
        item===null?'null':Array.isArray(item)?'array':typeof item]));
      const mode=Object.hasOwn(page,'runInTran')?{present:true,value:page.runInTran}:{present:false};
      return {state:'SUCCEEDED',action:payload.action,platformApplied:false,after:{step:payload.step,
        page:{pageId:page.pageId,systemId:page.systemId,pageType:page.pageType,pageAliasId:page.pageAliasId,runInTran:mode},
        sourceVersion:String(source.version),sourceKeys:describe(source),beanKeys:describe(source.bean),
        beanPageId:source.bean.pageId ?? null,beanPageType:source.bean.pageType ?? null,
        compScriptLength:typeof source.bean.compScript==='string'?source.bean.compScript.length:null,manifestHash:step.manifestHash}};
    }
    if(step.operation==='SAVE_PAGE_FIELDS') {
      const page=(await checked('/develop/dev/pages/getPageBaseInfo.htm',{pageId:step.pageId})).page;
      if(page?.pageId!==step.pageId || page.systemId!==step.systemId)throw new Error('Hidden field PAGE is outside the selected system');
      const source=await checked('/develop/dev/pages/getPageModuleXml.htm',{pageId:step.pageId});
      if(String(source.version)!==step.expectedVersion || source.bean?.pageId!==step.pageId)throw new Error('Native PAGE source version changed');
      for(const c of step.collections) {
        let fields=source.bean;for(const token of c.pointer.split('/').slice(1))fields=fields?.[token];
        if(!Array.isArray(fields) || canonicalNative(fields.map(f=>f.fieldId))!==canonicalNative(c.expectedIds))throw new Error('Native save field list changed');
      }
      if(payload.action==='inspect-native-source')return {state:'SUCCEEDED',action:payload.action,after:{step:payload.step,sourceVersion:String(source.version),manifestHash:step.manifestHash},platformApplied:false};
      for(const c of step.collections) {
        let fields=source.bean;for(const token of c.pointer.split('/').slice(1))fields=fields[token];
        fields.push(...c.fields);
      }
      const candidate=comparableNativePage(source.bean),bytes=new TextEncoder().encode(JSON.stringify(source.bean));let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
      dispatched=true;
      await checked('/develop/dev/models/savePageModuleXml.htm',{pageId:step.pageId,pageVersion:source.version,json:encodeURIComponent(btoa(binary)),isBase64:1,flag:0,isAutoCompile:1});
      const after=await checked('/develop/dev/pages/getPageModuleXml.htm',{pageId:step.pageId});
      if(comparableNativePage(after.bean)!==candidate)throw new Error('Native hidden field readback differs from reviewed fields');
      return {state:'SUCCEEDED',action:payload.action,after:{step:payload.step,sourceVersion:String(after.version),sourceOperationId:step.sourceOperationId,manifestHash:step.manifestHash},platformApplied:true,autoCompileRequested:true};
    }
    const expectedIsTran=step.expectedIsTran === undefined ? 0 : step.expectedIsTran;
    const expectedIsReturn=step.expectedIsReturn === undefined ? 1 : step.expectedIsReturn;
    const parents=await checked('/develop/procedure/admin/getProcTree.htm',{dataSourceId:step.dataSourceId});
    const parent=parents.list?.filter(p=>p.procedureId===step.procedureId && p.procedureAliasId===step.procedureAlias);
    if(parent?.length!==1)throw new Error('Native procedure parent identity changed');
    const catalog=await checked('/develop/procedure/admin/getFunList.htm',{procedureId:step.procedureId});
    const present=catalog.list?.filter(f=>f.funId===step.funId);
    if(!present || present.length>1)throw new Error('Native function catalog is incomplete');
    let fun=present.length?(await checked('/develop/procedure/admin/getFunInfo.htm',{procedureId:step.procedureId,funId:step.funId})).bean:null;
    if(payload.action==='inspect-native-source')return {state:'SUCCEEDED',action:payload.action,after:{step:payload.step,exists:!!fun,bean:fun,manifestHash:step.manifestHash},platformApplied:false};
    if(step.operation==='CREATE_FUNCTION') {
      if(fun)throw new Error('Native function already exists; no creation dispatched');
      dispatched=true;
      await checked('/develop/procedure/admin/saveFunInfo.htm',{procedureId:step.procedureId,funId:step.funId,funName:step.funName,isTran:expectedIsTran,isReturn:expectedIsReturn,opt:'new'});
    } else {
      if(!fun || fun.funId!==step.funId)throw new Error('Native function is absent');
      if(step.operation==='SAVE_PARAMETERS') {
        if(String(fun.isTran)!==String(expectedIsTran) || String(fun.isReturn)!==String(expectedIsReturn))throw new Error('Native function mode changed since review');
        const params=JSON.parse(fun.funParams || '[]');
        if(canonicalNative(params)!==canonicalNative(step.expectedParameters || []) || (fun.funScript && fun.versionMac!==step.expectedVersion))throw new Error('Native parameters or source version changed since review');
        dispatched=true;
        await checked('/develop/procedure/admin/saveFunParams.htm',{procedureId:step.procedureId,funId:step.funId,params:JSON.stringify(step.parameters)});
      } else if(['SAVE_SOURCE','SAVE_SOURCE_PATCH'].includes(step.operation)) {
        const normalize=t=>(t || '').replaceAll('\r\n','\n');
        if(String(fun.isTran)!==String(expectedIsTran) || String(fun.isReturn)!==String(expectedIsReturn))throw new Error('Native function mode changed since review');
        if((fun.versionMac ?? null)!==(step.expectedVersion ?? null))throw new Error('Native function source/version changed');
        if(step.operation==='SAVE_SOURCE_PATCH') {
          publishedSource=normalize(fun.funScript);
          for(const r of step.replacements) {
            if(publishedSource.split(r.old).length-1!==r.expectedCount)throw new Error('Native source patch text no longer matches its reviewed unique fragment');
            publishedSource=publishedSource.replace(r.old,r.new);
          }
          if(publishedSource.length>196608)throw new Error('Patched source exceeds the publication bound');
        } else {
          if(normalize(fun.funScript)!==normalize(step.expectedContent))throw new Error('Native function source/version changed');
          publishedSource=normalize(step.content);
        }
        const bytes=new TextEncoder().encode(JSON.stringify({script:publishedSource}));let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
        dispatched=true;
        await checked('/develop/procedure/admin/saveFunScript.htm',{procedureId:step.procedureId,funId:step.funId,funScript:encodeURIComponent(btoa(binary)),isBase64:1,flag:0,versionMac:fun.versionMac});
      } else if(step.operation==='REGISTER_TOOL') {
        const tools=await checked('/develop/mcp/tools/list.htm',{systemId:step.systemId});
        if(!Array.isArray(tools.list) || tools.list.some(t=>t.toolsId===step.tool.toolsId))throw new Error('MCP tool exists or catalog is incomplete; no registration dispatched');
        if(!fun.funScript || String(fun.isTran)!=='0' || String(fun.isReturn)!=='1')throw new Error('MCP handler is not a published nontransactional function');
        dispatched=true;
        await checked('/develop/mcp/tools/save.htm',{...step.tool,toolsParam:JSON.stringify(step.tool.toolsParam),systemId:step.systemId,procId:step.procedureId,procFunId:step.funId,procAliasName:step.procedureAlias,status:1,isNew:1});
        const after=await checked('/develop/mcp/tools/list.htm',{systemId:step.systemId});
        const tool=after.list?.filter(t=>t.toolsId===step.tool.toolsId && t.procId===step.procedureId && t.procFunId===step.funId);
        if(tool?.length!==1)throw new Error('Native MCP registration readback does not match');
        return {state:'SUCCEEDED',action:payload.action,after:{step:payload.step,tool:tool[0],manifestHash:step.manifestHash},platformApplied:true};
      }
    }
    fun=(await checked('/develop/procedure/admin/getFunInfo.htm',{procedureId:step.procedureId,funId:step.funId})).bean;
    if(!fun || fun.funId!==step.funId || String(fun.isTran)!==String(expectedIsTran)
      || String(fun.isReturn)!==String(expectedIsReturn))throw new Error('Native function metadata readback differs');
    if(publishedSource!==null && (fun.funScript || '').replaceAll('\r\n','\n')!==publishedSource)throw new Error('Native published source readback differs');
    if(step.operation==='SAVE_PARAMETERS' && canonicalNative(JSON.parse(fun.funParams || '[]'))!==canonicalNative(step.parameters))throw new Error('Native parameter readback differs');
    return {state:'SUCCEEDED',action:payload.action,after:{step:payload.step,bean:{procedureId:fun.procedureId,funId:fun.funId,versionMac:fun.versionMac,isTran:fun.isTran,isReturn:fun.isReturn,funParams:fun.funParams},sourceVerified:true,manifestHash:step.manifestHash},platformApplied:true};
  } catch(error) {return {state:dispatched?'UNKNOWN':'REJECTED',platformApplied:dispatched?null:false,message:String(error.message || error).slice(0,512)};}
}

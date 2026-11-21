const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

// The local owner freezes source maintenance; HTTP callers select a step, never code or endpoints.
function resolveNativeSource(value,{manifestPath=process.env.GUTHON_NATIVE_SOURCE_PLAN_FILE}={}) {
  const keys=['action','dataSourceId','step','definition','type'];
  if(!value || Object.keys(value).some(k=>!keys.includes(k)) || !['inspect-native-source','apply-native-source'].includes(value.action)
    || !/^[A-Za-z0-9_-]{1,80}$/.test(value.step || '') || value.type!==undefined && value.type!=='native-metadata')throw new Error('Only a frozen source maintenance step is supported');
  if(!manifestPath || !path.isAbsolute(manifestPath))throw new Error('No explicit native source plan is configured');
  const stat=fs.lstatSync(manifestPath);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size>262144)throw new Error('Native source plan must be a bounded regular file');
  const raw=fs.readFileSync(manifestPath,'utf8'),plan=JSON.parse(raw),step=plan.steps?.[value.step];
  if(['INSPECT_PAGE_SOURCE','SAVE_PAGE_SOURCE_PATCH'].includes(step?.operation)) {
    const sourceSave=step.operation==='SAVE_PAGE_SOURCE_PATCH';
    const origin=new URL(plan.origin);
    if(!sourceSave && value.action!=='inspect-native-source' || plan.schemaVersion!==1 || plan.environment!=='dev'
      || !/^(products|projects)\.[A-Za-z0-9_.-]+$/.test(plan.workspaceKey || '')
      || !/^SYS-[A-Za-z0-9-]+$/.test(plan.systemId || '') || !/^[A-Za-z0-9_-]{1,128}$/.test(plan.dataSourceId || '')
      || value.dataSourceId!==plan.dataSourceId || origin.origin!==plan.origin || !['http:','https:'].includes(origin.protocol)
      || Object.keys(step).some(k=>!['operation','pageId','alias',...(sourceSave?['expectedVersion','expectedContent','expectedRunInTran','sourceHash','replacements']:[])].includes(k))
      || !/^PG-[A-Za-z0-9-]{1,96}$/.test(step.pageId || '') || !/^com\.golden\.[A-Za-z0-9_.]{1,220}$/.test(step.alias || ''))throw new Error('Invalid read-only native PAGE source inspection');
    if(sourceSave && (typeof step.expectedVersion!=='string' || !step.expectedVersion
      || typeof step.expectedContent!=='string' || step.expectedContent.length>196608
      || ![0,1,10].includes(step.expectedRunInTran) || !/^[a-f0-9]{64}$/.test(step.sourceHash || '')
      || !Array.isArray(step.replacements) || !step.replacements.length || step.replacements.length>20
      || step.replacements.some(r=>Object.keys(r).some(k=>!['old','new','expectedCount'].includes(k))
        || typeof r.old!=='string' || !r.old || typeof r.new!=='string' || r.old.length>16000 || r.new.length>16000 || r.expectedCount!==1)))throw new Error('Service source save requires exact prior source, native mode, version and controlled source hash');
    const definition={workspaceKey:plan.workspaceKey,origin:plan.origin,systemId:plan.systemId,dataSourceId:plan.dataSourceId,
      manifestHash:crypto.createHash('sha256').update(raw).digest('hex'),...step};
    if(value.definition && JSON.stringify(value.definition)!==JSON.stringify(definition))throw new Error('Frozen PAGE inspection changed');
    return {action:value.action,dataSourceId:value.dataSourceId,step:value.step,definition,type:'native-metadata'};
  }
  if(step?.operation==='SAVE_PAGE_FIELDS') {
    if(plan.schemaVersion!==1 || plan.environment!=='dev' || !/^(products|projects)\.[A-Za-z0-9_.-]+$/.test(plan.workspaceKey || '')
      || !/^SYS-[A-Za-z0-9-]+$/.test(plan.systemId || '') || value.dataSourceId!==plan.dataSourceId || new URL(plan.origin).origin!==plan.origin
      || Object.keys(step).some(k=>!['operation','pageId','expectedVersion','sourceOperationId','collections'].includes(k))
      || !/^PG-[A-Za-z0-9-]+$/.test(step.pageId || '') || !step.expectedVersion || !/^page-op:v1:[a-f0-9]{64}$/.test(step.sourceOperationId || '')
      || !Array.isArray(step.collections) || step.collections.length>10)throw new Error('Invalid frozen native PAGE field plan');
    for(const c of step.collections) {
      if(!/^\/views\/rows\/\d+(\/tabs\/tabPages\/\d+\/rows\/\d+)?\/component\/fields$/.test(c.pointer || '')
        || !Array.isArray(c.expectedIds) || !Array.isArray(c.fields) || c.fields.length>10
        || c.fields.some(f=>f.isHideField!==1 || !/^[A-Z][A-Z0-9_]*$/.test(f.fieldId || '')
          || Object.keys(f).some(k=>!['fieldId','type','label','isHideField','guid','id','width','colGroupType','isMust','isEndDate','isLike','isDisabled','isRichEdit','isImageUpload','fileInput','isDisLabel','isDisAdvSearch','isHide','selectBox','validId','pageEvents','isSum','sumSql','autoHeight','isCanRemoveGroupField','useTableFieldName','params','editable','sortable'].includes(k)) || Object.keys(f.pageEvents || {}).length>0 || Object.keys(f.params || {}).length>0 || Object.keys(f.fileInput || {}).length>0 || f.sumSql && f.sumSql!=='' || f.validId && f.validId!=='' || Object.keys(f.selectBox || {}).some(k=>k!=='forceSelection') || !['text','date','datetime'].includes(f.type)))throw new Error('Only frozen hidden save fields may be appended');
    }
    const definition={workspaceKey:plan.workspaceKey,origin:plan.origin,systemId:plan.systemId,dataSourceId:plan.dataSourceId,
      manifestHash:crypto.createHash('sha256').update(raw).digest('hex'),...step};
    if(value.definition && JSON.stringify(value.definition)!==JSON.stringify(definition))throw new Error('Frozen PAGE field plan changed');
    return {action:value.action,dataSourceId:value.dataSourceId,step:value.step,definition,type:'native-metadata'};
  }
  if(plan.schemaVersion!==1 || plan.environment!=='dev' || !/^(products|projects)\.[A-Za-z0-9_.-]+$/.test(plan.workspaceKey || '')
    || !/^SYS-[A-Za-z0-9-]+$/.test(plan.systemId || '') || value.dataSourceId!==plan.dataSourceId
    || new URL(plan.origin).origin!==plan.origin || !['http:','https:'].includes(new URL(plan.origin).protocol)
    || !step || !['CREATE_FUNCTION','SAVE_PARAMETERS','SAVE_SOURCE','SAVE_SOURCE_PATCH','REGISTER_TOOL'].includes(step.operation)
    || !/^PR-[A-Za-z0-9-]+$/.test(step.procedureId || '') || !/^com\.golden\.[A-Za-z0-9_.]+$/.test(step.procedureAlias || '')
    || !/^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(step.funId || ''))throw new Error('Frozen native source identity is invalid');
  const modeBound=step.operation!=='REGISTER_TOOL';
  const allowed=['operation','procedureId','procedureAlias','funId','funName','expectedVersion','expectedContent','content','parameters','expectedParameters','tool','replacements','sourceOperationId',...(modeBound?['expectedIsTran','expectedIsReturn']:[])];
  if(Object.keys(step).some(k=>!allowed.includes(k)))throw new Error('Unknown source maintenance property');
  if(modeBound && ['expectedIsTran','expectedIsReturn'].some(k=>Object.hasOwn(step,k) && ![0,1].includes(step[k])))throw new Error('Frozen native function mode must be integer 0 or 1');
  if(step.operation==='SAVE_SOURCE' && (step.expectedVersion!==null && (typeof step.expectedVersion!=='string' || !step.expectedVersion) || typeof step.expectedContent!=='string'
    || typeof step.content!=='string' || step.content.length>196608))throw new Error('Source publication needs exact prior text and native version');
  if(step.operation==='SAVE_SOURCE_PATCH' && (typeof step.expectedVersion!=='string' || !step.expectedVersion
    || !/^procedure-op:v1:[a-f0-9]{64}$/.test(step.sourceOperationId || '') || !Array.isArray(step.replacements)
    || !step.replacements.length || step.replacements.length>20 || step.replacements.some(r=>Object.keys(r).some(k=>!['old','new','expectedCount'].includes(k))
      || typeof r.old!=='string' || !r.old || typeof r.new!=='string' || r.old.length>16000 || r.new.length>16000 || r.expectedCount!==1)))throw new Error('Source patch needs a verified source operation, native version and exact unique replacements');
  if(step.operation==='SAVE_PARAMETERS' && (!Array.isArray(step.parameters) || step.parameters.length>10
    || step.parameters.some(p=>!p || Object.keys(p).some(k=>!['id','name','remark'].includes(k)) || !/^\$?[A-Za-z_][A-Za-z0-9_]*$/.test(p.id))))throw new Error('Invalid frozen function parameters');
  if(step.operation==='REGISTER_TOOL' && (!step.tool || Object.keys(step.tool).some(k=>!['toolsId','toolsName','toolsRemark','toolsParam'].includes(k))
    || !/^[A-Za-z][A-Za-z0-9_.]{1,100}$/.test(step.tool.toolsId || '') || JSON.stringify(step.tool.toolsParam).length>1000))throw new Error('Invalid frozen MCP registration');
  const definition={workspaceKey:plan.workspaceKey,origin:plan.origin,systemId:plan.systemId,dataSourceId:plan.dataSourceId,
    manifestHash:crypto.createHash('sha256').update(raw).digest('hex'),...step};
  if(value.definition && JSON.stringify(value.definition)!==JSON.stringify(definition))throw new Error('Frozen native source plan changed since dispatch');
  return {action:value.action,dataSourceId:value.dataSourceId,step:value.step,definition,type:'native-metadata'};
}
module.exports={resolveNativeSource};

const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

function resolveNativeStep(value,{manifestPath=process.env.GUTHON_NATIVE_STEPS_FILE}={}) {
  const keys=['action','dataSourceId','step','definition','type'];
  if(!value || Object.keys(value).some(key=>!keys.includes(key)) || !['inspect-declared-step','run-declared-step'].includes(value.action)
    || value.type!==undefined && value.type!=='native-metadata' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.step || ''))throw new Error('Only a declared native step name may be requested');
  if(!manifestPath || !path.isAbsolute(manifestPath))throw new Error('No explicit frozen native step file is configured');
  const stat=fs.lstatSync(manifestPath);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size>65536)throw new Error('Frozen native step file must be a bounded regular file');
  const raw=fs.readFileSync(manifestPath,'utf8'),manifest=JSON.parse(raw);
  if(manifest.schemaVersion!==1 || manifest.environment!=='dev' || !/^(products|projects)\.[A-Za-z0-9_.-]+$/.test(manifest.workspaceKey || '')
    || !/^SYS-[A-Za-z0-9-]+$/.test(manifest.systemId || '') || !/^[A-Za-z0-9_-]{1,128}$/.test(manifest.dataSourceId || '')
    || new URL(manifest.origin).origin!==manifest.origin || !['http:','https:'].includes(new URL(manifest.origin).protocol)
    || !manifest.steps || Array.isArray(manifest.steps) || Object.keys(manifest.steps).length>32)throw new Error('Frozen native step scope is invalid');
  if(value.dataSourceId!==manifest.dataSourceId)throw new Error('Declared native step datasource does not match');
  const step=manifest.steps[value.step],allowed=['pageId','alias','sourceVersion','parentPageId','mutates','timeoutMs','arguments','kind','ctrlId','searchBoxId'];
  if(!step || Object.keys(step).some(key=>!allowed.includes(key)) || !/^PG-[A-Za-z0-9-]{1,96}$/.test(step.pageId || '')
    || !/^PG-[A-Za-z0-9-]{1,96}$/.test(step.parentPageId || '') || !['service','page-query'].includes(step.kind || 'service')
    || (step.kind!=='page-query' && !/^com\.golden\.[A-Za-z0-9_.]{1,220}$/.test(step.alias || ''))
    || typeof step.sourceVersion!=='string' || !step.sourceVersion || step.sourceVersion.length>128 || typeof step.mutates!=='boolean'
    || !Number.isInteger(step.timeoutMs) || step.timeoutMs<1000 || step.timeoutMs>90000
    || !step.arguments || Array.isArray(step.arguments) || typeof step.arguments!=='object' || JSON.stringify(step.arguments).length>16000)throw new Error('Declared native step definition is invalid');
  if(step.kind==='page-query') {
    if(step.mutates || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(step.ctrlId || '') || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(step.searchBoxId || '')
      || step.alias!==undefined && step.alias!=='' && !/^com\.golden\.[A-Za-z0-9_.]{1,220}$/.test(step.alias))throw new Error('Native PAGE query must be read-only with exact controls');
  } else if(step.ctrlId!==undefined || step.searchBoxId!==undefined)throw new Error('Service steps cannot override PAGE query controls');
  const checkArguments=object=>{
    if(!object || typeof object!=='object')return;
    for(const [key,entry] of Object.entries(object)){
      if(/SQL|SCRIPT|PASSWORD|TOKEN|SECRET|OPERATOR_CODE|USER_ID|IGNORE.*AUTH/i.test(key))throw new Error('Native step cannot accept code, credentials or identity overrides');
      checkArguments(entry);
    }
  };
  checkArguments(step.arguments);
  const definition={workspaceKey:manifest.workspaceKey,origin:manifest.origin,systemId:manifest.systemId,
    dataSourceId:manifest.dataSourceId,manifestHash:crypto.createHash('sha256').update(raw).digest('hex'),kind:step.kind || 'service',...step};
  if(value.definition && JSON.stringify(value.definition)!==JSON.stringify(definition))throw new Error('Declared native step changed since dispatch');
  return {action:value.action,dataSourceId:value.dataSourceId,step:value.step,definition,type:'native-metadata'};
}
module.exports={resolveNativeStep};

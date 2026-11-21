const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {resolveNativeStep}=require('./native-step-registry');

test('native steps use only the explicit frozen file and reject caller URLs, aliases, parameters and definition drift',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-step-'));
 try {
  const file=path.join(directory,'steps.json');
  const manifest={schemaVersion:1,environment:'dev',workspaceKey:'products.demo',origin:'http://platform.example',systemId:'SYS-EXAMPLE',dataSourceId:'DS_1',
   steps:{read:{pageId:'PG-SERVICE',alias:'com.golden.example.read',sourceVersion:'v1',parentPageId:'PG-PARENT',mutates:false,timeoutMs:30000,arguments:{ORG_CODE:'ORG1'}}}};
  fs.writeFileSync(file,JSON.stringify(manifest));const target={action:'run-declared-step',dataSourceId:'DS_1',step:'read'};
  const bound=resolveNativeStep(target,{manifestPath:file});assert.equal(bound.definition.arguments.ORG_CODE,'ORG1');
  assert.equal(resolveNativeStep(bound,{manifestPath:file}).definition.manifestHash,bound.definition.manifestHash);
  for(const extra of [{url:'/sql'},{alias:'other'},{params:{ORG_CODE:'OTHER'}},{step:'missing'},{dataSourceId:'OTHER'},
   {definition:{...bound.definition,arguments:{ORG_CODE:'OTHER'}}}])assert.throws(()=>resolveNativeStep({...target,...extra},{manifestPath:file}));
  assert.throws(()=>resolveNativeStep(target,{manifestPath:''}));
  manifest.steps.read.arguments={OPERATOR_CODE:'forged'};fs.writeFileSync(file,JSON.stringify(manifest));
  assert.throws(()=>resolveNativeStep(target,{manifestPath:file}),/identity overrides/);
 } finally {fs.rmSync(directory,{recursive:true,force:true});}
});

test('frozen PAGE queries need real control identities and cannot declare mutation',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-page-query-'));
 try {
  const file=path.join(directory,'steps.json'),manifest={schemaVersion:1,environment:'dev',workspaceKey:'products.demo',origin:'http://platform.example',systemId:'SYS-EXAMPLE',dataSourceId:'DS_1',steps:{read:{kind:'page-query',pageId:'PG-PAGE',sourceVersion:'v1',parentPageId:'PG-PARENT',mutates:false,timeoutMs:30000,ctrlId:'mainTable',searchBoxId:'searchForm',arguments:{ORG_CODE:'ORG1'}}}};
  fs.writeFileSync(file,JSON.stringify(manifest));const target={action:'run-declared-step',dataSourceId:'DS_1',step:'read'};
  assert.equal(resolveNativeStep(target,{manifestPath:file}).definition.kind,'page-query');
  manifest.steps.read.mutates=true;fs.writeFileSync(file,JSON.stringify(manifest));assert.throws(()=>resolveNativeStep(target,{manifestPath:file}),/read-only/);
 } finally {fs.rmSync(directory,{recursive:true,force:true});}
});

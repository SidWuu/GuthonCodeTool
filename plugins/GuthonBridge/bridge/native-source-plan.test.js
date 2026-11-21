const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {resolveNativeSource}=require('./native-source-plan');
test('source maintenance accepts only local frozen identities and rejects request code or source drift',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'source-plan-')),file=path.join(d,'plan.json');
 try{
 const plan={schemaVersion:1,environment:'dev',workspaceKey:'products.demo',origin:'http://platform.example',systemId:'SYS-EXAMPLE',dataSourceId:'DS_1',steps:{create:{operation:'CREATE_FUNCTION',procedureId:'PR-EXAMPLE',procedureAlias:'com.golden.example',funId:'riskData',funName:'Risk'}}};
 fs.writeFileSync(file,JSON.stringify(plan));const request={action:'apply-native-source',dataSourceId:'DS_1',step:'create'};
 const bound=resolveNativeSource(request,{manifestPath:file});assert.equal(bound.definition.funId,'riskData');
 for(const change of [{content:'bad()'},{url:'/sql'},{dataSourceId:'OTHER'},{step:'missing'}])assert.throws(()=>resolveNativeSource({...request,...change},{manifestPath:file}));
 plan.steps.create.funName='changed';fs.writeFileSync(file,JSON.stringify(plan));assert.throws(()=>resolveNativeSource(bound,{manifestPath:file}),/changed/);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('large-source patch plans require reviewed unique fragments and reject caller supplied patch data',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'source-patch-')),file=path.join(d,'plan.json');
 try{
 const source={operation:'SAVE_SOURCE_PATCH',procedureId:'PR-EXAMPLE',procedureAlias:'com.golden.example',funId:'riskData',expectedVersion:'v1',sourceOperationId:'procedure-op:v1:'+'a'.repeat(64),replacements:[{old:'old()',new:'new()',expectedCount:1}]};
 const plan={schemaVersion:1,environment:'dev',workspaceKey:'products.demo',origin:'http://platform.example',systemId:'SYS-EXAMPLE',dataSourceId:'DS_1',steps:{patch:source}};
 const request={action:'apply-native-source',dataSourceId:'DS_1',step:'patch'};
 fs.writeFileSync(file,JSON.stringify(plan));assert.equal(resolveNativeSource(request,{manifestPath:file}).definition.operation,'SAVE_SOURCE_PATCH');
 assert.throws(()=>resolveNativeSource({...request,replacements:source.replacements},{manifestPath:file}));
 for(const change of [{expectedVersion:''},{sourceOperationId:''},{replacements:[{old:'',new:'x',expectedCount:1}]},{replacements:[{old:'x',new:'y',expectedCount:2}]}]){
  plan.steps.patch={...source,...change};fs.writeFileSync(file,JSON.stringify(plan));assert.throws(()=>resolveNativeSource(request,{manifestPath:file}));
 }
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('function creation, parameter and source saves may freeze integer transaction and return modes',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'source-mode-')),file=path.join(d,'plan.json');
 try{
  const identity={procedureId:'PR-EXAMPLE',procedureAlias:'com.golden.example',funId:'riskData'};
  const plan={schemaVersion:1,environment:'dev',workspaceKey:'products.demo',origin:'http://platform.example',systemId:'SYS-EXAMPLE',dataSourceId:'DS_1',steps:{}};
  const request={action:'apply-native-source',dataSourceId:'DS_1',step:'source'};
  const resolve=step=>{plan.steps.source=step;fs.writeFileSync(file,JSON.stringify(plan));return resolveNativeSource(request,{manifestPath:file});};
  for(const source of [
   {...identity,operation:'CREATE_FUNCTION'},
   {...identity,operation:'SAVE_PARAMETERS',parameters:[]},
   {...identity,operation:'SAVE_SOURCE',expectedVersion:'v1',expectedContent:'old',content:'new'},
   {...identity,operation:'SAVE_SOURCE_PATCH',expectedVersion:'v1',sourceOperationId:'procedure-op:v1:'+'a'.repeat(64),replacements:[{old:'old',new:'new',expectedCount:1}]}
  ]){
   assert.equal(resolve(source).definition.expectedIsTran,undefined);
   for(const key of ['expectedIsTran','expectedIsReturn']){
    for(const valid of [0,1])assert.equal(resolve({...source,[key]:valid}).definition[key],valid);
    for(const invalid of [null,'0','1',false,true,-1,2,0.5,{},[]])assert.throws(()=>resolve({...source,[key]:invalid}),/integer 0 or 1/);
   }
   const bound=resolve({...source,expectedIsTran:1,expectedIsReturn:0});
   plan.steps.source.expectedIsReturn=1;fs.writeFileSync(file,JSON.stringify(plan));
   assert.throws(()=>resolveNativeSource(bound,{manifestPath:file}),/changed/);
  }
  for(const key of ['expectedIsTran','expectedIsReturn'])assert.throws(()=>resolve({...identity,operation:'REGISTER_TOOL',[key]:1}),/Unknown source maintenance property/);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('service PAGE source inspection accepts only frozen read-only identity',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'page-inspect-')),file=path.join(d,'plan.json');
 try {
  const step={operation:'INSPECT_PAGE_SOURCE',pageId:'PG-EXAMPLE',alias:'com.golden.example.service'};
  const plan={schemaVersion:1,environment:'dev',workspaceKey:'products.demo',origin:'http://platform.example',systemId:'SYS-EXAMPLE',dataSourceId:'DS_1',steps:{inspect:step}};
  const request={action:'inspect-native-source',dataSourceId:'DS_1',step:'inspect'};
  fs.writeFileSync(file,JSON.stringify(plan));const bound=resolveNativeSource(request,{manifestPath:file});
  assert.equal(bound.definition.alias,step.alias);
  for(const input of [{action:'apply-native-source'},{content:'code'},{replacements:[]},{dataSourceId:'OTHER'}])assert.throws(()=>resolveNativeSource({...request,...input},{manifestPath:file}));
  plan.steps.inspect.alias='com.golden.example.other';fs.writeFileSync(file,JSON.stringify(plan));assert.throws(()=>resolveNativeSource(bound,{manifestPath:file}),/changed/);
 } finally {fs.rmSync(d,{recursive:true,force:true});}
});

test('frozen service source patch binds native mode, prior source and controlled hash',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'page-save-')),file=path.join(d,'plan.json');
 try {
  const step={operation:'SAVE_PAGE_SOURCE_PATCH',pageId:'PG-EXAMPLE',alias:'com.golden.example.service',expectedVersion:'v1',expectedContent:'old()',expectedRunInTran:1,sourceHash:'a'.repeat(64),replacements:[{old:'old()',new:'new()',expectedCount:1}]};
  const plan={schemaVersion:1,environment:'dev',workspaceKey:'products.demo',origin:'http://platform.example',systemId:'SYS-EXAMPLE',dataSourceId:'DS_1',steps:{save:step}};
  const request={action:'apply-native-source',dataSourceId:'DS_1',step:'save'};
  const resolve=change=>{plan.steps.save={...step,...change};fs.writeFileSync(file,JSON.stringify(plan));return resolveNativeSource(request,{manifestPath:file});};
  assert.equal(resolve({}).definition.expectedRunInTran,1);
  for(const mode of [0,1,10])assert.equal(resolve({expectedRunInTran:mode}).definition.expectedRunInTran,mode);
  for(const invalid of [{expectedRunInTran:null},{expectedRunInTran:'1'},{expectedRunInTran:2},{sourceHash:''},{expectedVersion:''},{replacements:[{old:'old()',new:'new()',expectedCount:2}]},{sql:'X'}])assert.throws(()=>resolve(invalid));
  const bound=resolve({});plan.steps.save.expectedContent='changed';fs.writeFileSync(file,JSON.stringify(plan));assert.throws(()=>resolveNativeSource(bound,{manifestPath:file}),/changed/);
  assert.throws(()=>resolveNativeSource({...request,content:'caller code'},{manifestPath:file}));
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});

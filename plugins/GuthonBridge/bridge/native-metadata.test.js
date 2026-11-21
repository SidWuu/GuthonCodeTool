const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {metadataTarget,createMetadataJournal}=require('./native-metadata');

test('native metadata target accepts only exact GUID operations and no caller supplied URL/body/SQL',()=>{
  const valid={action:'inspect-guid',dataSourceId:'DS_1',tableId:'EXAMPLE',fieldId:'ROW_ID'};
  assert.equal(metadataTarget(valid).type,'native-metadata');
  for(const extra of [{url:'/admin'},{sql:'UPDATE X'},{isIncrement:1},{action:'createTable'},{expectedSnapshot:'not allowed'}])
    assert.throws(()=>metadataTarget({...valid,...extra}));
  assert.throws(()=>metadataTarget({...valid,tableId:'EXAMPLE;DELETE'}));
  assert.throws(()=>metadataTarget({...valid,action:'set-guid'}));
  assert.throws(()=>metadataTarget({...valid,action:'sync-page-guid',expectedSnapshot:'snapshot'}));
  assert.throws(()=>metadataTarget({...valid,pageId:'PG-EXAMPLE'}));
  assert.equal(metadataTarget({...valid,action:'sync-page-guid',expectedSnapshot:'snapshot',pageId:'PG-EXAMPLE'}).pageId,'PG-EXAMPLE');
});

test('metadata intent and receipt survive retries/restart without dispatching again',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-metadata-journal-'));
  try{
    const payload={workspaceKey:'products.demo',contextId:'context',idempotencyKey:'guid-change-001',
      target:{action:'set-guid',dataSourceId:'DS_1',tableId:'EXAMPLE',fieldId:'ROW_ID',expectedSnapshot:'snapshot'}};
    const context={contextId:'context',pageOrigin:'http://platform.example'};let writes=0;
    const send=()=>{writes++;return {requestId:'original-request'};};
    const journal=createMetadataJournal(directory);
    assert.equal(journal.dispatch(payload,context,send).state,'PENDING');
    assert.equal(journal.dispatch(payload,context,send).replayed,false);assert.equal(writes,1);
    assert.throws(()=>journal.dispatch({...payload,target:{...payload.target,fieldId:'OTHER'}},context,send),/different parameters/);
    const final=journal.result(payload.workspaceKey,payload.idempotencyKey,()=>({state:'SUCCEEDED',data:{state:'SUCCEEDED',after:{isIncrement:2}}}));
    assert.equal(final.data.after.isIncrement,2);
    const reopened=createMetadataJournal(directory);
    assert.equal(reopened.result(payload.workspaceKey,payload.idempotencyKey,()=>{throw Error('No in-memory receipt');}).data.state,'SUCCEEDED');
    reopened.dispatch(payload,context,send);assert.equal(writes,1);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('dispatch intent with unavailable transport remains recorded and cannot be replayed',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-metadata-unknown-'));
  try{
    const journal=createMetadataJournal(directory),payload={workspaceKey:'products.demo',idempotencyKey:'unknown-change-001',
      target:{action:'inspect-guid',dataSourceId:'DS_1',tableId:'EXAMPLE',fieldId:'ROW_ID'}};
    const context={contextId:'context',pageOrigin:'http://platform.example'};let sends=0;
    assert.throws(()=>journal.dispatch(payload,context,()=>{sends++;throw Error('disconnected');}),/disconnected/);
    assert.equal(journal.dispatch(payload,context,()=>{sends++;}).replayed,false);
    assert.equal(journal.result(payload.workspaceKey,payload.idempotencyKey,()=>{}).state,'UNKNOWN');assert.equal(sends,1);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('native record target rejects caller identity, arbitrary payloads, updates and primary-operation flags',()=>{
  const valid={action:'save-native-record',dataSourceId:'DS_1',pageId:'PG-RECORD',parentPageId:'PG-PARENT',bntId:'a'.repeat(32),expectedVersion:'v1',inputForm:{CODE:'TEST'}};
  assert.equal(metadataTarget(valid).inputForm.CODE,'TEST');
  for(const change of [{url:'/sql'},{sql:'UPDATE T SET X=1'},{action:'update-native-record'},{inputForm:{OPERATOR_CODE:'forged'}},{inputForm:{_OPT_TYPE_:'2'}},{inputForm:{CODE:{sql:'x'}}}])assert.throws(()=>metadataTarget({...valid,...change}));
});

test('native script publication requires an exact reviewed source operation and existing save-hook pointer',()=>{
 const target={action:'apply-page-script',dataSourceId:'DS_1',pageId:'PG-EXAMPLE',jsonPointer:'/modalSaveBnt/serviceEvents/beforeSaveScript',
  expectedVersion:'v1',expectedContent:'old()',content:'new()',sourceOperationId:'page-op:v1:'+'a'.repeat(64)};
 assert.equal(metadataTarget(target).content,'new()');
 for(const change of [{sourceOperationId:undefined},{jsonPointer:'/views/rows/0/component/datasource/sql'},{url:'/runScript'},{expectedVersion:''}])assert.throws(()=>metadataTarget({...target,...change}));
});

test('reviewed main-form save hooks permit an explicit missing prior script and reject other owners',()=>{
 const target={action:'apply-page-script',dataSourceId:'DS_1',pageId:'PG-EXAMPLE',jsonPointer:'/views/rows/0/component/buttons/0/serviceEvents/beforeSaveScript',
  expectedVersion:'v1',expectedContent:null,content:'new()',sourceOperationId:'page-op:v1:'+'a'.repeat(64)};
 assert.equal(metadataTarget(target).expectedContent,null);
 for(const change of [{expectedContent:undefined},{expectedContent:0},{content:null},{jsonPointer:'/views/rows/0/component/params/serviceEvents/beforeSaveScript'}])assert.throws(()=>metadataTarget({...target,...change}));
});

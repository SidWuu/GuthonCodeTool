const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function metadataTarget(value) {
  if(['inspect-native-source','apply-native-source'].includes(value?.action))return require('./native-source-plan').resolveNativeSource(value);
  if(['inspect-declared-step','run-declared-step'].includes(value?.action))return require('./native-step-registry').resolveNativeStep(value);
  if (['apply-page-script','inspect-page-script'].includes(value?.action)) {
    const keys=['action','dataSourceId','pageId','jsonPointer','expectedVersion','expectedContent','content','sourceOperationId','type'];
    if(Object.keys(value).some(key=>!keys.includes(key)) || value.type !== undefined && value.type !== 'native-metadata')throw new Error('Unknown native script publication property');
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(value.dataSourceId || '') || !/^PG-[A-Za-z0-9-]{1,96}$/.test(value.pageId || '')
      || !/^\/(modalSaveBnt|views\/rows\/\d+\/component\/buttons\/\d+)\/serviceEvents\/(beforeSaveScript|saveDataScript|afterSaveScript|complateSaveScript)$/.test(value.jsonPointer || ''))throw new Error('Only a hook of an exact native save button is supported');
    if(value.action==='apply-page-script') {
      if(typeof value.expectedVersion!=='string' || !value.expectedVersion || value.expectedVersion.length>128
        || !/^page-op:v1:[a-f0-9]{64}$/.test(value.sourceOperationId || ''))throw new Error('Script publication needs a native version and verified source operation identity');
      if(value.expectedContent!==null && (typeof value.expectedContent!=='string' || value.expectedContent.length>16000))throw new Error('Expected script must be bounded text, or null for a missing hook');
      if(typeof value.content!=='string' || value.content.length>16000)throw new Error('Script publication needs bounded candidate content');
    } else if(['expectedVersion','expectedContent','content','sourceOperationId'].some(key=>value[key]!==undefined))throw new Error('Script inspection cannot publish content');
    return {...value,type:'native-metadata'};
  }
  if (['save-native-record','prepare-native-record'].includes(value?.action)) {
    const keys = ['action','dataSourceId','pageId','parentPageId','bntId','expectedVersion','inputForm','type'];
    if (Object.keys(value).some(key => !keys.includes(key)) || value.type !== undefined && value.type !== 'native-metadata') throw new Error('Unknown native record property');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(value.dataSourceId || '') || !/^PG-[A-Za-z0-9-]{1,96}$/.test(value.pageId || '')
        || !/^PG-[A-Za-z0-9-]{1,96}$/.test(value.parentPageId || '') || !/^[A-Fa-f0-9]{32}$/.test(value.bntId || '') || typeof value.expectedVersion !== 'string' || !value.expectedVersion || value.expectedVersion.length > 128) throw new Error('Native record needs exact datasource, PAGE, button and source version');
    if (!value.inputForm || Array.isArray(value.inputForm) || typeof value.inputForm !== 'object' || JSON.stringify(value.inputForm).length > 16000) throw new Error('Native record needs a bounded inputForm');
    for (const [key,entry] of Object.entries(value.inputForm)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || entry !== null && !['string','number','boolean'].includes(typeof entry)) throw new Error('Only scalar native fields are supported');
      if (/^(OPERATOR_|DATA_SYSTEMDATE$|DATA_TIMESTAMP$|_PK_|_OPT_TYPE_|_BILL_TYPE_CODE_)/.test(key)) throw new Error('Caller cannot supply managed identity, timestamps or operation flags');
    }
    return {...value,type:'native-metadata'};
  }
  const keys = ['action','dataSourceId','tableId','fieldId','expectedSnapshot','pageId','type'];
  if (!value || Object.keys(value).some(key => !keys.includes(key)) || !['inspect-guid','set-guid','inspect-page-guid','sync-page-guid','inspect-runtime'].includes(value.action)) throw new Error('Unsupported native metadata action or property');
  if(value.type !== undefined && value.type !== 'native-metadata')throw new Error('Wrong native metadata command type');
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(value.dataSourceId || ''))throw new Error('Native metadata needs an exact datasource');
  for (const key of ['tableId','fieldId']) if (!/^[A-Za-z0-9_]{1,128}$/.test(value[key] || '')) throw new Error('Native metadata needs exact table/field identities');
  if (['set-guid','sync-page-guid'].includes(value.action) && (typeof value.expectedSnapshot !== 'string' || !value.expectedSnapshot || value.expectedSnapshot.length > 16000)) throw new Error('GUID update needs a bounded native inspection snapshot');
  if (value.action.startsWith('inspect-') && value.expectedSnapshot !== undefined) throw new Error('Inspection cannot supply a previous snapshot');
  if (value.action.endsWith('page-guid') ? !/^PG-[A-Za-z0-9-]{1,96}$/.test(value.pageId || '') : value.pageId !== undefined) throw new Error('PAGE identity is required only for PAGE GUID synchronization');
  return {...Object.fromEntries(keys.filter(key => key !== 'type' && value[key] !== undefined).map(key => [key,value[key]])),type:'native-metadata'};
}

function createMetadataJournal(directory) {
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Metadata journal cannot use a symlink');
  const file = (workspaceKey,key) => {
    if (!/^[A-Za-z0-9_.:-]{8,160}$/.test(key || '')) throw new Error('Native metadata request needs a stable idempotencyKey');
    return path.join(directory,crypto.createHash('sha256').update(workspaceKey+'\n'+key).digest('hex')+'.json');
  };
  const read = name => {
    try {
      const stat=fs.lstatSync(name);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size>50000) throw new Error('Metadata journal is not a bounded regular file');
      return JSON.parse(fs.readFileSync(name,'utf8'));
    } catch(error) {if(error.code==='ENOENT')return undefined;throw error;}
  };
  const save = (name,record) => {
    const temporary=name+'.'+crypto.randomUUID()+'.tmp';
    fs.writeFileSync(temporary,JSON.stringify(record),{flag:'wx',mode:0o600});
    fs.renameSync(temporary,name);
  };
  return {
    dispatch(payload,context,send) {
      const target=metadataTarget(payload.target),name=file(payload.workspaceKey,payload.idempotencyKey);
      const fingerprint=crypto.createHash('sha256').update(JSON.stringify({workspaceKey:payload.workspaceKey,
        contextId:context.contextId,pageOrigin:context.pageOrigin,target})).digest('hex');
      const previous=read(name);
      if(previous){if(previous.fingerprint!==fingerprint)throw new Error('Metadata idempotencyKey was used with different parameters');return {...previous,replayed:false};}
      const record={workspaceKey:payload.workspaceKey,idempotencyKey:payload.idempotencyKey,fingerprint,
        state:'DISPATCH_RESERVED',requestId:null,createdAt:new Date().toISOString()};
      save(name,record);
      const accepted=send({...payload,target});
      record.requestId=accepted.requestId;record.state='PENDING';save(name,record);
      return record;
    },
    result(workspaceKey,key,lookup) {
      const name=file(workspaceKey,key),record=read(name);
      if(!record)throw new Error('Metadata request was not recorded');
      if(record.data)return record;
      if(!record.requestId)return {...record,state:'UNKNOWN',message:'Dispatch intent exists without a receipt; inspect field, do not replay'};
      let receipt;
      try{receipt=lookup({workspaceKey,requestId:record.requestId});}
      catch{return {...record,state:'UNKNOWN',message:'Original receipt unavailable; inspect field, do not replay'};}
      if(receipt.state==='PENDING')return record;
      record.state=receipt.state;record.data=receipt.data;record.message=receipt.message;
      save(name,record);return record;
    }
  };
}
module.exports={metadataTarget,createMetadataJournal};

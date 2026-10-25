const test=require('node:test');
const assert=require('node:assert/strict');
const {PageStateReceiver}=require('../src/page-editor/state');
const baseline={pageId:'PG-1',collections:[{pointer:'/fields',reorderable:true,fields:[
  {key:'A',editable:true,properties:[{name:'label',value:'A'}]},{key:'B',editable:true,properties:[{name:'label',value:'B'}]}
]}],nodes:[{key:'sql',pointer:'/sql',editable:true,content:'select 1'}]};
const property={kind:'property',collectionPointer:'/fields',fieldKey:'A',property:'label',value:'draft'};

test('baseline-bound patches preserve metadata and revert removed changes including order and text',()=>{
  const receiver=new PageStateReceiver();
  const first=receiver.receive({update:'full',sequence:1,baseline,operations:[property],pageName:'page',comparison:{svn:{available:true},local:{total:1}}});
  assert.equal(first.state.model.collections[0].fields[0].properties[0].value,'draft');
  const model=first.state.model;
  const second=receiver.receive({update:'patch',sequence:2,baseSequence:1,operations:[property,{kind:'order',collectionPointer:'/fields',fieldKeys:['B','A']},{kind:'text',jsonPointer:'/sql',content:'select 2'}],pageName:'page',comparison:{local:{total:3}}});
  assert.equal(second.state.model,model);assert.equal(second.state.model.collections[0].fields[0].key,'B');
  assert.equal(second.state.comparison.svn.available,true);
  const unchanged=receiver.receive({update:'patch',sequence:3,baseSequence:2,pageName:'renamed',comparison:{sourceStale:false}});
  assert.deepEqual(unchanged.changes,[]);assert.equal(unchanged.state.operations.length,3);
  assert.equal(unchanged.state.model.pageName,'renamed');
  const undone=receiver.receive({update:'patch',sequence:4,baseSequence:3,operations:[],pageName:'renamed'});
  assert.equal(undone.state.model.collections[0].fields[0].key,'A');
  assert.equal(undone.state.model.collections[0].fields[0].properties[0].value,'A');
  assert.equal(undone.state.model.nodes[0].content,'select 1');
});

test('missing patches request resynchronization and late messages cannot overwrite a new full baseline',()=>{
  const receiver=new PageStateReceiver();
  assert.equal(receiver.receive({update:'patch',sequence:2,baseSequence:1}),null);
  receiver.receive({update:'full',sequence:3,baseline,operations:[],pageName:'new'});
  assert.equal(receiver.receive({update:'patch',sequence:5,baseSequence:4}),null);
  assert.equal(receiver.receive({update:'patch',sequence:2,baseSequence:1}).ignored,true);
  assert.equal(receiver.state.model.pageName,'new');
});

test('replacing five hundred pending changes reverts old values before applying the new snapshot',()=>{
  const receiver=new PageStateReceiver();
  const model={pageId:'PG-LARGE',collections:[{pointer:'/fields',reorderable:true,fields:Array.from({length:1000},(_,index)=>({
    key:'F'+index,editable:true,properties:[{name:'label',value:'original-'+index}]
  }))}],nodes:[]};
  const operations=(start,value)=>Array.from({length:500},(_,index)=>({kind:'property',collectionPointer:'/fields',fieldKey:'F'+(start+index),property:'label',value}));
  receiver.receive({update:'full',sequence:1,baseline:model,operations:operations(0,'first'),pageName:'large'});
  const result=receiver.receive({update:'patch',sequence:2,baseSequence:1,operations:operations(500,'second'),pageName:'large'});
  assert.equal(result.changes.length,1000);assert.equal(result.state.operations.length,500);
  assert.equal(result.state.model.collections[0].fields[0].properties[0].value,'original-0');
  assert.equal(result.state.model.collections[0].fields[499].properties[0].value,'original-499');
  assert.equal(result.state.model.collections[0].fields[500].properties[0].value,'second');
  assert.equal(result.state.model.collections[0].fields[999].properties[0].value,'second');
  assert.equal(receiver.draft.past.length,0);assert.equal(receiver.draft.future.length,0);
});

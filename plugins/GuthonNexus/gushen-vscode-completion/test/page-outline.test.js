const test = require('node:test');
const assert = require('node:assert/strict');
const {buildOutline} = require('../src/page-editor/outline');
const {PageDraft} = require('../src/page-editor/model');

function fixture() {
  const source = {pageId:'PG-TREE',pageName:'开票申请',pageSetup:{pageEvents:{onCreateScript:'create();'},
    serviceEvents:{onLoadScript:'load();'}},views:{rows:[{cols:[
    {component:{name:'searchForm',type:'search-box',fields:[{fieldId:'DATE'},{fieldId:'NO'}],
      buttons:[{id:'query',name:'查询'}],datasource:{sql:'select 1',fields:[{name:'metadata only'}]}}},
    {tabs:{name:'业务明细',pages:[
      {name:'开票明细',rows:[{component:{name:'detailTable',type:'table-item',fields:[{fieldId:'NO'}]}}]},
      {name:'税额',rows:[{component:{name:'taxdetailTable',type:'table-item',buttons:[]}}]},
    ]}},
  ]}]}};
  const search='/views/rows/0/cols/0/component',detail='/views/rows/0/cols/1/tabs/pages/0/rows/0/component';
  const model={pageId:source.pageId,pageName:source.pageName,collections:[
    {pointer:search+'/fields',regionPointer:search,region:'SEARCH',kind:'FIELDS',label:'searchForm',reorderable:true,
      fields:[{key:'fieldId:DATE',pointer:search+'/fields/0',label:'日期',editable:true,properties:[{name:'label',value:'日期'}]},
        {key:'fieldId:NO',pointer:search+'/fields/1',label:'单据号',properties:[]}]},
    {pointer:detail+'/fields',regionPointer:detail,region:'DETAIL_TABLE',kind:'FIELDS',label:'detailTable',fields:[
      {key:'fieldId:NO',pointer:detail+'/fields/0',label:'业务单据号',properties:[]}]},
    {pointer:search+'/buttons',regionPointer:search,region:'SEARCH',kind:'BUTTONS',label:'searchForm',fields:[
      {key:'id:query',pointer:search+'/buttons/0',label:'查询',properties:[]}]},
  ],nodes:[
    {key:'create',pointer:'/pageSetup/pageEvents/onCreateScript',type:'SCRIPT'},
    {key:'load',pointer:'/pageSetup/serviceEvents/onLoadScript',type:'SCRIPT',eventScope:'SERVICE'},
    {key:'sql',pointer:search+'/datasource/sql',type:'SQL'},
    {key:'date-change',pointer:search+'/fields/0/pageEvents/onChangeScript',type:'SCRIPT'},
    {key:'query-click',pointer:search+'/buttons/0/pageEvents/onClickScript',type:'SCRIPT'},
    {key:'query-service',pointer:search+'/buttons/0/serviceEvents/onClickScript',type:'SCRIPT',eventScope:'SERVICE'},
    {key:'detail-load',pointer:detail+'/pageEvents/onLoadScript',type:'SCRIPT'},
  ]};
  return {source,model,search,detail};
}
const flatten = entries => entries.flatMap(entry=>[entry,...flatten(entry.children)]);

test('outline hides row and column wrappers while preserving meaningful tabs and original source pointers',()=>{
  const f=fixture(),outline=buildOutline(f.source,f.model);
  const [search,tabs]=outline.layout;assert.equal(search.pointer,f.search);
  assert.equal(tabs.kind,'tabs');assert.equal(tabs.label,'业务明细');
  assert.deepEqual(tabs.children.map(entry=>[entry.kind,entry.label]),[['tab','开票明细'],['tab','税额']]);
  assert.equal(tabs.children[0].children[0].pointer,f.detail);
  const empty=tabs.children[1].children[0];
  assert.equal(empty.label,'taxdetailTable');assert.equal(empty.kind,'region');
  assert.deepEqual(empty.collectionPointers,[]);
  assert.equal(flatten(outline.layout).some(entry=>['row','column'].includes(entry.kind)),false);
  assert.equal(flatten(outline.layout).some(entry=>/datasource|fields|buttons/.test(entry.pointer)),false);
});

test('generated tab wrappers disappear, explicit tab captions take precedence, wrapper events remain reachable',()=>{
  const page={pageId:'PG-COMPACT',views:{rows:[
    {component:{name:'inputForm',type:'input-box'}},
    {tabs:{name:'tabPage',aliasName:'tabPage',pages:[{name:'tabPage0',label:'tabPage0',rows:[{component:{name:'detailTable',type:'table-item'}}]}]}},
  ]}};
  const model={collections:[],nodes:[
    {key:'row-event',pointer:'/views/rows/0/pageEvents/onLoadScript',type:'SCRIPT'},
    {key:'tabs-event',pointer:'/views/rows/1/tabs/pageEvents/onLoadScript',type:'SCRIPT'},
  ]};
  const outline=buildOutline(page,model);
  assert.deepEqual(outline.layout.map(entry=>entry.label),['inputForm','detailTable']);
  assert.deepEqual(new Set(outline.pageNodeKeys),new Set(['row-event','tabs-event']));
  assert.equal(outline.layout[1].pointer,'/views/rows/1/tabs/pages/0/rows/0/component');
  page.views.rows[1].tabs.pages[0].label='入库明细';
  const named=buildOutline(page,model);
  assert.equal(named.layout[1].kind,'tab');assert.equal(named.layout[1].label,'入库明细');
  assert.equal(named.layout[1].children[0].label,'detailTable');
});

test('page events and region SQL are assigned once, while field/button events stay with their owners',()=>{
  const f=fixture(),outline=buildOutline(f.source,f.model),entries=flatten(outline.layout);
  assert.deepEqual(outline.pageNodeKeys,['create','load']);
  const search=entries.find(entry=>entry.pointer===f.search);
  assert.deepEqual(search.nodeKeys,['sql']);assert.equal(search.collectionPointers.length,2);
  assert.deepEqual(entries.find(entry=>entry.pointer===f.detail).nodeKeys,['detail-load']);
  const free=[...outline.pageNodeKeys,...entries.flatMap(entry=>entry.nodeKeys)];
  assert.deepEqual(free.sort(),['create','detail-load','load','sql']);assert.equal(new Set(free).size,free.length);
  const ownerKeys=f.model.collections.flatMap(collection=>collection.fields.flatMap(field=>f.model.nodes.filter(node=>
    node.pointer.startsWith(field.pointer+'/')).map(node=>node.key)));
  assert.deepEqual([...free,...ownerKeys].sort(),f.model.nodes.map(node=>node.key).sort());
});

test('navigation keeps stable collection references while draft names and field order change',()=>{
  const f=fixture(),before=JSON.stringify(f.source);f.model.outline=buildOutline(f.source,f.model);
  const draft=new PageDraft(f.model);
  draft.property(f.search+'/fields','fieldId:DATE','label','业务日期');
  draft.order(f.search+'/fields',['fieldId:NO','fieldId:DATE']);
  assert.deepEqual(draft.model.outline,f.model.outline);
  assert.equal(draft.model.collections[0].fields[1].properties[0].value,'业务日期');
  assert.equal(JSON.stringify(f.source),before);
  assert.deepEqual(flatten(draft.model.outline.layout).find(entry=>entry.pointer===f.search).collectionPointers,
    [f.search+'/fields',f.search+'/buttons']);
});

test('layout-only scripts and escaped container paths remain reachable without exposing metadata as containers',()=>{
  const page={pageId:'PG-EMPTY',views:{'named/container~':{name:'外层容器',rows:[
    {component:{name:'onlyScripts',type:'custom-widget',pageEvents:{onCreateScript:'create();'}}},
  ]}}};
  const pointer='/views/named~1container~0/rows/0/component';
  const model={collections:[],nodes:[{key:'script',pointer:pointer+'/pageEvents/onCreateScript'}]};
  // A nonstandard wrapper that owns recognized UI remains part of its real path.
  model.collections=[{pointer:pointer+'/fields',region:'UNKNOWN',fields:[]}];
  const outline=buildOutline(page,model),entry=flatten(outline.layout).find(item=>item.pointer===pointer);
  assert.equal(outline.layout[0].label,'外层容器');assert.deepEqual(entry.nodeKeys,['script']);
  assert.equal(entry.kind,'region');assert.deepEqual(outline.pageNodeKeys,[]);
  const scriptOnly={pageId:'PG-EMPTY',views:{rows:[{component:{name:'onlyScripts',type:'custom-widget',pageEvents:{onCreateScript:'create();'}}}]}};
  const simple=buildOutline(scriptOnly,{collections:[],nodes:[{key:'script',pointer:'/views/rows/0/component/pageEvents/onCreateScript'}]});
  assert.deepEqual(flatten(simple.layout).find(item=>item.label==='onlyScripts').nodeKeys,['script']);
});

test('empty PAGE does not invent event or layout entries',()=>{
  assert.deepEqual(buildOutline({pageId:'PG-EMPTY'},{collections:[],nodes:[]}),{layout:[],pageNodeKeys:[]});
});

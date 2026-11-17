const test=require('node:test'),assert=require('node:assert/strict');
const {enrichCompletionData,mergeApiCompletionItems}=require('../src/api-completion');
const {filterItems,itemBodyToSnippet,mergeCompletionData}=require('../src/rules');
test('qualified and short signatures merge aliases, preserving insertion and source objects',()=>{
  const first={prefix:'quick.find',aliases:['find'],apiPath:'$vs.db.find',signature:'find($sql:string,$where:Map<string, ?>):List<Map<string, ?>>',body:'$vs.db.find(sql,where)',group:'db'};
  const second={prefix:'$vs.db.find',aliases:['lookup'],apiPath:'$vs.db.find',signature:'$vs.db.find( $sql: string, $where: Map<string,?> ): List<Map<string,?>>',body:'$vs.db.find(sql,where)'};
  const original=structuredClone(first),items=mergeApiCompletionItems([first],[second]),[item]=items;
  assert.equal(items.length,1);
  assert.equal(item.body,first.body);assert.equal(item.signature,first.signature);assert.equal(item.prefix,'quick.find');
  assert.deepEqual(item.aliases,['quick.find','find','$vs.db.find','lookup']);assert.deepEqual(first,original);
  for(const word of ['quick.find','lookup','find','$vs.db.'])assert.equal(filterItems({java:items},{source:'java'},word).length,1,word);
  assert.equal(itemBodyToSnippet(item.body),itemBodyToSnippet(first.body));
});
test('different owners, argument counts, types and defaults remain distinct overloads',()=>{
  const signatures=['find(x:string):void','find(x:number):void','find(x:string,y:number):void','find(x:string="a"):void','find(x:string="b"):void','find(x:string="a b"):void','find(x:string="ab"):void'];
  const items=signatures.map(signature=>({prefix:'find',apiPath:'$vs.db.find',signature,body:'$vs.db.find(x)'}));
  items.push({...items[0],apiPath:'$vs.other.find',body:'$vs.other.find(x)'});
  assert.equal(mergeApiCompletionItems(items,items).length,items.length);
});
test('legacy JavaScript templates match a unique signature and retain the original shortcut',()=>{
  const legacy={prefix:'gu.trim',group:'gu',body:'gUtil.trim(str)',description:'original'};
  const reference={prefix:'gUtil.trim',aliases:['trim'],apiPath:'gUtil.trim',signature:'gUtil.trim(str:string):string',body:'gUtil.trim(str)'};
  const items=mergeApiCompletionItems([legacy,legacy],[reference,reference]);
  assert.equal(items.length,1);assert.equal(items[0].prefix,'gu.trim');assert.equal(items[0].body,legacy.body);
  for(const word of ['gu.trim','trim','gUtil.trim'])assert.equal(filterItems({javascript:items},{source:'javascript'},word).length,1);
  const typedOverload={...reference,signature:'gUtil.trim(str:object):string'};
  assert.equal(mergeApiCompletionItems([legacy],[reference,typedOverload]).length,3);
});
test('syntax snippets and special insertion templates remain verbatim',()=>{
  const snippets=[{prefix:'if',group:'syntax',body:['#if ($1)','$2','#end']},
    {prefix:'custom',body:'before(); after();'}, {prefix:'vs',body:'$vs',completionKind:'module',apiPath:'$vs'}];
  assert.deepEqual(mergeApiCompletionItems(snippets),snippets);
});
test('bundled JavaScript duplicates collapse without losing quick inputs or GSS overloads',()=>{
  const base=enrichCompletionData(mergeCompletionData(require('../data/index.json'),require('../data/manual.json')),require('../data/official-api.json'));
  const java=mergeApiCompletionItems(base.java),js=mergeApiCompletionItems(base.javascript);
  assert.equal(java.length,base.java.length);
  for(const body of ['MainTable.reDrawRow(row)','ItemTable.reDrawRow(row)','Tab.isVisable()'])
    assert.equal(js.filter(x=>x.body===body).length,1,body);
  for(const item of base.javascript)assert.ok(js.some(x=>x.body===item.body&&(x.prefix===item.prefix||x.aliases?.includes(item.prefix))),item.prefix);
  assert.ok(java.filter(x=>x.apiPath==='$vs.dbTools.list').length>1);
});

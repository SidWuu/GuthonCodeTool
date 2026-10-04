const assert=require('node:assert/strict');const test=require('node:test');
const {BoundedCache}=require('../src/svn/bounded-cache');
test('LRU expires closed records and preserves live document state',()=>{
 let now=0;const pinned=new Set(['dirty']);const cache=new BoundedCache({maxEntries:2,maxBytes:8,ttlMs:10,sizeOf:Buffer.byteLength,isPinned:key=>pinned.has(key),now:()=>now});
 cache.set('dirty','long text');cache.set('closed','x');assert.equal(cache.has('dirty'),true);assert.equal(cache.has('closed'),false);
 pinned.clear();cache.prune();assert.equal(cache.size,0);
 cache.set('a','a');cache.set('b','b');cache.get('a');cache.set('c','c');assert.equal(cache.has('b'),false);
 now=11;assert.equal(cache.get('a'),undefined);assert.equal(cache.bytes,1);
});

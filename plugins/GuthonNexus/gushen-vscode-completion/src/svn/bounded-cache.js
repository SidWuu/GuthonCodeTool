// Retain live editor state; evict least-recently-used closed records by size/age.
class BoundedCache extends Map {
  constructor({maxEntries=128,maxBytes=32*1024*1024,ttlMs=0,sizeOf=()=>1,isPinned=()=>false,onEvict=()=>{},now=Date.now}={}) {
    super();Object.assign(this,{maxEntries,maxBytes,ttlMs,sizeOf,isPinned,onEvict,now});
    this.metadata=new Map();this.bytes=0;
  }
  get(key) {
    if (!super.has(key)) return undefined;
    const value=super.get(key);const meta=this.metadata.get(key);
    if (this.ttlMs && this.now()-meta.time>this.ttlMs && !this.isPinned(key,value)) {this.delete(key);return undefined;}
    super.delete(key);super.set(key,value);return value;
  }
  set(key,value) {
    const previous=this.metadata.get(key);if(previous)this.bytes-=previous.bytes;
    super.delete(key);super.set(key,value);
    const bytes=Math.max(0,this.sizeOf(value));this.bytes+=bytes;this.metadata.set(key,{bytes,time:this.now()});
    this.prune();return this;
  }
  delete(key) {
    if(!super.has(key))return false;
    const value=super.get(key);this.bytes-=this.metadata.get(key)?.bytes||0;this.metadata.delete(key);
    super.delete(key);this.onEvict(key,value);return true;
  }
  clear(){for(const key of [...super.keys()])this.delete(key);}
  prune(){
    for(const [key,value] of super.entries()){
      if(this.size<=this.maxEntries && this.bytes<=this.maxBytes)break;
      if(!this.isPinned(key,value))this.delete(key);
    }
  }
}
module.exports={BoundedCache};

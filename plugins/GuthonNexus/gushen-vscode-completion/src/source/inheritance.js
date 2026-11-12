const inflight=new WeakMap();
async function readPages({run,workspaceKey,path,jsonPointer='',expectedHash,maxChars=24000,maxTotal=1000000}) {
  let offset=0,first,signature;const parts=[];
  for(;;) {
    const result=await run(workspaceKey,'inheritance',{path,jsonPointer,offset,maxChars});
    const identity=JSON.stringify([result.path,result.sourceHash,result.parentPointer || '',result.parentPath || '',result.parentHash || '',result.status,result.segments]);
    if(result.path!==path || (expectedHash && result.sourceHash!==expectedHash) || (signature && identity!==signature)) throw new Error('继承源码读取期间发生变化，请重新打开');
    first ||= result;signature ||= identity;
    if(result.effective==null) return {...first,effective:result.effective};
    if(typeof result.effective!=='string') throw new Error('继承源码展开结果无效');
    parts.push(result.effective);
    if(!result.truncated) break;
    if(!Number.isInteger(result.nextOffset) || result.nextOffset<=offset || result.nextOffset>maxTotal) throw new Error('继承源码分页无效或超出展开上限');
    offset=result.nextOffset;
  }
  const effective=parts.join('');
  if(!Number.isInteger(first.totalChars) || first.totalChars>maxTotal || Array.from(effective).length!==first.totalChars) throw new Error('继承源码展开不完整或超出上限');
  return {...first,effective,truncated:false,nextOffset:null};
}
function readInheritance(options) {
  let requests=inflight.get(options.run);if(!requests){requests=new Map();inflight.set(options.run,requests);}
  const key=JSON.stringify([options.workspaceKey,options.path,options.jsonPointer || '',options.expectedHash || '',options.maxChars || 24000,options.maxTotal || 1000000]);
  if(requests.has(key)) return requests.get(key);
  const pending=readPages(options).finally(()=>requests.delete(key));requests.set(key,pending);return pending;
}
module.exports={readInheritance};

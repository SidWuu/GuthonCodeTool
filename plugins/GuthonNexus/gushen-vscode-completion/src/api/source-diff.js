const path=require('node:path');
const {ReadonlyDiffEditor}=require('../source/readonly-diff-editor');

const SCHEME='guthon-api-review-diff';
const PAGE_SIZE=50000;

class SourceDiffProvider extends ReadonlyDiffEditor {
  constructor(vscode,run) {
    super(vscode,SCHEME);
    this.run=run;
  }
  async open(key,sourcePath,{view='auto',expectedSourceHash,expectedBaseHash}={}) {
    if(!this.registration)throw new Error('只读差异文档不可用');
    let offset=0,first,before='',after='';
    for(;;) {
      const part=await this.run(key,'diff',{path:sourcePath,view,offset,maxChars:PAGE_SIZE});
      if(!part || part.path!==sourcePath || part.offset!==offset || part.readonly!==true ||
        typeof part.before!=='string' || typeof part.after!=='string' ||
        typeof part.sourceHash!=='string' || !part.sourceHash || typeof part.baseHash!=='string' || !part.baseHash ||
        !Number.isSafeInteger(part.totalBeforeChars) || part.totalBeforeChars<0 ||
        !Number.isSafeInteger(part.totalAfterChars) || part.totalAfterChars<0 ||
        !['raw','readable'].includes(part.view) || typeof part.language!=='string') throw new Error('差异分页响应无效');
      if(!first) {
        first=part;
        if((expectedSourceHash && part.sourceHash!==expectedSourceHash) || (expectedBaseHash && part.baseHash!==expectedBaseHash))
          throw new Error('审阅期间源码或基线已变化，请重新比较');
      } else if(['sourceHash','baseHash','view','language','totalBeforeChars','totalAfterChars','sourceType','message'].some(k=>part[k]!==first[k])) {
        throw new Error('差异读取期间源码或基线已变化，请重新比较');
      }
      const total=Math.max(part.totalBeforeChars,part.totalAfterChars),end=offset+PAGE_SIZE;
      if([...part.before].length!==Math.max(0,Math.min(PAGE_SIZE,part.totalBeforeChars-offset)) ||
        [...part.after].length!==Math.max(0,Math.min(PAGE_SIZE,part.totalAfterChars-offset)) ||
        part.nextOffset!==(end<total?end:null) || part.truncated!==(end<total)) throw new Error('差异分页不完整，请重新比较');
      before+=part.before;after+=part.after;
      if(part.nextOffset===null)break;
      offset=part.nextOffset;
    }
    const extension=first.view==='readable'?'.md':(path.posix.extname(sourcePath) || '.txt');
    await this.show(before,after,{
      beforeName:`baseline${extension}`,afterName:`current${extension}`,
      title:`${sourcePath} · ${first.view==='readable'?'PAGE 可读差异':'原始源码差异'}`,
    });
    return first;
  }
}
module.exports={SourceDiffProvider,SCHEME};

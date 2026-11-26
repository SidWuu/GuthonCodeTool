const path=require('node:path');
const {ReadonlyDiffEditor}=require('../source/readonly-diff-editor');

const SCHEME='guthon-api-review-diff';
const PAGE_SIZE=50000;

class SourceDiffProvider extends ReadonlyDiffEditor {
  constructor(vscode,run) {
    super(vscode,SCHEME);
    this.run=run;
  }
  async open(key,sourcePath,{view='auto',expectedSourceHash,expectedBaseHash,expectedRemoteHash}={}) {
    if(!this.registration)throw new Error('只读差异文档不可用');
    const conflict=expectedRemoteHash!==undefined;
    const otherHash=conflict?'remoteHash':'baseHash';
    const expectedOtherHash=conflict?expectedRemoteHash:expectedBaseHash;
    const versions=conflict?'本地源码或平台冲突版本':'源码或基线';
    let offset=0,first,before='',after='';
    for(;;) {
      const part=await this.run(key,conflict?'conflict':'diff',{path:sourcePath,view,offset,maxChars:PAGE_SIZE});
      if(!part || part.path!==sourcePath || part.offset!==offset || part.readonly!==true ||
        typeof part.before!=='string' || typeof part.after!=='string' ||
        typeof part.sourceHash!=='string' || !part.sourceHash || typeof part[otherHash]!=='string' || !part[otherHash] ||
        !Number.isSafeInteger(part.totalBeforeChars) || part.totalBeforeChars<0 ||
        !Number.isSafeInteger(part.totalAfterChars) || part.totalAfterChars<0 ||
        !['raw','readable'].includes(part.view) || typeof part.language!=='string') throw new Error('差异分页响应无效');
      if(!first) {
        first=part;
        if((expectedSourceHash && part.sourceHash!==expectedSourceHash) || (expectedOtherHash && part[otherHash]!==expectedOtherHash))
          throw new Error(`审阅期间${versions}已变化，请重新比较`);
      } else if(['sourceHash',otherHash,'view','language','totalBeforeChars','totalAfterChars','sourceType','message'].some(k=>part[k]!==first[k])) {
        throw new Error(`差异读取期间${versions}已变化，请重新比较`);
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
    const purpose=first.view==='readable'?'PAGE 可读差异':'原始源码差异';
    await this.show(before,after,{
      beforeName:`${conflict?'本地':'baseline'}${extension}`,afterName:`${conflict?'平台':'current'}${extension}`,
      title:`${sourcePath} · ${purpose}${conflict?'（本地 ↔ 平台冲突）':''}`,
    });
    return first;
  }
}
module.exports={SourceDiffProvider,SCHEME};

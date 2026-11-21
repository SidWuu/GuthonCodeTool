const crypto=require('node:crypto');
const path=require('node:path');

const SCHEME='guthon-api-review-diff';
const PAGE_SIZE=50000;

class SourceDiffProvider {
  constructor(vscode,run) {
    this.vscode=vscode;this.run=run;this.documents=new Map();
    this.registration=vscode.workspace?.registerTextDocumentContentProvider?.(SCHEME,this);
    this.closeListener=vscode.workspace?.onDidCloseTextDocument?.(document=>{
      if(document.uri.scheme===SCHEME)this.documents.delete(document.uri.path);
    });
  }
  provideTextDocumentContent(uri) {
    const value=this.documents.get(uri.path);
    if(value===undefined)throw new Error('差异快照已关闭，请重新比较');
    return value;
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
    const id=crypto.randomUUID(),extension=first.view==='readable'?'.md':(path.posix.extname(sourcePath) || '.txt');
    const left=this.vscode.Uri.from({scheme:SCHEME,path:`/${id}/baseline${extension}`});
    const right=this.vscode.Uri.from({scheme:SCHEME,path:`/${id}/current${extension}`});
    this.documents.set(left.path,before);this.documents.set(right.path,after);
    try {
      await this.vscode.commands.executeCommand('vscode.diff',left,right,`${sourcePath} · ${first.view==='readable'?'PAGE 可读差异':'原始源码差异'}`);
    } catch(error) {
      this.documents.delete(left.path);this.documents.delete(right.path);throw error;
    }
    return first;
  }
  dispose(){this.closeListener?.dispose();this.registration?.dispose();this.documents.clear();}
}
module.exports={SourceDiffProvider,SCHEME};

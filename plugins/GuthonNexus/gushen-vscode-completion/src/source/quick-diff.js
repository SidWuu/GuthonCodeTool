const crypto=require('node:crypto');
const {SCHEME,decodeIdentity}=require('./virtual-fs');
const {BoundedCache}=require('./bounded-cache');
const DIFF_SCHEME='guthon-api-diff';
function pointerValue(data,pointer) {
  if(!pointer) return data;
  return pointer.slice(1).split('/').reduce((value,key)=>value?.[key.replace(/~1/g,'/').replace(/~0/g,'~')],data);
}
class ApiQuickDiff {
  constructor({vscode,run,editorState,ui,projectBase,projectionBase}) {Object.assign(this,{vscode,run,editorState,ui,projectBase,projectionBase});this.contents=new BoundedCache({maxEntries:128,maxBytes:32*1024*1024,sizeOf:Buffer.byteLength,isPinned:key=>(vscode.workspace.textDocuments || []).some(doc=>doc.uri.toString()===key)});this.label='API 源码基线';}
  provideTextDocumentContent(uri){return this.contents.get(uri.toString()) || '';}
  async provideOriginalResource(uri,token) {
    if(token?.isCancellationRequested) return;
    let key,sourcePath,pointer='',sourceType='';
    if(uri.scheme===SCHEME) {const id=decodeIdentity(uri);key=id.workspaceKey;sourcePath=id.sourcePath;pointer=id.jsonPointer;sourceType=id.sourceType;}
    else if(uri.scheme==='file') for(const [candidate,state] of this.editorState.workspaces) {
      const path=this.editorState.documentPath(candidate,state,{uri});if(path) {key=candidate;sourcePath=path;break;}
    }
    if(!key || !sourcePath) return;
    const generation=this.ui.scmGenerations.get(key)||0;
    const result=await this.run(key,'diff',{path:sourcePath});
    if(token?.isCancellationRequested || generation!==(this.ui.scmGenerations.get(key)||0)) return;
    let content=result.before;
    if(sourceType==='view' || sourceType==='module-parameter') {
      content=this.projectionBase?.(uri,result);
    } else if(pointer) {
      try {content=pointerValue(JSON.parse(content),pointer);} catch {
        const snapshot=await this.run(key,'page',{action:'open',path:sourcePath});
        if(snapshot.sourceHash!==result.sourceHash) return;
        const comparison=await this.run(key,'page',{action:'comparison',path:sourcePath,sourceHash:snapshot.sourceHash});
        if(comparison.baseHash!==result.baseHash || typeof comparison.baseSourceText!=='string') return;
        try {content=pointerValue(JSON.parse(comparison.baseSourceText),pointer);} catch {return;}
      }
      if(Array.isArray(content) && decodeIdentity(uri).fragmentType==='fields') content=JSON.stringify(content,null,2);
      if(typeof content!=='string') return;
    }
    if(typeof content!=='string') return;
    if(uri.scheme===SCHEME && /@?inherit\s*\(/.test(content)) {content=this.projectBase?.(uri,content);if(typeof content!=='string') return;}
    const hash=crypto.createHash('sha256').update(JSON.stringify([key,sourcePath,pointer])).update('\0').update(content).digest('hex');
    const original=this.vscode.Uri.from({scheme:DIFF_SCHEME,authority:'workspace',path:`/baseline/${hash}`,query:new URLSearchParams({workspaceKey:key,path:sourcePath,pointer}).toString()});
    const name=original.toString();
    if(Buffer.byteLength(content)>this.contents.maxBytes) throw new Error('差异快照超过编辑器缓存上限');
    this.contents.set(name,content);if(!this.contents.has(name)) throw new Error('差异快照已满，请关闭部分差异编辑器');return original;
  }
  dispose(){this.contents.clear();}
}
function isUri(value){return !!value && typeof value.scheme==='string' && typeof value.toString==='function';}
function documentWithLineChanges(
  vscode,
  originalDocument,
  modifiedDocument,
  changes,
  omittedIndex = -1
) {
  const parts = [];
  let originalLine = 0;
  for (const [changeIndex, change] of changes.entries()) {
    const originalEndLineNumber = Number(change.originalEndLineNumber || 0);
    const modifiedEndLineNumber = Number(change.modifiedEndLineNumber || 0);
    const originalStartLineNumber = Number(change.originalStartLineNumber || 0);
    const modifiedStartLineNumber = Number(change.modifiedStartLineNumber || 0);
    const originalIsEmpty = originalEndLineNumber === 0;
    const modifiedIsEmpty = modifiedEndLineNumber === 0;
    const originalChangeStartLine = originalIsEmpty
      ? originalStartLineNumber
      : originalStartLineNumber - 1;
    let originalStartLine = originalChangeStartLine;
    let originalStartColumn = 0;
    if (modifiedIsEmpty && originalEndLineNumber === originalDocument.lineCount) {
      originalStartLine -= 1;
      originalStartColumn = originalDocument.lineAt(originalStartLine).range.end.character;
    }
    parts.push(originalDocument.getText(new vscode.Range(
      originalLine,
      0,
      originalStartLine,
      originalStartColumn
    )));
    if (changeIndex === omittedIndex) {
      if (!originalIsEmpty) {
        parts.push(originalDocument.getText(new vscode.Range(
          originalChangeStartLine,
          0,
          originalEndLineNumber,
          0
        )));
      }
    } else if (!modifiedIsEmpty) {
      let modifiedStartLine = modifiedStartLineNumber - 1;
      let modifiedStartColumn = 0;
      if (originalIsEmpty && originalStartLineNumber === originalDocument.lineCount) {
        modifiedStartLine -= 1;
        modifiedStartColumn = modifiedDocument.lineAt(modifiedStartLine).range.end.character;
      }
      parts.push(modifiedDocument.getText(new vscode.Range(
        modifiedStartLine,
        modifiedStartColumn,
        modifiedEndLineNumber,
        0
      )));
    }
    originalLine = originalIsEmpty ? originalStartLineNumber : originalEndLineNumber;
  }
  parts.push(originalDocument.getText(new vscode.Range(
    originalLine,
    0,
    originalDocument.lineCount,
    0
  )));
  return parts.join('');
}

async function revertQuickDiffChange({ vscode, provider, resourceUri, changes, changeIndex }) {
  if (!isUri(resourceUri)
    || !Array.isArray(changes)
    || !Number.isInteger(changeIndex)
    || !changes[changeIndex]) {
    void vscode.window.showWarningMessage('未取得当前 API 差异块，请重新点击左侧变更标记后再试。');
    return false;
  }
  const editors = [
    vscode.window.activeTextEditor,
    ...(vscode.window.visibleTextEditors || []),
  ].filter((editor, index, all) => (
    editor && all.indexOf(editor) === index
  ));
  const editor = editors.find((candidate) => (
    candidate.document.uri.toString() === resourceUri.toString()
  ));
  if (!editor) {
    void vscode.window.showWarningMessage('当前修改文件未在编辑器中打开，无法撤销这一处变更。');
    return false;
  }
  const originalUri = await provider.provideOriginalResource(resourceUri, {
    isCancellationRequested: false,
  });
  if (!originalUri) {
    void vscode.window.showWarningMessage('当前文件没有可用的 API 基线，无法撤销这一处变更。');
    return false;
  }
  const originalDocument = await vscode.workspace.openTextDocument(originalUri);
  const updatedText = documentWithLineChanges(
    vscode,
    originalDocument,
    editor.document,
    changes,
    changeIndex
  );
  const lastLine = Math.max(0, editor.document.lineCount - 1);
  const endCharacter = editor.document.lineAt(lastLine).range.end.character;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    resourceUri,
    new vscode.Range(0, 0, lastLine, endCharacter),
    updatedText
  );
  if (!await vscode.workspace.applyEdit(edit)) {
    throw new Error('VS Code 未能应用当前差异块的撤销编辑');
  }
  if (!await editor.document.save()) throw new Error('撤销后保存文件失败');
  const targetLine = Math.max(0, Math.min(
    editor.document.lineCount - 1,
    Number(changes[changeIndex].modifiedStartLineNumber || 1) - 1
  ));
  if (vscode.Selection) editor.selection = new vscode.Selection(targetLine, 0, targetLine, 0);
  const visibleRange = editor.visibleRanges?.[0];
  if (visibleRange) editor.revealRange?.(visibleRange);
  return true;
}

module.exports={DIFF_SCHEME,ApiQuickDiff,documentWithLineChanges,revertQuickDiffChange};

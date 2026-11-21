const {SCHEME}=require('./virtual-fs');
class InheritanceDecorations {
  constructor(vscode,virtualFs) {
    this.vscode=vscode;this.virtualFs=virtualFs;this.registrations=[];
    if(!vscode.window.createTextEditorDecorationType) return;
    this.product=vscode.window.createTextEditorDecorationType({backgroundColor:'rgba(92,119,149,0.22)',borderLeft:'2px solid rgba(120,151,181,0.55)',isWholeLine:true,rangeBehavior:vscode.DecorationRangeBehavior.ClosedClosed});
    this.project=vscode.window.createTextEditorDecorationType({backgroundColor:'rgba(148,138,110,0.07)',isWholeLine:true,rangeBehavior:vscode.DecorationRangeBehavior.ClosedClosed});
    if(vscode.window.onDidChangeActiveTextEditor) this.registrations.push(vscode.window.onDidChangeActiveTextEditor(editor=>this.render(editor)));
    if(vscode.window.onDidChangeVisibleTextEditors) this.registrations.push(vscode.window.onDidChangeVisibleTextEditors(editors=>editors.forEach(editor=>this.render(editor))));
  }
  render(editor) {
    if(!this.product || !editor || editor.document.uri.scheme!==SCHEME) return;
    const inherited=this.virtualFs.records.get(editor.document.uri.toString())?.inherited;
    if(!inherited) {editor.setDecorations(this.product,[]);editor.setDecorations(this.project,[]);return;}
    const span=(start,end)=>new this.vscode.Range(editor.document.positionAt(start),editor.document.positionAt(end));
    editor.setDecorations(this.product,[span(inherited.start,inherited.end)]);
    editor.setDecorations(this.project,[span(0,inherited.start),span(inherited.end,editor.document.getText().length)]);
  }
  refresh(document) {
    const editors=[this.vscode.window.activeTextEditor,...(this.vscode.window.visibleTextEditors || [])];
    for(const editor of new Set(editors)) if(editor && (!document || editor.document===document)) this.render(editor);
  }
  dispose(){if(this.disposed)return;this.disposed=true;this.registrations.forEach(item=>item.dispose());this.product?.dispose();this.project?.dispose();}
}
module.exports={InheritanceDecorations};

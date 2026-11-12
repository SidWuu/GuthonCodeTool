const test=require('node:test');const assert=require('node:assert/strict');
const {ApiPageVirtualFs}=require('../src/source/virtual-fs');const {InheritanceDecorations}=require('../src/source/inheritance-decoration');
test('inherited parent is highlighted and follows edits before its region',()=>{
  const types=[],decorations=[];class Emitter{constructor(){this.event=()=>{};}dispose(){}};
  const vscode={EventEmitter:Emitter,DecorationRangeBehavior:{ClosedClosed:1},Range:class{constructor(start,end){this.start=start;this.end=end;}},
    workspace:{textDocuments:[]},window:{createTextEditorDecorationType:options=>{const item={options,dispose(){}};types.push(item);return item;}}};
  const virtualFs=new ApiPageVirtualFs({vscode,run:async()=>{},editorState:{}}),uri={scheme:'guthon-api-edit',toString:()=> 'uri'};
  const document={uri,positionAt:offset=>offset,getText:()=> 'AAparentBB'},editor={document,setDecorations:(type,ranges)=>decorations.push({type,ranges})};
  virtualFs.records.set('uri',{inherited:{start:2,end:8,productTouched:false}});
  const highlighter=new InheritanceDecorations(vscode,virtualFs);highlighter.render(editor);
  assert.deepEqual(decorations[0].ranges.map(x=>[x.start,x.end]),[[2,8]]);
  virtualFs.trackDocumentChange({document,contentChanges:[{rangeOffset:0,rangeLength:0,text:'xx'}]});highlighter.render(editor);
  assert.deepEqual(decorations[2].ranges.map(x=>[x.start,x.end]),[[4,10]]);
  virtualFs.records.get('uri').inherited=undefined;highlighter.render(editor);assert.deepEqual(decorations[4].ranges,[]);
  assert.equal(types.length,2);highlighter.dispose();virtualFs.dispose();
});

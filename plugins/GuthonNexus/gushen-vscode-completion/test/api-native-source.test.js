const test=require('node:test');
const assert=require('node:assert/strict');
const {ApiSourceUI}=require('../src/api/source-ui');
function tree(object) {
  const vscode={TreeItem:class {constructor(label){this.label=label;}},TreeItemCollapsibleState:{None:0,Collapsed:1}};
  const ui=new ApiSourceUI({vscode,run:async()=>{throw Error('No request expected');}});
  return ui.getTreeItem({key:'projects.fixture',label:'Page',kind:'source',object:{path:'systems/A/pages/01/P/P.xml',sourceType:'page',sourceFormat:'native-xml',...object}});
}
test('PAGE tooltip distinguishes verified native model from an unverified source',()=>{
  assert.match(tree({pageSource:'native-editor',nativeState:'PRESENT'}).tooltip,/原生编辑模型.*原生 JSON 保存/);
  assert.match(tree({}).tooltip,/原文来源待核验/);
});
test('native metadata without a source version does not promise editable source',()=>{
  assert.match(tree({pageSource:'native-editor',nativeState:'METADATA_ONLY'}).tooltip,/尚无源码版本，仅可查看/);
});

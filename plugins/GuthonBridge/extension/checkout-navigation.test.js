const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  function element() {
    return {children:[],textContent:'',disabled:false,
      appendChild(child){this.children.push(child);child.parent=this;child.parentNode=this;},
      insertBefore(child,before){const i=this.children.indexOf(before);this.children.splice(i<0?this.children.length:i,0,child);child.parent=this;child.parentNode=this;},
      get firstChild(){return this.children[0];},get nextSibling(){return this.parent?.children[this.parent.children.indexOf(this)+1]||null;},setAttribute(){},
      remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);}};
  }
  const body=element(), hidden=element();
  hidden.appendChild(element());
  const columns=['selection','checkOutUserName','checkOutDate','procedureAliasId','funId','funName'].map(property=>({property}));
  const rows=[{procedureId:'PR-A',procedureAliasId:'demo.pkg',funId:'save'},
    {procedureId:'PR-B',procedureAliasId:'demo.pkg',funId:'save'}];
  const mounted=[];
  class Column {
    constructor(options){this.options=options;this.$options={name:'ElTableColumn'};}
    $mount(host){this.$el=host;mounted.push(this);columns.splice(hidden.children.indexOf(host),0,this.options.render().data.props);}
    $destroy(){columns.splice(columns.indexOf(this.options.render().data.props),1);this.destroyed=true;}
  }
  const selection=new Column({});selection.columnConfig={type:'selection'};selection.$el=hidden.firstChild;
  const tableVm={$options:{_base:Column},store:{states:{columns,data:rows}},$children:[selection],$refs:{hiddenColumns:hidden},
    $createElement(type,data,text){return {type,data,text,componentOptions:{propsData:data.props}};}};
  const table={__vue__:tableVm};
  let visible=true,title='由我签出的页面',closed=0,failure=null;
  const wrapper={getClientRects:()=>visible?[{}]:[],querySelector:selector=>({
    '.el-dialog__title':{textContent:title},'.el-dialog__body':body,
    '.el-dialog__headerbtn':{click(){closed++;}}})[selector],querySelectorAll:()=>[table]};
  const calls=[];
  const context={document:{querySelectorAll:()=>[wrapper],createElement:element},
    getComputedStyle:()=>({display:'block'}),getVueInstance:e=>e.__vue__,
    navigateToProcedure:async target=>{calls.push(target);if(failure)throw Error(failure);}};
  const source=fs.readFileSync(require.resolve('./page-bridge.js'),'utf8');
  vm.runInNewContext(source.slice(source.indexOf('  const checkoutColumns ='),source.indexOf('  function installProcedureNavigation()')),context);
  return {rows,columns,hidden,body,calls,mounted,tableVm,refresh:()=>context.installCheckoutProcedureLinks(),
    hide:()=>{visible=false;},show:()=>{visible=true;},title:value=>{title=value;},failure:value=>{failure=value;},closed:()=>closed,
    button:row=>mounted.at(-1).options.render().data.scopedSlots.default({row})};
}
function click(vnode,button={disabled:false}) {
  let prevented=false,stopped=false;
  const result=vnode.data.on.click({currentTarget:button,preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});
  assert.ok(prevented&&stopped,'opening must not toggle native row selection');
  return result;
}
test('native operation column follows selection and stays unique across refresh and row filtering',async()=>{
  const f=fixture();f.refresh();f.refresh();
  assert.equal(f.mounted.length,1);
  assert.equal(f.columns[1].label,'操作');
  assert.equal(f.columns[1].width,50);
  assert.equal(f.columns[1].align,'center');
  assert.equal(f.columns[1].headerAlign,'center');
  assert.equal(f.columns[0].property,'selection');
  assert.equal(f.columns[2].property,'checkOutUserName');
  assert.equal(f.mounted[0].$el,f.hidden.children[1]);
  await click(f.button(f.rows[1]));
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),[{procedureId:'PR-B',procedureKeyword:'demo.pkg',funId:'save'}]);
  f.tableVm.store.states.data=[f.rows[0]];f.refresh();
  await click(f.button(f.rows[0]));
  assert.equal(f.calls[1].procedureId,'PR-A');
  assert.equal(f.mounted.length,1);
  f.hide();f.refresh();
  assert.equal(f.mounted[0].destroyed,true);
  assert.equal(f.columns[0].property,'selection');
  assert.equal(f.hidden.children.length,1);
  assert.equal(f.body.children.length,0);
  f.show();f.refresh();assert.equal(f.columns[1].label,'操作');
});
test('failed opening leaves dialog open and displays errors; duplicate clicks are suppressed',async()=>{
  const f=fixture();f.failure('精确身份未找到');f.refresh();
  const button={disabled:false};
  const first=click(f.button(f.rows[0]),button);
  assert.equal(button.disabled,true);
  assert.equal(f.button(f.rows[0]).data.attrs.disabled,true);
  await click(f.button(f.rows[0]),button);await first;
  assert.equal(f.calls.length,1);assert.equal(f.closed(),0);assert.equal(button.disabled,false);
  assert.equal(f.body.children[0].textContent,'打开失败：精确身份未找到');
});
test('unknown dialogs and missing native table capabilities safely skip; invalid identities disable opening',async()=>{
  const f=fixture();f.title('代码搜索器');f.refresh();assert.equal(f.mounted.length,0);
  f.title('由我签出的页面');f.columns[3].property='pageAliasId';f.refresh();assert.equal(f.mounted.length,0);
  f.columns[3].property='procedureAliasId';f.tableVm.$refs.hiddenColumns=null;f.refresh();assert.equal(f.mounted.length,0);
  f.tableVm.$refs.hiddenColumns=f.hidden;f.refresh();
  delete f.rows[0].procedureId;
  const vnode=f.button(f.rows[0]);assert.equal(vnode.data.attrs.disabled,true);
  await click(vnode);assert.equal(f.calls.length,0);
});

test('checkout resolution distinguishes identical names by the checked-out procedure ID',()=>{
  const source=fs.readFileSync(require.resolve('./page-bridge.js'),'utf8');
  const context={collectMatches:items=>items,
    pickFirst:(item,keys)=>keys.map(key=>item[key]).find(value=>value!==undefined&&value!==null&&value!=='')||''};
  vm.runInNewContext(source.slice(source.indexOf('  function resolveProcedure('),source.indexOf('  async function pullProcedure(')),context);
  const candidates=[{procedureId:'PR-A',procedureAliasId:'demo.pkg',funId:'save',dataSourceId:'DS-A'},
    {procedureId:'PR-B',procedureAliasId:'demo.pkg',funId:'save',dataSourceId:'DS-B'}];
  assert.equal(context.resolveProcedure(candidates,'demo.pkg','save',true,'','PR-B').dataSourceId,'DS-B');
  assert.throws(()=>context.resolveProcedure(candidates,'demo.pkg','save',true,'','PR-MISSING'),/未找到/);
});

const vscode=acquireVsCodeApi();
const tree=document.getElementById('tree');
const menu=document.getElementById('menu');
const glyphs={'pass-filled':'●',project:'◇',warning:'!',folder:'▰','folder-opened':'▱',table:'▦',
  layout:'▤','symbol-method':'◇',code:'⌘',terminal:'›','diff-modified':'●',
  'symbol-structure':'▥','settings-gear':'⚙︎','symbol-enum':'≣','list-selection':'☷',book:'▣',files:'▧',
  file:'□','file-code':'□','symbol-field':'⊞','symbol-event':'ϟ',database:'◉','folder-library':'▰',
  json:'{}',info:'ⓘ',error:'⊗'};
let generation, rows=[], elements=new Map(), selected, pendingMenu;
const send=(type,params={})=>vscode.postMessage({type,generation,...params});

function select(id,{focus=false,scroll=false,notify=true,mark=true}={}) {
  const node=elements.get(id);
  if(!node)return;
  const previous=elements.get(selected);
  if(previous) {previous.tabIndex=-1;previous.setAttribute('aria-selected','false');}
  for(const child of tree.querySelectorAll('[tabindex="0"]'))child.tabIndex=-1;
  selected=id;
  node.tabIndex=0;
  node.setAttribute('aria-selected',String(mark));
  if(focus)node.focus({preventScroll:true});
  if(scroll)node.scrollIntoView({block:'nearest'});
  if(notify)send('select',{id});
}
function openMenu(id,x,y) {
  select(id,{focus:true});
  pendingMenu={id,x,y};
  send('menu',{id});
}
function closeMenu(restoreFocus=false) {
  pendingMenu=undefined;
  if(menu.hidden)return;
  menu.hidden=true;
  menu.replaceChildren();
  if(restoreFocus)elements.get(selected)?.focus();
}
function showMenu(items,x,y,id) {
  if(!items.length){closeMenu();return;}
  menu.classList.toggle('single-item',items.length===1);
  menu.replaceChildren(...items.map(item=>{
    const button=document.createElement('button');
    button.type='button';
    button.setAttribute('role','menuitem');
    button.textContent=item.label;
    button.addEventListener('click',()=>{
      closeMenu(true);
      send('context',{id,command:item.command});
    });
    return button;
  }));
  menu.hidden=false;
  menu.style.left=Math.max(0,Math.min(x,innerWidth-menu.offsetWidth))+'px';
  menu.style.top=Math.max(0,Math.min(y,innerHeight-menu.offsetHeight))+'px';
  menu.firstElementChild.focus();
}
function render(message) {
  closeMenu();
  generation=message.generation;
  rows=message.rows;
  tree.setAttribute('aria-label',message.title);
  const restoreFocus=tree.contains(document.activeElement);
  const scroll=tree.scrollTop;
  elements=new Map();
  const content=document.createDocumentFragment();
  if(message.notice || message.error) {
    const notice=document.createElement('div');
    notice.id='notice';
    notice.setAttribute('role','status');
    notice.textContent=message.error || message.notice;
    content.append(notice);
  }
  for(const row of rows) {
    const node=document.createElement('div');
    node.dataset.id=row.id;
    if(row.status)node.classList.add('status-row');
    node.setAttribute('role','treeitem');
    node.setAttribute('aria-level',String(row.depth+1));
    node.setAttribute('aria-selected','false');
    if(row.capable)node.setAttribute('aria-expanded',String(row.open));
    node.tabIndex=-1;
    node.title=row.tooltip;
    node.style.paddingInlineStart=(6+row.depth*13)+'px';
    const twisty=document.createElement('span'), icon=document.createElement('span');
    twisty.className='twisty';
    twisty.setAttribute('aria-hidden','true');
    twisty.textContent=row.capable?(row.open?'⌄':'›'):'';
    icon.className='node-icon';
    icon.setAttribute('aria-hidden','true');
    icon.textContent=glyphs[row.icon] || (row.capable?glyphs.folder:glyphs.file);
    if(row.color)icon.style.color='var(--vscode-'+row.color.replace(/\./g,'-')+')';
    const label=document.createElement('span');
    label.className='label';
    label.textContent=row.label;
    node.append(twisty,icon,label);
    if(row.code) {
      const code=document.createElement('span');
      code.className='source-code';
      code.textContent=row.code;
      node.append(code);
    }
    if(row.description) {
      const detail=document.createElement('span');
      detail.className='description';
      detail.textContent=row.description;
      node.append(detail);
    }
    elements.set(row.id,node);
    content.append(node);
  }
  tree.replaceChildren(content);
  tree.scrollTop=scroll;
  selected=undefined;
  tree.tabIndex=rows.length?-1:0;
  const selectedId=message.reveal || message.selected;
  if(rows.length)select(selectedId || rows[0].id,
    {focus:restoreFocus || !!message.focus,scroll:!!message.reveal,notify:false,mark:!!selectedId});
}
function activate(row,toggle=false) {
  if(row.capable && (toggle || !row.action))send('toggle',{id:row.id});
  else if(row.action)send('open',{id:row.id});
}
tree.addEventListener('click',event=>{
  const id=event.target.closest('[role=treeitem]')?.dataset.id;
  const row=rows.find(item=>item.id===id);
  if(!row)return;
  select(id,{focus:true});
  activate(row,event.target.classList.contains('twisty'));
});
tree.addEventListener('contextmenu',event=>{
  const id=event.target.closest('[role=treeitem]')?.dataset.id;
  if(id){event.preventDefault();openMenu(id,event.clientX,event.clientY);}
});
tree.addEventListener('keydown',event=>{
  const index=rows.findIndex(row=>row.id===selected),row=rows[index];
  if(!row)return;
  const move=index=>{if(rows[index])select(rows[index].id,{focus:true,scroll:true});};
  if(event.key==='ArrowUp')move(index-1);
  else if(event.key==='ArrowDown')move(index+1);
  else if(event.key==='Home')move(0);
  else if(event.key==='End')move(rows.length-1);
  else if(event.key==='ArrowRight'){
    if(row.capable && !row.open)send('toggle',{id:row.id});
    else if(rows[index+1]?.parentId===row.id)move(index+1);
  } else if(event.key==='ArrowLeft'){
    if(row.open)send('toggle',{id:row.id});
    else if(row.parentId)select(row.parentId,{focus:true,scroll:true});
  } else if(event.key==='Enter' || event.key===' ')activate(row);
  else if(event.key==='ContextMenu' || event.key==='F10' && event.shiftKey){
    const box=elements.get(row.id).getBoundingClientRect();
    openMenu(row.id,box.left+20,box.bottom);
  } else return;
  event.preventDefault();
});
menu.addEventListener('keydown',event=>{
  const items=[...menu.children], index=items.indexOf(document.activeElement);
  if(event.key==='Escape'){event.preventDefault();closeMenu(true);}
  else if(event.key==='ArrowUp' || event.key==='ArrowDown'){
    event.preventDefault();
    items[(index+(event.key==='ArrowUp'?-1:1)+items.length)%items.length].focus();
  } else if(event.key==='Tab')closeMenu(true);
});
document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target))closeMenu();});
window.addEventListener('message',({data})=>{
  if(data.type==='tree')render(data);
  if(data.type==='menu' && data.generation===generation && pendingMenu?.id===data.id)
    showMenu(data.items,pendingMenu.x,pendingMenu.y,data.id);
});
send('ready');

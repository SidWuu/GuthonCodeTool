/* Editing inspector only. Rendering belongs exclusively to the original designer. */
(() => {
  const api = acquireVsCodeApi(), $ = id => document.getElementById(id);
  let state, selection, selectedRow, selectedCode, before = false, awaiting = false, query = '', revealOnUpdate = false;
  const expansion = new Map();
  const queue = [];
  const el = (tag, text, className) => {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = String(text);
    if (className) item.className = className;
    return item;
  };
  function send(type, data = {}) {
    if (['native','manageResources'].includes(type)) {
      if ($('native').disabled || $('manageResources').disabled) return;
      $('native').disabled = $('manageResources').disabled = true;
    }
    queue.push({type, ...data}); flush();
  }
  function flush() {
    if (awaiting || !state || !queue.length) return;
    awaiting = true; api.postMessage({version: state.version, ...queue.shift()});
  }
  function button(text, click, disabled = false, className = '') {
    const item = el('button', text, className); item.type = 'button'; item.disabled = disabled;
    item.addEventListener('click', click); return item;
  }
  const value = (field, name) => field.properties.find(prop => prop.name === name)?.value;
  const title = field => value(field, 'name') ?? value(field, 'label') ?? value(field, 'disName') ?? field.label;
  const codeType = node => node.type === 'SQL' ? 'SQL' : node.eventScope === 'SERVICE' ? '服务事件' : '前端脚本';
  const regionNames = {FORM:'表单',SEARCH:'查询表单',MAIN_TABLE:'主表',DETAIL_TABLE:'明细表'};
  const within = (pointer, parent) => pointer === parent || pointer.startsWith(parent + '/');
  function revealSelection() {
    if (!selectedRow) return;
    const canvas = $('canvas'), viewport = canvas.getBoundingClientRect(), row = selectedRow.getBoundingClientRect();
    if (row.top < viewport.top) canvas.scrollTop += row.top - viewport.top;
    else if (row.bottom > viewport.bottom) canvas.scrollTop += row.bottom - viewport.bottom;
  }
  function select(collection, field) {
    selection = {collection: collection.pointer, key: field.key}; selectedCode = undefined;
    // A tree selection must stay visible even when the middle list was filtered.
    if (query && !(title(field) + field.key).toLowerCase().includes(query)) {
      query = ''; $('search').value = '';
    }
    render(); $('properties').scrollTop = 0; revealSelection();
  }
  function selectRegion(pointer) {
    selection = {region:pointer}; selectedCode = undefined;
    if (query) {query=''; $('search').value='';}
    render(); $('properties').scrollTop = 0;
    const canvas = $('canvas');
    const region = [...canvas.querySelectorAll('.collection')].find(item=>within(item.dataset.region,pointer));
    if (region) canvas.scrollTop += region.getBoundingClientRect().top - canvas.getBoundingClientRect().top;
  }
  function openCode(node) {
    selectedCode = node.key;
    const model=before ? state.baseline : state.model;
    let fieldOwner=false;
    for (const collection of model.collections) {
      const field=collection.fields.find(item=>within(node.pointer,item.pointer));
      if (!field) continue;
      selection={collection:collection.pointer,key:field.key};
      fieldOwner=true;
      if (query && !(title(field)+field.key).toLowerCase().includes(query)) {query=''; $('search').value='';}
      break;
    }
    if (!fieldOwner) {
      const region=layoutRegions(model).find(entry=>entry.nodeKeys.includes(node.key));
      selection=region ? {region:region.pointer} : undefined;
    }
    render(); revealSelection(); send('openCode',{key:node.key});
  }
  function layoutRegions(model) {
    const result = [];
    function visit(entry) {
      if (entry.kind === 'region') result.push(entry);
      entry.children.forEach(visit);
    }
    model.outline.layout.forEach(visit); return result;
  }
  function renderTree(model) {
    const tree = $('tree');
    for (const group of tree.querySelectorAll('details')) expansion.set(group.dataset.outlineKey,group.open);
    const selectedNode = model.nodes.find(node=>node.key === selectedCode);
    const collection = model.collections.find(item=>item.pointer === selection?.collection);
    const selectedRegion = selection?.region ?? collection?.regionPointer ?? collection?.pointer.slice(0,collection.pointer.lastIndexOf('/'));
    const active = (pointer, keys=[]) => (selectedRegion !== undefined && within(selectedRegion,pointer))
      || (selectedNode && within(selectedNode.pointer,pointer)) || keys.includes(selectedCode);
    function branch(key,label,parent,opened=false,selected=false,navigate) {
      const group = el('details',undefined,'tree-node'); group.dataset.outlineKey=key;
      group.classList.toggle('tree-root',key==='page');
      group.open = selected || (expansion.has(key) ? expansion.get(key) : opened);
      const summary = el('summary');
      if (navigate) {
        const control = button(label,()=>{group.open=true; navigate();},false,'tree-link');
        summary.append(control);
      } else summary.textContent=label;
      const children = el('div',undefined,'tree-children'); group.append(summary,children); parent.append(group);
      return children;
    }
    function codeLeaf(node,parent) {
      const name = node.pointer.split('/').at(-1).replace(/~1/g,'/').replace(/~0/g,'~');
      const inherited = node.reason?.includes('继承') ? '（继承）' : '';
      const control = button(name+inherited,()=>openCode(node),false,'tree-link tree-code');
      control.title=node.label; control.setAttribute('aria-label',`${codeType(node)} · ${node.label}`);
      control.classList.toggle('selected',node.key===selectedCode); parent.append(control);
    }
    function codes(keys,parent,key) {
      const nodes = model.nodes.filter(node=>keys.includes(node.key));
      for (const node of nodes.filter(item=>item.type==='SQL')) codeLeaf(node,parent);
      for (const [scope,label] of [['FRONT','前端事件'],['SERVICE','服务事件']]) {
        const events=nodes.filter(node=>node.type!=='SQL' && (node.eventScope==='SERVICE'?'SERVICE':'FRONT')===scope);
        if (!events.length) continue;
        const group=branch(key+':'+scope,label,parent,false,events.some(node=>node.key===selectedCode));
        events.forEach(node=>codeLeaf(node,group));
      }
    }
    function layoutEntry(entry,parent) {
      const label = entry.region ? `${entry.label}（${regionNames[entry.region] || entry.region}）` : entry.label;
      const group = branch('layout:'+entry.pointer,label,parent,true,active(entry.pointer),()=>selectRegion(entry.pointer));
      if (entry.nodeKeys.length) {
        const events = branch('codes:'+entry.pointer,'区域脚本与 SQL',group,false,entry.nodeKeys.includes(selectedCode));
        codes(entry.nodeKeys,events,'region:'+entry.pointer);
      }
      for (const [kind,label] of [['BUTTONS','按钮'],['FIELDS','字段']]) {
        const collections = model.collections.filter(item=>entry.collectionPointers.includes(item.pointer)
          && (item.kind || 'FIELDS')===kind);
        const count=collections.reduce((sum,item)=>sum+item.fields.length,0);
        if (!count) continue;
        const isSelected=collections.some(item=>item.pointer===selection?.collection)
          || collections.some(item=>item.fields.some(field=>selectedNode && within(selectedNode.pointer,field.pointer)));
        const items=branch(kind+':'+entry.pointer,`${label} (${count})`,group,false,isSelected);
        for (const collection of collections) for (const field of collection.fields) {
          const name = `${title(field)} [${field.key.replace(/^[^:]+:/,'')}]`;
          const nodes=model.nodes.filter(node=>within(node.pointer,field.pointer));
          const selected=selection?.collection===collection.pointer && selection?.key===field.key;
          if (nodes.length) {
            const owner = branch('item:'+collection.pointer+'|'+field.key,name,items,false,
              selected || nodes.some(node=>node.key===selectedCode),()=>select(collection,field));
            owner.previousElementSibling.firstElementChild.classList.toggle('selected',selected);
            codes(nodes.map(node=>node.key),owner,'item:'+collection.pointer+'|'+field.key);
          } else {
            const control=button(name,()=>select(collection,field),false,'tree-link');
            control.classList.toggle('selected',selected); items.append(control);
          }
        }
      }
      entry.children.forEach(child=>layoutEntry(child,group));
    }
    tree.replaceChildren(el('span','PAGE OUTLINE','eyebrow'));
    const page=branch('page',[model.pageName,model.pageId].filter(Boolean).join(' · '),tree,true,!!selection || !!selectedNode);
    if (model.outline.pageNodeKeys.length) {
      const events=branch('page-events','页面事件',page,false,model.outline.pageNodeKeys.includes(selectedCode));
      codes(model.outline.pageNodeKeys,events,'page-events');
    }
    if (model.outline.layout.length) {
      const layout=branch('layout','页面布局',page,true,selectedRegion!==undefined || model.outline.layout.some(entry=>selectedNode && within(selectedNode.pointer,entry.pointer)));
      model.outline.layout.forEach(entry=>layoutEntry(entry,layout));
    }
  }
  function renderFields(model) {
    const root = $('canvas'); root.replaceChildren(); selectedRow = null;
    let count = 0;
    const regions = new Map();
    for (const entry of layoutRegions(model)) regions.set(entry.pointer,{...entry,collections:[]});
    for (const collection of model.collections) {
      const pointer = collection.regionPointer || collection.pointer.replace(/\/(fields|buttons)$/, '');
      if (!regions.has(pointer)) regions.set(pointer,{...collection,pointer,collections:[]});
      regions.get(pointer).collections.push(collection);
    }
    for (const entry of regions.values()) {
      const {collections}=entry;
      const fieldSets = collections.filter(item=>item.kind !== 'BUTTONS');
      const matches = field => !query || (title(field) + field.key).toLowerCase().includes(query);
      const fieldCount = fieldSets.reduce((sum,item)=>sum+item.fields.filter(matches).length,0);
      const buttons = collections.filter(item=>item.kind === 'BUTTONS');
      const buttonCount = buttons.reduce((sum,item)=>sum+item.fields.filter(matches).length,0);
      if (query && !fieldCount && !buttonCount) continue;
      count++;
      const section = el('section', undefined, 'collection'); section.dataset.region=entry.pointer;
      section.classList.toggle('active-region',selection?.region===entry.pointer);
      const header = el('div', undefined, 'collection-heading');
      header.append(el('h2', entry.label), el('span', `${entry.region} · ${fieldCount} 字段 · ${buttonCount} 按钮`, 'muted'));
      section.append(header);
      for (const set of buttons) {
        const bar = el('div', undefined, 'region-buttons');
        for (const item of set.fields.filter(matches)) {
          const control = button(title(item), ()=>select(set,item));
          control.classList.toggle('selected',selection?.collection===set.pointer && selection?.key===item.key);
          control.title = `${item.key} · 编辑按钮属性与事件`;
          if (selection?.collection===set.pointer && selection?.key===item.key) selectedRow=control;
          bar.append(control);
        }
        if (bar.childElementCount) section.append(bar);
      }
      for (const collection of fieldSets) {
        const fields = collection.fields.filter(matches);
        if (!fields.length) continue;
        const table = el('table');
        const thead = el('thead'), labels = el('tr');
        for (const label of ['字段名称', 'fieldId / 标识', '控件类型', '宽度']) labels.append(el('th', label));
        thead.append(labels); table.append(thead);
        const body = el('tbody');
        for (const field of fields) {
          const row = el('tr');
          const active = selection?.collection === collection.pointer && selection?.key === field.key;
          row.classList.toggle('selected', active); if (active) selectedRow = row;
          row.tabIndex = 0; row.setAttribute('aria-label', `${title(field)} · ${field.key}`);
          row.setAttribute('aria-selected', String(active));
          row.addEventListener('click', () => select(collection, field));
          row.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault(); select(collection, field); selectedRow?.focus({preventScroll: true});
            }
          });
          row.append(el('td', title(field), 'field-name'), el('td', field.key.replace(/^[^:]+:/, ''), 'field-id'),
            el('td', field.type || '—'), el('td', value(field, 'width') ?? '—'));
          body.append(row);
        }
        table.append(body); section.append(table);
      }
      if (!fieldCount && !buttonCount) section.append(el('p','此区域没有字段或按钮，可从左侧打开已有脚本与 SQL。','empty'));
      root.append(section);
    }
    if (!count) root.append(el('p', query ? '没有匹配的字段' : '此页面没有已识别字段，可从左侧打开脚本和 SQL。', 'empty'));
  }
  function renderProperties(model) {
    const root = $('properties');
    const collection = model.collections.find(item => item.pointer === selection?.collection);
    root.replaceChildren(el('span', 'INSPECTOR', 'eyebrow'), el('h2', collection?.kind === 'BUTTONS' ? '按钮属性与事件' : '字段属性'));
    const field = collection?.fields.find(item => item.key === selection?.key);
    if (!field) { root.append(el('p', '选择字段或区域按钮编辑已有属性与事件。', 'empty')); return; }
    root.append(el('h3', title(field)), el('code', field.key));
    if (field.reason) root.append(el('p', field.reason, 'notice'));
    for (const prop of field.properties) {
      const label = el('label', prop.label);
      const input = el('input');
      const flag = ['isHide', 'isDisabled'].includes(prop.name);
      const boolean = typeof prop.value === 'boolean' || flag;
      input.type = boolean ? 'checkbox' : 'text';
      if (boolean) input.checked = prop.value === true || prop.value === 1;
      else input.value = prop.value === null ? 'null' : String(prop.value);
      input.disabled = !field.editable || !state.editable || before;
      input.addEventListener('change', () => {
        let next = boolean ? input.checked : input.value;
        if (flag || typeof prop.value === 'number') next = Number(next);
        if (prop.value === null) { try { next = JSON.parse(next); } catch { /* Preserve literal strings. */ } }
        send('property', {collectionPointer: collection.pointer, fieldKey: field.key, name: prop.name, value: next});
      });
      label.append(input); root.append(label);
    }
    const keys = collection.fields.map(item => item.key), index = keys.indexOf(field.key);
    const order = el('div', undefined, 'actions');
    for (const [text, offset] of [['上移', -1], ['下移', 1]]) order.append(button(text, () => {
      const next = [...keys]; [next[index], next[index + offset]] = [next[index + offset], next[index]];
      revealOnUpdate = true;
      send('order', {collectionPointer: collection.pointer, fieldKeys: next});
    }, !state.editable || before || !collection.reorderable || index + offset < 0 || index + offset >= keys.length));
    root.append(order);
    if (!collection.reorderable) root.append(el('p', collection.reorderReason || '当前字段集合不支持排序', 'notice'));
    const nodes = model.nodes.filter(item => item.pointer.startsWith(field.pointer + '/'));
    for (const node of nodes) root.append(button(`${codeType(node)} · ${node.pointer.split('/').at(-1)}`,
      () => openCode(node)));
    if (nodes.length) root.append(button('查看源码差异', () => send('diff', {key: nodes[0].key})));
    else if (collection.kind === 'BUTTONS') root.append(el('p', '此按钮没有已导出的脚本事件。', 'notice'));
  }
  function render() {
    if (!state) return;
    const scroll = ['tree', 'canvas', 'properties'].map(id => [id, $(id).scrollTop, $(id).scrollLeft]);
    const model = before ? state.baseline : state.model;
    $('title').textContent = [model.pageName, model.pageId].filter(Boolean).join(' · ');
    document.title = $('title').textContent + ' · 本地页面';
    $('status').textContent = state.blocked || (state.codeDirty ? '代码有未保存输入，请先在代码标签保存' : state.status)
      || (state.operations.length ? `${state.operations.length} 项未保存修改` : '已保存到本地');
    $('baseline').textContent = `SVN ${state.baseRevision || '未知'} · ${state.sourceHash.slice(0, 12)} · ${model.remoteStatus} · ${before ? '上次保存' : '当前草稿'}`;
    for (const id of ['save', 'undo', 'redo']) $(id).disabled = !state.editable || before;
    for (const id of ['native','manageResources']) $(id).disabled=!!state.resourceBusy;
    $('resume').hidden = !state.pending;
    $('before').textContent = before ? '返回当前草稿' : '查看修改前';
    $('resources').textContent = state.designer
      ? `${state.designer.platformUrl} · ${state.designer.message || '使用已校验缓存'} · 页面效果待验收`
      : '尚未绑定谷神平台，可通过上方“平台资源”连接或导入资源包。';
    renderTree(model);
    renderFields(model); renderProperties(model);
    for (const [id, top, left] of scroll) { $(id).scrollTop = top; $(id).scrollLeft = left; }
    if (revealOnUpdate) { revealSelection(); revealOnUpdate = false; }
    $('delta').textContent = JSON.stringify(state.operations, null, 2);
    api.setState({selection, selectedCode, before, expanded:[...$('tree').querySelectorAll('details')].map(group=>[group.dataset.outlineKey,group.open])});
  }
  window.addEventListener('message', event => {
    if (event.data?.type !== 'state') return;
    state = event.data; awaiting = false; render(); flush();
  });
  for (const type of ['save', 'undo', 'redo', 'export', 'resume', 'native', 'reload', 'manageResources']) $(type)?.addEventListener('click', () => send(type));
  $('search').addEventListener('input', event => { query = event.target.value.trim().toLowerCase(); renderFields(before ? state.baseline : state.model); });
  $('before').addEventListener('click', () => { before = !before; render(); });
  window.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); document.activeElement?.blur(); send('save');
    }
  });
  const saved = api.getState(); if (saved) {
    ({selection, selectedCode, before = false} = saved);
    for (const [key,open] of saved.expanded || []) expansion.set(key,open);
  }
  api.postMessage({type: 'ready'});
})();

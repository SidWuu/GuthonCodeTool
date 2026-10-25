/* Editing inspector only. Rendering belongs exclusively to the original designer. */
(() => {
  const api = acquireVsCodeApi(), $ = id => document.getElementById(id);
  let state, selection, selectedRow, selectedCode, compareMode = '', awaiting = false, query = '', revealOnUpdate = false;
  const expansion = new Map();
  const receiver = new window.GuthonPageState.PageStateReceiver();
  const fieldRows = new Map(), fieldNodes = new Map();
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
  const title = field => field.buttonRole==='RESET' ? '重置' : value(field, 'name') ?? value(field, 'label') ?? value(field, 'disName') ?? field.label;
  const codeType = node => node.type === 'SQL' ? 'SQL' : node.eventScope === 'SERVICE' ? '服务事件' : '前端脚本';
  const regionNames = {FORM:'表单',SEARCH:'查询表单',MAIN_TABLE:'主表',DETAIL_TABLE:'明细表'};
  const within = (pointer, parent) => pointer === parent || pointer.startsWith(parent + '/');
  const intersects = (a,b) => within(a,b) || within(b,a);
  function markDiff(control, pointers) {
    control.dataset.diffPaths = JSON.stringify(pointers);
    for (const [mode, label] of [['svn','M'],['local','●']]) {
      const info=state.comparison?.[mode];
      const paths=mode==='svn' && !info?.available ? [] : (mode==='svn' ? info?.changes?.paths : info?.paths) || [];
      if (!pointers.some(pointer=>paths.some(path=>within(path,pointer)))) continue;
      control.append(el('span',label,'diff-badge diff-'+mode));
      control.classList.add('has-diff-'+mode);
    }
  }
  function renderComparison() {
    const root=$('canvas'); root.replaceChildren(); selectedRow=null;
    const svn=compareMode==='svn', info=svn ? state.comparison?.svn?.changes : state.comparison?.local;
    const heading=el('div',undefined,'comparison-heading '+(svn?'diff-svn':'diff-local'));
    heading.append(el('h2',svn?'SVN BASE → 本地已保存源码':'本地保存版本 → 当前窗口草稿'));
    heading.append(el('p',svn ? `只读 · SVN BASE r${state.comparison?.svn?.baseRevision || state.baseRevision || '未知'} · 不包含窗口未保存草稿`
      : `只读 · 本地基线载入于 ${state.comparison?.savedAt ? new Date(state.comparison.savedAt).toLocaleString() : '未知'} · ${state.sourceHash.slice(0,12)}`));
    root.append(heading);
    if (svn && !state.comparison?.svn?.available) {root.append(el('p',state.comparison?.svn?.message || '正在读取 SVN BASE…','notice'));return;}
    if (!info) return;
    if (info.truncated) root.append(el('p',`共 ${info.total} 项差异，仅展示前 ${info.rows.length} 项；完整差异请从源代码管理查看。`,'notice'));
    if (svn && state.comparison.svn.formatOnly) root.append(el('p','仅 JSON 格式或键顺序发生变化，页面结构和值相同；原文差异请从源代码管理查看。','notice'));
    const collection=state.model.collections.find(item=>item.pointer===selection?.collection);
    const field=collection?.fields.find(item=>item.key===selection?.key);
    const code=state.model.nodes.find(item=>item.key===selectedCode);
    const selected=code?.pointer || field?.pointer || selection?.region;
    let shown=0;
    for (const row of info.rows) {
      if (query && !(row.label+row.pointer+row.beforeText+row.afterText).toLowerCase().includes(query)) continue;
      shown++;
      const section=el('section',undefined,'comparison-change diff-border-'+compareMode);
      if (selection?.removed ? row.kind==='removed' && row.beforePointer===selection.removed : selected && intersects(row.anchor,selected)) {
        section.classList.add('comparison-selected'); selectedRow ||= section;
      }
      const kind={added:'新增',removed:'删除',modified:'修改',order:'排序'}[row.kind] || '修改';
      section.append(el('h3',`${kind} · ${row.label || '页面配置'}`),el('code',row.pointer || '/'));
      const columns=el('div',undefined,'comparison-columns');
      for (const [name,content] of [[svn?'SVN BASE':'本地保存版本',row.beforeText],[svn?'本地已保存源码':'当前窗口草稿',row.afterText]]) {
        const side=el('div');side.append(el('h4',name),el('pre',content));columns.append(side);
      }
      section.append(columns);root.append(section);
    }
    if (!shown) root.append(el('p',query?'没有匹配的差异':'当前比较没有内容差异。','empty'));
    if (selected && selectedRow) revealSelection();
  }
  function renderSourceMerge() {
    const root = $('canvas'), merge = state.sourceMerge;
    root.replaceChildren(); selectedRow = null;
    if (!merge) return;
    root.append(el('h2', '外部文件与窗口草稿'));
    root.append(el('p', merge.applying ? '正在重新核对文件，请稍候…'
      : '选择只影响窗口草稿；全部选择完成后迁移到当前文件版本，仍需“保存到本地”。', 'notice'));
    if (merge.blockedReason) {
      root.append(el('p', merge.blockedReason, 'notice'));
      if (merge.paths.length) root.append(el('pre', merge.paths.slice(0, 100).join('\n')));
      root.append(el('p', '当前草稿保持不变。请先导出草稿、保留未保存代码或原版设置输入，再按提示重新载入。', 'notice'));
    }
    for (const conflict of merge.conflicts) {
      if (query && !(conflict.label + conflict.pointer + conflict.texts.join(' ')).toLowerCase().includes(query)) continue;
      const section = el('section', undefined, 'comparison-change source-merge-change');
      section.append(el('h3', conflict.label), el('code', conflict.pointer));
      const columns = el('div', undefined, 'comparison-columns source-merge-columns');
      ['原先加载的值', '当前文件的值', '窗口草稿的值'].forEach((name, index) => {
        const side = el('div'); side.append(el('h4', name), el('pre', conflict.texts[index])); columns.append(side);
      });
      section.append(columns);
      if (conflict.truncated) section.append(el('p', '长内容仅展示前 8000 字，完整三方内容随“导出草稿”保留。', 'notice'));
      const actions = el('div', undefined, 'actions');
      for (const [choice, label] of [['draft', '保留窗口修改'], ['file', '采用文件修改']]) {
        const control = button(label, () => send('resolveSourceConflict', {id: conflict.id, choice, sourceHash: merge.sourceHash}),
          !!merge.blockedReason || merge.applying || state.busy || !!state.pending || !!state.blocked,
          conflict.choice === choice ? 'primary' : '');
        control.setAttribute('aria-pressed', String(conflict.choice === choice)); actions.append(control);
      }
      section.append(actions); root.append(section);
    }
  }
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
    const model=state.model;
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
    render(); revealSelection(); if (!compareMode && !state.comparison?.sourceStale) send('openCode',{key:node.key});
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
    fieldNodes.clear();
    const tree = $('tree');
    for (const group of tree.querySelectorAll('details')) expansion.set(group.dataset.outlineKey,group.open);
    const selectedNode = model.nodes.find(node=>node.key === selectedCode);
    const collection = model.collections.find(item=>item.pointer === selection?.collection);
    const selectedRegion = selection?.region ?? collection?.regionPointer ?? collection?.pointer.slice(0,collection.pointer.lastIndexOf('/'));
    const active = (pointer, keys=[]) => (selectedRegion !== undefined && within(selectedRegion,pointer))
      || (selectedNode && within(selectedNode.pointer,pointer)) || keys.includes(selectedCode);
    function branch(key,label,parent,opened=false,selected=false,navigate,paths=[]) {
      const group = el('details',undefined,'tree-node'); group.dataset.outlineKey=key;
      group.classList.toggle('tree-root',key==='page');
      group.open = selected || (expansion.has(key) ? expansion.get(key) : opened);
      const summary = el('summary');
      if (navigate) {
        const control = button(label,()=>{group.open=true; navigate();},false,'tree-link');
        summary.append(control);
      } else summary.textContent=label;
      markDiff(summary,paths);
      const children = el('div',undefined,'tree-children'); group.append(summary,children); parent.append(group);
      return children;
    }
    function codeLeaf(node,parent) {
      const name = node.pointer.split('/').at(-1).replace(/~1/g,'/').replace(/~0/g,'~');
      const inherited = node.reason?.includes('继承') ? '（继承）' : '';
      const control = button(name+inherited,()=>openCode(node),false,'tree-link tree-code');
      control.title=node.label; control.setAttribute('aria-label',`${codeType(node)} · ${node.label}`);
      control.classList.toggle('selected',node.key===selectedCode); markDiff(control,[node.pointer]); parent.append(control);
    }
    function codes(keys,parent,key) {
      const nodes = model.nodes.filter(node=>keys.includes(node.key));
      for (const node of nodes.filter(item=>item.type==='SQL')) codeLeaf(node,parent);
      for (const [scope,label] of [['FRONT','前端事件'],['SERVICE','服务事件']]) {
        const events=nodes.filter(node=>node.type!=='SQL' && (node.eventScope==='SERVICE'?'SERVICE':'FRONT')===scope);
        if (!events.length) continue;
        const group=branch(key+':'+scope,label,parent,false,events.some(node=>node.key===selectedCode),undefined,events.map(node=>node.pointer));
        events.forEach(node=>codeLeaf(node,group));
      }
    }
    function layoutEntry(entry,parent) {
      const label = entry.region ? `${entry.label}（${regionNames[entry.region] || entry.region}）` : entry.label;
      const group = branch('layout:'+entry.pointer,label,parent,true,active(entry.pointer),()=>selectRegion(entry.pointer),[entry.pointer]);
      if (entry.nodeKeys.length) {
        const events = branch('codes:'+entry.pointer,'区域脚本与 SQL',group,false,entry.nodeKeys.includes(selectedCode),undefined,model.nodes.filter(node=>entry.nodeKeys.includes(node.key)).map(node=>node.pointer));
        codes(entry.nodeKeys,events,'region:'+entry.pointer);
      }
      for (const [kind,label] of [['BUTTONS','按钮'],['FIELDS','字段']]) {
        const collections = model.collections.filter(item=>entry.collectionPointers.includes(item.pointer)
          && (item.kind || 'FIELDS')===kind);
        const count=collections.reduce((sum,item)=>sum+item.fields.length,0);
        if (!count) continue;
        const isSelected=collections.some(item=>item.pointer===selection?.collection)
          || collections.some(item=>item.fields.some(field=>selectedNode && within(selectedNode.pointer,field.pointer)));
        const items=branch(kind+':'+entry.pointer,`${label} (${count})`,group,false,isSelected,undefined,collections.map(item=>item.pointer));
        for (const collection of collections) for (const field of collection.fields) {
          const name = kind==='BUTTONS' ? title(field) : `${title(field)} [${field.key.replace(/^[^:]+:/,'')}]`;
          const nodes=model.nodes.filter(node=>within(node.pointer,field.pointer));
          const selected=selection?.collection===collection.pointer && selection?.key===field.key;
          if (nodes.length) {
            const owner = branch('item:'+collection.pointer+'|'+field.key,name,items,false,
              selected || nodes.some(node=>node.key===selectedCode),()=>select(collection,field),[field.pointer]);
            owner.previousElementSibling.firstElementChild.classList.toggle('selected',selected);
            owner.previousElementSibling.firstElementChild.dataset.field = collection.pointer + '|' + field.key;
            fieldNodes.set(collection.pointer + '|' + field.key, owner.previousElementSibling.firstElementChild);
            codes(nodes.map(node=>node.key),owner,'item:'+collection.pointer+'|'+field.key);
          } else {
            const control=button(name,()=>select(collection,field),false,'tree-link');
            control.dataset.field = collection.pointer + '|' + field.key;
            fieldNodes.set(control.dataset.field, control);
            control.classList.toggle('selected',selected); markDiff(control,[field.pointer]); items.append(control);
          }
        }
      }
      entry.children.forEach(child=>layoutEntry(child,group));
    }
    tree.replaceChildren(el('span','PAGE OUTLINE','eyebrow'));
    const page=branch('page',[model.pageName,model.pageId].filter(Boolean).join(' · '),tree,true,!!selection || !!selectedNode,undefined,['']);
    if (model.outline.pageNodeKeys.length) {
      const events=branch('page-events','页面事件',page,false,model.outline.pageNodeKeys.includes(selectedCode),undefined,model.nodes.filter(node=>model.outline.pageNodeKeys.includes(node.key)).map(node=>node.pointer));
      codes(model.outline.pageNodeKeys,events,'page-events');
    }
    if (model.outline.layout.length) {
      const layout=branch('layout','页面布局',page,true,selectedRegion!==undefined || model.outline.layout.some(entry=>selectedNode && within(selectedNode.pointer,entry.pointer)),undefined,['/views']);
      model.outline.layout.forEach(entry=>layoutEntry(entry,layout));
    }
    const removed=state.comparison?.svn?.available ? state.comparison.svn.changes.rows.filter(row=>row.kind==='removed') : [];
    if (removed.length) {
      const group=branch('svn-removed',`SVN 已删除项 (${removed.length})`,page,false,!!selection?.removed);
      for (const row of removed) {
        const control=button(row.label || '已删除配置',()=>{
          selection={removed:row.beforePointer};selectedCode=undefined;compareMode='svn';query='';$('search').value='';
          render();revealSelection();
        },false,'tree-link diff-svn');
        control.append(el('span','M','diff-badge diff-svn'));group.append(control);
      }
    }
  }
  function renderFields(model) {
    fieldRows.clear();
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
          control.dataset.field = set.pointer + '|' + item.key;
          fieldRows.set(control.dataset.field, control);
          control.classList.toggle('selected',selection?.collection===set.pointer && selection?.key===item.key);
          control.title = `编辑“${title(item)}”按钮属性与事件`;
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
          row.dataset.field = collection.pointer + '|' + field.key;
          fieldRows.set(row.dataset.field, row);
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
    root.append(el('h3', title(field)));
    if (collection.kind!=='BUTTONS') root.append(el('code', field.key));
    if (field.reason) root.append(el('p', field.reason, 'notice'));
    for (const prop of field.properties) {
      const label = el('label', prop.label);
      const input = el('input');
      const flag = ['isHide', 'isDisabled'].includes(prop.name);
      const boolean = typeof prop.value === 'boolean' || flag;
      input.type = boolean ? 'checkbox' : 'text';
      if (boolean) input.checked = prop.value === true || prop.value === 1;
      else input.value = prop.value === null ? 'null' : String(prop.value);
      input.disabled = !field.editable || !state.editable || !!compareMode;
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
    }, !state.editable || !!compareMode || !collection.reorderable || index + offset < 0 || index + offset >= keys.length));
    root.append(order);
    if (!collection.reorderable) root.append(el('p', collection.reorderReason || '当前字段集合不支持排序', 'notice'));
    const nodes = model.nodes.filter(item => item.pointer.startsWith(field.pointer + '/'));
    for (const node of nodes) root.append(button(`${codeType(node)} · ${node.pointer.split('/').at(-1)}`,
      () => openCode(node)));
    if (nodes.length) root.append(button('查看源码差异', () => send('diff', {key: nodes[0].key})));
    else if (collection.kind === 'BUTTONS') root.append(el('p', '此按钮没有已导出的脚本事件。', 'notice'));
  }
  function render(update = null) {
    if (!state) return;
    const scroll = ['tree', 'canvas', 'properties'].map(id => [id, $(id).scrollTop, $(id).scrollLeft]);
    const model = state.model;
    $('title').textContent = [model.pageName, model.pageId].filter(Boolean).join(' · ');
    document.title = $('title').textContent + ' · 本地页面';
    $('status').textContent = state.blocked || (state.codeDirty ? '代码有未保存输入，请先在代码标签保存' : state.status)
      || (state.operations.length ? `${state.operations.length} 项未保存修改` : '已保存到本地');
    $('baseline').textContent = `SVN ${state.baseRevision || '未知'} · ${state.sourceHash.slice(0, 12)} · ${model.remoteStatus} · ${compareMode ? '只读比较' : '当前草稿'}`;
    for (const id of ['save', 'undo', 'redo']) $(id).disabled = !state.editable || !!compareMode;
    for (const id of ['native','manageResources']) $(id).disabled=!!state.resourceBusy;
    $('native').disabled ||= !!state.comparison?.sourceStale;
    $('resume').hidden = !state.pending;
    $('source-merge').hidden = !state.sourceMerge;
    $('exit-compare').hidden = !compareMode;
    $('comparison-status').textContent = state.sourceMerge ? state.sourceMerge.blockedReason || '存在外部修改冲突，请逐项核对'
      : state.comparison?.sourceStale ? '本地文件已外部更新，请保留输入并重新核对' : state.comparison?.svn?.available ? '' : state.comparison?.svn?.message || '';
    $('resources').textContent = state.designer
      ? `${state.designer.platformUrl} · ${state.designer.message || '使用已校验缓存'} · 页面效果待验收`
      : '原版设计器按需打开；点击“原版设计视图”使用已绑定资源，或通过“平台资源”连接与管理。';
    const structural = !update || update.full || update.changes.some(operation => operation.kind !== 'property') || !!query || !!compareMode;
    if (structural) renderTree(model);
    if (compareMode === 'external') {
      renderSourceMerge(); $('properties').replaceChildren(el('h2','冲突处理'),el('p','原值、文件值和窗口值分别保留。选择完成后返回草稿核对，再保存到本地。','notice'));
    }
    else if (compareMode) { renderComparison(); $('properties').replaceChildren(el('h2','只读比较'),el('p','退出比较后继续编辑，当前草稿保持不变。','notice')); }
    else if (structural) { renderFields(model); renderProperties(model); }
    else {
      for (const operation of update.changes) {
        const collection = model.collections.find(item => item.pointer === operation.collectionPointer);
        const field = collection?.fields.find(item => item.key === operation.fieldKey);
        if (!field) continue;
        const identity = collection.pointer + '|' + field.key;
        const row = fieldRows.get(identity);
        if (row?.tagName === 'TR') {
          row.setAttribute('aria-label', `${title(field)} · ${field.key}`);
          row.children[0].textContent = title(field); row.children[3].textContent = value(field, 'width') ?? '—';
        } else if (row) row.textContent = title(field);
        const owner = fieldNodes.get(identity);
        if (owner) {
          owner.replaceChildren(document.createTextNode(collection.kind === 'BUTTONS' ? title(field) : `${title(field)} [${field.key.replace(/^[^:]+:/,'')}]`));
        }
        if (selection?.collection === collection.pointer && selection?.key === field.key) renderProperties(model);
      }
      // Ancestor badges aggregate the changed field paths without rebuilding the navigation tree.
      const changedFields = update.changes.map(operation => model.collections.find(item => item.pointer === operation.collectionPointer)
        ?.fields.find(item => item.key === operation.fieldKey)?.pointer).filter(Boolean);
      for (const control of changedFields.length ? $('tree').querySelectorAll('[data-diff-paths]') : []) {
        const paths = JSON.parse(control.dataset.diffPaths);
        if (!paths.some(pointer => changedFields.some(field => within(field, pointer)))) continue;
        for (const badge of control.querySelectorAll(':scope > .diff-badge')) badge.remove();
        control.classList.remove('has-diff-svn', 'has-diff-local');
        markDiff(control, paths);
      }
    }
    for (const [id, top, left] of scroll) { $(id).scrollTop = top; $(id).scrollLeft = left; }
    if (revealOnUpdate) { revealSelection(); revealOnUpdate = false; }
    $('delta').textContent = JSON.stringify(state.operations, null, 2);
    api.setState({selection, selectedCode, compareMode, expanded:[...$('tree').querySelectorAll('details')].map(group=>[group.dataset.outlineKey,group.open])});
  }
  window.addEventListener('message', event => {
    if (event.data?.type !== 'state') return;
    const mergeHash = state?.sourceMerge?.sourceHash;
    const previousMode = compareMode, previousState = state;
    const received = receiver.receive(event.data);
    if (!received) { api.postMessage({type: 'ready'}); return; }
    if (received.ignored) return;
    state = received.state;
    if (state.sourceMerge && mergeHash !== state.sourceMerge.sourceHash) compareMode = 'external';
    if (compareMode === 'external' && !state.sourceMerge) compareMode = '';
    awaiting = false;
    const changedView = previousMode !== compareMode || previousState?.comparison?.svn !== state.comparison?.svn
      || previousState?.editable !== state.editable || previousState?.pageName !== state.pageName;
    render(changedView ? null : received); flush();
  });
  for (const type of ['save', 'undo', 'redo', 'export', 'resume', 'native', 'reload', 'manageResources']) $(type)?.addEventListener('click', () => send(type));
  $('search').addEventListener('input', event => {
    query = event.target.value.trim().toLowerCase();
    if (compareMode === 'external') renderSourceMerge(); else if (compareMode) renderComparison(); else renderFields(state.model);
  });
  $('source-merge').addEventListener('click', () => { compareMode = 'external'; render(); });
  $('compare').addEventListener('click', () => {
    $('compare-menu').hidden = !$('compare-menu').hidden;
    $('compare').setAttribute('aria-expanded',String(!$('compare-menu').hidden));
  });
  for (const mode of ['svn','local']) $('compare-'+mode).addEventListener('click', () => {
    compareMode=mode; $('compare-menu').hidden=true; $('compare').setAttribute('aria-expanded','false');
    render(); send('compare');
  });
  $('exit-compare').addEventListener('click', () => { compareMode=''; render(); });
  window.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); if (!compareMode) { document.activeElement?.blur(); send('save'); }
    }
  });
  const saved = api.getState(); if (saved) {
    ({selection, selectedCode, compareMode = ''} = saved);
    for (const [key,open] of saved.expanded || []) expansion.set(key,open);
  }
  api.postMessage({type: 'ready'});
})();

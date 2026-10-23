/* Read-only navigation from the physical PAGE layout and existing editor targets. */
const regionTypes = {'input-box':'FORM', 'search-box':'SEARCH', 'table-main':'MAIN_TABLE', 'table-item':'DETAIL_TABLE'};
const layoutKeys = new Set(['views', 'rows', 'cols', 'component', 'tabs', 'pages']);
const metadataKeys = new Set(['fields', 'buttons', 'datasource', 'pageEvents', 'serviceEvents', 'superPageEvents', 'superServiceEvents']);
const generatedName = /^(?:tab(?:Page|Item|Set)?|tabs?|container|panel|rows?|cols?|columns?|views?)[_-]?\d*$/i;
const within = (pointer, parent) => pointer === parent || pointer.startsWith(parent + '/');
const childPointer = (pointer, key) => pointer + '/' + String(key).replace(/~/g, '~0').replace(/\//g, '~1');

function buildOutline(page, model) {
  const regions = new Map(), entries = [], namedEntries = new Set();
  for (const collection of model.collections) {
    const pointer = collection.regionPointer ?? collection.pointer.slice(0, collection.pointer.lastIndexOf('/'));
    if (!regions.has(pointer)) regions.set(pointer, []);
    regions.get(pointer).push(collection);
  }
  const regionPaths = [...regions.keys()];
  const ownerPaths = model.collections.flatMap(collection=>collection.fields.map(field=>field.pointer));
  const freeNodes = model.nodes.filter(node=>!ownerPaths.some(pointer=>within(node.pointer,pointer)));
  function walk(value, pointer, slot, index) {
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap((child,i)=>walk(child,childPointer(pointer,i),slot,i));
    const collections = regions.get(pointer) || [], children = [];
    for (const [key, child] of Object.entries(value)) {
      if (metadataKeys.has(key)) continue;
      const target = childPointer(pointer,key);
      if (layoutKeys.has(key) || regionPaths.some(path=>within(path,target)))
        children.push(...walk(child,target,key));
    }
    const region = collections[0]?.region || regionTypes[value.type] || '';
    const hasCode = freeNodes.some(node=>within(node.pointer,pointer));
    if (!region && !children.length && !hasCode) return [];
    // Keep physical owners until code assignment; navigation is compacted below.
    if (slot === 'views' && index === undefined && !value.name && !value.type && !region) return children;
    const kind = region ? 'region' : slot === 'rows' ? 'row' : slot === 'cols' ? 'column'
      : slot === 'pages' ? 'tab' : slot === 'tabs' ? 'tabs' : 'container';
    const text = values => values.find(item=>typeof item === 'string' && item.trim())?.trim();
    const caption=text([value.label,value.title,value.disName,value.aliasName].filter(item=>typeof item==='string' && !generatedName.test(item.trim())));
    const name=text([value.name]);
    const named=caption || (name && !generatedName.test(name) ? name : '');
    const fallback = kind === 'tab' ? `页签 ${(index ?? 0)+1}` : kind === 'tabs' ? '页签组' : '容器';
    const label = region ? text([value.name,value.aliasName,value.label,value.disName,value.id]) || collections[0]?.label || fallback
      : named || fallback;
    const entry = {pointer,kind,label,region,collectionPointers:collections.map(item=>item.pointer),nodeKeys:[],children};
    if (named) namedEntries.add(entry);
    entries.push(entry); return [entry];
  }
  const layout = walk(page.views,'/views','views');
  // Keep recognized UI collections outside views reachable, without scanning private metadata as layout.
  for (const pointer of regionPaths) if (!entries.some(entry=>entry.pointer === pointer)) {
    const value = pointer ? pointer.slice(1).split('/').reduce((item,key)=>item?.[key.replace(/~1/g,'/').replace(/~0/g,'~')],page) : page;
    layout.push(...walk(value,pointer,'component'));
  }
  const pageNodeKeys = [];
  for (const node of freeNodes) {
    const owner = entries.filter(entry=>within(node.pointer,entry.pointer)).sort((a,b)=>b.pointer.length-a.pointer.length)[0];
    if (owner) owner.nodeKeys.push(node.key);
    else pageNodeKeys.push(node.key);
  }
  function compact(items,parentKeys) {
    const result=[];
    for (const entry of items) {
      entry.children=compact(entry.children,entry.nodeKeys);
      const transparent=entry.kind==='row' || entry.kind==='column'
        || (['container','tabs'].includes(entry.kind) && !namedEntries.has(entry))
        || (entry.kind==='tab' && !namedEntries.has(entry) && entry.children.length===1);
      if (transparent) {
        // Hoist wrapper events as well, keeping every original event key reachable.
        parentKeys.push(...entry.nodeKeys);result.push(...entry.children);
      } else result.push(entry);
    }
    return result;
  }
  return {layout:compact(layout,pageNodeKeys),pageNodeKeys};
}

module.exports = {buildOutline};

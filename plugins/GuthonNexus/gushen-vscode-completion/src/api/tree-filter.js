function matches(item, query) {
  return [item.label,item.object?.name,item.object?.sourceId,item.object?.funId,item.object?.path,item.sourcePrefix]
    .some(value=>typeof value==='string' && value.toLocaleLowerCase().includes(query));
}
function filterChildren(items, text, parent) {
  const query=text.trim().toLocaleLowerCase();
  if(!query)return items;
  for(let ancestor=parent;ancestor;ancestor=ancestor.parent)if(matches(ancestor,query))return items;
  const contains=item=>matches(item,query) || (Array.isArray(item.children) && item.children.some(contains));
  return items.filter(item=>item.kind==='message' || contains(item));
}
module.exports={filterChildren};

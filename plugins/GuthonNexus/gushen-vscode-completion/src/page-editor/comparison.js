/* Read-only draft comparison; source SVN differences are computed losslessly by the backend. */
const text = value => JSON.stringify(value, null, 2);
function draftChanges(draft) {
  const rows = [], paths = new Set();
  for (const op of draft.operations()) {
    let before, after, pointer, label, kind = 'modified';
    if (op.kind === 'text') {
      const node = draft.baseline.nodes.find(item=>item.pointer===op.jsonPointer);
      before=node.content; after=op.content; pointer=node.pointer; label=node.label || pointer;
    } else {
      const original=draft.baseline.collections.find(item=>item.pointer===op.collectionPointer);
      const current=draft.model.collections.find(item=>item.pointer===op.collectionPointer);
      if (op.kind==='order') {
        const names=fields=>fields.map(field=>field.buttonRole==='RESET'?'重置':field.properties.find(prop=>['name','label','disName'].includes(prop.name))?.value || field.label);
        before=names(original.fields); after=names(current.fields);pointer=op.collectionPointer;label=original.label+' / 顺序';kind='order';
        original.fields.forEach((field,index)=>{if (current.fields[index].key!==field.key) paths.add(field.pointer);});
      } else {
        const field=original.fields.find(item=>item.key===op.fieldKey);
        before=field.properties.find(prop=>prop.name===op.property).value;after=op.value;
        pointer=field.pointer+'/'+op.property;label=original.label+' / '+field.label+' / '+op.property;
      }
    }
    // Tree pointers remain the saved model's stable addresses even while its field order is drafted.
    paths.add(pointer);
    rows.push({kind,pointer,anchor:pointer,label,beforeText:op.kind==='text'?before:text(before),afterText:op.kind==='text'?after:text(after)});
  }
  return {rows,paths:[...paths],total:rows.length,truncated:false};
}
module.exports = {draftChanges};

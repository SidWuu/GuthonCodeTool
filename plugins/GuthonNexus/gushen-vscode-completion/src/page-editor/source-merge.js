const {PageDraft} = require('./model');

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const pointerKey = value => String(value).replace(/~/g, '~0').replace(/\//g, '~1');
const nativeIdentity = value => ['fieldId', 'id', 'guid'].find(key => typeof value?.[key] === 'string' && value[key].trim());

function topology(model) {
  const entries = new Map();
  for (const collection of model.collections) entries.set(collection.pointer, [collection.region, collection.kind, collection.reorderable,
    collection.fields.map(field => [field.key, field.pointer, field.type, field.editable, field.buttonRole])]);
  for (const node of model.nodes) entries.set(node.pointer, [node.key, node.type, node.eventScope, node.editable]);
  return entries;
}

function ownerIdentity(data, pointer, arrays) {
  let current = data;
  const result = [];
  for (const part of pointer.slice(1).split('/').map(value => value.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!current || !Object.hasOwn(current, part)) return null;
    if (Array.isArray(current)) {
      const key = nativeIdentity(current[part]);
      if (!key) return null;
      if (!arrays.has(current)) {
        const counts = new Map();
        for (const value of current) {
          const name = nativeIdentity(value);
          if (!name) continue;
          const identity = name + ':' + value[name].trim().toLowerCase();
          counts.set(identity, (counts.get(identity) || 0) + 1);
        }
        arrays.set(current, counts);
      }
      if (arrays.get(current).get(key + ':' + current[part][key].trim().toLowerCase()) !== 1) return null;
    }
    current = current[part];
    if (current && !Array.isArray(current) && typeof current === 'object') result.push(
      ['pageId', 'fieldId', 'id', 'guid', 'type'].filter(key => Object.hasOwn(current, key)).map(key => [key, current[key]])
    );
  }
  return result;
}

function mergePageDraft(baseline, previous, current, choices = {}) {
  const blocked = (reason, paths = []) => ({draft: null, conflicts: [], blockedReason: reason, paths});
  for (const key of ['workspaceKey', 'sourceNamespace', 'sourceId', 'workingCopyId', 'sourcePath', 'funId']) {
    if ((baseline[key] || '') !== (current[key] || '')) return blocked('页面来源身份已变化，请导出草稿后重新载入');
  }
  let beforeData, currentData;
  try { beforeData = JSON.parse(baseline.sourceText); currentData = JSON.parse(current.sourceText); }
  catch { return blocked('页面原文无法解析，请保留草稿并检查源码'); }
  if (!beforeData?.pageId || beforeData.pageId !== currentData?.pageId
    || beforeData.pageId !== previous.baseline.pageId || beforeData.pageId !== current.model.pageId)
    return blocked('页面编码与草稿不一致，请导出草稿后重新载入');

  const operations = previous.operations(), draft = new PageDraft(current.model);
  if (!operations.length) return {draft, conflicts: [], blockedReason: '', paths: [], appliedCount: 0, absorbedCount: 0};
  if (!current.editable) return blocked('当前页面不可编辑，请导出草稿后核对来源和 SVN 状态');
  const oldTopology = topology(previous.baseline), freshTopology = topology(current.model);
  const changed = [...new Set([...oldTopology.keys(), ...freshTopology.keys()])]
    .filter(pointer => !same(oldTopology.get(pointer), freshTopology.get(pointer)));
  if (changed.length) return blocked('页面结构、顺序或可编辑范围已变化，请导出草稿后重新载入', changed);

  const oldCollections = new Map(previous.baseline.collections.map(item => [item.pointer, item]));
  const freshCollections = new Map(current.model.collections.map(item => [item.pointer, item]));
  const oldNodes = new Map(previous.baseline.nodes.map(item => [item.pointer, item]));
  const freshNodes = new Map(current.model.nodes.map(item => [item.pointer, item]));
  const arrays = new WeakMap(), conflicts = [];
  let absorbedCount = 0;
  for (const operation of operations) {
    let before, file, local, pointer, label;
    if (operation.kind === 'text') {
      const original = oldNodes.get(operation.jsonPointer), fresh = freshNodes.get(operation.jsonPointer);
      before = original.content; file = fresh.content; local = operation.content;
      pointer = original.pointer; label = original.label || pointer;
    } else {
      const original = oldCollections.get(operation.collectionPointer), fresh = freshCollections.get(operation.collectionPointer);
      if (operation.kind === 'order') {
        before = original.fields.map(field => field.key); file = fresh.fields.map(field => field.key); local = operation.fieldKeys;
        pointer = original.pointer; label = (original.label || pointer) + ' / 顺序';
      } else {
        const field = original.fields.find(item => item.key === operation.fieldKey);
        const next = fresh.fields.find(item => item.key === operation.fieldKey);
        const oldProperty = field.properties.find(item => item.name === operation.property);
        const freshProperty = next.properties.find(item => item.name === operation.property);
        pointer = field.pointer + '/' + pointerKey(operation.property);
        if (!oldProperty || !freshProperty) return blocked('草稿属性已不存在，请导出草稿后重新载入', [pointer]);
        before = oldProperty.value; file = freshProperty.value; local = operation.value;
        if (file !== null && local !== null && typeof file !== typeof local)
          return blocked('属性类型已变化，请导出草稿后核对当前源码类型', [pointer]);
        label = [original.label || original.pointer, field.label || field.key, operation.property].join(' / ');
      }
    }
    const originalOwner = ownerIdentity(beforeData, pointer, arrays), freshOwner = ownerIdentity(currentData, pointer, arrays);
    if (!originalOwner || !freshOwner || !same(originalOwner, freshOwner))
      return blocked('目标区域或控件身份不明确，请导出草稿后重新载入', [pointer]);

    const id = JSON.stringify([operation.kind, operation.collectionPointer || operation.jsonPointer,
      operation.fieldKey || '', operation.property || '']);
    let apply = true;
    if (same(file, local)) { absorbedCount++; apply = false; }
    else if (!same(file, before)) {
      const choice = ['draft', 'file'].includes(choices[id]) ? choices[id] : null;
      conflicts.push({id, kind: operation.kind, pointer, label, before, file, local, choice});
      apply = choice === 'draft';
    }
    if (apply) draft.restore([operation]);
  }
  return {draft, conflicts, blockedReason: '', paths: [], absorbedCount, appliedCount: draft.operations().length};
}

module.exports = {mergePageDraft};

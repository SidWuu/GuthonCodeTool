const clone = value => JSON.parse(JSON.stringify(value));
const parts = pointer => pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
const get = (object, pointer) => parts(pointer).reduce((value, key) => value[key], object);
const set = (object, pointer, value) => { const keys = parts(pointer), key = keys.pop(); keys.reduce((item, part) => item[part], object)[key] = value; };
const nativeKey = field => ['fieldId', 'id', 'guid'].find(name => typeof field?.[name] === 'string' && field[name].trim());
const keyOf = field => { const name = nativeKey(field); return name ? name + ':' + field[name].trim() : ''; };
const pointerKey = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1');

function projectNative(snapshot, draft) {
  const data = JSON.parse(snapshot.sourceText), model = clone(draft.model);
  for (const op of draft.operations().filter(op => op.kind !== 'order')) {
    if (op.kind === 'text') set(data, op.jsonPointer, op.content);
    else {
      const field = snapshot.model.collections.find(item => item.pointer === op.collectionPointer).fields.find(item => item.key === op.fieldKey);
      set(data, field.pointer + '/' + pointerKey(op.property), op.value);
    }
  }
  for (const collection of model.collections) {
    const original = snapshot.model.collections.find(item => item.pointer === collection.pointer);
    const fields = new Map(get(data, collection.pointer).map(field => [keyOf(field), field]));
    if (!original.reorderable) continue;
    set(data, collection.pointer, collection.fields.map(field => fields.get(field.key)));
    for (const [index, field] of collection.fields.entries()) {
      const previous = original.fields.find(item => item.key === field.key).pointer;
      field.pointer = collection.pointer + '/' + index;
      for (const node of model.nodes) {
        const base = snapshot.model.nodes.find(item => item.key === node.key);
        if (base.pointer.startsWith(previous + '/')) node.pointer = field.pointer + base.pointer.slice(previous.length);
      }
    }
  }
  return {data, model};
}

function nativeChanges(baseline, candidate, model) {
  if (!candidate || candidate.pageId !== baseline?.pageId || candidate.pageId !== model.pageId) throw new Error('设计器页面身份不一致');
  const changes = [], same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const collections = new Map(model.collections.map(item => [item.pointer, item]));
  const nodes = new Map(model.nodes.map(item => [item.pointer, item]));
  const properties = new Map(model.collections.flatMap(collection => collection.fields.flatMap(field => field.properties.map(prop =>
    [field.pointer + '/' + pointerKey(prop.name), {collection, field, prop}]))));
  function walk(before, after, pointer) {
    if (same(before, after)) return;
    if (after === undefined) throw new Error('暂不支持删除属性：' + pointer);
    if (Array.isArray(before) || Array.isArray(after)) {
      if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) throw new Error('暂不支持设计器中的字段、按钮或布局增删');
      const collection = collections.get(pointer);
      if (collection?.reorderable) {
        const beforeKeys = before.map(keyOf), afterKeys = after.map(keyOf);
        if (new Set(afterKeys).size !== beforeKeys.length || afterKeys.some(key => !beforeKeys.includes(key))) throw new Error('设计器改变了字段身份');
        if (!same(beforeKeys, afterKeys)) changes.push({kind: 'order', collectionPointer: pointer, fieldKeys: afterKeys});
        for (const [index, key] of beforeKeys.entries()) walk(before[index], after[afterKeys.indexOf(key)], pointer + '/' + index);
      } else before.forEach((value, index) => walk(value, after[index], pointer + '/' + index));
    } else if (before && after && typeof before === 'object' && typeof after === 'object') {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (['superPageEvents', 'superServiceEvents'].includes(key)) continue;
        walk(before[key], after[key], pointer + '/' + pointerKey(key));
      }
    } else if (properties.has(pointer)) {
      const {collection, field, prop} = properties.get(pointer);
      if (!field.editable) throw new Error('此控件仅支持查看');
      changes.push({kind: 'property', collectionPointer: collection.pointer, fieldKey: field.key, property: prop.name, value: after});
    } else if (nodes.get(pointer)?.editable && typeof after === 'string') {
      changes.push({kind: 'text', key: nodes.get(pointer).key, content: after});
    } else throw new Error('设计器修改超出已验证范围：' + pointer);
  }
  walk(baseline, candidate, '');
  if (changes.length > 500) throw new Error('设计器修改超过 500 项');
  return changes;
}
module.exports = {projectNative, nativeChanges};

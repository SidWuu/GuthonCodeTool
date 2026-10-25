/* Shared by the extension host and its Webview; no filesystem or script execution. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GuthonPageModel = factory();
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  class PageDraft {
    constructor(model) {
      this.baseline = clone(model); this.model = clone(model);
      this.version = 0; this.past = []; this.future = [];
      this.collections = new Map(); this.nodes = new Map(); this.dirty = new Map();
      let rank = 0;
      for (const [index, collection] of this.model.collections.entries()) {
        const original = this.baseline.collections[index], fields = new Map();
        for (const [fieldIndex, field] of collection.fields.entries()) {
          const properties = new Map();
          for (const [propertyIndex, property] of field.properties.entries()) {
            properties.set(property.name, {object: property, key: 'value', baseline: original.fields[fieldIndex].properties[propertyIndex].value,
              rank: rank++, operation: {kind: 'property', collectionPointer: collection.pointer, fieldKey: field.key, property: property.name}});
          }
          fields.set(field.key, {value: field, properties});
        }
        const order = {object: collection, key: 'fields', fields, baseline: original.fields.map(field => field.key), rank: rank++,
          operation: {kind: 'order', collectionPointer: collection.pointer}};
        this.collections.set(collection.pointer, {value: collection, fields, order});
      }
      for (const [index, node] of this.model.nodes.entries()) this.nodes.set(node.key, {
        object: node, key: 'content', baseline: this.baseline.nodes[index].content, rank: rank++,
        operation: {kind: 'text', jsonPointer: node.pointer},
      });
    }
    write(target, value) {
      target.object[target.key] = target.fields ? value.map(key => target.fields.get(key).value) : clone(value);
      if (same(value, target.baseline)) this.dirty.delete(target);
      else this.dirty.set(target, {...target.operation, [target.fields ? 'fieldKeys' : target.key === 'content' ? 'content' : 'value']: value});
    }
    record(entries) {
      if (this.transaction) { this.transaction.push(...entries); return; }
      const combined = new Map();
      for (const entry of entries) combined.set(entry.target, {...entry,
        before: combined.has(entry.target) ? combined.get(entry.target).before : entry.before});
      const changes = [...combined.values()].filter(entry => !same(entry.before, entry.after));
      if (!changes.length) return;
      this.past.push(changes); if (this.past.length > 50) this.past.shift();
      this.future = []; this.version++;
    }
    change(target, value) {
      const before = target.fields ? target.object.fields.map(field => field.key) : target.object[target.key];
      if (same(before, value)) return;
      const entry = {target, before: clone(before), after: clone(value)};
      this.write(target, entry.after);
      if (this.dirty.size > 500) {
        this.write(target, entry.before);
        throw new Error('单次页面修改超过 500 项，请缩小范围');
      }
      this.record([entry]);
    }
    batch(action) {
      const previous = this.transaction, entries = [];
      this.transaction = entries;
      try { action(); }
      catch (error) { for (const entry of entries.reverse()) this.write(entry.target, entry.before); throw error; }
      finally { this.transaction = previous; }
      this.record(entries);
    }
    field(collectionPointer, fieldKey) {
      const field = this.collections.get(collectionPointer)?.fields.get(fieldKey)?.value;
      if (!field?.editable) throw new Error('字段不可编辑或身份已变化');
      return field;
    }
    property(collectionPointer, fieldKey, name, value) {
      this.field(collectionPointer, fieldKey);
      const target = this.collections.get(collectionPointer).fields.get(fieldKey).properties.get(name);
      if (!target) throw new Error('属性不可编辑');
      this.change(target, value);
    }
    text(key, value) {
      const target = this.nodes.get(key);
      if (!target?.object.editable || typeof value !== 'string') throw new Error('脚本节点不可编辑');
      this.change(target, value);
    }
    order(pointer, keys) {
      const collection = this.collections.get(pointer);
      if (!collection?.value.reorderable || !Array.isArray(keys) || keys.length !== collection.fields.size
        || new Set(keys).size !== keys.length || keys.some(key => !collection.fields.has(key))) throw new Error('拖拽只能调整同一支持容器内的顺序');
      this.change(collection.order, keys);
    }
    undo() {
      if (!this.past.length) return;
      const entries = this.past.pop();
      for (const entry of [...entries].reverse()) this.write(entry.target, entry.before);
      this.future.push(entries); this.version++;
    }
    redo() {
      if (!this.future.length) return;
      const entries = this.future.pop();
      for (const entry of entries) this.write(entry.target, entry.after);
      this.past.push(entries); this.version++;
    }
    operations() {
      return [...this.dirty].sort(([left], [right]) => left.rank - right.rank).map(([, operation]) => clone(operation));
    }
    restore(operations) {
      if (!Array.isArray(operations) || operations.length > 500) throw new Error('草稿格式或大小无效');
      for (const op of operations) {
        if (op.kind === 'property') this.property(op.collectionPointer, op.fieldKey, op.property, op.value);
        else if (op.kind === 'order') this.order(op.collectionPointer, op.fieldKeys);
        else if (op.kind === 'text') {
          const node = this.model.nodes.find(item => item.pointer === op.jsonPointer);
          this.text(node?.key, op.content);
        } else throw new Error('草稿包含未知操作');
      }
    }
  }
  return {PageDraft};
});

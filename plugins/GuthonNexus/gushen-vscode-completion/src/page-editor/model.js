/* Shared by the extension host and its Webview; no filesystem or script execution. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GuthonPageModel = factory();
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const clone = value => JSON.parse(JSON.stringify(value));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  class PageDraft {
    constructor(model) {
      this.baseline = clone(model); this.model = clone(model);
      this.version = 0; this.past = []; this.future = [];
    }
    change(action) {
      const before = clone(this.model);
      try { action(); this.operations(); } catch (error) { this.model = before; throw error; }
      if (same(before, this.model)) return;
      this.past.push(before); if (this.past.length > 50) this.past.shift();
      this.future = []; this.version++;
    }
    batch(action) {
      const model = clone(this.model), past = [...this.past], future = [...this.future], version = this.version;
      try { action(); }
      catch (error) { Object.assign(this, {model, past, future, version}); throw error; }
      if (!same(model, this.model)) {
        this.past = [...past, model].slice(-50); this.future = []; this.version = version + 1;
      }
    }
    field(collectionPointer, fieldKey) {
      const collection = this.model.collections.find(item => item.pointer === collectionPointer);
      const field = collection?.fields.find(item => item.key === fieldKey);
      if (!field?.editable) throw new Error('字段不可编辑或身份已变化');
      return field;
    }
    property(collectionPointer, fieldKey, name, value) {
      this.change(() => {
        const prop = this.field(collectionPointer, fieldKey).properties.find(item => item.name === name);
        if (!prop) throw new Error('属性不可编辑');
        prop.value = value;
      });
    }
    text(key, value) {
      this.change(() => {
        const node = this.model.nodes.find(item => item.key === key);
        if (!node?.editable || typeof value !== 'string') throw new Error('脚本节点不可编辑');
        node.content = value;
      });
    }
    order(pointer, keys) {
      this.change(() => {
        const collection = this.model.collections.find(item => item.pointer === pointer);
        const fields = new Map((collection?.fields || []).map(item => [item.key, item]));
        if (!collection?.reorderable || !Array.isArray(keys) || keys.length !== fields.size
          || new Set(keys).size !== fields.size || keys.some(key => !fields.has(key))) throw new Error('拖拽只能调整同一支持容器内的顺序');
        collection.fields = keys.map(key => fields.get(key));
      });
    }
    undo() {
      if (!this.past.length) return;
      this.future.push(this.model); this.model = this.past.pop(); this.version++;
    }
    redo() {
      if (!this.future.length) return;
      this.past.push(this.model); this.model = this.future.pop(); this.version++;
    }
    operations() {
      const result = [];
      for (const original of this.baseline.collections) {
        const collection = this.model.collections.find(item => item.pointer === original.pointer);
        for (const before of original.fields) {
          const field = collection.fields.find(item => item.key === before.key);
          for (const prop of before.properties) {
            const value = field.properties.find(item => item.name === prop.name).value;
            if (!same(value, prop.value)) result.push({kind: 'property', collectionPointer: collection.pointer,
              fieldKey: field.key, property: prop.name, value});
          }
        }
        const fieldKeys = collection.fields.map(item => item.key);
        if (!same(fieldKeys, original.fields.map(item => item.key))) result.push({kind: 'order', collectionPointer: collection.pointer, fieldKeys});
      }
      for (const before of this.baseline.nodes) {
        const node = this.model.nodes.find(item => item.key === before.key);
        if (node.content !== before.content) result.push({kind: 'text', jsonPointer: before.pointer, content: node.content});
      }
      if (result.length > 500) throw new Error('单次页面修改超过 500 项，请缩小范围');
      return result;
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

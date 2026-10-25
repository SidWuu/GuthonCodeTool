/* Baseline-bound PAGE messages shared by the host and Webview. */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model'));
  else root.GuthonPageState = factory(root.GuthonPageModel);
})(typeof globalThis === 'object' ? globalThis : this, ({PageDraft}) => {
  const key = operation => JSON.stringify([operation.kind, operation.collectionPointer || operation.jsonPointer,
    operation.fieldKey || '', operation.property || '']);
  class PageStateReceiver {
    receive(message) {
      if (this.state && message.sequence <= this.state.sequence) return {state: this.state, changes: [], full: false, ignored: true};
      if (message.update === 'full') {
        this.draft = new PageDraft(message.baseline); this.operations = new Map();
      } else if (!this.state || message.baseSequence !== this.state.sequence) return null;
      const changes = [];
      if (message.operations) {
        const next = new Map(message.operations.map(operation => [key(operation), operation]));
        for (const [identity, operation] of this.operations) if (!next.has(identity)) {
          if (operation.kind === 'text') changes.push({...operation,
            content: this.draft.baseline.nodes.find(node => node.pointer === operation.jsonPointer).content});
          else {
            const collection = this.draft.baseline.collections.find(item => item.pointer === operation.collectionPointer);
            changes.push(operation.kind === 'order' ? {...operation, fieldKeys: collection.fields.map(field => field.key)}
              : {...operation, value: collection.fields.find(field => field.key === operation.fieldKey).properties.find(prop => prop.name === operation.property).value});
          }
        }
        for (const [identity, operation] of next) if (JSON.stringify(operation) !== JSON.stringify(this.operations.get(identity))) changes.push(operation);
        this.draft.batch(() => { for (const operation of changes) this.draft.restore([operation]); });
        // Undo belongs to the host; this replica only reconstructs the current view.
        this.draft.past = []; this.draft.future = []; this.operations = next;
      }
      this.draft.model.pageName = this.draft.baseline.pageName = message.pageName;
      this.state = {...this.state, ...message, model: this.draft.model, baseline: this.draft.baseline,
        comparison: {...this.state?.comparison, ...message.comparison},
        operations: [...this.operations.values()]};
      return {state: this.state, changes, full: message.update === 'full'};
    }
  }
  return {PageStateReceiver};
});

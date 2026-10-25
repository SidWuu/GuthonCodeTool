const {setTimeout: delay} = require('node:timers/promises');

function quickPickFixture() {
  const handlers = new Map();
  const picker = {items: [], selectedItems: [], value: '', busy: false, disposed: false,
    show() { this.shown = true; }, dispose() { this.disposed = true; }};
  for (const event of ['ChangeValue', 'Accept', 'TriggerItemButton', 'Hide']) {
    handlers.set(event, new Set());
    picker['onDid' + event] = listener => {
      handlers.get(event).add(listener);
      return {dispose: () => handlers.get(event).delete(listener)};
    };
  }
  const emit = (event, value) => { for (const listener of handlers.get(event)) listener(value); };
  return {
    picker,
    vscode: {ThemeIcon: class {constructor(id) {this.id = id;}}, window: {createQuickPick: () => picker}},
    input(value) { picker.value = value; emit('ChangeValue', value); },
    accept(index = 0) { picker.selectedItems = picker.items[index] ? [picker.items[index]] : []; emit('Accept'); },
    button(index, action) { const item = picker.items[index]; emit('TriggerItemButton', {item, button: item.buttons.find(button => button.action === action)}); },
    hide() { emit('Hide'); },
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for Quick Pick state');
    await delay(2);
  }
}

module.exports = {quickPickFixture, waitFor};

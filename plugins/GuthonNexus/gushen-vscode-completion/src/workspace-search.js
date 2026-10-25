const {searchPickItems} = require('./workspace-assistant');

function showWorkspaceSearch({vscode, title, search, value = '', sourceOnly = false,
  defaultAction = 'open', debounceMs = 200}) {
  const picker = vscode.window.createQuickPick();
  const hint = sourceOnly ? '输入名称、路径、ID 或函数关键词；回车打开源码'
    : '输入源码名称、ID、函数或事实关键词；回车打开，右侧按钮生成 AI 上下文';
  const buttons = defaultAction === 'open' && !sourceOnly ? [
    {iconPath: new vscode.ThemeIcon('copy'), tooltip: '复制精简 AI 上下文', action: 'context'},
    {iconPath: new vscode.ThemeIcon('list-tree'), tooltip: '复制详细 AI 上下文', action: 'context-detailed'},
    {iconPath: new vscode.ThemeIcon('export'), tooltip: '导出 AI 上下文文件', action: 'context-file'},
  ] : [];
  picker.title = title;
  picker.placeholder = hint;
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.value = value;

  return new Promise(resolve => {
    let closed = false, timer, running = false, requested, generation = 0, readyGeneration = -1, failed = false;
    const subscriptions = [];
    function finish(result) {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      subscriptions.forEach(subscription => subscription.dispose());
      picker.dispose();
      resolve(result);
    }
    async function run() {
      if (closed || running || !requested) return;
      const request = requested;
      requested = undefined;
      running = true;
      try {
        const result = await search(request.query);
        if (closed || generation !== request.generation) return;
        const items = sourceOnly ? (result.items || []).filter(item => item.kind === 'source') : result.items;
        // The backend matches indexed identities and evidence, which may not occur in a row's display text.
        picker.items = searchPickItems({items}).map(item => ({...item, alwaysShow: true, buttons}));
        picker.title = `${title} · ${picker.items.length} 条结果${result.truncated ? ' · 结果已截断，请细化关键词' : ''}`;
        picker.placeholder = picker.items.length ? hint : '未找到本地索引结果，请调整关键词或检查工作区索引';
        readyGeneration = request.generation;
      } catch (error) {
        if (closed || generation !== request.generation) return;
        failed = true;
        picker.title = `${title} · 搜索失败`;
        picker.placeholder = `${error.message}；回车重试，或修改关键词`;
      } finally {
        running = false;
        if (!closed) {
          if (generation === request.generation) picker.busy = false;
          if (requested && timer === undefined) void run();
        }
      }
    }
    function schedule(input, delay = debounceMs) {
      clearTimeout(timer);
      timer = undefined;
      generation++;
      failed = false;
      readyGeneration = -1;
      picker.items = [];
      picker.title = title;
      picker.placeholder = hint;
      const query = input.trim();
      requested = query ? {query, generation} : undefined;
      picker.busy = Boolean(query);
      if (requested) timer = setTimeout(() => { timer = undefined; void run(); }, delay);
    }
    function choose(row, action) {
      if (closed || picker.busy || readyGeneration !== generation || !picker.items.includes(row)) return;
      finish({item: row.item, action});
    }
    subscriptions.push(
      picker.onDidChangeValue(input => schedule(input)),
      picker.onDidAccept(() => {
        if (failed) schedule(picker.value, 0);
        else choose(picker.selectedItems[0], defaultAction);
      }),
      picker.onDidTriggerItemButton(event => {
        if (buttons.includes(event.button)) choose(event.item, event.button.action);
      }),
      picker.onDidHide(() => finish(undefined))
    );
    picker.show();
    if (value.trim()) schedule(value, 0);
  });
}

module.exports = {showWorkspaceSearch};

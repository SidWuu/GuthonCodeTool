const {searchPickItems} = require('./workspace-assistant');
const {MODULE_STYLES, SOURCE_CATEGORIES} = require('./source/tree-styles');

const commonTypes = ['page', 'procedure', 'table', 'view', 'system-script'];
const sourceTypesByMode = {
  api: [...commonTypes, 'module-parameter', 'bill-type', 'dropdown', 'skill', 'public'],
  svn: [...commonTypes, 'skill', 'public'],
  database: [...commonTypes, 'bill-type'],
};

function showWorkspaceSearch({vscode, title, search, value = '', sourceOnly = false,
  sourceMode, defaultAction = 'open', debounceMs = 200}) {
  const picker = vscode.window.createQuickPick();
  const types = sourceTypesByMode[sourceMode];
  const typeItems = types && [{label: '全部类型', sourceType: ''}, ...types.map(sourceType => ({
    label: MODULE_STYLES[SOURCE_CATEGORIES[sourceType]].label, sourceType,
  }))];
  let selectedType = typeItems?.[0], filterButton, selectingType = false;
  const searchTitle = () => selectedType ? `${title} · ${selectedType.label}` : title;
  function updateFilterButton() {
    filterButton = {iconPath: new vscode.ThemeIcon('filter'), tooltip: `筛选源码类型（当前：${selectedType.label}）`};
    picker.buttons = [filterButton];
  }
  if (typeItems) updateFilterButton();
  const hint = sourceOnly ? '输入名称、路径、ID 或函数关键词；回车打开源码'
    : '输入源码名称、ID、函数或事实关键词；回车打开，右侧按钮生成 AI 上下文';
  const buttons = defaultAction === 'open' && !sourceOnly ? [
    {iconPath: new vscode.ThemeIcon('copy'), tooltip: '复制精简 AI 上下文', action: 'context'},
    {iconPath: new vscode.ThemeIcon('list-tree'), tooltip: '复制详细 AI 上下文', action: 'context-detailed'},
    {iconPath: new vscode.ThemeIcon('export'), tooltip: '导出 AI 上下文文件', action: 'context-file'},
  ] : [];
  picker.title = searchTitle();
  picker.placeholder = hint;
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.value = value;

  return new Promise(resolve => {
    const moreItem = {label: '$(chevron-down) 加载更多结果', alwaysShow: true};
    let closed = false, timer, running = false, requested, generation = 0, readyGeneration = -1, failed = false;
    let nextPage;
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
        const result = await search(request.query, request.offset, request.sourceType);
        if (closed || generation !== request.generation) return;
        if (request.offset && result.indexGeneration !== request.indexGeneration) {
          throw new Error('搜索期间索引已变化，请重新查询');
        }
        const {nextOffset, indexGeneration} = result;
        if (nextOffset != null && (!Number.isInteger(nextOffset) || nextOffset <= request.offset || !indexGeneration)) {
          throw new Error('搜索分页无效');
        }
        const items = sourceOnly ? (result.items || []).filter(item => item.kind === 'source') : result.items;
        // The backend matches indexed identities and evidence, which may not occur in a row's display text.
        const rows = searchPickItems({items}).map(item => ({...item, alwaysShow: true, buttons}));
        const loaded = request.offset ? [...picker.items.filter(row => row !== moreItem), ...rows] : rows;
        nextPage = nextOffset == null ? undefined : {...request, offset: nextOffset, indexGeneration};
        picker.sortByLabel = !request.offset && !nextPage;
        picker.items = nextPage ? [...loaded, moreItem] : loaded;
        if (request.offset && rows.length) picker.activeItems = [rows[0]];
        picker.title = `${searchTitle()} · ${loaded.length} 条结果${nextPage ? ' · 还有更多' : ''}${result.truncated ? ' · 结果已截断，请细化关键词' : ''}`;
        picker.placeholder = loaded.length || nextPage ? hint : '未找到本地索引结果，请调整关键词或检查工作区索引';
        readyGeneration = request.generation;
      } catch (error) {
        if (closed || generation !== request.generation) return;
        failed = true;
        picker.title = `${searchTitle()} · 搜索失败`;
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
      nextPage = undefined;
      picker.items = [];
      picker.title = searchTitle();
      picker.placeholder = hint;
      const query = input.trim();
      requested = query ? {query, generation, offset: 0, sourceType: selectedType?.sourceType} : undefined;
      picker.busy = Boolean(query);
      if (requested) timer = setTimeout(() => { timer = undefined; void run(); }, delay);
    }
    if (typeItems) subscriptions.push(picker.onDidTriggerButton(async button => {
      if (closed || selectingType || button !== filterButton) return;
      // Opening the type picker temporarily hides the search picker.
      selectingType = true;
      try {
        const selected = await vscode.window.showQuickPick(typeItems.map(type => ({
          ...type, description: type.sourceType === selectedType.sourceType ? '当前类型' : undefined,
        })), {title: '筛选源码类型'});
        if (selected && selected.sourceType !== selectedType.sourceType) {
          selectedType = selected;
          updateFilterButton();
          schedule(picker.value, 0);
        }
      } finally {
        selectingType = false;
        picker.show();
      }
    }));
    function choose(row, action) {
      if (closed || selectingType || picker.busy || readyGeneration !== generation || !picker.items.includes(row)) return;
      if (row === moreItem) {
        requested = nextPage;
        picker.busy = true;
        void run();
        return;
      }
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
      picker.onDidHide(() => { if (!selectingType) finish(undefined); })
    );
    picker.show();
    if (value.trim()) schedule(value, 0);
  });
}

module.exports = {showWorkspaceSearch};

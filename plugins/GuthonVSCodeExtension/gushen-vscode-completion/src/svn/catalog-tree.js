const CATEGORY_LABELS = {
  pages: '页面',
  procedures: '过程函数',
  'system-script': '系统脚本',
  tables: '表',
  views: '视图',
  skill: 'Skill',
  public: 'Public',
};

const CATEGORY_ICONS = {
  pages: 'layout',
  procedures: 'symbol-method',
  'system-script': 'terminal',
  tables: 'table',
  views: 'eye',
  skill: 'book',
  public: 'folder-library',
};

const SOURCE_ICONS = {
  page: 'preview',
  procedure: 'symbol-method',
  'system-script': 'terminal',
  table: 'table',
  view: 'eye',
  skill: 'book',
  public: 'file-code',
};

function groupCatalog(objects) {
  const grouped = new Map();
  for (const object of objects || []) {
    const category = {
      page: 'pages',
      procedure: 'procedures',
      'system-script': 'system-script',
      skill: 'skill',
      public: 'public',
    }[object.sourceType] || `${object.sourceType}s`;
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category).push(object);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => (CATEGORY_LABELS[left] || left).localeCompare(CATEGORY_LABELS[right] || right, 'zh-CN'))
    .map(([category, items]) => ({
      kind: 'category',
      category,
      label: CATEGORY_LABELS[category] || category,
      count: items.length,
      children: buildSourceTree(items),
    }));
}

function objectLabel(object) {
  if (object.treeLabel) return String(object.treeLabel);
  if (object.sourceType === 'procedure') {
    return `${object.funId || object.sourceId || ''} ${object.sourceAliasId || ''}`.trim()
      || '未命名过程函数';
  }
  if (object.sourceType === 'table' || object.sourceType === 'view') {
    return object.sourceName && object.sourceName !== object.sourceId
      ? `${object.sourceId} ${object.sourceName}`
      : String(object.sourceId || object.sourceName || '未命名源码');
  }
  const identity = object.funId
    ? `${object.sourceAliasId}.${object.funId}`
    : object.sourceAliasId || object.sourceId;
  const label = object.sourceName && object.sourceName !== identity
    ? `${object.sourceName}  ${identity}`
    : identity;
  return String(label || '未命名源码');
}

function compareSortOrder(leftOrder, rightOrder) {
  const normalizedLeft = Array.isArray(leftOrder) ? leftOrder : null;
  const normalizedRight = Array.isArray(rightOrder) ? rightOrder : null;
  if (normalizedLeft && normalizedRight) {
    const length = Math.max(normalizedLeft.length, normalizedRight.length);
    for (let index = 0; index < length; index += 1) {
      const difference = (normalizedLeft[index] ?? Number.MAX_SAFE_INTEGER)
        - (normalizedRight[index] ?? Number.MAX_SAFE_INTEGER);
      if (difference) return difference;
    }
  } else if (normalizedLeft || normalizedRight) {
    return normalizedLeft ? -1 : 1;
  }
  return 0;
}

function compareTreeOrder(left, right) {
  const orderDifference = compareSortOrder(left?.sortOrder, right?.sortOrder);
  if (orderDifference) return orderDifference;
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
  return String(left?.label || '').localeCompare(String(right?.label || ''), 'zh-CN');
}

function earlierTreeOrder(left, right) {
  if (!Array.isArray(left)) return right;
  if (!Array.isArray(right)) return left;
  return compareSortOrder(left, right) <= 0 ? left : right;
}

function buildSourceTree(objects) {
  const root = { children: [], directories: new Map() };
  for (const object of objects || []) {
    let parent = root;
    for (const rawSegment of object.treePath || []) {
      const segment = String(rawSegment || '').trim();
      if (!segment) continue;
      let directory = parent.directories.get(segment);
      if (!directory) {
        directory = {
          kind: 'directory', label: segment, children: [], directories: new Map(), sortOrder: undefined,
        };
        parent.directories.set(segment, directory);
        parent.children.push(directory);
      }
      parent = directory;
    }
    parent.children.push({
      kind: 'source', label: objectLabel(object), object, sortOrder: object.treeOrder,
    });
  }
  const finalize = (node) => {
    for (const child of node.children) {
      if (child.kind === 'directory') {
        finalize(child);
        delete child.directories;
      }
      node.sortOrder = earlierTreeOrder(node.sortOrder, child.sortOrder);
    }
    node.children.sort(compareTreeOrder);
  };
  finalize(root);
  return root.children;
}

function fragmentLabel(fragment) {
  const typeLabel = {
    js: 'JS',
    gss: 'GSS',
    vm: 'GSS',
    sql: 'SQL',
    fields: '字段',
  }[fragment.scriptType] || fragment.scriptType || '源码';
  if (fragment.label) return `${typeLabel} · ${fragment.label}`;
  const pointer = fragment.jsonPointer || '';
  const tail = pointer.split('/').filter(Boolean).at(-1);
  return tail ? `${typeLabel} · ${tail}` : typeLabel;
}

class SvnCatalogTreeProvider {
  constructor({ vscode, backend, listSvnWorkspaces }) {
    this.vscode = vscode;
    this.backend = backend;
    this.listSvnWorkspaces = listSvnWorkspaces;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.decorationChanged = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this.decorationChanged.event;
    this.catalogs = new Map();
    this.workspaceNodes = null;
    this.objectElements = new Map();
    this.sourcePathElements = new Map();
    this.changeStates = new Map();
    this.decorationElements = new Map();
  }

  setStatus(workspaceKey, status) {
    this.changeStates.set(
      workspaceKey,
      new Map((status?.changes || []).map((change) => [change.path, change.state || 'EXTERNAL_MODIFIED']))
    );
    this.changed.fire();
    this.decorationChanged.fire();
  }

  refresh(workspaceKey) {
    if (workspaceKey) this.catalogs.delete(workspaceKey);
    else this.catalogs.clear();
    if (workspaceKey) this.changeStates.delete(workspaceKey);
    else this.changeStates.clear();
    this.workspaceNodes = null;
    this.objectElements.clear();
    this.sourcePathElements.clear();
    this.decorationElements.clear();
    this.changed.fire();
  }

  _objectKey(workspaceKey, object) {
    return JSON.stringify([
      workspaceKey,
      object.sourceType,
      object.sourceId,
      object.funId || '',
    ]);
  }

  _sourceElement(child, parent, workspaceKey) {
    const object = child.object;
    const fragments = object.fragments;
    const opensReadOnlyMetadata = Array.isArray(fragments) && fragments.length === 0
      && ['table', 'view', 'skill', 'public'].includes(object.sourceType);
    const opensDirectly = Array.isArray(fragments)
      && (fragments.length === 1 || opensReadOnlyMetadata);
    const identity = {
      workspaceKey,
      sourceType: object.sourceType,
      sourceId: object.sourceId,
      funId: object.funId || '',
      jsonPointer: fragments?.[0]?.jsonPointer || '',
      fragmentType: fragments?.[0]?.scriptType || '',
    };
    const element = {
      kind: opensDirectly ? 'document' : 'object',
      label: child.label,
      description: object.status === 'OK' ? undefined : object.status,
      tooltip: `${object.sourcePath}\n${workspaceKey}`,
      icon: SOURCE_ICONS[object.sourceType] || 'file-code',
      object,
      workspaceKey,
      parent,
      command: opensDirectly
        ? { command: 'gushenCompletion.openSvnDocument', title: '打开 SVN 源码', arguments: [identity] }
        : undefined,
    };
    this.objectElements.set(this._objectKey(workspaceKey, object), element);
    this.sourcePathElements.set(`${workspaceKey}\n${object.sourcePath}`, element);
    return element;
  }

  _elementState(element) {
    if (!element) return '';
    if (element.kind === 'fragment') {
      const state = element.fragment?.status;
      return state && state !== 'OK' ? state : '';
    }
    const sourcePath = element.object?.sourcePath;
    if (sourcePath) return this.changeStates.get(element.workspaceKey)?.get(sourcePath) || '';
    const children = element.children || [];
    const states = children.map((child) => this._elementState(child)).filter(Boolean);
    if (states.includes('CONFLICT')) return 'CONFLICT';
    if (states.includes('UNTRACKED')) return 'UNTRACKED';
    return states[0] || '';
  }

  _treeUri(element) {
    const segments = [];
    let current = element;
    while (current) {
      segments.push(current.object?.sourcePath || current.label || current.kind);
      current = current.parent;
    }
    const uri = this.vscode.Uri.from({
      scheme: 'guthon-svn-tree',
      authority: element.workspaceKey || element.workspace?.workspaceKey || '',
      path: `/${segments.reverse().map((value) => encodeURIComponent(String(value))).join('/')}`,
    });
    this.decorationElements.set(uri.toString(), element);
    return uri;
  }

  provideFileDecoration(uri) {
    const element = this.decorationElements.get(uri.toString());
    const state = this._elementState(element);
    if (!state) return undefined;
    const conflict = state === 'CONFLICT';
    const untracked = state === 'UNTRACKED';
    return new this.vscode.FileDecoration(
      conflict ? '!' : untracked ? '?' : 'M',
      conflict ? 'SVN 冲突' : untracked ? 'SVN 未跟踪' : 'SVN 本地修改',
      new this.vscode.ThemeColor(
        conflict
          ? 'gitDecoration.conflictingResourceForeground'
          : untracked
            ? 'gitDecoration.untrackedResourceForeground'
            : 'gitDecoration.modifiedResourceForeground'
      )
    );
  }

  _decorateChildren(children, parent, workspaceKey) {
    return children.map((child) => {
      if (child.kind === 'directory') {
        const directory = {
          ...child,
          workspaceKey,
          tooltip: child.label,
          icon: 'folder',
          parent,
        };
        directory.children = this._decorateChildren(child.children, directory, workspaceKey);
        return directory;
      }
      return this._sourceElement(child, parent, workspaceKey);
    });
  }

  async _workspaceChildren(element) {
    if (element.children) return element.children;
    let catalog = this.catalogs.get(element.workspace.workspaceKey);
    if (!catalog) {
      catalog = await this.backend.catalog(element.workspace.workspaceKey);
      this.catalogs.set(element.workspace.workspaceKey, catalog);
    }
    element.children = groupCatalog(catalog.objects).map((category) => {
      const categoryElement = {
        ...category,
        workspaceKey: element.workspace.workspaceKey,
        description: String(category.count),
        icon: CATEGORY_ICONS[category.category] || 'folder',
        parent: element,
      };
      categoryElement.children = this._decorateChildren(
        category.children,
        categoryElement,
        element.workspace.workspaceKey
      );
      return categoryElement;
    });
    return element.children;
  }

  getTreeItem(element) {
    const collapsible = ['document', 'fragment', 'message'].includes(element.kind)
      ? this.vscode.TreeItemCollapsibleState.None
      : this.vscode.TreeItemCollapsibleState.Collapsed;
    const item = new this.vscode.TreeItem(element.label, collapsible);
    item.description = element.description;
    item.tooltip = element.tooltip;
    item.iconPath = new this.vscode.ThemeIcon(element.icon || 'file-code');
    item.resourceUri = this._treeUri(element);
    if (['document', 'object', 'fragment'].includes(element.kind)) item.contextValue = 'guthonSvnSource';
    if (element.command) item.command = element.command;
    return item;
  }

  getParent(element) {
    return element.parent;
  }

  async getChildren(element) {
    if (!element) {
      if (this.workspaceNodes) return this.workspaceNodes;
      const workspaces = await this.listSvnWorkspaces();
      this.workspaceNodes = workspaces.map((workspace) => ({
        kind: 'workspace',
        label: workspace.displayName,
        description: workspace.workspaceKey,
        workspace,
        icon: 'repo',
      }));
      return this.workspaceNodes;
    }
    if (element.kind === 'workspace') {
      return this._workspaceChildren(element);
    }
    if (element.kind === 'category' || element.kind === 'directory') {
      if (element.children.some((child) => child.kind === 'source')) {
        element.children = this._decorateChildren(element.children, element, element.workspaceKey);
      }
      return element.children;
    }
    if (element.kind === 'object') {
      if (element.children) return element.children;
      if (!Array.isArray(element.object.fragments)) {
        const result = await this.backend.fragments(element.workspaceKey, {
          sourceType: element.object.sourceType,
          sourceId: element.object.sourceId,
          funId: element.object.funId || '',
        });
        element.object.fragments = result.fragments || [];
      }
      const fragments = element.object.fragments;
      if (!fragments.length) {
        element.children = [{
          kind: 'message',
          label: '无受控分块（原文件可在资源管理器查看）',
          icon: 'info',
          parent: element,
        }];
        return element.children;
      }
      element.children = fragments.map((fragment) => ({
        kind: 'fragment',
        label: fragmentLabel(fragment),
        tooltip: fragment.jsonPointer || fragment.label,
        icon: fragment.scriptType === 'sql'
          ? 'database'
          : fragment.scriptType === 'fields'
            ? 'symbol-field'
            : ['gss', 'vm'].includes(fragment.scriptType)
              ? 'symbol-method'
              : 'symbol-event',
        parent: element,
        workspaceKey: element.workspaceKey,
        fragment,
        command: {
          command: 'gushenCompletion.openSvnDocument',
          title: '打开 SVN 源码分块',
          arguments: [{
            workspaceKey: element.workspaceKey,
            sourceType: element.object.sourceType,
            sourceId: element.object.sourceId,
            funId: element.object.funId || '',
            jsonPointer: fragment.jsonPointer || '',
            fragmentType: fragment.scriptType || '',
          }],
        },
      }));
      return element.children;
    }
    return [];
  }

  async locate(identity) {
    const workspaces = await this.getChildren();
    const workspace = workspaces.find((item) => item.workspace.workspaceKey === identity.workspaceKey);
    if (!workspace) return undefined;
    await this.getChildren(workspace);
    const source = identity.sourcePath
      ? this.sourcePathElements.get(`${identity.workspaceKey}\n${identity.sourcePath}`)
      : this.objectElements.get(this._objectKey(identity.workspaceKey, identity));
    if (!source || !identity.jsonPointer || source.kind !== 'object') return source;
    const fragments = await this.getChildren(source);
    return fragments.find((item) => item.fragment?.jsonPointer === identity.jsonPointer) || source;
  }

  dispose() {
    this.changed.dispose();
    this.decorationChanged.dispose();
    this.decorationElements.clear();
  }
}

module.exports = {
  buildSourceTree,
  compareTreeOrder,
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  SOURCE_ICONS,
  SvnCatalogTreeProvider,
  fragmentLabel,
  groupCatalog,
  objectLabel,
};

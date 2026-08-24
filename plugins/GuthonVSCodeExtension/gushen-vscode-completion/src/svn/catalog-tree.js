const CATEGORY_LABELS = {
  pages: '页面',
  procedures: '过程函数',
  'system-script': '系统脚本',
  tables: '表',
  views: '视图',
  skill: 'Skill',
  public: 'Public',
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
  if (object.treeLabel) return object.treeLabel;
  if (object.sourceType === 'procedure') {
    return `${object.funId || object.sourceId} ${object.sourceAliasId || ''}`.trim();
  }
  if (object.sourceType === 'table' || object.sourceType === 'view') {
    return object.sourceName && object.sourceName !== object.sourceId
      ? `${object.sourceId} ${object.sourceName}`
      : object.sourceId;
  }
  const identity = object.funId
    ? `${object.sourceAliasId}.${object.funId}`
    : object.sourceAliasId || object.sourceId;
  return object.sourceName && object.sourceName !== identity
    ? `${object.sourceName}  ${identity}`
    : identity;
}

function sortTreeNodes(left, right) {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
  return left.label.localeCompare(right.label, 'zh-CN');
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
        directory = { kind: 'directory', label: segment, children: [], directories: new Map() };
        parent.directories.set(segment, directory);
        parent.children.push(directory);
      }
      parent = directory;
    }
    parent.children.push({ kind: 'source', label: objectLabel(object), object });
  }
  const finalize = (node) => {
    for (const child of node.children) {
      if (child.kind === 'directory') {
        finalize(child);
        delete child.directories;
      }
    }
    node.children.sort(sortTreeNodes);
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
    this.catalogs = new Map();
    this.workspaceNodes = null;
    this.objectElements = new Map();
    this.sourcePathElements = new Map();
  }

  refresh(workspaceKey) {
    if (workspaceKey) this.catalogs.delete(workspaceKey);
    else this.catalogs.clear();
    this.workspaceNodes = null;
    this.objectElements.clear();
    this.sourcePathElements.clear();
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
      icon: object.sourceType === 'table' ? 'table' : object.sourceType === 'view' ? 'eye' : 'file-code',
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
        icon: category.category === 'pages'
          ? 'layout'
          : category.category === 'procedures'
            ? 'symbol-method'
            : 'folder',
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
  }
}

module.exports = {
  buildSourceTree,
  CATEGORY_LABELS,
  SvnCatalogTreeProvider,
  fragmentLabel,
  groupCatalog,
  objectLabel,
};

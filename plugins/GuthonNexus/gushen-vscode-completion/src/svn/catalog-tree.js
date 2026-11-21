const {fragmentIdentity} = require('./virtual-fs');
const {MODULE_STYLES,SOURCE_CATEGORIES,sourceTreeIcon,sourceTreeIdentity,datasourceTreeName,sourceGroupDatasourceId,compareDatasourceIds}=require('../source/tree-styles');

const FRAGMENT_TYPE_ORDER = {
  gss: 0,
  vm: 0,
  js: 1,
  sql: 2,
  fields: 3,
};

function compareFragmentType(left, right) {
  return (FRAGMENT_TYPE_ORDER[left?.scriptType] ?? Number.MAX_SAFE_INTEGER)
    - (FRAGMENT_TYPE_ORDER[right?.scriptType] ?? Number.MAX_SAFE_INTEGER);
}

function groupCatalog(objects, navigationGroups, byName) {
  const grouped = new Map();
  for (const object of objects || []) {
    const category = object.referenceCategory || SOURCE_CATEGORIES[object.sourceType] || 'public';
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category).push(object);
  }
  return Object.keys(MODULE_STYLES).filter(category=>grouped.has(category))
    .map(category => ({
      kind: 'category',
      category,
      label: MODULE_STYLES[category].label,
      count: grouped.get(category).length,
      children: buildSourceTree(grouped.get(category), category, navigationGroups, byName),
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
  const datasourceDifference=compareDatasourceIds(left.datasourceOrderId,right.datasourceOrderId);
  if(datasourceDifference)return datasourceDifference;
  if(left.code && right.code) {
    const difference=left.code.localeCompare(right.code,'en',{numeric:true});
    if(difference)return difference;
  }
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

function buildSourceTree(objects, category, navigationGroups, byName) {
  const root = { children: [], directories: new Map() };
  for (const object of objects || []) {
    let parent = root;
    for (const [depth,rawSegment] of (object.treePath || []).entries()) {
      const segment = String(rawSegment || '').trim();
      if (!segment) continue;
      const code=depth===0 && object.treeScopeId || '';
      const key=code || segment;
      let directory = parent.directories.get(key);
      if (!directory) {
        directory = {
          kind: 'directory', label: depth===0 && ['procedure','table','view'].includes(object.sourceType)?datasourceTreeName(segment):segment,
          code, datasourceOrderId: depth===0 && !byName ? sourceGroupDatasourceId(navigationGroups,category,code,segment) : undefined,
          children: [], directories: new Map(), sortOrder: undefined,
        };
        parent.directories.set(key, directory);
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
    node.children.sort(byName ? ((left,right)=>Number(right.kind==='directory')-Number(left.kind==='directory')
      || (left.object?.sourceName || left.label).localeCompare(right.object?.sourceName || right.label,'zh-CN')
      || compareTreeOrder(left,right)) : compareTreeOrder);
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
    json: 'JSON',
  }[fragment.scriptType] || fragment.scriptType || '源码';
  if (fragment.label) return `${typeLabel} · ${fragment.label}`;
  const pointer = fragment.jsonPointer || '';
  const tail = pointer.split('/').filter(Boolean).at(-1);
  return tail ? `${typeLabel} · ${tail}` : typeLabel;
}

function serviceComponentDocumentName(object) {
  if (object.sourceType !== 'page' || !String(object.sourcePath || '').toLowerCase().endsWith('.gss')) {
    return '';
  }
  const sourceName = String(object.sourceName || '').trim();
  return sourceName && sourceName !== String(object.sourceId || '')
    && sourceName !== String(object.funId || '')
    ? sourceName
    : '';
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

  refreshRoots() {
    this.workspaceNodes = null;
    this.changed.fire();
  }

  refresh(workspaceKey) {
    if (workspaceKey) this.catalogs.delete(workspaceKey);
    else this.catalogs.clear();
    if (workspaceKey) this.changeStates.delete(workspaceKey);
    else this.changeStates.clear();
    this.workspaceNodes = null;
    if (workspaceKey) {
      for (const key of this.objectElements.keys()) {
        if (JSON.parse(key)[0] === workspaceKey) this.objectElements.delete(key);
      }
      for (const key of this.sourcePathElements.keys()) {
        if (key.startsWith(`${workspaceKey}\n`)) this.sourcePathElements.delete(key);
      }
    } else {
      this.objectElements.clear();
      this.sourcePathElements.clear();
    }
    this.changed.fire();
    // VS Code can request a decoration for an existing TreeItem before the
    // refreshed tree has produced its replacement TreeItem. Keep the URI to
    // element mapping alive across that interval so a fresh SCM status can
    // still decorate the existing resource URI.
    this.decorationChanged.fire();
  }

  _objectKey(workspaceKey, object) {
    return JSON.stringify([
      workspaceKey,
      object.sourceType,
      object.sourceId,
      object.funId || '',
      object.workingCopyId || object.scopeEntryId || '',
    ]);
  }

  _sourceElement(child, parent, workspaceKey) {
    const object = child.object;
    const fragments = object.fragments;
    const localPage = object.sourceType === 'page' && /\.json$/i.test(object.sourcePath || '');
    const opensReadOnlyMetadata = Array.isArray(fragments) && fragments.length === 0
      && ['table', 'view', 'skill', 'public'].includes(object.sourceType);
    const opensDirectly = !localPage && !object.referenceCategory && Array.isArray(fragments)
      && (fragments.length === 1 || opensReadOnlyMetadata);
    const identity = fragmentIdentity(workspaceKey, object, fragments?.[0]);
    if (object.sourceType === 'public' || object.sourceType === 'skill') identity.documentName=object.sourceName;
    else if (object.sourceType !== 'page') identity.documentName=serviceComponentDocumentName(object);
    const element = {
      kind: opensDirectly ? 'document' : 'object',
      label: child.label,
      description: object.status === 'OK' ? undefined : object.status,
      tooltip: `${object.sourcePath}\n${workspaceKey}`,
      category: object.referenceCategory || SOURCE_CATEGORIES[object.sourceType],
      icon: object.sourceType === 'public' && !object.referenceCategory && /\.json$/i.test(object.sourcePath) ? 'json' : undefined,
      object,
      workspaceKey,
      parent,
      command: opensDirectly
        ? { command: 'gushenCompletion.openSvnDocument', title: '打开 SVN 源码', arguments: [identity] }
        : undefined,
    };
    if (localPage) element.command={command:'gushenCompletion.openLocalPageEditor',title:'打开本地页面编辑器',arguments:[{object,workspaceKey}]};
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
    // Keep old decorations during refresh, then release the old tree once its
    // replacement catalog is ready. Removed objects must not stay rooted forever.
    const workspaceKey = element.workspace.workspaceKey;
    for (const [key, cached] of this.decorationElements) {
      if ((cached.workspaceKey || cached.workspace?.workspaceKey) === workspaceKey) this.decorationElements.delete(key);
    }
    const byName=this.vscode.workspace.getConfiguration?.('gushenCompletion')?.get('sourceTreeOrder')==='name';
    element.children = groupCatalog(catalog.objects,catalog.navigationGroups,byName).map((category) => {
      const categoryElement = {
        ...category,
        workspaceKey: element.workspace.workspaceKey,
        description: String(category.count),
        parent: element,
      };
      if (['bill-type','dropdown'].includes(category.category)) {
        categoryElement.referenceFiles=catalog.objects.filter(object=>object.referenceCategory===category.category);
        categoryElement.datasourceNames=new Map(catalog.objects.filter(object=>object.treeScopeId &&
          ['procedure','table','view'].includes(object.sourceType) && object.treePath?.length)
          .map(object=>[object.treeScopeId,datasourceTreeName(object.treePath[0])]));
        categoryElement.byName=byName;
        categoryElement.description=undefined;
        categoryElement.children=undefined;
        return categoryElement;
      }
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
    const object=element.object;
    const name=object?.sourceName!==object?.sourceId ? object?.sourceName : '';
    const display=object && !['skill','public'].includes(object.sourceType) ?
      sourceTreeIdentity(name,object.funId || object.sourceId,element.label)
      : sourceTreeIdentity(element.label,element.code,element.label);
    const item = new this.vscode.TreeItem(display.label, collapsible);
    if(display.code)item.guthonCode=display.code;
    item.description = element.description;
    item.tooltip = element.tooltip;
    let owner=element;
    while(owner && !owner.category)owner=owner.parent;
    item.iconPath = sourceTreeIcon(this.vscode,owner?.category,element.icon);
    item.resourceUri = this._treeUri(element);
    if (['document', 'object', 'fragment'].includes(element.kind)) {
      item.contextValue = element.object?.sourceType === 'procedure'
        ? 'guthonSvnProcedure'
        : element.kind==='fragment' && element.parent?.object?.sourceType==='page' && element.fragment?.scriptType!=='fields'
          ? 'guthonSvnPageFragment'
        : element.object?.sourceType === 'page'
          && String(element.object?.sourcePath || '').toLowerCase().endsWith('.json')
          ? 'guthonSvnPage'
        : 'guthonSvnSource';
    }
    if(['category','directory'].includes(element.kind))item.contextValue='guthonSvnContainer';
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
    if(element.referenceFiles && !element.children) {
      if(!element.loading)element.loading=Promise.all(element.referenceFiles.map(async object=>{
        const result=await this.backend.fragments(element.workspaceKey,object);
        return result.fragments.map(fragment=>({object,fragment}));
      })).then(results=>{
        const compare=(a,b)=>a.localeCompare(b,'en',{numeric:true});
        const entries=results.flat().sort((left,right)=>compareDatasourceIds(left.fragment.dataSourceId,right.fragment.dataSourceId)
          || compare(left.fragment.code || '',right.fragment.code || '')
          || left.fragment.label.localeCompare(right.fragment.label,'zh-CN'));
        const groups=new Map(), children=[];
        for(const {object,fragment} of entries) {
          let parent=element;
          const id=fragment.dataSourceId;
          if(element.category==='bill-type' && id) {
            if(!groups.has(id)) {
              const group={kind:'directory',label:element.datasourceNames.get(id) || id,code:id,icon:'folder',
                workspaceKey:element.workspaceKey,parent:element,children:[]};
              groups.set(id,group);children.push(group);
            }
            parent=groups.get(id);
          }
          const row={kind:'fragment',label:fragment.label,code:fragment.code,icon:'json',
            tooltip:[object.sourcePath,fragment.code,fragment.jsonPointer].filter(Boolean).join(' · '),parent,
            workspaceKey:element.workspaceKey,fragment,command:{command:'gushenCompletion.openSvnDocument',
              title:'查看 SVN 参考条目',arguments:[{...fragmentIdentity(element.workspaceKey,object,fragment),documentName:fragment.label}]}};
          (parent===element?children:parent.children).push(row);
        }
        if(element.byName)children.sort((left,right)=>left.label.localeCompare(right.label,'zh-CN'));
        element.description=String(entries.length);
        return element.children=children.length?children:[{kind:'message',label:'没有可读取的参考条目',parent:element}];
      }).catch(error=>[{kind:'message',label:`读取参考条目失败：${error.message}`,parent:element}])
        .finally(()=>{element.loading=undefined;});
      return element.loading;
    }
    if (element.kind === 'category' || element.kind === 'directory') {
      if (element.children.some((child) => child.kind === 'source')) {
        element.children = this._decorateChildren(element.children, element, element.workspaceKey);
      }
      return element.children;
    }
    if (element.kind === 'object') {
      if (element.children) return element.children;
      const raw = element.object.referenceCategory ? [{
        kind:'document',label:'查看原始 JSON',icon:'json',parent:element,
        command:{command:'gushenCompletion.openSvnDocument',title:'查看原始 JSON',
          arguments:[{...fragmentIdentity(element.workspaceKey,element.object),documentName:element.object.sourceName}]},
      }] : [];
      if (!Array.isArray(element.object.fragments)) {
        const identity = {
          sourceType: element.object.sourceType,
          sourceId: element.object.sourceId,
          funId: element.object.funId || '',
        };
        const workingCopyId = element.object.workingCopyId || element.object.scopeEntryId || '';
        if (workingCopyId) identity.workingCopyId = workingCopyId;
        try {
          const result = await this.backend.fragments(element.workspaceKey, identity);
          element.object.fragments = result.fragments || [];
        } catch(error) {
          if(!raw.length)throw error;
          return [...raw,{kind:'message',label:`JSON 条目读取失败：${error.message}`,icon:'warning',parent:element}];
        }
      }
      const fragments = [...element.object.fragments].sort(compareFragmentType);
      if (!fragments.length) {
        if (raw.length) return element.children=raw;
        element.children = [{
          kind: 'message',
          label: '无受控分块（原文件可在资源管理器查看）',
          icon: 'info',
          parent: element,
        }];
        return element.children;
      }
      element.children = [...raw,...fragments.map((fragment) => ({
        kind: 'fragment',
        label: fragmentLabel(fragment),
        tooltip: fragment.jsonPointer || fragment.label,
        icon: fragment.scriptType === 'sql'
          ? 'database'
          : fragment.scriptType === 'fields'
            ? 'symbol-field'
            : fragment.scriptType === 'json' ? 'json'
            : ['gss', 'vm'].includes(fragment.scriptType)
              ? 'symbol-method'
              : 'symbol-event',
        parent: element,
        workspaceKey: element.workspaceKey,
        fragment,
        command: {
          command: 'gushenCompletion.openSvnDocument',
          title: '打开 SVN 源码分块',
          arguments: [{...fragmentIdentity(element.workspaceKey, element.object, fragment),
            ...(fragment.scriptType==='json' ? {documentName:fragment.label} : {})}],
        },
      }))];
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
  compareFragmentType,
  SvnCatalogTreeProvider,
  fragmentLabel,
  groupCatalog,
  objectLabel,
};

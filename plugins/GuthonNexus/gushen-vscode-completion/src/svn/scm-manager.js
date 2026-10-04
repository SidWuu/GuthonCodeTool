const CHANGE_STATES = {
  LOCAL_MODIFIED: { id: 'local', label: 'Nexus 修改', icon: 'edit' },
  EXTERNAL_MODIFIED: { id: 'external', label: '其他本地修改', icon: 'diff-modified' },
  CONFLICT: { id: 'conflict', label: '冲突/阻断', icon: 'warning' },
  UNTRACKED: { id: 'untracked', label: '未跟踪文件', icon: 'question' },
  REMOTE: { id: 'remote', label: '远程变更', icon: 'cloud-download' },
};
const LOCAL_STATES = Object.keys(CHANGE_STATES).filter((state) => state !== 'REMOTE');
const CHANGE_DIFF_STATUSES = {
  added: { id: 'ADDED', label: '新增', icon: 'diff-added' },
  unversioned: { id: 'ADDED', label: '新增', icon: 'diff-added' },
  deleted: { id: 'DELETED', label: '删除', icon: 'diff-removed' },
  modified: { id: 'MODIFIED', label: '修改', icon: 'diff-modified' },
};
const LEGACY_SCM_PROVIDER_PREFIX = 'guthon-svn-';
const SCM_PROVIDER_PREFIX = 'guthon-svn-v3-';
const VERSIONED_SCM_PROVIDER_PREFIX = /^guthon-svn-v\d+-/;

function sourceControlId(workspaceKey) {
  // VS Code persists SCM repository visibility by provider ID. Versioning the
  // ID performs a one-time migration for workspaces previously left hidden.
  return `${SCM_PROVIDER_PREFIX}${workspaceKey}`;
}

function workspaceKeyFromSourceControlId(value) {
  const id = String(value || '');
  const versionedPrefix = id.match(VERSIONED_SCM_PROVIDER_PREFIX)?.[0];
  if (versionedPrefix) return id.slice(versionedPrefix.length);
  if (id.startsWith(LEGACY_SCM_PROVIDER_PREFIX)) {
    return id.slice(LEGACY_SCM_PROVIDER_PREFIX.length);
  }
  return '';
}

function changeDiffStatus(change) {
  return CHANGE_DIFF_STATUSES[change?.item] || CHANGE_DIFF_STATUSES.modified;
}

function isTextConflict(change, state) {
  return state === 'CONFLICT' && (
    change?.conflictKind === 'text'
    || (!change?.conflictKind && change?.item === 'conflicted' && !change?.treeConflicted)
  );
}

function appendExtension(label, sourcePath) {
  const extension = String(sourcePath || '').match(/\.[A-Za-z0-9]+$/)?.[0] || '';
  return extension && !String(label).toLowerCase().endsWith(extension.toLowerCase())
    ? `${label}${extension}`
    : label;
}

function changeDisplayName(change) {
  const fallback = String(change.path || '').split('/').at(-1) || 'change';
  let label = String(change.treeLabel || change.sourceName || '').trim();
  if (/^(主页面|主页)$/.test(label)) {
    const owners = (change.treePath || []).slice(1).filter(Boolean);
    if (owners.length) label = `${owners.join(' · ')} · ${label}`;
  }
  if (!label && change.sourceType === 'procedure') {
    label = [change.funId, change.sourceName].filter(Boolean).join(' · ');
  }
  if (!label && ['table', 'view'].includes(change.sourceType)) {
    label = [change.sourceId, change.sourceName].filter((value, index, values) => (
      value && values.indexOf(value) === index
    )).join(' · ');
  }
  return appendExtension(label || fallback, change.path);
}

function changeDocumentName(change) {
  if (change.sourceType !== 'page' || !String(change.path || '').toLowerCase().endsWith('.gss')) {
    return '';
  }
  const sourceName = String(change.sourceName || '').trim();
  if (!sourceName || sourceName === change.sourceId || sourceName === change.funId) return '';
  return appendExtension(sourceName, change.path);
}

function changeUri(vscode, workspaceKey, change, state = '') {
  const params = new URLSearchParams({ path: change.path });
  if (state) params.set('state', state);
  for (const key of ['workingCopyId', 'sourceType', 'sourceId', 'funId', 'jsonPointer']) {
    if (change[key]) params.set(key, change[key]);
  }
  const documentName = changeDocumentName(change);
  if (documentName) params.set('documentName', documentName);
  const displayName = changeDisplayName(change).replace(/[\\/]+/g, ' · ');
  return vscode.Uri.from({
    scheme: 'guthon-svn-change',
    authority: workspaceKey,
    path: `/${displayName}`,
    query: params.toString(),
  });
}

class SvnScmManager {
  constructor({ vscode, backend, onStatusChanged, quickDiffProvider }) {
    this.vscode = vscode;
    this.backend = backend;
    this.onStatusChanged = onStatusChanged;
    this.quickDiffProvider = quickDiffProvider;
    this.providers = new Map();
  }

  _create(workspace) {
    // The same SCM provider serves physical checkout files and Nexus virtual
    // documents. A checkout root would suppress Quick Diff for guthon-svn-edit.
    const rootUri = undefined;
    const sourceControl = this.vscode.scm.createSourceControl(
      sourceControlId(workspace.workspaceKey),
      `${workspace.displayName} · 谷神 SVN 源码变更`,
      // Let the Quick Diff provider decide whether a document belongs to this
      // SVN workspace; virtual Nexus documents have no physical root URI.
      rootUri
    );
    const record = { workspace, sourceControl, groups: new Map(), status: undefined };
    this._configure(record, workspace);
    this.providers.set(workspace.workspaceKey, record);
    return record;
  }

  _configure(record, workspace) {
    record.workspace = workspace;
    this.quickDiffProvider?.setWorkspace?.(workspace);
    if (this.quickDiffProvider) record.sourceControl.quickDiffProvider = this.quickDiffProvider;
    record.sourceControl.guthonWorkspaceKey = workspace.workspaceKey;
    record.sourceControl.inputBox.placeholder = 'SVN 提交说明（可选）';
    record.sourceControl.acceptInputCommand = {
      command: 'gushenCompletion.saveSvnToGuthon',
      title: '保存到谷神',
      arguments: [workspace.workspaceKey],
    };
    this._syncGroups(record, workspace.sourceControlGroups || []);
  }

  _syncGroups(record, definitions, workingCopies = []) {
    const normalized = (definitions || []).filter((definition) => (
      definition?.id && definition?.label
    ));
    if (!normalized.length) {
      normalized.push({
        id: 'all',
        label: '全部源码',
        workingCopyIds: (workingCopies || []).map((item) => item.id).filter(Boolean),
      });
    }
    const expected = new Set(normalized.map((definition) => definition.id));
    for (const [groupId, group] of record.groups) {
      if (!expected.has(groupId)) {
        group.dispose?.();
        record.groups.delete(groupId);
      }
    }
    for (const definition of normalized) {
      let group = record.groups.get(definition.id);
      if (group && group.guthonLabel !== definition.label) {
        group.dispose?.();
        record.groups.delete(definition.id);
        group = undefined;
      }
      if (!group) {
        group = record.sourceControl.createResourceGroup(definition.id, definition.label);
        record.groups.set(definition.id, group);
      }
      group.guthonLabel = definition.label;
      group.guthonWorkspaceKey = record.workspace.workspaceKey;
      group.guthonWorkingCopyIds = [...(definition.workingCopyIds || [])];
      group.hideWhenEmpty = false;
      group.resourceStates ||= [];
    }
  }

  _groupForChange(record, change) {
    for (const group of record.groups.values()) {
      if (group.guthonWorkingCopyIds.includes(change.workingCopyId)) return group;
    }
    return record.groups.values().next().value;
  }

  ensure(workspace) {
    const existing = this.providers.get(workspace.workspaceKey);
    if (existing) {
      this._configure(existing, workspace);
      return existing;
    }
    return this._create(workspace);
  }

  _applyStatus(record, value, options = {}) {
    const previousRemote = record.status?.remoteChanges || [];
    const remoteChanges = value.remoteChecked ? (value.remoteChanges || []) : previousRemote;
    record.status = { ...value, remoteChanges };
    this._syncGroups(record, record.workspace.sourceControlGroups || [], value.workingCopies || []);
    const resources = new Map([...record.groups.values()].map((group) => [group, []]));
    const addChange = (change, state) => {
      const definition = CHANGE_STATES[state];
      const diffStatus = changeDiffStatus(change);
      const textConflict = isTextConflict(change, state);
      const canOpenNexus = !['CONFLICT', 'UNTRACKED'].includes(state)
        && change.item !== 'deleted'
        && change.sourceType
        && change.sourceId;
      const group = this._groupForChange(record, change);
      if (!group || !definition) return;
      const resourceUri = changeUri(this.vscode, record.workspace.workspaceKey, change, state);
      resources.get(group).push({
        resourceUri,
        command: textConflict
          ? {
            command: 'gushenCompletion.openSvnConflictMerge',
            title: '打开 SVN 三方合并',
            arguments: [resourceUri],
          }
          : {
            command: 'gushenCompletion.showSvnDiff',
            title: '查看 SVN 差异',
            arguments: [record.workspace.workspaceKey, change.path, state === 'REMOTE'],
          },
        contextValue: `guthonSvn.${state}${
          textConflict
            ? '.text'
            : canOpenNexus ? '.nexus' : ''
        }`,
        decorations: {
          iconPath: new this.vscode.ThemeIcon(
            ['CONFLICT', 'REMOTE'].includes(state) ? definition.icon : diffStatus.icon
          ),
          tooltip: `${definition.label} · ${diffStatus.label} · ${changeDisplayName(change)}\n${change.path}\n${change.workingCopyId}`,
          strikeThrough: state === 'CONFLICT',
          faded: state === 'UNTRACKED',
        },
      });
    };
    for (const state of LOCAL_STATES) {
      for (const change of value.groups?.[state] || []) addChange(change, state);
    }
    for (const change of remoteChanges) addChange(change, 'REMOTE');
    if (![...resources.values()].some((items) => items.length)) {
      const firstGroup = record.groups.values().next().value;
      if (firstGroup) {
        resources.get(firstGroup).push({
          resourceUri: this.vscode.Uri.from({
            scheme: 'guthon-svn-change',
            authority: record.workspace.workspaceKey,
            path: '/当前无变更',
            query: 'placeholder=clean',
          }),
          contextValue: 'guthonSvn.PLACEHOLDER',
          decorations: {
            iconPath: new this.vscode.ThemeIcon('check'),
            tooltip: '当前工作区没有本地或远端 SVN 变更；此占位项用于保持子系统可见',
            faded: true,
          },
        });
      }
    }
    for (const [group, resourceStates] of resources) group.resourceStates = resourceStates;
    record.sourceControl.count = (value.changes?.length || 0) + remoteChanges.length;
    this.quickDiffProvider?.setStatus?.(record.workspace.workspaceKey, record.status);
    this.onStatusChanged?.(record.workspace.workspaceKey, record.status);
    return record.status;
  }

  async _refresh(workspace, remote, options) {
    const record=this.ensure(workspace);
    const key=JSON.stringify([workspace.workspaceKey,remote,options]);
    record.inFlight ||= new Map();
    if(record.inFlight.has(key))return record.inFlight.get(key);
    const generation=(record.statusRequest||0)+1;record.statusRequest=generation;
    const pending=(async()=>{
      let value=await this.backend.scmStatus(workspace.workspaceKey,remote,options);
      if((options.workingCopyIds||[]).length){
        // Scope controls remote IO, not the freshness of the local SCM snapshot.
        const local=await this.backend.scmStatus(workspace.workspaceKey,false,{});
        value={...local,remoteChecked:value.remoteChecked,remoteChanges:value.remoteChanges};
      }
      if(this.providers.get(workspace.workspaceKey)!==record || record.statusRequest!==generation)return record.status;
      return this._applyStatus(record,value);
    })().finally(()=>record.inFlight.delete(key));
    record.inFlight.set(key,pending);return pending;
  }

  refresh(workspace, options = {}) { return this._refresh(workspace,false,options); }
  refreshRemote(workspace, options = {}) { return this._refresh(workspace,true,options); }

  async refreshAll(workspaces, options = {}) {
    const expected = new Set(workspaces.map((workspace) => workspace.workspaceKey));
    const results = [];
    for (const workspace of workspaces) {
      try {
        results.push(await this.refresh(workspace, options));
      } catch (error) {
        results.push({ ok: false, workspaceKey: workspace.workspaceKey, error });
      }
    }
    for (const workspaceKey of this.providers.keys()) {
      if (!expected.has(workspaceKey)) this.remove(workspaceKey);
    }
    return results;
  }

  syncWorkspaces(workspaces) {
    const expected = new Set(workspaces.map((workspace) => workspace.workspaceKey));
    for (const workspace of workspaces) this.ensure(workspace);
    for (const workspaceKey of this.providers.keys()) {
      if (!expected.has(workspaceKey)) this.remove(workspaceKey);
    }
  }

  async applySaved(result) {
    const record=this.record(result?.workspaceKey);
    if(!record || !result?.sourcePath)return false;
    // Saving content can also restore SVN BASE. Only a fresh status response can
    // decide whether this file remains modified; do not invent a local change.
    await this.refresh(record.workspace);
    return true;
  }

  remove(workspaceKey) {
    const record = this.providers.get(workspaceKey);
    if (!record) return;
    record.sourceControl.dispose();
    this.quickDiffProvider?.removeWorkspace?.(workspaceKey);
    this.providers.delete(workspaceKey);
  }

  record(workspaceKey) {
    return this.providers.get(workspaceKey);
  }

  status(workspaceKey) {
    return this.record(workspaceKey)?.status;
  }

  inputMessage(workspaceKey) {
    return this.record(workspaceKey)?.sourceControl.inputBox.value.trim() || '';
  }

  clearInput(workspaceKey) {
    const sourceControl = this.record(workspaceKey)?.sourceControl;
    if (sourceControl) sourceControl.inputBox.value = '';
  }

  clearRemote(workspaceKey) {
    const record = this.record(workspaceKey);
    if (!record) return;
    if (record.status) {
      this._applyStatus(record, { ...record.status, remoteChecked: true, remoteChanges: [] });
    }
  }

  dispose() {
    for (const record of this.providers.values()) record.sourceControl.dispose();
    this.providers.clear();
    this.quickDiffProvider?.dispose?.();
  }
}

module.exports = {
  CHANGE_STATES,
  SvnScmManager,
  changeDiffStatus,
  changeDisplayName,
  changeUri,
  isTextConflict,
  sourceControlId,
  workspaceKeyFromSourceControlId,
};

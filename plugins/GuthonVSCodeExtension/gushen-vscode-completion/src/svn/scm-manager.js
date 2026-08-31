const GROUPS = {
  LOCAL_MODIFIED: { id: 'local', label: 'Nexus 修改', icon: 'edit' },
  EXTERNAL_MODIFIED: { id: 'external', label: '其他本地修改', icon: 'diff-modified' },
  CONFLICT: { id: 'conflict', label: '冲突/阻断', icon: 'warning' },
  UNTRACKED: { id: 'untracked', label: '未跟踪文件', icon: 'question' },
  REMOTE: { id: 'remote', label: '远程变更', icon: 'cloud-download' },
};
const LOCAL_STATES = Object.keys(GROUPS).filter((state) => state !== 'REMOTE');

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

function changeUri(vscode, workspaceKey, change) {
  const params = new URLSearchParams({ path: change.path });
  const displayName = changeDisplayName(change).replace(/[\\/]+/g, ' · ');
  return vscode.Uri.from({
    scheme: 'guthon-svn-change',
    authority: workspaceKey,
    path: `/${displayName}`,
    query: params.toString(),
  });
}

class SvnScmManager {
  constructor({ vscode, backend, onStatusChanged }) {
    this.vscode = vscode;
    this.backend = backend;
    this.onStatusChanged = onStatusChanged;
    this.providers = new Map();
  }

  _create(workspace) {
    const rootUri = workspace.checkoutPath ? this.vscode.Uri.file(workspace.checkoutPath) : undefined;
    const sourceControl = this.vscode.scm.createSourceControl(
      `guthon-svn-${workspace.workspaceKey}`,
      `${workspace.displayName} · 谷神 SVN 源码变更`,
      rootUri
    );
    const groups = Object.fromEntries(
      Object.entries(GROUPS).map(([state, definition]) => [
        state,
        sourceControl.createResourceGroup(definition.id, definition.label),
      ])
    );
    for (const group of Object.values(groups)) group.guthonWorkspaceKey = workspace.workspaceKey;
    const record = { workspace, sourceControl, groups, status: undefined };
    groups.REMOTE.hideWhenEmpty = true;
    this._configure(record, workspace);
    this.providers.set(workspace.workspaceKey, record);
    return record;
  }

  _configure(record, workspace) {
    record.workspace = workspace;
    record.sourceControl.inputBox.placeholder = 'SVN 提交说明（可选）';
    record.sourceControl.acceptInputCommand = {
      command: 'gushenCompletion.saveSvnToGuthon',
      title: '保存到谷神',
      arguments: [workspace.workspaceKey],
    };
  }

  ensure(workspace) {
    const existing = this.providers.get(workspace.workspaceKey);
    if (existing) {
      this._configure(existing, workspace);
      return existing;
    }
    return this._create(workspace);
  }

  _applyStatus(record, value) {
    const previousRemote = record.status?.remoteChanges || [];
    const remoteChanges = value.remoteChecked ? (value.remoteChanges || []) : previousRemote;
    record.status = { ...value, remoteChanges };
    for (const state of LOCAL_STATES) {
      const group = record.groups[state];
      group.resourceStates = (value.groups?.[state] || []).map((change) => ({
        resourceUri: changeUri(this.vscode, record.workspace.workspaceKey, change),
        command: {
          command: 'gushenCompletion.showSvnDiff',
          title: '查看 SVN 差异',
          arguments: [record.workspace.workspaceKey, change.path],
        },
        contextValue: `guthonSvn.${state}`,
        decorations: {
          iconPath: new this.vscode.ThemeIcon(GROUPS[state].icon),
          tooltip: `${GROUPS[state].label} · ${changeDisplayName(change)}\n${change.path}\n${change.workingCopyId}`,
          strikeThrough: state === 'CONFLICT',
          faded: state === 'UNTRACKED',
        },
      }));
    }
    record.groups.REMOTE.resourceStates = remoteChanges.map((change) => ({
      resourceUri: changeUri(this.vscode, record.workspace.workspaceKey, change),
      contextValue: 'guthonSvn.REMOTE',
      decorations: {
        iconPath: new this.vscode.ThemeIcon(GROUPS.REMOTE.icon),
        tooltip: `远程${change.item || '变更'} · ${changeDisplayName(change)}\n${change.path}\n${change.workingCopyId}`,
      },
    }));
    record.sourceControl.count = (value.changes?.length || 0) + remoteChanges.length;
    this.onStatusChanged?.(record.workspace.workspaceKey, record.status);
    return record.status;
  }

  async refresh(workspace) {
    const record = this.ensure(workspace);
    const value = await this.backend.scmStatus(workspace.workspaceKey);
    return this._applyStatus(record, value);
  }

  async refreshRemote(workspace) {
    const record = this.ensure(workspace);
    const value = await this.backend.scmStatus(workspace.workspaceKey, true);
    return this._applyStatus(record, value);
  }

  async refreshAll(workspaces) {
    const expected = new Set(workspaces.map((workspace) => workspace.workspaceKey));
    const results = [];
    for (const workspace of workspaces) {
      try {
        results.push(await this.refresh(workspace));
      } catch (error) {
        results.push({ ok: false, workspaceKey: workspace.workspaceKey, error });
      }
    }
    for (const workspaceKey of this.providers.keys()) {
      if (!expected.has(workspaceKey)) this.remove(workspaceKey);
    }
    return results;
  }

  applySaved(result) {
    const record = this.record(result?.workspaceKey);
    const current = record?.status;
    if (!record || !current || !result?.changed || !result.sourcePath || !result.workingCopyId) return false;
    const change = {
      workingCopyId: result.workingCopyId,
      scopeEntryId: result.workingCopyId,
      category: result.sourcePath.split('/')[0] || '',
      path: result.sourcePath,
      item: 'modified',
      properties: 'none',
      state: 'LOCAL_MODIFIED',
      sessionManaged: true,
      sourceHash: result.sourceHash || '',
    };
    const withoutSavedPath = (items = []) => items.filter((item) => item.path !== result.sourcePath);
    const groups = Object.fromEntries(
      LOCAL_STATES.map((state) => [state, withoutSavedPath(current.groups?.[state])])
    );
    groups.LOCAL_MODIFIED.push(change);
    const workingCopies = (current.workingCopies || []).map((workingCopy) => (
      workingCopy.id === result.workingCopyId ? { ...workingCopy, clean: false } : workingCopy
    ));
    this._applyStatus(record, {
      ...current,
      clean: false,
      workingCopies,
      changes: [...withoutSavedPath(current.changes), change],
      groups,
    });
    return true;
  }

  remove(workspaceKey) {
    const record = this.providers.get(workspaceKey);
    if (!record) return;
    record.sourceControl.dispose();
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
    record.groups.REMOTE.resourceStates = [];
    if (record.status) record.status = { ...record.status, remoteChanges: [] };
    record.sourceControl.count = record.status?.changes?.length || 0;
    this.onStatusChanged?.(workspaceKey, record.status);
  }

  dispose() {
    for (const record of this.providers.values()) record.sourceControl.dispose();
    this.providers.clear();
  }
}

module.exports = { GROUPS, SvnScmManager, changeDisplayName, changeUri };

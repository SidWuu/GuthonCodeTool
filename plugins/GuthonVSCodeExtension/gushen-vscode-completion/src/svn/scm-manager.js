const GROUPS = {
  LOCAL_MODIFIED: { id: 'local', label: 'Nexus 修改' },
  EXTERNAL_MODIFIED: { id: 'external', label: '其他本地修改' },
  CONFLICT: { id: 'conflict', label: '冲突/阻断' },
  UNTRACKED: { id: 'untracked', label: '未跟踪文件' },
};

function changeUri(vscode, workspaceKey, change) {
  const params = new URLSearchParams({ path: change.path });
  return vscode.Uri.from({
    scheme: 'guthon-svn-change',
    authority: workspaceKey,
    path: `/${change.path.split('/').at(-1) || 'change'}`,
    query: params.toString(),
  });
}

class SvnScmManager {
  constructor({ vscode, backend }) {
    this.vscode = vscode;
    this.backend = backend;
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
    const record = { workspace, sourceControl, groups, status: undefined };
    this._configure(record, workspace);
    this.providers.set(workspace.workspaceKey, record);
    return record;
  }

  _configure(record, workspace) {
    record.workspace = workspace;
    record.sourceControl.inputBox.placeholder = '输入保存到谷神的 SVN 提交说明';
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
    record.status = value;
    for (const [state, group] of Object.entries(record.groups)) {
      group.resourceStates = (value.groups?.[state] || []).map((change) => ({
        resourceUri: changeUri(this.vscode, record.workspace.workspaceKey, change),
        command: {
          command: 'gushenCompletion.showSvnDiff',
          title: '查看 SVN 差异',
          arguments: [record.workspace.workspaceKey, change.path],
        },
        contextValue: `guthonSvn.${state}`,
        decorations: {
          tooltip: `${GROUPS[state].label} · ${change.workingCopyId}`,
          strikeThrough: state === 'CONFLICT',
          faded: state === 'UNTRACKED',
        },
      }));
    }
    record.sourceControl.count = value.changes?.length || 0;
    return value;
  }

  async refresh(workspace) {
    const record = this.ensure(workspace);
    const value = await this.backend.scmStatus(workspace.workspaceKey);
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
      Object.keys(GROUPS).map((state) => [state, withoutSavedPath(current.groups?.[state])])
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

  dispose() {
    for (const record of this.providers.values()) record.sourceControl.dispose();
    this.providers.clear();
  }
}

module.exports = { GROUPS, SvnScmManager, changeUri };

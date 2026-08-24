const SOURCE_MODE_DATABASE = 'database';
const SOURCE_MODE_SVN = 'svn';
const SOURCE_MODES = [SOURCE_MODE_DATABASE, SOURCE_MODE_SVN];

function normalizeSourceMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return SOURCE_MODES.includes(normalized) ? normalized : SOURCE_MODE_DATABASE;
}

function sourceModeLabel(value) {
  return normalizeSourceMode(value) === SOURCE_MODE_SVN ? 'SVN' : 'DATABASE';
}

function filterWorkspacesBySourceMode(workspaces, sourceMode) {
  const selected = normalizeSourceMode(sourceMode);
  return (workspaces || []).filter(
    (workspace) => normalizeSourceMode(workspace?.sourceMode) === selected
  );
}

async function selectWorkspaceSourceMode(window, currentValue, beforeChange) {
  const current = normalizeSourceMode(currentValue);
  const selected = await window.showQuickPick(
    SOURCE_MODES.map((value) => ({
      label: sourceModeLabel(value),
      value,
      description: value === current ? '当前模式' : undefined,
    })),
    { title: '选择项目源码来源' }
  );
  if (!selected || selected.value === current) return undefined;
  if (beforeChange && !await beforeChange(current, selected.value)) return undefined;
  return selected.value;
}

module.exports = {
  SOURCE_MODE_DATABASE,
  SOURCE_MODE_SVN,
  SOURCE_MODES,
  filterWorkspacesBySourceMode,
  normalizeSourceMode,
  selectWorkspaceSourceMode,
  sourceModeLabel,
};

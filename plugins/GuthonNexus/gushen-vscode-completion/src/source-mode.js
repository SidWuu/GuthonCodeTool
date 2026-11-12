const SOURCE_MODE_API = 'api';
function normalizeSourceMode(value) {
  const mode=String(value || '').trim().toLowerCase();
  return mode === 'api' || !mode ? SOURCE_MODE_API : mode;
}
function sourceModeLabel(value) {return normalizeSourceMode(value)==='api' ? 'API' : '不支持的旧源码配置';}
function filterWorkspacesBySourceMode(workspaces, mode='api') {
  return (workspaces || []).filter(workspace=>normalizeSourceMode(workspace.sourceMode)===mode);
}
module.exports={SOURCE_MODE_API,normalizeSourceMode,sourceModeLabel,filterWorkspacesBySourceMode};

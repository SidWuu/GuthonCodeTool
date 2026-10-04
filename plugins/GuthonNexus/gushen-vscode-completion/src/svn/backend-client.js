const { ToolJsonClient } = require('../tool-json-client');

function backendErrorMessage(stderr, stdout, code) {
  const stderrLines = String(stderr || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('[SVN] '));
  return stderrLines.join('\n') || String(stdout || '').trim() || `退出码 ${code}`;
}

class SvnBackendClient {
  constructor({ getTool, spawnProcess, processClient }) {
    this.client = new ToolJsonClient({getTool, spawnProcess, processClient,
      errorMessage: backendErrorMessage, outputLabel: 'SVN 后端'});
  }

  run(workspaceKey, args, input, options = {}) {
    return this.client.run(workspaceKey, 'svn', args, input, options);
  }

  releaseLease(workspaceKey, sessionId, documentId) {
    return this.run(workspaceKey, ['lease-release', '--session', sessionId, '--document', documentId]);
  }

  catalog(workspaceKey) {
    return this.run(workspaceKey, ['catalog']);
  }

  fragments(workspaceKey, identity) {
    const args = ['fragments', '--source-type', identity.sourceType, '--source-id', identity.sourceId];
    if (identity.funId) args.push('--fun-id', identity.funId);
    if (identity.workingCopyId) args.push('--working-copy', identity.workingCopyId);
    return this.run(workspaceKey, args);
  }

  pageQuery(workspaceKey, name, args = {}) {
    return this.run(workspaceKey, ['page-query'], { name, arguments: args });
  }

  scopePreview(workspaceKey) {
    return this.run(workspaceKey, ['scope-preview']);
  }

  scopeImport(workspaceKey, text, source = 'script') {
    return this.run(workspaceKey, ['scope-import'], { text, source });
  }

  scopeImportFile(workspaceKey, filePath) {
    return this.run(workspaceKey, ['scope-import'], { file: filePath, source: 'script' });
  }

  cacheAuthentication(workspaceKey, password) {
    return this.run(workspaceKey, ['auth-cache'], { password });
  }

  read(workspaceKey, identity) {
    const args = ['read', '--source-type', identity.sourceType, '--source-id', identity.sourceId];
    if (identity.funId) args.push('--fun-id', identity.funId);
    if (identity.workingCopyId) args.push('--working-copy', identity.workingCopyId);
    if (identity.jsonPointer) args.push('--json-pointer', identity.jsonPointer);
    return this.run(workspaceKey, args);
  }

  readBatch(workspaceKey, targets, options = {}) {
    return this.run(workspaceKey, ['read-batch'], { targets }, options);
  }

  write(workspaceKey, sessionId, documentId, content, options = {}) {
    return this.run(
      workspaceKey,
      ['write', '--session', sessionId, '--document', documentId],
      { content, ...(options.expectedProductHash ? { expectedProductHash: options.expectedProductHash } : {}) },
      options
    );
  }

  writeBatch(workspaceKey, sessionOrChanges, changesOrOptions = {}, options = {}) {
    const identityMode = Array.isArray(sessionOrChanges);
    const sessionId = identityMode ? '' : sessionOrChanges;
    const changes = identityMode ? sessionOrChanges : changesOrOptions;
    const runOptions = identityMode ? changesOrOptions : options;
    return this.run(
      workspaceKey,
      ['write-batch', ...(sessionId ? ['--session', sessionId] : [])],
      { changes },
      runOptions
    );
  }

  scmStatus(workspaceKey, remote = false, options = {}) {
    const workingCopyIds = [...new Set((options.workingCopyIds || []).filter(Boolean))];
    const args = ['scm-status', ...(remote ? ['--remote'] : [])];
    for (const workingCopyId of workingCopyIds) args.push('--working-copy', workingCopyId);
    return this.run(workspaceKey, args, undefined, options);
  }

  refresh(workspaceKey, {
    sourcePath = '',
    workingCopyIds = [],
    mergeLocal = false,
    onOutput,
  } = {}) {
    const args = ['refresh'];
    if (sourcePath) args.push('--path', sourcePath);
    for (const workingCopyId of workingCopyIds) args.push('--working-copy', workingCopyId);
    if (mergeLocal) args.push('--merge-local');
    return this.run(workspaceKey, args, undefined, { onOutput });
  }

  diff(workspaceKey, sourcePath, remote = false) {
    return this.run(workspaceKey, ['diff', '--path', sourcePath, ...(remote ? ['--remote'] : [])]);
  }

  conflict(workspaceKey, sourcePath) {
    return this.run(workspaceKey, ['conflict', '--path', sourcePath]);
  }

  resolveConflict(workspaceKey, sourcePath, options = {}) {
    return this.run(workspaceKey, ['resolve-conflict', '--path', sourcePath], undefined, options);
  }

  history(workspaceKey, sourcePath, limit = 20) {
    return this.run(workspaceKey, ['history', '--path', sourcePath, '--limit', String(limit)]);
  }

  definition(workspaceKey, alias, funId) {
    return this.run(workspaceKey, ['definition', '--alias', alias, '--fun-id', funId]);
  }

  callers(workspaceKey, alias, funId, limit = 100) {
    return this.run(workspaceKey, [
      'callers', '--alias', alias, '--fun-id', funId, '--limit', String(limit),
    ]);
  }

  context(workspaceKey, sourceId, funId = '', limit = 20) {
    return this.run(workspaceKey, [
      'context', '--source-id', sourceId, '--fun-id', funId, '--limit', String(limit),
    ]);
  }

  reindexFile(workspaceKey, sourcePath, options = {}) {
    return this.run(workspaceKey, ['reindex-file', '--path', sourcePath], undefined, options);
  }

  preview(workspaceKey, action, sessionId, options = {}) {
    const workingCopyIds = [...new Set((options.workingCopyIds || []).filter(Boolean))];
    const args = [`${action}-preview`, '--session', sessionId];
    for (const workingCopyId of workingCopyIds) args.push('--working-copy', workingCopyId);
    return this.run(workspaceKey, args, undefined, options);
  }

  revert(workspaceKey, preview, candidateIds, options = {}) {
    return this.run(workspaceKey, [
      'revert',
      '--session', preview.sessionId,
      '--selection-token', preview.selectionToken,
      ...candidateIds.flatMap((candidateId) => ['--candidate', candidateId]),
    ], undefined, options);
  }

  platformSave(workspaceKey, preview, candidateIds, message, options = {}) {
    return this.run(workspaceKey, [
      'platform-save',
      '--session', preview.sessionId,
      '--selection-token', preview.selectionToken,
      ...candidateIds.flatMap((candidateId) => ['--candidate', candidateId]),
    ], { message }, options);
  }

  deliveryStatus(workspaceKey) {
    return this.run(workspaceKey, ['delivery-status']);
  }

}

module.exports = { backendErrorMessage, SvnBackendClient };

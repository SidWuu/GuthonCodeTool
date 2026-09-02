const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { toolArguments } = require('../tool-runtime');

class SvnBackendClient {
  constructor({ getTool, spawnProcess = spawn }) {
    this.getTool = getTool;
    this.spawnProcess = spawnProcess;
  }

  async run(workspaceKey, args, input, { onOutput } = {}) {
    const tool = await this.getTool();
    if (!tool) throw new Error('请先配置 GuthonCodeTool 运行模式和本地数据目录');
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(
        tool.toolPath,
        toolArguments(tool, 'svn', args, workspaceKey),
        { shell: false, env: process.env }
      );
      const stdoutChunks = [];
      const stderrChunks = [];
      const stderrDecoder = new StringDecoder('utf8');
      child.stdout.on('data', (data) => {
        stdoutChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'));
      });
      child.stderr.on('data', (data) => {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        stderrChunks.push(chunk);
        onOutput?.(stderrDecoder.write(chunk));
      });
      child.on('error', reject);
      child.on('close', (code) => {
        onOutput?.(stderrDecoder.end());
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        if (code) return reject(new Error((stderr || stdout || `退出码 ${code}`).trim()));
        try {
          const payload = JSON.parse(stdout);
          if (payload?.ok !== true) {
            throw new Error(payload?.errors?.map((item) => item.error).join('; ') || '后端返回 ok=false');
          }
          resolve(payload);
        } catch (error) {
          reject(new Error(`SVN 后端输出无效：${error.message}`));
        }
      });
      if (input !== undefined) child.stdin.end(JSON.stringify(input));
      else child.stdin.end();
    });
  }

  catalog(workspaceKey) {
    return this.run(workspaceKey, ['catalog']);
  }

  fragments(workspaceKey, identity) {
    const args = ['fragments', '--source-type', identity.sourceType, '--source-id', identity.sourceId];
    if (identity.funId) args.push('--fun-id', identity.funId);
    return this.run(workspaceKey, args);
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
    if (identity.jsonPointer) args.push('--json-pointer', identity.jsonPointer);
    return this.run(workspaceKey, args);
  }

  write(workspaceKey, sessionId, documentId, content, options = {}) {
    return this.run(
      workspaceKey,
      ['write', '--session', sessionId, '--document', documentId],
      { content },
      options
    );
  }

  scmStatus(workspaceKey, remote = false, options = {}) {
    return this.run(workspaceKey, ['scm-status', ...(remote ? ['--remote'] : [])], undefined, options);
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

  reindexFile(workspaceKey, sourcePath, options = {}) {
    return this.run(workspaceKey, ['reindex-file', '--path', sourcePath], undefined, options);
  }

  preview(workspaceKey, action, sessionId, options = {}) {
    return this.run(workspaceKey, [`${action}-preview`, '--session', sessionId], undefined, options);
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
}

module.exports = { SvnBackendClient };

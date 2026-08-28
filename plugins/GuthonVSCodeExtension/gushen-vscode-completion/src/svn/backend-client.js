const { spawn } = require('node:child_process');
const { toolArguments } = require('../tool-runtime');

class SvnBackendClient {
  constructor({ getTool, getEnvironment = async () => ({}), spawnProcess = spawn }) {
    this.getTool = getTool;
    this.getEnvironment = getEnvironment;
    this.spawnProcess = spawnProcess;
  }

  async run(workspaceKey, args, input) {
    const tool = await this.getTool();
    if (!tool) throw new Error('请先配置 GuthonCodeTool 运行模式和本地数据目录');
    const environment = await this.getEnvironment(workspaceKey);
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(
        tool.toolPath,
        toolArguments(tool, 'svn', args, workspaceKey),
        { shell: false, env: { ...process.env, ...environment } }
      );
      const stdoutChunks = [];
      const stderrChunks = [];
      child.stdout.on('data', (data) => {
        stdoutChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'));
      });
      child.stderr.on('data', (data) => {
        stderrChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'));
      });
      child.on('error', reject);
      child.on('close', (code) => {
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

  read(workspaceKey, identity) {
    const args = ['read', '--source-type', identity.sourceType, '--source-id', identity.sourceId];
    if (identity.funId) args.push('--fun-id', identity.funId);
    if (identity.jsonPointer) args.push('--json-pointer', identity.jsonPointer);
    return this.run(workspaceKey, args);
  }

  write(workspaceKey, sessionId, documentId, content) {
    return this.run(
      workspaceKey,
      ['write', '--session', sessionId, '--document', documentId],
      { content }
    );
  }

  scmStatus(workspaceKey, remote = false) {
    return this.run(workspaceKey, ['scm-status', ...(remote ? ['--remote'] : [])]);
  }

  refresh(workspaceKey, { sourcePath = '', workingCopyIds = [], mergeLocal = false } = {}) {
    const args = ['refresh'];
    if (sourcePath) args.push('--path', sourcePath);
    for (const workingCopyId of workingCopyIds) args.push('--working-copy', workingCopyId);
    if (mergeLocal) args.push('--merge-local');
    return this.run(workspaceKey, args);
  }

  diff(workspaceKey, sourcePath) {
    return this.run(workspaceKey, ['diff', '--path', sourcePath]);
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

  reindexFile(workspaceKey, sourcePath) {
    return this.run(workspaceKey, ['reindex-file', '--path', sourcePath]);
  }

  preview(workspaceKey, action, sessionId) {
    return this.run(workspaceKey, [`${action}-preview`, '--session', sessionId]);
  }

  revert(workspaceKey, preview, candidateIds) {
    return this.run(workspaceKey, [
      'revert',
      '--session', preview.sessionId,
      '--selection-token', preview.selectionToken,
      ...candidateIds.flatMap((candidateId) => ['--candidate', candidateId]),
    ]);
  }

  platformSave(workspaceKey, preview, candidateIds, message) {
    return this.run(workspaceKey, [
      'platform-save',
      '--session', preview.sessionId,
      '--selection-token', preview.selectionToken,
      ...candidateIds.flatMap((candidateId) => ['--candidate', candidateId]),
    ], { message });
  }
}

module.exports = { SvnBackendClient };

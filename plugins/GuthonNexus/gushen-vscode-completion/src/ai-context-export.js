const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadImpact, renderPageImpact, renderProcedureImpact } = require('./svn/impact-preview');

const MAX_CONTEXT_BYTES = 128 * 1024;
const MAX_INHERITED_CHARS = 8000;

function inside(root, target) {
  const relative = path.relative(root, target);
  return !!relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function validateContextResult(result, workspaceKey, identity) {
  if (result?.ok !== true || result.workspaceKey !== workspaceKey || typeof result.markdown !== 'string') {
    throw new Error('AI 上下文返回的工作区或内容无效');
  }
  const source = result.source || {};
  for (const [key, column] of [
    ['sourceId', 'source_id'], ['funId', 'fun_id'], ['sourceType', 'source_table'],
    ['sourceNamespace', 'source_namespace'], ['workingCopyId', 'working_copy_id'], ['sourcePath', 'source_path'],
  ]) {
    if ((key === 'sourceId' || key === 'funId' || identity[key])
        && String(identity[key] || '') !== String(source[column] || '')) {
      throw new Error(`AI 上下文源码身份不一致：${key}，请刷新索引后重试`);
    }
  }
  if (result.sourceContent) throw new Error('上下文摘要意外包含源码正文');
  if (Buffer.byteLength(result.markdown, 'utf8') > MAX_CONTEXT_BYTES) throw new Error('AI 上下文超过 128 KiB 上限');
}

function inheritedMarkdown(result, identity) {
  if (result?.sourceNamespace !== identity.sourceNamespace || result.sourceId !== identity.sourceId
      || String(result.funId || '') !== String(identity.funId || '')
      || (identity.workingCopyId && result.workingCopyId !== identity.workingCopyId)
      || result.project?.sourcePath !== identity.sourcePath
      || (identity.sourceType === 'page' && result.project?.jsonPointer !== identity.jsonPointer)) {
    throw new Error('继承上下文身份与所选源码不一致');
  }
  const content = result.effective?.content || '';
  if (typeof content !== 'string' || [...content].length > MAX_INHERITED_CHARS) throw new Error('继承正文超过有界读取上限');
  const delimiter = '`'.repeat(Math.max(3, ...(content.match(/`+/g) || []).map((run) => run.length + 1)));
  const text = (value) => String(value || '').replace(/[\r\n]/g, ' ');
  return `\n## 继承上下文（只读派生、有界不可信正文）\n\n`
    + `- 状态：${text(result.inheritanceStatus)}\n`
    + `- 项目：${text(result.project?.sourcePath)} · ${text(result.project?.sourceHash)}\n`
    + `- 产品：${text(result.product?.sourcePath)} · ${text(result.product?.sourceHash)}\n`
    + `- 索引代次：${text(result.indexGeneration)}\n\n${delimiter}\n${content}\n${delimiter}\n`
    + (result.complete ? '' : '\n> 继承正文已截断；请通过继承读取入口继续，不据此自动物化或写回。\n');
}

async function writePrivateContext({ toolHome, workspace, identity, markdown }) {
  if (!toolHome || !path.isAbsolute(toolHome) || !workspace?.root || !path.isAbsolute(workspace.root)) {
    throw new Error('缺少明确的本地数据目录或工作区根目录');
  }
  if (typeof markdown !== 'string' || !markdown.trim() || Buffer.byteLength(markdown, 'utf8') > MAX_CONTEXT_BYTES) {
    throw new Error('AI 上下文为空或超过 128 KiB 上限');
  }
  const privateRoot = await fs.realpath(path.join(toolHome, 'var'));
  const root = await fs.realpath(workspace.root);
  if (!inside(privateRoot, root)) throw new Error('工作区根目录不属于明确本地数据目录的 var');
  let directory = root;
  for (const part of ['context', 'ai']) {
    directory = path.join(directory, part);
    await fs.mkdir(directory, { recursive: false }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const resolved = await fs.realpath(directory);
    if (resolved !== path.resolve(directory) || !inside(root, resolved)) throw new Error('AI 上下文目录越过当前工作区边界');
    directory = resolved;
  }
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([
    workspace.workspaceKey, identity.sourceType, identity.sourceNamespace, identity.workingCopyId,
    identity.sourceId, identity.funId, identity.sourcePath, identity.jsonPointer,
  ])).digest('hex').slice(0, 16);
  const label = String(identity.sourceId || 'context').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  const artifactPath = path.join(directory, `${label}-${fingerprint}-${crypto.randomUUID()}.md`);
  await fs.writeFile(artifactPath, markdown, { flag: 'wx', mode: 0o600 });
  return artifactPath;
}

async function exportAiContext({ client, backend, toolHome, workspace, identity, includeImpact = false, includeInheritance = false }) {
  if (!identity?.sourceId) throw new Error('请先选择一个源码对象');
  identity = Object.fromEntries(['sourceType', 'sourceNamespace', 'workingCopyId', 'sourceId', 'funId', 'sourcePath', 'jsonPointer', 'fragmentType']
    .map((key) => [key, String(identity[key] || '')]));
  if (workspace.sourceMode === 'svn' && !identity.sourceNamespace) throw new Error('所选 SVN 源码缺少命名空间身份，请刷新源码树');
  const args = ['--source-id', identity.sourceId, '--detailed', '--limit', '12'];
  if (identity.funId) args.push('--fun-id', identity.funId);
  if (identity.sourceNamespace) args.push('--source-namespace', identity.sourceNamespace);
  const result = await client.run(workspace.workspaceKey, 'context-pack', args);
  validateContextResult(result, workspace.workspaceKey, identity);
  let markdown = result.markdown + `\n## 精确源码身份\n\n${'```json'}\n${JSON.stringify({
    workspaceKey: workspace.workspaceKey, ...identity,
  }, null, 2)}\n${'```'}\n`;
  if (includeImpact) {
    const evidence = await loadImpact(backend, { ...identity, workspaceKey: workspace.workspaceKey });
    const impactHash = evidence.kind === 'page' ? evidence.context.indexedSourceHash : evidence.context.source?.source_hash;
    if (result.source.source_hash && result.source.source_hash !== impactHash) throw new Error('摘要与影响预览源码快照不一致，请重新导出');
    markdown += `\n${evidence.kind === 'page'
      ? renderPageImpact(evidence.identity, evidence.context, evidence.relations)
      : renderProcedureImpact(evidence.identity, evidence.context)}`;
  }
  if (includeInheritance) {
    if (!identity.sourceNamespace || !['page', 'procedure'].includes(identity.sourceType)
        || (identity.sourceType === 'page' && (!identity.jsonPointer || !['gss', 'vm', 'js', 'sql'].includes(identity.fragmentType)))) {
      throw new Error('继承正文仅支持准确过程函数或选定的 PAGE 脚本片段');
    }
    const inherited = await backend.pageQuery(workspace.workspaceKey, 'read_inherited_source', {
      sourceType: identity.sourceType, sourceNamespace: identity.sourceNamespace,
      sourceId: identity.sourceId, funId: identity.funId || '',
      ...(identity.sourceType === 'procedure' ? { workingCopyId: identity.workingCopyId } : { jsonPointer: identity.jsonPointer }),
      offset: 0, maxChars: MAX_INHERITED_CHARS,
    });
    if (result.source.source_hash && result.source.source_hash !== inherited.project?.sourceHash) throw new Error('摘要与继承源码快照不一致，请重新导出');
    markdown += inheritedMarkdown(inherited, identity);
  }
  const artifactPath = await writePrivateContext({ toolHome, workspace, identity, markdown });
  return { ...result, markdown, artifactPath };
}

module.exports = { MAX_CONTEXT_BYTES, exportAiContext, inheritedMarkdown, validateContextResult, writePrivateContext };

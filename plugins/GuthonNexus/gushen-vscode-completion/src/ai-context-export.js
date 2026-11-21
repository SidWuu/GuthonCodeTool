const fs = require('node:fs/promises');
const path = require('node:path');
const { workspaceRoot } = require('./workspace-root');
const crypto = require('node:crypto');

const MAX_CONTEXT_BYTES = 128 * 1024;
const MAX_INHERITED_CHARS = 8000;

function inside(root, target) {
  const relative = path.relative(root, target);
  return !!relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function writePrivateContext({ toolHome, workspace, identity, markdown }) {
  if (!toolHome || !path.isAbsolute(toolHome) || !workspace?.root || !path.isAbsolute(workspace.root)) {
    throw new Error('缺少明确的本地数据目录或工作区根目录');
  }
  if (typeof markdown !== 'string' || !markdown.trim() || Buffer.byteLength(markdown, 'utf8') > MAX_CONTEXT_BYTES) {
    throw new Error('AI 上下文为空或超过 128 KiB 上限');
  }
  const privateRoot = await fs.realpath(workspaceRoot(toolHome));
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
    workspace.workspaceKey, identity.sourcePath || identity.path, identity.jsonPointer || '',
  ])).digest('hex').slice(0, 16);
  const label = String(identity.sourceId || 'context').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  const artifactPath = path.join(directory, `${label}-${fingerprint}-${crypto.randomUUID()}.md`);
  await fs.writeFile(artifactPath, markdown, { flag: 'wx', mode: 0o600 });
  return artifactPath;
}

async function apiContext({run,workspaceKey,identity,includeImpact=false,includeInheritance=false}) {
  const sourcePath=identity.sourcePath || identity.path;
  if (!sourcePath) throw new Error('请先选择具有精确路径的源码');
  const current=await run(workspaceKey,'read',{path:sourcePath});
  if(identity.sourceType && current.metadata?.sourceType!==identity.sourceType) throw new Error('源码类型与所选身份不一致');
  const context=await run(workspaceKey,'context',{path:sourcePath,limit:100});
  if(context.workspaceKey!==workspaceKey || context.source?.path!==sourcePath || context.source?.sourceHash!==current.sourceHash) throw new Error('源码与索引快照不一致，请先重建索引');
  const evidence={source:context.source,calls:context.calls,incoming:context.incoming,complete:context.complete,warnings:context.warnings,indexGeneration:context.indexGeneration};
  if(includeImpact) {
    const facts=await run(workspaceKey,'facts',{path:sourcePath,keyword:'',limit:100});
    if(facts.indexGeneration!==context.indexGeneration) throw new Error('影响事实与调用索引代次不一致，请重新查询');
    evidence.facts=facts.facts;evidence.factsTruncated=facts.truncated;
  }
  if(includeInheritance) {
    const inherited=await run(workspaceKey,'inheritance',{path:sourcePath,jsonPointer:identity.jsonPointer || '',offset:0,maxChars:MAX_INHERITED_CHARS});
    if(inherited.sourceHash!==current.sourceHash) throw new Error('继承源码快照已变化，请重新查询');
    evidence.inheritance=inherited;
  }
  const body=JSON.stringify(evidence,null,2), fence='`'.repeat(Math.max(3,...(body.match(/`+/g) || []).map(x=>x.length+1)));
  const markdown=`# API 源码上下文\n\n工作区：${workspaceKey}\n\n源码：${sourcePath}\n\n以下是本地索引快照；不构成运行或业务验收。\n\n${fence}json\n${body}\n${fence}\n`;
  if(Buffer.byteLength(markdown,'utf8')>MAX_CONTEXT_BYTES) throw new Error('AI 上下文超过 128 KiB 上限');
  return {workspaceKey,source:context.source,markdown};
}
async function exportAiContext({run,toolHome,workspace,identity,includeImpact=false,includeInheritance=false}) {
  const result=await apiContext({run,workspaceKey:workspace.workspaceKey,identity,includeImpact,includeInheritance});
  const artifactPath=await writePrivateContext({toolHome,workspace,identity:{...identity,sourcePath:identity.sourcePath || identity.path},markdown:result.markdown});
  return {...result,artifactPath};
}
module.exports = { MAX_CONTEXT_BYTES, exportAiContext, apiContext, writePrivateContext };

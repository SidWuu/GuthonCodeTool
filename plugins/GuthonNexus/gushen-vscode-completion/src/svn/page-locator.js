const PROCEDURE_ALIAS = /^[A-Za-z_$][A-Za-z0-9_.$]{0,255}$/;
const FUNCTION_ID = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;

async function findExactSourceCandidates(backend, workspaceKey, keyword, sourceType, matchesIdentity) {
  const matches = [];
  let cursor = '';
  let generation = '';
  let pages = 0;
  do {
    if (++pages > 10) throw new Error('精确源码候选超过 1000 条，请在 Nexus 源码树定位');
    const result = await backend.pageQuery(workspaceKey, 'search_sources', {
      keyword, sourceType, limit: 100, ...(cursor ? { cursor } : {}),
    });
    if (generation && result.indexGeneration !== generation) {
      throw new Error('查询期间索引已变化，请重新定位源码');
    }
    generation = result.indexGeneration;
    matches.push(...(result.sources || []).filter((source) =>
      source.sourceType === sourceType && source.sourcePath
      && source.workingCopyId && source.sourceNamespace && matchesIdentity(source)));
    cursor = result.nextCursor || '';
  } while (cursor);
  return matches;
}

function findExactPageCandidates(backend, workspaceKey, pageId) {
  const id = String(pageId || '').trim();
  if (!id || id.length > 100) throw new Error('页面编码必须为 1–100 个字符');
  return findExactSourceCandidates(backend, workspaceKey, id, 'page', (source) =>
    source.sourceId === id && source.sourcePath.toLowerCase().endsWith('.json'));
}

function findExactProcedureCandidates(backend, workspaceKey, alias, funId) {
  if (!PROCEDURE_ALIAS.test(alias) || !FUNCTION_ID.test(funId)) {
    throw new Error('过程函数需要有效的包名和函数名');
  }
  const sourceId = `${alias}#${funId}`;
  return findExactSourceCandidates(backend, workspaceKey, sourceId.slice(0, 100), 'procedure', (source) =>
    source.sourceId === sourceId && source.sourceAliasId === alias && source.funId === funId);
}

function procedureFromFullName(fullName) {
  const value = String(fullName || '').trim();
  const separator = value.lastIndexOf('.');
  const alias = value.slice(0, separator);
  const funId = value.slice(separator + 1);
  if (separator < 1 || !PROCEDURE_ALIAS.test(alias) || !FUNCTION_ID.test(funId)) {
    throw new Error('请输入完整包名和函数名，例如 demo.pkg.save');
  }
  return { type: 'procedure', alias, funId };
}

function sourceLocatorFromUri(uri) {
  if (uri?.path !== '/locate-page' && uri?.path !== '/locate-procedure') return null;
  if (uri.authority !== 'gushen-local.guthon-nexus-vscode') {
    throw new Error('源码定位链接的扩展身份不正确');
  }
  const params = new URLSearchParams(uri.query || '');
  if (uri.path === '/locate-page') {
    const ids = params.getAll('pageId');
    if (ids.length !== 1 || [...params.keys()].some((key) => key !== 'pageId')
      || !/^PG-[A-Za-z0-9-]{1,96}$/.test(ids[0])) {
      throw new Error('PAGE 定位链接缺少有效且唯一的页面编码');
    }
    return { type: 'page', pageId: ids[0] };
  }
  const aliases = params.getAll('alias');
  const funIds = params.getAll('funId');
  if (aliases.length !== 1 || funIds.length !== 1
    || [...params.keys()].some((key) => key !== 'alias' && key !== 'funId')
    || !PROCEDURE_ALIAS.test(aliases[0]) || !FUNCTION_ID.test(funIds[0])) {
    throw new Error('过程函数定位链接缺少有效且唯一的包名和函数名');
  }
  return { type: 'procedure', alias: aliases[0], funId: funIds[0] };
}

module.exports = {
  findExactPageCandidates,
  findExactProcedureCandidates,
  procedureFromFullName,
  sourceLocatorFromUri,
};

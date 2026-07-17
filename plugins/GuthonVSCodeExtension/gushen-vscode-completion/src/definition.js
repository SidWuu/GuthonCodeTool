const path = require('node:path');

const PROCEDURE_PATH = /\/source\/(workcopy|readonly)\/(products|project)\/([^/]+)\/([^/]+)\//;

function procedureTargetAt(source, offset) {
  const invoke = /\$vs\.proc\.invoke\s*\(\s*(['"])([A-Za-z_][\w.]*)\1\s*,\s*(['"])([A-Za-z_]\w*)\3/g;
  for (const match of source.matchAll(invoke)) {
    const start = match.index + match[0].lastIndexOf(match[4]);
    if (offset >= start && offset <= start + match[4].length) {
      return { alias: match[2], fun: match[4] };
    }
  }

  const calls = /\$([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)/g;
  for (const call of source.matchAll(calls)) {
    const start = call.index + call[0].lastIndexOf(call[2]);
    if (offset < start || offset > start + call[2].length) {
      continue;
    }

    const bindings = /#set\s*\(\s*\$([A-Za-z_]\w*)\s*=\s*\$vs\.proc\.find\s*\(\s*(['"])([A-Za-z_][\w.]*)\2/g;
    let alias;
    for (const binding of source.slice(0, call.index).matchAll(bindings)) {
      if (binding[1] === call[1]) {
        alias = binding[3];
      }
    }
    return alias ? { alias, fun: call[2] } : null;
  }
  return null;
}

function sourceInfo(filePath) {
  const match = path.normalize(filePath).replaceAll('\\', '/').match(PROCEDURE_PATH);
  return match && { layer: match[1], kind: match[2], owner: match[3], business: match[4] };
}

function selectDefinitionPaths(paths, currentPath) {
  const current = sourceInfo(currentPath);
  const preferredLayer = current?.layer === 'readonly' ? 'readonly' : 'workcopy';
  const score = (filePath) => {
    const candidate = sourceInfo(filePath);
    if (!candidate) return [5, 2];
    let scope = 4;
    if (current) {
      if (candidate.kind === current.kind && candidate.owner === current.owner && candidate.business === current.business) scope = 0;
      else if (candidate.kind === current.kind && candidate.business === current.business) scope = 1;
      else if (candidate.business === current.business) scope = 2;
      else if (candidate.kind === current.kind) scope = 3;
    }
    return [scope, candidate.layer === preferredLayer ? 0 : 1];
  };
  const ranked = paths.map((filePath) => ({ filePath, score: score(filePath) }))
    .sort((a, b) => a.score[0] - b.score[0] || a.score[1] - b.score[1] || a.filePath.localeCompare(b.filePath));
  if (!ranked.length) return [];
  return ranked.filter((item) => item.score[0] === ranked[0].score[0] && item.score[1] === ranked[0].score[1])
    .map((item) => item.filePath);
}

module.exports = { procedureTargetAt, selectDefinitionPaths };

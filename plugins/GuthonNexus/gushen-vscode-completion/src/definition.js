function serviceComponentTargetAt(source, offset) {
  const calls = /\$vs\.(?:proc|thread)\.runServiceComp\s*\(\s*(['"])([A-Za-z0-9_.-]{1,100})\1(?=\s*[,\)])/g;
  for (const match of source.matchAll(calls)) {
    const start = match.index + match[0].length - match[2].length - 1;
    if (offset >= start && offset < start + match[2].length) return { componentId: match[2] };
  }
  return null;
}

function procedureTargetAt(source, offset) {
  const directCalls = /\$vs\.(?:proc\.invoke|thread\.(?:run|runFutureTask))\s*\(\s*(['"])([A-Za-z_][\w.]*)\1\s*,\s*(['"])([A-Za-z_]\w*)\3(?=\s*[,\)])/g;
  for (const match of source.matchAll(directCalls)) {
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

function localFunctionDefinitionAt(source, offset) {
  const calls = /@([A-Za-z_]\w*)\s*\(/g;
  for (const call of source.matchAll(calls)) {
    const start = call.index + 1;
    if (offset < start || offset > start + call[1].length) continue;
    const definitions = /^[ \t]*#function[ \t]+([A-Za-z_]\w*)[ \t]*\(/gm;
    for (const definition of source.matchAll(definitions)) {
      if (definition[1] === call[1]) {
        return definition.index + definition[0].indexOf(definition[1]);
      }
    }
    return null;
  }
  return null;
}

module.exports = { serviceComponentTargetAt, localFunctionDefinitionAt, procedureTargetAt };

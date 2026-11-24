function serviceComponentTargetAt(source, offset) {
  const calls = /\$vs\.(?:proc|thread)\.runServiceComp\s*\(\s*(['"])([A-Za-z0-9_.-]{1,100})\1(?=\s*[,\)])/g;
  for (const match of source.matchAll(calls)) {
    const start = match.index + match[0].length - match[2].length - 1;
    if (offset >= start && offset < start + match[2].length) return { componentId: match[2], start };
  }
  return null;
}

function procedureTargetAt(source, offset) {
  const directCalls = /\$vs\.(?:proc\.(?:invoke|invokeWithGlobalTrans)|thread\.(?:run|runFutureTask|runFutureTaskWithGlobalTrans))\s*\(\s*(['"])([A-Za-z_][\w.]*)\1\s*,\s*(['"])([A-Za-z_]\w*)\3(?=\s*[,\)])/g;
  for (const match of source.matchAll(directCalls)) {
    const start = match.index + match[0].lastIndexOf(match[4]);
    if (offset >= start && offset <= start + match[4].length) {
      return { alias: match[2], fun: match[4], start };
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
    return alias ? { alias, fun: call[2], start } : null;
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


function localFunctionAt(source, offset) {
  const call = [...source.matchAll(/@([A-Za-z_$][\w$]*)\s*\(/g)].find(match =>
    offset >= match.index + 1 && offset <= match.index + 1 + match[1].length);
  const declarations = [...source.matchAll(/^[ \t]*#function[ \t]+([A-Za-z_$][\w$]*)(?:[ \t]*\(([^)\r\n]*)\))?/gm)];
  const declaration = call ? declarations.find(match => match[1] === call[1]) : declarations.find(match => {
    const start = match.index + match[0].indexOf(match[1]);
    return offset >= start && offset <= start + match[1].length;
  });
  if (!declaration) return;
  const comments = [];
  for (const line of source.slice(0, declaration.index).replace(/\r?\n$/, '').split(/\r?\n/).reverse()) {
    if (/^\s*\*\//.test(line)) continue;
    const comment = line.match(/^\s*(?:\/\/|##|\/\*|\*)\s?(.*?)(?:\*\/)?\s*$/);
    if (!comment) break;
    comments.unshift(comment[1]);
  }
  return {name: declaration[1], signature: `${declaration[1]}(${declaration[2] || ''})`,
    comment: comments.join('\n'), start: declaration.index + declaration[0].indexOf(declaration[1])};
}
function inheritCallAt(source, offset) {
  return [...source.matchAll(/@inherit\s*\(\s*\)/g)].some(match =>
    offset >= match.index && offset <= match.index + match[0].length);
}
module.exports = { serviceComponentTargetAt, localFunctionDefinitionAt, procedureTargetAt, localFunctionAt, inheritCallAt };

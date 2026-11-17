// Official presentation/data with Nexus aliases and all non-GSS completion data retained.
function enrichCompletionData(data, catalog) {
  const old = data.java || [];
  const pathOf = item => typeof item.body === 'string' ? item.body.split('(')[0] : '';
  const paths = new Set();
  const official = [{prefix:'vs', aliases:['$vs'], body:'$vs', language:'java', group:'official-module',completionKind:'module',apiPath:'$vs',description:'谷神公共对象'}];
  for (const [moduleName, module] of Object.entries(catalog.modules)) {
    official.push({prefix: moduleName, aliases:[module.fullName], body:module.fullName,
      language:'java', group:'official-module', completionKind:'module', apiPath:module.fullName,
      description:module.description});
    for (const method of module.functions) {
      const apiPath = `${module.fullName}.${method.name}`;
      const legacy = old.filter(item => pathOf(item) === apiPath);
      paths.add(apiPath);
      const args = method.params.map(p => p.varName || 'param');
      const descriptions = [...new Set(legacy.map(item=>item.description).filter(Boolean))];
      official.push({prefix:legacy[0]?.prefix || `${moduleName}.${method.name}`,
        aliases:[apiPath,...legacy.map(item=>item.prefix)], language:'java', group:legacy[0]?.group || moduleName,
        apiPath, signature:method.label, completionKind:'function', body:`${apiPath}(${args.join(',')})`,
        description:legacy[0]?.description || module.description,
        officialDocumentation:method.doc + (descriptions.length ? '\n\n' + descriptions.join('\n\n') : '')});
    }
  }
  const retained = old.filter(item=>!paths.has(pathOf(item))).map(item=>{
    const apiPath = pathOf(item);
    if (!/^[A-Za-z_$][\w$.]*$/.test(apiPath) || !String(item.body).includes('(')) return item;
    return {...item,apiPath,completionKind:'function',signature:apiPath.split('.').at(-1)+item.body.slice(item.body.indexOf('(')),officialDocumentation:item.description || ''};
  });
  return {...data, java:[...retained,...official]};
}

// Keep syntax snippets intact. API identity includes the full owner and overload,
// independently of whether a catalog displays a short or qualified method name.
function mergeApiCompletionItems(...sources) {
  const normalize = value => value.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\s+/g,
    token => /^\s/.test(token) ? '' : token);
  const entries = sources.flat().map(item => {
    if (Array.isArray(item.body) || item.group === 'syntax') return {item};
    const call = /^([\w$.]+)(\([\s\S]*\))$/.exec(String(item.body || ''));
    if (!call) return {item};
    const apiPath = item.apiPath || call[1];
    const bodyKey = apiPath + normalize(call[2]);
    const signature = item.signature?.match(/^[\w$.]+(\([\s\S]*)$/)?.[1];
    return {item, bodyKey, signatureKey: signature ? apiPath + normalize(signature) : undefined};
  });
  const signatures = new Map();
  for (const {bodyKey, signatureKey} of entries) {
    if (!signatureKey) continue;
    if (!signatures.has(bodyKey)) signatures.set(bodyKey, new Set());
    signatures.get(bodyKey).add(signatureKey);
  }
  const merged = [], positions = new Map();
  for (const {item, bodyKey, signatureKey} of entries) {
    const known = signatures.get(bodyKey);
    // An untyped legacy template can match a single known overload. If several
    // typed overloads share its template, keep it rather than guessing a type.
    const key = signatureKey || (known?.size === 1 ? [...known][0] : bodyKey);
    if (!key || !positions.has(key)) {
      if (key) positions.set(key, merged.length);
      merged.push(item);
      continue;
    }
    const index = positions.get(key), first = merged[index];
    merged[index] = {...first, aliases: [...new Set([
      first.prefix, ...(first.aliases || []), item.prefix, ...(item.aliases || []),
    ].filter(Boolean))]};
  }
  return merged;
}

module.exports = {enrichCompletionData, mergeApiCompletionItems};

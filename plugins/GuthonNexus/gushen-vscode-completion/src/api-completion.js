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

module.exports = {enrichCompletionData};

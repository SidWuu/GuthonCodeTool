(function initFieldsMoverCore(global) {
  function cloneValue(value, seen = new Map()) {
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);
    if (value instanceof Date) return new Date(value.getTime());
    const copy = Array.isArray(value) ? [] : {};
    seen.set(value, copy);
    Object.keys(value).forEach((key) => { copy[key] = cloneValue(value[key], seen); });
    return copy;
  }

  // Only standalone inheritance statements are source expansion points. Mask
  // comments and literals first so their contents remain untouched.
  function expandInheritedSource(source, product) {
    const masked = source.replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|##[^\r\n]*|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`/g,
      (value) => value.replace(/[^\r\n]/g, " ")
    );
    const markers = [...masked.matchAll(/^[ \t]*(?:return[ \t]+)?@?inherit\(\);?[ \t]*\r?$/gm)];
    if (!markers.length && !/(?<![\w])@?inherit\s*\(/.test(masked)) return source;
    if (markers.length !== 1) throw new Error("字段继承脚本无法安全展开，请核对源码");
    const marker = markers[0];
    const remaining = masked.slice(0, marker.index) + masked.slice(marker.index + marker[0].length);
    if (/(?<![\w])@?inherit\s*\(/.test(remaining)) throw new Error("字段继承脚本无法安全展开，请核对源码");
    if (typeof product !== "string") throw new Error("字段缺少产品继承源码，无法复制");
    const expanded = source.slice(0, marker.index) + product + source.slice(marker.index + marker[0].length);
    return expanded.trim() ? expanded : "";
  }

  function materializeFieldScripts(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const [key, parentKey] of [["pageEvents", "superPageEvents"], ["serviceEvents", "superServiceEvents"]]) {
      const events = value[key];
      const parent = value[parentKey];
      if (events && typeof events === "object") {
        Object.keys(events).forEach((name) => {
          if (typeof events[name] === "string") {
            const product = parent && typeof parent === "object" && !Array.isArray(parent)
              ? (Object.hasOwn(parent, name) ? parent[name] : "") : undefined;
            events[name] = expandInheritedSource(events[name], product);
          }
        });
      }
    }
    if (typeof value.script === "string") value.script = expandInheritedSource(value.script, value.superScript);
    Object.entries(value).forEach(([key, child]) => {
      if (!["superPageEvents", "superServiceEvents", "superScript"].includes(key)) materializeFieldScripts(child, seen);
    });
  }

  function cloneFields(fields) {
    const copy = cloneValue(fields);
    copy.forEach((field) => {
      materializeFieldScripts(field);
      if (field && "isProduct" in field) field.isProduct = 0;
    });
    return copy;
  }

  function planAppendFields(targetFields, copiedFields) {
    const seen = new Set(targetFields.filter((field) => field?.fieldId).map((field) => String(field.fieldId)));
    const toAppend = [];
    const skippedDuplicate = [];
    const skippedInvalid = [];
    copiedFields.forEach((field) => {
      if (!field?.fieldId) skippedInvalid.push(field);
      else if (seen.has(String(field.fieldId))) skippedDuplicate.push(field);
      else {
        seen.add(String(field.fieldId));
        toAppend.push(field);
      }
    });
    return { toAppend, skippedDuplicate, skippedInvalid };
  }

  const api = { cloneFields, planAppendFields };
  global.GuthonFieldsMoverCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);

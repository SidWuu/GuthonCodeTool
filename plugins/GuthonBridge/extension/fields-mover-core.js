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

  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
  const fixedFieldKeys = new Set(["fieldId", "id", "guid", "type", "isProduct", "tbId", "fdId",
    "colGroupType", "parentFieldId", "childFieldId", "bnts", "superScript", "superPageEvents", "superServiceEvents"]);
  const fieldCode = value => typeof value === "string" && value.trim() !== "";
  const validIdentity = identity => record(identity) && fieldCode(identity.fieldId)
    && Object.entries(identity).every(([key, value]) => ["fieldId", "id", "guid"].includes(key) && fieldCode(value));

  function parseFieldBatch(text) {
    const invalid = () => new Error("请粘贴 Nexus 复制的 DATABASE 字段改动");
    if (typeof text !== "string" || !text.trim()) throw invalid();
    if (new TextEncoder().encode(text).length > 4_000_000) throw new Error("字段改动超过导入上限");
    let batch;
    try {
      batch = JSON.parse(text, (key, value) => {
        if (forbiddenKeys.has(key)) throw invalid();
        if (typeof value === "number" && (!Number.isFinite(value) ||
          (Number.isInteger(value) && !Number.isSafeInteger(value)))) throw new Error("字段改动含有无法保真导入的数字");
        return value;
      });
    } catch (error) {
      if (error instanceof SyntaxError) throw invalid();
      throw error;
    }
    if (batch?.format !== "guthon-database-page-fields-v1" || !fieldCode(batch.pageId) || !fieldCode(batch.component)
      || !["input-box", "table-main", "table-item"].includes(batch.componentType)
      || !Array.isArray(batch.anchors) || !batch.anchors.length
      || !batch.anchors.every(identity => validIdentity(identity) && !!(identity.id || identity.guid))
      || !Array.isArray(batch.updates) || !Array.isArray(batch.additions) || !batch.updates.length && !batch.additions.length)
      throw invalid();
    const fieldIds = new Set();
    for (const update of batch.updates) {
      if (!validIdentity(update?.identity) || !fieldCode(update.type) || !Array.isArray(update.changes) || !update.changes.length
        || fieldIds.has(update.identity.fieldId)) throw invalid();
      fieldIds.add(update.identity.fieldId);
      const paths = new Set();
      for (const change of update.changes) {
        const path = change?.path;
        if (!Array.isArray(path) || path.length < 1 || path.length > 2
          || !path.every(key => fieldCode(key) && !key.includes(".") && !forbiddenKeys.has(key))
          || fixedFieldKeys.has(path[0]) || (!Object.hasOwn(change, "before") && !Object.hasOwn(change, "after")))
          throw invalid();
        const name = path.join(".");
        if (paths.has(name) || (path.length === 2 ? paths.has(path[0]) : [...paths].some(key => key.startsWith(name + "."))))
          throw invalid();
        paths.add(name);
      }
    }
    for (const entry of batch.additions) {
      if (!record(entry?.field) || !fieldCode(entry.field.fieldId) || !fieldCode(entry.field.type)
        || typeof entry.hidden !== "boolean" || fieldIds.has(entry.field.fieldId)) throw invalid();
      fieldIds.add(entry.field.fieldId);
    }
    return batch;
  }

  function sameValue(left, right) {
    if (left === right) return true;
    if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
    return record(left) && record(right) && Object.keys(left).length === Object.keys(right).length
      && Object.keys(left).every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
  }

  function planFieldBatch(fields, batch) {
    const byCode = new Map();
    for (const field of fields) {
      if (!fieldCode(field?.fieldId)) continue;
      const code = field.fieldId;
      byCode.set(code, byCode.has(code) ? null : field);
    }
    const matches = (field, identity) => field && Object.entries(identity).every(([key, value]) => field[key] === value);
    if (!batch.anchors.every(identity => matches(byCode.get(identity.fieldId), identity)))
      throw new Error("选中组件与本地字段改动的来源组件不匹配，请核对页面和组件");

    const writes = [], preview = [];
    let already = 0;
    for (const {identity, type, changes} of batch.updates) {
      const field = byCode.get(identity.fieldId);
      if (!matches(field, identity) || field.type !== type)
        throw new Error(`字段 ${identity.fieldId} 的身份或类型不匹配`);
      const nested = new Map();
      for (const change of changes) {
        const [key, child] = change.path;
        const parent = child ? field[key] : field;
        const leaf = child || key;
        const present = record(parent) && Object.hasOwn(parent, leaf);
        const matchesSide = side => Object.hasOwn(change, side) === present && (!present || sameValue(parent[leaf], change[side]));
        if (matchesSide("after")) { already++; continue; }
        if (!matchesSide("before") || (child && parent != null && !record(parent)))
          throw new Error(`字段 ${identity.fieldId} 的 ${change.path.join(".")} 已在设计器中变化，请核对后重试`);
        if (child) {
          if (!nested.has(key)) nested.set(key, {...parent});
          const next = nested.get(key);
          if (Object.hasOwn(change, "after")) next[child] = change.after;
          else delete next[child];
        } else {
          writes.push({field, key, remove: !Object.hasOwn(change, "after"), value: change.after});
        }
        preview.push({fieldId: identity.fieldId, ...change});
      }
      for (const [key, value] of nested) writes.push({field, key, value});
    }

    const additions = batch.additions.map(({field, hidden}) => ({field: cloneFields([field])[0], hidden}));
    const append = planAppendFields(fields, additions.map(entry => entry.field));
    for (const field of append.skippedDuplicate) {
      if (!sameValue(byCode.get(field.fieldId), field))
        throw new Error(`新增字段 ${field.fieldId} 已存在，且配置与本地不同`);
      already++;
    }
    const nativeIds = new Set(fields.flatMap(field => [field?.id, field?.guid]).filter(fieldCode));
    const added = new Set(append.toAppend);
    for (const field of added) {
      const ids = [field.id, field.guid].filter(fieldCode);
      if (ids.some(id => nativeIds.has(id))) throw new Error(`新增字段 ${field.fieldId} 的控件身份已存在`);
      for (const id of ids) nativeIds.add(id);
    }
    return {writes, additions: additions.filter(entry => added.has(entry.field)), preview, already};
  }

  const api = { cloneFields, planAppendFields, parseFieldBatch, planFieldBatch };
  global.GuthonFieldsMoverCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);

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

  function cloneFields(fields) {
    const copy = cloneValue(fields);
    copy.forEach((field) => {
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

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function getCurrentWord(lineText, character) {
  const beforeCursor = String(lineText || '').slice(0, character);
  const match = beforeCursor.match(/[\w$.-]+$/);
  return match ? match[0] : '';
}

function routeMatches(route, languageId, typedPrefix) {
  return (
    normalizeKey(route.in) === normalizeKey(languageId) &&
    normalizeKey(route.type) === normalizeKey(typedPrefix)
  );
}

function resolveRoute(rules, languageId, typedPrefix) {
  const routes = Array.isArray(rules.routes) ? rules.routes : [];
  const route = routes.find((item) => routeMatches(item, languageId, typedPrefix));

  if (route) {
    return {
      source: route.use,
      group: route.group,
      route,
    };
  }

  const defaults = rules.defaults || {};
  return {
    source: defaults[languageId] || languageId,
    group: undefined,
    route: undefined,
  };
}

function itemMatchesPrefix(item, typedPrefix) {
  const prefix = normalizeKey(item.prefix);
  const typed = normalizeKey(typedPrefix);

  if (!typed) {
    return true;
  }

  return prefix.startsWith(typed) || prefix.includes(`.${typed}`);
}

function itemBodyToDisplayText(body) {
  if (Array.isArray(body)) {
    return body.join('\n');
  }

  return String(body || '');
}

function splitSegments(value) {
  return String(value || '')
    .split(/[.$\s()]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function isCamelBoundary(segment, index) {
  return index > 0 && /[A-Z]/.test(segment[index]);
}

function bodyCallPath(body) {
  if (Array.isArray(body)) {
    return '';
  }

  const text = String(body || '');
  const open = text.indexOf('(');
  return open === -1 ? text : text.slice(0, open);
}

function findHoverItems(data, languageId, api) {
  return (data[languageId] || []).filter((item) => bodyCallPath(item.body) === api);
}

function segmentMatchRank(value, typed) {
  const text = normalizeKey(value);
  const segments = splitSegments(value);
  const lowerSegments = segments.map((segment) => normalizeKey(segment));

  if (text === typed || lowerSegments.some((segment) => segment === typed)) {
    return 0;
  }

  if (text.startsWith(typed) || lowerSegments.some((segment) => segment.startsWith(typed))) {
    return 1;
  }

  if (segments.some((segment, index) => {
    const lower = lowerSegments[index];
    const matchIndex = lower.indexOf(typed);
    return matchIndex > 0 && isCamelBoundary(segment, matchIndex);
  })) {
    return 2;
  }

  return 9;
}

function matchingSegment(value, typed) {
  const text = normalizeKey(value);
  const segments = splitSegments(value);
  const lowerSegments = segments.map((segment) => normalizeKey(segment));

  const exactIndex = lowerSegments.findIndex((segment) => segment === typed);
  if (exactIndex !== -1) {
    return segments[exactIndex];
  }

  const prefixIndex = lowerSegments.findIndex((segment) => segment.startsWith(typed));
  if (prefixIndex !== -1) {
    return segments[prefixIndex];
  }

  const camelIndex = segments.findIndex((segment, index) => {
    const lower = lowerSegments[index];
    const matchIndex = lower.indexOf(typed);
    return matchIndex > 0 && isCamelBoundary(segment, matchIndex);
  });
  if (camelIndex !== -1) {
    return segments[camelIndex];
  }

  if (text.startsWith(typed)) {
    return value;
  }

  return '';
}

function itemMatchRank(item, typedPrefix) {
  const typed = normalizeKey(typedPrefix);

  if (!typed) {
    return 0;
  }

  const prefixRank = segmentMatchRank(item.prefix, typed);
  if (prefixRank < 9) {
    return prefixRank;
  }

  if (normalizeKey(item.group) === 'syntax') {
    return 9;
  }

  const bodyRank = segmentMatchRank(bodyCallPath(item.body), typed);
  if (bodyRank < 9) {
    return 2;
  }

  return 9;
}

function filterItems(data, route, typedPrefix) {
  const sourceItems = data[route.source] || [];

  return sourceItems.filter((item) => {
    if (route.group && normalizeKey(item.group) !== normalizeKey(route.group)) {
      return false;
    }

    if (route.route) {
      return true;
    }

    return itemMatchRank(item, typedPrefix) < 9;
  });
}

function mergeCompletionData(...sources) {
  const merged = {};

  for (const source of sources) {
    for (const [language, items] of Object.entries(source || {})) {
      if (!Array.isArray(items)) {
        continue;
      }

      merged[language] = [...(merged[language] || []), ...items];
    }
  }

  return merged;
}

function escapeSnippetText(value) {
  return String(value).replace(/\$/g, '\\$');
}

function templateToSnippet(template) {
  const text = String(template || '');
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');

  if (open === -1 || close === -1 || close < open) {
    return escapeSnippetText(text);
  }

  const head = escapeSnippetText(text.slice(0, open + 1));
  const tail = escapeSnippetText(text.slice(close));
  const args = text
    .slice(open + 1, close)
    .split(',')
    .map((arg) => arg.trim())
    .filter(Boolean);

  if (args.length === 0) {
    return `${head}${tail}`;
  }

  const body = args
    .map((arg, index) => `\${${index + 1}:${arg}}`)
    .join(',');

  return `${head}${body}${tail}`;
}

function itemBodyToSnippet(body) {
  if (Array.isArray(body)) {
    return body.join('\n');
  }

  return templateToSnippet(body);
}

function shortDescription(description, maxLength = 36) {
  const text = normalizeText(description);
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}…`;
}

function itemLabel(item) {
  const description = shortDescription(item.description);

  if (!description) {
    return item.prefix;
  }

  return {
    label: item.prefix,
    description,
  };
}

function itemDocumentation(item) {
  const body = itemBodyToDisplayText(item.body);
  const description = normalizeText(item.description);

  if (body && description) {
    return `\`\`\`gushen\n${body}\n\`\`\`\n\n${description}`;
  }

  if (body) {
    return `\`\`\`gushen\n${body}\n\`\`\``;
  }

  return description;
}

function itemFilterText(item, typedPrefix) {
  const typed = normalizeText(typedPrefix);
  const normalizedTyped = normalizeKey(typed);

  if (!typed) {
    return item.prefix;
  }

  if (segmentMatchRank(item.prefix, normalizedTyped) < 9) {
    return matchingSegment(item.prefix, normalizedTyped) || item.prefix;
  }

  return `${item.prefix} ${matchingSegment(bodyCallPath(item.body), normalizedTyped) || typed}`;
}

function itemGroupRank(item) {
  const group = normalizeKey(item.group);
  const ranks = {
    syntax: 0,
    proc: 10,
    svc: 20,
    db: 30,
    sqlb: 40,
    sqlh: 41,
    sql: 42,
    re: 70,
  };

  return ranks[group] ?? 50;
}

function itemParameterCount(item) {
  if (Array.isArray(item.body)) {
    return 99;
  }

  const body = String(item.body || '');
  const open = body.indexOf('(');
  const close = body.lastIndexOf(')');

  if (open === -1 || close === -1 || close < open) {
    return 99;
  }

  const args = body
    .slice(open + 1, close)
    .split(',')
    .map((arg) => arg.trim())
    .filter(Boolean);

  return args.length;
}

function itemSortText(item, route, currentWord) {
  const matchRank = itemMatchRank(item, currentWord);
  const priority = item.group === 'syntax' ? '0' : route && route.route ? '1' : `2${matchRank}`;
  const groupRank = String(itemGroupRank(item)).padStart(2, '0');
  const overloadRank = String(itemParameterCount(item)).padStart(2, '0');

  return `${priority}_${groupRank}_${item.prefix}_${overloadRank}`;
}

module.exports = {
  filterItems,
  findHoverItems,
  getCurrentWord,
  itemBodyToSnippet,
  itemDocumentation,
  itemFilterText,
  itemLabel,
  itemMatchRank,
  itemParameterCount,
  itemSortText,
  mergeCompletionData,
  resolveRoute,
  templateToSnippet,
};

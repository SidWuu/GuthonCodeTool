const test = require('node:test');
const assert = require('node:assert/strict');
const manualData = require('../data/manual.json');

const {
  resolveRoute,
  filterItems,
  itemBodyToSnippet,
  itemDocumentation,
  itemLabel,
  itemMatchRank,
  itemParameterCount,
  itemFilterText,
  mergeCompletionData,
  getCurrentWord,
  itemSortText,
  templateToSnippet,
} = require('../src/rules');

const rules = {
  defaults: {
    java: 'java',
    javascript: 'javascript',
    sql: 'sql',
  },
  routes: [
    { in: 'java', type: 'sqltools', use: 'sql', group: 'sql' },
    { in: 'java', type: 'sql', use: 'java', group: 'sqlb' },
    { in: 'java', type: 'sqlh', use: 'java', group: 'sqlh' },
  ],
};

const data = {
  java: [
    { prefix: 'sqlb.like', group: 'sqlb', body: '$vs.sqlTools.like(sqlBean,strField,strData)' },
    { prefix: 'sqlh.like', group: 'sqlh', body: '$vs.sqlHelper.like(form,strTableFieldId)' },
    { prefix: 'db.list', group: 'db', body: '$vs.dbTools.list(strSql,where)' },
    { prefix: 'proc.callMainPageFind', group: 'proc', body: '$vs.proc.callMainPageFind(pageId,args)', description: '调用主页面报表查询接口查询数据' },
  ],
  sql: [
    { prefix: 'sql.like', group: 'sql', body: 'SQLTools.like(field,data)' },
    { prefix: 'sql.UUID', group: 'sql', body: 'SQLTools.UUID()' },
  ],
};

function fuzzyMatch(pattern, candidate) {
  let cursor = 0;
  const lowerPattern = pattern.toLowerCase();
  const lowerCandidate = candidate.toLowerCase();

  for (const char of lowerPattern) {
    cursor = lowerCandidate.indexOf(char, cursor);
    if (cursor === -1) {
      return false;
    }
    cursor += 1;
  }

  return true;
}

test('defaults to the current language data source when no route matches', () => {
  assert.deepEqual(resolveRoute(rules, 'java', 'db'), {
    source: 'java',
    group: undefined,
    route: undefined,
  });
});

test('routes java sqltools prefix to SQL SQLTools snippets', () => {
  assert.deepEqual(resolveRoute(rules, 'java', 'sqltools'), {
    source: 'sql',
    group: 'sql',
    route: rules.routes[0],
  });
});

test('routes java sql and sqlh prefixes to separate java tool groups', () => {
  assert.equal(resolveRoute(rules, 'java', 'sql').group, 'sqlb');
  assert.equal(resolveRoute(rules, 'java', 'sqlh').group, 'sqlh');
});

test('filters items by route group without requiring the typed alias to match item prefixes', () => {
  const route = resolveRoute(rules, 'java', 'sqltools');
  assert.deepEqual(filterItems(data, route, 'sqltools').map((item) => item.prefix), [
    'sql.like',
    'sql.UUID',
  ]);
});

test('filters default items by typed prefix', () => {
  const route = resolveRoute(rules, 'java', 'db');
  assert.deepEqual(filterItems(data, route, 'db').map((item) => item.prefix), ['db.list']);
});

test('filters default items by body and description text', () => {
  const route = resolveRoute(rules, 'java', 'find');
  assert.deepEqual(filterItems(data, route, 'find').map((item) => item.prefix), [
    'proc.callMainPageFind',
  ]);
});

test('ranks prefix matches before full-text matches', () => {
  assert.equal(
    itemMatchRank({ prefix: 'proc.find', body: '$vs.proc.find(strProcName)' }, 'find'),
    0
  );
  assert.equal(
    itemMatchRank({ prefix: 'db.findPage', body: '$vs.dbTools.findPage(sql,where)' }, 'find'),
    1
  );
  assert.equal(
    itemMatchRank({ prefix: 'proc.callMainPageFind', body: '$vs.proc.callMainPageFind(pageId,args)' }, 'find'),
    2
  );
  assert.equal(
    itemMatchRank({ prefix: 'file.download', body: '$vs.file.download(fileId)', description: 'download find result file' }, 'find'),
    9
  );
});

test('does not match manual syntax snippets by body text', () => {
  assert.equal(
    itemMatchRank({
      prefix: 'tryCatchFinally',
      group: 'syntax',
      body: [
        '#try',
        '    $1',
        '#catch (\\$e)',
        '    \\$vs.exception.throwException($2);',
        '#finally',
        '    $3',
        '#end',
      ],
      description: '谷神后端脚本 try/catch/finally',
    }, 'exception'),
    9
  );
  assert.equal(
    itemMatchRank({
      prefix: 'tryCatchFinally',
      group: 'syntax',
      body: ['#try', '#end'],
    }, 'try'),
    1
  );
});

test('does not match API parameters or descriptions as free text', () => {
  assert.equal(
    itemMatchRank({
      prefix: 'ex.throwException',
      group: 'ex',
      body: '$vs.exception.throwException(errorMsg)',
      description: '向用户端抛出异常提示 若当前存在事务 则会回滚事务',
    }, 'set'),
    9
  );
  assert.equal(
    itemMatchRank({
      prefix: 'barcode.createQrCode',
      group: 'barcode',
      body: '$vs.barcode.createQrCode(content,charset,width)',
      description: '生成二维码 charset 参数',
    }, 'set'),
    9
  );
  assert.equal(
    itemMatchRank({
      prefix: 'proc.callMainPageFind',
      group: 'proc',
      body: '$vs.proc.callMainPageFind(pageId,form,pageSize,pageNo)',
      description: '调用主页查询',
    }, 'find'),
    2
  );
  assert.equal(
    itemMatchRank({
      prefix: 'file.download',
      group: 'file',
      body: '$vs.file.download(fileId)',
      description: 'download find result file',
    }, 'find'),
    9
  );
  assert.equal(
    itemMatchRank({
      prefix: 'redis.getset',
      group: 'redis',
      body: '$vs.redis.getset(key,value)',
      description: '获取并设置值',
    }, 'set'),
    9
  );
  assert.equal(
    itemMatchRank({
      prefix: 'redis.setBean',
      group: 'redis',
      body: '$vs.redis.setBean(key,value)',
      description: '设置值',
    }, 'set'),
    1
  );
  assert.equal(
    itemMatchRank({
      prefix: 'ex.throwException',
      group: 'ex',
      body: '$vs.exception.throwException(errorMsg)',
    }, 'exception'),
    2
  );
});

test('uses item prefix as filter text for prefix matches', () => {
  assert.equal(
    itemFilterText({ prefix: 'if', group: 'syntax', body: ['#if ($1)', '#end'] }, 'i'),
    'if'
  );
  assert.equal(
    itemFilterText({ prefix: 'proc.find', body: '$vs.proc.find(strProcName)' }, 'find'),
    'find'
  );
  assert.equal(
    itemFilterText({ prefix: 'proc.callMainPageFind', body: '$vs.proc.callMainPageFind(pageId,args)' }, 'find'),
    'callMainPageFind'
  );
  assert.equal(
    itemFilterText({ prefix: 'alias.mainPage', body: '$vs.proc.callMainPageFind(pageId,args)' }, 'find'),
    'alias.mainPage callMainPageFind'
  );
});

test('uses the matched segment as filter text to avoid stale fuzzy matches', () => {
  assert.equal(
    itemFilterText({ prefix: 'file.download', body: '$vs.file.download(path)' }, 'fi'),
    'file'
  );
  assert.equal(
    itemFilterText({ prefix: 'proc.find', body: '$vs.proc.find(strProcName)' }, 'fi'),
    'find'
  );
  assert.equal(
    itemFilterText({ prefix: 'tryCatchFinally', group: 'syntax', body: ['#try', '#end'] }, 'fi'),
    'tryCatchFinally'
  );
});

test('prevents stale fi candidates from surviving the final find filter', () => {
  assert.equal(
    fuzzyMatch('find', itemFilterText({ prefix: 'file.download', body: '$vs.file.download(path)' }, 'fi')),
    false
  );
  assert.equal(
    fuzzyMatch('find', itemFilterText({ prefix: 'proc.find', body: '$vs.proc.find(strProcName)' }, 'fi')),
    true
  );
  assert.equal(
    fuzzyMatch('find', itemFilterText({ prefix: 'tryCatchFinally', group: 'syntax', body: ['#try', '#end'] }, 'fi')),
    false
  );
});

test('counts API parameters for overload sorting', () => {
  assert.equal(itemParameterCount({ body: '$vs.proc.find(strProcName)' }), 1);
  assert.equal(itemParameterCount({ body: '$vs.proc.find(strProcName,timeout,systemId)' }), 3);
  assert.equal(itemParameterCount({ body: 'SQLTools.UUID()' }), 0);
  assert.equal(itemParameterCount({ body: ['#if ($1)', '    $2', '#end'] }), 99);
});

test('sorts proc exact find matches above regexp find matches', () => {
  const items = [
    { prefix: 're.findAll', group: 're', body: '$vs.regexp.findAll(str,exp)' },
    { prefix: 're.findFirst', group: 're', body: '$vs.regexp.findFirst(str,exp)' },
    { prefix: 'proc.find', group: 'proc', body: '$vs.proc.find(strProcName,timeout,systemId)' },
    { prefix: 'proc.find', group: 'proc', body: '$vs.proc.find(strProcName)' },
  ];

  const sorted = items
    .toSorted((left, right) => itemSortText(left, undefined, 'find').localeCompare(itemSortText(right, undefined, 'find')))
    .map((item) => item.body);

  assert.deepEqual(sorted, [
    '$vs.proc.find(strProcName)',
    '$vs.proc.find(strProcName,timeout,systemId)',
    '$vs.regexp.findAll(str,exp)',
    '$vs.regexp.findFirst(str,exp)',
  ]);
});

test('extracts the current trigger word before the cursor', () => {
  assert.equal(getCurrentWord('  sqltools', 10), 'sqltools');
  assert.equal(getCurrentWord('$vs.sqlHelper', 13), '$vs.sqlHelper');
});

test('converts API templates to VS Code snippet placeholders', () => {
  assert.equal(
    templateToSnippet('$vs.sqlTools.like(sqlBean,strField,strData)'),
    '\\$vs.sqlTools.like(${1:sqlBean},${2:strField},${3:strData})'
  );
  assert.equal(templateToSnippet('SQLTools.UUID()'), 'SQLTools.UUID()');
});

test('keeps explicit multiline snippet bodies unchanged', () => {
  assert.equal(
    itemBodyToSnippet(['#if ($1)', '    $2', '#end']),
    '#if ($1)\n    $2\n#end'
  );
});

test('merges manual java syntax snippets into generated completion data', () => {
  const generated = {
    java: [{ prefix: 'db.list', group: 'db', body: '$vs.dbTools.list(strSql,where)' }],
  };
  const manual = {
    java: [{ prefix: 'break', group: 'syntax', body: '#break;' }],
  };
  const merged = mergeCompletionData(generated, manual);
  const route = resolveRoute(rules, 'java', 'break');

  assert.deepEqual(filterItems(merged, route, 'break').map((item) => item.prefix), ['break']);
});

test('keeps manual decimal-format completions free of JSON escape characters', () => {
  const completion = manualData.java.find((item) => item.prefix === 'weightP');

  assert.equal(completion.body, '$vs.decimalTools.weight_decimalP');
  assert.equal(itemBodyToSnippet(completion.body), '\\$vs.decimalTools.weight_decimalP');
});

test('builds completion label with a short description for the suggestion row', () => {
  assert.deepEqual(
    itemLabel({
      prefix: 'if',
      description: '谷神后端脚本 if 判断',
    }),
    {
      label: 'if',
      description: '谷神后端脚本 if 判断',
    }
  );
});

test('builds documentation from body followed by description', () => {
  assert.equal(
    itemDocumentation({
      body: ['#if ($1)', '    $2', '#end'],
      description: '谷神后端脚本 if 判断',
    }),
    '```gushen\n#if ($1)\n    $2\n#end\n```\n\n谷神后端脚本 if 判断'
  );
});

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  collectPages,
  extractPageSegment,
  formatJavaScript,
  formatReadablePageScripts,
  formatServiceScript,
  jsonStringAtParts,
  parsePageComponents,
  rewritePageSegment,
  rewriteJsonStringAtParts,
  parsePageIndex,
  resolveIndexLink
} = require('../src/page-index');

const INDEX_PATH = path.join(path.sep, 'tmp', 'golden', 'pages', 'SYS-DEMO', 'index.md');

const SAMPLE = `# 页面索引
### 🌏 主数据(SYS-DEMO)
<details>
  <summary>📂 会员管理</summary>
<details>
  <summary> - 📂 客商管理</summary>
- 📄 客商档案
  - [🏠 主页面](D/1/PG-D145.json)
  - [🧊 客商编辑](1/F/PG-1F31.json)
  - [⚡ 企业档案删除](B/A/com.golden.basic.companyDel.gss)
  - [⚡ 会员审核[备份]](7/B/com.golden.basic.audit.copy.gss)
</details>
</details>`;

test('parses the Chinese system, directory, menu and page hierarchy', () => {
  const system = parsePageIndex(SAMPLE, INDEX_PATH);
  assert.equal(system.label, '主数据');
  assert.equal(system.systemId, 'SYS-DEMO');
  assert.equal(system.children[0].label, '会员管理');
  assert.equal(system.children[0].children[0].label, '客商管理');
  assert.equal(system.children[0].children[0].children[0].label, '客商档案');

  const pages = collectPages([system]);
  assert.equal(pages.length, 4);
  assert.equal(pages[0].pageType, '主页面');
  assert.equal(pages[0].filePath, path.join(path.dirname(INDEX_PATH), 'D', '1', 'PG-D145.json'));
  assert.equal(pages[2].pageType, '服务组件');
  assert.match(pages[2].breadcrumb, /主数据 \/ 会员管理 \/ 客商管理 \/ 客商档案 \/ 企业档案删除/);
  assert.equal(pages[3].label, '会员审核[备份]');
});

test('accepts the dash bucket used by system home pages', () => {
  assert.equal(
    resolveIndexLink(INDEX_PATH, '-/A/SYS-DEMO.json'),
    path.join(path.dirname(INDEX_PATH), '-', 'A', 'SYS-DEMO.json')
  );
});

test('rejects remote URLs and paths escaping the system directory', () => {
  assert.equal(resolveIndexLink(INDEX_PATH, 'https://example.test/page.json'), null);
  assert.equal(resolveIndexLink(INDEX_PATH, '../../outside.json'), null);
});

test('builds a virtual component and control tree from one page JSON file', () => {
  const source = JSON.stringify({
    pageSetup: { pageEvents: { onOpenScript: 'searchForm.load();' } },
    views: {
      rows: [
        {
          component: {
            type: 'search-box',
            name: 'searchForm',
            fields: [
              {
                fieldId: 'BILL_DATE',
                label: '单据日期',
                type: 'datesearch',
                pageEvents: { onChangeScript: "if(value){searchForm.setValue('ORG_CODE','A');}" }
              },
              { fieldId: 'ORG_CODE', label: '机构代码', isHideField: 1 }
            ],
            buttons: [{
              id: 'reset',
              name: '重置',
              bntType: 'reset',
              pageEvents: { onClickScript: 'searchForm.reset();' }
            }]
          }
        },
        {
          component: {
            type: 'table-main',
            name: 'mainTable',
            datasource: { sql: 'SELECT A.ID FROM TEST A', saveTableId: 'TEST' },
            fields: [{ fieldId: 'ID', label: '主键' }],
            params: { pageEvents: { onCheckScript: 'detailTable.load(rowData);' } }
          }
        },
        {
          tabs: {
            type: 'tab-page',
            name: 'tabPage',
            tabPages: [{
              type: 'tab-item',
              name: 'tabPage0',
              label: '明细信息',
              rows: [{
                component: {
                  type: 'table-item',
                  name: 'detailTable',
                  fields: [{ fieldId: 'DETAIL_ID', label: '明细ID' }]
                }
              }]
            }]
          }
        }
      ]
    }
  }, null, 2);

  const components = parsePageComponents(source, '/tmp/PG-DEMO.json');
  assert.equal(components.length, 4);
  assert.equal(components[0].label, '查询区');
  assert.equal(components[0].description, 'searchForm · search-box');
  assert.equal(components[0].children[0].label, '字段（2）');
  assert.equal(components[0].children[0].children[0].label, '页面脚本（1）');
  assert.equal(
    components[0].children[0].children[0].children[0].label,
    'BILL_DATE · 单据日期 · onChangeScript'
  );
  assert.equal(components[1].children.at(-1).label, '数据源 SQL');
  assert.equal(components[2].children[0].label, '明细信息');
  assert.equal(components[2].children[0].children[0].description, 'detailTable · table-item');
  assert.equal(components[3].label, '页面脚本（1）');
  assert.equal(components[3].children[0].label, 'onOpenScript');

  const billDate = components[0].children[0];
  assert.equal(source.slice(billDate.offset, billDate.offset + 1), '[');
  assert.match(source.slice(billDate.offset, billDate.endOffset), /"fieldId": "BILL_DATE"/);
  assert.equal(
    JSON.parse(extractPageSegment(source, billDate))[0].fieldId,
    'BILL_DATE'
  );
  const sql = components[1].children.at(-1);
  assert.equal(extractPageSegment(source, sql), 'SELECT A.ID FROM TEST A\n');
  const event = components[1].children.find((node) => node.label.startsWith('页面脚本')).children[0];
  assert.equal(extractPageSegment(source, event), 'detailTable.load(rowData);');

  const rewritten = rewritePageSegment(
    source,
    event.virtualPath,
    'if (rowData) {\n  detailTable.refresh(rowData);\n}'
  );
  const rewrittenData = JSON.parse(rewritten.source);
  assert.equal(
    rewrittenData.views.rows[1].component.params.pageEvents.onCheckScript,
    'if (rowData) {\n  detailTable.refresh(rowData);\n}'
  );
  assert.throws(
    () => rewritePageSegment(source, event.virtualPath, 'if (rowData) {'),
    /JavaScript 语法错误/
  );

  const fields = components[0].children[0];
  const fieldsValue = JSON.parse(extractPageSegment(source, fields));
  fieldsValue[0].label = '修改后的日期';
  const fieldsRewrite = rewritePageSegment(source, fields.virtualPath, JSON.stringify(fieldsValue, null, 2));
  assert.equal(JSON.parse(fieldsRewrite.source).views.rows[0].component.fields[0].label, '修改后的日期');
});

test('preserves the original JSON string escaping when writing a script back', () => {
  const source = '{"pageSetup":{"pageEvents":{"onOpenScript":"//a\\r\\ncall(\\u0027x\\u0027);\\r\\n"}},"views":{}}';
  const nodes = parsePageComponents(source, '/tmp/PG-STYLE.json');
  let event;
  const visit = (items) => {
    for (const node of items || []) {
      if (node.kind === 'event') event = node;
      visit(node.children);
    }
  };
  visit(nodes);
  const rewritten = rewritePageSegment(source, event.virtualPath, "//a\ncall('y');\n");
  assert.match(rewritten.replacement, /\\r\\n/);
  assert.match(rewritten.replacement, /\\u0027y\\u0027/);
  assert.doesNotMatch(rewritten.replacement, /(?<!\\)\n/);
  assert.equal(JSON.parse(rewritten.source).pageSetup.pageEvents.onOpenScript, "//a\r\ncall('y');\r\n");
});

test('formats compact page JavaScript without changing strings, comments or regex literals', () => {
  const compact = "var row=mainTable.getRow();if(!row){gUtil.error('x;y');return;}var re=/[;}]/g;// keep\nmainTable.load();";
  const formatted = formatJavaScript(compact);
  assert.match(formatted, /var row = mainTable\.getRow\(\);\nif \(!row\) \{/);
  assert.match(formatted, /  gUtil\.error\('x;y'\);\n  return;/);
  assert.match(formatted, /var re = \/\[;}\]\/g;\n\/\/ keep\nmainTable\.load\(\);/);
});

test('formats compact service scripts and keeps hashes inside strings intact', () => {
  const compact = '#set($x="a#b")#if($x)$result.put("x",$x);#else$result.put("x","");#end';
  assert.equal(
    formatServiceScript(compact),
    '#set($x="a#b")\n#if($x)\n  $result.put("x",$x);\n#else\n  $result.put("x","");\n#end\n'
  );
});

test('keeps a semicolon attached to a Velocity directive', () => {
  assert.equal(
    formatServiceScript('#set($x = 1);#if($x)$result.put("x", $x);#end'),
    '#set($x = 1);\n#if($x)\n  $result.put("x", $x);\n#end\n'
  );
});

test('renders only page scripts as readable multiline diff text', () => {
  const readable = formatReadablePageScripts(JSON.stringify({
    views: {},
    serviceEvents: {
      beforeSaveScript: '#set($x = 1);\n$result.put("x", $x);'
    },
    pageEvents: {
      onClickScript: "gUtil.error('错误');"
    },
    datasource: {
      sql: 'select *\nfrom RM_FUTURES_PROJECT'
    }
  }));
  assert.match(readable, /serviceEvents > beforeSaveScript · serviceEvents/);
  assert.match(readable, /#set\(\$x = 1\);\n\s*\$result\.put\("x", \$x\);/);
  assert.match(readable, /pageEvents > onClickScript · pageEvents/);
  assert.match(readable, /datasource > sql · SQL/);
  assert.match(readable, /select \*\nfrom RM_FUTURES_PROJECT/);
  assert.doesNotMatch(readable, /"views"/);
  assert.doesNotMatch(readable, /\\n/);
});

test('treats dsType 1 data sources as GSS instead of SQL', () => {
  const source = JSON.stringify({
    views: {
      rows: [{
        component: {
          type: 'table-main',
          name: 'scriptTable',
          datasource: {
            dsType: 1,
            script: '#set($rows = $vs.dbTools.list("select 1"));\nreturn $rows;',
            sql: 'SELECT SHOULD_NOT_BE_USED FROM TEST'
          }
        }
      }]
    }
  });
  const components = parsePageComponents(source, '/tmp/PG-SCRIPT-DS.json');
  const datasource = components[0].children.find((node) => node.kind === 'datasource');
  assert.equal(datasource.label, '数据源脚本（GSS）');
  assert.equal(datasource.dataSourceMode, 'script');
  assert.equal(datasource.dataSourceType, 1);
  assert.match(datasource.virtualPath, /datasource\/script$/);
  assert.equal(extractPageSegment(source, datasource), '#set($rows = $vs.dbTools.list("select 1"));\nreturn $rows;\n');
  const readable = formatReadablePageScripts(source);
  assert.match(readable, /datasource > script · GSS/);
  assert.match(readable, /#set\(\$rows = \$vs\.dbTools\.list\("select 1"\)\);/);
  assert.doesNotMatch(readable, /SHOULD_NOT_BE_USED/);
});

test('rewrites only the selected JSON script block', () => {
  const source = JSON.stringify({
    views: {
      rows: [{
        component: {
          pageEvents: {
            onClickScript: 'old script',
            onOpenScript: 'keep script'
          }
        }
      }]
    },
    other: 'keep'
  });
  const parts = ['views', 'rows', '0', 'component', 'pageEvents', 'onClickScript'];
  assert.equal(jsonStringAtParts(source, parts), 'old script');
  const updated = rewriteJsonStringAtParts(source, parts, 'new script');
  const parsed = JSON.parse(updated);
  assert.equal(jsonStringAtParts(updated, parts), 'new script');
  assert.equal(parsed.views.rows[0].component.pageEvents.onOpenScript, 'keep script');
  assert.equal(parsed.other, 'keep');
});

test('reports malformed JSON instead of returning a misleading component tree', () => {
  assert.throws(() => parsePageComponents('{"views":', '/tmp/broken.json'), /无法解析 JSON 值/);
});

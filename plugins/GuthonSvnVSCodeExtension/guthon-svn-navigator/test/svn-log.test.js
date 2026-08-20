'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSvnLogXml } = require('../src/svn-log');

test('parses SVN file history with decoded messages', () => {
  const xml = `<log><logentry revision="128"><author>alice</author><date>2026-08-20T01:00:00.000000Z</date><msg>修复 A &amp; B</msg></logentry>
  <logentry revision="127"><msg>初始化</msg></logentry></log>`;
  assert.deepEqual(parseSvnLogXml(xml), [
    { revision: '128', author: 'alice', date: '2026-08-20T01:00:00.000000Z', message: '修复 A & B' },
    { revision: '127', author: '未知作者', date: '', message: '初始化' }
  ]);
});

test('repairs a UTF-8 commit message previously stored as Latin-1 text', () => {
  const xml = '<log><logentry revision="1303"><msg>æâä¸å¡æºæ + ååâæ§å¶å¯ä¸æ§</msg></logentry></log>';
  assert.equal(
    parseSvnLogXml(xml)[0].message,
    '按“业务机构 + 品名”控制唯一性'
  );
});

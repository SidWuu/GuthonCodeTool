'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseSvnRemoteStatusXml, parseSvnStatusXml } = require('../src/svn-status');

test('parses SVN XML working copy changes and ignores normal entries', () => {
  const root = path.join('/tmp', 'guthon-svn');
  const xml = `<?xml version="1.0"?>
    <status>
      <target path=".">
        <entry path="pages/SYS/a&amp;b.json"><wc-status item="modified" props="none"/></entry>
        <entry path="pages/SYS/new.json"><wc-status item="unversioned" props="none"/></entry>
        <entry path="pages/SYS/ok.json"><wc-status item="normal" props="none"/></entry>
      </target>
    </status>`;
  assert.deepEqual(parseSvnStatusXml(xml, root).map((entry) => ({
    relativePath: entry.relativePath,
    item: entry.item
  })), [
    { relativePath: path.join('pages', 'SYS', 'a&b.json'), item: 'modified' },
    { relativePath: path.join('pages', 'SYS', 'new.json'), item: 'unversioned' }
  ]);
});

test('merges absolute entry paths from multiple independent working copy targets', () => {
  const root = path.join('/tmp', 'guthon-svn-composite');
  const xml = `<?xml version="1.0"?>
    <status>
      <target path="${path.join(root, 'pages', 'SYS-DEMO')}">
        <entry path="${path.join(root, 'pages', 'SYS-DEMO', 'PG-DEMO.json')}">
          <wc-status item="modified" props="none"/>
        </entry>
      </target>
      <target path="${path.join(root, 'procedures', '0000')}">
        <entry path="${path.join(root, 'procedures', '0000', 'com', 'golden', 'demo.gss')}">
          <wc-status item="added" props="none"/>
        </entry>
      </target>
    </status>`;
  assert.deepEqual(parseSvnStatusXml(xml, root).map((entry) => entry.relativePath), [
    path.join('pages', 'SYS-DEMO', 'PG-DEMO.json'),
    path.join('procedures', '0000', 'com', 'golden', 'demo.gss')
  ]);
});

test('keeps property-only changes as modified entries', () => {
  const root = path.join('/tmp', 'guthon-svn-properties');
  const xml = `<status><target path=".">
    <entry path="pages/SYS/PG-DEMO.json"><wc-status item="normal" props="modified"/></entry>
  </target></status>`;
  assert.deepEqual(parseSvnStatusXml(xml, root).map((entry) => ({
    relativePath: entry.relativePath,
    item: entry.item,
    props: entry.props
  })), [{
    relativePath: path.join('pages', 'SYS', 'PG-DEMO.json'),
    item: 'modified',
    props: 'modified'
  }]);
});

test('parses incoming repository changes and the compared revision', () => {
  const xml = `<status><target path=".">
    <entry path="pages/SYS/PG-DEMO.json">
      <wc-status item="normal" props="none" revision="12"/>
      <repos-status item="modified" props="none"/>
    </entry>
    <against revision="18"/>
  </target></status>`;
  const entries = parseSvnRemoteStatusXml(xml, '/repo');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].remoteItem, 'modified');
  assert.equal(entries[0].againstRevision, '18');
});

test('keeps SVN changelist names on local changes', () => {
  const xml = `<status><target path="."><changelist name="年度计划">
    <entry path="source.gss"><wc-status item="modified" props="none"/></entry>
  </changelist></target></status>`;
  const entries = parseSvnStatusXml(xml, '/repo');
  assert.equal(entries[0].changelist, '年度计划');
});

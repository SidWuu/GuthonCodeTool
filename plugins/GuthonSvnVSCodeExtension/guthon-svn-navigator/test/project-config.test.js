'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DEFAULT_PROJECT_CONFIG_TEMPLATE,
  configuredProjectRootsForPath,
  parseProjectConfig,
  readProjectConfigurations
} = require('../src/project-config');

test('default project template preserves the product and uses a non-sensitive SVN username placeholder', () => {
  const projects = parseProjectConfig(DEFAULT_PROJECT_CONFIG_TEMPLATE);

  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, 'gmeSvn');
  assert.equal(projects[0].name, '期现产品');
  assert.equal(projects[0].username, 'your-svn-user');
  assert.ok(!DEFAULT_PROJECT_CONFIG_TEMPLATE.includes('17634542953'));
  assert.match(DEFAULT_PROJECT_CONFIG_TEMPLATE, /scsjSvn/);
});

test('parses multiple named projects and checkout paths', () => {
  const projects = parseProjectConfig(`
version: 2
projects:
  gmeSvn:
    name: 谷神贸易风险
    path: gmeSvn
    repository_url: https://source.example/gss/product/gme
    username: demo
    checkout_paths:
      - skill
      - pages/SYS-DEMO
      - procedures/0000
  scsjSvn:
    name: 四川数据
    path: scsjSvn
    svn:
      repository_url: https://source.example/gss/product/scsj
    checkout_paths: [pages/SYS-SCSJ, tables/0000]
`);

  assert.deepEqual(projects, [
    {
      id: 'gmeSvn',
      name: '谷神贸易风险',
      path: 'gmeSvn',
      repositoryUrl: 'https://source.example/gss/product/gme',
      checkoutRoot: '',
      username: 'demo',
      checkoutPaths: ['skill', 'pages/SYS-DEMO', 'procedures/0000']
    },
    {
      id: 'scsjSvn',
      name: '四川数据',
      path: 'scsjSvn',
      repositoryUrl: 'https://source.example/gss/product/scsj',
      checkoutRoot: '',
      username: '',
      checkoutPaths: ['pages/SYS-SCSJ', 'tables/0000']
    }
  ]);
});

test('keeps compatibility with the old single-project dictionary', () => {
  const projects = parseProjectConfig(`
project: gmeSvn
version: 1
data_sources:
  - data_source_id: "0000"
    source_paths:
      procedures: procedures/0000
      tables: tables/0000
      views: views/0000
    systems:
      - system_id: SYS-DEMO
        source_paths:
          pages: pages/SYS-DEMO
          system_script: system-script/SYS-DEMO
`);

  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, 'gmeSvn');
  assert.deepEqual(projects[0].checkoutPaths, [
    'procedures/0000',
    'tables/0000',
    'views/0000',
    'pages/SYS-DEMO',
    'system-script/SYS-DEMO'
  ]);
});

test('maps an opened parent or project folder to the configured project paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-project-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'guthon-projects.yaml'), `
version: 2
projects:
  gmeSvn:
    path: gmeSvn
  scsjSvn:
    path: scsjSvn
`, 'utf8');

  const gme = path.join(root, 'gmeSvn');
  const scsj = path.join(root, 'scsjSvn');
  assert.deepEqual(configuredProjectRootsForPath(root), [gme, scsj]);
  assert.deepEqual(configuredProjectRootsForPath(path.join(gme, 'pages')), [gme]);
});

test('can restrict project configuration lookup to the opened folder', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-svn-local-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'guthon-projects.yaml'), `
version: 2
projects:
  parentProject:
    path: parentProject
`, 'utf8');
  const openedFolder = path.join(root, 'empty-workspace');
  fs.mkdirSync(openedFolder);

  assert.equal(readProjectConfigurations(openedFolder, { localOnly: true }).projects.length, 0);
  assert.deepEqual(configuredProjectRootsForPath(openedFolder, { localOnly: true }), []);
});

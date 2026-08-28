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
  projectCheckoutMode,
  readProjectConfigurations
} = require('../src/project-config');

test('default template contains only the new layout examples', () => {
  const projects = parseProjectConfig(DEFAULT_PROJECT_CONFIG_TEMPLATE);
  assert.deepEqual(projects.map((project) => project.id), ['gmeSvn', 'newProject']);
  assert.equal(projects[0].username, 'your-svn-user');
  assert.equal(projectCheckoutMode(projects[0]), 'composite');
  assert.equal(projectCheckoutMode(projects[1]), 'monolithic');
  assert.ok(DEFAULT_PROJECT_CONFIG_TEMPLATE.includes('systems/SYS-XXXX'));
  assert.ok(DEFAULT_PROJECT_CONFIG_TEMPLATE.includes('datasources/0000'));
  assert.equal(DEFAULT_PROJECT_CONFIG_TEMPLATE.includes('data_sources'), false);
  assert.equal(DEFAULT_PROJECT_CONFIG_TEMPLATE.includes('source_paths'), false);
  assert.equal(DEFAULT_PROJECT_CONFIG_TEMPLATE.includes('17634542953'), false);
});

test('parses new composite and monolithic projects with one shared username', () => {
  const projects = parseProjectConfig(`
version: 2
username: shared-svn-user
projects:
  gmeSvn:
    name: 谷神贸易风险
    path: gmeSvn
    repository_url: https://source.example/gss/product/gme
    checkout_paths:
      - skill
      - systems/SYS-DEMO
      - datasources/0000
  newProject:
    name: 整项目
    path: newProject
    repository_url: https://source.example/gss/product/new
`);
  assert.deepEqual(projects.map((project) => [project.id, project.username, project.checkoutPaths]), [
    ['gmeSvn', 'shared-svn-user', ['skill', 'systems/SYS-DEMO', 'datasources/0000']],
    ['newProject', 'shared-svn-user', []]
  ]);
  assert.equal(projectCheckoutMode(projects[0]), 'composite');
  assert.equal(projectCheckoutMode(projects[1]), 'monolithic');
});

test('empty checkout_paths is monolithic and has no implicit paths', () => {
  const projects = parseProjectConfig(`
version: 2
projects:
  project:
    path: project
    repository_url: https://source.example/project
    checkout_paths: []
`);
  assert.equal(projects.length, 1);
  assert.deepEqual(projects[0].checkoutPaths, []);
  assert.equal(projectCheckoutMode(projects[0]), 'monolithic');
});

test('removed data_sources, source_paths and legacy single-project blocks are ignored', () => {
  const projects = parseProjectConfig(`
version: 1
project: legacy
data_sources:
  - data_source_id: "0000"
    source_paths:
      procedures: procedures/0000
projects:
  current:
    path: current
    repository_url: https://source.example/current
`);
  assert.deepEqual(projects.map((project) => project.id), ['current']);
  assert.deepEqual(projects[0].checkoutPaths, []);
});

test('maps opened folders to configured project roots', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guthon-project-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'guthon-projects.yaml'), `
version: 2
projects:
  first:
    path: first
  second:
    path: second
`, 'utf8');
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  assert.deepEqual(configuredProjectRootsForPath(root), [first, second]);
  assert.deepEqual(configuredProjectRootsForPath(path.join(first, 'systems')), [first]);
});

test('local-only lookup does not read a parent configuration', (t) => {
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

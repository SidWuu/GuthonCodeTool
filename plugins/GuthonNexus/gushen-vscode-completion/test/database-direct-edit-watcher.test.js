const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {registerLegacyProjects} = require('../src/legacy-project');

test('DATABASE watcher refreshes Workcopy source bytes and excludes readonly events', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'database-watcher-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const workspace = {workspaceKey:'projects.fixture', sourceMode:'database', root,
    readonlyDir:path.join(root, 'readonly'), workcopyDir:path.join(root, 'workcopy')};
  const filename = path.join(workspace.workcopyDir, 'group', 'source.vm');
  const projection = path.join(workspace.workcopyDir, 'group', 'page', 'scripts', 'query.sql');
  const systemCss = path.join(workspace.workcopyDir, 'group', 'scripts', '30-style', 'source.css');
  const systemJs = path.join(workspace.workcopyDir, 'group', 'scripts', '20-script', 'source.js');
  const readonly = path.join(workspace.readonlyDir, 'group', 'source.vm');
  await fs.mkdir(path.dirname(filename), {recursive:true});
  await fs.mkdir(path.dirname(readonly), {recursive:true});
  await fs.mkdir(path.dirname(projection), {recursive:true});
  await fs.mkdir(path.dirname(systemCss), {recursive:true});
  await fs.mkdir(path.dirname(systemJs), {recursive:true});
  await fs.writeFile(filename, 'edited');
  await fs.writeFile(readonly, 'baseline');
  await fs.writeFile(projection, 'select 1');
  await fs.writeFile(systemCss, 'body {}');
  await fs.writeFile(systemJs, 'const value = 1;');
  const watchers = new Map(), requests = [], errors = [], subscriptions = [];
  const disposable = {dispose(){}};
  const vscode = {
    EventEmitter:class {event=()=>disposable; fire(){} dispose(){}},
    RelativePattern:class {constructor(base, pattern){this.base=base;this.pattern=pattern;}},
    workspace:{textDocuments:[], createFileSystemWatcher(pattern){
      const watcher={onDidCreate(fn){this.create=fn;}, onDidChange(fn){this.change=fn;},
        onDidDelete(fn){this.remove=fn;}, dispose(){}};
      watchers.set(pattern.base, watcher);
      return watcher;
    }},
    window:{},
  };
  const legacy = registerLegacyProjects({vscode, context:{subscriptions,workspaceState:{get(){}}},
    getTool:()=>({toolHome:root}), getSelected:async()=>workspace, getWorkspaces:async()=>[workspace],
    sourceTree:{refresh(){}}, getOutput:()=>({appendLine:message=>errors.push(message)}),
    processClient:{async request(_tool, command, args, key, input){
      requests.push({command,args,key,input});
      const files = await Promise.all(input.files.map(async item => ({
        ok:true, path:item.path, sourceHash:crypto.createHash('sha256').update(await fs.readFile(item.path)).digest('hex')
      })));
      return {ok:true,files};
    }},
  });
  t.after(() => subscriptions.forEach(item => item.dispose()));
  await legacy.sync(workspace, [workspace]);
  watchers.get(workspace.readonlyDir).change({fsPath:readonly});
  watchers.get(workspace.workcopyDir).change({fsPath:filename});
  watchers.get(workspace.workcopyDir).change({fsPath:filename});
  watchers.get(workspace.workcopyDir).change({fsPath:projection});
  watchers.get(workspace.workcopyDir).change({fsPath:systemCss});
  watchers.get(workspace.workcopyDir).remove({fsPath:systemJs});
  watchers.get(workspace.workcopyDir).create({fsPath:systemJs});
  await new Promise(resolve => setTimeout(resolve, 350));
  const files = [filename, projection, systemCss, systemJs];
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], {command:'source-direct-edit', args:['inspect'], key:workspace.workspaceKey,
    input:{files:files.map(path=>({path}))}});
  const versions = await Promise.all(files.map(async path=>({
    path, sourceHash:crypto.createHash('sha256').update(await fs.readFile(path)).digest('hex')
  })));
  assert.deepEqual(requests[1], {command:'source-direct-edit', args:['refresh'], key:workspace.workspaceKey,
    input:{files:versions}});
  assert.deepEqual(errors, []);
});

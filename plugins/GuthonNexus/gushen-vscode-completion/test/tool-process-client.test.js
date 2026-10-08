const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { ToolProcessClient, requestKind, requestTimeoutMs } = require('../src/tool-process-client');

const fakeHost = `
const readline = require('node:readline');
process.stdout.write(JSON.stringify({type:'ready',protocolVersion:1})+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({id:request.id,type:'result',ok:true,result:{command:request.command,kind:request.requestKind}})+'\\n');
});
`;

test('ToolHost receives the installed dependency environment explicitly', async () => {
  let environment;
  const client = new ToolProcessClient({ env: { PATH: '/old-parent', KEEP: 'preserved' }, spawnProcess: (_exe, _args, options) => {
    environment = options.env;
    return spawn(process.execPath, ['-e', fakeHost], { stdio: ['pipe', 'pipe', 'pipe'] });
  } });
  try {
    await client.request({ toolPath: '/fixture', toolHome: '/fixture-home', env: { PATH: '/installed-git' } }, 'workspaces');
    assert.equal(environment.PATH, '/installed-git');
    assert.equal(environment.KEEP, 'preserved');
  } finally { await client.stop(); }
});

test('reuses one ToolHost for consecutive requests and stops it on dispose', async () => {
  let starts = 0;
  const client = new ToolProcessClient({
    spawnProcess: () => {
      starts += 1;
      return spawn(process.execPath, ['-e', fakeHost], { stdio: ['pipe', 'pipe', 'pipe'] });
    },
  });
  const tool = { toolPath: '/unused', toolHome: '/unused-home' };
  const results = await Promise.all([
    client.request(tool, 'workspaces'),
    client.request(tool, 'svn', ['catalog'], 'products.a'),
    client.request(tool, 'svn', ['write'], 'products.a'),
  ]);
  assert.deepEqual(results.map((result) => result.kind), ['read', 'read', 'write']);
  assert.equal(starts, 1);
  await client.stop();
  assert.equal(client.child, null);
});

test('runtime switches cannot kill in-flight writes and workspace changes keep their captured identities', async () => {
  const host=`const readline=require('node:readline');process.stdout.write(JSON.stringify({type:'ready',protocolVersion:1})+'\\n');
    readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
      process.stdout.write(JSON.stringify({type:'progress',message:'started'})+'\\n');
      setTimeout(()=>process.stdout.write(JSON.stringify({id:r.id,type:'result',ok:true,result:{workspaceKey:r.workspaceKey}})+'\\n'),80);});`;
  let starts=0,started;
  const ready=new Promise(resolve=>{started=resolve;});
  const client=new ToolProcessClient({onProgress:message=>{if(message.type==='progress')started();},spawnProcess:()=>{
    starts++;return spawn(process.execPath,['-e',host],{stdio:['pipe','pipe','pipe']});
  }});
  const tool={toolPath:'/tool',toolHome:'/first'};
  const first=client.request(tool,'svn',['write'],'products.first');
  await ready;
  await assert.rejects(client.request({...tool,toolHome:'/other'},'svn',['write'],'products.other'),/原写入未被中断/);
  const second=client.request(tool,'svn',['write'],'products.second');
  assert.equal((await first).workspaceKey,'products.first');
  assert.equal((await second).workspaceKey,'products.second');
  assert.equal(starts,1);
  await client.stop();
});

test('switching runtime during startup cannot strand the original request', async () => {
  const delayed=fakeHost.replace("process.stdout.write(JSON.stringify({type:'ready',protocolVersion:1})+'\\n');", "setTimeout(()=>process.stdout.write(JSON.stringify({type:'ready',protocolVersion:1})+'\\n'),80);");
  let starts=0;
  const client=new ToolProcessClient({spawnProcess:()=>{starts++;return spawn(process.execPath,['-e',delayed],{stdio:['pipe','pipe','pipe']});}});
  const tool={toolPath:'/tool',toolHome:'/original'};
  const original=client.request(tool,'svn',['write'],'products.first');
  await assert.rejects(client.request({...tool,toolHome:'/other'},'svn',['write'],'products.other'),/正在启动或写入/);
  assert.equal((await original).kind,'write');
  assert.equal(starts,1);
  await client.stop();
});

test('active cancellation on an older host waits for the real result without sending unknown frames', async () => {
  const host=`const readline=require('node:readline');process.stdout.write(JSON.stringify({type:'ready',protocolVersion:1})+'\\n');
    readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
      if(r.type==='cancel')process.exit(7);
      process.stderr.write('started\\n');setTimeout(()=>process.stdout.write(JSON.stringify({id:r.id,type:'result',ok:true,result:{finished:true}})+'\\n'),80);});`;
  let cancel;
  const messages=[];
  const token={isCancellationRequested:false,onCancellationRequested(callback){cancel=callback;return {dispose(){}};}};
  const client=new ToolProcessClient({spawnProcess:()=>spawn(process.execPath,['-e',host],{stdio:['pipe','pipe','pipe']})});
  const result=await client.request({toolPath:'/tool',toolHome:'/home'},'reindex',[],'products.demo',undefined,
    {token,onOutput:value=>{messages.push(value);if(value.includes('started'))cancel();}});
  assert.equal(result.finished,true);assert.match(messages.join(''),/版本不支持协作式取消/);
  await client.stop();
});

test('classifies SVN mutations as writes so they cannot be replayed as reads', () => {
  assert.equal(requestKind('svn', ['auth-cache']), 'write');
  assert.equal(requestKind('svn', ['refresh']), 'write');
  assert.equal(requestKind('svn', ['scm-status']), 'read');
  assert.equal(requestKind('svn', ['page-query']), 'read');
});

test('allows full SVN checkout and indexing to exceed the normal ToolHost wait', () => {
  assert.equal(requestTimeoutMs('svn', ['sync-from-config']), 30 * 60 * 1000);
  assert.equal(requestTimeoutMs('svn', ['sync-from-script']), 30 * 60 * 1000);
  assert.equal(requestTimeoutMs('svn', ['sync-from-bat']), 30 * 60 * 1000);
  assert.equal(requestTimeoutMs('svn', ['init']), 30 * 60 * 1000);
  assert.equal(requestTimeoutMs('svn', ['refresh']), 30 * 60 * 1000);
  assert.equal(requestTimeoutMs('reindex'), 30 * 60 * 1000);
  assert.equal(requestTimeoutMs('svn', ['write']), 120000);
});

test('restarts a crashed read once and never replays an uncertain write', async () => {
  const crashHost = `
const readline = require('node:readline');
process.stdout.write(JSON.stringify({type:'ready',protocolVersion:1})+'\\n');
readline.createInterface({input:process.stdin}).on('line', () => process.exit(7));
`;
  let readStarts = 0;
  const readClient = new ToolProcessClient({
    spawnProcess: () => spawn(process.execPath, ['-e', ++readStarts === 1 ? crashHost : fakeHost], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  });
  const tool = { toolPath: '/unused', toolHome: '/unused-home' };
  assert.equal((await readClient.request(tool, 'workspaces')).kind, 'read');
  assert.equal(readStarts, 2);
  await readClient.stop();

  let writeStarts = 0;
  const writeClient = new ToolProcessClient({
    spawnProcess: () => {
      writeStarts += 1;
      return spawn(process.execPath, ['-e', crashHost], { stdio: ['pipe', 'pipe', 'pipe'] });
    },
  });
  await assert.rejects(writeClient.request(tool, 'svn', ['write']), /写入结果未知/);
  assert.equal(writeStarts, 1);
});

test('terminates a timed-out ToolHost before retrying a read', async () => {
  const idleHost = `
process.stdout.write(JSON.stringify({type:'ready',protocolVersion:1})+'\\n');
process.stdin.resume();
`;
  let starts = 0;
  const client = new ToolProcessClient({
    spawnProcess: () => spawn(process.execPath, ['-e', ++starts === 1 ? idleHost : fakeHost], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  });
  const tool = { toolPath: '/unused', toolHome: '/unused-home' };
  assert.equal((await client.request(tool, 'workspaces', [], '', undefined, { timeoutMs: 50 })).kind, 'read');
  assert.equal(starts, 2);
  await client.stop();
});

test('oversized unterminated ToolHost output terminates without replaying reads', async () => {
  let starts = 0;
  const client = new ToolProcessClient({ spawnProcess: () => {
    starts += 1;
    return spawn(process.execPath, ['-e', `process.stdout.write(JSON.stringify({type:'ready',protocolVersion:1})+'\\n'); process.stdin.on('data',()=>process.stdout.write('x'.repeat(9*1024*1024)));`], {stdio:['pipe','pipe','pipe']});
  } });
  try {
    await assert.rejects(client.request({toolPath:'/unused',toolHome:'/unused'}, 'workspaces'), /协议输出超过限制/);
    assert.equal(starts, 1);
  } finally { await client.stop(); }
});

test('write timeouts settle even when the host ignores SIGTERM', async () => {
  const client = new ToolProcessClient({ spawnProcess: () => spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>{}); process.stdout.write(JSON.stringify({type:'ready',protocolVersion:1})+'\\n'); process.stdin.resume();`], {stdio:['pipe','pipe','pipe']}) });
  try {
    await assert.rejects(client.request({toolPath:'/unused',toolHome:'/unused'}, 'pull', [], 'products.demo', undefined, {timeoutMs:20}), /写入等待超时，结果未知/);
  } finally { await client.stop(); }
});

test('Node command classification and timeouts derive from the Python authority byte for byte', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const authority = fs.readFileSync(path.resolve(__dirname, '../../../../scripts/common/command_metadata.json'));
  const bundled = fs.readFileSync(path.resolve(__dirname, '../data/tool-command-metadata.json'));
  assert.ok(authority.equals(bundled), 'Run npm run build:bridge after editing command_metadata.json');
  const metadata = JSON.parse(authority.toString('utf8'));
  for (const [command, entry] of Object.entries(metadata.commands)) {
    assert.equal(requestKind(command), entry.kind, command);
    assert.equal(requestTimeoutMs(command), entry.timeoutMs, command);
  }
  for (const [action, entry] of Object.entries(metadata.svnActions)) {
    assert.equal(requestKind('svn', [action]), entry.kind, action);
    assert.equal(requestTimeoutMs('svn', [action]), entry.timeoutMs, action);
  }
  assert.equal(requestKind('unknown-command'), 'write');
  assert.equal(requestKind('svn', ['unknown-action']), 'write');
  assert.equal(requestKind('svn', ['toString']), 'write');
  assert.equal(requestTimeoutMs('unknown-command'), metadata.defaultTimeoutMs);
});


test('artifact output flags are non-replayable on both query families', () => {
  assert.equal(requestKind('context-pack', ['--write-context']), 'write');
  assert.equal(requestKind('database-query-readonly', ['--output=result.csv']), 'write');
  assert.equal(requestKind('database-diagnose', ['--output', 'result.csv']), 'write');
  assert.equal(requestKind('context-pack', ['--include-source']), 'read');
});


test('read metadata remains responsive during a long write without replaying it', async()=>{
 const host=`const readline=require('node:readline');let held;
 process.stdout.write(JSON.stringify({type:'ready',protocolVersion:1})+'\\n');
 const done=r=>process.stdout.write(JSON.stringify({id:r.id,type:'result',ok:true,result:{command:r.command}})+'\\n');
 readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
 if(r.releaseTestWrite){done(held);held=null;}else if(r.command==='sync-source')held=r;else done(r);});`;
 let starts=0;const client=new ToolProcessClient({spawnProcess:()=>{starts+=1;return spawn(process.execPath,['-e',host],{stdio:['pipe','pipe','pipe']});}});
 const tool={toolPath:'/unused',toolHome:'/unused-home'};
 const writing=client.request(tool,'sync-source',[],'products.demo');
 writing.catch(()=>{});
 try {
  while(!client.active)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal((await client.request(tool,'workspaces')).command,'workspaces');
  assert.equal(starts,2);assert.equal(client.active.kind,'write');
  client.child.stdin.write(JSON.stringify({releaseTestWrite:true})+'\n');
  assert.equal((await writing).command,'sync-source');
 } finally {await client.stop();}
 assert.equal(client.child,null);assert.equal(client.readClient,null);
});


test('workspace identity derives the same public metadata contract as Python',()=>{
 const {isWorkspaceKey}=require('../src/workspace-identity');
 for(const key of ['products.demo','projects.123','products.a_b-c.d'])assert.equal(isWorkspaceKey(key),true);
 for(const key of ['',null,undefined,'products..','projects._bad','projects../x','PRD demo'])assert.equal(isWorkspaceKey(key),false);
});

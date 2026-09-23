const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { ToolProcessClient, requestKind } = require('../src/tool-process-client');

const fakeHost = `
const readline = require('node:readline');
process.stdout.write(JSON.stringify({type:'ready',protocolVersion:1})+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({id:request.id,type:'result',ok:true,result:{command:request.command,kind:request.requestKind}})+'\\n');
});
`;

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

test('classifies SVN mutations as writes so they cannot be replayed as reads', () => {
  assert.equal(requestKind('svn', ['auth-cache']), 'write');
  assert.equal(requestKind('svn', ['refresh']), 'write');
  assert.equal(requestKind('svn', ['scm-status']), 'read');
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

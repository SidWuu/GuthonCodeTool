const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { ToolJsonClient } = require('../src/tool-json-client');

test('JSON transport keeps semantic error codes for configuration preflight',async()=>{
 const client=new ToolJsonClient({getTool:async()=>({toolPath:'/tool',toolHome:'/home'}),processClient:{request:async()=>({ok:false,error:{code:'CONFIG_INVALID',message:'bad configuration'}})}});
 await assert.rejects(client.run('products.demo','database-target-list'),error=>error.code==='CONFIG_INVALID' && error.message==='bad configuration');
});

test('reused transport forwards execution and queue timeouts without changing workspace identity',async()=>{
  let request;
  const client=new ToolJsonClient({getTool:async()=>({toolPath:'/tool',toolHome:'/home'}),
    processClient:{request:async(...args)=>{request=args;return {ok:true};}}});
  const onOutput=()=>{};
  await client.run('products.demo','search',['--query','save'],undefined,{timeoutMs:37,queueTimeoutMs:43,onOutput});
  assert.equal(request[3],'products.demo');assert.deepEqual(request[5],{timeoutMs:37,queueTimeoutMs:43,onOutput});
});

test('shared one-shot transport bounds output and never retries an unknown write', async () => {
  const kills = [], children = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = {end() {}}; child.kill = signal => kills.push(signal);
    children.push(child);
    process.nextTick(() => child.stdout.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1)));
    return child;
  };
  const client = new ToolJsonClient({getTool:async()=>({toolPath:'/tool',toolHome:'/home'}),spawnProcess});
  await assert.rejects(client.run('products.demo','svn',['write']), /超过 4 MiB/);
  assert.equal(children.length, 1);
  assert.deepEqual(kills, ['SIGTERM']);
  children[0].emit('close', 1);
});

test('shared one-shot write timeout makes uncertainty explicit and kills once', async () => {
  const kills = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = {end() {}}; child.kill = signal => kills.push(signal);
  const client = new ToolJsonClient({getTool:async()=>({toolPath:'/tool',toolHome:'/home'}),spawnProcess:()=>child});
  await assert.rejects(client.run('products.demo','svn',['write'],{}, {timeoutMs:5}), /写入结果未知/);
  assert.deepEqual(kills, ['SIGTERM']);
  child.emit('close', 1);
});

test('routes a generic JSON command through the selected workspace', async () => {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: (input) => { calls[0].input = input; } };
    calls.push({ command, args, options });
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, items: [] })));
      child.emit('close', 0);
    });
    return child;
  };
  const client = new ToolJsonClient({
    getTool: async () => ({ toolPath: '/tool', toolHome: '/home' }),
    spawnProcess,
  });

  await client.run('projects.demo', 'search', ['--query', 'save']);
  assert.deepEqual(calls[0].args, [
    'search', '--home', '/home', '--workspace', 'projects.demo', '--', '--query', 'save',
  ]);
  assert.equal(calls[0].options.shell, false);
});

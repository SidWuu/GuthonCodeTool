const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const target = {origin:'http://platform.test', systemId:'SYS-1', dataSourceId:'0001',
  procedureId:'PR-1', procedureAlias:'pkg.temp', funId:'sample'};
const operationId = 'a'.repeat(64);

test('DATABASE native save requires signed-out ownership and forwards the reviewed version without submitting', async () => {
  const calls = [];
  let owner = 'OTHER', code = 0;
  const box = {location:{origin:target.origin,pathname:'/guthon/index.html'}, TextEncoder, URLSearchParams, AbortSignal, btoa,
    async fetch(endpoint, options) {
      const body = Object.fromEntries(options.body || []);
      calls.push({endpoint,body});
      if (endpoint === '/develop/login/isLogin.htm') assert.equal(options.method,'GET');
      const responses = {
        '/develop/procedure/admin/getProcTree.htm': {list:[{procedureId:'PR-1',procedureAliasId:'pkg.temp'}]},
        '/develop/procedure/admin/getFunInfo.htm': {bean:{...target,versionMac:'v1',funScript:'before',checkOutUserId:owner}},
        '/develop/login/isLogin.htm': {user:{userId:'TESTER'}},
      };
      if (endpoint in responses) return {ok:true,json:async()=>({code:0,data:responses[endpoint]})};
      assert.equal(endpoint, '/develop/procedure/admin/saveFunScript.htm');
      return {ok:true,json:async()=>({code,message:code ? '函数已被其他人修改，请核实后再保存' : ''})};
    }};
  vm.runInNewContext(fs.readFileSync(require.resolve('./database-procedure.js'),'utf8'),box);
  const input = {action:'save',target,systemId:'SYS-1',dataSourceId:'0001',
    evidence:{operationId,expectedVersion:'v1',content:'after'}};
  assert.equal((await box.runDatabaseProcedure(input)).rejected,'CHECKOUT_REQUIRED');
  assert.equal(calls.some(call=>call.endpoint.endsWith('saveFunScript.htm')),false);
  owner='TESTER';
  assert.equal((await box.runDatabaseProcedure(input)).acknowledged,true);
  const {body}=calls.at(-1);
  assert.equal(body.versionMac,'v1');
  assert.equal(body.flag,'0');
  assert.equal(JSON.parse(Buffer.from(decodeURIComponent(body.funScript),'base64').toString()).script,'after');
  code=1;
  assert.equal((await box.runDatabaseProcedure(input)).rejected,'PLATFORM_VERSION_CHANGED');
});

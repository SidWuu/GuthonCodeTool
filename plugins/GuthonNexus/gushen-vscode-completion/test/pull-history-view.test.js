const test = require('node:test');
const assert = require('node:assert/strict');
const {pullHistoryMarkdown} = require('../src/pull-history-view');
test('pull history view renders metadata and makes partial log windows explicit', () => {
  const markdown = pullHistoryMarkdown({workspaceKey:'projects.demo', returned:1, truncated:true, coverage:'retained window',
    entries:[{time:'2026-10-03',log:'workspace',trigger:'manual',ok:true,summary:{sourceId:'a|b',funId:'save'},payload:{password:'secret'},content:'source'}],
    scan:[{log:'workspace',rotated:false,scannedLines:2,malformedLines:1,windowTruncated:true}]});
  assert.match(markdown, /a\\\|b/);
  assert.match(markdown, /较早字节未读取/);
  assert.match(markdown, /更多保留记录未展示/);
  assert.ok(!markdown.includes('secret'));
  assert.ok(!markdown.includes('source'));
});

const {showPullHistory,maintainPullHistory} = require('../src/pull-history-view');
function ui(actions = []) {
  return {
    workspace:{openTextDocument:async(document)=>document},
    window:{showTextDocument:async()=>{},showQuickPick:async()=>actions.shift(),showInputBox:async()=>actions.shift(),showInformationMessage:async()=>undefined},
  };
}
test('history follows backend cursor and refuses changing snapshots', async () => {
  const calls=[];
  const vscode=ui([{value:'next'}]);
  const client={run:async(...args)=>{calls.push(args);return {workspaceKey:'projects.demo',entries:[],generation:'g1',nextCursor:calls.length===1?'cursor1':null,complete:calls.length===2};}};
  await showPullHistory({vscode,client,workspaceKey:'projects.demo'});
  assert.deepEqual(calls[1][2],['tail','--limit','100','--cursor','cursor1']);
  let page=0;
  await assert.rejects(showPullHistory({vscode:ui([{value:'next'}]),workspaceKey:'projects.demo',client:{run:async()=>({workspaceKey:'projects.demo',entries:[],generation:++page===1?'g1':'g2',nextCursor:'next'})}}),/快照/);
});

test('cancelled archival runs only preview; explicit workspace confirmation passes fixed plan hash', async () => {
  const hash='a'.repeat(64), calls=[];
  const client={run:async(...args)=>{calls.push(args);return {workspaceKey:'projects.demo',planHash:hash,candidateCount:2,archivedCount:2,archiveId:'archive-42'};}};
  await maintainPullHistory({vscode:ui(['2026-10-01',undefined]),client,workspaceKey:'projects.demo',action:'archive'});
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0][2],['archive','--before','2026-10-01','--check']);
  calls.length=0;
  await maintainPullHistory({vscode:ui(['2026-10-01','projects.demo']),client,workspaceKey:'projects.demo',action:'archive'});
  assert.equal(calls.length,2);
  assert.deepEqual(calls[1][2],['archive','--before','2026-10-01','--confirmation','projects.demo','--plan-hash',hash]);
});

test('restoration requires exact archive and workpace; rejects mismatched preview identity', async () => {
  const calls=[];
  const client={run:async(...args)=>{calls.push(args);return {workspaceKey:'projects.demo',planHash:'b'.repeat(64),archiveId:'archive-42',state:'COMPLETE'};}};
  await maintainPullHistory({vscode:ui(['archive-42','wrong']),client,workspaceKey:'projects.demo',action:'restore'});
  assert.equal(calls.length,1);
  await assert.rejects(maintainPullHistory({vscode:ui(['archive-42']),client:{run:async()=>({workspaceKey:'projects.other',planHash:'b'.repeat(64)})},workspaceKey:'projects.demo',action:'restore'}),/身份/);
});

test('export passes the fixed observed generation and validates private artifact path', async (t) => {
  const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-history-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'context'));const artifactPath=path.join(root,'context','history.json');await fs.writeFile(artifactPath,'{}');
  const calls=[];
  const client={run:async(...args)=>{calls.push(args);return calls.length===1
    ? {workspaceKey:'projects.demo',entries:[],generation:'fixed-generation'}
    : {workspaceKey:'projects.demo',artifactPath};}};
  await showPullHistory({vscode:ui([{value:'json'}]),client,workspaceKey:'projects.demo',workspaceRoot:root});
  assert.deepEqual(calls[1][2],['export','--format','json','--generation','fixed-generation']);
  const {verifyHistoryArtifact}=require('../src/pull-history-view');
  await assert.rejects(verifyHistoryArtifact({workspaceKey:'projects.demo',artifactPath:__filename},'projects.demo',root),/边界/);
});

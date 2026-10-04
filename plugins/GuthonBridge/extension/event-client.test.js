const test = require('node:test');
const assert = require('node:assert/strict');
const {consume} = require('./event-client');
test('authenticated stream parser handles split UTF-8 frames and ignores heartbeat comments', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\n\nevent: navigate\ndata: {"label":"中文"}\n\n');
  const values = [];
  const stream = new ReadableStream({start(controller) {for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close();}});
  await consume(new Response(stream, {headers: {'content-type': 'text/event-stream'}}), (event, data) => values.push({event, data}));
  assert.deepEqual(values, [{event: 'navigate', data: {label: '中文'}}]);
});
test('stream parser rejects wrong content type and unbounded frame', async () => {
  await assert.rejects(() => consume(new Response('{}'), () => {}), /连接失败/);
  await assert.rejects(() => consume(new Response('a'.repeat(65537), {headers: {'content-type': 'text/event-stream'}}), () => {}), /过大/);
});

(function(root) {
  // Fetch is used instead of EventSource so the pairing token stays in a header.
  async function consume(response, onEvent) {
    if (!response.ok || !response.headers?.get('content-type')?.startsWith('text/event-stream')) throw new Error('Bridge 事件连接失败');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, {stream: true});
        if (buffer.length > 65536) throw new Error('Bridge 事件帧过大');
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          let event = ''; const data = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          if (event && data.length) await onEvent(event, JSON.parse(data.join('\n')));
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  root.GuthonBridgeEvents = {consume};
  if (typeof module === 'object' && module.exports) module.exports = {consume};
})(globalThis);

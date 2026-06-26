// ============================================================================
//  Net — thin WebSocket client wrapper
// ============================================================================
const Net = (() => {
  let ws = null;
  let onMessage = () => {};
  let onOpen = () => {};
  let onClose = () => {};
  let pingTimer = null;
  let latency = 0;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      onOpen();
      pingTimer = setInterval(() => send({ type: 'ping', t: Date.now() }), 3000);
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'pong') { latency = Date.now() - m.t; return; }
      onMessage(m);
    };
    ws.onclose = () => { clearInterval(pingTimer); onClose(); setTimeout(connect, 1500); };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  return {
    connect, send,
    set onMessage(fn) { onMessage = fn; },
    set onOpen(fn) { onOpen = fn; },
    set onClose(fn) { onClose = fn; },
    get latency() { return latency; },
    get ready() { return ws && ws.readyState === WebSocket.OPEN; }
  };
})();

'use strict';
// WebSocket 联机：自动重连 + 快照缓冲（供插值渲染）。
const Net = (() => {
  let ws = null;
  let reconnectDelay = 500;
  let pingTimer = null;

  const state = {
    connected: false,
    myId: 0,
    world: null,          // welcome 里的地图数据
    car: { r: 26, hp: 100 },
    respawnMs: 3000,
    prevSnap: null,       // 上一个快照 { data, at }
    curSnap: null,        // 最新快照
    boards: { live: [], history: [] },
    ping: 0,
    handlers: {}          // type -> fn，由其他模块注册
  };

  function url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host;
  }

  function connect() {
    ws = new WebSocket(url());

    ws.onopen = () => {
      state.connected = true;
      reconnectDelay = 500;
      emit('_open');
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ type: 'ping', t: Date.now() }), 2000);
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      switch (msg.type) {
        case 'welcome':
          state.myId = msg.id;
          state.world = msg.world;
          state.car = msg.car;
          state.respawnMs = msg.respawnMs;
          state.prevSnap = state.curSnap = null;
          break;
        case 'state':
          state.prevSnap = state.curSnap;
          state.curSnap = { data: msg, at: performance.now() };
          break;
        case 'boards':
          state.boards = { live: msg.live || [], history: msg.history || [] };
          break;
        case 'pong':
          state.ping = Date.now() - msg.t;
          break;
      }
      emit(msg.type, msg);
    };

    ws.onclose = () => {
      state.connected = false;
      clearInterval(pingTimer);
      emit('_close');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 5000);
    };

    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function on(type, fn) {
    (state.handlers[type] = state.handlers[type] || []).push(fn);
  }
  function emit(type, msg) {
    const list = state.handlers[type];
    if (list) for (const fn of list) fn(msg);
  }

  // 插值：返回渲染用玩家列表（在上一帧和当前帧之间 lerp）
  function lerpPlayers() {
    const cur = state.curSnap;
    if (!cur) return [];
    const prev = state.prevSnap;
    if (!prev) return cur.data.players;

    const gap = Math.max(cur.at - prev.at, 16);
    let f = (performance.now() - cur.at) / gap;
    f = Math.max(0, Math.min(f, 1.25)); // 允许少量外推

    const prevMap = new Map();
    for (const p of prev.data.players) prevMap.set(p.id, p);

    return cur.data.players.map(p => {
      const q = prevMap.get(p.id);
      if (!q || p.dd !== q.dd) return p;
      let da = p.a - q.a;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      return Object.assign({}, p, {
        x: q.x + (p.x - q.x) * f,
        y: q.y + (p.y - q.y) * f,
        a: q.a + da * f
      });
    });
  }

  return { state, connect, send, on, lerpPlayers };
})();

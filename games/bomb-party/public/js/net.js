'use strict';

// WebSocket 连接管理：自动重连（指数退避），JSON 收发。
// 支持部署在子路径后面（按当前页面路径推导 ws 地址）。

window.Net = (function () {
  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const base = location.pathname.replace(/\/[^/]*$/, '');
    return proto + '//' + location.host + base + '/ws';
  }

  function create({ onMessage, onOpen, onClose }) {
    let ws = null;
    let backoff = 500;
    let closedByUser = false;

    function connect() {
      ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        backoff = 500;
        if (onOpen) onOpen();
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        onMessage(msg);
      };
      ws.onclose = () => {
        if (onClose) onClose();
        if (closedByUser) return;
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 1.7, 5000);
      };
      ws.onerror = () => ws.close();
    }

    connect();

    return {
      send(msg) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      get connected() {
        return ws && ws.readyState === WebSocket.OPEN;
      },
      destroy() {
        closedByUser = true;
        if (ws) ws.close();
      },
    };
  }

  return { create };
})();

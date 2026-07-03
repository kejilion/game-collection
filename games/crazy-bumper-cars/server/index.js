'use strict';
// 疯狂碰碰车服务端：Express 静态托管 + 同端口 WebSocket，一个 URL 搞定联机。
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const C = require('./config');
const { World } = require('./world');
const leaderboard = require('./leaderboard');

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/healthz', (_req, res) => res.json({ ok: true, players: world.players.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 2048 });

const world = new World();
world.onDeath = (p) => leaderboard.record(p); // 死亡时把这条命的成绩写入历史榜

const sockets = new Map(); // ws -> playerId (0 = 已连接未加入)

const CTRL_RE = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(obj, joinedOnly = false) {
  const raw = JSON.stringify(obj);
  for (const [ws, pid] of sockets) {
    if (joinedOnly && !pid) continue;
    if (ws.readyState === 1 && ws.bufferedAmount < C.BACKPRESSURE_BYTES) ws.send(raw);
  }
}

function cleanName(raw) {
  let name = String(raw || '').replace(CTRL_RE, '').replace(/[<>]/g, '').trim();
  if (!name) name = '无名车手';
  if (name.length > C.NAME_MAX) name = name.slice(0, C.NAME_MAX);
  return name;
}

wss.on('connection', (ws) => {
  sockets.set(ws, 0);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // 一连上就先给排行榜，菜单页也能看到
  send(ws, { type: 'boards', live: world.liveBoard(10), history: leaderboard.top(10) });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg.type !== 'string') return;
    const pid = sockets.get(ws);
    const player = pid ? world.players.get(pid) : null;

    switch (msg.type) {
      case 'join': {
        if (player) break; // 已经在场上
        if (world.players.size >= C.MAX_PLAYERS) { send(ws, { type: 'full' }); break; }
        const name = cleanName(msg.name);
        const color = Number.isInteger(msg.color) ? ((msg.color % C.COLORS) + C.COLORS) % C.COLORS : Math.floor(Math.random() * C.COLORS);
        const p = world.addPlayer(name, color);
        sockets.set(ws, p.id);
        send(ws, {
          type: 'welcome',
          id: p.id,
          world: { w: C.WORLD.w, h: C.WORLD.h, bumpers: C.BUMPERS, saws: C.SAWS, pads: C.PADS },
          car: { r: C.CAR.r, hp: C.CAR.hp },
          respawnMs: C.RESPAWN_MS
        });
        broadcast({ type: 'sys', text: `🚗 ${name} 冲进了战场！` });
        console.log(`[join] #${p.id} ${name} (在线 ${world.players.size})`);
        break;
      }
      case 'input': {
        if (player && !player.dead) world.setInput(pid, msg);
        break;
      }
      case 'chat': {
        if (!player) break;
        const t = world.time;
        if (t < player.chatReadyAt) break;
        player.chatReadyAt = t + C.CHAT.cooldownMs;
        const text = String(msg.text || '').replace(CTRL_RE, '').trim().slice(0, C.CHAT.maxLen);
        if (!text) break;
        broadcast({ type: 'chat', from: player.name, c: player.color, text });
        break;
      }
      case 'horn': {
        if (!player || player.dead) break;
        const t = world.time;
        if (t < (player.hornReadyAt || 0)) break;
        player.hornReadyAt = t + 400;
        world.events.push({ e: 'horn', x: Math.round(player.x), y: Math.round(player.y), id: player.id });
        break;
      }
      case 'leave': {
        if (!player) break;
        leaderboard.record(player);
        world.removePlayer(pid);
        sockets.set(ws, 0);
        broadcast({ type: 'sys', text: `👋 ${player.name} 离开了战场` });
        break;
      }
      case 'ping': {
        send(ws, { type: 'pong', t: msg.t });
        break;
      }
    }
  });

  ws.on('close', () => {
    const pid = sockets.get(ws);
    sockets.delete(ws);
    if (pid) {
      const p = world.players.get(pid);
      if (p) {
        leaderboard.record(p);
        world.removePlayer(pid);
        broadcast({ type: 'sys', text: `👋 ${p.name} 离开了战场` });
        console.log(`[leave] #${pid} ${p.name} (在线 ${world.players.size})`);
      }
    }
  });

  ws.on('error', () => { try { ws.terminate(); } catch (_) {} });
});

// ---- 模拟循环 ----
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25; // 进程卡顿时防止物理爆炸
  world.update(dt);
}, Math.round(1000 / C.TICK_RATE));

// ---- 快照广播 ----
setInterval(() => {
  if (sockets.size === 0) { world.events.length = 0; return; }
  broadcast(world.snapshot());
}, Math.round(1000 / C.BROADCAST_RATE));

// ---- 排行榜广播 ----
setInterval(() => {
  if (sockets.size === 0) return;
  broadcast({ type: 'boards', live: world.liveBoard(10), history: leaderboard.top(10) });
}, C.BOARDS_MS);

// ---- 心跳：清理僵尸连接 ----
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 30000);

server.listen(C.PORT, () => {
  console.log(`🚗💥 疯狂碰碰车服务器已启动: http://localhost:${C.PORT}`);
  console.log(`    数据目录: ${C.DATA_DIR}`);
});

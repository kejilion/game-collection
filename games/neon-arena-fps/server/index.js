// 霓虹竞技场 — 服务端入口：一个 URL 同时提供静态客户端与 WebSocket 联机（单房间）
'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const World = require('./world');
const board = require('./leaderboard');
const cfg = require('./config');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (req, res) => {
  res.json({ ok: true, players: world.players.size, spectators: countSpectators(), uptime: Math.round(process.uptime()) });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 4096 });

// ---------- 广播 ----------
function countSpectators() {
  let n = 0;
  for (const ws of wss.clients) if (ws.spectator) n++;
  return n;
}
function rawSend(ws, str, droppable) {
  if (ws.readyState !== 1) return;
  if (droppable && ws.bufferedAmount > 256 * 1024) return; // 客户端拥塞时丢弃状态帧
  try { ws.send(str); } catch (_) { /* 忽略 */ }
}
function broadcast(obj, droppable) {
  const str = JSON.stringify(obj);
  for (const ws of wss.clients) rawSend(ws, str, droppable);
}
function sendTo(id, obj) {
  const ws = sockets.get(id);
  if (ws) rawSend(ws, JSON.stringify(obj));
}

const sockets = new Map(); // playerId -> ws
const world = new World(broadcast, sendTo);

// 下发给新连接的静态定义（地图/武器/道具/商店），两端共用一份数据
const DEFS = {
  type: 'defs',
  map: cfg.MAP, weapons: cfg.WEAPONS, equips: cfg.EQUIPS, buffs: cfg.BUFFS,
  shop: cfg.SHOP, shopSlots: cfg.SHOP_SLOTS,
  rules: {
    maxHp: cfg.RULES.maxHp, maxArmor: cfg.RULES.maxArmor, baseSpeed: cfg.RULES.baseSpeed,
    jumpVel: cfg.RULES.jumpVel, gravity: cfg.RULES.gravity, eyeH: cfg.RULES.eyeH,
    pickupDist: cfg.RULES.pickupDist, merchantDist: cfg.RULES.merchantDist,
    respawnMs: cfg.RULES.respawnMs, protectMs: cfg.RULES.protectMs, shieldHp: cfg.RULES.shieldHp,
    dayMs: cfg.RULES.dayMs,
  },
  // 各类型 BOSS 的外形参数（客户端建模/命中预测用）
  bosses: Object.fromEntries(Object.entries(cfg.BOSSES).map(([k, b]) =>
    [k, { name: b.name, radius: b.radius, yc: b.yc, color: b.color }])),
};

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.spectator = false;
  ws.playerId = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  rawSend(ws, JSON.stringify(DEFS));
  rawSend(ws, JSON.stringify(world.boardMsg()));
  rawSend(ws, JSON.stringify(world.snapshot()));

  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch (_) { return; }
    if (!m || typeof m.type !== 'string') return;
    const p = ws.playerId ? world.players.get(ws.playerId) : null;
    switch (m.type) {
      case 'join': {
        if (p) return;
        if (world.players.size >= cfg.RULES.maxPlayers) { rawSend(ws, JSON.stringify({ type: 'err', text: '房间已满，稍后再试' })); return; }
        ws.spectator = false;
        const np = world.addPlayer(m.name);
        ws.playerId = np.id;
        sockets.set(np.id, ws);
        rawSend(ws, JSON.stringify({ type: 'joined', id: np.id, you: { coins: np.coins, owned: np.owned, eq: np.eq }, name: np.name }));
        break;
      }
      case 'spectate': {
        if (p) { world.removePlayer(p.id); sockets.delete(p.id); ws.playerId = 0; }
        ws.spectator = true;
        rawSend(ws, JSON.stringify({ type: 'spec' }));
        break;
      }
      case 'leave': {
        if (p) { world.removePlayer(p.id); sockets.delete(p.id); ws.playerId = 0; }
        ws.spectator = false;
        rawSend(ws, JSON.stringify({ type: 'left' }));
        break;
      }
      case 'move':   if (p) world.handleMove(p, m); break;
      case 'melee':  if (p) world.handleMelee(p, m); break;
      case 'fire':   if (p) world.handleFire(p, m); break;
      case 'nade':   if (p) world.handleNade(p, m); break;
      case 'reload': if (p) world.handleReload(p); break;
      case 'switch': if (p) world.handleSwitch(p, m); break;
      case 'pickup': if (p) world.handlePickup(p, m); break;
      case 'chat':   if (p) world.handleChat(p, m); break;
      case 'buy':    if (p) world.handleBuy(p, m); break;
      case 'equip':  if (p) world.handleEquipCos(p, m); break;
      case 'ping':   rawSend(ws, JSON.stringify({ type: 'pong', t: m.t })); break;
    }
  });

  ws.on('close', () => {
    if (ws.playerId) { world.removePlayer(ws.playerId); sockets.delete(ws.playerId); }
  });
  ws.on('error', () => { /* close 会跟着触发 */ });
});

// 心跳：清理断线连接
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) { /* 忽略 */ }
  }
}, 15000);

// 模拟循环 30Hz
let last = Date.now();
setInterval(() => {
  const t = Date.now();
  const dt = Math.min(0.25, (t - last) / 1000);
  last = t;
  try { world.update(dt); } catch (e) { console.error('[world] update 异常:', e); }
}, 1000 / cfg.RULES.tickRate);

// 状态广播 15Hz（可丢帧）
setInterval(() => {
  if (wss.clients.size === 0) return;
  broadcast(world.snapshot(), true);
}, 1000 / cfg.RULES.broadcastRate);

// 排行榜广播 2s
setInterval(() => {
  if (wss.clients.size === 0) return;
  broadcast(world.boardMsg(), true);
}, 2000);

server.listen(PORT, () => {
  console.log(`[霓虹竞技场] 服务已启动: http://0.0.0.0:${PORT}  (单房间, 最多 ${cfg.RULES.maxPlayers} 人)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { board.saveNow(); process.exit(0); });
}

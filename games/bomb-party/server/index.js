'use strict';

// HTTP + WebSocket 服务端入口：
//  - express 提供 public/ 静态资源、/health 健康检查、/api/leaderboard
//  - ws 处理联机：单一常驻世界，所有连接进入同一房间
//  - 30Hz 推进模拟，15Hz 广播快照（事件跨帧累积，保证不丢）

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const C = require('./config');
const World = require('./world');
const { createLeaderboard } = require('./leaderboard');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const world = World.create();
const leaderboard = createLeaderboard(DATA_DIR);
const clients = new Map(); // ws -> { playerId }
const startedAt = Date.now();

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    players: world.players.size,
    monsters: world.monsters.length,
  });
});

app.get('/api/leaderboard', (req, res) => {
  res.json(leaderboard.top(10));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of clients.keys()) {
    if (ws.readyState === ws.OPEN) ws.send(raw);
  }
}

function rosterMsg() {
  return {
    t: 'roster',
    list: [...world.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      score: p.score,
      kills: p.kills,
      deaths: p.deaths,
      alive: p.alive,
    })),
  };
}

// 把玩家当前战绩写进历史排行榜（kills 按增量累计）
function recordPlayer(p) {
  if (!p) return;
  const delta = p.kills - (p._lbKills || 0);
  p._lbKills = p.kills;
  leaderboard.record(p.name, { score: p.score, killsDelta: delta });
}

function detachPlayer(meta) {
  if (meta.playerId == null) return;
  const p = world.players.get(meta.playerId);
  if (p) {
    recordPlayer(p);
    World.removePlayer(world, meta.playerId);
    console.log(`[leave] ${p.name} (#${p.id}) 玩家数=${world.players.size}`);
  }
  meta.playerId = null;
}

wss.on('connection', (ws) => {
  clients.set(ws, { playerId: null });
  send(ws, {
    t: 'hello',
    cols: C.COLS,
    rows: C.ROWS,
    grid: World.serializeGrid(world),
    tick: C.TICK_RATE,
    snapEvery: C.SNAP_EVERY,
    respawn: C.RESPAWN_DELAY,
    lb: leaderboard.top(5),
  });
  send(ws, rosterMsg());

  ws.on('message', (raw) => {
    if (raw.length > 512) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const meta = clients.get(ws);
    if (!meta) return;

    if (msg.t === 'join' && meta.playerId == null) {
      if (world.players.size >= C.MAX_PLAYERS) {
        send(ws, { t: 'full' });
        return;
      }
      const p = World.addPlayer(world, { name: msg.name, color: msg.color });
      meta.playerId = p.id;
      send(ws, { t: 'you', id: p.id });
      broadcast(rosterMsg());
      console.log(`[join] ${p.name} (#${p.id}) 玩家数=${world.players.size}`);
      return;
    }
    if (msg.t === 'ping') {
      send(ws, { t: 'pong', id: msg.id });
      return;
    }
    if (meta.playerId == null) return;
    if (msg.t === 'in') {
      World.setInput(world, meta.playerId, msg.d);
    } else if (msg.t === 'bomb') {
      World.requestBomb(world, meta.playerId);
    } else if (msg.t === 'leave') {
      // 回到选角：卸下玩家但保留连接
      detachPlayer(meta);
      broadcast(rosterMsg());
    }
  });

  ws.on('close', () => {
    const meta = clients.get(ws);
    clients.delete(ws);
    if (meta && meta.playerId != null) {
      detachPlayer(meta);
      broadcast(rosterMsg());
    }
  });

  ws.on('error', () => ws.close());
});

// ---------- 模拟主循环 ----------

const DT = 1 / C.TICK_RATE;
const DT_MS = 1000 / C.TICK_RATE;
let tickNum = 0;
let pendingEvents = [];

function tick() {
  World.step(world, DT);
  tickNum++;

  if (world.events.length > 0) {
    pendingEvents.push(...world.events);
    world.events = [];
  }
  if (tickNum % C.SNAP_EVERY !== 0) return;

  const events = pendingEvents;
  pendingEvents = [];

  // 死亡时写历史排行榜；名单类事件触发 roster 重发
  let rosterDirty = false;
  for (const ev of events) {
    if (ev.e === 'die') {
      recordPlayer(world.players.get(ev.id));
      rosterDirty = true;
    } else if (ev.e === 'join' || ev.e === 'leave' || ev.e === 'streak') {
      rosterDirty = true;
    }
  }

  // 当前领跑者（画皇冠用）
  let top = 0, topScore = -1;
  for (const p of world.players.values()) {
    if (p.score > topScore) { topScore = p.score; top = p.id; }
  }

  const r2 = (n) => Math.round(n * 100) / 100;
  const snap = {
    t: 's',
    n: tickNum,
    top,
    p: [...world.players.values()].map((p) => [
      p.id, r2(p.x), r2(p.y), p.dir,
      p.moving ? 1 : 0, p.alive ? 1 : 0,
      p.shield ? 1 : 0, p.spawnShield > 0 || p.invuln > 0 ? 1 : 0,
      p.maxBombs, p.range,
      Math.round((p.speed - C.BASE_SPEED) / C.SPEED_STEP),
      p.score, p.kills,
      p.alive ? 0 : r2(Math.max(0, p.deadUntil - world.time)),
    ]),
    m: world.monsters.map((m) => [m.id, m.typeIdx, r2(m.x), r2(m.y), m.dir]),
    b: world.bombs.map((b) => [b.id, b.x, b.y, r2(b.fuse), b.range]),
    f: world.blasts.map((f) => [f.x, f.y, f.part, f.dir]),
    u: world.powerups.map((u) => [u.id, u.x, u.y, u.kindIdx, r2(u.until - world.time)]),
    e: events,
  };
  broadcast(snap);
  if (rosterDirty) broadcast(rosterMsg());
}

// 定时器驱动 + 时间累积器：setInterval 在部分平台（尤其 Windows）实际
// 间隔明显大于请求值，直接“每次触发推进固定 DT”会让整个世界慢放。
// 这里按真实流逝时间补步，保证模拟严格贴合墙钟。
let lastLoop = Date.now();
let acc = 0;
setInterval(() => {
  const now = Date.now();
  acc += now - lastLoop;
  lastLoop = now;
  if (acc > 250) acc = 250; // 卡顿过久则丢弃积压，避免追帧雪崩
  while (acc >= DT_MS) {
    acc -= DT_MS;
    tick();
  }
}, 8);

// 定期把在线玩家战绩落盘，防止意外退出丢数据
setInterval(() => {
  for (const p of world.players.values()) recordPlayer(p);
}, 60 * 1000);

process.on('SIGTERM', () => {
  for (const p of world.players.values()) recordPlayer(p);
  leaderboard.flush();
  process.exit(0);
});
process.on('SIGINT', () => {
  for (const p of world.players.values()) recordPlayer(p);
  leaderboard.flush();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`💣 炸弹派对 Bomb Party 服务已启动: http://localhost:${PORT}`);
});

'use strict';

// HTTP + WebSocket 服务端入口：
//  - express 提供 public/ 静态资源、/health 健康检查、/api/leaderboard
//  - ws 处理联机：单一房间，所有连接进入同一世界
//  - 固定频率推进世界模拟并广播快照

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
    state: world.round.state,
    round: world.round.num,
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
      wins: p.wins,
      kills: p.kills,
      spec: p.spec,
      alive: p.alive,
    })),
  };
}

wss.on('connection', (ws) => {
  clients.set(ws, { playerId: null });
  send(ws, {
    t: 'hello',
    cols: C.COLS,
    rows: C.ROWS,
    grid: World.serializeGrid(world),
    tick: C.TICK_RATE,
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
      if (world.players.size >= 32) return; // 房间人数硬上限（含观战）
      const p = World.addPlayer(world, { name: msg.name });
      meta.playerId = p.id;
      send(ws, { t: 'you', id: p.id });
      broadcast(rosterMsg());
      console.log(`[join] ${p.name} (#${p.id}) 玩家数=${world.players.size}`);
      return;
    }
    if (meta.playerId == null) return;
    if (msg.t === 'in') {
      World.setInput(world, meta.playerId, msg.d);
    } else if (msg.t === 'bomb') {
      World.requestBomb(world, meta.playerId);
    } else if (msg.t === 'ping') {
      send(ws, { t: 'pong', id: msg.id });
    }
  });

  ws.on('close', () => {
    const meta = clients.get(ws);
    clients.delete(ws);
    if (meta && meta.playerId != null) {
      const p = world.players.get(meta.playerId);
      World.removePlayer(world, meta.playerId);
      broadcast(rosterMsg());
      if (p) console.log(`[leave] ${p.name} (#${p.id}) 玩家数=${world.players.size}`);
    }
  });

  ws.on('error', () => ws.close());
});

// ---------- 模拟主循环 ----------

const DT = 1 / C.TICK_RATE;
let tickNum = 0;

setInterval(() => {
  World.step(world, DT);
  tickNum++;

  const events = world.events;
  world.events = [];

  // 回合结束：写排行榜，同步 roster（wins 变了）
  let rosterDirty = false;
  for (const ev of events) {
    if (ev.e === 'end') {
      for (const p of world.players.values()) {
        if (!p.spec) leaderboard.record(p.name, { win: p.id === ev.id, score: p.score });
      }
      ev.lb = leaderboard.top(5);
      rosterDirty = true;
    } else if (ev.e === 'join' || ev.e === 'leave' || ev.e === 'round') {
      rosterDirty = true;
    }
  }

  const r2 = (n) => Math.round(n * 100) / 100;
  const snap = {
    t: 's',
    n: tickNum,
    st: world.round.state,
    rn: world.round.num,
    tl: Math.ceil(world.round.timeLeft),
    ct: r2(world.round.t),
    sd: world.sudden.active ? 1 : 0,
    p: [...world.players.values()]
      .filter((p) => !p.spec)
      .map((p) => [
        p.id, r2(p.x), r2(p.y), p.dir,
        p.moving ? 1 : 0, p.alive ? 1 : 0,
        p.shield ? 1 : 0, p.spawnShield > 0 || p.invuln > 0 ? 1 : 0,
        p.maxBombs, p.range,
        Math.round((p.speed - C.BASE_SPEED) / C.SPEED_STEP),
        p.score,
      ]),
    m: world.monsters.map((m) => [m.id, m.typeIdx, r2(m.x), r2(m.y), m.dir]),
    b: world.bombs.map((b) => [b.id, b.x, b.y, r2(b.fuse), b.range]),
    f: world.blasts.map((f) => [f.x, f.y, f.part, f.dir]),
    u: world.powerups.map((u) => [u.id, u.x, u.y, u.kindIdx]),
    e: events,
  };
  broadcast(snap);
  if (rosterDirty) broadcast(rosterMsg());
}, 1000 / C.TICK_RATE);

process.on('SIGTERM', () => {
  leaderboard.flush();
  process.exit(0);
});
process.on('SIGINT', () => {
  leaderboard.flush();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`💣 炸弹派对 Bomb Party 服务已启动: http://localhost:${PORT}`);
});

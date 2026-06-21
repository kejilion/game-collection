// ============================================================================
//  Arena Brawl — server entry point
//  Express serves the static client; ws runs the realtime game protocol.
//  One persistent World instance is created at boot and simulated forever
//  ("大地图场景实例一直待命"), independent of how many players are connected.
// ============================================================================
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const { World } = require('./world');
const leaderboard = require('./leaderboard');
const { WORLD, TICK_RATE, BROADCAST_RATE, CLASSES, ITEM_TYPES, SHOP } = require('./config');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, players: world.players.size, uptime: process.uptime() }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
wss.on('error', (e) => console.error('wss error:', e.message));
process.on('uncaughtException', (e) => console.error('uncaught:', e.message));

// ---- the always-on world ---------------------------------------------------
const world = new World();
const sockets = new Map();           // ws -> playerId

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
}
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) { try { ws.send(msg); } catch (e) {} }
}

// ---- connection handling ---------------------------------------------------
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});          // ignore abrupt-disconnect errors (would otherwise crash the process)

  // send static definitions right away so the menu can render class cards
  send(ws, { type: 'defs', classes: CLASSES, items: ITEM_TYPES, shop: SHOP });

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const pid = sockets.get(ws);
    const player = pid ? world.players.get(pid) : null;

    switch (m.type) {
      case 'join': {
        if (player) return;                              // already joined
        const clsId = CLASSES[m.cls] ? m.cls : 'warrior';
        let name = (typeof m.name === 'string' ? m.name : '').trim().slice(0, 14);
        if (!name) name = '无名英雄';
        const p = world.addPlayer(name, clsId);
        sockets.set(ws, p.id);
        world.itemsDirty = true;                 // ensure this joiner's first post-join state contains the item snapshot
        send(ws, {
          type: 'welcome', id: p.id, world: WORLD,
          classes: CLASSES, items: ITEM_TYPES, shop: SHOP,
          obstacles: world.getObstacles(), tickRate: TICK_RATE
        });
        broadcast({ type: 'sys', text: `${name} 加入了大乱斗！`, color: p.cls.color });
        break;
      }
      case 'input': if (player) world.setInput(player, m); break;
      case 'attack': if (player) world.doAttack(player); break;
      case 'skill': if (player && typeof m.slot === 'number') world.doSkill(player, m.slot); break;
      case 'chat':
        if (player && typeof m.text === 'string' && m.text.trim()) {
          world.setChat(player, m.text);
          broadcast({ type: 'chat', name: player.name, text: String(m.text).trim().slice(0, 80), color: player.cls.color });
        }
        break;
      case 'buy': if (player) { const r = world.buy(player, m.item); send(ws, { type: 'shopResult', ...r }); } break;
      case 'leave': {                                    // return to character select
        if (player) { leaderboard.record(player); world.removePlayer(player.id); sockets.delete(ws); }
        break;
      }
      case 'ping': send(ws, { type: 'pong', t: m.t }); break;
    }
  });

  ws.on('close', () => {
    const pid = sockets.get(ws);
    if (pid) {
      const p = world.players.get(pid);
      if (p) { leaderboard.record(p); world.removePlayer(pid); broadcast({ type: 'sys', text: `${p.name} 离开了战场`, color: '#9aa3b2' }); }
      sockets.delete(ws);
    }
  });
});

// drop dead connections
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; try { ws.ping(); } catch (e) {}
  }
}, 15000);

// ---- simulation + broadcast loops -----------------------------------------
let last = Date.now();
setInterval(() => {
  const t = Date.now();
  let dt = (t - last) / 1000; last = t;
  if (dt > 0.25) dt = 0.25;                  // clamp after long pauses
  world.update(dt);
}, Math.round(1000 / TICK_RATE));

setInterval(() => {
  if (wss.clients.size === 0) { world.fx.length = 0; return; }  // nobody listening
  broadcast({ type: 'state', ...world.serialize() });
}, Math.round(1000 / BROADCAST_RATE));

setInterval(() => {
  broadcast({ type: 'leaderboard', realtime: world.realtimeLeaderboard(8), historical: leaderboard.top(8) });
}, 1000);

server.listen(PORT, () => {
  console.log(`\n  ⚔  Arena Brawl 大乱斗 running`);
  console.log(`  ▶  http://localhost:${PORT}`);
  console.log(`  ▶  world ${WORLD.width}x${WORLD.height}, tick ${TICK_RATE}Hz, broadcast ${BROADCAST_RATE}Hz\n`);
});

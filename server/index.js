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
const { WORLD, TICK_RATE, BROADCAST_RATE, CLASSES, ITEM_TYPES, PERMANENT_SHOP_CATALOG, BOSS_DEFS } = require('./config');

const PORT = process.env.PORT || 3000;
const BACKPRESSURE_BYTES = 256 * 1024;   // skip a client's state frame while its send buffer is backed up
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// The client renders a 1:1 (no-zoom) camera, so it only ever sees a vw×vh slice
// of the world. Mirror that camera here and pad it so the server streams a client
// exactly what it can see (+ a margin so things appear before reaching the edge).
function viewRect(p, view) {
  const vw = (view && view.w) || 1280, vh = (view && view.h) || 720;
  const camX = clamp(p.x - vw / 2, 0, Math.max(0, WORLD.width - vw));
  const camY = clamp(p.y - vh / 2, 0, Math.max(0, WORLD.height - vh));
  const M = 280;
  return { x0: camX - M, y0: camY - M, x1: camX + vw + M, y1: camY + vh + M };
}

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
const spectators = new Set();        // ws set for spectator connections

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
  ws.view = { w: 1280, h: 720 };       // updated by the client's 'view' message; sane default until then
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});          // ignore abrupt-disconnect errors (would otherwise crash the process)

  // send static definitions right away so the menu can render class cards
  send(ws, { type: 'defs', classes: CLASSES, items: ITEM_TYPES, permanentShop: PERMANENT_SHOP_CATALOG, bosses: BOSS_DEFS });
  send(ws, { type: 'spectatorCount', count: spectators.size });

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const pid = sockets.get(ws);
    const player = pid ? world.players.get(pid) : null;

    switch (m.type) {
      case 'join': {
        if (player) return;                              // already joined
        if (spectators.has(ws)) return;                  // spectators can't join
        const clsId = CLASSES[m.cls] ? m.cls : 'warrior';
        let name = (typeof m.name === 'string' ? m.name : '').trim().slice(0, 14);
        if (!name) name = '无名英雄';
        const p = world.addPlayer(name, clsId);
        sockets.set(ws, p.id);
        send(ws, {
          type: 'welcome', id: p.id, world: WORLD,
          classes: CLASSES, items: ITEM_TYPES, permanentShop: PERMANENT_SHOP_CATALOG, bosses: BOSS_DEFS,
          obstacles: world.getObstacles(), tickRate: TICK_RATE,
          gold: p.gold,
          // permanent-shop "already bought" state for THIS match (so the shop
          // panel can render owned items as such). Resets every match because
          // the Player instance is fresh.
          owned: {
            equipment: [...p.boughtEquipment],
            cosmetics: { warrior: [...p.boughtCosmetics.warrior], mage: [...p.boughtCosmetics.mage], assassin: [...p.boughtCosmetics.assassin] }
          }
        });
        broadcast({ type: 'sys', text: `${name} 加入了大乱斗！`, color: p.cls.color });
        break;
      }
      case 'input': if (player) world.setInput(player, m); break;
      case 'attack': if (player) world.doAttack(player); break;
      case 'skill': if (player && typeof m.slot === 'number') world.doSkill(player, m.slot); break;
      case 'chat':
        if (player && typeof m.text === 'string' && m.text.trim()) {
          const t = Date.now();
          if (t < player.chatReadyAt) break;             // throttle: drop messages sent too fast
          player.chatReadyAt = t + 700;
          world.setChat(player, m.text);
          broadcast({ type: 'chat', name: player.name, text: String(m.text).trim().slice(0, 80), color: player.cls.color });
        }
        break;
      case 'buy': if (player) { const r = world.buy(player, m.item); send(ws, { type: 'shopResult', ...r }); } break;
      case 'shopPermanentBuy': if (player) { const r = world.permanentBuy(player, m.item); send(ws, { type: 'shopResult', ...r }); } break;
      case 'leave': {                                    // return to character select
        if (player) { leaderboard.record(player); world.removePlayer(player.id); sockets.delete(ws); }
        break;
      }
      case 'ping': send(ws, { type: 'pong', t: m.t }); break;
      case 'view':                                       // client viewport size, for area-of-interest culling
        if (typeof m.w === 'number' && typeof m.h === 'number')
          ws.view = { w: clamp(m.w | 0, 320, 4096), h: clamp(m.h | 0, 240, 4096) };
        break;
      case 'spectate': {
        if (player || spectators.has(ws)) return;
        spectators.add(ws);
        send(ws, {
          type: 'spectateWelcome', world: WORLD,
          classes: CLASSES, items: ITEM_TYPES, permanentShop: PERMANENT_SHOP_CATALOG, bosses: BOSS_DEFS,
          obstacles: world.getObstacles(), tickRate: TICK_RATE
        });
        broadcast({ type: 'spectatorCount', count: spectators.size });
        break;
      }
      case 'spectateLeave': {
        if (spectators.has(ws)) {
          spectators.delete(ws);
          broadcast({ type: 'spectatorCount', count: spectators.size });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const pid = sockets.get(ws);
    if (pid) {
      const p = world.players.get(pid);
      if (p) { leaderboard.record(p); world.removePlayer(pid); broadcast({ type: 'sys', text: `${p.name} 离开了战场`, color: '#9aa3b2' }); }
      sockets.delete(ws);
    }
    if (spectators.has(ws)) {
      spectators.delete(ws);
      broadcast({ type: 'spectatorCount', count: spectators.size });
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
  if (sockets.size === 0 && spectators.size === 0) { world.fx.length = 0; return; }
  world.prepareSnapshot();                                      // build the full snapshot once...
  for (const [ws, pid] of sockets) {                            // ...then send each player only its slice
    if (ws.readyState !== ws.OPEN) continue;
    if (ws.bufferedAmount > BACKPRESSURE_BYTES) continue;       // client can't keep up — skip this frame
    const p = world.players.get(pid);
    if (!p) continue;
    send(ws, { type: 'state', ...world.viewFor(viewRect(p, ws.view), p) });
  }
  for (const ws of spectators) {
    if (ws.readyState !== ws.OPEN) continue;
    if (ws.bufferedAmount > BACKPRESSURE_BYTES) continue;
    const full = { x0: -9999, y0: -9999, x1: WORLD.width + 9999, y1: WORLD.height + 9999 };
    send(ws, { type: 'state', ...world.viewFor(full, null, true) });   // spectators see everyone, incl. stealthed
  }
}, Math.round(1000 / BROADCAST_RATE));

// low-rate global blips so the minimap shows the whole map even with AoI culling
setInterval(() => {
  if (wss.clients.size === 0) return;
  broadcast({ type: 'overview', ...world.overview() });
}, 200);

setInterval(() => {
  broadcast({ type: 'leaderboard', realtime: world.realtimeLeaderboard(8), historical: leaderboard.top(8) });
}, 1000);

server.listen(PORT, () => {
  console.log(`\n  ⚔  Arena Brawl 大乱斗 running`);
  console.log(`  ▶  http://localhost:${PORT}`);
  console.log(`  ▶  world ${WORLD.width}x${WORLD.height}, tick ${TICK_RATE}Hz, broadcast ${BROADCAST_RATE}Hz\n`);
});

// 霓虹竞技场 — 服务端入口：一个 URL 同时提供静态客户端与 WebSocket 联机（单房间）
// 反作弊：AC_MODE=off 可关闭惩罚（冷却/数值等功能校验仍生效），详见 server/anticheat/README.md
'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const World = require('./world');
const board = require('./leaderboard');
const cfg = require('./config');
const { AntiCheat, fpsPreset, createJsonStore, TokenBucket, RATE_PRESETS } = require('./anticheat');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (req, res) => {
  res.json({
    ok: true, players: world.players.size, spectators: countSpectators(),
    uptime: Math.round(process.uptime()),
    anticheat: ac.status(),
  });
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

// ---------- 反作弊引擎 ----------
const acStore = createJsonStore(path.join(DATA_DIR, 'anticheat.json'));
const ac = new AntiCheat(fpsPreset({
  enabled: process.env.AC_MODE !== 'off',
  store: acStore,
  onAction(key, action, reason) {
    const ws = sockets.get(key);
    const p = world.players.get(key);
    if (action === 'warn') {
      sendTo(key, { type: 'acwarn', text: '⚠️ 检测到异常操作，请规范游戏行为' });
      return;
    }
    const label = action === 'ban'
      ? `你已被临时封禁：${reason}`
      : `你已被移出对局：${reason}`;
    if (p) broadcast({ type: 'sys', style: 'streak', text: `🚫 ${p.name} 因异常行为被系统${action === 'ban' ? '封禁' : '移出'}` });
    if (ws) {
      rawSend(ws, JSON.stringify({ type: 'kicked', text: label }));
      setTimeout(() => { try { ws.close(4001, 'anticheat'); } catch (_) { /* 忽略 */ } }, 60);
    }
  },
  log: e => console.warn(`[anticheat] ${e.name || e.key} ${e.rule} ${e.detail} → score=${e.score}`),
}));

// ---- 底层 TCP 瞬间涌入丢弃与自动封禁 (防大并发卡顿) ----
const tcpConnHistory = new Map(); // ip -> [timestamps]
server.on('connection', (socket) => {
  const rawIp = socket.remoteAddress;
  if (!rawIp) return;
  const ip = rawIp.replace(/^::ffff:/, '');
  const ipKey = 'ip:' + rawIp;
  const ban = ac.isBanned([ipKey]);
  if (ban) {
    socket.destroy();
    return;
  }
  const now = Date.now();
  let times = tcpConnHistory.get(ip) || [];
  times = times.filter(t => now - t < 2000);
  times.push(now);
  tcpConnHistory.set(ip, times);
  if (times.length > 6) {
    console.log(`[TCP-SURGE] IP ${ip} 瞬间涌入攻击，直接销毁并封禁。`);
    ac.registerBan([ipKey], 15, 'TCP 瞬间涌入攻击');
    socket.destroy();
  }
});
setInterval(() => ac.tick(1), 1000);

const world = new World(broadcast, sendTo, ac);

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

// ---- 连接防刷：同 IP 短时间内大量连接直接拒绝 ----
const connTracker = new Map();  // ip -> { times: [timestamps], blocked: until }
const CONN_WINDOW = 10000;      // 10 秒窗口
const CONN_MAX = 8;             // 窗口内最大连接数
const CONN_BLOCK_BASE = 30000;  // 首次封堵 30 秒
const CONN_BLOCK_MAX = 600000;  // 最高封堵 10 分钟
function checkConnFlood(ip) {
  const now = Date.now();
  let rec = connTracker.get(ip);
  if (!rec) { rec = { times: [], blocked: 0, strikes: 0 }; connTracker.set(ip, rec); }
  if (rec.blocked > now) return false;
  rec.times = rec.times.filter(t => now - t < CONN_WINDOW);
  rec.times.push(now);
  if (rec.times.length > CONN_MAX) {
    rec.strikes++;
    const blockMs = Math.min(CONN_BLOCK_BASE * Math.pow(2, rec.strikes - 1), CONN_BLOCK_MAX);
    rec.blocked = now + blockMs;
    rec.times = [];
    console.log(`[conn-flood] IP ${ip} blocked for ${Math.round(blockMs/1000)}s (strike #${rec.strikes})`);
    return false;
  }
  return true;
}
// 定时清理过期记录（每 60 秒）
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of connTracker) {
    if (rec.blocked < now && rec.times.length === 0) connTracker.delete(ip);
  }
}, 60000);

// ---- 同IP并发连接限制 ----
const IP_MAX_CONCURRENT = 4;
const ipConns = new Map();  // ip -> count
function ipConnAdd(ip) {
  const c = (ipConns.get(ip) || 0) + 1;
  ipConns.set(ip, c);
  return c;
}
function ipConnDel(ip) {
  const c = (ipConns.get(ip) || 1) - 1;
  if (c <= 0) ipConns.delete(ip); else ipConns.set(ip, c);
}

// ---- 名字黑名单正则 ----
const NAME_BLACKLIST = [
  /我是sb/i,
  /^sb\d*$/i,
  /习近平/,
  /毛泽[东西]/,
];
function isNameBlocked(name) {
  return NAME_BLACKLIST.some(re => re.test(name));
}

// ---- 挂机/纯送死检测 ----
const AFK_CHECK_INTERVAL = 15000;
const AFK_DEATH_THRESHOLD = 10;  // 死亡超过此数且0击杀
setInterval(() => {
  for (const [id, p] of world.players) {
    if (p.kills === 0 && p.deaths >= AFK_DEATH_THRESHOLD) {
      const ws = sockets.get(id);
      console.log(`[anti-grief] 踢出纯送死玩家: ${p.name} (0杀/${p.deaths}死)`);
      world.removePlayer(id);
      sockets.delete(id);
      if (ws) {
        ws.playerId = 0;
        rawSend(ws, JSON.stringify({ type: 'err', text: '长时间未参与战斗，已被移出' }));
        // 记录踢出到反作弊
        if (p.mon) ac.opts.store.addKick('ip:' + (p.ip || 'unknown'), 24*3600000);
        if (p.mon) ac.opts.store.addKick('name:' + p.name, 24*3600000);
      }
    }
  }
}, AFK_CHECK_INTERVAL);

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.spectator = false;
  ws.playerId = 0;
  ws.ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';
  if (!checkConnFlood(ws.ip)) { ws.close(4429, 'too many connections'); return; }
  if (ipConnAdd(ws.ip) > IP_MAX_CONCURRENT) { ipConnDel(ws.ip); ws.close(4429, 'too many concurrent'); return; }
  ws.preBucket = new TokenBucket(6, 12);   // 加入前的连接级限速
  ws.on('pong', () => { ws.isAlive = true; });
  rawSend(ws, JSON.stringify(DEFS));
  rawSend(ws, JSON.stringify(world.boardMsg()));
  rawSend(ws, JSON.stringify(world.snapshot()));

  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch (_) { return; }
    if (!m || typeof m.type !== 'string') return;
    const p = ws.playerId ? world.players.get(ws.playerId) : null;
    // 反作弊：分类型限速（未加入的连接走前置小桶）
    if (p && p.mon) {
      if (!p.mon.rate(m.type, ...(RATE_PRESETS[m.type] || RATE_PRESETS.default))) return;
    } else if (m.type !== 'ping' && !ws.preBucket.take()) return;

    switch (m.type) {
      case 'join': {
        if (p) return;
        if (world.players.size >= cfg.RULES.maxPlayers) { rawSend(ws, JSON.stringify({ type: 'err', text: '房间已满，稍后再试' })); return; }
        // 封禁门：IP 与昵称任一命中即拒绝
        const cleanName = String(m.name || '').replace(/[<>&"']/g, '').trim().slice(0, 12);
        if (isNameBlocked(cleanName)) {
          rawSend(ws, JSON.stringify({ type: 'err', text: '该昵称不可用' }));
          return;
        }
        const ban = ac.isBanned(['ip:' + ws.ip, 'name:' + cleanName]);
        if (ban) {
          const mins = Math.max(1, Math.ceil((ban.until - Date.now()) / 60000));
          rawSend(ws, JSON.stringify({ type: 'err', text: `你已被临时封禁（${ban.reason}），剩余约 ${mins} 分钟` }));
          return;
        }
        ws.spectator = false;
        const np = world.addPlayer(m.name, ws.ip);
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
    ipConnDel(ws.ip);
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
  console.log(`[霓虹竞技场] 服务已启动: http://0.0.0.0:${PORT}  (单房间, 最多 ${cfg.RULES.maxPlayers} 人, 反作弊${ac.status().enabled ? '开启' : '关闭'})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { board.saveNow(); acStore.save(); process.exit(0); });
}
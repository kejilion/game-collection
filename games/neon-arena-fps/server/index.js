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
const { createChatFilter } = require('./chat-filter');
const { createChatHistory } = require('./chat-history');
const { SessionGuard } = require('./session-guard');
const { AntiCheat, fpsPreset, createJsonStore, createAuditLog, TokenBucket, RATE_PRESETS } = require('./anticheat');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const audit = createAuditLog({
  enabled: process.env.AC_AUDIT_MODE !== 'off',
  dataDir: DATA_DIR,
  retentionDays: Number(process.env.AC_AUDIT_RETENTION_DAYS) || 30,
});
const chatFilter = createChatFilter({
  enabled: process.env.CHAT_FILTER_MODE !== 'off',
  filePath: process.env.CHAT_FILTER_FILE || path.join(__dirname, 'sensitive-words.txt'),
});
const chatHistory = createChatHistory({ filePath: path.join(DATA_DIR, 'chat-history.jsonl') });
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (req, res) => {
  res.json({
    ok: true, players: world.players.size, spectators: countSpectators(),
    uptime: Math.round(process.uptime()),
    anticheat: ac.status(),
    audit: audit.status(),
    wsGuard: connGuardStatus(),
    sessionGuard: sessionGuard.status(),
    websocket: {
      compression: wsCompressionEnabled ? 'permessage-deflate' : 'off',
      compressionThreshold: wsCompressionEnabled ? wsCompression.threshold : null,
    },
    chatFilter: chatFilter.status(),
    chatHistory: chatHistory.status(),
  });
});

const server = http.createServer(app);
const wsCompressionEnabled = envFlag('WS_COMPRESSION');
const wsCompression = wsCompressionEnabled ? {
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  threshold: envInt('WS_COMPRESSION_THRESHOLD', 1024, 0),
  concurrencyLimit: envInt('WS_COMPRESSION_CONCURRENCY', 5, 1),
  zlibDeflateOptions: {
    level: Math.min(9, envInt('WS_COMPRESSION_LEVEL', 3, 0)),
  },
} : false;
const wss = new WebSocketServer({
  server,
  maxPayload: 4096,
  perMessageDeflate: wsCompression,
});

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
  audit,
  onAction(key, action, reason, monitor) {
    const ws = sockets.get(key);
    const p = world.players.get(key);
    const ruleCounts = {};
    for (const entry of (monitor && monitor.violations) || []) ruleCounts[entry.rule] = (ruleCounts[entry.rule] || 0) + 1;
    const rtt = monitor && monitor.networkRtt !== null ? `${Math.round(monitor.networkRtt)}ms` : 'unknown';
    const scores = monitor && typeof monitor.scoreSnapshot === 'function' ? monitor.scoreSnapshot() : {};
    console.warn(`[anticheat-action] ${(p && p.name) || key} ${action} score=${monitor ? Math.round(monitor.score) : 0} channels=${JSON.stringify(scores)} rtt=${rtt} rules=${JSON.stringify(ruleCounts)} reason=${reason}`);
    if (action === 'warn') {
      sendTo(key, { type: 'acwarn', text: '⚠️ 检测到异常操作，请规范游戏行为' });
      return;
    }
    const label = action === 'ban'
      ? '你已被临时封禁，请规范游戏行为'
      : '你已被移出对局，请规范游戏行为';
    if (p) broadcast({ type: 'sys', style: 'streak', text: `🚫 ${p.name} 因异常行为被系统${action === 'ban' ? '封禁' : '移出'}` });
    // 踢出与封禁统一清空完整档案；断线时再次清理，避免会话收尾把档案重新写回。
    if ((action === 'kick' || action === 'ban') && p && p.name) {
      p.purgeProfile = true;
      board.clearHistory(p.name);
    }
    if (ws) {
      rawSend(ws, JSON.stringify({ type: 'kicked', text: label }));
      setTimeout(() => { try { ws.close(4001, 'anticheat'); } catch (_) { /* 忽略 */ } }, 60);
    }
  },
  log: e => console.warn(`[anticheat] ${e.name || e.key} ${e.rule}/${e.channel} ${e.detail} → score=${e.score}`),
}));
setInterval(() => ac.tick(1), 1000);

const world = new World(broadcast, sendTo, ac, chatFilter, chatHistory, audit);
audit.write({
  type: 'startup',
  port: Number(PORT),
  thresholds: ac.opts.thresholds,
  channelDecayPerSec: ac.opts.channelDecayPerSec,
  movementBanContribution: ac.opts.movementBanContribution,
  movementKicksToBan: ac.opts.movementKicksToBan,
  sustainedSpeed: ac.opts.sustainedSpeed,
  kicksToBan: ac.opts.kicksToBan,
  weights: ac.opts.weights,
  ruleChannels: ac.opts.ruleChannels,
  ruleConfig: world.auditRuleConfig(),
});

// 下发给新连接的静态定义（地图/武器/道具/商店），两端共用一份数据
const DEFS = {
  type: 'defs',
  map: cfg.MAP, weapons: cfg.WEAPONS, equips: cfg.EQUIPS, buffs: cfg.BUFFS,
  shop: cfg.SHOP, shopSlots: cfg.SHOP_SLOTS, airdrops: cfg.AIRDROPS,
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

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || '').trim());
}
function envInt(name, fallback, min) {
  const v = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v >= min ? v : fallback;
}
function normalizeIp(raw) {
  let ip = String(raw || '').trim();
  if (!ip) return 'unknown';
  if (ip.includes(',')) ip = ip.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end > 0) ip = ip.slice(1, end);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.replace(/:\d+$/, '');
  }
  return ip || 'unknown';
}
function isLoopbackIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}
function firstHeaderValue(value) {
  if (Array.isArray(value)) value = value[0];
  return typeof value === 'string' ? value.split(',')[0].trim() : '';
}
function forwardedIp(req) {
  const xff = firstHeaderValue(req.headers['x-forwarded-for']);
  if (xff) return xff;
  const real = firstHeaderValue(req.headers['x-real-ip']);
  if (real) return real;
  const fwd = firstHeaderValue(req.headers.forwarded);
  const m = /(?:^|;\s*)for="?([^";,]+)"?/i.exec(fwd);
  return m ? m[1] : '';
}
function clientIpFromReq(req) {
  const remote = normalizeIp(req.socket.remoteAddress);
  if (TRUST_PROXY || isLoopbackIp(remote)) {
    const forwarded = normalizeIp(forwardedIp(req));
    if (forwarded !== 'unknown') return forwarded;
  }
  return remote;
}
function ipIdent(ip) {
  return ip && ip !== 'unknown' ? 'ip:' + ip : null;
}
function windowLabel(ms) {
  return ms % 1000 === 0 ? `${ms / 1000}秒` : `${ms}ms`;
}

// ---- 连接防刷：同 IP 1 秒内大量 WS 连接写入反作弊封禁 ----
const TRUST_PROXY = envFlag('TRUST_PROXY');
const CONN_WINDOW = envInt('WS_FLOOD_WINDOW_MS', 1000, 250);
const CONN_MAX = envInt('WS_FLOOD_MAX_PER_SECOND', 12, 2);
const CONN_BAN_MINUTES = envInt('WS_FLOOD_BAN_MINUTES', 60, 1);
const CONN_SOFT_BLOCK_MS = envInt('WS_FLOOD_SOFT_BLOCK_MS', 30000, 1000);
const connTracker = new Map();  // ip -> { times: [timestamps], blockedUntil, lastSeen }
const connFloodStats = { bans: 0, rejects: 0, lastBan: null };
function checkConnFlood(ip) {
  const now = Date.now();
  const ident = ipIdent(ip);
  if (ident) {
    const ban = ac.isBanned([ident]);
    if (ban) {
      connFloodStats.rejects++;
      return { ok: false, reason: 'ip banned', ban };
    }
  }

  let rec = connTracker.get(ip);
  if (!rec) { rec = { times: [], blockedUntil: 0, lastSeen: now }; connTracker.set(ip, rec); }
  rec.lastSeen = now;
  if (rec.blockedUntil > now) {
    connFloodStats.rejects++;
    return { ok: false, reason: 'too many connections' };
  }

  rec.times = rec.times.filter(t => now - t < CONN_WINDOW);
  rec.times.push(now);
  if (rec.times.length > CONN_MAX) {
    const count = rec.times.length;
    rec.times = [];
    connFloodStats.rejects++;

    if (ident) {
      const reason = `${windowLabel(CONN_WINDOW)}内涌入 ${count} 个 WebSocket 连接`;
      ac.registerBan([ident], CONN_BAN_MINUTES, reason);
      audit.write({
        type: 'action', action: 'ban', rule: 'connflood', reason,
        identity: audit.identityHash(ip), players: world.players.size,
      });
      if (ac.opts.store && typeof ac.opts.store.save === 'function') ac.opts.store.save();
      const ban = ac.isBanned([ident]);
      connFloodStats.bans++;
      connFloodStats.lastBan = { ip, count, at: now, until: ban ? ban.until : now + CONN_BAN_MINUTES * 60000 };
      console.warn(`[conn-flood] banned ${ip}: ${reason}`);
      closeIpConnections(ip, 4429, 'ws flood ban');
      return { ok: false, reason: 'ws flood banned', ban };
    }

    rec.blockedUntil = now + CONN_SOFT_BLOCK_MS;
    console.warn(`[conn-flood] soft-blocked unknown IP for ${Math.round(CONN_SOFT_BLOCK_MS / 1000)}s`);
    return { ok: false, reason: 'too many connections' };
  }
  return { ok: true };
}
function closeIpConnections(ip, code, reason) {
  for (const client of wss.clients) {
    if (client.ip !== ip || client.readyState > 1) continue;
    try {
      if (client.readyState === 1) rawSend(client, JSON.stringify({ type: 'kicked', text: '连接异常，请稍后再试' }));
      client.close(code, reason);
    } catch (_) {
      try { client.terminate(); } catch (_) { /* 忽略 */ }
    }
  }
}
function connGuardStatus() {
  return {
    trackedIps: connTracker.size,
    concurrentIps: ipConns.size,
    trustProxy: TRUST_PROXY,
    floodWindowMs: CONN_WINDOW,
    floodMaxPerSecond: CONN_MAX,
    floodBanMinutes: CONN_BAN_MINUTES,
    floodBans: connFloodStats.bans,
    rejected: connFloodStats.rejects,
    lastBan: connFloodStats.lastBan,
  };
}
// 定时清理过期记录（每 60 秒）
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of connTracker) {
    rec.times = rec.times.filter(t => now - t < CONN_WINDOW);
    if (rec.blockedUntil < now && rec.times.length === 0 && now - rec.lastSeen > 60000) connTracker.delete(ip);
  }
}, 60000);

// ---- 同IP并发连接限制 ----
const IP_MAX_CONCURRENT = envInt('IP_MAX_CONCURRENT', 4, 1);
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
  const blocked = NAME_BLACKLIST.some(re => re.test(name)) || chatFilter.contains(name);
  if (blocked) chatFilter.noteBlockedName();
  return blocked;
}

// ---- 参战会话与真实无操作治理 ----
const sessionGuard = new SessionGuard({
  maxPlayersPerDevice: envInt('DEVICE_MAX_PLAYERS', 1, 1),
  maxPlayersPerIp: envInt('IP_MAX_PLAYERS', 2, 1),
  warnAfterMs: envInt('AFK_WARN_MS', 180000, 1000),
  kickAfterMs: envInt('AFK_KICK_MS', 300000, 2000),
});
const AFK_CHECK_INTERVAL = envInt('AFK_CHECK_INTERVAL_MS', 15000, 1000);
setInterval(() => {
  const result = sessionGuard.sweep();
  for (const { playerId } of result.warnings) {
    sendTo(playerId, { type: 'sys', text: '长时间无有效操作，继续无操作将自动退出对局' });
  }
  for (const { playerId, idleMs } of result.kicks) {
    const p = world.players.get(playerId);
    const ws = sockets.get(playerId);
    if (!p) { sessionGuard.release(playerId); continue; }
    console.log(`[session-guard] afk kick player=${p.name} idleMs=${Math.round(idleMs)}`);
    sessionGuard.release(playerId);
    world.removePlayer(playerId, 'afk');
    sockets.delete(playerId);
    if (ws) {
      ws.playerId = 0;
      rawSend(ws, JSON.stringify({ type: 'kicked', text: '长时间无有效操作，已退出对局' }));
      setTimeout(() => { try { ws.close(4004, 'afk'); } catch (_) { /* ignore */ } }, 60);
    }
  }
}, AFK_CHECK_INTERVAL);

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.spectator = false;
  ws.playerId = 0;
  ws.ip = clientIpFromReq(req);
  const connCheck = checkConnFlood(ws.ip);
  if (!connCheck.ok) {
    const text = connCheck.ban ? `连接异常，请稍后再试` : '连接过于频繁，请稍后再试';
    rawSend(ws, JSON.stringify({ type: 'err', text }));
    ws.close(4429, connCheck.reason);
    return;
  }
  if (ipConnAdd(ws.ip) > IP_MAX_CONCURRENT) { ipConnDel(ws.ip); ws.close(4429, 'too many concurrent'); return; }
  ws.preBucket = new TokenBucket(6, 12);   // 加入前的连接级限速
  ws.on('pong', () => {
    ws.isAlive = true;
    if (!ws.heartbeatAt) return;
    const p = ws.playerId ? world.players.get(ws.playerId) : null;
    if (p && p.mon) p.mon.noteRtt(Date.now() - ws.heartbeatAt);
    ws.heartbeatAt = 0;
  });
  rawSend(ws, JSON.stringify(DEFS));
  rawSend(ws, JSON.stringify(world.boardMsg()));
  rawSend(ws, JSON.stringify(world.snapshot()));
  rawSend(ws, JSON.stringify({ type: 'chatHistory', items: chatHistory.recent(40) }));

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
          rawSend(ws, JSON.stringify({ type: 'err', text: `你已被临时封禁，剩余约 ${mins} 分钟` }));
          return;
        }
        const joinCheck = sessionGuard.canJoin({ ip: ws.ip, deviceId: m.deviceId });
        if (!joinCheck.ok) {
          const text = joinCheck.reason === 'missing_device_id'
            ? '设备标识无效，请刷新页面后重试，或使用观战模式'
            : joinCheck.reason === 'device_limit'
              ? '该设备已有玩家在对局中，可使用观战模式'
              : '当前网络已有多名玩家在对局中，请稍后再试或使用观战模式';
          audit.write({
            type: 'session_guard', action: 'reject', rule: joinCheck.reason,
            identity: audit.identityHash(ws.ip), players: world.players.size,
          });
          rawSend(ws, JSON.stringify({ type: 'err', code: joinCheck.reason, text }));
          return;
        }
        ws.spectator = false;
        const np = world.addPlayer(m.name, ws.ip);
        ws.playerId = np.id;
        sockets.set(np.id, ws);
        sessionGuard.activate(np.id, { ip: ws.ip, deviceId: joinCheck.deviceId, state: np });
        if (!ws.heartbeatAt) {
          ws.heartbeatAt = Date.now();
          try { ws.ping(); } catch (_) { ws.heartbeatAt = 0; }
        }
        rawSend(ws, JSON.stringify({ type: 'joined', id: np.id, you: { coins: np.coins, owned: np.owned, eq: np.eq }, name: np.name }));
        break;
      }
      case 'spectate': {
        if (p) { sessionGuard.release(p.id); world.removePlayer(p.id); sockets.delete(p.id); ws.playerId = 0; }
        ws.spectator = true;
        rawSend(ws, JSON.stringify({ type: 'spec' }));
        break;
      }
      case 'leave': {
        if (p) { sessionGuard.release(p.id); world.removePlayer(p.id); sockets.delete(p.id); ws.playerId = 0; }
        ws.spectator = false;
        rawSend(ws, JSON.stringify({ type: 'left' }));
        break;
      }
      case 'move':   if (p) { world.handleMove(p, m); sessionGuard.noteState(p.id, p); } break;
      case 'melee':  if (p) { sessionGuard.noteActivity(p.id); world.handleMelee(p, m); } break;
      case 'fire':   if (p) { sessionGuard.noteActivity(p.id); world.handleFire(p, m); } break;
      case 'nade':   if (p) { sessionGuard.noteActivity(p.id); world.handleNade(p, m); } break;
      case 'reload': if (p) { sessionGuard.noteActivity(p.id); world.handleReload(p); } break;
      case 'switch': if (p) { sessionGuard.noteActivity(p.id); world.handleSwitch(p, m); } break;
      case 'pickup': if (p) { sessionGuard.noteActivity(p.id); world.handlePickup(p, m); } break;
      case 'chat':   if (p) { sessionGuard.noteActivity(p.id); world.handleChat(p, m); } break;
      case 'buy':    if (p) { sessionGuard.noteActivity(p.id); world.handleBuy(p, m); } break;
      case 'equip':  if (p) { sessionGuard.noteActivity(p.id); world.handleEquipCos(p, m); } break;
      case 'ping':
        if (p && p.mon) p.mon.noteClientRtt(m.rtt);
        rawSend(ws, JSON.stringify({ type: 'pong', t: m.t }));
        break;
    }
  });

  ws.on('close', () => {
    ipConnDel(ws.ip);
    if (ws.playerId) { sessionGuard.release(ws.playerId); world.removePlayer(ws.playerId); sockets.delete(ws.playerId); }
  });
  ws.on('error', () => { /* close 会跟着触发 */ });
});

// 心跳：清理断线连接
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.heartbeatAt = Date.now();
    try { ws.ping(); } catch (_) { ws.heartbeatAt = 0; }
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

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    world.flushAuditSessions('shutdown');
    audit.write({ type: 'shutdown', signal: sig, players: world.players.size });
    board.saveNow();
    acStore.save();
    await audit.close();
    process.exit(0);
  });
}

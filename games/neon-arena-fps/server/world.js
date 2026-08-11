// 权威游戏世界：所有伤害/拾取/购买/BOSS/油桶均在服务端判定，客户端只上报输入与位置
'use strict';
const { randomUUID } = require('crypto');
const { MAP, WEAPONS, EQUIPS, BUFFS, PICKUP_POOLS, BOSS, BOSSES, SHOP, RULES, AIRDROPS } = require('./config');
const board = require('./leaderboard');

const now = () => Date.now();
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const r2 = v => Math.round(v * 100) / 100;
const r5 = v => Math.round(v * 100000) / 100000;

const COLORS = ['#ff6b6b', '#4dabf7', '#69db7c', '#ffd43b', '#da77f2', '#ffa94d', '#63e6e2', '#f783ac', '#a9e34b', '#748ffc', '#ff8787', '#66d9e8'];
const PROJ_KIND = { fire: 0, bullet: 1, orb: 2, rocket: 3 };
const NADE_KIND = { frag: 0, flash: 1, smoke: 2 };
const KILL_PACE_MAX_WINDOW = 60000;
const KILL_PACE_RULES = [
  { tag: 'burst', windowMs: 10000, minKills: 4, minVictims: 3, minPlayers: 3, weight: 25, cooldownMs: 12000 },
  { tag: 'rush', windowMs: 30000, minKills: 7, minVictims: 3, minPlayers: 3, weight: 46, cooldownMs: 20000 },
  { tag: 'wipe', windowMs: 60000, minKills: 10, minVictims: 4, minPlayers: 4, weight: 70, cooldownMs: 30000 },
];
const STREAK_AUX_RULES = [
  { tag: 'streak15', minStreak: 15, minVictims: 4, minPlayers: 3, score: 2 },
  { tag: 'streak20', minStreak: 20, minVictims: 5, minPlayers: 3, score: 5 },
  { tag: 'streak30', minStreak: 30, minVictims: 1, minPlayers: 2, score: 35, enforce: true },
];
const AC_BEHAVIOR = {
  visionSampleMs: 200,
  topPlayers: 3,
  candidateMinKills: 10,
  candidateMinStreak: 8,
  candidateScore: 10,
  minDistance: 18,
  maxDistance: 65,
  hiddenAimDot: Math.cos(2.5 * Math.PI / 180),
  hiddenTrackMs: 600,
  transitionMs: 550,
  awarenessMs: 4000,
  shotAwarenessRadius: 30,
  shotAwarenessMs: 3000,
  eventWindowMs: 300000,
  preaimEvents: 6,
  preaimVictims: 4,
  preaimWeight: 25,
  dominanceMinSessionMs: 300000,
  dominanceMinKills: 20,
  dominanceMinVictims: 1,
  dominanceMinPlayers: 2,
  dominanceMinKd: 8,
  dominanceMinKpm: 1.5,
  dominanceEvidenceMs: 300000,
  dominanceObserveMs: 60000,
  dominanceWeight: 10,
  dominanceFusionWeight: 35,
  dominanceFusionMinVictims: 4,
  dominanceFusionMinPlayers: 3,
  dominanceCooldownEvents: 2,
  dominanceMovementEvents: 2,
  dominanceMovementMaxRttMs: 250,
};
const DOMINANCE_AIM_RULES = new Set(['aim', 'hipsniper', 'spk', 'preaim']);
const DOMINANCE_MOVEMENT_RULES = new Set(['teleport', 'speed', 'fly', 'clip']);

function antiCheatVictimKey(victim) {
  if (victim && victim.mon && victim.mon.identity) return `identity:${victim.mon.identity}`;
  return `player:${victim && (victim.id || victim.name) || 'unknown'}`;
}

// 静态障碍物 AABB，用于子弹遮挡与 BOSS 碰撞（油桶单独作为动态实体）
const OBS = MAP.obstacles.map(o => ({
  minx: o.x - o.w / 2, maxx: o.x + o.w / 2, minz: o.z - o.d / 2, maxz: o.z + o.d / 2, miny: 0, maxy: o.h,
}));

function rayAABB(o, d, b) { // 返回进入距离 t，未命中返回 null（d 需归一化）
  let tmin = 0, tmax = Infinity;
  const axes = [['x', b.minx, b.maxx], ['y', b.miny, b.maxy], ['z', b.minz, b.maxz]];
  for (const [ax, mn, mx] of axes) {
    const ro = o[ax], rd = d[ax];
    if (Math.abs(rd) < 1e-9) { if (ro < mn || ro > mx) return null; continue; }
    let t1 = (mn - ro) / rd, t2 = (mx - ro) / rd;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}
function raySphere(o, d, c, r) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const disc = b * b - (ox * ox + oy * oy + oz * oz - r * r);
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : null;
}
function barrelBox(b) {
  const r = MAP.barrelR;
  return { minx: b.x - r, maxx: b.x + r, minz: b.z - r, maxz: b.z + r, miny: 0, maxy: MAP.barrelH };
}
// 圆（半径 r）与 AABB 的水平推挤，用于 BOSS 移动
function circlePushBoxes(pos, r, boxes) {
  for (const b of boxes) {
    const cx = clamp(pos.x, b.minx, b.maxx), cz = clamp(pos.z, b.minz, b.maxz);
    const dx = pos.x - cx, dz = pos.z - cz, d2 = dx * dx + dz * dz;
    if (d2 < r * r && d2 > 1e-9) {
      const dd = Math.sqrt(d2), push = (r - dd) / dd;
      pos.x += dx * push; pos.z += dz * push;
    } else if (d2 <= 1e-9) { pos.x = b.maxx + r; }
  }
  const lim = MAP.half - r;
  pos.x = clamp(pos.x, -lim, lim); pos.z = clamp(pos.z, -lim, lim);
}

// 圆(r)沿 (dx,dz) 分轴推进并滑行：先推 x 轴，遇障碍回退 x；再推 z 轴，遇障碍回退 z。
// 受阻的轴停下、另一轴继续前进 → 撞墙时沿边滑行。
// 当主方向被障碍正面挡住（两轴都推不动）时，自动尝试切向（垂直方向）滑动绕过，
// 解决"正对墙面卡死"的情况（如 BOSS 正东撞平台西面，dz=0 时无法滑行）。
function circleHitsBox(pos, r, b) {
  const cx = clamp(pos.x, b.minx, b.maxx), cz = clamp(pos.z, b.minz, b.maxz);
  const dx = pos.x - cx, dz = pos.z - cz;
  return dx * dx + dz * dz < r * r;
}
function moveCircle(pos, r, dx, dz, boxes) {
  const lim = MAP.half - r;
  // 主方向分轴推进
  const ox = pos.x, oz = pos.z;
  pos.x += dx;
  let xBlocked = false;
  for (const b of boxes) { if (circleHitsBox(pos, r, b)) { pos.x = ox; xBlocked = true; break; } }
  pos.z += dz;
  let zBlocked = false;
  for (const b of boxes) { if (circleHitsBox(pos, r, b)) { pos.z = oz; zBlocked = true; break; } }
  // 主方向正面被挡（x 受阻且 z 也没推进或被挡）→ 尝试切向滑动绕过
  if (xBlocked && (zBlocked || dz === 0)) {
    const sd = Math.abs(dz) > 1e-6 ? Math.sign(dz) : 0;
    const tryDirs = sd !== 0 ? [sd, -sd] : [1, -1];
    for (const td of tryDirs) {
      const tz = pos.z;
      pos.z += td * Math.max(Math.abs(dx), Math.abs(dz));
      let hit = false;
      for (const b of boxes) { if (circleHitsBox(pos, r, b)) { pos.z = tz; hit = true; break; } }
      if (!hit) break;
    }
  } else if (zBlocked && (xBlocked || dx === 0)) {
    const sx = Math.abs(dx) > 1e-6 ? Math.sign(dx) : 0;
    const tryDirs = sx !== 0 ? [sx, -sx] : [1, -1];
    for (const td of tryDirs) {
      const tx = pos.x;
      pos.x += td * Math.max(Math.abs(dx), Math.abs(dz));
      let hit = false;
      for (const b of boxes) { if (circleHitsBox(pos, r, b)) { pos.x = tx; hit = true; break; } }
      if (!hit) break;
    }
  }
  pos.x = clamp(pos.x, -lim, lim); pos.z = clamp(pos.z, -lim, lim);
}

class World {
  constructor(broadcast, sendTo, ac, chatFilter, chatHistory, audit) {
    this.broadcast = broadcast;
    this.sendTo = sendTo;
    this.ac = ac;                 // 反作弊引擎（见 server/anticheat/）
    this.chatFilter = chatFilter;
    this.chatHistory = chatHistory;
    this.audit = audit;
    this.players = new Map();
    this.nextId = 1;
    this.pickups = MAP.pickups.map(def => ({ def, item: pick(PICKUP_POOLS[def.cat]), avail: true, respawnAt: 0 }));
    this.barrels = MAP.barrels.map((b, i) => ({ id: i, x: b.x, z: b.z, hp: RULES.barrelHp, alive: true, respawnAt: 0 }));
    this.boss = null;
    this.nextBossAt = now() + BOSS.firstDelay * 1000;
    this.projs = [];         // {id, kind, pos, vel, dmg, born, targetId?, bossName}
    this.blasts = [];        // 巫妖延迟爆破 {pos, at, dmg, r, bossName}
    this.grenades = [];
    this.entId = 1;
    this.lootDrops = [];       // 玩家死亡散落武器 {id,item,slot,pos,ammo,reserve,count,availableAt,expiresAt}
    // 空投系统
    this.airdrop = null;             // {id, type, from, to, startAt, endAt, dropAt, focus, dropped, warned}
    this.nextAirdropAt = now() + (AIRDROPS.firstDelay || 30) * 1000;
    this.airdropCrate = null;        // {id, pos, hp, maxHp, alive, type, rewards}
    this.specialMobs = [];           // 特种精英怪数组
    this.burns = [];                 // 赤红制裁落地灼烧区域 {pos, until, r, dmgPerSec, nextTick}
    this.nextAcVisionAt = 0;
  }

  // 射线被障碍物/存活油桶挡住的最近距离
  obstacleBlock(o, d, maxT) {
    let t = maxT;
    for (const b of OBS) { const h = rayAABB(o, d, b); if (h !== null && h < t) t = h; }
    for (const br of this.barrels) {
      if (!br.alive) continue;
      const h = rayAABB(o, d, barrelBox(br));
      if (h !== null && h < t) t = h;
    }
    return t;
  }
  collideBoxes() {
    const boxes = OBS.slice();
    for (const br of this.barrels) if (br.alive) boxes.push(barrelBox(br));
    return boxes;
  }

  // ---------- 玩家生命周期 ----------
  addPlayer(rawName, ip) {
    const joinedAt = now();
    let name = String(rawName || '').replace(/[<>&"']/g, '').trim().slice(0, 12) || ('玩家' + Math.floor(rand(100, 999)));
    for (const p of this.players.values()) if (p.name === name) { name = name.slice(0, 9) + Math.floor(rand(10, 99)); break; }
    const prof = board.get(name);
    prof.joins++; prof.last = joinedAt;
    if (prof.coins === null || prof.coins === undefined) prof.coins = RULES.startCoins;
    const p = {
      id: this.nextId++, name, color: COLORS[(this.nextId + name.length) % COLORS.length],
      pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, anim: 0,
      aiming: 0, aimingSince: 0, blindUntil: 0, blindTotal: 1,
      hp: RULES.maxHp, armor: 0, shield: 0, alive: true, deadUntil: 0, protectUntil: now() + RULES.protectMs,
      melee: 'fist', gun: null, nadeType: null, active: 'melee',
      ammo: 0, ammoReserve: 0, nadeLeft: 0, reloadUntil: 0, lastFire: {}, lastNade: 0,
      boots: 0, buffs: {},
      kills: 0, deaths: 0, score: 0, streak: 0,
      ip,
      coins: prof.coins, owned: prof.owned.slice(), eq: Object.assign({ head: null, face: null, back: null, fx: null }, prof.eq),
      lastChatAt: 0, lastSpawnIdx: -1,
      acKillPace: { kills: [], flags: {} },
      acStreak: { victims: new Set(), flags: {} },
      acDominance: { victims: new Set(), nextCheckAt: 0 },
      acVision: { targets: new Map(), events: [], nextFlagAt: 0 },
      acAware: new Map(),
      sessionId: randomUUID(),
      sessionStartedAt: joinedAt,
      nextAuditAt: joinedAt + 300000,
      maxStreak: 0,
      auditSummarySeq: 0,
      acSession: {
        shots: 0, hits: 0, headshots: 0,
        gunKills: 0, meleeKills: 0, grenadeKills: 0,
        preaimArmed: 0, preaimHits: 0,
        weapons: {},
      },
    };
    this.placeAtSpawn(p);
    p.mon = this.ac.attach(p.id, { name, ip });
    p.mon.resetPos(p.pos);
    this.players.set(p.id, p);
    if (this.audit) this.audit.write({
      type: 'session_start', t: joinedAt, sessionId: p.sessionId,
      identity: p.mon.identity, name: p.name, players: this.players.size,
    });
    this.broadcast({ type: 'sys', style: 'join', text: `${name} 加入了竞技场` });
    return p;
  }

  removePlayer(id, reason = 'leave') {
    const p = this.players.get(id);
    if (!p) return;
    this.auditSession(p, p.mon && p.mon.kicked ? (p.mon.lastAction || 'kick') : reason, true);
    if (p.purgeProfile || (p.mon && p.mon.kicked)) board.clearHistory(p.name);
    else this.saveProfile(p);
    this.ac.detach(id);
    this.players.delete(id);
    this.broadcast({ type: 'sys', style: 'leave', text: `${p.name} 离开了竞技场` });
  }

  saveProfile(p) {
    const prof = board.get(p.name);
    prof.coins = p.coins; prof.owned = p.owned.slice(); prof.eq = Object.assign({}, p.eq);
    board.save();
  }

  auditWeapon(p, weapon) {
    if (!p.acSession) return null;
    const key = weapon || 'unknown';
    if (!p.acSession.weapons[key]) p.acSession.weapons[key] = { shots: 0, hits: 0, headshots: 0, kills: 0 };
    return p.acSession.weapons[key];
  }

  recordAuditShot(p, weapon) {
    const row = this.auditWeapon(p, weapon);
    if (!row) return;
    p.acSession.shots++;
    row.shots++;
  }

  recordAuditHit(p, weapon, headshot) {
    const row = this.auditWeapon(p, weapon);
    if (!row) return;
    p.acSession.hits++;
    row.hits++;
    if (headshot) { p.acSession.headshots++; row.headshots++; }
  }

  recordAuditKill(p, weapon) {
    const row = this.auditWeapon(p, weapon);
    if (row) row.kills++;
    const def = WEAPONS[weapon];
    if (def && def.slot === 'gun') p.acSession.gunKills++;
    else if (def && def.slot === 'melee') p.acSession.meleeKills++;
    else if (def && def.slot === 'nade') p.acSession.grenadeKills++;
  }

  auditSession(p, reason, final) {
    if (!this.audit || !p || !p.mon || (final && p.auditClosed)) return;
    const t = now();
    const durationSec = Math.max(0, (t - p.sessionStartedAt) / 1000);
    const stats = p.acSession || {};
    const shots = stats.shots || 0;
    const hits = stats.hits || 0;
    const gunKills = stats.gunKills || 0;
    p.auditSummarySeq++;
    this.audit.write({
      type: 'session', t, reason, final: !!final,
      sessionId: p.sessionId, seq: p.auditSummarySeq,
      identity: p.mon.identity, name: p.name, players: this.players.size,
      durationSec: Math.round(durationSec), kills: p.kills, deaths: p.deaths,
      streak: p.streak, maxStreak: p.maxStreak || 0,
      uniqueVictims: p.acDominance && p.acDominance.victims ? p.acDominance.victims.size : 0,
      kpm: durationSec > 0 ? r5(p.kills / (durationSec / 60)) : 0,
      kd: r5(p.kills / Math.max(1, p.deaths)),
      shots, hits, headshots: stats.headshots || 0,
      hitRate: shots ? r5(hits / shots) : null,
      headshotRate: hits ? r5((stats.headshots || 0) / hits) : null,
      shotsPerKill: gunKills ? r5(shots / gunKills) : null,
      gunKills, meleeKills: stats.meleeKills || 0, grenadeKills: stats.grenadeKills || 0,
      preaimArmed: stats.preaimArmed || 0, preaimHits: stats.preaimHits || 0,
      weapons: stats.weapons || {},
      ruleCounts: Object.assign({}, p.mon.ruleCounts),
      observeCounts: Object.assign({}, p.mon.observeCounts),
      scores: p.mon.scoreSnapshot(), rtt: p.mon.rttStats(),
      movement: Object.assign({}, p.mon.stats),
    });
    if (final) p.auditClosed = true;
  }

  flushAuditSessions(reason) {
    for (const p of this.players.values()) this.auditSession(p, reason || 'shutdown', true);
  }

  auditRuleConfig() {
    return {
      killPace: KILL_PACE_RULES,
      streak: STREAK_AUX_RULES,
      behavior: AC_BEHAVIOR,
    };
  }

  placeAtSpawn(p) {
    let best = null, bestD = -1;
    for (let i = 0; i < 3; i++) {
      let idx = Math.floor(Math.random() * MAP.spawns.length);
      if (idx === p.lastSpawnIdx) idx = (idx + 1) % MAP.spawns.length;
      const [x, z] = MAP.spawns[idx];
      let dMin = Infinity;
      for (const o of this.players.values())
        if (o !== p && o.alive) dMin = Math.min(dMin, (o.pos.x - x) ** 2 + (o.pos.z - z) ** 2);
      if (dMin > bestD) { bestD = dMin; best = idx; }
    }
    p.lastSpawnIdx = best;
    const [x, z] = MAP.spawns[best];
    p.pos = { x: x + rand(-1.5, 1.5), y: 0, z: z + rand(-1.5, 1.5) };
  }

  respawn(p) {
    p.alive = true; p.hp = RULES.maxHp; p.armor = 0; p.shield = 0;
    p.melee = 'fist'; p.gun = null; p.nadeType = null; p.active = 'melee';
    p.ammo = 0; p.ammoReserve = 0; p.nadeLeft = 0; p.reloadUntil = 0; p.buffs = {}; p.boots = 0; p.anim = 0;
    p.aiming = 0; p.aimingSince = 0; p.blindUntil = 0; p.blindTotal = 1;
    p.protectUntil = now() + RULES.protectMs;
    p.acVision.targets.clear();
    this.placeAtSpawn(p);
    p.mon.resetPos(p.pos);   // 合法传送：重置移动校验基线
    this.broadcast({ type: 'fx', k: 'respawn', id: p.id, pos: [r2(p.pos.x), 0, r2(p.pos.z)] });
  }

  // ---------- 反作弊：几何/速度查询（引擎回调注入点） ----------
  maxSpeedOf(p) {
    const base = RULES.baseSpeed * (1 + 0.1 * p.boots)
      * (this.buffOn(p, 'speed') ? 1.6 : 1)
      * (this.buffOn(p, 'zombie') ? 1.35 : 1);
    // 近期峰值宽限：buff 生效/失效边界上，客户端与服务端对 buff 状态的认知有 1 帧网络时差，
    // 取近 1.2s 内的最大理论速度，避免边界瞬间被误判超速
    const t = now();
    if (base >= (p._spdPeak || 0) || t - (p._spdPeakAt || 0) > 1200) { p._spdPeak = base; p._spdPeakAt = t; }
    return Math.max(base, p._spdPeak || base);
  }
  maxAboveFloorOf(p) {
    // 跳跃增益让跳跃高度 ×2.25，飞天阈值同步抬高，避免弹跳道具误判
    const mul = this.buffOn(p, 'jump') ? 1.5 : 1;
    const jumpH = (RULES.jumpVel * mul) ** 2 / (2 * RULES.gravity);
    return jumpH + (this.buffOn(p, 'jump') ? 2.2 : 2.8);
  }
  maxAirMsOf(p) {
    const mul = this.buffOn(p, 'jump') ? 1.5 : 1;
    const jumpFlightMs = 2 * RULES.jumpVel * mul / RULES.gravity * 1000;
    return jumpFlightMs + (this.buffOn(p, 'jump') ? 1500 : 1100);
  }
  floorAtSrv(pos) {   // 支撑面高度（含微阶坡道片与存活油桶）
    let f = 0;
    const pad = 0.35;
    for (const b of this.collideBoxes()) {
      if (pos.x > b.minx - pad && pos.x < b.maxx + pad && pos.z > b.minz - pad && pos.z < b.maxz + pad) {
        if (b.maxy <= pos.y + 0.5 && b.maxy > f) f = b.maxy;
      }
    }
    return f;
  }
  inSolidSrv(pos) {   // 脚部明显埋入静态几何（0.35m 深度容忍坡道片阶差）
    const s = 0.12;
    for (const b of OBS) {
      if (pos.x > b.minx + s && pos.x < b.maxx - s && pos.z > b.minz + s && pos.z < b.maxz - s
        && pos.y + 0.35 < b.maxy && pos.y + 1.3 > b.miny) return true;
    }
    return false;
  }
  viewVec(p) {        // 最近上报视角的方向向量（YXZ 欧拉）
    const cp = Math.cos(p.pitch);
    return [-cp * Math.sin(p.yaw), Math.sin(p.pitch), -cp * Math.cos(p.yaw)];
  }

  combatAware(p, targetId, t) {
    const until = p.acAware && p.acAware.get(targetId);
    if (!until) return false;
    if (until <= t) { p.acAware.delete(targetId); return false; }
    return true;
  }

  markCombatAwareness(a, b, t) {
    if (!a.acAware) a.acAware = new Map();
    if (!b.acAware) b.acAware = new Map();
    a.acAware.set(b.id, t + AC_BEHAVIOR.awarenessMs);
    b.acAware.set(a.id, t + AC_BEHAVIOR.awarenessMs);
  }

  markShotAwareness(shooter, t) {
    for (const player of this.players.values()) {
      if (player === shooter || !player.alive) continue;
      if (Math.hypot(player.pos.x - shooter.pos.x, player.pos.z - shooter.pos.z) > AC_BEHAVIOR.shotAwarenessRadius) continue;
      if (!player.acAware) player.acAware = new Map();
      player.acAware.set(shooter.id, t + AC_BEHAVIOR.shotAwarenessMs);
    }
  }

  updateAntiCheatVision(t) {
    if (t < this.nextAcVisionAt) return;
    this.nextAcVisionAt = t + AC_BEHAVIOR.visionSampleMs;
    const ranked = [...this.players.values()]
      .filter(p => p.alive)
      .sort((a, b) => b.kills - a.kills || b.streak - a.streak || b.score - a.score);
    const topIds = new Set(ranked.slice(0, AC_BEHAVIOR.topPlayers).map(p => p.id));

    for (const shooter of ranked) {
      if (!shooter.mon || shooter.mon.kicked || !shooter.gun || shooter.active !== 'gun') continue;
      const candidate = (topIds.has(shooter.id) && shooter.kills >= AC_BEHAVIOR.candidateMinKills)
        || shooter.streak >= AC_BEHAVIOR.candidateMinStreak
        || shooter.mon.score >= AC_BEHAVIOR.candidateScore;
      if (!candidate || !shooter.mon.combatEvidenceSafe()) continue;
      if (!shooter.acVision) shooter.acVision = { targets: new Map(), events: [], nextFlagAt: 0 };
      const eye = { x: shooter.pos.x, y: shooter.pos.y + RULES.eyeH, z: shooter.pos.z };
      const view = this.viewVec(shooter);
      const liveTargets = new Set();

      for (const target of ranked) {
        if (target === shooter || target.protectUntil > t || this.combatAware(shooter, target.id, t)) continue;
        const dx = target.pos.x - eye.x, dy = target.pos.y + 1.1 - eye.y, dz = target.pos.z - eye.z;
        const distance = Math.hypot(dx, dy, dz);
        if (distance < AC_BEHAVIOR.minDistance || distance > AC_BEHAVIOR.maxDistance) continue;
        liveTargets.add(target.id);
        let row = shooter.acVision.targets.get(target.id);
        if (!row) row = { hiddenAimMs: 0, lastSampleAt: 0, lastHiddenAt: 0, armedAt: 0 };
        const dir = { x: dx / distance, y: dy / distance, z: dz / distance };
        const hidden = this.obstacleBlock(eye, dir, distance) < distance - 0.35;
        const aligned = view[0] * dir.x + view[1] * dir.y + view[2] * dir.z >= AC_BEHAVIOR.hiddenAimDot;
        if (hidden && aligned) {
          const elapsed = row.lastSampleAt
            ? Math.min(AC_BEHAVIOR.visionSampleMs * 2, Math.max(0, t - row.lastSampleAt))
            : AC_BEHAVIOR.visionSampleMs;
          row.hiddenAimMs += elapsed;
          row.lastHiddenAt = t;
          if (row.hiddenAimMs >= AC_BEHAVIOR.hiddenTrackMs && !row.armedAt) {
            row.armedAt = t;
            if (shooter.acSession) shooter.acSession.preaimArmed++;
          }
        } else if (hidden) {
          row.hiddenAimMs = 0;
          row.armedAt = 0;
        } else {
          row.hiddenAimMs = 0;
          if (t - row.lastHiddenAt > AC_BEHAVIOR.transitionMs) row.armedAt = 0;
        }
        row.lastSampleAt = t;
        shooter.acVision.targets.set(target.id, row);
      }
      for (const targetId of shooter.acVision.targets.keys()) {
        if (!liveTargets.has(targetId)) shooter.acVision.targets.delete(targetId);
      }
    }
  }

  recordPreaimHit(shooter, target, t) {
    if (!shooter.mon || shooter.mon.kicked || !shooter.mon.combatEvidenceSafe()) return;
    if (!shooter.acVision || this.combatAware(shooter, target.id, t)) return;
    const row = shooter.acVision.targets.get(target.id);
    if (!row || !row.armedAt || t - row.lastHiddenAt > AC_BEHAVIOR.transitionMs) return;
    const reactionMs = Math.max(0, t - row.lastHiddenAt);
    row.hiddenAimMs = 0; row.lastHiddenAt = 0; row.armedAt = 0;
    if (shooter.acSession) shooter.acSession.preaimHits++;
    const state = shooter.acVision;
    state.events = state.events.filter(event => t - event.t <= AC_BEHAVIOR.eventWindowMs);
    state.events.push({ t, victimId: target.id, reactionMs });
    const victims = new Set(state.events.map(event => event.victimId));
    if (state.events.length < AC_BEHAVIOR.preaimEvents || victims.size < AC_BEHAVIOR.preaimVictims || t < state.nextFlagAt) return;
    const averageReaction = state.events.reduce((sum, event) => sum + event.reactionMs, 0) / state.events.length;
    state.nextFlagAt = t + AC_BEHAVIOR.eventWindowMs;
    if (shooter.mon.flag(
      'preaim', AC_BEHAVIOR.preaimWeight,
      `隔墙跟随后快速命中 ${state.events.length} 次 / ${victims.size} 名玩家，平均过渡 ${Math.round(averageReaction)}ms`
    )) state.events = [];
  }

  // ---------- 输入处理 ----------
  handleMove(p, m) {
    if (!p.alive || !Array.isArray(m.p)) return;
    const nx = +m.p[0], ny = +m.p[1], nz = +m.p[2];
    if (!isFinite(nx) || !isFinite(ny) || !isFinite(nz)) { p.mon.flag('badvec', undefined, 'move 非法坐标'); return; }
    const lim = MAP.half - 0.4;
    const cand = { x: clamp(nx, -lim, lim), y: clamp(ny, 0, 12), z: clamp(nz, -lim, lim) };
    const res = p.mon.movement(cand, {
      maxSpeed: this.maxSpeedOf(p),
      floorY: this.floorAtSrv(cand),
      maxAboveFloor: this.maxAboveFloorOf(p),
      airMinAboveFloor: this.buffOn(p, 'jump') ? 1.8 : 1.2,
      maxAirMs: this.maxAirMsOf(p),
      inSolid: q => this.inSolidSrv(q),
    });
    p.pos = res.pos;   // 违规时已回拉到最后合法位置，快照广播的永远是合法坐标
    if (!res.ok) {
      const t = now();
      if (t - (p._lastPosFixAt || 0) >= 120) {
        p._lastPosFixAt = t;
        this.sendTo(p.id, { type: 'posfix', p: [r2(p.pos.x), r2(p.pos.y), r2(p.pos.z)], reason: res.reason || 'move' });
      }
    }
    const ya = +m.ya, pi = +m.pi;
    if (isFinite(ya)) p.yaw = ya;
    if (isFinite(pi)) p.pitch = clamp(pi, -1.55, 1.55);
    p.anim = m.an ? 1 : 0;
    const wantsAim = !!(m.zm && p.active === 'gun' && p.gun === 'sniper');
    if (wantsAim && !p.aiming) p.aimingSince = now();
    else if (!wantsAim) p.aimingSince = 0;
    p.aiming = wantsAim ? 1 : 0;
  }

  buffOn(p, k) { return (p.buffs[k] || 0) > now(); }
  meleeCd(p, w) { return WEAPONS[w].cd * (this.buffOn(p, 'zombie') ? 0.6 : 1) * 1000; }

  handleMelee(p, m) {
    if (!p.alive) return;
    const w = p.melee, def = WEAPONS[w];
    if (!p.mon.cooldown('melee', this.meleeCd(p, w) * 0.85)) return;
    let dx = +((m.d || [])[0]) || 0, dz = +((m.d || [])[2]) || 0;
    const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    this.broadcast({ type: 'fx', k: 'melee', id: p.id, wp: w });
    const range = def.range + 0.7, dotMin = def.sweep ? 0.1 : 0.45;
    const targets = [];
    for (const o of this.players.values()) {
      if (o === p || !o.alive) continue;
      const tx = o.pos.x - p.pos.x, tz = o.pos.z - p.pos.z, dist = Math.hypot(tx, tz);
      if (dist > range || Math.abs(o.pos.y - p.pos.y) > 2.2) continue;
      if ((tx * dx + tz * dz) / (dist || 1) < dotMin) continue;
      targets.push({ o, dist });
    }
    targets.sort((a, b) => a.dist - b.dist);
    const hitList = def.sweep ? targets : targets.slice(0, 1);
    for (const { o } of hitList) this.applyDamage(o, def.dmg, p, { melee: true, wp: w });
    // BOSS 也吃近战
    if (this.boss) {
      const bx = this.boss.pos.x - p.pos.x, bz = this.boss.pos.z - p.pos.z;
      const bd = Math.hypot(bx, bz) - this.boss.cfg.radius;
      if (bd <= range && (bx * dx + bz * dz) / (Math.hypot(bx, bz) || 1) > 0.1)
        this.damageBoss(this.dmgMul(p, def.dmg, true).dmg, p);
    }
    // 精英怪也吃近战（倒序遍历：damageSpecialMob 死亡时 splice 数组，倒序避免跳过相邻元素）
    for (let i = this.specialMobs.length - 1; i >= 0; i--) {
      const mob = this.specialMobs[i];
      const bx = mob.pos.x - p.pos.x, bz = mob.pos.z - p.pos.z;
      const bd = Math.hypot(bx, bz) - mob.radius;
      if (bd <= range && (bx * dx + bz * dz) / (Math.hypot(bx, bz) || 1) > 0.1)
        this.damageSpecialMob(mob, this.dmgMul(p, def.dmg, true).dmg, p);
    }
    // 补给箱可被近战破坏
    if (this.airdropCrate && this.airdropCrate.alive) {
      const bx = this.airdropCrate.pos.x - p.pos.x, bz = this.airdropCrate.pos.z - p.pos.z;
      const bd = Math.hypot(bx, bz);
      if (bd <= range + 1 && (bx * dx + bz * dz) / (bd || 1) > 0.3)
        this.damageCrate(def.dmg, p);
    }
    // 油桶也能砸爆
    for (const br of this.barrels) {
      if (!br.alive) continue;
      const bx = br.x - p.pos.x, bz = br.z - p.pos.z;
      const bd = Math.hypot(bx, bz) - MAP.barrelR;
      if (bd <= range && (bx * dx + bz * dz) / (Math.hypot(bx, bz) || 1) > 0.3)
        this.damageBarrel(br, def.dmg, p);
    }
  }

  // 打光备弹：只提示玩家（不自动切武器，枪留在手里=空枪，玩家自己去捡新武器）
  outOfAmmo(p) {
    this.sendTo(p.id, { type: 'dry', name: p.gun ? WEAPONS[p.gun].name : '枪械' });
  }

  handleFire(p, m) {
    if (!p.alive || p.active !== 'gun' || !p.gun) return;
    if (this.buffOn(p, 'zombie')) return;
    const def = WEAPONS[p.gun], t = now();
    if (t < p.reloadUntil) return;
    if (p.ammo <= 0) {
      if (p.ammoReserve > 0) p.reloadUntil = t + def.reload * 1000;   // 有备弹：进换弹冷却
      else this.outOfAmmo(p);                                          // 无备弹：空枪切近战
      return;
    }
    if (!p.mon.cooldown('fire_' + p.gun, def.cd * 1000 * 0.8)) return;
    p.ammo--;
    p.mon.recordShot();
    if (p.ammo <= 0) {
      if (p.ammoReserve > 0) p.reloadUntil = t + def.reload * 1000;   // 打空当前匣、有备弹 → 自动换弹
      else this.outOfAmmo(p);                                          // 打出最后一发、无备弹 → 切近战
    }
    const eye = { x: p.pos.x, y: p.pos.y + RULES.eyeH, z: p.pos.z };
    const co = m.o;
    if (Array.isArray(co) && Math.hypot(co[0] - eye.x, co[1] - eye.y, co[2] - eye.z) < 2.5) {
      eye.x = +co[0]; eye.y = +co[1]; eye.z = +co[2];
    }
    const dv = p.mon.vec3(m.d, { unit: true });   // 方向必须为有限单位向量
    if (!dv) return;
    this.recordAuditShot(p, p.gun);
    this.markShotAwareness(p, t);
    const d = { x: dv[0], y: dv[1], z: dv[2] };

    if (def.projectile === 'rocket') {
      const mView = this.viewVec(p);
      p.mon.aimShot({ dir: dv, view: mView, hit: false, headshot: false });
      const mRight = [Math.cos(p.yaw), 0, -Math.sin(p.yaw)];
      const muzzle = {
        x: eye.x + d.x * 1.05 + mRight[0] * 0.12,
        y: eye.y + d.y * 1.05 - 0.12,
        z: eye.z + d.z * 1.05 + mRight[2] * 0.12,
      };
      this.spawnProj('rocket', muzzle, {
        x: d.x * def.projectileSpeed,
        y: d.y * def.projectileSpeed,
        z: d.z * def.projectileSpeed,
      }, def.dmg, {
        owner: p.id, wp: p.gun, aoe: def.radius, falloff: def.falloff,
        selfMul: def.selfDamageMul, maxRange: def.range, speed: def.projectileSpeed,
      });
      this.broadcast({
        type: 'fx', k: 'rocketshot', id: p.id, wp: p.gun,
        o: [r2(muzzle.x), r2(muzzle.y), r2(muzzle.z)],
      });
      return;
    }

    let bestT = def.range, target = null, headshot = false, hitBoss = false, hitBarrel = null;
    for (const o of this.players.values()) {
      if (o === p || !o.alive) continue;
      const body = raySphere(eye, d, { x: o.pos.x, y: o.pos.y + 0.95, z: o.pos.z }, 0.55);
      const head = raySphere(eye, d, { x: o.pos.x, y: o.pos.y + 1.55, z: o.pos.z }, 0.34);
      let tt = null, hs = false;
      if (head !== null && (body === null || head <= body)) { tt = head; hs = true; }
      else if (body !== null) tt = body;
      if (tt !== null && tt < bestT) { bestT = tt; target = o; headshot = hs; hitBoss = false; hitBarrel = null; }
    }
    if (this.boss) {
      const bt = raySphere(eye, d, { x: this.boss.pos.x, y: this.boss.cfg.yc, z: this.boss.pos.z }, this.boss.cfg.radius + 0.3);
      if (bt !== null && bt < bestT) { bestT = bt; target = null; hitBoss = true; hitBarrel = null; }
    }
    // 精英怪可被射击
    let hitSpecial = null;
    for (const mob of this.specialMobs) {
      const bt = raySphere(eye, d, { x: mob.pos.x, y: mob.yc, z: mob.pos.z }, mob.radius + 0.3);
      if (bt !== null && bt < bestT) { bestT = bt; target = null; hitBoss = false; hitBarrel = null; hitSpecial = mob; }
    }
    // 补给箱可被射击
    let hitCrate = false;
    if (this.airdropCrate && this.airdropCrate.alive) {
      const bt = raySphere(eye, d, { x: this.airdropCrate.pos.x, y: 0.9, z: this.airdropCrate.pos.z }, 1.2);
      if (bt !== null && bt > 0 && bt < bestT) { bestT = bt; target = null; hitBoss = false; hitBarrel = null; hitSpecial = null; hitCrate = true; }
    }
    for (const br of this.barrels) {
      if (!br.alive) continue;
      const bt = rayAABB(eye, d, barrelBox(br));
      if (bt !== null && bt > 0 && bt < bestT) { bestT = bt; target = null; hitBoss = false; hitBarrel = br; }
    }
    // 静态障碍遮挡
    let tObs = def.range;
    for (const b of OBS) { const h = rayAABB(eye, d, b); if (h !== null && h < tObs) tObs = h; }
    let endT = bestT;
    if (tObs < bestT) { target = null; hitBoss = false; hitBarrel = null; hitSpecial = null; hitCrate = false; endT = tObs; }
    const end = [r2(eye.x + d.x * endT), r2(eye.y + d.y * endT), r2(eye.z + d.z * endT)];
    // 瞄准统计：开火方向 vs 最近上报视线，命中/爆头计数（窗口满自动评估）
    const mView = this.viewVec(p);
    p.mon.aimShot({ dir: dv, view: mView, hit: !!target, headshot: !!(target && headshot) });
    if (p.gun === 'sniper' && p.mon.hipSniperShot) {
      const aimingMs = p.aiming ? Math.max(0, t - (p.aimingSince || t)) : 0;
      p.mon.hipSniperShot({
        scoped: !!p.aiming || !!m.zm,
        aimingMs,
        dir: dv, view: mView,
        hit: !!target, headshot: !!(target && headshot),
        distance: target ? bestT : 0,
        victimId: target ? target.id : null,
        moving: !!p.anim,
      });
    }
    // 曳光弹起点用枪口位置（眼睛 + 朝前0.9 + 右偏0.14 + 下偏0.1），和客户端本地 mp 一致，
    // 让观战第三人称看到的弹道从玩家手里枪口射出，而非从眼睛/头部
    const mRight = [Math.cos(p.yaw), 0, -Math.sin(p.yaw)];   // 右向量（与 viewVec 的 forward 正交）
    const muzzle = [eye.x + mView[0] * 0.9 + mRight[0] * 0.14,
                    eye.y + mView[1] * 0.9 - 0.1,
                    eye.z + mView[2] * 0.9 + mRight[2] * 0.14];
    this.broadcast({ type: 'fx', k: 'shot', id: p.id, wp: p.gun, o: [r2(muzzle[0]), r2(muzzle[1]), r2(muzzle[2])], e: end, tg: target ? target.id : (hitBoss ? -1 : 0) });
    if (target) {
      this.recordPreaimHit(p, target, t);
      const dealt = this.applyDamage(target, def.dmg, p, { wp: p.gun, hs: headshot });
      if (dealt > 0) this.recordAuditHit(p, p.gun, headshot);
    }
    else if (hitBoss) this.damageBoss(this.dmgMul(p, def.dmg, false).dmg, p);
    else if (hitSpecial) this.damageSpecialMob(hitSpecial, this.dmgMul(p, def.dmg, false).dmg, p);
    else if (hitCrate) this.damageCrate(def.dmg, p);
    else if (hitBarrel) this.damageBarrel(hitBarrel, def.dmg, p);
  }

  handleNade(p, m) {
    if (!p.alive || !p.nadeType || p.nadeLeft <= 0) return;   // 投掷物用完不能投
    if (this.buffOn(p, 'zombie')) return;
    const t = now(), def = WEAPONS[p.nadeType];
    // 同一个 'nade' 冷却标签不分类型：换一种投掷物不能借机绕过冷却
    if (!p.mon.cooldown('nade', def.cd * 1000 * 0.85)) return;
    p.lastNade = t;
    const dv = p.mon.vec3(m.d, { unit: true });
    if (!dv) return;
    const d = { x: dv[0], y: dv[1], z: dv[2] };
    const eye = { x: p.pos.x, y: p.pos.y + RULES.eyeH, z: p.pos.z };
    this.grenades.push({
      id: this.entId++, owner: p.id, kind: def.kind,
      pos: { x: eye.x + d.x * 0.6, y: eye.y, z: eye.z + d.z * 0.6 },
      vel: { x: d.x * 16, y: d.y * 16 + 3.5, z: d.z * 16 },
      explodeAt: t + def.fuse * 1000,
    });
    this.broadcast({ type: 'fx', k: 'throw', id: p.id });
    p.nadeLeft--;
    if (p.nadeLeft <= 0) this.sendTo(p.id, { type: 'dry', name: def.name });   // 投完只提示，不自动切武器
  }

  // 闪光弹致盲：视线被遮挡则免疫；越正对着爆点、离得越近，致盲时间越长
  applyFlash(pos, def) {
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const eye = { x: p.pos.x, y: p.pos.y + RULES.eyeH, z: p.pos.z };
      const dx = pos.x - eye.x, dy = pos.y - eye.y, dz = pos.z - eye.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > def.blindRadius || dist < 0.05) continue;
      const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
      const blockT = this.obstacleBlock(eye, dir, dist);
      if (blockT < dist - 0.15) continue;   // 视线被墙挡住，免疫
      const view = this.viewVec(p);
      const facing = Math.max(0, view[0] * dir.x + view[1] * dir.y + view[2] * dir.z);
      if (facing < 0.12) continue;          // 基本背对/侧对，不吃闪光
      const distFalloff = 1 - dist / def.blindRadius;
      const dur = def.blindMax * Math.pow(facing, 1.4) * (0.35 + 0.65 * distFalloff);
      if (dur < 0.15) continue;
      const flashMs = Math.round(dur * 1000);
      const flashUntil = now() + flashMs;
      if (flashUntil > (p.blindUntil || 0)) {
        p.blindUntil = flashUntil;
        p.blindTotal = flashMs;
      }
      this.sendTo(p.id, { type: 'flashed', ms: flashMs });
    }
  }

  handleReload(p) {
    if (!p.alive || !p.gun) return;
    const def = WEAPONS[p.gun], t = now();
    if (t < p.reloadUntil || p.ammo >= def.mag || p.ammoReserve <= 0) return;   // 无备弹不能换
    p.reloadUntil = t + def.reload * 1000;
  }

  handleSwitch(p, m) {
    const slot = m.slot;
    if (!p.alive) return;
    if (this.buffOn(p, 'zombie') && slot !== 'melee') return;
    if (slot === 'melee') p.active = 'melee';
    else if (slot === 'gun' && p.gun) p.active = 'gun';
    else if (slot === 'nade' && p.nadeType) p.active = 'nade';
    if (p.active !== 'gun' || p.gun !== 'sniper') { p.aiming = 0; p.aimingSince = 0; }
  }

  handlePickup(p, m) {
    if (!p.alive) return;
    if (m.drop !== undefined) { this.handleLootPickup(p, m.drop); return; }
    const pk = this.pickups[m.id | 0];
    if (!pk || !pk.avail) return;
    const dist = Math.hypot(pk.def.x - p.pos.x, pk.def.z - p.pos.z);
    if (dist > RULES.pickupDist) {
      if (dist > RULES.pickupDist * 3) p.mon.flag('range', undefined, `远距拾取探测 ${dist.toFixed(1)}m`);
      return;
    }
    if (Math.abs(p.pos.y - (pk.def.y || 0)) > 2) return;
    const item = pk.item;
    pk.avail = false;
    pk.respawnAt = now() + rand(RULES.pickupRespawnMin, RULES.pickupRespawnMax) * 1000;
    this.grantItem(p, item);
    this.broadcast({ type: 'pk', ev: 'taken', id: pk.def.id, by: p.id, item });
  }

  lootDropPos(victim, index, total) {
    const minR = RULES.deathLootScatterMin;
    const maxR = RULES.deathLootScatterMax;
    const radius = total <= 1 ? (minR + maxR) * 0.5 : minR + (maxR - minR) * (index / Math.max(1, total - 1));
    const base = victim.yaw + Math.PI / 2 + Math.PI * 2 * index / Math.max(1, total);
    const lim = MAP.half - 0.8;
    for (let attempt = 0; attempt < 7; attempt++) {
      const step = Math.ceil(attempt / 2) * 0.42 * (attempt % 2 ? 1 : -1);
      const angle = base + step;
      const probe = {
        x: clamp(victim.pos.x + Math.cos(angle) * radius, -lim, lim),
        y: victim.pos.y,
        z: clamp(victim.pos.z + Math.sin(angle) * radius, -lim, lim),
      };
      const pos = { x: probe.x, y: this.floorAtSrv(probe), z: probe.z };
      if (!this.inSolidSrv(pos)) return pos;
    }
    const center = { x: clamp(victim.pos.x, -lim, lim), y: victim.pos.y, z: clamp(victim.pos.z, -lim, lim) };
    center.y = this.floorAtSrv(center);
    return center;
  }

  dropPlayerLoadout(victim) {
    const entries = [];
    if (victim.melee && victim.melee !== 'fist') entries.push({ item: victim.melee, slot: 'melee' });
    if (victim.gun && victim.ammo + victim.ammoReserve > 0) {
      entries.push({ item: victim.gun, slot: 'gun', ammo: victim.ammo, reserve: victim.ammoReserve });
    }
    if (victim.nadeType && victim.nadeLeft > 0) entries.push({ item: victim.nadeType, slot: 'nade', count: victim.nadeLeft });
    if (!entries.length) return;
    const t = now();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      this.lootDrops.push({
        id: this.entId++, item: entry.item, slot: entry.slot,
        pos: this.lootDropPos(victim, i, entries.length),
        ammo: entry.ammo || 0, reserve: entry.reserve || 0, count: entry.count || 0,
        availableAt: t + RULES.deathLootPickupDelayMs,
        expiresAt: t + RULES.deathLootLifetimeMs,
      });
    }
    if (this.lootDrops.length > RULES.deathLootMax) {
      this.lootDrops.splice(0, this.lootDrops.length - RULES.deathLootMax);
    }
  }

  handleLootPickup(p, rawId) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) return;
    const index = this.lootDrops.findIndex(drop => drop.id === id);
    if (index < 0) return;
    const drop = this.lootDrops[index];
    const t = now();
    if (t < drop.availableAt || t >= drop.expiresAt) return;
    const dist = Math.hypot(drop.pos.x - p.pos.x, drop.pos.z - p.pos.z);
    if (dist > RULES.pickupDist) {
      if (dist > RULES.pickupDist * 3 && p.mon) p.mon.flag('range', undefined, `远距舔包探测 ${dist.toFixed(1)}m`);
      return;
    }
    if (Math.abs(p.pos.y - drop.pos.y) > 2) return;
    this.lootDrops.splice(index, 1);
    this.grantLootDrop(p, drop);
  }

  grantLootDrop(p, drop) {
    const def = WEAPONS[drop.item];
    if (!def || def.slot !== drop.slot) return;
    let desc = '遗落武器';
    if (drop.slot === 'melee') {
      p.melee = drop.item;
      if (!this.buffOn(p, 'zombie')) p.active = 'melee';
    } else if (drop.slot === 'gun') {
      const maxReserve = def.mag * def.reserveMags;
      if (p.gun === drop.item) {
        const total = Math.min(def.mag + maxReserve, p.ammo + p.ammoReserve + drop.ammo + drop.reserve);
        p.ammo = Math.min(def.mag, total);
        p.ammoReserve = Math.min(maxReserve, Math.max(0, total - p.ammo));
      } else {
        p.gun = drop.item;
        p.ammo = clamp(drop.ammo, 0, def.mag);
        p.ammoReserve = clamp(drop.reserve, 0, maxReserve);
      }
      p.reloadUntil = 0;
      if (!this.buffOn(p, 'zombie')) p.active = 'gun';
      desc = `遗落枪械 · ${p.ammo}/${def.mag} · 备弹 ${p.ammoReserve}`;
    } else if (drop.slot === 'nade') {
      p.nadeLeft = p.nadeType === drop.item
        ? Math.min(def.count, p.nadeLeft + drop.count)
        : clamp(drop.count, 0, def.count);
      p.nadeType = drop.item;
      desc = `遗落投掷物 · ×${p.nadeLeft}`;
    }
    this.sendTo(p.id, { type: 'got', item: drop.item, kind: 'wep', name: def.name, desc });
  }

  grantItem(p, item) {
    const t = now();
    let info = null;
    if (WEAPONS[item]) {
      const def = WEAPONS[item];
      if (def.slot === 'melee') { p.melee = item; if (!this.buffOn(p, 'zombie')) p.active = 'melee'; }
      else if (def.slot === 'gun') { p.gun = item; p.ammo = def.mag; p.ammoReserve = def.mag * def.reserveMags; p.reloadUntil = 0; if (!this.buffOn(p, 'zombie')) p.active = 'gun'; }   // 拾取补满弹匣+备弹
      else if (def.slot === 'nade') { p.nadeType = item; p.nadeLeft = def.count; }   // 拾取补满投掷数
      const nadeDesc = item === 'flash' ? '按 3 投掷 · 致盲正对爆点的敌人'
        : item === 'smoke' ? '按 3 投掷 · 制造视野遮蔽烟雾'
        : def.slot === 'nade' ? '按 3 投掷 · 无限数量有冷却' : '';
      info = { kind: 'wep', name: def.name, desc: nadeDesc };
    } else if (EQUIPS[item]) {
      if (item === 'health') p.hp = Math.min(RULES.maxHp, p.hp + 50);
      else if (item === 'armor') p.armor = Math.min(RULES.maxArmor, p.armor + 50);
      else if (item === 'boots') p.boots = Math.min(3, p.boots + 1);
      info = { kind: 'equip', name: EQUIPS[item].name, desc: EQUIPS[item].desc };
    } else if (BUFFS[item]) {
      const b = BUFFS[item];
      p.buffs[item] = t + b.dur * 1000;
      if (item === 'zombie') p.active = 'melee';
      if (item === 'shield') p.shield = RULES.shieldHp;
      info = { kind: 'buff', name: b.name, desc: b.desc };
    }
    if (info) this.sendTo(p.id, { type: 'got', item, kind: info.kind, name: info.name, desc: info.desc });
  }

  handleChat(p, m) {
    const t = now();
    if (t - p.lastChatAt < 600) return;
    const text = String(m.text || '').replace(/[<>]/g, '').trim().slice(0, 120);
    if (!text) return;
    p.lastChatAt = t;
    const filtered = this.chatFilter ? this.chatFilter.filter(text) : { text };
    const message = { type: 'chat', from: p.name, color: p.color, text: filtered.text, at: t };
    if (this.chatHistory) this.chatHistory.add(message);
    this.broadcast(message);
  }

  handleBuy(p, m) {
    const item = SHOP.find(s => s.id === m.id);
    if (!item) return;
    if (p.owned.includes(item.id)) { this.sendTo(p.id, { type: 'shopmsg', ok: false, text: '已拥有该外观' }); return; }
    if (p.coins < item.price) { this.sendTo(p.id, { type: 'shopmsg', ok: false, text: '金币不足！击杀玩家与 BOSS 可获得金币' }); return; }
    p.coins -= item.price;
    p.owned.push(item.id);
    p.eq[item.slot] = item.id;
    this.saveProfile(p);
    this.sendYou(p);
    this.sendTo(p.id, { type: 'shopmsg', ok: true, text: `购买成功：${item.name}` });
    if (item.price >= 400) this.broadcast({ type: 'sys', style: 'shop', text: `${p.name} 购入了豪华外观「${item.name}」` });
  }

  handleEquipCos(p, m) {
    const slot = m.slot;
    if (!['head', 'face', 'back', 'fx'].includes(slot)) return;
    if (m.id !== null && !p.owned.includes(m.id)) return;
    if (m.id !== null && !SHOP.find(s => s.id === m.id && s.slot === slot)) return;
    p.eq[slot] = m.id;
    this.saveProfile(p);
    this.sendYou(p);
  }

  sendYou(p) {
    this.sendTo(p.id, { type: 'you', coins: p.coins, owned: p.owned, eq: p.eq });
  }

  // ---------- 伤害结算 ----------
  dmgMul(p, raw, melee) {
    let dmg = raw, crit = false;
    if (this.buffOn(p, 'rage')) dmg *= RULES.rageMul;
    if (melee && this.buffOn(p, 'zombie')) dmg *= RULES.zombieMeleeMul;
    if (this.buffOn(p, 'crit') && Math.random() < RULES.critChance) { dmg *= 2; crit = true; }
    return { dmg, crit };
  }

  applyDamage(victim, raw, attacker, opts = {}) {
    if (!victim.alive) return 0;
    const t = now();
    if (victim.protectUntil > t) {
      this.broadcast({ type: 'fx', k: 'immune', tg: victim.id, pos: this.chest(victim) });
      return 0;
    }
    let dmg = raw, crit = false;
    if (attacker && attacker !== victim) { const r = this.dmgMul(attacker, raw, !!opts.melee); dmg = r.dmg; crit = r.crit; }
    if (opts.hs) dmg *= RULES.headshotMul;
    if (victim.shield > 0 && this.buffOn(victim, 'shield')) {
      const abs = Math.min(victim.shield, dmg);
      victim.shield -= abs; dmg -= abs;
    }
    if (dmg > 0 && victim.armor > 0) {
      const abs = Math.min(victim.armor, dmg * RULES.armorAbsorb);
      victim.armor -= abs; dmg -= abs;
    }
    dmg = Math.round(dmg);
    if (attacker && attacker !== victim && dmg > 0) this.markCombatAwareness(attacker, victim, t);
    victim.hp -= dmg;
    if (attacker && attacker !== victim && opts.melee && this.buffOn(attacker, 'zombie'))
      attacker.hp = Math.min(RULES.maxHp, attacker.hp + dmg * RULES.zombieLifesteal);
    this.broadcast({
      type: 'fx', k: 'hit', tg: victim.id, by: attacker ? attacker.id : 0,
      dmg, crit, hs: !!opts.hs, pos: this.chest(victim),
      wp: opts.wp || null, melee: !!opts.melee,   // 附带武器信息供客户端做打击反馈分化，不影响判定
    });
    if (victim.hp <= 0) this.killPlayer(victim, attacker, opts.wp || 'boss', opts.bossName);
    return dmg;
  }

  chest(p) { return [r2(p.pos.x), r2(p.pos.y + 1.1), r2(p.pos.z)]; }

  killPlayer(victim, attacker, wp, bossName) {
    victim.alive = false; victim.hp = 0; victim.deaths++; victim.buffs = {}; victim.shield = 0;
    victim.aiming = 0; victim.aimingSince = 0; victim.blindUntil = 0; victim.blindTotal = 1;
    victim.deadUntil = now() + RULES.respawnMs;
    this.dropPlayerLoadout(victim);
    const vProf = board.get(victim.name); vProf.deaths++; board.save();
    const shutdown = victim.streak >= 5 ? victim.streak : 0;
    victim.streak = 0;
    if (victim.mon && typeof victim.mon.setPersistentScore === 'function') victim.mon.setPersistentScore('streak', 0);
    victim.acStreak = { victims: new Set(), flags: {} };
    let kInfo = null;
    if (attacker && attacker !== victim) {
      this.recordKillPace(attacker, victim, wp, bossName);
      if (attacker.mon) attacker.mon.recordKill(wp);
      attacker.kills++; attacker.score += RULES.killScore; attacker.coins += RULES.killCoins;
      attacker.hp = Math.min(RULES.maxHp, attacker.hp + RULES.killHeal);
      attacker.streak++;
      attacker.maxStreak = Math.max(attacker.maxStreak || 0, attacker.streak);
      this.recordAuditKill(attacker, wp);
      this.recordStreakAux(attacker, victim, wp, bossName);
      this.recordDominance(attacker, victim, wp, bossName);
      const aProf = board.get(attacker.name); aProf.kills++;
      if (attacker.streak > aProf.bestStreak) aProf.bestStreak = attacker.streak;   // 历史最高连杀入档
      // 历史最好单会话成绩：本次会话击杀超过历史最高则整组更新（kills/score/deaths 同源同会话）
      if (attacker.kills > aProf.bestSession.kills) {
        aProf.bestSession.kills = attacker.kills;
        aProf.bestSession.score = attacker.score;
        aProf.bestSession.deaths = attacker.deaths;
      }
      board.save();
      kInfo = { id: attacker.id, n: attacker.name, c: attacker.color };
      const s = attacker.streak;
      const label = s === 3 ? '三连杀!' : s === 5 ? '五连杀!!' : s === 8 ? '八连杀，锐不可当!' : s === 12 ? '超神了!!!' : null;
      if (label) this.broadcast({ type: 'sys', style: 'streak', text: `${attacker.name} ${label}` });
      if (shutdown) this.broadcast({ type: 'sys', style: 'streak', text: `${attacker.name} 终结了 ${victim.name} 的 ${shutdown} 连杀` });
    }
    this.broadcast({
      type: 'kill',
      k: kInfo, v: { id: victim.id, n: victim.name, c: victim.color },
      wp, boss: bossName || null, self: attacker === victim,
    });
    this.broadcast({ type: 'fx', k: 'die', id: victim.id, pos: this.chest(victim) });
  }

  recordKillPace(attacker, victim, wp, bossName) {
    if (!attacker.mon || attacker.mon.kicked || bossName || wp === 'barrel') return;
    if (!attacker.acKillPace) attacker.acKillPace = { kills: [], flags: {} };
    const t = now();
    const state = attacker.acKillPace;
    state.kills = state.kills.filter(k => t - k.t <= KILL_PACE_MAX_WINDOW);
    state.kills.push({
      t,
      victimKey: antiCheatVictimKey(victim),
      victimId: victim.id,
      victimName: victim.name,
      wp: wp || '',
    });
    const alivePlayers = [...this.players.values()].filter(p => p.alive).length;
    const totalPlayers = Math.max(alivePlayers, this.players.size);

    for (const rule of KILL_PACE_RULES) {
      if (totalPlayers < rule.minPlayers) continue;
      const recent = state.kills.filter(k => t - k.t <= rule.windowMs);
      if (recent.length < rule.minKills) continue;
      const victims = new Set(recent.map(k => k.victimKey || k.victimId || k.victimName));
      if (victims.size < rule.minVictims) continue;
      if (t - (state.flags[rule.tag] || 0) < rule.cooldownMs) continue;
      state.flags[rule.tag] = t;
      attacker.mon.flag(
        'killpace',
        rule.weight,
        `${Math.round(rule.windowMs / 1000)}s 内击杀 ${recent.length} 次 / ${victims.size} 名玩家，在线 ${totalPlayers} 人`
      );
    }
  }

  // 15/20 连杀保持弱辅助分；30 连杀在低人数刷榜场景中直接走现有踢出阈值。
  recordStreakAux(attacker, victim, wp, bossName) {
    if (!attacker.mon || attacker.mon.kicked || bossName || wp === 'barrel') return;
    if (!attacker.acStreak) attacker.acStreak = { victims: new Set(), flags: {} };
    const state = attacker.acStreak;
    if (!(state.victims instanceof Set)) state.victims = new Set(state.victims || []);
    state.victims.add(antiCheatVictimKey(victim));
    const totalPlayers = this.players.size;

    for (const rule of STREAK_AUX_RULES) {
      if (state.flags[rule.tag] || attacker.streak < rule.minStreak) continue;
      if (totalPlayers < rule.minPlayers || state.victims.size < rule.minVictims) continue;
      state.flags[rule.tag] = true;
      const detail = `${attacker.streak} 连杀 / ${state.victims.size} 名玩家，在线 ${totalPlayers} 人`;
      if (rule.enforce) attacker.mon.flag('streak', rule.score, detail);
      else attacker.mon.setPersistentScore('streak', rule.score, detail);
    }
  }

  recordDominance(attacker, victim, wp, bossName) {
    if (!attacker.mon || attacker.mon.kicked || bossName || wp === 'barrel') return;
    if (!attacker.acDominance) attacker.acDominance = { victims: new Set(), nextCheckAt: 0 };
    const state = attacker.acDominance;
    if (!(state.victims instanceof Set)) state.victims = new Set(state.victims || []);
    state.victims.add(antiCheatVictimKey(victim));
    const t = now();
    if (t < state.nextCheckAt) return;
    const sessionMs = t - (attacker.sessionStartedAt || t);
    if (sessionMs < AC_BEHAVIOR.dominanceMinSessionMs
      || attacker.kills < AC_BEHAVIOR.dominanceMinKills
      || state.victims.size < AC_BEHAVIOR.dominanceMinVictims
      || this.players.size < AC_BEHAVIOR.dominanceMinPlayers) return;
    const kd = attacker.kills / Math.max(1, attacker.deaths);
    const kpm = attacker.kills / Math.max(1, sessionMs / 60000);
    if (kd < AC_BEHAVIOR.dominanceMinKd || kpm < AC_BEHAVIOR.dominanceMinKpm) return;
    const evidence = attacker.mon.violations.filter(entry =>
      !entry.persistent && t - entry.t <= AC_BEHAVIOR.dominanceEvidenceMs
    );
    const aimRules = [...new Set(evidence.filter(entry => DOMINANCE_AIM_RULES.has(entry.rule)).map(entry => entry.rule))];
    const cooldownEvents = evidence.filter(entry => entry.rule === 'cooldown').length;
    const movementEvents = evidence.filter(entry => DOMINANCE_MOVEMENT_RULES.has(entry.rule)).length;
    const lowLatencyMovement = typeof attacker.mon.movementEvidenceSafe === 'function'
      && attacker.mon.movementEvidenceSafe(AC_BEHAVIOR.dominanceMovementMaxRttMs);
    const fused = state.victims.size >= AC_BEHAVIOR.dominanceFusionMinVictims
      && this.players.size >= AC_BEHAVIOR.dominanceFusionMinPlayers
      && cooldownEvents >= AC_BEHAVIOR.dominanceCooldownEvents
      && movementEvents >= AC_BEHAVIOR.dominanceMovementEvents
      && lowLatencyMovement;
    const detail = `${attacker.kills}杀${attacker.deaths}死 K/D=${kd.toFixed(1)}，${kpm.toFixed(1)}杀/分，目标${state.victims.size}人`;
    if (fused) {
      state.nextCheckAt = t + AC_BEHAVIOR.dominanceObserveMs * 2;
      attacker.mon.flag('dominance', AC_BEHAVIOR.dominanceFusionWeight, `${detail}，关联 cooldown×${cooldownEvents}/movement×${movementEvents}`);
    } else if (aimRules.length) {
      state.nextCheckAt = t + AC_BEHAVIOR.dominanceObserveMs * 2;
      attacker.mon.flag('dominance', AC_BEHAVIOR.dominanceWeight, `${detail}，关联 ${aimRules.join('/')}`);
    } else {
      state.nextCheckAt = t + AC_BEHAVIOR.dominanceObserveMs;
      const context = `cooldown×${cooldownEvents}/movement×${movementEvents}`;
      attacker.mon.observe('dominance', `${detail}，组合证据不足（${context}）`);
    }
  }

  // ---------- 范围伤害（手雷/油桶/火箭/爆破 共用，含油桶连锁） ----------
  aoeDamage(pos, radius, dmg, attacker, opts = {}) {
    const falloff = opts.falloff === undefined ? 0.6 : opts.falloff;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.pos.x - pos.x, (p.pos.y + 1) - pos.y, p.pos.z - pos.z);
      if (d <= radius) {
        const directHit = opts.directTargetId === p.id;
        if (opts.lineOfSight && !directHit && d > 0.2) {
          const dir = {
            x: (p.pos.x - pos.x) / d,
            y: ((p.pos.y + 1) - pos.y) / d,
            z: (p.pos.z - pos.z) / d,
          };
          const sightStart = {
            x: pos.x + dir.x * 0.12,
            y: pos.y + dir.y * 0.12,
            z: pos.z + dir.z * 0.12,
          };
          const sightDistance = Math.max(0, d - 0.12);
          if (this.obstacleBlock(sightStart, dir, sightDistance) < sightDistance - 0.15) continue;
        }
        const selfMul = attacker && p === attacker ? (opts.selfMul === undefined ? 1 : opts.selfMul) : 1;
        const distanceMul = directHit ? 1 : (1 - falloff * d / radius);
        this.applyDamage(p, dmg * distanceMul * selfMul, attacker, { wp: opts.wp, bossName: opts.bossName });
      }
    }
    if (this.boss) {
      const d = Math.hypot(this.boss.pos.x - pos.x, this.boss.cfg.yc - pos.y, this.boss.pos.z - pos.z);
      if (d <= radius + this.boss.cfg.radius && !opts.bossName) this.damageBoss(dmg, attacker);
    }
    for (let i = this.specialMobs.length - 1; i >= 0; i--) {
      const mob = this.specialMobs[i];
      const dd = Math.hypot(mob.pos.x - pos.x, mob.yc - pos.y, mob.pos.z - pos.z);
      if (dd <= radius + mob.radius) this.damageSpecialMob(mob, dmg, attacker);
    }
    if (this.airdropCrate && this.airdropCrate.alive) {
      const d = Math.hypot(this.airdropCrate.pos.x - pos.x, 0.9 - pos.y, this.airdropCrate.pos.z - pos.z);
      if (d <= radius) this.damageCrate(dmg, attacker);
    }
    for (const br of this.barrels) {
      if (!br.alive) continue;
      const d = Math.hypot(br.x - pos.x, 0.9 - pos.y, br.z - pos.z);
      if (d <= radius) this.damageBarrel(br, dmg, attacker);
    }
  }

  // ---------- 油桶 ----------
  damageBarrel(br, dmg, attacker) {
    if (!br.alive) return;
    br.hp -= dmg;
    if (br.hp <= 0) {
      br.alive = false;
      br.respawnAt = now() + rand(RULES.barrelRespawnMin, RULES.barrelRespawnMax) * 1000;
      this.broadcast({ type: 'fx', k: 'barrel', id: br.id });
      this.broadcast({ type: 'fx', k: 'explode', pos: [r2(br.x), 0.9, r2(br.z)], r: RULES.barrelRadius, fire: true });
      this.aoeDamage({ x: br.x, y: 0.9, z: br.z }, RULES.barrelRadius, RULES.barrelDmg, attacker, { wp: 'barrel', falloff: 0.5 });
    } else {
      this.broadcast({ type: 'fx', k: 'barrelhit', id: br.id, pos: [r2(br.x), 1.2, r2(br.z)] });
    }
  }

  // ---------- BOSS ----------
  spawnBoss() {
    const type = pick(Object.keys(BOSSES));
    const cfg = BOSSES[type];
    const [x, z] = pick(MAP.bossSpawns);
    const maxHp = Math.round(cfg.hp * BOSS.hpMul);
    this.boss = {
      type, cfg, name: cfg.name, hp: maxHp, maxHp,
      pos: { x, y: 0, z }, yaw: 0,
      nextMelee: 0, nextFire: now() + 2500,
      nextBlink: now() + 4000, invisUntil: 0, nextInvis: now() + 7000,
      nextBurst: now() + 3000, burstLeft: 0, burstNextAt: 0,
      nextRocket: now() + 6000,
      nextOrb: now() + 2500, nextBlast: now() + 5000,
      strafeDir: Math.random() < 0.5 ? -1 : 1, nextStrafeFlip: 0,
      wander: null, wanderUntil: 0,
      damagers: new Map(),
      threat: new Map(),
      targetId: null, targetLockUntil: 0, nextRetarget: 0,
      avoidDir: Math.random() < 0.5 ? -1 : 1, avoidUntil: 0, blockedFor: 0,
    };
    this.broadcast({ type: 'sys', style: 'boss', text: `⚠️ BOSS「${cfg.name}」降临竞技场！击杀可获 ${cfg.killCoins} 金币与强力增益` });
    this.broadcast({ type: 'fx', k: 'roar', pos: [x, 0, z] });
  }

  damageBoss(dmg, attacker) {
    const b = this.boss;
    if (!b) return;
    dmg = Math.round(dmg);
    b.hp -= dmg;
    if (attacker) {
      b.damagers.set(attacker.id, (b.damagers.get(attacker.id) || 0) + dmg);
      b.threat.set(attacker.id, Math.min(BOSS.damageThreatMax, (b.threat.get(attacker.id) || 0) + dmg));
    }
    this.broadcast({ type: 'fx', k: 'bosshit', dmg, by: attacker ? attacker.id : 0, pos: [r2(b.pos.x), b.cfg.yc, r2(b.pos.z)] });
    if (b.hp <= 0) {
      const killer = attacker;
      this.broadcast({ type: 'fx', k: 'explode', pos: [r2(b.pos.x), 1.5, r2(b.pos.z)], r: 8, boss: true });
      if (killer && this.players.has(killer.id)) {
        killer.score += BOSS.killScore; killer.coins += b.cfg.killCoins;
        killer.hp = RULES.maxHp;
        const bk = pick(Object.keys(BUFFS));
        killer.buffs[bk] = now() + BUFFS[bk].dur * 1000;
        if (bk === 'shield') killer.shield = RULES.shieldHp;
        if (bk === 'zombie') killer.active = 'melee';
        const prof = board.get(killer.name); prof.bossKills++; board.save();
        this.saveProfile(killer);
        this.broadcast({ type: 'sys', style: 'boss', text: `🏆 ${killer.name} 击杀了 BOSS「${b.name}」！获得 ${b.cfg.killCoins} 金币 + 满血 + ${BUFFS[bk].name}增益` });
        this.sendYou(killer);
      }
      for (const [pid, d] of b.damagers) {
        const p = this.players.get(pid);
        if (p && p !== killer && d >= BOSS.assistMin) {
          p.coins += BOSS.assistCoins;
          this.sendTo(pid, { type: 'got', kind: 'coin', name: `BOSS 助攻 +${BOSS.assistCoins} 金币`, desc: '' });
          this.sendYou(p);
        }
      }
      this.boss = null;
      this.nextBossAt = now() + rand(BOSS.respawnMin, BOSS.respawnMax) * 1000;
    }
  }

  spawnProj(kind, pos, vel, dmg, opts = {}) {
    this.projs.push(Object.assign({ id: this.entId++, kind, pos, vel, dmg, born: now() }, opts));
  }

  aimAt(from, fromY, target) { // 归一化指向目标胸口的方向
    const d = { x: target.pos.x - from.x, y: (target.pos.y + 1.1) - fromY, z: target.pos.z - from.z };
    const L = Math.hypot(d.x, d.y, d.z) || 1;
    return { x: d.x / L, y: d.y / L, z: d.z / L };
  }

  bossRankBonuses(t) {
    const ranked = [...this.players.values()]
      .filter(p => p.alive && !(p.protectUntil > t))
      .sort((a, b) => b.kills - a.kills || b.streak - a.streak || b.score - a.score || a.deaths - b.deaths);
    const bonuses = new Map();
    if (!ranked.length || ranked[0].kills <= 0) return bonuses;
    if (ranked.length >= BOSS.rankMinPlayers) {
      for (let i = 0; i < Math.min(BOSS.rankBonus.length, ranked.length); i++) bonuses.set(ranked[i].id, BOSS.rankBonus[i]);
    } else if (ranked.length >= 2) {
      bonuses.set(ranked[0].id, BOSS.lowPopulationRankBonus);
    }
    return bonuses;
  }

  decayBossThreat(b, dt) {
    for (const [id, value] of b.threat) {
      const next = value - BOSS.damageThreatDecayPerSec * dt;
      if (next <= 0 || !this.players.has(id)) b.threat.delete(id);
      else b.threat.set(id, next);
    }
  }

  bossTargetScore(b, p, distance, rankBonuses) {
    const recentDamage = Math.min(BOSS.damageThreatMax, b.threat.get(p.id) || 0);
    const streak = Math.min(BOSS.streakCap, Math.max(0, p.streak || 0));
    let score = BOSS.aggro - distance;
    score += rankBonuses.get(p.id) || 0;
    score += recentDamage * BOSS.damageThreatScale;
    score += streak * BOSS.streakWeight;
    if (b.targetId === p.id) score += BOSS.currentTargetBonus;
    if (b.type === 'assassin' && p.pos.y >= 1.8) score -= 18;
    return score;
  }

  selectBossTarget(b, t) {
    let current = b.targetId ? this.players.get(b.targetId) : null;
    let currentDistance = Infinity;
    if (current && current.alive && !(current.protectUntil > t)) {
      currentDistance = Math.hypot(current.pos.x - b.pos.x, current.pos.z - b.pos.z);
    } else {
      current = null;
    }
    if (current && currentDistance <= BOSS.disengage && t < b.targetLockUntil) return current;
    if (current && currentDistance <= BOSS.disengage && t < b.nextRetarget) return current;

    b.nextRetarget = t + BOSS.retargetMs;
    const rankBonuses = this.bossRankBonuses(t);
    let best = null, bestScore = -Infinity;
    for (const p of this.players.values()) {
      if (!p.alive || p.protectUntil > t) continue;
      const distance = Math.hypot(p.pos.x - b.pos.x, p.pos.z - b.pos.z);
      if (distance > BOSS.aggro) continue;
      const score = this.bossTargetScore(b, p, distance, rankBonuses);
      if (score > bestScore) { best = p; bestScore = score; }
    }

    if (current && currentDistance <= BOSS.disengage) {
      const currentScore = this.bossTargetScore(b, current, currentDistance, rankBonuses);
      if (!best || best.id === current.id || bestScore < currentScore + BOSS.switchAdvantage) return current;
    }
    if (best) {
      if (best.id !== b.targetId) b.targetLockUntil = t + BOSS.targetLockMs;
      b.targetId = best.id;
      return best;
    }
    b.targetId = null;
    b.targetLockUntil = 0;
    return null;
  }

  moveBoss(b, cfg, mx, mz, dt, t) {
    const moveSpeed = b.moveSpeed || cfg.speed;
    let intent = Math.hypot(mx, mz);
    if (intent > 1) { mx /= intent; mz /= intent; intent = 1; }
    if (intent > 0.05 && b.avoidUntil > t) {
      const sx = -mz * b.avoidDir, sz = mx * b.avoidDir;
      mx = mx * 0.55 + sx * 0.85;
      mz = mz * 0.55 + sz * 0.85;
      const mixed = Math.hypot(mx, mz) || 1;
      mx /= mixed; mz /= mixed;
    }
    const beforeX = b.pos.x, beforeZ = b.pos.z;
    moveCircle(b.pos, cfg.radius, mx * moveSpeed * dt, mz * moveSpeed * dt, this.collideBoxes());
    const expected = intent * moveSpeed * dt;
    const moved = Math.hypot(b.pos.x - beforeX, b.pos.z - beforeZ);
    if (expected > 0.01 && moved < expected * 0.2) {
      b.blockedFor += dt;
      if (b.blockedFor >= 0.45) {
        b.avoidDir *= -1;
        b.avoidUntil = t + 900;
        b.blockedFor = 0;
      }
    } else {
      b.blockedFor = Math.max(0, b.blockedFor - dt * 2);
    }
  }

  updateBoss(dt, t) {
    if (!this.boss) {
      if (t >= this.nextBossAt && [...this.players.values()].some(p => p.alive)) this.spawnBoss();
      return;
    }
    const b = this.boss, cfg = b.cfg;
    this.decayBossThreat(b, dt);
    const target = this.selectBossTarget(b, t);
    let mx = 0, mz = 0;
    if (target) {
      const dx = target.pos.x - b.pos.x, dz = target.pos.z - b.pos.z, d = Math.hypot(dx, dz) || 1;
      b.yaw = Math.atan2(-dx, -dz);
      const ux = dx / d, uz = dz / d;
      const meleeOk = target.pos.y < 1.8;   // 高台上的目标近战够不着

      if (b.type === 'golem') {
        if (d > cfg.meleeRange * 0.75) { mx = ux; mz = uz; }
        if (d <= cfg.meleeRange && meleeOk && t >= b.nextMelee) {
          b.nextMelee = t + cfg.meleeCd * 1000;
          this.broadcast({ type: 'fx', k: 'slam', pos: [r2(b.pos.x), 0, r2(b.pos.z)], r: cfg.meleeRange + 0.6 });
          for (const p of this.players.values()) {
            if (!p.alive || p.pos.y > 1.8) continue;
            if (Math.hypot(p.pos.x - b.pos.x, p.pos.z - b.pos.z) <= cfg.meleeRange + 0.6)
              this.applyDamage(p, cfg.meleeDmg, null, { bossName: b.name });
          }
        }
        if (t >= b.nextFire && d > 4 && d < 38) {
          b.nextFire = t + cfg.fireCd * 1000;
          const dir = this.aimAt(b.pos, 2.6, target);
          this.spawnProj('fire', { x: b.pos.x + dir.x * 1.2, y: 2.6, z: b.pos.z + dir.z * 1.2 },
            { x: dir.x * cfg.fireSpeed, y: dir.y * cfg.fireSpeed, z: dir.z * cfg.fireSpeed }, cfg.fireDmg, { bossName: b.name, aoe: 2 });
          this.broadcast({ type: 'fx', k: 'bossfire', pos: [r2(b.pos.x), 2.6, r2(b.pos.z)] });
        }
      } else if (b.type === 'assassin') {
        if (d > cfg.meleeRange * 0.7) { mx = ux; mz = uz; }
        if (t >= b.nextBlink && d > 5) {
          b.nextBlink = t + cfg.blinkCd * 1000;
          const from = [r2(b.pos.x), 0, r2(b.pos.z)];
          b.pos.x = target.pos.x + ux * 2.2 - uz * b.strafeDir * 1.2;
          b.pos.z = target.pos.z + uz * 2.2 + ux * b.strafeDir * 1.2;
          b.strafeDir *= -1;
          circlePushBoxes(b.pos, cfg.radius, this.collideBoxes());
          this.broadcast({ type: 'fx', k: 'blink', from, to: [r2(b.pos.x), 0, r2(b.pos.z)] });
        }
        if (t >= b.nextInvis) {
          b.nextInvis = t + cfg.invisCd * 1000;
          b.invisUntil = t + cfg.invisDur * 1000;
        }
        if (d <= cfg.meleeRange && meleeOk && t >= b.nextMelee) {
          b.nextMelee = t + cfg.meleeCd * 1000;
          this.broadcast({ type: 'fx', k: 'slash', pos: this.chest(target) });
          this.applyDamage(target, cfg.meleeDmg, null, { bossName: b.name });
        }
      } else if (b.type === 'warmachine') {
        if (d < 11) { mx = -ux; mz = -uz; }
        else if (d > 22) { mx = ux; mz = uz; }
        else {
          if (t > b.nextStrafeFlip) { b.strafeDir *= -1; b.nextStrafeFlip = t + 2600; }
          mx = -uz * b.strafeDir; mz = ux * b.strafeDir;
        }
        if (t >= b.nextBurst && d < 34) {
          b.nextBurst = t + cfg.burstCd * 1000 + cfg.burstCount * cfg.burstGap * 1000;
          b.burstLeft = cfg.burstCount;
          b.burstNextAt = t;
          this.broadcast({ type: 'fx', k: 'burst', pos: [r2(b.pos.x), cfg.yc, r2(b.pos.z)] });
        }
        if (b.burstLeft > 0 && t >= b.burstNextAt) {
          b.burstLeft--;
          b.burstNextAt = t + cfg.burstGap * 1000;
          const dir = this.aimAt(b.pos, cfg.yc, target);
          const sp = 0.045;
          dir.x += rand(-sp, sp); dir.y += rand(-sp, sp); dir.z += rand(-sp, sp);
          this.spawnProj('bullet', { x: b.pos.x + dir.x * 2, y: cfg.yc, z: b.pos.z + dir.z * 2 },
            { x: dir.x * cfg.bulletSpeed, y: dir.y * cfg.bulletSpeed, z: dir.z * cfg.bulletSpeed }, cfg.burstDmg, { bossName: b.name });
        }
        if (t >= b.nextRocket && d > 6 && d < 36) {
          b.nextRocket = t + cfg.rocketCd * 1000;
          this.broadcast({ type: 'fx', k: 'bossfire', pos: [r2(b.pos.x), cfg.yc, r2(b.pos.z)] });
          for (const ang of [-0.18, 0, 0.18]) {
            const cos = Math.cos(ang), sin = Math.sin(ang);
            const dir = this.aimAt(b.pos, cfg.yc, target);
            const rx = dir.x * cos - dir.z * sin, rz = dir.x * sin + dir.z * cos;
            this.spawnProj('fire', { x: b.pos.x + rx * 2, y: cfg.yc, z: b.pos.z + rz * 2 },
              { x: rx * cfg.fireSpeed, y: dir.y * cfg.fireSpeed, z: rz * cfg.fireSpeed }, cfg.rocketDmg, { bossName: b.name, aoe: 2.5 });
          }
        }
      } else if (b.type === 'lich') {
        // 风筝走位：太近后撤，太远靠近，中距横移
        if (d < 7) { mx = -ux; mz = -uz; }
        else if (d > 20) { mx = ux; mz = uz; }
        else {
          if (t > b.nextStrafeFlip) { b.strafeDir *= -1; b.nextStrafeFlip = t + 3000; }
          mx = -uz * b.strafeDir; mz = ux * b.strafeDir;
        }
        if (t >= b.nextOrb) {
          b.nextOrb = t + cfg.orbCd * 1000;
          const dir = this.aimAt(b.pos, cfg.yc, target);
          this.spawnProj('orb', { x: b.pos.x + dir.x * 1.5, y: cfg.yc, z: b.pos.z + dir.z * 1.5 },
            { x: dir.x * cfg.orbSpeed, y: dir.y * cfg.orbSpeed, z: dir.z * cfg.orbSpeed }, cfg.orbDmg,
            { bossName: b.name, targetId: target.id });
          this.broadcast({ type: 'fx', k: 'cast', pos: [r2(b.pos.x), cfg.yc, r2(b.pos.z)] });
        }
        if (t >= b.nextBlast) {
          b.nextBlast = t + cfg.blastCd * 1000;
          const pos = { x: target.pos.x, y: target.pos.y + 0.5, z: target.pos.z };
          this.blasts.push({ pos, at: t + cfg.blastDelay * 1000, dmg: cfg.blastDmg, r: cfg.blastR, bossName: b.name });
          this.broadcast({ type: 'fx', k: 'voidring', pos: [r2(pos.x), r2(target.pos.y) + 0.05, r2(pos.z)], r: cfg.blastR, ms: cfg.blastDelay * 1000 });
        }
      }
    } else {
      if (!b.wander || t > b.wanderUntil) {
        b.wander = { x: rand(-20, 20), z: rand(-20, 20) };
        b.wanderUntil = t + 5000;
      }
      const dx = b.wander.x - b.pos.x, dz = b.wander.z - b.pos.z, d = Math.hypot(dx, dz);
      if (d > 1.5) { mx = dx / d * 0.5; mz = dz / d * 0.5; b.yaw = Math.atan2(-dx, -dz); }
    }
    // 切向滑行：分轴推进+受阻回退，撞平台/墙时沿边滑过绕行，不再卡死边缘反复推挤
    this.moveBoss(b, cfg, mx, mz, dt, t);
  }

  // ---------- 空投系统 ----------
  scheduleAirdrop(t) {
    this.nextAirdropAt = t + AIRDROPS.intervalMs + rand(-AIRDROPS.varMs, AIRDROPS.varMs);
  }

  warnAirdrop(t) {
    if (this.airdrop && !this.airdrop.warned && t >= this.airdrop.startAt - AIRDROPS.warnMs) {
      this.airdrop.warned = true;
      const ad = this.airdrop;
      this.broadcast({
        type: 'fx', k: 'airdrop_warn',
        tp: ad.type, color: AIRDROPS.colors[ad.type],
        from: [r2(ad.from.x), r2(ad.from.z)], to: [r2(ad.to.x), r2(ad.to.z)],
        // 剩余毫秒：避免客户端用服务器时间戳（时区错位），改用相对量
        ms: Math.max(0, Math.round(ad.startAt - t)),
      });
    }
  }

  airdropDirText(from, to) {
    const dx = to.x - from.x, dz = to.z - from.z;
    const horiz = Math.abs(dx) > Math.abs(dz);
    if (horiz) return dx > 0 ? '自西向东' : '自东向西';
    return dz > 0 ? '自南向北' : '自北向南';
  }

  airdropCombatPoint(t) {
    const alive = [...this.players.values()].filter(p => p.alive);
    if (!alive.length) return null;
    const unprotected = alive.filter(p => p.protectUntil <= t);
    const candidates = unprotected.length ? unprotected : alive;
    const radius = Math.max(1, AIRDROPS.missile.targetClusterRadius || 24);
    let best = null;
    for (const anchor of candidates) {
      const group = candidates.filter(p => Math.hypot(p.pos.x - anchor.pos.x, p.pos.z - anchor.pos.z) <= radius);
      const x = group.reduce((sum, p) => sum + p.pos.x, 0) / group.length;
      const z = group.reduce((sum, p) => sum + p.pos.z, 0) / group.length;
      const spread = group.reduce((sum, p) => sum + Math.hypot(p.pos.x - x, p.pos.z - z), 0) / group.length;
      const score = group.length * 100 - spread;
      if (!best || score > best.score) best = { x, z, score };
    }
    const jitter = Math.max(0, AIRDROPS.missile.targetJitter || 0);
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.random() * jitter;
    return {
      x: clamp(best.x + Math.cos(angle) * distance, -MAP.half + 6, MAP.half - 6),
      z: clamp(best.z + Math.sin(angle) * distance, -MAP.half + 6, MAP.half - 6),
    };
  }

  spawnAirdrop(t) {
    if (this.airdrop) return;
    const type = pick(AIRDROPS.types);
    const focus = type === 'missile' ? this.airdropCombatPoint(t) : null;
    // 红机航线穿过当前玩家密集区；补给机与特种机继续保持全图随机。
    const half = MAP.half + 14;
    let from, to, dropFraction = 0.5;
    if (focus && Math.random() < 0.5) {
      const k = clamp((focus.x + half) / (half * 2), 0.1, 0.9);
      const skew = rand(-12, 12);
      from = { x: -half, z: focus.z - skew * k };
      to = { x: half, z: focus.z + skew * (1 - k) };
      dropFraction = k;
    } else if (focus) {
      const k = clamp((focus.z + half) / (half * 2), 0.1, 0.9);
      const skew = rand(-12, 12);
      from = { x: focus.x - skew * k, z: -half };
      to = { x: focus.x + skew * (1 - k), z: half };
      dropFraction = k;
    } else if (Math.random() < 0.5) {
      const z = rand(-MAP.half * 0.85, MAP.half * 0.85);
      from = { x: -half, z };
      to = { x: half, z: z + rand(-16, 16) };
    } else {
      const x = rand(-MAP.half * 0.85, MAP.half * 0.85);
      from = { x, z: -half };
      to = { x: x + rand(-16, 16), z: half };
    }
    if (Math.random() < 0.5) {
      const swap = from; from = to; to = swap;
      dropFraction = 1 - dropFraction;
    }
    const dist = Math.hypot(to.x - from.x, to.z - from.z);
    const duration = dist / AIRDROPS.speed;
    this.airdrop = {
      id: this.entId++, type, from, to,
      startAt: t, endAt: t + duration * 1000,
      dropAt: t + duration * 1000 * dropFraction,
      focus,
      dropped: false, warned: false,
    };
    // 出生即广播：让全场知道飞机已起飞、什么颜色、从哪个方向来
    this.broadcast({
      type: 'sys', style: 'airdrop',
      text: `✈️ 空投「${AIRDROPS.names[type]}」已起飞！${this.airdropDirText(from, to)}飞来，注意天空`,
    });
    this.broadcast({
      type: 'fx', k: 'airdrop_spawn',
      id: this.airdrop.id, tp: type, color: AIRDROPS.colors[type],
      from: [r2(from.x), r2(from.z)], to: [r2(to.x), r2(to.z)],
      startAt: Math.round(t), endAt: Math.round(t + duration * 1000),
    });
  }

  airdropPos(ad, t) {
    const k = Math.max(0, Math.min(1, (t - ad.startAt) / (ad.endAt - ad.startAt)));
    return { x: ad.from.x + (ad.to.x - ad.from.x) * k, z: ad.from.z + (ad.to.z - ad.from.z) * k };
  }

  updateAirdrop(dt, t) {
    if (!this.airdrop) {
      if (t >= this.nextAirdropAt && [...this.players.values()].some(p => p.alive)) this.spawnAirdrop(t);
      return;
    }
    this.warnAirdrop(t);
    if (!this.airdrop.dropped && t >= this.airdrop.dropAt) {
      this.airdrop.dropped = true;
      const pos = this.airdropPos(this.airdrop, t);
      this.dropPayload(this.airdrop.type, pos, t);
    }
    if (t >= this.airdrop.endAt) {
      this.broadcast({ type: 'fx', k: 'airdrop_leave', id: this.airdrop.id });
      this.airdrop = null;
      this.scheduleAirdrop(t);
    }
  }

  dropPayload(type, pos, t) {
    const cfg = AIRDROPS[type];
    const dropPos = { x: r2(clamp(pos.x, -MAP.half + 4, MAP.half - 4)), z: r2(clamp(pos.z, -MAP.half + 4, MAP.half - 4)) };
    this.broadcast({
      type: 'fx', k: 'airdrop_drop',
      tp: type, color: AIRDROPS.colors[type],
      pos: [dropPos.x, dropPos.z],
    });
    if (type === 'missile') {
      // 延迟导弹轰炸：在目标区域生成若干落点标记，稍后引爆
      const targets = [];
      for (let i = 0; i < cfg.count; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rr = i === 0 ? 0 : Math.sqrt(Math.random()) * cfg.spreadR;
        targets.push({
          x: clamp(dropPos.x + Math.cos(ang) * rr, -MAP.half + 3, MAP.half - 3),
          z: clamp(dropPos.z + Math.sin(ang) * rr, -MAP.half + 3, MAP.half - 3),
        });
      }
      for (const tp of targets) {
        this.blasts.push({
          pos: { x: tp.x, y: 0.5, z: tp.z },
          at: t + cfg.delayMs + rand(-300, 300),
          dmg: cfg.dmg, r: cfg.radius,
          airdrop: true,
        });
        this.broadcast({
          type: 'fx', k: 'airdrop_target',
          pos: [r2(tp.x), r2(tp.z)], color: AIRDROPS.colors.missile,
          ms: cfg.delayMs,
        });
      }
    } else if (type === 'supply') {
      // 生成可拾取补给箱
      this.airdropCrate = {
        id: this.entId++, pos: dropPos,
        hp: cfg.crateHp, maxHp: cfg.crateHp,
        alive: true, openedBy: null,
      };
    } else if (type === 'special') {
      this.spawnSpecialMob(dropPos);
    }
  }

  // 落点相对地图中心的方位文字（八方位）
  posZone(pos) {
    const x = pos.x, z = pos.z;
    if (Math.hypot(x, z) < 12) return '地图中央';
    const a = Math.atan2(x, -z);   // 0=北(+z 朝北? 这里按 z 负=北 约定)
    const dirs = ['北侧', '东北', '东侧', '东南', '南侧', '西南', '西侧', '西北'];
    const idx = (Math.round(a / (Math.PI / 4)) + 8) % 8;
    return dirs[idx];
  }

  spawnSpecialMob(pos) {
    const cfg = AIRDROPS.special;
    const count = Math.floor(rand(cfg.minCount, cfg.maxCount + 1));
    const nowt = now();
    const packId = `special-${nowt}-${this.entId}`;
    for (let i = 0; i < count; i++) {
      // 围绕落点散布，避免挤成一坨
      const ang = (i / count) * Math.PI * 2 + rand(-0.3, 0.3);
      const rr = rand(1.5, 4.5);
      const mob = {
        id: this.entId++, type: 'special', hp: cfg.hp, maxHp: cfg.hp,
        pos: { x: clamp(pos.x + Math.cos(ang) * rr, -MAP.half + 2, MAP.half - 2),
               y: 0, z: clamp(pos.z + Math.sin(ang) * rr, -MAP.half + 2, MAP.half - 2) },
        yaw: rand(0, Math.PI * 2),
        nextMelee: 0, meleePhaseMs: i * cfg.meleeStaggerMs, inMelee: false,
        speed: cfg.speed, radius: cfg.radius, yc: cfg.yc,
        home: null, wander: null, wanderUntil: 0,
        targetId: null, targetLockUntil: 0, nextRetarget: 0,
        packId, threat: new Map(), surroundAngle: (i / count) * Math.PI * 2,
        avoidDir: i % 2 ? 1 : -1, avoidUntil: 0, blockedFor: 0,
        expireAt: nowt + (cfg.lifeSec || 90) * 1000,   // 到期自动消散
      };
      circlePushBoxes(mob.pos, cfg.radius, this.collideBoxes());
      mob.home = { x: mob.pos.x, z: mob.pos.z };
      this.specialMobs.push(mob);
    }
    this.broadcast({ type: 'fx', k: 'roar', pos: [r2(pos.x), 0, r2(pos.z)] });
  }

  decaySpecialMobThreat(mob, dt) {
    const cfg = AIRDROPS.special;
    for (const [id, value] of mob.threat) {
      const next = value - cfg.damageThreatDecayPerSec * dt;
      if (next <= 0 || !this.players.has(id)) mob.threat.delete(id);
      else mob.threat.set(id, next);
    }
  }

  specialMobTargetScore(mob, player, distance, targetLoads) {
    const cfg = AIRDROPS.special;
    const recentDamage = Math.min(cfg.damageThreatMax, mob.threat.get(player.id) || 0);
    const loadKey = `${mob.packId}:${player.id}`;
    const otherAttackers = Math.max(0, (targetLoads.get(loadKey) || 0) - (mob.targetId === player.id ? 1 : 0));
    let score = cfg.aggro - distance;
    score += recentDamage * cfg.damageThreatScale;
    score += otherAttackers * cfg.targetCrowdBonus;
    if (mob.targetId === player.id) score += cfg.currentTargetBonus;
    if (Math.abs(player.pos.y - mob.pos.y) >= 1.8) score -= cfg.highGroundPenalty;
    return score;
  }

  selectSpecialMobTarget(mob, t, targetLoads) {
    const cfg = AIRDROPS.special;
    let current = mob.targetId ? this.players.get(mob.targetId) : null;
    let currentDistance = Infinity;
    if (current && current.alive && !(current.protectUntil > t)) {
      currentDistance = Math.hypot(current.pos.x - mob.pos.x, current.pos.z - mob.pos.z);
    } else {
      current = null;
    }
    if (current && currentDistance <= cfg.disengage && t < mob.targetLockUntil) return current;
    if (current && currentDistance <= cfg.disengage && t < mob.nextRetarget) return current;

    mob.nextRetarget = t + cfg.retargetMs;
    let best = null, bestScore = -Infinity;
    for (const player of this.players.values()) {
      if (!player.alive || player.protectUntil > t) continue;
      const distance = Math.hypot(player.pos.x - mob.pos.x, player.pos.z - mob.pos.z);
      if (distance > cfg.aggro) continue;
      const score = this.specialMobTargetScore(mob, player, distance, targetLoads);
      if (score > bestScore) { best = player; bestScore = score; }
    }
    if (current && currentDistance <= cfg.disengage) {
      const currentScore = this.specialMobTargetScore(mob, current, currentDistance, targetLoads);
      if (!best || best.id === current.id || bestScore < currentScore + cfg.switchAdvantage) return current;
    }
    if (best) {
      if (best.id !== mob.targetId) mob.targetLockUntil = t + cfg.targetLockMs;
      mob.targetId = best.id;
      return best;
    }
    mob.targetId = null;
    mob.targetLockUntil = 0;
    return null;
  }

  updateSpecialMobs(dt, t) {
    const cfg = AIRDROPS.special;
    const sepR = cfg.radius * 2.1;   // 紧密包围但不重叠，保留群攻压迫感
    const targetLoads = new Map();
    for (const mob of this.specialMobs) {
      if (mob.targetId) {
        const loadKey = `${mob.packId}:${mob.targetId}`;
        targetLoads.set(loadKey, (targetLoads.get(loadKey) || 0) + 1);
      }
    }
    for (let i = this.specialMobs.length - 1; i >= 0; i--) {
      const m = this.specialMobs[i];
      // 到期自动消散（无击杀奖励，自然死亡防堆积）
      if (m.expireAt && t >= m.expireAt) {
        this.broadcast({ type: 'fx', k: 'die', id: 0, pos: [r2(m.pos.x), r2(m.pos.y + 1.1), r2(m.pos.z)] });
        this.broadcast({ type: 'fx', k: 'explode', pos: [r2(m.pos.x), 1.0, r2(m.pos.z)], r: 1.5 });
        this.specialMobs.splice(i, 1);
        continue;
      }
      this.decaySpecialMobThreat(m, dt);
      const previousTargetId = m.targetId;
      const target = this.selectSpecialMobTarget(m, t, targetLoads);
      if (previousTargetId !== m.targetId) {
        if (previousTargetId) {
          const previousKey = `${m.packId}:${previousTargetId}`;
          targetLoads.set(previousKey, Math.max(0, (targetLoads.get(previousKey) || 0) - 1));
        }
        if (m.targetId) {
          const nextKey = `${m.packId}:${m.targetId}`;
          targetLoads.set(nextKey, (targetLoads.get(nextKey) || 0) + 1);
        }
      }
      m.moveSpeed = cfg.speed;
      let mx = 0, mz = 0;
      if (target) {
        const dx = target.pos.x - m.pos.x, dz = target.pos.z - m.pos.z, d = Math.hypot(dx, dz) || 1;
        m.yaw = Math.atan2(-dx, -dz);
        if (d > cfg.chargeDistance) m.moveSpeed = cfg.speed * cfg.chargeSpeedMul;
        const surroundX = target.pos.x + Math.cos(m.surroundAngle) * cfg.surroundRadius;
        const surroundZ = target.pos.z + Math.sin(m.surroundAngle) * cfg.surroundRadius;
        const slotDx = surroundX - m.pos.x, slotDz = surroundZ - m.pos.z;
        const slotDistance = Math.hypot(slotDx, slotDz);
        if (slotDistance > 0.25) {
          mx = slotDx / slotDistance;
          mz = slotDz / slotDistance;
        }
        // 近战需在同一高度层（差<1.8），否则够不着高台玩家，消除"隔空咬人"
        const meleeOk = Math.abs(target.pos.y - m.pos.y) < 1.8;
        const inMelee = d <= cfg.meleeRange && meleeOk;
        if (inMelee && !m.inMelee) m.nextMelee = t + m.meleePhaseMs;
        m.inMelee = inMelee;
        if (inMelee && t >= m.nextMelee) {
          m.nextMelee = t + cfg.meleeCd * 1000;
          this.broadcast({ type: 'fx', k: 'slash', pos: [r2(target.pos.x), r2(target.pos.y + 1.1), r2(target.pos.z)] });
          this.broadcast({ type: 'fx', k: 'mobatk', id: m.id, pos: [r2(m.pos.x), r2(m.pos.z)] });
          this.applyDamage(target, cfg.meleeDmg, null, { bossName: '噬魂尸' });
        }
      } else {
        m.inMelee = false;
        const homeDx = m.home.x - m.pos.x, homeDz = m.home.z - m.pos.z;
        const homeDistance = Math.hypot(homeDx, homeDz);
        if (homeDistance > cfg.homeRadius) {
          mx = homeDx / homeDistance; mz = homeDz / homeDistance;
        } else {
          if (!m.wander || t >= m.wanderUntil) {
            const ang = rand(0, Math.PI * 2), radius = rand(2, cfg.wanderRadius);
            m.wander = { x: m.home.x + Math.cos(ang) * radius, z: m.home.z + Math.sin(ang) * radius };
            m.wanderUntil = t + cfg.wanderMs;
          }
          const wanderDx = m.wander.x - m.pos.x, wanderDz = m.wander.z - m.pos.z;
          const wanderDistance = Math.hypot(wanderDx, wanderDz);
          if (wanderDistance > 0.8) { mx = wanderDx / wanderDistance * 0.45; mz = wanderDz / wanderDistance * 0.45; }
        }
      }
      // 群内分离：被附近同伴推开，保证追人时也保持间距、不重叠
      for (let j = 0; j < this.specialMobs.length; j++) {
        if (j === i) continue;
        const o = this.specialMobs[j];
        const dx = m.pos.x - o.pos.x, dz = m.pos.z - o.pos.z;
        const dd = Math.hypot(dx, dz);
        if (dd > 0.01 && dd < sepR) {
          const push = (sepR - dd) / sepR;
          mx += (dx / dd) * push;
          mz += (dz / dd) * push;
        }
      }
      // 归一化避免多个分离力叠加后超速
      const ml = Math.hypot(mx, mz);
      if (ml > 1) { mx /= ml; mz /= ml; }
      // 切向滑行：分轴推进+受阻回退，撞障碍沿边滑过，不卡死
      this.moveBoss(m, cfg, mx, mz, dt, t);
    }
  }

  damageSpecialMob(mob, dmg, attacker) {
    const roundedDamage = Math.round(dmg);
    mob.hp -= roundedDamage;
    if (attacker) {
      if (!mob.threat) mob.threat = new Map();
      mob.threat.set(attacker.id, Math.min(AIRDROPS.special.damageThreatMax, (mob.threat.get(attacker.id) || 0) + roundedDamage));
    }
    this.broadcast({ type: 'fx', k: 'bosshit', dmg, by: attacker ? attacker.id : 0, pos: [r2(mob.pos.x), mob.yc, r2(mob.pos.z)] });
    if (mob.hp <= 0) {
      this.broadcast({ type: 'fx', k: 'die', id: 0, pos: [r2(mob.pos.x), r2(mob.pos.y + 1.1), r2(mob.pos.z)] });
      this.broadcast({ type: 'fx', k: 'explode', pos: [r2(mob.pos.x), 1.0, r2(mob.pos.z)], r: 2 });
      const idx = this.specialMobs.indexOf(mob);
      if (idx >= 0) this.specialMobs.splice(idx, 1);
      if (attacker && this.players.has(attacker.id)) {
        attacker.coins += AIRDROPS.special.killCoins;
        attacker.hp = Math.min(RULES.maxHp, attacker.hp + AIRDROPS.special.killHeal);
        this.saveProfile(attacker);
        this.sendTo(attacker.id, { type: 'got', kind: 'coin', name: `击杀噬魂尸 +${AIRDROPS.special.killCoins}🪙`, desc: '' });
        this.sendYou(attacker);
      }
    }
  }

  // 玩家可主动破坏/拾取补给箱
  damageCrate(dmg, attacker) {
    const crate = this.airdropCrate;
    if (!crate || !crate.alive) return;
    crate.hp -= dmg;
    if (crate.hp <= 0) {
      crate.alive = false;
      crate.openedBy = attacker ? attacker.id : null;
      this.broadcast({ type: 'fx', k: 'crate_break', id: crate.id, pos: [r2(crate.pos.x), 0.5, r2(crate.pos.z)] });
      if (attacker && this.players.has(attacker.id)) {
        this.grantAirdropSupply(attacker);
      } else {
        // 无归属破坏时奖励给最近玩家
        let nearest = null, nd = Infinity;
        for (const p of this.players.values()) {
          if (!p.alive) continue;
          const d = Math.hypot(p.pos.x - crate.pos.x, p.pos.z - crate.pos.z);
          if (d < nd) { nd = d; nearest = p; }
        }
        if (nearest) this.grantAirdropSupply(nearest);
      }
      this.airdropCrate = null;   // 箱子消失，清引用（snapshot 据 airdropCrate 发 null，置 null 更彻底）
    }
  }

  grantAirdropSupply(p) {
    // 医疗包 + 护甲 + 随机武器满弹 + 随机 BUFF
    p.hp = RULES.maxHp;
    p.armor = RULES.maxArmor;
    const gun = pick(['pistol', 'mg', 'sniper']);
    const def = WEAPONS[gun];
    p.gun = gun; p.ammo = def.mag; p.ammoReserve = def.mag * def.reserveMags;
    if (!this.buffOn(p, 'zombie')) p.active = 'gun';
    const buff = pick(Object.keys(BUFFS));
    p.buffs[buff] = now() + BUFFS[buff].dur * 1000;
    if (buff === 'shield') p.shield = RULES.shieldHp;
    if (buff === 'zombie') p.active = 'melee';
    this.sendTo(p.id, { type: 'got', kind: 'buff', name: '空投补给箱', desc: `满血满甲 · ${def.name} · ${BUFFS[buff].name}` });
    this.sendYou(p);
  }

  // ---------- 世界更新 ----------
  update(dt) {
    const t = now();
    for (const p of this.players.values()) {
      if (t >= (p.nextAuditAt || Infinity)) {
        this.auditSession(p, 'periodic', false);
        p.nextAuditAt = t + 300000;
      }
      if (p.gun && p.reloadUntil && t >= p.reloadUntil) {   // 换弹完成：从备弹补入当前匣（可能不足一匣）
        const mag = WEAPONS[p.gun].mag, take = Math.min(mag - p.ammo, p.ammoReserve);
        p.ammo += take; p.ammoReserve -= take; p.reloadUntil = 0;
      }
      if (!p.alive && t >= p.deadUntil) this.respawn(p);
      for (const k of Object.keys(p.buffs)) if (p.buffs[k] <= t) delete p.buffs[k];
    }
    this.updateAntiCheatVision(t);
    // 手雷
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.vel.y -= RULES.gravity * dt;
      g.pos.x += g.vel.x * dt; g.pos.y += g.vel.y * dt; g.pos.z += g.vel.z * dt;
      if (g.pos.y < 0.2 && g.vel.y < 0) { g.pos.y = 0.2; g.vel.y *= -0.38; g.vel.x *= 0.65; g.vel.z *= 0.65; }
      const lim = MAP.half - 0.3;
      if (Math.abs(g.pos.x) > lim) { g.pos.x = clamp(g.pos.x, -lim, lim); g.vel.x *= -0.5; }
      if (Math.abs(g.pos.z) > lim) { g.pos.z = clamp(g.pos.z, -lim, lim); g.vel.z *= -0.5; }
      if (t >= g.explodeAt) {
        this.grenades.splice(i, 1);
        const def = WEAPONS[g.kind] || WEAPONS.nade;
        const owner = this.players.get(g.owner) || null;
        const pos = [r2(g.pos.x), r2(g.pos.y), r2(g.pos.z)];
        if (g.kind === 'smoke') {
          this.broadcast({ type: 'fx', k: 'smokepop', pos, r: def.radius, dur: def.smokeDur });
        } else if (g.kind === 'flash') {
          this.broadcast({ type: 'fx', k: 'flashbang', pos, r: def.blindRadius });
          this.applyFlash(g.pos, def);
        } else {
          this.broadcast({ type: 'fx', k: 'explode', pos, r: def.radius });
          this.aoeDamage({ x: g.pos.x, y: g.pos.y, z: g.pos.z }, def.radius, def.dmg, owner, { wp: 'nade', falloff: 0.65 });
        }
      }
    }
    // BOSS 弹道（火球/弹幕/追踪法球）
    for (let i = this.projs.length - 1; i >= 0; i--) {
      const f = this.projs[i];
      // 追踪法球转向
      if (f.kind === 'orb' && f.targetId) {
        const tp = this.players.get(f.targetId);
        if (tp && tp.alive) {
          const dir = this.aimAt(f.pos, f.pos.y, tp);
          const sp = Math.hypot(f.vel.x, f.vel.y, f.vel.z) || 1;
          const k = Math.min(1, dt * 2.4);
          f.vel.x += (dir.x * sp - f.vel.x) * k;
          f.vel.y += (dir.y * sp - f.vel.y) * k;
          f.vel.z += (dir.z * sp - f.vel.z) * k;
        }
      }
      // 障碍物阻挡
      const vlen = Math.hypot(f.vel.x, f.vel.y, f.vel.z) * dt;
      if (vlen > 0) {
        const nd = { x: f.vel.x, y: f.vel.y, z: f.vel.z };
        const L = Math.hypot(nd.x, nd.y, nd.z); nd.x /= L; nd.y /= L; nd.z /= L;
        const tb = this.obstacleBlock(f.pos, nd, vlen);
        if (tb < vlen) {
          f.pos.x += nd.x * tb; f.pos.y += nd.y * tb; f.pos.z += nd.z * tb;
          this.explodeProj(f, i);
          continue;
        }
      }
      f.pos.x += f.vel.x * dt; f.pos.y += f.vel.y * dt; f.pos.z += f.vel.z * dt;
      let boom = false;
      const hitR = f.kind === 'bullet' ? 0.8 : f.kind === 'orb' ? 1.0 : f.kind === 'rocket' ? 0.8 : 1.15;
      for (const p of this.players.values()) {
        if (!p.alive || (f.kind === 'rocket' && p.id === f.owner)) continue;
        if (Math.hypot(p.pos.x - f.pos.x, p.pos.y + 1.2 - f.pos.y, p.pos.z - f.pos.z) < hitR) {
          if (f.kind === 'bullet') this.applyDamage(p, f.dmg, null, { bossName: f.bossName });
          if (f.kind === 'rocket') f.directTargetId = p.id;
          boom = true; break;
        }
      }
      if (!boom && f.kind === 'rocket') {
        if (this.boss && Math.hypot(this.boss.pos.x - f.pos.x, this.boss.cfg.yc - f.pos.y, this.boss.pos.z - f.pos.z) < this.boss.cfg.radius + 0.65) boom = true;
        for (const mob of this.specialMobs) {
          if (Math.hypot(mob.pos.x - f.pos.x, mob.yc - f.pos.y, mob.pos.z - f.pos.z) < mob.radius + 0.65) { boom = true; break; }
        }
        if (!boom && this.airdropCrate && this.airdropCrate.alive
          && Math.hypot(this.airdropCrate.pos.x - f.pos.x, 0.9 - f.pos.y, this.airdropCrate.pos.z - f.pos.z) < 1.35) boom = true;
        if (!boom) {
          for (const br of this.barrels) {
            if (br.alive && Math.hypot(br.x - f.pos.x, 0.9 - f.pos.y, br.z - f.pos.z) < MAP.barrelR + 0.55) { boom = true; break; }
          }
        }
      }
      const life = f.kind === 'bullet' ? 2500
        : f.kind === 'orb' ? 6000
          : f.kind === 'rocket' ? Math.min(5000, (f.maxRange || 100) / Math.max(1, f.speed || 24) * 1000)
            : 4500;
      if (!boom && (f.pos.y < 0.1 || Math.abs(f.pos.x) > MAP.half || Math.abs(f.pos.z) > MAP.half || t - f.born > life)) boom = true;
      if (boom) {
        if (f.kind === 'rocket' && f.pos.y < 0.2) f.pos.y = 0.2;
        this.explodeProj(f, i);
      }
    }
    // 巫妖延迟爆破 / 空投导弹延迟轰炸
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const bl = this.blasts[i];
      if (t >= bl.at) {
        this.blasts.splice(i, 1);
        if (bl.airdrop) {
          this.broadcast({ type: 'fx', k: 'explode', pos: [r2(bl.pos.x), r2(bl.pos.y), r2(bl.pos.z)], r: bl.r, fire: true });
          // 赤红制裁：落地灼烧区域，持续 burnSec 秒
          const mc = AIRDROPS.missile;
          if (mc.burnSec) {
            this.burns.push({
              pos: { x: bl.pos.x, y: 0, z: bl.pos.z },
              until: t + mc.burnSec * 1000, r: mc.burnR,
              dmgPerSec: mc.burnDmgPerSec, nextTick: t,
            });
            this.broadcast({ type: 'fx', k: 'burnfield', pos: [r2(bl.pos.x), 0, r2(bl.pos.z)], r: mc.burnR, sec: mc.burnSec });
          }
        } else {
          this.broadcast({ type: 'fx', k: 'explode', pos: [r2(bl.pos.x), r2(bl.pos.y), r2(bl.pos.z)], r: bl.r, vp: true });
        }
        this.aoeDamage(bl.pos, bl.r, bl.dmg, null, { bossName: bl.bossName, falloff: bl.airdrop ? AIRDROPS.missile.falloff : 0.3 });
      }
    }
    // 赤红制裁灼烧区域：每 burnTickMs 对范围内目标造成持续伤害
    const mc = AIRDROPS.missile;
    for (let i = this.burns.length - 1; i >= 0; i--) {
      const bu = this.burns[i];
      if (t >= bu.until) { this.burns.splice(i, 1); continue; }
      if (t >= bu.nextTick) {
        bu.nextTick = t + (mc.burnTickMs || 500);
        const tickDmg = bu.dmgPerSec * ((mc.burnTickMs || 500) / 1000);
        for (const p of this.players.values()) {
          if (!p.alive) continue;
          if (Math.hypot(p.pos.x - bu.pos.x, p.pos.z - bu.pos.z) <= bu.r)
            this.applyDamage(p, tickDmg, null, { bossName: '灼烧' });
        }
        if (this.boss) {
          const d = Math.hypot(this.boss.pos.x - bu.pos.x, this.boss.pos.z - bu.pos.z);
          if (d <= bu.r + this.boss.cfg.radius) this.damageBoss(tickDmg, null);
        }
        for (let i = this.specialMobs.length - 1; i >= 0; i--) {
          const mob = this.specialMobs[i];
          if (Math.hypot(mob.pos.x - bu.pos.x, mob.pos.z - bu.pos.z) <= bu.r + mob.radius)
            this.damageSpecialMob(mob, tickDmg, null);
        }
        for (const br of this.barrels) {
          if (!br.alive) continue;
          if (Math.hypot(br.x - bu.pos.x, br.z - bu.pos.z) <= bu.r) this.damageBarrel(br, tickDmg, null);
        }
      }
    }
    this.updateBoss(dt, t);
    this.updateAirdrop(dt, t);
    this.updateSpecialMobs(dt, t);
    for (let i = this.lootDrops.length - 1; i >= 0; i--) {
      if (t >= this.lootDrops[i].expiresAt) this.lootDrops.splice(i, 1);
    }
    // 拾取点刷新
    for (const pk of this.pickups) {
      if (!pk.avail && t >= pk.respawnAt) {
        pk.avail = true;
        pk.item = pick(PICKUP_POOLS[pk.def.cat]);
        this.broadcast({ type: 'pk', ev: 'spawn', id: pk.def.id, item: pk.item });
      }
    }
    // 油桶重生
    for (const br of this.barrels) {
      if (!br.alive && t >= br.respawnAt) {
        br.alive = true;
        br.hp = RULES.barrelHp;
        this.broadcast({ type: 'fx', k: 'barrelup', id: br.id });
      }
    }
    // 空投补给箱：玩家靠近自动拾取（也兼容被打爆）
    if (this.airdropCrate && this.airdropCrate.alive) {
      const crate = this.airdropCrate;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (Math.hypot(p.pos.x - crate.pos.x, p.pos.z - crate.pos.z) <= AIRDROPS.supply.pickupDist) {
          crate.alive = false;
          crate.openedBy = p.id;
          this.broadcast({ type: 'fx', k: 'crate_break', id: crate.id, pos: [r2(crate.pos.x), 0.5, r2(crate.pos.z)] });
          this.grantAirdropSupply(p);
          this.airdropCrate = null;
          break;
        }
      }
    }
  }

  explodeProj(f, idx) {
    this.projs.splice(idx, 1);
    if (f.kind === 'bullet') {
      this.broadcast({ type: 'fx', k: 'pimpact', pos: [r2(f.pos.x), r2(Math.max(0.1, f.pos.y)), r2(f.pos.z)] });
      return;
    }
    const r = f.aoe || (f.kind === 'orb' ? 1.6 : 2);
    const isRocket = f.kind === 'rocket';
    const attacker = isRocket && f.owner ? (this.players.get(f.owner) || null) : null;
    this.broadcast({ type: 'fx', k: 'explode', pos: [r2(f.pos.x), r2(Math.max(0.2, f.pos.y)), r2(f.pos.z)], r, fire: f.kind === 'fire' || isRocket, vp: f.kind === 'orb', rocket: isRocket });
    this.aoeDamage({ x: f.pos.x, y: f.pos.y, z: f.pos.z }, r, f.dmg, attacker, {
      wp: isRocket ? (f.wp || 'rocket') : null,
      bossName: f.bossName,
      falloff: isRocket ? f.falloff : 0.35,
      selfMul: isRocket ? f.selfMul : 1,
      lineOfSight: isRocket,
      directTargetId: isRocket ? f.directTargetId : null,
    });
  }

  // ---------- 快照 ----------
  snapshot() {
    const t = now();
    const pl = [];
    for (const p of this.players.values()) {
      pl.push({
        i: p.id, n: p.name, c: p.color,
        p: [r2(p.pos.x), r2(p.pos.y), r2(p.pos.z)], ya: r2(p.yaw), pi: r2(p.pitch), an: p.anim,
        zm: p.aiming ? 1 : 0, bl: p.blindUntil > t ? p.blindUntil - t : 0, bt: p.blindTotal || 1,
        hp: Math.max(0, Math.round(p.hp)), ar: Math.round(p.armor), sh: Math.round(p.shield),
        al: p.alive ? 1 : 0, ac: p.active, mw: p.melee, gw: p.gun, ng: p.nadeType || null,
        am: p.ammo, re: p.ammoReserve, nl: p.nadeLeft, rl: p.reloadUntil > t ? p.reloadUntil - t : 0,
        dd: !p.alive ? Math.max(0, p.deadUntil - t) : 0,
        pr: p.protectUntil > t ? 1 : 0, bo: p.boots,
        bf: Object.entries(p.buffs).map(([k, until]) => [k, until - t]),
        eq: p.eq, k: p.kills, d: p.deaths, s: p.score, co: p.coins, st: p.streak,
      });
    }
    return {
      type: 'state', t,
      day: r5((t % RULES.dayMs) / RULES.dayMs),
      pl,
      boss: this.boss ? {
        tp: this.boss.type, nm: this.boss.name,
        hp: Math.max(0, this.boss.hp), mx: this.boss.maxHp,
        p: [r2(this.boss.pos.x), 0, r2(this.boss.pos.z)], ya: r2(this.boss.yaw),
        iv: this.boss.invisUntil > t ? 1 : 0,
      } : null,
      fb: this.projs.map(f => [f.id, r2(f.pos.x), r2(f.pos.y), r2(f.pos.z), r2(f.vel.x), r2(f.vel.y), r2(f.vel.z), PROJ_KIND[f.kind] || 0]),
      gd: this.grenades.map(g => [g.id, r2(g.pos.x), r2(g.pos.y), r2(g.pos.z), r2(g.vel.x), r2(g.vel.y), r2(g.vel.z), NADE_KIND[g.kind] || 0]),
      pk: this.pickups.map(pk => pk.avail ? pk.item : null),
      ld: this.lootDrops.map(drop => [
        drop.id, drop.item, r2(drop.pos.x), r2(drop.pos.y), r2(drop.pos.z),
        Math.max(0, drop.availableAt - t), Math.max(0, drop.expiresAt - t),
      ]),
      br: this.barrels.map(b => b.alive ? 1 : 0),
      nb: !this.boss ? Math.max(0, this.nextBossAt - t) : 0,
      // 空投状态
      ad: this.airdrop ? {
        id: this.airdrop.id, tp: this.airdrop.type,
        p: [r2(this.airdropPos(this.airdrop, t).x), AIRDROPS.altitude, r2(this.airdropPos(this.airdrop, t).z)],
        from: [r2(this.airdrop.from.x), r2(this.airdrop.from.z)],
        to: [r2(this.airdrop.to.x), r2(this.airdrop.to.z)],
        color: AIRDROPS.colors[this.airdrop.type],
        startAt: this.airdrop.startAt, endAt: this.airdrop.endAt,
      } : null,
      na: !this.airdrop ? Math.max(0, this.nextAirdropAt - t) : 0,
      ac: this.airdropCrate && this.airdropCrate.alive ? {
        id: this.airdropCrate.id,
        p: [r2(this.airdropCrate.pos.x), 0, r2(this.airdropCrate.pos.z)],
        hp: this.airdropCrate.hp, mx: this.airdropCrate.maxHp,
      } : null,
      sm: this.specialMobs.map(m => ({
        id: m.id, p: [r2(m.pos.x), 0, r2(m.pos.z)], ya: r2(m.yaw),
        hp: Math.max(0, m.hp), mx: m.maxHp,
      })),
    };
  }

  boardMsg() {
    const rt = [...this.players.values()]
      .sort((a, b) => b.kills - a.kills || b.streak - a.streak || b.score - a.score || a.deaths - b.deaths)
      .map(p => ({ i: p.id, n: p.name, c: p.color, k: p.kills, d: p.deaths, s: p.score, st: p.streak }));
    return { type: 'board', rt, hist: board.top(10) };
  }
}

module.exports = World;

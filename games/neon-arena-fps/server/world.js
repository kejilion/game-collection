// 权威游戏世界：所有伤害/拾取/购买/BOSS/油桶均在服务端判定，客户端只上报输入与位置
'use strict';
const { MAP, WEAPONS, EQUIPS, BUFFS, PICKUP_POOLS, BOSS, BOSSES, SHOP, RULES } = require('./config');
const board = require('./leaderboard');

const now = () => Date.now();
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const r2 = v => Math.round(v * 100) / 100;
const r5 = v => Math.round(v * 100000) / 100000;

const COLORS = ['#ff6b6b', '#4dabf7', '#69db7c', '#ffd43b', '#da77f2', '#ffa94d', '#63e6e2', '#f783ac', '#a9e34b', '#748ffc', '#ff8787', '#66d9e8'];
const PROJ_KIND = { fire: 0, bullet: 1, orb: 2 };
const NADE_KIND = { frag: 0, flash: 1, smoke: 2 };
const KILL_PACE_MAX_WINDOW = 60000;
const KILL_PACE_RULES = [
  { tag: 'burst', windowMs: 10000, minKills: 4, minVictims: 3, minPlayers: 4, weight: 25, cooldownMs: 12000 },
  { tag: 'rush', windowMs: 30000, minKills: 7, minVictims: 3, minPlayers: 4, weight: 46, cooldownMs: 20000 },
  { tag: 'wipe', windowMs: 60000, minKills: 10, minVictims: 4, minPlayers: 5, weight: 70, cooldownMs: 30000 },
];

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

class World {
  constructor(broadcast, sendTo, ac) {
    this.broadcast = broadcast;
    this.sendTo = sendTo;
    this.ac = ac;                 // 反作弊引擎（见 server/anticheat/）
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
    let name = String(rawName || '').replace(/[<>&"']/g, '').trim().slice(0, 12) || ('玩家' + Math.floor(rand(100, 999)));
    for (const p of this.players.values()) if (p.name === name) { name = name.slice(0, 9) + Math.floor(rand(10, 99)); break; }
    const prof = board.get(name);
    prof.joins++; prof.last = now();
    if (prof.coins === null || prof.coins === undefined) prof.coins = RULES.startCoins;
    const p = {
      id: this.nextId++, name, color: COLORS[(this.nextId + name.length) % COLORS.length],
      pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, anim: 0,
      hp: RULES.maxHp, armor: 0, shield: 0, alive: true, deadUntil: 0, protectUntil: now() + RULES.protectMs,
      melee: 'fist', gun: null, nadeType: null, active: 'melee',
      ammo: 0, ammoReserve: 0, nadeLeft: 0, reloadUntil: 0, lastFire: {}, lastNade: 0,
      boots: 0, buffs: {},
      kills: 0, deaths: 0, score: 0, streak: 0,
      coins: prof.coins, owned: prof.owned.slice(), eq: Object.assign({ head: null, face: null, back: null, fx: null }, prof.eq),
      lastChatAt: 0, lastSpawnIdx: -1,
      acKillPace: { kills: [], flags: {} },
    };
    this.placeAtSpawn(p);
    p.mon = this.ac.attach(p.id, { name, ip });
    p.mon.resetPos(p.pos);
    this.players.set(p.id, p);
    this.broadcast({ type: 'sys', style: 'join', text: `${name} 加入了竞技场` });
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.saveProfile(p);
    this.ac.detach(id);
    this.players.delete(id);
    this.broadcast({ type: 'sys', style: 'leave', text: `${p.name} 离开了竞技场` });
  }

  saveProfile(p) {
    const prof = board.get(p.name);
    prof.coins = p.coins; prof.owned = p.owned.slice(); prof.eq = Object.assign({}, p.eq);
    board.save();
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
    p.protectUntil = now() + RULES.protectMs;
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

  // ---------- 输入处理 ----------
  handleMove(p, m) {
    if (!p.alive || !Array.isArray(m.p)) return;
    const nx = +m.p[0], ny = +m.p[1], nz = +m.p[2];
    if (!isFinite(nx) || !isFinite(ny) || !isFinite(nz)) { p.mon.flag('badvec', 4, 'move 非法坐标'); return; }
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
    const ya = +m.ya, pi = +m.pi;
    if (isFinite(ya)) p.yaw = ya;
    if (isFinite(pi)) p.pitch = clamp(pi, -1.55, 1.55);
    p.anim = m.an ? 1 : 0;
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
    const d = { x: dv[0], y: dv[1], z: dv[2] };

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
    for (const br of this.barrels) {
      if (!br.alive) continue;
      const bt = rayAABB(eye, d, barrelBox(br));
      if (bt !== null && bt > 0 && bt < bestT) { bestT = bt; target = null; hitBoss = false; hitBarrel = br; }
    }
    // 静态障碍遮挡
    let tObs = def.range;
    for (const b of OBS) { const h = rayAABB(eye, d, b); if (h !== null && h < tObs) tObs = h; }
    let endT = bestT;
    if (tObs < bestT) { target = null; hitBoss = false; hitBarrel = null; endT = tObs; }
    const end = [r2(eye.x + d.x * endT), r2(eye.y + d.y * endT), r2(eye.z + d.z * endT)];
    // 瞄准统计：开火方向 vs 最近上报视线，命中/爆头计数（窗口满自动评估）
    p.mon.aimShot({ dir: dv, view: this.viewVec(p), hit: !!(target || hitBoss || hitBarrel), headshot: !!(target && headshot) });
    this.broadcast({ type: 'fx', k: 'shot', id: p.id, wp: p.gun, o: [r2(eye.x), r2(eye.y), r2(eye.z)], e: end, tg: target ? target.id : (hitBoss ? -1 : 0) });
    if (target) this.applyDamage(target, def.dmg, p, { wp: p.gun, hs: headshot });
    else if (hitBoss) this.damageBoss(this.dmgMul(p, def.dmg, false).dmg, p);
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
      this.sendTo(p.id, { type: 'flashed', ms: Math.round(dur * 1000) });
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
  }

  handlePickup(p, m) {
    if (!p.alive) return;
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
    this.broadcast({ type: 'chat', from: p.name, color: p.color, text });
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
    victim.deadUntil = now() + RULES.respawnMs;
    const vProf = board.get(victim.name); vProf.deaths++; board.save();
    const shutdown = victim.streak >= 5 ? victim.streak : 0;
    victim.streak = 0;
    let kInfo = null;
    if (attacker && attacker !== victim) {
      this.recordKillPace(attacker, victim, wp, bossName);
      attacker.kills++; attacker.score += RULES.killScore; attacker.coins += RULES.killCoins;
      attacker.hp = Math.min(RULES.maxHp, attacker.hp + RULES.killHeal);
      attacker.streak++;
      const aProf = board.get(attacker.name); aProf.kills++;
      if (attacker.streak > aProf.bestStreak) aProf.bestStreak = attacker.streak;   // 历史最高连杀入档
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
    state.kills.push({ t, victimId: victim.id, victimName: victim.name, wp: wp || '' });
    const alivePlayers = [...this.players.values()].filter(p => p.alive).length;
    const totalPlayers = Math.max(alivePlayers, this.players.size);

    for (const rule of KILL_PACE_RULES) {
      if (totalPlayers < rule.minPlayers) continue;
      const recent = state.kills.filter(k => t - k.t <= rule.windowMs);
      if (recent.length < rule.minKills) continue;
      const victims = new Set(recent.map(k => k.victimId || k.victimName));
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

  // ---------- 范围伤害（手雷/油桶/火箭/爆破 共用，含油桶连锁） ----------
  aoeDamage(pos, radius, dmg, attacker, opts = {}) {
    const falloff = opts.falloff === undefined ? 0.6 : opts.falloff;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.pos.x - pos.x, (p.pos.y + 1) - pos.y, p.pos.z - pos.z);
      if (d <= radius) {
        this.applyDamage(p, dmg * (1 - falloff * d / radius), attacker, { wp: opts.wp, bossName: opts.bossName });
      }
    }
    if (this.boss) {
      const d = Math.hypot(this.boss.pos.x - pos.x, this.boss.cfg.yc - pos.y, this.boss.pos.z - pos.z);
      if (d <= radius + this.boss.cfg.radius && !opts.bossName) this.damageBoss(dmg, attacker);
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
    this.boss = {
      type, cfg, name: cfg.name, hp: cfg.hp, maxHp: cfg.hp,
      pos: { x, y: 0, z }, yaw: 0,
      nextMelee: 0, nextFire: now() + 2500,
      nextBlink: now() + 4000, invisUntil: 0, nextInvis: now() + 7000,
      nextBurst: now() + 3000, burstLeft: 0, burstNextAt: 0,
      nextRocket: now() + 6000,
      nextOrb: now() + 2500, nextBlast: now() + 5000,
      strafeDir: 1, nextStrafeFlip: 0,
      wander: null, wanderUntil: 0,
      damagers: new Map(),
    };
    this.broadcast({ type: 'sys', style: 'boss', text: `⚠️ BOSS「${cfg.name}」降临竞技场！击杀可获 ${cfg.killCoins} 金币与强力增益` });
    this.broadcast({ type: 'fx', k: 'roar', pos: [x, 0, z] });
  }

  damageBoss(dmg, attacker) {
    const b = this.boss;
    if (!b) return;
    dmg = Math.round(dmg);
    b.hp -= dmg;
    if (attacker) b.damagers.set(attacker.id, (b.damagers.get(attacker.id) || 0) + dmg);
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

  updateBoss(dt, t) {
    if (!this.boss) {
      if (t >= this.nextBossAt && [...this.players.values()].some(p => p.alive)) this.spawnBoss();
      return;
    }
    const b = this.boss, cfg = b.cfg;
    let target = null, bd = BOSS.aggro;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.pos.x - b.pos.x, p.pos.z - b.pos.z);
      if (d < bd) { bd = d; target = p; }
    }
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
          b.pos.x = target.pos.x + ux * 2.2;
          b.pos.z = target.pos.z + uz * 2.2;
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
        if (d > 22) { mx = ux; mz = uz; }
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
    b.pos.x += mx * cfg.speed * dt;
    b.pos.z += mz * cfg.speed * dt;
    circlePushBoxes(b.pos, cfg.radius, this.collideBoxes());
  }

  // ---------- 世界更新 ----------
  update(dt) {
    const t = now();
    for (const p of this.players.values()) {
      if (p.gun && p.reloadUntil && t >= p.reloadUntil) {   // 换弹完成：从备弹补入当前匣（可能不足一匣）
        const mag = WEAPONS[p.gun].mag, take = Math.min(mag - p.ammo, p.ammoReserve);
        p.ammo += take; p.ammoReserve -= take; p.reloadUntil = 0;
      }
      if (!p.alive && t >= p.deadUntil) this.respawn(p);
      for (const k of Object.keys(p.buffs)) if (p.buffs[k] <= t) delete p.buffs[k];
    }
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
      const hitR = f.kind === 'bullet' ? 0.8 : f.kind === 'orb' ? 1.0 : 1.15;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (Math.hypot(p.pos.x - f.pos.x, p.pos.y + 1.2 - f.pos.y, p.pos.z - f.pos.z) < hitR) {
          if (f.kind === 'bullet') this.applyDamage(p, f.dmg, null, { bossName: f.bossName });
          boom = true; break;
        }
      }
      const life = f.kind === 'bullet' ? 2500 : f.kind === 'orb' ? 6000 : 4500;
      if (!boom && (f.pos.y < 0.1 || Math.abs(f.pos.x) > MAP.half || Math.abs(f.pos.z) > MAP.half || t - f.born > life)) boom = true;
      if (boom) this.explodeProj(f, i);
    }
    // 巫妖延迟爆破
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const bl = this.blasts[i];
      if (t >= bl.at) {
        this.blasts.splice(i, 1);
        this.broadcast({ type: 'fx', k: 'explode', pos: [r2(bl.pos.x), r2(bl.pos.y), r2(bl.pos.z)], r: bl.r, vp: true });
        this.aoeDamage(bl.pos, bl.r, bl.dmg, null, { bossName: bl.bossName, falloff: 0.3 });
      }
    }
    this.updateBoss(dt, t);
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
  }

  explodeProj(f, idx) {
    this.projs.splice(idx, 1);
    if (f.kind === 'bullet') {
      this.broadcast({ type: 'fx', k: 'pimpact', pos: [r2(f.pos.x), r2(Math.max(0.1, f.pos.y)), r2(f.pos.z)] });
      return;
    }
    const r = f.aoe || (f.kind === 'orb' ? 1.6 : 2);
    this.broadcast({ type: 'fx', k: 'explode', pos: [r2(f.pos.x), r2(Math.max(0.2, f.pos.y)), r2(f.pos.z)], r, fire: f.kind === 'fire', vp: f.kind === 'orb' });
    this.aoeDamage({ x: f.pos.x, y: f.pos.y, z: f.pos.z }, r, f.dmg, null, { bossName: f.bossName, falloff: 0.35 });
  }

  // ---------- 快照 ----------
  snapshot() {
    const t = now();
    const pl = [];
    for (const p of this.players.values()) {
      pl.push({
        i: p.id, n: p.name, c: p.color,
        p: [r2(p.pos.x), r2(p.pos.y), r2(p.pos.z)], ya: r2(p.yaw), pi: r2(p.pitch), an: p.anim,
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
      br: this.barrels.map(b => b.alive ? 1 : 0),
      nb: !this.boss ? Math.max(0, this.nextBossAt - t) : 0,
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

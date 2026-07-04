// 权威游戏世界：所有伤害/拾取/购买/BOSS 均在服务端判定，客户端只上报输入与位置
'use strict';
const { MAP, WEAPONS, EQUIPS, BUFFS, PICKUP_POOLS, BOSS, SHOP, RULES } = require('./config');
const board = require('./leaderboard');

const now = () => Date.now();
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const r2 = v => Math.round(v * 100) / 100;

const COLORS = ['#ff6b6b', '#4dabf7', '#69db7c', '#ffd43b', '#da77f2', '#ffa94d', '#63e6e2', '#f783ac', '#a9e34b', '#748ffc', '#ff8787', '#66d9e8'];

// 障碍物 AABB（圆柱按外接方盒处理），用于子弹遮挡与 BOSS 碰撞
const OBS = MAP.obstacles.map(o => {
  const w = o.t === 'cyl' ? o.r * 2 : o.w, d = o.t === 'cyl' ? o.r * 2 : o.d;
  return { minx: o.x - w / 2, maxx: o.x + w / 2, minz: o.z - d / 2, maxz: o.z + d / 2, miny: 0, maxy: o.h };
});

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
function obstacleBlock(o, d, maxT) { // 射线被障碍物挡住的最近距离
  let t = maxT;
  for (const b of OBS) { const h = rayAABB(o, d, b); if (h !== null && h < t) t = h; }
  return t;
}
// 圆（半径 r）与 AABB 的水平推挤，用于 BOSS 移动
function circlePush(pos, r) {
  for (const b of OBS) {
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
  constructor(broadcast, sendTo) {
    this.broadcast = broadcast;   // (obj) => 发给所有连接（含观战）
    this.sendTo = sendTo;         // (id, obj) => 发给指定玩家
    this.players = new Map();
    this.nextId = 1;
    this.pickups = MAP.pickups.map(def => ({ def, item: pick(PICKUP_POOLS[def.cat]), avail: true, respawnAt: 0 }));
    this.boss = null;
    this.nextBossAt = now() + BOSS.firstDelay * 1000;
    this.fireballs = [];
    this.grenades = [];
    this.entId = 1;
  }

  // ---------- 玩家生命周期 ----------
  addPlayer(rawName) {
    let name = String(rawName || '').replace(/[<>&"']/g, '').trim().slice(0, 12) || ('玩家' + Math.floor(rand(100, 999)));
    for (const p of this.players.values()) if (p.name === name) { name = name.slice(0, 9) + Math.floor(rand(10, 99)); break; }
    const prof = board.get(name);
    prof.joins++; prof.last = now();
    if (prof.coins === null || prof.coins === undefined) prof.coins = RULES.startCoins;
    const p = {
      id: this.nextId++, name, color: COLORS[(this.nextId + name.length) % COLORS.length],
      pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, anim: 0,
      hp: RULES.maxHp, armor: 0, shield: 0, alive: true, deadUntil: 0, protectUntil: now() + RULES.protectMs,
      melee: 'fist', gun: null, hasNade: false, active: 'melee',
      ammo: 0, reloadUntil: 0, lastFire: {}, lastNade: 0,
      boots: 0, buffs: {},
      kills: 0, deaths: 0, score: 0, streak: 0,
      coins: prof.coins, owned: prof.owned.slice(), eq: Object.assign({ head: null, face: null, back: null, fx: null }, prof.eq),
      lastChatAt: 0, lastSpawnIdx: -1,
    };
    this.placeAtSpawn(p);
    this.players.set(p.id, p);
    this.broadcast({ type: 'sys', style: 'join', text: `${name} 加入了竞技场` });
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.saveProfile(p);
    this.players.delete(id);
    this.broadcast({ type: 'sys', style: 'leave', text: `${p.name} 离开了竞技场` });
  }

  saveProfile(p) {
    const prof = board.get(p.name);
    prof.coins = p.coins; prof.owned = p.owned.slice(); prof.eq = Object.assign({}, p.eq);
    board.save();
  }

  placeAtSpawn(p) {
    // 从 3 个随机候选点里选离其他玩家最远的（且换地点重生）
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
    p.melee = 'fist'; p.gun = null; p.hasNade = false; p.active = 'melee';
    p.ammo = 0; p.reloadUntil = 0; p.buffs = {}; p.boots = 0; p.anim = 0;
    p.protectUntil = now() + RULES.protectMs;
    this.placeAtSpawn(p);
    this.broadcast({ type: 'fx', k: 'respawn', id: p.id, pos: [r2(p.pos.x), 0, r2(p.pos.z)] });
  }

  // ---------- 输入处理 ----------
  handleMove(p, m) {
    if (!p.alive || !Array.isArray(m.p)) return;
    const lim = MAP.half - 0.4;
    p.pos.x = clamp(+m.p[0] || 0, -lim, lim);
    p.pos.y = clamp(+m.p[1] || 0, 0, 12);
    p.pos.z = clamp(+m.p[2] || 0, -lim, lim);
    p.yaw = +m.ya || 0; p.pitch = clamp(+m.pi || 0, -1.55, 1.55);
    p.anim = m.an ? 1 : 0;
  }

  buffOn(p, k) { return (p.buffs[k] || 0) > now(); }

  meleeCd(p, w) { return WEAPONS[w].cd * (this.buffOn(p, 'zombie') ? 0.6 : 1) * 1000; }

  handleMelee(p, m) {
    if (!p.alive) return;
    const w = p.melee, def = WEAPONS[w], t = now();
    if (t - (p.lastFire.melee || 0) < this.meleeCd(p, w) * 0.85) return;
    p.lastFire.melee = t;
    let dx = +((m.d || [])[0]) || 0, dz = +((m.d || [])[2]) || 0;
    const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    this.broadcast({ type: 'fx', k: 'melee', id: p.id, wp: w });
    const range = def.range + 0.7, dotMin = def.sweep ? 0.1 : 0.45;
    const targets = [];
    for (const o of this.players.values()) {
      if (o === p || !o.alive) continue;
      const tx = o.pos.x - p.pos.x, tz = o.pos.z - p.pos.z, dist = Math.hypot(tx, tz);
      if (dist > range) continue;
      if ((tx * dx + tz * dz) / (dist || 1) < dotMin) continue;
      targets.push({ o, dist });
    }
    targets.sort((a, b) => a.dist - b.dist);
    const hitList = def.sweep ? targets : targets.slice(0, 1);
    for (const { o } of hitList) this.applyDamage(o, def.dmg, p, { melee: true, wp: w });
    // BOSS 也吃近战
    if (this.boss) {
      const bx = this.boss.pos.x - p.pos.x, bz = this.boss.pos.z - p.pos.z;
      const bd = Math.hypot(bx, bz) - BOSS.radius;
      if (bd <= range && (bx * dx + bz * dz) / (Math.hypot(bx, bz) || 1) > 0.1)
        this.damageBoss(this.dmgMul(p, def.dmg, true).dmg, p);
    }
  }

  handleFire(p, m) {
    if (!p.alive || p.active !== 'gun' || !p.gun) return;
    if (this.buffOn(p, 'zombie')) return;               // 丧尸状态禁枪
    const def = WEAPONS[p.gun], t = now();
    if (t < p.reloadUntil) return;
    if (p.ammo <= 0) { p.reloadUntil = t + def.reload * 1000; return; }
    if (t - (p.lastFire[p.gun] || 0) < def.cd * 1000 * 0.8) return;
    p.lastFire[p.gun] = t;
    p.ammo--;
    if (p.ammo <= 0) p.reloadUntil = t + def.reload * 1000;   // 打空自动换弹 = 冷却
    // 射线起点：以服务端已知位置为准（容忍少量偏差）
    const eye = { x: p.pos.x, y: p.pos.y + RULES.eyeH, z: p.pos.z };
    const co = m.o;
    if (Array.isArray(co) && Math.hypot(co[0] - eye.x, co[1] - eye.y, co[2] - eye.z) < 2.5) {
      eye.x = +co[0]; eye.y = +co[1]; eye.z = +co[2];
    }
    let d = { x: +((m.d || [])[0]) || 0, y: +((m.d || [])[1]) || 0, z: +((m.d || [])[2]) || -1 };
    const L = Math.hypot(d.x, d.y, d.z) || 1; d = { x: d.x / L, y: d.y / L, z: d.z / L };

    let bestT = def.range, target = null, headshot = false, hitBoss = false;
    for (const o of this.players.values()) {
      if (o === p || !o.alive) continue;
      const body = raySphere(eye, d, { x: o.pos.x, y: o.pos.y + 0.95, z: o.pos.z }, 0.55);
      const head = raySphere(eye, d, { x: o.pos.x, y: o.pos.y + 1.55, z: o.pos.z }, 0.34);
      let tt = null, hs = false;
      if (head !== null && (body === null || head <= body)) { tt = head; hs = true; }
      else if (body !== null) tt = body;
      if (tt !== null && tt < bestT) { bestT = tt; target = o; headshot = hs; hitBoss = false; }
    }
    if (this.boss) {
      const bt = raySphere(eye, d, { x: this.boss.pos.x, y: 2.1, z: this.boss.pos.z }, BOSS.radius + 0.3);
      if (bt !== null && bt < bestT) { bestT = bt; target = null; hitBoss = true; }
    }
    const tObs = obstacleBlock(eye, d, def.range);
    let endT = bestT;
    if (tObs < bestT) { target = null; hitBoss = false; endT = tObs; }
    const end = [r2(eye.x + d.x * endT), r2(eye.y + d.y * endT), r2(eye.z + d.z * endT)];
    this.broadcast({ type: 'fx', k: 'shot', id: p.id, wp: p.gun, o: [r2(eye.x), r2(eye.y), r2(eye.z)], e: end, tg: target ? target.id : (hitBoss ? -1 : 0) });
    if (target) this.applyDamage(target, def.dmg, p, { wp: p.gun, hs: headshot });
    else if (hitBoss) this.damageBoss(this.dmgMul(p, def.dmg, false).dmg, p);
  }

  handleNade(p, m) {
    if (!p.alive || !p.hasNade) return;
    if (this.buffOn(p, 'zombie')) return;
    const t = now(), def = WEAPONS.nade;
    if (t - p.lastNade < def.cd * 1000 * 0.85) return;
    p.lastNade = t;
    let d = { x: +((m.d || [])[0]) || 0, y: +((m.d || [])[1]) || 0.3, z: +((m.d || [])[2]) || -1 };
    const L = Math.hypot(d.x, d.y, d.z) || 1;
    const eye = { x: p.pos.x, y: p.pos.y + RULES.eyeH, z: p.pos.z };
    this.grenades.push({
      id: this.entId++, owner: p.id,
      pos: { x: eye.x + d.x / L * 0.6, y: eye.y, z: eye.z + d.z / L * 0.6 },
      vel: { x: d.x / L * 16, y: d.y / L * 16 + 3.5, z: d.z / L * 16 },
      explodeAt: t + def.fuse * 1000,
    });
    this.broadcast({ type: 'fx', k: 'throw', id: p.id });
  }

  handleReload(p) {
    if (!p.alive || !p.gun) return;
    const def = WEAPONS[p.gun], t = now();
    if (t < p.reloadUntil || p.ammo >= def.mag) return;
    p.reloadUntil = t + def.reload * 1000;
  }

  handleSwitch(p, m) {
    const slot = m.slot;
    if (!p.alive) return;
    if (this.buffOn(p, 'zombie') && slot !== 'melee') return;
    if (slot === 'melee') p.active = 'melee';
    else if (slot === 'gun' && p.gun) p.active = 'gun';
    else if (slot === 'nade' && p.hasNade) p.active = 'nade';
  }

  handlePickup(p, m) {
    if (!p.alive) return;
    const pk = this.pickups[m.id | 0];
    if (!pk || !pk.avail) return;
    if (Math.hypot(pk.def.x - p.pos.x, pk.def.z - p.pos.z) > RULES.pickupDist || p.pos.y > 3) return;
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
      else if (def.slot === 'gun') { p.gun = item; p.ammo = def.mag; p.reloadUntil = 0; if (!this.buffOn(p, 'zombie')) p.active = 'gun'; }
      else if (def.slot === 'nade') { p.hasNade = true; }
      info = { kind: 'wep', name: def.name, desc: def.slot === 'nade' ? '按 3 投掷 · 无限数量有冷却' : '' };
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
    if (attacker) { const r = this.dmgMul(attacker, raw, !!opts.melee); dmg = r.dmg; crit = r.crit; }
    if (opts.hs) dmg *= RULES.headshotMul;
    // 护盾 → 护甲 → 生命
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
    if (attacker && opts.melee && this.buffOn(attacker, 'zombie'))
      attacker.hp = Math.min(RULES.maxHp, attacker.hp + dmg * RULES.zombieLifesteal);
    this.broadcast({
      type: 'fx', k: 'hit', tg: victim.id, by: attacker ? attacker.id : 0,
      dmg, crit, hs: !!opts.hs, pos: this.chest(victim),
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
      attacker.kills++; attacker.score += RULES.killScore; attacker.coins += RULES.killCoins;
      attacker.hp = Math.min(RULES.maxHp, attacker.hp + RULES.killHeal);
      attacker.streak++;
      const aProf = board.get(attacker.name); aProf.kills++; board.save();
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

  // ---------- BOSS ----------
  spawnBoss() {
    const [x, z] = pick(MAP.bossSpawns);
    this.boss = {
      name: pick(BOSS.names), hp: BOSS.hp, maxHp: BOSS.hp,
      pos: { x, y: 0, z }, yaw: 0,
      nextMelee: 0, nextFire: now() + 2000, wander: null, wanderUntil: 0,
      damagers: new Map(),
    };
    this.broadcast({ type: 'sys', style: 'boss', text: `⚠️ BOSS「${this.boss.name}」降临竞技场！击杀可获 ${BOSS.killCoins} 金币与强力增益` });
    this.broadcast({ type: 'fx', k: 'roar', pos: [x, 0, z] });
  }

  damageBoss(dmg, attacker) {
    const b = this.boss;
    if (!b) return;
    dmg = Math.round(dmg);
    b.hp -= dmg;
    if (attacker) b.damagers.set(attacker.id, (b.damagers.get(attacker.id) || 0) + dmg);
    this.broadcast({ type: 'fx', k: 'bosshit', dmg, by: attacker ? attacker.id : 0, pos: [r2(b.pos.x), 2.2, r2(b.pos.z)] });
    if (b.hp <= 0) {
      const killer = attacker;
      this.broadcast({ type: 'fx', k: 'explode', pos: [r2(b.pos.x), 1.5, r2(b.pos.z)], r: 8, boss: true });
      if (killer && this.players.has(killer.id)) {
        killer.score += BOSS.killScore; killer.coins += BOSS.killCoins;
        killer.hp = RULES.maxHp;
        const bk = pick(Object.keys(BUFFS));
        killer.buffs[bk] = now() + BUFFS[bk].dur * 1000;
        if (bk === 'shield') killer.shield = RULES.shieldHp;
        if (bk === 'zombie') killer.active = 'melee';
        const prof = board.get(killer.name); prof.bossKills++; board.save();
        this.saveProfile(killer);
        this.broadcast({ type: 'sys', style: 'boss', text: `🏆 ${killer.name} 击杀了 BOSS「${b.name}」！获得 ${BOSS.killCoins} 金币 + 满血 + ${BUFFS[bk].name}增益` });
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

  updateBoss(dt, t) {
    if (!this.boss) {
      if (t >= this.nextBossAt && [...this.players.values()].some(p => p.alive)) this.spawnBoss();
      return;
    }
    const b = this.boss;
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
      if (d > BOSS.meleeRange * 0.75) { mx = dx / d; mz = dz / d; }
      if (d <= BOSS.meleeRange && t >= b.nextMelee) {
        b.nextMelee = t + BOSS.meleeCd * 1000;
        this.broadcast({ type: 'fx', k: 'slam', pos: [r2(b.pos.x), 0, r2(b.pos.z)], r: BOSS.meleeRange + 0.6 });
        for (const p of this.players.values()) {
          if (!p.alive) continue;
          if (Math.hypot(p.pos.x - b.pos.x, p.pos.z - b.pos.z) <= BOSS.meleeRange + 0.6)
            this.applyDamage(p, BOSS.meleeDmg, null, { bossName: b.name });
        }
      }
      if (t >= b.nextFire && d > 4 && d < 38) {
        b.nextFire = t + BOSS.fireCd * 1000;
        const ty = target.pos.y + 1.2, oy = 2.6;
        const dir = { x: dx, y: ty - oy, z: dz };
        const L = Math.hypot(dir.x, dir.y, dir.z) || 1;
        this.fireballs.push({
          id: this.entId++, born: t,
          pos: { x: b.pos.x - Math.sin(b.yaw) * 1.2, y: oy, z: b.pos.z - Math.cos(b.yaw) * 1.2 },
          vel: { x: dir.x / L * BOSS.fireSpeed, y: dir.y / L * BOSS.fireSpeed, z: dir.z / L * BOSS.fireSpeed },
        });
        this.broadcast({ type: 'fx', k: 'bossfire', pos: [r2(b.pos.x), 2.6, r2(b.pos.z)] });
      }
    } else {
      // 无目标时缓慢游荡
      if (!b.wander || t > b.wanderUntil) {
        b.wander = { x: rand(-20, 20), z: rand(-20, 20) };
        b.wanderUntil = t + 5000;
      }
      const dx = b.wander.x - b.pos.x, dz = b.wander.z - b.pos.z, d = Math.hypot(dx, dz);
      if (d > 1.5) { mx = dx / d; mz = dz / d; b.yaw = Math.atan2(-dx, -dz); }
    }
    b.pos.x += mx * BOSS.speed * dt;
    b.pos.z += mz * BOSS.speed * dt;
    circlePush(b.pos, BOSS.radius);
  }

  // ---------- 世界更新 ----------
  update(dt) {
    const t = now();
    // 换弹完成
    for (const p of this.players.values()) {
      if (p.gun && p.reloadUntil && t >= p.reloadUntil) { p.ammo = WEAPONS[p.gun].mag; p.reloadUntil = 0; }
      if (!p.alive && !p.spectateHold && t >= p.deadUntil) this.respawn(p);
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
        const def = WEAPONS.nade;
        this.broadcast({ type: 'fx', k: 'explode', pos: [r2(g.pos.x), r2(g.pos.y), r2(g.pos.z)], r: def.radius });
        const owner = this.players.get(g.owner) || null;
        for (const p of this.players.values()) {
          if (!p.alive) continue;
          const d = Math.hypot(p.pos.x - g.pos.x, (p.pos.y + 1) - g.pos.y, p.pos.z - g.pos.z);
          if (d <= def.radius) {
            const dmg = def.dmg * (1 - 0.65 * d / def.radius);
            this.applyDamage(p, dmg, owner === p ? null : owner, { wp: 'nade' });
            if (owner === p && p.alive === false) { /* 自爆已按无击杀者结算 */ }
          }
        }
        if (this.boss) {
          const d = Math.hypot(this.boss.pos.x - g.pos.x, 2 - g.pos.y, this.boss.pos.z - g.pos.z);
          if (d <= def.radius + BOSS.radius) this.damageBoss(def.dmg * (owner ? this.dmgMul(owner, 1, false).dmg : 1), owner);
        }
      }
    }
    // BOSS 火球
    for (let i = this.fireballs.length - 1; i >= 0; i--) {
      const f = this.fireballs[i];
      f.pos.x += f.vel.x * dt; f.pos.y += f.vel.y * dt; f.pos.z += f.vel.z * dt;
      let boom = false;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (Math.hypot(p.pos.x - f.pos.x, p.pos.y + 1.2 - f.pos.y, p.pos.z - f.pos.z) < 1.15) {
          this.applyDamage(p, BOSS.fireDmg, null, { bossName: this.boss ? this.boss.name : 'BOSS' });
          boom = true; break;
        }
      }
      if (!boom && (f.pos.y < 0.1 || Math.abs(f.pos.x) > MAP.half || Math.abs(f.pos.z) > MAP.half || t - f.born > 4500)) boom = true;
      if (boom) {
        this.broadcast({ type: 'fx', k: 'explode', pos: [r2(f.pos.x), r2(Math.max(0.2, f.pos.y)), r2(f.pos.z)], r: 2, fire: true });
        this.fireballs.splice(i, 1);
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
        al: p.alive ? 1 : 0, ac: p.active, mw: p.melee, gw: p.gun, hn: p.hasNade ? 1 : 0,
        am: p.ammo, rl: p.reloadUntil > t ? p.reloadUntil - t : 0,
        dd: !p.alive ? Math.max(0, p.deadUntil - t) : 0,
        pr: p.protectUntil > t ? 1 : 0, bo: p.boots,
        bf: Object.entries(p.buffs).map(([k, until]) => [k, until - t]),
        eq: p.eq, k: p.kills, d: p.deaths, s: p.score, co: p.coins, st: p.streak,
      });
    }
    return {
      type: 'state', t,
      pl,
      boss: this.boss ? {
        nm: this.boss.name, hp: Math.max(0, this.boss.hp), mx: this.boss.maxHp,
        p: [r2(this.boss.pos.x), 0, r2(this.boss.pos.z)], ya: r2(this.boss.yaw),
      } : null,
      fb: this.fireballs.map(f => [r2(f.pos.x), r2(f.pos.y), r2(f.pos.z)]),
      gd: this.grenades.map(g => [r2(g.pos.x), r2(g.pos.y), r2(g.pos.z)]),
      pk: this.pickups.map(pk => pk.avail ? pk.item : null),
      nb: !this.boss ? Math.max(0, this.nextBossAt - t) : 0,
    };
  }

  boardMsg() {
    const rt = [...this.players.values()]
      .sort((a, b) => b.kills - a.kills || b.score - a.score || a.deaths - b.deaths)
      .map(p => ({ i: p.id, n: p.name, c: p.color, k: p.kills, d: p.deaths, s: p.score }));
    return { type: 'board', rt, hist: board.top(10) };
  }
}

module.exports = World;

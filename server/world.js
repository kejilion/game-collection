// ============================================================================
//  Arena Brawl — authoritative world simulation
//  Holds all entities and runs the game logic. The server (index.js) drives
//  update() on a fixed tick and serialize() on the broadcast tick.
// ============================================================================

const {
  WORLD, CLASSES, ITEM_TYPES, ITEM_WEIGHTS, SHOP, BALANCE, BOSS_NAMES, OBSTACLES, DROP, KILL
} = require('./config');

// ---- small helpers ---------------------------------------------------------
let _seq = 1;
const uid = (p) => `${p}${(_seq++).toString(36)}`;
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
const now = () => Date.now();
function angDiff(a, b) { let d = a - b; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; }
function xpForLevel(level) { return Math.floor(100 * Math.pow(1.34, level - 1)); }
function weightedPick(weights) {
  let total = 0; for (const k in weights) total += weights[k];
  let r = Math.random() * total;
  for (const k in weights) { r -= weights[k]; if (r <= 0) return k; }
  return Object.keys(weights)[0];
}

// fx that are global announcements (kill feed / boss kill) must reach every
// client regardless of where it happened; all other fx are positional and only
// sent to clients whose view contains them.
const GLOBAL_FX = new Set(['killfeed', 'bossKill']);

// ===========================================================================
//  Entities
// ===========================================================================
class Player {
  constructor(name, clsId) {
    const cls = CLASSES[clsId];
    this.id = uid('P');
    this.kind = 'player';
    this.name = name;
    this.clsId = clsId;
    this.level = 1; this.xp = 0; this.xpNext = xpForLevel(1);
    this.maxHp = cls.maxHp; this.hp = this.maxHp;
    this.gold = 60;
    this.kills = 0; this.deaths = 0; this.bossKills = 0; this.extraLives = 0;
    this.x = 0; this.y = 0; this.facing = 0;
    this.input = { up: false, down: false, left: false, right: false };
    this.moving = false; this.dead = false; this.respawnAt = 0;
    this.attackReadyAt = 0; this.skillReadyAt = {};
    this.buffs = {};               // type -> expiresAt
    this.lastHitBy = null; this.lastHitAt = 0;
    this.chat = null;              // { text, until }
    this.chatReadyAt = 0;          // server-side chat throttle (anti-spam)
    this.spawnProtectUntil = 0;
    this.online = true;
    this.killStreak = 0;          // consecutive kills without dying (连杀)
    this.multiKill = 0;           // kills within the multi-kill window (双杀/三杀…)
    this.lastKillAt = 0;
  }
  get cls() { return CLASSES[this.clsId]; }
  hasBuff(t, t2) { return this.buffs[t] && this.buffs[t] > t2; }

  effMaxHp() { return this.cls.maxHp + (this.level - 1) * BALANCE.hp.perLevel; }
  effSpeed(t) { return this.cls.speed * (this.hasBuff('speed', t) ? BALANCE.buff.speedMul : 1); }
  effAttack(t) {
    const a = this.cls.attack + (this.level - 1) * BALANCE.attackPerLevel;
    return a * (this.hasBuff('power', t) ? BALANCE.buff.powerMul : 1);
  }
  effDefense(t) {
    return this.cls.defense + (this.level - 1) * BALANCE.defensePerLevel +
      (this.hasBuff('defense', t) ? BALANCE.buff.defenseAdd : 0);
  }
  effAttackCd(t) { return this.cls.attackCd * (this.hasBuff('haste', t) ? BALANCE.buff.hasteMul : 1); }
  get score() { return this.kills * 100 + this.bossKills * 400 + (this.level - 1) * 80; }
}

class Boss {
  constructor(x, y) {
    this.id = uid('B'); this.kind = 'boss';
    this.name = BOSS_NAMES[randInt(0, BOSS_NAMES.length - 1)];
    this.maxHp = BALANCE.boss.hp; this.hp = this.maxHp;
    this.x = x; this.y = y; this.facing = 0;
    this.targetId = null;
    this.attackReadyAt = 0; this.slamReadyAt = now() + 3000; this.orbReadyAt = now() + 5000;
    this.lastHitBy = null;
  }
}

class Merchant {
  constructor(x, y) {
    this.id = uid('M'); this.kind = 'merchant'; this.name = '神秘商人';
    this.x = x; this.y = y; this.tx = x; this.ty = y;
    this.state = 'idle';          // 'idle' (营业中) | 'move'
    this.stateUntil = 0;
  }
}

class Item {
  constructor(type, x, y) { this.id = uid('I'); this.kind = 'item'; this.type = type; this.x = x; this.y = y; }
}

class Projectile {
  constructor(o) {
    this.id = uid('R'); this.kind = 'proj';
    this.x = o.x; this.y = o.y; this.vx = o.vx; this.vy = o.vy;
    this.ownerId = o.ownerId; this.ownerKind = o.ownerKind; // 'player' | 'boss'
    this.damage = o.damage; this.radius = o.radius; this.type = o.type; // 'bolt'|'fireball'|'orb'
    this.aoe = o.aoe || 0; this.aoeMult = o.aoeMult || 1; this.crit = !!o.crit;
    this.life = o.life || 2.2;
  }
}

// ===========================================================================
//  World
// ===========================================================================
class World {
  constructor() {
    this.players = new Map();
    this.bosses = new Map();
    this.merchants = new Map();
    this.items = new Map();
    this.projectiles = new Map();
    this.fx = [];                 // transient visual events, flushed each broadcast
    this.obstacles = [];          // static cover; sent to clients once on join
    this.itemSpawnAt = 0;
    this.bossRespawnAt = 0;
    this.firstBlood = false;      // 一血 announced once per server lifetime
    this.genObstacles();
    for (let i = 0; i < BALANCE.merchantCount; i++) {
      const p = this.randomPoint(200); const m = new Merchant(p.x, p.y); this.merchants.set(m.id, m);
    }
    for (let i = 0; i < BALANCE.boss.count; i++) this.spawnBoss();
    for (let i = 0; i < 24; i++) this.spawnItem(); // seed the field
  }

  randomPoint(margin = 120) {
    return { x: rand(margin, WORLD.width - margin), y: rand(margin, WORLD.height - margin) };
  }
  // a random point not overlapping any obstacle (so items/spawns stay reachable)
  freePoint(margin = 120) {
    for (let i = 0; i < 24; i++) {
      const p = this.randomPoint(margin);
      let ok = true;
      for (const o of this.obstacles) if (dist2(p.x, p.y, o.x, o.y) < (o.r + 44) ** 2) { ok = false; break; }
      if (ok) return p;
    }
    return this.randomPoint(margin);
  }
  genObstacles() {
    let tries = 0;
    while (this.obstacles.length < OBSTACLES.count && tries < OBSTACLES.count * 40) {
      tries++;
      const r = rand(OBSTACLES.minR, OBSTACLES.maxR);
      const x = rand(OBSTACLES.margin, WORLD.width - OBSTACLES.margin);
      const y = rand(OBSTACLES.margin, WORLD.height - OBSTACLES.margin);
      let ok = true;
      for (const o of this.obstacles)
        if (dist2(x, y, o.x, o.y) < (r + o.r + OBSTACLES.gap) ** 2) { ok = false; break; }
      if (ok) this.obstacles.push({
        id: uid('O'), x: Math.round(x), y: Math.round(y), r: Math.round(r),
        type: Math.random() < 0.5 ? 'rock' : 'crate'
      });
    }
  }
  getObstacles() { return this.obstacles; }
  // push an entity out of any obstacle it overlaps, then clamp to world bounds
  resolveObstacles(ent, radius) {
    for (const o of this.obstacles) {
      const dx = ent.x - o.x, dy = ent.y - o.y;
      const min = o.r + radius;
      const d2 = dx * dx + dy * dy;
      if (d2 < min * min) {
        const d = Math.sqrt(d2) || 0.001;
        const push = min - d;
        ent.x += (dx / d) * push; ent.y += (dy / d) * push;
      }
    }
    ent.x = clamp(ent.x, radius, WORLD.width - radius);
    ent.y = clamp(ent.y, radius, WORLD.height - radius);
  }
  pushFx(e) { this.fx.push(e); }

  // ---- lifecycle ----------------------------------------------------------
  addPlayer(name, clsId) {
    const p = new Player(name, clsId);
    const pt = this.freePoint(160);
    p.x = pt.x; p.y = pt.y;
    p.spawnProtectUntil = now() + BALANCE.spawnProtect;
    this.players.set(p.id, p);
    this.pushFx({ t: 'spawn', x: p.x, y: p.y, color: p.cls.color });
    return p;
  }
  removePlayer(id) { this.players.delete(id); }

  spawnBoss() {
    const p = this.freePoint(300);
    const b = new Boss(p.x, p.y);
    this.bosses.set(b.id, b);
    this.pushFx({ t: 'bossSpawn', x: b.x, y: b.y, name: b.name });
  }
  // low-level: add an item to the field (used by natural spawn AND death drops)
  addItem(type, x, y) {
    const it = new Item(type, clamp(x, 36, WORLD.width - 36), clamp(y, 36, WORLD.height - 36));
    this.items.set(it.id, it);
    return it;
  }
  spawnItem() {
    if (this.items.size >= BALANCE.itemCap) return;
    const p = this.freePoint(80);
    this.addItem(weightedPick(ITEM_WEIGHTS), p.x, p.y);
  }
  // scatter 1-N random items around a death location
  dropLoot(x, y, count) {
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const d = rand(18, DROP.scatter);
      this.addItem(weightedPick(ITEM_WEIGHTS), x + Math.cos(ang) * d, y + Math.sin(ang) * d);
    }
    this.pushFx({ t: 'loot', x, y, count });
  }

  // ---- input from clients -------------------------------------------------
  setInput(p, input) {
    if (!p) return;
    p.input.up = !!input.up; p.input.down = !!input.down;
    p.input.left = !!input.left; p.input.right = !!input.right;
  }
  setChat(p, text) {
    if (!p || !text) return;
    text = String(text).slice(0, 80);
    p.chat = { text, until: now() + BALANCE.chatDur };
  }

  // ---- combat helpers -----------------------------------------------------
  enemiesOfPlayer(p) {
    const out = [];
    for (const o of this.players.values()) if (o !== p && !o.dead) out.push(o);
    for (const b of this.bosses.values()) out.push(b);
    return out;
  }
  nearestEnemy(p, maxRange) {
    let best = null, bestD = maxRange * maxRange;
    for (const e of this.enemiesOfPlayer(p)) {
      const d = dist2(p.x, p.y, e.x, e.y);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }
  radiusOf(e) { return e.kind === 'boss' ? BALANCE.boss.radius : e.kind === 'player' ? 22 : 16; }

  damageEntity(target, amount, attacker, opts = {}) {
    const t = now();
    if (target.kind === 'player') {
      if (target.dead || target.spawnProtectUntil > t) return;
    }
    amount = Math.max(1, Math.round(amount));
    target.hp -= amount;
    if (attacker && attacker.kind === 'player') { target.lastHitBy = attacker.id; target.lastHitAt = t; }
    this.pushFx({ t: 'dmg', x: target.x, y: target.y - this.radiusOf(target) - 6, v: amount, crit: !!opts.crit });
    // attacker earns xp proportional to damage dealt
    if (attacker && attacker.kind === 'player' && !attacker.dead) {
      this.gainXp(attacker, amount * BALANCE.xp.perDamage);
    }
    if (target.hp <= 0) this.handleDeath(target, attacker);
  }

  handleDeath(target, attacker) {
    const t = now();
    if (target.kind === 'player') {
      if (target.extraLives > 0) {       // 复活之心: revive in place
        target.extraLives -= 1; target.hp = target.effMaxHp();
        target.spawnProtectUntil = t + 1500;
        this.pushFx({ t: 'revive', x: target.x, y: target.y });
        return;
      }
      const victimStreak = target.killStreak;
      target.dead = true; target.deaths += 1;
      target.killStreak = 0; target.multiKill = 0;
      target.respawnAt = t + BALANCE.respawnDelay;
      target.input = { up: false, down: false, left: false, right: false };
      this.pushFx({ t: 'death', x: target.x, y: target.y, color: target.cls.color, name: target.name });
      this.dropLoot(target.x, target.y, randInt(DROP.playerMin, DROP.playerMax));
      const killer = attacker && attacker.kind === 'player' ? attacker
        : (target.lastHitBy && this.players.get(target.lastHitBy));
      if (killer && killer !== target) {
        killer.kills += 1;
        const bounty = randInt(BALANCE.killBounty[0], BALANCE.killBounty[1]) + target.level * 3;
        killer.gold += bounty;
        this.gainXp(killer, BALANCE.xp.killBase + target.level * BALANCE.xp.killPerLevel);
        this.recordKill(killer, target.name, target.clsId, false, victimStreak);
      }
    } else if (target.kind === 'boss') {
      this.bosses.delete(target.id);
      this.bossRespawnAt = t + BALANCE.boss.respawnMs;
      this.pushFx({ t: 'bossDeath', x: target.x, y: target.y });
      this.dropLoot(target.x, target.y, randInt(DROP.bossMin, DROP.bossMax));
      const killer = (attacker && attacker.kind === 'player') ? attacker
        : (target.lastHitBy && this.players.get(target.lastHitBy));
      if (killer) {
        killer.bossKills += 1; killer.gold += BALANCE.boss.bounty;
        this.gainXp(killer, BALANCE.xp.bossKill);
        this.pushFx({ t: 'bossKill', x: target.x, y: target.y, name: killer.name, boss: target.name });
        this.pushFx({ t: 'killfeed', killer: killer.name, killerId: killer.id, kcls: killer.clsId, victim: target.name, vcls: 'boss', boss: true });
      } else {
        this.pushFx({ t: 'bossKill', x: target.x, y: target.y, name: '', boss: target.name });
      }
    }
  }

  // record a hero kill: update streak/multi-kill/first-blood and emit a feed event
  recordKill(killer, victimName, victimCls, isBoss, victimStreak) {
    const t = now();
    if (t - killer.lastKillAt <= KILL.multiWindowMs) killer.multiKill += 1; else killer.multiKill = 1;
    killer.lastKillAt = t;
    killer.killStreak += 1;
    const fb = !this.firstBlood; if (fb) this.firstBlood = true;
    this.pushFx({
      t: 'killfeed',
      killer: killer.name, killerId: killer.id, kcls: killer.clsId,
      victim: victimName, vcls: victimCls, boss: !!isBoss,
      fb, multi: killer.multiKill, spree: killer.killStreak,
      shutdown: (victimStreak >= 3) ? victimStreak : 0
    });
  }

  gainXp(p, amount) {
    if (!p || p.dead) return;
    p.xp += amount;
    let leveled = false;
    while (p.xp >= p.xpNext) {
      p.xp -= p.xpNext; p.level += 1; p.xpNext = xpForLevel(p.level); leveled = true;
    }
    if (leveled) {
      const newMax = p.effMaxHp();
      p.hp = newMax;                       // full heal on level up
      p.maxHp = newMax;
      this.pushFx({ t: 'levelup', x: p.x, y: p.y, level: p.level, id: p.id });
    }
  }

  // ---- player actions -----------------------------------------------------
  doAttack(p) {
    const t = now();
    if (!p || p.dead || t < p.attackReadyAt) return;
    p.attackReadyAt = t + p.effAttackCd(t);
    const cls = p.cls;
    const crit = Math.random() < cls.critChance;
    const base = p.effAttack(t) * (crit ? cls.critMult : 1);

    if (cls.attackType === 'projectile') {
      const aim = this.nearestEnemy(p, cls.attackRange);
      const ang = aim ? Math.atan2(aim.y - p.y, aim.x - p.x) : p.facing;
      p.facing = ang;
      const pr = new Projectile({
        x: p.x + Math.cos(ang) * 26, y: p.y + Math.sin(ang) * 26,
        vx: Math.cos(ang) * cls.projSpeed, vy: Math.sin(ang) * cls.projSpeed,
        ownerId: p.id, ownerKind: 'player', damage: base, radius: cls.projRadius,
        type: 'bolt', crit, life: cls.attackRange / cls.projSpeed + 0.2
      });
      this.projectiles.set(pr.id, pr);
      this.pushFx({ t: 'cast', cls: 'mage', x: p.x, y: p.y, ang });
    } else if (cls.attackType === 'melee_aoe') {
      // hit all enemies within range & facing arc
      const aim = this.nearestEnemy(p, cls.attackRange);
      if (aim) p.facing = Math.atan2(aim.y - p.y, aim.x - p.x);
      const rangeSq = (cls.attackRange + 0) ** 2;
      for (const e of this.enemiesOfPlayer(p)) {
        const d2 = dist2(p.x, p.y, e.x, e.y);
        if (d2 > (cls.attackRange + this.radiusOf(e)) ** 2) continue;
        const ang = Math.atan2(e.y - p.y, e.x - p.x);
        if (Math.abs(angDiff(ang, p.facing)) > cls.attackArc / 2) continue;
        this.damageEntity(e, base, p, { crit });
      }
      this.pushFx({ t: 'swing', x: p.x, y: p.y, ang: p.facing, range: cls.attackRange, arc: cls.attackArc, color: cls.color });
    } else { // melee_single (assassin)
      const aim = this.nearestEnemy(p, cls.attackRange);
      if (aim) {
        p.facing = Math.atan2(aim.y - p.y, aim.x - p.x);
        this.damageEntity(aim, base, p, { crit });
        this.pushFx({ t: 'slash', x: aim.x, y: aim.y, crit, color: cls.color });
      }
      this.pushFx({ t: 'swing', x: p.x, y: p.y, ang: p.facing, range: cls.attackRange, arc: Math.PI * 0.5, color: cls.color });
    }
  }

  doSkill(p, slot) {
    const t = now();
    if (!p || p.dead) return;
    const skill = p.cls.skills[slot];
    if (!skill) return;                                  // slot not yet unlocked
    if ((p.skillReadyAt[skill.id] || 0) > t) return;
    p.skillReadyAt[skill.id] = t + skill.cd;
    const crit = true;
    const base = p.effAttack(t) * skill.mult;

    if (skill.id === 'fireball') {
      const aim = this.nearestEnemy(p, p.cls.attackRange);
      const ang = aim ? Math.atan2(aim.y - p.y, aim.x - p.x) : p.facing;
      p.facing = ang;
      const pr = new Projectile({
        x: p.x + Math.cos(ang) * 28, y: p.y + Math.sin(ang) * 28,
        vx: Math.cos(ang) * skill.projSpeed, vy: Math.sin(ang) * skill.projSpeed,
        ownerId: p.id, ownerKind: 'player', damage: base, radius: skill.projRadius,
        type: 'fireball', aoe: skill.radius, aoeMult: 1, crit: false, life: 2.4
      });
      this.projectiles.set(pr.id, pr);
      this.pushFx({ t: 'cast', cls: 'mage', x: p.x, y: p.y, ang, big: true });
    } else if (skill.id === 'whirlwind') {
      for (const e of this.enemiesOfPlayer(p)) {
        if (dist2(p.x, p.y, e.x, e.y) <= (skill.radius + this.radiusOf(e)) ** 2)
          this.damageEntity(e, base, p, { crit: false });
      }
      this.pushFx({ t: 'whirlwind', x: p.x, y: p.y, radius: skill.radius, color: p.cls.color });
    } else if (skill.id === 'shadowstrike') {
      const aim = this.nearestEnemy(p, 460);
      const ang = aim ? Math.atan2(aim.y - p.y, aim.x - p.x) : p.facing;
      p.facing = ang;
      const sx = p.x, sy = p.y;
      const nx = clamp(p.x + Math.cos(ang) * skill.dash, 30, WORLD.width - 30);
      const ny = clamp(p.y + Math.sin(ang) * skill.dash, 30, WORLD.height - 30);
      // damage enemies near the dash line
      for (const e of this.enemiesOfPlayer(p)) {
        const t2 = this.pointSegDist2(e.x, e.y, sx, sy, nx, ny);
        if (t2 <= (skill.radius + this.radiusOf(e)) ** 2) this.damageEntity(e, base, p, { crit: true });
      }
      p.x = nx; p.y = ny;
      this.resolveObstacles(p, 22);
      this.pushFx({ t: 'dash', x1: sx, y1: sy, x2: nx, y2: ny, color: p.cls.color });
    }
  }

  pointSegDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay; const l2 = dx * dx + dy * dy || 1;
    let tt = ((px - ax) * dx + (py - ay) * dy) / l2; tt = clamp(tt, 0, 1);
    const cx = ax + tt * dx, cy = ay + tt * dy;
    return dist2(px, py, cx, cy);
  }

  buy(p, itemId) {
    const t = now();
    if (!p || p.dead) return { ok: false, msg: '已阵亡' };
    let near = false;
    for (const m of this.merchants.values())
      if (dist2(p.x, p.y, m.x, m.y) <= BALANCE.merchantRange ** 2) { near = true; break; }
    if (!near) return { ok: false, msg: '附近没有商人' };
    const entry = SHOP.find(s => s.id === itemId);
    if (!entry) return { ok: false, msg: '没有该商品' };
    if (p.gold < entry.price) return { ok: false, msg: '金币不足' };
    p.gold -= entry.price;
    this.applyItem(p, itemId);
    this.pushFx({ t: 'buy', x: p.x, y: p.y });
    return { ok: true, msg: `购买了${ITEM_TYPES[itemId].name}` };
  }

  applyItem(p, type) {
    const t = now();
    const def = ITEM_TYPES[type];
    switch (type) {
      case 'heal': p.hp = Math.min(p.effMaxHp(), p.hp + p.effMaxHp() * 0.4); break;
      case 'life': p.extraLives += 1; break;
      case 'exp': this.gainXp(p, BALANCE.xp.expPotion + p.level * 12); break;
      case 'gold': p.gold += randInt(BALANCE.goldChest[0], BALANCE.goldChest[1]); break;
      default: // timed buffs
        if (BALANCE.buffDur[type]) p.buffs[type] = t + BALANCE.buffDur[type];
    }
    this.pushFx({ t: 'pickup', x: p.x, y: p.y, color: def.color, icon: def.icon, type, id: p.id });
  }

  // ---- main update --------------------------------------------------------
  update(dt) {
    const t = now();

    // players: movement, buffs, respawn
    for (const p of this.players.values()) {
      // chat expiry
      if (p.chat && p.chat.until <= t) p.chat = null;
      if (p.dead) {
        if (t >= p.respawnAt) {
          const pt = this.randomPoint(160);
          p.x = pt.x; p.y = pt.y; p.dead = false;
          p.hp = p.effMaxHp(); p.maxHp = p.effMaxHp();
          p.spawnProtectUntil = t + BALANCE.spawnProtect;
          this.pushFx({ t: 'spawn', x: p.x, y: p.y, color: p.cls.color });
        }
        continue;
      }
      let dx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
      let dy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
      if (dx || dy) {
        const len = Math.hypot(dx, dy);
        dx /= len; dy /= len;
        const sp = p.effSpeed(t);
        p.x += dx * sp * dt; p.y += dy * sp * dt;
        this.resolveObstacles(p, 22);
        p.facing = Math.atan2(dy, dx);
        p.moving = true;
      } else p.moving = false;
    }

    // projectiles
    for (const pr of this.projectiles.values()) {
      pr.life -= dt;
      pr.x += pr.vx * dt; pr.y += pr.vy * dt;
      if (pr.life <= 0 || pr.x < -40 || pr.y < -40 || pr.x > WORLD.width + 40 || pr.y > WORLD.height + 40) {
        if (pr.type === 'fireball') this.explode(pr);
        this.projectiles.delete(pr.id); continue;
      }
      // obstacles block shots (cover)
      let blocked = false;
      for (const o of this.obstacles)
        if (dist2(pr.x, pr.y, o.x, o.y) <= (o.r + pr.radius) ** 2) { blocked = true; break; }
      if (blocked) {
        if (pr.type === 'fireball') this.explode(pr);
        else this.pushFx({ t: 'hit', x: pr.x, y: pr.y, color: '#cdd6ea' });
        this.projectiles.delete(pr.id); continue;
      }
      const targets = pr.ownerKind === 'boss'
        ? [...this.players.values()].filter(o => !o.dead)
        : this.enemiesOfPlayerId(pr.ownerId);
      let hit = null;
      for (const e of targets) {
        if (dist2(pr.x, pr.y, e.x, e.y) <= (pr.radius + this.radiusOf(e)) ** 2) { hit = e; break; }
      }
      if (hit) {
        if (pr.type === 'fireball') { this.explode(pr); }
        else {
          const owner = this.players.get(pr.ownerId) || null;
          this.damageEntity(hit, pr.damage, owner, { crit: pr.crit });
          if (pr.type === 'orb') this.pushFx({ t: 'hit', x: pr.x, y: pr.y, color: '#ff6a3d' });
          else this.pushFx({ t: 'hit', x: pr.x, y: pr.y, color: '#bcd6ff' });
        }
        this.projectiles.delete(pr.id);
      }
    }

    // bosses
    for (const b of this.bosses.values()) {
      this.updateBoss(b, dt, t);
    }
    if (this.bosses.size < BALANCE.boss.count && t >= this.bossRespawnAt && this.bossRespawnAt !== 0) {
      this.spawnBoss(); this.bossRespawnAt = 0;
    }

    // merchants: short hop, then stand still a while so players can shop
    for (const m of this.merchants.values()) {
      if (m.state === 'idle') {
        if (t >= m.stateUntil) {                 // done resting -> pick a nearby spot and walk there
          const ang = Math.random() * Math.PI * 2;
          const d = randInt(BALANCE.merchantRoamDist[0], BALANCE.merchantRoamDist[1]);
          m.tx = clamp(m.x + Math.cos(ang) * d, 80, WORLD.width - 80);
          m.ty = clamp(m.y + Math.sin(ang) * d, 80, WORLD.height - 80);
          m.state = 'move'; m.stateUntil = t + BALANCE.merchantMoveMaxMs;
        }
        continue;                                // hold position while idle
      }
      const dx = m.tx - m.x, dy = m.ty - m.y;
      if ((dx * dx + dy * dy) < 36 || t >= m.stateUntil) {   // arrived (or timed out) -> rest
        m.state = 'idle'; m.stateUntil = t + randInt(BALANCE.merchantPauseMs[0], BALANCE.merchantPauseMs[1]);
        continue;
      }
      const a = Math.atan2(dy, dx);
      m.x = clamp(m.x + Math.cos(a) * BALANCE.merchantSpeed * dt, 24, WORLD.width - 24);
      m.y = clamp(m.y + Math.sin(a) * BALANCE.merchantSpeed * dt, 24, WORLD.height - 24);
    }

    // item spawning
    if (t >= this.itemSpawnAt) { this.spawnItem(); this.itemSpawnAt = t + BALANCE.itemSpawnMs; }

    // pickups
    for (const p of this.players.values()) {
      if (p.dead) continue;
      for (const it of this.items.values()) {
        if (dist2(p.x, p.y, it.x, it.y) <= BALANCE.pickupRadius ** 2) {
          this.applyItem(p, it.type); this.items.delete(it.id);
        }
      }
    }
  }

  enemiesOfPlayerId(ownerId) {
    const owner = this.players.get(ownerId);
    const out = [];
    for (const o of this.players.values()) if (o.id !== ownerId && !o.dead) out.push(o);
    for (const b of this.bosses.values()) out.push(b);
    return out;
  }

  explode(pr) {
    this.pushFx({ t: 'explosion', x: pr.x, y: pr.y, radius: pr.aoe });
    const owner = this.players.get(pr.ownerId) || null;
    const targets = this.enemiesOfPlayerId(pr.ownerId);
    for (const e of targets) {
      if (dist2(pr.x, pr.y, e.x, e.y) <= (pr.aoe + this.radiusOf(e)) ** 2)
        this.damageEntity(e, pr.damage * pr.aoeMult, owner, { crit: false });
    }
  }

  updateBoss(b, dt, t) {
    const B = BALANCE.boss;
    // pick / refresh target = nearest alive player within aggro
    let tgt = b.targetId && this.players.get(b.targetId);
    if (!tgt || tgt.dead || dist2(b.x, b.y, tgt.x, tgt.y) > B.aggro * B.aggro) {
      tgt = null; let bestD = B.aggro * B.aggro;
      for (const p of this.players.values()) {
        if (p.dead) continue;
        const d = dist2(b.x, b.y, p.x, p.y);
        if (d < bestD) { bestD = d; tgt = p; }
      }
      b.targetId = tgt ? tgt.id : null;
    }
    if (!tgt) return;
    b.facing = Math.atan2(tgt.y - b.y, tgt.x - b.x);
    const d2 = dist2(b.x, b.y, tgt.x, tgt.y);
    if (d2 > B.contactRange * B.contactRange) {
      b.x += Math.cos(b.facing) * B.speed * dt;
      b.y += Math.sin(b.facing) * B.speed * dt;
      this.resolveObstacles(b, B.radius);
    } else if (t >= b.attackReadyAt) {
      b.attackReadyAt = t + B.contactMs;
      this.damageEntity(tgt, B.attack, b);
      this.pushFx({ t: 'swing', x: b.x, y: b.y, ang: b.facing, range: B.contactRange, arc: Math.PI, color: '#ff4d4d' });
    }
    // ground slam — AOE around boss
    if (t >= b.slamReadyAt) {
      b.slamReadyAt = t + B.slamMs;
      this.pushFx({ t: 'slam', x: b.x, y: b.y, radius: B.slamRadius });
      for (const p of this.players.values()) {
        if (!p.dead && dist2(b.x, b.y, p.x, p.y) <= (B.slamRadius + 22) ** 2)
          this.damageEntity(p, B.slamDmg, b);
      }
    }
    // radial orb barrage
    if (t >= b.orbReadyAt) {
      b.orbReadyAt = t + B.orbMs;
      for (let i = 0; i < B.orbCount; i++) {
        const a = (Math.PI * 2 * i) / B.orbCount;
        const pr = new Projectile({
          x: b.x + Math.cos(a) * B.radius, y: b.y + Math.sin(a) * B.radius,
          vx: Math.cos(a) * B.orbSpeed, vy: Math.sin(a) * B.orbSpeed,
          ownerId: b.id, ownerKind: 'boss', damage: B.orbDmg, radius: B.orbRadius,
          type: 'orb', life: 2.6
        });
        this.projectiles.set(pr.id, pr);
      }
      this.pushFx({ t: 'bossCast', x: b.x, y: b.y });
    }
  }

  // ---- serialization ------------------------------------------------------
  // Build the full snapshot ONCE per broadcast tick. Each connected client then
  // gets its own culled slice via viewFor(), so per-client cost is the JSON of
  // only what that player can see — bandwidth scales with viewport, not with the
  // total population. Entities carry numeric x,y so viewFor() can rect-test them.
  prepareSnapshot() {
    const t = now();
    const r = (n) => Math.round(n);
    const players = [];
    for (const p of this.players.values()) {
      const buffs = [];
      for (const k in p.buffs) if (p.buffs[k] > t) buffs.push(k);
      players.push({
        id: p.id, name: p.name, cls: p.clsId, x: r(p.x), y: r(p.y),
        hp: r(Math.max(0, p.hp)), maxHp: r(p.effMaxHp()), level: p.level,
        facing: +p.facing.toFixed(2), moving: p.moving, dead: p.dead,
        kills: p.kills, deaths: p.deaths, bossKills: p.bossKills, gold: r(p.gold),
        score: p.score, xp: r(p.xp), xpNext: p.xpNext, extraLives: p.extraLives,
        invis: p.hasBuff('invis', t), buffs,
        prot: p.spawnProtectUntil > t,
        chat: p.chat ? p.chat.text : null
      });
    }
    const bosses = [];
    for (const b of this.bosses.values())
      bosses.push({ id: b.id, name: b.name, x: r(b.x), y: r(b.y), hp: r(Math.max(0, b.hp)), maxHp: b.maxHp, facing: +b.facing.toFixed(2) });
    const merchants = [];
    for (const m of this.merchants.values()) merchants.push({ id: m.id, name: m.name, x: r(m.x), y: r(m.y), idle: m.state === 'idle' });
    const items = [];
    for (const it of this.items.values()) items.push({ id: it.id, type: it.type, x: r(it.x), y: r(it.y) });
    const projectiles = [];
    for (const pr of this.projectiles.values())
      projectiles.push({ id: pr.id, x: r(pr.x), y: r(pr.y), type: pr.type, r: pr.radius, owner: pr.ownerId });
    this._snap = { t, players, bosses, merchants, items, projectiles };
    this._fx = this.fx; this.fx = [];   // capture fx once; viewFor() culls per client
    return this._snap;
  }

  // Slice the prepared snapshot down to one client's view rectangle.
  // (Linear scan over the snapshot; if profiling ever shows this dominating at
  // very high player counts, back it with a spatial grid — see P3.)
  viewFor(rect, viewer) {
    const s = this._snap, fxAll = this._fx || [];
    const inR = (e) => e.x >= rect.x0 && e.x <= rect.x1 && e.y >= rect.y0 && e.y <= rect.y1;
    // Hide invisible rivals at the source (anti-cheat): a culled client never
    // receives their exact position, so a patched client still can't see them.
    // You always see yourself, and 洞察之眼/reveal still surfaces hidden players.
    // (The low-rate minimap overview stays a single broadcast — its faint blip
    // is filtered client-side, an accepted trade for keeping that one broadcast.)
    const viewerId = viewer ? viewer.id : null;
    const revealed = viewer ? viewer.hasBuff('reveal', s.t) : false;
    const canSee = (p) => inR(p) && (!p.invis || p.id === viewerId || revealed);
    const fx = [];
    for (const f of fxAll) {
      if (GLOBAL_FX.has(f.t) || f.x === undefined) fx.push(f);            // always-deliver announcements
      else if (f.x >= rect.x0 && f.x <= rect.x1 && f.y >= rect.y0 && f.y <= rect.y1) fx.push(f);
    }
    return {
      t: s.t,
      players: s.players.filter(canSee),
      bosses: s.bosses.filter(inR),
      merchants: s.merchants.filter(inR),
      items: s.items.filter(inR),
      projectiles: s.projectiles.filter(inR),
      fx
    };
  }

  // Tiny global blip list for the minimap (all entities, minimal fields). Sent
  // at a low rate to every client so far-away dots still show on the minimap and
  // "洞察之眼/reveal" can surface hidden players, without the per-frame detail cost.
  overview() {
    const t = now();
    const r = (n) => Math.round(n);
    const players = [];
    for (const p of this.players.values())
      players.push({ id: p.id, cls: p.clsId, x: r(p.x), y: r(p.y), dead: p.dead, invis: p.hasBuff('invis', t) });
    const bosses = [];
    for (const b of this.bosses.values()) bosses.push({ id: b.id, x: r(b.x), y: r(b.y) });
    const merchants = [];
    for (const m of this.merchants.values()) merchants.push({ id: m.id, x: r(m.x), y: r(m.y), idle: m.state === 'idle' });
    const items = [];
    for (const it of this.items.values()) items.push({ id: it.id, type: it.type, x: r(it.x), y: r(it.y) });
    return { players, bosses, merchants, items };
  }

  realtimeLeaderboard(n = 8) {
    return [...this.players.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .map(p => ({ name: p.name, cls: p.clsId, score: p.score, level: p.level, kills: p.kills, bossKills: p.bossKills }));
  }
}

module.exports = { World };

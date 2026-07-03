'use strict';
// 服务端权威世界模拟：一张大地图，无赛局，死亡后重生。
const C = require('./config');

let nextId = 1;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function dist2(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; }

class Player {
  constructor(name, color) {
    this.id = nextId++;
    this.name = name;
    this.color = color;
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.angle = 0;
    this.spin = 0;               // 被击飞后的视觉旋转
    this.hp = C.CAR.hp;
    this.nitro = C.NITRO.max;
    this.boosting = false;
    this.input = { up: false, down: false, left: false, right: false, boost: false };
    this.dead = false;
    this.respawnAt = 0;
    this.invulnUntil = 0;        // 出生保护
    this.shieldUntil = 0;        // 护盾道具
    this.powerUntil = 0;         // 狂暴道具
    this.score = 0;              // 本条命的得分（死亡清零并计入历史榜）
    this.kills = 0;              // 本次会话总击杀
    this.deaths = 0;
    this.lastHitBy = 0;
    this.lastHitAt = 0;
    this.sawReadyAt = 0;
    this.padReadyAt = 0;
    this.chatReadyAt = 0;
    this.crown = false;
  }
  protected(t) { return t < this.invulnUntil || t < this.shieldUntil; }
  powered(t) { return t < this.powerUntil; }
}

class World {
  constructor() {
    this.players = new Map();
    this.pickups = new Map();
    this.events = [];            // 每次广播时被取走清空
    this.time = 0;               // 模拟时间 ms
    this.nextPickupAt = 0;
    this.nextPickupId = 1;
    this.pairHits = new Map();   // "aId:bId" -> 上次伤害时间
    this.onDeath = null;         // 回调(player, killer|null)
  }

  addPlayer(name, color) {
    const p = new Player(name, color);
    this.spawn(p);
    this.players.set(p.id, p);
    this.events.push({ e: 'spawn', id: p.id, x: Math.round(p.x), y: Math.round(p.y) });
    return p;
  }

  removePlayer(id) { this.players.delete(id); }

  setInput(id, input) {
    const p = this.players.get(id);
    if (!p) return;
    p.input.up = !!input.up;
    p.input.down = !!input.down;
    p.input.left = !!input.left;
    p.input.right = !!input.right;
    p.input.boost = !!input.boost;
  }

  spawn(p) {
    // 选离其他活人最远的出生点
    let best = C.SPAWNS[0], bestD = -1;
    for (const s of C.SPAWNS) {
      let d = Infinity;
      for (const q of this.players.values()) {
        if (q.dead || q === p) continue;
        d = Math.min(d, dist2(s.x, s.y, q.x, q.y));
      }
      if (d > bestD) { bestD = d; best = s; }
    }
    p.x = best.x + (Math.random() - 0.5) * 60;
    p.y = best.y + (Math.random() - 0.5) * 60;
    p.vx = 0; p.vy = 0; p.spin = 0;
    p.angle = Math.atan2(C.WORLD.h / 2 - p.y, C.WORLD.w / 2 - p.x);
    p.hp = C.CAR.hp;
    p.nitro = C.NITRO.max;
    p.dead = false;
    p.invulnUntil = this.time + C.SPAWN_PROT_MS;
    p.shieldUntil = 0; p.powerUntil = 0;
    p.lastHitBy = 0; p.lastHitAt = 0;
  }

  update(dt) {
    this.time += dt * 1000;
    const t = this.time;

    for (const p of this.players.values()) {
      if (p.dead) {
        if (t >= p.respawnAt) {
          this.spawn(p);
          this.events.push({ e: 'spawn', id: p.id, x: Math.round(p.x), y: Math.round(p.y) });
        }
        continue;
      }
      this.movePlayer(p, dt, t);
      this.collideWalls(p, t);
      this.collideBumpers(p, t);
      this.collideSaws(p, t);
      this.applyPads(p, t);
      this.collectPickups(p, t);
    }

    this.collidePlayers(t);
    this.spawnPickups(t);
  }

  movePlayer(p, dt, t) {
    const inp = p.input;
    // 方向即走：上下左右直接决定行驶方向（支持斜向），车头自动转过去
    let dx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    let dy = (inp.down ? 1 : 0) - (inp.up ? 1 : 0);
    const moving = dx !== 0 || dy !== 0;
    if (moving) {
      const m = Math.hypot(dx, dy);
      dx /= m; dy /= m;
    }

    // 氮气：按住冲刺 + 任意方向
    const wantBoost = inp.boost && moving;
    if (wantBoost && (p.boosting ? p.nitro > 0 : p.nitro >= C.NITRO.minToFire)) {
      p.boosting = true;
      p.nitro = Math.max(0, p.nitro - C.NITRO.drain * dt);
    } else {
      p.boosting = false;
      p.nitro = Math.min(C.NITRO.max, p.nitro + C.NITRO.regen * dt);
    }

    // 被击飞的旋转慢慢衰减
    p.spin *= Math.max(0, 1 - 4.5 * dt);

    // 朝目标方向加速，车头平滑转向行驶方向（纯视觉，不影响操控）
    if (moving) {
      const accel = p.boosting ? C.CAR.boostAccel : C.CAR.accel;
      p.vx += dx * accel * dt;
      p.vy += dy * accel * dt;
      const want = Math.atan2(dy, dx);
      let da = want - p.angle;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      const maxTurn = C.CAR.turnRate * dt;
      p.angle += clamp(da, -maxTurn, maxTurn);
    }

    // 摩擦
    const f = Math.max(0, 1 - C.CAR.friction * dt);
    p.vx *= f; p.vy *= f;

    // 限速（被击飞时允许超速，靠摩擦自然减回来）
    const engineMax = p.boosting ? C.CAR.boostSpeed : C.CAR.maxSpeed;
    const sp = Math.hypot(p.vx, p.vy);
    if (moving && sp > engineMax && sp < engineMax * 1.05) {
      const k = engineMax / sp;
      p.vx *= k; p.vy *= k;
    }
    const HARD_CAP = 1400;
    if (sp > HARD_CAP) { const k = HARD_CAP / sp; p.vx *= k; p.vy *= k; }

    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }

  collideWalls(p, t) {
    const r = C.CAR.r, e = 0.75;
    let hit = 0;
    if (p.x < r) { p.x = r; if (p.vx < 0) { hit = Math.abs(p.vx); p.vx = -p.vx * e; } }
    if (p.x > C.WORLD.w - r) { p.x = C.WORLD.w - r; if (p.vx > 0) { hit = Math.abs(p.vx); p.vx = -p.vx * e; } }
    if (p.y < r) { p.y = r; if (p.vy < 0) { hit = Math.max(hit, Math.abs(p.vy)); p.vy = -p.vy * e; } }
    if (p.y > C.WORLD.h - r) { p.y = C.WORLD.h - r; if (p.vy > 0) { hit = Math.max(hit, Math.abs(p.vy)); p.vy = -p.vy * e; } }
    if (hit > C.DMG.wallMinSpeed && !p.protected(t)) {
      this.damage(p, C.DMG.wallDmg, null, t);
      this.events.push({ e: 'wall', x: Math.round(p.x), y: Math.round(p.y), p: clamp(hit / 900, 0.3, 1) });
    } else if (hit > 220) {
      this.events.push({ e: 'wall', x: Math.round(p.x), y: Math.round(p.y), p: 0.2 });
    }
  }

  collideBumpers(p, t) {
    for (const b of C.BUMPERS) {
      const rr = b.r + C.CAR.r;
      const d2 = dist2(p.x, p.y, b.x, b.y);
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2) || 0.01;
      const nx = (p.x - b.x) / d, ny = (p.y - b.y) / d;
      p.x = b.x + nx * rr;
      p.y = b.y + ny * rr;
      const vn = p.vx * nx + p.vy * ny;
      if (vn < 0) {
        const bounce = Math.max(-vn * C.BUMPER.restitution, C.BUMPER.minKick);
        p.vx += nx * (bounce - vn);
        p.vy += ny * (bounce - vn);
        p.spin += (Math.random() - 0.5) * C.KNOCK.spin;
        this.events.push({ e: 'bump', x: Math.round(b.x + nx * b.r), y: Math.round(b.y + ny * b.r), p: clamp(-vn / 700, 0.25, 1) });
      }
    }
  }

  collideSaws(p, t) {
    for (const s of C.SAWS) {
      const rr = s.r + C.CAR.r - 6;
      if (dist2(p.x, p.y, s.x, s.y) >= rr * rr) continue;
      const d = Math.sqrt(dist2(p.x, p.y, s.x, s.y)) || 0.01;
      const nx = (p.x - s.x) / d, ny = (p.y - s.y) / d;
      p.x = s.x + nx * (rr + 2);
      p.y = s.y + ny * (rr + 2);
      p.vx = nx * C.SAW.fling + (Math.random() - 0.5) * 120;
      p.vy = ny * C.SAW.fling + (Math.random() - 0.5) * 120;
      p.spin += C.KNOCK.spin * 1.5;
      if (t >= p.sawReadyAt && !p.protected(t)) {
        p.sawReadyAt = t + C.SAW.cooldownMs;
        this.events.push({ e: 'saw', x: Math.round(p.x), y: Math.round(p.y), d: C.SAW.dmg });
        this.damage(p, C.SAW.dmg, null, t, '被电锯切碎了');
      }
    }
  }

  applyPads(p, t) {
    if (t < p.padReadyAt) return;
    for (const pad of C.PADS) {
      if (p.x < pad.x || p.x > pad.x + pad.w || p.y < pad.y || p.y > pad.y + pad.h) continue;
      p.vx += Math.cos(pad.dir) * C.PAD.kick;
      p.vy += Math.sin(pad.dir) * C.PAD.kick;
      p.padReadyAt = t + C.PAD.cooldownMs;
      this.events.push({ e: 'pad', x: Math.round(p.x), y: Math.round(p.y) });
      break;
    }
  }

  collidePlayers(t) {
    const list = [...this.players.values()].filter(p => !p.dead);
    const rr = C.CAR.r * 2;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const d2 = dist2(a.x, a.y, b.x, b.y);
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 0.01;
        const nx = (b.x - a.x) / d, ny = (b.y - a.y) / d;

        // 分离重叠
        const overlap = (rr - d) / 2;
        a.x -= nx * overlap; a.y -= ny * overlap;
        b.x += nx * overlap; b.y += ny * overlap;

        // 沿法线的逼近速度
        const van = a.vx * nx + a.vy * ny;      // a 朝 b 的分量
        const vbn = b.vx * nx + b.vy * ny;      // b 沿同方向的分量
        const rel = van - vbn;                  // >0 表示在互相逼近
        if (rel <= 0) continue;

        // 夸张弹性碰撞（等质量，restitution > 1）
        const jImp = (1 + C.KNOCK.restitution) * rel / 2;
        a.vx -= nx * jImp; a.vy -= ny * jImp;
        b.vx += nx * jImp; b.vy += ny * jImp;

        // 谁是主撞方：谁的逼近分量大
        const aPush = Math.max(0, van), bPush = Math.max(0, -vbn);
        const total = aPush + bPush || 1;
        const aShare = aPush / total;
        const attacker = aShare >= 0.5 ? a : b;
        const victim = attacker === a ? b : a;
        const atkShare = Math.max(aShare, 1 - aShare);

        // 额外把受害者铲飞
        const dir = attacker === a ? 1 : -1;
        const shove = rel * C.KNOCK.victimShove * atkShare * (attacker.powered(t) ? 1.6 : 1);
        victim.vx += nx * dir * shove;
        victim.vy += ny * dir * shove;
        victim.spin += (Math.random() - 0.5) * C.KNOCK.spin * clamp(rel / 500, 0.3, 1.6);

        // 伤害（带对冷却，防止贴脸每 tick 掉血）
        const key = a.id < b.id ? a.id + ':' + b.id : b.id + ':' + a.id;
        const last = this.pairHits.get(key);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (rel >= C.DMG.minImpact && (last === undefined || t - last >= C.DMG.pairCooldownMs)) {
          this.pairHits.set(key, t);
          let dmg = Math.min(C.DMG.cap, (rel - C.DMG.minImpact * 0.6) * C.DMG.scale);
          if (attacker.powered(t)) dmg *= 2;
          if (attacker.boosting) dmg *= 1.35;
          dmg = Math.round(dmg);
          const vDmg = victim.protected(t) ? 0 : dmg;
          const aDmg = attacker.protected(t) ? 0 : Math.round(dmg * (1 - atkShare) * 0.8);
          this.events.push({
            e: 'hit', x: Math.round(mid.x), y: Math.round(mid.y),
            p: clamp(rel / 900, 0.15, 1), d: vDmg, v: victim.id
          });
          if (vDmg > 0) {
            attacker.score += Math.round(vDmg * C.SCORE.dmgFactor);
            victim.lastHitBy = attacker.id;
            victim.lastHitAt = t;
            this.damage(victim, vDmg, attacker, t);
          }
          if (aDmg > 0) {
            attacker.lastHitBy = victim.id;
            attacker.lastHitAt = t;
            this.damage(attacker, aDmg, victim, t);
          }
        } else if (rel > 60) {
          this.events.push({ e: 'clank', x: Math.round(mid.x), y: Math.round(mid.y), p: clamp(rel / 500, 0.1, 0.6) });
        }
      }
    }
  }

  damage(p, dmg, attacker, t, causeText) {
    if (p.dead) return;
    p.hp -= dmg;
    if (p.hp > 0) return;
    p.hp = 0;
    p.dead = true;
    p.deaths++;
    p.respawnAt = t + C.RESPAWN_MS;

    // 击杀归属：直接攻击者，否则 8 秒内最后打过我的人
    let killer = attacker;
    if (!killer && p.lastHitBy && t - p.lastHitAt <= C.KILL_CREDIT_MS) {
      killer = this.players.get(p.lastHitBy) || null;
      if (killer && killer.dead) killer = null;
    }
    if (killer && killer !== p) {
      killer.kills++;
      killer.score += p.crown ? C.SCORE.killCrown : C.SCORE.kill;
    }
    this.events.push({
      e: 'die', id: p.id, x: Math.round(p.x), y: Math.round(p.y),
      vx: Math.round(p.vx), vy: Math.round(p.vy),
      n: p.name, c: p.color,
      by: killer ? killer.id : 0,
      byName: killer ? killer.name : (causeText || ''),
      byColor: killer ? killer.color : -1,
      crown: !!p.crown
    });
    if (this.onDeath) this.onDeath(p, killer || null);
    p.score = 0; // 得分是"这条命"的，死了清零（历史榜已在回调里记录）
  }

  spawnPickups(t) {
    if (t < this.nextPickupAt || this.pickups.size >= C.PICKUPS.max) return;
    this.nextPickupAt = t + C.PICKUPS.intervalMs;
    const kinds = C.PICKUPS.kinds;
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    // 避开电锯和弹力柱
    for (let tries = 0; tries < 20; tries++) {
      const x = 120 + Math.random() * (C.WORLD.w - 240);
      const y = 120 + Math.random() * (C.WORLD.h - 240);
      let ok = true;
      for (const s of C.SAWS) if (dist2(x, y, s.x, s.y) < (s.r + 90) ** 2) { ok = false; break; }
      if (ok) for (const b of C.BUMPERS) if (dist2(x, y, b.x, b.y) < (b.r + 70) ** 2) { ok = false; break; }
      if (!ok) continue;
      const id = this.nextPickupId++;
      this.pickups.set(id, { id, kind, x: Math.round(x), y: Math.round(y) });
      return;
    }
  }

  collectPickups(p, t) {
    for (const pk of this.pickups.values()) {
      const rr = C.PICKUPS.r + C.CAR.r;
      if (dist2(p.x, p.y, pk.x, pk.y) >= rr * rr) continue;
      this.pickups.delete(pk.id);
      switch (pk.kind) {
        case 'wrench': p.hp = Math.min(C.CAR.hp, p.hp + C.PICKUPS.heal); break;
        case 'nitro': p.nitro = C.NITRO.max; break;
        case 'shield': p.shieldUntil = t + C.PICKUPS.shieldMs; break;
        case 'power': p.powerUntil = t + C.PICKUPS.powerMs; break;
      }
      this.events.push({ e: 'pick', x: pk.x, y: pk.y, kind: pk.kind, id: p.id });
    }
  }

  updateCrown() {
    let top = null;
    for (const p of this.players.values()) {
      p.crown = false;
      if (p.dead || p.score <= 0) continue;
      if (!top || p.score > top.score) top = p;
    }
    if (top) top.crown = true;
  }

  snapshot() {
    this.updateCrown();
    const t = this.time;
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id, n: p.name, c: p.color,
        x: Math.round(p.x), y: Math.round(p.y),
        a: Math.round(p.angle * 100) / 100,
        sp: Math.round(p.spin * 10) / 10,
        hp: Math.round(p.hp), sc: p.score, k: p.kills,
        nt: Math.round(p.nitro),
        bo: p.boosting ? 1 : 0,
        sh: p.protected(t) ? 1 : 0,
        pw: p.powered(t) ? 1 : 0,
        dd: p.dead ? 1 : 0,
        cr: p.crown ? 1 : 0
      });
    }
    const pickups = [...this.pickups.values()];
    const events = this.events;
    this.events = [];
    // 清理无效的碰撞对冷却记录
    if (this.pairHits.size > 400) {
      for (const [k, v] of this.pairHits) if (t - v > 5000) this.pairHits.delete(k);
    }
    return { type: 'state', t: Math.round(t), players, pickups, events };
  }

  liveBoard(n = 10) {
    return [...this.players.values()]
      .sort((a, b) => b.score - a.score || b.kills - a.kills)
      .slice(0, n)
      .map(p => ({ n: p.name, c: p.color, sc: p.score, k: p.kills, cr: p.crown ? 1 : 0 }));
  }
}

module.exports = { World, Player };

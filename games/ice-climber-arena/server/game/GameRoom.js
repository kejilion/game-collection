// ============================================================================
//  GameRoom — the single authoritative world that every browser connects to.
//  Runs a fixed 60 Hz simulation, resolves all entity interactions, manages the
//  round / rescue lifecycle, and broadcasts 30 Hz snapshots to all clients.
// ============================================================================
import {
  TICK_RATE, DT, SNAPSHOT_RATE, WORLD_WIDTH, WORLD_HEIGHT, FLOOR_COUNT,
  FLOOR_SPACING, floorTopY, floorBandHalfWidth, Tile, PLAYER_W, PLAYER_H,
  PLAYER_MAX_HP, JUMP_BUFF_MULT, FALL_SAFE_FLOORS, FALL_DMG_PER_FLOOR,
  ATTACK_COOLDOWN, ATTACK_ANIM, MELEE_W, MELEE_H, MELEE_DMG, MELEE_KNOCKBACK,
  MONSTER_TOUCH_DMG, MONSTER_STUN, BUFF_JUMP_TIME, BUFF_FIRE_TIME, HEAL_AMOUNT,
  FIREBALL_SPEED, FIREBALL_DMG, FIREBALL_COOLDOWN, ICICLE_DMG, ICICLE_GRAVITY,
  ICICLE_INTERVAL, RESCUE_TARGET, INTERMISSION_MS, ROUND_TIME_LIMIT_MS,
  PLANE_Y, PLANE_SPEED, PICKUP_W, PICKUP_H, ItemKind, Phase,
} from '../../public/shared/constants.js';
import { stepPlayer, buildRects, aabb } from '../../public/shared/physics.js';
import { Player } from './Player.js';
import { Monster } from './Monster.js';
import {
  makeItem, serializeItem, makeProjectile, serializeProjectile,
  makeIcicle, serializeIcicle,
} from './entities.js';
import { generateLevel } from './Level.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rnd = (a, b) => a + Math.random() * (b - a);

export class GameRoom {
  constructor(io, leaderboard) {
    this.io = io;
    this.leaderboard = leaderboard;
    this.players = new Map();

    this.round = 1;
    this.phase = Phase.PLAYING;
    this.roundStartMs = Date.now();

    this.brokenIce = new Set();
    this.projectiles = [];
    this.icicles = [];
    this.rescued = [];
    this.fx = [];

    this.planeActive = false;
    this.planeX = WORLD_WIDTH / 2;
    this.planeDir = 1;
    this.planeCenter = WORLD_WIDTH / 2;

    this.snapAccum = 0;
    this.hazardNext = {};

    this.level = generateLevel(this.round);
    this._spawnEntities();
    this._initHazardTimers();
  }

  start() {
    this._timer = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  stop() {
    clearInterval(this._timer);
  }

  // --------------------------------------------------------------- players ---
  addPlayer(id, name, look) {
    const p = new Player(id, name, look);
    const s = this._groundSpawn();
    p.spawn(s.x, s.y);
    p.updateFloor();
    this.players.set(id, p);
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
    if (this.phase === Phase.PLAYING && this.rescued.length >= this._rescueTarget()) {
      this.endRound();
    }
  }

  setInput(id, msg) {
    const p = this.players.get(id);
    if (!p) return;
    p.input.left = !!msg.left;
    p.input.right = !!msg.right;
    p.input.jump = !!msg.jump;
    p.input.attack = !!msg.attack;
    if (msg.seq) p.lastSeq = msg.seq;
    p.lastInputAt = Date.now();
  }

  initStateFor(id) {
    return {
      selfId: id,
      serverTime: Date.now(),
      round: this.round,
      phase: this.phase,
      roundStartMs: this.roundStartMs,
      level: this.serializeLevel(),
      brokenIce: [...this.brokenIce],
      leaderboard: this.leaderboard.top(10),
    };
  }

  // ------------------------------------------------------------ simulation ---
  tick() {
    const now = Date.now();
    const t = (now - this.roundStartMs) / 1000;
    const rects = buildRects(this.level.platforms, this.brokenIce, t);

    if (this.phase === Phase.PLAYING && now - this.roundStartMs > ROUND_TIME_LIMIT_MS) {
      this.endRound();
    }

    for (const p of this.players.values()) {
      // tick down timers
      p.invuln = Math.max(0, p.invuln - DT);
      p.stun = Math.max(0, p.stun - DT);
      p.attackCd = Math.max(0, p.attackCd - DT);
      p.attackAnim = Math.max(0, p.attackAnim - DT);
      p.fireCd = Math.max(0, p.fireCd - DT);
      p.jumpBuff = Math.max(0, p.jumpBuff - DT);
      p.fireBuff = Math.max(0, p.fireBuff - DT);

      if (p.rescued) {
        if (p.lifting) p.y -= 70 * DT; // float up into the plane
        continue;
      }

      const frozen = p.stun > 0;
      const ev = stepPlayer(p, p.input, rects, DT, {
        frozen,
        jumpMul: p.jumpBuff > 0 ? JUMP_BUFF_MULT : 1,
      });

      // breakable ice via head-bonk
      for (const r of ev.bonk) {
        if (r.type === Tile.ICE && !this.brokenIce.has(r.id)) {
          this.brokenIce.add(r.id);
          this.fx.push({ t: 'ice', id: r.id, x: r.x + r.w / 2, y: r.y + r.h / 2 });
          if (Math.random() < 0.18) this._spawnItemAt(r.x + r.w / 2, r.y - 34, p.floor);
        }
      }

      // fall damage (> safe floors)
      if (ev.fallFloors > 0) {
        const dmg = (ev.fallFloors - FALL_SAFE_FLOORS) * FALL_DMG_PER_FLOOR;
        this.damagePlayer(p, dmg, { cause: 'fall' });
      }

      // attack (edge-triggered by cooldown)
      if (p.input.attack && p.attackCd <= 0 && !frozen) this.doAttack(p, now);

      p.updateFloor();

      if (p.floor >= FLOOR_COUNT - 1 && !this.planeActive && this.phase === Phase.PLAYING) {
        this.activatePlane();
      }

      this._checkItemPickup(p, now);
      this._checkMonsterContact(p);
      if (this.planeActive) this._checkRescue(p, now);
    }

    // monsters
    const pls = [...this.players.values()];
    for (const m of this.monsters) {
      const fire = m.update(DT, pls);
      if (fire) {
        this.projectiles.push(makeProjectile({ kind: 'freeze', owner: null, x: fire.x, y: fire.y, vx: fire.vx, vy: fire.vy, life: 3 }));
      }
    }
    this.monsters = this.monsters.filter((m) => m.alive);

    this._updateProjectiles(rects, now);
    this._updateIcicles(now);
    this._updateItems(now);
    if (this.planeActive) this._updatePlane();

    // snapshot cadence
    if (++this.snapAccum >= Math.round(TICK_RATE / SNAPSHOT_RATE)) {
      this.snapAccum = 0;
      this.broadcastSnapshot(now);
    }
  }

  // -------------------------------------------------------------- combat -----
  doAttack(p, now) {
    p.attackCd = ATTACK_COOLDOWN;
    p.attackAnim = ATTACK_ANIM;

    // fireball mode from pickup
    if (p.fireBuff > 0 && p.fireCd <= 0) {
      p.fireCd = FIREBALL_COOLDOWN;
      this.projectiles.push(makeProjectile({
        kind: 'fire', owner: p.id,
        x: p.x + p.facing * 16, y: p.y - PLAYER_H / 2,
        vx: p.facing * FIREBALL_SPEED, vy: -40, life: 1.7,
      }));
      this.fx.push({ t: 'shoot', x: p.x + p.facing * 16, y: p.y - PLAYER_H / 2, f: p.facing });
      return;
    }

    // melee hitbox in facing direction
    const hb = {
      x: p.facing > 0 ? p.x + PLAYER_W / 2 - 4 : p.x - PLAYER_W / 2 - MELEE_W + 4,
      y: p.y - PLAYER_H / 2 - 2,
      w: MELEE_W, h: MELEE_H,
    };
    for (const o of this.players.values()) {
      if (o === p || o.rescued || o.invuln > 0) continue;
      if (aabb(hb.x, hb.y, hb.w, hb.h, o.x - PLAYER_W / 2, o.y - PLAYER_H / 2, PLAYER_W, PLAYER_H)) {
        this.damagePlayer(o, MELEE_DMG, { knockback: p.facing * MELEE_KNOCKBACK, cause: 'pvp' });
      }
    }
    for (const m of this.monsters) {
      if (!m.alive) continue;
      const a = m.aabb();
      if (aabb(hb.x, hb.y, hb.w, hb.h, a.x, a.y, a.w, a.h)) this.damageMonster(m, MELEE_DMG);
    }
    this.fx.push({ t: 'swing', x: hb.x + hb.w / 2, y: hb.y + hb.h / 2, f: p.facing });
  }

  damagePlayer(p, amt, opts = {}) {
    if (p.invuln > 0 || p.rescued || !p.alive) return;
    p.hp -= amt;
    this.fx.push({ t: 'hit', x: p.x, y: p.y - PLAYER_H / 2, dmg: Math.round(amt), id: p.id });
    if (opts.knockback) {
      p.vx += opts.knockback;
      p.vy = Math.min(p.vy, -160);
      p.onGround = false;
    }
    if (p.hp <= 0) this.killPlayer(p, opts.cause);
  }

  killPlayer(p, cause) {
    p.deaths++;
    this.fx.push({ t: 'death', x: p.x, y: p.y, id: p.id, name: p.name, cause: cause || '' });
    const s = this._groundSpawn();
    p.spawn(s.x, s.y); // immediate respawn on the ground floor
    p.updateFloor();
  }

  damageMonster(m, amt) {
    m.hp -= amt;
    this.fx.push({ t: 'mhit', x: m.x, y: m.y - 16 });
    if (m.hp <= 0) {
      m.alive = false;
      this.fx.push({ t: 'mdeath', x: m.x, y: m.y - 16 });
    }
  }

  // ------------------------------------------------------------- pickups ------
  applyItem(p, kind) {
    if (kind === ItemKind.FIRE) p.fireBuff = BUFF_FIRE_TIME;
    else if (kind === ItemKind.HEAL) p.hp = Math.min(PLAYER_MAX_HP, p.hp + HEAL_AMOUNT);
    else if (kind === ItemKind.JUMP) p.jumpBuff = BUFF_JUMP_TIME;
  }

  _checkItemPickup(p, now) {
    for (const it of this.items) {
      if (it.taken) continue;
      if (aabb(p.x - PLAYER_W / 2, p.y - PLAYER_H / 2, PLAYER_W, PLAYER_H, it.x - 16, it.y - 16, 32, 32)) {
        it.taken = true;
        it.respawnAt = now + 20000;
        this.applyItem(p, it.kind);
        this.fx.push({ t: 'pickup', x: it.x, y: it.y, kind: it.kind, id: p.id });
      }
    }
  }

  _updateItems(now) {
    for (const it of this.items) {
      if (it.taken && it.respawnAt && now >= it.respawnAt) {
        it.taken = false;
        it.respawnAt = 0;
      }
    }
  }

  _spawnItemAt(x, y, floor) {
    const kind = [ItemKind.FIRE, ItemKind.HEAL, ItemKind.JUMP][Math.floor(Math.random() * 3)];
    this.items.push(makeItem({ kind, x, y, floor }));
  }

  // ------------------------------------------------------------ monsters ------
  _checkMonsterContact(p) {
    if (p.invuln > 0) return;
    const pb = { x: p.x - PLAYER_W / 2, y: p.y - PLAYER_H / 2, w: PLAYER_W, h: PLAYER_H };
    for (const m of this.monsters) {
      if (!m.alive) continue;
      const a = m.aabb();
      if (aabb(pb.x, pb.y, pb.w, pb.h, a.x, a.y, a.w, a.h)) {
        this.damagePlayer(p, MONSTER_TOUCH_DMG, { knockback: (Math.sign(p.x - m.x) || 1) * 210, cause: 'monster' });
        p.stun = Math.max(p.stun, MONSTER_STUN);
        break;
      }
    }
  }

  // ---------------------------------------------------------- projectiles -----
  _updateProjectiles(rects, now) {
    const keep = [];
    for (const pr of this.projectiles) {
      pr.life -= DT;
      pr.x += pr.vx * DT;
      pr.y += pr.vy * DT;
      if (pr.kind === 'fire') pr.vy += 240 * DT; // slight arc

      let dead = pr.life <= 0 || pr.x < -30 || pr.x > WORLD_WIDTH + 30 || pr.y > WORLD_HEIGHT + 50;

      if (!dead) {
        for (const r of rects) {
          if ((r.type === Tile.GROUND || r.type === Tile.SOLID) &&
              aabb(pr.x - 6, pr.y - 6, 12, 12, r.x, r.y, r.w, r.h)) { dead = true; break; }
        }
      }
      if (!dead && pr.kind === 'fire') {
        for (const m of this.monsters) {
          if (!m.alive) continue;
          const a = m.aabb();
          if (aabb(pr.x - 7, pr.y - 7, 14, 14, a.x, a.y, a.w, a.h)) { this.damageMonster(m, FIREBALL_DMG); dead = true; break; }
        }
        if (!dead) {
          for (const o of this.players.values()) {
            if (o.id === pr.owner || o.rescued || o.invuln > 0) continue;
            if (aabb(pr.x - 7, pr.y - 7, 14, 14, o.x - PLAYER_W / 2, o.y - PLAYER_H / 2, PLAYER_W, PLAYER_H)) {
              this.damagePlayer(o, FIREBALL_DMG, { knockback: Math.sign(pr.vx) * 220, cause: 'fire' });
              dead = true; break;
            }
          }
        }
      } else if (!dead && pr.kind === 'freeze') {
        for (const o of this.players.values()) {
          if (o.rescued || o.invuln > 0) continue;
          if (aabb(pr.x - 7, pr.y - 7, 14, 14, o.x - PLAYER_W / 2, o.y - PLAYER_H / 2, PLAYER_W, PLAYER_H)) {
            this.damagePlayer(o, 6, { cause: 'freeze' });
            o.stun = Math.max(o.stun, MONSTER_STUN);
            dead = true; break;
          }
        }
      }

      if (dead) this.fx.push({ t: 'pop', x: pr.x, y: pr.y, kind: pr.kind });
      else keep.push(pr);
    }
    this.projectiles = keep;
  }

  // -------------------------------------------------------------- hazards -----
  _initHazardTimers() {
    const now = Date.now();
    this.hazardNext = {};
    for (const f of this.level.floors) {
      if (f.hazard) this.hazardNext[f.i] = now + Math.random() * ICICLE_INTERVAL * 1000;
    }
  }

  _updateIcicles(now) {
    // spawn
    for (const f of this.level.floors) {
      if (!f.hazard) continue;
      if (now >= (this.hazardNext[f.i] || 0)) {
        this.hazardNext[f.i] = now + ICICLE_INTERVAL * 1000 * rnd(0.7, 1.3);
        const half = floorBandHalfWidth(f.i);
        const x = WORLD_WIDTH / 2 + rnd(-half, half);
        const ic = makeIcicle(x, floorTopY(f.i) - FLOOR_SPACING + 24);
        ic.targetY = floorTopY(f.i);
        this.icicles.push(ic);
      }
    }
    // update
    const keep = [];
    for (const c of this.icicles) {
      c.vy += ICICLE_GRAVITY * DT;
      c.y += c.vy * DT;
      let dead = false;
      for (const p of this.players.values()) {
        if (p.rescued || p.invuln > 0) continue;
        if (aabb(c.x - 7, c.y - 4, 14, 20, p.x - PLAYER_W / 2, p.y - PLAYER_H / 2, PLAYER_W, PLAYER_H)) {
          this.damagePlayer(p, ICICLE_DMG, { cause: 'icicle' });
          dead = true; break;
        }
      }
      if (!dead && c.y >= c.targetY) { dead = true; }
      if (dead) this.fx.push({ t: 'shatter', x: c.x, y: Math.min(c.y, c.targetY) });
      else keep.push(c);
    }
    this.icicles = keep;
  }

  // --------------------------------------------------------------- plane ------
  activatePlane() {
    this.planeActive = true;
    const pad = this.level.platforms.find((p) => p.id === this.level.topPadId);
    this.planeCenter = pad ? pad.x + pad.w / 2 : WORLD_WIDTH / 2;
    this.planeX = this.planeCenter - 150;
    this.planeDir = 1;
    this.fx.push({ t: 'plane' });
    this.io.emit('planeIncoming', {});
  }

  _updatePlane() {
    this.planeX += this.planeDir * PLANE_SPEED * DT;
    const lo = clamp(this.planeCenter - 160, 60, WORLD_WIDTH - 60);
    const hi = clamp(this.planeCenter + 160, 60, WORLD_WIDTH - 60);
    if (this.planeX >= hi) { this.planeX = hi; this.planeDir = -1; }
    if (this.planeX <= lo) { this.planeX = lo; this.planeDir = 1; }
  }

  _checkRescue(p, now) {
    if (p.floor < FLOOR_COUNT - 1 || p.onGround) return; // must hop into it at the top
    const zone = { x: this.planeX - PICKUP_W / 2, y: PLANE_Y + 24, w: PICKUP_W, h: PICKUP_H };
    if (aabb(p.x - PLAYER_W / 2, p.y - PLAYER_H / 2, PLAYER_W, PLAYER_H, zone.x, zone.y, zone.w, zone.h)) {
      this.rescuePlayer(p, now);
    }
  }

  rescuePlayer(p, now) {
    p.rescued = true;
    p.lifting = true;
    p.vx = 0; p.vy = 0;
    const timeMs = now - this.roundStartMs;
    const rank = this.rescued.length + 1;
    p.rank = rank;
    p.finishMs = timeMs;
    this.rescued.push({ id: p.id, name: p.name, timeMs, rank, look: p.look });
    const allTimeRank = this.leaderboard.add({ name: p.name, timeMs, round: this.round, rank });
    this.fx.push({ t: 'rescue', x: p.x, y: p.y, name: p.name, rank });
    this.io.emit('rescued', { id: p.id, name: p.name, rank, timeMs, round: this.round, allTimeRank });
    if (this.rescued.length >= this._rescueTarget()) this.endRound();
  }

  _rescueTarget() {
    return Math.min(RESCUE_TARGET, Math.max(1, this.players.size));
  }

  // --------------------------------------------------------------- rounds -----
  endRound() {
    if (this.phase !== Phase.PLAYING) return;
    this.phase = Phase.INTERMISSION;
    this.planeActive = false;
    const results = this.rescued.slice(0, RESCUE_TARGET);
    this.io.emit('roundEnd', {
      round: this.round,
      results,
      nextInMs: INTERMISSION_MS,
      leaderboard: this.leaderboard.top(10),
    });
    clearTimeout(this._nextRoundTimer);
    this._nextRoundTimer = setTimeout(() => this.startNewRound(), INTERMISSION_MS);
  }

  startNewRound() {
    this.round++;
    this.phase = Phase.PLAYING;
    this.level = generateLevel(this.round);
    this.brokenIce.clear();
    this.projectiles = [];
    this.icicles = [];
    this.rescued = [];
    this.fx = [];
    this.planeActive = false;
    this.roundStartMs = Date.now();
    this._spawnEntities();
    this._initHazardTimers();
    for (const p of this.players.values()) {
      const s = this._groundSpawn();
      p.resetForRound(s.x, s.y);
      p.updateFloor();
    }
    this.io.emit('roundStart', {
      round: this.round,
      level: this.serializeLevel(),
      roundStartMs: this.roundStartMs,
      serverTime: Date.now(),
    });
  }

  _spawnEntities() {
    this.monsters = this.level.monsters.map((s) => new Monster(s));
    this.items = this.level.items.map((s) => makeItem(s));
  }

  _groundSpawn() {
    return {
      x: clamp(WORLD_WIDTH / 2 + rnd(-230, 230), 40, WORLD_WIDTH - 40),
      y: floorTopY(0) - PLAYER_H / 2,
    };
  }

  // ----------------------------------------------------------- networking -----
  serializeLevel() {
    return {
      platforms: this.level.platforms,
      floors: this.level.floors.map((f) => ({ i: f.i, y: f.y, hazard: f.hazard })),
      topPadId: this.level.topPadId,
      round: this.round,
    };
  }

  rankingList() {
    const list = [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, floor: p.floor, maxFloor: p.maxFloor,
      rescued: p.rescued, rank: p.rank, hp: Math.max(0, Math.round(p.hp)),
      x: Math.round(p.x), y: Math.round(p.y), look: p.look,
    }));
    list.sort((a, b) => {
      if (a.rescued && b.rescued) return a.rank - b.rank;
      if (a.rescued !== b.rescued) return a.rescued ? -1 : 1;
      if (b.floor !== a.floor) return b.floor - a.floor;
      return a.y - b.y;
    });
    return list;
  }

  broadcastSnapshot(now) {
    const snap = {
      t: now,
      rt: this.roundStartMs,
      round: this.round,
      phase: this.phase,
      players: [...this.players.values()].map((p) => p.serialize()),
      monsters: this.monsters.map((m) => m.serialize()),
      items: this.items.filter((it) => !it.taken).map(serializeItem),
      proj: this.projectiles.map(serializeProjectile),
      ice: this.icicles.map(serializeIcicle),
      plane: this.planeActive ? { x: Math.round(this.planeX), y: PLANE_Y, dir: this.planeDir } : null,
      broken: [...this.brokenIce],
      rescued: this.rescued.map((r) => ({ name: r.name, rank: r.rank, timeMs: r.timeMs })),
      ranking: this.rankingList(),
      fx: this.fx,
    };
    this.io.volatile.emit('snapshot', snap);
    this.fx = [];
  }
}

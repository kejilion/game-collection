// ============================================================================
//  GameRoom 闁?the single authoritative world that every browser connects to.
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
  PLANE_Y_HIGH, PLANE_Y_LOW, PLANE_DIVE_PERIOD, PLANE_DIVE_HOLD, PLANE_SPEED, PLANE_OFFSCREEN, PICKUP_W, PICKUP_H, RESCUE_ZONE_TOP_OFFSET, RESCUE_ZONE_BOTTOM_OFFSET, ItemKind, Phase,
  GRAVITY, TERMINAL_VY, BRICK_CELL_W, DEATH_DURATION,
  CHAT_MAX_LEN, CHAT_THROTTLE_MS, CHAT_DUR_MS,
} from '../../public/shared/constants.js';
import { stepPlayer, buildRects, aabb, cellKeyAt } from '../../public/shared/physics.js';
import { Player } from './Player.js';
import { Monster } from './Monster.js';
import {
  makeItem, serializeItem, makeProjectile, serializeProjectile,
  makeIcicle, serializeIcicle,
} from './entities.js';
import { generateLevel } from './Level.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rnd = (a, b) => a + Math.random() * (b - a);
// 毫秒 -> M:SS.cs，用于播报冠亚季军用时。
function fmtClock(ms) {
  if (ms == null) return '--';
  const t = Math.max(0, ms);
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const cs = Math.floor((t % 1000) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

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
    this.planeY = PLANE_Y_HIGH;
    this.planeDiveT = 0;

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
    p.startMs = Date.now(); // begin per-player timing on entry
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

  // Accept a chat message from a client: throttle per-player and store a
  // short-lived speech bubble on the player so it shows up for everyone.
  setChat(id, text) {
    const p = this.players.get(id);
    if (!p || typeof text !== 'string') return false;
    const t = Date.now();
    if (t < p.chatReadyAt) return false; // throttle: drop messages sent too fast
    p.chatReadyAt = t + CHAT_THROTTLE_MS;
    p.chat = { text: text.slice(0, CHAT_MAX_LEN), until: t + CHAT_DUR_MS };
    return true;
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

    if (ROUND_TIME_LIMIT_MS > 0 && this.phase === Phase.PLAYING && now - this.roundStartMs > ROUND_TIME_LIMIT_MS) {
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
      // chat bubble expiry
      if (p.chat && p.chat.until <= now) p.chat = null;
      // death timer: frozen, no physics/interactions while the death animation plays
      if (p.deadTimer > 0) {
        p.deadTimer = Math.max(0, p.deadTimer - DT);
        if (p.deadTimer <= 0) {
          // respawn on the ground floor
          const sp = this._groundSpawn();
          p.spawn(sp.x, sp.y);
          p.updateFloor();
        }
        continue;
      }

      if (p.rescued) {
        if (p.lifting) p.y -= 70 * DT; // float up into the plane
        continue;
      }

      const frozen = p.stun > 0;
      const ev = stepPlayer(p, p.input, rects, DT, {
        frozen,
        jumpMul: p.jumpBuff > 0 ? JUMP_BUFF_MULT : 1,
      });

      // breakable ice via head-bonk -- ONE small cell per bonk (r.id is `${parentId}:${col}`)
      for (const r of ev.bonk) {
        if (r.type === Tile.ICE && !this.brokenIce.has(r.id)) {
          this.brokenIce.add(r.id);
          this.fx.push({ t: 'ice', id: r.id, x: r.x + r.w / 2, y: r.y + r.h / 2 });
          // monsters / pickups resting on that exact cell lose support next tick.
          this._markFallingAbove(r);
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
      const prevFootY = m.y;
      const nextFootY = prevFootY + Math.min((m.vy||0)+GRAVITY*DT, TERMINAL_VY)*DT;
      const support = m.falling
        ? this._sweptSupport(rects, m.x, prevFootY, nextFootY)
        : this._surfaceSupport(rects, m.x, m.y);
      const fire = m.update(DT, pls, support);
      if (fire) {
        this.projectiles.push(makeProjectile({ kind: 'freeze', owner: null, x: fire.x, y: fire.y, vx: fire.vx, vy: fire.vy, life: 3 }));
      }
    }
    this.monsters = this.monsters.filter((m) => m.alive);

    this._updateProjectiles(rects, now);
    this._updateIcicles(now);
    this._updateItems(rects, now);
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
    if (p.invuln > 0 || p.rescued || !p.alive || p.deadTimer > 0) return;
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
    p.deadTimer = DEATH_DURATION;
    p.vx = 0; p.vy = 0;
    this.fx.push({ t: 'death', x: p.x, y: p.y, id: p.id, name: p.name, cause: cause || '' });
    this.io.emit('playerDied', { id: p.id, name: p.name, cause: cause || '', x: p.x, y: p.y });
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
      if (aabb(p.x - PLAYER_W / 2, p.y - PLAYER_H / 2, PLAYER_W, PLAYER_H, it.x - 28, it.y - 28, 56, 56)) {
        it.taken = true;
        it.respawnAt = now + 20000;
        this.applyItem(p, it.kind);
        this.fx.push({ t: 'pickup', x: it.x, y: it.y, kind: it.kind, id: p.id });
      }
    }
  }

  _updateItems(rects, now) {
    for (const it of this.items) {
      // respawn inactive pickups
      if (it.taken && it.respawnAt && now >= it.respawnAt) {
        it.taken = false;
        it.respawnAt = 0;
        it.vy = 0; it.falling = false;
      }
      if (it.taken) continue;
      // pickup hovers ~34px above a ledge; its base sits at it.y+22.
      const footY = it.y + 22;
      let sup;
      if (it.falling) {
        const nextFootY = footY + Math.min((it.vy||0)+GRAVITY*DT, TERMINAL_VY)*DT;
        sup = this._sweptSupport(rects, it.x, footY, nextFootY);
        it.vy = Math.min((it.vy || 0) + GRAVITY * DT, TERMINAL_VY);
        if (sup) { // landed on a ledge below this tick
          it.falling = false; it.vy = 0; it.y = sup.y - 22;
        } else {
          it.y += it.vy * DT;
        }
      } else {
        sup = this._surfaceSupport(rects, it.x, footY, 30);
        if (!sup) it.falling = true; // cell gone -> start falling
      }
    }
  }

  // ---- support / falling helpers --------------------------------------------
  // Static support: the top surface an entity at (bx, footY) currently rests on,
  // within `tol` px of its feet. Returns {y, minX, maxX} or null (cell gone => fall).
  _surfaceSupport(rects, bx, footY, tol = 6) {
    let best = null;
    for (const r of rects) {
      if (bx < r.x || bx > r.x + r.w) continue;
      const top = r.y;
      if (footY >= top - tol && footY <= top + tol) {
        if (!best || top > best.y) best = { y: top, minX: r.x, maxX: r.x + r.w };
      }
    }
    return best;
  }

  // Swept support while falling this tick: the highest surface whose top the feet
  // pass through going prevFootY -> nextFootY, so a falling monster/item lands on
  // the ledge below instead of tunneling through it.
  _sweptSupport(rects, bx, prevFootY, nextFootY) {
    let best = null;
    const lo = Math.min(prevFootY, nextFootY);
    const hi = Math.max(prevFootY, nextFootY);
    for (const r of rects) {
      if (bx < r.x || bx > r.x + r.w) continue;
      const top = r.y;
      if (top >= lo - 1 && top <= hi + 1) {
        if (!best || top < best.y) best = { y: top, minX: r.x, maxX: r.x + r.w };
      }
    }
    return best;
  }

  // Immediately flag any monsters / items sitting right above a freshly-shattered
  // cell so they start falling this very tick (the per-tick support check below
  // the wall catches the rest, but nudging here avoids a one-frame hover).
  _markFallingAbove(cell) {
    const cx = cell.x + cell.w / 2;
    for (const m of this.monsters) {
      if (!m.alive) continue;
      if (Math.abs(m.x - cx) < cell.w / 2 + 2 && Math.abs(m.y - cell.y) <= 8) {
        m.falling = true;
      }
    }
    for (const it of this.items) {
      if (it.taken) continue;
      if (Math.abs(it.x - cx) < cell.w / 2 + 18 && Math.abs((it.y + 22) - cell.y) <= 10) {
        it.falling = true;
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
        this.damagePlayer(p, MONSTER_TOUCH_DMG, { knockback: (Math.sign(p.x - m.x) || 1) * 320, cause: 'monster' });
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
              aabb(pr.x - 10, pr.y - 10, 20, 20, r.x, r.y, r.w, r.h)) { dead = true; break; }
        }
      }
      if (!dead && pr.kind === 'fire') {
        for (const m of this.monsters) {
          if (!m.alive) continue;
          const a = m.aabb();
          if (aabb(pr.x - 11, pr.y - 11, 22, 22, a.x, a.y, a.w, a.h)) { this.damageMonster(m, FIREBALL_DMG); dead = true; break; }
        }
        if (!dead) {
          for (const o of this.players.values()) {
            if (o.id === pr.owner || o.rescued || o.invuln > 0) continue;
            if (aabb(pr.x - 11, pr.y - 11, 22, 22, o.x - PLAYER_W / 2, o.y - PLAYER_H / 2, PLAYER_W, PLAYER_H)) {
              this.damagePlayer(o, FIREBALL_DMG, { knockback: Math.sign(pr.vx) * 220, cause: 'fire' });
              dead = true; break;
            }
          }
        }
      } else if (!dead && pr.kind === 'freeze') {
        for (const o of this.players.values()) {
          if (o.rescued || o.invuln > 0) continue;
          if (aabb(pr.x - 11, pr.y - 11, 22, 22, o.x - PLAYER_W / 2, o.y - PLAYER_H / 2, PLAYER_W, PLAYER_H)) {
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
        const ic = makeIcicle(x, floorTopY(f.i) - FLOOR_SPACING + 40);
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
        if (aabb(c.x - 11, c.y - 6, 22, 32, p.x - PLAYER_W / 2, p.y - PLAYER_H / 2, PLAYER_W, PLAYER_H)) {
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
    this.planeSide = 1; // first approach sweeps in from the right
    this.planeDiveT = 0;
    this.planeY = PLANE_Y_HIGH;
    this.planeX = this.planeCenter + this.planeSide * PLANE_OFFSCREEN; // start off-screen
    this.planeDir = -this.planeSide;
    this.fx.push({ t: 'plane' });
    this.io.emit('planeIncoming', {});
  }

  _updatePlane() {
    // One cycle = approach from off-screen -> dive -> hold (offer rope) -> rise -> depart off-screen.
    // Most of the cycle the plane is loitering OUTSIDE the visible band; it only
    // sweeps in over the top pad to drop the rope during the dive window.
    this.planeDiveT += DT / PLANE_DIVE_PERIOD;
    if (this.planeDiveT > 1) {
      this.planeDiveT -= 1;
      this.planeSide = -(this.planeSide || 1); // alternate the side it approaches from
    }
    const t = this.planeDiveT;
    const cx = this.planeCenter;
    const off = PLANE_OFFSCREEN;
    const side = this.planeSide || 1;
    const holdFrac = PLANE_DIVE_HOLD / PLANE_DIVE_PERIOD;
    const approachEnd = 0.20;
    const descendEnd = approachEnd + 0.16;
    const holdEnd = descendEnd + holdFrac;
    const ascendEnd = holdEnd + 0.16;
    // defaults: loitering off-screen at cruise altitude
    let fx = cx + side * off; // far off-screen
    let fy = PLANE_Y_HIGH;
    let dir = -side;
    const ease = (u) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(u, 0, 1));
    if (t < approachEnd) {
      // fly in from off-screen toward the pad (high)
      const u = t / approachEnd;
      fx = (cx + side * off) + ((cx) - (cx + side * off)) * ease(u);
      fy = PLANE_Y_HIGH;
      dir = -side;
    } else if (t < descendEnd) {
      // hovering over the pad, diving down to LOW
      const u = (t - approachEnd) / (descendEnd - approachEnd);
      fx = cx;
      fy = PLANE_Y_HIGH + (PLANE_Y_LOW - PLANE_Y_HIGH) * ease(u);
      dir = 1;
    } else if (t < holdEnd) {
      // holding low, gentle drift across the pad so the player times the hop
      const u = (t - descendEnd) / (holdFrac);
      fx = cx + Math.sin(u * Math.PI * 2) * 120;
      fy = PLANE_Y_LOW;
      dir = this.planeX < fx ? 1 : -1;
    } else if (t < ascendEnd) {
      // rising back up over the pad
      const u = (t - holdEnd) / (ascendEnd - holdEnd);
      fx = cx;
      fy = PLANE_Y_LOW + (PLANE_Y_HIGH - PLANE_Y_LOW) * ease(u);
      dir = side;
    } else {
      // depart: fly out to off-screen on the opposite side and loiter
      const u = (t - ascendEnd) / (1 - ascendEnd);
      const target = cx - side * off;
      fx = cx + (target - cx) * ease(Math.min(1, u * 1.6));
      fy = PLANE_Y_HIGH;
      dir = -side;
    }
    this.planeX = fx;
    this.planeY = fy;
    this.planeDir = dir;
  }

  _checkRescue(p, now) {
    if (p.floor < FLOOR_COUNT - 1 || p.onGround) return; // must hop into it at the top
    const zone = { x: this.planeX - PICKUP_W / 2, y: this.planeY + RESCUE_ZONE_TOP_OFFSET, w: PICKUP_W, h: RESCUE_ZONE_BOTTOM_OFFSET - RESCUE_ZONE_TOP_OFFSET };
    if (aabb(p.x - PLAYER_W / 2, p.y - PLAYER_H / 2, PLAYER_W, PLAYER_H, zone.x, zone.y, zone.w, zone.h)) {
      this.rescuePlayer(p, now);
    }
  }

  rescuePlayer(p, now) {
    p.rescued = true;
    p.lifting = true;
    p.vx = 0; p.vy = 0;
    const timeMs = now - (p.startMs || this.roundStartMs); // per-player elapsed time
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
    // 第一时间广播本届冠亚季军一句话，让所有玩家都看到结果。
    this.io.emit('system', { kind: 'roundEnd', msg: this._roundRecapMsg(results) });
    this.io.emit('roundEnd', {
      round: this.round,
      results,
      nextInMs: INTERMISSION_MS,
      leaderboard: this.leaderboard.top(10),
    });
    // 权威倒数：剩余5秒开始清晰交代冠亚季军并 5-4-3-2-1 提示。
    this._scheduleCountdown(results);
    clearTimeout(this._nextRoundTimer);
    this._nextRoundTimer = setTimeout(() => this.startNewRound(), INTERMISSION_MS);
  }

  // 本届冠亚季军一句话播报；无人逃生时给出提示。
  _roundRecapMsg(results) {
    const place = ['冠军', '亚军', '季军'];
    if (!results || results.length === 0) return '🏆 本局无人逃生成功！';
    const parts = results.map((r, i) => `${place[i] || '第' + (i + 1) + '名'}：${r.name}（${fmtClock(r.timeMs)}）`);
    return '🏆 本届 ' + parts.join(' ｜ ');
  }

  // 在 INTERMISSION_MS 窗口的最后5秒内，每秒广播一条全员提示，
  // 既保证所有客户端节奏一致，也作为前端大字倒数的权威触发源。
  _scheduleCountdown(results) {
    clearTimeout(this._cdTimer);
    const recap = this._roundRecapMsg(results);
    const sleep = (ms) => new Promise((res) => { this._cdTimer = setTimeout(res, ms); });
    const run = async () => {
      const startAt = Math.max(0, INTERMISSION_MS - 5000);
      if (startAt > 0) await sleep(startAt);
      this.io.emit('system', { kind: 'countdown', seq: 5, msg: `${recap}\n⏳ 5 秒后开新一局！` });
      for (let n = 4; n >= 1; n--) {
        await sleep(1000);
        this.io.emit('system', { kind: 'countdown', seq: n, msg: `⏳ ${n}` });
      }
    };
    run();
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
    // 新一局开始时清晰告诉所有玩家。
    this.io.emit('system', { kind: 'roundStart', msg: `🚀 第${this.round} 局开始！冲！` });
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
      x: clamp(WORLD_WIDTH / 2 + rnd(-380, 380), 64, WORLD_WIDTH - 64),
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
      plane: this.planeActive ? { x: Math.round(this.planeX), y: Math.round(this.planeY), dir: this.planeDir } : null,
      broken: [...this.brokenIce],
      rescued: this.rescued.map((r) => ({ name: r.name, rank: r.rank, timeMs: r.timeMs })),
      ranking: this.rankingList(),
      fx: this.fx,
    };
    this.io.volatile.emit('snapshot', snap);
    this.fx = [];
  }
}

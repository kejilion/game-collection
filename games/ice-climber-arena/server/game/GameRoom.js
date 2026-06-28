// ============================================================================
//  GameRoom — the single authoritative world that every browser connects to.
//  Runs a fixed 60 Hz simulation, resolves all entity interactions, manages the
//  round / rescue lifecycle, and broadcasts 30 Hz snapshots to all clients.
// ============================================================================
import {
  TICK_RATE, DT, SNAPSHOT_RATE, WORLD_WIDTH, WORLD_HEIGHT, FLOOR_COUNT,
  FLOOR_SPACING, floorTopY, floorAtY, floorBandHalfWidth, Tile, PLAYER_W, PLAYER_H,
  PLAYER_MAX_HP, JUMP_BUFF_MULT, FALL_SAFE_FLOORS, FALL_DMG_PER_FLOOR,
  ATTACK_COOLDOWN, ATTACK_ANIM,
  MONSTER_TOUCH_DMG, MONSTER_STUN, MonsterKind, BOSS_TYPES,
  BUFF_JUMP_TIME, BUFF_FIRE_TIME, BUFF_HASTE_TIME, SPEED_BUFF_MULT, BUFF_SHIELD_TIME, HEAL_AMOUNT,
  FIREBALL_SPEED, FIREBALL_DMG, FIREBALL_COOLDOWN, ICICLE_DMG, ICICLE_GRAVITY,
  ICICLE_INTERVAL, RESCUE_TARGET, INTERMISSION_MS, ROUND_TIME_LIMIT_MS, RESCUE_COUNTDOWN_MS,
  PLANE_Y_LOW, PLANE_SPEED, PLANE_PATROL_RANGE, PICKUP_W, PICKUP_H, RESCUE_ZONE_TOP_OFFSET, RESCUE_ZONE_BOTTOM_OFFSET, ItemKind, Phase,
  GRAVITY, TERMINAL_VY, BRICK_CELL_W, DEATH_DURATION,
  CHAT_MAX_LEN, CHAT_THROTTLE_MS, CHAT_DUR_MS, wrapX, wrapDX,
} from '../../public/shared/constants.js';
import { stepPlayer, buildRects, aabb, aabbWrapX, cellKeyAt } from '../../public/shared/physics.js';
import { Player } from './Player.js';
import { Monster } from './Monster.js';
import {
  makeItem, serializeItem, makeProjectile, serializeProjectile,
  makeIcicle, serializeIcicle,
} from './entities.js';
import { generateLevel } from './Level.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
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
    this.rescueDeadline = 0; // >0 once the first player is rescued: absolute ms the plane departs

    this.brokenIce = new Set();
    this.projectiles = [];
    this.icicles = [];
    this.rescued = [];
    this.fx = [];

    this.planeActive = false;
    this.planeX = WORLD_WIDTH / 2;
    this.planeDir = 1;
    this.planeCenter = WORLD_WIDTH / 2;
    this.planeY = PLANE_Y_LOW;

    this.snapAccum = 0;
    this.hazardNext = {};

    this.level = generateLevel(this.round);
    this._spawnEntities();
    this._initHazardTimers();
    this._announceBoss();
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

    // Final-departure countdown: once the first player escapes, the plane leaves
    // when this timer runs out even if fewer than RESCUE_TARGET made it aboard,
    // so the early finishers never wait indefinitely for a slow 3rd place.
    if (this.phase === Phase.PLAYING && this.rescueDeadline && now >= this.rescueDeadline) {
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
      p.hasteBuff = Math.max(0, p.hasteBuff - DT);
      p.shield = Math.max(0, p.shield - DT);
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
        speedMul: p.hasteBuff > 0 ? SPEED_BUFF_MULT : 1,
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

    // monsters (small mobs + the round's boss)
    const pls = [...this.players.values()];
    const spawned = []; // adds summoned this tick, added after the loop
    for (const m of this.monsters) {
      let support = null;
      if (!m.fly && !m.anchored) { // grounded mobs can fall through smashed ice
        const prevFootY = m.y;
        const nextFootY = prevFootY + Math.min((m.vy || 0) + GRAVITY * DT, TERMINAL_VY) * DT;
        support = m.falling
          ? this._sweptSupport(rects, m.x, prevFootY, nextFootY)
          : this._surfaceSupport(rects, m.x, m.y);
      }
      const act = m.update(DT, pls, support);
      if (act) {
        if (act.bolts) {
          for (const b of act.bolts) {
            this.projectiles.push(makeProjectile({
              kind: b.kind || 'freeze', owner: null,
              x: b.x, y: b.y, vx: b.vx, vy: b.vy, life: b.life || 3,
              dmg: b.dmg, stun: b.stun,
            }));
          }
        }
        if (act.summon) this._summonAdds(m, act.summon, spawned);
      }
    }
    if (spawned.length) this.monsters.push(...spawned);
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
    // 只有持有道具（火球 buff）时才能攻击；无道具则普通攻击不生效。
    if (p.fireBuff <= 0 || p.fireCd > 0) return;

    p.attackCd = ATTACK_COOLDOWN;
    p.attackAnim = ATTACK_ANIM;
    p.fireCd = FIREBALL_COOLDOWN;
    this.projectiles.push(makeProjectile({
      kind: 'fire', owner: p.id,
      x: p.x + p.facing * 16, y: p.y - PLAYER_H / 2,
      vx: p.facing * FIREBALL_SPEED, vy: -40, life: 1.7,
    }));
    this.fx.push({ t: 'shoot', x: p.x + p.facing * 16, y: p.y - PLAYER_H / 2, f: p.facing });
  }

  damagePlayer(p, amt, opts = {}) {
    if (p.invuln > 0 || p.shield > 0 || p.rescued || !p.alive || p.deadTimer > 0) return;
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
    // 死亡即清空所有限时 buff（火球/跳跃/加速/免伤）——重生从零开始
    p.jumpBuff = 0; p.fireBuff = 0; p.hasteBuff = 0; p.shield = 0;
    this.fx.push({ t: 'death', x: p.x, y: p.y, id: p.id, name: p.name, cause: cause || '' });
    this.io.emit('playerDied', { id: p.id, name: p.name, cause: cause || '', x: p.x, y: p.y });
  }

  damageMonster(m, amt) {
    m.hp -= amt;
    this.fx.push({ t: 'mhit', x: m.x, y: m.y - 16 });
    if (m.hp <= 0) {
      m.alive = false;
      this.fx.push({ t: 'mdeath', x: m.x, y: m.y - 16 });
      // 死亡散落状态道具：小怪 1 个，BOSS 1~3 个
      this._dropStatusItems(m, m.boss ? 1 + Math.floor(Math.random() * 3) : 1);
      if (m.boss) {
        // a felled boss makes a scene + announces to everyone
        for (let i = 0; i < 4; i++) this.fx.push({ t: 'mdeath', x: m.x + rnd(-34, 34), y: m.y - rnd(10, 70) });
        this.fx.push({ t: 'death', x: m.x, y: m.y, id: m.id, name: m.name, cause: 'boss' });
        this.io.emit('system', { kind: 'boss', msg: `🎉 BOSS【${m.name}】被击败了！` });
      }
    }
  }

  // ------------------------------------------------------------- pickups ------
  applyItem(p, kind) {
    if (kind === ItemKind.FIRE) p.fireBuff = BUFF_FIRE_TIME;
    else if (kind === ItemKind.HEAL) p.hp = Math.min(PLAYER_MAX_HP, p.hp + HEAL_AMOUNT);
    else if (kind === ItemKind.JUMP) p.jumpBuff = BUFF_JUMP_TIME;
    else if (kind === ItemKind.HASTE) p.hasteBuff = BUFF_HASTE_TIME;
    else if (kind === ItemKind.SHIELD) p.shield = BUFF_SHIELD_TIME;
  }

  _checkItemPickup(p, now) {
    for (const it of this.items) {
      if (it.taken) continue;
      if (aabbWrapX(p.x - PLAYER_W / 2, p.y - PLAYER_H / 2, PLAYER_W, PLAYER_H, it.x - 28, it.y - 28, 56, 56)) {
        it.taken = true;
        it.respawnAt = it.oneShot ? 0 : now + 20000; // 怪物掉落一次性，不复活
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
    // 一次性怪物掉落被拾取后清除，避免堆积 / 复活
    if (this.items.some((it) => it.taken && it.oneShot)) {
      this.items = this.items.filter((it) => !(it.taken && it.oneShot));
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
    const kinds = [ItemKind.FIRE, ItemKind.HEAL, ItemKind.JUMP, ItemKind.HASTE, ItemKind.SHIELD];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    this.items.push(makeItem({ kind, x, y, floor }));
  }

  // 怪物死亡散落的“状态道具”（限时 buff）。回血是瞬发的、不算状态道具，故不在此池中。
  // 落点由 _updateItems 的下落逻辑接管，最终停在怪物脚下/下方的平台上。
  _dropStatusItems(m, n) {
    const pool = [ItemKind.FIRE, ItemKind.JUMP, ItemKind.HASTE, ItemKind.SHIELD];
    const floor = floorAtY(m.y);
    for (let i = 0; i < n; i++) {
      const kind = pool[Math.floor(Math.random() * pool.length)];
      const dx = n === 1 ? 0 : rnd(-46, 46); // 多个时左右散开，单个原地迸出
      this.items.push(makeItem({
        kind, x: wrapX(m.x + dx), y: m.y - m.h * 0.5, floor, oneShot: true,
      }));
    }
  }

  // ------------------------------------------------------------ monsters ------
  _checkMonsterContact(p) {
    if (p.invuln > 0 || p.shield > 0) return; // 免伤护盾：无敌泡也免疫接触伤害与冰冻
    const pb = { x: p.x - PLAYER_W / 2, y: p.y - PLAYER_H / 2, w: PLAYER_W, h: PLAYER_H };
    for (const m of this.monsters) {
      if (!m.alive) continue;
      const a = m.aabb();
      if (aabbWrapX(pb.x, pb.y, pb.w, pb.h, a.x, a.y, a.w, a.h)) {
        const dmg = m.touchDmg != null ? m.touchDmg : MONSTER_TOUCH_DMG;
        const kb = (Math.sign(wrapDX(m.x, p.x)) || 1) * (m.knockback != null ? m.knockback : 320);
        this.damagePlayer(p, dmg, { knockback: kb, cause: 'monster' });
        p.stun = Math.max(p.stun, m.touchStun != null ? m.touchStun : MONSTER_STUN);
        break;
      }
    }
  }

  // ---------------------------------------------------------- projectiles -----
  _updateProjectiles(rects, now) {
    const keep = [];
    for (const pr of this.projectiles) {
      pr.life -= DT;
      pr.x = wrapX(pr.x + pr.vx * DT); // bolts loop around the seam like everything else
      pr.y += pr.vy * DT;
      if (pr.kind === 'fire') pr.vy += 240 * DT; // slight arc

      let dead = pr.life <= 0 || pr.y > WORLD_HEIGHT + 50;

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
          if (aabbWrapX(pr.x - 11, pr.y - 11, 22, 22, a.x, a.y, a.w, a.h)) { this.damageMonster(m, FIREBALL_DMG); dead = true; break; }
        }
        if (!dead) {
          for (const o of this.players.values()) {
            if (o.id === pr.owner || o.rescued || o.invuln > 0 || o.shield > 0) continue;
            if (aabbWrapX(pr.x - 11, pr.y - 11, 22, 22, o.x - PLAYER_W / 2, o.y - PLAYER_H / 2, PLAYER_W, PLAYER_H)) {
              this.damagePlayer(o, FIREBALL_DMG, { knockback: Math.sign(pr.vx) * 220, cause: 'fire' });
              dead = true; break;
            }
          }
        }
      } else if (!dead && pr.kind === 'freeze') {
        for (const o of this.players.values()) {
          if (o.rescued || o.invuln > 0 || o.shield > 0) continue;
          if (aabbWrapX(pr.x - 11, pr.y - 11, 22, 22, o.x - PLAYER_W / 2, o.y - PLAYER_H / 2, PLAYER_W, PLAYER_H)) {
            this.damagePlayer(o, pr.dmg != null ? pr.dmg : 6, { cause: 'freeze' });
            o.stun = Math.max(o.stun, pr.stun != null ? pr.stun : MONSTER_STUN);
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
        if (p.rescued || p.invuln > 0 || p.shield > 0) continue;
        if (aabbWrapX(c.x - 11, c.y - 6, 22, 32, p.x - PLAYER_W / 2, p.y - PLAYER_H / 2, PLAYER_W, PLAYER_H)) {
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
    this.planeSide = 1; // patrol direction sign (kept for snapshot compat)
    this.planeDiveT = 0;
    this.planeY = PLANE_Y_LOW; // patrol altitude from the very start (no dive-in)
    this.planeX = this.planeCenter - PLANE_PATROL_RANGE; // start at the left end of the sweep
    this.planeDir = 1; // sweep rightward first
    this.fx.push({ t: 'plane' });
    this.io.emit('planeIncoming', {});
  }

  _updatePlane() {
    // The plane flies its OWN path: a steady horizontal sweep back and forth across
    // the sky at patrol altitude. It never dives toward the pad or lingers to pick
    // anyone up -- the climber must time the hop so their jump apex meets the rope
    // as the plane passes overhead.
    const cx = this.planeCenter;
    const range = PLANE_PATROL_RANGE;
    // advance a smooth triangular back-and-forth phase so the plane keeps a
    // constant speed (no slowing / no hovering at the ends except the instant turn).
    this.planeDiveT += DT / ((2 * 2 * range) / PLANE_SPEED); // period = total round-trip distance / speed
    if (this.planeDiveT >= 1) this.planeDiveT -= 1;
    const t = this.planeDiveT;
    // triangle wave in [-1, 1]: ramps 0->1->0->-1->0 across the phase
    const tri = t < 0.5 ? (t * 4 - 1) : (3 - t * 4);
    const fx = cx + tri * range;
    const fy = PLANE_Y_LOW; // constant patrol altitude; rope-end stays near jump apex
    // direction tracks the sweep so the nose always points along travel
    const dir = tri >= 0 ? 1 : -1;
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
    if (this.rescued.length >= this._rescueTarget()) { this.endRound(); return; }
    // First escapee starts the plane's final-departure countdown; the round then
    // ends on whichever comes first -- target reached or the timer expiring.
    if (RESCUE_COUNTDOWN_MS > 0 && !this.rescueDeadline) {
      this.rescueDeadline = now + RESCUE_COUNTDOWN_MS;
      const secs = Math.round(RESCUE_COUNTDOWN_MS / 1000);
      this.io.emit('system', { kind: 'lastcall', msg: `✈️ ${p.name} 首位逃生！救援机将在 ${secs} 秒后撤离，冲顶！` });
    }
  }

  _rescueTarget() {
    return Math.min(RESCUE_TARGET, Math.max(1, this.players.size));
  }

  // --------------------------------------------------------------- rounds -----
  endRound() {
    if (this.phase !== Phase.PLAYING) return;
    this.phase = Phase.INTERMISSION;
    this.planeActive = false;
    this.rescueDeadline = 0;
    const results = this.rescued.slice(0, RESCUE_TARGET);
    // 第一时间广播本届冠亚季军一句话，让所有玩家都看到结果。
    this.io.emit('system', { kind: 'roundEnd', msg: this._roundRecapMsg(results) });
    this.io.emit('roundEnd', {
      round: this.round,
      results,
      nextInMs: INTERMISSION_MS,
      leaderboard: this.leaderboard.top(10),
    });
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
    this.rescueDeadline = 0;
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
    this._announceBoss();
  }

  _spawnEntities() {
    this.monsters = this.level.monsters.map((s) => new Monster(s));
    if (this.level.boss) this.monsters.push(new Monster(this.level.boss));
    this.items = this.level.items.map((s) => makeItem(s));
  }

  // Broadcast the round's boss so every climber is warned where it lurks.
  _announceBoss() {
    const b = this.level.boss;
    if (!b) return;
    const def = BOSS_TYPES[b.kind];
    const floorNum = (b.floor ?? 0) + 1;
    this.io.emit('system', { kind: 'boss', msg: `⚠️ 本局BOSS【${def ? def.name : '强敌'}】盘踞在第 ${floorNum} 层，小心冲顶！` });
  }

  // Spawn a boss's summoned adds (capped), collected into `sink` to add after
  // the monster loop so they don't act on the same tick they appear.
  _summonAdds(boss, n, sink) {
    const CAP = 3;
    const aliveAdds = this.monsters.filter((m) => m.summonedBy === boss.id && m.alive).length
      + sink.filter((m) => m.summonedBy === boss.id).length;
    const room = Math.min(n, CAP - aliveAdds);
    for (let k = 0; k < room; k++) {
      const x = clamp(boss.x + rnd(-140, 140), boss.minX, boss.maxX);
      const kind = pick([MonsterKind.WALKER, MonsterKind.HOPPER, MonsterKind.DASHER]);
      sink.push(new Monster({ kind, minX: boss.minX, maxX: boss.maxX, wrap: boss.wrap, x, y: boss.homeY, summonedBy: boss.id }));
      this.fx.push({ t: 'mhit', x, y: boss.homeY - 16 });
    }
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
    // Lean ranking rows: only what the HUD list + mini-tower need. name/look are
    // already carried once per player in `players[]`, so we send just the outfit
    // colour here instead of duplicating the whole look object 30×/sec.
    const list = [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, floor: p.floor,
      rescued: p.rescued, rank: p.rank,
      x: Math.round(p.x), y: Math.round(p.y), color: p.look.outfit,
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
      rescueDeadline: this.rescueDeadline || null, // absolute server ms the plane departs, or null
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

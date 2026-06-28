// ============================================================================
//  Monster AI — six small "trash mob" kinds and six bosses, all driven by one
//  data-table-fed update loop.  Stats & behavior come from MONSTER_TYPES /
//  BOSS_TYPES in shared/constants.js so tuning is a one-line change.
//
//  Behaviors:
//   • melee   — chase and body-slam (walker / brute / boss giant)
//   • aimed   — hold ground, lob a single aimed freeze bolt (caster)
//   • spread  — fan of three bolts (spitter)
//   • volley  — rapid fan bolts (boss blizzard)
//   • radial  — burst a full ring of shards (boss golem)
//   • dash    — creep, then commit to a fast lunge (dasher)
//   • charge  — relentless cross-floor charges (boss mammoth)
//   • hop     — bound along in arcs, reusing the fall/land system (hopper)
//   • fly     — hover above the ledge and rain bolts (boss wyvern)
//   • summon  — spawn small adds while pressuring with bolts (boss queen)
//
//  Contact resolution, projectile spawning and add-summoning happen in GameRoom
//  (update() returns the bolts to fire and how many adds to summon this tick).
// ============================================================================
import {
  MonsterKind, MONSTER_TYPES, BOSS_TYPES, GRAVITY, TERMINAL_VY, wrapX, wrapDX,
} from '../../public/shared/constants.js';

export const MONSTER_BASE = 48; // hit-box of a 1.0-scale small monster
// legacy aliases (some older imports referenced these)
export const MONSTER_W = MONSTER_BASE;
export const MONSTER_H = MONSTER_BASE;

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

let nextId = 1;

export class Monster {
  constructor(spec) {
    this.id = `m${nextId++}`;
    this.boss = !!spec.boss;
    this.kind = spec.kind;
    const def = (this.boss ? BOSS_TYPES[spec.kind] : MONSTER_TYPES[spec.kind])
      || MONSTER_TYPES[MonsterKind.WALKER];
    this.def = def;
    this.name = def.name;
    this.behavior = def.behavior;
    this.fly = !!def.fly;
    // bosses hold their floor (never tumble down the tower when ice is smashed);
    // flying bosses manage their own altitude instead.
    this.anchored = this.boss && !this.fly;

    this.hpMax = def.hp;
    this.hp = def.hp;
    this.speed = def.speed;
    this.aggro = def.aggro;
    this.detect = def.detect;
    this.touchDmg = def.touchDmg;
    this.touchStun = def.stun;
    this.knockback = def.knockback;
    this.sc = def.scale;
    this.w = MONSTER_BASE * def.scale;
    this.h = MONSTER_BASE * def.scale;

    this.minX = spec.minX;
    this.maxX = spec.maxX;
    // full-width roamers (band fills the world) loop across the seam instead of
    // bouncing at minX/maxX, and chase/aim the short way around — see _dx().
    this.wrap = !!spec.wrap;
    this.y = spec.y;       // feet on the ledge surface
    this.homeY = spec.y;   // the ledge it patrols / hovers over
    this.x = spec.x != null ? spec.x : (spec.minX + spec.maxX) / 2;
    this.dir = Math.random() < 0.5 ? -1 : 1;
    this.facing = this.dir;
    this.alive = true;
    this.summonedBy = spec.summonedBy || null; // adds spawned by a boss

    // vertical state (small monsters fall through broken ice / hop)
    this.vy = 0;
    this.falling = false;

    // behavior timers
    this.castCd = def.castCd || 1.6;
    this.dashCd = rnd(0.6, 1.4);
    this.dashT = 0;
    this.hopCd = rnd(0.3, 1.2);
    this.summonCd = def.summonCd || 5;
    this.flyPhase = Math.random() * Math.PI * 2;
    this.st = ''; // transient anim hint sent to the client: ''|'dash'|'hop'|'cast'
  }

  /**
   * Advance one tick.
   * @param {{y:number,minX:number,maxX:number}|null} support surface under feet
   *   (null while airborne / for fly & anchored bosses, which manage their own y)
   * @returns {null | {bolts?:Array, summon?:number}} actions for GameRoom to apply
   */
  update(dt, players, support) {
    if (!this.alive) return null;
    this.st = '';

    this._vertical(dt, support);

    // tick behavior timers
    this.castCd -= dt; this.dashCd -= dt; this.hopCd -= dt; this.summonCd -= dt;
    if (this.dashT > 0) this.dashT -= dt;

    const target = this._acquire(players);

    let bolts = null;
    let summon = 0;
    switch (this.behavior) {
      case 'aimed':  this._idleDrift(dt, target); bolts = this._fire(target, 1, 0, 360); break;
      case 'spread': this._idleDrift(dt, target); bolts = this._fire(target, 3, 0.5, 320); break;
      case 'volley': this._idleDrift(dt, target); bolts = this._fire(target, 3, 0.3, 380); break;
      case 'radial': this._chase(dt, target);     bolts = this._radial(target); break;
      case 'fly':    this._drift(dt, target);     bolts = this._fire(target, 1, 0, 420); break;
      case 'summon': this._chase(dt, target);     bolts = this._fire(target, 1, 0, 360); summon = this._summonTick(target); break;
      case 'dash':
      case 'charge': this._dash(dt, target); break;
      case 'hop':    this._hop(dt, target); break;
      case 'melee':
      default:       this._chase(dt, target); break;
    }

    // confine to the patrol band (fly bosses bounce inside _drift)
    if (!this.fly) {
      if (this.wrap) {
        this.x = wrapX(this.x); // loop across the seam — never bounce
      } else {
        if (this.x <= this.minX) { this.x = this.minX; this.dir = 1; this.dashT = 0; }
        if (this.x >= this.maxX) { this.x = this.maxX; this.dir = -1; this.dashT = 0; }
      }
    }
    this.facing = this.dir;

    const out = {};
    if (bolts && bolts.length) out.bolts = bolts;
    if (summon) out.summon = summon;
    return out.bolts || out.summon ? out : null;
  }

  // ---- vertical integration --------------------------------------------------
  _vertical(dt, support) {
    if (this.fly) {
      this.flyPhase += dt;
      this.y = this.homeY - 130 + Math.sin(this.flyPhase * 1.6) * 16;
      return;
    }
    if (this.anchored) { this.y = this.homeY; return; }

    if (this.falling) {
      this.vy = Math.min(this.vy + GRAVITY * dt, TERMINAL_VY);
      const nextY = this.y + this.vy * dt;
      // land only while descending onto a surface the feet pass through
      if (support && this.vy >= 0 && nextY >= support.y - 0.5) {
        this.y = support.y;
        this.vy = 0;
        this.falling = false;
        if (support.y > this.homeY + 4) {
          // fell to a genuinely lower ledge -> adopt it and confine the patrol
          // (a tumbled mob stops looping the world and patrols where it landed)
          this.homeY = support.y;
          this.wrap = false;
          this.minX = Math.max(this.minX, support.minX);
          this.maxX = Math.min(this.maxX, support.maxX);
          if (this.minX > this.maxX) this.minX = this.maxX = (support.minX + support.maxX) / 2;
          this.x = clamp(this.x, this.minX, this.maxX);
        }
      } else {
        this.y = nextY;
      }
    } else if (!support) {
      this.falling = true; // the cell beneath was smashed -> start falling
      this.vy = 0;
    } else {
      this.y = support.y;  // glued to a stable ledge
    }
  }

  // ---- target acquisition ----------------------------------------------------
  _acquire(players) {
    let target = null;
    let best = this.detect;
    const vCap = this.boss ? 260 : 200; // only hunt within ~1 floor vertically
    for (const p of players) {
      if (!p.alive || p.rescued || p.invuln > 0) continue;
      if (Math.abs(p.y - this.y) > vCap) continue;
      const d = Math.hypot(this._dx(p.x), (p.y - this.y) * 0.6);
      if (d < best) { best = d; target = p; }
    }
    return target;
  }

  // ---- locomotion primitives -------------------------------------------------
  // Signed horizontal distance to a world-x. Full-width roamers measure it the
  // short way around the wrap seam, so they chase & aim across the loop edge
  // instead of the long way back through the whole floor.
  _dx(tx) { return this.wrap ? wrapDX(this.x, tx) : tx - this.x; }

  _chase(dt, target) {
    if (target) this.dir = Math.sign(this._dx(target.x)) || this.dir;
    const sp = target ? this.aggro : this.speed;
    this.x += this.dir * sp * dt;
  }

  _idleDrift(dt, target) {
    if (target) {
      // keep an ideal firing gap: back off when crowded, shuffle in when far,
      // but never hold perfectly still so a ranged mob does not read as a dead prop
      this.dir = Math.sign(this._dx(target.x)) || this.dir;
      const gap = Math.abs(this._dx(target.x));
      const ideal = this.detect * 0.6;
      if (gap < ideal - 30) this.x -= this.dir * this.speed * 0.8 * dt;
      else if (gap > ideal + 40) this.x += this.dir * this.speed * 0.7 * dt;
    } else {
      this.x += this.dir * this.speed * 0.6 * dt;
    }
  }

  _drift(dt, target) {
    // flyer: glide horizontally, easing toward the target's x
    if (target) {
      const want = clamp(target.x, this.minX, this.maxX);
      this.dir = Math.sign(want - this.x) || this.dir;
      this.x += this.dir * this.speed * dt;
      if (Math.abs(want - this.x) < 6) this.x = want;
    } else {
      this.x += this.dir * this.speed * 0.5 * dt;
    }
    if (this.x <= this.minX) { this.x = this.minX; this.dir = 1; }
    if (this.x >= this.maxX) { this.x = this.maxX; this.dir = -1; }
  }

  _dash(dt, target) {
    if (this.dashT > 0) { this.st = 'dash'; this.x += this.dir * (this.def.dashSpeed || 480) * dt; return; }
    if (target) this.dir = Math.sign(this._dx(target.x)) || this.dir;
    const aligned = this.behavior === 'charge' || (target && Math.abs(target.y - this.y) < 80);
    const wants = this.behavior === 'charge' || target;
    if (this.dashCd <= 0 && aligned && wants) {
      this.dashCd = this.def.dashCd || 2.0;
      this.dashT = this.def.dashTime || 0.45;
      this.st = 'dash';
      return;
    }
    const sp = target ? this.aggro : this.speed;
    this.x += this.dir * sp * dt;
  }

  _hop(dt, target) {
    if (target) this.dir = Math.sign(this._dx(target.x)) || this.dir;
    const sp = target ? this.aggro : this.speed;
    this.x += this.dir * sp * dt; // keeps travelling through the air too
    if (!this.falling && this.hopCd <= 0) {
      // reuse the fall/land system as a hop: launch up, gravity brings it home
      this.falling = true;
      this.vy = -(this.def.hopVel || 360);
      this.hopCd = this.def.hopCd || 0.9;
    }
    if (this.falling) this.st = 'hop';
  }

  // ---- ranged primitives -----------------------------------------------------
  /** Fan of `count` bolts aimed at target, spread radians apart. */
  _fire(target, count, spread, speed) {
    if (!target) return null;
    this.dir = Math.sign(this._dx(target.x)) || this.dir;
    if (this.castCd > 0) return null;
    this.castCd = this.def.castCd || 2.3;
    this.st = 'cast';
    const ox = this.x;
    const oy = this.y - this.h * 0.5;
    // aim at the nearest image of the target — across the seam if that's closer;
    // the bolt itself wraps in GameRoom, so a short-way shot lands correctly.
    const base = Math.atan2((target.y - 20) - oy, this._dx(target.x));
    const dmg = this.boss ? 12 : 6;
    const bolts = [];
    for (let i = 0; i < count; i++) {
      const a = base + (count > 1 ? (i - (count - 1) / 2) * spread : 0);
      bolts.push({ x: ox, y: oy, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, dmg, stun: this.touchStun });
    }
    return bolts;
  }

  /** Full ring of shards in every direction. */
  _radial(target) {
    if (!target || this.castCd > 0) return null;
    this.castCd = this.def.castCd || 3.0;
    this.st = 'cast';
    const ox = this.x;
    const oy = this.y - this.h * 0.5;
    const n = 12;
    const speed = 230;
    const bolts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      bolts.push({ x: ox, y: oy, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, dmg: 9, stun: this.touchStun });
    }
    return bolts;
  }

  _summonTick(target) {
    if (!target || this.summonCd > 0) return 0;
    this.summonCd = this.def.summonCd || 5;
    this.st = 'cast';
    return this.def.summonCount || 2;
  }

  // ---- snapshot --------------------------------------------------------------
  aabb() {
    return { x: this.x - this.w / 2, y: this.y - this.h, w: this.w, h: this.h };
  }

  serialize() {
    const s = {
      id: this.id,
      kind: this.kind,
      x: Math.round(this.x),
      y: Math.round(this.y),
      f: this.facing,
      hp: Math.max(0, Math.round(this.hp)),
      hpMax: this.hpMax,
      sc: Math.round(this.sc * 100) / 100,
      st: this.st || '',
    };
    if (this.boss) { s.boss = 1; s.name = this.name; }
    if (this.fly) s.fly = 1;
    return s;
  }
}

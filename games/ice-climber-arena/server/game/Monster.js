// ============================================================================
//  Patrolling monster with light AI.  WALKERs path along their ledge and
//  charge nearby climbers (contact damage + a brief freeze / CC).  CASTERs
//  hold position and lob freezing bolts (ranged crowd-control).
//  Contact resolution & damage application happen in GameRoom.
// ============================================================================
import {
  MonsterKind, MONSTER_HP, MONSTER_SPEED, MONSTER_AGGRO_SPEED,
  MONSTER_DETECT, GRAVITY, TERMINAL_VY,
} from '../../public/shared/constants.js';

export const MONSTER_W = 48;
export const MONSTER_H = 48;

let nextId = 1;

export class Monster {
  constructor(spec) {
    this.id = `m${nextId++}`;
    this.kind = spec.kind;
    this.minX = spec.minX;
    this.maxX = spec.maxX;
    this.y = spec.y; // ledge surface (monster's feet)
    this.x = (spec.minX + spec.maxX) / 2;
    this.dir = Math.random() < 0.5 ? -1 : 1;
    this.facing = this.dir;
    this.hp = MONSTER_HP;
    this.alive = true;
    this.castCd = 1.5;
    // falling state: set by GameRoom when the ice cell under the monster is shattered
    this.vy = 0;
    this.falling = false;
    this.supportY = spec.y; // y of the surface currently under its feet
  }

  /** @returns {null | {x,y,vx,vy}} a freeze bolt to spawn this tick */
  /** @param {{y:number,minX:number,maxX:number}|null} support surface under feet this tick
   *  @returns {null | {x,y,vx,vy}} a freeze bolt to spawn this tick */
  update(dt, players, support) {
    if (!this.alive) return null;
    this.castCd -= dt;

    // --- falling when the cell beneath is gone ---
    if (!support) {
      this.falling = true;
      this.vy = Math.min(this.vy + GRAVITY * dt, TERMINAL_VY);
      this.y += this.vy * dt;
      return null;
    }
    // landed on a new surface -> snap feet to it and resume patrolling
    if (this.falling) {
      this.falling = false;
      this.vy = 0;
      this.y = support.y;
      // confine patrol bounds to the new (possibly narrower) ledge band
      this.minX = Math.max(this.minX, support.minX);
      this.maxX = Math.min(this.maxX, support.maxX);
      if (this.minX > this.maxX) { this.minX = this.maxX = (support.minX+support.maxX)/2; }
      this.x = Math.max(this.minX, Math.min(this.maxX, this.x));
    } else {
      this.y = support.y; // keep feet glued to a stable ledge
    }


    // nearest valid target on roughly the same floor
    let target = null;
    let best = MONSTER_DETECT;
    for (const p of players) {
      if (!p.alive || p.rescued || p.invuln > 0) continue;
      if (Math.abs(p.y - this.y) > 150) continue;
      const d = Math.abs(p.x - this.x);
      if (d < best) { best = d; target = p; }
    }

    let fire = null;
    if (this.kind === MonsterKind.WALKER) {
      if (target) this.dir = Math.sign(target.x - this.x) || this.dir;
      const speed = target ? MONSTER_AGGRO_SPEED : MONSTER_SPEED;
      this.x += this.dir * speed * dt;
    } else {
      // CASTER: slow drift, stop & shoot when it sees prey
      if (target) {
        this.dir = Math.sign(target.x - this.x) || this.dir;
        if (this.castCd <= 0) {
          this.castCd = 2.3;
          const dx = target.x - this.x;
          const dy = (target.y - 20) - (this.y - MONSTER_H / 2);
          const len = Math.hypot(dx, dy) || 1;
          const spd = 360;
          fire = { x: this.x, y: this.y - MONSTER_H / 2, vx: (dx / len) * spd, vy: (dy / len) * spd };
        }
      } else {
        this.x += this.dir * MONSTER_SPEED * 0.5 * dt;
      }
    }

    // bounce inside the ledge
    if (this.x <= this.minX) { this.x = this.minX; this.dir = 1; }
    if (this.x >= this.maxX) { this.x = this.maxX; this.dir = -1; }
    this.facing = this.dir;
    return fire;
  }

  aabb() {
    return { x: this.x - MONSTER_W / 2, y: this.y - MONSTER_H, w: MONSTER_W, h: MONSTER_H };
  }

  serialize() {
    return {
      id: this.id,
      kind: this.kind,
      x: Math.round(this.x),
      y: Math.round(this.y),
      f: this.facing,
      hp: Math.max(0, Math.round(this.hp)),
    };
  }
}

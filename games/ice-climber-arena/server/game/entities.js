// ============================================================================
//  Lightweight world entities: pickups, projectiles (player fireballs & monster
//  freeze bolts) and falling icicles.  Plain data + serializers; their motion
//  and interactions are driven by GameRoom.
// ============================================================================
import { ItemKind } from '../../public/shared/constants.js';

let itemId = 1;
let projId = 1;
let iceId = 1;

export function makeItem(spec) {
  return {
    id: `i${itemId++}`,
    kind: spec.kind || ItemKind.HEAL,
    x: spec.x,
    y: spec.y,
    floor: spec.floor,
    taken: false,
    respawnAt: 0, // server time when it should reappear (0 = active)
  };
}

export function serializeItem(it) {
  return { id: it.id, kind: it.kind, x: Math.round(it.x), y: Math.round(it.y) };
}

export function makeProjectile(spec) {
  return {
    id: `p${projId++}`,
    kind: spec.kind, // 'fire' | 'freeze'
    owner: spec.owner || null,
    x: spec.x,
    y: spec.y,
    vx: spec.vx,
    vy: spec.vy || 0,
    life: spec.life || 2.2,
  };
}

export function serializeProjectile(p) {
  return { id: p.id, kind: p.kind, x: Math.round(p.x), y: Math.round(p.y), vx: Math.round(p.vx) };
}

export function makeIcicle(x, y) {
  return { id: `c${iceId++}`, x, y, vy: 0, dead: false };
}

export function serializeIcicle(c) {
  return { id: c.id, x: Math.round(c.x), y: Math.round(c.y) };
}

// ============================================================================
//  Deterministic physics — shared by client prediction and the server.
//  Axis-separated swept AABB against a list of rectangles.  Pure functions
//  (mutate the passed-in player state, return a small events object).
// ============================================================================
import {
  PLAYER_W, PLAYER_H, RUN_SPEED, RUN_ACCEL, AIR_ACCEL, GROUND_FRICTION,
  ICE_FRICTION, SPEED_TILE_MULT, GRAVITY, TERMINAL_VY, JUMP_VEL,
  WORLD_WIDTH, FLOOR_SPACING, FALL_SAFE_FLOORS, Tile,
} from './constants.js';

function approach(cur, target, maxStep) {
  if (cur < target) return Math.min(cur + maxStep, target);
  if (cur > target) return Math.max(cur - maxStep, target);
  return cur;
}

export function aabb(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/**
 * Build the list of solid collision rects for a given moment in the round.
 * Moving platforms are a pure function of `t` (seconds since round start) so
 * the client and server compute identical positions without extra packets.
 * Broken ice tiles (ids in `broken`) are excluded.
 */
export function buildRects(platforms, broken, t) {
  const out = [];
  for (const p of platforms) {
    if (p.type === Tile.ICE && broken && broken.has(p.id)) continue;
    let x = p.x;
    let vx = 0;
    if (p.type === Tile.MOVING) {
      x = p.x + Math.sin(t * p.speed + p.phase) * p.range;
      vx = Math.cos(t * p.speed + p.phase) * p.range * p.speed;
    }
    out.push({ id: p.id, x, y: p.y, w: p.w, h: p.h, type: p.type, vx, solid: true });
  }
  return out;
}

/**
 * Advance one player by a fixed `dt`. Mutates `s`.
 * `s` fields used: x,y,vx,vy,facing,onGround,jumpHeld,fallStartY,supportType,supportId
 * `opts`: { frozen, jumpMul, speedMul }
 * Returns: { bonk:[rects], landed:bool, fallFloors:number, leftGround:bool }
 */
export function stepPlayer(s, input, rects, dt, opts = {}) {
  const ev = { bonk: [], landed: false, fallFloors: 0, leftGround: false };
  const frozen = !!opts.frozen;
  const HW = PLAYER_W / 2;
  const HH = PLAYER_H / 2;
  const x0 = s.x;
  const y0 = s.y;
  const wasGround = s.onGround;

  // Support-surface modifiers (carried from the previous landing).
  let maxSpeed = RUN_SPEED * (opts.speedMul || 1);
  let friction = GROUND_FRICTION;
  if (s.supportType === Tile.SPEED) {
    maxSpeed *= SPEED_TILE_MULT;
    friction = ICE_FRICTION;
  }

  // --- horizontal intent ---
  let target = 0;
  if (!frozen) {
    if (input.left) target -= maxSpeed;
    if (input.right) target += maxSpeed;
  }
  const accel = wasGround ? RUN_ACCEL : AIR_ACCEL;
  if (target !== 0) s.vx = approach(s.vx, target, accel * dt);
  else if (wasGround) s.vx = approach(s.vx, 0, friction * dt);
  else s.vx = approach(s.vx, 0, AIR_ACCEL * 0.35 * dt); // light air drag
  if (s.vx > maxSpeed) s.vx = maxSpeed;
  if (s.vx < -maxSpeed) s.vx = -maxSpeed;
  if (!frozen) {
    if (input.left && !input.right) s.facing = -1;
    else if (input.right && !input.left) s.facing = 1;
  }

  // --- jump (edge-triggered) ---
  const jumpEdge = input.jump && !s.jumpHeld;
  s.jumpHeld = input.jump;
  if (!frozen && wasGround && jumpEdge) {
    s.vy = -JUMP_VEL * (opts.jumpMul || 1);
    s.onGround = false;
  }

  // --- gravity ---
  s.vy += GRAVITY * dt;
  if (s.vy > TERMINAL_VY) s.vy = TERMINAL_VY;

  // --- integrate X, resolve side collisions ---
  let nx = x0 + s.vx * dt;
  const pLeft = x0 - HW, pRight = x0 + HW, pTop0 = y0 - HH, pBot0 = y0 + HH;
  for (const r of rects) {
    if (!r.solid) continue;
    if (pBot0 > r.y && pTop0 < r.y + r.h) {
      if (s.vx > 0 && pRight <= r.x + 0.5 && nx + HW > r.x) { nx = r.x - HW; s.vx = 0; }
      else if (s.vx < 0 && pLeft >= r.x + r.w - 0.5 && nx - HW < r.x + r.w) { nx = r.x + r.w + HW; s.vx = 0; }
    }
  }
  if (nx < HW) { nx = HW; if (s.vx < 0) s.vx = 0; }
  if (nx > WORLD_WIDTH - HW) { nx = WORLD_WIDTH - HW; if (s.vx > 0) s.vx = 0; }
  s.x = nx;

  // --- integrate Y, resolve floor / head collisions ---
  let ny = y0 + s.vy * dt;
  let grounded = false;
  let support = null;
  const cLeft = s.x - HW, cRight = s.x + HW;
  let bestDown = null, bestUp = null;
  for (const r of rects) {
    if (!r.solid) continue;
    if (cRight > r.x && cLeft < r.x + r.w) {
      if (s.vy >= 0 && pBot0 <= r.y + 0.5 && ny + HH >= r.y) {
        if (!bestDown || r.y < bestDown.y) bestDown = r;
      } else if (s.vy < 0 && pTop0 >= r.y + r.h - 0.5 && ny - HH <= r.y + r.h) {
        if (!bestUp || r.y + r.h > bestUp.y + bestUp.h) bestUp = r;
      }
    }
  }
  if (bestDown) {
    ny = bestDown.y - HH;
    s.vy = 0;
    grounded = true;
    support = bestDown;
  } else if (bestUp) {
    ny = bestUp.y + bestUp.h + HH;
    s.vy = 0;
    ev.bonk.push(bestUp);
  }
  s.y = ny;
  s.onGround = grounded;
  s.supportType = support ? support.type : null;
  s.supportId = support ? support.id : null;

  // ride a moving platform
  if (grounded && support && support.type === Tile.MOVING && support.vx) {
    s.x += support.vx * dt;
    if (s.x < HW) s.x = HW;
    if (s.x > WORLD_WIDTH - HW) s.x = WORLD_WIDTH - HW;
  }

  // --- fall tracking ---
  if (wasGround && !grounded) {
    ev.leftGround = true;
    s.fallStartY = y0;
  }
  if (!wasGround && grounded) {
    ev.landed = true;
    const dist = s.y - (s.fallStartY ?? s.y);
    const floors = dist / FLOOR_SPACING;
    if (floors > FALL_SAFE_FLOORS) ev.fallFloors = floors;
  }
  return ev;
}

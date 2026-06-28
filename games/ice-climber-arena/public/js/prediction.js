// ============================================================================
//  Local-player prediction.  Runs the SAME deterministic physics as the server
//  on the local input every frame so movement feels instant.  Authoritative
//  snapshots are folded in WITHOUT yanking the on-screen position: the base
//  state is moved onto (velocity-extrapolated) authority while the exact same
//  delta is pushed into a render-space error offset that then decays away — so
//  corrections are absorbed invisibly instead of stuttering at the snapshot
//  rate.  Rendering also extrapolates the leftover fixed-step accumulator, which
//  keeps motion buttery on any refresh rate (no per-snapshot jump twitch).
// ============================================================================
import { stepPlayer } from '../shared/physics.js';
import { DT, JUMP_BUFF_MULT, SPEED_BUFF_MULT, wrapX, wrapDX } from '../shared/constants.js';

const ERR_TAU = 0.09; // seconds — time-constant for absorbing a correction
const SNAP_DIST = 150; // px — beyond this it's a respawn/teleport → hard snap
const MAX_OFFSET = 240; // px — clamp the visual debt so big jolts still resolve fast

export class LocalPredictor {
  constructor() {
    this.s = null; // predicted physics state (authoritative-tracking)
    this.acc = 0; // fixed-step accumulator
    this.server = null; // last authoritative self snapshot
    this.ex = 0; // render-space error offset (decays to 0)
    this.ey = 0;
  }

  _initFrom(p) {
    this.s = {
      x: p.x, y: p.y, vx: p.vx || 0, vy: p.vy || 0,
      facing: p.f || 1, onGround: !!p.g, jumpHeld: false,
      fallStartY: p.y, supportType: null, supportId: null,
    };
    this.ex = 0; this.ey = 0; this.acc = 0;
  }

  /** Advance prediction by real elapsed time using current input + world rects. */
  update(dtSec, input, rects) {
    if (!this.s) return;
    const sv = this.server;
    const opts = {
      frozen: sv ? sv.stun === 1 : false,
      jumpMul: sv && sv.jb ? JUMP_BUFF_MULT : 1,
      speedMul: sv && sv.spd ? SPEED_BUFF_MULT : 1,
    };
    this.acc += dtSec;
    let steps = 0;
    while (this.acc >= DT && steps < 5) {
      stepPlayer(this.s, input, rects, DT, opts);
      this.acc -= DT;
      steps++;
    }
    // smoothly absorb any outstanding correction
    const k = Math.exp(-dtSec / ERR_TAU);
    this.ex *= k; this.ey *= k;
    if (Math.abs(this.ex) < 0.05) this.ex = 0;
    if (Math.abs(this.ey) < 0.05) this.ey = 0;
  }

  /**
   * Fold in an authoritative snapshot of the local player.
   * `ageSec` is how stale the snapshot already is (≈ one-way latency) so we can
   * extrapolate it to "now" and keep the steady-state error near zero.
   */
  reconcile(server, ageSec = 0) {
    this.server = server;
    if (!this.s) { this._initFrom(server); return; }
    if (server.res || server.lift) { // being rescued — follow the server exactly
      this.s.x = server.x; this.s.y = server.y; this.s.vx = 0; this.s.vy = 0;
      this.ex = 0; this.ey = 0;
      return;
    }
    if (server.dead > 0) { // dead — hold the death spot, no prediction
      this.s.x = server.x; this.s.y = server.y; this.s.vx = 0; this.s.vy = 0;
      this.ex = 0; this.ey = 0;
      return;
    }
    const age = Math.max(0, Math.min(0.2, ageSec));
    const sx = server.x + (server.vx || 0) * age;
    const sy = server.y + (server.vy || 0) * age;
    // measure the error the short way around the wrap seam, so a legitimate edge
    // crossing reads as a few px (smoothly absorbed) — not a ~1500px hard snap.
    const dx = wrapDX(this.s.x, sx);
    const dy = sy - this.s.y;
    if (Math.hypot(dx, dy) > SNAP_DIST) { // teleport / respawn / large desync → snap
      this.s.x = server.x; this.s.y = server.y;
      this.s.vx = server.vx; this.s.vy = server.vy;
      this.s.onGround = !!server.g;
      this.s.fallStartY = server.y;
      this.ex = 0; this.ey = 0;
      return;
    }
    // Move the base state onto authority, but keep the rendered position put by
    // pushing the same delta (negated) into the decaying error offset.
    this.s.x = sx; this.s.y = sy;
    this.ex = clamp(this.ex - dx, -MAX_OFFSET, MAX_OFFSET);
    this.ey = clamp(this.ey - dy, -MAX_OFFSET, MAX_OFFSET);
  }

  /** Smooth, low-latency render state: fixed-step extrapolated + error-absorbed. */
  view() {
    if (!this.s) return null;
    const a = Math.min(this.acc, DT); // never extrapolate past one step
    return {
      x: wrapX(this.s.x + this.s.vx * a + this.ex), // keep the rendered self on the loop [0, WORLD_WIDTH)
      y: this.s.y + this.s.vy * a + this.ey,
      vx: this.s.vx, vy: this.s.vy,
      facing: this.s.facing, onGround: this.s.onGround,
    };
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

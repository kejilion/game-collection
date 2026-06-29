// ============================================================================
//  Network client.  Wraps Socket.IO, keeps a clock offset to the server, and
//  buffers snapshots so remote entities can be rendered with smooth
//  interpolation (≈100 ms behind "now").  The local player is predicted
//  separately (see prediction.js).
// ============================================================================
import { wrapX, wrapDX } from '../shared/constants.js';

const INTERP_DELAY = 100; // ms render delay for remote entities
const BUFFER = 24; // snapshots kept

export class Net {
  constructor() {
    this.socket = null;
    this.selfId = null;
    this.offset = 0; // serverTime ≈ Date.now() + offset
    this.rtt = 0;
    this._offInit = false;
    this.snaps = []; // { t, data }
    this.handlers = {};
  }

  on(evt, fn) { this.handlers[evt] = fn; return this; }
  _emit(evt, ...a) { if (this.handlers[evt]) this.handlers[evt](...a); }

  connect() {
    // eslint-disable-next-line no-undef
    this.socket = io({ transports: ['websocket', 'polling'] });
    const s = this.socket;
    s.on('connect', () => { this._emit('connect'); this._syncClock(); });
    s.on('disconnect', () => this._emit('disconnect'));
    s.on('snapshot', (data) => this._onSnapshot(data));
    s.on('roundStart', (d) => this._emit('roundStart', d));
    s.on('roundEnd', (d) => this._emit('roundEnd', d));
    s.on('rescued', (d) => this._emit('rescued', d));
    s.on('playerDied', (d) => this._emit('playerDied', d));
    s.on('planeIncoming', (d) => this._emit('plane', d));
    s.on('system', (d) => this._emit('system', d));
    s.on('chat', (d) => this._emit('chat', d));
    this._clockTimer = setInterval(() => this._syncClock(), 2500);
  }

  join(name, look) {
    return new Promise((resolve) => {
      this.socket.emit('join', { name, look }, (init) => {
        this.selfId = init.selfId;
        if (!this._offInit) { this.offset = init.serverTime - Date.now(); this._offInit = true; }
        resolve(init);
      });
    });
  }

  sendInput(msg) { if (this.socket) this.socket.volatile.emit('input', msg); }

  sendChat(text) { if (this.socket) this.socket.emit('chat', text); }

  /** Tear down the live connection (used when leaving / quitting a game). */
  disconnect() {
    clearInterval(this._clockTimer);
    if (this.socket) {
      try { this.socket.removeAllListeners(); } catch { /* noop */ }
      this.socket.disconnect();
      this.socket = null;
    }
    this.snaps = [];
    this.selfId = null;
    this._offInit = false;
  }

  now() { return Date.now() + this.offset; }

  _syncClock() {
    const t0 = Date.now();
    this.socket.emit('timesync', t0, (res) => {
      const t1 = Date.now();
      const rtt = t1 - t0;
      this.rtt = rtt;
      const serverNow = res.ts + rtt / 2;
      const newOffset = serverNow - t1;
      this.offset = this._offInit ? this.offset * 0.8 + newOffset * 0.2 : newOffset;
      this._offInit = true;
    });
  }

  _onSnapshot(data) {
    this.snaps.push({ t: data.t, data });
    if (this.snaps.length > BUFFER) this.snaps.shift();
    this._emit('snapshot', data);
  }

  latest() { return this.snaps.length ? this.snaps[this.snaps.length - 1].data : null; }

  /**
   * Interpolated view of remote entities at (serverNow - INTERP_DELAY).
   * Returns { players, monsters, items, proj, ice, plane } or null.
   */
  renderState() {
    if (this.snaps.length === 0) return null;
    const target = this.now() - INTERP_DELAY;

    let a = this.snaps[0], b = this.snaps[0];
    for (let i = 0; i < this.snaps.length - 1; i++) {
      if (this.snaps[i].t <= target && this.snaps[i + 1].t >= target) {
        a = this.snaps[i]; b = this.snaps[i + 1]; break;
      }
      b = this.snaps[i + 1]; a = this.snaps[i + 1];
    }
    const span = b.t - a.t;
    const alpha = span > 0 ? Math.max(0, Math.min(1, (target - a.t) / span)) : 0;
    const da = a.data, db = b.data;

    return {
      players: lerpById(da.players, db.players, alpha),
      monsters: lerpById(da.monsters, db.monsters, alpha),
      items: db.items,
      proj: lerpById(da.proj, db.proj, alpha),
      ice: lerpById(da.ice, db.ice, alpha),
      plane: lerpPlane(da.plane, db.plane, alpha),
    };
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }

function lerpById(listA, listB, alpha) {
  if (!listB) return listA || [];
  const mapA = new Map((listA || []).map((e) => [e.id, e]));
  return listB.map((eb) => {
    const ea = mapA.get(eb.id);
    if (!ea) return eb;
    const out = { ...eb };
    // interpolate x the short way around the seam: an entity crossing the edge
    // (1599→2) slides a few px and wraps, instead of racing back across the floor.
    if (eb.x != null) out.x = wrapX(ea.x + wrapDX(ea.x, eb.x) * alpha);
    if (eb.y != null) out.y = lerp(ea.y, eb.y, alpha);
    return out;
  });
}

function lerpPlane(pa, pb, alpha) {
  if (!pb) return null;
  if (!pa) return pb;
  return { x: lerp(pa.x, pb.x, alpha), y: pb.y, dir: pb.dir };
}

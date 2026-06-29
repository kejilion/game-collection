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
    this._joinArgs = null;   // remembered so we can transparently re-join on reconnect
    this._joinResolve = null;
    this._joinTimer = null;
  }

  on(evt, fn) { this.handlers[evt] = fn; return this; }
  _emit(evt, ...a) { if (this.handlers[evt]) this.handlers[evt](...a); }

  connect() {
    // Polling first, then silently upgrade to WebSocket. This is the Socket.IO
    // default for a reason: a raw WebSocket as the *first* transport often stalls
    // on mobile carriers / captive Wi‑Fi / reverse proxies that don't pass the
    // Upgrade header, leaving the client stuck on "连接中…". Long‑polling connects
    // nearly everywhere and the upgrade happens transparently when allowed.
    // eslint-disable-next-line no-undef
    this.socket = io({
      transports: ['polling', 'websocket'],
      timeout: 8000,                 // fail a stalled attempt fast instead of hanging
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelayMax: 4000,
    });
    const s = this.socket;
    s.on('connect', () => {
      this._emit('connect');
      this._syncClock();
      // (Re)join on every connect. After a mobile blip Socket.IO reconnects with a
      // fresh id; without re‑joining the server has no player for us and we turn
      // into a ghost. The first join is driven by join(); this covers reconnects.
      if (this._joinArgs) this._doJoin();
    });
    s.on('connect_error', (err) => this._emit('connect_error', err));
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

  /**
   * Join the room. Resolves with the server's init payload, or rejects after a
   * timeout so the UI never hangs forever on "连接中…". The join args are
   * remembered so we can transparently re‑join after a reconnect.
   */
  join(name, look) {
    this._joinArgs = { name, look };
    return new Promise((resolve, reject) => {
      this._joinResolve = resolve;
      this._joinTimer = setTimeout(() => {
        if (!this._joinResolve) return;
        this._joinResolve = null;
        reject(new Error('join-timeout'));
      }, 12000);
      // Connected already? fire now. Otherwise the connect handler will.
      if (this.socket && this.socket.connected) this._doJoin();
    });
  }

  _doJoin() {
    if (!this.socket || !this._joinArgs) return;
    this.socket.emit('join', this._joinArgs, (init) => {
      if (!this.socket || !this._joinArgs || !init) return;
      const reconnect = this.selfId != null;
      this.selfId = init.selfId;
      if (!this._offInit) { this.offset = init.serverTime - Date.now(); this._offInit = true; }
      if (this._joinResolve) {
        clearTimeout(this._joinTimer);
        const done = this._joinResolve;
        this._joinResolve = null;
        done(init);
      } else if (reconnect) {
        this._emit('rejoin', init); // let the app re‑sync level/round/selfId
      }
    });
  }

  sendInput(msg) { if (this.socket) this.socket.volatile.emit('input', msg); }

  sendChat(text) { if (this.socket) this.socket.emit('chat', text); }

  /** Tear down the live connection (used when leaving / quitting a game). */
  disconnect() {
    clearInterval(this._clockTimer);
    clearTimeout(this._joinTimer);
    this._joinArgs = null;
    this._joinResolve = null;
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

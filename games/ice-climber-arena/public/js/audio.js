// ============================================================================
//  SFX engine.  A tiny Web-Audio layer over a set of CC0 one-shot samples
//  (public/audio/*.ogg — Kenney, CC0; see public/audio/CREDITS.txt).
//
//  The game is server-authoritative: most cues ride the `fx` events the server
//  already streams in each snapshot (see GameRoom.fx → main.js onSnapshot).
//  `fromFx()` turns one of those into a positioned, distance-attenuated sound so
//  you hear what's happening on *your* part of the tower — not every hit on all
//  ten floors at once.  Round-flow / plane / rescue cues are driven from the
//  discrete socket events in main.js instead (they know self-vs-other + rank).
//
//  Nothing here ever throws into the game loop: with no Web Audio, a muted tab,
//  a sample that 404s or fails to decode, the matching cue is simply silent.
// ============================================================================
import { wrapDX, WORLD_WIDTH } from '../shared/constants.js';

// semantic cue → file under /audio.  All samples are CC0 (Kenney).
const MANIFEST = {
  jump: 'jump.ogg', land: 'land.ogg',
  ice_break_1: 'ice_break_1.ogg', ice_break_2: 'ice_break_2.ogg', ice_break_3: 'ice_break_3.ogg',
  shoot: 'shoot.ogg', hurt: 'hurt.ogg', ko: 'ko.ogg', ko_tone: 'ko_tone.ogg',
  pickup_fire: 'pickup_fire.ogg', pickup_heal: 'pickup_heal.ogg', pickup_jump: 'pickup_jump.ogg',
  pickup_haste: 'pickup_haste.ogg', pickup_shield: 'pickup_shield.ogg',
  freeze: 'freeze.ogg', no_ammo: 'no_ammo.ogg',
  mhit: 'mhit.ogg', mdeath: 'mdeath.ogg',
  pop_fire: 'pop_fire.ogg', pop_ice: 'pop_ice.ogg', icicle: 'icicle.ogg', hit_other: 'hit_other.ogg',
  plane: 'plane.ogg', win: 'win.ogg', escape_other: 'escape_other.ogg',
  round_start: 'round_start.ogg', round_end: 'round_end.ogg',
  ui_select: 'ui_select.ogg', ui_start: 'ui_start.ogg',
};

// Per-cue base level — normalizes loudness across packs and keeps ambient
// stuff (other people's monsters, far icicles) sitting under your own actions.
const GAIN = {
  jump: 0.32, land: 0.4, shoot: 0.5, hurt: 0.85, ko: 0.95, ko_tone: 0.7,
  freeze: 0.7, no_ammo: 0.5, plane: 0.85, win: 0.95, escape_other: 0.5,
  round_start: 0.75, round_end: 0.75, ui_select: 0.4, ui_start: 0.65,
  ice_break_1: 0.6, ice_break_2: 0.6, ice_break_3: 0.6,
  pickup_fire: 0.75, pickup_heal: 0.75, pickup_jump: 0.75, pickup_haste: 0.75, pickup_shield: 0.75,
  mhit: 0.45, mdeath: 0.55, pop_fire: 0.4, pop_ice: 0.4, icicle: 0.5, hit_other: 0.45,
};

// Min ms between repeats of the same cue, so storms of identical fx (raining
// icicles, a boss's burst death, a hail of projectile pops) don't machine-gun.
const THROTTLE = {
  icicle: 70, pop_fire: 60, pop_ice: 60, mhit: 55, mdeath: 45, hit_other: 60,
  land: 90, ice_break_1: 40, ice_break_2: 40, ice_break_3: 40,
};

const HALF_W = WORLD_WIDTH / 2; // pan normalizer (world wraps every WORLD_WIDTH)

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buffers = new Map();   // cue → AudioBuffer
    this.loading = false;
    this.ready = 0;             // how many samples decoded (for verification)
    this._lastAt = new Map();   // cue → last play ts (throttle)
    this._voices = 0;
    this.MAX_VOICES = 16;
    this.muted = readLS('ice.muted') === '1';
    const v = parseFloat(readLS('ice.vol'));
    this.volume = Number.isFinite(v) ? clamp01(v) : 0.8;
    // Background music is a separate HTMLAudioElement with its own mute (persisted),
    // independent of the SFX master — so 音乐 / 音效 toggle separately. Swap musicSrc
    // (or replace the file) to change the track.
    this.musicMuted = readLS('ice.music') === '1';
    this.musicVol = 0.45;
    this.musicSrc = '/audio/Zero_Degree_Dash.mp3';
    this.musicEl = null;
  }

  /**
   * Create the AudioContext on a real user gesture (browser autoplay policy)
   * and kick off sample loading. Safe to call repeatedly — resumes if the
   * context got suspended (e.g. tab backgrounded).
   */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        try {
          this.ctx = new AC();
          this.master = this.ctx.createGain();
          this.master.gain.value = this.muted ? 0 : this.volume;
          this.master.connect(this.ctx.destination);
          this._loadAll();
        } catch { this.ctx = null; } // no Web Audio → SFX stay silent, never error
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    this.startMusic();                 // BGM is independent of Web Audio
  }

  async _loadAll() {
    if (this.loading) return;
    this.loading = true;
    await Promise.all(Object.entries(MANIFEST).map(async ([cue, file]) => {
      try {
        const res = await fetch('/audio/' + file);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
        this.buffers.set(cue, buf);
        this.ready++;
      } catch (err) {
        console.warn('[audio] skip', cue, err && err.message); // that cue is just silent
      }
    }));
  }

  // ---- mute / volume (persisted) ------------------------------------------
  setMuted(m) {
    this.muted = !!m;
    writeLS('ice.muted', this.muted ? '1' : '0');
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    return this.muted;
  }
  toggleMute() { return this.setMuted(!this.muted); }
  isMuted() { return this.muted; }
  setVolume(v) {
    this.volume = clamp01(v);
    writeLS('ice.vol', String(this.volume));
    if (this.master && !this.muted) this.master.gain.value = this.volume;
  }

  // ---- background music (separate HTMLAudioElement, own mute) --------------
  _ensureMusic() {
    if (!this.musicEl) {
      try {
        const el = new Audio(this.musicSrc);
        el.loop = true; el.preload = 'auto'; el.volume = this.musicVol;
        this.musicEl = el;
      } catch { /* no <audio> element support */ }
    }
    return this.musicEl;
  }
  startMusic() {
    if (this.musicMuted) return;
    const el = this._ensureMusic();
    if (el) { const p = el.play(); if (p && p.catch) p.catch(() => {}); } // pre-gesture autoplay race → ignore
  }
  stopMusic() { if (this.musicEl) this.musicEl.pause(); }
  setMusicMuted(m) {
    this.musicMuted = !!m;
    writeLS('ice.music', this.musicMuted ? '1' : '0');
    if (this.musicMuted) this.stopMusic(); else this.startMusic();
    return this.musicMuted;
  }
  toggleMusic() { return this.setMusicMuted(!this.musicMuted); }
  isMusicMuted() { return this.musicMuted; }
  setMusicVolume(v) { this.musicVol = clamp01(v); if (this.musicEl) this.musicEl.volume = this.musicVol; }

  // ---- playback -----------------------------------------------------------
  /** Fire a one-shot. opts: { gain (0..1 multiplier), rate, pan (-1..1) }. */
  play(cue, opts = {}) {
    if (!this.ctx || this.muted) return;
    const buf = this.buffers.get(cue);
    if (!buf) return;
    const now = performance.now();
    const thr = THROTTLE[cue];
    if (thr) {
      if (now - (this._lastAt.get(cue) || 0) < thr) return;
      this._lastAt.set(cue, now);
    }
    if (this._voices >= this.MAX_VOICES) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    if (opts.rate) src.playbackRate.value = opts.rate;
    let node = src;
    if (opts.pan && this.ctx.createStereoPanner) {
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = clampPan(opts.pan);
      src.connect(pan); node = pan;
    }
    const g = this.ctx.createGain();
    g.gain.value = (GAIN[cue] != null ? GAIN[cue] : 0.7) * (opts.gain != null ? opts.gain : 1);
    node.connect(g); g.connect(this.master);
    this._voices++;
    src.onended = () => { this._voices = Math.max(0, this._voices - 1); };
    src.start();
  }

  /** Random one of several cues — variety for repeated impacts. */
  playOneOf(cues, opts) { this.play(cues[(Math.random() * cues.length) | 0], opts); }

  /**
   * World-positioned cue, panned + attenuated relative to the local player
   * `self` ({x,y}). Full within ~1 screen, silent a couple floors away — so the
   * mix tracks what's happening around you, not the whole tower.
   */
  playAt(cue, x, y, self, opts = {}) {
    if (!self || x == null) return this.play(cue, opts);
    const dx = wrapDX(self.x, x);
    const dy = (y || 0) - (self.y || 0);
    const dist = Math.hypot(dx, dy);
    const att = dist <= 480 ? 1 : dist >= 1150 ? 0 : 1 - (dist - 480) / 670;
    if (att <= 0.02) return;
    this.play(cue, {
      ...opts,
      gain: (opts.gain != null ? opts.gain : 1) * att,
      pan: clampPan(dx / HALF_W),
    });
  }

  /**
   * Translate a server `fx` event into a cue. `self` is the local player
   * snapshot ({x,y}); `selfId` is this client's id, used to tell "my hit/death/
   * pickup" (full, centered) from someone else's (positioned, quieter).
   * NOTE: `plane` and `rescue` are intentionally NOT handled here — main.js
   * drives those off the socket events, which also fire, to avoid double sounds.
   */
  fromFx(fx, self, selfId) {
    if (!fx) return;
    const mine = selfId != null && fx.id === selfId;
    switch (fx.t) {
      case 'ice':
        this.playAt(['ice_break_1', 'ice_break_2', 'ice_break_3'][(Math.random() * 3) | 0], fx.x, fx.y, self);
        break;
      case 'shoot':
        this.playAt('shoot', fx.x, fx.y, self, { gain: mine ? 1 : 0.7 });
        break;
      case 'hit':
        if (mine) this.play('hurt');
        else this.playAt('hit_other', fx.x, fx.y, self);
        break;
      case 'death':
        if (fx.cause === 'boss') {           // a felled boss — id is the monster, never `mine`
          this.playAt('ko', fx.x, fx.y, self, { gain: 1 });
          this.playAt('mdeath', fx.x, fx.y, self);
        } else if (mine) {
          this.play('ko'); this.play('ko_tone', { gain: 0.8 });
        } else {
          this.playAt('hit_other', fx.x, fx.y, self, { gain: 0.85 });
        }
        break;
      case 'mhit': this.playAt('mhit', fx.x, fx.y, self); break;
      case 'mdeath': this.playAt('mdeath', fx.x, fx.y, self); break;
      case 'pickup':
        if (mine) this.play(MANIFEST['pickup_' + fx.kind] ? 'pickup_' + fx.kind : 'pickup_jump');
        break;                               // other people's pickups stay silent
      case 'pop': this.playAt(fx.kind === 'fire' ? 'pop_fire' : 'pop_ice', fx.x, fx.y, self); break;
      case 'shatter': this.playAt('icicle', fx.x, fx.y, self); break;
      default: break;                        // plane / rescue handled in main.js
    }
  }
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function clampPan(v) { return Math.max(-1, Math.min(1, v)); }
function readLS(k) { try { return localStorage.getItem(k); } catch { return null; } }
function writeLS(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

export const audio = new AudioEngine();

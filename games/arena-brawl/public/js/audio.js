//  Audio — minimal MVP.
//  Wraps the Web Audio API to play SFX and a looping BGM with a single master gain
//  and a localStorage-backed volume / mute preference. No build step required.
//
//  Public API:
//    Audio.init()           — create/resume AudioContext; safe to call from a click handler
//    Audio.preload()        — fetch + decode all assets in MANIFEST; resolves when ready
//    Audio.play(name, opts) — fire-and-forget SFX; opts: { vol, loop }
//    Audio.playMusic(name)  — start a looping music track (fades in over 1.5 s)
//    Audio.stopMusic()      — stop the music with a short fade-out
//    Audio.setMaster(v01)   — 0..1
//    Audio.mute(bool)       — toggle mute; persists across reloads
//    Audio.loadPrefs()      — read localStorage prefs into the gain nodes
//    Audio.isSupported      — boolean (false on browsers without Web Audio)
//
//  If the browser lacks Web Audio, every method becomes a no-op and `isSupported` is false.

const Audio = (() => {
  'use strict';

  const ASSET_VERSION = '20260628a';

  // Single source of truth — bump both this and the <script> ?v= when assets change.
  const MANIFEST = {
    'swing':      'audio/sfx/swing.mp3?v=' + ASSET_VERSION,
    'slash':      'audio/sfx/slash.mp3?v=' + ASSET_VERSION,
    'fireball':   'audio/sfx/fireball.mp3?v=' + ASSET_VERSION,
    'explosion':  'audio/sfx/explosion.mp3?v=' + ASSET_VERSION,
    'pickup':     'audio/sfx/pickup.mp3?v=' + ASSET_VERSION,
    'levelup':    'audio/sfx/levelup.mp3?v=' + ASSET_VERSION,
    'death':      'audio/sfx/death.mp3?v=' + ASSET_VERSION,
    'spawn':      'audio/sfx/spawn.mp3?v=' + ASSET_VERSION,
    'boss-roar':  'audio/sfx/boss-roar.mp3?v=' + ASSET_VERSION,
    'boss-death': 'audio/sfx/boss-death.mp3?v=' + ASSET_VERSION,
    'ui-click':   'audio/sfx/ui-click.mp3?v=' + ASSET_VERSION,
    'bgm-loop':   'audio/music/bgm-loop.mp3?v=' + ASSET_VERSION,
  };

  // Per-SFX mix. Loudness now lives in the audio files themselves (each is
  // peak-normalized to ~0.3 / -10.5 dBFS), so the code applies no per-sound
  // gain — every entry plays at gain 1. What stays here is throttling:
  // `minGap` = min ms between repeats, which keeps the spammiest combat cues
  // (slash, fireball, explosion fire many times a second) from stacking into a
  // wall of the same sample. The basic-attack swing is silenced at the call
  // site (render.js), not here. Any sound with no entry plays at gain 1, no throttle.
  const SFX_MIX = {
    'slash':     { gain: 1, minGap: 90 },  // melee impact — one per landed hit
    'fireball':  { gain: 1, minGap: 90 },  // mage cast — one per shot
    'explosion': { gain: 1, minGap: 70 },  // fireball detonation
    'pickup':    { gain: 1, minGap: 0  },  // rare + important
  };

  const PREF_KEYS = {
    master: 'arena.audio.master',
    muted:  'arena.audio.muted',
  };

  const isSupported = !!(window.AudioContext || window.webkitAudioContext);

  // Module state — created lazily on init() so the page can load without user gesture.
  let ctx = null;
  let masterGain = null;
  const buffers = new Map();   // name -> AudioBuffer
  const lastPlay = new Map();   // name -> last trigger time (ms), for SFX_MIX throttling
  let musicSource = null;      // the looping source, if any
  let musicGain = null;
  let masterVol = 1;
  let muted = false;
  let preloadPromise = null;   // resolved when MANIFEST entries are decoded (or skipped)
  let pendingMusic = null;     // name requested before preload finished

  // ---- helpers ----------------------------------------------------------

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  function _readPref(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }

  function _writePref(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode etc */ }
  }

  async function _fetchAndDecode(name, url) {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    const arr = await res.arrayBuffer();
    // decodeAudioData is callback- or Promise-based depending on browser; use the Promise form.
    const buf = await ctx.decodeAudioData(arr);
    buffers.set(name, buf);
    return buf;
  }

  // ---- public API -------------------------------------------------------

  function init() {
    if (!isSupported) return;
    if (ctx) {
      // Already initialised — just make sure it's running (iOS can suspend after tab switch).
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctor();
    masterGain = ctx.createGain();
    masterGain.gain.value = masterVol;
    masterGain.connect(ctx.destination);
    musicGain = ctx.createGain();
    musicGain.gain.value = 0;
    musicGain.connect(masterGain);
  }

  async function preload() {
    if (!isSupported) return { loaded: 0, total: 0, skipped: true };
    if (preloadPromise) return preloadPromise;
    preloadPromise = (async () => {
      // Skip on slow / data-saver connections to avoid burning mobile bandwidth.
      const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (conn && (conn.effectiveType === '2g' || conn.effectiveType === 'slow-2g' || conn.saveData)) {
        return { loaded: 0, total: 0, skipped: true };
      }
      const entries = Object.entries(MANIFEST);
      let loaded = 0;
      await Promise.all(entries.map(async ([name, url]) => {
        try { await _fetchAndDecode(name, url); loaded++; }
        catch (e) { console.warn('[audio] failed to load', name, e); }
      }));
      return { loaded, total: entries.length, skipped: false };
    })();
    return preloadPromise;
  }

  function play(name, opts) {
    if (!ctx || muted) return;
    const buf = buffers.get(name);
    if (!buf) return; // not loaded yet — silent no-op
    opts = opts || {};
    const mix = SFX_MIX[name];

    // Throttle spammy combat cues: drop a repeat that lands within minGap ms of
    // the previous one so rapid-fire attacks don't stack the same sample.
    if (mix && mix.minGap) {
      const now = ctx.currentTime * 1000;
      if (now - (lastPlay.get(name) || -Infinity) < mix.minGap) return;
      lastPlay.set(name, now);
    }

    // Final gain: an explicit opts.vol wins (lets an ability deliberately reuse a
    // toned-down sample at its own level); otherwise use the per-sound mix gain,
    // defaulting to 1. Capped at 1.5 so a boosted cue (pickup) has headroom.
    const base = opts.vol == null ? (mix ? mix.gain : 1) : opts.vol;
    const vol = Math.max(0, Math.min(1.5, base));
    if (vol <= 0) return;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (opts.loop) src.loop = true;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(g).connect(masterGain);
    src.start();
    if (!opts.loop) src.onended = () => { try { src.disconnect(); g.disconnect(); } catch (e) {} };
    return src;
  }

  function playMusic(name) {
    if (!ctx) return;
    const buf = buffers.get(name);
    if (!buf) {
      // Buffer not decoded yet — usually because the caller fired playMusic in the
      // same gesture as Audio.preload(). Remember the request and start it as soon
      // as the decode finishes (or, on the slow-connection skip path, when nothing
      // arrives — bail in that case so we don't loop on a never-resolving promise).
      pendingMusic = name;
      if (preloadPromise) {
        preloadPromise.then(() => {
          if (pendingMusic === name) {
            pendingMusic = null;
            if (buffers.has(name)) _startMusic(name);
          }
        });
      }
      return;
    }
    _startMusic(name);
  }

  // BGM tracks the master slider 1:1 (no separate attenuation): loudness is
  // baked into bgm-loop.mp3, normalized to the same ~0.3 peak as the SFX.
  // Independent of the SFX mute toggle.
  function _bgmTarget() { return masterVol; }

  function _startMusic(name) {
    if (!ctx) return;
    stopMusic(0);                       // tear down any prior loop instantly
    const buf = buffers.get(name);
    if (!buf) return;
    musicSource = ctx.createBufferSource();
    musicSource.buffer = buf;
    musicSource.loop = true;
    musicSource.connect(musicGain);
    musicGain.gain.cancelScheduledValues(ctx.currentTime);
    musicGain.gain.setValueAtTime(musicGain.gain.value, ctx.currentTime);
    musicGain.gain.linearRampToValueAtTime(_bgmTarget(), ctx.currentTime + 1.5); // BGM ignores SFX mute
    musicSource.start();
  }

  function stopMusic(fadeMs) {
    if (!ctx || !musicSource) return;
    const t = ctx.currentTime;
    const fade = (fadeMs == null ? 0.3 : fadeMs / 1000);
    musicGain.gain.cancelScheduledValues(t);
    musicGain.gain.setValueAtTime(musicGain.gain.value, t);
    musicGain.gain.linearRampToValueAtTime(0, t + fade);
    const src = musicSource;
    musicSource = null;
    setTimeout(() => { try { src.stop(); src.disconnect(); } catch (e) {} }, fade * 1000 + 50);
  }

  function setMaster(v01) {
    masterVol = clamp01(v01);
    if (masterGain) masterGain.gain.value = muted ? 0 : masterVol;
    if (musicSource && musicGain) musicGain.gain.linearRampToValueAtTime(_bgmTarget(), ctx.currentTime + 0.2); // BGM ignores SFX mute
  }

  function mute(shouldMute) {
    // SFX-only mute: BGM is controlled independently so the music / sfx
    // toggles in the settings panel don't bleed into each other.
    muted = !!shouldMute;
    _writePref(PREF_KEYS.muted, muted ? '1' : '0');
  }

  function loadPrefs() {
    const m = parseFloat(_readPref(PREF_KEYS.master, '1'));
    masterVol = isFinite(m) ? clamp01(m) : 1;
    muted = _readPref(PREF_KEYS.muted, '0') === '1';
    if (masterGain) masterGain.gain.value = muted ? 0 : masterVol;
  }

  function persistMaster() { _writePref(PREF_KEYS.master, String(masterVol)); }

  // isSupported is exposed as a getter so it reflects the detection at load time.
  const api = {
    init, preload, play, playMusic, stopMusic,
    setMaster, mute, loadPrefs, persistMaster,
    get isSupported() { return isSupported; },
    get isMuted() { return muted; },
    get masterVol() { return masterVol; },
  };
  // Expose on window so other scripts loaded *before* audio.js (render.js, etc.)
  // can still reach the module from inside their own IIFEs.
  if (typeof window !== 'undefined') {
    window.Audio = api;
    // Debug surface — lets us peek at decode state from devtools/preview.
    window.__audioDebug = {
      get bufferNames() { return Array.from(buffers.keys()); },
      get ctxState() { return ctx ? ctx.state : 'no-ctx'; },
      has: (n) => buffers.has(n),
    };
  }
  return api;
})();
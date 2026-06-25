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

  const ASSET_VERSION = '20260701';

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

  const PREF_KEYS = {
    master: 'arena.audio.master',
    muted:  'arena.audio.muted',
  };

  const isSupported = !!(window.AudioContext || window.webkitAudioContext);

  // Module state — created lazily on init() so the page can load without user gesture.
  let ctx = null;
  let masterGain = null;
  const buffers = new Map();   // name -> AudioBuffer
  let musicSource = null;      // the looping source, if any
  let musicGain = null;
  let masterVol = 0.8;
  let muted = false;

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
  }

  function play(name, opts) {
    if (!ctx || muted) return;
    const buf = buffers.get(name);
    if (!buf) return; // not loaded yet — silent no-op
    opts = opts || {};
    const vol = clamp01(opts.vol == null ? 1 : opts.vol);
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
    stopMusic(0);                       // tear down any prior loop instantly
    const buf = buffers.get(name);
    if (!buf) return;                   // not loaded yet
    musicSource = ctx.createBufferSource();
    musicSource.buffer = buf;
    musicSource.loop = true;
    musicSource.connect(musicGain);
    musicGain.gain.cancelScheduledValues(ctx.currentTime);
    musicGain.gain.setValueAtTime(musicGain.gain.value, ctx.currentTime);
    musicGain.gain.linearRampToValueAtTime(masterVol * (muted ? 0 : 1), ctx.currentTime + 1.5);
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
    if (musicSource && musicGain) musicGain.gain.linearRampToValueAtTime(masterVol * (muted ? 0 : 1), ctx.currentTime + 0.2);
  }

  function mute(shouldMute) {
    muted = !!shouldMute;
    if (masterGain) masterGain.gain.value = muted ? 0 : masterVol;
    if (musicSource && musicGain) musicGain.gain.linearRampToValueAtTime(muted ? 0 : masterVol, ctx.currentTime + 0.2);
    _writePref(PREF_KEYS.muted, muted ? '1' : '0');
  }

  function loadPrefs() {
    const m = parseFloat(_readPref(PREF_KEYS.master, '0.8'));
    masterVol = isFinite(m) ? clamp01(m) : 0.8;
    muted = _readPref(PREF_KEYS.muted, '0') === '1';
    if (masterGain) masterGain.gain.value = muted ? 0 : masterVol;
  }

  function persistMaster() { _writePref(PREF_KEYS.master, String(masterVol)); }

  // isSupported is exposed as a getter so it reflects the detection at load time.
  return {
    init, preload, play, playMusic, stopMusic,
    setMaster, mute, loadPrefs, persistMaster,
    get isSupported() { return isSupported; },
    get isMuted() { return muted; },
    get masterVol() { return masterVol; },
  };
})();
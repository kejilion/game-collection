// 程序化音效（WebAudio 合成，无外部资源）
window.G = window.G || {};
G.audio = (function () {
  let ctx = null, master = null;

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createDynamicsCompressor();
      const gain = ctx.createGain();
      gain.gain.value = 0.5;
      master.connect(gain); gain.connect(ctx.destination);
    } catch (_) { ctx = null; }
  }
  const ok = () => ctx && ctx.state === 'running';

  function noiseBuf(dur) {
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  // 噪声爆发：枪声/爆炸底料
  function burst(dur, freq, vol, decay, type) {
    if (!ok()) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = noiseBuf(dur);
    const f = ctx.createBiquadFilter(); f.type = type || 'lowpass'; f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t); src.stop(t + dur);
  }
  // 单音：滑频振荡器
  function tone(type, f0, f1, dur, vol, delay) {
    if (!ok()) return;
    const t = ctx.currentTime + (delay || 0);
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  return {
    init, get ready() { return ok(); },
    shot(wp) {
      if (wp === 'pistol') { burst(0.12, 2400, 0.5, 0.1); tone('square', 320, 90, 0.08, 0.16); }
      else if (wp === 'mg') { burst(0.09, 2000, 0.42, 0.07); tone('square', 260, 80, 0.06, 0.13); }
      else if (wp === 'sniper') { burst(0.35, 1400, 0.8, 0.3); tone('sawtooth', 190, 40, 0.3, 0.28); burst(0.4, 300, 0.4, 0.4); }
    },
    dryFire() { tone('square', 900, 700, 0.05, 0.1); },
    reload() { tone('square', 500, 380, 0.05, 0.12); tone('square', 700, 550, 0.05, 0.12, 0.16); },
    reloadDone() { tone('square', 800, 1200, 0.07, 0.14); },
    melee(wp) {
      burst(0.16, wp === 'hammer' ? 500 : 1200, 0.3, 0.14, 'bandpass');
      if (wp === 'hammer') tone('sine', 120, 60, 0.18, 0.24);
    },
    hit(crit) { tone('square', crit ? 1500 : 1100, crit ? 900 : 700, 0.06, 0.22); },
    headshot() { tone('sine', 1800, 1200, 0.1, 0.24); tone('sine', 2400, 1800, 0.1, 0.18, 0.05); },
    hurt() { burst(0.12, 800, 0.3, 0.1, 'bandpass'); tone('sawtooth', 200, 120, 0.12, 0.16); },
    immune() { tone('sine', 600, 600, 0.08, 0.14); },
    explosion(big) {
      burst(big ? 0.9 : 0.5, 180, big ? 1 : 0.7, big ? 0.8 : 0.45);
      burst(0.3, 1200, 0.4, 0.25);
      tone('sine', 90, 30, big ? 0.8 : 0.5, 0.5);
    },
    throwNade() { burst(0.1, 900, 0.16, 0.09, 'bandpass'); },
    pickup() { tone('sine', 700, 1050, 0.09, 0.2); tone('sine', 1050, 1400, 0.1, 0.18, 0.08); },
    buff() { tone('sine', 500, 900, 0.14, 0.2); tone('sine', 750, 1350, 0.16, 0.18, 0.1); tone('sine', 1000, 1800, 0.18, 0.14, 0.2); },
    buy() { tone('sine', 900, 1300, 0.1, 0.2); tone('sine', 1300, 1900, 0.14, 0.18, 0.1); },
    deny() { tone('square', 240, 160, 0.14, 0.16); },
    chat() { tone('sine', 1200, 1400, 0.05, 0.08); },
    kill() { tone('sine', 600, 900, 0.1, 0.2); tone('sine', 900, 1400, 0.12, 0.2, 0.09); },
    die() { tone('sawtooth', 300, 60, 0.7, 0.3); burst(0.4, 500, 0.25, 0.35); },
    respawn() { tone('sine', 400, 1200, 0.3, 0.2); },
    roar() { tone('sawtooth', 90, 45, 1.1, 0.5); tone('sawtooth', 140, 60, 1, 0.4, 0.08); burst(1, 300, 0.35, 0.9); },
    bossFire() { burst(0.3, 600, 0.3, 0.26, 'bandpass'); tone('sawtooth', 300, 120, 0.3, 0.2); },
    slam() { tone('sine', 100, 40, 0.4, 0.5); burst(0.35, 400, 0.5, 0.3); },
    zombie() { tone('sawtooth', 160, 70, 0.5, 0.3); tone('sawtooth', 220, 90, 0.5, 0.25, 0.15); },
    step() { burst(0.05, 500, 0.06, 0.045, 'bandpass'); },
    ui() { tone('sine', 800, 950, 0.05, 0.1); },
  };
})();

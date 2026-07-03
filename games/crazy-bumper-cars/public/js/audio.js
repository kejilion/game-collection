'use strict';
// WebAudio 合成音效（无需音频文件）：撞击、爆炸、弹簧、道具、喇叭、引擎。
const GameAudio = (() => {
  let ctx = null;
  let master = null;
  let engineOsc = null, engineGain = null;
  let muted = false;

  function ensure() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return true; }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    } catch (_) { return false; }
    return true;
  }

  function now() { return ctx.currentTime; }

  function env(gainNode, t0, peak, dur) {
    const g = gainNode.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(Math.max(peak, 0.001), t0 + 0.012);
    g.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }

  function noiseBuffer(dur) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  function playNoise(dur, peak, filterFreq, filterSweep) {
    if (!ctx || muted) return;
    const t0 = now();
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(dur);
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(filterFreq, t0);
    if (filterSweep) filt.frequency.exponentialRampToValueAtTime(filterSweep, t0 + dur);
    const g = ctx.createGain();
    env(g, t0, peak, dur);
    src.connect(filt).connect(g).connect(master);
    src.start(t0); src.stop(t0 + dur + 0.05);
  }

  function playTone(type, f0, f1, dur, peak) {
    if (!ctx || muted) return;
    const t0 = now();
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    if (f1) osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + dur);
    const g = ctx.createGain();
    env(g, t0, peak, dur);
    osc.connect(g).connect(master);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
  }

  return {
    unlock() { ensure(); },
    toggleMute() { muted = !muted; if (engineGain) engineGain.gain.value = 0; return muted; },
    get muted() { return muted; },

    hit(p) {           // 车对撞：闷响 + 金属
      playNoise(0.18, 0.5 * p + 0.15, 900 + 1500 * p, 150);
      playTone('square', 180 + 120 * p, 60, 0.15, 0.25 * p);
    },
    clank(p) {         // 轻碰
      playNoise(0.06, 0.12 * p + 0.04, 1800, 400);
    },
    bump(p) {          // 弹力柱：卡通 BOING
      playTone('sine', 160, 620 + 300 * p, 0.22, 0.4);
      playTone('triangle', 90, 260, 0.22, 0.25);
    },
    wall(p) { playNoise(0.1, 0.2 * p + 0.05, 700, 120); },
    saw() {            // 电锯
      playNoise(0.3, 0.5, 3200, 500);
      playTone('sawtooth', 420, 90, 0.3, 0.3);
    },
    explode() {        // 爆炸
      playNoise(0.7, 0.85, 2400, 60);
      playTone('sine', 130, 28, 0.6, 0.5);
    },
    pickup() { playTone('sine', 620, 1240, 0.14, 0.3); playTone('sine', 930, 1860, 0.18, 0.2); },
    horn() {           // 喇叭：双音
      playTone('square', 466, 466, 0.16, 0.22);
      setTimeout(() => playTone('square', 370, 370, 0.2, 0.22), 110);
    },
    spawn() { playTone('triangle', 320, 660, 0.25, 0.25); },
    boostLoopHint() { playNoise(0.12, 0.1, 2600, 900); },

    // 本地车引擎音：随速度改变音高
    engine(speedRatio, boosting) {
      if (!ctx || muted) { return; }
      if (!engineOsc) {
        engineOsc = ctx.createOscillator();
        engineOsc.type = 'sawtooth';
        engineGain = ctx.createGain();
        engineGain.gain.value = 0;
        const filt = ctx.createBiquadFilter();
        filt.type = 'lowpass'; filt.frequency.value = 380;
        engineOsc.connect(filt).connect(engineGain).connect(master);
        engineOsc.start();
      }
      const f = 42 + speedRatio * 90 + (boosting ? 45 : 0);
      const v = speedRatio > 0.02 ? 0.05 + speedRatio * 0.075 : 0.02;
      engineOsc.frequency.setTargetAtTime(f, now(), 0.08);
      engineGain.gain.setTargetAtTime(v, now(), 0.12);
    },
    engineStop() {
      if (engineGain) engineGain.gain.setTargetAtTime(0, now(), 0.1);
    }
  };
})();

'use strict';

// WebAudio 合成音效与 BGM：无音频文件，全部程序合成。
// 首次用户手势后才创建 AudioContext（浏览器自动播放策略）。

window.GameAudio = (function () {
  let ctx = null;
  let master = null;
  let sfxOn = true;
  let musicOn = true;
  let musicTimer = null;
  let musicGain = null;

  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return true;
    }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
      return true;
    } catch {
      return false;
    }
  }

  function env(gain, t0, attack, peak, decay) {
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  function tone({ type = 'square', freq = 440, to = null, dur = 0.15, vol = 0.25, when = 0 }) {
    if (!sfxOn || !ensure()) return;
    const t0 = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    env(g, t0, 0.01, vol, dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  function noise({ dur = 0.3, vol = 0.4, freq = 800, when = 0 }) {
    if (!sfxOn || !ensure()) return;
    const t0 = ctx.currentTime + when;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(freq * 4, t0);
    filter.frequency.exponentialRampToValueAtTime(freq / 4, t0 + dur);
    const g = ctx.createGain();
    env(g, t0, 0.005, vol, dur);
    src.connect(filter).connect(g).connect(master);
    src.start(t0);
  }

  // 位置相关的音效带音量系数 k（0~1），供“按距离衰减”使用
  const sfx = {
    place(k = 1) { tone({ type: 'sine', freq: 300, to: 180, dur: 0.12, vol: 0.3 * k }); },
    boom(k = 1) {
      noise({ dur: 0.5, vol: 0.55 * k, freq: 500 });
      tone({ type: 'sine', freq: 90, to: 40, dur: 0.4, vol: 0.5 * k });
    },
    brick(k = 1) { noise({ dur: 0.15, vol: 0.2 * k, freq: 1200 }); },
    pick(k = 1) {
      tone({ type: 'square', freq: 660, dur: 0.07, vol: 0.2 * k });
      tone({ type: 'square', freq: 990, dur: 0.1, vol: 0.2 * k, when: 0.07 });
    },
    shield() { tone({ type: 'triangle', freq: 500, to: 220, dur: 0.25, vol: 0.3 }); },
    die(k = 1) {
      tone({ type: 'sawtooth', freq: 420, to: 80, dur: 0.5, vol: 0.3 * k });
      tone({ type: 'square', freq: 620, to: 120, dur: 0.4, vol: 0.15 * k, when: 0.05 });
    },
    mdie(k = 1) { tone({ type: 'square', freq: 520, to: 900, dur: 0.18, vol: 0.22 * k }); },
    grow(k = 1) { tone({ type: 'sine', freq: 140, to: 220, dur: 0.2, vol: 0.12 * k }); },
    streak() {
      [523, 659, 784, 1046].forEach((f, i) =>
        tone({ type: 'square', freq: f, dur: 0.18, vol: 0.25, when: i * 0.13 }));
    },
    respawn() { tone({ type: 'square', freq: 440, to: 880, dur: 0.25, vol: 0.22 }); },
  };

  // ---------- BGM：轻快的 8 小节循环 ----------

  // 简谱式音符表（频率, 拍数），0 表示休止
  const MELODY = [
    [523, .5], [659, .5], [784, .5], [659, .5], [523, .5], [659, .5], [784, 1],
    [880, .5], [784, .5], [659, .5], [784, .5], [880, .5], [1046, .5], [784, 1],
    [659, .5], [523, .5], [587, .5], [659, .5], [698, .5], [659, .5], [587, 1],
    [523, .5], [587, .5], [659, .5], [587, .5], [523, .5], [494, .5], [523, 1],
  ];
  const BASS = [131, 165, 196, 165];
  const BPM = 132;

  function scheduleMusicLoop() {
    if (!musicOn || !ctx) return;
    const beat = 60 / BPM;
    let t = ctx.currentTime + 0.05;
    const loopStart = t;
    for (const [freq, beats] of MELODY) {
      if (freq > 0) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.045, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + beats * beat * 0.85);
        osc.connect(g).connect(musicGain);
        osc.start(t);
        osc.stop(t + beats * beat);
      }
      t += beats * beat;
    }
    let bt = loopStart;
    const total = t - loopStart;
    let bi = 0;
    while (bt < loopStart + total - 0.01) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = BASS[bi % BASS.length];
      g.gain.setValueAtTime(0.0001, bt);
      g.gain.linearRampToValueAtTime(0.05, bt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, bt + beat * 0.9);
      osc.connect(g).connect(musicGain);
      osc.start(bt);
      osc.stop(bt + beat);
      bt += beat;
      bi++;
    }
    musicTimer = setTimeout(scheduleMusicLoop, (total - 0.1) * 1000);
  }

  function startMusic() {
    if (!ensure() || musicTimer) return;
    if (!musicGain) {
      musicGain = ctx.createGain();
      musicGain.gain.value = 1;
      musicGain.connect(master);
    }
    if (musicOn) scheduleMusicLoop();
  }

  function stopMusic() {
    if (musicTimer) {
      clearTimeout(musicTimer);
      musicTimer = null;
    }
  }

  return {
    sfx,
    unlock() { ensure(); },
    startMusic,
    toggleSfx() { sfxOn = !sfxOn; return sfxOn; },
    toggleMusic() {
      musicOn = !musicOn;
      if (musicOn) { startMusic(); } else { stopMusic(); }
      return musicOn;
    },
    get sfxOn() { return sfxOn; },
    get musicOn() { return musicOn; },
  };
})();

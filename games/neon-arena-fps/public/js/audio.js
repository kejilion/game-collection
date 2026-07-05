// 程序化音频（WebAudio 合成，无外部资源）：音效 + 背景音乐，均可独立开关
window.G = window.G || {};
G.audio = (function () {
  let ctx = null, master = null, musicGain = null;
  const S = { sfxOn: true, musicOn: true, lite: false };

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); startMusic(); return; }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createDynamicsCompressor();
      const gain = ctx.createGain();
      gain.gain.value = 0.5;
      master.connect(gain); gain.connect(ctx.destination);
      musicGain = ctx.createGain();
      musicGain.gain.value = 0.16;
      musicGain.connect(master);
      startMusic();
    } catch (_) { ctx = null; }
  }
  const ok = () => ctx && ctx.state === 'running';

  // 标签页/App 切后台时暂停音乐调度定时器（省电，避免后台无谓计算），回前台恢复
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (music.timer) { clearInterval(music.timer); music.timer = null; } }
    else { if (ctx && ctx.state === 'suspended') ctx.resume(); if (S.musicOn) startMusic(); }
  });

  function noiseBuf(dur) {
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  // ---------- 音效底层（受 sfxOn 开关控制） ----------
  function burst(dur, freq, vol, decay, type) {
    if (!ok() || !S.sfxOn) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = noiseBuf(dur);
    const f = ctx.createBiquadFilter(); f.type = type || 'lowpass'; f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t); src.stop(t + dur);
  }
  function tone(type, f0, f1, dur, vol, delay) {
    if (!ok() || !S.sfxOn) return;
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

  // ---------- 背景音乐（暗色合成器氛围循环，走独立 musicGain 通道） ----------
  const music = { timer: null, step: 0, nextAt: 0, drone: null };
  S.intensity = 0;   // 0 平时 / 1 BOSS 在场（game.js 每状态帧同步，setter 内部去重）
  const STEP = 0.32;                                     // ~94 BPM 八分音符
  // A/B 两段低音走向交替（各 2 小节），打破单循环的单调感；均为 A 小调
  const BASS_A = [55, 0, 55, 0, 82.4, 0, 55, 0, 65.4, 0, 65.4, 0, 49, 0, 61.7, 73.4];
  const BASS_B = [55, 0, 65.4, 0, 49, 0, 55, 0, 73.4, 0, 82.4, 0, 98, 0, 73.4, 65.4];
  const ARP = [220, 261.6, 329.6, 392, 440, 523.2];

  function mnote(type, freq, dur, vol, at, filterF) {
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(vol, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, at + dur);
    let node = o;
    if (filterF) {
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filterF;
      o.connect(f); node = f;
    }
    node.connect(g); g.connect(musicGain);
    o.start(at); o.stop(at + dur + 0.05);
  }
  function mhat(at) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf(0.05);
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 6000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.04);
    src.connect(f); f.connect(g); g.connect(musicGain);
    src.start(at); src.stop(at + 0.05);
  }
  function startMusic() {
    if (!ctx || music.timer || !S.musicOn) return;
    music.nextAt = ctx.currentTime + 0.1;
    music.step = 0;
    music.timer = setInterval(() => {
      if (!ok()) return;
      while (music.nextAt < ctx.currentTime + 0.4) {
        const st = music.step % 16, at = music.nextAt;
        const bar = Math.floor(music.step / 16);
        const BASS = (bar % 4 < 2) ? BASS_A : BASS_B;    // A/B 段落每两小节交替
        const bass = BASS[st];
        if (bass) mnote('sawtooth', bass, 0.4, 0.16, at, 320);
        // 强度层（BOSS 在场）：镲片加密、低音八度补强、琶音更活跃
        const hatEvery = S.intensity ? (S.lite ? 2 : 1) : (S.lite ? 4 : 2);
        if (st % hatEvery === 0) mhat(at + 0.16);
        if (S.intensity && bass && st % 8 === 4) mnote('sawtooth', bass * 2, 0.3, 0.05, at, 640);
        if (st % 4 === 2 && Math.random() < (S.intensity ? 0.9 : 0.7))
          mnote('sine', ARP[Math.floor(Math.random() * ARP.length)], 0.5, 0.045, at);
        if (st === 0 && !S.lite) {                        // 长音和弦垫（轻量模式跳过，省 3 个长振荡器）
          mnote('triangle', 110, STEP * 16, 0.05, at);
          mnote('triangle', 164.8, STEP * 16, 0.04, at);
          mnote('triangle', 220.9, STEP * 16, 0.03, at);
        }
        music.step++;
        music.nextAt += STEP;
      }
    }, 120);
  }
  function stopMusic() {
    if (music.timer) { clearInterval(music.timer); music.timer = null; }
  }

  return {
    init, get ready() { return ok(); },
    get sfxOn() { return S.sfxOn; }, get musicOn() { return S.musicOn; },
    setSfx(on) { S.sfxOn = !!on; },
    setMusic(on) { S.musicOn = !!on; if (on) startMusic(); else stopMusic(); },
    setLite(on) { S.lite = !!on; },   // 轻量模式：移动端等性能受限设备减少同时发声的振荡器数量
    setIntensity(v) { const n = v ? 1 : 0; if (S.intensity !== n) S.intensity = n; },
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
    // 近战命中的"确实打中了"那一下：按武器分量级，铁锤最沉，小刀最脆
    meleeHit(wp) {
      const heavy = wp === 'hammer', mid = wp === 'sword';
      burst(heavy ? 0.24 : mid ? 0.14 : 0.09, heavy ? 260 : mid ? 550 : 900, heavy ? 0.55 : 0.32, heavy ? 0.24 : 0.1, 'bandpass');
      tone('sine', heavy ? 85 : mid ? 140 : 220, heavy ? 38 : mid ? 60 : 90, heavy ? 0.3 : 0.16, heavy ? 0.42 : 0.24);
      if (heavy) burst(0.32, 140, 0.4, 0.3);
    },
    hit(crit) { tone('square', crit ? 1500 : 1100, crit ? 900 : 700, 0.06, 0.22); burst(0.05, 750, 0.16, 0.06); },
    headshot() { tone('sine', 1800, 1200, 0.1, 0.24); tone('sine', 2400, 1800, 0.1, 0.18, 0.05); burst(0.05, 3200, 0.14, 0.05, 'highpass'); },
    hurt() { burst(0.12, 800, 0.3, 0.1, 'bandpass'); tone('sawtooth', 200, 120, 0.12, 0.16); },
    immune() { tone('sine', 600, 600, 0.08, 0.14); },
    explosion(big) {
      burst(big ? 0.9 : 0.5, 180, big ? 1 : 0.7, big ? 0.8 : 0.45);
      burst(0.3, 1200, 0.4, 0.25);
      tone('sine', 90, 30, big ? 0.8 : 0.5, 0.5);
    },
    throwNade() { burst(0.1, 900, 0.16, 0.09, 'bandpass'); },
    flashPop() { burst(0.32, 5000, 0.7, 0.06, 'highpass'); tone('sine', 3200, 200, 0.3, 0.4); burst(0.4, 200, 0.5, 0.35); },
    smokePop() { burst(0.5, 500, 0.35, 0.4); tone('sine', 180, 90, 0.35, 0.2); },
    flashPop() {   // 闪光弹：炸响 + 高频耳鸣余音
      burst(0.25, 3000, 0.5, 0.2, 'highpass');
      tone('sine', 3600, 3400, 0.9, 0.16);
      tone('sine', 90, 40, 0.3, 0.3);
    },
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
    blink() { tone('sine', 1400, 200, 0.22, 0.2); burst(0.18, 3000, 0.14, 0.15, 'highpass'); },
    cast() { tone('sine', 300, 1100, 0.3, 0.16); tone('sine', 450, 1500, 0.3, 0.12, 0.06); },
    burstFire() { burst(0.12, 1800, 0.3, 0.1); tone('square', 220, 90, 0.08, 0.14); },
    zombie() { tone('sawtooth', 160, 70, 0.5, 0.3); tone('sawtooth', 220, 90, 0.5, 0.25, 0.15); },
    step() { burst(0.05, 500, 0.06, 0.045, 'bandpass'); },
    land() { burst(0.09, 350, 0.22, 0.08); tone('sine', 130, 70, 0.1, 0.16); },
    heartbeat() { tone('sine', 62, 45, 0.12, 0.3); tone('sine', 58, 42, 0.1, 0.24, 0.18); },
    ui() { tone('sine', 800, 950, 0.05, 0.1); },
  };
})();

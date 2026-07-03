'use strict';
// Canvas 卡通渲染：棋盘地板、道具、电锯、弹力柱、带脸的碰碰车、
// 粒子、漫画拟声字、伤害数字、屏幕震动、小地图。
const Render = (() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const mini = document.getElementById('minimap');
  const mctx = mini.getContext('2d');

  const cam = { x: 1600, y: 1100, shake: 0, sx: 0, sy: 0 };
  let zoom = 1;

  const particles = [];
  const bursts = [];    // 漫画拟声字
  const dmgNums = [];
  const wrecks = [];    // 死亡飞车
  const horns = new Map(); // playerId -> until
  const hitFlash = new Map(); // playerId -> time (挤压动画)

  const BOOM_WORDS = ['砰!!', '轰!!', '咣!!', 'POW!', 'BAM!', 'BOOM!'];
  const PICKUP_ICON = { wrench: '🔧', nitro: '⚡', shield: '🛡️', power: '⭐' };

  function resize() {
    canvas.width = window.innerWidth * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    zoom = Math.min(window.innerWidth / 1500, window.innerHeight / 950);
    zoom = Math.max(0.55, Math.min(zoom, 1.35)) * devicePixelRatio;
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- 粒子 ----------
  function spawnParticles(x, y, opts) {
    const n = opts.n || 8;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = (opts.speed || 200) * (0.4 + Math.random() * 0.8);
      particles.push({
        x, y,
        vx: Math.cos(ang) * sp + (opts.vx || 0),
        vy: Math.sin(ang) * sp + (opts.vy || 0),
        life: 1, decay: 1 / ((opts.dur || 0.5) * (0.6 + Math.random() * 0.8)),
        size: (opts.size || 6) * (0.6 + Math.random() * 0.9),
        color: Array.isArray(opts.color) ? opts.color[Math.floor(Math.random() * opts.color.length)] : opts.color,
        type: opts.type || 'spark',
        rot: Math.random() * Math.PI * 2,
        vrot: (Math.random() - 0.5) * 12
      });
    }
    if (particles.length > 900) particles.splice(0, particles.length - 900);
  }

  function addBurst(x, y, text, color, scale) {
    bursts.push({ x, y, text, color: color || '#ffca28', life: 1, rot: (Math.random() - 0.5) * 0.5, scale: scale || 1 });
  }
  function addDmg(x, y, dmg) {
    dmgNums.push({ x: x + (Math.random() - 0.5) * 30, y, life: 1, text: '-' + dmg });
  }

  function shake(power) { cam.shake = Math.min(cam.shake + power, 26); }

  // ---------- 事件 -> 特效 ----------
  function handleEvents(events, myId) {
    if (!events) return;
    const t = performance.now();
    for (const ev of events) {
      const near = dist(ev.x, ev.y, cam.x, cam.y) < 900;
      switch (ev.e) {
        case 'hit': {
          spawnParticles(ev.x, ev.y, { n: 10 + ev.p * 14, speed: 150 + ev.p * 350, color: ['#ffca28', '#ff9138', '#fff176'], type: 'spark', size: 6 });
          spawnParticles(ev.x, ev.y, { n: 5, speed: 90, color: ['#eceff1', '#cfd8dc'], type: 'smoke', dur: 0.8, size: 12 });
          if (ev.p > 0.45) {
            spawnParticles(ev.x, ev.y, { n: 6, speed: 260, color: ['#ffeb3b'], type: 'star', size: 10, dur: 0.7 });
            addBurst(ev.x, ev.y - 30, BOOM_WORDS[Math.floor(Math.random() * BOOM_WORDS.length)], '#ffca28', 0.8 + ev.p);
          }
          if (ev.d > 0) addDmg(ev.x, ev.y - 20, ev.d);
          if (ev.v) hitFlash.set(ev.v, t);
          if (near) { shake(ev.p * 14); GameAudio.hit(ev.p); }
          break;
        }
        case 'clank':
          spawnParticles(ev.x, ev.y, { n: 4, speed: 120, color: ['#fff176'], size: 4 });
          if (near) GameAudio.clank(ev.p);
          break;
        case 'bump':
          spawnParticles(ev.x, ev.y, { n: 8, speed: 220, color: ['#80deea', '#fff'], type: 'star', size: 8 });
          addBurst(ev.x, ev.y - 20, 'BOING!', '#26c6da', 0.7);
          if (near) { shake(4); GameAudio.bump(ev.p); }
          break;
        case 'wall':
          spawnParticles(ev.x, ev.y, { n: 6, speed: 160, color: ['#ffab91', '#eceff1'], size: 5 });
          if (near) { shake(ev.p * 8); GameAudio.wall(ev.p); }
          break;
        case 'saw':
          spawnParticles(ev.x, ev.y, { n: 22, speed: 380, color: ['#ff5252', '#ffca28', '#b0bec5'], size: 7 });
          addBurst(ev.x, ev.y - 30, '刺啦!!', '#ff5252', 1.1);
          if (near) { shake(10); GameAudio.saw(); }
          break;
        case 'pad':
          spawnParticles(ev.x, ev.y, { n: 8, speed: 150, color: ['#69f0ae', '#b9f6ca'], size: 6, dur: 0.4 });
          if (near) GameAudio.boostLoopHint();
          break;
        case 'pick':
          spawnParticles(ev.x, ev.y, { n: 12, speed: 180, color: ['#fff59d', '#a5d6a7', '#90caf9'], type: 'confetti', size: 6, dur: 0.7 });
          if (ev.id === myId || near) GameAudio.pickup();
          break;
        case 'die': {
          wrecks.push({
            x: ev.x, y: ev.y, vx: ev.vx * 1.6, vy: ev.vy * 1.6 - 260,
            angle: 0, spin: (Math.random() - 0.5) * 18,
            color: ev.c, life: 1.6
          });
          spawnParticles(ev.x, ev.y, { n: 30, speed: 420, color: ['#ff7043', '#ffca28', '#ef5350', '#fff176'], size: 9, dur: 0.9 });
          spawnParticles(ev.x, ev.y, { n: 14, speed: 120, color: ['#78909c', '#455a64'], type: 'smoke', size: 18, dur: 1.4 });
          spawnParticles(ev.x, ev.y, { n: 16, speed: 320, color: ['#ffd54f', '#4fc3f7', '#f48fb1', '#aed581'], type: 'confetti', size: 7, dur: 1.2 });
          addBurst(ev.x, ev.y - 40, 'KO!!', '#ff5252', 1.6);
          if (near || ev.id === myId || ev.by === myId) { shake(18); GameAudio.explode(); }
          break;
        }
        case 'spawn':
          spawnParticles(ev.x, ev.y, { n: 14, speed: 200, color: ['#80deea', '#fff'], type: 'star', size: 8, dur: 0.6 });
          if (ev.id === myId) GameAudio.spawn();
          break;
        case 'horn':
          horns.set(ev.id, t + 700);
          if (near) GameAudio.horn();
          break;
      }
    }
  }

  function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }

  // ---------- 主绘制 ----------
  function draw(dt, players, me) {
    const W = Net.state.world;
    const t = performance.now();

    // 摄像机跟随
    if (me) {
      cam.x += (me.x - cam.x) * Math.min(1, dt * 6);
      cam.y += (me.y - cam.y) * Math.min(1, dt * 6);
    }
    cam.shake *= Math.max(0, 1 - dt * 6);
    cam.sx = (Math.random() - 0.5) * cam.shake;
    cam.sy = (Math.random() - 0.5) * cam.shake;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#27703f'; // 场外草地
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!W) return;

    ctx.translate(canvas.width / 2 + cam.sx, canvas.height / 2 + cam.sy);
    ctx.scale(zoom, zoom);
    ctx.translate(-cam.x, -cam.y);

    const viewW = canvas.width / zoom, viewH = canvas.height / zoom;
    const vx0 = cam.x - viewW / 2 - 60, vy0 = cam.y - viewH / 2 - 60;
    const vx1 = cam.x + viewW / 2 + 60, vy1 = cam.y + viewH / 2 + 60;

    drawFloor(W, vx0, vy0, vx1, vy1);
    drawPads(W, t);
    drawBorder(W);
    drawPickups(t);
    drawBumpers(W, t);
    drawWrecks(dt);
    drawPlayers(players, me, t, dt);
    drawSaws(W, t);
    drawParticles(dt);
    drawBursts(dt);
    drawDmgNums(dt);

    // 冲刺速度线
    if (me && me.bo) drawSpeedLines(t);

    drawMinimap(players, me, W);
  }

  function drawFloor(W, vx0, vy0, vx1, vy1) {
    const S = 200;
    const x0 = Math.max(0, Math.floor(vx0 / S) * S);
    const y0 = Math.max(0, Math.floor(vy0 / S) * S);
    for (let x = x0; x < Math.min(W.w, vx1); x += S) {
      for (let y = y0; y < Math.min(W.h, vy1); y += S) {
        const even = ((x / S) + (y / S)) % 2 === 0;
        ctx.fillStyle = even ? '#4db36b' : '#45a862';
        ctx.fillRect(x, y, Math.min(S, W.w - x), Math.min(S, W.h - y));
      }
    }
  }

  function drawBorder(W) {
    // 红白相间的护栏
    const T = 26, SEG = 120;
    ctx.save();
    ctx.lineWidth = T;
    ctx.lineCap = 'butt';
    const edges = [
      [0, 0, W.w, 0], [W.w, 0, W.w, W.h],
      [W.w, W.h, 0, W.h], [0, W.h, 0, 0]
    ];
    for (const [x1, y1, x2, y2] of edges) {
      const len = Math.hypot(x2 - x1, y2 - y1);
      const n = Math.ceil(len / SEG);
      for (let i = 0; i < n; i++) {
        const f0 = i / n, f1 = (i + 1) / n;
        ctx.strokeStyle = i % 2 === 0 ? '#ef5350' : '#fafafa';
        ctx.beginPath();
        ctx.moveTo(x1 + (x2 - x1) * f0, y1 + (y2 - y1) * f0);
        ctx.lineTo(x1 + (x2 - x1) * f1, y1 + (y2 - y1) * f1);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = '#2b2233';
    ctx.lineWidth = 6;
    ctx.strokeRect(-T / 2 - 3, -T / 2 - 3, W.w + T + 6, W.h + T + 6);
    ctx.restore();
  }

  function drawPads(W, t) {
    for (const p of W.pads) {
      ctx.save();
      ctx.translate(p.x + p.w / 2, p.y + p.h / 2);
      ctx.fillStyle = 'rgba(38,198,218,.28)';
      roundRect(-p.w / 2, -p.h / 2, p.w, p.h, 14);
      ctx.fill();
      ctx.strokeStyle = 'rgba(38,198,218,.7)';
      ctx.lineWidth = 4;
      roundRect(-p.w / 2, -p.h / 2, p.w, p.h, 14);
      ctx.stroke();
      // 流动箭头
      ctx.rotate(p.dir);
      const long = Math.max(p.w, p.h);
      const off = ((t / 400) % 1) * 46;
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      for (let i = -1; i <= 1; i++) {
        const ax = -long / 2 + 30 + off + (i + 1) * 46;
        if (ax > long / 2 - 16) continue;
        ctx.beginPath();
        ctx.moveTo(ax - 12, -12); ctx.lineTo(ax, 0); ctx.lineTo(ax - 12, 12);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawBumpers(W, t) {
    for (const b of W.bumpers) {
      ctx.save();
      ctx.translate(b.x, b.y);
      // 阴影
      ctx.fillStyle = 'rgba(0,0,0,.25)';
      ctx.beginPath(); ctx.ellipse(4, 8, b.r, b.r * 0.9, 0, 0, Math.PI * 2); ctx.fill();
      // 底座
      circle(0, 0, b.r, '#e0e0e0', '#2b2233', 5);
      // 条纹环
      ctx.save();
      ctx.beginPath(); ctx.arc(0, 0, b.r - 8, 0, Math.PI * 2); ctx.clip();
      ctx.rotate(t / 4000);
      ctx.fillStyle = '#ef5350';
      for (let i = 0; i < 6; i++) {
        ctx.rotate(Math.PI / 3);
        ctx.fillRect(-b.r, -b.r / 5, b.r * 2, b.r / 2.5);
      }
      ctx.restore();
      ctx.beginPath(); ctx.arc(0, 0, b.r - 8, 0, Math.PI * 2);
      ctx.strokeStyle = '#2b2233'; ctx.lineWidth = 3; ctx.stroke();
      // 中心圆顶
      circle(0, 0, b.r * 0.42, '#ffca28', '#2b2233', 4);
      circle(-b.r * 0.12, -b.r * 0.12, b.r * 0.14, 'rgba(255,255,255,.8)', null, 0);
      ctx.restore();
    }
  }

  function drawSaws(W, t) {
    for (const s of W.saws) {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.fillStyle = 'rgba(0,0,0,.22)';
      ctx.beginPath(); ctx.ellipse(3, 6, s.r, s.r * 0.92, 0, 0, Math.PI * 2); ctx.fill();
      // 警戒圈
      ctx.strokeStyle = 'rgba(255,82,82,.5)';
      ctx.setLineDash([14, 10]);
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(0, 0, s.r + 16, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      // 旋转锯片
      ctx.rotate(t / 90);
      ctx.fillStyle = '#b0bec5';
      ctx.strokeStyle = '#2b2233';
      ctx.lineWidth = 4;
      ctx.beginPath();
      const teeth = 12;
      for (let i = 0; i < teeth; i++) {
        const a0 = (i / teeth) * Math.PI * 2;
        const a1 = ((i + 0.5) / teeth) * Math.PI * 2;
        const a2 = ((i + 1) / teeth) * Math.PI * 2;
        ctx.lineTo(Math.cos(a0) * s.r, Math.sin(a0) * s.r);
        ctx.lineTo(Math.cos(a1) * (s.r * 0.78), Math.sin(a1) * (s.r * 0.78));
        ctx.lineTo(Math.cos(a2) * s.r, Math.sin(a2) * s.r);
      }
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      circle(0, 0, s.r * 0.34, '#78909c', '#2b2233', 4);
      circle(0, 0, s.r * 0.12, '#37474f', null, 0);
      ctx.restore();
    }
  }

  function drawPickups(t) {
    const snap = Net.state.curSnap;
    if (!snap) return;
    for (const pk of snap.data.pickups) {
      const bob = Math.sin(t / 300 + pk.id) * 5;
      ctx.save();
      ctx.translate(pk.x, pk.y + bob);
      ctx.fillStyle = 'rgba(0,0,0,.2)';
      ctx.beginPath(); ctx.ellipse(0, 14 - bob, 16, 6, 0, 0, Math.PI * 2); ctx.fill();
      circle(0, 0, 19, 'rgba(255,255,255,.88)', '#2b2233', 3.5);
      ctx.font = '20px serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(PICKUP_ICON[pk.kind] || '❓', 0, 1);
      ctx.restore();
    }
  }

  // ---------- 车 ----------
  function drawPlayers(players, me, t, dt) {
    for (const p of players) {
      if (p.dd) continue;
      drawCar(p, p.id === (me && me.id), t);
    }
  }

  function drawCar(p, isMe, t) {
    const color = HUD.colorOf(p.c);
    const dark = shade(color, -35);
    const flash = hitFlash.get(p.id);
    let squash = 1;
    if (flash) {
      const age = (t - flash) / 260;
      if (age < 1) squash = 1 + Math.sin(age * Math.PI) * 0.25;
      else hitFlash.delete(p.id);
    }
    const wobble = p.sp ? Math.sin(t / 36) * Math.min(Math.abs(p.sp) * 0.045, 0.5) : 0;

    ctx.save();
    ctx.translate(p.x, p.y);

    // 阴影
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.beginPath(); ctx.ellipse(3, 7, 34, 26, 0, 0, Math.PI * 2); ctx.fill();

    ctx.rotate(p.a + wobble);
    ctx.scale(1 / squash, squash); // 挨撞时的挤压

    const L = 30, Wd = 22; // 半长/半宽

    // 尾部氮气火焰
    if (p.bo) {
      const fl = 18 + Math.random() * 16;
      ctx.fillStyle = 'rgba(255,145,0,.85)';
      ctx.beginPath();
      ctx.moveTo(-L - 2, -8); ctx.lineTo(-L - fl, 0); ctx.lineTo(-L - 2, 8);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,235,59,.9)';
      ctx.beginPath();
      ctx.moveTo(-L - 2, -4); ctx.lineTo(-L - fl * 0.55, 0); ctx.lineTo(-L - 2, 4);
      ctx.closePath(); ctx.fill();
    }

    // 轮子
    ctx.fillStyle = '#2b2233';
    roundRectFill(-L + 4, -Wd - 5, 15, 8, 3);
    roundRectFill(-L + 4, Wd - 3, 15, 8, 3);
    roundRectFill(L - 19, -Wd - 5, 15, 8, 3);
    roundRectFill(L - 19, Wd - 3, 15, 8, 3);

    // 车身
    ctx.fillStyle = color;
    ctx.strokeStyle = '#2b2233';
    ctx.lineWidth = 4;
    roundRect(-L, -Wd, L * 2, Wd * 2, 14);
    ctx.fill(); ctx.stroke();

    // 大保险杠（碰碰车灵魂）
    ctx.strokeStyle = dark;
    ctx.lineWidth = 7;
    roundRect(-L + 2, -Wd + 2, L * 2 - 4, Wd * 2 - 4, 11);
    ctx.stroke();

    // 引擎盖条纹
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    roundRectFill(2, -4, L - 6, 8, 4);

    // 驾驶员（头盔 + 眼睛）
    circle(-4, 0, 11, '#ffe0b2', '#2b2233', 3);
    ctx.fillStyle = dark;
    ctx.beginPath(); ctx.arc(-4, 0, 11, Math.PI * 0.6, Math.PI * 1.4); ctx.fill();
    // 眼睛看向前方；狂暴时变凶
    const angry = p.pw;
    ctx.fillStyle = '#2b2233';
    circle(0, -3.5, angry ? 2.6 : 2, '#2b2233', null, 0);
    circle(0, 3.5, angry ? 2.6 : 2, '#2b2233', null, 0);
    if (angry) {
      ctx.strokeStyle = '#c62828'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-3, -7); ctx.lineTo(3, -4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-3, 7); ctx.lineTo(3, 4); ctx.stroke();
    }

    ctx.restore();

    // ---- 车顶上方的世界空间装饰 ----
    ctx.save();
    ctx.translate(p.x, p.y);

    // 护盾泡泡
    if (p.sh) {
      const pulse = 1 + Math.sin(t / 120) * 0.05;
      ctx.strokeStyle = 'rgba(100,216,255,.9)';
      ctx.fillStyle = 'rgba(100,216,255,.16)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, 42 * pulse, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }
    // 狂暴光环
    if (p.pw) {
      ctx.strokeStyle = `rgba(255,82,82,${0.5 + Math.sin(t / 90) * 0.3})`;
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(0, 0, 38, 0, Math.PI * 2); ctx.stroke();
    }
    // 喇叭气泡
    const hornUntil = horns.get(p.id);
    if (hornUntil && t < hornUntil) {
      ctx.font = '22px serif'; ctx.textAlign = 'center';
      ctx.fillText('📢', 26, -38 - Math.sin(t / 60) * 3);
      ctx.strokeStyle = 'rgba(255,255,255,.6)';
      ctx.lineWidth = 2.5;
      const rr = ((t % 500) / 500) * 30 + 34;
      ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 2); ctx.stroke();
    } else if (hornUntil) horns.delete(p.id);

    // 名字 + 血条 + 皇冠
    ctx.textAlign = 'center';
    ctx.font = 'bold 15px "Baloo 2", "Microsoft YaHei", sans-serif';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    const label = (p.cr ? '👑 ' : '') + p.n;
    ctx.strokeText(label, 0, -46);
    ctx.fillStyle = isMe ? '#ffe082' : '#fff';
    ctx.fillText(label, 0, -46);

    const maxHp = Net.state.car.hp || 100;
    const hw = 56;
    ctx.fillStyle = 'rgba(0,0,0,.5)';
    roundRectFill(-hw / 2, -40, hw, 7, 3);
    const ratio = Math.max(0, p.hp / maxHp);
    ctx.fillStyle = ratio > 0.5 ? '#66bb6a' : ratio > 0.25 ? '#ffca28' : '#ef5350';
    if (ratio > 0) roundRectFill(-hw / 2 + 1, -39, (hw - 2) * ratio, 5, 2);

    ctx.restore();

    // 冲刺尾迹粒子
    if (p.bo && Math.random() < 0.7) {
      spawnParticles(p.x - Math.cos(p.a) * 30, p.y - Math.sin(p.a) * 30,
        { n: 1, speed: 40, color: ['#ff9138', '#ffca28'], type: 'smoke', size: 8, dur: 0.4 });
    }
  }

  // ---------- 残骸 / 粒子 / 文字 ----------
  function drawWrecks(dt) {
    for (let i = wrecks.length - 1; i >= 0; i--) {
      const w = wrecks[i];
      w.life -= dt;
      if (w.life <= 0) { wrecks.splice(i, 1); continue; }
      w.x += w.vx * dt;
      w.y += w.vy * dt;
      w.vy += 700 * dt;   // “重力”让车抛物线飞出去
      w.vx *= 0.99;
      w.angle += w.spin * dt;
      const s = Math.min(1, w.life / 1.6) * (1 + (1.6 - w.life) * 0.4);
      ctx.save();
      ctx.translate(w.x, w.y);
      ctx.rotate(w.angle);
      ctx.scale(s, s);
      ctx.globalAlpha = Math.min(1, w.life);
      ctx.fillStyle = shade(HUD.colorOf(w.color), -15);
      ctx.strokeStyle = '#2b2233';
      ctx.lineWidth = 4;
      roundRect(-26, -18, 52, 36, 10);
      ctx.fill(); ctx.stroke();
      ctx.font = '18px serif'; ctx.textAlign = 'center';
      ctx.fillText('💫', 0, -24);
      ctx.restore();
      if (Math.random() < 0.5) {
        spawnParticles(w.x, w.y, { n: 1, speed: 30, color: ['#78909c'], type: 'smoke', size: 10, dur: 0.6 });
      }
    }
  }

  function drawParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= p.decay * dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.96; p.vy *= 0.96;
      p.rot += p.vrot * dt;
      ctx.globalAlpha = Math.min(1, p.life);
      ctx.fillStyle = p.color;
      if (p.type === 'smoke') {
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.6 - p.life * 0.6), 0, Math.PI * 2); ctx.fill();
      } else if (p.type === 'star') {
        drawStar(p.x, p.y, p.size * p.life, p.rot, p.color);
      } else if (p.type === 'confetti') {
        ctx.save();
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      } else {
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * p.life * 0.6 + 1, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawStar(x, y, r, rot, color) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 === 0 ? r : r * 0.45;
      const a = (i / 10) * Math.PI * 2;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawBursts(dt) {
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      b.life -= dt * 1.1;
      if (b.life <= 0) { bursts.splice(i, 1); continue; }
      const pop = b.life > 0.85 ? (1 - b.life) / 0.15 : 1;
      ctx.save();
      ctx.translate(b.x, b.y - (1 - b.life) * 30);
      ctx.rotate(b.rot);
      ctx.scale(pop * b.scale, pop * b.scale);
      ctx.globalAlpha = Math.min(1, b.life * 2);
      // 底下的爆炸星形
      drawStar(0, 0, 46, b.rot * 2, 'rgba(255,255,255,.85)');
      drawStar(0, 0, 38, -b.rot, b.color);
      ctx.font = '900 30px "Baloo 2", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 6;
      ctx.strokeStyle = '#2b2233';
      ctx.strokeText(b.text, 0, 0);
      ctx.fillStyle = '#fff';
      ctx.fillText(b.text, 0, 0);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawDmgNums(dt) {
    ctx.textAlign = 'center';
    for (let i = dmgNums.length - 1; i >= 0; i--) {
      const d = dmgNums[i];
      d.life -= dt * 1.3;
      if (d.life <= 0) { dmgNums.splice(i, 1); continue; }
      d.y -= 55 * dt;
      ctx.globalAlpha = Math.min(1, d.life * 2);
      ctx.font = '900 22px "Baloo 2", "Microsoft YaHei", sans-serif';
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#2b2233';
      ctx.strokeText(d.text, d.x, d.y);
      ctx.fillStyle = '#ff8a80';
      ctx.fillText(d.text, d.x, d.y);
    }
    ctx.globalAlpha = 1;
  }

  function drawSpeedLines(t) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const cx = canvas.width / 2, cy = canvas.height / 2;
    ctx.strokeStyle = 'rgba(255,255,255,.16)';
    ctx.lineWidth = 3 * devicePixelRatio;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + (t / 300) % 1;
      const r0 = Math.min(cx, cy) * 0.75, r1 = Math.max(cx, cy) * 1.1;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
    }
  }

  // ---------- 小地图 ----------
  function drawMinimap(players, me, W) {
    const w = mini.width, h = mini.height;
    mctx.clearRect(0, 0, w, h);
    mctx.fillStyle = 'rgba(30,70,40,.9)';
    mctx.fillRect(0, 0, w, h);
    const sx = w / W.w, sy = h / W.h;
    for (const s of W.saws) {
      mctx.fillStyle = '#ef9a9a';
      mctx.beginPath(); mctx.arc(s.x * sx, s.y * sy, 4, 0, Math.PI * 2); mctx.fill();
    }
    for (const b of W.bumpers) {
      mctx.fillStyle = '#e0e0e0';
      mctx.beginPath(); mctx.arc(b.x * sx, b.y * sy, 3.4, 0, Math.PI * 2); mctx.fill();
    }
    for (const p of players) {
      if (p.dd) continue;
      const isMe = me && p.id === me.id;
      mctx.fillStyle = isMe ? '#fff' : HUD.colorOf(p.c);
      mctx.beginPath(); mctx.arc(p.x * sx, p.y * sy, isMe ? 4 : 3, 0, Math.PI * 2); mctx.fill();
      if (p.cr) { mctx.fillStyle = '#ffd54f'; mctx.fillRect(p.x * sx - 2, p.y * sy - 7, 4, 3); }
    }
  }

  // ---------- 小工具 ----------
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function roundRectFill(x, y, w, h, r) { roundRect(x, y, w, h, r); ctx.fill(); }
  function circle(x, y, r, fill, stroke, lw) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
  }
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) + amt, g = ((n >> 8) & 0xff) + amt, b = (n & 0xff) + amt;
    r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
    return `rgb(${r},${g},${b})`;
  }

  return { draw, handleEvents, shake, cam };
})();

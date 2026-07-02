'use strict';

// Canvas 渲染器：泡泡堂式 Q 版卡通风格，全部程序化绘制（无图片资源）。
// 地砖 / 砖块 / 炸弹 / 火焰 / 道具 / 怪物 / Q版小人 / 粒子特效 / 屏幕震动。

window.Renderer = (function () {
  const TS = 48; // 每格像素

  const PLAYER_COLORS = [
    ['#ff5a5a', '#c93a3a'], ['#4da3ff', '#2f7fd6'],
    ['#6fd44e', '#4aa930'], ['#ffd93d', '#d9ae14'],
    ['#ff8ad8', '#d65cae'], ['#b28dff', '#8a63d6'],
    ['#ff9f43', '#d67c1f'], ['#4dd6c1', '#2aab98'],
  ];
  const POWERUP_STYLE = [
    { icon: 'bomb', color: '#5a6acf' },
    { icon: 'fire', color: '#ff6b35' },
    { icon: 'speed', color: '#ffb800' },
    { icon: 'shield', color: '#39c5e8' },
  ];

  function create(canvas, cols, rows) {
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = cols * TS * dpr;
    canvas.height = rows * TS * dpr;

    const particles = [];
    const floatTexts = [];
    const fallingBlocks = [];
    const ghosts = [];
    const confetti = [];
    let shakeT = 0, shakeMag = 0;

    const px = (wx) => (wx + 0.5) * TS;

    // ---------- 特效接口 ----------

    function burst(wx, wy, n, colors, speed = 3, life = 0.6, grav = 6) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = (0.4 + Math.random() * 0.6) * speed;
        particles.push({
          x: px(wx), y: px(wy),
          vx: Math.cos(a) * v * TS, vy: Math.sin(a) * v * TS - TS,
          life: life * (0.5 + Math.random() * 0.5), t: 0,
          size: 3 + Math.random() * 5,
          color: colors[(Math.random() * colors.length) | 0],
          grav: grav * TS,
        });
      }
    }

    function addFloatText(wx, wy, text, color = '#fff') {
      floatTexts.push({ x: px(wx), y: px(wy) - 20, text, color, t: 0 });
    }

    function addFallingBlock(wx, wy) {
      fallingBlocks.push({ x: wx, y: wy, t: 0 });
    }

    function addDeathGhost(wx, wy, colorIdx) {
      ghosts.push({ x: px(wx), y: px(wy), t: 0, color: PLAYER_COLORS[colorIdx % 8][0] });
      burst(wx, wy, 16, [PLAYER_COLORS[colorIdx % 8][0], '#fff', '#ffd93d'], 4, 0.7);
    }

    function shake(mag = 5, dur = 0.25) {
      shakeMag = Math.max(shakeMag, mag);
      shakeT = Math.max(shakeT, dur);
    }

    function winConfetti() {
      for (let i = 0; i < 120; i++) {
        confetti.push({
          x: Math.random() * cols * TS,
          y: -Math.random() * rows * TS * 0.5,
          vy: (2 + Math.random() * 3) * TS * 0.5,
          vx: (Math.random() - 0.5) * TS,
          rot: Math.random() * Math.PI * 2,
          vr: (Math.random() - 0.5) * 8,
          size: 5 + Math.random() * 6,
          color: ['#ff5a5a', '#ffd93d', '#4da3ff', '#6fd44e', '#ff8ad8', '#b28dff'][(Math.random() * 6) | 0],
          t: 0,
        });
      }
    }

    // ---------- 基础图形 ----------

    function rr(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function drawFloor(gx, gy) {
      const x = gx * TS, y = gy * TS;
      ctx.fillStyle = (gx + gy) % 2 === 0 ? '#b8e986' : '#a5dd72';
      ctx.fillRect(x, y, TS, TS);
    }

    function drawWall(gx, gy) {
      const x = gx * TS, y = gy * TS;
      ctx.fillStyle = '#6b7a8f';
      rr(x + 1, y + 3, TS - 2, TS - 4, 8);
      ctx.fill();
      ctx.fillStyle = '#98a9bf';
      rr(x + 1, y + 1, TS - 2, TS - 8, 8);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.25)';
      rr(x + 6, y + 5, TS - 12, 8, 4);
      ctx.fill();
    }

    function drawBrick(gx, gy) {
      const x = gx * TS, y = gy * TS;
      ctx.fillStyle = '#b06a2c';
      rr(x + 2, y + 4, TS - 4, TS - 6, 7);
      ctx.fill();
      ctx.fillStyle = '#e0995a';
      rr(x + 2, y + 2, TS - 4, TS - 8, 7);
      ctx.fill();
      // 砖缝
      ctx.strokeStyle = 'rgba(120,60,20,.55)';
      ctx.lineWidth = 2;
      const v = (gx * 7 + gy * 13) % 2;
      ctx.beginPath();
      ctx.moveTo(x + 4, y + TS * 0.42);
      ctx.lineTo(x + TS - 4, y + TS * 0.42);
      ctx.moveTo(x + TS * (v ? 0.36 : 0.6), y + 5);
      ctx.lineTo(x + TS * (v ? 0.36 : 0.6), y + TS * 0.4);
      ctx.moveTo(x + TS * (v ? 0.64 : 0.34), y + TS * 0.45);
      ctx.lineTo(x + TS * (v ? 0.64 : 0.34), y + TS - 6);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.3)';
      rr(x + 6, y + 5, TS - 12, 6, 3);
      ctx.fill();
    }

    function drawShadow(cx, cy, r) {
      ctx.fillStyle = 'rgba(0,0,0,.2)';
      ctx.beginPath();
      ctx.ellipse(cx, cy + TS * 0.32, r, r * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---------- 炸弹 ----------

    function drawBomb(b, tNow) {
      const cx = px(b.x), cy = px(b.y);
      const urgency = Math.max(0, 1 - b.fuse / 2.6);
      const pulse = 1 + 0.07 * Math.sin(tNow * (6 + urgency * 18));
      const r = TS * 0.34 * pulse;
      drawShadow(cx, cy, r);
      const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
      g.addColorStop(0, '#5c6470');
      g.addColorStop(1, '#23272e');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      if (b.fuse < 0.8) {
        ctx.fillStyle = `rgba(255,80,60,${0.35 + 0.3 * Math.sin(tNow * 30)})`;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // 高光
      ctx.fillStyle = 'rgba(255,255,255,.5)';
      ctx.beginPath();
      ctx.ellipse(cx - r * 0.3, cy - r * 0.35, r * 0.22, r * 0.14, -0.6, 0, Math.PI * 2);
      ctx.fill();
      // 引信 + 火花
      ctx.strokeStyle = '#8a5a2c';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx + r * 0.1, cy - r * 0.9);
      ctx.quadraticCurveTo(cx + r * 0.5, cy - r * 1.3, cx + r * 0.8, cy - r * 1.1);
      ctx.stroke();
      const sx = cx + r * 0.8, sy = cy - r * 1.1;
      const sp = 2 + Math.sin(tNow * 25) * 1.5;
      ctx.fillStyle = '#ffd93d';
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = tNow * 8 + (i * Math.PI * 2) / 5;
        ctx.arc(sx + Math.cos(a) * sp, sy + Math.sin(a) * sp, 1.6, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    // ---------- 火焰 ----------

    function drawBlast(f, tNow) {
      const cx = px(f.x), cy = px(f.y);
      const phase = Math.min(1, f.age / 0.55);
      const s = Math.sin(Math.PI * phase); // 0→1→0
      const half = TS * 0.5 * (0.55 + 0.45 * s);
      const layers = [
        ['#ff8c42', 1.0],
        ['#ffd93d', 0.72],
        ['#fff8e1', 0.42],
      ];
      for (const [color, k] of layers) {
        ctx.fillStyle = color;
        const h = half * k;
        if (f.part === 0) {
          ctx.beginPath();
          ctx.arc(cx, cy, h * 1.15, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const vert = f.dir === 0 || f.dir === 1;
          if (vert) rr(cx - h, cy - TS * 0.5 - 1, h * 2, TS + 2, h);
          else rr(cx - TS * 0.5 - 1, cy - h, TS + 2, h * 2, h);
          ctx.fill();
        }
      }
    }

    // ---------- 道具 ----------

    function drawPowerup(u, tNow) {
      const bob = Math.sin(tNow * 3 + u.x * 1.7 + u.y) * 3;
      const cx = px(u.x), cy = px(u.y) + bob;
      const st = POWERUP_STYLE[u.kind] || POWERUP_STYLE[0];
      drawShadow(px(u.x), px(u.y), TS * 0.3);
      ctx.fillStyle = '#fffdf5';
      rr(cx - 15, cy - 15, 30, 30, 9);
      ctx.fill();
      ctx.strokeStyle = st.color;
      ctx.lineWidth = 3;
      rr(cx - 15, cy - 15, 30, 30, 9);
      ctx.stroke();
      ctx.save();
      ctx.translate(cx, cy);
      if (st.icon === 'bomb') {
        ctx.fillStyle = '#2f3542';
        ctx.beginPath();
        ctx.arc(0, 1.5, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#8a5a2c';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(2, -6);
        ctx.quadraticCurveTo(6, -11, 9, -9);
        ctx.stroke();
        ctx.fillStyle = '#ffd93d';
        ctx.beginPath();
        ctx.arc(9, -9, 2.4, 0, Math.PI * 2);
        ctx.fill();
      } else if (st.icon === 'fire') {
        ctx.fillStyle = '#ff6b35';
        ctx.beginPath();
        ctx.moveTo(0, -10);
        ctx.quadraticCurveTo(9, -2, 6, 6);
        ctx.quadraticCurveTo(3, 11, 0, 10);
        ctx.quadraticCurveTo(-3, 11, -6, 6);
        ctx.quadraticCurveTo(-9, -2, 0, -10);
        ctx.fill();
        ctx.fillStyle = '#ffd93d';
        ctx.beginPath();
        ctx.moveTo(0, -3);
        ctx.quadraticCurveTo(5, 2, 3, 7);
        ctx.quadraticCurveTo(0, 9.5, -3, 7);
        ctx.quadraticCurveTo(-5, 2, 0, -3);
        ctx.fill();
      } else if (st.icon === 'speed') {
        ctx.fillStyle = '#ffb800';
        ctx.beginPath();
        ctx.moveTo(3, -11);
        ctx.lineTo(-6, 2);
        ctx.lineTo(-1, 2);
        ctx.lineTo(-3, 11);
        ctx.lineTo(6, -2);
        ctx.lineTo(1, -2);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = '#39c5e8';
        ctx.beginPath();
        ctx.moveTo(0, -10);
        ctx.quadraticCurveTo(9, -8, 9, -2);
        ctx.quadraticCurveTo(9, 6, 0, 11);
        ctx.quadraticCurveTo(-9, 6, -9, -2);
        ctx.quadraticCurveTo(-9, -8, 0, -10);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.5)';
        ctx.beginPath();
        ctx.moveTo(0, -7);
        ctx.quadraticCurveTo(6, -5.5, 6, -1.5);
        ctx.quadraticCurveTo(6, 4, 0, 8);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    // ---------- 怪物 ----------

    function drawMonster(m, tNow) {
      const cx = px(m.ix), cy = px(m.iy);
      const wob = Math.sin(tNow * 6 + m.id);
      if (m.type === 1) drawGhostMonster(cx, cy, tNow, m);
      else drawSlime(cx, cy, tNow, m, m.type === 2 ? '#ff5a5a' : '#6fd44e',
        m.type === 2 ? '#c93a3a' : '#4aa930', wob);
    }

    function drawSlime(cx, cy, tNow, m, color, dark, wob) {
      const squish = 1 + wob * 0.12;
      const rw = TS * 0.36 * squish;
      const rh = TS * 0.32 / squish;
      drawShadow(cx, cy, rw);
      const g = ctx.createRadialGradient(cx - rw * 0.3, cy - rh * 0.5, 2, cx, cy, rw * 1.3);
      g.addColorStop(0, color);
      g.addColorStop(1, dark);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(cx, cy + TS * 0.08, rw, rh, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.45)';
      ctx.beginPath();
      ctx.ellipse(cx - rw * 0.35, cy - rh * 0.3, rw * 0.25, rh * 0.18, -0.5, 0, Math.PI * 2);
      ctx.fill();
      drawMonsterEyes(cx, cy, m.dir, 6, '#fff');
      if (m.type === 2) { // 小恶魔的角
        ctx.fillStyle = dark;
        ctx.beginPath();
        ctx.moveTo(cx - rw * 0.5, cy - rh * 0.5);
        ctx.lineTo(cx - rw * 0.7, cy - rh * 1.3);
        ctx.lineTo(cx - rw * 0.2, cy - rh * 0.8);
        ctx.moveTo(cx + rw * 0.5, cy - rh * 0.5);
        ctx.lineTo(cx + rw * 0.7, cy - rh * 1.3);
        ctx.lineTo(cx + rw * 0.2, cy - rh * 0.8);
        ctx.fill();
      }
    }

    function drawGhostMonster(cx, cy, tNow, m) {
      const r = TS * 0.32;
      const bob = Math.sin(tNow * 4 + m.id) * 3;
      cy += bob - 3;
      ctx.fillStyle = 'rgba(0,0,0,.12)';
      ctx.beginPath();
      ctx.ellipse(cx, cy + TS * 0.35 - bob, r * 0.8, r * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.4, 2, cx, cy, r * 1.5);
      g.addColorStop(0, '#d9c8ff');
      g.addColorStop(1, '#9a7fd6');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy - r * 0.2, r, Math.PI, 0);
      const hem = r * 0.85;
      const wave = tNow * 8 + m.id;
      ctx.lineTo(cx + r, cy + hem * 0.6);
      for (let i = 3; i >= -3; i--) {
        const wx = cx + (i / 3) * r;
        const wy = cy + hem * 0.6 + Math.sin(wave + i * 2) * 3 + (Math.abs(i) % 2 === 0 ? 6 : 0);
        ctx.quadraticCurveTo(wx + r / 6, cy + hem * 0.75, wx, wy);
      }
      ctx.closePath();
      ctx.fill();
      drawMonsterEyes(cx, cy - r * 0.25, m.dir, 5.5, '#fff');
    }

    function drawMonsterEyes(cx, cy, dir, size, white) {
      const look = [[0, -1.5], [0, 1.5], [-1.5, 0], [1.5, 0]][dir] || [0, 0];
      for (const side of [-1, 1]) {
        ctx.fillStyle = white;
        ctx.beginPath();
        ctx.arc(cx + side * size * 1.2, cy - 2, size * 0.75, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#2f3542';
        ctx.beginPath();
        ctx.arc(cx + side * size * 1.2 + look[0], cy - 2 + look[1], size * 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ---------- Q 版小人 ----------

    function drawPlayer(p, tNow, isMe) {
      const [color, dark] = PLAYER_COLORS[p.color % 8];
      const cx = px(p.ix);
      let cy = px(p.iy);
      const bob = p.moving ? Math.abs(Math.sin(tNow * 11 + p.id)) * 3.2 : Math.sin(tNow * 2.5 + p.id) * 1.2;
      cy -= bob;
      const r = TS * 0.36;

      if (p.inv) ctx.globalAlpha = 0.55 + 0.35 * Math.sin(tNow * 18);

      drawShadow(cx, cy + bob, r * 0.9);

      // 小脚丫
      ctx.fillStyle = dark;
      const step = p.moving ? Math.sin(tNow * 13 + p.id) * 4 : 0;
      ctx.beginPath();
      ctx.ellipse(cx - r * 0.4, cy + r * 0.72 + bob * 0.5 - Math.max(0, step), 6, 4, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + r * 0.4, cy + r * 0.72 + bob * 0.5 - Math.max(0, -step), 6, 4, 0, 0, Math.PI * 2);
      ctx.fill();

      // 圆滚滚的身体（大头娃娃）
      const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.45, 3, cx, cy, r * 1.4);
      g.addColorStop(0, color);
      g.addColorStop(1, dark);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.25)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // 肚皮
      ctx.fillStyle = 'rgba(255,255,255,.75)';
      ctx.beginPath();
      ctx.ellipse(cx, cy + r * 0.45, r * 0.5, r * 0.38, 0, 0, Math.PI * 2);
      ctx.fill();

      // 天线球
      ctx.strokeStyle = dark;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r * 0.95);
      ctx.quadraticCurveTo(cx + 3, cy - r * 1.3, cx + Math.sin(tNow * 5 + p.id) * 3, cy - r * 1.45);
      ctx.stroke();
      ctx.fillStyle = '#ffd93d';
      ctx.beginPath();
      ctx.arc(cx + Math.sin(tNow * 5 + p.id) * 3, cy - r * 1.5, 4.5, 0, Math.PI * 2);
      ctx.fill();

      // 大眼睛（看向移动方向）
      const look = [[0, -2.5], [0, 2.5], [-2.5, 0], [2.5, 0]][p.dir] || [0, 2.5];
      for (const side of [-1, 1]) {
        const ex = cx + side * r * 0.34, ey = cy - r * 0.15;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.ellipse(ex, ey, 6.5, 7.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#2f3542';
        ctx.beginPath();
        ctx.arc(ex + look[0] * 0.8, ey + look[1] * 0.8, 3.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(ex + look[0] * 0.8 - 1.2, ey + look[1] * 0.8 - 1.2, 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
      // 腮红 + 嘴巴
      ctx.fillStyle = 'rgba(255,120,140,.5)';
      ctx.beginPath();
      ctx.ellipse(cx - r * 0.62, cy + r * 0.05, 4, 2.6, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + r * 0.62, cy + r * 0.05, 4, 2.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#2f3542';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy + r * 0.18, 4, 0.2, Math.PI - 0.2);
      ctx.stroke();

      ctx.globalAlpha = 1;

      // 护盾泡泡
      if (p.shield) {
        const sr = r * 1.35 + Math.sin(tNow * 4) * 2;
        const sg = ctx.createRadialGradient(cx, cy, sr * 0.6, cx, cy, sr);
        sg.addColorStop(0, 'rgba(80,200,255,0)');
        sg.addColorStop(0.8, 'rgba(80,200,255,.25)');
        sg.addColorStop(1, 'rgba(140,230,255,.6)');
        ctx.fillStyle = sg;
        ctx.beginPath();
        ctx.arc(cx, cy, sr, 0, Math.PI * 2);
        ctx.fill();
      }

      // 名牌
      ctx.font = '700 11px "PingFang SC","Microsoft YaHei",sans-serif';
      const label = (isMe ? '★' : '') + p.name;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = isMe ? 'rgba(255,217,61,.92)' : 'rgba(255,255,255,.85)';
      rr(cx - tw / 2 - 6, cy - r - 26, tw + 12, 16, 8);
      ctx.fill();
      ctx.fillStyle = '#3a3350';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, cx, cy - r - 17.5);
    }

    // ---------- 特效更新与绘制 ----------

    function drawEffects(dt, tNow) {
      // 粒子
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.t += dt;
        if (p.t >= p.life) { particles.splice(i, 1); continue; }
        p.vy += p.grav * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const a = 1 - p.t / p.life;
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        rr(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size, p.size * 0.3);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // 死亡小幽灵
      for (let i = ghosts.length - 1; i >= 0; i--) {
        const gh = ghosts[i];
        gh.t += dt;
        if (gh.t > 1.4) { ghosts.splice(i, 1); continue; }
        const a = 1 - gh.t / 1.4;
        const gy = gh.y - gh.t * 40;
        ctx.globalAlpha = a * 0.9;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(gh.x, gy, 12, Math.PI, 0);
        ctx.lineTo(gh.x + 12, gy + 12);
        for (let k = 2; k >= -2; k--) {
          ctx.quadraticCurveTo(gh.x + k * 6 + 3, gy + 16, gh.x + k * 6, gy + 12);
        }
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#2f3542';
        ctx.beginPath();
        ctx.arc(gh.x - 4, gy - 2, 2, 0, Math.PI * 2);
        ctx.arc(gh.x + 4, gy - 2, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#2f3542';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(gh.x, gy + 3, 2.5, 0, Math.PI);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // 飘字
      ctx.font = '900 15px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      for (let i = floatTexts.length - 1; i >= 0; i--) {
        const ft = floatTexts[i];
        ft.t += dt;
        if (ft.t > 1) { floatTexts.splice(i, 1); continue; }
        ctx.globalAlpha = 1 - ft.t;
        ctx.strokeStyle = 'rgba(0,0,0,.5)';
        ctx.lineWidth = 3;
        ctx.strokeText(ft.text, ft.x, ft.y - ft.t * 34);
        ctx.fillStyle = ft.color;
        ctx.fillText(ft.text, ft.x, ft.y - ft.t * 34);
      }
      ctx.globalAlpha = 1;

      // 彩带
      for (let i = confetti.length - 1; i >= 0; i--) {
        const c = confetti[i];
        c.t += dt;
        if (c.t > 4 || c.y > rows * TS + 20) { confetti.splice(i, 1); continue; }
        c.x += c.vx * dt + Math.sin(c.t * 5 + c.rot) * 0.8;
        c.y += c.vy * dt;
        c.rot += c.vr * dt;
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.rotate(c.rot);
        ctx.fillStyle = c.color;
        ctx.fillRect(-c.size / 2, -c.size / 4, c.size, c.size / 2);
        ctx.restore();
      }
    }

    function drawFallingBlocks(dt) {
      for (let i = fallingBlocks.length - 1; i >= 0; i--) {
        const fb = fallingBlocks[i];
        fb.t += dt;
        if (fb.t > 0.28) {
          burst(fb.x, fb.y, 6, ['#98a9bf', '#d5dde8'], 2, 0.4);
          fallingBlocks.splice(i, 1);
          continue;
        }
        const k = fb.t / 0.28;
        const yOff = (1 - k * k) * -TS * 2.2;
        ctx.save();
        ctx.translate(0, yOff);
        drawWall(fb.x, fb.y);
        ctx.restore();
      }
    }

    // ---------- 主渲染 ----------

    let lastT = performance.now() / 1000;

    function render(view) {
      const tNow = performance.now() / 1000;
      const dt = Math.min(0.05, tNow - lastT);
      lastT = tNow;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // 屏幕震动
      if (shakeT > 0) {
        shakeT -= dt;
        const m = shakeMag * (shakeT > 0 ? shakeT / 0.25 : 0);
        ctx.translate((Math.random() - 0.5) * m * 2, (Math.random() - 0.5) * m * 2);
        if (shakeT <= 0) shakeMag = 0;
      }

      const grid = view.grid;
      if (!grid) return;

      // 地板与静态块
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          drawFloor(x, y);
        }
      }
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const v = grid[y][x];
          if (v === 1) drawWall(x, y);
          else if (v === 2) drawBrick(x, y);
        }
      }

      for (const u of view.powerups) drawPowerup(u, tNow);
      for (const b of view.bombs) drawBomb(b, tNow);
      for (const f of view.blasts) drawBlast(f, tNow);
      drawFallingBlocks(dt);
      for (const m of view.monsters) drawMonster(m, tNow);
      // 按 y 排序绘制玩家，制造前后遮挡关系
      const alive = view.players.filter((p) => p.alive).sort((a, b) => a.iy - b.iy);
      for (const p of alive) drawPlayer(p, tNow, p.id === view.myId);

      drawEffects(dt, tNow);
    }

    return {
      render, burst, addFloatText, addFallingBlock, addDeathGhost, shake, winConfetti,
      TS,
    };
  }

  return { create, TS, PLAYER_COLORS };
})();

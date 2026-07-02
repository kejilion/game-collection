'use strict';

// Canvas 渲染器：泡泡堂式 Q 版卡通风格，全部程序化绘制（无图片资源）。
// 大世界摄像机跟随 + 视口裁剪 + 小地图；地砖/砖块/炸弹/火焰/道具/
// 怪物/Q版小人/粒子特效/屏幕震动。

window.Renderer = (function () {
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

  function create(canvas, minimapCanvas, cols, rows, tileSize) {
    const ctx = canvas.getContext('2d');
    const mctx = minimapCanvas.getContext('2d');
    const TS = tileSize || 48;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    let viewW = 800, viewH = 600; // CSS 像素
    const cam = { x: (cols * TS) / 2, y: (rows * TS) / 2 }; // 世界像素，视口中心

    const particles = [];
    const floatTexts = [];
    const growBlocks = [];
    const ghosts = [];
    const spawnFx = [];
    let spotlightUntil = 0; // 出生聚光灯结束时刻（墙钟秒，低帧率下也不拖长）
    const SPOT_DUR = 2.4;
    let shakeT = 0, shakeMag = 0;
    let lastMinimap = 0;

    const px = (wx) => (wx + 0.5) * TS;

    function resize(w, h) {
      viewW = w; viewH = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      // 小地图保持世界纵横比，宽 ~168px
      const mw = 168;
      const mh = Math.round((mw * rows) / cols);
      minimapCanvas.width = mw;
      minimapCanvas.height = mh;
      minimapCanvas.style.width = mw + 'px';
      minimapCanvas.style.height = mh + 'px';
    }

    function clampCam() {
      const worldW = cols * TS, worldH = rows * TS;
      const hw = viewW / 2, hh = viewH / 2;
      cam.x = worldW <= viewW ? worldW / 2 : Math.max(hw, Math.min(worldW - hw, cam.x));
      cam.y = worldH <= viewH ? worldH / 2 : Math.max(hh, Math.min(worldH - hh, cam.y));
    }

    // 摄像机瞄准某个世界坐标（格），带边界钳制与平滑
    function aimCamera(fx, fy, dt) {
      const tx = px(fx), ty = px(fy);
      const k = Math.min(1, dt * 8);
      cam.x += (tx - cam.x) * k;
      cam.y += (ty - cam.y) * k;
      clampCam();
    }

    // 出生/重生：镜头立即切过去，不做飞行过渡
    function snapCamera(fx, fy) {
      cam.x = px(fx);
      cam.y = px(fy);
      clampCam();
    }

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

    function addGrowBlock(wx, wy) {
      growBlocks.push({ x: wx, y: wy, t: 0 });
    }

    // 出生特效：全场压暗聚光灯 + 光柱 + 扩散光环 + 弹跳箭头“你在这里”
    function addSpawnFx(wx, wy) {
      spawnFx.push({ x: wx, y: wy, t: 0 });
      spotlightUntil = performance.now() / 1000 + SPOT_DUR;
      burst(wx, wy, 14, ['#ffd93d', '#fff', '#a5dd72'], 3, 0.6);
    }

    // 聚光灯：压暗全场，亮圈从大到小收缩聚焦到自己身上
    function drawSpotlight(view, tNow) {
      const remain = spotlightUntil - tNow;
      if (remain <= 0) return;
      const me = view.players.find((p) => p.id === view.myId && p.alive);
      if (!me) return;
      const t = SPOT_DUR - remain;
      const cx = px(me.ix), cy = px(me.iy);
      // 亮圈半径：0.8 秒内从 8 格收缩到 2.4 格（缓出）
      const ease = 1 - Math.pow(1 - Math.min(1, t / 0.8), 3);
      const rIn = TS * (8 - 5.6 * ease);
      const rOut = rIn * 2.1;
      // 快速压暗，最后 0.8 秒淡出
      let alpha = 0.78 * Math.min(1, t / 0.15);
      if (remain < 0.8) alpha *= remain / 0.8;
      const g = ctx.createRadialGradient(cx, cy, rIn, cx, cy, rOut);
      g.addColorStop(0, 'rgba(8,12,28,0)');
      g.addColorStop(1, `rgba(8,12,28,${alpha})`);
      ctx.fillStyle = g;
      ctx.fillRect(cam.x - viewW / 2 - TS, cam.y - viewH / 2 - TS, viewW + TS * 2, viewH + TS * 2);
    }

    function addDeathGhost(wx, wy, colorIdx) {
      ghosts.push({ x: px(wx), y: px(wy), t: 0 });
      burst(wx, wy, 16, [PLAYER_COLORS[colorIdx % 8][0], '#fff', '#ffd93d'], 4, 0.7);
    }

    function shake(mag = 5, dur = 0.25) {
      shakeMag = Math.max(shakeMag, mag);
      shakeT = Math.max(shakeT, dur);
    }

    // 世界坐标是否在视野附近（特效降噪用）
    function inView(wx, wy, margin = 3) {
      const x = px(wx), y = px(wy);
      return Math.abs(x - cam.x) < viewW / 2 + margin * TS &&
             Math.abs(y - cam.y) < viewH / 2 + margin * TS;
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
      ctx.fillStyle = 'rgba(255,255,255,.5)';
      ctx.beginPath();
      ctx.ellipse(cx - r * 0.3, cy - r * 0.35, r * 0.22, r * 0.14, -0.6, 0, Math.PI * 2);
      ctx.fill();
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
      // 快过期时闪烁
      if (u.ttl < 6 && Math.sin(tNow * 10) > 0.2) return;
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
      else if (m.type === 3) drawSlime(cx, cy, tNow, m, '#ffd24a', '#d9a412', wob, true);
      else if (m.type === 2) drawSlime(cx, cy, tNow, m, '#ff5a5a', '#c93a3a', wob, false);
      else drawSlime(cx, cy, tNow, m, '#6fd44e', '#4aa930', wob, false);
    }

    function drawSlime(cx, cy, tNow, m, color, dark, wob, golden) {
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
      if (golden) {
        // 金光闪闪
        ctx.fillStyle = `rgba(255,240,150,${0.4 + 0.3 * Math.sin(tNow * 8)})`;
        for (let i = 0; i < 3; i++) {
          const a = tNow * 3 + (i * Math.PI * 2) / 3;
          const sx = cx + Math.cos(a) * rw * 1.2;
          const sy = cy - rh * 0.4 + Math.sin(a) * rh * 0.9;
          ctx.beginPath();
          ctx.arc(sx, sy, 2, 0, Math.PI * 2);
          ctx.fill();
        }
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

    function drawPlayer(p, tNow, isMe, isTop) {
      const [color, dark] = PLAYER_COLORS[p.color % 8];
      const cx = px(p.ix);
      let cy = px(p.iy);
      const bob = p.moving ? Math.abs(Math.sin(tNow * 11 + p.id)) * 3.2 : Math.sin(tNow * 2.5 + p.id) * 1.2;
      cy -= bob;
      const r = TS * 0.36;

      if (p.inv) ctx.globalAlpha = 0.55 + 0.35 * Math.sin(tNow * 18);

      drawShadow(cx, cy + bob, r * 0.9);

      // 自己脚下的常驻金圈，随时能在人群里找到自己
      if (isMe) {
        const pu = 0.6 + 0.4 * Math.sin(tNow * 4);
        ctx.strokeStyle = `rgba(255,217,61,${0.35 + 0.35 * pu})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(cx, cy + bob + TS * 0.32, r * 1.2, r * 0.5, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

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

      // 领跑者皇冠
      if (isTop) {
        const gy = cy - r - 30 + Math.sin(tNow * 3) * 2;
        ctx.fillStyle = '#ffd24a';
        ctx.strokeStyle = '#d9a412';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx - 9, gy + 7);
        ctx.lineTo(cx - 9, gy);
        ctx.lineTo(cx - 4.5, gy + 4);
        ctx.lineTo(cx, gy - 3);
        ctx.lineTo(cx + 4.5, gy + 4);
        ctx.lineTo(cx + 9, gy);
        ctx.lineTo(cx + 9, gy + 7);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
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

      // 聊天气泡
      if (p.bubble) {
        ctx.globalAlpha = p.bubble.alpha;
        ctx.font = '600 11px "PingFang SC","Microsoft YaHei",sans-serif';
        let txt = p.bubble.text;
        if (txt.length > 26) txt = txt.slice(0, 25) + '…';
        const bw = ctx.measureText(txt).width + 16;
        const by = cy - r - 54;
        ctx.fillStyle = 'rgba(255,255,255,.95)';
        rr(cx - bw / 2, by, bw, 20, 10);
        ctx.fill();
        ctx.beginPath(); // 气泡小尾巴
        ctx.moveTo(cx - 4, by + 19);
        ctx.lineTo(cx + 4, by + 19);
        ctx.lineTo(cx, by + 26);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#3a3350';
        ctx.fillText(txt, cx, by + 10.5);
        ctx.globalAlpha = 1;
      }
    }

    // ---------- 特效更新与绘制 ----------

    function drawEffects(dt, tNow) {
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.t += dt;
        if (p.t >= p.life) { particles.splice(i, 1); continue; }
        p.vy += p.grav * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        ctx.globalAlpha = 1 - p.t / p.life;
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
        const gy = gh.y - gh.t * 40;
        ctx.globalAlpha = (1 - gh.t / 1.4) * 0.9;
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
    }

    // 出生特效
    function drawSpawnFx(dt, tNow) {
      for (let i = spawnFx.length - 1; i >= 0; i--) {
        const fx = spawnFx[i];
        fx.t += dt;
        if (fx.t > 2.6) { spawnFx.splice(i, 1); continue; }
        const cx = px(fx.x), cy = px(fx.y);
        // 地面扩散光环 ×3
        for (let k = 0; k < 3; k++) {
          const ph = (fx.t - k * 0.22) / 0.9;
          if (ph < 0 || ph > 1) continue;
          ctx.globalAlpha = (1 - ph) * 0.85;
          ctx.strokeStyle = k === 1 ? '#fff' : '#ffd93d';
          ctx.lineWidth = 5 - ph * 3;
          ctx.beginPath();
          ctx.ellipse(cx, cy + TS * 0.3, TS * (0.25 + ph * 1.5), TS * (0.12 + ph * 0.75), 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        // 落地光柱（第一秒）
        if (fx.t < 1) {
          const a = 1 - fx.t;
          const g = ctx.createLinearGradient(0, cy - TS * 3.2, 0, cy + TS * 0.3);
          g.addColorStop(0, 'rgba(255,240,150,0)');
          g.addColorStop(1, `rgba(255,230,120,${0.5 * a})`);
          ctx.globalAlpha = 1;
          ctx.fillStyle = g;
          const wHalf = TS * (0.32 + 0.06 * Math.sin(fx.t * 20));
          ctx.fillRect(cx - wHalf, cy - TS * 3.2, wHalf * 2, TS * 3.5);
        }
        // 弹跳箭头 + “你在这里”
        const bounce = Math.abs(Math.sin(fx.t * 5)) * 10;
        const ay = cy - TS * 1.6 - bounce;
        ctx.globalAlpha = fx.t > 2.1 ? (2.6 - fx.t) / 0.5 : 1;
        ctx.fillStyle = '#ffd93d';
        ctx.strokeStyle = 'rgba(0,0,0,.45)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(cx - 12, ay - 18);
        ctx.lineTo(cx + 12, ay - 18);
        ctx.lineTo(cx, ay);
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
        ctx.font = '900 13px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.strokeText('你在这里', cx, ay - 30);
        ctx.fillStyle = '#fff';
        ctx.fillText('你在这里', cx, ay - 30);
        ctx.globalAlpha = 1;
      }
    }

    // 砖块再生动画（从地里长出来）
    function drawGrowBlocks(dt) {
      for (let i = growBlocks.length - 1; i >= 0; i--) {
        const gb = growBlocks[i];
        gb.t += dt;
        if (gb.t > 0.35) { growBlocks.splice(i, 1); continue; }
        const k = gb.t / 0.35;
        ctx.save();
        ctx.translate((gb.x + 0.5) * TS, (gb.y + 1) * TS);
        ctx.scale(1, k);
        ctx.translate(-(gb.x + 0.5) * TS, -(gb.y + 1) * TS);
        drawBrick(gb.x, gb.y);
        ctx.restore();
      }
    }

    // ---------- 小地图 ----------

    function drawMinimap(view) {
      const mw = minimapCanvas.width, mh = minimapCanvas.height;
      const sx = mw / cols, sy = mh / rows;
      mctx.clearRect(0, 0, mw, mh);
      mctx.fillStyle = 'rgba(20,26,46,.9)';
      mctx.fillRect(0, 0, mw, mh);
      const grid = view.grid;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const v = grid[y][x];
          if (v === 1) mctx.fillStyle = '#55617a';
          else if (v === 2) mctx.fillStyle = '#a5713a';
          else continue;
          mctx.fillRect(x * sx, y * sy, sx + 0.5, sy + 0.5);
        }
      }
      // 道具
      mctx.fillStyle = '#ffe066';
      for (const u of view.powerups) mctx.fillRect(u.x * sx, u.y * sy, sx, sy);
      // 怪物
      for (const m of view.monsters) {
        mctx.fillStyle = m.type === 3 ? '#ffd24a' : '#ff6b6b';
        mctx.beginPath();
        mctx.arc((m.ix + 0.5) * sx, (m.iy + 0.5) * sy, 1.8, 0, Math.PI * 2);
        mctx.fill();
      }
      // 玩家
      for (const p of view.players) {
        if (!p.alive) continue;
        mctx.fillStyle = PLAYER_COLORS[p.color % 8][0];
        mctx.beginPath();
        mctx.arc((p.ix + 0.5) * sx, (p.iy + 0.5) * sy, p.id === view.myId ? 3 : 2.2, 0, Math.PI * 2);
        mctx.fill();
        if (p.id === view.myId) {
          mctx.strokeStyle = '#fff';
          mctx.lineWidth = 1.2;
          mctx.stroke();
        }
      }
      // 视口范围框
      const vx = (cam.x - viewW / 2) / TS * sx;
      const vy = (cam.y - viewH / 2) / TS * sy;
      mctx.strokeStyle = 'rgba(255,255,255,.55)';
      mctx.lineWidth = 1;
      mctx.strokeRect(vx, vy, (viewW / TS) * sx, (viewH / TS) * sy);
    }

    // ---------- 主渲染 ----------

    let lastT = performance.now() / 1000;

    function render(view) {
      const tNow = performance.now() / 1000;
      const dt = Math.min(0.05, tNow - lastT);
      lastT = tNow;

      if (view.follow) aimCamera(view.follow.x, view.follow.y, dt);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // 视口外底色
      ctx.fillStyle = '#22304f';
      ctx.fillRect(0, 0, viewW, viewH);

      let ox = viewW / 2 - cam.x, oy = viewH / 2 - cam.y;
      if (shakeT > 0) {
        shakeT -= dt;
        const m = shakeMag * Math.max(0, shakeT / 0.25);
        ox += (Math.random() - 0.5) * m * 2;
        oy += (Math.random() - 0.5) * m * 2;
        if (shakeT <= 0) shakeMag = 0;
      }
      ctx.translate(ox, oy);

      const grid = view.grid;
      if (!grid) return;

      // 可见范围裁剪
      const x0 = Math.max(0, Math.floor((cam.x - viewW / 2) / TS) - 1);
      const x1 = Math.min(cols - 1, Math.ceil((cam.x + viewW / 2) / TS) + 1);
      const y0 = Math.max(0, Math.floor((cam.y - viewH / 2) / TS) - 1);
      const y1 = Math.min(rows - 1, Math.ceil((cam.y + viewH / 2) / TS) + 1);

      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          ctx.fillStyle = (x + y) % 2 === 0 ? '#b8e986' : '#a5dd72';
          ctx.fillRect(x * TS, y * TS, TS, TS);
        }
      }
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const v = grid[y][x];
          if (v === 1) drawWall(x, y);
          else if (v === 2) drawBrick(x, y);
        }
      }

      const vis = (e) => e.x >= x0 - 1 && e.x <= x1 + 1 && e.y >= y0 - 1 && e.y <= y1 + 1;
      for (const u of view.powerups) if (vis(u)) drawPowerup(u, tNow);
      for (const b of view.bombs) if (vis(b)) drawBomb(b, tNow);
      for (const f of view.blasts) if (vis(f)) drawBlast(f, tNow);
      drawGrowBlocks(dt);
      for (const m of view.monsters) {
        if (m.ix >= x0 - 1 && m.ix <= x1 + 1 && m.iy >= y0 - 1 && m.iy <= y1 + 1) drawMonster(m, tNow);
      }
      const alive = view.players.filter((p) => p.alive).sort((a, b) => a.iy - b.iy);
      for (const p of alive) {
        if (p.ix >= x0 - 1 && p.ix <= x1 + 1 && p.iy >= y0 - 1 && p.iy <= y1 + 1) {
          drawPlayer(p, tNow, p.id === view.myId, p.id === view.topId && view.players.length > 1);
        }
      }

      drawSpotlight(view, tNow); // 先压暗，再画箭头/光环保证特效全亮
      drawSpawnFx(dt, tNow);
      drawEffects(dt, tNow);

      // 小地图节流重绘
      if (tNow - lastMinimap > 0.15) {
        lastMinimap = tNow;
        drawMinimap(view);
      }
    }

    return {
      render, resize, burst, addFloatText, addGrowBlock, addDeathGhost, addSpawnFx,
      snapCamera, shake, inView,
      cam, TS,
    };
  }

  return { create, PLAYER_COLORS };
})();

// ============================================================================
//  Renderer — all canvas drawing. Procedural cartoon art, no image assets.
//  main.js prepares an interpolated `view` each frame and calls draw().
// ============================================================================
const Renderer = (() => {
  let cv, ctx, mm, mmx;
  let W = { width: 3200, height: 2200 };
  let CLASSES = {}, ITEMS = {};
  let vw = 0, vh = 0, dpr = 1;
  let camX = 0, camY = 0;
  let decor = [];
  const particles = [], floaters = [], rings = [], slashes = [], dashes = [];
  const projPrev = new Map();
  let shake = 0;

  function init(canvasEl, minimapEl) {
    cv = canvasEl; ctx = cv.getContext('2d');
    mm = minimapEl; mmx = mm.getContext('2d');
    window.addEventListener('resize', resize); resize();
  }
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = cv.clientWidth; vh = cv.clientHeight;
    cv.width = Math.floor(vw * dpr); cv.height = Math.floor(vh * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function setWorld(dims, classes, items) {
    W = dims; CLASSES = classes; ITEMS = items;
    decor = [];
    const n = Math.floor((W.width * W.height) / 90000);
    for (let i = 0; i < n; i++) {
      decor.push({ x: Math.random() * W.width, y: Math.random() * W.height,
        r: 40 + Math.random() * 120, h: Math.random() * 360, a: 0.04 + Math.random() * 0.05 });
    }
  }

  // ---- effects spawned from server fx events ------------------------------
  function spawnFx(e) {
    switch (e.t) {
      case 'dmg': floaters.push({ x: e.x, y: e.y, v: e.v, crit: e.crit, life: 0.9, vy: -42, dmg: true }); break;
      case 'swing': slashes.push({ x: e.x, y: e.y, ang: e.ang, range: e.range, arc: e.arc, color: e.color, life: 0.22, max: 0.22 }); break;
      case 'slash': burst(e.x, e.y, e.color || '#fff', e.crit ? 14 : 8, e.crit ? 3.4 : 2.4); if (e.crit) shake = Math.max(shake, 5); break;
      case 'hit': burst(e.x, e.y, e.color || '#fff', 7, 2.2); break;
      case 'cast': for (let i = 0; i < (e.big ? 16 : 8); i++) burst(e.x, e.y, '#7fb0ff', 1, 2); break;
      case 'explosion': rings.push({ x: e.x, y: e.y, r: 8, max: e.radius, life: 0.45, color: '#ff8a3d', fill: true }); burst(e.x, e.y, '#ffb347', 26, 4); shake = Math.max(shake, 9); break;
      case 'whirlwind': rings.push({ x: e.x, y: e.y, r: 8, max: e.radius, life: 0.5, color: e.color }); for (let i = 0; i < 22; i++) burst(e.x, e.y, e.color, 1, 4); shake = Math.max(shake, 6); break;
      case 'slam': rings.push({ x: e.x, y: e.y, r: 10, max: e.radius, life: 0.55, color: '#ff4d4d', fill: true }); shake = Math.max(shake, 10); break;
      case 'dash': dashes.push({ x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, color: e.color, life: 0.3, max: 0.3 }); break;
      case 'pickup': for (let i = 0; i < 10; i++) burst(e.x, e.y, e.color, 1, 2.6); floaters.push({ x: e.x, y: e.y - 24, v: e.icon, life: 0.8, vy: -34, text: true, color: e.color }); break;
      case 'spawn': rings.push({ x: e.x, y: e.y, r: 4, max: 46, life: 0.5, color: e.color }); break;
      case 'death': burst(e.x, e.y, e.color, 26, 4); break;
      case 'revive': rings.push({ x: e.x, y: e.y, r: 4, max: 50, life: 0.5, color: '#ff7ab8' }); break;
      case 'levelup': rings.push({ x: e.x, y: e.y, r: 6, max: 60, life: 0.7, color: '#ffd23f' }); floaters.push({ x: e.x, y: e.y - 40, v: 'LEVEL UP!', life: 1.2, vy: -26, text: true, color: '#ffd23f' }); break;
      case 'bossCast': rings.push({ x: e.x, y: e.y, r: 10, max: 90, life: 0.4, color: '#ff5a3c' }); break;
    }
  }
  function burst(x, y, color, count, spd) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, s = (0.4 + Math.random()) * spd * 30;
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.5 + Math.random() * 0.3, max: 0.8, color, r: 2 + Math.random() * 2 });
    }
  }

  // ---- main draw ----------------------------------------------------------
  function draw(view, dt) {
    // self-heal: if layout size drifted (e.g. after a display:none→block switch), re-measure
    if (cv.clientWidth && (cv.clientWidth !== vw || cv.clientHeight !== vh)) resize();
    const self = view.self;
    const tx = self ? self.x : (view.lastX || W.width / 2);
    const ty = self ? self.y : (view.lastY || W.height / 2);
    camX = clamp(tx - vw / 2, 0, Math.max(0, W.width - vw));
    camY = clamp(ty - vh / 2, 0, Math.max(0, W.height - vh));
    let sx = 0, sy = 0;
    if (shake > 0.2) { sx = (Math.random() - 0.5) * shake; sy = (Math.random() - 0.5) * shake; shake *= 0.86; } else shake = 0;

    ctx.clearRect(0, 0, vw, vh);
    ctx.save();
    ctx.translate(-camX + sx, -camY + sy);

    drawGround();
    // depth order: items < projectiles < merchants < boss < players
    for (const it of view.items) drawItem(it);
    drawRings(dt, false);
    for (const pr of view.projectiles) drawProjectile(pr, dt);
    for (const m of view.merchants) drawMerchant(m);
    for (const b of view.bosses) drawBoss(b);
    drawSlashes(dt);
    drawDashes(dt);
    // sort players by y for nice overlap
    const ps = view.players.slice().sort((a, b) => a.y - b.y);
    for (const p of ps) drawPlayer(p, p.id === view.selfId);
    drawRings(dt, true);
    drawParticles(dt);
    drawFloaters(dt);

    ctx.restore();
    drawMinimap(view);
  }

  // ---- ground -------------------------------------------------------------
  function drawGround() {
    const x0 = camX, y0 = camY;
    const g = ctx.createLinearGradient(0, y0, 0, y0 + vh);
    g.addColorStop(0, '#16204a'); g.addColorStop(1, '#0d1430');
    ctx.fillStyle = g; ctx.fillRect(x0, y0, vw, vh);
    // soft decorative blobs
    for (const d of decor) {
      if (d.x < x0 - d.r || d.x > x0 + vw + d.r || d.y < y0 - d.r || d.y > y0 + vh + d.r) continue;
      ctx.fillStyle = `hsla(${d.h},70%,60%,${d.a})`;
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 7); ctx.fill();
    }
    // grid
    ctx.strokeStyle = 'rgba(255,255,255,.045)'; ctx.lineWidth = 1;
    const step = 64;
    ctx.beginPath();
    for (let x = Math.floor(x0 / step) * step; x < x0 + vw; x += step) { ctx.moveTo(x, y0); ctx.lineTo(x, y0 + vh); }
    for (let y = Math.floor(y0 / step) * step; y < y0 + vh; y += step) { ctx.moveTo(x0, y); ctx.lineTo(x0 + vw, y); }
    ctx.stroke();
    // glowing world border
    ctx.strokeStyle = 'rgba(120,170,255,.5)'; ctx.lineWidth = 6;
    ctx.shadowColor = 'rgba(120,170,255,.6)'; ctx.shadowBlur = 18;
    ctx.strokeRect(3, 3, W.width - 6, W.height - 6);
    ctx.shadowBlur = 0;
  }

  // ---- entities -----------------------------------------------------------
  function shadow(x, y, r) {
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    ctx.beginPath(); ctx.ellipse(x, y + r * 0.92, r * 0.85, r * 0.4, 0, 0, 7); ctx.fill();
  }
  function roundBody(x, y, r, fill, line) {
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.4, r * 0.2, x, y, r);
    g.addColorStop(0, lighten(fill, 30)); g.addColorStop(1, fill);
    ctx.fillStyle = g; ctx.strokeStyle = line; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.stroke();
  }
  function eyes(x, y, r, facing, scale = 1) {
    const dx = Math.cos(facing) * r * 0.22, dy = Math.sin(facing) * r * 0.18;
    for (const s of [-1, 1]) {
      const ex = x + s * r * 0.32, ey = y - r * 0.12;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ex, ey, r * 0.2 * scale, 0, 7); ctx.fill();
      ctx.fillStyle = '#1a1a2e'; ctx.beginPath(); ctx.arc(ex + dx, ey + dy, r * 0.1 * scale, 0, 7); ctx.fill();
    }
  }

  function drawPlayer(p, isSelf) {
    const r = 21;
    const bob = p.moving ? Math.sin(performance.now() / 90 + p.x) * 3 : Math.sin(performance.now() / 600 + p.y) * 1.2;
    const x = p.x, y = p.y + bob;
    const cls = CLASSES[p.cls] || { color: '#888', name: '?' };
    const ghost = p.invis ? 0.4 : 1;
    ctx.globalAlpha = ghost;
    shadow(x, p.y, r);

    // weapon behind for some facings
    drawWeapon(x, y, r, p.facing, p.cls, cls.color);
    roundBody(x, y, r, cls.color, '#1c2140');
    // class hat/hood
    drawHeadgear(x, y, r, p.cls, cls);
    eyes(x, y, r, p.facing);

    // spawn protection shield
    if (p.prot) {
      ctx.strokeStyle = 'rgba(120,200,255,.8)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r + 6 + Math.sin(performance.now() / 120) * 2, 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // nameplate + bars
    nameplate(x, p.y - r, p, isSelf, cls);

    // chat bubble
    if (p.chat) chatBubble(x, p.y - r - (isSelf ? 50 : 44), p.chat);
  }

  function drawWeapon(x, y, r, facing, clsId, color) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(facing);
    ctx.lineCap = 'round';
    if (clsId === 'warrior') {                 // big sword
      ctx.strokeStyle = '#dfe6f5'; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(r * 0.4, 8); ctx.lineTo(r + 18, 8); ctx.stroke();
      ctx.strokeStyle = '#8a6a3a'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(r * 0.2, 8); ctx.lineTo(r * 0.5, 8); ctx.stroke();
    } else if (clsId === 'mage') {              // staff with orb
      ctx.strokeStyle = '#a9763f'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(0, 6); ctx.lineTo(r + 12, 6); ctx.stroke();
      ctx.fillStyle = '#7fb0ff'; ctx.shadowColor = '#7fb0ff'; ctx.shadowBlur = 10; ctx.beginPath(); ctx.arc(r + 14, 6, 6, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
    } else {                                    // dagger
      ctx.strokeStyle = '#e6d4ff'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(r * 0.3, 7); ctx.lineTo(r + 8, 7); ctx.stroke();
    }
    ctx.restore();
  }
  function drawHeadgear(x, y, r, clsId, cls) {
    if (clsId === 'mage') {                      // pointed hat
      ctx.fillStyle = darken(cls.color, 18); ctx.strokeStyle = '#1c2140'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x - r * 0.7, y - r * 0.5); ctx.lineTo(x + r * 0.7, y - r * 0.5); ctx.lineTo(x, y - r * 1.7); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffe08a'; ctx.beginPath(); ctx.arc(x, y - r * 1.7, 3, 0, 7); ctx.fill();
    } else if (clsId === 'warrior') {            // helmet band
      ctx.strokeStyle = '#cdd6ea'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(x, y - r * 0.1, r * 0.92, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
    } else {                                     // assassin hood
      ctx.fillStyle = darken(cls.color, 22);
      ctx.beginPath(); ctx.arc(x, y - r * 0.2, r * 0.95, Math.PI * 1.05, Math.PI * 1.95); ctx.lineTo(x, y - r * 0.2); ctx.fill();
    }
  }

  function drawBoss(b) {
    const r = 60;
    const x = b.x, y = b.y + Math.sin(performance.now() / 500) * 2;
    shadow(x, b.y, r);
    // spiky aura
    ctx.fillStyle = 'rgba(255,60,40,.12)'; ctx.beginPath(); ctx.arc(x, y, r + 16, 0, 7); ctx.fill();
    // horns
    ctx.fillStyle = '#2a0d14';
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(x + s * r * 0.5, y - r * 0.7); ctx.lineTo(x + s * r * 0.9, y - r * 1.25); ctx.lineTo(x + s * r * 0.25, y - r * 0.4); ctx.closePath(); ctx.fill(); }
    roundBody(x, y, r, '#9e2b2b', '#350a0a');
    // angry eyes
    ctx.fillStyle = '#ffe14d';
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(x + s * r * 0.32, y - r * 0.08, r * 0.16, r * 0.1, s * 0.4, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#3a0000';
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(x + s * r * 0.32, y - r * 0.06, r * 0.06, 0, 7); ctx.fill(); }
    // mouth
    ctx.strokeStyle = '#3a0000'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(x, y + r * 0.25, r * 0.4, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();

    // name + hp
    ctx.font = '800 16px "Baloo 2","Noto Sans SC"'; ctx.textAlign = 'center';
    ctx.fillStyle = '#ff6a6a'; ctx.fillText('☠ ' + b.name, x, y - r - 20);
    bar(x - 70, y - r - 14, 140, 9, b.hp / b.maxHp, '#ff3d3d', '#5a0e0e');
  }

  function drawMerchant(m) {
    const r = 22;
    const x = m.x, y = m.y + Math.sin(performance.now() / 420 + m.x) * 2;
    shadow(x, m.y, r);
    roundBody(x, y, r, '#37b07a', '#16402c');
    // straw-hat
    ctx.fillStyle = '#d9a441'; ctx.beginPath(); ctx.ellipse(x, y - r * 0.7, r * 1.05, r * 0.35, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x, y - r * 0.95, r * 0.5, r * 0.4, 0, 0, 7); ctx.fill();
    eyes(x, y, r, 0, 0.9);
    // floating coin
    const cy = y - r - 16 + Math.sin(performance.now() / 300) * 3;
    ctx.fillStyle = '#ffd23f'; ctx.shadowColor = '#ffd23f'; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(x, cy, 7, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = '#a8780a'; ctx.font = '800 10px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('$', x, cy + 3.5);
    ctx.font = '700 12px "Noto Sans SC"'; ctx.fillStyle = '#bfe8cf'; ctx.fillText('神秘商人', x, m.y - r - 26);
  }

  function drawItem(it) {
    const def = ITEMS[it.type] || { color: '#fff', icon: '?' };
    const t = performance.now() / 1000;
    const bob = Math.sin(t * 2.2 + it.x) * 4;
    const x = it.x, y = it.y + bob, r = 13;
    // glow
    ctx.fillStyle = hexA(def.color, 0.22); ctx.beginPath(); ctx.arc(x, y, r + 7 + Math.sin(t * 3) * 2, 0, 7); ctx.fill();
    shadow(x, it.y + 6, r * 0.8);
    // gem
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.sin(t + it.x) * 0.15);
    const g = ctx.createLinearGradient(0, -r, 0, r); g.addColorStop(0, lighten(def.color, 40)); g.addColorStop(1, def.color);
    ctx.fillStyle = g; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 2;
    roundRect(-r, -r, r * 2, r * 2, 7); ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#fff'; ctx.font = '800 15px "Baloo 2"'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(def.icon, x, y + 1); ctx.textBaseline = 'alphabetic';
  }

  function drawProjectile(pr, dt) {
    const prev = projPrev.get(pr.id);
    let ang = 0; if (prev) ang = Math.atan2(pr.y - prev.y, pr.x - prev.x);
    projPrev.set(pr.id, { x: pr.x, y: pr.y, seen: performance.now() });
    const x = pr.x, y = pr.y;
    if (pr.type === 'fireball') {
      ctx.fillStyle = 'rgba(255,140,40,.3)'; ctx.beginPath(); ctx.arc(x, y, pr.r + 8, 0, 7); ctx.fill();
      const g = ctx.createRadialGradient(x, y, 2, x, y, pr.r); g.addColorStop(0, '#fff2b0'); g.addColorStop(.5, '#ff9b2e'); g.addColorStop(1, '#ff3d1a');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, pr.r, 0, 7); ctx.fill();
    } else if (pr.type === 'orb') {
      ctx.shadowColor = '#ff5a2a'; ctx.shadowBlur = 10; ctx.fillStyle = '#ff7a3d';
      ctx.beginPath(); ctx.arc(x, y, pr.r, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
    } else {                                    // bolt
      ctx.strokeStyle = 'rgba(150,190,255,.5)'; ctx.lineWidth = pr.r * 1.6; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x - Math.cos(ang) * 16, y - Math.sin(ang) * 16); ctx.lineTo(x, y); ctx.stroke();
      ctx.shadowColor = '#9fc4ff'; ctx.shadowBlur = 8; ctx.fillStyle = '#dcebff';
      ctx.beginPath(); ctx.arc(x, y, pr.r, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
    }
  }

  // ---- nameplate / bars / bubble -----------------------------------------
  function nameplate(x, topY, p, isSelf, cls) {
    bar(x - 26, topY - 12, 52, 7, p.hp / p.maxHp, '#ff4d63', '#3a0c14');
    ctx.font = '800 13px "Baloo 2","Noto Sans SC"'; ctx.textAlign = 'center';
    const label = `${p.name}`;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.strokeText(label, x, topY - 18);
    ctx.fillStyle = isSelf ? '#9be7ff' : '#fff'; ctx.fillText(label, x, topY - 18);
    // class + level chip
    ctx.font = '800 10px "Baloo 2"';
    ctx.fillStyle = cls.color; ctx.fillText(`${cls.name} Lv.${p.level}`, x, topY - 31);
  }
  function bar(x, y, w, h, frac, color, back) {
    frac = clamp(frac, 0, 1);
    ctx.fillStyle = back; roundRect(x, y, w, h, h / 2); ctx.fill();
    ctx.fillStyle = color; roundRect(x, y, w * frac, h, h / 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 1; roundRect(x, y, w, h, h / 2); ctx.stroke();
  }
  function chatBubble(x, y, text) {
    ctx.font = '700 13px "Noto Sans SC"'; const w = Math.min(ctx.measureText(text).width + 20, 220);
    ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.strokeStyle = 'rgba(0,0,0,.15)'; ctx.lineWidth = 1;
    roundRect(x - w / 2, y - 24, w, 24, 12); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 7); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#1a2140'; ctx.textAlign = 'center'; ctx.fillText(text.length > 18 ? text.slice(0, 18) + '…' : text, x, y - 8);
  }

  // ---- transient effect layers -------------------------------------------
  function drawParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]; p.life -= dt; if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92;
      ctx.globalAlpha = clamp(p.life / p.max, 0, 1); ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  function drawFloaters(dt) {
    ctx.textAlign = 'center';
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i]; f.life -= dt; if (f.life <= 0) { floaters.splice(i, 1); continue; }
      f.y += f.vy * dt; f.vy *= 0.94;
      ctx.globalAlpha = clamp(f.life * 1.4, 0, 1);
      if (f.text) {
        ctx.font = '800 15px "Baloo 2","Noto Sans SC"'; ctx.fillStyle = f.color || '#fff';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.strokeText(f.v, f.x, f.y); ctx.fillText(f.v, f.x, f.y);
      } else {
        ctx.font = `800 ${f.crit ? 22 : 15}px "Baloo 2"`;
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.55)';
        ctx.fillStyle = f.crit ? '#ffd23f' : '#ffd9dc';
        const s = (f.crit ? '✸' : '') + f.v;
        ctx.strokeText(s, f.x, f.y); ctx.fillText(s, f.x, f.y);
      }
    }
    ctx.globalAlpha = 1;
  }
  function drawRings(dt, over) {
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      if (!!r.fill !== over) continue;          // fill rings drawn under players
      r.life -= dt; if (r.life <= 0) { rings.splice(i, 1); continue; }
      const k = 1 - r.life / (r.maxLife || (r.maxLife = r.life + dt));
      const rad = r.r + (r.max - r.r) * easeOut(k);
      ctx.globalAlpha = clamp(r.life * 2, 0, 0.8);
      if (r.fill) { ctx.fillStyle = hexA(r.color, 0.18); ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, 7); ctx.fill(); }
      ctx.strokeStyle = r.color; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function drawSlashes(dt) {
    for (let i = slashes.length - 1; i >= 0; i--) {
      const s = slashes[i]; s.life -= dt; if (s.life <= 0) { slashes.splice(i, 1); continue; }
      const k = s.life / s.max;
      ctx.globalAlpha = k * 0.7;
      ctx.fillStyle = hexA(s.color, 0.5);
      ctx.beginPath(); ctx.moveTo(s.x, s.y);
      ctx.arc(s.x, s.y, s.range, s.ang - s.arc / 2, s.ang + s.arc / 2); ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  function drawDashes(dt) {
    for (let i = dashes.length - 1; i >= 0; i--) {
      const d = dashes[i]; d.life -= dt; if (d.life <= 0) { dashes.splice(i, 1); continue; }
      ctx.globalAlpha = d.life / d.max; ctx.strokeStyle = d.color; ctx.lineWidth = 14; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(d.x1, d.y1); ctx.lineTo(d.x2, d.y2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ---- minimap ------------------------------------------------------------
  function drawMinimap(view) {
    const MW = mm.width, MH = mm.height;
    const sxk = MW / W.width, syk = MH / W.height;
    mmx.clearRect(0, 0, MW, MH);
    mmx.fillStyle = 'rgba(10,16,40,.9)'; mmx.fillRect(0, 0, MW, MH);
    // items
    for (const it of view.items) { const d = ITEMS[it.type]; mmx.fillStyle = hexA(d ? d.color : '#fff', .5); mmx.fillRect(it.x * sxk - 1, it.y * syk - 1, 2, 2); }
    // merchants
    mmx.fillStyle = '#ffd23f'; for (const m of view.merchants) { mmx.beginPath(); mmx.arc(m.x * sxk, m.y * syk, 3, 0, 7); mmx.fill(); }
    // boss
    mmx.fillStyle = '#ff3d3d'; for (const b of view.bosses) { mmx.beginPath(); mmx.arc(b.x * sxk, b.y * syk, 4, 0, 7); mmx.fill(); }
    // players
    for (const p of view.players) {
      const cls = CLASSES[p.cls] || { color: '#fff' };
      mmx.fillStyle = p.id === view.selfId ? '#9be7ff' : cls.color;
      mmx.beginPath(); mmx.arc(p.x * sxk, p.y * syk, p.id === view.selfId ? 4 : 3, 0, 7); mmx.fill();
    }
    // viewport rect
    mmx.strokeStyle = 'rgba(255,255,255,.5)'; mmx.lineWidth = 1;
    mmx.strokeRect(camX * sxk, camY * syk, vw * sxk, vh * syk);
  }

  // ---- utils --------------------------------------------------------------
  function roundRect(x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function hexA(hex, a) { const c = hx(hex); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; }
  function lighten(hex, amt) { const c = hx(hex); return `rgb(${cl(c[0] + amt)},${cl(c[1] + amt)},${cl(c[2] + amt)})`; }
  function darken(hex, amt) { return lighten(hex, -amt); }
  function cl(v) { return Math.max(0, Math.min(255, v | 0)); }
  function hx(hex) { hex = hex.replace('#', ''); if (hex.length === 3) hex = hex.split('').map(c => c + c).join(''); return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]; }

  // periodically forget stale projectile-trail entries
  setInterval(() => { const t = performance.now(); for (const [k, v] of projPrev) if (t - v.seen > 500) projPrev.delete(k); }, 1000);

  return { init, resize, setWorld, spawnFx, draw, get cam() { return { x: camX, y: camY }; } };
})();

// ============================================================================
//  Renderer — all canvas drawing. Procedural cartoon art, no image assets.
//  main.js prepares an interpolated `view` each frame and calls draw().
// ============================================================================
const Renderer = (() => {
  let cv, ctx, mm, mmx;
  let W = { width: 3200, height: 2200 };
  let CLASSES = {}, ITEMS = {}, BOSS = {};
  let vw = 0, vh = 0, dpr = 1;
  let camX = 0, camY = 0;
  let decor = [];
  let obstacles = [];
  const particles = [], floaters = [], rings = [], slashes = [], dashes = [];
  const projPrev = new Map();
  const itemSeen = new Map();      // item id -> first-seen time, for pop-in animation
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
  function setWorld(dims, classes, items, bosses) {
    W = dims; CLASSES = classes; ITEMS = items; BOSS = bosses || {};
    decor = [];
    const n = Math.floor((W.width * W.height) / 90000);
    for (let i = 0; i < n; i++) {
      decor.push({ x: Math.random() * W.width, y: Math.random() * W.height,
        r: 40 + Math.random() * 120, h: Math.random() * 360, a: 0.04 + Math.random() * 0.05 });
    }
  }
  function setObstacles(list) { obstacles = list || []; }

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
      // warrior 铁壁战吼: golden brace ring + a shield bloom + rising green heal motes
      case 'warcry':
        rings.push({ x: e.x, y: e.y, r: 10, max: e.radius, life: 0.5, color: '#ffd766', fill: true });
        rings.push({ x: e.x, y: e.y, r: 6, max: 52, life: 0.55, color: '#ffe9a8' });
        for (let i = 0; i < 16; i++) burst(e.x, e.y, '#ffd766', 1, 3);
        for (let i = 0; i < 10; i++) { const a = Math.random() * Math.PI * 2; particles.push({ x: e.x + Math.cos(a) * 22, y: e.y + Math.sin(a) * 22, vx: 0, vy: -60 - Math.random() * 50, life: 0.6, max: 0.8, color: '#8ef0a8', r: 2.6 }); }
        shake = Math.max(shake, 7); break;
      // mage 霜雪新星: icy fill ring + inner frost ring + cyan/white shards
      case 'frost':
        rings.push({ x: e.x, y: e.y, r: 10, max: e.radius, life: 0.5, color: e.color || '#7fd8ff', fill: true });
        rings.push({ x: e.x, y: e.y, r: 8, max: e.radius * 0.7, life: 0.45, color: '#dff4ff' });
        for (let i = 0; i < 22; i++) burst(e.x, e.y, i % 2 ? '#bfeaff' : '#7fd8ff', 1, 3.4);
        shake = Math.max(shake, 6); break;
      // assassin 影遁: smoke puff + fading dash trail + an implosion ring at the landing spot
      case 'veil':
        dashes.push({ x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, color: hexA(e.color || '#a368ff', 0.6), life: 0.3, max: 0.3 });
        rings.push({ x: e.x1, y: e.y1, r: 6, max: 56, life: 0.4, color: '#9aa3b2' });
        for (let i = 0; i < 16; i++) burst(e.x1, e.y1, i % 2 ? '#b6a0d8' : '#7c7c8a', 1, 3);
        rings.push({ x: e.x2, y: e.y2, r: 30, max: 6, life: 0.3, color: e.color || '#a368ff' });
        break;
      case 'slam': rings.push({ x: e.x, y: e.y, r: 10, max: e.radius, life: 0.55, color: '#ff4d4d', fill: true }); shake = Math.max(shake, 10); break;
      // generic boss ring AOE (slam / charge-nova / drain pulse), tinted by archetype
      case 'shock': {
        rings.push({ x: e.x, y: e.y, r: 10, max: e.radius, life: 0.55, color: e.color || '#ff4d4d', fill: true });
        if (e.drain) for (let i = 0; i < 16; i++) {           // drain pulls motes inward toward the boss
          const a = Math.random() * Math.PI * 2, d = e.radius * (0.5 + Math.random() * 0.5);
          particles.push({ x: e.x + Math.cos(a) * d, y: e.y + Math.sin(a) * d, vx: -Math.cos(a) * 90, vy: -Math.sin(a) * 90, life: 0.5, max: 0.6, color: e.color || '#9bf0c4', r: 2.5 });
        }
        shake = Math.max(shake, Math.min(14, e.radius / 18));
        break;
      }
      case 'dash': dashes.push({ x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, color: e.color, life: 0.3, max: 0.3 }); break;
      // charger telegraph: an arrow/ring at the wind-up spot showing the incoming lane
      case 'bossCharge': {
        rings.push({ x: e.x, y: e.y, r: 8, max: 70, life: 0.55, color: e.color || '#bfe6ff' });
        const ex = e.x + Math.cos(e.ang) * e.dist, ey = e.y + Math.sin(e.ang) * e.dist;
        dashes.push({ x1: e.x, y1: e.y, x2: ex, y2: ey, color: hexA(e.color || '#bfe6ff', 0.5), life: 0.6, max: 0.6 });
        break;
      }
      // teleport: collapse ring at the old spot, bloom ring at the new one
      case 'blink':
        rings.push({ x: e.x, y: e.y, r: 36, max: 6, life: 0.32, color: e.color || '#caa8ff' });
        rings.push({ x: e.x2, y: e.y2, r: 6, max: 48, life: 0.42, color: e.color || '#caa8ff' });
        for (let i = 0; i < 10; i++) burst(e.x2, e.y2, e.color || '#caa8ff', 1, 2.6);
        break;
      case 'bossEnrage':
        rings.push({ x: e.x, y: e.y, r: 10, max: 130, life: 0.6, color: e.color || '#ff5a3c', fill: true });
        floaters.push({ x: e.x, y: e.y - 70, v: '狂暴！', life: 1.1, vy: -24, text: true, color: e.color || '#ff5a3c' });
        shake = Math.max(shake, 12);
        break;
      case 'bossSpawn':
        for (let k = 0; k < 2; k++) rings.push({ x: e.x, y: e.y, r: 8, max: 120 + k * 70, life: 0.7 + k * 0.15, color: e.color || '#ff6a6a' });
        floaters.push({ x: e.x, y: e.y - 60, v: '☠ ' + (e.name || 'BOSS') + ' 降临', life: 1.6, vy: -18, text: true, color: e.color || '#ff6a6a' });
        break;
      case 'pickup': {
        for (let i = 0; i < 12; i++) burst(e.x, e.y, e.color, 1, 2.8);
        rings.push({ x: e.x, y: e.y, r: 6, max: 38, life: 0.4, color: e.color });
        const nm = (ITEMS[e.type] || {}).name || '';
        floaters.push({ x: e.x, y: e.y - 26, v: (e.icon ? e.icon + ' ' : '') + nm, life: 1.0, vy: -36, text: true, color: e.color });
        break;
      }
      case 'spawn': rings.push({ x: e.x, y: e.y, r: 4, max: 46, life: 0.5, color: e.color }); break;
      case 'death':
        burst(e.x, e.y, e.color, 36, 5); burst(e.x, e.y, '#ffffff', 10, 3);
        rings.push({ x: e.x, y: e.y, r: 6, max: 72, life: 0.5, color: e.color });
        rings.push({ x: e.x, y: e.y, r: 6, max: 44, life: 0.4, color: '#ffffff' });
        floaters.push({ x: e.x, y: e.y - 28, v: 'K.O.', life: 1.1, vy: -28, text: true, color: '#ffffff' });
        shake = Math.max(shake, 11);
        break;
      case 'bossDeath':
        for (let k = 0; k < 3; k++) rings.push({ x: e.x, y: e.y, r: 8, max: 150 + k * 60, life: 0.6 + k * 0.12, color: k % 2 ? '#ffd23f' : '#ff5a3c', fill: k === 0 });
        burst(e.x, e.y, '#ffb347', 50, 6); burst(e.x, e.y, '#fff2b0', 24, 4);
        floaters.push({ x: e.x, y: e.y - 50, v: 'BOSS 倒下！', life: 1.5, vy: -22, text: true, color: '#ffd23f' });
        shake = Math.max(shake, 22);
        break;
      case 'loot':
        for (let i = 0; i < Math.min(40, (e.count || 1) * 4); i++) burst(e.x, e.y, i % 2 ? '#ffd23f' : '#fff2b0', 1, 4.5);
        break;
      case 'revive': rings.push({ x: e.x, y: e.y, r: 4, max: 50, life: 0.5, color: '#ff7ab8' }); break;
      case 'levelup': rings.push({ x: e.x, y: e.y, r: 6, max: 60, life: 0.7, color: '#ffd23f' }); floaters.push({ x: e.x, y: e.y - 40, v: 'LEVEL UP!', life: 1.2, vy: -26, text: true, color: '#ffd23f' }); break;
      case 'bossCast': rings.push({ x: e.x, y: e.y, r: 10, max: 90, life: 0.4, color: e.color || '#ff5a3c' }); break;
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
    drawObstacles();
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

  function drawObstacles() {
    const x0 = camX, y0 = camY;
    for (const o of obstacles) {
      if (o.x < x0 - o.r - 40 || o.x > x0 + vw + o.r + 40 || o.y < y0 - o.r - 40 || o.y > y0 + vh + o.r + 40) continue;
      shadow(o.x, o.y, o.r);
      if (o.type === 'crate') {
        const s = o.r * 1.5;
        ctx.save(); ctx.translate(o.x, o.y);
        const g = ctx.createLinearGradient(-s / 2, -s / 2, s / 2, s / 2);
        g.addColorStop(0, '#bd8744'); g.addColorStop(1, '#875525');
        ctx.fillStyle = g; ctx.strokeStyle = '#553616'; ctx.lineWidth = 4;
        roundRect(-s / 2, -s / 2, s, s, 8); ctx.fill(); ctx.stroke();
        ctx.lineWidth = 3; ctx.beginPath();
        ctx.moveTo(-s / 2, -s / 2); ctx.lineTo(s / 2, s / 2);
        ctx.moveTo(s / 2, -s / 2); ctx.lineTo(-s / 2, s / 2); ctx.stroke();
        ctx.restore();
      } else {
        const g = ctx.createRadialGradient(o.x - o.r * 0.3, o.y - o.r * 0.4, o.r * 0.2, o.x, o.y, o.r);
        g.addColorStop(0, '#9aa3b5'); g.addColorStop(1, '#4d5564');
        ctx.fillStyle = g; ctx.strokeStyle = '#333a48'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, 7); ctx.fill(); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,.12)';
        ctx.beginPath(); ctx.ellipse(o.x - o.r * 0.25, o.y - o.r * 0.3, o.r * 0.42, o.r * 0.26, -0.5, 0, 7); ctx.fill();
      }
    }
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
    const def = BOSS[b.type] || {};
    const r = b.r || def.radius || 60;
    const col = def.color || '#9e2b2b';
    const acc = def.accent || '#ff6a6a';
    const x = b.x, y = b.y + Math.sin(performance.now() / 500) * 2;
    shadow(x, b.y, r);
    // aura — pulses red & wider while enraged, else a soft archetype-colored glow
    const pulse = b.enraged ? 0.2 + Math.sin(performance.now() / 90) * 0.08 : 0.12;
    ctx.fillStyle = hexA(b.enraged ? '#ff3322' : acc, pulse);
    ctx.beginPath(); ctx.arc(x, y, r + (b.enraged ? 22 : 16), 0, 7); ctx.fill();

    switch (def.shape) {
      case 'beast':    bossBeast(x, y, r, col, acc, b.facing); break;
      case 'golem':    bossGolem(x, y, r, col, acc); break;
      case 'wraith':   bossWraith(x, y, r, col, acc, b.facing); break;
      case 'eye':      bossEye(x, y, r, col, acc, b.facing); break;
      case 'revenant': bossRevenant(x, y, r, col, acc); break;
      default:         bossDemon(x, y, r, col, acc); break;
    }

    // name + hp bar (width scales with this archetype's radius)
    const bw = Math.max(120, r * 2.1);
    ctx.font = '800 16px "Baloo 2","Noto Sans SC"'; ctx.textAlign = 'center';
    const label = '☠ ' + b.name + (b.enraged ? ' ⚡狂暴' : '');
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.strokeText(label, x, y - r - 22);
    ctx.fillStyle = acc; ctx.fillText(label, x, y - r - 22);
    bar(x - bw / 2, y - r - 14, bw, 9, b.hp / b.maxHp, b.enraged ? '#ff2d2d' : '#ff3d3d', '#5a0e0e');
  }

  // ---- per-archetype boss silhouettes (procedural, no assets) --------------
  // 1) brute — horned fire demon (the classic look)
  function bossDemon(x, y, r, col, acc) {
    ctx.fillStyle = darken(col, 40);
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(x + s * r * 0.5, y - r * 0.7); ctx.lineTo(x + s * r * 0.9, y - r * 1.25); ctx.lineTo(x + s * r * 0.25, y - r * 0.4); ctx.closePath(); ctx.fill(); }
    roundBody(x, y, r, col, darken(col, 55));
    ctx.fillStyle = '#ffe14d';
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(x + s * r * 0.32, y - r * 0.08, r * 0.16, r * 0.1, s * 0.4, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#3a0000';
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(x + s * r * 0.32, y - r * 0.06, r * 0.06, 0, 7); ctx.fill(); }
    ctx.strokeStyle = '#3a0000'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(x, y + r * 0.25, r * 0.4, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  }
  // 2) charger — frost beast: ears, fanged maw, icy brow
  function bossBeast(x, y, r, col, acc) {
    ctx.fillStyle = darken(col, 30);
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(x + s * r * 0.6, y - r * 0.5); ctx.lineTo(x + s * r * 0.95, y - r * 1.15); ctx.lineTo(x + s * r * 0.2, y - r * 0.55); ctx.closePath(); ctx.fill(); }
    roundBody(x, y, r, col, darken(col, 50));
    ctx.fillStyle = '#eaf6ff';
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(x + s * r * 0.34, y - r * 0.12, r * 0.17, r * 0.08, 0, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#0d2a44';
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(x + s * r * 0.34, y - r * 0.12, r * 0.055, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#10243a'; ctx.beginPath(); ctx.ellipse(x, y + r * 0.34, r * 0.34, r * 0.22, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#eaf6ff';
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(x + s * r * 0.22, y + r * 0.2); ctx.lineTo(x + s * r * 0.30, y + r * 0.52); ctx.lineTo(x + s * r * 0.1, y + r * 0.26); ctx.closePath(); ctx.fill(); }
  }
  // 3) golem — chunky rock octagon, cracks, glowing eyes under a heavy brow
  function bossGolem(x, y, r, col, acc) {
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.4, r * 0.2, x, y, r);
    g.addColorStop(0, lighten(col, 25)); g.addColorStop(1, col);
    ctx.fillStyle = g; ctx.strokeStyle = darken(col, 35); ctx.lineWidth = 4;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2 + 0.2, rr = r * (0.92 + (i % 2) * 0.12); const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = darken(col, 30); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x - r * 0.4, y - r * 0.2); ctx.lineTo(x - r * 0.05, y + r * 0.1); ctx.lineTo(x - r * 0.25, y + r * 0.45); ctx.stroke();
    ctx.fillStyle = darken(col, 30); ctx.fillRect(x - r * 0.5, y - r * 0.3, r, r * 0.13);
    ctx.fillStyle = acc; ctx.shadowColor = acc; ctx.shadowBlur = 8;
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(x + s * r * 0.28, y - r * 0.02, r * 0.08, 0, 7); ctx.fill(); }
    ctx.shadowBlur = 0;
  }
  // 4) warden — floating hooded wraith with glowing slit eyes
  function bossWraith(x, y, r, col, acc, facing) {
    ctx.save(); ctx.globalAlpha = 0.92;
    const g = ctx.createLinearGradient(x, y - r, x, y + r);
    g.addColorStop(0, lighten(col, 22)); g.addColorStop(1, darken(col, 30));
    ctx.fillStyle = g; ctx.strokeStyle = darken(col, 45); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y - r * 0.1, r, Math.PI, 0);          // hood dome
    const teeth = 6;
    for (let i = 0; i <= teeth; i++) { const px = x + r - (i / teeth) * r * 2, py = y + r * (i % 2 ? 0.95 : 0.55); ctx.lineTo(px, py); }
    ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
    const dx = Math.cos(facing) * r * 0.1, dy = Math.sin(facing) * r * 0.06;
    ctx.fillStyle = acc; ctx.shadowColor = acc; ctx.shadowBlur = 12;
    for (const s of [-1, 1]) { ctx.save(); ctx.translate(x + s * r * 0.3 + dx, y - r * 0.15 + dy); ctx.rotate(s * 0.3); ctx.beginPath(); ctx.ellipse(0, 0, r * 0.17, r * 0.06, 0, 0, 7); ctx.fill(); ctx.restore(); }
    ctx.shadowBlur = 0;
  }
  // 5) eye — single great eye, iris tracks its target, writhing tentacles
  function bossEye(x, y, r, col, acc, facing) {
    ctx.strokeStyle = darken(col, 20); ctx.lineWidth = r * 0.16; ctx.lineCap = 'round';
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + performance.now() / 1400; ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * r * 0.7, y + Math.sin(a) * r * 0.7); ctx.lineTo(x + Math.cos(a) * r * 1.25, y + Math.sin(a) * r * 1.25); ctx.stroke(); }
    roundBody(x, y, r, col, darken(col, 45));
    ctx.fillStyle = '#f4ecff'; ctx.beginPath(); ctx.arc(x, y, r * 0.62, 0, 7); ctx.fill();
    const ix = x + Math.cos(facing) * r * 0.26, iy = y + Math.sin(facing) * r * 0.26;
    ctx.fillStyle = acc; ctx.beginPath(); ctx.arc(ix, iy, r * 0.3, 0, 7); ctx.fill();
    ctx.fillStyle = '#1a0a2a'; ctx.beginPath(); ctx.arc(ix, iy, r * 0.14, 0, 7); ctx.fill();
    ctx.strokeStyle = hexA(acc, 0.5); ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, r * 0.62, 0, 7); ctx.stroke();
  }
  // 6) revenant — skull with hollow sockets, glowing pupils, green soul-flames
  function bossRevenant(x, y, r, col, acc) {
    for (let i = -1; i <= 1; i++) { const fx = x + i * r * 0.5, h = r * (0.7 + Math.sin(performance.now() / 200 + i) * 0.2); ctx.fillStyle = hexA(acc, 0.5); ctx.beginPath(); ctx.moveTo(fx - r * 0.18, y - r * 0.5); ctx.quadraticCurveTo(fx, y - r * 0.5 - h, fx + r * 0.18, y - r * 0.5); ctx.closePath(); ctx.fill(); }
    roundBody(x, y, r, col, darken(col, 45));
    ctx.fillStyle = '#08231a';
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(x + s * r * 0.32, y - r * 0.12, r * 0.18, r * 0.22, 0, 0, 7); ctx.fill(); }
    ctx.fillStyle = acc; ctx.shadowColor = acc; ctx.shadowBlur = 10;
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(x + s * r * 0.32, y - r * 0.05, r * 0.06, 0, 7); ctx.fill(); }
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#08231a'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(x - r * 0.4, y + r * 0.35); ctx.lineTo(x + r * 0.4, y + r * 0.35); ctx.stroke();
    ctx.lineWidth = 3; for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(x + i * r * 0.16, y + r * 0.27); ctx.lineTo(x + i * r * 0.16, y + r * 0.43); ctx.stroke(); }
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
    ctx.font = '800 11px "Noto Sans SC"';
    ctx.fillStyle = m.idle ? '#6ee7a0' : '#9aa3b2';
    ctx.fillText(m.idle ? '● 营业中' : '… 赶路中', x, m.y - r - 12);
  }

  function drawItem(it) {
    const def = ITEMS[it.type] || { color: '#fff', icon: '?' };
    const t = performance.now() / 1000;
    // pop-in scale when an item first appears (great for scattered death loot)
    let seen = itemSeen.get(it.id);
    if (!seen) { seen = { first: performance.now() }; itemSeen.set(it.id, seen); }
    seen.last = performance.now();
    const age = (performance.now() - seen.first) / 1000;
    const sc = age < 0.32 ? 0.25 + 0.75 * easeOut(age / 0.32) : 1;
    const bob = Math.sin(t * 2.2 + it.x) * 4;
    const x = it.x, y = it.y + bob, r = 13 * sc;
    // glow
    ctx.fillStyle = hexA(def.color, 0.22); ctx.beginPath(); ctx.arc(x, y, r + 7 + Math.sin(t * 3) * 2, 0, 7); ctx.fill();
    shadow(x, it.y + 6, r * 0.8);
    // gem
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.sin(t + it.x) * 0.15);
    const g = ctx.createLinearGradient(0, -r, 0, r); g.addColorStop(0, lighten(def.color, 40)); g.addColorStop(1, def.color);
    ctx.fillStyle = g; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 2;
    roundRect(-r, -r, r * 2, r * 2, 7); ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#fff'; ctx.font = `800 ${(15 * sc).toFixed(0)}px "Baloo 2"`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
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
      const col = pr.c || '#ff7a3d';
      ctx.shadowColor = col; ctx.shadowBlur = 10; ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(x, y, pr.r, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
      ctx.fillStyle = lighten(col, 55);          // bright core so light-tinted orbs still read
      ctx.beginPath(); ctx.arc(x, y, pr.r * 0.5, 0, 7); ctx.fill();
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
    // prefer the global overview (whole map); fall back to the local AoI view until it arrives
    const ov = (view.overview && view.overview.players && view.overview.players.length)
      ? view.overview
      : { players: view.players, bosses: view.bosses, merchants: view.merchants, items: view.items };
    // obstacles
    mmx.fillStyle = 'rgba(150,160,180,.5)';
    for (const o of obstacles) { mmx.beginPath(); mmx.arc(o.x * sxk, o.y * syk, Math.max(1.5, o.r * sxk), 0, 7); mmx.fill(); }
    // items
    for (const it of ov.items) { const d = ITEMS[it.type]; mmx.fillStyle = hexA(d ? d.color : '#fff', .5); mmx.fillRect(it.x * sxk - 1, it.y * syk - 1, 2, 2); }
    // merchants
    mmx.fillStyle = '#ffd23f'; for (const m of ov.merchants) { mmx.beginPath(); mmx.arc(m.x * sxk, m.y * syk, 3, 0, 7); mmx.fill(); }
    // boss (dot tinted to its archetype so you can tell which one is loose)
    for (const b of ov.bosses) { mmx.fillStyle = (BOSS[b.type] && BOSS[b.type].accent) || '#ff3d3d'; mmx.beginPath(); mmx.arc(b.x * sxk, b.y * syk, 4, 0, 7); mmx.fill(); }
    // players (hide invisible enemies unless we have reveal — matches the main view)
    for (const p of ov.players) {
      if (p.invis && !view.hasReveal && p.id !== view.selfId) continue;
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

  // periodically forget stale projectile-trail / item-pop entries
  setInterval(() => {
    const t = performance.now();
    for (const [k, v] of projPrev) if (t - v.seen > 500) projPrev.delete(k);
    for (const [k, v] of itemSeen) if (t - (v.last || 0) > 1500) itemSeen.delete(k);
  }, 1000);

  return { init, resize, setWorld, setObstacles, spawnFx, draw, get cam() { return { x: camX, y: camY }; } };
})();

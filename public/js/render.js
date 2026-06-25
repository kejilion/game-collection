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
  let ambientMotes = [];
  let atmosphereClock = 0;
  let nightMaskRadius = null;
  let obstacles = [];
  const particles = [], floaters = [], rings = [], slashes = [], dashes = [];
  // hexA(hex, alpha) -> 'rgba(r,g,b,a)'. Defined near the bottom of this file
  // (alongside `hx`); the cosmetic trail below reuses it.
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
    ambientMotes = [];
    nightMaskRadius = null;
    const n = Math.floor((W.width * W.height) / 90000);
    for (let i = 0; i < n; i++) {
      decor.push({ x: Math.random() * W.width, y: Math.random() * W.height,
        r: 40 + Math.random() * 120, h: Math.random() * 360, a: 0.04 + Math.random() * 0.05 });
    }
    // Fixed world-space motes make the arena feel inhabited: they drift with
    // the camera instead of looking like a flat screen filter.
    const motes = Math.floor((W.width * W.height) / 52000);
    for (let i = 0; i < motes; i++) {
      ambientMotes.push({
        x: Math.random() * W.width, y: Math.random() * W.height,
        r: 1.2 + Math.random() * 2.4, phase: Math.random() * Math.PI * 2,
        sway: 5 + Math.random() * 14, hue: Math.random() < 0.58 ? 54 : 192
      });
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
    atmosphereClock += dt;
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

    drawGround(view.light);
    drawAmbientMotes(view.light);
    drawObstacles();
    // depth order: items < projectiles < merchants < boss < players
    for (const it of view.items) drawItem(it);
    drawRings(dt, false);
    for (const pr of view.projectiles) drawProjectile(pr, dt);
    for (const m of view.merchants) drawMerchant(m, self);
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
    drawCelestialAtmosphere(view.light);
    drawNightVision(view, dt);
    drawMinimap(view);
  }

  // ---- ground -------------------------------------------------------------
  function drawGround(light) {
    const x0 = camX, y0 = camY;
    const palette = groundPalette(light);
    const g = ctx.createLinearGradient(0, y0, 0, y0 + vh);
    g.addColorStop(0, palette.top); g.addColorStop(1, palette.bottom);
    ctx.fillStyle = g; ctx.fillRect(x0, y0, vw, vh);
    // soft decorative blobs
    for (const d of decor) {
      if (d.x < x0 - d.r || d.x > x0 + vw + d.r || d.y < y0 - d.r || d.y > y0 + vh + d.r) continue;
      ctx.fillStyle = `hsla(${d.h},70%,${palette.decorLight}%,${d.a * palette.decorAlpha})`;
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

  // The mask is a soft circle, never an ellipse. It starts beyond the whole
  // screen at dusk, contracts inward, then expands beyond the screen again at
  // dawn; that keeps both transitions gentle even when a snapshot arrives.
  function drawNightVision(view, dt) {
    // Free-cam spectators (no followed player) see the whole arena brightly;
    // a spectator *following* a player adopts that player's limited night vision
    // so the veil contracts around the one they're tracking, just like playing.
    if (!view.self) return;
    const light = normalLight(view.light);
    const nightness = clamp((1 - light.visibility) / 0.5, 0, 1);
    const cx = view.self.x - camX;
    const cy = view.self.y - camY;
    const farthestCorner = Math.hypot(Math.max(cx, vw - cx), Math.max(cy, vh - cy));
    const edgeWidth = Math.max(155, Math.min(vw, vh) * 0.25);
    const outsideScreen = farthestCorner + edgeWidth + 110;
    const nightRadius = Math.max(150, Math.min(vw, vh) * 0.25);
    const easedNightness = 0.5 - Math.cos(Math.PI * nightness) * 0.5;
    const desiredRadius = outsideScreen + (nightRadius - outsideScreen) * easedNightness;

    // A short renderer-side response absorbs packet cadence and also lets a
    // player joining mid-night see the veil drift in from off-screen.
    if (nightMaskRadius == null) nightMaskRadius = outsideScreen;
    const response = 1 - Math.exp(-Math.max(0, dt) * 2.4);
    nightMaskRadius += (desiredRadius - nightMaskRadius) * response;
    if (nightness <= 0.001 && nightMaskRadius >= outsideScreen - 1) return;

    const presence = clamp((outsideScreen - nightMaskRadius) / (outsideScreen - nightRadius), 0, 1);
    const outerRadius = nightMaskRadius + edgeWidth;
    const coreStop = clamp(nightMaskRadius / outerRadius, 0, 1);
    const midStop = coreStop + (1 - coreStop) * 0.56;
    // Beyond this radius the arena is intentionally unreadable. It is close
    // enough that the far half of a wide display is truly black at night,
    // while the preceding two fog bands keep the falloff natural.
    const blackoutRadius = nightMaskRadius + edgeWidth * 2.55;
    const deepRadius = blackoutRadius + edgeWidth * 0.72;
    const deepStart = clamp((nightMaskRadius + edgeWidth * 0.24) / deepRadius, 0, 1);
    const deepEdge = clamp(outerRadius / deepRadius, deepStart, 1);
    const blackStop = clamp(blackoutRadius / deepRadius, deepEdge, 1);
    const deepMid = deepEdge + (blackStop - deepEdge) * 0.34;
    const deepLate = deepEdge + (blackStop - deepEdge) * 0.72;
    const pulse = 0.5 + Math.sin(atmosphereClock * 1.2) * 0.5;

    ctx.save();
    const shade = ctx.createRadialGradient(cx, cy, 0, cx, cy, outerRadius);
    const coreTint = presence * (0.018 + pulse * 0.012);
    shade.addColorStop(0, `rgba(24,34,76,${coreTint})`);
    shade.addColorStop(coreStop, `rgba(18,27,65,${coreTint})`);
    shade.addColorStop(midStop, `rgba(10,18,52,${presence * 0.25})`);
    shade.addColorStop(1, `rgba(5,11,34,${presence * 0.36})`);
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, vw, vh);

    // A second, much larger veil gives the unseen area real depth: the first
    // ring only softens silhouettes; the farther a point is from the player,
    // the more the deep fog erases it.
    const deepFog = ctx.createRadialGradient(cx, cy, 0, cx, cy, deepRadius);
    deepFog.addColorStop(0, 'rgba(4,9,31,0)');
    deepFog.addColorStop(deepStart, 'rgba(4,9,31,0)');
    deepFog.addColorStop(deepEdge, `rgba(4,9,31,${presence * 0.08})`);
    deepFog.addColorStop(deepMid, `rgba(4,9,31,${presence * 0.26})`);
    deepFog.addColorStop(deepLate, `rgba(3,7,25,${presence * 0.58})`);
    deepFog.addColorStop(blackStop, `rgba(2,5,18,${presence * 0.92})`);
    deepFog.addColorStop(1, `rgba(1,3,12,${presence * 0.98})`);
    ctx.fillStyle = deepFog;
    ctx.fillRect(0, 0, vw, vh);
    ctx.restore();
  }

  function lightMood(rawLight) {
    const light = normalLight(rawLight);
    const nightness = clamp((1 - light.visibility) / 0.5, 0, 1);
    // Twilight peaks halfway through dusk/dawn, rather than snapping at phase boundaries.
    const twilight = (light.phase === 'dusk' || light.phase === 'dawn')
      ? Math.sin(Math.PI * nightness) : 0;
    return { light, nightness, twilight, daylight: 1 - nightness };
  }

  // Tiny floating lights behind the actors: gold reads as fireflies, cyan as
  // distant spirit motes. They stay sparse enough to preserve combat clarity.
  function drawAmbientMotes(rawLight) {
    const mood = lightMood(rawLight);
    if (mood.nightness < 0.02 && mood.twilight < 0.04) return;
    const x0 = camX, y0 = camY;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const m of ambientMotes) {
      if (m.x < x0 - 40 || m.x > x0 + vw + 40 || m.y < y0 - 40 || m.y > y0 + vh + 40) continue;
      const pulse = 0.45 + 0.55 * Math.sin(atmosphereClock * 1.7 + m.phase);
      const alpha = (0.05 + pulse * 0.26) * mood.nightness + mood.twilight * 0.055;
      if (alpha <= 0.01) continue;
      const y = m.y + Math.sin(atmosphereClock * 0.58 + m.phase) * m.sway;
      const color = m.hue === 54 ? '#ffe6a0' : '#9deaff';
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 9 + pulse * 8;
      ctx.beginPath(); ctx.arc(m.x, y, m.r + pulse * 0.7, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.restore();
  }

  // Screen-space atmosphere keeps the mood legible even in open, empty areas:
  // a gentle daytime sun, rose-violet twilight, then a cool moon bloom.
  function drawCelestialAtmosphere(rawLight) {
    const mood = lightMood(rawLight);
    const breath = 0.5 + 0.5 * Math.sin(atmosphereClock * 0.38);
    ctx.save();
    if (mood.daylight > 0.03) {
      const sun = ctx.createRadialGradient(vw * 0.80, vh * 0.12, 0, vw * 0.80, vh * 0.12, Math.max(vw, vh) * 0.58);
      sun.addColorStop(0, `rgba(255,235,174,${0.12 * mood.daylight})`);
      sun.addColorStop(0.35, `rgba(255,196,112,${0.055 * mood.daylight})`);
      sun.addColorStop(1, 'rgba(255,196,112,0)');
      ctx.fillStyle = sun; ctx.fillRect(0, 0, vw, vh);
    }
    if (mood.twilight > 0.01) {
      const glow = ctx.createLinearGradient(0, 0, 0, vh);
      glow.addColorStop(0, `rgba(255,156,124,${0.10 * mood.twilight})`);
      glow.addColorStop(0.48, `rgba(191,123,212,${0.075 * mood.twilight})`);
      glow.addColorStop(1, 'rgba(87,92,184,0)');
      ctx.fillStyle = glow; ctx.fillRect(0, 0, vw, vh);
    }
    if (mood.nightness > 0.03) {
      const mx = vw * 0.17, my = vh * 0.16, mr = Math.max(vw, vh) * 0.30;
      const moon = ctx.createRadialGradient(mx, my, 0, mx, my, mr);
      moon.addColorStop(0, `rgba(220,230,255,${(0.12 + breath * 0.035) * mood.nightness})`);
      moon.addColorStop(0.28, `rgba(148,182,255,${0.065 * mood.nightness})`);
      moon.addColorStop(1, 'rgba(93,119,220,0)');
      ctx.fillStyle = moon; ctx.fillRect(0, 0, vw, vh);
    }
    ctx.restore();
  }

  function normalLight(light) {
    const visibility = light && typeof light.visibility === 'number' ? light.visibility : 1;
    return { phase: (light && light.phase) || 'day', visibility: clamp(visibility, 0.5, 1) };
  }

  function groundPalette(rawLight) {
    const light = normalLight(rawLight);
    const day = { top: '#315f85', bottom: '#1b4165', decorLight: 65, decorAlpha: 1 };
    const twilight = { top: '#594878', bottom: '#26345f', decorLight: 59, decorAlpha: 0.72 };
    const night = { top: '#16204a', bottom: '#0d1430', decorLight: 52, decorAlpha: 0.48 };
    let from = day, to = day, progress = 0;
    if (light.phase === 'dusk') {
      from = day; to = night;
      progress = (1 - light.visibility) / 0.5;
      if (progress < 0.5) return mixPalette(from, twilight, progress * 2);
      return mixPalette(twilight, to, (progress - 0.5) * 2);
    }
    if (light.phase === 'night') return night;
    if (light.phase === 'dawn') {
      from = night; to = day;
      progress = (light.visibility - 0.5) / 0.5;
      if (progress < 0.5) return mixPalette(from, twilight, progress * 2);
      return mixPalette(twilight, to, (progress - 0.5) * 2);
    }
    return day;
  }

  function mixPalette(a, b, t) {
    return {
      top: mixHex(a.top, b.top, t), bottom: mixHex(a.bottom, b.bottom, t),
      decorLight: a.decorLight + (b.decorLight - a.decorLight) * t,
      decorAlpha: a.decorAlpha + (b.decorAlpha - a.decorAlpha) * t
    };
  }

  function mixHex(a, b, t) {
    const aa = hx(a), bb = hx(b);
    const c = aa.map((v, i) => Math.round(v + (bb[i] - v) * clamp(t, 0, 1)));
    return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
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
  function roundBody(x, y, r, fill, line, c) {
    c = c || ctx;
    const g = c.createRadialGradient(x - r * 0.3, y - r * 0.4, r * 0.2, x, y, r);
    g.addColorStop(0, lighten(fill, 30)); g.addColorStop(1, fill);
    c.fillStyle = g; c.strokeStyle = line; c.lineWidth = 3;
    c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); c.stroke();
  }
  function eyes(x, y, r, facing, scale = 1, c) {
    c = c || ctx;
    const dx = Math.cos(facing) * r * 0.22, dy = Math.sin(facing) * r * 0.18;
    for (const s of [-1, 1]) {
      const ex = x + s * r * 0.32, ey = y - r * 0.12;
      c.fillStyle = '#fff'; c.beginPath(); c.arc(ex, ey, r * 0.2 * scale, 0, 7); c.fill();
      c.fillStyle = '#1a1a2e'; c.beginPath(); c.arc(ex + dx, ey + dy, r * 0.1 * scale, 0, 7); c.fill();
    }
  }

  // ---- portrait (menu / class picker) -------------------------------------
  // Re-uses the same primitives as drawPlayer (roundBody / drawHeadgear /
  // drawWeapon / eyes) so the class-picker shows the actual in-game sprite
  // instead of an emoji glyph. The caller drives `tick` so this stays a
  // pure paint — no per-frame closure here.
  function drawPortrait(canvas, clsId, tick) {
    if (!canvas || !canvas.getContext) return;
    if (tick == null) tick = 0;
    const pc = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    // Prefer HUD's class def, since Renderer.setWorld only runs after
    // onWelcome (player joined a match). Without this fallback the menu
    // would paint every class with #888.
    const cls = CLASSES[clsId] || (typeof HUD !== 'undefined' && HUD.getClasses && HUD.getClasses()[clsId]) || { color: '#888', name: '?' };
    const r = Math.min(W, H) * 0.28;
    const cx = W / 2;
    // idle bob + facing sway — same math as drawPlayer so it looks identical
    const bob = Math.sin(tick / 90) * 2.2;
    const facing = Math.sin(tick / 1100) * 0.25;       // gentle look-around
    const y = H / 2 + bob + 4;
    const x = cx;
    pc.clearRect(0, 0, W, H);
    // soft floor shadow
    pc.fillStyle = 'rgba(0,0,0,.28)';
    pc.beginPath(); pc.ellipse(x, y + r * 0.95, r * 0.9, r * 0.42, 0, 0, 7); pc.fill();
    drawWeapon(x, y, r, facing, clsId, cls.color, pc);
    roundBody(x, y, r, cls.color, '#1c2140', pc);
    drawHeadgear(x, y, r, clsId, cls, pc);
    eyes(x, y, r, facing, 1, pc);
  }

  function drawPlayer(p, isSelf) {
    const r = 21 * (p.size || 1);
    // bob phase keyed to a STABLE per-entity value (id) — NOT the live x/y. Using
    // the moving position made the sine argument jump several radians per frame
    // while walking, aliasing the bob into a vertical strobe (the "走路发抖" look).
    const ph = phaseOf(p.id);
    const bob = p.moving ? Math.sin(performance.now() / 90 + ph) * 3 : Math.sin(performance.now() / 600 + ph) * 1.2;
    const x = p.x, y = p.y + bob;
    const cls = CLASSES[p.cls] || { color: '#888', name: '?' };
    const skinColor = p.skin === 'crimson' ? '#7a1414'
                    : p.skin === 'arcane'  ? '#2a3a8a'
                    : p.skin === 'shadow'  ? '#1a1a2a'
                    : cls.color;
    const ghost = p.invis ? 0.4 : 1;
    ctx.globalAlpha = ghost;
    shadow(x, p.y, r);

    // outer glow ring (cosmetic) — additive ring around the body
    if (p.glow) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = p.glow;
      ctx.globalAlpha = ghost * (0.28 + 0.12 * Math.sin(performance.now() / 220));
      ctx.beginPath(); ctx.arc(x, y, r + 4, 0, 7); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = ghost;
    }

    // weapon behind for some facings
    drawWeapon(x, y, r, p.facing, p.cls, cls.color);
    roundBody(x, y, r, skinColor, '#1c2140');
    // class hat/hood
    drawHeadgear(x, y, r, p.cls, cls);
    eyes(x, y, r, p.facing);

    // spawn protection shield
    if (p.prot) {
      ctx.strokeStyle = 'rgba(120,200,255,.8)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r + 6 + Math.sin(performance.now() / 120) * 2, 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // trail (cosmetic) — push a fading dash segment to the existing dashes array
    if (p.moving && p.trail) {
      const tc = p.trail === 'fire' ? '#ff7a3d'
               : p.trail === 'frost' ? '#7fd8ff'
               :                       '#9aa3b2';
      const fwd = p.facing || 0;
      dashes.push({ x1: p.x - Math.cos(fwd) * 14, y1: p.y - Math.sin(fwd) * 14, x2: p.x, y2: p.y, color: hexA(tc, 0.6), life: 0.3, max: 0.3 });
    }

    // nameplate + bars
    nameplate(x, p.y - r, p, isSelf, cls);

    // chat bubble
    if (p.chat) chatBubble(x, p.y - r - (isSelf ? 50 : 44), p.chat);
  }

  function drawWeapon(x, y, r, facing, clsId, color, c) {
    c = c || ctx;
    c.save(); c.translate(x, y); c.rotate(facing);
    c.lineCap = 'round';
    if (clsId === 'warrior') {                 // big sword
      c.strokeStyle = '#dfe6f5'; c.lineWidth = 6; c.beginPath(); c.moveTo(r * 0.4, 8); c.lineTo(r + 18, 8); c.stroke();
      c.strokeStyle = '#8a6a3a'; c.lineWidth = 4; c.beginPath(); c.moveTo(r * 0.2, 8); c.lineTo(r * 0.5, 8); c.stroke();
    } else if (clsId === 'mage') {              // staff with orb
      c.strokeStyle = '#a9763f'; c.lineWidth = 4; c.beginPath(); c.moveTo(0, 6); c.lineTo(r + 12, 6); c.stroke();
      c.fillStyle = '#7fb0ff'; c.shadowColor = '#7fb0ff'; c.shadowBlur = 10; c.beginPath(); c.arc(r + 14, 6, 6, 0, 7); c.fill(); c.shadowBlur = 0;
    } else {                                    // dagger
      c.strokeStyle = '#e6d4ff'; c.lineWidth = 5; c.beginPath(); c.moveTo(r * 0.3, 7); c.lineTo(r + 8, 7); c.stroke();
    }
    c.restore();
  }
  function drawHeadgear(x, y, r, clsId, cls, c) {
    c = c || ctx;
    if (clsId === 'mage') {                      // pointed hat
      c.fillStyle = darken(cls.color, 18); c.strokeStyle = '#1c2140'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(x - r * 0.7, y - r * 0.5); c.lineTo(x + r * 0.7, y - r * 0.5); c.lineTo(x, y - r * 1.7); c.closePath(); c.fill(); c.stroke();
      c.fillStyle = '#ffe08a'; c.beginPath(); c.arc(x, y - r * 1.7, 3, 0, 7); c.fill();
    } else if (clsId === 'warrior') {            // helmet band
      c.strokeStyle = '#cdd6ea'; c.lineWidth = 4; c.beginPath(); c.arc(x, y - r * 0.1, r * 0.92, Math.PI * 1.15, Math.PI * 1.85); c.stroke();
    } else {                                     // assassin hood
      c.fillStyle = darken(cls.color, 22);
      c.beginPath(); c.arc(x, y - r * 0.2, r * 0.95, Math.PI * 1.05, Math.PI * 1.95); c.lineTo(x, y - r * 0.2); c.fill();
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

  function drawMerchant(m, self) {
    const r = 22;
    const x = m.x, y = m.y + Math.sin(performance.now() / 420 + phaseOf(m.id)) * 2;
    shadow(x, m.y, r);
    roundBody(x, y, r, '#37b07a', '#16402c');
    // straw-hat
    ctx.fillStyle = '#d9a441'; ctx.beginPath(); ctx.ellipse(x, y - r * 0.7, r * 1.05, r * 0.35, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x, y - r * 0.95, r * 0.5, r * 0.4, 0, 0, 7); ctx.fill();
    eyes(x, y, r, 0, 0.9);
    // floating coin removed — the HP bar now lives in this slot (right under
    // the status line), which reads more naturally than a gold coin on top.
    ctx.font = '700 12px "Noto Sans SC"'; ctx.fillStyle = '#bfe8cf'; ctx.fillText('神秘商人', x, m.y - r - 44);
    ctx.font = '800 11px "Noto Sans SC"';
    ctx.fillStyle = m.idle ? '#6ee7a0' : '#9aa3b2';
    ctx.fillText(m.idle ? '● 营业中' : '… 赶路中', x, m.y - r - 30);
    // "Press E" speech bubble when the local player is within shopping range
    // and the merchant is alive — a steady hint, not a fading toast.
    if (self && m.hp != null && m.hp > 0) {
      const dx = self.x - m.x, dy = self.y - m.y;
      if (dx * dx + dy * dy <= 140 * 140) {
        const bob = Math.sin(performance.now() / 320) * 2;
        const by = m.y - r - 70 + bob;
        const padX = 9, padY = 5;
        ctx.font = '800 13px "Noto Sans SC"';
        const label = '按 E 购买';
        const tw = ctx.measureText(label).width;
        const bw = tw + padX * 2, bh = 22;
        const bx = x - bw / 2;
        // pill background
        ctx.fillStyle = 'rgba(0,0,0,.55)';
        roundRect(bx, by, bw, bh, 11);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,210,63,.65)'; ctx.lineWidth = 1.5;
        roundRect(bx, by, bw, bh, 11);
        ctx.stroke();
        // keycap "E"
        const kc = 18, kcX = bx + 6, kcY = by + (bh - kc) / 2;
        ctx.fillStyle = '#ffd23f';
        roundRect(kcX, kcY, kc, kc, 4);
        ctx.fill();
        ctx.fillStyle = '#1a1208'; ctx.font = '800 13px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('E', kcX + kc / 2, kcY + 13);
        // text
        ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
        ctx.fillText(label, kcX + kc + 5, by + 15);
        ctx.textAlign = 'center';
      }
    }
    // HP bar — same red pill as players so the three entity types share one
    // visual language for "is this thing hurt?". Placed directly under the
    // "营业中" status line so the stack reads top→bottom:
    //   神秘商人  →  ● 营业中  →  ━━ HP ━━  →  商人身体
    if (m.maxHp && m.hp != null) {
      bar(x - 26, m.y - r - 17, 52, 6, m.hp / m.maxHp, '#ff4d63', '#3a0c14');
    }
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
    } else if (pr.type === 'frostnova') {
      ctx.fillStyle = 'rgba(127,216,255,.3)'; ctx.beginPath(); ctx.arc(x, y, pr.r + 8, 0, 7); ctx.fill();
      const gf = ctx.createRadialGradient(x, y, 2, x, y, pr.r); gf.addColorStop(0, '#ffffff'); gf.addColorStop(.5, '#7fd8ff'); gf.addColorStop(1, '#4da6ff');
      ctx.fillStyle = gf; ctx.beginPath(); ctx.arc(x, y, pr.r, 0, 7); ctx.fill();
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
    // During dusk these markers melt away; at full night, only the local
    // player remains. Dawn restores them with the same smooth fade.
    const minimapMarks = clamp((normalLight(view.light).visibility - 0.5) / 0.5, 0, 1);
    if (minimapMarks > 0.001) {
      mmx.globalAlpha = minimapMarks;
      // obstacles
      mmx.fillStyle = 'rgba(150,160,180,.5)';
      for (const o of obstacles) { mmx.beginPath(); mmx.arc(o.x * sxk, o.y * syk, Math.max(1.5, o.r * sxk), 0, 7); mmx.fill(); }
      // items
      for (const it of ov.items) { const d = ITEMS[it.type]; mmx.fillStyle = hexA(d ? d.color : '#fff', .5); mmx.fillRect(it.x * sxk - 1, it.y * syk - 1, 2, 2); }
      // merchants
      mmx.fillStyle = '#ffd23f'; for (const m of ov.merchants) { mmx.beginPath(); mmx.arc(m.x * sxk, m.y * syk, 3, 0, 7); mmx.fill(); }
      // boss (dot tinted to its archetype so you can tell which one is loose)
      for (const b of ov.bosses) {
        if (b.x == null || b.y == null) continue;          // server-masked (defensive — bosses are never invis today)
        mmx.fillStyle = (BOSS[b.type] && BOSS[b.type].accent) || '#ff3d3d'; mmx.beginPath(); mmx.arc(b.x * sxk, b.y * syk, 4, 0, 7); mmx.fill();
      }
      // Rivals fade with the rest of the map; invisibility still applies before night arrives.
      for (const p of ov.players) {
        if (p.id === view.selfId || (p.invis && !view.hasReveal && !view.spectating)) continue;
        if (p.x == null || p.y == null) continue;            // server-masked invisible player — skip the dot
        const cls = CLASSES[p.cls] || { color: '#fff' };
        mmx.fillStyle = cls.color; mmx.beginPath(); mmx.arc(p.x * sxk, p.y * syk, 3, 0, 7); mmx.fill();
      }
      // The viewport frame is another information marker, so it vanishes too.
      mmx.strokeStyle = 'rgba(255,255,255,.5)'; mmx.lineWidth = 1;
      mmx.strokeRect(camX * sxk, camY * syk, vw * sxk, vh * syk);
    }
    // Self is deliberately drawn last and at full brightness in every phase.
    const self = view.self || ov.players.find(p => p.id === view.selfId);
    if (self && !view.spectating) {
      mmx.globalAlpha = 1;
      mmx.fillStyle = '#9be7ff'; mmx.shadowColor = '#9be7ff'; mmx.shadowBlur = 8;
      mmx.beginPath(); mmx.arc(self.x * sxk, self.y * syk, 4, 0, 7); mmx.fill();
      mmx.shadowBlur = 0;
    }
    mmx.globalAlpha = 1;
  }

  // ---- utils --------------------------------------------------------------
  function roundRect(x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  // stable 0..2π phase from an entity id, so idle-bob/float cycles stay desynced
  // between entities WITHOUT keying off live x/y (which strobes when they move)
  function phaseOf(id) { let h = 0; const s = '' + id; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return (h % 62832) / 10000; }
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

  return { init, resize, setWorld, setObstacles, spawnFx, draw, drawPortrait, get cam() { return { x: camX, y: camY }; } };
})();

// ============================================================================
//  main.js — game client orchestration
//  Connects the modules, manages menu/game screens, buffers server snapshots
//  and renders them with interpolation + client-side prediction for self.
// ============================================================================
(() => {
  const G = {
    selfId: null, defs: { classes: {}, items: {}, shop: [] }, world: { width: 3200, height: 2200 },
    snaps: [], leaderboard: { rt: [], hist: [] },
    pred: { x: 0, y: 0, ready: false }, lastSelf: null,
    selectedClass: 'warrior', screen: 'menu', nearMerchant: false,
    deadSince: 0, shopOpen: false, settingsOpen: false, merchantHinted: false,
    obstacles: [], items: [],            // items: nearby set from AoI state; keep our own copy
    overview: { players: [], bosses: [], merchants: [], items: [] },  // global minimap blips (low-rate)
    interpDelay: 120, gapEMA: 50, lastStateAt: 0,  // adaptive interpolation for jittery links
    shopCloseAt: 0, isTouch: false,
    spectating: false, specTarget: null, specFree: true, spectatorCount: 0,
    lastKilledBy: null, lastKilledAt: 0,   // who landed the killing blow on us (for the death notice)
    // free-cam: a spectator camera detached from any player — pan it anywhere
    specCam: { x: 1600, y: 1100 }, specKeys: { up: false, down: false, left: false, right: false }, specDrag: null
  };
  let lastFrame = performance.now();


  // ---- spectator mode -------------------------------------------------------
  function onSpectateWelcome(m) {
    G.spectating = true; G.specFree = true; G.specTarget = null;
    G.world = m.world;
    G.specCam = { x: m.world.width / 2, y: m.world.height / 2 };   // free camera starts centered
    G.specKeys = { up: false, down: false, left: false, right: false };
    G.defs = { classes: m.classes, items: m.items, shop: m.shop, bosses: m.bosses || {} };
    G.obstacles = m.obstacles || [];
    Renderer.setWorld(m.world, m.classes, m.items, m.bosses);
    Renderer.setObstacles(G.obstacles);
    HUD.setDefs(m.classes, m.items, m.shop);
    G.snaps.length = 0; G.items = []; G.deadSince = 0;
    showScreen('game');
    document.getElementById('spectatorBar').classList.add('show');
    document.getElementById('spectatorList').classList.add('show');
    document.getElementById('playerPanel').style.display = 'none';
    document.getElementById('skillbar').style.display = 'none';
    wireSpectatorControls();
    updateSpecUI();                       // show the 自由视角 + pan hint right away
  }

  function onSpectatorCount(m) {
    G.spectatorCount = m.count;
    const menuEl = document.getElementById('menuSpecCount');
    if (menuEl) menuEl.textContent = m.count > 0 ? '\uD83D\uDC41 ' + m.count + ' \u4EBA\u89C2\u6218\u4E2D' : '';
    const badge = document.getElementById('specCountBadge');
    if (badge) {
      badge.textContent = '\uD83D\uDC41 \u89C2\u6218 ' + m.count;
      badge.classList.toggle('show', m.count > 0);
    }
  }

  function specSwitchTarget(dir) {
    const snap = G.snaps.length > 0 ? G.snaps[G.snaps.length - 1] : null;
    if (!snap) return;
    const alive = snap.data.players.filter(p => !p.dead);
    if (alive.length === 0) { G.specFree = true; G.specTarget = null; updateSpecUI(); return; }
    G.specFree = false;
    const idx = alive.findIndex(p => p.id === G.specTarget);
    if (idx < 0) { G.specTarget = alive[0].id; }
    else {
      const next = (idx + dir + alive.length) % alive.length;
      G.specTarget = alive[next].id;
    }
    updateSpecUI();
  }

  function specSelectPlayer(id) {
    G.specFree = false; G.specTarget = id; updateSpecUI();
  }

  function specGoFree() {
    G.specFree = true; G.specTarget = null; updateSpecUI();
  }

  // free-cam: glide the detached spectator camera from held keys (px/sec)
  function updateSpecCam(dt) {
    let dx = (G.specKeys.right ? 1 : 0) - (G.specKeys.left ? 1 : 0);
    let dy = (G.specKeys.down ? 1 : 0) - (G.specKeys.up ? 1 : 0);
    if (!dx && !dy) return;
    const len = Math.hypot(dx, dy); dx /= len; dy /= len;
    const sp = 760;
    G.specCam.x = clamp(G.specCam.x + dx * sp * dt, 0, G.world.width);
    G.specCam.y = clamp(G.specCam.y + dy * sp * dt, 0, G.world.height);
  }

  function specExit() {
    Net.send({ type: 'spectateLeave' });
    G.spectating = false; G.specTarget = null; G.specFree = true;
    G.snaps.length = 0; G.items = [];
    document.getElementById('spectatorBar').classList.remove('show');
    document.getElementById('spectatorList').classList.remove('show');
    document.getElementById('playerPanel').style.display = '';
    document.getElementById('skillbar').style.display = '';
    showScreen('menu');
  }

  function updateSpecUI() {
    const el = document.getElementById('specTarget');
    if (G.specFree) { el.textContent = '\u81EA\u7531\u89C6\u89D2 \u00B7 WASD/\u62D6\u52A8 \u79FB\u52A8\u955C\u5934'; return; }
    const snap = G.snaps.length > 0 ? G.snaps[G.snaps.length - 1] : null;
    const target = snap ? snap.data.players.find(p => p.id === G.specTarget) : null;
    el.textContent = target ? target.name : '\u81EA\u7531\u89C6\u89D2';
  }

  function updateSpecPlayerList(players) {
    const el = document.getElementById('spectatorList');
    if (!el || !G.spectating) return;
    let html = '<div class="sl-title">\u6218\u573A\u4EBA\u7269 (' + players.length + ')</div>';
    const sorted = [...players].sort((a, b) => b.score - a.score);
    for (const p of sorted) {
      const cls = G.defs.classes[p.cls] || { color: '#fff' };
      const active = p.id === G.specTarget ? ' active' : '';
      const dead = p.dead ? ' sl-dead' : '';
      html += '<div class="sl-player' + active + dead + '" data-pid="' + p.id + '">'
        + '<span class="sl-dot" style="background:' + cls.color + '"></span>'
        + '<span>' + escapeHtml(p.name) + '</span>'
        + '<span style="margin-left:auto;opacity:.5;font-size:.75rem">Lv.' + p.level + '</span>'
        + '</div>';
    }
    el.innerHTML = html;
    el.querySelectorAll('.sl-player').forEach(row => {
      row.addEventListener('click', () => specSelectPlayer(row.dataset.pid));
    });
  }

  let _specControlsWired = false;
  function wireSpectatorControls() {
    if (_specControlsWired) return;
    _specControlsWired = true;
    document.getElementById('specPrev').addEventListener('click', () => specSwitchTarget(-1));
    document.getElementById('specNext').addEventListener('click', () => specSwitchTarget(1));
    document.getElementById('specFree').addEventListener('click', specGoFree);
    document.getElementById('specExit').addEventListener('click', specExit);
    window.addEventListener('keydown', (e) => {
      if (!G.spectating) return;
      const c = e.code;
      if (c === 'Escape') { e.preventDefault(); specExit(); return; }
      if (c === 'Space')  { e.preventDefault(); specGoFree(); return; }
      const up = c==='ArrowUp'||c==='KeyW', down = c==='ArrowDown'||c==='KeyS';
      const left = c==='ArrowLeft'||c==='KeyA', right = c==='ArrowRight'||c==='KeyD';
      if (!(up||down||left||right)) return;
      e.preventDefault();
      if (G.specFree) {                          // free camera: hold to pan
        if (up) G.specKeys.up = true; if (down) G.specKeys.down = true;
        if (left) G.specKeys.left = true; if (right) G.specKeys.right = true;
      } else if (left) specSwitchTarget(-1);     // following: ← / → cycle players
      else if (right) specSwitchTarget(1);
    });
    window.addEventListener('keyup', (e) => {
      if (!G.spectating) return;
      const c = e.code;
      if (c==='ArrowUp'||c==='KeyW') G.specKeys.up = false;
      else if (c==='ArrowDown'||c==='KeyS') G.specKeys.down = false;
      else if (c==='ArrowLeft'||c==='KeyA') G.specKeys.left = false;
      else if (c==='ArrowRight'||c==='KeyD') G.specKeys.right = false;
    });
    // drag the canvas to pan the free camera (mouse / touch)
    const cv = document.getElementById('canvas');
    if (cv) {
      cv.addEventListener('pointerdown', (e) => {
        if (!G.spectating || !G.specFree) return;
        G.specDrag = { x: e.clientX, y: e.clientY };
        try { cv.setPointerCapture(e.pointerId); } catch (e2) {}
      });
      cv.addEventListener('pointermove', (e) => {
        if (!G.specDrag) return;
        G.specCam.x = clamp(G.specCam.x - (e.clientX - G.specDrag.x), 0, G.world.width);
        G.specCam.y = clamp(G.specCam.y - (e.clientY - G.specDrag.y), 0, G.world.height);
        G.specDrag.x = e.clientX; G.specDrag.y = e.clientY;
      });
      const endDrag = () => { G.specDrag = null; };
      cv.addEventListener('pointerup', endDrag);
      cv.addEventListener('pointercancel', endDrag);
    }
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  // ---- boot ---------------------------------------------------------------
  window.addEventListener('DOMContentLoaded', () => {
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
      G.isTouch = true; document.body.classList.add('is-touch');
    }
    HUD.init();
    Renderer.init(document.getElementById('canvas'), document.getElementById('minimap'));
    wireMenu(); wireGameUI();
    Net.onOpen = () => setConn('已连接，选择职业进入战斗', 'ok');
    Net.onClose = () => setConn('与服务器断开，正在重连…', 'bad');
    Net.onMessage = onMessage;
    Net.connect();
    window.addEventListener('resize', () => { if (G.screen === 'game') scheduleSendView(); });
    requestAnimationFrame(loop);
  });

  function setConn(text, cls) {
    const el = document.getElementById('connStatus');
    el.textContent = text; el.className = 'conn-status ' + (cls || '');
  }

  // ---- server messages ----------------------------------------------------
  function onMessage(m) {
    switch (m.type) {
      case 'defs': onDefs(m); break;
      case 'welcome': onWelcome(m); break;
      case 'state': onState(m); break;
      case 'spectateWelcome': onSpectateWelcome(m); break;
      case 'spectatorCount': onSpectatorCount(m); break;
      case 'overview': G.overview = m; break;
      case 'leaderboard':
        G.leaderboard = { rt: m.realtime, hist: m.historical };
        HUD.updateLeaderboard(m.realtime, m.historical, G.lastSelf ? G.lastSelf.name : '');
        HUD.updateMenuHistory(m.historical);
        break;
      case 'chat':
        HUD.addChat(m.name, m.text, m.color);
        break;
      case 'sys':
        HUD.addChat('', m.text, m.color, true);
        break;
      case 'shopResult':
        HUD.toast(m.msg, m.ok ? '#6ee7a0' : '#ff7a7a');
        break;
    }
  }

  function onDefs(m) {
    G.defs = { classes: m.classes, items: m.items, shop: m.shop, bosses: m.bosses || {} };
    HUD.setDefs(m.classes, m.items, m.shop);
    HUD.buildClassPicker((cls) => { G.selectedClass = cls; });
    HUD.buildShop(buy);
  }

  function onWelcome(m) {
    G.selfId = m.id; G.world = m.world;
    G.defs = { classes: m.classes, items: m.items, shop: m.shop, bosses: m.bosses || {} };
    G.obstacles = m.obstacles || [];
    Renderer.setWorld(m.world, m.classes, m.items, m.bosses);
    Renderer.setObstacles(G.obstacles);
    HUD.setDefs(m.classes, m.items, m.shop);
    HUD.buildSkillbar(G.selectedClass);
    HUD.buildShop(buy);
    G.pred.ready = false; G.snaps.length = 0; G.items = []; G.deadSince = 0; G.shopCloseAt = 0;
    showScreen('game');
    sendView();                            // tell the server our viewport so it streams only what we can see
  }

  // report viewport size to the server for area-of-interest culling
  let _viewTimer = 0;
  function scheduleSendView() { clearTimeout(_viewTimer); _viewTimer = setTimeout(sendView, 200); }
  function sendView() {
    const cv = document.getElementById('canvas');
    const w = (cv && cv.clientWidth) || window.innerWidth || 1280;
    const h = (cv && cv.clientHeight) || window.innerHeight || 720;
    Net.send({ type: 'view', w, h });
  }

  function onState(m) {
    const recv = performance.now();
    // adaptive interpolation: track packet inter-arrival jitter and stay that far behind
    if (G.lastStateAt) {
      const gap = recv - G.lastStateAt;
      G.gapEMA = G.gapEMA * 0.85 + gap * 0.15;
      G.interpDelay = clamp(G.gapEMA * 1.6 + 35, 90, 260);
    }
    G.lastStateAt = recv;

    // index moving entities by id for interpolation (items are delta-synced separately)
    const idx = {};
    for (const k of ['players', 'bosses', 'merchants', 'projectiles']) {
      idx[k] = new Map(); for (const e of m[k]) idx[k].set(e.id, e);
    }
    if (m.items) G.items = m.items;        // AoI item set for our current view (sent each state)
    G.snaps.push({ t: recv, data: m, idx });
    while (G.snaps.length > 16) G.snaps.shift();

    // fx events -> renderer + notable toasts
    for (const fx of m.fx) {
      Renderer.spawnFx(fx);
      if (fx.t === 'bossKill') HUD.toast(`${fx.name || '有人'} 击杀了 BOSS ${fx.boss}！`, '#ffd23f');
      else if (fx.t === 'bossSpawn') {
        const bd = G.defs.bosses && G.defs.bosses[fx.type];
        HUD.toast(`BOSS ${fx.name} 降临！${bd ? ' · ' + bd.desc : ''}`, fx.color || '#ff6a6a');
      }
      else if (fx.t === 'levelup' && fx.id === G.selfId) {
        HUD.toast(`升级！ Lv.${fx.level}`, '#6ee7a0');
        const cls = G.defs.classes[G.lastSelf ? G.lastSelf.cls : G.selectedClass];
        if (cls) cls.skills.forEach((sk, i) => { if (sk && sk.reqLevel === fx.level) HUD.toast(`🔓 解锁技能「${sk.name}」· 按 ${i + 1}`, '#ffd23f'); });
      }
      else if (fx.t === 'pickup' && fx.id === G.selfId) {
        const d = G.defs.items[fx.type];
        if (d) HUD.toast(`获得 ${d.name} · ${d.desc}`, d.color);
      }
      else if (fx.t === 'killfeed') {
        HUD.killFeed(fx, G.selfId);
        if (fx.victimId && fx.victimId === G.selfId) { G.lastKilledBy = fx.killer; G.lastKilledAt = recv; }
      }
    }

    // self-derived HUD
    const self = idx.players.get(G.selfId);
    if (self) {
      G.lastSelf = self;
      HUD.updatePlayer(self);
      HUD.updateShopGold(self.gold);
      // death / respawn overlay (+ an explicit toast so the death is never missed)
      if (self.dead && !G.deadSince) {
        G.deadSince = recv;
        const by = (G.lastKilledBy && recv - G.lastKilledAt < 1500) ? G.lastKilledBy : null;
        HUD.toast(by ? `💀 你被 ${by} 击败！3 秒后复活` : '💀 你已阵亡！3 秒后复活', '#ff6a6a');
      }
      if (!self.dead) { G.deadSince = 0; G.lastKilledBy = null; }
      toggleRespawn(self.dead);
      // near-merchant detection
      let near = false;
      for (const mm of m.merchants) if (dist2(self.x, self.y, mm.x, mm.y) <= 140 * 140) { near = true; break; }
      G.nearMerchant = near;
      if (near) {
        G.shopCloseAt = 0;                 // back in range — cancel any pending auto-close
        if (!G.merchantHinted) { HUD.toast('靠近商人，按 B（或点击🛒）购买道具', '#6ee7a0'); G.merchantHinted = true; }
      } else {
        G.merchantHinted = false;
        if (G.shopOpen && !G.shopCloseAt) G.shopCloseAt = recv + 4000;  // grace period before it closes
      }
    }
    if (G.spectating && m.players) updateSpecPlayerList(m.players);
  }

  // ---- main loop: interpolate + predict + render --------------------------
  function loop(now) {
    const dt = Math.min((now - lastFrame) / 1000, 0.05); lastFrame = now;
    if (G.spectating && G.specFree) updateSpecCam(dt);   // pan the free camera from held keys
    if (G.screen === 'game' && G.snaps.length) {
      const view = buildView(now, dt);
      Renderer.draw(view, dt);
      HUD.renderSkillbar();
      if (G.deadSince) {
        const left = Math.max(0, 3 - (now - G.deadSince) / 1000);
        document.getElementById('respawnCount').textContent = Math.ceil(left);
      }
    }
    // shop auto-closes only after a grace period away from the merchant
    if (G.shopCloseAt && performance.now() > G.shopCloseAt) { G.shopCloseAt = 0; closeShop(); }
    requestAnimationFrame(loop);
  }

  function buildView(now, dt) {
    const target = now - G.interpDelay;
    // find bracketing snapshots
    let a = G.snaps[0], b = G.snaps[G.snaps.length - 1];
    for (let i = 0; i < G.snaps.length - 1; i++) {
      if (G.snaps[i].t <= target && G.snaps[i + 1].t >= target) { a = G.snaps[i]; b = G.snaps[i + 1]; break; }
    }
    const span = b.t - a.t || 1;
    const alpha = clamp((target - a.t) / span, 0, 1);

    const view = { selfId: G.spectating ? null : G.selfId, players: [], bosses: [], merchants: [], items: G.items, projectiles: [] };
    view.bosses = lerpList(a.idx.bosses, b.idx.bosses, alpha);
    view.merchants = lerpList(a.idx.merchants, b.idx.merchants, alpha);
    view.projectiles = lerpList(a.idx.projectiles, b.idx.projectiles, alpha);

    // players (interpolated) — but replace self with prediction
    const others = lerpList(a.idx.players, b.idx.players, alpha);
    const selfLatest = b.idx.players.get(G.selfId) || G.lastSelf;
    const hasReveal = selfLatest && selfLatest.buffs && selfLatest.buffs.includes('reveal');
    for (const p of others) {
      if (p.id === G.selfId) continue;
      if (p.invis && !hasReveal && !G.spectating) continue;
      view.players.push(p);
    }
    if (selfLatest) {
      predictSelf(selfLatest, dt);
      const sp = { ...selfLatest, x: G.pred.x, y: G.pred.y };
      view.players.push(sp); view.self = sp;
    } else { view.lastX = G.pred.x; view.lastY = G.pred.y; }
    view.overview = G.overview;           // global blips for the minimap (whole map, not just AoI slice)
    view.hasReveal = hasReveal;
    if (G.spectating) {
      if (!G.specFree && G.specTarget) {
        const tp = view.players.find(p => p.id === G.specTarget);
        if (tp) view.self = tp;
        else { G.specFree = true; G.specTarget = null; updateSpecUI(); }   // followed player gone -> free
      }
      if (G.specFree) {
        view.self = null;                                     // detach from every player
        view.lastX = G.specCam.x; view.lastY = G.specCam.y;   // free camera: wherever the spectator panned
      } else if (view.self) {
        G.specCam.x = view.self.x; G.specCam.y = view.self.y; // keep cam synced so 自由视角 resumes from here
      } else {
        view.lastX = G.specCam.x; view.lastY = G.specCam.y;   // followed target off-screen this frame
      }
    }
    return view;
  }

  function predictSelf(server, dt) {
    if (!G.pred.ready) { G.pred.x = server.x; G.pred.y = server.y; G.pred.ready = true; return; }
    if (server.dead) { G.pred.x = server.x; G.pred.y = server.y; return; }
    const cls = G.defs.classes[server.cls];
    let dx = (Input.keys.right ? 1 : 0) - (Input.keys.left ? 1 : 0);
    let dy = (Input.keys.down ? 1 : 0) - (Input.keys.up ? 1 : 0);
    if (dx || dy) {
      const len = Math.hypot(dx, dy); dx /= len; dy /= len;
      const sp = cls.speed * (server.buffs && server.buffs.includes('speed') ? 1.42 : 1);
      G.pred.x += dx * sp * dt; G.pred.y += dy * sp * dt;
      // mirror server cover collision so prediction doesn't fight the authority
      for (const o of G.obstacles) {
        const ox = G.pred.x - o.x, oy = G.pred.y - o.y, min = o.r + 22, d2 = ox * ox + oy * oy;
        if (d2 < min * min) { const d = Math.sqrt(d2) || 0.001, push = min - d; G.pred.x += ox / d * push; G.pred.y += oy / d * push; }
      }
      G.pred.x = clamp(G.pred.x, 22, G.world.width - 22);
      G.pred.y = clamp(G.pred.y, 22, G.world.height - 22);
    }
    // gentle reconciliation toward authoritative position
    const err = Math.hypot(server.x - G.pred.x, server.y - G.pred.y);
    if (err > 150) { G.pred.x = server.x; G.pred.y = server.y; }
    else { G.pred.x += (server.x - G.pred.x) * 0.16; G.pred.y += (server.y - G.pred.y) * 0.16; }
  }

  function lerpList(amap, bmap, alpha) {
    const out = [];
    for (const [idk, b] of bmap) {
      const a = amap.get(idk);
      if (a) out.push({ ...b, x: a.x + (b.x - a.x) * alpha, y: a.y + (b.y - a.y) * alpha });
      else out.push(b);
    }
    return out;
  }

  // ---- input -> network ---------------------------------------------------
  function setupInput() {
    Input.init({
      move: (keys) => Net.send({ type: 'input', ...keys }),
      attack: () => { if (!isDead()) { Net.send({ type: 'attack' }); HUD.triggerCd('A', attackCd()); } },
      skill: (slot) => {
        if (isDead()) return;
        const cls = G.defs.classes[G.lastSelf ? G.lastSelf.cls : G.selectedClass];
        const sk = cls && cls.skills[slot];
        if (!sk) return;
        const lvl = G.lastSelf ? G.lastSelf.level : 1;
        if (lvl < (sk.reqLevel || 1)) { HUD.toast(`「${sk.name}」需 Lv.${sk.reqLevel} 解锁`, '#ffd23f'); return; }
        Net.send({ type: 'skill', slot }); HUD.triggerCd(String(slot), sk.cd);
      },
      toggleShop: toggleShopUI,
      escape: () => { if (G.shopOpen) return closeShop(); toggleSettings(); },
      chat: () => { const ci = document.getElementById('chatInput'); ci.focus(); }
    });
  }
  function attackCd() { const c = G.defs.classes[G.lastSelf ? G.lastSelf.cls : G.selectedClass]; return c ? c.attackCd : 500; }
  function isDead() { return G.lastSelf && G.lastSelf.dead; }

  // ---- menu wiring --------------------------------------------------------
  function wireMenu() {
    const saved = localStorage.getItem('brawl_name'); if (saved) document.getElementById('nameInput').value = saved;
    // class picker is built when the server's "defs" message arrives (onDefs)
    document.getElementById('playBtn').addEventListener('click', play);
    document.getElementById('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') play(); });
    const specBtn = document.getElementById('spectateBtn');
    if (specBtn) specBtn.addEventListener('click', spectate);
  }
  function spectate() {
    if (!Net.ready) { HUD.toast('正在连接服务器…', '#ff7a7a'); return; }
    Net.send({ type: 'spectate' });   // server replies with spectateWelcome -> onSpectateWelcome
  }
  function play() {
    if (!Net.ready) { HUD.toast('正在连接服务器…', '#ff7a7a'); return; }
    let name = document.getElementById('nameInput').value.trim().slice(0, 14);
    if (!name) name = '勇士' + Math.floor(Math.random() * 1000);
    localStorage.setItem('brawl_name', name);
    Net.send({ type: 'join', name, cls: G.selectedClass });
    setupInput();
    if (G.isTouch) enterFullscreen();      // immersive play on phones (within the tap gesture)
  }

  // ---- in-game UI wiring --------------------------------------------------
  function wireGameUI() {
    document.querySelectorAll('.op-close').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.close === 'shop') closeShop(); else closeSettings();
    }));
    document.getElementById('btnResume').addEventListener('click', closeSettings);
    document.getElementById('btnReselect').addEventListener('click', reselect);
    document.getElementById('btnQuit').addEventListener('click', quit);
    const fsBtn = document.getElementById('btnFullscreen');
    if (fsBtn) fsBtn.addEventListener('click', toggleFullscreen);
    const mSet = document.getElementById('mobileSettings');
    if (mSet) mSet.addEventListener('click', toggleSettings);   // click fallback alongside pointer handler
    const mFs = document.getElementById('mobileFs');
    if (mFs) mFs.addEventListener('click', toggleFullscreen);
    const mShop = document.getElementById('mobileShop');
    if (mShop) mShop.addEventListener('click', toggleShopUI);
    const mChat = document.getElementById('mobileChat');
    if (mChat) mChat.addEventListener('click', () => { document.body.classList.add('chat-open'); document.getElementById('chatInput').focus(); });
    document.getElementById('btnBackMenu').addEventListener('click', () => {
      document.getElementById('quitScreen').classList.remove('show'); showScreen('menu');
    });
    const form = document.getElementById('chatForm');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const ci = document.getElementById('chatInput');
      const text = ci.value.trim();
      if (text) Net.send({ type: 'chat', text });
      ci.value = ''; ci.blur(); document.body.classList.remove('chat-open');
    });
    const chatInput = document.getElementById('chatInput');
    chatInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.target.blur(); });
    chatInput.addEventListener('blur', () => document.body.classList.remove('chat-open'));
  }

  function buy(itemId) { Net.send({ type: 'buy', item: itemId }); }

  function openShop() { G.shopOpen = true; G.shopCloseAt = 0; document.getElementById('shopPanel').classList.add('show'); if (G.lastSelf) HUD.updateShopGold(G.lastSelf.gold); }
  function closeShop() { G.shopOpen = false; G.shopCloseAt = 0; document.getElementById('shopPanel').classList.remove('show'); }
  function toggleShopUI() { if (G.shopOpen) closeShop(); else if (G.nearMerchant) openShop(); else HUD.toast('附近没有商人', '#ff7a7a'); }

  function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen).call(document.documentElement);
      else (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } catch (e) {}
  }
  function enterFullscreen() {
    try { if (!document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen(); } catch (e) {}
  }
  function toggleSettings() { G.settingsOpen ? closeSettings() : openSettings(); }
  function openSettings() { G.settingsOpen = true; document.getElementById('settingsPanel').classList.add('show'); }
  function closeSettings() { G.settingsOpen = false; document.getElementById('settingsPanel').classList.remove('show'); }

  function reselect() {
    Net.send({ type: 'leave' });
    Input.releaseAll();
    G.selfId = null; G.lastSelf = null; G.snaps.length = 0; G.pred.ready = false; G.deadSince = 0;
    closeSettings(); closeShop(); toggleRespawn(false);
    showScreen('menu');
  }
  function quit() {
    Net.send({ type: 'leave' });
    Input.releaseAll();
    G.selfId = null; G.lastSelf = null; G.snaps.length = 0; G.pred.ready = false;
    closeSettings(); closeShop(); toggleRespawn(false);
    document.getElementById('quitScreen').classList.add('show');
  }

  // ---- screen helpers -----------------------------------------------------
  function showScreen(name) {
    G.screen = name;
    document.getElementById('menu').classList.toggle('show', name === 'menu');
    document.getElementById('game').classList.toggle('show', name === 'game');
    if (name === 'game') Renderer.resize();   // #game was display:none at init → canvas needs real size now
    if (name === 'menu') HUD.updateMenuHistory(G.leaderboard.hist);
  }
  function toggleRespawn(show) { document.getElementById('respawn').classList.toggle('show', !!show); }

  // ---- utils --------------------------------------------------------------
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
})();

// ============================================================================
//  Client bootstrap & game loop.  Owns the menu → game flow, drives prediction
//  + rendering each frame, and reflects authoritative snapshots into the HUD.
// ============================================================================
import { Net } from './network.js';
import { Input } from './input.js';
import { LocalPredictor } from './prediction.js';
import { Renderer } from './renderer.js';
import { buildRects } from '../shared/physics.js';
import { FLOOR_COUNT, WORLD_WIDTH } from '../shared/constants.js';
import {
  setupCreator, randomLook, randomName, fmtTime, renderLeaderboard, escapeHtml,
} from './ui.js';

const $ = (id) => document.getElementById(id);

const app = {
  look: randomLook(),
  name: '',
  level: null,
  brokenIce: new Set(),
  round: 1,
  roundStartMs: 0,
  localServer: null,
  ranking: [],
  planeActive: false,
  started: false,
  localStartMs: 0,  // per-player timer start (server ms)
  finalMs: null,    // frozen finish time once rescued
  rescueDeadline: null, // server ms the plane departs (set after the first escape)
  phase: 'playing',     // last known round phase from snapshots
  escapeRank: null,     // this client's finishing place once rescued (for the spectator badge)
  spectating: false,    // true only AFTER the win banner clears -> camera follows leader + badge
};

const net = new Net();
const input = new Input();
// 无火球道具时，按攻击键给予轻提示（节流）。
let _noAmmoToastAt = 0;
input.onAttackEdge = () => {
  const self = app.localServer;
  if (!self || self.res || self.dead) return; // 未进入/已逃生/已死亡不提示
  if (self.fb) return; // 有火球 buff，正常攻击
  const now = performance.now();
  if (now - _noAmmoToastAt < 1200) return; // 节流
  _noAmmoToastAt = now;
  toast('\ud83d\udd25 需拾取火球道具才能攻击', 'bad');
};
const predictor = new LocalPredictor();
let renderer = null;

// --------------------------------------------------------- viewport scaling
// The game world is authored in a fixed 1600×900 (16:9) space.  Rather than
// stretch that to the window (which distorts on any non-16:9 screen), we fit
// the largest 16:9 frame inside the viewport (letterbox), render the canvas at
// device-pixel resolution for crispness, and scale the HUD layer by the same
// factor.  Result: pixel-accurate, never stretched, at any size or DPR.
const VIEW_W = 1600, VIEW_H = 900, VIEW_AR = VIEW_W / VIEW_H;
const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches
  || (navigator.maxTouchPoints || 0) > 0;

function fitViewport() {
  const game = $('game');
  if (!game || game.classList.contains('hidden')) return; // only while playing
  const stage = $('frame').parentElement; // .stage spans the whole viewport
  const availW = stage.clientWidth, availH = stage.clientHeight;
  if (availW < 1 || availH < 1) return;

  // largest 16:9 box that fits inside the viewport
  let w = availW, h = Math.round(availW / VIEW_AR);
  if (h > availH) { h = availH; w = Math.round(availH * VIEW_AR); }

  $('frame').style.width = w + 'px';
  $('frame').style.height = h + 'px';
  $('ui').style.setProperty('--ui-scale', w / VIEW_W);

  if (renderer) renderer.resize(w, h, Math.min(2, window.devicePixelRatio || 1));

  // on a phone held upright the 16:9 frame is a thin strip — nudge to rotate
  if (IS_TOUCH) {
    const portrait = availH > availW;
    $('rotate-hint').classList.toggle('show', portrait);
    if (portrait) input.releaseAll();
  }
}

window.addEventListener('resize', fitViewport);
window.addEventListener('orientationchange', fitViewport);
if (window.visualViewport) window.visualViewport.addEventListener('resize', fitViewport);

// Wire the on-screen buttons to the same input state the keyboard drives, so
// touch and key controls are fully interchangeable.
function initTouch() {
  if (!IS_TOUCH) return;
  document.body.classList.add('is-touch');
  const bind = (id, key) => {
    const el = $(id);
    if (!el) return;
    const press = (e) => {
      e.preventDefault();
      input.setControl(key, true);
      el.classList.add('pressed');
      try { el.setPointerCapture(e.pointerId); } catch { /* some pointers can't be captured */ }
    };
    const release = () => { input.setControl(key, false); el.classList.remove('pressed'); };
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  };
  bind('tc-left', 'left');
  bind('tc-right', 'right');
  bind('tc-jump', 'jump');
  bind('tc-attack', 'attack');
}

// ----------------------------------------------------------------- chat
function wireChat() {
  // Enter (when not typing) opens the chat input.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Enter') return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    const ci = chatInput;
    if (ci && game && !game.classList.contains('hidden')) {
      e.preventDefault(); ci.focus();
    }
  });

  const form = chatForm;
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const ci = chatInput;
      const text = (ci.value || '').trim();
      if (text) net.sendChat(text);
      ci.value = ''; ci.blur(); document.body.classList.remove('chat-open');
    });
  }
  const ci = chatInput;
  if (ci) {
    ci.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.target.blur(); });
    ci.addEventListener('blur', () => document.body.classList.remove('chat-open'));
  }
  const mChat = $('tc-chat');
  if (mChat) {
    mChat.addEventListener('click', () => {
      document.body.classList.add('chat-open');
      const el = chatInput; if (el) el.focus();
    });
  }
}

// ---------------------------------------------------------------- menu setup
function initMenu() {
  setupCreator($('preview'), app.look);
  $('name-input').value = randomName();

  refreshMenuData();
  setInterval(refreshMenuData, 5000);

  $('start-btn').addEventListener('click', startGame);
  $('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') startGame(); });
}

async function refreshMenuData() {
  try {
    const [st, lb] = await Promise.all([
      fetch('/api/state').then((r) => r.json()),
      fetch('/api/leaderboard').then((r) => r.json()),
    ]);
    $('menu-round').textContent = st.round;
    $('menu-online').textContent = st.players;
    renderLeaderboard($('menu-board'), lb.top);
  } catch { /* server not ready yet */ }
}

// ---------------------------------------------------------------- start game
async function startGame() {
  if (app.started) return;
  app.name = ($('name-input').value || '').trim() || randomName();
  app.started = true;
  $('start-btn').disabled = true;
  $('start-btn').textContent = '连接中…';

  net.connect();
  wireNet();
  const init = await net.join(app.name, app.look);
  applyInit(init);

  $('menu').classList.add('hidden');
  $('game').classList.remove('hidden');
  renderer = new Renderer($('view'));
  fitViewport();                 // size the canvas + HUD to this screen (no stretch)
  input.enable(true);
  requestAnimationFrame(loop);
}

function applyInit(init) {
  app.level = init.level;
  app.round = init.round;
  app.roundStartMs = init.roundStartMs;
  app.brokenIce = new Set(init.brokenIce || []);
  $('hud-round').textContent = init.round;
}

// ------------------------------------------------------------- net handlers
function wireNet() {
  net.on('connect', () => setConn('已连接', 'ok'));
  net.on('disconnect', () => setConn('连接断开 · 重连中', 'bad'));
  net.on('snapshot', onSnapshot);
  net.on('roundStart', (d) => {
    app.level = d.level; app.round = d.round; app.roundStartMs = d.roundStartMs;
    app.brokenIce = new Set();
    app.planeActive = false;
    app.localStartMs = d.roundStartMs;
    app.finalMs = null;
    app.rescueDeadline = null;
    $('hud-round').textContent = d.round;
    hideOverlay(); hideWin(); hideDeathBanner();
    // 新一局开始：显示醒目 banner，并 toast 提示。
    showRoundStartBanner(d.round);
    toast(`第 ${d.round} 局开始！`, 'good');
  });
  net.on('roundEnd', onRoundEnd);
  net.on('rescued', onRescued);
  net.on('plane', () => toast('✈️ 救援飞机来了！看准时机跳起抓住绳子！', 'good'));
  net.on('system', (d) => {
    if (!d || !d.msg) return;
    // 冠亚季军总结、新局开始、普通系统消息都进聊天桦，保证所有人看到。
    addChat('', d.msg, '', true);
    // 新一局开始的系统消息不重复 toast（下面 roundStart 事件会显示 banner）；
    // 其它系统消息（加入/离开/冠亚季军）走 toast。
    if (d.kind === 'roundStart') return;
    toast(d.msg, d.kind === 'roundEnd' ? 'good' : '');
  });
  net.on('chat', (d) => addChat(d.name, d.text, outfitColor(d)));
  net.on('playerDied', onPlayerDied);
}

function onSnapshot(data) {
  app.round = data.round;
  app.roundStartMs = data.rt;
  // Broken ice only ever grows within a round, so rebuild the Set (used by
  // buildRects every frame) only when the count actually changed — not 30×/sec.
  const brokenLen = data.broken ? data.broken.length : 0;
  if (!app.brokenIce || app.brokenIce.size !== brokenLen) {
    app.brokenIce = new Set(data.broken || []);
  }
  app.planeActive = !!data.plane;
  app.ranking = data.ranking || [];
  app.rescueDeadline = data.rescueDeadline || null;
  app.phase = data.phase || app.phase;

  const self = data.players.find((p) => p.id === net.selfId);
  if (self) {
    const age = Math.max(0, (net.now() - data.t) / 1000); // how stale this snapshot is
    predictor.reconcile(self, age);
    app.localServer = self;
    if (self.res) { if (app.finalMs == null && self.fn) app.finalMs = self.fn; }
    else if (data.phase === "intermission") app.localStartMs = null; // round over, not finished
    else app.localStartMs = self.st || app.roundStartMs; // live per-player timer
    if (!self.res) app.finalMs = null; // still climbing: live timer
    if (!self.res) { app.escapeRank = null; app.spectating = false; } // back in the race: reset spectate state
    updateHud(self);
    updateSpectate(self);
    if (!self.dead && app.deathShown) hideDeathBanner();
  }

  if (data.fx && renderer) {
    for (const fx of data.fx) {
      renderer.addFx(fx);
      if (fx.t === 'death' && fx.id === net.selfId) {
        renderer.addShake(22);
        showDeathBanner(fx.cause);
      }
    }
  }

  // The ranking HUD + mini-tower don't need to rebuild their DOM/canvas at the
  // full 30 Hz snapshot rate; ~7 Hz is visually identical and avoids the per-
  // snapshot reflow that grows with player count.
  const tnow = performance.now();
  if (tnow - (app._lastRankAt || 0) >= 140) {
    app._lastRankAt = tnow;
    updateRanking();
  }
}

function onRoundEnd(d) {
  // round over: players who did not finish get no time this round
  if (app.finalMs == null) app.localStartMs = null;
  app.rescueDeadline = null;
  app.escapeRank = null;
  app.spectating = false;
  clearTimeout(app._winTimer); // a still-pending banner->spectate handoff is moot now
  $('depart').classList.add('hidden');
  $('spectate').classList.add('hidden');
  hideWin();
  const ov = $('round-overlay');
  $('ov-title').textContent = `第 ${d.round} 局结束`;
  const ol = $('ov-results');
  ol.innerHTML = '';
  const medals = ['🥇', '🥈', '🥉'];
  d.results.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = 'r' + (i + 1);
    li.innerHTML =
      `<span class="rk">${medals[i] || (i + 1)}</span>` +
      `<span>${escapeHtml(r.name)}</span>` +
      `<span class="tm">${fmtTime(r.timeMs, true)}</span>`;
    ol.appendChild(li);
  });
  if (d.results.length === 0) ol.innerHTML = '<li class="r1"><span>本局无人逃生</span></li>';
  renderLeaderboard($('ov-board'), d.leaderboard);
  ov.classList.remove('hidden');

  let left = Math.ceil(d.nextInMs / 1000);
  $('ov-count').textContent = left;
  clearInterval(app._countTimer);
  app._countTimer = setInterval(() => {
    left -= 1;
    $('ov-count').textContent = Math.max(0, left);
    if (left <= 0) clearInterval(app._countTimer);
  }, 1000);
}

// How long the personal "逃生成功" banner sits before we slip into spectator
// mode. The camera holds on the player's own pickup for this whole beat.
const WIN_BANNER_MS = 6000;

function onRescued(d) {
  if (d.id === net.selfId) {
    app.finalMs = d.timeMs;
    app.escapeRank = d.rank;
    app.spectating = false; // hold the camera on our own pickup until the banner clears
    $('win-detail').textContent =
      `第 ${d.rank} 名 · 用时 ${fmtTime(d.timeMs, true)}` +
      (d.allTimeRank <= 20 ? ` · 历史第 ${d.allTimeRank} 名！` : '');
    $('win-banner').classList.remove('hidden');
    updateSpectate(app.localServer); // badge stays hidden while spectating=false
    clearTimeout(app._winTimer);
    // Let the victory banner sit for a beat; only THEN enter spectator mode.
    app._winTimer = setTimeout(enterSpectate, WIN_BANNER_MS);
    toast(`✈️ 第 ${d.rank} 名逃生成功！`, 'good');
  } else {
    toast(`✈️ ${d.name} 第 ${d.rank} 名逃生！`, 'good');
  }
}

// Fires WIN_BANNER_MS after the local player is rescued: drop the victory banner
// and switch to spectator mode — camera follows the leading climber and the
// persistent 观战 badge (with finishing place) appears.
function enterSpectate() {
  hideWin();
  if (!app.localServer || !app.localServer.res) return; // round already moved on
  app.spectating = true;
  updateSpectate(app.localServer);
  toast('🔭 进入观战模式 · 镜头跟随冲顶选手', 'good');
}

// ----------------------------------------------------------------- game loop
let lastT = performance.now();
let lastSend = 0;
function loop(now) {
 try {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  if (app.level) {
    const tEst = Math.max(0, (net.now() - app.roundStartMs) / 1000);
    const rects = buildRects(app.level.platforms, app.brokenIce, tEst);
    predictor.update(dt, input.state, rects);

    // send input (immediately on change + ~10 Hz heartbeat)
    if (input.dirty || now - lastSend > 100) {
      net.sendInput(input.message());
      lastSend = now;
    }

    renderer.update(dt);
    // once rescued, the camera follows the leading climber still racing the
    // departure countdown instead of locking onto the empty summit.
    let spectateY = null;
    if (app.spectating && app.phase === 'playing' && app.localServer && app.localServer.res) {
      const lead = (app.ranking || []).find((p) => !p.rescued);
      if (lead) spectateY = lead.y;
    }
    renderer.draw({
      level: app.level,
      brokenIce: app.brokenIce,
      tEst,
      rects, // reuse the collision rects already built for prediction this frame
      local: predictor.view(),
      localServer: app.localServer,
      localLook: app.look,
      localName: app.name,
      selfId: net.selfId,
      remote: net.renderState(),
      spectateY,
    }, dt);

    // live per-player timer (frozen once rescued)
    const ms = app.finalMs != null ? app.finalMs : (app.localStartMs ? Math.max(0, net.now() - app.localStartMs) : 0);
    $('timer').textContent = fmtTime(ms);
    updateDepart();
  }
 } catch (err) {
   // a single bad frame shouldn't freeze the client — log and keep going
   console.error('render loop error:', err);
 }
  requestAnimationFrame(loop);
}

// --------------------------------------------------------------------- HUD
function updateHud(self) {
  $('hud-floor').textContent = Math.min(FLOOR_COUNT, self.floor + 1);
  const hp = Math.max(0, self.hp);
  $('hp-fill').style.width = hp + '%';
  $('hp-text').textContent = hp;

  const buffs = $('buffs');
  buffs.innerHTML = '';
  if (self.fb) buffs.appendChild(buffChip('🔥', '火球'));
  if (self.jb) buffs.appendChild(buffChip('⬆️', '高跳'));
  if (self.spd) buffs.appendChild(buffChip('💨', '加速'));
  if (self.sh) buffs.appendChild(buffChip('🛡️', '免伤'));
}

function buffChip(icon, label) {
  const d = document.createElement('div');
  d.className = 'buff';
  d.textContent = icon;
  d.title = label;
  return d;
}

// Final-departure countdown HUD: seconds until the rescue plane leaves, shown
// once the first player has escaped. Driven each frame off the synced server
// clock so it ticks smoothly even between (or without) snapshots.
function updateDepart() {
  const el = $('depart');
  if (!el) return;
  const dl = app.rescueDeadline;
  if (!dl) { el.classList.add('hidden'); return; }
  const secs = Math.max(0, Math.ceil((dl - net.now()) / 1000));
  $('depart-count').textContent = secs;
  el.classList.toggle('urgent', secs <= 10);
  el.classList.remove('hidden');
}

// This client's finishing place once rescued. Prefer the value cached from the
// `rescued` event; fall back to our own row in the ranking (carries `rank`).
function selfRescueRank() {
  if (app.escapeRank) return app.escapeRank;
  const r = (app.ranking || []).find((p) => p.id === net.selfId);
  return r && r.rescued ? r.rank : null;
}

// Persistent "you've escaped, now spectating" badge. Stays up the entire time
// the local player is rescued and the round is still running, so the finishing
// place (第几名) and the spectator state are always on screen — not just for the
// few seconds the win banner is visible. Auto-hides at intermission / new round.
function updateSpectate(self) {
  const el = $('spectate');
  if (!el) return;
  if (self && self.res && app.phase === 'playing' && app.spectating) {
    const rank = selfRescueRank();
    $('sp-rank').textContent = rank != null ? rank : '—';
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function updateRanking() {
  const list = $('rank-list');
  list.innerHTML = '';
  const top = app.ranking.slice(0, 8);
  const medals = ['🥇', '🥈', '🥉'];
  top.forEach((p, i) => {
    const li = document.createElement('li');
    if (p.id === net.selfId) li.classList.add('me');
    const color = p.color || '#5ad1ff';
    const tag = p.rescued ? '✈️' : (i < 3 ? medals[i] : '');
    li.innerHTML =
      `<span class="dot" style="background:${color}"></span>` +
      `<span class="nm">${escapeHtml(p.name)}</span>` +
      `<span class="fl">${tag}${p.rescued ? '' : (p.floor + 1) + 'F'}</span>`;
    list.appendChild(li);
  });
  drawMiniTower(app.ranking);
}

function drawMiniTower(ranking) {
  const cv = $('mini');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  // floor rungs
  ctx.strokeStyle = 'rgba(255,255,255,.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i < FLOOR_COUNT; i++) {
    const y = H - 8 - (i / (FLOOR_COUNT - 1)) * (H - 16);
    ctx.beginPath(); ctx.moveTo(6, y); ctx.lineTo(W - 6, y); ctx.stroke();
  }
  for (const p of ranking) {
    const fl = p.rescued ? FLOOR_COUNT - 1 : p.floor;
    const y = H - 8 - (fl / (FLOOR_COUNT - 1)) * (H - 16);
    const x = 10 + ((p.x || WORLD_WIDTH / 2) / WORLD_WIDTH) * (W - 20);
    ctx.fillStyle = p.color || '#5ad1ff';
    ctx.beginPath(); ctx.arc(x, y - 3, p.id === net.selfId ? 4 : 3, 0, 7); ctx.fill();
    if (p.id === net.selfId) { ctx.strokeStyle = '#ffd84a'; ctx.lineWidth = 1.5; ctx.stroke(); }
  }
}

// ------------------------------------------------------------------- toasts
function toast(msg, kind = '') {
  const wrap = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 2900);
}

// ---- chat ----
// Derive a chat color from a snapshot/chat player's outfit look.
function outfitColor(d) {
  const ranking = app.ranking || [];
  const p = d && d.id ? ranking.find((r) => r.id === d.id) : null;
  return (p && p.color) || '#5ad1ff';
}

function addChat(name, text, color, sys) {
  const log = chatLog;
  if (!log) return;
  const line = document.createElement('div');
  line.className = 'line' + (sys ? ' sys' : '');
  if (sys || !name) {
    line.textContent = text;
  } else {
    line.innerHTML = '<span class="who" style="color:' + (color || '#9be7ff') + '">' + escapeHtml(name) + '：</span>' + escapeHtml(text);
  }
  log.appendChild(line);
  while (log.children.length > 40) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function deathMsg(cause) {
  const m = {
    fall: '摔得太狠了！回到第一层',
    monster: '被怪物击倒！回到第一层',
    icicle: '被冰锥砸中！回到第一层',
    fire: '被火球击倒！回到第一层',
    freeze: '被冰冻击倒！回到第一层',
    pvp: '被其他玩家击败！回到第一层',
  };
  return m[cause] || '你倒下了！回到第一层';
}

function onPlayerDied(d) {
  if (d.id === net.selfId) {
    renderer && renderer.addShake(22);
    showDeathBanner(d.cause);
  } else {
    toast(`💀 ${d.name} 倒下了`, 'bad');
  }
}

function deathLabel(cause) {
  const m = {
    fall: '摔得太狠了',
    monster: '被怪物击倒',
    icicle: '被冰锥砸中',
    fire: '被火球击倒',
    freeze: '被冰冻击倒',
    pvp: '被其他玩家击败',
  };
  return m[cause] || '你倒下了';
}

function showDeathBanner(cause) {
  if (app.deathShown) return;
  app.deathShown = true;
  const el = $('death-banner');
  if (!el) return;
  $('death-reason').textContent = deathLabel(cause);
  el.classList.remove('hidden');
}

function hideDeathBanner() {
  app.deathShown = false;
  const el = $('death-banner');
  if (el) el.classList.add('hidden');
}

function hideOverlay() { $('round-overlay').classList.add('hidden'); }
function hideWin() { $('win-banner').classList.add('hidden'); }
// 显示新一局开始 banner，约2.6s 后自动隐藏。
function showRoundStartBanner(round) {
  const el = $('round-start-banner');
  if (!el) return;
  $('rs-title').textContent = `第 ${round} 局开始！`;
  el.classList.remove('hidden');
  // 重启出场动画。
  const inner = el.querySelector('.rs-inner');
  if (inner) { inner.style.animation = 'none'; void inner.offsetWidth; inner.style.animation = ''; }
  clearTimeout(app._rsTimer);
  app._rsTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}
function setConn(text, cls) {
  const el = $('conn-status');
  el.textContent = text;
  el.className = 'conn-status ' + (cls || '');
}

initMenu();
initTouch();
wireChat();

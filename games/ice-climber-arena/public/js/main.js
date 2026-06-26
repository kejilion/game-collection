// ============================================================================
//  Client bootstrap & game loop.  Owns the menu → game flow, drives prediction
//  + rendering each frame, and reflects authoritative snapshots into the HUD.
// ============================================================================
import { Net } from './network.js';
import { Input } from './input.js';
import { LocalPredictor } from './prediction.js';
import { Renderer } from './renderer.js';
import { buildRects } from '../shared/physics.js';
import { FLOOR_COUNT } from '../shared/constants.js';
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
};

const net = new Net();
const input = new Input();
const predictor = new LocalPredictor();
let renderer = null;

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
    $('hud-round').textContent = d.round;
    hideOverlay(); hideWin();
    toast(`第 ${d.round} 局开始！`, 'good');
  });
  net.on('roundEnd', onRoundEnd);
  net.on('rescued', onRescued);
  net.on('plane', () => toast('✈️ 救援飞机来了！跳上去逃生！', 'good'));
  net.on('system', (d) => { if (d && d.msg) toast(d.msg); });
}

function onSnapshot(data) {
  app.round = data.round;
  app.roundStartMs = data.rt;
  app.brokenIce = new Set(data.broken || []);
  app.planeActive = !!data.plane;
  app.ranking = data.ranking || [];

  const self = data.players.find((p) => p.id === net.selfId);
  if (self) {
    const age = Math.max(0, (net.now() - data.t) / 1000); // how stale this snapshot is
    predictor.reconcile(self, age);
    app.localServer = self;
    updateHud(self);
  }

  if (data.fx && renderer) {
    for (const fx of data.fx) {
      renderer.addFx(fx);
      if (fx.t === 'death' && fx.id === net.selfId) toast(deathMsg(fx.cause), 'bad');
    }
  }

  updateRanking();
}

function onRoundEnd(d) {
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

function onRescued(d) {
  if (d.id === net.selfId) {
    $('win-detail').textContent =
      `第 ${d.rank} 名 · 用时 ${fmtTime(d.timeMs, true)}` +
      (d.allTimeRank <= 20 ? ` · 历史第 ${d.allTimeRank} 名！` : '');
    $('win-banner').classList.remove('hidden');
    clearTimeout(app._winTimer);
    app._winTimer = setTimeout(hideWin, 4500);
  } else {
    toast(`✈️ ${d.name} 第 ${d.rank} 名逃生！`, 'good');
  }
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
    renderer.draw({
      level: app.level,
      brokenIce: app.brokenIce,
      tEst,
      local: predictor.view(),
      localServer: app.localServer,
      localLook: app.look,
      localName: app.name,
      selfId: net.selfId,
      remote: net.renderState(),
    }, dt);

    // live timer
    $('timer').textContent = fmtTime(net.now() - app.roundStartMs);
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
}

function buffChip(icon, label) {
  const d = document.createElement('div');
  d.className = 'buff';
  d.textContent = icon;
  d.title = label;
  return d;
}

function updateRanking() {
  const list = $('rank-list');
  list.innerHTML = '';
  const top = app.ranking.slice(0, 8);
  const medals = ['🥇', '🥈', '🥉'];
  top.forEach((p, i) => {
    const li = document.createElement('li');
    if (p.id === net.selfId) li.classList.add('me');
    const color = (p.look && p.look.outfit) || '#5ad1ff';
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
    const x = 10 + ((p.x || 480) / 960) * (W - 20);
    ctx.fillStyle = (p.look && p.look.outfit) || '#5ad1ff';
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

function hideOverlay() { $('round-overlay').classList.add('hidden'); }
function hideWin() { $('win-banner').classList.add('hidden'); }
function setConn(text, cls) {
  const el = $('conn-status');
  el.textContent = text;
  el.className = 'conn-status ' + (cls || '');
}

initMenu();

'use strict';

// 客户端主控：网络消息 → 世界状态 → 预测/插值渲染 + HUD/特效/音效调度。
//
// 高延迟优化：
//  - 本机玩家：本地预测移动（与服务端相同的碰撞规则）+ 快照平滑纠偏
//  - 其他实体：双快照插值，插值延迟按实测快照间隔与抖动自适应
//  - 音效/震动按与镜头的距离衰减，远处的战斗不打扰

(function () {
  const $ = (id) => document.getElementById(id);

  const els = {
    canvas: $('game'),
    minimap: $('minimap'),
    stage: $('stage'),
    overlay: $('overlay'),
    joinScreen: $('join-screen'),
    nameInput: $('name-input'),
    joinBtn: $('join-btn'),
    joinLb: $('join-leaderboard'),
    colorPicker: $('color-picker'),
    menuScreen: $('menu-screen'),
    boardScreen: $('board-screen'),
    boardLive: $('board-live'),
    boardHistory: $('board-history'),
    quitScreen: $('quit-screen'),
    reconnectScreen: $('reconnect-screen'),
    playersPanel: $('players-panel'),
    toastArea: $('toast-area'),
    respawnBanner: $('respawn-banner'),
    respawnText: $('respawn-text'),
    statBomb: $('stat-bomb'),
    statFire: $('stat-fire'),
    statSpeed: $('stat-speed'),
    statShield: $('stat-shield'),
    statScore: $('stat-score'),
    statPing: $('stat-ping'),
    btnBoard: $('btn-board'),
    btnMenu: $('btn-menu'),
    menuResume: $('menu-resume'),
    menuSound: $('menu-sound'),
    menuMusic: $('menu-music'),
    menuReselect: $('menu-reselect'),
    menuQuit: $('menu-quit'),
    boardClose: $('board-close'),
    quitRejoin: $('quit-rejoin'),
    chatLog: $('chat-log'),
    chatForm: $('chat-form'),
    chatInput: $('chat-input'),
    chatBtn: $('chat-btn'),
    deathVignette: $('death-vignette'),
  };

  const POWERUP_NAMES = ['💣 炸弹+1', '🔥 火力+1', '⚡ 速度+1', '🛡️ 护盾'];
  // 与 server/config.js 保持一致的移动常量（用于本地预测）
  const BASE_SPEED = 3.0, SPEED_STEP = 0.35, PLAYER_R = 0.36;

  const state = {
    cols: 41, rows: 33,
    grid: null,
    myId: null,
    joined: false,
    quit: false,
    menuOpen: false,
    boardOpen: false,
    myName: localStorage.getItem('bp-name') || '',
    myColor: Number(localStorage.getItem('bp-color') || 0),
    roster: new Map(),
    snaps: [],          // 插值缓冲 {at, p:Map, m:Map}
    latest: null,
    blastAges: new Map(),
    tickRate: 30,
    snapEvery: 2,
    respawnDelay: 2.5,
    renderer: null,
    // 本机预测
    pred: { x: 0, y: 0, ok: false },
    // 服务器 tick 时间轴（抗到达抖动的插值基准）
    srvOffset: null, srvJitter: 5, snapMs: 66.7,
    // 延迟测量
    pingSeq: 0, pingSent: new Map(), rtt: 0,
    // 聊天气泡：玩家 id -> { text, until }（客户端本地维护，不占快照）
    bubbles: new Map(),
  };

  window.__game = state; // 调试用

  // ---------- 网络 ----------

  const net = Net.create({
    onOpen() {
      els.reconnectScreen.classList.add('hidden');
      if (state.joined && state.myName) {
        net.send({ t: 'join', name: state.myName, color: state.myColor });
      }
      updateOverlay();
    },
    onClose() {
      if (state.joined && !state.quit) {
        els.reconnectScreen.classList.remove('hidden');
        updateOverlay();
      }
    },
    onMessage(msg) {
      if (msg.t === 's') onSnapshot(msg);
      else if (msg.t === 'roster') onRoster(msg.list);
      else if (msg.t === 'hello') onHello(msg);
      else if (msg.t === 'you') {
        state.myId = msg.id;
        state.joined = true;
        state.pred.ok = false;
        updateOverlay();
      } else if (msg.t === 'pong') {
        const sent = state.pingSent.get(msg.id);
        if (sent != null) {
          state.pingSent.delete(msg.id);
          const rtt = performance.now() - sent;
          state.rtt = state.rtt === 0 ? rtt : state.rtt * 0.7 + rtt * 0.3;
        }
      } else if (msg.t === 'full') {
        toast('😥 房间已满，稍后再试');
      } else if (msg.t === 'chat') {
        addChatLine(msg.name, msg.text, msg.color);
        state.bubbles.set(msg.id, { text: msg.text, until: performance.now() + 6000 });
      }
    },
  });

  function onHello(msg) {
    state.cols = msg.cols;
    state.rows = msg.rows;
    state.tickRate = msg.tick || 30;
    state.snapEvery = msg.snapEvery || 2;
    state.snapMs = (1000 / state.tickRate) * state.snapEvery;
    state.respawnDelay = msg.respawn || 2.5;
    state.grid = msg.grid.map((row) => row.split('').map(Number));
    ensureRenderer();
    renderJoinLeaderboard(msg.lb);
    updateOverlay();
  }

  // 渲染器惰性创建：等舞台完成布局（尺寸非 0）后再建，
  // 视野拉近：按屏幕短边约显示 12 格，看清自己附近的战况
  function ensureRenderer() {
    if (state.renderer || !state.grid) return;
    const w = els.stage.clientWidth, h = els.stage.clientHeight;
    if (w < 50 || h < 50) return; // 布局未就绪，下一帧再试
    const ts = Math.max(48, Math.min(84, Math.round(Math.min(w, h) / 12)));
    state.renderer = Renderer.create(els.canvas, els.minimap, state.cols, state.rows, ts);
    resize();
  }

  function onRoster(list) {
    state.roster = new Map(list.map((p) => [p.id, p]));
    renderPlayersPanel();
  }

  function onSnapshot(s) {
    state.latest = s;
    const now = performance.now();
    // 服务器 tick 时间轴：快照按 tick 序号定位（服务端模拟严格贴墙钟，
    // tick 序号等距）。到达抖动只影响缓慢平滑的时钟偏移估计，
    // 不再直接转化为回放速度的抖动。
    const srvMs = s.n * (1000 / state.tickRate);
    const offset = now - srvMs;
    if (state.srvOffset == null || Math.abs(offset - state.srvOffset) > 1000) {
      state.srvOffset = offset; // 初次同步 / 服务器重启：直接重置
      state.srvJitter = 5;
    } else {
      state.srvJitter = state.srvJitter * 0.9 + Math.abs(offset - state.srvOffset) * 0.1;
      state.srvOffset += (offset - state.srvOffset) * 0.05; // 缓慢跟踪时钟漂移
    }

    const pm = new Map(), mm = new Map();
    for (const row of s.p) pm.set(row[0], row);
    for (const row of s.m) mm.set(row[0], row);
    state.snaps.push({ at: srvMs, p: pm, m: mm });
    if (state.snaps.length > 16) state.snaps.shift();

    // 本机预测纠偏
    const me = pm.get(state.myId);
    if (me && me[5] === 1) {
      if (!state.pred.ok) {
        state.pred.x = me[1]; state.pred.y = me[2]; state.pred.ok = true;
      } else {
        const dx = me[1] - state.pred.x, dy = me[2] - state.pred.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) {
          state.pred.x = me[1]; state.pred.y = me[2];
        } else {
          const k = input && input.currentDir() >= 0 ? 0.18 : 0.35;
          state.pred.x += dx * k;
          state.pred.y += dy * k;
        }
      }
    }

    // 火焰出现时间（用于动画相位）
    const seen = new Set();
    for (const f of s.f) {
      const key = f[0] + ',' + f[1];
      seen.add(key);
      if (!state.blastAges.has(key)) state.blastAges.set(key, now);
    }
    for (const key of state.blastAges.keys()) {
      if (!seen.has(key)) state.blastAges.delete(key);
    }

    for (const ev of s.e) handleEvent(ev);
    updateHUD(s);
  }

  // ---------- 事件（音效/特效/播报） ----------

  // 距离衰减：以镜头为中心，近满响、远渐弱、太远不响
  function volAt(x, y) {
    const R = state.renderer;
    if (!R) return 1;
    const dx = Math.abs((x + 0.5) * R.TS - R.cam.x) / R.TS;
    const dy = Math.abs((y + 0.5) * R.TS - R.cam.y) / R.TS;
    const d = Math.max(dx, dy);
    if (d > 16) return 0;
    if (d < 7) return 1;
    return Math.max(0.12, 1 - (d - 7) / 9);
  }

  function nameOf(id) {
    const p = state.roster.get(id);
    return p ? p.name : '???';
  }

  function handleEvent(ev) {
    const R = state.renderer;
    switch (ev.e) {
      case 'bomb': {
        const k = volAt(ev.x, ev.y);
        if (k > 0) GameAudio.sfx.place(k);
        break;
      }
      case 'boom': {
        const k = volAt(ev.x, ev.y);
        if (k > 0) GameAudio.sfx.boom(k);
        if (R && R.inView(ev.x, ev.y, 4)) {
          R.shake((2 + Math.min(4, ev.r)) * k, 0.25);
          R.burst(ev.x, ev.y, 10, ['#ffd93d', '#ff8c42', '#fff'], 4, 0.5);
        }
        break;
      }
      case 'tile':
        if (state.grid) state.grid[ev.y][ev.x] = ev.v;
        if (ev.fx === 'brick') {
          const k = volAt(ev.x, ev.y);
          if (k > 0) GameAudio.sfx.brick(k);
          if (R && R.inView(ev.x, ev.y)) R.burst(ev.x, ev.y, 8, ['#e0995a', '#b06a2c', '#8a5a2c'], 3, 0.5);
        } else if (ev.fx === 'grow' && R && R.inView(ev.x, ev.y)) {
          R.addGrowBlock(ev.x, ev.y);
          const k = volAt(ev.x, ev.y);
          if (k > 0) GameAudio.sfx.grow(k);
        }
        break;
      case 'pick': {
        const mine = ev.id === state.myId;
        GameAudio.sfx.pick(mine ? 1 : volAt(ev.x, ev.y) * 0.6);
        if (R && R.inView(ev.x, ev.y)) R.addFloatText(ev.x, ev.y, POWERUP_NAMES[ev.k] || '?', '#ffd93d');
        break;
      }
      case 'burn':
        if (R && R.inView(ev.x, ev.y)) R.burst(ev.x, ev.y, 5, ['#ffd93d', '#aaa'], 2, 0.4);
        break;
      case 'die': {
        const mine = ev.id === state.myId;
        GameAudio.sfx.die(mine ? 1 : volAt(ev.x, ev.y));
        if (mine && R) R.flash('255,60,60', 0.5); // 死亡红闪
        const p = state.roster.get(ev.id);
        if (R && p && R.inView(ev.x, ev.y)) R.addDeathGhost(ev.x, ev.y, p.color);
        // 击杀播报
        const victim = nameOf(ev.id);
        if (ev.by == null) toast(`👾 ${victim} 被怪物抓住了`);
        else if (ev.by === ev.id) toast(`💫 ${victim} 被自己炸飞了`);
        else toast(`💥 ${nameOf(ev.by)} 炸飞了 ${victim}`);
        if (mine && navigator.vibrate) navigator.vibrate(180);
        break;
      }
      case 'mdie': {
        const k = volAt(ev.x, ev.y);
        if (k > 0) GameAudio.sfx.mdie(k);
        if (R && R.inView(ev.x, ev.y)) {
          const gold = ev.mt === 3;
          R.burst(ev.x, ev.y, gold ? 20 : 12, gold ? ['#ffd24a', '#fff', '#ffb800'] : ['#6fd44e', '#b28dff', '#fff'], 4, 0.6);
          R.addFloatText(ev.x, ev.y, gold ? '+500' : ['+50', '+100', '+150'][ev.mt] || '+50', gold ? '#ffd24a' : '#6fd44e');
        }
        if (ev.mt === 3) toast('✨ 金史莱姆被抓住了！');
        break;
      }
      case 'shield':
        GameAudio.sfx.shield();
        if (ev.id === state.myId) toast('🛡️ 护盾抵挡了一次伤害！');
        break;
      case 'streak': {
        const label = ev.n >= 5 ? '超神' : ev.n === 4 ? '四连杀' : ev.n === 3 ? '三连杀' : '双杀';
        toast(`🔥 ${nameOf(ev.id)} ${label}！`, true);
        if (ev.id === state.myId) GameAudio.sfx.streak();
        break;
      }
      case 'spawn':
        if (ev.id === state.myId) {
          state.pred.x = ev.x;
          state.pred.y = ev.y;
          state.pred.ok = true;
          GameAudio.sfx.respawn();
          // 镜头直接切到出生点 + 出生特效，一眼找到自己
          if (R) {
            R.snapCamera(ev.x, ev.y);
            R.addSpawnFx(ev.x, ev.y);
          }
        }
        break;
      case 'join':
        if (ev.id !== state.myId) toast(`👋 ${ev.name} 加入了战场`);
        addChatLine(null, `${ev.name} 加入了战场`);
        break;
      case 'leave':
        toast(`🚪 ${ev.name} 离开了战场`);
        addChatLine(null, `${ev.name} 离开了战场`);
        state.bubbles.delete(ev.id);
        break;
    }
  }

  // ---------- HUD ----------

  function updateHUD(s) {
    const me = s.p.find((row) => row[0] === state.myId);
    if (me) {
      els.statBomb.textContent = `💣 ${me[8]}`;
      els.statFire.textContent = `🔥 ${me[9]}`;
      els.statSpeed.textContent = `⚡ ${me[10]}`;
      els.statShield.classList.toggle('off', me[6] !== 1);
      els.statScore.textContent = `⭐ ${me[11]}`;
      // 重生倒计时 + 死亡蒙版（画布褪色 + 暗角）
      const dead = me[5] === 0;
      if (dead) {
        els.respawnBanner.classList.remove('hidden');
        els.respawnText.textContent = `${Math.max(0, me[13]).toFixed(1)}s 后重生`;
      } else {
        els.respawnBanner.classList.add('hidden');
      }
      els.canvas.classList.toggle('dead', dead);
      els.deathVignette.classList.toggle('show', dead);
    } else {
      els.respawnBanner.classList.add('hidden');
      els.canvas.classList.remove('dead');
      els.deathVignette.classList.remove('show');
    }

    // 分数实时刷新
    let dirty = false;
    for (const row of s.p) {
      const r = state.roster.get(row[0]);
      if (r && (r.score !== row[11] || r.alive !== (row[5] === 1) || r.kills !== row[12])) {
        r.score = row[11];
        r.kills = row[12];
        r.alive = row[5] === 1;
        dirty = true;
      }
    }
    if (dirty) {
      renderPlayersPanel();
      if (state.boardOpen) renderBoardLive();
    }
  }

  function renderPlayersPanel() {
    const rows = [...state.roster.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((p) => {
        const cls = ['player-row'];
        if (!p.alive) cls.push('dead');
        if (p.id === state.myId) cls.push('me');
        const color = Renderer.PLAYER_COLORS[p.color % 8][0];
        return `<div class="${cls.join(' ')}">
          <span class="dot" style="background:${color}"></span>
          <span class="pname">${escapeHtml(p.name)}</span>
          <span class="pscore">${p.score}</span>
        </div>`;
      });
    els.playersPanel.innerHTML = rows.join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function renderJoinLeaderboard(lb) {
    if (!lb || lb.length === 0) {
      els.joinLb.innerHTML = '';
      return;
    }
    const rows = lb.map((e, i) =>
      `<tr><td>${['🥇', '🥈', '🥉', '4.', '5.'][i] || ''}</td><td>${escapeHtml(e.name)}</td><td>${e.best} 分</td><td>${e.kills} 杀</td></tr>`);
    els.joinLb.innerHTML = `<div class="lb-title">📜 历史最佳</div><table>${rows.join('')}</table>`;
  }

  // 聊天日志：name 为 null 时是系统消息；上限 40 条，自动滚到底部
  function addChatLine(name, text, color) {
    const line = document.createElement('div');
    if (name == null) {
      line.className = 'line sys';
      line.textContent = text;
    } else {
      line.className = 'line';
      const c = Renderer.PLAYER_COLORS[(color || 0) % 8][0];
      line.innerHTML =
        `<span class="who" style="color:${c}">${escapeHtml(name)}：</span>${escapeHtml(text)}`;
    }
    els.chatLog.appendChild(line);
    while (els.chatLog.children.length > 40) els.chatLog.firstChild.remove();
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function openChat() {
    if (!state.joined || state.quit || state.menuOpen || state.boardOpen) return;
    document.body.classList.add('chat-open');
    els.chatInput.focus();
  }

  els.chatForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = els.chatInput.value.trim();
    if (text) net.send({ t: 'chat', text });
    els.chatInput.value = '';
    els.chatInput.blur();
  });
  els.chatInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      els.chatInput.blur();
    }
  });
  els.chatInput.addEventListener('blur', () => document.body.classList.remove('chat-open'));
  els.chatBtn.addEventListener('click', openChat);

  function toast(text, big = false) {
    const div = document.createElement('div');
    div.className = big ? 'toast big' : 'toast';
    div.textContent = text;
    els.toastArea.appendChild(div);
    setTimeout(() => div.remove(), 3000);
    while (els.toastArea.children.length > 4) els.toastArea.firstChild.remove();
  }

  // ---------- 排行榜界面 ----------

  function renderBoardLive() {
    const rows = [...state.roster.values()]
      .sort((a, b) => b.score - a.score)
      .map((p, i) => `<tr class="${p.id === state.myId ? 'me' : ''}">
        <td>${i + 1}.</td><td>${escapeHtml(p.name)}</td>
        <td>⭐${p.score}</td><td>⚔️${p.kills}</td><td>💀${p.deaths}</td>
      </tr>`);
    els.boardLive.innerHTML = rows.join('') || '<tr><td>暂无玩家</td></tr>';
  }

  async function renderBoardHistory() {
    try {
      const res = await fetch('api/leaderboard');
      const lb = await res.json();
      const rows = lb.map((e, i) =>
        `<tr><td>${i + 1}.</td><td>${escapeHtml(e.name)}</td><td>⭐${e.best}</td><td>⚔️${e.kills}</td></tr>`);
      els.boardHistory.innerHTML = rows.join('') || '<tr><td>暂无记录</td></tr>';
    } catch {
      els.boardHistory.innerHTML = '<tr><td>加载失败</td></tr>';
    }
  }

  // ---------- 覆盖层 ----------

  function updateOverlay() {
    const showJoin = !state.joined && !state.quit;
    const showMenu = state.joined && state.menuOpen;
    const showBoard = state.boardOpen;
    const showQuit = state.quit;
    const showReconnect = !els.reconnectScreen.classList.contains('hidden');

    els.joinScreen.classList.toggle('hidden', !showJoin || showBoard);
    els.menuScreen.classList.toggle('hidden', !showMenu || showBoard);
    els.boardScreen.classList.toggle('hidden', !showBoard);
    els.quitScreen.classList.toggle('hidden', !showQuit);

    const any = showJoin || showMenu || showBoard || showQuit || showReconnect;
    els.overlay.classList.toggle('hidden', !any);
  }

  // ---------- 选角与加入 ----------

  function buildColorPicker() {
    els.colorPicker.innerHTML = Renderer.PLAYER_COLORS.map(([c], i) =>
      `<div class="swatch ${i === state.myColor ? 'sel' : ''}" data-c="${i}" style="background:${c}"></div>`).join('');
    els.colorPicker.querySelectorAll('.swatch').forEach((el) => {
      el.addEventListener('click', () => {
        state.myColor = Number(el.dataset.c);
        localStorage.setItem('bp-color', String(state.myColor));
        els.colorPicker.querySelectorAll('.swatch').forEach((e) =>
          e.classList.toggle('sel', e === el));
      });
    });
  }
  buildColorPicker();

  function join() {
    const name = els.nameInput.value.trim() || '玩家' + Math.floor(Math.random() * 999);
    state.myName = name;
    localStorage.setItem('bp-name', name);
    GameAudio.unlock();
    GameAudio.startMusic();
    net.send({ t: 'join', name, color: state.myColor });
  }

  els.nameInput.value = state.myName;
  els.joinBtn.addEventListener('click', join);
  els.nameInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') join();
  });

  // ---------- 菜单 ----------

  function toggleMenu(force) {
    if (!state.joined) return;
    state.menuOpen = force != null ? force : !state.menuOpen;
    state.boardOpen = false;
    updateOverlay();
  }

  function toggleBoard(force) {
    state.boardOpen = force != null ? force : !state.boardOpen;
    if (state.boardOpen) {
      renderBoardLive();
      renderBoardHistory();
    }
    updateOverlay();
  }

  function updateAudioLabels() {
    els.menuSound.textContent = GameAudio.sfxOn ? '🔊 音效：开' : '🔇 音效：关';
    els.menuMusic.textContent = GameAudio.musicOn ? '🎵 音乐：开' : '🎵 音乐：关';
  }

  els.btnMenu.addEventListener('click', () => toggleMenu());
  els.btnBoard.addEventListener('click', () => toggleBoard());
  els.menuResume.addEventListener('click', () => toggleMenu(false));
  els.menuSound.addEventListener('click', () => { GameAudio.toggleSfx(); updateAudioLabels(); });
  els.menuMusic.addEventListener('click', () => { GameAudio.toggleMusic(); updateAudioLabels(); });
  els.menuReselect.addEventListener('click', () => {
    net.send({ t: 'leave' });
    state.joined = false;
    state.myId = null;
    state.menuOpen = false;
    state.pred.ok = false;
    updateOverlay();
  });
  els.menuQuit.addEventListener('click', () => {
    net.send({ t: 'leave' });
    state.quit = true;
    state.menuOpen = false;
    net.destroy();
    updateOverlay();
  });
  els.boardClose.addEventListener('click', () => toggleBoard(false));
  els.quitRejoin.addEventListener('click', () => location.reload());
  updateAudioLabels();

  // ---------- 输入 ----------

  const input = GameInput.create({
    onDir(d) { net.send({ t: 'in', d }); },
    onBomb() {
      if (state.menuOpen || state.boardOpen) return;
      net.send({ t: 'bomb' });
    },
    onMenu() {
      if (state.boardOpen) toggleBoard(false);
      else toggleMenu();
    },
    onBoard() { toggleBoard(); },
    onChat() { openChat(); },
    onAnyKey() { GameAudio.unlock(); },
  });

  // ---------- 延迟测量 ----------

  setInterval(() => {
    if (!net.connected) return;
    const id = ++state.pingSeq;
    state.pingSent.set(id, performance.now());
    if (state.pingSent.size > 10) {
      state.pingSent.delete(state.pingSeq - 10);
    }
    net.send({ t: 'ping', id });
    els.statPing.textContent = state.rtt > 0 ? `📶 ${Math.round(state.rtt)}ms` : '📶 --';
  }, 2000);

  // ---------- 本机移动预测（与服务端相同的碰撞规则） ----------

  function tileSolidLocal(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= state.cols || ty >= state.rows) return true;
    if (state.grid[ty][tx] !== 0) return true;
    if (state.latest) {
      for (const b of state.latest.b) {
        if (b[1] === tx && b[2] === ty) {
          // 自己正压着的炸弹可以继续通过（对应服务端 passers 规则）
          const over = Math.abs(state.pred.x - tx) < 0.5 + PLAYER_R &&
                       Math.abs(state.pred.y - ty) < 0.5 + PLAYER_R;
          if (!over) return true;
        }
      }
    }
    return false;
  }

  function boxHitsLocal(x, y) {
    const r = PLAYER_R;
    const minX = Math.round(x - r), maxX = Math.round(x + r);
    const minY = Math.round(y - r), maxY = Math.round(y + r);
    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) {
        if (tileSolidLocal(tx, ty)) return true;
      }
    }
    return false;
  }

  function movePredict(dir, dist) {
    const p = state.pred;
    const V = [[0, -1], [0, 1], [-1, 0], [1, 0]][dir];
    const axis = V[0] !== 0 ? 'x' : 'y';
    const other = V[0] !== 0 ? 'y' : 'x';
    const sign = V[0] !== 0 ? V[0] : V[1];

    const nx = axis === 'x' ? p.x + V[0] * dist : p.x;
    const ny = axis === 'y' ? p.y + V[1] * dist : p.y;
    if (!boxHitsLocal(nx, ny)) { p.x = nx; p.y = ny; return; }

    let remaining = dist;
    const cur = p[axis];
    const curTile = Math.round(cur);
    const flush = curTile + sign * (0.5 - PLAYER_R - 0.001);
    if ((flush - cur) * sign > 0) {
      const fx = axis === 'x' ? flush : p.x;
      const fy = axis === 'y' ? flush : p.y;
      if (!boxHitsLocal(fx, fy)) {
        p.x = fx; p.y = fy;
        remaining = Math.max(0, dist - Math.abs(flush - cur));
      }
    }
    if (remaining <= 0) remaining = dist * 0.5;

    const oc = Math.round(p[other]);
    const off = p[other] - oc;
    const aheadX = axis === 'x' ? curTile + sign : oc;
    const aheadY = axis === 'y' ? curTile + sign : oc;
    if (!tileSolidLocal(aheadX, aheadY) && Math.abs(off) > 0.001) {
      const slide = Math.min(Math.abs(off), remaining) * -Math.sign(off);
      const sx = other === 'x' ? p.x + slide : p.x;
      const sy = other === 'y' ? p.y + slide : p.y;
      if (!boxHitsLocal(sx, sy)) { p.x = sx; p.y = sy; }
    } else if (Math.abs(off) > 0.25) {
      const so = Math.sign(off);
      const dgX = axis === 'x' ? curTile + sign : oc + so;
      const dgY = axis === 'y' ? curTile + sign : oc + so;
      if (!tileSolidLocal(dgX, dgY)) {
        const slide = so * remaining;
        const sx = other === 'x' ? p.x + slide : p.x;
        const sy = other === 'y' ? p.y + slide : p.y;
        if (!boxHitsLocal(sx, sy)) { p.x = sx; p.y = sy; }
      }
    }
  }

  // ---------- 插值 ----------

  function interpolated() {
    // 在服务器时间轴上回放：固定 1.3 个快照间隔起步，抖动大时自动加深缓冲
    const delay = Math.min(280, Math.max(state.snapMs * 1.3, state.snapMs + state.srvJitter * 3));
    const rt = performance.now() - state.srvOffset - delay;
    const snaps = state.snaps;
    const players = [];
    const monsters = [];
    if (snaps.length === 0 || !state.latest) return { players, monsters };

    let a = snaps[0], b = snaps[snaps.length - 1];
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].at <= rt) {
        a = snaps[i];
        b = snaps[i + 1] || snaps[i];
        break;
      }
    }
    const span = b.at - a.at;
    const k = span > 0 ? Math.min(1, Math.max(0, (rt - a.at) / span)) : 1;

    const heldDir = input.currentDir();
    for (const row of state.latest.p) {
      const id = row[0];
      const isMe = id === state.myId;
      let ix = row[1], iy = row[2];
      let dir = row[3], moving = row[4] === 1;
      if (isMe && state.pred.ok && row[5] === 1) {
        // 本机：用预测位置 + 本地输入的朝向（零延迟手感）
        ix = state.pred.x; iy = state.pred.y;
        if (heldDir >= 0) { dir = heldDir; moving = true; }
        else moving = false;
      } else {
        const ra = a.p.get(id), rb = b.p.get(id);
        if (ra && rb) {
          // 瞬移（重生）不插值
          if (Math.abs(rb[1] - ra[1]) + Math.abs(rb[2] - ra[2]) < 3) {
            ix = ra[1] + (rb[1] - ra[1]) * k;
            iy = ra[2] + (rb[2] - ra[2]) * k;
          }
        } else if (rb) {
          // 新出现的实体：用时间轴上更近的快照，避免闪跳
          ix = rb[1]; iy = rb[2];
        }
      }
      const roster = state.roster.get(id) || {};
      // 聊天气泡（过期即清）
      let bubble = null;
      const bb = state.bubbles.get(id);
      if (bb) {
        const rem = bb.until - performance.now();
        if (rem <= 0) state.bubbles.delete(id);
        else bubble = { text: bb.text, alpha: Math.min(1, rem / 300) };
      }
      players.push({
        id, ix, iy, dir, moving,
        alive: row[5] === 1,
        shield: row[6] === 1, inv: row[7] === 1,
        color: roster.color || 0,
        name: roster.name || '?',
        bubble,
      });
    }
    for (const row of state.latest.m) {
      const id = row[0];
      const ra = a.m.get(id), rb = b.m.get(id);
      let ix = row[2], iy = row[3];
      if (ra && rb) {
        ix = ra[2] + (rb[2] - ra[2]) * k;
        iy = ra[3] + (rb[3] - ra[3]) * k;
      } else if (rb) {
        ix = rb[2]; iy = rb[3];
      }
      monsters.push({ id, type: row[1], ix, iy, dir: row[4] });
    }
    return { players, monsters };
  }
  state.interpolated = interpolated; // 调试用

  // ---------- 渲染循环 ----------

  let lastFrameT = performance.now();

  function frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrameT) / 1000);
    lastFrameT = now;

    // 布局就绪 / 尺寸变化（转屏、浏览器栏收起）自动适配
    ensureRenderer();
    if (state.renderer &&
        (els.stage.clientWidth !== lastStageW || els.stage.clientHeight !== lastStageH)) {
      resize();
    }

    // 本机预测推进
    if (state.joined && state.pred.ok && state.latest) {
      const meRow = state.latest.p.find((r) => r[0] === state.myId);
      if (meRow && meRow[5] === 1) {
        const d = input.currentDir();
        if (d >= 0) {
          const speed = BASE_SPEED + meRow[10] * SPEED_STEP;
          movePredict(d, speed * dt);
        }
      }
    }

    if (state.renderer && state.grid && state.latest) {
      const { players, monsters } = interpolated();
      const me = players.find((p) => p.id === state.myId);
      const follow = me
        ? { x: me.ix, y: me.iy }
        : { x: (state.cols - 1) / 2, y: (state.rows - 1) / 2 };
      state.renderer.render({
        grid: state.grid,
        players,
        monsters,
        myId: state.myId,
        topId: state.latest.top,
        follow,
        bombs: state.latest.b.map((r) => ({ id: r[0], x: r[1], y: r[2], fuse: r[3] })),
        blasts: state.latest.f.map((r) => {
          const key = r[0] + ',' + r[1];
          const t0 = state.blastAges.get(key) || now;
          return { x: r[0], y: r[1], part: r[2], dir: r[3], age: (now - t0) / 1000 };
        }),
        powerups: state.latest.u.map((r) => ({ id: r[0], x: r[1], y: r[2], kind: r[3], ttl: r[4] })),
      });
    }
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
  // 后台标签页 / 无头环境下 rAF 停摆时的兜底渲染
  setInterval(() => {
    if (performance.now() - lastFrameT > 250) frame();
  }, 250);

  // ---------- 自适应尺寸 ----------

  let lastStageW = 0, lastStageH = 0;

  function resize() {
    if (state.renderer) {
      lastStageW = els.stage.clientWidth;
      lastStageH = els.stage.clientHeight;
      state.renderer.resize(lastStageW, lastStageH);
    }
  }
  window.addEventListener('resize', resize);
  resize();
  updateOverlay();
})();

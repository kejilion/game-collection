'use strict';

// 客户端主控：网络消息 → 世界状态 → 插值渲染 + HUD/特效/音效调度。

(function () {
  const $ = (id) => document.getElementById(id);

  const els = {
    canvas: $('game'),
    stage: $('stage'),
    overlay: $('overlay'),
    joinScreen: $('join-screen'),
    nameInput: $('name-input'),
    joinBtn: $('join-btn'),
    joinLb: $('join-leaderboard'),
    countdownScreen: $('countdown-screen'),
    countdownNum: $('countdown-num'),
    resultScreen: $('result-screen'),
    resultTitle: $('result-title'),
    resultSub: $('result-sub'),
    reconnectScreen: $('reconnect-screen'),
    playersPanel: $('players-panel'),
    toastArea: $('toast-area'),
    roundLabel: $('round-label'),
    timer: $('timer'),
    statBomb: $('stat-bomb'),
    statFire: $('stat-fire'),
    statSpeed: $('stat-speed'),
    statShield: $('stat-shield'),
    btnSound: $('btn-sound'),
    btnMusic: $('btn-music'),
  };

  const POWERUP_NAMES = ['💣 炸弹+1', '🔥 火力+1', '⚡ 速度+1', '🛡️ 护盾'];

  const state = {
    cols: 15, rows: 13,
    grid: null,
    myId: null,
    joined: false,
    myName: localStorage.getItem('bp-name') || '',
    roster: new Map(),
    snaps: [],          // 插值缓冲 {at, p:Map, m:Map}
    latest: null,       // 最新快照
    blastAges: new Map(),
    tickRate: 30,
    countShown: -1,
    renderer: null,
  };

  window.__game = state; // 调试用

  // ---------- 网络 ----------

  const net = Net.create({
    onOpen() {
      els.reconnectScreen.classList.add('hidden');
      if (state.joined && state.myName) {
        net.send({ t: 'join', name: state.myName });
      }
      updateOverlay();
    },
    onClose() {
      if (state.joined) {
        els.reconnectScreen.classList.remove('hidden');
        els.overlay.classList.remove('hidden');
      }
    },
    onMessage(msg) {
      if (msg.t === 's') onSnapshot(msg);
      else if (msg.t === 'roster') onRoster(msg.list);
      else if (msg.t === 'hello') onHello(msg);
      else if (msg.t === 'you') {
        state.myId = msg.id;
        state.joined = true;
        updateOverlay();
      }
    },
  });

  function onHello(msg) {
    state.cols = msg.cols;
    state.rows = msg.rows;
    state.tickRate = msg.tick || 30;
    state.grid = msg.grid.map((row) => row.split('').map(Number));
    if (!state.renderer) {
      state.renderer = Renderer.create(els.canvas, state.cols, state.rows);
      resize();
    }
    renderJoinLeaderboard(msg.lb);
    updateOverlay();
  }

  function onRoster(list) {
    state.roster = new Map(list.map((p) => [p.id, p]));
    renderPlayersPanel();
  }

  function onSnapshot(s) {
    state.latest = s;
    const at = performance.now();
    const pm = new Map(), mm = new Map();
    for (const row of s.p) pm.set(row[0], row);
    for (const row of s.m) mm.set(row[0], row);
    state.snaps.push({ at, p: pm, m: mm });
    if (state.snaps.length > 12) state.snaps.shift();

    // 火焰出现时间（用于动画相位）
    const seen = new Set();
    for (const f of s.f) {
      const key = f[0] + ',' + f[1];
      seen.add(key);
      if (!state.blastAges.has(key)) state.blastAges.set(key, at);
    }
    for (const key of state.blastAges.keys()) {
      if (!seen.has(key)) state.blastAges.delete(key);
    }

    for (const ev of s.e) handleEvent(ev);
    updateHUD(s);
    updateOverlay();
  }

  // ---------- 事件（音效/特效/提示） ----------

  function handleEvent(ev) {
    const R = state.renderer;
    switch (ev.e) {
      case 'round':
        state.grid = ev.map.map((row) => row.split('').map(Number));
        state.blastAges.clear();
        state.countShown = -1;
        break;
      case 'go':
        GameAudio.sfx.go();
        toast('🚀 开战！');
        break;
      case 'bomb':
        GameAudio.sfx.place();
        break;
      case 'boom':
        GameAudio.sfx.boom();
        if (R) {
          R.shake(4 + Math.min(4, ev.r), 0.25);
          R.burst(ev.x, ev.y, 10, ['#ffd93d', '#ff8c42', '#fff'], 4, 0.5);
        }
        break;
      case 'tile':
        if (state.grid) state.grid[ev.y][ev.x] = ev.v;
        if (ev.fx === 'brick') {
          GameAudio.sfx.brick();
          if (R) R.burst(ev.x, ev.y, 8, ['#e0995a', '#b06a2c', '#8a5a2c'], 3, 0.5);
        } else if (ev.fx === 'sd' && R) {
          R.addFallingBlock(ev.x, ev.y);
        }
        break;
      case 'pick': {
        GameAudio.sfx.pick();
        if (R) R.addFloatText(ev.x, ev.y, POWERUP_NAMES[ev.k] || '?', '#ffd93d');
        break;
      }
      case 'burn':
        if (R) R.burst(ev.x, ev.y, 5, ['#ffd93d', '#aaa'], 2, 0.4);
        break;
      case 'die': {
        GameAudio.sfx.die();
        const p = state.roster.get(ev.id);
        if (R && p) R.addDeathGhost(ev.x, ev.y, p.color);
        if (ev.id === state.myId) toast('💥 你被炸飞了！观战中…');
        else if (p) toast(`💀 ${p.name} 被淘汰`);
        break;
      }
      case 'mdie':
        GameAudio.sfx.mdie();
        if (R) {
          R.burst(ev.x, ev.y, 12, ['#6fd44e', '#b28dff', '#fff'], 4, 0.6);
          R.addFloatText(ev.x, ev.y, '+100', '#6fd44e');
        }
        break;
      case 'shield':
        GameAudio.sfx.shield();
        if (ev.id === state.myId) toast('🛡️ 护盾抵挡了一次伤害！');
        break;
      case 'sd':
        GameAudio.sfx.sd();
        toast('⚠️ 突然死亡！墙壁开始坍塌！');
        break;
      case 'end':
        onRoundEnd(ev);
        break;
      case 'spawn':
        if (ev.id === state.myId) toast('🎮 已加入战斗！');
        break;
      case 'join':
        if (ev.id !== state.myId) toast(`👋 ${ev.name} 加入了房间`);
        break;
      case 'leave':
        toast(`🚪 ${ev.name} 离开了房间`);
        break;
    }
  }

  function onRoundEnd(ev) {
    const R = state.renderer;
    if (ev.name) {
      els.resultTitle.textContent = `🏆 ${ev.name} 获胜！`;
      if (ev.id === state.myId) {
        GameAudio.sfx.win();
        if (R) R.winConfetti();
      } else {
        GameAudio.sfx.lose();
      }
    } else {
      els.resultTitle.textContent = ev.n >= 2 ? '💥 同归于尽…平局！' : '💀 全军覆没…再来一局！';
      GameAudio.sfx.lose();
    }
    els.resultSub.textContent = '几秒后自动开始下一回合';
    if (ev.lb) renderJoinLeaderboard(ev.lb);
  }

  // ---------- HUD ----------

  function updateHUD(s) {
    const labels = { lobby: '大厅', countdown: '准备', playing: `第${s.rn}回合`, ended: '结算' };
    els.roundLabel.textContent = labels[s.st] || s.st;

    if (s.st === 'playing') {
      const mm = Math.floor(s.tl / 60), ss = s.tl % 60;
      els.timer.textContent = s.sd ? '☠️ 坍塌中' : `⏱ ${mm}:${String(ss).padStart(2, '0')}`;
      els.timer.classList.toggle('danger', s.sd === 1 || s.tl <= 30);
    } else {
      els.timer.textContent = '⏱ --';
      els.timer.classList.remove('danger');
    }

    const me = s.p.find((row) => row[0] === state.myId);
    if (me) {
      els.statBomb.textContent = `💣 ${me[8]}`;
      els.statFire.textContent = `🔥 ${me[9]}`;
      els.statSpeed.textContent = `⚡ ${me[10]}`;
      els.statShield.classList.toggle('off', me[6] !== 1);
    }

    // 分数实时刷新（roster 里的 score 用快照更新）
    let dirty = false;
    for (const row of s.p) {
      const r = state.roster.get(row[0]);
      if (r && (r.score !== row[11] || r.alive !== (row[5] === 1))) {
        r.score = row[11];
        r.alive = row[5] === 1;
        dirty = true;
      }
    }
    if (dirty) renderPlayersPanel();
  }

  function renderPlayersPanel() {
    const rows = [...state.roster.values()]
      .sort((a, b) => b.score - a.score)
      .map((p) => {
        const cls = ['player-row'];
        if (!p.alive && !p.spec) cls.push('dead');
        if (p.id === state.myId) cls.push('me');
        const color = Renderer.PLAYER_COLORS[p.color % 8][0];
        const tag = p.spec ? ' 👁' : '';
        return `<div class="${cls.join(' ')}">
          <span class="dot" style="background:${color}"></span>
          <span class="pname">${escapeHtml(p.name)}${tag}</span>
          <span class="pscore">${p.score}🏆${p.wins}</span>
        </div>`;
      });
    els.playersPanel.innerHTML = rows.join('');
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function renderJoinLeaderboard(lb) {
    if (!lb || lb.length === 0) {
      els.joinLb.innerHTML = '';
      return;
    }
    const rows = lb.map((e, i) =>
      `<tr><td>${['🥇', '🥈', '🥉', '4.', '5.'][i] || ''}</td><td>${escapeHtml(e.name)}</td><td>${e.wins} 胜</td><td>${e.best} 分</td></tr>`);
    els.joinLb.innerHTML = `<div class="lb-title">🏆 排行榜</div><table>${rows.join('')}</table>`;
  }

  function toast(text) {
    const div = document.createElement('div');
    div.className = 'toast';
    div.textContent = text;
    els.toastArea.appendChild(div);
    setTimeout(() => div.remove(), 3000);
    while (els.toastArea.children.length > 4) els.toastArea.firstChild.remove();
  }

  // ---------- 覆盖层 ----------

  function updateOverlay() {
    const s = state.latest;
    const showJoin = !state.joined;
    const showCountdown = state.joined && s && s.st === 'countdown';
    const showResult = state.joined && s && s.st === 'ended';
    const showReconnect = !els.reconnectScreen.classList.contains('hidden');

    els.joinScreen.classList.toggle('hidden', !showJoin);
    els.countdownScreen.classList.toggle('hidden', !showCountdown);
    els.resultScreen.classList.toggle('hidden', !showResult);

    if (showCountdown && s) {
      const n = Math.max(1, Math.ceil(s.ct));
      if (n !== state.countShown) {
        state.countShown = n;
        els.countdownNum.textContent = n;
        els.countdownNum.style.animation = 'none';
        void els.countdownNum.offsetWidth; // 重启动画
        els.countdownNum.style.animation = '';
        GameAudio.sfx.count();
      }
    }

    const any = showJoin || showCountdown || showResult || showReconnect;
    els.overlay.classList.toggle('hidden', !any);
  }

  // ---------- 加入 ----------

  function join() {
    const name = els.nameInput.value.trim() || '玩家' + Math.floor(Math.random() * 999);
    state.myName = name;
    localStorage.setItem('bp-name', name);
    GameAudio.unlock();
    GameAudio.startMusic();
    net.send({ t: 'join', name });
  }

  els.nameInput.value = state.myName;
  els.joinBtn.addEventListener('click', join);
  els.nameInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') join();
  });

  els.btnSound.addEventListener('click', () => {
    els.btnSound.classList.toggle('off', !GameAudio.toggleSfx());
  });
  els.btnMusic.addEventListener('click', () => {
    els.btnMusic.classList.toggle('off', !GameAudio.toggleMusic());
  });

  // ---------- 输入 ----------

  GameInput.create({
    onDir(d) { net.send({ t: 'in', d }); },
    onBomb() { net.send({ t: 'bomb' }); },
    onAnyKey() { GameAudio.unlock(); },
  });

  // ---------- 插值 ----------

  function interpolated() {
    const delay = (2.5 / state.tickRate) * 1000; // 约 2.5 个快照的缓冲
    const rt = performance.now() - delay;
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

    for (const row of state.latest.p) {
      const id = row[0];
      const ra = a.p.get(id), rb = b.p.get(id);
      let ix = row[1], iy = row[2];
      if (ra && rb) {
        // 玩家瞬移（重生）时不插值
        if (Math.abs(rb[1] - ra[1]) + Math.abs(rb[2] - ra[2]) < 3) {
          ix = ra[1] + (rb[1] - ra[1]) * k;
          iy = ra[2] + (rb[2] - ra[2]) * k;
        }
      }
      const roster = state.roster.get(id) || {};
      players.push({
        id, ix, iy,
        dir: row[3], moving: row[4] === 1, alive: row[5] === 1,
        shield: row[6] === 1, inv: row[7] === 1,
        color: roster.color || 0,
        name: roster.name || '?',
      });
    }
    for (const row of state.latest.m) {
      const id = row[0];
      const ra = a.m.get(id), rb = b.m.get(id);
      let ix = row[2], iy = row[3];
      if (ra && rb) {
        ix = ra[2] + (rb[2] - ra[2]) * k;
        iy = ra[3] + (rb[3] - ra[3]) * k;
      }
      monsters.push({ id, type: row[1], ix, iy, dir: row[4] });
    }
    return { players, monsters };
  }

  // ---------- 渲染循环 ----------

  function frame() {
    lastFrame = performance.now();
    if (state.renderer && state.grid && state.latest) {
      const { players, monsters } = interpolated();
      const now = performance.now();
      state.renderer.render({
        grid: state.grid,
        players,
        monsters,
        myId: state.myId,
        bombs: state.latest.b.map((r) => ({ id: r[0], x: r[1], y: r[2], fuse: r[3] })),
        blasts: state.latest.f.map((r) => {
          const key = r[0] + ',' + r[1];
          const t0 = state.blastAges.get(key) || now;
          return { x: r[0], y: r[1], part: r[2], dir: r[3], age: (now - t0) / 1000 };
        }),
        powerups: state.latest.u.map((r) => ({ id: r[0], x: r[1], y: r[2], kind: r[3] })),
      });
    }
    requestAnimationFrame(frame);
  }

  let lastFrame = performance.now();
  requestAnimationFrame(frame);
  // 后台标签页 / 无头环境下 rAF 停摆时的兜底渲染
  setInterval(() => {
    if (performance.now() - lastFrame > 250) frame();
  }, 250);

  // ---------- 自适应尺寸 ----------

  function resize() {
    const pad = 16;
    const availW = els.stage.clientWidth - pad;
    const availH = els.stage.clientHeight - pad;
    const aspect = state.cols / state.rows;
    let w = availW, h = w / aspect;
    if (h > availH) {
      h = availH;
      w = h * aspect;
    }
    els.canvas.style.width = w + 'px';
    els.canvas.style.height = h + 'px';
  }
  window.addEventListener('resize', resize);
  resize();
  updateOverlay();
})();

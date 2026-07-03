'use strict';
// 入口：菜单、游戏循环、模块串联。
const Game = {
  joined: false,
  myName: '',
  myColor: Math.floor(Math.random() * 8),
  lastEventSnap: null,
  wasDead: false
};

(() => {
  const $ = (id) => document.getElementById(id);

  // ---- 菜单 ----
  const colorRow = $('color-row');
  HUD.COLORS.forEach((c, i) => {
    const dot = document.createElement('div');
    dot.className = 'color-dot' + (i === Game.myColor ? ' sel' : '');
    dot.style.background = c;
    dot.addEventListener('click', () => {
      Game.myColor = i;
      colorRow.querySelectorAll('.color-dot').forEach(d => d.classList.remove('sel'));
      dot.classList.add('sel');
      GameAudio.unlock();
    });
    colorRow.appendChild(dot);
  });

  const nameInput = $('name-input');
  nameInput.value = localStorage.getItem('bumper-name') || '';

  function join() {
    GameAudio.unlock();
    if (!Net.state.connected) {
      $('menu-status').textContent = '正在连接服务器…';
      return;
    }
    const name = nameInput.value.trim() || '无名车手';
    localStorage.setItem('bumper-name', name);
    Game.myName = name;
    Net.send({ type: 'join', name, color: Game.myColor });
  }

  $('play-btn').addEventListener('click', join);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

  // ---- 网络事件 ----
  Net.on('welcome', () => {
    Game.joined = true;
    Game.wasDead = false;
    $('menu').classList.add('hidden');
    $('hud').classList.remove('hidden');
    HUD.hideDeath();
    Input.enable();
    Input.setupTouch();
  });

  Net.on('full', () => { $('menu-status').textContent = '😱 服务器满员了，稍后再试！'; });

  Net.on('chat', (msg) => HUD.addChat(msg.from, msg.c, msg.text));
  Net.on('sys', (msg) => HUD.addSys(msg.text));

  Net.on('boards', () => {
    if (Game.joined) HUD.renderBoards();
    else HUD.renderMenuBoard();
  });

  Net.on('state', (msg) => {
    // 特效事件只处理一次
    Render.handleEvents(msg.events, Net.state.myId);
    for (const ev of msg.events) {
      if (ev.e === 'die') {
        HUD.killFeed(ev);
        if (ev.id === Net.state.myId) { HUD.showDeath(ev); Game.wasDead = true; }
      }
      if (ev.e === 'spawn' && ev.id === Net.state.myId && Game.wasDead) {
        HUD.hideDeath();
        Game.wasDead = false;
      }
    }
  });

  Net.on('_open', () => {
    $('disconnect-tip').classList.add('hidden');
    $('menu-status').textContent = '';
    if (Game.joined) {
      // 断线重连后自动重新加入
      Net.send({ type: 'join', name: Game.myName, color: Game.myColor });
    }
  });
  Net.on('_close', () => {
    $('disconnect-tip').classList.remove('hidden');
    GameAudio.engineStop();
  });

  // ---- 输入回调 ----
  HUD.setupChat();
  Input.onChatFocus(() => HUD.focusChat());
  Input.onHorn(() => Net.send({ type: 'horn' }));
  Input.onBoards((down) => HUD.setHistory(down));
  document.getElementById('board-panel').addEventListener('click', () => HUD.toggleHistoryClick());

  // ---- 主循环 ----
  let lastFrame = performance.now();
  function frame(now) {
    const dt = Math.min((now - lastFrame) / 1000, 0.05);
    lastFrame = now;

    const players = Net.lerpPlayers();
    let me = null;
    for (const p of players) if (p.id === Net.state.myId) { me = p; break; }

    if (Game.joined) {
      if (me && !me.dd) {
        Input.applyJoystick();
        Input.flush();
        // 引擎音随速度
        const cur = Net.state.curSnap, prev = Net.state.prevSnap;
        let speed = 0;
        if (cur && prev) {
          const c = cur.data.players.find(q => q.id === me.id);
          const q = prev.data.players.find(q2 => q2.id === me.id);
          if (c && q) {
            const gap = Math.max((cur.data.t - prev.data.t) / 1000, 0.033);
            speed = Math.hypot(c.x - q.x, c.y - q.y) / gap;
          }
        }
        GameAudio.engine(Math.min(speed / 740, 1), !!me.bo);
      } else {
        GameAudio.engineStop();
      }
      HUD.updateStatus(me);
    }

    Render.draw(dt, players, me);
    requestAnimationFrame(frame);
  }

  Net.connect();
  requestAnimationFrame(frame);
})();

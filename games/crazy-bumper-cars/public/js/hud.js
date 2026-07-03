'use strict';
// HUD：血条/氮气、聊天、击杀播报、实时/历史排行榜、死亡界面、小地图数据由 render 画。
const HUD = (() => {
  const COLORS = ['#ff5252', '#448aff', '#ffca28', '#66bb6a', '#ab47bc', '#ff9138', '#26c6da', '#ff6fae'];

  const el = (id) => document.getElementById(id);
  let showHistory = false;
  let deathTimer = null;

  function colorOf(i) { return COLORS[((i % COLORS.length) + COLORS.length) % COLORS.length] || '#fff'; }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ---- 聊天 ----
  function addChat(name, colorIdx, text) {
    const log = el('chat-log');
    const line = document.createElement('div');
    line.className = 'chat-line';
    line.innerHTML = `<span class="cname" style="color:${colorOf(colorIdx)}">${esc(name)}:</span> ${esc(text)}`;
    log.appendChild(line);
    trimChat(log);
  }
  function addSys(text) {
    const log = el('chat-log');
    const line = document.createElement('div');
    line.className = 'chat-line sys';
    line.textContent = text;
    log.appendChild(line);
    trimChat(log);
  }
  function trimChat(log) {
    while (log.children.length > 60) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  function setupChat() {
    const input = el('chat-input');
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = input.value.trim();
        if (text) Net.send({ type: 'chat', text });
        input.value = '';
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = '';
        input.blur();
      }
    });
  }
  function focusChat() { el('chat-input').focus(); }

  // ---- 击杀播报 ----
  function addFeed(html) {
    const feed = el('killfeed');
    const item = document.createElement('div');
    item.className = 'feed-item';
    item.innerHTML = html;
    feed.appendChild(item);
    while (feed.children.length > 4) feed.removeChild(feed.firstChild);
    setTimeout(() => { item.style.opacity = '0'; item.style.transition = 'opacity .5s'; }, 3800);
    setTimeout(() => item.remove(), 4400);
  }

  function killFeed(ev) {
    const victim = `<b style="color:${colorOf(ev.c)}">${esc(ev.n)}</b>`;
    if (ev.by) {
      const killer = `<b style="color:${colorOf(ev.byColor)}">${esc(ev.byName)}</b>`;
      const bonus = ev.crown ? ' 👑💰' : '';
      addFeed(`💥 ${killer} 把 ${victim} 撞上了天！${bonus}`);
    } else if (ev.byName) {
      addFeed(`🪚 ${victim} ${esc(ev.byName)}`);
    } else {
      addFeed(`💀 ${victim} 报废了`);
    }
  }

  // ---- 排行榜 ----
  function renderBoards() {
    const b = Net.state.boards;
    const list = showHistory ? b.history : b.live;
    el('board-title').innerHTML = showHistory
      ? '📜 历史排行 <span class="board-hint">(松开 Tab 返回)</span>'
      : '🏆 实时排行 <span class="board-hint">(Tab 看历史)</span>';
    const meName = window.Game ? Game.myName : '';
    el('board-list').innerHTML = list.map((r, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '.';
      const crown = r.cr ? '👑' : '';
      const me = r.n === meName ? ' class="me"' : '';
      return `<li${me}><span class="b-name" style="color:${colorOf(r.c)}">${medal} ${crown}${esc(r.n)}</span>` +
             `<span>${showHistory ? '' : `<small>${r.k}杀</small> `}<span class="b-score">${r.sc}</span></span></li>`;
    }).join('') || '<li style="opacity:.6">虚位以待…</li>';
  }

  function renderMenuBoard() {
    const h = Net.state.boards.history;
    const box = el('menu-board');
    if (!h.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="mb-title">📜 历史最强车手</div>' +
      h.slice(0, 5).map((r, i) =>
        `<div class="mb-row"><span style="color:${colorOf(r.c)}">${i + 1}. ${esc(r.n)}</span><b>${r.sc}</b></div>`
      ).join('');
  }

  // ---- 状态条 ----
  function updateStatus(me) {
    if (!me) return;
    const maxHp = Net.state.car.hp || 100;
    const hpBar = el('hp-bar');
    hpBar.style.width = Math.max(0, me.hp / maxHp * 100) + '%';
    hpBar.classList.toggle('low', me.hp <= maxHp * 0.3);
    el('nitro-bar').style.width = Math.max(0, me.nt) + '%';
    el('my-score').textContent = me.sc;
    el('my-kills').textContent = me.k;
    el('ping').textContent = Net.state.ping + 'ms';
  }

  // ---- 死亡界面 ----
  function showDeath(ev) {
    const scr = el('death-screen');
    scr.classList.remove('hidden');
    el('death-text').innerHTML = ev.by
      ? `你被 <b style="color:${colorOf(ev.byColor)}">${esc(ev.byName)}</b> 撞上了天！`
      : (ev.byName ? `你${esc(ev.byName)}` : '你的车报废了！');
    const until = performance.now() + Net.state.respawnMs;
    clearInterval(deathTimer);
    deathTimer = setInterval(() => {
      const left = Math.max(0, until - performance.now());
      el('death-count').textContent = (left / 1000).toFixed(1) + 's';
      if (left <= 0) clearInterval(deathTimer);
    }, 100);
  }
  function hideDeath() {
    clearInterval(deathTimer);
    el('death-screen').classList.add('hidden');
  }

  return {
    COLORS, colorOf,
    addChat, addSys, setupChat, focusChat,
    killFeed, addFeed,
    renderBoards, renderMenuBoard,
    updateStatus, showDeath, hideDeath,
    setHistory(v) { showHistory = v; renderBoards(); },
    toggleHistoryClick() { showHistory = !showHistory; renderBoards(); }
  };
})();

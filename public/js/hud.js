// ============================================================================
//  HUD — DOM overlays: player panel, skillbar, leaderboard, chat, shop,
//  settings, toasts and the respawn screen.
// ============================================================================
const HUD = (() => {
  let $ = {};
  let CLASSES = {}, ITEMS = {}, SHOP = [];
  let selfCls = 'warrior';
  const cd = {};                  // slot key -> { until, total }
  let toastN = 0;

  const id = (s) => document.getElementById(s);

  function init() {
    $ = {
      ppClass: id('ppClass'), ppName: id('ppName'), ppLevel: id('ppLevel'),
      ppHp: id('ppHp'), ppHpTxt: id('ppHpTxt'), ppXp: id('ppXp'), ppXpTxt: id('ppXpTxt'),
      ppGold: id('ppGold'), ppKd: id('ppKd'), ppLives: id('ppLives'), buffRow: id('buffRow'),
      skillbar: id('skillbar'), boardRt: id('boardRt'), boardHist: id('boardHist'),
      chatLog: id('chatLog'), toastWrap: id('toastWrap'), shopGrid: id('shopGrid'),
      shopGold: id('shopGold'), menuHistory: id('menuHistory')
    };
    // leaderboard tabs
    document.querySelectorAll('.board-tabs .tab').forEach(t => t.addEventListener('click', () => {
      document.querySelectorAll('.board-tabs .tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const rt = t.dataset.tab === 'rt';
      $.boardRt.classList.toggle('show', rt); $.boardHist.classList.toggle('show', !rt);
    }));
  }

  function setDefs(classes, items, shop) { CLASSES = classes; ITEMS = items; SHOP = shop; }

  // ---- menu class picker --------------------------------------------------
  function buildClassPicker(onSelect) {
    const wrap = id('classPick'); wrap.innerHTML = '';
    let sel = 'warrior';
    const tags = { warrior: '坦克', mage: '爆发', assassin: '刺杀' };
    const ava = { warrior: '🛡', mage: '🔮', assassin: '🗡' };
    Object.values(CLASSES).forEach(c => {
      const el = document.createElement('div');
      el.className = 'class-card' + (c.id === sel ? ' sel' : '');
      el.style.setProperty('--cc', c.color);
      el.style.setProperty('--ccs', hexA(c.color, .45));
      el.innerHTML =
        `<span class="tag">${tags[c.id]}</span>
         <div class="ava">${ava[c.id]}</div>
         <h4>${c.name}</h4>
         <div class="role">${c.desc.split('·')[1] || c.desc}</div>`;
      el.addEventListener('click', () => {
        sel = c.id; selfCls = c.id;
        wrap.querySelectorAll('.class-card').forEach(x => x.classList.remove('sel'));
        el.classList.add('sel'); onSelect(c.id);
      });
      wrap.appendChild(el);
    });
    onSelect(sel);
  }

  // ---- skillbar -----------------------------------------------------------
  function buildSkillbar(clsId) {
    selfCls = clsId;
    const cls = CLASSES[clsId];
    for (const k in cd) delete cd[k];
    let html = `<div class="skill attack" data-k="A"><span class="key">A</span><span class="ic">⚔</span><span class="nm">攻击</span></div>`;
    for (let i = 0; i < 5; i++) {
      const sk = cls.skills[i];
      if (sk) html += `<div class="skill ready" data-k="${i}"><span class="key">${i + 1}</span><span class="ic">${skillIcon(sk.id)}</span><span class="nm">${sk.name}</span></div>`;
      else html += `<div class="skill locked"><span class="key">${i + 1}</span><span class="ic">🔒</span><span class="nm">待解锁</span></div>`;
    }
    $.skillbar.innerHTML = html;
  }
  function skillIcon(idv) { return ({ whirlwind: '🌀', fireball: '🔥', shadowstrike: '💨' })[idv] || '✦'; }

  function triggerCd(key, total) { cd[key] = { until: performance.now() + total, total }; }

  function renderSkillbar() {
    const now = performance.now();
    $.skillbar.querySelectorAll('.skill').forEach(el => {
      const k = el.dataset.k; if (k === undefined) return;
      const c = cd[k];
      let ov = el.querySelector('.cd');
      if (c && c.until > now) {
        const left = (c.until - now) / 1000;
        if (!ov) { ov = document.createElement('div'); ov.className = 'cd'; ov.innerHTML = '<span class="cd-num"></span>'; el.appendChild(ov); }
        ov.querySelector('.cd-num').textContent = left.toFixed(1);
        ov.style.opacity = 1;
      } else if (ov) ov.remove();
    });
  }

  // ---- player panel -------------------------------------------------------
  function updatePlayer(p) {
    const cls = CLASSES[p.cls];
    $.ppClass.textContent = cls.name; $.ppClass.style.background = cls.color;
    $.ppName.textContent = p.name; $.ppLevel.textContent = 'Lv.' + p.level;
    $.ppHp.style.width = Math.max(0, (p.hp / p.maxHp) * 100) + '%';
    $.ppHpTxt.textContent = `${p.hp} / ${p.maxHp}`;
    $.ppXp.style.width = (p.xp / p.xpNext * 100) + '%';
    $.ppXpTxt.textContent = `EXP ${Math.floor(p.xp / p.xpNext * 100)}%`;
    $.ppGold.textContent = '💰 ' + p.gold;
    $.ppKd.textContent = `⚔ ${p.kills} / ☠ ${p.deaths}`;
    $.ppLives.textContent = '❤×' + (1 + p.extraLives);
    // buffs
    let bh = '';
    (p.buffs || []).forEach(b => { const d = ITEMS[b]; if (d) bh += `<div class="buff-chip" title="${d.name}">${d.icon}</div>`; });
    if (p.bossKills) bh += `<div class="buff-chip" title="击杀BOSS">👑<b>${p.bossKills}</b></div>`;
    $.buffRow.innerHTML = bh;
  }

  // ---- leaderboards -------------------------------------------------------
  function rowHtml(e, i, selfName) {
    const cls = CLASSES[e.cls] || { color: '#fff', name: '' };
    const me = e.name === selfName ? ' me' : '';
    return `<li class="top${i + 1}${me}"><span class="rank">${i + 1}</span>
      <span class="dot" style="background:${cls.color}"></span>
      <span class="nm">${escapeHtml(e.name)}</span><span class="sc">${e.score}</span></li>`;
  }
  function updateLeaderboard(rt, hist, selfName) {
    $.boardRt.innerHTML = rt.length ? rt.map((e, i) => rowHtml(e, i, selfName)).join('') : '<li style="justify-content:center;color:#9fb0d8">暂无玩家</li>';
    $.boardHist.innerHTML = hist.length ? hist.map((e, i) => rowHtml(e, i, selfName)).join('') : '<li style="justify-content:center;color:#9fb0d8">暂无记录</li>';
  }
  function updateMenuHistory(hist) {
    $.menuHistory.innerHTML = hist.length
      ? hist.map((e, i) => { const c = CLASSES[e.cls] || { name: '' }; return `<li><span class="nm">${i + 1}. ${escapeHtml(e.name)} <small style="color:#9fb0d8">${c.name} Lv.${e.level}</small></span><span class="sc">${e.score}</span></li>`; }).join('')
      : '<li class="empty">暂无记录，快来抢占榜首！</li>';
  }

  // ---- chat ---------------------------------------------------------------
  function addChat(name, text, color, sys) {
    const line = document.createElement('div');
    line.className = 'line' + (sys ? ' sys' : '');
    if (sys) line.textContent = text;
    else line.innerHTML = `<span class="who" style="color:${color || '#9be7ff'}">${escapeHtml(name)}：</span>${escapeHtml(text)}`;
    $.chatLog.appendChild(line);
    while ($.chatLog.children.length > 40) $.chatLog.removeChild($.chatLog.firstChild);
    $.chatLog.scrollTop = $.chatLog.scrollHeight;
  }

  // ---- toasts -------------------------------------------------------------
  function toast(text, color) {
    const el = document.createElement('div'); el.className = 'toast'; el.textContent = text;
    if (color) el.style.borderColor = color;
    $.toastWrap.appendChild(el);
    setTimeout(() => el.remove(), 3700);
    while ($.toastWrap.children.length > 4) $.toastWrap.removeChild($.toastWrap.firstChild);
  }

  // ---- shop ---------------------------------------------------------------
  function buildShop(onBuy) {
    $.shopGrid.innerHTML = '';
    SHOP.forEach(s => {
      const d = ITEMS[s.id];
      const el = document.createElement('div'); el.className = 'shop-item'; el.dataset.price = s.price; el.dataset.item = s.id;
      el.innerHTML =
        `<div class="si-ic" style="background:${d.color}">${d.icon}</div>
         <div style="flex:1;min-width:0"><div class="si-nm">${d.name}</div><div class="si-ds">${d.desc}</div></div>
         <div class="si-pr">💰${s.price}</div>`;
      el.addEventListener('click', () => onBuy(s.id));
      $.shopGrid.appendChild(el);
    });
  }
  function updateShopGold(gold) {
    $.shopGold.textContent = gold;
    $.shopGrid.querySelectorAll('.shop-item').forEach(el => el.classList.toggle('cant', gold < +el.dataset.price));
  }

  // ---- util ---------------------------------------------------------------
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function hexA(hex, a) { hex = hex.replace('#', ''); if (hex.length === 3) hex = hex.split('').map(c => c + c).join(''); const n = parseInt(hex, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }

  return {
    init, setDefs, buildClassPicker, buildSkillbar, triggerCd, renderSkillbar,
    updatePlayer, updateLeaderboard, updateMenuHistory, addChat, toast,
    buildShop, updateShopGold
  };
})();

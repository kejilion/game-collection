// ============================================================================
//  HUD — DOM overlays: player panel, skillbar, leaderboard, chat, shop,
//  settings, toasts and the respawn screen.
// ============================================================================
const HUD = (() => {
  let $ = {};
  let CLASSES = {}, ITEMS = {};
  let PERM_SHOP = null;           // { equipment: [...], cosmetics: { warrior: [...], mage: [...], assassin: [...] } }
  let selfCls = 'warrior';
  let selfLevel = 1;              // tracked so the bar can relight a skill the moment it unlocks
  const cd = {};                  // slot key -> { until, total }
  let toastN = 0;

  const id = (s) => document.getElementById(s);

  function init() {
    $ = {
      ppClass: id('ppClass'), ppName: id('ppName'), ppLevel: id('ppLevel'),
      ppHp: id('ppHp'), ppHpTxt: id('ppHpTxt'), ppXp: id('ppXp'), ppXpTxt: id('ppXpTxt'),
      ppGold: id('ppGold'), ppKd: id('ppKd'), ppLives: id('ppLives'), buffRow: id('buffRow'),
      skillbar: id('skillbar'), boardRt: id('boardRt'), boardHist: id('boardHist'),
      chatLog: id('chatLog'), toastWrap: id('toastWrap'),
      permGoldEl: id('permShopGold'), permEquipGrid: id('permEquipGrid'), permCosGrid: id('permCosGrid'),
      menuHistory: id('menuHistory'),
      killFeed: id('killFeed'), killBanner: id('killBanner'), killCue: id('killCue')
    };
    // leaderboard tabs
    document.querySelectorAll('.board-tabs .tab').forEach(t => t.addEventListener('click', () => {
      document.querySelectorAll('.board-tabs .tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const rt = t.dataset.tab === 'rt';
      $.boardRt.classList.toggle('show', rt); $.boardHist.classList.toggle('show', !rt);
    }));
    // permanent shop tabs (装备 / 外观)
    document.querySelectorAll('#permanentShopPanel .perm-tab').forEach(t => t.addEventListener('click', () => {
      document.querySelectorAll('#permanentShopPanel .perm-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const tab = t.dataset.tab;
      if ($.permEquipGrid) $.permEquipGrid.hidden = (tab !== 'equipment');
      if ($.permCosGrid)   $.permCosGrid.hidden   = (tab !== 'cosmetics');
    }));
  }

  function setDefs(classes, items, permShop) { CLASSES = classes; ITEMS = items; PERM_SHOP = permShop || null; }

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
  // `level` decides lock state: a skill below its reqLevel renders locked but shows the
  // level it unlocks at (so the player knows what's coming and when). Called again on
  // level-up to relight a freshly unlocked slot without wiping in-flight cooldowns.
  function buildSkillbar(clsId, level = 1) {
    const clsChanged = clsId !== selfCls;
    selfCls = clsId; selfLevel = level;
    const cls = CLASSES[clsId];
    if (clsChanged) for (const k in cd) delete cd[k];   // only reset cooldowns when the class actually changes
    let html = `<div class="skill attack" data-k="A"><span class="key">A</span><span class="ic">⚔</span><span class="nm">攻击</span></div>`;
    for (let i = 0; i < 5; i++) {
      const sk = cls.skills[i];
      if (!sk) {                                         // empty slot reserved for a future skill
        html += `<div class="skill locked"><span class="key">${i + 1}</span><span class="ic">🔒</span><span class="nm">待解锁</span></div>`;
      } else if (level < (sk.reqLevel || 1)) {           // exists but not yet unlocked — show the requirement
        html += `<div class="skill locked" data-k="${i}"><span class="key">${i + 1}</span><span class="ic">${skillIcon(sk.id)}</span><span class="nm">Lv.${sk.reqLevel}</span></div>`;
      } else {
        html += `<div class="skill ready" data-k="${i}"><span class="key">${i + 1}</span><span class="ic">${skillIcon(sk.id)}</span><span class="nm">${sk.name}</span></div>`;
      }
    }
    $.skillbar.innerHTML = html;
  }
  function skillIcon(idv) { return ({ whirlwind: '🌀', fireball: '🔥', shadowstrike: '💨', warcry: '🛡', frostnova: '❄', shadowveil: '🌫' })[idv] || '✦'; }

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
    if (p.level !== selfLevel) buildSkillbar(p.cls, p.level);   // relight any skill that just unlocked
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

  // ---- kill feed + 王者-style announcements -------------------------------
  function clsColor(c) { return (CLASSES[c] && CLASSES[c].color) || (c === 'boss' ? '#ff4d4d' : '#fff'); }
  const MULTI = { 2: ['双杀', 'DOUBLE KILL'], 3: ['三杀', 'TRIPLE KILL'], 4: ['四杀', 'QUADRA KILL'], 5: ['五杀', 'PENTA KILL'] };
  const SPREE = { 3: '势不可挡', 4: '大杀特杀', 5: '横扫千军', 6: '主宰全场', 7: '天下无双' };
  function multiInfo(n) { return n >= 6 ? [n + '连环杀', 'UNSTOPPABLE'] : MULTI[n]; }
  function spreeInfo(n) { if (n >= 8) return ['超神', 'GODLIKE']; return SPREE[n] ? [SPREE[n], n + ' 连杀'] : null; }
  function killLine(fx) { return `${fx.killer} ⚔ ${fx.victim}`; }

  function killFeed(fx, selfId) {
    // scrolling feed entry: killer ⚔ victim
    const row = document.createElement('div');
    const isSelf = !!fx.killerId && fx.killerId === selfId;
    row.className = 'kf-row' + (isSelf ? ' kf-me' : '') + (fx.boss ? ' kf-boss' : '');
    const vName = fx.boss ? ('👑' + fx.victim) : fx.victim;
    row.innerHTML =
      `<span class="kf-k" style="color:${clsColor(fx.kcls)}">${escapeHtml(fx.killer)}</span>` +
      `<span class="kf-x">⚔</span>` +
      `<span class="kf-v" style="color:${clsColor(fx.vcls)}">${escapeHtml(vName)}</span>`;
    $.killFeed.appendChild(row);
    while ($.killFeed.children.length > 6) $.killFeed.removeChild($.killFeed.firstChild);
    setTimeout(() => row.remove(), 5600);

    if (fx.boss) {
      // Boss kills are always worth an immediate global announcement.  It preempts
      // queued streak messages so the reward never feels swallowed by UI noise.
      enqueueBanner({ big: '击败 BOSS', sub: killLine(fx), kind: 'boss', urgent: true, duration: 2300 });
      return;
    }
    // big center banner for special moments
    let b = null;
    if (fx.multi >= 2) { const m = multiInfo(fx.multi); if (m) b = { big: m[0], sub: killLine(fx), kind: 'multi' }; }
    else if (fx.fb) b = { big: '首杀', sub: killLine(fx), kind: 'fb' };
    else { const s = spreeInfo(fx.spree); if (s) b = { big: s[0], sub: killLine(fx), kind: 'spree' }; }
    if (b) enqueueBanner(b);
    else if (isSelf) showKillCue(fx);           // every ordinary kill still has instant local feedback
    if (fx.shutdown >= 3) toast(`${fx.killer} 终结了 ${fx.victim} 的 ${fx.shutdown} 连杀！`, '#ff9f43');
  }

  let killCueTimer = 0;
  function showKillCue(fx) {
    const el = $.killCue;
    clearTimeout(killCueTimer);
    el.className = 'kill-cue';
    el.innerHTML = `<span class="kc-killer" style="color:${clsColor(fx.kcls)}">${escapeHtml(fx.killer)}</span>` +
      `<span class="kc-label">击败</span><strong>${escapeHtml(fx.victim)}</strong>`;
    void el.offsetWidth;                        // restart CSS animation
    el.classList.add('show');
    killCueTimer = setTimeout(() => el.classList.remove('show'), 1150);
  }

  const bannerQ = []; let bannerBusy = false; let bannerTimer = 0;
  function enqueueBanner(b) {
    if (b.urgent) {
      bannerQ.length = 0;
      clearTimeout(bannerTimer);
      bannerBusy = false;
      $.killBanner.classList.remove('show');
      showBanner(b);
      return;
    }
    if (bannerQ.length < 3) bannerQ.push(b);   // avoid replaying stale messages after a hectic fight
    if (!bannerBusy) showNextBanner();
  }
  function showNextBanner() {
    if (!bannerQ.length) { bannerBusy = false; return; }
    showBanner(bannerQ.shift());
  }
  function showBanner(b) {
    bannerBusy = true;
    const el = $.killBanner;
    el.className = 'kill-banner kb-' + b.kind;
    el.innerHTML = `<div class="kb-big">${escapeHtml(b.big)}</div><div class="kb-sub">${escapeHtml(b.sub)}${b.who ? ` · ${escapeHtml(b.who)}` : ''}</div>`;
    void el.offsetWidth;                        // restart CSS animation
    el.classList.add('show');
    bannerTimer = setTimeout(() => {
      el.classList.remove('show');
      bannerTimer = setTimeout(() => { bannerTimer = 0; showNextBanner(); }, 240);
    }, b.duration || 1900);
  }

  // ---- toasts -------------------------------------------------------------
  function toast(text, color) {
    const el = document.createElement('div'); el.className = 'toast'; el.textContent = text;
    if (color) el.style.borderColor = color;
    $.toastWrap.appendChild(el);
    setTimeout(() => el.remove(), 3700);
    while ($.toastWrap.children.length > 4) $.toastWrap.removeChild($.toastWrap.firstChild);
  }

  // ---- permanent shop (in-match upgrades: equipment + per-class cosmetics) -
  function setPermShop(catalog) { PERM_SHOP = catalog; }
  function buildPermanentShop(clsId, onBuy, owned) {
    if (!PERM_SHOP) return;
    const eqGrid = $.permEquipGrid, cosGrid = $.permCosGrid;
    if (!eqGrid || !cosGrid) return;
    eqGrid.innerHTML = ''; cosGrid.innerHTML = '';
    const ownedEq = new Set((owned && owned.equipment) || []);
    const ownedCos = {
      warrior: new Set(((owned && owned.cosmetics && owned.cosmetics.warrior) || [])),
      mage:    new Set(((owned && owned.cosmetics && owned.cosmetics.mage) || [])),
      assassin: new Set(((owned && owned.cosmetics && owned.cosmetics.assassin) || []))
    };
    const paint = (parent, item, ownedNow, iconColor, icon, tag) => {
      const el = document.createElement('div');
      el.className = 'perm-item' + (ownedNow ? ' owned' : ''); el.dataset.item = item.id; el.dataset.price = item.price;
      el.innerHTML =
        `<div class="pi-ic" style="background:${iconColor}">${icon}</div>
         <div style="flex:1;min-width:0"><div class="pi-nm">${item.name}</div><div class="pi-ds">${tag}</div></div>
         <div class="pi-pr">${ownedNow ? '已拥有' : '💰' + item.price}</div>`;
      if (!ownedNow) el.addEventListener('click', () => onBuy(item.id));
      parent.appendChild(el);
    };
    // equipment cards
    (PERM_SHOP.equipment || []).forEach(eq => {
      const desc = Object.entries(eq.bonus || {}).map(([k, v]) => k + (v < 1 && v > 0 ? '+' + (v * 100).toFixed(0) + '%' : (v < 1 ? '×' + v : '+' + v))).join(' · ');
      paint(eqGrid, eq, ownedEq.has(eq.id), '#7eaaff', '⚙', desc);
    });
    // cosmetics for this class
    (PERM_SHOP.cosmetics && PERM_SHOP.cosmetics[clsId] ? PERM_SHOP.cosmetics[clsId] : []).forEach(cs => {
      const tag = cs.skin ? '外观 · 皮肤' : cs.trail ? '外观 · 拖尾' : cs.glow ? '外观 · 外发光' : cs.size ? '外观 · 体格' : '外观';
      paint(cosGrid, cs, ownedCos[clsId].has(cs.id), '#c08bff', '✦', tag);
    });
  }
  function updatePermShopGold(gold) {
    if ($.permGoldEl) $.permGoldEl.textContent = gold;
    document.querySelectorAll('#permanentShopPanel .perm-item').forEach(el =>
      el.classList.toggle('cant', gold < +el.dataset.price));
  }
  function markPermanentOwned(itemId) {
    const el = document.querySelector(`#permanentShopPanel .perm-item[data-item="${itemId}"]`);
    if (!el) return;
    el.classList.add('owned');
    el.querySelector('.pi-pr').textContent = '已拥有';
    el.style.cursor = 'default';
  }

  // ---- util ---------------------------------------------------------------
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function hexA(hex, a) { hex = hex.replace('#', ''); if (hex.length === 3) hex = hex.split('').map(c => c + c).join(''); const n = parseInt(hex, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }

  return {
    init, setDefs, buildClassPicker, buildSkillbar, triggerCd, renderSkillbar,
    updatePlayer, updateLeaderboard, updateMenuHistory, addChat, toast,
    setPermShop, buildPermanentShop, updatePermShopGold, markPermanentOwned,
    killFeed
  };
})();

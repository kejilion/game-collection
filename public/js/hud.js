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
      permGoldEl: id('permShopGold'), permShopGrid: id('permShopGrid'),
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
  }

  function setDefs(classes, items, permShop) { CLASSES = classes; ITEMS = items; PERM_SHOP = permShop || null; }

  // ---- menu class picker --------------------------------------------------
  // Each card paints a small in-game sprite via Renderer.drawPortrait on a
  // <canvas class="ava"> (replacing the old emoji glyph). One rAF loop drives
  // every portrait at the same time — stopPickerAnim() must run before
  // rebuilding so hot-reloads don't leak frames.
  let _pickerRaf = 0;
  function stopPickerAnim() { if (_pickerRaf) { cancelAnimationFrame(_pickerRaf); _pickerRaf = 0; } }
  function buildClassPicker(onSelect) {
    const wrap = id('classPick'); wrap.innerHTML = '';
    let sel = 'warrior';
    const tags = { warrior: '坦克', mage: '爆发', assassin: '刺杀' };
    Object.values(CLASSES).forEach(c => {
      const el = document.createElement('div');
      el.className = 'class-card' + (c.id === sel ? ' sel' : '');
      el.style.setProperty('--cc', c.color);
      el.style.setProperty('--ccs', hexA(c.color, .45));
      el.innerHTML =
        `<span class="tag">${tags[c.id]}</span>
         <canvas class="ava" width="96" height="96" data-cls="${c.id}"></canvas>
         <h4>${c.name}</h4>
         <div class="role">${c.desc.split('·')[1] || c.desc}</div>`;
      el.addEventListener('click', () => {
        sel = c.id; selfCls = c.id;
        wrap.querySelectorAll('.class-card').forEach(x => x.classList.remove('sel'));
        el.classList.add('sel'); onSelect(c.id);
        if (window.Audio) window.Audio.play('ui-click');
      });
      wrap.appendChild(el);
    });
    stopPickerAnim();
    const start = performance.now();
    const tick = () => {
      const t = performance.now() - start;
      wrap.querySelectorAll('canvas.ava').forEach(cv => {
        if (Renderer && Renderer.drawPortrait) Renderer.drawPortrait(cv, cv.dataset.cls, t);
      });
      _pickerRaf = requestAnimationFrame(tick);
    };
    _pickerRaf = requestAnimationFrame(tick);
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
    // killerKind === 'boss' means a BOSS finished a player off (no real killer id).
    // Treat that as NOT being the local player so we don't fire "I killed them"
    // feedback, and tag the row so CSS can give it a distinct look.
    const killerIsBoss = fx.killerKind === 'boss' || fx.kcls === 'boss';
    const isSelf = !!fx.killerId && fx.killerId === selfId;
    row.className = 'kf-row'
      + (isSelf ? ' kf-me' : '')
      + (fx.boss ? ' kf-boss' : '')
      + (killerIsBoss ? ' kf-boss-killer' : '');
    const vName = fx.boss ? ('👑' + fx.victim) : fx.victim;
    row.innerHTML =
      `<span class="kf-k" style="color:${clsColor(fx.kcls)}">${escapeHtml(fx.killer)}</span>` +
      `<span class="kf-x">⚔</span>` +
      `<span class="kf-v" style="color:${clsColor(fx.vcls)}">${escapeHtml(vName)}</span>`;
    $.killFeed.appendChild(row);
    while ($.killFeed.children.length > 6) $.killFeed.removeChild($.killFeed.firstChild);
    setTimeout(() => row.remove(), 5600);

    if (fx.boss) {
      // Boss-tagged feed entries come from two very different moments, so the
      // banner has to read differently for each:
      //   • killer is a player → celebrate "击败 BOSS"
      //   • killer is a BOSS   → the victim just got taken down, so flip it
      //     to "被 BOSS 击败" instead of letting "击败 BOSS" imply the reverse.
      const big = killerIsBoss ? '被 BOSS 击败' : '击败 BOSS';
      enqueueBanner({ big, sub: killLine(fx), kind: 'boss', urgent: true, duration: 2300 });
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
    const grid = $.permShopGrid;
    if (!grid) return;
    grid.innerHTML = '';
    const ownedEq = new Set((owned && owned.equipment) || []);
    const ownedCos = {
      warrior: new Set(((owned && owned.cosmetics && owned.cosmetics.warrior) || [])),
      mage:    new Set(((owned && owned.cosmetics && owned.cosmetics.mage) || [])),
      assassin: new Set(((owned && owned.cosmetics && owned.cosmetics.assassin) || []))
    };
    // Build an SVG icon element from a path string + bg color. The shop card
    // uses these to convey what stat the equipment boosts at a glance — heart
    // for HP, sword for ATK, shoe for SPEED, star for CRIT, lightning for
    // ATTACK SPEED — instead of every item showing the same gear glyph.
    const svgIcon = (path, bg) => {
      const wrap = document.createElement('div');
      wrap.className = 'pi-ic';
      wrap.style.background = bg;
      wrap.innerHTML =
        `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
           <path d="${path}" fill="#fff" stroke="#1a1208" stroke-width="1" stroke-linejoin="round"/>
         </svg>`;
      return wrap;
    };
    // stat label + format helpers — one canonical place so the card always
    // shows "+40 生命" not raw keys like "hp+40".
    const STAT_LABEL = { hp: '生命', atk: '攻击', speed: '移速', critChance: '暴击', attackCdMul: '攻速' };
    const fmtBonus = (b) => {
      const k = Object.keys(b)[0], v = b[k];
      // attackCdMul < 1 means attacks come faster → display "-15%"
      if (k === 'attackCdMul') return { val: '-' + Math.round((1 - v) * 100) + '%', label: STAT_LABEL[k] };
      if (k === 'critChance') return { val: '+' + (v * 100).toFixed(0) + '%', label: STAT_LABEL[k] };
      return { val: '+' + v, label: STAT_LABEL[k] };
    };
    // canvas preview for cosmetics — small 40x40 mini-art of the actual
    // effect so the player sees what they're buying (skin recolor, trail
    // streak, glow halo, size change) rather than a flat icon.
    const previewCanvas = (kind, item) => {
      const cv = document.createElement('canvas');
      cv.className = 'pi-pv'; cv.width = 40; cv.height = 40;
      const c = cv.getContext('2d');
      c.fillStyle = '#0d1117'; c.fillRect(0, 0, 40, 40);
      const cls = (PERM_SHOP.cosmetics && CLASSES[item.cls]) || CLASSES.warrior;
      if (kind === 'skin') {
        const tint = item.skin === 'crimson' ? '#ff3b3b' : item.skin === 'arcane' ? '#7c4dff' : item.skin === 'shadow' ? '#2a2238' : cls.color;
        c.fillStyle = tint; c.beginPath(); c.arc(20, 22, 11, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#1a1208'; c.fillRect(15, 20, 2, 4); c.fillRect(23, 20, 2, 4);
        c.fillRect(17, 27, 6, 2);
      } else if (kind === 'trail') {
        const trailColors = { fire: ['#ff7a3d','#ffd23f'], frost: ['#7fd8ff','#e0f7ff'], smoke: ['#9aa3b2','#5b6271'] };
        const [a, b] = trailColors[item.trail] || ['#fff','#fff'];
        for (let i = 0; i < 6; i++) {
          c.fillStyle = a; c.globalAlpha = 1 - i * 0.15;
          c.beginPath(); c.arc(20 - i * 3, 28, 4 + i * 0.3, 0, Math.PI * 2); c.fill();
        }
        c.globalAlpha = 1; c.fillStyle = cls.color; c.beginPath(); c.arc(20, 22, 9, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#1a1208'; c.fillRect(16, 20, 2, 4); c.fillRect(22, 20, 2, 4);
        c.fillStyle = b; c.fillRect(15, 26, 10, 1);
      } else if (kind === 'glow') {
        c.fillStyle = item.glow; c.globalAlpha = 0.22; c.beginPath(); c.arc(20, 22, 17, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 0.45; c.beginPath(); c.arc(20, 22, 12, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1; c.fillStyle = item.glow; c.beginPath(); c.arc(20, 22, 9, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#1a1208'; c.fillRect(16, 20, 2, 4); c.fillRect(22, 20, 2, 4);
      } else if (kind === 'size') {
        const isUp = item.size >= 1;
        c.fillStyle = cls.color; c.globalAlpha = 0.5; c.beginPath(); c.arc(12, 28, isUp ? 9 : 5, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1; c.beginPath(); c.arc(28, 18, isUp ? 11 : 4, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#fff'; c.font = '800 12px sans-serif'; c.textAlign = 'center';
        c.fillText(isUp ? '↑' : '↓', 32, 22);
      }
      return cv;
    };
    // paint() takes a pre-rendered left-side node (SVG icon for equipment,
    // canvas preview for cosmetics) and a `main` object describing what to
    // print big in the card. The item name is intentionally NOT shown — the
    // player only needs the bonus / effect to decide what to buy, and the
    // card is narrow enough that the name would push layout into a column.
    const paint = (item, ownedNow, leftNode, main) => {
      const el = document.createElement('div');
      el.className = 'perm-item' + (ownedNow ? ' owned' : ''); el.dataset.item = item.id; el.dataset.price = item.price;
      el.title = item.name;     // hover tooltip so the flavor name isn't lost
      el.appendChild(leftNode);
      const mid = document.createElement('div'); mid.className = 'pi-mid';
      const mainEl = document.createElement('div'); mainEl.className = 'pi-main';
      // gold label leads (e.g. "生命 +40"), then the white value — same font
      // size so both words read as one stat, with colour carrying the role.
      if (main.label) {
        const lblEl = document.createElement('span'); lblEl.className = 'pi-main-lbl'; lblEl.textContent = main.label;
        mainEl.appendChild(lblEl);
      }
      const valEl = document.createElement('span'); valEl.className = 'pi-main-val'; valEl.textContent = main.val;
      mainEl.appendChild(valEl);
      mid.appendChild(mainEl);
      el.appendChild(mid);
      const pr = document.createElement('div'); pr.className = 'pi-pr';
      pr.textContent = ownedNow ? '已拥有' : '💰' + item.price;
      el.appendChild(pr);
      if (!ownedNow) el.addEventListener('click', () => onBuy(item.id));
      grid.appendChild(el);
    };
    const section = (label) => {
      const h = document.createElement('div');
      h.className = 'perm-section-title';
      h.textContent = label;
      grid.appendChild(h);
    };
    // equipment — left is a unique SVG icon per item, main is "+40 生命"
    // (the actual bonus number). Item name is kept only as a hover tooltip
    // (see paint()) so it never competes for space in the card.
    section('⚙ 装备');
    (PERM_SHOP.equipment || []).forEach(eq => {
      const bonus = fmtBonus(eq.bonus || {});
      const left = svgIcon(eq.icon || 'M12 2l2.5 6.5L21 9l-5 4.5L17.5 21 12 17l-5.5 4L8 13.5 3 9l6.5-0.5L12 2z', eq.iconBg || '#7eaaff');
      paint(eq, ownedEq.has(eq.id), left, bonus);
    });
    const cosList = (PERM_SHOP.cosmetics && PERM_SHOP.cosmetics[clsId]) || [];
    if (cosList.length) {
      section('✦ 外观');
      cosList.forEach(cs => {
        const kind = cs.preview || (cs.skin ? 'skin' : cs.trail ? 'trail' : cs.glow ? 'glow' : 'size');
        const preview = previewCanvas(kind, cs);
        const main = { val: cs.skin ? '皮肤' : cs.trail ? '拖尾' : cs.glow ? '外发光' : cs.size ? (cs.size >= 1 ? '体格↑' : '体格↓') : '外观', label: '' };
        paint(cs, ownedCos[clsId].has(cs.id), preview, main);
      });
    }
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
    init, setDefs, getClasses: () => CLASSES, buildClassPicker, buildSkillbar, triggerCd, renderSkillbar,
    updatePlayer, updateLeaderboard, updateMenuHistory, addChat, toast,
    setPermShop, buildPermanentShop, updatePermShopGold, markPermanentOwned,
    killFeed
  };
})();

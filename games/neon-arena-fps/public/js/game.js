// 主逻辑：网络同步 / 第一·第三人称 / 战斗 / 昼夜 / HUD / 聊天 / 商店(3D预览) / 排行榜 / 观战 / 设置
(function () {
  const T = THREE;
  const $ = id => document.getElementById(id);
  const V3 = (x, y, z) => new T.Vector3(x, y, z);
  const now = () => Date.now();
  const qs = new URLSearchParams(location.search);
  const NOLOCK = qs.get('nolock') === '1';

  // ---------- 移动端检测 + 画质分级 ----------
  // 判定依据：主指针精度（pointer:coarse = 触屏/手写笔），可用 ?touch=1/0 强制覆盖用于桌面调试
  const TOUCH = (() => {
    const f = qs.get('touch');
    if (f === '1') return true;
    if (f === '0') return false;
    return matchMedia('(pointer: coarse)').matches;
  })();
  document.body.classList.toggle('mobile', TOUCH);
  // 画质仅影响阴影分辨率/抗锯齿/像素比这类纯观感开销，绝不缩短视距/雾距——
  // 视野范围是竞技公平性的一部分，任何设备都必须能看到同样远的敌人
  const QUALITY = {
    high:   { pr: 2,    aa: true,  shadow: 2048, soft: true  },
    medium: { pr: 1.5,  aa: true,  shadow: 1024, soft: false },
    low:    { pr: 1.15, aa: false, shadow: 512,  soft: false },
  };
  const quality = (() => {
    const forced = qs.get('quality');
    if (QUALITY[forced]) return QUALITY[forced];
    if (!TOUCH) return QUALITY.high;
    const hwc = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;
    return (hwc <= 4 || mem <= 3) ? QUALITY.low : QUALITY.medium;
  })();

  const WICON = { fist: '👊', knife: '🔪', sword: '⚔️', hammer: '🔨', pistol: '🔫', mg: '💥', sniper: '🎯', nade: '🧨', boss: '👹', barrel: '🛢️' };
  const COS_ICON = { hat_cowboy: '🤠', hat_beret: '🧢', hat_horns: '😈', hat_crown: '👑', face_shades: '🕶️', face_visor: '🥽', back_cape: '🦸', back_jet: '🚀', back_wings: '👼', fx_ice: '❄️', fx_gold: '✨', fx_rainbow: '🌈' };

  // ---------- 渲染器 ----------
  const canvas = $('cv');
  const renderer = new T.WebGLRenderer({ canvas, antialias: quality.aa, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(quality.pr, window.devicePixelRatio));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = quality.soft ? T.PCFSoftShadowMap : T.PCFShadowMap;
  renderer.outputEncoding = T.sRGBEncoding;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.78;
  const scene = new T.Scene();
  const BASE_FOV = 75;
  const VIEW_LAYER = 1;
  const camera = new T.PerspectiveCamera(BASE_FOV, innerWidth / innerHeight, 0.08, 400);
  camera.rotation.order = 'YXZ';
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ---------- 设置（持久化） ----------
  const settings = {
    music: localStorage.getItem('na_music') !== '0',
    sfx: localStorage.getItem('na_sfx') !== '0',
    sens: parseFloat(localStorage.getItem('na_sens')) || 1,
    view: localStorage.getItem('na_view') === 'tp' ? 'tp' : 'fp',
  };
  G.audio.setMusic(settings.music);
  G.audio.setSfx(settings.sfx);
  G.audio.setLite(TOUCH);   // 轻量BGM：移动端减少同时发声的振荡器数量
  // 移动端音频解锁：触屏比鼠标点击更早触发，touchstart 抢在 click 之前解锁 AudioContext
  addEventListener('touchstart', () => G.audio.init(), { once: true, passive: true });
  // 触屏/桌面各自的操作说明 + 触控层显隐
  $('helpDesktop').classList.toggle('hidden', TOUCH);
  $('helpTouch').classList.toggle('hidden', !TOUCH);
  $('touchLayer').classList.toggle('hidden', !TOUCH);

  // ---------- 全局状态 ----------
  let ws = null, wsOk = false, defs = null, worldBuilt = false;
  let mode = 'menu';            // menu | play | spec
  let myId = 0, myName = localStorage.getItem('na_name') || '';
  let you = { coins: 0, owned: [], eq: { head: null, face: null, back: null, fx: null } };
  let mySnap = null;
  let lastKillerText = '';
  let rejoinWanted = false;
  let kickedText = null;        // 被反作弊踢出/封禁的原因（断线重连提示优先展示）
  let pingMs = 0, lastPingAt = 0;
  let dayBase = 0, dayAt = 0, dayMs = 600000;

  const me = {
    pos: V3(0, 0, 0), vy: 0, grounded: true, yaw: 0, pitch: 0,
    active: 'melee', ammoL: 0, reloadUntil: 0, reloadDur: 1,
    lastMelee: 0, lastShot: 0, lastNade: -99999, lastSwitch: 0,
    moving: false, zoom: 0, stepT: 0, spread: 0, fallV: 0,
    swayX: 0, swayY: 0,
  };
  const keys = {};
  let mouseDown = false, rmbDown = false, lockWanted = false;
  // 触屏摇杆/视角状态：joyX/joyZ 为 -1..1 模拟量（movement() 里与键盘输入二选一）
  const touch = { joyId: null, joyBaseX: 0, joyBaseY: 0, joyX: 0, joyZ: 0, lookId: null };
  const activeTouches = new Map();   // touch identifier -> {role:'joy'|'look', ...}

  const ents = new Map();
  let bossEnt = null;
  let pickupMeshes = [];
  let projMeshes = [];          // {id, kind, g, target, vel, netAt}
  let nadeMeshes = [];          // {id, g, target, vel, netAt}
  let merchant = null;
  let vm = null;
  let vmSwingT = 9, vmKick = 0, vmThrowT = 9;
  let myModel = null;           // 第三人称下渲染自己的模型
  let specFollow = -1, specFree = { pos: V3(0, 18, 30) }, specView = 'tp', specSpeed = 1;
  let shopPre = null, hoverEq = null;
  let lastBeatAt = 0;

  // ---------- 网络 ----------
  function connect() {
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    ws = new WebSocket(url);
    ws.onopen = () => {
      wsOk = true;
      $('lost').classList.add('hidden');
      if (rejoinWanted && myName) send({ type: 'join', name: myName });
    };
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      handleMsg(m);
    };
    ws.onclose = () => {
      wsOk = false;
      if (kickedText) {
        rejoinWanted = false;
        backToMenu();
        $('lost').classList.remove('hidden');
        $('lostText').textContent = kickedText;
        setTimeout(() => { $('lost').classList.add('hidden'); kickedText = null; }, 6000);
      } else if (mode !== 'menu' || rejoinWanted) {
        rejoinWanted = mode === 'play' || rejoinWanted;
        $('lost').classList.remove('hidden');
        $('lostText').textContent = '连接已断开，正在重连…';
      }
      setTimeout(connect, 2500);
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }
  function send(obj) { if (wsOk && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function handleMsg(m) {
    switch (m.type) {
      case 'defs': onDefs(m); break;
      case 'state': onState(m); break;
      case 'joined':
        myId = m.id; myName = m.name;
        localStorage.setItem('na_name', myName);
        you = m.you; rejoinWanted = false;
        enterPlay();
        break;
      case 'spec': mode = 'spec'; enterSpec(); break;
      case 'left': backToMenu(); break;
      case 'you': you = { coins: m.coins, owned: m.owned, eq: m.eq }; renderShop(); break;
      case 'fx': onFx(m); break;
      case 'kill': onKill(m); break;
      case 'chat': addChat(`<span class="cname" style="color:${m.color}">${esc(m.from)}</span>：${esc(m.text)}`); if (m.from !== myName) G.audio.chat(); break;
      case 'sys': onSys(m); break;
      case 'pk': onPk(m); break;
      case 'got': onGot(m); break;
      case 'board': renderBoard(m); break;
      case 'shopmsg': shopMsg(m.text, m.ok); if (m.ok) G.audio.buy(); else G.audio.deny(); break;
      case 'err': $('menuErr').textContent = m.text; break;
      case 'kicked': kickedText = m.text || '你已被移出对局'; rejoinWanted = false; break;
      case 'acwarn':
        bigNotice(m.text);
        addChat(`<span class="sys-text">${esc(m.text)}</span>`, 'sys streak');
        break;
      case 'pong': pingMs = now() - m.t; break;
    }
  }

  function onDefs(m) {
    defs = m;
    dayMs = (m.rules && m.rules.dayMs) || 600000;
    if (!worldBuilt) {
      worldBuilt = true;
      G.world.build(scene, defs.map, quality.shadow);
      G.fx.init(scene);
      merchant = G.models.makeMerchant();
      merchant.position.set(defs.map.merchant.x, 0, defs.map.merchant.z);
      merchant.rotation.y = Math.atan2(-(0 - defs.map.merchant.x), -(0 - defs.map.merchant.z));
      scene.add(merchant);
      pickupMeshes = defs.map.pickups.map(pt => ({ pt, item: null, mesh: null, lastTry: 0 }));
      vm = G.models.makeViewModel();
      vm.group.traverse(o => { o.layers.set(VIEW_LAYER); });
      camera.add(vm.group);
      scene.add(camera);
      buildShopTabs();
      camera.position.set(0, 14, 42);
      camera.lookAt(0, 0, 0);
    }
  }

  // ---------- 状态同步 ----------
  function onState(m) {
    if (!defs) return;
    dayBase = m.day || 0; dayAt = performance.now();
    $('menuOnline').textContent = m.pl.length;
    const seen = new Set();
    for (const s of m.pl) {
      seen.add(s.i);
      if (s.i === myId) { onMySnap(s); continue; }
      let e = ents.get(s.i);
      if (!e) {
        const model = G.models.makePlayer(s.c, s.n);
        scene.add(model.group);
        e = { id: s.i, name: s.n, color: s.c, model, cur: null, disp: { x: s.p[0], y: s.p[1], z: s.p[2], ya: s.ya, pi: s.pi }, lastHp: -1 };
        ents.set(s.i, e);
      }
      e.cur = s;
    }
    for (const [id, e] of ents) {
      if (!seen.has(id)) { scene.remove(e.model.group); ents.delete(id); }
    }
    // BOSS（多类型）
    if (m.boss) {
      if (!bossEnt || bossEnt.tp !== m.boss.tp) {
        if (bossEnt) scene.remove(bossEnt.model.group);
        const info = (defs.bosses && defs.bosses[m.boss.tp]) || { color: '#ff6a1a' };
        const model = G.models.makeBoss(m.boss.tp, m.boss.nm, info.color);
        scene.add(model.group);
        bossEnt = { tp: m.boss.tp, model, disp: { x: m.boss.p[0], z: m.boss.p[2], ya: m.boss.ya }, lastIv: -1 };
        $('bossBar').classList.remove('hidden');
        $('bossName').textContent = m.boss.nm;
      }
      bossEnt.cur = m.boss;
      $('bossFill').style.width = (m.boss.hp / m.boss.mx * 100) + '%';
      if (bossEnt.lastIv !== m.boss.iv) {
        bossEnt.lastIv = m.boss.iv;
        G.models.setBossOpacity(bossEnt.model, m.boss.iv ? 0.14 : 1);
      }
    } else if (bossEnt) {
      scene.remove(bossEnt.model.group);
      bossEnt = null;
      $('bossBar').classList.add('hidden');
    }
    if (!m.boss && m.nb > 0) {
      $('bossTimer').classList.remove('hidden');
      $('bossTimer').textContent = `👹 BOSS 将在 ${Math.ceil(m.nb / 1000)}s 后降临`;
    } else $('bossTimer').classList.add('hidden');
    // 弹道 / 手雷 / 油桶
    syncProjs(m.fb);
    syncNades(m.gd);
    if (m.br) G.world.setBarrels(m.br);
    // 拾取点
    for (let i = 0; i < pickupMeshes.length; i++) {
      const pm = pickupMeshes[i], item = m.pk[i];
      if (item !== pm.item) {
        if (pm.mesh) { scene.remove(pm.mesh); pm.mesh = null; }
        pm.item = item;
        if (item) {
          pm.mesh = G.models.makePickup(item, defs);
          pm.mesh.position.set(pm.pt.x, pm.pt.y || 0, pm.pt.z);
          scene.add(pm.mesh);
        }
      }
    }
  }
  function makeProjMesh(kind) {
    const g = new T.Group();
    if (kind === 1) {          // 机炮弹幕
      const s = new T.Mesh(new T.SphereGeometry(0.11, 6, 6), new T.MeshBasicMaterial({ color: '#ffd23c' }));
      g.add(s);
    } else if (kind === 2) {   // 追踪法球
      const s = new T.Mesh(new T.SphereGeometry(0.28, 10, 8), new T.MeshBasicMaterial({ color: '#a98aff' }));
      const glow = new T.Sprite(new T.SpriteMaterial({ color: '#8f5bff', transparent: true, opacity: 0.55, blending: T.AdditiveBlending, depthWrite: false }));
      glow.scale.setScalar(1.5);
      g.add(s, glow);
    } else {                   // 火球
      const s = new T.Mesh(new T.SphereGeometry(0.32, 10, 8), new T.MeshBasicMaterial({ color: '#ff8a30' }));
      const glow = new T.Sprite(new T.SpriteMaterial({ color: '#ff5a10', transparent: true, opacity: 0.6, blending: T.AdditiveBlending, depthWrite: false }));
      glow.scale.setScalar(1.6);
      g.add(s, glow);
    }
    return g;
  }
  function makeNadeMesh() {
    const g = new T.Mesh(new T.SphereGeometry(0.13, 8, 8), new T.MeshStandardMaterial({ color: '#3c5232' }));
    g.castShadow = true;
    return g;
  }
  function readProj(a, i) {
    if (a.length >= 8) return { id: 'p' + a[0], pos: V3(a[1], a[2], a[3]), vel: V3(a[4], a[5], a[6]), kind: a[7] || 0 };
    return { id: 'po' + i, pos: V3(a[0], a[1], a[2]), vel: V3(0, 0, 0), kind: a[3] || 0 };
  }
  function readNade(a, i) {
    if (a.length >= 7) return { id: 'g' + a[0], pos: V3(a[1], a[2], a[3]), vel: V3(a[4], a[5], a[6]), kind: 0 };
    return { id: 'go' + i, pos: V3(a[0], a[1], a[2]), vel: V3(0, 0, 0), kind: 0 };
  }
  function syncMoving(pool, arr, make, read) {
    const seen = new Set();
    for (let i = 0; i < arr.length; i++) {
      const n = read(arr[i], i);
      seen.add(n.id);
      let idx = pool.findIndex(e => e.id === n.id);
      if (idx >= 0 && pool[idx].kind !== n.kind) {
        scene.remove(pool[idx].g);
        pool.splice(idx, 1);
        idx = -1;
      }
      let e = idx >= 0 ? pool[idx] : null;
      if (!e) {
        e = { id: n.id, kind: n.kind, g: make(n.kind), target: n.pos.clone(), vel: n.vel.clone(), netAt: perfNow };
        e.g.position.copy(n.pos);
        scene.add(e.g);
        pool.push(e);
      }
      e.target.copy(n.pos);
      e.vel.copy(n.vel);
      e.netAt = perfNow;
    }
    for (let i = pool.length - 1; i >= 0; i--) {
      if (seen.has(pool[i].id)) continue;
      scene.remove(pool[i].g);
      pool.splice(i, 1);
    }
  }
  function syncProjs(arr) {
    syncMoving(projMeshes, arr || [], makeProjMesh, readProj);
  }
  function syncNades(arr) {
    syncMoving(nadeMeshes, arr || [], makeNadeMesh, readNade);
  }
  function advanceMoving(pool, dt, ballistic) {
    const k = 1 - Math.exp(-dt * 20);
    const grav = defs && defs.rules ? defs.rules.gravity : 22;
    for (const e of pool) {
      const lead = Math.min(0.14, Math.max(0, (perfNow - e.netAt) / 1000));
      const want = e.target.clone().addScaledVector(e.vel, lead);
      if (ballistic) want.y -= 0.5 * grav * lead * lead;
      if (e.g.position.distanceToSquared(want) > 64) e.g.position.copy(want);
      else e.g.position.lerp(want, k);
      e.g.rotation.x += dt * 7;
      e.g.rotation.y += dt * 4;
    }
  }
  function renderMovingProjectiles(dt) {
    advanceMoving(projMeshes, dt, false);
    advanceMoving(nadeMeshes, dt, true);
  }

  function onMySnap(s) {
    const wasAlive = mySnap ? mySnap.al : 1;
    mySnap = s;
    if (s.rl > 0) { me.reloadUntil = now() + s.rl; me.reloadDur = defs.weapons[s.gw] ? defs.weapons[s.gw].reload * 1000 : 1000; }
    else if (me.reloadUntil > now() + 200) me.reloadUntil = 0;
    if (Math.abs(s.am - me.ammoL) > 1 || s.rl > 0) me.ammoL = s.am;
    const zomb = s.bf.some(b => b[0] === 'zombie');
    if (zomb) me.active = 'melee';
    else if (now() - me.lastSwitch > 600 && s.ac !== me.active) me.active = s.ac;
    if (me.active === 'gun' && !s.gw) me.active = 'melee';
    if (wasAlive && !s.al) onMyDeath();
    if (!wasAlive && s.al && mode === 'play') {
      $('death').classList.add('hidden');
      me.pos.set(s.p[0], s.p[1], s.p[2]);
      me.vy = 0;
      G.audio.respawn();
    }
    const d2 = (me.pos.x - s.p[0]) ** 2 + (me.pos.z - s.p[2]) ** 2;
    if (d2 > 36 && s.al) me.pos.set(s.p[0], s.p[1], s.p[2]);
    updateHud();
  }

  // ---------- FX 事件 ----------
  function entPos(id) {
    if (id === myId) return [me.pos.x, me.pos.y + 1, me.pos.z];
    const e = ents.get(id);
    return e ? [e.disp.x, e.disp.y + 1, e.disp.z] : null;
  }
  function distToMe(pos) {
    return Math.hypot(pos[0] - camera.position.x, pos[2] - camera.position.z);
  }
  function onFx(m) {
    switch (m.k) {
      case 'shot': {
        if (m.id === myId) break;
        G.fx.tracer(m.o, m.e, '#ffd98a');
        G.fx.muzzle(V3(m.o[0], m.o[1], m.o[2]));
        if (distToMe(m.o) < 75) G.audio.shot(m.wp);
        const e = ents.get(m.id);
        if (e) e.model.attackT = 0;
        break;
      }
      case 'melee': {
        if (m.id === myId) break;
        const e = ents.get(m.id);
        if (e) { e.model.attackT = 0; e.model.attackDur = 0.3; }
        const p = entPos(m.id);
        if (p && distToMe(p) < 40) G.audio.melee(m.wp);
        break;
      }
      case 'hit': {
        G.fx.blood(m.pos);
        if (m.by === myId) {
          const hm = $('hitmarker');
          hm.classList.remove('show', 'crit'); void hm.offsetWidth;
          if (m.crit || m.hs) hm.classList.add('crit');
          hm.classList.add('show');
          if (m.hs) G.audio.headshot(); else G.audio.hit(m.crit);
          G.fx.damageText(m.pos, (m.hs ? '爆头 ' : '') + m.dmg + (m.crit ? '!' : ''), m.crit ? '#ffd23c' : m.hs ? '#ff9c3c' : '#fff', m.crit || m.hs);
        }
        if (m.tg === myId) {
          G.audio.hurt();
          const dv = $('dmgVignette');
          dv.style.opacity = Math.min(1, 0.35 + m.dmg / 60);
          setTimeout(() => dv.style.opacity = 0, 140);
          G.fx.shake(Math.min(0.5, m.dmg / 80));
          if (m.by) { const ap = entPos(m.by); if (ap) showDmgDir(ap); }
          else if (bossEnt) showDmgDir([bossEnt.disp.x, 0, bossEnt.disp.z]);
        }
        break;
      }
      case 'immune': G.fx.damageText(m.pos, '免疫', '#9fd8ef', false); if (m.tg !== myId) G.audio.immune(); break;
      case 'explode':
        G.fx.explosion(m.pos, m.r, { fire: m.fire, boss: m.boss, vp: m.vp });
        if (distToMe(m.pos) < 90) G.audio.explosion(m.boss || m.r > 4);
        break;
      case 'throw': if (m.id !== myId) G.audio.throwNade(); break;
      case 'die': {
        const e = ents.get(m.id);
        G.fx.die(m.pos, e ? e.color : '#ff6b6b');
        if (distToMe(m.pos) < 60) G.audio.die();
        break;
      }
      case 'respawn': G.fx.respawnBeam(m.pos); break;
      case 'slam': G.fx.slam(m.pos, m.r); if (bossEnt) bossEnt.model.slamT = 0; if (distToMe(m.pos) < 70) G.audio.slam(); break;
      case 'slash': G.fx.impact(m.pos, '#ff4060'); if (bossEnt) bossEnt.model.slamT = 0; if (distToMe(m.pos) < 50) G.audio.melee('knife'); break;
      case 'blink':
        G.fx.sparkle(m.from, '#b46bff'); G.fx.sparkle(m.to, '#b46bff');
        if (distToMe(m.to) < 60) G.audio.blink();
        break;
      case 'burst': if (bossEnt) bossEnt.model.slamT = 0; if (distToMe(m.pos) < 80) G.audio.burstFire(); break;
      case 'cast': G.fx.sparkle(m.pos, '#8f7bff'); if (bossEnt) bossEnt.model.slamT = 0; if (distToMe(m.pos) < 70) G.audio.cast(); break;
      case 'voidring': G.fx.telegraph(m.pos, m.r, m.ms); if (distToMe(m.pos) < 70) G.audio.cast(); break;
      case 'pimpact': G.fx.impact(m.pos, '#ffd98a'); break;
      case 'roar': G.fx.roarWave(m.pos); G.audio.roar(); break;
      case 'bossfire': if (distToMe(m.pos) < 80) G.audio.bossFire(); break;
      case 'bosshit':
        G.fx.impact(m.pos, '#ff8a50');
        if (m.by === myId) { G.fx.damageText(m.pos, m.dmg, '#ff9c3c', false); G.audio.hit(false); }
        break;
      case 'barrel': {
        const br = G.world.barrelAt(m.id);
        if (br) br.group.visible = false;
        break;
      }
      case 'barrelhit': G.fx.impact(m.pos, '#ffb02e'); if (distToMe(m.pos) < 50) G.audio.hit(false); break;
      case 'barrelup': {
        const br = G.world.barrelAt(m.id);
        if (br) { br.group.visible = true; G.fx.sparkle([br.x, 0.8, br.z], '#ffb02e'); }
        break;
      }
    }
  }

  function onKill(m) {
    const icon = m.boss ? '👹' : (WICON[m.wp] || '🔫');
    let html;
    if (m.self) html = `<b style="color:${m.v.c}">${esc(m.v.n)}</b><span class="wp">${icon}</span>自爆了`;
    else if (m.boss && !m.k) html = `<b style="color:#ff9c5c">👹 ${esc(m.boss)}</b><span class="wp">${icon}</span><b style="color:${m.v.c}">${esc(m.v.n)}</b>`;
    else if (!m.k) html = `<b style="color:${m.v.c}">${esc(m.v.n)}</b><span class="wp">💥</span>被炸飞了`;
    else html = `<b style="color:${m.k.c}">${esc(m.k.n)}</b><span class="wp">${icon}</span><b style="color:${m.v.c}">${esc(m.v.n)}</b>`;
    addKillfeed(html);
    if (m.k && m.k.id === myId && m.v.id !== myId) {
      G.audio.kill();
      notice(`击杀 ${m.v.n} +25🪙`, true);
    }
    if (m.v.id === myId) {
      lastKillerText = m.self ? '你被自己的爆炸送走了' :
        m.boss && !m.k ? `被 BOSS「${m.boss}」击杀` :
        !m.k ? '被爆炸送走了' :
        `被 <b style="color:${m.k.c}">${esc(m.k.n)}</b> 用${icon}击杀`;
    }
  }

  function onSys(m) {
    addChat(`<span class="sys-text">${esc(m.text)}</span>`, 'sys ' + (m.style || ''));
    if (m.style === 'boss' || m.style === 'streak') bigNotice(m.text);
    if (m.style === 'boss' && m.text.includes('降临')) {
      G.audio.roar();
      const bf = $('bossFlash');
      bf.classList.remove('show'); void bf.offsetWidth; bf.classList.add('show');
    }
  }

  function onPk(m) {
    const pt = defs.map.pickups[m.id];
    if (!pt) return;
    const y = (pt.y || 0) + 0.5;
    if (m.ev === 'taken') G.fx.sparkle([pt.x, y, pt.z], '#9ff3ff');
    else if (m.ev === 'spawn') G.fx.sparkle([pt.x, y, pt.z], '#fff2a8');
  }

  function onGot(m) {
    if (m.kind === 'buff') {
      G.audio.buff();
      if (m.item === 'zombie') G.audio.zombie();
      notice(`${defs.buffs[m.item] ? defs.buffs[m.item].icon : '✨'} ${m.name} · ${m.desc}`, true);
    } else if (m.kind === 'coin') {
      G.audio.buy(); notice(m.name, true);
    } else {
      G.audio.pickup();
      notice(`获得 ${WICON[m.item] || '📦'} ${m.name}${m.desc ? ' · ' + m.desc : ''}`);
    }
  }

  // ---------- 模式切换 ----------
  function enterPlay() {
    mode = 'play';
    $('menu').classList.add('hidden');
    $('hud').classList.remove('hidden');
    $('chatBox').classList.remove('hidden');
    $('specBar').classList.add('hidden');
    $('death').classList.add('hidden');
    me.active = 'melee'; me.ammoL = 0; me.lastNade = -99999;
    if (mySnap) { me.pos.set(mySnap.p[0], mySnap.p[1], mySnap.p[2]); }
    requestLock();
  }
  function enterSpec() {
    mode = 'spec';
    $('menu').classList.add('hidden');
    $('hud').classList.add('hidden');
    $('death').classList.add('hidden');
    $('chatBox').classList.remove('hidden');
    $('specBar').classList.remove('hidden');
    mySnap = null; myId = 0;
    specFollow = -1; specView = 'tp';
    specFree.pos = camera.position.clone();
    updateSpecBar();
    requestLock();
  }
  function backToMenu() {
    mode = 'menu';
    mySnap = null; myId = 0;
    if (myModel) myModel.group.visible = false;
    $('menu').classList.remove('hidden');
    $('hud').classList.add('hidden');
    $('specBar').classList.add('hidden');
    $('death').classList.add('hidden');
    $('shop').classList.add('hidden');
    $('pause').classList.add('hidden');
    document.exitPointerLock && document.exitPointerLock();
  }
  function onMyDeath() {
    $('death').classList.remove('hidden');
    $('deathBy').innerHTML = lastKillerText || '';
    me.zoom = 0;
  }

  // ---------- UI 工具 ----------
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function addChat(html, cls) {
    const div = document.createElement('div');
    div.className = 'cmsg ' + (cls || '');
    div.innerHTML = html;
    const box = $('chatMsgs');
    box.appendChild(div);
    while (box.children.length > 40) box.removeChild(box.firstChild);
    setTimeout(() => { if (div.parentNode) div.style.opacity = '0.45'; }, 12000);
  }
  function addKillfeed(html) {
    const div = document.createElement('div');
    div.className = 'kf';
    div.innerHTML = html;
    const kf = $('killfeed');
    kf.appendChild(div);
    while (kf.children.length > 6) kf.removeChild(kf.firstChild);
    setTimeout(() => { if (div.parentNode) div.remove(); }, 6500);
  }
  function notice(text, gold) {
    const div = document.createElement('div');
    div.className = 'notice-item' + (gold ? ' gold' : '');
    div.textContent = text;
    const n = $('notice');
    n.appendChild(div);
    while (n.children.length > 4) n.removeChild(n.firstChild);
    setTimeout(() => { if (div.parentNode) div.remove(); }, 2700);
  }
  function bigNotice(text) {
    const b = $('bigNotice');
    b.textContent = text;
    b.classList.remove('show'); void b.offsetWidth;
    b.classList.add('show');
  }
  function shopMsg(text, ok) {
    const el = $('shopMsg');
    el.textContent = text;
    el.className = ok ? '' : 'bad';
  }
  // 受击方向指示（红色弧线指向攻击者）
  const dmgArcs = [];
  function showDmgDir(apos) {
    const wrap = $('dmgDirWrap');
    let arc = dmgArcs.find(a => !a.busy);
    if (!arc) {
      if (dmgArcs.length >= 4) return;
      const div = document.createElement('div');
      div.className = 'dmg-arc';
      wrap.appendChild(div);
      arc = { div, busy: false };
      dmgArcs.push(arc);
    }
    const bearing = Math.atan2(-(apos[0] - camera.position.x), -(apos[2] - camera.position.z));
    let rel = bearing - me.yaw;
    const deg = -rel * 180 / Math.PI;
    arc.busy = true;
    arc.div.style.setProperty('--ang', deg + 'deg');
    arc.div.classList.remove('show'); void arc.div.offsetWidth;
    arc.div.classList.add('show');
    setTimeout(() => { arc.busy = false; }, 800);
  }

  // ---------- HUD ----------
  function updateHud() {
    if (!mySnap || mode !== 'play') return;
    const s = mySnap;
    $('hpFill').style.width = s.hp + '%'; $('hpNum').textContent = s.hp;
    document.querySelector('.bar.hp').classList.toggle('low', s.hp <= 30);
    $('arFill').style.width = s.ar + '%'; $('arNum').textContent = s.ar;
    const shRow = $('shieldRow');
    shRow.style.display = s.sh > 0 ? 'flex' : 'none';
    $('shFill').style.width = s.sh + '%'; $('shNum').textContent = s.sh;
    $('coinNum').textContent = s.co;
    you.coins = s.co;
    $('shopCoins').textContent = s.co;
    const zomb = s.bf.some(b => b[0] === 'zombie');
    const sm = $('slotMelee');
    sm.querySelector('.wico').textContent = zomb ? '🧟' : WICON[s.mw];
    sm.querySelector('.wname').textContent = zomb ? '丧尸利爪' : defs.weapons[s.mw].name;
    sm.classList.toggle('active', me.active === 'melee');
    const sg = $('slotGun');
    sg.classList.toggle('empty', !s.gw);
    sg.classList.toggle('active', me.active === 'gun');
    if (s.gw) {
      sg.querySelector('.wico').textContent = WICON[s.gw];
      sg.querySelector('.wname').textContent = defs.weapons[s.gw].name;
      sg.querySelector('.wammo').textContent = `${me.ammoL}/${defs.weapons[s.gw].mag}`;
    } else {
      sg.querySelector('.wico').textContent = '·';
      sg.querySelector('.wname').textContent = '未拾取枪械';
      sg.querySelector('.wammo').textContent = '';
    }
    const sn = $('slotNade');
    sn.classList.toggle('empty', !s.hn);
    sn.classList.toggle('active', me.active === 'nade');
    sn.querySelector('.wico').textContent = '🧨';
    sn.querySelector('.wname').textContent = s.hn ? '手雷' : '未拾取手雷';
    const nadeCd = Math.max(0, 3500 - (now() - me.lastNade));
    sn.querySelector('.wammo').textContent = s.hn ? (nadeCd > 0 ? (nadeCd / 1000).toFixed(1) + 's' : '✓') : '';
    const br = $('buffRow');
    br.innerHTML = s.bf.map(([k, ms]) => {
      const b = defs.buffs[k];
      if (!b) return '';
      return `<div class="buff-chip" style="--bc:${b.color}">${b.icon} ${b.name} ${(ms / 1000).toFixed(0)}s</div>`;
    }).join('');
    $('zombieTint').style.opacity = zomb ? 1 : 0;
    $('protectHint').classList.toggle('hidden', !s.pr);
  }

  // ---------- 排行榜（含首页历史榜） ----------
  function renderBoard(m) {
    const mkRows = (rows, isRt) => {
      let html = `<div class="brow head"><span>#</span><span>玩家</span><span class="num">击杀</span><span class="num">死亡</span><span class="num">${isRt ? '得分' : 'BOSS'}</span></div>`;
      rows.forEach((r, i) => {
        const meCls = (isRt && r.i === myId) || (!isRt && r.n === myName) ? ' me' : '';
        html += `<div class="brow${meCls}"><span class="rank r${i + 1}">${i + 1}</span><span style="color:${r.c || '#cfe6f5'}">${esc(r.n)}</span><span class="num">${r.k}</span><span class="num">${r.d}</span><span class="num">${isRt ? r.s : r.bk}</span></div>`;
      });
      if (!rows.length) html += '<div class="brow"><span></span><span style="color:#7591ad">暂无数据</span></div>';
      return html;
    };
    $('boardRt').innerHTML = mkRows(m.rt, true);
    $('boardHist').innerHTML = mkRows(m.hist, false);
    $('menuHist').innerHTML = mkRows(m.hist.slice(0, 8), false);
  }
  $('tabRt').onclick = () => { $('tabRt').classList.add('active'); $('tabHist').classList.remove('active'); $('boardRt').classList.remove('hidden'); $('boardHist').classList.add('hidden'); };
  $('tabHist').onclick = () => { $('tabHist').classList.add('active'); $('tabRt').classList.remove('active'); $('boardHist').classList.remove('hidden'); $('boardRt').classList.add('hidden'); };

  // ---------- 商店（含 3D 试穿预览） ----------
  let shopTab = 'head';
  function buildShopTabs() {
    const tabs = $('shopTabs');
    tabs.innerHTML = '';
    for (const [slot, label] of Object.entries(defs.shopSlots)) {
      const b = document.createElement('button');
      b.className = 'tab' + (slot === shopTab ? ' active' : '');
      b.textContent = label;
      b.onclick = () => { shopTab = slot; hoverEq = null; buildShopTabs(); renderShop(); };
      tabs.appendChild(b);
    }
  }
  function initShopPre() {
    if (shopPre) return;
    const cv = $('shopCv');
    const r = new T.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
    r.setSize(240, 320, false);
    r.outputEncoding = T.sRGBEncoding;
    const sc = new T.Scene();
    sc.add(new T.HemisphereLight(0xbfd9ff, 0x282030, 0.95));
    const dl = new T.DirectionalLight(0xffffff, 0.9);
    dl.position.set(2, 3, 2.5);
    sc.add(dl);
    const cam = new T.PerspectiveCamera(38, 240 / 320, 0.1, 20);
    cam.position.set(0, 1.35, 3.5);
    cam.lookAt(0, 1.0, 0);
    const model = G.models.makePlayer(mySnap ? mySnap.c : '#4dabf7', myName || '我');
    model.plate.visible = false;
    G.models.setPlayerWeapon(model, 'sword');
    sc.add(model.group);
    shopPre = { r, sc, cam, model };
  }
  function renderShopPre(dt) {
    if (!shopPre || $('shop').classList.contains('hidden')) return;
    const eq = hoverEq || you.eq || {};
    const fxPreview = ['knife', 'sword', 'pistol', 'mg', 'sniper', 'hammer'];
    const previewWeapon = shopTab === 'fx' ? fxPreview[Math.floor(perfNow / 1400) % fxPreview.length] : 'sword';
    G.models.setPlayerWeapon(shopPre.model, previewWeapon);
    G.models.applyCosmetics(shopPre.model, eq);
    G.models.applyWeaponFx(shopPre.model, eq.fx, perfNow / 1000);
    shopPre.model.group.rotation.y += dt * 0.9;
    shopPre.r.render(shopPre.sc, shopPre.cam);
  }
  function renderShop() {
    if (!defs) return;
    $('shopCoins').textContent = you.coins;
    const grid = $('shopGrid');
    grid.innerHTML = '';
    for (const item of defs.shop.filter(s => s.slot === shopTab)) {
      const owned = you.owned.includes(item.id);
      const equipped = you.eq[item.slot] === item.id;
      const div = document.createElement('div');
      div.className = 'shop-item';
      div.innerHTML = `<div class="si-preview">${COS_ICON[item.id] || '🎁'}</div>
        <div class="si-name">${item.name}</div><div class="si-price">🪙 ${item.price}</div>`;
      const btn = document.createElement('button');
      if (equipped) { btn.textContent = '已装备 · 点击卸下'; btn.className = 'equipped'; btn.onclick = () => send({ type: 'equip', slot: item.slot, id: null }); }
      else if (owned) { btn.textContent = '装备'; btn.className = 'owned'; btn.onclick = () => send({ type: 'equip', slot: item.slot, id: item.id }); }
      else { btn.textContent = '购买'; btn.disabled = you.coins < item.price; btn.onclick = () => send({ type: 'buy', id: item.id }); }
      div.appendChild(btn);
      // 悬停试穿
      div.addEventListener('mouseenter', () => { hoverEq = Object.assign({}, you.eq, { [item.slot]: item.id }); });
      div.addEventListener('mouseleave', () => { hoverEq = null; });
      grid.appendChild(div);
    }
  }
  function toggleShop(open) {
    const el = $('shop');
    const want = open === undefined ? el.classList.contains('hidden') : open;
    if (want) {
      initShopPre();
      renderShop(); shopMsg('', true);
      hoverEq = null;
      el.classList.remove('hidden');
      document.exitPointerLock && document.exitPointerLock();
    } else {
      el.classList.add('hidden');
      hoverEq = null;
      if (mode === 'play') requestLock();
    }
  }

  // ---------- 设置面板 ----------
  function refreshOpts() {
    $('optMusic').textContent = settings.music ? '开' : '关';
    $('optMusic').classList.toggle('off', !settings.music);
    $('optSfx').textContent = settings.sfx ? '开' : '关';
    $('optSfx').classList.toggle('off', !settings.sfx);
    $('optView').textContent = settings.view === 'tp' ? '第三人称' : '第一人称';
    $('optSens').value = Math.round(settings.sens * 100);
  }
  $('optMusic').onclick = () => {
    settings.music = !settings.music;
    localStorage.setItem('na_music', settings.music ? '1' : '0');
    G.audio.setMusic(settings.music);
    refreshOpts(); G.audio.ui();
  };
  $('optSfx').onclick = () => {
    settings.sfx = !settings.sfx;
    localStorage.setItem('na_sfx', settings.sfx ? '1' : '0');
    G.audio.setSfx(settings.sfx);
    refreshOpts(); G.audio.ui();
  };
  $('optView').onclick = () => { toggleView(); refreshOpts(); };
  $('optSens').oninput = () => {
    settings.sens = $('optSens').value / 100;
    localStorage.setItem('na_sens', settings.sens);
  };
  function toggleView() {
    if (mode === 'spec') { specView = specView === 'tp' ? 'fp' : 'tp'; updateSpecBar(); return; }
    settings.view = settings.view === 'tp' ? 'fp' : 'tp';
    localStorage.setItem('na_view', settings.view);
    refreshOpts();
    G.audio.ui();
  }
  function openPause() {
    refreshOpts();
    $('pause').classList.remove('hidden');
    document.exitPointerLock && document.exitPointerLock();
  }
  function closePause() {
    $('pause').classList.add('hidden');
    if (mode !== 'menu') requestLock();
  }

  // ---------- 指针锁定与输入 ----------
  function requestLock() {
    lockWanted = true;
    if (NOLOCK || TOUCH) return;   // 触屏没有指针锁定这回事，视角改由触摸拖拽驱动
    try { canvas.requestPointerLock && canvas.requestPointerLock(); } catch (_) {}
  }
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && lockWanted && (mode === 'play' || mode === 'spec')
      && $('shop').classList.contains('hidden') && $('pause').classList.contains('hidden') && !NOLOCK && !TOUCH) {
      openPause();
    }
  });
  canvas.addEventListener('click', () => {
    G.audio.init();
    if (!TOUCH && mode !== 'menu' && !document.pointerLockElement
      && $('pause').classList.contains('hidden') && $('shop').classList.contains('hidden')) requestLock();
  });
  $('btnResume').onclick = () => closePause();
  $('btnToMenu').onclick = () => { send({ type: 'leave' }); rejoinWanted = false; lockWanted = false; backToMenu(); };

  // 视角旋转：鼠标(movementX/Y)与触屏拖拽(帧间坐标差)最终都走这一个函数，行为完全一致
  function applyLook(dx, dy, sensMul) {
    if (mode === 'menu') return;
    const sens = (sensMul || 0.0022) * settings.sens * (me.zoom > 0.5 ? 0.4 : 1);
    me.yaw -= dx * sens;
    me.pitch = Math.max(-1.53, Math.min(1.53, me.pitch - dy * sens));
    me.swayX = Math.max(-0.06, Math.min(0.06, me.swayX + dx * 0.0005));
    me.swayY = Math.max(-0.05, Math.min(0.05, me.swayY + dy * 0.0005));
  }
  document.addEventListener('mousemove', e => {
    const locked = !!document.pointerLockElement || NOLOCK;
    if (!locked || mode === 'menu') return;
    applyLook(e.movementX, e.movementY);
  });
  document.addEventListener('mousedown', e => {
    if (mode === 'menu' || isTyping()) return;
    if (!$('shop').classList.contains('hidden') || !$('pause').classList.contains('hidden')
      || !$('lost').classList.contains('hidden')) return;
    if (e.button === 0) mouseDown = true;
    if (e.button === 2) rmbDown = true;
  });
  document.addEventListener('mouseup', e => {
    if (e.button === 0) mouseDown = false;
    if (e.button === 2) rmbDown = false;
  });
  document.addEventListener('contextmenu', e => e.preventDefault());
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouseDown = rmbDown = false; touch.joyId = touch.lookId = null; });

  // ---------- 触屏：虚拟摇杆 + 视角拖拽（画布上的触点按落点区域二选一角色） ----------
  // 摇杆：浮动式，落在左下区域即在触点处生成；视角：其余区域拖拽，帧间坐标差喂给 applyLook()
  // 按钮（.tbtn）pointer-events:auto 会先于画布收到触摸，这里天然不会跟按钮冲突
  function joyZoneHit(x, y) { return x < innerWidth * 0.52 && y > innerHeight * 0.4; }
  function showJoyAt(x, y) {
    const base = $('joyBase');
    base.style.left = (x - 56) + 'px'; base.style.top = (y - 56) + 'px';
    base.classList.add('show');
    $('joyStick').style.transform = 'translate(0px,0px)';
  }
  canvas.addEventListener('touchstart', e => {
    if (mode === 'menu' || isTyping()) return;
    for (const t of e.changedTouches) {
      if (touch.joyId === null && joyZoneHit(t.clientX, t.clientY)) {
        touch.joyId = t.identifier; touch.joyBaseX = t.clientX; touch.joyBaseY = t.clientY;
        touch.joyX = 0; touch.joyZ = 0;
        showJoyAt(t.clientX, t.clientY);
      } else if (touch.lookId === null && !joyZoneHit(t.clientX, t.clientY)) {
        touch.lookId = t.identifier;
        activeTouches.set(t.identifier, { lastX: t.clientX, lastY: t.clientY });
      }
    }
  }, { passive: true });
  canvas.addEventListener('touchmove', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === touch.joyId) {
        let dx = t.clientX - touch.joyBaseX, dy = t.clientY - touch.joyBaseY;
        const R = 52, dist = Math.hypot(dx, dy);
        if (dist > R) { dx = dx / dist * R; dy = dy / dist * R; }
        $('joyStick').style.transform = `translate(${dx}px,${dy}px)`;
        touch.joyX = dx / R; touch.joyZ = -dy / R;
      } else if (t.identifier === touch.lookId) {
        const info = activeTouches.get(t.identifier);
        if (!info) continue;
        const dx = t.clientX - info.lastX, dy = t.clientY - info.lastY;
        info.lastX = t.clientX; info.lastY = t.clientY;
        applyLook(dx, dy, 0.0032);
      }
    }
  }, { passive: true });
  function touchEndHandler(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === touch.joyId) {
        touch.joyId = null; touch.joyX = 0; touch.joyZ = 0;
        $('joyBase').classList.remove('show');
      } else if (t.identifier === touch.lookId) {
        touch.lookId = null; activeTouches.delete(t.identifier);
      }
    }
  }
  canvas.addEventListener('touchend', touchEndHandler, { passive: true });
  canvas.addEventListener('touchcancel', touchEndHandler, { passive: true });

  // 触屏按钮：Fire/Jump 需要"按住"语义走 touchstart/touchend；其余简单点按复用原生 click 即可
  function touchActionAllowed() {
    return mode !== 'menu' && !isTyping() && $('shop').classList.contains('hidden')
      && $('pause').classList.contains('hidden') && $('lost').classList.contains('hidden');
  }
  $('tFire').addEventListener('touchstart', e => { e.preventDefault(); if (touchActionAllowed()) mouseDown = true; }, { passive: false });
  $('tFire').addEventListener('touchend', e => { e.preventDefault(); mouseDown = false; }, { passive: false });
  $('tFire').addEventListener('touchcancel', () => { mouseDown = false; });
  $('tJump').addEventListener('touchstart', e => { e.preventDefault(); if (touchActionAllowed()) keys.Space = true; }, { passive: false });
  $('tJump').addEventListener('touchend', e => { e.preventDefault(); keys.Space = false; }, { passive: false });
  $('tJump').addEventListener('touchcancel', () => { keys.Space = false; });
  $('tScope').onclick = () => { if (touchActionAllowed()) rmbDown = !rmbDown; };
  $('tMenu').onclick = () => { if (mode === 'play' || mode === 'spec') openPause(); };
  $('tBoard').onclick = () => { $('board').classList.toggle('hidden'); };
  $('tChat').onclick = () => { if (mode === 'play') openChat(); };
  $('boardClose').onclick = () => { $('board').classList.add('hidden'); };
  $('shopClose').onclick = () => toggleShop(false);
  // 武器栏点按切换（桌面鼠标点击同样生效，无副作用）；再点已激活的枪械栏 = 换弹
  $('slotMelee').onclick = () => switchSlot('melee');
  $('slotNade').onclick = () => switchSlot('nade');
  $('slotGun').onclick = () => {
    if (!mySnap || !mySnap.gw) return;
    if (me.active !== 'gun') switchSlot('gun');
    else { send({ type: 'reload' }); tryLocalReload(); }
  };
  $('interactHint').onclick = () => tryInteract();

  // 滚轮：战局中切武器 / 观战自由视角调速
  addEventListener('wheel', e => {
    if (isTyping() || !$('shop').classList.contains('hidden')) return;
    if (mode === 'play' && mySnap && mySnap.al) {
      cycleWeapon(e.deltaY > 0 ? 1 : -1);
    } else if (mode === 'spec' && specFollow === -1) {
      specSpeed = Math.max(0.3, Math.min(4, specSpeed * (e.deltaY > 0 ? 0.85 : 1.18)));
    }
  }, { passive: true });
  function cycleWeapon(dir) {
    if (!mySnap) return;
    const zomb = mySnap.bf.some(b => b[0] === 'zombie');
    if (zomb) return;
    const slots = ['melee'];
    if (mySnap.gw) slots.push('gun');
    if (mySnap.hn) slots.push('nade');
    if (slots.length < 2) return;
    let idx = slots.indexOf(me.active);
    if (idx < 0) idx = 0;
    switchSlot(slots[(idx + dir + slots.length) % slots.length]);
  }

  function isTyping() { return document.activeElement === $('chatInput') || document.activeElement === $('nameInput'); }

  document.addEventListener('keydown', e => {
    if (e.code === 'Tab') { e.preventDefault(); if (mode !== 'menu' && !isTyping()) $('board').classList.remove('hidden'); return; }
    if (e.code === 'Escape') {
      if (!$('shop').classList.contains('hidden')) { toggleShop(false); return; }
      if (!$('pause').classList.contains('hidden')) { closePause(); return; }
      if (mode === 'play' || mode === 'spec') openPause();
      return;
    }
    if (isTyping()) return;
    keys[e.code] = true;
    if (e.code === 'Enter') {
      if (mode === 'spec') { joinFromSpec(); return; }
      if (mode === 'play') openChat();
      return;
    }
    if (e.code === 'KeyV' && mode !== 'menu') { toggleView(); return; }
    if (mode === 'play') {
      if (e.code === 'Digit1') switchSlot('melee');
      if (e.code === 'Digit2') switchSlot('gun');
      if (e.code === 'Digit3') switchSlot('nade');
      if (e.code === 'KeyR') { send({ type: 'reload' }); tryLocalReload(); }
      if (e.code === 'KeyE') tryInteract();
    }
    if (mode === 'spec') {
      if (e.code === 'KeyF') { specFollow = specFollow === -1 ? 0 : -1; updateSpecBar(); }
      if (e.code === 'ArrowLeft') cycleSpec(-1);
      if (e.code === 'ArrowRight') cycleSpec(1);
    }
  });
  document.addEventListener('keyup', e => {
    if (e.code === 'Tab') { e.preventDefault(); $('board').classList.add('hidden'); return; }
    keys[e.code] = false;
  });

  function switchSlot(slot) {
    if (!mySnap) return;
    const zomb = mySnap.bf.some(b => b[0] === 'zombie');
    if (zomb && slot !== 'melee') { G.audio.deny(); return; }
    if (slot === 'gun' && !mySnap.gw) { G.audio.deny(); return; }
    if (slot === 'nade' && !mySnap.hn) { G.audio.deny(); return; }
    if (me.active === slot) return;
    me.active = slot; me.lastSwitch = now();
    send({ type: 'switch', slot });
    G.audio.ui();
  }
  function tryLocalReload() {
    if (!mySnap || !mySnap.gw) return;
    const def = defs.weapons[mySnap.gw];
    if (me.ammoL >= def.mag || me.reloadUntil > now()) return;
    me.reloadUntil = now() + def.reload * 1000;
    me.reloadDur = def.reload * 1000;
    G.audio.reload();
  }
  function tryInteract() {
    if (!defs) return;
    const md = Math.hypot(me.pos.x - defs.map.merchant.x, me.pos.z - defs.map.merchant.z);
    if (md < defs.rules.merchantDist || !$('shop').classList.contains('hidden')) toggleShop();
  }

  // 聊天
  function openChat() {
    $('chatInputRow').classList.remove('hidden');
    $('chatInput').focus();
  }
  function sendChatNow() {
    const v = $('chatInput').value.trim();
    if (v) send({ type: 'chat', text: v });
    $('chatInput').value = '';
    $('chatInputRow').classList.add('hidden');
    $('chatInput').blur();
  }
  $('chatInput').addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.code === 'Enter') sendChatNow();
    else if (e.code === 'Escape') { $('chatInputRow').classList.add('hidden'); $('chatInput').blur(); }
  });
  $('chatSendBtn').onclick = () => sendChatNow();
  // 移动端虚拟键盘会挡住底部聊天框，聚焦时临时上移（粗略估计键盘高度，非精确 visualViewport 适配）
  $('chatInput').addEventListener('focus', () => { if (TOUCH) document.body.classList.add('chat-focus'); });
  $('chatInput').addEventListener('blur', () => document.body.classList.remove('chat-focus'));

  // 菜单按钮
  $('nameInput').value = myName;
  $('btnPlay').onclick = () => {
    G.audio.init();
    myName = $('nameInput').value.trim() || ('玩家' + Math.floor(Math.random() * 900 + 100));
    $('menuErr').textContent = '';
    send({ type: 'join', name: myName });
  };
  $('btnSpec').onclick = () => { G.audio.init(); send({ type: 'spectate' }); };
  $('btnDeathSpec').onclick = () => { send({ type: 'spectate' }); };
  $('btnSpecJoin').onclick = () => joinFromSpec();
  $('nameInput').addEventListener('keydown', e => { if (e.code === 'Enter') $('btnPlay').click(); e.stopPropagation(); });
  function joinFromSpec() {
    myName = myName || $('nameInput').value.trim() || ('玩家' + Math.floor(Math.random() * 900 + 100));
    send({ type: 'join', name: myName });
  }

  // ---------- 观战 ----------
  function specTargets() { return [...ents.values()].filter(e => e.cur && e.cur.al); }
  function cycleSpec(d) {
    const ts = specTargets();
    if (!ts.length) { specFollow = -1; updateSpecBar(); return; }
    if (specFollow === -1) specFollow = 0;
    else specFollow = (specFollow + d + ts.length) % ts.length;
    updateSpecBar();
  }
  function updateSpecBar() {
    const ts = specTargets();
    if (specFollow === -1 || !ts.length) {
      $('specMode').textContent = '自由视角';
      $('specTarget').textContent = ts.length ? '按 F 跟随玩家' : '暂无玩家在场';
    } else {
      const e = ts[Math.min(specFollow, ts.length - 1)];
      $('specMode').textContent = `跟随视角 · ${specView === 'tp' ? '第三人称' : '第一人称'}`;
      $('specTarget').innerHTML = `<span style="color:${e.color}">${esc(e.name)}</span> · ❤️${e.cur.hp}`;
    }
  }

  // ---------- 本地战斗 ----------
  function camDir() {
    return V3(0, 0, -1).applyEuler(new T.Euler(me.pitch, me.yaw, 0, 'YXZ'));
  }
  function eyePos() { return V3(me.pos.x, me.pos.y + defs.rules.eyeH, me.pos.z); }
  function effectiveView() { return me.zoom > 0.5 ? 'fp' : settings.view; }

  // 跨端公平性：触屏精度天然低于鼠标，给触屏客户端一点"子弹磁吸"辅助瞄准（bullet magnetism）。
  // 只在本地把发送给服务器的开火方向朝最近目标中心柔性纠偏（≤35%），桌面端(TOUCH=false)完全不生效，
  // 服务器侧判定逻辑没有任何变化——不是服务器给触屏玩家开后门，只是客户端替手指的抖动兜个底。
  const AIM_ASSIST_CONE = Math.cos(7 * Math.PI / 180), AIM_ASSIST_RANGE = 55, AIM_ASSIST_BLEND = 0.35;
  function applyAimAssist(dir, origin) {
    if (!TOUCH) return dir;
    let bestDot = AIM_ASSIST_CONE, bestDir = null;
    for (const e of ents.values()) {
      if (!e.cur || !e.cur.al || e.cur.bf.some(b => b[0] === 'invis')) continue;
      const to = V3(e.disp.x, e.disp.y + 1.1, e.disp.z).sub(origin);
      const dist = to.length();
      if (dist < 0.5 || dist > AIM_ASSIST_RANGE) continue;
      to.normalize();
      const dot = to.dot(dir);
      if (dot > bestDot) { bestDot = dot; bestDir = to; }
    }
    if (bossEnt && bossEnt.cur && defs.bosses && defs.bosses[bossEnt.tp]) {
      const yc = defs.bosses[bossEnt.tp].yc || 2;
      const to = V3(bossEnt.disp.x, yc, bossEnt.disp.z).sub(origin);
      const dist = to.length();
      if (dist >= 0.5 && dist <= AIM_ASSIST_RANGE) {
        to.normalize();
        const dot = to.dot(dir);
        if (dot > bestDot) { bestDot = dot; bestDir = to; }
      }
    }
    return bestDir ? dir.clone().lerp(bestDir, AIM_ASSIST_BLEND).normalize() : dir;
  }

  function localRayEnd(o, d, maxR) {
    let t = G.world.rayObstacles({ x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z }, maxR);
    for (const e of ents.values()) {
      if (!e.cur || !e.cur.al) continue;
      for (const [oy, r] of [[0.95, 0.55], [1.55, 0.34]]) {
        const c = V3(e.disp.x, e.disp.y + oy, e.disp.z);
        const oc = o.clone().sub(c);
        const b = oc.dot(d);
        const disc = b * b - (oc.lengthSq() - r * r);
        if (disc > 0) { const tt = -b - Math.sqrt(disc); if (tt > 0 && tt < t) t = tt; }
      }
    }
    if (bossEnt && defs.bosses && defs.bosses[bossEnt.tp]) {
      const bi = defs.bosses[bossEnt.tp];
      const c = V3(bossEnt.disp.x, bi.yc, bossEnt.disp.z);
      const oc = o.clone().sub(c);
      const b = oc.dot(d);
      const disc = b * b - (oc.lengthSq() - bi.radius * bi.radius);
      if (disc > 0) { const tt = -b - Math.sqrt(disc); if (tt > 0 && tt < t) t = tt; }
    }
    return o.clone().addScaledVector(d, t);
  }

  function combat(dt) {
    if (!mySnap || !mySnap.al || isTyping()) return;
    if (!$('shop').classList.contains('hidden') || !$('pause').classList.contains('hidden')) return;
    const t = now();
    const zomb = mySnap.bf.some(b => b[0] === 'zombie');
    const wantZoom = rmbDown && me.active === 'gun' && mySnap.gw === 'sniper';
    me.zoom += ((wantZoom ? 1 : 0) - me.zoom) * Math.min(1, dt * 10);
    if (!mouseDown) { me.firedOnce = false; return; }
    if (me.active === 'melee') {
      const w = mySnap.mw;
      const cd = defs.weapons[w].cd * (zomb ? 0.6 : 1) * 1000;
      if (t - me.lastMelee >= cd) {
        me.lastMelee = t;
        const d = camDir();
        send({ type: 'melee', d: [d.x, d.y, d.z] });
        G.audio.melee(w);
        vmSwingT = 0;
        if (myModel) myModel.attackT = 0;
      }
    } else if (me.active === 'gun' && mySnap.gw) {
      const def = defs.weapons[mySnap.gw];
      if (!def.auto && me.firedOnce) return;
      if (me.reloadUntil > t) return;
      if (me.ammoL <= 0) { if (!me.firedOnce) { G.audio.dryFire(); tryLocalReload(); me.firedOnce = true; } return; }
      if (t - me.lastShot < def.cd * 1000) return;
      me.lastShot = t; me.firedOnce = true;
      me.ammoL--;
      const spread = me.zoom > 0.5 ? 0 : def.spread * (me.moving ? 1.6 : 1);
      const o = eyePos();
      let d = camDir();
      d.x += (Math.random() - 0.5) * spread * 2;
      d.y += (Math.random() - 0.5) * spread * 2;
      d.z += (Math.random() - 0.5) * spread * 2;
      d.normalize();
      d = applyAimAssist(d, o);
      send({ type: 'fire', o: [o.x, o.y, o.z], d: [d.x, d.y, d.z] });
      G.audio.shot(mySnap.gw);
      const end = localRayEnd(o, d, def.range);
      const mp = o.clone().addScaledVector(d, 0.9).addScaledVector(V3(Math.cos(me.yaw), 0, -Math.sin(me.yaw)), 0.14);
      mp.y -= 0.1;
      G.fx.tracer([mp.x, mp.y, mp.z], [end.x, end.y, end.z], '#ffe0a0');
      G.fx.muzzle(mp);
      // 枪口青烟
      G.fx.dustPuff([mp.x, mp.y, mp.z], 0.5, '#9aa4b0');
      vmKick = Math.min(1, vmKick + (mySnap.gw === 'sniper' ? 1 : 0.4));
      me.pitch += mySnap.gw === 'sniper' ? 0.02 : mySnap.gw === 'mg' ? 0.004 : 0.009;
      me.spread = Math.min(14, me.spread + 5);
      if (myModel) myModel.attackT = 0;
      if (me.ammoL <= 0) { tryLocalReload(); }
    } else if (me.active === 'nade' && mySnap.hn) {
      if (t - me.lastNade >= 3500) {
        me.lastNade = t;
        const d = camDir();
        send({ type: 'nade', d: [d.x, d.y, d.z] });
        G.audio.throwNade();
        vmThrowT = 0;
        if (myModel) myModel.attackT = 0;
      }
    }
  }

  // 移动输入轴：触屏摇杆优先（模拟量，支持半推半速），否则退回键盘（数字量，斜向已归一化不吃加速）
  // 桌面端行为与改造前逐字节一致：mag 恒为 1，方向归一化——这里只是把同一段逻辑抽成两端共用的函数
  function moveAxes() {
    if (touch.joyId !== null) {
      const L = Math.hypot(touch.joyX, touch.joyZ);
      return L > 1e-4 ? { ix: touch.joyX / L, iz: touch.joyZ / L, mag: Math.min(1, L) } : { ix: 0, iz: 0, mag: 0 };
    }
    let ix = 0, iz = 0;
    if (keys.KeyW) iz += 1; if (keys.KeyS) iz -= 1;
    if (keys.KeyA) ix -= 1; if (keys.KeyD) ix += 1;
    const L = Math.hypot(ix, iz);
    return L > 0 ? { ix: ix / L, iz: iz / L, mag: 1 } : { ix: 0, iz: 0, mag: 0 };
  }

  // ---------- 本地移动 ----------
  function movement(dt) {
    if (!mySnap || !mySnap.al) return;
    if (!$('pause').classList.contains('hidden')) { me.moving = false; return; }
    const zomb = mySnap.bf.some(b => b[0] === 'zombie');
    const hasSpeed = mySnap.bf.some(b => b[0] === 'speed');
    const hasJump = mySnap.bf.some(b => b[0] === 'jump');
    let spd = defs.rules.baseSpeed * (1 + 0.1 * mySnap.bo) * (hasSpeed ? 1.6 : 1) * (zomb ? 1.35 : 1) * (me.zoom > 0.5 ? 0.55 : 1);
    const { ix, iz, mag } = moveAxes();
    me.moving = mag > 0.05;
    if (me.moving) {
      const fx = -Math.sin(me.yaw), fz = -Math.cos(me.yaw);
      const rx = Math.cos(me.yaw), rz = -Math.sin(me.yaw);
      const dx = (fx * iz + rx * ix) * spd * mag * dt;
      const dz = (fz * iz + rz * ix) * spd * mag * dt;
      G.world.moveStep(me.pos, dx, dz);
    }
    const floor = G.world.floorAt(me.pos);
    if (keys.Space && me.grounded) {
      me.vy = defs.rules.jumpVel * (hasJump ? 1.5 : 1);
      me.grounded = false;
    }
    me.vy -= defs.rules.gravity * dt;
    me.pos.y += me.vy * dt;
    if (me.pos.y <= floor) {
      // 落地反馈
      if (!me.grounded && me.fallV < -9) {
        G.audio.land();
        G.fx.dustPuff([me.pos.x, floor + 0.1, me.pos.z], 1.4, '#8a8f9a');
        vmKick = Math.min(1, vmKick + 0.5);
        G.fx.shake(0.12);
      }
      me.pos.y = floor; me.vy = 0; me.grounded = true;
    }
    else me.grounded = false;
    me.fallV = me.vy;
    if (me.moving && me.grounded) {
      me.stepT += dt;
      if (me.stepT > (hasSpeed || zomb ? 0.24 : 0.34)) {
        me.stepT = 0;
        G.audio.step();
        G.fx.dustPuff([me.pos.x, me.pos.y + 0.06, me.pos.z], 0.5, '#77808f');
      }
    }
    // 自动拾取
    const t = now();
    for (let i = 0; i < pickupMeshes.length; i++) {
      const pm = pickupMeshes[i];
      if (!pm.item || t - pm.lastTry < 500) continue;
      if (Math.hypot(pm.pt.x - me.pos.x, pm.pt.z - me.pos.z) < 2.3 && Math.abs(me.pos.y - (pm.pt.y || 0)) < 2) {
        pm.lastTry = t;
        send({ type: 'pickup', id: i });
      }
    }
    const md = Math.hypot(me.pos.x - defs.map.merchant.x, me.pos.z - defs.map.merchant.z);
    $('interactHint').classList.toggle('hidden', !(md < defs.rules.merchantDist && $('shop').classList.contains('hidden')));
  }

  let moveSendT = 0;
  function netSync(dt) {
    moveSendT += dt;
    if (mode === 'play' && mySnap && mySnap.al && moveSendT > 0.066) {
      moveSendT = 0;
      send({ type: 'move', p: [me.pos.x, me.pos.y, me.pos.z], ya: me.yaw, pi: me.pitch, an: me.moving ? 1 : 0 });
    }
    if (now() - lastPingAt > 2000 && wsOk) {
      lastPingAt = now();
      send({ type: 'ping', t: lastPingAt });
    }
  }

  // ---------- 远程实体渲染 ----------
  function renderEnts(dt) {
    const k = 1 - Math.exp(-dt * 14);
    for (const e of ents.values()) {
      const s = e.cur;
      if (!s) continue;
      e.disp.x += (s.p[0] - e.disp.x) * k;
      e.disp.y += (s.p[1] - e.disp.y) * k;
      e.disp.z += (s.p[2] - e.disp.z) * k;
      let dy = s.ya - e.disp.ya;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      e.disp.ya += dy * k;
      const m = e.model;
      m.group.position.set(e.disp.x, e.disp.y, e.disp.z);
      m.group.rotation.y = e.disp.ya;
      m.group.visible = !!s.al;
      if (!s.al) continue;
      const zomb = s.bf.some(b => b[0] === 'zombie');
      G.models.tintZombie(m, zomb);
      const heldWeapon = zomb ? null : (s.ac === 'gun' ? s.gw : s.ac === 'nade' ? 'nade' : s.mw);
      G.models.setPlayerWeapon(m, heldWeapon);
      G.models.animatePlayer(m, dt, !!s.an, s.ac, 1);
      G.models.applyCosmetics(m, s.eq);
      G.models.applyWeaponFx(m, s.eq.fx || null, perfNow / 1000);
      const invis = s.bf.some(b => b[0] === 'invis');
      G.models.setOpacity(m, invis ? 0.12 : 1);
      if (s.pr) m.group.rotation.y += Math.sin(perfNow / 90) * 0.02;
      if (e.lastHp !== s.hp) { e.lastHp = s.hp; m.plate.userData.set(s.hp, 100); }
      m.plate.visible = !invis;
    }
    // BOSS
    if (bossEnt && bossEnt.cur) {
      const b = bossEnt.cur;
      bossEnt.disp.x += (b.p[0] - bossEnt.disp.x) * k;
      bossEnt.disp.z += (b.p[2] - bossEnt.disp.z) * k;
      let dy = b.ya - bossEnt.disp.ya;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      bossEnt.disp.ya += dy * k;
      const moving = Math.hypot(b.p[0] - bossEnt.disp.x, b.p[2] - bossEnt.disp.z) > 0.12;
      bossEnt.model.group.position.set(bossEnt.disp.x, 0, bossEnt.disp.z);
      bossEnt.model.group.rotation.y = bossEnt.disp.ya;
      bossEnt.model.update(dt, moving);
      bossEnt.model.plate.userData.set(b.hp, b.mx);
    }
    // 拾取物漂浮 + 光环脉动
    for (const pm of pickupMeshes) {
      if (!pm.mesh) continue;
      pm.mesh.rotation.y += dt * 1.2;
      pm.mesh.position.y = (pm.pt.y || 0) + Math.sin(perfNow / 600 + pm.pt.id) * 0.12;
      const ring = pm.mesh.children[pm.mesh.children.length - 1];
      if (ring) ring.scale.setScalar(1 + Math.sin(perfNow / 300 + pm.pt.id) * 0.1);
    }
    if (merchant) merchant.userData.gem.rotation.y += dt * 2;
  }

  // 第三人称下渲染自己的角色
  function renderSelf(dt) {
    const show = mode === 'play' && mySnap && mySnap.al && effectiveView() === 'tp';
    if (!show) { if (myModel) myModel.group.visible = false; return; }
    if (!myModel) {
      myModel = G.models.makePlayer(mySnap.c, myName);
      myModel.plate.visible = false;
      scene.add(myModel.group);
    }
    myModel.group.visible = true;
    myModel.group.position.copy(me.pos);
    myModel.group.rotation.y = me.yaw;
    const zomb = mySnap.bf.some(b => b[0] === 'zombie');
    G.models.tintZombie(myModel, zomb);
    const held = zomb ? null : (me.active === 'gun' ? mySnap.gw : me.active === 'nade' ? 'nade' : mySnap.mw);
    G.models.setPlayerWeapon(myModel, held);
    G.models.animatePlayer(myModel, dt, me.moving, me.active, 1);
    G.models.applyCosmetics(myModel, mySnap.eq);
    G.models.applyWeaponFx(myModel, mySnap.eq.fx || null, perfNow / 1000);
    const invis = mySnap.bf.some(b => b[0] === 'invis');
    G.models.setOpacity(myModel, invis ? 0.35 : 1);
    myModel.plate.visible = false;
  }

  // ---------- 视角模型动画 ----------
  function renderViewModel(dt) {
    if (!vm) return;
    const inPlay = mode === 'play' && mySnap && mySnap.al;
    vm.group.visible = inPlay && me.zoom < 0.5 && effectiveView() === 'fp';
    if (!inPlay) return;
    const zomb = mySnap.bf.some(b => b[0] === 'zombie');
    const held = me.active === 'gun' ? mySnap.gw : me.active === 'nade' ? 'nade' : mySnap.mw;
    G.models.setViewWeapon(vm, held, zomb && me.active === 'melee');
    G.models.applyWeaponFx({ weaponMesh: vm.weaponMesh }, mySnap.eq.fx || null, perfNow / 1000);
    vmSwingT += dt; vmThrowT += dt;
    vmKick = Math.max(0, vmKick - dt * 6);
    me.swayX *= Math.exp(-dt * 8);
    me.swayY *= Math.exp(-dt * 8);
    const bob = me.moving && me.grounded ? Math.sin(perfNow / 90) * 0.014 : Math.sin(perfNow / 700) * 0.004;
    vm.group.position.set(0.02 - me.swayX * 0.4, -0.02 + bob - me.swayY * 0.3, vmKick * 0.06);
    vm.group.rotation.set(vmKick * 0.12 - me.swayY * 0.6, -me.swayX * 0.8, 0);
    if (vmSwingT < 0.28) {
      const kk = vmSwingT / 0.28;
      vm.armR.rotation.x = -1.6 * Math.sin(kk * Math.PI);
      vm.armR.rotation.z = -0.5 * Math.sin(kk * Math.PI);
    } else if (vmThrowT < 0.3) {
      const kk = vmThrowT / 0.3;
      vm.armR.rotation.x = -1.2 * Math.sin(kk * Math.PI);
      vm.armR.rotation.z = 0;
    } else {
      vm.armR.rotation.x = 0; vm.armR.rotation.z = 0;
    }
    if (me.reloadUntil > now() && vm.weaponMesh) {
      const rem = (me.reloadUntil - now()) / me.reloadDur;
      vm.weaponMesh.rotation.x = Math.sin(rem * Math.PI) * 0.9;
    } else if (vm.weaponMesh) vm.weaponMesh.rotation.x = 0;
  }

  // ---------- HUD 每帧 ----------
  function hudFrame() {
    if (TOUCH) $('tScope').classList.toggle('hidden', !(mode === 'play' && mySnap && mySnap.al && mySnap.gw === 'sniper' && me.active === 'gun'));
    if (mode !== 'play' || !mySnap) return;
    me.spread = Math.max(0, me.spread - 0.6);
    const sp = me.spread + (me.moving ? 4 : 0);
    $('crosshair').style.setProperty('--sp', sp + 'px');
    $('crosshair').style.display = (mySnap.al && me.zoom < 0.5 && $('shop').classList.contains('hidden')) ? '' : 'none';
    $('scope').classList.toggle('hidden', me.zoom < 0.5);
    const rl = me.reloadUntil - now();
    const rb = $('reloadBar');
    if (rl > 0 && mySnap.gw) {
      rb.classList.remove('hidden');
      $('reloadFill').style.width = (100 - rl / me.reloadDur * 100) + '%';
    } else rb.classList.add('hidden');
    if (!mySnap.al) {
      $('deathCount').textContent = mySnap.dd > 0 ? `${(mySnap.dd / 1000).toFixed(1)}s 后重生` : '即将重生…';
    }
    if (me.active === 'nade') updateHud();
    // 低血量心跳
    if (mySnap.al && mySnap.hp <= 25 && perfNow - lastBeatAt > 950) {
      lastBeatAt = perfNow;
      G.audio.heartbeat();
    }
  }

  // ---------- 相机 ----------
  const TP_DIST = 3.4;
  function updateCamera(dt) {
    const hasSpeed = mode === 'play' && mySnap && mySnap.bf.some(b => b[0] === 'speed');
    const targetFov = BASE_FOV - me.zoom * 51 + (hasSpeed && me.moving ? 6 : 0);
    if (Math.abs(camera.fov - targetFov) > 0.1) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 12);
      camera.updateProjectionMatrix();
    }
    if (mode === 'play' && mySnap) {
      if (mySnap.al) {
        if (effectiveView() === 'tp') {
          // 第三人称：肩后视角 + 遮挡收缩
          const eye = eyePos();
          const vd = camDir();
          const right = V3(Math.cos(me.yaw), 0, -Math.sin(me.yaw));
          const desired = eye.clone().addScaledVector(vd, -TP_DIST).addScaledVector(right, 0.55).add(V3(0, 0.3, 0));
          const dir = desired.clone().sub(eye);
          const len = dir.length() || 1;
          dir.normalize();
          const t = G.world.rayObstacles({ x: eye.x, y: eye.y, z: eye.z }, { x: dir.x, y: dir.y, z: dir.z }, len + 0.3);
          const d = Math.max(0.6, Math.min(len, t - 0.25));
          camera.position.copy(eye).addScaledVector(dir, d);
          if (camera.position.y < 0.3) camera.position.y = 0.3;
          camera.rotation.set(me.pitch, me.yaw, 0);
        } else {
          camera.position.set(me.pos.x, me.pos.y + defs.rules.eyeH, me.pos.z);
          camera.rotation.set(me.pitch, me.yaw, 0);
        }
      } else {
        const dp = V3(me.pos.x, me.pos.y + 7, me.pos.z + 5);
        camera.position.lerp(dp, Math.min(1, dt * 3));
        camera.lookAt(me.pos.x, 0.5, me.pos.z);
      }
    } else if (mode === 'spec') {
      const ts = specTargets();
      if (specFollow >= 0 && ts.length) {
        const e = ts[Math.min(specFollow, ts.length - 1)];
        const eye = V3(e.disp.x, e.disp.y + 1.62, e.disp.z);
        const q = new T.Quaternion().setFromEuler(new T.Euler(e.cur.pi, e.disp.ya, 0, 'YXZ'));
        if (specView === 'tp') {
          const vd = V3(0, 0, -1).applyQuaternion(q);
          const desired = eye.clone().addScaledVector(vd, -3.8).add(V3(0, 0.5, 0));
          const dir = desired.clone().sub(eye);
          const len = dir.length() || 1;
          dir.normalize();
          const t = G.world.rayObstacles({ x: eye.x, y: eye.y, z: eye.z }, { x: dir.x, y: dir.y, z: dir.z }, len + 0.3);
          const d = Math.max(0.8, Math.min(len, t - 0.25));
          const camPos = eye.clone().addScaledVector(dir, d);
          if (camPos.y < 0.3) camPos.y = 0.3;
          camera.position.lerp(camPos, Math.min(1, dt * 10));
        } else {
          camera.position.lerp(eye, Math.min(1, dt * 10));
        }
        camera.quaternion.slerp(q, Math.min(1, dt * 8));
        if (Math.floor(perfNow / 500) !== Math.floor((perfNow - dt * 1000) / 500)) updateSpecBar();
      } else {
        let spd = 14 * specSpeed * (keys.ShiftLeft ? 2.2 : 1);
        const d = camDir();
        const rx = Math.cos(me.yaw), rz = -Math.sin(me.yaw);
        const { ix, iz, mag } = moveAxes();
        if (mag > 0.05) {
          specFree.pos.addScaledVector(d, iz * spd * mag * dt);
          specFree.pos.x += rx * ix * spd * mag * dt;
          specFree.pos.z += rz * ix * spd * mag * dt;
        }
        if (keys.Space) specFree.pos.y += spd * dt;
        if (keys.KeyC) specFree.pos.y -= spd * dt;
        specFree.pos.y = Math.max(0.5, Math.min(60, specFree.pos.y));
        camera.position.copy(specFree.pos);
        camera.rotation.set(me.pitch, me.yaw, 0);
      }
    } else if (mode === 'menu' && worldBuilt) {
      const a = perfNow / 9000;
      camera.position.set(Math.cos(a) * 38, 16, Math.sin(a) * 38);
      camera.lookAt(0, 1, 0);
    }
    const sh = G.fx.getShake();
    if (sh) { camera.position.x += sh.x; camera.position.y += sh.y; camera.position.z += sh.z; }
  }

  // ---------- 主循环（后台标签页降级为 10Hz 定时器，防止逻辑停摆） ----------
  let perfNow = performance.now(), lastFrame = performance.now();
  let fpsCnt = 0, fpsAt = performance.now();
  let lowFpsStreak = 0;
  let loopGen = 0;
  function schedule() {
    // 世代令牌：可见性切换时旧的 rAF 回调可能永远挂起或迟到，令牌保证单链推进
    const gen = ++loopGen;
    if (document.hidden) setTimeout(() => { if (gen === loopGen) loop(); }, 100);
    else requestAnimationFrame(() => { if (gen === loopGen) loop(); });
  }
  // 看门狗：主循环停摆超过 600ms（如 rAF 在后台被冻结）就重新拉起
  setInterval(() => {
    if (performance.now() - lastFrame > 600) loop();
  }, 400);
  function loop() {
    schedule();
    perfNow = performance.now();
    if (canvas.width !== Math.floor(innerWidth * renderer.getPixelRatio()) && innerWidth > 0) {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    }
    const dt = Math.min(0.05, (perfNow - lastFrame) / 1000);
    lastFrame = perfNow;
    if (!worldBuilt) return;
    if (mode === 'play') {
      movement(dt);
      combat(dt);
    }
    netSync(dt);
    // 昼夜推进（服务器同步 + 本地插值）
    const dayT = (dayBase + (perfNow - dayAt) / dayMs) % 1;
    G.world.setDay(dayT, scene);
    G.world.updateAmbient(dt);
    renderMovingProjectiles(dt);
    renderEnts(dt);
    renderSelf(dt);
    renderViewModel(dt);
    renderShopPre(dt);
    hudFrame();
    updateCamera(dt);
    G.fx.update(dt);
    renderSceneFrame();
    fpsCnt++;
    if (perfNow - fpsAt > 1000) {
      $('fpsNum').textContent = fpsCnt + ' FPS';
      $('pingNum').textContent = pingMs + ' ms';
      const di = G.world.dayInfo();
      $('dayChip').textContent = `${di.icon} ${di.phase}`;
      // 运行时画质自动降级：持续低帧率就砍掉阴影这类纯观感开销（绝不动视距/雾距，公平性红线）
      if (TOUCH && fpsCnt < 40 && renderer.shadowMap.enabled) {
        if (++lowFpsStreak >= 4) {
          renderer.shadowMap.enabled = false;
          renderer.setPixelRatio(Math.min(1, renderer.getPixelRatio()));
          lowFpsStreak = 0;
        }
      } else lowFpsStreak = 0;
      fpsCnt = 0; fpsAt = perfNow;
    }
  }

  // ---------- 启动 ----------
  function renderSceneFrame() {
    const oldMask = camera.layers.mask;
    camera.layers.set(0);
    renderer.autoClear = true;
    renderer.render(scene, camera);
    if (vm && vm.group.visible) {
      const bg = scene.background;
      scene.background = null;
      renderer.autoClear = false;
      renderer.clearDepth();
      camera.layers.set(VIEW_LAYER);
      renderer.render(scene, camera);
      scene.background = bg;
    }
    renderer.autoClear = true;
    camera.layers.mask = oldMask;
  }

  window.__na = {
    renderer, scene, camera, TOUCH, quality,
    ui: { toggleShop, openPause, toggleView, get shopPre() { return shopPre; } },
    touch, applyLook, moveAxes,
  };   // 调试句柄（截帧/诊断用）
  refreshOpts();
  connect();
  loop();
  if (qs.get('name')) $('nameInput').value = qs.get('name');
  if (qs.get('auto') === '1') {
    const tryJoin = setInterval(() => {
      if (wsOk && defs) { clearInterval(tryJoin); $('btnPlay').click(); }
    }, 300);
  }
})();

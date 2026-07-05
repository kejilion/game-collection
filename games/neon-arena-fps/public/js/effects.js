// 特效系统：粒子 / 曳光弹 / 爆炸 / 伤害飘字 / 镜头震动（全部对象池）
window.G = window.G || {};
G.fx = (function () {
  const T = THREE;
  let scene = null;
  const V = (x, y, z) => new T.Vector3(x, y, z);

  // ---------- 共享贴图 ----------
  function radialTex(inner, outer) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 2, 32, 32, 32);
    g.addColorStop(0, inner); g.addColorStop(1, outer);
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    return new T.CanvasTexture(c);
  }
  let sparkTex, smokeTex;

  // ---------- 粒子池（Sprite） ----------
  const P_MAX = 160;
  const parts = [];
  function spawnP(pos, vel, color, size, life, opts) {
    let p = parts.find(q => !q.alive);
    if (!p) return;
    p.alive = true; p.t = 0; p.life = life;
    p.spr.visible = true;
    p.spr.position.copy(pos);
    p.vel.copy(vel);
    p.grav = (opts && opts.grav) !== undefined ? opts.grav : 9;
    p.drag = (opts && opts.drag) || 0.98;
    p.size0 = size;
    p.grow = (opts && opts.grow) || 0;
    p.spr.material.map = (opts && opts.smoke) ? smokeTex : sparkTex;
    p.spr.material.color.set(color);
    p.spr.material.blending = (opts && opts.smoke) ? T.NormalBlending : T.AdditiveBlending;
    p.spr.material.opacity = 1;
    p.spr.scale.setScalar(size);
  }
  function burst(pos, n, color, speed, size, life, opts) {
    for (let i = 0; i < n; i++) {
      const v = V(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize()
        .multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      spawnP(pos, v, color, size * (0.6 + Math.random() * 0.7), life * (0.6 + Math.random() * 0.8), opts);
    }
  }

  // ---------- 曳光弹池 ----------
  const TR_MAX = 30;
  const tracers = [];
  function tracer(o, e, color) {
    let tr = tracers.find(q => !q.alive);
    if (!tr) return;
    tr.alive = true; tr.t = 0;
    const a = V(o[0], o[1], o[2]), b = V(e[0], e[1], e[2]);
    const len = a.distanceTo(b);
    if (len < 0.1) return;
    tr.mesh.visible = true;
    tr.mesh.material.color.set(color || '#ffd98a');
    tr.mesh.material.opacity = 0.9;
    tr.mesh.scale.set(1, len, 1);
    tr.mesh.position.copy(a).add(b).multiplyScalar(0.5);
    tr.mesh.quaternion.setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize());
  }

  // ---------- 伤害飘字池 ----------
  const DT_MAX = 26;
  const dtexts = [];
  function damageText(pos, text, color, big) {
    let d = dtexts.find(q => !q.alive);
    if (!d) return;
    d.alive = true; d.t = 0;
    const ctx = d.ctx, c = d.canvas;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.font = `bold ${big ? 44 : 32}px "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 5;
    ctx.fillStyle = color;
    ctx.fillText(text, c.width / 2, c.height / 2);
    d.spr.material.map.needsUpdate = true;
    d.spr.visible = true;
    d.spr.position.set(pos[0] + (Math.random() - 0.5) * 0.6, pos[1] + 0.4, pos[2] + (Math.random() - 0.5) * 0.6);
    d.spr.material.opacity = 1;
    d.spr.scale.set(big ? 2 : 1.4, big ? 1 : 0.7, 1);
  }

  // ---------- 一次性膨胀体（爆炸球 / 冲击环 / 光柱） ----------
  const blobs = [];
  function spawnBlob(mesh, life, growTo, fade) {
    mesh.visible = true;
    blobs.push({ mesh, t: 0, life, s0: mesh.scale.x, growTo, fade });
    scene.add(mesh);
  }

  // 共享爆炸光源
  let boomLight = null, muzzleLight = null, muzzleFlash = null;
  let shakeAmt = 0;
  let muzzleFlashT = 999;
  const smokes = [];   // 长效烟雾云团（持续数秒，跟其他短命特效分开管理）

  // ---------- 镜头冲击力（弹簧阻尼，比纯随机抖动更有"扎实一顶"的手感） ----------
  const kickPos = new T.Vector3(), kickVel = new T.Vector3();
  const KICK_K = 90, KICK_D = 13;   // 刚度/阻尼：数值越大回弹越快越干脆
  function punch(dir, mag) {
    if (!dir || !mag) return;
    kickVel.x += dir.x * mag; kickVel.y += (dir.y || 0) * mag * 0.6; kickVel.z += dir.z * mag;
  }
  function getKick() {
    if (kickPos.lengthSq() < 0.00001 && kickVel.lengthSq() < 0.00001) return null;
    return kickPos;
  }

  function init(sc) {
    scene = sc;
    sparkTex = radialTex('rgba(255,255,255,1)', 'rgba(255,255,255,0)');
    smokeTex = radialTex('rgba(160,160,170,.7)', 'rgba(120,120,130,0)');
    for (let i = 0; i < P_MAX; i++) {
      const spr = new T.Sprite(new T.SpriteMaterial({ map: sparkTex, transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
      spr.visible = false; scene.add(spr);
      parts.push({ alive: false, spr, vel: V(0, 0, 0), t: 0, life: 1, grav: 9, drag: 0.98, size0: 1, grow: 0 });
    }
    const trGeo = new T.CylinderGeometry(0.02, 0.02, 1, 5, 1, true);
    for (let i = 0; i < TR_MAX; i++) {
      const mesh = new T.Mesh(trGeo, new T.MeshBasicMaterial({ color: 0xffd98a, transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false }));
      mesh.visible = false; scene.add(mesh);
      tracers.push({ alive: false, mesh, t: 0 });
    }
    for (let i = 0; i < DT_MAX; i++) {
      const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 64;
      const tex = new T.CanvasTexture(canvas);
      const spr = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
      spr.visible = false; scene.add(spr);
      dtexts.push({ alive: false, spr, canvas, ctx: canvas.getContext('2d'), t: 0 });
    }
    boomLight = new T.PointLight(0xffa040, 0, 26); scene.add(boomLight);
    muzzleLight = new T.PointLight(0xffd080, 0, 8); scene.add(muzzleLight);
    muzzleFlash = new T.Sprite(new T.SpriteMaterial({ map: sparkTex, color: 0xffe6a0, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending }));
    scene.add(muzzleFlash);
  }

  function muzzle(pos, color) {
    muzzleLight.position.copy(pos);
    muzzleLight.color.set(color || 0xffd080);
    muzzleLight.intensity = 2.6;
    muzzleFlash.position.copy(pos);
    muzzleFlash.material.color.set(color || 0xffe6a0);
    muzzleFlash.scale.setScalar(0.55);
    muzzleFlashT = 0;
    spawnP(pos, V(0, 0.2, 0), '#ffe8a0', 0.5, 0.07, { grav: 0 });
  }

  function impact(pos, color) {
    burst(V(pos[0], pos[1], pos[2]), 5, color || '#ffd98a', 3.5, 0.16, 0.3);
  }
  // 墙面/环境命中火花：没打中任何目标的子弹终点补一下，卖出"打在东西上了"的实感
  function impactSpark(pos, color) {
    burst(V(pos[0], pos[1], pos[2]), 8, color || '#ffe6a8', 4.2, 0.14, 0.32);
    burst(V(pos[0], pos[1], pos[2]), 4, '#999', 1.1, 0.2, 0.5, { smoke: true, grav: -0.4, grow: 1.3 });
  }
  // dir 给出的话血液会朝命中方向喷溅偏移，不给则退回原来的全向爆散
  function blood(pos, dir) {
    if (!dir) { burst(V(pos[0], pos[1], pos[2]), 7, '#e02020', 3, 0.2, 0.45, { grav: 12 }); return; }
    const base = V(pos[0], pos[1], pos[2]);
    for (let i = 0; i < 9; i++) {
      const v = V(dir.x + (Math.random() - 0.5) * 0.6, 0.35 + Math.random() * 0.5, dir.z + (Math.random() - 0.5) * 0.6)
        .normalize().multiplyScalar(2.6 + Math.random() * 2.2);
      spawnP(base, v, '#e02020', 0.15 + Math.random() * 0.12, 0.35 + Math.random() * 0.3, { grav: 12 });
    }
  }

  function explosion(pos, r, opts) {
    const p = V(pos[0], Math.max(0.3, pos[1]), pos[2]);
    const fire = opts && opts.fire, boss = opts && opts.boss, vp = opts && opts.vp;  // vp = 虚空紫
    const ball = new T.Mesh(new T.SphereGeometry(1, 14, 10),
      new T.MeshBasicMaterial({ color: vp ? 0xa66bff : fire ? 0xff7a30 : 0xffc860, transparent: true, opacity: 0.95, blending: T.AdditiveBlending, depthWrite: false }));
    ball.position.copy(p); ball.scale.setScalar(r * 0.25);
    spawnBlob(ball, 0.35, r * 0.85, true);
    const ring = new T.Mesh(new T.TorusGeometry(1, 0.06, 6, 28),
      new T.MeshBasicMaterial({ color: vp ? 0x8f5bff : boss ? 0xff5a3a : 0xffd080, transparent: true, opacity: 0.85, blending: T.AdditiveBlending, depthWrite: false }));
    ring.rotation.x = Math.PI / 2; ring.position.set(p.x, 0.15, p.z); ring.scale.setScalar(r * 0.2);
    spawnBlob(ring, 0.5, r * 1.3, true);
    burst(p, boss ? 26 : 16, vp ? '#b48aff' : fire ? '#ff8a40' : '#ffc060', r * 1.6, 0.35, 0.7);
    burst(p, 10, '#888', r * 0.7, 0.8, 1.4, { smoke: true, grav: -1.5, grow: 1.2 });
    boomLight.position.set(p.x, p.y + 1, p.z);
    boomLight.color.set(vp ? 0x9a6bff : 0xffa040);
    boomLight.intensity = boss ? 8 : 5;
    shakeAmt = Math.min(1.2, shakeAmt + (boss ? 0.9 : r > 4 ? 0.55 : 0.3));
  }

  // 巫妖虚空爆破预警圈：ms 毫秒后落地
  function telegraph(pos, r, ms) {
    const life = (ms || 1200) / 1000;
    const ring = new T.Mesh(new T.TorusGeometry(1, 0.09, 6, 32),
      new T.MeshBasicMaterial({ color: 0x9a5bff, transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false }));
    ring.rotation.x = Math.PI / 2; ring.position.set(pos[0], pos[1] + 0.08, pos[2]); ring.scale.setScalar(r * 0.3);
    spawnBlob(ring, life, r, false);
    const disc = new T.Mesh(new T.RingGeometry(0.2, 1, 24),
      new T.MeshBasicMaterial({ color: 0x6b3bd0, transparent: true, opacity: 0.35, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide }));
    disc.rotation.x = -Math.PI / 2; disc.position.set(pos[0], pos[1] + 0.06, pos[2]); disc.scale.setScalar(r * 0.3);
    spawnBlob(disc, life, r, false);
  }

  // 尘土/烟雾小团（脚步、落地、枪口青烟）
  function dustPuff(pos, size, color) {
    burst(V(pos[0], pos[1], pos[2]), Math.ceil(3 * (size || 1)), color || '#8a8f9a',
      0.8 * (size || 1), 0.18 * (size || 1), 0.5, { smoke: true, grav: -0.8, grow: 1.5 });
  }

  function slam(pos, r) {
    const ring = new T.Mesh(new T.TorusGeometry(1, 0.08, 6, 28),
      new T.MeshBasicMaterial({ color: 0xff8a50, transparent: true, opacity: 0.8, blending: T.AdditiveBlending, depthWrite: false }));
    ring.rotation.x = Math.PI / 2; ring.position.set(pos[0], 0.12, pos[2]); ring.scale.setScalar(0.5);
    spawnBlob(ring, 0.45, r, true);
    burst(V(pos[0], 0.3, pos[2]), 14, '#c9a06a', 4, 0.3, 0.6, { smoke: true, grav: 2 });
    shakeAmt = Math.min(1.2, shakeAmt + 0.4);
  }

  function die(pos, color) {
    burst(V(pos[0], pos[1], pos[2]), 20, color || '#ff6b6b', 5, 0.28, 0.8);
    burst(V(pos[0], pos[1], pos[2]), 8, '#fff', 3, 0.15, 0.4);
  }

  function respawnBeam(pos) {
    const beam = new T.Mesh(new T.CylinderGeometry(0.7, 0.7, 10, 12, 1, true),
      new T.MeshBasicMaterial({ color: 0x35e0ff, transparent: true, opacity: 0.5, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide }));
    beam.position.set(pos[0], 5, pos[2]);
    spawnBlob(beam, 0.7, 1.6, true);
    burst(V(pos[0], 1, pos[2]), 12, '#35e0ff', 3, 0.22, 0.6, { grav: -3 });
  }

  function sparkle(pos, color) {
    burst(V(pos[0], pos[1] + 0.8, pos[2]), 10, color || '#9ff3ff', 2.2, 0.2, 0.5, { grav: -2 });
  }

  // 闪光弹爆闪：全场可见的白光炸开，谁被晃到由服务器单独下发 'flashed' 消息驱动屏幕白屏（在 game.js 里处理）
  function flashPop(pos, r) {
    const p = V(pos[0], pos[1], pos[2]);
    const ball = new T.Mesh(new T.SphereGeometry(1, 14, 10),
      new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: T.AdditiveBlending, depthWrite: false }));
    ball.position.copy(p); ball.scale.setScalar(0.4);
    spawnBlob(ball, 0.3, r * 0.9, true);
    const ring = new T.Mesh(new T.TorusGeometry(1, 0.05, 6, 28),
      new T.MeshBasicMaterial({ color: 0xdfe9ff, transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false }));
    ring.rotation.x = Math.PI / 2; ring.position.set(p.x, 0.2, p.z); ring.scale.setScalar(r * 0.25);
    spawnBlob(ring, 0.4, r * 1.2, true);
    burst(p, 14, '#ffffff', r * 1.2, 0.3, 0.4);
    boomLight.position.set(p.x, p.y + 0.5, p.z);
    boomLight.color.set(0xffffff);
    boomLight.intensity = 7;
    shakeAmt = Math.min(1.2, shakeAmt + 0.25);
  }

  // 烟雾云团：几个漂移的柔和精灵拼出一坨遮挡视野的雾，淡入-维持-淡出，纯视觉不挡子弹判定
  function smokeCloud(pos, r, durMs) {
    const sprites = [];
    const n = Math.min(12, Math.round(5 + r * 0.5));   // 云团精灵数随半径增加，大烟不稀疏
    for (let i = 0; i < n; i++) {
      const spr = new T.Sprite(new T.SpriteMaterial({ map: smokeTex, color: 0xc6cbd2, transparent: true, opacity: 0, depthWrite: false }));
      const a = Math.random() * Math.PI * 2, rr = Math.random() * r * 0.45;
      spr.position.set(pos[0] + Math.cos(a) * rr, pos[1] + 0.4 + Math.random() * r * 0.4, pos[2] + Math.sin(a) * rr);
      spr.scale.setScalar(r * (0.85 + Math.random() * 0.5));
      spr.userData.drift = V((Math.random() - 0.5) * 0.12, 0.025 + Math.random() * 0.03, (Math.random() - 0.5) * 0.12);
      scene.add(spr);
      sprites.push(spr);
    }
    smokes.push({ sprites, t: 0, dur: Math.max(1, (durMs || 9000) / 1000) });
  }

  function roarWave(pos) {
    const ring = new T.Mesh(new T.TorusGeometry(1, 0.12, 6, 32),
      new T.MeshBasicMaterial({ color: 0xff4020, transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false }));
    ring.rotation.x = Math.PI / 2; ring.position.set(pos[0], 0.4, pos[2]); ring.scale.setScalar(1);
    spawnBlob(ring, 1.1, 22, true);
    shakeAmt = Math.min(1.2, shakeAmt + 0.5);
  }

  function update(dt) {
    for (const p of parts) {
      if (!p.alive) continue;
      p.t += dt;
      if (p.t >= p.life) { p.alive = false; p.spr.visible = false; continue; }
      p.vel.y -= p.grav * dt;
      p.vel.multiplyScalar(Math.pow(p.drag, dt * 60));
      p.spr.position.addScaledVector(p.vel, dt);
      const k = 1 - p.t / p.life;
      p.spr.material.opacity = k;
      p.spr.scale.setScalar(p.size0 * (1 + p.grow * (1 - k)));
    }
    for (const tr of tracers) {
      if (!tr.alive) continue;
      tr.t += dt;
      if (tr.t > 0.09) { tr.alive = false; tr.mesh.visible = false; continue; }
      tr.mesh.material.opacity = 0.9 * (1 - tr.t / 0.09);
    }
    for (const d of dtexts) {
      if (!d.alive) continue;
      d.t += dt;
      if (d.t > 0.9) { d.alive = false; d.spr.visible = false; continue; }
      d.spr.position.y += dt * 1.4;
      d.spr.material.opacity = 1 - Math.pow(d.t / 0.9, 2);
    }
    for (let i = blobs.length - 1; i >= 0; i--) {
      const b = blobs[i];
      b.t += dt;
      const k = b.t / b.life;
      if (k >= 1) { scene.remove(b.mesh); b.mesh.geometry.dispose ? 0 : 0; blobs.splice(i, 1); continue; }
      const s = b.s0 + (b.growTo - b.s0) * (1 - Math.pow(1 - k, 2));
      b.mesh.scale.setScalar(s);
      if (b.fade) b.mesh.material.opacity = (1 - k) * 0.9;
    }
    boomLight.intensity = Math.max(0, boomLight.intensity - dt * 22);
    muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 30);
    shakeAmt = Math.max(0, shakeAmt - dt * 2.6);

    muzzleFlashT += dt;
    if (muzzleFlashT < 0.055) {
      const k = muzzleFlashT / 0.055;
      muzzleFlash.material.opacity = 1 - k;
      muzzleFlash.scale.setScalar(0.55 + k * 0.5);
    } else muzzleFlash.material.opacity = 0;

    // 镜头冲击力弹簧：kickVel/kickPos 是隐式欧拉积分的阻尼弹簧，dt 很小所以稳定
    const ax = -KICK_K * kickPos.x - KICK_D * kickVel.x;
    const ay = -KICK_K * kickPos.y - KICK_D * kickVel.y;
    const az = -KICK_K * kickPos.z - KICK_D * kickVel.z;
    kickVel.x += ax * dt; kickVel.y += ay * dt; kickVel.z += az * dt;
    kickPos.x += kickVel.x * dt; kickPos.y += kickVel.y * dt; kickPos.z += kickVel.z * dt;

    for (let i = smokes.length - 1; i >= 0; i--) {
      const s = smokes[i];
      s.t += dt;
      const fadeIn = 0.6, fadeOut = 1.6;
      let op;
      if (s.t < fadeIn) op = (s.t / fadeIn) * 0.55;
      else if (s.t > s.dur - fadeOut) op = Math.max(0, (s.dur - s.t) / fadeOut) * 0.55;
      else op = 0.55;
      for (const spr of s.sprites) { spr.position.addScaledVector(spr.userData.drift, dt); spr.material.opacity = op; }
      if (s.t >= s.dur) { for (const spr of s.sprites) scene.remove(spr); smokes.splice(i, 1); }
    }
  }

  function getShake() {
    if (shakeAmt <= 0.001) return null;
    const a = shakeAmt * 0.06;
    return { x: (Math.random() - 0.5) * a, y: (Math.random() - 0.5) * a, z: (Math.random() - 0.5) * a * 0.5 };
  }

  return {
    init, update, tracer, muzzle, impact, impactSpark, blood, explosion, telegraph, dustPuff, slam, die, respawnBeam, sparkle, roarWave, damageText,
    flashPop, smokeCloud,
    getShake, shake: a => { shakeAmt = Math.min(1.2, shakeAmt + a); },
    punch, getKick,
  };
})();

// 程序化模型工厂：玩家 / BOSS / 商人 / 武器 / 拾取物 / 外观装饰（全部几何体拼装，无外部资源）
window.G = window.G || {};
G.models = (function () {
  const T = THREE;

  function std(color, opt) {
    return new T.MeshStandardMaterial(Object.assign({ color, roughness: 0.75, metalness: 0.15 }, opt || {}));
  }
  function box(w, h, d, mat) { const m = new T.Mesh(new T.BoxGeometry(w, h, d), mat); m.castShadow = true; return m; }
  function cyl(rt, rb, h, mat, seg) { const m = new T.Mesh(new T.CylinderGeometry(rt, rb, h, seg || 12), mat); m.castShadow = true; return m; }
  function cylZ(rt, rb, h, mat, seg, openEnded) {
    const m = new T.Mesh(new T.CylinderGeometry(rt, rb, h, seg || 12, 1, !!openEnded), mat);
    m.rotation.x = Math.PI / 2;
    m.castShadow = true;
    return m;
  }
  function muzzleRing(r, mat) {
    const m = new T.Mesh(new T.TorusGeometry(r, r * 0.18, 8, 18), mat);
    m.castShadow = true;
    return m;
  }
  function sph(r, mat, seg) { const m = new T.Mesh(new T.SphereGeometry(r, seg || 12, seg || 10), mat); m.castShadow = true; return m; }
  function cone(r, h, mat, seg) { const m = new T.Mesh(new T.ConeGeometry(r, h, seg || 10), mat); m.castShadow = true; return m; }

  // ---------- 脸部纹理（共享） ----------
  let faceTex = null;
  function getFaceTex() {
    if (faceTex) return faceTex;
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    x.fillStyle = '#e8b98a'; x.fillRect(0, 0, 64, 64);
    x.fillStyle = '#222'; x.fillRect(14, 24, 10, 12); x.fillRect(40, 24, 10, 12);   // 眼睛
    x.fillStyle = '#fff'; x.fillRect(16, 26, 4, 4); x.fillRect(42, 26, 4, 4);
    x.fillStyle = '#b3805a'; x.fillRect(24, 44, 16, 4);                              // 嘴
    faceTex = new T.CanvasTexture(c);
    return faceTex;
  }

  // ---------- 文字精灵 ----------
  function textSprite(w, h, draw) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    draw(ctx, c);
    const tex = new T.CanvasTexture(c);
    const spr = new T.Sprite(new T.SpriteMaterial({ map: tex, depthWrite: false }));
    spr.userData.canvas = c; spr.userData.ctx = ctx; spr.userData.tex = tex;
    return spr;
  }
  function drawNameplate(ctx, c, name, color, hp, maxHp) {
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.font = 'bold 26px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 6;
    ctx.fillStyle = color; ctx.fillText(name, c.width / 2, 20);
    ctx.shadowBlur = 0;
    const bw = 150, bx = (c.width - bw) / 2, by = 40;
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(bx - 1, by - 1, bw + 2, 10);
    const r = Math.max(0, hp / maxHp);
    ctx.fillStyle = r > 0.4 ? '#4dff88' : '#ff5544';
    ctx.fillRect(bx, by, bw * r, 8);
  }
  function makeNameplate(name, color) {
    const spr = textSprite(256, 64, (ctx, c) => drawNameplate(ctx, c, name, color, 100, 100));
    spr.scale.set(2.2, 0.55, 1);
    spr.userData.set = (hp, maxHp) => {
      drawNameplate(spr.userData.ctx, spr.userData.canvas, name, color, hp, maxHp);
      spr.userData.tex.needsUpdate = true;
    };
    return spr;
  }

  // ---------- 玩家 ----------
  function makePlayer(color, name) {
    const g = new T.Group();
    const mats = [];
    const track = m => { mats.push(m); return m; };
    const cBody = track(std(color));
    const cDark = track(std(new T.Color(color).multiplyScalar(0.55).getHex()));
    const cSkin = track(std('#e8b98a'));

    const legL = box(0.22, 0.7, 0.24, cDark); legL.geometry.translate(0, -0.35, 0); legL.position.set(-0.16, 0.7, 0);
    const legR = legL.clone(); legR.position.x = 0.16;
    const body = box(0.68, 0.62, 0.38, cBody); body.position.y = 1.0;
    const belt = box(0.7, 0.08, 0.4, cDark); belt.position.y = 0.72;
    const faceMat = track(new T.MeshStandardMaterial({ map: getFaceTex(), roughness: 0.8 }));
    const headMats = [cSkin, cSkin, cSkin, cSkin, cSkin, faceMat]; // -Z 为脸
    const head = new T.Mesh(new T.BoxGeometry(0.42, 0.4, 0.42), headMats); head.castShadow = true;
    head.position.y = 1.53;
    const armGeo = new T.BoxGeometry(0.17, 0.62, 0.2); armGeo.translate(0, -0.28, 0);
    const armL = new T.Mesh(armGeo, cSkin); armL.castShadow = true; armL.position.set(-0.43, 1.28, 0);
    const armR = new T.Mesh(armGeo.clone(), cSkin); armR.castShadow = true; armR.position.set(0.43, 1.28, 0);

    // 外观锚点
    const hatA = new T.Group(); hatA.position.set(0, 1.75, 0);
    const faceA = new T.Group(); faceA.position.set(0, 1.56, -0.23);
    const backA = new T.Group(); backA.position.set(0, 1.15, 0.24);
    const weaponA = new T.Group(); weaponA.position.set(0, -0.55, -0.1); armR.add(weaponA);

    g.add(legL, legR, body, belt, head, armL, armR, hatA, faceA, backA);
    const plate = makeNameplate(name, color); plate.position.y = 2.25; g.add(plate);

    const model = {
      group: g, legL, legR, armL, armR, head, body, plate, hatA, faceA, backA, weaponA,
      mats, cosMats: [], walkT: 0, attackT: 9, attackDur: 0.3, weaponMesh: null, curWeapon: null,
      baseColor: color, zombified: false,
    };
    g.userData.model = model;
    return model;
  }

  function animatePlayer(m, dt, moving, activeSlot, speedMul) {
    m.walkT += dt * (moving ? 9 * (speedMul || 1) : 0);
    m.attackT += dt;
    const sw = moving ? Math.sin(m.walkT) * 0.55 : 0;
    m.legL.rotation.x = sw; m.legR.rotation.x = -sw;
    // 手臂姿态：持枪 = 前平举；近战攻击 = 挥砍；丧尸 = 双爪前伸
    let armBase = moving ? -Math.sin(m.walkT) * 0.3 : 0;
    if (m.zombified) {
      m.armL.rotation.x = -1.35 + Math.sin(m.walkT * 0.7) * 0.1;
      m.armR.rotation.x = -1.35 - Math.sin(m.walkT * 0.7) * 0.1;
    } else if (activeSlot === 'gun') {
      m.armR.rotation.x = -1.45;
      m.armL.rotation.x = -1.1;
    } else {
      m.armL.rotation.x = armBase;
      m.armR.rotation.x = -armBase;
    }
    if (m.attackT < m.attackDur) {
      const k = m.attackT / m.attackDur;
      m.armR.rotation.x = -2.1 + k * 2.1;   // 快速下劈
    }
  }

  function setPlayerWeapon(m, wp) {
    if (m.curWeapon === wp) return;
    m.curWeapon = wp;
    if (m.weaponMesh) { m.weaponA.remove(m.weaponMesh); m.weaponMesh = null; }
    if (wp && wp !== 'fist') {
      m.weaponMesh = buildWeapon(wp);
      m.weaponMesh.rotation.x = Math.PI / 2 * 0.9;
      m.weaponA.add(m.weaponMesh);
    }
  }

  function setOpacity(m, a) {
    const all = m.mats.concat(m.cosMats);
    for (const mat of all) {
      mat.transparent = a < 0.99;
      mat.opacity = a;
      mat.depthWrite = a >= 0.5;
    }
    m.plate.visible = a > 0.5;
  }

  function tintZombie(m, on) {
    if (m.zombified === on) return;
    m.zombified = on;
    const c = on ? '#5dbb46' : m.baseColor;
    m.mats[0].color.set(on ? '#4a8f38' : m.baseColor);
    m.mats[2].color.set(on ? '#7bd45f' : '#e8b98a');
  }

  // ---------- 外观装饰 ----------
  function buildCosmetic(id) {
    const g = new T.Group();
    const add = (...ms) => { ms.forEach(x => g.add(x)); return g; };
    switch (id) {
      case 'hat_cowboy': {
        const m = std('#8a5a2b');
        const brim = cyl(0.36, 0.36, 0.045, m); const top = cyl(0.19, 0.21, 0.24, m); top.position.y = 0.13;
        return add(brim, top);
      }
      case 'hat_beret': {
        const b = sph(0.26, std('#3f7d3a')); b.scale.y = 0.45; b.position.set(0.04, 0.06, 0);
        return add(b);
      }
      case 'hat_horns': {
        const m = std('#a03030', { emissive: '#5c0f0f', emissiveIntensity: 0.6 });
        const h1 = cone(0.07, 0.3, m); h1.position.set(-0.17, 0.12, 0); h1.rotation.z = 0.5;
        const h2 = h1.clone(); h2.position.x = 0.17; h2.rotation.z = -0.5;
        return add(h1, h2);
      }
      case 'hat_crown': {
        const m = std('#ffd23c', { metalness: 0.85, roughness: 0.3, emissive: '#8a6a00', emissiveIntensity: 0.35 });
        const base = cyl(0.24, 0.26, 0.14, m); base.position.y = 0.07;
        g.add(base);
        for (let i = 0; i < 5; i++) {
          const s = cone(0.05, 0.14, m);
          const a = i / 5 * Math.PI * 2;
          s.position.set(Math.cos(a) * 0.22, 0.19, Math.sin(a) * 0.22);
          g.add(s);
        }
        return g;
      }
      case 'face_shades': {
        const b = box(0.4, 0.1, 0.05, std('#111', { roughness: 0.2, metalness: 0.6 }));
        return add(b);
      }
      case 'face_visor': {
        const b = box(0.44, 0.15, 0.06, std('#0b2733', { emissive: '#35e0ff', emissiveIntensity: 1.4, roughness: 0.2 }));
        return add(b);
      }
      case 'back_cape': {
        const m = std('#b01e3c', { side: T.DoubleSide });
        const p = new T.Mesh(new T.PlaneGeometry(0.62, 0.95), m); p.castShadow = true;
        p.position.set(0, -0.35, 0.03); p.rotation.x = 0.12;
        return add(p);
      }
      case 'back_jet': {
        const m = std('#777c85', { metalness: 0.7, roughness: 0.35 });
        const fm = std('#331a05', { emissive: '#ff7a1a', emissiveIntensity: 1.6 });
        const t1 = cyl(0.09, 0.09, 0.42, m); t1.position.set(-0.11, -0.1, 0.06);
        const t2 = t1.clone(); t2.position.x = 0.11;
        const f1 = cone(0.06, 0.12, fm); f1.rotation.x = Math.PI; f1.position.set(-0.11, -0.36, 0.06);
        const f2 = f1.clone(); f2.position.x = 0.11;
        return add(t1, t2, f1, f2);
      }
      case 'back_wings': {
        const m = std('#f5f7ff', { emissive: '#aac6ff', emissiveIntensity: 0.5, side: T.DoubleSide });
        for (const s of [-1, 1]) {
          for (let i = 0; i < 3; i++) {
            const f = new T.Mesh(new T.PlaneGeometry(0.5 - i * 0.1, 0.16), m);
            f.position.set(s * (0.25 + i * 0.13), -i * 0.16 + 0.1, 0.05 + i * 0.02);
            f.rotation.z = s * (0.5 + i * 0.25);
            g.add(f);
          }
        }
        return g;
      }
    }
    return g;
  }

  const FX_COLORS = { fx_ice: '#57d4ff', fx_gold: '#ffca3a', fx_rainbow: null };
  function applyWeaponFx(model, fxId, time) {
    const mesh = model.weaponMesh || (model.viewWeapon || null);
    if (!mesh || !mesh.userData.fxMats) return;
    let col = null;
    if (fxId === 'fx_rainbow') col = new T.Color().setHSL((time * 0.22) % 1, 0.86, 0.58);
    else if (FX_COLORS[fxId]) col = new T.Color(FX_COLORS[fxId]);
    const pulse = 0.28 + Math.sin(time * 4) * 0.06;
    for (const mat of mesh.userData.fxMats) {
      if (col) { mat.emissive.copy(col); mat.emissiveIntensity = pulse; }
      else { mat.emissive.set(0x000000); mat.emissiveIntensity = 0; }
    }
  }

  function applyCosmetics(model, eq) {
    const key = (eq.head || '') + '|' + (eq.face || '') + '|' + (eq.back || '');
    if (model._cosKey === key) return;
    model._cosKey = key;
    for (const a of [model.hatA, model.faceA, model.backA]) while (a.children.length) a.remove(a.children[0]);
    model.cosMats = [];
    const collect = grp => grp.traverse(o => { if (o.material) model.cosMats.push(o.material); });
    if (eq.head) { const c = buildCosmetic(eq.head); model.hatA.add(c); collect(c); }
    if (eq.face) { const c = buildCosmetic(eq.face); model.faceA.add(c); collect(c); }
    if (eq.back) { const c = buildCosmetic(eq.back); model.backA.add(c); collect(c); }
  }

  // ---------- 武器 ----------
  function buildWeapon(wp) {
    const g = new T.Group();
    const metal = std('#9aa4b0', { metalness: 0.8, roughness: 0.3 });
    const dark = std('#2e3238', { metalness: 0.6, roughness: 0.4 });
    const wood = std('#7a4f28');
    const fxMats = [];
    switch (wp) {
      case 'knife': {
        const blade = box(0.045, 0.02, 0.3, metal); blade.position.z = -0.18;
        const hilt = box(0.05, 0.05, 0.12, dark); hilt.position.z = 0.03;
        g.add(blade, hilt); fxMats.push(metal);
        break;
      }
      case 'sword': {
        const blade = box(0.07, 0.025, 0.8, metal); blade.position.z = -0.45;
        const guard = box(0.2, 0.03, 0.05, std('#c9a227', { metalness: 0.8 }));
        const hilt = box(0.05, 0.05, 0.18, dark); hilt.position.z = 0.1;
        g.add(blade, guard, hilt); fxMats.push(metal);
        break;
      }
      case 'hammer': {
        const handle = cylZ(0.035, 0.035, 0.65, wood); handle.position.z = -0.1;
        const headMat = std('#2e3238', { metalness: 0.6, roughness: 0.4 });
        const head = box(0.18, 0.18, 0.3, headMat); head.position.z = -0.42;
        g.add(handle, head); fxMats.push(headMat);
        break;
      }
      case 'pistol': {
        const body = box(0.07, 0.09, 0.28, dark); body.position.z = -0.12;
        const grip = box(0.05, 0.14, 0.07, dark); grip.position.set(0, -0.1, 0.02); grip.rotation.x = 0.25;
        const barrelMat = std('#9aa4b0', { metalness: 0.8, roughness: 0.3 });
        const barrel = cylZ(0.017, 0.017, 0.2, barrelMat, 14, true); barrel.position.set(0, 0.02, -0.36);
        const muzzle = muzzleRing(0.018, barrelMat); muzzle.position.set(0, 0.02, -0.46);
        g.add(body, grip, barrel, muzzle); fxMats.push(barrelMat);
        break;
      }
      case 'mg': {
        const body = box(0.07, 0.11, 0.55, dark); body.position.z = -0.18;
        const barrelMat = std('#9aa4b0', { metalness: 0.8, roughness: 0.3 });
        const barrel = cylZ(0.022, 0.022, 0.42, barrelMat, 14, true); barrel.position.set(0, 0.02, -0.68);
        const muzzle = muzzleRing(0.023, barrelMat); muzzle.position.set(0, 0.02, -0.89);
        const mag = box(0.05, 0.2, 0.09, metal); mag.position.set(0, -0.13, -0.12); mag.rotation.x = 0.15;
        const stock = box(0.05, 0.09, 0.18, wood); stock.position.set(0, -0.02, 0.16);
        const grip = box(0.045, 0.11, 0.05, dark); grip.position.set(0, -0.1, 0.03);
        g.add(body, barrel, muzzle, mag, stock, grip); fxMats.push(barrelMat);
        break;
      }
      case 'sniper': {
        const body = box(0.06, 0.09, 0.6, dark); body.position.z = -0.15;
        const barrelMat = std('#9aa4b0', { metalness: 0.8, roughness: 0.3 });
        const scopeMat = std('#9aa4b0', { metalness: 0.8, roughness: 0.3 });
        const barrel = cylZ(0.02, 0.02, 0.62, barrelMat, 14, true); barrel.position.set(0, 0.01, -0.79);
        const muzzle = muzzleRing(0.021, barrelMat); muzzle.position.set(0, 0.01, -1.1);
        const scope = cylZ(0.035, 0.035, 0.24, scopeMat, 14); scope.position.set(0, 0.09, -0.18);
        const scopeLens = muzzleRing(0.036, scopeMat); scopeLens.position.set(0, 0.09, -0.3);
        const stock = box(0.05, 0.1, 0.22, wood); stock.position.set(0, -0.03, 0.2);
        const grip = box(0.045, 0.1, 0.05, dark); grip.position.set(0, -0.11, 0.05);
        g.add(body, barrel, muzzle, scope, scopeLens, stock, grip); fxMats.push(barrelMat, scopeMat);
        break;
      }
      case 'nade': {
        const b = sph(0.09, std('#3c5232', { roughness: 0.5 }));
        const topMat = std('#9aa4b0', { metalness: 0.8, roughness: 0.3 });
        const top = cyl(0.03, 0.03, 0.05, topMat); top.position.y = 0.1;
        g.add(b, top); fxMats.push(topMat);
        break;
      }
      case 'flash': {   // 闪光弹：银色小罐 + 白色发光环
        const bodyMat = std('#c8ccd4', { metalness: 0.75, roughness: 0.25 });
        const body = cyl(0.05, 0.05, 0.16, bodyMat);
        const band = cyl(0.053, 0.053, 0.035, new T.MeshStandardMaterial({ color: '#ffffff', emissive: '#dfeaff', emissiveIntensity: 0.8 }));
        band.position.y = 0.03;
        const top = cyl(0.028, 0.028, 0.04, std('#2e3238', { metalness: 0.6 })); top.position.y = 0.1;
        g.add(body, band, top); fxMats.push(bodyMat);
        break;
      }
      case 'smoke': {   // 烟雾弹：灰罐 + 黄色警示环
        const bodyMat = std('#5a626e', { roughness: 0.55 });
        const body = cyl(0.06, 0.06, 0.2, bodyMat);
        const band = cyl(0.063, 0.063, 0.04, std('#ffd23c', { emissive: '#7a5f00', emissiveIntensity: 0.4 }));
        band.position.y = 0.04;
        const top = cyl(0.03, 0.03, 0.04, std('#2e3238', { metalness: 0.6 })); top.position.y = 0.12;
        g.add(body, band, top); fxMats.push(bodyMat);
        break;
      }
    }
    g.userData.fxMats = fxMats;
    return g;
  }

  // ---------- 拾取物 ----------
  function makePickup(item, defs) {
    const g = new T.Group();
    if (defs.weapons[item]) {
      const w = buildWeapon(item);
      w.scale.setScalar(1.5);
      w.position.y = 0.75;
      g.add(w);
      g.userData.glow = '#35e0ff';
    } else if (defs.equips[item]) {
      if (item === 'health') {
        const b = box(0.5, 0.34, 0.5, std('#f2f5f7'));
        b.position.y = 0.7;
        const c1 = box(0.3, 0.09, 0.06, std('#e33', { emissive: '#e33', emissiveIntensity: 0.5 })); c1.position.set(0, 0.7, -0.26);
        const c2 = box(0.09, 0.3, 0.06, c1.material); c2.position.set(0, 0.7, -0.26);
        g.add(b, c1, c2); g.userData.glow = '#6dff9a';
      } else if (item === 'armor') {
        const b = box(0.44, 0.5, 0.2, std('#2f6fb2', { emissive: '#1a4a80', emissiveIntensity: 0.5, metalness: 0.5 }));
        b.position.y = 0.75;
        g.add(b); g.userData.glow = '#4d9fff';
      } else {
        const m = std('#d9822b', { emissive: '#8a4a10', emissiveIntensity: 0.5 });
        const b1 = box(0.16, 0.2, 0.34, m); b1.position.set(-0.12, 0.6, 0);
        const b2 = b1.clone(); b2.position.x = 0.12;
        g.add(b1, b2); g.userData.glow = '#ffa94d';
      }
    } else if (defs.buffs[item]) {
      const col = defs.buffs[item].color;
      const orb = sph(0.26, new T.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 1.1, roughness: 0.3 }));
      orb.position.y = 0.85;
      const ring = new T.Mesh(new T.TorusGeometry(0.38, 0.03, 8, 24),
        new T.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.8 }));
      ring.position.y = 0.85; ring.rotation.x = Math.PI / 2;
      g.add(orb, ring); g.userData.glow = col;
    }
    // 底座光环
    const base = new T.Mesh(new T.RingGeometry(0.45, 0.6, 24),
      new T.MeshBasicMaterial({ color: g.userData.glow || '#35e0ff', transparent: true, opacity: 0.5, side: T.DoubleSide }));
    base.rotation.x = -Math.PI / 2; base.position.y = 0.03;
    g.add(base);
    return g;
  }

  // ---------- BOSS（四种特色类型） ----------
  function finishBoss(g, name, color, plateY, light) {
    const plate = makeNameplate('👹 ' + name, '#ff9c5c');
    plate.position.y = plateY; plate.scale.set(3.2, 0.8, 1);
    g.add(plate);
    const pl = new T.PointLight(color, 0.9, 10); pl.position.y = plateY * 0.5; g.add(pl);
    const mats = [];
    g.traverse(o => { if (o.material && o !== plate) mats.push(o.material); });
    return { plate, mats };
  }
  function setBossOpacity(m, a) {
    for (const mat of m.mats) { mat.transparent = a < 0.99; mat.opacity = a; mat.depthWrite = a >= 0.5; }
    m.plate.visible = a > 0.5;
  }

  function makeBoss(type, name, color) {
    const g = new T.Group();
    let model;
    if (type === 'assassin') {
      // 暗影刺客：修长身形 + 双刃 + 破斗篷
      const dark = std('#1c1730', { roughness: 0.6 });
      const glow = new T.MeshStandardMaterial({ color: '#12081f', emissive: color, emissiveIntensity: 1.6 });
      const legGeo = new T.BoxGeometry(0.18, 0.85, 0.2); legGeo.translate(0, -0.42, 0);
      const legL = new T.Mesh(legGeo, dark); legL.castShadow = true; legL.position.set(-0.15, 0.85, 0);
      const legR = new T.Mesh(legGeo.clone(), dark); legR.castShadow = true; legR.position.x = 0.15; legR.position.y = 0.85;
      const body = box(0.55, 0.85, 0.32, dark); body.position.y = 1.3;
      const strap = box(0.58, 0.1, 0.35, glow); strap.position.y = 1.45; strap.rotation.z = 0.5;
      const hood = cone(0.3, 0.55, dark); hood.position.y = 2.0;
      const face = sph(0.18, std('#0a0714'), 8); face.position.set(0, 1.86, -0.12);
      const eyeM = new T.MeshStandardMaterial({ color: '#000', emissive: color, emissiveIntensity: 2.5 });
      const e1 = sph(0.035, eyeM, 6); e1.position.set(-0.07, 1.88, -0.26);
      const e2 = e1.clone(); e2.position.x = 0.07;
      const armGeo = new T.BoxGeometry(0.14, 0.7, 0.16); armGeo.translate(0, -0.32, 0);
      const armL = new T.Mesh(armGeo, dark); armL.castShadow = true; armL.position.set(-0.38, 1.62, 0);
      const armR = new T.Mesh(armGeo.clone(), dark); armR.castShadow = true; armR.position.set(0.38, 1.62, 0);
      for (const arm of [armL, armR]) {
        const blade = box(0.03, 0.5, 0.09, glow); blade.position.set(0, -0.75, -0.05);
        arm.add(blade);
      }
      const cape = new T.Mesh(new T.PlaneGeometry(0.6, 1.1), std('#241b3d', { side: T.DoubleSide }));
      cape.position.set(0, 1.2, 0.2); cape.rotation.x = 0.15;
      g.add(legL, legR, body, strap, hood, face, e1, e2, armL, armR, cape);
      const fin = finishBoss(g, name, color, 2.75);
      model = Object.assign({ group: g, walkT: 0, slamT: 9 }, fin);
      model.update = (dt, moving) => {
        model.walkT += dt * (moving ? 11 : 1.5);
        model.slamT += dt;
        const sw = Math.sin(model.walkT) * 0.7;
        legL.rotation.x = sw; legR.rotation.x = -sw;
        if (model.slamT < 0.3) {           // 疾斩：前倾突刺
          const k = Math.sin(model.slamT / 0.3 * Math.PI);
          armL.rotation.x = -2 * k; armR.rotation.x = -2 * k;
          g.rotation.x = 0.25 * k;
        } else {
          g.rotation.x = 0;
          armL.rotation.x = -0.5 + Math.sin(model.walkT) * 0.3;
          armR.rotation.x = -0.5 - Math.sin(model.walkT) * 0.3;
        }
      };
    } else if (type === 'warmachine') {
      // 钢铁暴君：重装机体 + 双管机炮
      const metal = std('#4a525e', { metalness: 0.7, roughness: 0.35 });
      const darkM = std('#2b3038', { metalness: 0.6, roughness: 0.45 });
      const redGlow = new T.MeshStandardMaterial({ color: '#1a0505', emissive: '#ff2e2e', emissiveIntensity: 2 });
      const trackL = box(1.0, 0.85, 2.0, darkM); trackL.position.set(-0.75, 0.45, 0);
      const trackR = trackL.clone(); trackR.position.x = 0.75;
      const torso = box(2.5, 1.4, 1.6, metal); torso.position.y = 1.9;
      const visor = box(1.8, 0.2, 0.06, redGlow); visor.position.set(0, 2.2, -0.82);
      const shoulderL = box(0.7, 0.5, 0.9, darkM); shoulderL.position.set(-1.6, 2.45, 0);
      const shoulderR = shoulderL.clone(); shoulderR.position.x = 1.6;
      const gunL = new T.Group(); gunL.position.set(-1.6, 2.1, 0);
      const gunR = new T.Group(); gunR.position.set(1.6, 2.1, 0);
      for (const gun of [gunL, gunR]) {
        const barrel = cyl(0.13, 0.15, 1.5, darkM); barrel.rotation.x = Math.PI / 2; barrel.position.z = -0.9;
        const muzzle = cyl(0.17, 0.17, 0.16, redGlow); muzzle.rotation.x = Math.PI / 2; muzzle.position.z = -1.62;
        gun.add(barrel, muzzle);
      }
      const antenna = cyl(0.02, 0.02, 0.9, darkM); antenna.position.set(0.8, 3.1, 0.4);
      const tip = sph(0.06, redGlow, 6); tip.position.set(0.8, 3.55, 0.4);
      const pipeL = cyl(0.09, 0.09, 0.5, darkM); pipeL.position.set(-0.5, 2.8, 0.75);
      const pipeR = pipeL.clone(); pipeR.position.x = 0.5;
      const pipeFm = new T.MeshStandardMaterial({ color: '#331a05', emissive: '#ff7a1a', emissiveIntensity: 1.4 });
      const pf1 = cyl(0.07, 0.02, 0.12, pipeFm); pf1.position.set(-0.5, 3.08, 0.75);
      const pf2 = pf1.clone(); pf2.position.x = 0.5;
      g.add(trackL, trackR, torso, visor, shoulderL, shoulderR, gunL, gunR, antenna, tip, pipeL, pipeR, pf1, pf2);
      const fin = finishBoss(g, name, color, 4.3);
      model = Object.assign({ group: g, walkT: 0, slamT: 9 }, fin);
      model.update = (dt, moving) => {
        model.walkT += dt * (moving ? 5 : 1);
        model.slamT += dt;
        torso.position.y = 1.9 + Math.sin(model.walkT) * 0.03;
        if (model.slamT < 0.6) {           // 开火后座
          const k = Math.sin(model.slamT / 0.6 * Math.PI);
          gunL.position.z = k * 0.18; gunR.position.z = k * 0.18;
        } else { gunL.position.z = 0; gunR.position.z = 0; }
      };
    } else if (type === 'lich') {
      // 虚空巫妖：悬浮法袍 + 骷髅王冠 + 法杖
      const robeM = std('#2a1f4a', { roughness: 0.7 });
      const boneM = std('#d8d2c4', { roughness: 0.5 });
      const glowM = new T.MeshStandardMaterial({ color: '#12081f', emissive: color, emissiveIntensity: 2 });
      const body = new T.Group();                       // 悬浮体（整体上下浮动）
      const robe = cone(0.85, 2.1, robeM); robe.position.y = 1.05; body.add(robe);
      const trim = cyl(0.87, 0.87, 0.1, glowM); trim.position.y = 0.12; body.add(trim);
      const skull = box(0.46, 0.42, 0.44, boneM); skull.position.y = 2.35; body.add(skull);
      const jaw = box(0.34, 0.12, 0.3, boneM); jaw.position.set(0, 2.1, -0.04); body.add(jaw);
      const eyeM2 = new T.MeshStandardMaterial({ color: '#000', emissive: color, emissiveIntensity: 3 });
      const e1 = box(0.09, 0.1, 0.04, eyeM2); e1.position.set(-0.1, 2.38, -0.23); body.add(e1);
      const e2 = e1.clone(); e2.position.x = 0.1; body.add(e2);
      const crownM = std('#ffd23c', { metalness: 0.85, roughness: 0.3, emissive: '#7a5a00', emissiveIntensity: 0.4 });
      const crown = cyl(0.26, 0.28, 0.12, crownM); crown.position.y = 2.6; body.add(crown);
      for (let i = 0; i < 4; i++) {
        const spike = cone(0.05, 0.16, crownM);
        const a = i / 4 * Math.PI * 2;
        spike.position.set(Math.cos(a) * 0.24, 2.72, Math.sin(a) * 0.24);
        body.add(spike);
      }
      const shL = sph(0.22, robeM, 8); shL.position.set(-0.55, 1.95, 0); body.add(shL);
      const shR = shL.clone(); shR.position.x = 0.55; body.add(shR);
      const armR = new T.Group(); armR.position.set(0.62, 1.85, 0); body.add(armR);
      const staff = cyl(0.035, 0.035, 1.7, std('#3a2a1a')); staff.rotation.x = 0.25; staff.position.set(0, -0.2, -0.25); armR.add(staff);
      const orb = sph(0.15, glowM, 10); orb.position.set(0, 0.68, -0.46); armR.add(orb);
      g.add(body);
      const fin = finishBoss(g, name, color, 3.3);
      model = Object.assign({ group: g, walkT: 0, slamT: 9, body }, fin);
      model.update = (dt, moving) => {
        model.walkT += dt * 1.6;
        model.slamT += dt;
        body.position.y = 0.42 + Math.sin(model.walkT) * 0.16;   // 悬浮
        body.rotation.z = Math.sin(model.walkT * 0.7) * 0.05;
        if (model.slamT < 0.5) {           // 施法：法杖高举
          const k = Math.sin(model.slamT / 0.5 * Math.PI);
          armR.rotation.x = -1.6 * k;
        } else armR.rotation.x = -0.2;
        orb.rotation.y += dt * 3;
      };
    } else {
      // 熔岩魔像（默认）
      const rock = std('#3a3f4a', { roughness: 0.9 });
      const lava = std('#331005', { emissive: '#ff5a1a', emissiveIntensity: 1.6 });
      const legGeo = new T.BoxGeometry(0.7, 1.3, 0.8); legGeo.translate(0, -0.65, 0);
      const legL = new T.Mesh(legGeo, rock); legL.castShadow = true; legL.position.set(-0.55, 1.5, 0);
      const legR = new T.Mesh(legGeo.clone(), rock); legR.castShadow = true; legR.position.set(0.55, 1.5, 0);
      const torso = box(2.1, 1.7, 1.3, rock); torso.position.y = 2.4;
      const crack1 = box(1.5, 0.12, 1.34, lava); crack1.position.y = 2.5;
      const crack2 = box(2.14, 0.1, 0.9, lava); crack2.position.y = 2.15;
      const armGeo = new T.BoxGeometry(0.55, 1.6, 0.6); armGeo.translate(0, -0.7, 0);
      const armL = new T.Mesh(armGeo, rock); armL.castShadow = true; armL.position.set(-1.35, 3.1, 0);
      const armR = new T.Mesh(armGeo.clone(), rock); armR.castShadow = true; armR.position.set(1.35, 3.1, 0);
      const fistL = sph(0.42, rock); fistL.position.y = -1.5; armL.add(fistL);
      const fistR = fistL.clone(); armR.add(fistR);
      const head = box(0.8, 0.7, 0.75, rock); head.position.y = 3.6;
      const eyeM = new T.MeshStandardMaterial({ color: '#000', emissive: '#ffb01a', emissiveIntensity: 2.5 });
      const eyeL = sph(0.09, eyeM, 8); eyeL.position.set(-0.2, 3.65, -0.39);
      const eyeR = eyeL.clone(); eyeR.position.x = 0.2;
      const hornM = std('#20242c');
      const hornL = cone(0.14, 0.55, hornM); hornL.position.set(-0.35, 4.1, 0); hornL.rotation.z = 0.4;
      const hornR = hornL.clone(); hornR.position.x = 0.35; hornR.rotation.z = -0.4;
      g.add(legL, legR, torso, crack1, crack2, armL, armR, head, eyeL, eyeR, hornL, hornR);
      const fin = finishBoss(g, name, color || '#ff6a1a', 4.9);
      model = Object.assign({ group: g, walkT: 0, slamT: 9 }, fin);
      model.update = (dt, moving) => {
        model.walkT += dt * (moving ? 4 : 0.6);
        model.slamT += dt;
        const sw = Math.sin(model.walkT) * 0.4;
        legL.rotation.x = sw; legR.rotation.x = -sw;
        if (model.slamT < 0.5) {
          const k = model.slamT / 0.5;
          const a = k < 0.4 ? -2.4 * (k / 0.4) : -2.4 + 2.4 * ((k - 0.4) / 0.6);
          armL.rotation.x = a; armR.rotation.x = a;
        } else {
          armL.rotation.x = Math.sin(model.walkT) * 0.25;
          armR.rotation.x = -Math.sin(model.walkT) * 0.25;
        }
      };
    }
    return model;
  }

  // ---------- 可摧毁油桶 ----------
  function makeBarrel(r, h) {
    const g = new T.Group();
    const body = cyl(r, r, h, std('#b03a2e', { roughness: 0.55, metalness: 0.3 }), 14);
    body.position.y = h / 2;
    const band = cyl(r + 0.02, r + 0.02, 0.12, std('#d8d8d8', { metalness: 0.6 }), 14);
    band.position.y = h * 0.6;
    const lid = cyl(r * 0.92, r * 0.92, 0.06, std('#7a2a20', { roughness: 0.5 }), 14);
    lid.position.y = h + 0.02;
    // 警示条纹
    const hc = document.createElement('canvas'); hc.width = 64; hc.height = 16;
    const hx = hc.getContext('2d');
    for (let i = 0; i < 10; i++) { hx.fillStyle = i % 2 ? '#111' : '#ffb02e'; hx.beginPath(); hx.moveTo(i * 8 - 4, 16); hx.lineTo(i * 8 + 4, 0); hx.lineTo(i * 8 + 12, 0); hx.lineTo(i * 8 + 4, 16); hx.fill(); }
    const hTex = new T.CanvasTexture(hc); hTex.wrapS = T.RepeatWrapping; hTex.repeat.set(3, 1);
    const hazard = new T.Mesh(new T.CylinderGeometry(r + 0.015, r + 0.015, 0.22, 14, 1, true),
      new T.MeshStandardMaterial({ map: hTex, roughness: 0.6 }));
    hazard.position.y = h * 0.32;
    g.add(body, band, lid, hazard);
    return g;
  }

  // ---------- 神秘商人 ----------
  function makeMerchant() {
    const g = new T.Group();
    // 摊位
    const woodM = std('#6b4a26', { roughness: 0.85 });
    const counter = box(3, 1, 1, woodM); counter.position.set(0, 0.5, -1);
    for (const [px, pz] of [[-1.5, -1.6], [1.5, -1.6], [-1.5, 0.6], [1.5, 0.6]]) {
      const post = cyl(0.07, 0.07, 2.6, woodM); post.position.set(px, 1.3, pz); g.add(post);
    }
    // 条纹雨棚
    const awnC = document.createElement('canvas'); awnC.width = 128; awnC.height = 32;
    const ax = awnC.getContext('2d');
    for (let i = 0; i < 8; i++) { ax.fillStyle = i % 2 ? '#7b2d8b' : '#e8d44d'; ax.fillRect(i * 16, 0, 16, 32); }
    const awning = new T.Mesh(new T.BoxGeometry(3.6, 0.08, 2.6),
      new T.MeshStandardMaterial({ map: new T.CanvasTexture(awnC) }));
    awning.castShadow = true; awning.position.set(0, 2.65, -0.5); awning.rotation.x = -0.12;
    // 商人（斗篷法师）
    const robeM = std('#4a2a6b', { roughness: 0.7 });
    const robe = cone(0.55, 1.5, robeM); robe.position.set(0, 0.75, -1.8);
    const hood = sph(0.3, robeM); hood.position.set(0, 1.62, -1.8);
    const eyeM2 = new T.MeshStandardMaterial({ color: '#000', emissive: '#c76bff', emissiveIntensity: 2.2 });
    const e1 = sph(0.045, eyeM2, 8); e1.position.set(-0.09, 1.64, -1.55);
    const e2 = e1.clone(); e2.position.x = 0.09;
    // 台面商品
    const gem = new T.Mesh(new T.OctahedronGeometry ? new T.OctahedronGeometry(0.16) : new T.SphereGeometry(0.16, 8, 8),
      new T.MeshStandardMaterial({ color: '#b26bff', emissive: '#7b2dff', emissiveIntensity: 1.2 }));
    gem.position.set(-0.7, 1.2, -1);
    const potion = cyl(0.09, 0.12, 0.28, std('#2bbf8a', { emissive: '#128a5a', emissiveIntensity: 0.8 })); potion.position.set(0.6, 1.15, -1);
    const lamp = new T.PointLight('#d9a9ff', 1.1, 10); lamp.position.set(0, 2.2, -1);
    g.add(counter, awning, robe, hood, e1, e2, gem, potion, lamp);
    // 招牌
    const sign = textSprite(256, 80, (ctx, c) => {
      ctx.font = 'bold 44px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = '#c76bff'; ctx.shadowBlur = 16;
      ctx.fillStyle = '#e8ccff'; ctx.fillText('神秘商店', 128, 40);
    });
    sign.scale.set(3.4, 1.05, 1); sign.position.set(0, 3.4, -0.5);
    g.add(sign);
    g.userData.gem = gem;
    return g;
  }

  // ---------- 第一人称视角模型 ----------
  function makeViewModel() {
    const g = new T.Group();
    const skin = std('#e8b98a');
    const sleeve = std('#3a4a5c');
    const armR = new T.Group();
    const ra = box(0.045, 0.045, 0.13, sleeve); ra.position.z = 0.055;
    const rh = box(0.055, 0.05, 0.06, skin); rh.position.z = -0.04;
    armR.add(ra, rh);
    armR.position.set(0.17, -0.16, -0.42);
    const armL = armR.clone();
    armL.position.set(-0.17, -0.16, -0.42);
    const weaponA = new T.Group(); weaponA.position.set(0, 0.035, -0.08); armR.add(weaponA);
    g.add(armR, armL);
    g.traverse(o => { o.castShadow = false; o.receiveShadow = false; if (o.material) { o.material.depthTest = true; o.material.depthWrite = true; } });
    return { group: g, armR, armL, weaponA, weaponMesh: null, cur: null };
  }
  function setViewWeapon(vm, wp, zombified) {
    const key = (wp || 'fist') + (zombified ? '_z' : '');
    if (vm.cur === key) return;
    vm.cur = key;
    if (vm.weaponMesh) { vm.weaponA.remove(vm.weaponMesh); vm.weaponMesh = null; }
    vm.armL.visible = (wp === 'fist' || !wp || zombified);
    if (zombified) {
      const claws = new T.Group();
      const cm = std('#7bd45f', { emissive: '#2b8a1a', emissiveIntensity: 0.6 });
      for (let i = -1; i <= 1; i++) {
        const c = cone(0.02, 0.14, cm); c.rotation.x = -Math.PI / 2; c.position.set(i * 0.04, 0, -0.16);
        claws.add(c);
      }
      vm.weaponMesh = claws;
    } else if (wp && wp !== 'fist') {
      vm.weaponMesh = buildWeapon(wp);
    }
    if (vm.weaponMesh) {
      const layerMask = vm.group.layers.mask;
      vm.weaponMesh.traverse(o => {
        o.layers.mask = layerMask;
        o.castShadow = false;
        o.receiveShadow = false;
        if (o.material) { o.material.depthTest = true; o.material.depthWrite = true; }
      });
      vm.weaponA.add(vm.weaponMesh);
    }
  }

  return {
    makePlayer, animatePlayer, setPlayerWeapon, setOpacity, tintZombie,
    applyCosmetics, applyWeaponFx, buildWeapon, makePickup, makeBoss, setBossOpacity,
    makeBarrel, makeMerchant, makeViewModel, setViewWeapon, makeNameplate, textSprite, std,
  };
})();

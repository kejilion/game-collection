// 场景构建：昼夜天空 / 地面 / 围墙 / 障碍物 / 高地 / 油桶 + 玩家移动碰撞
window.G = window.G || {};
G.world = (function () {
  const T = THREE;
  let colliders = [];        // 静态 AABB
  let barrels = [];          // {x, z, alive, group} 动态油桶
  let barrelR = 0.85, barrelH = 1.7;
  let half = 35;
  let ramps = [];
  const RAMP_OVERLAP = 0.18;
  const RAMP_STEP_UP = 0.5;
  // 昼夜相关引用
  let skyMat = null, stars = null, moonMesh = null, sunMesh = null;
  let hemi = null, sun = null, moonLight = null, pylonLights = [], clouds = [], dust = null;
  let dayInfoCache = { icon: '🌙', phase: '深夜', k: 0 };

  function canvasTex(w, h, draw, repeat) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), c);
    const tex = new T.CanvasTexture(c);
    if (repeat) { tex.wrapS = tex.wrapT = T.RepeatWrapping; tex.repeat.set(repeat[0], repeat[1]); }
    tex.anisotropy = 4;
    return tex;
  }

  function groundTex() {
    return canvasTex(256, 256, (x) => {
      x.fillStyle = '#1a2030'; x.fillRect(0, 0, 256, 256);
      x.strokeStyle = 'rgba(90,110,150,.35)'; x.lineWidth = 2;
      x.strokeRect(1, 1, 254, 254);
      x.strokeStyle = 'rgba(60,75,105,.3)'; x.lineWidth = 1;
      x.beginPath(); x.moveTo(128, 0); x.lineTo(128, 256); x.moveTo(0, 128); x.lineTo(256, 128); x.stroke();
      for (let i = 0; i < 340; i++) {
        x.fillStyle = `rgba(${120 + Math.random() * 60},${140 + Math.random() * 60},${180 + Math.random() * 50},${Math.random() * 0.08})`;
        x.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
      }
    }, [18, 18]);
  }
  function wallTex() {
    return canvasTex(256, 128, (x) => {
      x.fillStyle = '#2a3040'; x.fillRect(0, 0, 256, 128);
      x.strokeStyle = 'rgba(120,150,200,.25)'; x.lineWidth = 2;
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++)
        x.strokeRect(c * 64 + (r % 2) * 32 - 32, r * 32, 64, 32);
      x.fillStyle = 'rgba(53,224,255,.12)'; x.fillRect(0, 0, 256, 6);
    }, [16, 1]);
  }
  function crateTex() {
    return canvasTex(128, 128, (x) => {
      x.fillStyle = '#8a5f30'; x.fillRect(0, 0, 128, 128);
      x.strokeStyle = '#5c3d1c'; x.lineWidth = 6; x.strokeRect(3, 3, 122, 122);
      x.beginPath(); x.moveTo(0, 0); x.lineTo(128, 128); x.moveTo(128, 0); x.lineTo(0, 128); x.stroke();
      x.fillStyle = 'rgba(0,0,0,.15)';
      for (let i = 0; i < 60; i++) x.fillRect(Math.random() * 128, Math.random() * 128, 3, 1);
    });
  }
  function plateTex() { // 金属平台板
    return canvasTex(128, 128, (x) => {
      x.fillStyle = '#39414f'; x.fillRect(0, 0, 128, 128);
      x.strokeStyle = 'rgba(20,24,32,.8)'; x.lineWidth = 3;
      x.strokeRect(2, 2, 124, 124);
      x.beginPath(); x.moveTo(64, 0); x.lineTo(64, 128); x.moveTo(0, 64); x.lineTo(128, 64); x.stroke();
      x.fillStyle = 'rgba(140,160,190,.5)';
      for (const [rx, ry] of [[12, 12], [116, 12], [12, 116], [116, 116], [52, 52], [76, 76], [52, 76], [76, 52]])
        { x.beginPath(); x.arc(rx, ry, 3, 0, 7); x.fill(); }
      x.fillStyle = 'rgba(53,224,255,.1)'; x.fillRect(0, 0, 128, 5);
    });
  }
  function softBlobTex() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(64, 64, 8, 64, 64, 62);
    g.addColorStop(0, 'rgba(255,255,255,.85)'); g.addColorStop(0.6, 'rgba(255,255,255,.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    return new T.CanvasTexture(c);
  }

  function rampCoord(r, along, y, cross) {
    return r.axis === 'x'
      ? [along, y, r.z + cross]
      : [r.x + cross, y, along];
  }
  function rampBounds(r) {
    const along0 = (r.axis === 'x' ? r.x : r.z) - r.dir * r.len / 2;
    const along1 = (r.axis === 'x' ? r.x : r.z) + r.dir * (r.len / 2 + RAMP_OVERLAP);
    const cross0 = (r.axis === 'x' ? r.z : r.x) - r.w / 2;
    const cross1 = (r.axis === 'x' ? r.z : r.x) + r.w / 2;
    return {
      minx: r.axis === 'x' ? Math.min(along0, along1) : Math.min(cross0, cross1),
      maxx: r.axis === 'x' ? Math.max(along0, along1) : Math.max(cross0, cross1),
      minz: r.axis === 'z' ? Math.min(along0, along1) : Math.min(cross0, cross1),
      maxz: r.axis === 'z' ? Math.max(along0, along1) : Math.max(cross0, cross1),
      miny: 0, maxy: r.h,
    };
  }
  function rampGeometry(r) {
    const low = (r.axis === 'x' ? r.x : r.z) - r.dir * r.len / 2;
    const high = (r.axis === 'x' ? r.x : r.z) + r.dir * r.len / 2;
    const cap = high + r.dir * RAMP_OVERLAP;
    const w = r.w / 2;
    const A = rampCoord(r, low, 0, -w);
    const B = rampCoord(r, low, 0, w);
    const C = rampCoord(r, high, r.h, w);
    const D = rampCoord(r, high, r.h, -w);
    const E = rampCoord(r, cap, 0, -w);
    const F = rampCoord(r, cap, 0, w);
    const G = rampCoord(r, cap, r.h, w);
    const H = rampCoord(r, cap, r.h, -w);
    const verts = [];
    const tri = (...pts) => pts.forEach(p => verts.push(p[0], p[1], p[2]));
    tri(A, B, C, A, C, D);
    tri(D, C, G, D, G, H);
    tri(A, E, F, A, F, B);
    tri(H, G, F, H, F, E);
    tri(A, D, H, A, H, E);
    tri(B, F, G, B, G, C);
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(verts, 3));
    geo.computeVertexNormals();
    return geo;
  }
  function rampHeightAt(pos, pad) {
    let best = null;
    for (const r of ramps) {
      const along = r.axis === 'x' ? pos.x : pos.z;
      const cross = r.axis === 'x' ? pos.z : pos.x;
      const low = (r.axis === 'x' ? r.x : r.z) - r.dir * r.len / 2;
      const t = (along - low) * r.dir / r.len;
      const center = r.axis === 'x' ? r.z : r.x;
      if (t < -0.02 || t > 1 + RAMP_OVERLAP / r.len + 0.03 || Math.abs(cross - center) > r.w / 2 + (pad || 0)) continue;
      const h = Math.max(0, Math.min(1, t)) * r.h;
      if (best === null || h > best) best = h;
    }
    return best;
  }
  function collideRampSides(pos, axis) {
    for (const r of ramps) {
      if ((r.axis === 'x' && axis !== 'z') || (r.axis === 'z' && axis !== 'x')) continue;
      const along = r.axis === 'x' ? pos.x : pos.z;
      const cross = r.axis === 'x' ? pos.z : pos.x;
      const low = (r.axis === 'x' ? r.x : r.z) - r.dir * r.len / 2;
      const t = (along - low) * r.dir / r.len;
      if (t < -0.02 || t > 1 + RAMP_OVERLAP / r.len + 0.03) continue;
      const h = Math.max(0, Math.min(1, t)) * r.h;
      if (pos.y >= h - RAMP_STEP_UP) continue;
      const center = r.axis === 'x' ? r.z : r.x;
      for (const side of [-1, 1]) {
        const edge = center + side * r.w / 2;
        if (Math.abs(cross - edge) >= R) continue;
        if (axis === 'x') pos.x = edge + side * R;
        else pos.z = edge + side * R;
      }
    }
  }

  function build(scene, map, shadowSize) {
    half = map.half;
    barrelR = map.barrelR; barrelH = map.barrelH;
    colliders = [];
    ramps = Array.isArray(map.ramps) ? map.ramps.slice() : [];

    scene.fog = new T.Fog(0x0a0e1a, 50, 150);
    scene.background = new T.Color(0x0a0e1a);

    // 天空穹顶（uniform 随昼夜更新）
    const skyGeo = new T.SphereGeometry(220, 24, 12);
    skyMat = new T.ShaderMaterial({
      side: T.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new T.Color(0x071226) }, bottom: { value: new T.Color(0x140b24) }, horizon: { value: new T.Color(0x1c3450) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: `varying vec3 vP; uniform vec3 top,bottom,horizon;
        void main(){ float h = normalize(vP).y;
        vec3 c = h>0.0? mix(horizon, top, pow(h,0.6)) : mix(horizon, bottom, pow(-h,0.7));
        gl_FragColor = vec4(c,1.0);}`,
    });
    scene.add(new T.Mesh(skyGeo, skyMat));
    // 星星
    const starGeo = new T.BufferGeometry();
    const starPos = [];
    for (let i = 0; i < 300; i++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * 1.1 + 0.15, r = 200;
      starPos.push(Math.cos(a) * Math.cos(e) * r, Math.sin(e) * r, Math.sin(a) * Math.cos(e) * r);
    }
    starGeo.setAttribute('position', new T.Float32BufferAttribute(starPos, 3));
    stars = new T.Points(starGeo, new T.PointsMaterial({ color: 0xbfd8ff, size: 0.7, fog: false, sizeAttenuation: false, transparent: true, opacity: 1 }));
    scene.add(stars);
    // 月亮 / 太阳
    moonMesh = new T.Mesh(new T.SphereGeometry(9, 16, 16), new T.MeshBasicMaterial({ color: 0xdfe8ff, fog: false }));
    scene.add(moonMesh);
    sunMesh = new T.Mesh(new T.SphereGeometry(11, 16, 16), new T.MeshBasicMaterial({ color: 0xffedb8, fog: false }));
    scene.add(sunMesh);
    // 云（白天可见）
    const blob = softBlobTex();
    for (let i = 0; i < 6; i++) {
      const spr = new T.Sprite(new T.SpriteMaterial({ map: blob, transparent: true, opacity: 0, depthWrite: false, fog: false }));
      spr.scale.set(46 + Math.random() * 30, 15 + Math.random() * 8, 1);
      spr.position.set((Math.random() - 0.5) * 320, 46 + Math.random() * 22, (Math.random() - 0.5) * 320);
      spr.userData.speed = 0.8 + Math.random() * 0.8;
      scene.add(spr);
      clouds.push(spr);
    }
    // 环境浮尘
    const dustGeo = new T.BufferGeometry();
    const dp = [];
    for (let i = 0; i < 50; i++) dp.push((Math.random() - 0.5) * 64, 0.3 + Math.random() * 4, (Math.random() - 0.5) * 64);
    dustGeo.setAttribute('position', new T.Float32BufferAttribute(dp, 3));
    dust = new T.Points(dustGeo, new T.PointsMaterial({ color: 0xaecdf0, size: 0.05, transparent: true, opacity: 0.4 }));
    scene.add(dust);

    // 光照
    hemi = new T.HemisphereLight(0x6f94c8, 0x100c1c, 0.45);
    hemi.layers.enable(1);
    scene.add(hemi);
    sun = new T.DirectionalLight(0xaac4ec, 0.8);
    sun.layers.enable(1);
    sun.position.set(40, 60, -30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(shadowSize || 2048, shadowSize || 2048);   // 仅观感开销：不影响雾距/视距（公平性要求）
    const shExt = half + 4;   // 阴影相机覆盖整张地图
    sun.shadow.camera.left = -shExt; sun.shadow.camera.right = shExt;
    sun.shadow.camera.top = shExt; sun.shadow.camera.bottom = -shExt;
    sun.shadow.camera.far = 260;
    sun.shadow.bias = -0.0004;
    scene.add(sun);
    sun.target.layers.enable(1);
    scene.add(sun.target);
    moonLight = new T.DirectionalLight(0xaac4ec, 0.34);
    moonLight.layers.enable(1);
    moonLight.position.set(-40, 60, -30);
    scene.add(moonLight);
    moonLight.target.layers.enable(1);
    scene.add(moonLight.target);

    // 地面
    const ground = new T.Mesh(new T.PlaneGeometry(half * 2, half * 2),
      new T.MeshStandardMaterial({ map: groundTex(), roughness: 0.9 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const outer = new T.Mesh(new T.PlaneGeometry(500, 500), new T.MeshStandardMaterial({ color: 0x10141f, roughness: 1 }));
    outer.rotation.x = -Math.PI / 2; outer.position.y = -0.05;
    scene.add(outer);

    // 围墙
    const wt = wallTex();
    const wallMat = new T.MeshStandardMaterial({ map: wt, roughness: 0.85 });
    const mkWall = (w, d, x, z) => {
      const m = new T.Mesh(new T.BoxGeometry(w, map.wallH, d), wallMat);
      m.position.set(x, map.wallH / 2, z);
      m.castShadow = m.receiveShadow = true;
      scene.add(m);
    };
    mkWall(half * 2 + 2, 1, 0, -half - 0.5);
    mkWall(half * 2 + 2, 1, 0, half + 0.5);
    mkWall(1, half * 2 + 2, -half - 0.5, 0);
    mkWall(1, half * 2 + 2, half + 0.5, 0);
    const neonMat = new T.MeshStandardMaterial({ color: 0x0b3540, emissive: 0x35e0ff, emissiveIntensity: 1.5 });
    for (const [w, d, x, z] of [[half * 2 + 2, 0.3, 0, -half - 0.5], [half * 2 + 2, 0.3, 0, half + 0.5], [0.3, half * 2 + 2, -half - 0.5, 0], [0.3, half * 2 + 2, half + 0.5, 0]]) {
      const m = new T.Mesh(new T.BoxGeometry(w, 0.15, d), neonMat);
      m.position.set(x, map.wallH + 0.08, z);
      scene.add(m);
    }
    // 角落光柱 + 夜间点光
    const pylonMat = new T.MeshStandardMaterial({ color: 0x101828, emissive: 0xff4d9d, emissiveIntensity: 1.2 });
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const p = new T.Mesh(new T.CylinderGeometry(0.35, 0.5, 9, 8), pylonMat);
      p.position.set(sx * (half - 1.2), 4.5, sz * (half - 1.2));
      scene.add(p);
      const pl = new T.PointLight(0xff6db0, 0.8, 22);
      pl.position.set(sx * (half - 2.5), 5, sz * (half - 2.5));
      scene.add(pl);
      pylonLights.push(pl);
    }

    // 障碍物（wall/crate/barrier/platform/step）
    const crateMat = new T.MeshStandardMaterial({ map: crateTex(), roughness: 0.85 });
    const barrierMat = new T.MeshStandardMaterial({ color: 0x9aa7bd, roughness: 0.7 });
    const stripeMat = new T.MeshStandardMaterial({ color: 0xffb02e, emissive: 0x663d00, emissiveIntensity: 0.3 });
    const plateMat = new T.MeshStandardMaterial({ map: plateTex(), roughness: 0.6, metalness: 0.35 });
    const stepMat = new T.MeshStandardMaterial({ color: 0x46505f, roughness: 0.7, metalness: 0.25 });
    const wallObMat = new T.MeshStandardMaterial({ map: wt.clone(), roughness: 0.85 });
    wallObMat.map.repeat.set(3, 1); wallObMat.map.needsUpdate = true;
    const rampMat = new T.MeshStandardMaterial({ color: 0x586373, roughness: 0.72, metalness: 0.24, side: T.DoubleSide });

    for (const r of ramps) {
      const mesh = new T.Mesh(rampGeometry(r), rampMat);
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
    }

    for (const o of map.obstacles) {
      if (o.kind === 'rampslice') continue;
      const mat = o.kind === 'crate' ? crateMat
        : o.kind === 'barrier' ? barrierMat
        : o.kind === 'platform' ? plateMat
        : o.kind === 'step' ? stepMat
        : wallObMat;
      const mesh = new T.Mesh(new T.BoxGeometry(o.w, o.h, o.d), mat);
      mesh.position.set(o.x, o.h / 2, o.z);
      if (o.kind === 'barrier') {
        const s = new T.Mesh(new T.BoxGeometry(o.w + 0.02, 0.18, o.d + 0.02), stripeMat);
        s.position.set(o.x, o.h - 0.2, o.z);
        scene.add(s);
      }
      if (o.kind === 'platform') { // 平台边缘霓虹描边
        const edge = new T.Mesh(new T.BoxGeometry(o.w + 0.06, 0.1, o.d + 0.06),
          new T.MeshStandardMaterial({ color: 0x0b3540, emissive: 0x35e0ff, emissiveIntensity: 0.9 }));
        edge.position.set(o.x, o.h - 0.04, o.z);
        scene.add(edge);
      }
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
      colliders.push({ minx: o.x - o.w / 2, maxx: o.x + o.w / 2, minz: o.z - o.d / 2, maxz: o.z + o.d / 2, miny: 0, maxy: o.h });
    }

    // 可摧毁油桶
    barrels = map.barrels.map((b) => {
      const group = G.models.makeBarrel(barrelR, barrelH);
      group.position.set(b.x, 0, b.z);
      scene.add(group);
      return { x: b.x, z: b.z, alive: true, group };
    });

    return colliders;
  }

  function setBarrels(aliveArr) {
    for (let i = 0; i < barrels.length && i < aliveArr.length; i++) {
      barrels[i].alive = !!aliveArr[i];
      barrels[i].group.visible = barrels[i].alive;
    }
  }
  function barrelAt(i) { return barrels[i]; }

  // ---------- 昼夜循环 ----------
  const C = (hex) => new T.Color(hex);
  const NIGHT = { top: C(0x071226), hor: C(0x1c3450), bot: C(0x140b24), fog: C(0x0a0e1a), sunC: C(0xaac4ec), hemiS: C(0x6f94c8), hemiG: C(0x100c1c) };
  const DAY   = { top: C(0x245798), hor: C(0x7fb0d0), bot: C(0x3c617f), fog: C(0x668aa6), sunC: C(0xf1dfbd), hemiS: C(0x9fbfdf), hemiG: C(0x3d4652) };
  const DAWN_H = C(0xff9450), DAWN_TOP = C(0x345d86), DAWN_SUN = C(0xffb15c), DAWN_FOG = C(0x665a50);
  const tmpA = new T.Color(), tmpB = new T.Color();

  function setDay(dayT, scene) {
    if (!skyMat) return;
    const ang = dayT * Math.PI * 2 - Math.PI / 2;   // dayT=0 深夜, 0.5 正午
    const sunH = Math.sin(ang);
    let s = Math.min(1, Math.max(0, (sunH + 0.16) / 0.52));
    const dayK = s * s * (3 - 2 * s);
    const band = Math.max(0, 1 - Math.abs(sunH) / 0.42);
    const dawn = band * band * (3 - 2 * band);

    skyMat.uniforms.top.value.copy(tmpA.copy(NIGHT.top).lerp(DAY.top, dayK).lerp(DAWN_TOP, dawn * 0.28));
    skyMat.uniforms.horizon.value.copy(tmpA.copy(NIGHT.hor).lerp(DAY.hor, dayK).lerp(DAWN_H, dawn * 0.76));
    skyMat.uniforms.bottom.value.copy(tmpA.copy(NIGHT.bot).lerp(DAY.bot, dayK).lerp(DAWN_H, dawn * 0.26));
    tmpB.copy(NIGHT.fog).lerp(DAY.fog, dayK).lerp(DAWN_FOG, dawn * 0.48);
    scene.fog.color.copy(tmpB);
    scene.background.copy(tmpB);

    hemi.intensity = 0.48 + dayK * 0.26 + dawn * 0.08;
    hemi.color.copy(tmpA.copy(NIGHT.hemiS).lerp(DAY.hemiS, dayK));
    hemi.groundColor.copy(tmpA.copy(NIGHT.hemiG).lerp(DAY.hemiG, dayK));
    const dirIntensity = 0.34 + dayK * 0.46 + dawn * 0.12;
    sun.intensity = dirIntensity * dayK;
    moonLight.intensity = dirIntensity * (1 - dayK);
    sun.color.copy(tmpA.copy(DAY.sunC).lerp(DAWN_SUN, dawn * 0.8));
    moonLight.color.copy(NIGHT.sunC);

    const sx = Math.cos(ang) * 70, sy = Math.sin(ang) * 80, sz = -35;
    sun.position.set(sx, Math.max(12, sy), sz);
    moonLight.position.set(-sx, Math.max(12, -sy), sz);
    sunMesh.position.set(sx * 2.4, sy * 2.4, sz * 2.4);
    sunMesh.visible = sunH > -0.05;
    moonMesh.position.set(-sx * 2.2, -sy * 2.2, sz * 2.2);
    moonMesh.visible = sunH < 0.05;
    stars.material.opacity = Math.max(0, 1 - dayK * 1.4);
    for (const pl of pylonLights) pl.intensity = 0.15 + (1 - dayK) * 0.75;
    for (const cl of clouds) cl.material.opacity = 0.08 + dayK * 0.3;

    const rising = Math.cos(ang) > 0;
    dayInfoCache = dayK > 0.85 ? { icon: '☀️', phase: '白天', k: dayK }
      : dayK < 0.12 ? { icon: '🌙', phase: '深夜', k: dayK }
      : rising ? { icon: '🌅', phase: '清晨', k: dayK } : { icon: '🌇', phase: '黄昏', k: dayK };
  }
  function dayInfo() { return dayInfoCache; }

  function updateAmbient(dt, camPos) {
    for (const cl of clouds) {
      cl.position.x += cl.userData.speed * dt;
      if (cl.position.x > 190) cl.position.x = -190;
    }
    if (dust) {
      const arr = dust.geometry.attributes.position.array;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i + 1] += dt * 0.18;
        if (arr[i + 1] > 4.5) arr[i + 1] = 0.3;
      }
      dust.geometry.attributes.position.needsUpdate = true;
    }
  }

  // ---------- 玩家移动碰撞（xz 分轴推挤 + 顶面站立；含存活油桶） ----------
  const R = 0.45;
  function eachBox(fn) {
    for (const b of colliders) fn(b);
    for (const br of barrels) {
      if (!br.alive) continue;
      fn({ minx: br.x - barrelR, maxx: br.x + barrelR, minz: br.z - barrelR, maxz: br.z + barrelR, miny: 0, maxy: barrelH });
    }
  }
  function collideAxis(pos, axis) {
    eachBox(b => {
      const rh = rampHeightAt(pos, R * 0.8);
      const standY = rh === null ? pos.y : Math.max(pos.y, rh);
      if (standY >= b.maxy - RAMP_STEP_UP) return;
      if (pos.y + 1.7 <= b.miny) return;
      if (pos.x > b.minx - R && pos.x < b.maxx + R && pos.z > b.minz - R && pos.z < b.maxz + R) {
        if (axis === 'x') pos.x = (pos.x - (b.minx + b.maxx) / 2) > 0 ? b.maxx + R : b.minx - R;
        else pos.z = (pos.z - (b.minz + b.maxz) / 2) > 0 ? b.maxz + R : b.minz - R;
      }
    });
    collideRampSides(pos, axis);
  }
  function floorAt(pos) {
    let f = 0;
    const rh = rampHeightAt(pos, R * 0.45);
    if (rh !== null && rh <= pos.y + 0.65) f = rh;
    eachBox(b => {
      if (pos.x > b.minx - R * 0.7 && pos.x < b.maxx + R * 0.7 && pos.z > b.minz - R * 0.7 && pos.z < b.maxz + R * 0.7) {
        if (b.maxy <= pos.y + 0.45 && b.maxy > f) f = b.maxy;
      }
    });
    return f;
  }
  function moveStep(pos, dx, dz) {
    const lim = half - 0.55;
    pos.x += dx; collideAxis(pos, 'x');
    pos.z += dz; collideAxis(pos, 'z');
    pos.x = Math.max(-lim, Math.min(lim, pos.x));
    pos.z = Math.max(-lim, Math.min(lim, pos.z));
  }

  // 客户端射线（曳光弹终点预测 / 第三人称相机遮挡）
  function rayObstacles(o, d, maxT) {
    let t = maxT;
    const hitBox = (b) => {
      let tmin = 0, tmax = Infinity, miss = false;
      const P = [['x', b.minx, b.maxx], ['y', b.miny, b.maxy], ['z', b.minz, b.maxz]];
      for (const [ax, mn, mx] of P) {
        const ro = o[ax], rd = d[ax];
        if (Math.abs(rd) < 1e-9) { if (ro < mn || ro > mx) { miss = true; break; } continue; }
        let t1 = (mn - ro) / rd, t2 = (mx - ro) / rd;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) { miss = true; break; }
      }
      if (!miss && tmin < t && tmin > 0) t = tmin;
    };
    eachBox(hitBox);
    for (const r of ramps) hitBox(rampBounds(r));
    for (const [ax, sign] of [['x', 1], ['x', -1], ['z', 1], ['z', -1]]) {
      const rd = d[ax], ro = o[ax];
      if (Math.abs(rd) > 1e-9) {
        const tw = (sign * half - ro) / rd;
        if (tw > 0 && tw < t) {
          const py = o.y + d.y * tw;
          if (py < 6 && py > 0) t = tw;
        }
      }
    }
    return t;
  }

  return {
    build, moveStep, floorAt, rayObstacles, setBarrels, barrelAt,
    setDay, dayInfo, updateAmbient,
    get colliders() { return colliders; }, get half() { return half; },
  };
})();

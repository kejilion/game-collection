// 场景构建：天空 / 地面 / 围墙 / 障碍物 / 光照 + 玩家移动碰撞
window.G = window.G || {};
G.world = (function () {
  const T = THREE;
  let colliders = [];   // {minx,maxx,miny,maxy,minz,maxz}
  let half = 35;

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
      // 地砖
      x.strokeStyle = 'rgba(90,110,150,.35)'; x.lineWidth = 2;
      x.strokeRect(1, 1, 254, 254);
      x.strokeStyle = 'rgba(60,75,105,.3)'; x.lineWidth = 1;
      x.beginPath(); x.moveTo(128, 0); x.lineTo(128, 256); x.moveTo(0, 128); x.lineTo(256, 128); x.stroke();
      // 噪点
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

  function build(scene, map) {
    half = map.half;
    colliders = [];

    // 雾与背景
    scene.fog = new T.Fog(0x0a0e1a, 50, 150);
    scene.background = new T.Color(0x0a0e1a);

    // 天空穹顶（顶点渐变）
    const skyGeo = new T.SphereGeometry(220, 24, 12);
    const skyMat = new T.ShaderMaterial({
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
    scene.add(new T.Points(starGeo, new T.PointsMaterial({ color: 0xbfd8ff, size: 0.7, fog: false, sizeAttenuation: false })));
    // 月亮
    const moon = new T.Mesh(new T.SphereGeometry(9, 16, 16), new T.MeshBasicMaterial({ color: 0xdfe8ff, fog: false }));
    moon.position.set(120, 90, -140);
    scene.add(moon);

    // 光照
    scene.add(new T.HemisphereLight(0x6f94c8, 0x100c1c, 0.45));
    const sun = new T.DirectionalLight(0xaac4ec, 0.8);
    sun.position.set(40, 60, -30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -45; sun.shadow.camera.right = 45;
    sun.shadow.camera.top = 45; sun.shadow.camera.bottom = -45;
    sun.shadow.camera.far = 160;
    sun.shadow.bias = -0.0004;
    scene.add(sun);

    // 地面
    const ground = new T.Mesh(new T.PlaneGeometry(half * 2, half * 2),
      new T.MeshStandardMaterial({ map: groundTex(), roughness: 0.9 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    // 场外延伸地面（暗色）
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
    // 墙顶霓虹条
    const neonMat = new T.MeshStandardMaterial({ color: 0x0b3540, emissive: 0x35e0ff, emissiveIntensity: 1.5 });
    for (const [w, d, x, z] of [[half * 2 + 2, 0.3, 0, -half - 0.5], [half * 2 + 2, 0.3, 0, half + 0.5], [0.3, half * 2 + 2, -half - 0.5, 0], [0.3, half * 2 + 2, half + 0.5, 0]]) {
      const m = new T.Mesh(new T.BoxGeometry(w, 0.15, d), neonMat);
      m.position.set(x, map.wallH + 0.08, z);
      scene.add(m);
    }
    // 角落光柱
    const pylonMat = new T.MeshStandardMaterial({ color: 0x101828, emissive: 0xff4d9d, emissiveIntensity: 1.2 });
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const p = new T.Mesh(new T.CylinderGeometry(0.35, 0.5, 9, 8), pylonMat);
      p.position.set(sx * (half - 1.2), 4.5, sz * (half - 1.2));
      scene.add(p);
    }

    // 障碍物
    const crateMat = new T.MeshStandardMaterial({ map: crateTex(), roughness: 0.85 });
    const barrierMat = new T.MeshStandardMaterial({ color: 0x9aa7bd, roughness: 0.7 });
    const stripeMat = new T.MeshStandardMaterial({ color: 0xffb02e, emissive: 0x663d00, emissiveIntensity: 0.3 });
    const barrelMat = new T.MeshStandardMaterial({ color: 0xb03a2e, roughness: 0.6, metalness: 0.3 });
    const wallObMat = new T.MeshStandardMaterial({ map: wt.clone(), roughness: 0.85 });
    wallObMat.map.repeat.set(3, 1); wallObMat.map.needsUpdate = true;

    for (const o of map.obstacles) {
      let mesh;
      if (o.t === 'cyl') {
        mesh = new T.Mesh(new T.CylinderGeometry(o.r, o.r, o.h, 14), barrelMat);
        mesh.position.set(o.x, o.h / 2, o.z);
        const band = new T.Mesh(new T.CylinderGeometry(o.r + 0.02, o.r + 0.02, 0.12, 14),
          new T.MeshStandardMaterial({ color: 0xd8d8d8, metalness: 0.6 }));
        band.position.set(o.x, o.h * 0.6, o.z);
        band.castShadow = true; scene.add(band);
        colliders.push({ minx: o.x - o.r, maxx: o.x + o.r, minz: o.z - o.r, maxz: o.z + o.r, miny: 0, maxy: o.h });
      } else {
        const mat = o.kind === 'crate' ? crateMat : o.kind === 'barrier' ? barrierMat : wallObMat;
        mesh = new T.Mesh(new T.BoxGeometry(o.w, o.h, o.d), mat);
        mesh.position.set(o.x, o.h / 2, o.z);
        if (o.kind === 'barrier') {
          const s = new T.Mesh(new T.BoxGeometry(o.w + 0.02, 0.18, o.d + 0.02), stripeMat);
          s.position.set(o.x, o.h - 0.2, o.z);
          scene.add(s);
        }
        colliders.push({ minx: o.x - o.w / 2, maxx: o.x + o.w / 2, minz: o.z - o.d / 2, maxz: o.z + o.d / 2, miny: 0, maxy: o.h });
      }
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
    }
    return colliders;
  }

  // ---------- 玩家移动碰撞（xz 分轴推挤 + 顶面站立） ----------
  const R = 0.45;
  function collideAxis(pos, axis) {
    for (const b of colliders) {
      if (pos.y >= b.maxy - 0.03) continue;                 // 站在顶上不阻挡
      if (pos.y + 1.7 <= b.miny) continue;
      if (pos.x > b.minx - R && pos.x < b.maxx + R && pos.z > b.minz - R && pos.z < b.maxz + R) {
        if (axis === 'x') pos.x = (pos.x - (b.minx + b.maxx) / 2) > 0 ? b.maxx + R : b.minx - R;
        else pos.z = (pos.z - (b.minz + b.maxz) / 2) > 0 ? b.maxz + R : b.minz - R;
      }
    }
  }
  function floorAt(pos) {
    let f = 0;
    for (const b of colliders) {
      if (pos.x > b.minx - R * 0.7 && pos.x < b.maxx + R * 0.7 && pos.z > b.minz - R * 0.7 && pos.z < b.maxz + R * 0.7) {
        if (b.maxy <= pos.y + 0.45 && b.maxy > f) f = b.maxy;
      }
    }
    return f;
  }
  // 移动一步：dx/dz 位移，重力与落地由调用方处理竖直速度
  function moveStep(pos, dx, dz) {
    const lim = half - 0.55;
    pos.x += dx; collideAxis(pos, 'x');
    pos.z += dz; collideAxis(pos, 'z');
    pos.x = Math.max(-lim, Math.min(lim, pos.x));
    pos.z = Math.max(-lim, Math.min(lim, pos.z));
  }

  // 客户端射线（自己开枪的曳光弹终点预测）：AABB + 玩家球体
  function rayObstacles(o, d, maxT) {
    let t = maxT;
    for (const b of colliders) {
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
    }
    // 围墙
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

  return { build, moveStep, floorAt, rayObstacles, get colliders() { return colliders; }, get half() { return half; } };
})();

// ============================================================================
//  Canvas renderer.  Draws the frosty backdrop, the tower (platforms by type),
//  items, monsters, projectiles, icicles, players (procedural cartoon art),
//  the rescue plane and a particle FX system.  Vertical camera follows the
//  local climber.
// ============================================================================
import {
  WORLD_WIDTH, WORLD_HEIGHT, FLOOR_COUNT, GROUND_THICKNESS, PLAYER_H, PLAYER_W,
  floorTopY, Tile, PLANE_Y, PICKUP_W, PICKUP_H, ItemKind,
} from '../shared/constants.js';
import { buildRects } from '../shared/physics.js';
import { drawClimber } from './characters.js';

const VIEW_W = 960;
const VIEW_H = 600;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.phases = new Map(); // id → run-cycle phase
    this.flakes = Array.from({ length: 70 }, () => ({
      x: Math.random() * VIEW_W, y: Math.random() * VIEW_H,
      r: 0.6 + Math.random() * 2, sp: 12 + Math.random() * 26, drift: Math.random() * 2 - 1,
    }));
    // --- ambient backdrop layers (screen-space, parallax-free) ---
    // twinkling stars — only shown in the dark lower reaches
    this.stars = Array.from({ length: 90 }, () => ({
      x: Math.random() * VIEW_W, y: Math.random() * VIEW_H * 0.82,
      r: 0.5 + Math.random() * 1.5, tw: 1 + Math.random() * 3, ph: Math.random() * 7,
      b: 0.5 + Math.random() * 0.5,
      c: Math.random() < 0.25 ? '#bcd2ff' : (Math.random() < 0.5 ? '#ffe7c0' : '#ffffff'),
    }));
    // slow aurora ribbons — dreamy near the bottom, faint up high
    this.aurora = [
      { y: 0.18, sp: 0.26, ph: 0.0, a: 0.50, c: '#54ffcf' },
      { y: 0.30, sp: 0.18, ph: 2.2, a: 0.42, c: '#8a7bff' },
      { y: 0.12, sp: 0.33, ph: 4.1, a: 0.30, c: '#74d4ff' },
    ];
    // drifting dreamy light motes (soft bokeh that rises and wraps)
    this.motes = Array.from({ length: 26 }, () => ({
      x: Math.random() * VIEW_W, y: Math.random() * VIEW_H,
      r: 14 + Math.random() * 42, sp: 5 + Math.random() * 16,
      a: 0.10 + Math.random() * 0.22, pls: 0.4 + Math.random() * 1.5, ph: Math.random() * 7,
      c: ['rgba(150,200,255,0.9)', 'rgba(190,160,255,0.9)', 'rgba(255,220,180,0.85)', 'rgba(160,255,230,0.85)'][(Math.random() * 4) | 0],
    }));
    this.cameraY = 0;
    this.t = 0;
    this._p = 0; // altitude progress 0(bottom)…1(top), set each frame
  }

  // ----- particle FX --------------------------------------------------------
  addFx(fx) {
    const P = this.particles;
    switch (fx.t) {
      case 'ice':
        for (let i = 0; i < 14; i++) P.push(shard(fx.x, fx.y, '#bfeaff'));
        break;
      case 'shatter':
        for (let i = 0; i < 8; i++) P.push(shard(fx.x, fx.y, '#eaffff'));
        break;
      case 'hit':
        for (let i = 0; i < 6; i++) P.push(spark(fx.x, fx.y, '#ffd36b'));
        if (fx.dmg) P.push(dmgText(fx.x, fx.y, '-' + fx.dmg, '#ff5a5a'));
        break;
      case 'mhit':
        for (let i = 0; i < 5; i++) P.push(spark(fx.x, fx.y, '#fff'));
        break;
      case 'mdeath':
        for (let i = 0; i < 12; i++) P.push(spark(fx.x, fx.y, '#9fd9ff'));
        break;
      case 'death':
        for (let i = 0; i < 16; i++) P.push(spark(fx.x, fx.y - PLAYER_H / 2, '#cfe6ff'));
        P.push(dmgText(fx.x, fx.y - PLAYER_H, '💥', '#fff', 22));
        break;
      case 'pickup': {
        const c = fx.kind === ItemKind.FIRE ? '#ff7a3c' : fx.kind === ItemKind.HEAL ? '#ff5a7a' : '#5ad1ff';
        for (let i = 0; i < 12; i++) P.push(sparkle(fx.x, fx.y, c));
        break;
      }
      case 'pop': {
        const c = fx.kind === 'fire' ? '#ff8a3c' : '#7fe3ff';
        for (let i = 0; i < 8; i++) P.push(spark(fx.x, fx.y, c));
        break;
      }
      case 'rescue':
        for (let i = 0; i < 26; i++) P.push(confetti(fx.x, fx.y - 20));
        break;
      default: break;
    }
  }

  update(dt) {
    this.t += dt;
    for (const f of this.flakes) {
      f.y += f.sp * dt; f.x += f.drift * 12 * dt;
      if (f.y > VIEW_H) { f.y = -4; f.x = Math.random() * VIEW_W; }
    }
    for (const m of this.motes) {
      m.y -= m.sp * dt; m.x += Math.sin(this.t * 0.3 + m.ph) * 5 * dt;
      if (m.y < -m.r) { m.y = VIEW_H + m.r; m.x = Math.random() * VIEW_W; }
    }
    const P = this.particles;
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.life -= dt;
      if (p.life <= 0) { P.splice(i, 1); continue; }
      p.vy += (p.gravity || 0) * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.spin) p.rot += p.spin * dt;
    }
  }

  // ----- main draw ----------------------------------------------------------
  draw(scene, dt) {
    const ctx = this.ctx;
    const { level, brokenIce, tEst, local } = scene;

    // camera follows local climber (or stays low before we have one)
    const focusY = local ? local.y : floorTopY(0);
    const targetCam = clamp(focusY - VIEW_H * 0.62, 0, WORLD_HEIGHT - VIEW_H);
    this.cameraY += (targetCam - this.cameraY) * Math.min(1, dt * 8);
    const cam = this.cameraY;

    this._background(ctx, cam);

    ctx.save();
    ctx.translate(0, -cam);

    this._floorLabels(ctx);
    const rects = buildRects(level.platforms, brokenIce, tEst);
    for (const r of rects) this._platform(ctx, r);

    if (scene.remote) {
      for (const it of scene.remote.items) this._item(ctx, it);
      for (const ic of scene.remote.ice) this._icicle(ctx, ic);
      for (const m of scene.remote.monsters) this._monster(ctx, m, dt);
      for (const pr of scene.remote.proj) this._proj(ctx, pr);
    }

    // players: remotes (interpolated) then local (predicted) on top
    const drawn = new Set();
    if (scene.remote) {
      for (const e of scene.remote.players) {
        if (e.id === scene.selfId) continue;
        this._player(ctx, e, e.look, e.name, dt, false);
        drawn.add(e.id);
      }
    }
    if (local && scene.localServer) {
      this._player(ctx, {
        x: local.x, y: local.y, vx: local.vx, vy: local.vy,
        f: local.facing, g: local.onGround ? 1 : 0,
        hp: scene.localServer.hp, stun: scene.localServer.stun,
        inv: scene.localServer.inv, atk: scene.localServer.atk,
        jb: scene.localServer.jb, fb: scene.localServer.fb,
        res: scene.localServer.res, lift: scene.localServer.lift,
        id: scene.selfId,
      }, scene.localLook, scene.localName, dt, true);
    }

    if (scene.remote && scene.remote.plane) this._plane(ctx, scene.remote.plane, local);

    this._particles(ctx);

    ctx.restore();
    this._snow(ctx);
  }

  // ----- backdrop -----------------------------------------------------------
  //  Altitude drives the whole mood: the depths are dark, dreamy and starlit;
  //  the climb brightens floor by floor into a hopeful dawn at the summit.
  _background(ctx, cam) {
    const maxCam = Math.max(1, WORLD_HEIGHT - VIEW_H);
    const p = clamp(1 - cam / maxCam, 0, 1); // 0 = bottom (dark) → 1 = top (bright)
    this._p = p;
    const ease = p * p * (3 - 2 * p); // smoothstep

    // sky: deep dreamy night → bright hopeful dawn
    const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    g.addColorStop(0, mix('#0a0e2a', '#5fb0ff', ease));
    g.addColorStop(0.55, mix('#1a1640', '#b9e6ff', ease));
    g.addColorStop(1, mix('#2a1b46', '#f0fbff', ease));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // twinkling stars (lower reaches only)
    const starA = clamp(1 - p * 1.7, 0, 1);
    if (starA > 0.01) {
      for (const s of this.stars) {
        const tw = 0.55 + 0.45 * Math.sin(this.t * s.tw + s.ph);
        ctx.globalAlpha = starA * tw * s.b;
        ctx.fillStyle = s.c;
        circle(ctx, s.x, s.y, s.r); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // aurora ribbons — strongest in the dreamy depths, a faint shimmer up top
    const auroraA = clamp(0.8 - p * 0.62, 0.1, 0.8);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const r of this.aurora) {
      const yb = VIEW_H * r.y + Math.sin(this.t * r.sp + r.ph) * 18;
      const grd = ctx.createLinearGradient(0, yb - 80, 0, yb + 80);
      grd.addColorStop(0, 'rgba(0,0,0,0)');
      grd.addColorStop(0.5, mixA(r.c, auroraA * r.a));
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.moveTo(0, yb + 80);
      for (let x = 0; x <= VIEW_W; x += 40) {
        const yy = yb + Math.sin(x * 0.012 + this.t * r.sp + r.ph) * 24 + Math.sin(x * 0.03 - this.t * r.sp) * 9;
        ctx.lineTo(x, yy);
      }
      ctx.lineTo(VIEW_W, yb + 80);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();

    // a glow of "hope" that swells toward the summit (warm dawn + soft god-rays)
    const hope = clamp((p - 0.4) / 0.6, 0, 1);
    if (hope > 0.01) {
      const hx = VIEW_W * 0.5, hy = VIEW_H * 0.1;
      const rg = ctx.createRadialGradient(hx, hy, 0, hx, hy, VIEW_H);
      rg.addColorStop(0, `rgba(255,248,216,${0.5 * hope})`);
      rg.addColorStop(0.4, `rgba(255,226,168,${0.2 * hope})`);
      rg.addColorStop(1, 'rgba(255,226,168,0)');
      ctx.fillStyle = rg; ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(hx, hy);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + this.t * 0.05;
        const w = 24 + Math.sin(this.t * 0.7 + i) * 12;
        ctx.fillStyle = `rgba(255,250,224,${0.05 * hope})`;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * 960 - w, Math.sin(a) * 960);
        ctx.lineTo(Math.cos(a) * 960 + w, Math.sin(a) * 960);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }

    // drifting dreamy motes (soft bokeh, denser in the depths)
    const moteA = clamp(0.78 - p * 0.5, 0.16, 0.78);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const m of this.motes) {
      ctx.globalAlpha = moteA * m.a * (0.6 + 0.4 * Math.sin(this.t * m.pls + m.ph));
      const rg = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r);
      rg.addColorStop(0, m.c);
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = rg;
      circle(ctx, m.x, m.y, m.r); ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // parallax peaks — dark silhouettes below, bright snowy ridges up high
    this._peaks(ctx, cam * 0.18, mix('#171f4a', '#cfe7f6', ease), 360, 150, ease);
    this._peaks(ctx, cam * 0.32, mix('#221a44', '#bcdcf0', ease), 300, 230, ease);
  }

  _peaks(ctx, off, color, base, height, ease = 1) {
    const y = VIEW_H - 110 + (off % VIEW_H);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, VIEW_H);
    for (let x = -100; x <= VIEW_W + 100; x += base) {
      ctx.lineTo(x + base / 2, y - height + Math.sin(x) * 12);
      ctx.lineTo(x + base, y);
    }
    ctx.lineTo(VIEW_W, VIEW_H);
    ctx.closePath();
    ctx.fill();
    // snow caps — bright at the hopeful summit, dim in the dark depths
    ctx.fillStyle = `rgba(255,255,255,${0.22 + 0.55 * ease})`;
    for (let x = -100; x <= VIEW_W + 100; x += base) {
      const px = x + base / 2; const py = y - height + Math.sin(x) * 12;
      ctx.beginPath();
      ctx.moveTo(px - 22, py + 30); ctx.lineTo(px, py); ctx.lineTo(px + 22, py + 30);
      ctx.quadraticCurveTo(px, py + 16, px - 22, py + 30);
      ctx.fill();
    }
  }

  _snow(ctx) {
    ctx.fillStyle = `rgba(255,255,255,${0.5 + 0.4 * this._p})`;
    for (const f of this.flakes) { ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 7); ctx.fill(); }
  }

  _floorLabels(ctx) {
    ctx.font = '700 12px system-ui';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < FLOOR_COUNT; i++) {
      const y = floorTopY(i);
      ctx.fillStyle = 'rgba(20,50,80,.35)';
      ctx.fillRect(0, y - 9, 30, 18);
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.fillText((i + 1) + 'F', 5, y + 1);
    }
  }

  // ----- platforms ----------------------------------------------------------
  _platform(ctx, r) {
    if (r.type === Tile.GROUND) return this._ground(ctx, r);
    const { x, y, w, h } = r;
    if (r.type === Tile.ICE) {
      // a breakable ice brick — a row of these forms a wall to bust through
      roundRect(ctx, x, y, w, h, 4);
      ctx.fillStyle = 'rgba(173, 230, 255, .9)';
      ctx.fill();
      ctx.strokeStyle = '#7fc6ef'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      roundRect(ctx, x + 3, y + 3, w - 6, 5, 3); ctx.fill();
      // shaded lower lip for depth + faint internal fractures
      ctx.fillStyle = 'rgba(96,160,205,.35)';
      ctx.fillRect(x + 2, y + h - 4, w - 4, 3);
      ctx.strokeStyle = 'rgba(120,190,230,.6)'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + w * 0.3, y + 4); ctx.lineTo(x + w * 0.45, y + h - 4);
      ctx.moveTo(x + w * 0.7, y + 5); ctx.lineTo(x + w * 0.6, y + h - 3);
      ctx.stroke();
    } else if (r.type === Tile.MOVING) {
      roundRect(ctx, x, y, w, h, 6);
      ctx.fillStyle = '#8a6b4a'; ctx.fill();
      ctx.strokeStyle = '#5e4730'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#a98257'; roundRect(ctx, x + 2, y + 2, w - 4, 6, 3); ctx.fill();
      // bolts + chevrons
      ctx.fillStyle = '#3c2e1f';
      circle(ctx, x + 6, y + h - 6, 1.7); ctx.fill();
      circle(ctx, x + w - 6, y + h - 6, 1.7); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 2;
      const cx = x + w / 2; const dir = r.vx >= 0 ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(cx - 5 * dir, y + h / 2 - 4); ctx.lineTo(cx + 3 * dir, y + h / 2);
      ctx.lineTo(cx - 5 * dir, y + h / 2 + 4); ctx.stroke();
    } else if (r.type === Tile.SPEED) {
      roundRect(ctx, x, y, w, h, 6);
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, '#7fe6ff'); g.addColorStop(1, '#2aa9e0');
      ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = '#1d87bd'; ctx.lineWidth = 2; ctx.stroke();
      // motion chevrons
      ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 2.4;
      const phase = (this.t * 60) % 24;
      for (let cx = x + 6 - phase; cx < x + w - 4; cx += 24) {
        ctx.beginPath();
        ctx.moveTo(cx, y + 6); ctx.lineTo(cx + 7, y + h / 2); ctx.lineTo(cx, y + h - 6);
        ctx.stroke();
      }
    } else { // SOLID rock — an unbreakable brick, route around it
      roundRect(ctx, x, y, w, h, 4);
      ctx.fillStyle = '#8b95a1'; ctx.fill();
      ctx.strokeStyle = '#5f6976'; ctx.lineWidth = 2; ctx.stroke();
      // thin frosted top + pebble speckle
      ctx.fillStyle = '#eef6fb';
      roundRect(ctx, x + 1, y, w - 2, 5, 3); ctx.fill();
      ctx.fillStyle = 'rgba(60,70,85,.5)';
      circle(ctx, x + w * 0.3, y + h - 8, 2); ctx.fill();
      circle(ctx, x + w * 0.65, y + h - 7, 1.6); ctx.fill();
    }
  }

  _ground(ctx, r) {
    ctx.fillStyle = '#6f4a32';
    ctx.fillRect(r.x, r.y + 10, r.w, r.h);
    ctx.fillStyle = '#7d5639';
    for (let x = r.x; x < r.x + r.w; x += 46) ctx.fillRect(x, r.y + 10, 3, r.h);
    // thick snow top
    ctx.fillStyle = '#f6fcff';
    roundRect(ctx, r.x, r.y - 4, r.w, 22, 10); ctx.fill();
    ctx.fillStyle = '#e3f1fb';
    for (let x = r.x + 20; x < r.x + r.w; x += 80) { circle(ctx, x, r.y + 16, 12); ctx.fill(); }
  }

  // ----- items / monsters / projectiles / icicles ---------------------------
  _item(ctx, it) {
    const bob = Math.sin(this.t * 3 + it.x) * 4;
    const x = it.x, y = it.y + bob;
    ctx.save();
    // glow
    const c = it.kind === ItemKind.FIRE ? '#ff7a3c' : it.kind === ItemKind.HEAL ? '#ff5a7a' : '#5ad1ff';
    ctx.shadowColor = c; ctx.shadowBlur = 14;
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    circle(ctx, x, y, 13); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.font = '16px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const icon = it.kind === ItemKind.FIRE ? '🔥' : it.kind === ItemKind.HEAL ? '❤️' : '🦅';
    ctx.fillText(icon, x, y + 1);
    ctx.restore();
  }

  _monster(ctx, m, dt) {
    const x = m.x, y = m.y; // feet on ledge
    const ph = this._phase(m.id, dt, 80);
    const wob = Math.sin(ph) * 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(m.f || 1, 1);
    const caster = m.kind === 'caster';
    const body = caster ? '#b58bff' : '#dff1ff';
    const dark = caster ? '#7d54d6' : '#9cc4dd';
    // body
    ctx.fillStyle = body; ctx.strokeStyle = dark; ctx.lineWidth = 2;
    roundRect(ctx, -13, -26 + wob, 26, 26, 12); ctx.fill(); ctx.stroke();
    // fuzzy feet
    ctx.fillStyle = dark;
    circle(ctx, -7, -2, 4); ctx.fill(); circle(ctx, 7, -2, 4); ctx.fill();
    // eyes (angry)
    ctx.fillStyle = '#23303f';
    circle(ctx, -5, -16 + wob, 2.3); ctx.fill(); circle(ctx, 5, -16 + wob, 2.3); ctx.fill();
    ctx.strokeStyle = '#23303f'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(-8, -21 + wob); ctx.lineTo(-2, -19 + wob);
    ctx.moveTo(8, -21 + wob); ctx.lineTo(2, -19 + wob); ctx.stroke();
    // mouth / horns
    if (caster) {
      ctx.fillStyle = '#ffd36b';
      ctx.beginPath(); ctx.moveTo(-10, -26 + wob); ctx.lineTo(-13, -33 + wob); ctx.lineTo(-6, -27 + wob); ctx.fill();
      ctx.beginPath(); ctx.moveTo(10, -26 + wob); ctx.lineTo(13, -33 + wob); ctx.lineTo(6, -27 + wob); ctx.fill();
    } else {
      ctx.fillStyle = '#23303f';
      roundRect(ctx, -4, -11 + wob, 8, 4, 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillRect(-3, -11 + wob, 2, 2); ctx.fillRect(1, -11 + wob, 2, 2);
    }
    ctx.restore();
    // hp bar
    if (m.hp != null) this._bar(ctx, x - 14, y - 36, 28, 4, m.hp / 40, '#ff6b6b');
  }

  _proj(ctx, pr) {
    ctx.save();
    if (pr.kind === 'fire') {
      ctx.shadowColor = '#ff7a2c'; ctx.shadowBlur = 14;
      ctx.fillStyle = '#ffb24a'; circle(ctx, pr.x, pr.y, 7); ctx.fill();
      ctx.fillStyle = '#ff6a2c'; circle(ctx, pr.x, pr.y, 4); ctx.fill();
    } else {
      ctx.shadowColor = '#7fe3ff'; ctx.shadowBlur = 12;
      ctx.fillStyle = '#d7f6ff';
      ctx.translate(pr.x, pr.y);
      ctx.beginPath();
      ctx.moveTo(0, -7); ctx.lineTo(5, 0); ctx.lineTo(0, 7); ctx.lineTo(-5, 0);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  _icicle(ctx, ic) {
    ctx.save();
    ctx.fillStyle = 'rgba(220, 248, 255, .92)';
    ctx.strokeStyle = '#9fdcff'; ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(ic.x - 6, ic.y - 10);
    ctx.lineTo(ic.x + 6, ic.y - 10);
    ctx.lineTo(ic.x, ic.y + 12);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // ----- players ------------------------------------------------------------
  _player(ctx, e, look, name, dt, isLocal) {
    const feetY = e.y + PLAYER_H / 2;
    const moving = Math.abs(e.vx || 0) > 22;
    let anim = 'idle';
    if (e.res || e.lift) anim = 'idle';
    else if (!e.g) anim = (e.vy || 0) < 0 ? 'jump' : 'fall';
    else if (moving) anim = 'run';
    const ph = this._phase(e.id, dt, anim === 'run' ? 360 + Math.abs(e.vx) : 0);

    ctx.save();
    // invulnerability blink
    if (e.inv && !isLocal) ctx.globalAlpha = (Math.floor(this.t * 12) % 2) ? 0.45 : 0.95;
    else if (e.inv) ctx.globalAlpha = (Math.floor(this.t * 12) % 2) ? 0.6 : 1;

    ctx.translate(e.x, feetY);
    ctx.scale(e.f || 1, 1);
    drawClimber(ctx, look || {}, {
      anim, t: this.t, runPhase: ph,
      attack: e.atk ? 1 : 0,
      frozen: !!e.stun,
      blink: anim === 'idle' && Math.sin(this.t * 1.7 + hash(e.id)) > 0.985,
    }, 0.96);
    ctx.restore();

    // floating rescue ring
    if (e.res) {
      ctx.save(); ctx.globalAlpha = 0.8; ctx.strokeStyle = '#ffd84a'; ctx.lineWidth = 2;
      circle(ctx, e.x, feetY - PLAYER_H / 2, 22 + Math.sin(this.t * 6) * 2); ctx.stroke(); ctx.restore();
    }

    // name + hp + buff chips
    const topY = feetY - PLAYER_H - 16;
    ctx.font = '700 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(20,40,60,.85)';
    ctx.strokeText(name || '', e.x, topY);
    ctx.fillStyle = isLocal ? '#fff7c8' : '#fff';
    ctx.fillText(name || '', e.x, topY);
    if (e.hp != null && !e.res) this._bar(ctx, e.x - 16, topY + 2, 32, 4, e.hp / 100, '#56d06f');

    let bx = e.x + 18;
    if (e.fb) { ctx.font = '12px system-ui'; ctx.textAlign = 'left'; ctx.fillText('🔥', bx, topY + 2); bx += 14; }
    if (e.jb) { ctx.font = '12px system-ui'; ctx.textAlign = 'left'; ctx.fillText('🟢', bx, topY + 2); }
  }

  _plane(ctx, plane, local) {
    const x = plane.x, y = plane.y;
    // pickup glow zone
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = 'rgba(255, 230, 120, .85)';
    ctx.lineWidth = 2;
    const zx = x - PICKUP_W / 2, zy = PLANE_Y + 24;
    roundRect(ctx, zx, zy, PICKUP_W, PICKUP_H, 8); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255, 230, 120, .12)';
    ctx.fill();
    // rope
    ctx.strokeStyle = '#caa15f'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y + 12); ctx.lineTo(x, zy + PICKUP_H - 6); ctx.stroke();
    ctx.fillStyle = '#caa15f';
    for (let ry = y + 18; ry < zy + PICKUP_H; ry += 10) { ctx.fillRect(x - 5, ry, 10, 2); }
    ctx.restore();

    // plane body (cartoon rescue plane)
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(plane.dir >= 0 ? 1 : -1, 1);
    ctx.fillStyle = '#e8503f'; ctx.strokeStyle = '#b5392c'; ctx.lineWidth = 2;
    roundRect(ctx, -34, -14, 68, 24, 12); ctx.fill(); ctx.stroke();
    // tail
    ctx.beginPath(); ctx.moveTo(-30, -10); ctx.lineTo(-46, -22); ctx.lineTo(-30, -2); ctx.closePath();
    ctx.fillStyle = '#e8503f'; ctx.fill(); ctx.stroke();
    // window
    ctx.fillStyle = '#bfe9ff'; ctx.strokeStyle = '#5fa9d6';
    circle(ctx, 14, -3, 7); ctx.fill(); ctx.stroke();
    // wing
    ctx.fillStyle = '#cf4334'; roundRect(ctx, -6, 6, 26, 7, 3); ctx.fill();
    // propeller
    ctx.strokeStyle = '#33414f'; ctx.lineWidth = 3;
    const pa = this.t * 30;
    ctx.beginPath();
    ctx.moveTo(34, -10 + Math.sin(pa) * 8); ctx.lineTo(34, 6 - Math.sin(pa) * 8); ctx.stroke();
    ctx.restore();

    // hint arrow if local is at the top
    if (local && local.y < floorTopY(FLOOR_COUNT - 2)) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.font = '700 13px system-ui'; ctx.textAlign = 'center';
      const ay = zy + PICKUP_H + 18 + Math.sin(this.t * 5) * 3;
      ctx.fillText('↑ 跳进飞机逃生', x, ay);
      ctx.restore();
    }
  }

  // ----- helpers ------------------------------------------------------------
  _bar(ctx, x, y, w, h, frac, color) {
    frac = clamp(frac, 0, 1);
    ctx.fillStyle = 'rgba(20,40,60,.6)';
    roundRect(ctx, x - 1, y - 1, w + 2, h + 2, 3); ctx.fill();
    ctx.fillStyle = color;
    roundRect(ctx, x, y, w * frac, h, 2); ctx.fill();
  }

  _phase(id, dt, speed) {
    let v = this.phases.get(id) || 0;
    if (speed > 0) { v += dt * (6 + speed * 0.012); this.phases.set(id, v); }
    return v;
  }

  _particles(ctx) {
    for (const p of this.particles) {
      const a = clamp(p.life / p.maxLife, 0, 1);
      ctx.globalAlpha = a;
      if (p.kind === 'text') {
        ctx.font = `700 ${p.size}px system-ui`; ctx.textAlign = 'center'; ctx.fillStyle = p.color;
        ctx.fillText(p.text, p.x, p.y);
      } else if (p.kind === 'shard') {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot || 0);
        ctx.fillStyle = p.color; ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size); ctx.restore();
      } else {
        ctx.fillStyle = p.color; circle(ctx, p.x, p.y, p.size); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------- particles --
function shard(x, y, color) {
  const a = Math.random() * Math.PI * 2; const s = 60 + Math.random() * 120;
  return { kind: 'shard', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, gravity: 420,
    rot: Math.random() * 6, spin: Math.random() * 8 - 4, size: 3 + Math.random() * 3,
    color, life: 0.6 + Math.random() * 0.3, maxLife: 0.9 };
}
function spark(x, y, color) {
  const a = Math.random() * Math.PI * 2; const s = 40 + Math.random() * 110;
  return { kind: 'dot', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, gravity: 120,
    size: 1.5 + Math.random() * 2.5, color, life: 0.4 + Math.random() * 0.3, maxLife: 0.7 };
}
function sparkle(x, y, color) {
  const a = Math.random() * Math.PI * 2; const s = 30 + Math.random() * 60;
  return { kind: 'dot', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 30, gravity: -10,
    size: 1.5 + Math.random() * 2, color, life: 0.5 + Math.random() * 0.4, maxLife: 0.9 };
}
function confetti(x, y) {
  const colors = ['#ff6b6b', '#ffd34a', '#56d06f', '#5ad1ff', '#c08bff', '#ff9f43'];
  const a = Math.random() * Math.PI * 2; const s = 60 + Math.random() * 160;
  return { kind: 'shard', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 120, gravity: 360,
    rot: Math.random() * 6, spin: Math.random() * 10 - 5, size: 3 + Math.random() * 3,
    color: colors[(Math.random() * colors.length) | 0], life: 1.0 + Math.random() * 0.6, maxLife: 1.6 };
}
function dmgText(x, y, text, color, size = 13) {
  return { kind: 'text', x, y, vx: (Math.random() - 0.5) * 20, vy: -50, gravity: 40,
    text, color, size, life: 0.8, maxLife: 0.8 };
}

// ------------------------------------------------------------------- utils ---
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
function circle(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.closePath(); }
function mix(c1, c2, t) {
  const a = parseInt(c1.slice(1), 16), b = parseInt(c2.slice(1), 16);
  const r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t);
  const g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t);
  const bl = Math.round((a & 255) * (1 - t) + (b & 255) * t);
  return `rgb(${r},${g},${bl})`;
}
function mixA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function hash(id) { let h = 0; const s = String(id); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000; return h; }

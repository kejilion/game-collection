'use strict';

// 游戏世界权威模拟：地图生成、移动碰撞、炸弹/爆炸/连锁、道具、
// 怪物 AI、突然死亡与回合流程。纯逻辑，无 IO，便于单元测试。

const BASE_CONFIG = require('./config');

const TILE = { EMPTY: 0, WALL: 1, BRICK: 2 };
// 方向编码：0 上 1 下 2 左 3 右
const DIR_VEC = [
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
];
const POWERUP_KINDS = ['bomb', 'fire', 'speed', 'shield'];
const MONSTER_TYPES = ['slime', 'ghost', 'imp'];
const MONSTER_RADIUS = 0.38;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function create(opts = {}) {
  const C = Object.assign({}, BASE_CONFIG, opts.config || {});
  const w = {
    C,
    rng: opts.seed != null ? mulberry32(opts.seed) : Math.random,
    grid: [],
    players: new Map(),
    monsters: [],
    bombs: [],
    blasts: [],
    powerups: [],
    pendingPowerups: [],
    events: [],
    nextId: 1,
    time: 0,
    round: {
      state: 'lobby', // lobby | countdown | playing | ended
      num: 0,
      t: 0, // countdown/ended 时为剩余秒数；playing 时为已进行秒数
      timeLeft: C.ROUND_TIME,
      winnerId: null,
      winnerName: null,
      participants: 0,
      monstersSpawned: 0,
    },
    sudden: { active: false, order: [], idx: 0, timer: 0 },
  };
  generateMap(w);
  return w;
}

function spawnPoints(C) {
  const R = C.COLS - 2, B = C.ROWS - 2;
  const mx = (C.COLS - 1) >> 1, my = (C.ROWS - 1) >> 1;
  return [
    { x: 1, y: 1 }, { x: R, y: B }, { x: R, y: 1 }, { x: 1, y: B },
    { x: mx, y: 1 }, { x: mx, y: B }, { x: 1, y: my }, { x: R, y: my },
  ].slice(0, C.MAX_PLAYERS);
}

function generateMap(w) {
  const { C } = w;
  const g = [];
  for (let y = 0; y < C.ROWS; y++) {
    const row = [];
    for (let x = 0; x < C.COLS; x++) {
      if (x === 0 || y === 0 || x === C.COLS - 1 || y === C.ROWS - 1) row.push(TILE.WALL);
      else if (x % 2 === 0 && y % 2 === 0) row.push(TILE.WALL);
      else row.push(TILE.EMPTY);
    }
    g.push(row);
  }
  // 出生点十字范围留空，保证开局可移动、可躲开首颗炸弹
  const clear = new Set();
  for (const s of spawnPoints(C)) {
    for (let d = -2; d <= 2; d++) {
      clear.add(s.x + d + ',' + s.y);
      clear.add(s.x + ',' + (s.y + d));
    }
  }
  for (let y = 1; y < C.ROWS - 1; y++) {
    for (let x = 1; x < C.COLS - 1; x++) {
      if (g[y][x] !== TILE.EMPTY) continue;
      if (clear.has(x + ',' + y)) continue;
      if (w.rng() < C.BRICK_DENSITY) g[y][x] = TILE.BRICK;
    }
  }
  w.grid = g;
}

function serializeGrid(w) {
  return w.grid.map((row) => row.join(''));
}

function spiralOrder(C) {
  const out = [];
  let x0 = 1, y0 = 1, x1 = C.COLS - 2, y1 = C.ROWS - 2;
  while (x0 <= x1 && y0 <= y1) {
    for (let x = x0; x <= x1; x++) out.push([x, y0]);
    for (let y = y0 + 1; y <= y1; y++) out.push([x1, y]);
    if (y1 > y0) for (let x = x1 - 1; x >= x0; x--) out.push([x, y1]);
    if (x1 > x0) for (let y = y1 - 1; y >= y0 + 1; y--) out.push([x0, y]);
    x0++; y0++; x1--; y1--;
  }
  return out;
}

function weightedPick(rng, weights) {
  let total = 0;
  for (const k in weights) total += weights[k];
  let roll = rng() * total;
  for (const k in weights) {
    roll -= weights[k];
    if (roll <= 0) return k;
  }
  return Object.keys(weights)[0];
}

// ---------- 玩家 ----------

const COLOR_COUNT = 8;

function addPlayer(w, { name } = {}) {
  const id = w.nextId++;
  const used = new Map();
  for (const p of w.players.values()) used.set(p.color, (used.get(p.color) || 0) + 1);
  let color = 0;
  for (let c = 0; c < COLOR_COUNT; c++) {
    if ((used.get(c) || 0) < (used.get(color) || 0)) color = c;
    if (!used.has(c)) { color = c; break; }
  }
  const p = {
    id,
    name: sanitizeName(name) || '玩家' + id,
    color,
    score: 0, wins: 0, kills: 0, deaths: 0,
    spec: true, alive: false,
    x: 0, y: 0, dir: 1, moving: false,
    input: -1, wantBomb: false,
    maxBombs: w.C.BASE_BOMBS, range: w.C.BASE_RANGE, speed: w.C.BASE_SPEED,
    activeBombs: 0,
    shield: false, spawnShield: 0, invuln: 0,
  };
  w.players.set(id, p);
  w.events.push({ e: 'join', id, name: p.name });
  const st = w.round.state;
  if ((st === 'playing' && w.round.t < w.C.JOIN_GRACE) || st === 'countdown') {
    trySpawn(w, p);
  }
  return p;
}

function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  const chars = [];
  for (const ch of name) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code !== 127) chars.push(ch);
  }
  return chars.join('').trim().slice(0, 12);
}

function removePlayer(w, id) {
  const p = w.players.get(id);
  if (!p) return;
  w.players.delete(id);
  w.events.push({ e: 'leave', id, name: p.name });
}

function setInput(w, id, d) {
  const p = w.players.get(id);
  if (!p) return;
  p.input = Number.isInteger(d) && d >= 0 && d <= 3 ? d : -1;
}

function requestBomb(w, id) {
  const p = w.players.get(id);
  if (p) p.wantBomb = true;
}

function resetPlayerForRound(w, p, spawn) {
  const { C } = w;
  p.spec = false;
  p.alive = true;
  p.x = spawn.x; p.y = spawn.y;
  p.dir = 1; p.moving = false;
  p.input = -1; p.wantBomb = false;
  p.maxBombs = C.BASE_BOMBS;
  p.range = C.BASE_RANGE;
  p.speed = C.BASE_SPEED;
  p.activeBombs = 0;
  p.shield = false;
  p.spawnShield = C.SPAWN_SHIELD;
  p.invuln = 0;
}

// 回合中途加入：还有空出生点就直接参战
function trySpawn(w, p) {
  const points = spawnPoints(w.C);
  const taken = new Set();
  for (const q of w.players.values()) {
    if (!q.spec && q.id !== p.id) {
      // 找离每个玩家最近的出生点视为已占用
      let best = 0, bd = Infinity;
      points.forEach((s, i) => {
        const d = Math.abs(q.x - s.x) + Math.abs(q.y - s.y);
        if (d < bd) { bd = d; best = i; }
      });
      taken.add(best);
    }
  }
  const activeCount = [...w.players.values()].filter((q) => !q.spec).length;
  if (activeCount >= w.C.MAX_PLAYERS) return false;
  for (let i = 0; i < points.length; i++) {
    if (taken.has(i)) continue;
    const s = points[i];
    resetPlayerForRound(w, p, s);
    // 清掉出生点周围可能重新生成的障碍（中途加入时地图已在使用中，仅清出生格）
    w.round.participants++;
    w.events.push({ e: 'spawn', id: p.id });
    return true;
  }
  return false;
}

// ---------- 回合流程 ----------

function startRound(w) {
  const { C } = w;
  w.round.num++;
  w.round.state = 'countdown';
  w.round.t = C.START_COUNTDOWN;
  w.round.timeLeft = C.ROUND_TIME;
  w.round.winnerId = null;
  w.round.winnerName = null;
  w.bombs = [];
  w.blasts = [];
  w.powerups = [];
  w.pendingPowerups = [];
  w.sudden = { active: false, order: spiralOrder(C), idx: 0, timer: 0 };
  generateMap(w);

  const points = spawnPoints(C);
  let slot = 0;
  for (const p of w.players.values()) {
    if (slot < points.length) {
      resetPlayerForRound(w, p, points[slot]);
      slot++;
    } else {
      p.spec = true;
      p.alive = false;
    }
  }
  w.round.participants = slot;
  spawnMonsters(w, slot);
  w.events.push({ e: 'round', n: w.round.num, map: serializeGrid(w) });
}

function endRound(w, winner) {
  const { C } = w;
  w.round.state = 'ended';
  w.round.t = C.ROUND_END_DELAY;
  if (winner) {
    winner.score += C.SCORE.win;
    winner.wins++;
    w.round.winnerId = winner.id;
    w.round.winnerName = winner.name;
  }
  w.events.push({
    e: 'end',
    id: winner ? winner.id : null,
    name: winner ? winner.name : null,
    n: w.round.participants,
  });
}

// ---------- 怪物 ----------

function spawnMonsters(w, playerCount) {
  const { C } = w;
  w.monsters = [];
  const count = Math.min(
    C.MONSTER_MAX,
    C.MONSTER_BASE + Math.floor(playerCount * C.MONSTER_PER_PLAYER)
  );
  w.round.monstersSpawned = 0;
  if (count <= 0) return;
  const points = spawnPoints(C);
  const candidates = [];
  for (let y = 1; y < C.ROWS - 1; y++) {
    for (let x = 1; x < C.COLS - 1; x++) {
      if (w.grid[y][x] !== TILE.EMPTY) continue;
      let ok = true;
      for (const s of points) {
        if (Math.abs(x - s.x) + Math.abs(y - s.y) < 5) { ok = false; break; }
      }
      if (ok) candidates.push({ x, y });
    }
  }
  for (let i = 0; i < count && candidates.length > 0; i++) {
    const idx = Math.floor(w.rng() * candidates.length);
    const spot = candidates.splice(idx, 1)[0];
    const type = weightedPick(w.rng, C.MONSTER_WEIGHTS);
    w.monsters.push({
      id: w.nextId++,
      type,
      typeIdx: MONSTER_TYPES.indexOf(type),
      x: spot.x, y: spot.y,
      dir: 1,
      speed: C.MONSTER_SPEED[type],
      target: null,
    });
    w.round.monstersSpawned++;
  }
}

function updateMonsters(w, dt) {
  for (const m of w.monsters) {
    if (m.target) {
      // 途中目标格被封（炸弹/坍塌）且尚未进入则重新决策
      if (tileSolidFor(w, m.target.x, m.target.y, m) &&
          (Math.abs(m.x - m.target.x) > 0.5 || Math.abs(m.y - m.target.y) > 0.5)) {
        m.target = null;
      }
    }
    if (!m.target) chooseMonsterTarget(w, m);
    if (!m.target) continue;
    const step = m.speed * dt;
    const dx = m.target.x - m.x, dy = m.target.y - m.y;
    const dist = Math.abs(dx) + Math.abs(dy);
    if (dist <= step) {
      m.x = m.target.x; m.y = m.target.y;
      m.target = null;
    } else {
      if (Math.abs(dx) > Math.abs(dy)) {
        m.x += Math.sign(dx) * step;
        m.dir = dx > 0 ? 3 : 2;
      } else {
        m.y += Math.sign(dy) * step;
        m.dir = dy > 0 ? 1 : 0;
      }
    }
  }
}

function chooseMonsterTarget(w, m) {
  const cx = Math.round(m.x), cy = Math.round(m.y);
  const open = [];
  for (let d = 0; d < 4; d++) {
    const nx = cx + DIR_VEC[d].x, ny = cy + DIR_VEC[d].y;
    if (!tileSolidFor(w, nx, ny, m)) open.push(d);
  }
  if (open.length === 0) return;
  let dir;
  const reverse = m.dir === 0 ? 1 : m.dir === 1 ? 0 : m.dir === 2 ? 3 : 2;
  if (m.type === 'ghost' && w.rng() < 0.75) {
    // 幽灵：贪心追最近的存活玩家
    let target = null, best = Infinity;
    for (const p of w.players.values()) {
      if (!p.alive) continue;
      const d = Math.abs(p.x - m.x) + Math.abs(p.y - m.y);
      if (d < best) { best = d; target = p; }
    }
    if (target) {
      let bd = Infinity;
      for (const d of open) {
        const nx = cx + DIR_VEC[d].x, ny = cy + DIR_VEC[d].y;
        const dd = Math.abs(target.x - nx) + Math.abs(target.y - ny);
        if (dd < bd) { bd = dd; dir = d; }
      }
    }
  }
  if (dir == null) {
    // 慢速怪：尽量不走回头路
    const forward = open.filter((d) => d !== reverse);
    const pool = forward.length > 0 && w.rng() < 0.8 ? forward : open;
    dir = pool[Math.floor(w.rng() * pool.length)];
  }
  m.dir = dir;
  m.target = { x: cx + DIR_VEC[dir].x, y: cy + DIR_VEC[dir].y };
}

// ---------- 碰撞与移动 ----------

function tileSolidFor(w, tx, ty, ent) {
  if (tx < 0 || ty < 0 || tx >= w.C.COLS || ty >= w.C.ROWS) return true;
  const v = w.grid[ty][tx];
  if (v === TILE.WALL || v === TILE.BRICK) return true;
  for (const b of w.bombs) {
    if (b.x === tx && b.y === ty && !b.passers.has(ent.id)) return true;
  }
  return false;
}

function boxHits(w, ent, x, y, r) {
  const minX = Math.round(x - r), maxX = Math.round(x + r);
  const minY = Math.round(y - r), maxY = Math.round(y + r);
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      if (tileSolidFor(w, tx, ty, ent)) return true;
    }
  }
  return false;
}

// 单轴移动 + 转角助滑（泡泡堂式：贴着口子会自动滑进通道）
function movePlayer(w, p, dir, dist) {
  const r = w.C.PLAYER_RADIUS;
  const v = DIR_VEC[dir];
  const axis = v.x !== 0 ? 'x' : 'y';
  const other = v.x !== 0 ? 'y' : 'x';
  const sign = axis === 'x' ? v.x : v.y;

  const nx = axis === 'x' ? p.x + v.x * dist : p.x;
  const ny = axis === 'y' ? p.y + v.y * dist : p.y;
  if (!boxHits(w, p, nx, ny, r)) {
    p.x = nx; p.y = ny;
    return;
  }

  // 被挡：先贴到墙边
  let remaining = dist;
  const cur = p[axis];
  const curTile = Math.round(cur);
  const flush = curTile + sign * (0.5 - r - 0.001);
  if ((flush - cur) * sign > 0) {
    const fx = axis === 'x' ? flush : p.x;
    const fy = axis === 'y' ? flush : p.y;
    if (!boxHits(w, p, fx, fy, r)) {
      p.x = fx; p.y = fy;
      remaining = Math.max(0, dist - Math.abs(flush - cur));
    }
  }
  if (remaining <= 0) remaining = dist * 0.5;

  // 转角助滑：正前方（对齐后）是通路则滑向走廊中线；
  // 否则若偏移较大且斜前方有口子则滑向那个口子。
  const oc = Math.round(p[other]);
  const off = p[other] - oc;
  const aheadX = axis === 'x' ? curTile + sign : oc;
  const aheadY = axis === 'y' ? curTile + sign : oc;
  if (!tileSolidFor(w, aheadX, aheadY, p) && Math.abs(off) > 0.001) {
    const slide = Math.min(Math.abs(off), remaining) * -Math.sign(off);
    const sx = other === 'x' ? p.x + slide : p.x;
    const sy = other === 'y' ? p.y + slide : p.y;
    if (!boxHits(w, p, sx, sy, r)) { p.x = sx; p.y = sy; }
  } else if (Math.abs(off) > 0.25) {
    const so = Math.sign(off);
    const dgX = axis === 'x' ? curTile + sign : oc + so;
    const dgY = axis === 'y' ? curTile + sign : oc + so;
    if (!tileSolidFor(w, dgX, dgY, p)) {
      const slide = so * remaining;
      const sx = other === 'x' ? p.x + slide : p.x;
      const sy = other === 'y' ? p.y + slide : p.y;
      if (!boxHits(w, p, sx, sy, r)) { p.x = sx; p.y = sy; }
    }
  }
}

// ---------- 炸弹与爆炸 ----------

function placeBomb(w, p) {
  const { C } = w;
  if (!p.alive || p.activeBombs >= p.maxBombs) return false;
  const tx = Math.round(p.x), ty = Math.round(p.y);
  if (w.grid[ty][tx] !== TILE.EMPTY) return false;
  for (const b of w.bombs) if (b.x === tx && b.y === ty) return false;
  const passers = new Set();
  const overlaps = (e, r) =>
    Math.abs(e.x - tx) < 0.5 + r && Math.abs(e.y - ty) < 0.5 + r;
  for (const q of w.players.values()) if (q.alive && overlaps(q, C.PLAYER_RADIUS)) passers.add(q.id);
  for (const m of w.monsters) if (overlaps(m, MONSTER_RADIUS)) passers.add(m.id);
  w.bombs.push({
    id: w.nextId++,
    x: tx, y: ty,
    fuse: C.BOMB_FUSE,
    range: p.range,
    owner: p.id,
    passers,
  });
  p.activeBombs++;
  w.events.push({ e: 'bomb', x: tx, y: ty });
  return true;
}

function updateBombs(w, dt) {
  for (const b of w.bombs) {
    // 离开炸弹格后不再可穿行
    for (const id of [...b.passers]) {
      const ent = w.players.get(id) || w.monsters.find((m) => m.id === id);
      if (!ent) { b.passers.delete(id); continue; }
      const r = w.players.has(id) ? w.C.PLAYER_RADIUS : MONSTER_RADIUS;
      if (Math.abs(ent.x - b.x) >= 0.5 + r || Math.abs(ent.y - b.y) >= 0.5 + r) {
        b.passers.delete(id);
      }
    }
    b.fuse -= dt;
  }
  // 逐个引爆（爆炸可能缩短其它炸弹引信，需循环到稳定）
  let exploded = true;
  while (exploded) {
    exploded = false;
    for (const b of w.bombs) {
      if (b.fuse <= 0) {
        explodeBomb(w, b);
        exploded = true;
        break;
      }
    }
  }
}

function explodeBomb(w, b) {
  const { C } = w;
  w.bombs = w.bombs.filter((x) => x !== b);
  const owner = w.players.get(b.owner);
  if (owner) owner.activeBombs = Math.max(0, owner.activeBombs - 1);
  const until = w.time + C.BLAST_TIME;
  const addBlast = (x, y, part, dir) =>
    w.blasts.push({ x, y, part, dir, until, owner: b.owner });
  addBlast(b.x, b.y, 0, 0);
  for (let d = 0; d < 4; d++) {
    for (let i = 1; i <= b.range; i++) {
      const x = b.x + DIR_VEC[d].x * i;
      const y = b.y + DIR_VEC[d].y * i;
      if (x < 0 || y < 0 || x >= C.COLS || y >= C.ROWS) break;
      const v = w.grid[y][x];
      if (v === TILE.WALL) break;
      if (v === TILE.BRICK) {
        destroyBrick(w, x, y, b.owner);
        addBlast(x, y, 2, d);
        break;
      }
      const other = w.bombs.find((ob) => ob.x === x && ob.y === y);
      if (other) {
        other.fuse = Math.min(other.fuse, C.CHAIN_DELAY);
        addBlast(x, y, 2, d);
        break;
      }
      addBlast(x, y, i === b.range ? 2 : 1, d);
    }
  }
  w.events.push({ e: 'boom', x: b.x, y: b.y, r: b.range });
}

function destroyBrick(w, x, y, byId) {
  const { C } = w;
  w.grid[y][x] = TILE.EMPTY;
  w.events.push({ e: 'tile', x, y, v: TILE.EMPTY, fx: 'brick' });
  const owner = w.players.get(byId);
  if (owner) owner.score += C.SCORE.brick;
  if (w.rng() < C.POWERUP_CHANCE) {
    const kind = weightedPick(w.rng, C.POWERUP_WEIGHTS);
    w.pendingPowerups.push({ x, y, kind, at: w.time + C.BLAST_TIME + 0.05 });
  }
}

function updateBlasts(w) {
  w.blasts = w.blasts.filter((f) => f.until > w.time);
  if (w.pendingPowerups.length > 0) {
    const remain = [];
    for (const pp of w.pendingPowerups) {
      if (w.time < pp.at) { remain.push(pp); continue; }
      if (w.grid[pp.y][pp.x] !== TILE.EMPTY) continue; // 被突然死亡压掉
      if (w.blasts.some((f) => f.x === pp.x && f.y === pp.y)) { remain.push(pp); continue; }
      w.powerups.push({
        id: w.nextId++,
        x: pp.x, y: pp.y,
        kind: pp.kind,
        kindIdx: POWERUP_KINDS.indexOf(pp.kind),
      });
    }
    w.pendingPowerups = remain;
  }
}

function applyBlastDamage(w) {
  const { C } = w;
  if (w.blasts.length === 0) return;
  const hit = (x, y, bx, by, tol) => Math.abs(x - bx) < tol && Math.abs(y - by) < tol;
  for (const f of w.blasts) {
    for (const p of w.players.values()) {
      if (p.alive && hit(p.x, p.y, f.x, f.y, 0.55)) hitPlayer(w, p, f.owner, false);
    }
    for (const m of [...w.monsters]) {
      if (hit(m.x, m.y, f.x, f.y, 0.6)) killMonster(w, m, f.owner);
    }
    w.powerups = w.powerups.filter((u) => {
      if (u.x === f.x && u.y === f.y) {
        w.events.push({ e: 'burn', x: u.x, y: u.y });
        return false;
      }
      return true;
    });
    // 火焰中的新炸弹立即连锁
    for (const b of w.bombs) {
      if (b.x === f.x && b.y === f.y) b.fuse = Math.min(b.fuse, C.CHAIN_DELAY);
    }
  }
}

function hitPlayer(w, p, byId, force) {
  const { C } = w;
  if (!p.alive) return;
  if (!force && (p.spawnShield > 0 || p.invuln > 0)) return;
  if (!force && p.shield) {
    p.shield = false;
    p.invuln = C.HIT_INVULN;
    w.events.push({ e: 'shield', id: p.id });
    return;
  }
  p.alive = false;
  p.deaths++;
  p.input = -1;
  w.events.push({ e: 'die', id: p.id, x: p.x, y: p.y });
  const killer = byId != null ? w.players.get(byId) : null;
  if (killer && killer.id !== p.id) {
    killer.score += C.SCORE.kill;
    killer.kills++;
  }
}

function killMonster(w, m, byId) {
  const { C } = w;
  w.monsters = w.monsters.filter((x) => x !== m);
  w.events.push({ e: 'mdie', id: m.id, x: m.x, y: m.y, mt: m.typeIdx });
  const killer = byId != null ? w.players.get(byId) : null;
  if (killer) killer.score += C.SCORE.monster;
  const tx = Math.round(m.x), ty = Math.round(m.y);
  if (
    w.rng() < C.MONSTER_DROP_CHANCE &&
    w.grid[ty][tx] === TILE.EMPTY &&
    !w.powerups.some((u) => u.x === tx && u.y === ty)
  ) {
    const kind = weightedPick(w.rng, C.POWERUP_WEIGHTS);
    w.pendingPowerups.push({ x: tx, y: ty, kind, at: w.time + C.BLAST_TIME });
  }
}

// ---------- 道具与接触 ----------

function applyPickups(w) {
  const { C } = w;
  if (w.powerups.length === 0) return;
  w.powerups = w.powerups.filter((u) => {
    for (const p of w.players.values()) {
      if (!p.alive) continue;
      if (Math.abs(p.x - u.x) < 0.6 && Math.abs(p.y - u.y) < 0.6) {
        if (u.kind === 'bomb') p.maxBombs = Math.min(C.MAX_BOMBS, p.maxBombs + 1);
        else if (u.kind === 'fire') p.range = Math.min(C.MAX_RANGE, p.range + 1);
        else if (u.kind === 'speed') p.speed = Math.min(C.MAX_SPEED, p.speed + C.SPEED_STEP);
        else if (u.kind === 'shield') p.shield = true;
        p.score += C.SCORE.pickup;
        w.events.push({ e: 'pick', id: p.id, x: u.x, y: u.y, k: u.kindIdx });
        return false;
      }
    }
    return true;
  });
}

function applyMonsterTouch(w) {
  const { C } = w;
  for (const m of w.monsters) {
    for (const p of w.players.values()) {
      if (!p.alive) continue;
      if (Math.abs(p.x - m.x) < C.MONSTER_TOUCH && Math.abs(p.y - m.y) < C.MONSTER_TOUCH) {
        hitPlayer(w, p, null, false);
      }
    }
  }
}

// ---------- 突然死亡 ----------

function updateSuddenDeath(w, dt) {
  const { C } = w;
  if (!w.sudden.active) {
    if (w.round.timeLeft <= 0) {
      w.sudden.active = true;
      w.events.push({ e: 'sd' });
    }
    return;
  }
  w.sudden.timer += dt;
  while (w.sudden.timer >= C.SUDDEN_DEATH_INTERVAL && w.sudden.idx < w.sudden.order.length) {
    w.sudden.timer -= C.SUDDEN_DEATH_INTERVAL;
    const [x, y] = w.sudden.order[w.sudden.idx++];
    if (w.grid[y][x] === TILE.WALL) continue;
    w.grid[y][x] = TILE.WALL;
    w.events.push({ e: 'tile', x, y, v: TILE.WALL, fx: 'sd' });
    w.bombs = w.bombs.filter((b) => !(b.x === x && b.y === y) || releaseBomb(w, b));
    w.powerups = w.powerups.filter((u) => !(u.x === x && u.y === y));
    for (const p of w.players.values()) {
      if (p.alive && Math.round(p.x) === x && Math.round(p.y) === y) hitPlayer(w, p, null, true);
    }
    for (const m of [...w.monsters]) {
      if (Math.round(m.x) === x && Math.round(m.y) === y) killMonster(w, m, null);
    }
  }
}

function releaseBomb(w, b) {
  const owner = w.players.get(b.owner);
  if (owner) owner.activeBombs = Math.max(0, owner.activeBombs - 1);
  return false; // filter 用：总是移除
}

// ---------- 主循环 ----------

function step(w, dt) {
  w.time += dt;
  const { C } = w;
  const humans = [...w.players.values()];
  const st = w.round.state;

  if (st === 'lobby') {
    if (humans.length > 0) startRound(w);
    return;
  }
  if (st === 'countdown') {
    w.round.t -= dt;
    if (w.round.t <= 0) {
      w.round.state = 'playing';
      w.round.t = 0;
      w.events.push({ e: 'go' });
    }
    return;
  }
  if (st === 'ended') {
    w.round.t -= dt;
    if (w.round.t <= 0) {
      if (humans.length > 0) startRound(w);
      else w.round.state = 'lobby';
    }
    return;
  }

  // playing
  w.round.t += dt;
  w.round.timeLeft = Math.max(0, w.round.timeLeft - dt);

  for (const p of w.players.values()) {
    if (!p.alive) continue;
    if (p.spawnShield > 0) p.spawnShield -= dt;
    if (p.invuln > 0) p.invuln -= dt;
    p.moving = false;
    if (p.input >= 0) {
      p.dir = p.input;
      p.moving = true;
      movePlayer(w, p, p.input, p.speed * dt);
    }
    if (p.wantBomb) {
      p.wantBomb = false;
      placeBomb(w, p);
    }
  }

  updateMonsters(w, dt);
  updateBombs(w, dt);
  updateBlasts(w);
  applyBlastDamage(w);
  applyPickups(w);
  applyMonsterTouch(w);
  updateSuddenDeath(w, dt);

  // 胜负判定
  const alive = humans.filter((p) => !p.spec && p.alive);
  if (w.round.participants >= 2) {
    if (alive.length === 0) endRound(w, null);
    else if (alive.length === 1) endRound(w, alive[0]);
  } else {
    if (alive.length === 0) endRound(w, null);
    else if (w.monsters.length === 0 && w.round.monstersSpawned > 0) endRound(w, alive[0]);
  }
}

module.exports = {
  create,
  step,
  startRound,
  addPlayer,
  removePlayer,
  setInput,
  requestBomb,
  serializeGrid,
  spawnPoints,
  TILE,
  POWERUP_KINDS,
  MONSTER_TYPES,
};

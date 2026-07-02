'use strict';

// 常驻世界权威模拟（无回合制，开服永久运行）：
// 大地图、随机空旷出生、死亡自动重生并掉落强化、怪物种群维持、
// 砖块定时再生、道具时效、连杀计分。纯逻辑无 IO，便于单元测试。

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
const MONSTER_TYPES = ['slime', 'ghost', 'imp', 'gold'];
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
    regrow: [], // 待再生的砖块 {x, y, at}
    events: [],
    nextId: 1,
    time: 0,
    monsterTimer: 0,
  };
  generateMap(w);
  return w;
}

function generateMap(w) {
  const { C } = w;
  const g = [];
  for (let y = 0; y < C.ROWS; y++) {
    const row = [];
    for (let x = 0; x < C.COLS; x++) {
      if (x === 0 || y === 0 || x === C.COLS - 1 || y === C.ROWS - 1) row.push(TILE.WALL);
      else if (x % 2 === 0 && y % 2 === 0) row.push(TILE.WALL);
      else if (w.rng() < C.BRICK_DENSITY) row.push(TILE.BRICK);
      else row.push(TILE.EMPTY);
    }
    g.push(row);
  }
  w.grid = g;
}

function serializeGrid(w) {
  return w.grid.map((row) => row.join(''));
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

// ---------- 出生点选择 ----------

function hasOpenNeighbor(w, x, y) {
  for (const d of DIR_VEC) {
    const v = w.grid[y + d.y] && w.grid[y + d.y][x + d.x];
    if (v === TILE.EMPTY) return true;
  }
  return false;
}

function tileClearOfBlast(w, x, y) {
  if (w.blasts.some((f) => f.x === x && f.y === y)) return false;
  if (w.bombs.some((b) => Math.abs(b.x - x) + Math.abs(b.y - y) <= 1)) return false;
  return true;
}

// 随机挑一块空旷地：优先远离怪物与其他玩家，逐级放宽
function randomSpawn(w) {
  const { C } = w;
  const passes = [
    { monster: C.SPAWN_MONSTER_DIST, player: C.SPAWN_PLAYER_DIST },
    { monster: C.SPAWN_MONSTER_DIST, player: 0 },
    { monster: 2, player: 0 },
  ];
  for (const rule of passes) {
    for (let i = 0; i < 80; i++) {
      const x = 1 + Math.floor(w.rng() * (C.COLS - 2));
      const y = 1 + Math.floor(w.rng() * (C.ROWS - 2));
      if (w.grid[y][x] !== TILE.EMPTY) continue;
      if (!hasOpenNeighbor(w, x, y)) continue;
      if (!tileClearOfBlast(w, x, y)) continue;
      if (rule.monster > 0 &&
          w.monsters.some((m) => Math.abs(m.x - x) + Math.abs(m.y - y) < rule.monster)) continue;
      if (rule.player > 0 &&
          [...w.players.values()].some((p) => p.alive && Math.abs(p.x - x) + Math.abs(p.y - y) < rule.player)) continue;
      return { x, y };
    }
  }
  // 兜底：全图扫第一块可用空地
  for (let y = 1; y < C.ROWS - 1; y++) {
    for (let x = 1; x < C.COLS - 1; x++) {
      if (w.grid[y][x] === TILE.EMPTY && hasOpenNeighbor(w, x, y)) return { x, y };
    }
  }
  return { x: 1, y: 1 };
}

// ---------- 玩家 ----------

const COLOR_COUNT = 8;

function addPlayer(w, { name, color } = {}) {
  const id = w.nextId++;
  const p = {
    id,
    name: sanitizeName(name) || '玩家' + id,
    color: Number.isInteger(color) && color >= 0 && color < COLOR_COUNT
      ? color
      : Math.floor(w.rng() * COLOR_COUNT),
    score: 0, kills: 0, deaths: 0, streak: 0,
    alive: false, deadUntil: 0,
    x: 0, y: 0, dir: 1, moving: false,
    input: -1, wantBomb: false,
    maxBombs: w.C.BASE_BOMBS, range: w.C.BASE_RANGE, speed: w.C.BASE_SPEED,
    activeBombs: 0,
    shield: false, spawnShield: 0, invuln: 0,
  };
  w.players.set(id, p);
  w.events.push({ e: 'join', id, name: p.name });
  spawnPlayer(w, p);
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

function spawnPlayer(w, p) {
  const { C } = w;
  const s = randomSpawn(w);
  p.alive = true;
  p.x = s.x; p.y = s.y;
  p.dir = 1; p.moving = false;
  p.input = -1; p.wantBomb = false;
  p.maxBombs = C.BASE_BOMBS;
  p.range = C.BASE_RANGE;
  p.speed = C.BASE_SPEED;
  p.activeBombs = 0;
  p.shield = false;
  p.spawnShield = C.SPAWN_SHIELD;
  p.invuln = 0;
  w.events.push({ e: 'spawn', id: p.id, x: s.x, y: s.y });
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

// 死亡掉落：把生前的强化按比例还给战场，奖励击杀者
function dropUpgrades(w, p) {
  const { C } = w;
  const pool = [];
  for (let i = C.BASE_BOMBS; i < p.maxBombs; i++) pool.push('bomb');
  for (let i = C.BASE_RANGE; i < p.range; i++) pool.push('fire');
  for (let i = 0; i < Math.round((p.speed - C.BASE_SPEED) / C.SPEED_STEP); i++) pool.push('speed');
  if (pool.length === 0) return;
  const cx = Math.round(p.x), cy = Math.round(p.y);
  const spots = [[cx, cy], [cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]
    .filter(([x, y]) =>
      x > 0 && y > 0 && x < C.COLS - 1 && y < C.ROWS - 1 &&
      w.grid[y][x] === TILE.EMPTY &&
      !w.powerups.some((u) => u.x === x && u.y === y) &&
      !w.pendingPowerups.some((u) => u.x === x && u.y === y));
  const count = Math.min(C.DEATH_DROPS, pool.length, spots.length);
  for (let i = 0; i < count; i++) {
    const kind = pool.splice(Math.floor(w.rng() * pool.length), 1)[0];
    const [x, y] = spots[i];
    w.pendingPowerups.push({ x, y, kind, at: w.time + 0.8 });
  }
}

// ---------- 怪物 ----------

function targetMonsterCount(w) {
  const { C } = w;
  return Math.min(C.MONSTER_MAX, C.MONSTER_BASE + C.MONSTER_PER_PLAYER * w.players.size);
}

function maintainMonsters(w, dt) {
  const { C } = w;
  w.monsterTimer += dt;
  while (w.monsterTimer >= C.MONSTER_RESPAWN_INTERVAL) {
    w.monsterTimer -= C.MONSTER_RESPAWN_INTERVAL;
    if (w.players.size === 0) continue;
    if (w.monsters.length >= targetMonsterCount(w)) continue;
    spawnMonster(w);
  }
}

function spawnMonster(w) {
  const { C } = w;
  let spot = null;
  for (const minDist of [C.MONSTER_PLAYER_DIST, 4]) {
    for (let i = 0; i < 60 && !spot; i++) {
      const x = 1 + Math.floor(w.rng() * (C.COLS - 2));
      const y = 1 + Math.floor(w.rng() * (C.ROWS - 2));
      if (w.grid[y][x] !== TILE.EMPTY) continue;
      if (!hasOpenNeighbor(w, x, y)) continue;
      if ([...w.players.values()].some((p) => p.alive && Math.abs(p.x - x) + Math.abs(p.y - y) < minDist)) continue;
      spot = { x, y };
    }
    if (spot) break;
  }
  if (!spot) return null;
  const hasGold = w.monsters.some((m) => m.type === 'gold');
  const type = !hasGold && w.rng() < C.GOLD_CHANCE
    ? 'gold'
    : weightedPick(w.rng, C.MONSTER_WEIGHTS);
  const m = {
    id: w.nextId++,
    type,
    typeIdx: MONSTER_TYPES.indexOf(type),
    x: spot.x, y: spot.y,
    dir: 1,
    speed: C.MONSTER_SPEED[type],
    target: null,
  };
  w.monsters.push(m);
  return m;
}

function updateMonsters(w, dt) {
  for (const m of w.monsters) {
    if (m.target) {
      // 途中目标格被封（炸弹/再生砖）且尚未进入则重新决策
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

function nearestAlivePlayer(w, x, y) {
  let target = null, best = Infinity;
  for (const p of w.players.values()) {
    if (!p.alive) continue;
    const d = Math.abs(p.x - x) + Math.abs(p.y - y);
    if (d < best) { best = d; target = p; }
  }
  return target;
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
    const target = nearestAlivePlayer(w, m.x, m.y);
    if (target) {
      let bd = Infinity;
      for (const d of open) {
        const nx = cx + DIR_VEC[d].x, ny = cy + DIR_VEC[d].y;
        const dd = Math.abs(target.x - nx) + Math.abs(target.y - ny);
        if (dd < bd) { bd = dd; dir = d; }
      }
    }
  } else if (m.type === 'gold' && w.rng() < 0.75) {
    // 金史莱姆：逃离最近的玩家
    const target = nearestAlivePlayer(w, m.x, m.y);
    if (target) {
      let bd = -Infinity;
      for (const d of open) {
        const nx = cx + DIR_VEC[d].x, ny = cy + DIR_VEC[d].y;
        const dd = Math.abs(target.x - nx) + Math.abs(target.y - ny);
        if (dd > bd) { bd = dd; dir = d; }
      }
    }
  }
  if (dir == null) {
    // 尽量不走回头路的随机游走
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
  w.events.push({ e: 'bomb', x: tx, y: ty, id: p.id });
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
  // 安排再生
  const delay = C.BRICK_REGROW_MIN + w.rng() * (C.BRICK_REGROW_MAX - C.BRICK_REGROW_MIN);
  w.regrow.push({ x, y, at: w.time + delay });
}

function updateBlasts(w) {
  const { C } = w;
  w.blasts = w.blasts.filter((f) => f.until > w.time);
  // 道具过期
  w.powerups = w.powerups.filter((u) => u.until > w.time);
  // 延迟生成的道具（等火焰散去）
  if (w.pendingPowerups.length > 0) {
    const remain = [];
    for (const pp of w.pendingPowerups) {
      if (w.time < pp.at) { remain.push(pp); continue; }
      if (w.grid[pp.y][pp.x] !== TILE.EMPTY) continue;
      if (w.blasts.some((f) => f.x === pp.x && f.y === pp.y)) { remain.push(pp); continue; }
      w.powerups.push({
        id: w.nextId++,
        x: pp.x, y: pp.y,
        kind: pp.kind,
        kindIdx: POWERUP_KINDS.indexOf(pp.kind),
        until: w.time + C.POWERUP_TTL,
      });
    }
    w.pendingPowerups = remain;
  }
}

function regrowBricks(w) {
  if (w.regrow.length === 0) return;
  const remain = [];
  for (const r of w.regrow) {
    if (w.time < r.at) { remain.push(r); continue; }
    const blocked =
      w.grid[r.y][r.x] !== TILE.EMPTY ||
      w.bombs.some((b) => b.x === r.x && b.y === r.y) ||
      w.powerups.some((u) => u.x === r.x && u.y === r.y) ||
      w.pendingPowerups.some((u) => u.x === r.x && u.y === r.y) ||
      [...w.players.values()].some((p) => p.alive && Math.abs(p.x - r.x) < 1.3 && Math.abs(p.y - r.y) < 1.3) ||
      w.monsters.some((m) => Math.abs(m.x - r.x) < 1.3 && Math.abs(m.y - r.y) < 1.3);
    if (blocked) {
      r.at = w.time + 5; // 位置被占，稍后再试
      remain.push(r);
      continue;
    }
    w.grid[r.y][r.x] = TILE.BRICK;
    w.events.push({ e: 'tile', x: r.x, y: r.y, v: TILE.BRICK, fx: 'grow' });
  }
  w.regrow = remain;
}

function applyBlastDamage(w) {
  const { C } = w;
  if (w.blasts.length === 0) return;
  const hit = (x, y, bx, by, tol) => Math.abs(x - bx) < tol && Math.abs(y - by) < tol;
  for (const f of w.blasts) {
    for (const p of w.players.values()) {
      if (p.alive && hit(p.x, p.y, f.x, f.y, 0.55)) hitPlayer(w, p, f.owner);
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

function hitPlayer(w, p, byId) {
  const { C } = w;
  if (!p.alive) return;
  if (p.spawnShield > 0 || p.invuln > 0) return;
  if (p.shield) {
    p.shield = false;
    p.invuln = C.HIT_INVULN;
    w.events.push({ e: 'shield', id: p.id });
    return;
  }
  p.alive = false;
  p.deaths++;
  p.streak = 0;
  p.input = -1;
  p.deadUntil = w.time + C.RESPAWN_DELAY;
  dropUpgrades(w, p);
  w.events.push({ e: 'die', id: p.id, x: p.x, y: p.y, by: byId != null ? byId : null });
  const killer = byId != null ? w.players.get(byId) : null;
  if (killer && killer.id !== p.id) {
    killer.kills++;
    killer.streak++;
    const bonus = Math.min(C.SCORE.streakBonus * (killer.streak - 1), C.SCORE.streakCap);
    killer.score += C.SCORE.kill + bonus;
    if (killer.streak >= 2) {
      w.events.push({ e: 'streak', id: killer.id, n: killer.streak });
    }
  }
}

function killMonster(w, m, byId) {
  const { C } = w;
  w.monsters = w.monsters.filter((x) => x !== m);
  w.events.push({ e: 'mdie', id: m.id, x: m.x, y: m.y, mt: m.typeIdx });
  const killer = byId != null ? w.players.get(byId) : null;
  if (killer) killer.score += C.MONSTER_SCORE[m.type] || 50;
  const dropChance = m.type === 'gold' ? 1 : C.MONSTER_DROP_CHANCE;
  const tx = Math.round(m.x), ty = Math.round(m.y);
  if (
    w.rng() < dropChance &&
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
    if (m.type === 'gold') continue; // 金史莱姆无害，只会逃
    for (const p of w.players.values()) {
      if (!p.alive) continue;
      if (Math.abs(p.x - m.x) < C.MONSTER_TOUCH && Math.abs(p.y - m.y) < C.MONSTER_TOUCH) {
        hitPlayer(w, p, null);
      }
    }
  }
}

// ---------- 主循环 ----------

function step(w, dt) {
  w.time += dt;

  for (const p of w.players.values()) {
    if (!p.alive) {
      if (w.time >= p.deadUntil) spawnPlayer(w, p); // 自动重生
      continue;
    }
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
  maintainMonsters(w, dt);
  updateBombs(w, dt);
  updateBlasts(w);
  applyBlastDamage(w);
  applyPickups(w);
  applyMonsterTouch(w);
  regrowBricks(w);
}

module.exports = {
  create,
  step,
  addPlayer,
  removePlayer,
  setInput,
  requestBomb,
  serializeGrid,
  randomSpawn,
  TILE,
  POWERUP_KINDS,
  MONSTER_TYPES,
};

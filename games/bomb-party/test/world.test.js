'use strict';

// 世界模拟单元测试：node --test
const test = require('node:test');
const assert = require('node:assert');

const World = require('../server/world');

const DT = 1 / 30;

// 无怪物、固定种子的测试世界
function makeWorld(config = {}) {
  return World.create({
    seed: 42,
    config: Object.assign({ MONSTER_BASE: 0, MONSTER_PER_PLAYER: 0 }, config),
  });
}

function stepSeconds(w, seconds) {
  const n = Math.ceil(seconds / DT);
  for (let i = 0; i < n; i++) World.step(w, DT);
}

function startPlaying(w) {
  // 跳过倒计时
  stepSeconds(w, 3.5);
  assert.strictEqual(w.round.state, 'playing');
}

test('地图生成：边框与柱子为墙，出生点畅通', () => {
  const w = makeWorld();
  const C = w.C;
  for (let x = 0; x < C.COLS; x++) {
    assert.strictEqual(w.grid[0][x], World.TILE.WALL);
    assert.strictEqual(w.grid[C.ROWS - 1][x], World.TILE.WALL);
  }
  for (let y = 2; y < C.ROWS - 1; y += 2) {
    for (let x = 2; x < C.COLS - 1; x += 2) {
      assert.strictEqual(w.grid[y][x], World.TILE.WALL);
    }
  }
  for (const s of World.spawnPoints(C)) {
    assert.strictEqual(w.grid[s.y][s.x], World.TILE.EMPTY, `出生点(${s.x},${s.y})应为空`);
    // 至少一个相邻格可走
    const open =
      w.grid[s.y][s.x + 1] === World.TILE.EMPTY ||
      w.grid[s.y][s.x - 1] === World.TILE.EMPTY ||
      w.grid[s.y + 1][s.x] === World.TILE.EMPTY ||
      w.grid[s.y - 1][s.x] === World.TILE.EMPTY;
    assert.ok(open, `出生点(${s.x},${s.y})应有出路`);
  }
});

test('玩家加入后回合自动开始并落位', () => {
  const w = makeWorld();
  const p1 = World.addPlayer(w, { name: '小红' });
  const p2 = World.addPlayer(w, { name: '小蓝' });
  World.step(w, DT);
  assert.strictEqual(w.round.state, 'countdown');
  assert.strictEqual(p1.alive, true);
  assert.strictEqual(p2.alive, true);
  assert.ok(p1.x !== p2.x || p1.y !== p2.y);
  startPlaying(w);
});

test('炸弹爆炸摧毁砖块并产生火焰', () => {
  const w = makeWorld();
  const p = World.addPlayer(w, { name: 'A' });
  World.addPlayer(w, { name: 'B' });
  startPlaying(w);
  // 在 p 旁边人为放一块砖
  const bx = p.x + 1, by = p.y;
  w.grid[by][bx] = World.TILE.BRICK;
  World.requestBomb(w, p.id);
  World.step(w, DT);
  assert.strictEqual(w.bombs.length, 1);
  // 挪开玩家避免被炸（放到远处安全位置）
  p.x = p.x; p.y = p.y + 2;
  p.spawnShield = 99;
  stepSeconds(w, 2.7);
  assert.strictEqual(w.bombs.length, 0, '炸弹应已爆炸');
  assert.ok(w.blasts.length > 0, '应有火焰');
  assert.strictEqual(w.grid[by][bx], World.TILE.EMPTY, '砖块应被摧毁');
});

test('火焰杀死玩家；护盾可挡一次', () => {
  const w = makeWorld();
  const a = World.addPlayer(w, { name: 'A' });
  const b = World.addPlayer(w, { name: 'B' });
  startPlaying(w);
  a.spawnShield = 0;
  b.spawnShield = 0;
  b.shield = true;
  // 直接构造火焰盖住两人
  w.blasts.push({ x: Math.round(a.x), y: Math.round(a.y), part: 0, dir: 0, until: w.time + 1, owner: null });
  w.blasts.push({ x: Math.round(b.x), y: Math.round(b.y), part: 0, dir: 0, until: w.time + 1, owner: null });
  World.step(w, DT);
  assert.strictEqual(a.alive, false, '无护盾玩家应死亡');
  assert.strictEqual(b.alive, true, '护盾玩家应存活');
  assert.strictEqual(b.shield, false, '护盾应被消耗');
});

test('连锁爆炸：相邻炸弹被波及后引信缩短', () => {
  const w = makeWorld();
  const p = World.addPlayer(w, { name: 'A' });
  World.addPlayer(w, { name: 'B' });
  startPlaying(w);
  p.spawnShield = 99;
  const x = Math.round(p.x), y = Math.round(p.y);
  // 两颗手工炸弹：第一颗即将爆炸，第二颗在其射程内
  w.bombs.push({ id: 900, x, y, fuse: 0.05, range: 2, owner: p.id, passers: new Set([p.id]) });
  w.bombs.push({ id: 901, x: x + 1, y, fuse: 99, range: 1, owner: p.id, passers: new Set() });
  w.grid[y][x + 1] = World.TILE.EMPTY;
  stepSeconds(w, 0.1);
  const second = w.bombs.find((b) => b.id === 901);
  assert.ok(second, '第二颗还没爆');
  assert.ok(second.fuse <= w.C.CHAIN_DELAY + 0.001, '第二颗引信应被缩短');
  stepSeconds(w, 0.3);
  assert.ok(!w.bombs.some((b) => b.id === 901), '第二颗应连锁爆炸');
});

test('拾取道具提升能力', () => {
  const w = makeWorld();
  const p = World.addPlayer(w, { name: 'A' });
  World.addPlayer(w, { name: 'B' });
  startPlaying(w);
  const before = p.maxBombs;
  w.powerups.push({ id: 800, x: Math.round(p.x), y: Math.round(p.y), kind: 'bomb', kindIdx: 0 });
  World.step(w, DT);
  assert.strictEqual(p.maxBombs, before + 1);
  assert.strictEqual(w.powerups.length, 0);
});

test('怪物触碰杀死玩家', () => {
  const w = makeWorld({ MONSTER_BASE: 2 });
  const a = World.addPlayer(w, { name: 'A' });
  World.addPlayer(w, { name: 'B' });
  startPlaying(w);
  assert.ok(w.monsters.length >= 1, '应生成怪物');
  const m = w.monsters[0];
  a.spawnShield = 0;
  m.x = a.x; m.y = a.y; m.target = null;
  World.step(w, DT);
  assert.strictEqual(a.alive, false, '被怪物碰到应死亡');
});

test('火焰杀死怪物并给炸弹主人计分', () => {
  const w = makeWorld({ MONSTER_BASE: 2 });
  World.addPlayer(w, { name: 'A' });
  const b = World.addPlayer(w, { name: 'B' });
  startPlaying(w);
  assert.ok(w.monsters.length >= 1, '应生成怪物');
  const before = b.score;
  const m = w.monsters[0];
  const total = w.monsters.length;
  w.blasts.push({ x: Math.round(m.x), y: Math.round(m.y), part: 0, dir: 0, until: w.time + 1, owner: b.id });
  World.step(w, DT);
  assert.ok(w.monsters.length < total, '怪物应被烧死');
  assert.ok(b.score >= before + w.C.SCORE.monster, '击杀怪物应计分');
});

test('两人局：只剩一人时该玩家获胜', () => {
  const w = makeWorld();
  const a = World.addPlayer(w, { name: 'A' });
  const b = World.addPlayer(w, { name: 'B' });
  startPlaying(w);
  b.spawnShield = 0;
  w.blasts.push({ x: Math.round(b.x), y: Math.round(b.y), part: 0, dir: 0, until: w.time + 1, owner: a.id });
  World.step(w, DT);
  assert.strictEqual(w.round.state, 'ended');
  assert.strictEqual(w.round.winnerId, a.id);
  assert.strictEqual(a.wins, 1);
});

test('单人局：清空所有怪物即获胜', () => {
  const w = makeWorld({ MONSTER_BASE: 1 });
  const a = World.addPlayer(w, { name: 'A' });
  startPlaying(w);
  assert.strictEqual(w.round.participants, 1);
  assert.ok(w.monsters.length >= 1);
  for (const m of [...w.monsters]) {
    w.blasts.push({ x: Math.round(m.x), y: Math.round(m.y), part: 0, dir: 0, until: w.time + 1, owner: a.id });
  }
  World.step(w, DT);
  assert.strictEqual(w.round.state, 'ended');
  assert.strictEqual(w.round.winnerId, a.id);
});

test('突然死亡：超时后边缘逐格坍塌并压死角色', () => {
  const w = makeWorld({ ROUND_TIME: 1, SUDDEN_DEATH_INTERVAL: 0.05 });
  const a = World.addPlayer(w, { name: 'A' });
  const b = World.addPlayer(w, { name: 'B' });
  startPlaying(w);
  a.shield = true; // 坍塌无视护盾
  stepSeconds(w, 2); // 超过 ROUND_TIME，螺旋从 (1,1) 开始压
  assert.ok(w.sudden.active, '应进入突然死亡');
  assert.strictEqual(a.alive, false, '角落玩家应被压死（护盾无效）');
  assert.strictEqual(w.grid[1][1], World.TILE.WALL, '(1,1) 应已坍塌');
  void b;
});

test('回合结束后自动开启下一回合', () => {
  const w = makeWorld();
  const a = World.addPlayer(w, { name: 'A' });
  const b = World.addPlayer(w, { name: 'B' });
  startPlaying(w);
  b.spawnShield = 0;
  w.blasts.push({ x: Math.round(b.x), y: Math.round(b.y), part: 0, dir: 0, until: w.time + 1, owner: a.id });
  World.step(w, DT);
  assert.strictEqual(w.round.state, 'ended');
  stepSeconds(w, w.C.ROUND_END_DELAY + 0.5);
  assert.strictEqual(w.round.state, 'countdown');
  assert.strictEqual(w.round.num, 2);
  assert.strictEqual(b.alive, true, '新回合所有人复活');
});

test('移动与碰撞：玩家不能穿墙', () => {
  const w = makeWorld();
  const p = World.addPlayer(w, { name: 'A' });
  World.addPlayer(w, { name: 'B' });
  startPlaying(w);
  // 把玩家放到 (1,1)，向上/向左都是墙。
  // 判定盒半径 0.36，允许中心最多贴近到 0.5 + 0.36 = 0.86 左右
  const limit = 0.5 + w.C.PLAYER_RADIUS - 0.01;
  p.x = 1; p.y = 1;
  World.setInput(w, p.id, 0); // 上
  stepSeconds(w, 0.5);
  assert.ok(p.y >= limit, `不能穿过上边墙 (y=${p.y})`);
  World.setInput(w, p.id, 2); // 左
  stepSeconds(w, 0.5);
  assert.ok(p.x >= limit, `不能穿过左边墙 (x=${p.x})`);
});

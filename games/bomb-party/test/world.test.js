'use strict';

// 常驻世界模拟单元测试：node --test
const test = require('node:test');
const assert = require('node:assert');

const World = require('../server/world');

const DT = 1 / 30;

// 默认无怪物、固定种子的测试世界
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

// 把玩家挪到指定空地并清掉周围威胁
function placeAt(w, p, x, y) {
  w.grid[y][x] = World.TILE.EMPTY;
  p.x = x; p.y = y;
}

test('地图生成：边框与柱子为墙', () => {
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
});

test('加入即出生在空旷地，且有出路', () => {
  const w = makeWorld();
  const p = World.addPlayer(w, { name: '小红', color: 3 });
  assert.strictEqual(p.alive, true);
  assert.strictEqual(p.color, 3);
  assert.strictEqual(w.grid[p.y][p.x], World.TILE.EMPTY);
  const open =
    w.grid[p.y][p.x + 1] === World.TILE.EMPTY ||
    w.grid[p.y][p.x - 1] === World.TILE.EMPTY ||
    w.grid[p.y + 1][p.x] === World.TILE.EMPTY ||
    w.grid[p.y - 1][p.x] === World.TILE.EMPTY;
  assert.ok(open, '出生点应有出路');
});

test('炸弹爆炸摧毁砖块并安排再生', () => {
  const w = makeWorld();
  const p = World.addPlayer(w, { name: 'A' });
  placeAt(w, p, 1, 1);
  w.grid[1][2] = World.TILE.BRICK;
  World.requestBomb(w, p.id);
  World.step(w, DT);
  assert.strictEqual(w.bombs.length, 1);
  p.spawnShield = 99; // 测试中不关心自伤
  stepSeconds(w, 2.7);
  assert.strictEqual(w.bombs.length, 0, '炸弹应已爆炸');
  assert.strictEqual(w.grid[1][2], World.TILE.EMPTY, '砖块应被摧毁');
  assert.ok(w.regrow.some((r) => r.x === 2 && r.y === 1), '应安排砖块再生');
});

test('砖块到时间后再生（无人阻挡时）', () => {
  const w = makeWorld({ BRICK_REGROW_MIN: 0.5, BRICK_REGROW_MAX: 0.6 });
  const p = World.addPlayer(w, { name: 'A' });
  placeAt(w, p, 1, 1);
  w.grid[1][2] = World.TILE.BRICK;
  World.requestBomb(w, p.id);
  p.spawnShield = 99;
  stepSeconds(w, 2.7);
  assert.strictEqual(w.grid[1][2], World.TILE.EMPTY);
  placeAt(w, p, 9, 9); // 挪远，避免阻挡再生
  stepSeconds(w, 1.5);
  assert.strictEqual(w.grid[1][2], World.TILE.BRICK, '砖块应已再生');
});

test('死亡后自动重生并重置强化', () => {
  const w = makeWorld();
  const p = World.addPlayer(w, { name: 'A' });
  p.spawnShield = 0;
  p.maxBombs = 4;
  w.blasts.push({ x: Math.round(p.x), y: Math.round(p.y), part: 0, dir: 0, until: w.time + 0.3, owner: null });
  World.step(w, DT);
  assert.strictEqual(p.alive, false, '应被炸死');
  assert.strictEqual(p.deaths, 1);
  stepSeconds(w, w.C.RESPAWN_DELAY + 0.2);
  assert.strictEqual(p.alive, true, '应已自动重生');
  assert.strictEqual(p.maxBombs, w.C.BASE_BOMBS, '重生后强化重置');
  assert.ok(p.spawnShield > 0, '重生带保护');
});

test('死亡掉落强化道具', () => {
  const w = makeWorld();
  const p = World.addPlayer(w, { name: 'A' });
  placeAt(w, p, 9, 9);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    w.grid[9 + dy][9 + dx] = World.TILE.EMPTY;
  }
  p.spawnShield = 0;
  p.maxBombs = 3;
  p.range = 3;
  w.blasts.push({ x: 9, y: 9, part: 0, dir: 0, until: w.time + 0.3, owner: null });
  World.step(w, DT);
  assert.strictEqual(p.alive, false);
  assert.ok(w.pendingPowerups.length >= 1, '应有掉落道具待生成');
  stepSeconds(w, 1.5);
  assert.ok(w.powerups.length >= 1, '掉落道具应已出现');
});

test('击杀计分与连杀加成', () => {
  const w = makeWorld();
  const killer = World.addPlayer(w, { name: '杀手' });
  const victim = World.addPlayer(w, { name: '受害者' });
  placeAt(w, killer, 1, 1);
  const base = w.C.SCORE.kill;

  // 第一杀：基础分
  victim.spawnShield = 0;
  w.blasts.push({ x: Math.round(victim.x), y: Math.round(victim.y), part: 0, dir: 0, until: w.time + 0.3, owner: killer.id });
  World.step(w, DT);
  assert.strictEqual(victim.alive, false);
  assert.strictEqual(killer.kills, 1);
  assert.strictEqual(killer.score, base);
  assert.strictEqual(killer.streak, 1);

  // 等重生后第二杀：+连杀加成
  stepSeconds(w, w.C.RESPAWN_DELAY + 0.2);
  assert.strictEqual(victim.alive, true);
  victim.spawnShield = 0;
  w.blasts.push({ x: Math.round(victim.x), y: Math.round(victim.y), part: 0, dir: 0, until: w.time + 0.3, owner: killer.id });
  World.step(w, DT);
  assert.strictEqual(killer.kills, 2);
  assert.strictEqual(killer.streak, 2);
  assert.strictEqual(killer.score, base * 2 + w.C.SCORE.streakBonus, '第二杀应有连杀加成');
});

test('护盾可挡一次伤害', () => {
  const w = makeWorld();
  const p = World.addPlayer(w, { name: 'A' });
  p.spawnShield = 0;
  p.shield = true;
  w.blasts.push({ x: Math.round(p.x), y: Math.round(p.y), part: 0, dir: 0, until: w.time + 0.3, owner: null });
  World.step(w, DT);
  assert.strictEqual(p.alive, true, '护盾应挡下');
  assert.strictEqual(p.shield, false, '护盾应被消耗');
});

test('连锁爆炸：相邻炸弹被波及后引信缩短', () => {
  const w = makeWorld();
  const p = World.addPlayer(w, { name: 'A' });
  placeAt(w, p, 9, 9);
  p.spawnShield = 99;
  w.grid[9][10] = World.TILE.EMPTY;
  w.bombs.push({ id: 900, x: 9, y: 9, fuse: 0.05, range: 2, owner: p.id, passers: new Set([p.id]) });
  w.bombs.push({ id: 901, x: 10, y: 9, fuse: 99, range: 1, owner: p.id, passers: new Set() });
  stepSeconds(w, 0.1);
  const second = w.bombs.find((b) => b.id === 901);
  assert.ok(second, '第二颗还没爆');
  assert.ok(second.fuse <= w.C.CHAIN_DELAY + 0.001, '第二颗引信应被缩短');
  stepSeconds(w, 0.3);
  assert.ok(!w.bombs.some((b) => b.id === 901), '第二颗应连锁爆炸');
});

test('拾取道具提升能力，道具超时消失', () => {
  const w = makeWorld({ POWERUP_TTL: 0.5 });
  const p = World.addPlayer(w, { name: 'A' });
  const before = p.maxBombs;
  w.powerups.push({ id: 800, x: Math.round(p.x), y: Math.round(p.y), kind: 'bomb', kindIdx: 0, until: w.time + 10 });
  World.step(w, DT);
  assert.strictEqual(p.maxBombs, before + 1, '拾取生效');
  // 远处道具超时
  w.powerups.push({ id: 801, x: 1, y: 1, kind: 'fire', kindIdx: 1, until: w.time + w.C.POWERUP_TTL });
  stepSeconds(w, 0.8);
  assert.strictEqual(w.powerups.length, 0, '道具应超时消失');
});

test('怪物种群自动补充到目标数量', () => {
  const w = makeWorld({ MONSTER_BASE: 3, MONSTER_RESPAWN_INTERVAL: 0.1 });
  World.addPlayer(w, { name: 'A' });
  stepSeconds(w, 1);
  assert.ok(w.monsters.length >= 3, `怪物应补到目标数量（当前 ${w.monsters.length}）`);
});

test('怪物触碰杀死玩家；金史莱姆无害', () => {
  const w = makeWorld({ MONSTER_BASE: 1, MONSTER_RESPAWN_INTERVAL: 0.1 });
  const p = World.addPlayer(w, { name: 'A' });
  stepSeconds(w, 0.5);
  assert.ok(w.monsters.length >= 1);
  const m = w.monsters[0];
  // 金史莱姆改造成普通怪测试触碰
  m.type = 'slime';
  p.spawnShield = 0;
  m.x = p.x; m.y = p.y; m.target = null;
  World.step(w, DT);
  assert.strictEqual(p.alive, false, '被怪物碰到应死亡');
  // 金史莱姆碰到不死
  stepSeconds(w, w.C.RESPAWN_DELAY + 0.2);
  assert.strictEqual(p.alive, true);
  p.spawnShield = 0;
  const m2 = w.monsters[0];
  if (m2) {
    m2.type = 'gold';
    m2.x = p.x; m2.y = p.y; m2.target = null;
    World.step(w, DT);
    assert.strictEqual(p.alive, true, '金史莱姆应无害');
  }
});

test('火焰杀死怪物并按种类计分', () => {
  const w = makeWorld({ MONSTER_BASE: 1, MONSTER_RESPAWN_INTERVAL: 0.1 });
  const p = World.addPlayer(w, { name: 'A' });
  stepSeconds(w, 0.5);
  assert.ok(w.monsters.length >= 1);
  const m = w.monsters[0];
  m.type = 'ghost';
  const before = p.score;
  w.blasts.push({ x: Math.round(m.x), y: Math.round(m.y), part: 0, dir: 0, until: w.time + 0.3, owner: p.id });
  World.step(w, DT);
  assert.ok(!w.monsters.includes(m), '怪物应被烧死');
  assert.strictEqual(p.score, before + w.C.MONSTER_SCORE.ghost, '按种类计分');
});

test('世界常驻运行：长时间推进无异常', () => {
  const w = makeWorld({ MONSTER_BASE: 2, MONSTER_RESPAWN_INTERVAL: 0.5 });
  const p = World.addPlayer(w, { name: 'A' });
  World.setInput(w, p.id, 3);
  stepSeconds(w, 20);
  assert.ok(w.time > 19);
  assert.ok(w.players.has(p.id));
});

test('移动与碰撞：玩家不能穿墙', () => {
  const w = makeWorld();
  const p = World.addPlayer(w, { name: 'A' });
  placeAt(w, p, 1, 1);
  const limit = 0.5 + w.C.PLAYER_RADIUS - 0.01;
  World.setInput(w, p.id, 0); // 上
  stepSeconds(w, 0.5);
  assert.ok(p.y >= limit, `不能穿过上边墙 (y=${p.y})`);
  World.setInput(w, p.id, 2); // 左
  stepSeconds(w, 0.5);
  assert.ok(p.x >= limit, `不能穿过左边墙 (x=${p.x})`);
});

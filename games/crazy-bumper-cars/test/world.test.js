'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../server/world');
const C = require('../server/config');

function step(world, seconds) {
  const dt = 1 / C.TICK_RATE;
  for (let t = 0; t < seconds; t += dt) world.update(dt);
}

test('玩家加入后出生在场内且满血', () => {
  const w = new World();
  const p = w.addPlayer('测试员', 0);
  assert.ok(p.x > 0 && p.x < C.WORLD.w);
  assert.ok(p.y > 0 && p.y < C.WORLD.h);
  assert.strictEqual(p.hp, C.CAR.hp);
  assert.strictEqual(p.dead, false);
});

test('高速对撞会造成伤害并把双方弹开', () => {
  const w = new World();
  const a = w.addPlayer('撞人的', 0);
  const b = w.addPlayer('被撞的', 1);
  // 出生保护关掉
  a.invulnUntil = 0; b.invulnUntil = 0;
  // 面对面高速对撞
  a.x = 1000; a.y = 500; a.vx = 500; a.vy = 0;
  b.x = 1052; b.y = 500; b.vx = -300; b.vy = 0;
  w.update(1 / C.TICK_RATE);
  assert.ok(b.hp < C.CAR.hp, '被撞方应该掉血');
  assert.ok(a.vx < 0, '撞人的应该被弹回');
  assert.ok(b.vx > 0, '被撞的应该被击飞');
  assert.ok(a.score > 0, '主撞方按伤害得分');
});

test('低速轻碰不掉血', () => {
  const w = new World();
  const a = w.addPlayer('龟速甲', 0);
  const b = w.addPlayer('龟速乙', 1);
  a.invulnUntil = 0; b.invulnUntil = 0;
  a.x = 1000; a.y = 500; a.vx = 40;
  b.x = 1050; b.y = 500; b.vx = -40;
  w.update(1 / C.TICK_RATE);
  assert.strictEqual(a.hp, C.CAR.hp);
  assert.strictEqual(b.hp, C.CAR.hp);
});

test('出生保护期内不掉血', () => {
  const w = new World();
  const a = w.addPlayer('闪电侠', 0);
  const b = w.addPlayer('新兵', 1);
  a.invulnUntil = 0; // 攻击方无保护
  a.x = 1000; a.y = 500; a.vx = 700;
  b.x = 1054; b.y = 500; b.vx = 0;
  w.update(1 / C.TICK_RATE);
  assert.strictEqual(b.hp, C.CAR.hp, '保护期内应免伤');
});

test('打死对手记击杀、加分，死者重生', () => {
  const w = new World();
  const a = w.addPlayer('杀手', 0);
  const b = w.addPlayer('倒霉蛋', 1);
  a.invulnUntil = 0; b.invulnUntil = 0;
  b.hp = 1;
  let died = null;
  w.onDeath = (p, killer) => { died = { p, killer }; };
  a.x = 1000; a.y = 500; a.vx = 700;
  b.x = 1054; b.y = 500; b.vx = -100;
  w.update(1 / C.TICK_RATE);
  assert.ok(b.dead, '倒霉蛋应该死了');
  assert.strictEqual(a.kills, 1);
  assert.ok(a.score >= C.SCORE.kill);
  assert.strictEqual(died.killer, a);
  assert.strictEqual(b.score, 0, '死亡后得分清零');
  // 等待重生
  step(w, C.RESPAWN_MS / 1000 + 0.5);
  assert.ok(!b.dead, '应该已重生');
  assert.strictEqual(b.hp, C.CAR.hp);
});

test('按方向键直接朝该方向行驶（支持斜向）', () => {
  const w = new World();
  const p = w.addPlayer('直行者', 0);
  p.x = 1600; p.y = 1100; p.vx = 0; p.vy = 0;
  w.setInput(p.id, { right: true, down: true });
  step(w, 0.5);
  const dx = p.x - 1600, dy = p.y - 1100;
  assert.ok(dx > 50, '应向右移动, dx=' + dx);
  assert.ok(dy > 50, '应向下移动, dy=' + dy);
  assert.ok(Math.abs(dx - dy) < 5, '斜向应为 45 度');
  // 车头应转向行驶方向（右下 = π/4）
  assert.ok(Math.abs(p.angle - Math.PI / 4) < 0.1, '车头应朝右下, angle=' + p.angle);
});

test('车不会跑出地图边界', () => {
  const w = new World();
  const p = w.addPlayer('逃跑的', 0);
  p.x = 30; p.y = 30; p.vx = -2000; p.vy = -2000;
  step(w, 1);
  assert.ok(p.x >= C.CAR.r - 1);
  assert.ok(p.y >= C.CAR.r - 1);
});

test('电锯碰到会掉血并被弹飞', () => {
  const w = new World();
  const p = w.addPlayer('好奇宝宝', 0);
  p.invulnUntil = 0;
  const s = C.SAWS[0];
  p.x = s.x + s.r; p.y = s.y; p.vx = -200; p.vy = 0;
  w.update(1 / C.TICK_RATE);
  assert.ok(p.hp < C.CAR.hp, '应被电锯伤到');
  const speed = Math.hypot(p.vx, p.vy);
  assert.ok(speed > 400, '应被弹飞, 实际速度 ' + speed);
});

test('快照包含玩家和事件且事件只发一次', () => {
  const w = new World();
  w.addPlayer('快照员', 2);
  const s1 = w.snapshot();
  assert.strictEqual(s1.players.length, 1);
  assert.ok(s1.events.some(e => e.e === 'spawn'));
  const s2 = w.snapshot();
  assert.strictEqual(s2.events.length, 0, '事件队列应已清空');
});

test('实时排行按得分排序', () => {
  const w = new World();
  const a = w.addPlayer('第二名', 0);
  const b = w.addPlayer('第一名', 1);
  a.score = 100; b.score = 500;
  const board = w.liveBoard(10);
  assert.strictEqual(board[0].n, '第一名');
  assert.strictEqual(board[0].sc, 500);
});

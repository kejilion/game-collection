// ============================================================================
//  Tests for the authoritative world simulation (server/world.js).
//  Zero dependencies — Node's built-in runner:  npm test  (node --test, Node >=18)
//
//  The sim uses real Date.now() for cooldowns/protection, so tests that care
//  about timing reset those fields explicitly. `duel()` builds an isolated world
//  (no boss / merchants / items / obstacles) so combat assertions are
//  deterministic; seed/overview tests use a full `new World()`.
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert');
const { World } = require('../server/world');
const { BALANCE, WORLD } = require('../server/config');

// two un-protected players in an otherwise empty world, A at (500,500), B at (560,500)
function duel(clsA = 'warrior', clsB = 'mage') {
  const w = new World();
  w.bosses.clear(); w.merchants.clear(); w.items.clear(); w.obstacles.length = 0;
  const a = w.addPlayer('A', clsA);
  const b = w.addPlayer('B', clsB);
  a.spawnProtectUntil = 0; b.spawnProtectUntil = 0;
  a.x = 500; a.y = 500; b.x = 560; b.y = 500;
  return { w, a, b };
}

// ---- world bootstrap -------------------------------------------------------
test('world seeds bosses, merchants, items and obstacles', () => {
  const w = new World();
  assert.equal(w.bosses.size, BALANCE.boss.count);
  assert.equal(w.merchants.size, BALANCE.merchantCount);
  assert.ok(w.items.size > 0, 'items seeded');
  assert.ok(w.obstacles.length > 0, 'obstacles generated');
});

test('addPlayer / removePlayer track population and class', () => {
  const w = new World();
  const p = w.addPlayer('Hero', 'assassin');
  assert.ok(w.players.has(p.id));
  assert.equal(p.clsId, 'assassin');
  w.removePlayer(p.id);
  assert.ok(!w.players.has(p.id));
});

// ---- combat ----------------------------------------------------------------
test('melee attack damages a nearby enemy and grants xp', () => {
  const { w, a, b } = duel('warrior', 'mage');
  const hp0 = b.hp;
  w.doAttack(a);
  assert.ok(b.hp < hp0, 'enemy took damage');
  assert.ok(a.xp > 0, 'attacker gained xp from damage');
});

test('spawn protection blocks incoming damage', () => {
  const { w, a, b } = duel();
  b.spawnProtectUntil = Date.now() + 5000;     // re-protect B
  const hp0 = b.hp;
  w.doAttack(a);
  assert.equal(b.hp, hp0, 'protected player takes no damage');
});

test('attack respects its cooldown', () => {
  const { w, a, b } = duel();
  w.doAttack(a);
  const hp1 = b.hp;
  w.doAttack(a);                                // immediate second swing is on cooldown
  assert.equal(b.hp, hp1, 'second immediate attack dealt no damage');
});

test('mage projectile travels and hits the only enemy', () => {
  const { w, a, b } = duel('mage', 'warrior');
  a.x = 400; a.y = 400; b.x = 700; b.y = 400;
  w.doAttack(a);
  assert.equal(w.projectiles.size, 1, 'one projectile spawned');
  const hp0 = b.hp;
  for (let i = 0; i < 60; i++) w.update(0.033);
  assert.ok(b.hp < hp0, 'projectile eventually hit the target');
});

// ---- progression -----------------------------------------------------------
test('xp accumulation triggers a level up and a full heal', () => {
  const w = new World();
  const p = w.addPlayer('Lv', 'warrior');
  p.hp = 1;
  w.gainXp(p, p.xpNext + 5);
  assert.ok(p.level >= 2, 'leveled up');
  assert.equal(p.hp, p.effMaxHp(), 'restored to full hp on level up');
});

test('applyItem: heal caps at max, life adds, timed buff is set', () => {
  const w = new World();
  const p = w.addPlayer('I', 'warrior');
  p.hp = p.effMaxHp();
  w.applyItem(p, 'heal');
  assert.equal(p.hp, p.effMaxHp(), 'heal never exceeds max hp');
  const lives0 = p.extraLives;
  w.applyItem(p, 'life');
  assert.equal(p.extraLives, lives0 + 1, 'extra life granted');
  w.applyItem(p, 'speed');
  assert.ok(p.hasBuff('speed', Date.now()), 'speed buff active');
});

// ---- death / respawn -------------------------------------------------------
test('extra life revives in place instead of dying', () => {
  const { w, a } = duel();
  a.extraLives = 1;
  w.damageEntity(a, 99999, null);
  assert.equal(a.dead, false, 'survived via extra life');
  assert.equal(a.extraLives, 0, 'consumed the extra life');
});

test('lethal damage kills the victim, drops loot, credits the killer', () => {
  const { w, a, b } = duel();
  const items0 = w.items.size;                  // 0 (duel clears items)
  w.damageEntity(b, 99999, a);
  assert.equal(b.dead, true, 'victim died');
  assert.equal(a.kills, 1, 'killer credited with the kill');
  assert.ok(w.items.size > items0, 'loot scattered on death');
});

test('a dead player respawns at full hp after the delay', () => {
  const { w, b } = duel();
  w.damageEntity(b, 99999, null);
  assert.equal(b.dead, true);
  b.respawnAt = Date.now() - 1;                 // fast-forward the respawn timer
  w.update(0.033);
  assert.equal(b.dead, false, 'respawned');
  assert.equal(b.hp, b.effMaxHp(), 'respawned at full hp');
});

// ---- skills: level-gated unlock + the per-class second skill ---------------
test('skill 2 is gated behind its required level', () => {
  const { w, a, b } = duel('mage', 'warrior');
  a.x = 500; a.y = 500; b.x = 560; b.y = 500;
  const hp0 = b.hp;
  a.level = 1;
  w.doSkill(a, 1);                              // 霜雪新星 needs Lv.3 — blocked while under-leveled
  assert.equal(b.hp, hp0, 'locked skill does nothing below its required level');
  a.level = 3;
  w.doSkill(a, 1);                              // now unlocked
  assert.ok(b.hp < hp0, 'skill fires once the level requirement is met');
});

test('frost nova (mage skill 2) damages and slows enemies in range', () => {
  const { w, a, b } = duel('mage', 'warrior');
  a.x = 500; a.y = 500; b.x = 560; b.y = 500; a.level = 3;
  const full = b.effSpeed(Date.now());
  const hp0 = b.hp;
  w.doSkill(a, 1);
  assert.ok(b.hp < hp0, 'nova dealt damage');
  assert.ok(b.slowUntil > Date.now(), 'enemy is chilled');
  assert.ok(b.effSpeed(Date.now()) < full, 'slowed move speed is lower than normal');
});

test('war cry (warrior skill 2) heals and braces against incoming damage', () => {
  const { w, a, b } = duel('warrior', 'warrior');
  a.x = 500; a.y = 500; b.x = 560; b.y = 500;
  a.level = 3; a.hp = 60; a.spawnProtectUntil = 0;
  w.doSkill(a, 1);
  assert.ok(a.hp > 60, 'war cry restored health');
  assert.ok(a.hasBuff('guard', Date.now()), 'brace (guard) buff is active');
  const before = a.hp;
  w.damageEntity(a, 100, b);
  assert.ok(before - a.hp < 100, 'guard reduced the hit below its raw amount');
});

test('shadow veil (assassin skill 2) blinks the held direction and cloaks', () => {
  const { w, a, b } = duel('assassin', 'warrior');
  a.x = 500; a.y = 500; b.x = 560; b.y = 500; a.level = 3;
  a.input = { up: false, down: false, left: true, right: false };   // flee left
  const x0 = a.x;
  w.doSkill(a, 1);
  assert.ok(a.x < x0, 'dashed in the held (left) direction');
  assert.ok(a.hasBuff('invis', Date.now()), 'cloaked while escaping');
});

// ---- shop ------------------------------------------------------------------
test('buy() validates merchant proximity and gold', () => {
  const w = new World();
  const p = w.addPlayer('Buyer', 'warrior');
  for (const m of w.merchants.values()) { m.x = 1; m.y = 1; }   // merchants far away
  p.x = WORLD.width - 1; p.y = WORLD.height - 1;
  assert.equal(w.buy(p, 'heal').ok, false, 'rejected: no merchant nearby');
  const m = [...w.merchants.values()][0]; m.x = p.x; m.y = p.y; // bring one adjacent
  p.gold = 0;
  assert.equal(w.buy(p, 'heal').ok, false, 'rejected: not enough gold');
  p.gold = 9999;
  assert.equal(w.buy(p, 'heal').ok, true, 'succeeds near a merchant with gold');
});

// ---- area-of-interest serialization ---------------------------------------
test('viewFor culls entities outside the rect but keeps global fx', () => {
  const { w, a, b } = duel();
  a.x = 500; a.y = 500; b.x = 3000; b.y = 2000;       // B far outside the rect
  w.pushFx({ t: 'killfeed', killer: 'A', victim: 'B' }); // global announcement (no x/y)
  w.pushFx({ t: 'hit', x: 3000, y: 2000 });             // positional, far away
  w.prepareSnapshot();
  const slice = w.viewFor({ x0: 300, y0: 300, x1: 800, y1: 800 }, a);
  const ids = slice.players.map(p => p.id);
  assert.ok(ids.includes(a.id), 'self is in view');
  assert.ok(!ids.includes(b.id), 'far player is culled');
  assert.ok(slice.fx.some(f => f.t === 'killfeed'), 'global fx is always delivered');
  assert.ok(!slice.fx.some(f => f.t === 'hit'), 'far positional fx is culled');
});

test('viewFor hides invisible rivals but not self or reveal-holders', () => {
  const { w, a, b } = duel();
  a.x = 500; a.y = 500; b.x = 560; b.y = 500;           // close together, both in rect
  b.buffs.invis = Date.now() + 10000;                   // B turns invisible
  const rect = { x0: 300, y0: 300, x1: 800, y1: 800 };

  w.prepareSnapshot();
  assert.ok(!w.viewFor(rect, a).players.some(p => p.id === b.id), 'invisible rival hidden from A');
  assert.ok(w.viewFor(rect, b).players.some(p => p.id === b.id), 'a player always sees itself');

  a.buffs.reveal = Date.now() + 10000;                  // A gains 洞察之眼
  w.prepareSnapshot();
  assert.ok(w.viewFor(rect, a).players.some(p => p.id === b.id), 'reveal surfaces the invisible rival');
});

test('overview lists every entity for the minimap', () => {
  const w = new World();
  w.addPlayer('A', 'warrior'); w.addPlayer('B', 'mage');
  const ov = w.overview();
  assert.ok(ov.players.length >= 2, 'all players blipped');
  assert.ok(ov.bosses.length >= 1, 'boss blipped');
  assert.ok(ov.merchants.length >= 1, 'merchants blipped');
});

test('realtimeLeaderboard ranks players by score', () => {
  const { w, a, b } = duel();
  a.kills = 5; b.kills = 1;
  const lb = w.realtimeLeaderboard(8);
  assert.equal(lb[0].name, 'A', 'higher score ranks first');
});

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
const { BALANCE, WORLD, DAY_NIGHT, dayNightLightAt } = require('../server/config');

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

function tickProjectiles(w, maxTicks = 30) {
  for (let i = 0; i < maxTicks && w.projectiles.size > 0; i++) w.update(0.033);
}

// ---- world bootstrap -------------------------------------------------------
test('world seeds bosses, merchants, items and obstacles', () => {
  const w = new World();
  assert.equal(w.bosses.size, BALANCE.boss.count);
  assert.equal(w.merchants.size, BALANCE.merchantCount);
  assert.ok(w.items.size > 0, 'items seeded');
  assert.ok(w.obstacles.length > 0, 'obstacles generated');
});

test('day-night cycle moves smoothly through all four phases and repeats', () => {
  const { dayMs, duskMs, nightMs, dawnMs, nightVisibility } = DAY_NIGHT;
  assert.deepEqual(dayNightLightAt(0), { phase: 'day', visibility: 1, phaseProgress: 0 });
  assert.deepEqual(dayNightLightAt(dayMs), { phase: 'dusk', visibility: 1, phaseProgress: 0 });
  assert.equal(dayNightLightAt(dayMs + duskMs / 2).visibility, 0.75, 'dusk reaches the midpoint smoothly');
  assert.equal(dayNightLightAt(dayMs + duskMs / 2).phaseProgress, 0.5, 'dusk scroll is halfway to night');
  assert.deepEqual(dayNightLightAt(dayMs + duskMs), { phase: 'night', visibility: nightVisibility, phaseProgress: 0 });
  assert.equal(dayNightLightAt(dayMs + duskMs + nightMs + dawnMs / 2).visibility, 0.75, 'dawn restores sight smoothly');
  assert.equal(dayNightLightAt(dayMs + duskMs + nightMs + dawnMs / 2).phaseProgress, 0.5, 'dawn scroll is halfway to day');
  assert.deepEqual(dayNightLightAt(dayMs + duskMs + nightMs + dawnMs), { phase: 'day', visibility: 1, phaseProgress: 0 });
});

test('world snapshots include the shared day-night light state', () => {
  const w = new World();
  const p = w.addPlayer('Light', 'warrior');
  w.prepareSnapshot();
  const state = w.viewFor({ x0: -1, y0: -1, x1: WORLD.width + 1, y1: WORLD.height + 1 }, p);
  assert.equal(state.light.phase, 'day');
  assert.equal(state.light.visibility, 1);
  assert.ok(state.light.phaseProgress >= 0 && state.light.phaseProgress < 1);
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

test('applyItem: life pickups cap total lives at BALANCE.maxLives', () => {
  const w = new World();
  const p = w.addPlayer('L', 'warrior');
  for (let i = 0; i < 12; i++) w.applyItem(p, 'life');     // spam well past the cap
  assert.equal(p.extraLives, BALANCE.maxLives - 1, 'extra lives stop at maxLives-1');
  assert.equal(1 + p.extraLives, BALANCE.maxLives, 'total lives (current + extra) never exceed maxLives');
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

test('BOSS kill does not falsely credit a bystander via lastHitBy', () => {
  // BOSS finishes a player who had previously been hit by another player.
  // The other player must NOT be credited with the kill (regression: BOSS
  // kills used to fall back to target.lastHitBy).
  const w = new World();
  w.merchants.clear(); w.items.clear(); w.obstacles.length = 0;
  const victim = w.addPlayer('Victim', 'warrior');
  const bystander = w.addPlayer('Bystander', 'warrior');
  victim.spawnProtectUntil = 0; bystander.spawnProtectUntil = 0;
  victim.x = 500; victim.y = 500; bystander.x = 800; bystander.y = 500;
  const boss = [...w.bosses.values()][0];
  boss.x = victim.x + 30; boss.y = victim.y;       // adjacent → next tick will hit
  victim.hp = 1;                                  // one-shot by BOSS contact
  // simulate "victim was recently hit by bystander" — this is the trap that
  // made the old code falsely credit bystander.
  victim.lastHitBy = bystander.id;
  const killsBefore = bystander.kills;
  w.update(0.033);                                 // run a tick so the BOSS lands its hit
  assert.equal(victim.dead, true, 'victim is dead');
  assert.equal(bystander.kills, killsBefore, 'bystander not credited for a BOSS kill');
});

test('BOSS kill of a player emits a killfeed entry tagged killerKind=boss', () => {
  const w = new World();
  w.merchants.clear(); w.items.clear(); w.obstacles.length = 0;
  const victim = w.addPlayer('V', 'warrior');
  victim.spawnProtectUntil = 0;
  victim.x = 500; victim.y = 500;
  const boss = [...w.bosses.values()][0];
  boss.x = victim.x + 30; boss.y = victim.y;
  victim.hp = 1;
  // drain any pre-existing killfeed entries from world bootstrap
  w.fx.length = 0;
  w.update(0.033);
  const feed = w.fx.find(f => f.t === 'killfeed' && f.victimId === victim.id && f.killerKind === 'boss');
  assert.ok(feed, 'killfeed entry exists for the BOSS kill');
  assert.equal(feed.killerId, null, 'BOSS has no player id');
  assert.equal(feed.victimId, victim.id, 'victim id preserved');
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
  tickProjectiles(w);
  assert.ok(b.hp < hp0, 'skill fires once the level requirement is met');
});

test('frost nova (mage skill 2) damages and slows enemies in range', () => {
  const { w, a, b } = duel('mage', 'warrior');
  a.x = 500; a.y = 500; b.x = 560; b.y = 500; a.level = 3;
  const full = b.effSpeed(Date.now());
  const hp0 = b.hp;
  w.doSkill(a, 1);
  tickProjectiles(w);
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

// ---- permanent shop --------------------------------------------------------
test('mage projectile hits a merchant after a tick', () => {
  const w = new World();
  w.bosses.clear(); w.items.clear(); w.obstacles.length = 0;
  const p = w.addPlayer('P', 'mage');
  const m = [...w.merchants.values()][0];
  m.x = p.x + 200; m.y = p.y; m.state = 'idle';
  p.spawnProtectUntil = 0; p.attackReadyAt = 0;
  const before = m.hp;
  w.doAttack(p);
  // tick until projectile resolves (mage projSpeed 470 → ~10 ticks to cover 200px)
  for (let i = 0; i < 30 && w.projectiles.size > 0; i++) w.update(0.033);
  assert.ok(m.hp < before, 'mage projectile actually damages the merchant');
});

test('melee attack damages a merchant (target list now includes merchants)', () => {
  const w = new World();
  w.bosses.clear(); w.items.clear(); w.obstacles.length = 0;
  const p = w.addPlayer('P', 'warrior');
  const m = [...w.merchants.values()][0];
  // park the merchant 30 px away (well inside melee range = 130) and zero its cooldown
  m.x = p.x + 30; m.y = p.y;
  p.spawnProtectUntil = 0; p.attackReadyAt = 0;
  m.state = 'idle';
  const before = m.hp;
  w.doAttack(p);
  assert.ok(m.hp < before, 'merchant took damage from a melee attack');
  // merchant hits never grant xp or gold (per damageEntity guard)
  const xpBefore = p.xp, goldBefore = p.gold;
  w.doAttack(p);
  assert.equal(p.xp, xpBefore, 'hitting merchant does not grant xp');
  assert.equal(p.gold, goldBefore, 'hitting merchant does not grant gold');
});

test('lethal merchant damage queues the merchant for respawn', () => {
  const w = new World();
  w.bosses.clear(); w.items.clear(); w.obstacles.length = 0;
  const p = w.addPlayer('P', 'warrior');
  const m = [...w.merchants.values()][0];
  // warrior is melee_aoe, so a single doAttack() resolves the hit — no need to tick projectiles
  m.x = p.x + 30; m.y = p.y;
  p.spawnProtectUntil = 0; p.attackReadyAt = 0;
  m.hp = 1; m.state = 'idle';
  const id = m.id;
  w.doAttack(p);
  assert.equal(m.hp <= 0, true, 'merchant drops to <= 0 hp');
  assert.equal(w.merchants.has(id), false, 'merchant removed from live map');
  assert.equal(w.merchantRespawns.length, 1, 'merchant queued for respawn');
});

test('permanentBuy() validates merchant proximity, gold, and ownership', () => {
  const w = new World();
  const p = w.addPlayer('Buyer', 'warrior');
  for (const m of w.merchants.values()) { m.x = 1; m.y = 1; }   // merchants far away
  p.x = WORLD.width - 1; p.y = WORLD.height - 1;
  // far from merchant
  assert.equal(w.permanentBuy(p, 'eq_hp1').ok, false, 'rejected: no merchant nearby');
  // bring a merchant adjacent, no gold
  const m = [...w.merchants.values()][0]; m.x = p.x; m.y = p.y;
  p.gold = 0;
  assert.equal(w.permanentBuy(p, 'eq_hp1').ok, false, 'rejected: not enough gold');
  // pay up — equipment piece applies bonus and tracks ownership
  p.gold = 9999;
  const r = w.permanentBuy(p, 'eq_hp1');
  assert.equal(r.ok, true, 'succeeds near a merchant with gold');
  assert.equal(p.equip.hp, 40, 'eq_hp1 raises equip.hp by 40');
  assert.equal(p.boughtEquipment.has('eq_hp1'), true, 'owned set tracks purchase');
  // re-buy is rejected
  assert.equal(w.permanentBuy(p, 'eq_hp1').ok, false, 'rejected: already owned');
  // cosmetic must match class
  const cos = w.permanentBuy(p, 'm_skin_arcane');   // mage skin
  assert.equal(cos.ok, false, 'rejected: cosmetic not for current class');
  const wcos = w.permanentBuy(p, 'w_skin_crimson'); // warrior skin
  assert.equal(wcos.ok, true, 'succeeds: warrior skin for a warrior');
  assert.equal(p.cosmetic.skin, 'crimson', 'skin applied to cosmetic state');
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

// ---- invisibility / stealth rigor -----------------------------------------
// These tests cover the boss-side invisibility gaps, the buff-clearing on
// death, the overview coordinate masking, and the snapshot fields the client
// needs to mirror its speed prediction.

test('BOSS nearestPlayer skips stealthed heroes', () => {
  // Two heroes in aggro range of a boss; the cloaked one is nearer. The BOSS
  // must ignore the cloak and pick the visible one (this is the core "stealth
  // breaks aggro" promise for the assassin's escape kit).
  const w = new World();
  w.merchants.clear(); w.items.clear(); w.obstacles.length = 0;
  const boss = [...w.bosses.values()][0];
  const visible = w.addPlayer('Vis', 'warrior');
  const hidden = w.addPlayer('Hid', 'assassin');
  visible.spawnProtectUntil = 0; hidden.spawnProtectUntil = 0;
  boss.x = 1000; boss.y = 1000;
  visible.x = 1080; visible.y = 1000;       // 80 px away
  hidden.x = 1020; hidden.y = 1000;          // 20 px away — closer, but cloaked
  hidden.buffs.invis = Date.now() + 5000;
  const target = w.nearestPlayer(boss, 500);
  assert.equal(target && target.id, visible.id, 'stealthed hero is skipped');
});

test('BOSS updateBoss drops a stealthed targetId and re-acquires visible', () => {
  // The boss should release its sticky target the moment the target goes
  // invisible, then fall back to nearestPlayer (which also filters invis).
  const w = new World();
  w.merchants.clear(); w.items.clear(); w.obstacles.length = 0;
  const boss = [...w.bosses.values()][0];
  const hero = w.addPlayer('H', 'warrior');
  const other = w.addPlayer('O', 'warrior');
  hero.spawnProtectUntil = 0; other.spawnProtectUntil = 0;
  boss.x = 1000; boss.y = 1000;
  hero.x = 1100; hero.y = 1000;              // currently targeted
  other.x = 1200; other.y = 1000;            // farther visible hero
  boss.targetId = hero.id;
  // run a tick so updateBoss latches a baseline
  w.update(0.033);
  assert.equal(boss.targetId, hero.id, 'locks onto visible hero first');
  // hero cloaks; one tick should drop the lock
  hero.buffs.invis = Date.now() + 5000;
  w.update(0.033);
  assert.notEqual(boss.targetId, hero.id, 'stealthed hero dropped from targetId');
  assert.equal(boss.targetId, other.id, 'falls back to nearest visible hero');
});

test('bossSlam and bossDrain skip stealthed heroes', () => {
  // AOE boss abilities should not hit cloaked players standing in the ring.
  const w = new World();
  w.merchants.clear(); w.items.clear(); w.obstacles.length = 0;
  const boss = [...w.bosses.values()][0];
  const cloaked = w.addPlayer('C', 'warrior');
  cloaked.spawnProtectUntil = 0;
  boss.x = 1000; boss.y = 1000;
  cloaked.x = 1020; cloaked.y = 1000;       // right next to the boss
  cloaked.buffs.invis = Date.now() + 5000;
  const hp0 = cloaked.hp;
  w.bossSlam(boss, { dmg: 50, radius: 200 });
  assert.equal(cloaked.hp, hp0, 'bossSlam did not damage cloaked hero');
  const hp1 = cloaked.hp;
  w.bossDrain(boss, { dmg: 30, radius: 200, heal: 0.5 });
  assert.equal(cloaked.hp, hp1, 'bossDrain did not damage cloaked hero');
});

test('handleDeath clears buffs so respawn body has no leftover stealth/speed/reveal', () => {
  // A hero who dies while cloaked / hasted / reveal-buffed must respawn
  // without those timers. The pre-fix bug let them keep their invis for the
  // remaining time on respawn — visible to the server, invisible to rivals.
  const { w, a } = duel();
  a.buffs.invis = Date.now() + 10000;
  a.buffs.speed = Date.now() + 8000;
  a.buffs.reveal = Date.now() + 10000;
  // lethal hit drops the player; the buff sweep runs immediately.
  w.damageEntity(a, 99999, null);
  assert.equal(a.dead, true);
  assert.equal(Object.keys(a.buffs).length, 0, 'buffs cleared on lethal death');
  // respawn body (next tick past respawnAt) — still empty.
  a.respawnAt = Date.now() - 1;
  w.update(0.033);
  assert.equal(a.dead, false, 'respawned');
  assert.equal(Object.keys(a.buffs).length, 0, 'buffs still empty after respawn');
});

test('extra-life revive also clears buffs (no stealth-on-revive exploit)', () => {
  // The 复活之心 in-place revive should also reset combat state; otherwise
  // a player would pop right back into invis with a half-tick left on their
  // 影遁 cloak.
  const { w, a } = duel();
  a.extraLives = 1;
  a.buffs.invis = Date.now() + 10000;
  w.damageEntity(a, 99999, null);
  assert.equal(a.dead, false, 'extra life kept the hero alive');
  assert.equal(Object.keys(a.buffs).length, 0, 'buffs cleared on revive');
});

test('overview() masks invisible player x/y when nobody has reveal', () => {
  // Anti-cheat: the 200ms minimap stream shouldn't leak precise coords for a
  // cloaked player. Without anyone holding 洞察之眼, x/y must be nulled.
  const w = new World();
  w.merchants.clear(); w.items.clear(); w.obstacles.length = 0;
  const cloaked = w.addPlayer('Cloak', 'warrior');
  cloaked.buffs.invis = Date.now() + 10000;
  const ov = w.overview();
  const me = ov.players.find(p => p.id === cloaked.id);
  assert.ok(me, 'player appears in overview');
  assert.equal(me.invis, true, 'invis flag set');
  assert.equal(me.x, null, 'x masked while no reveal-buff exists');
  assert.equal(me.y, null, 'y masked while no reveal-buff exists');
});

test('overview() reveals invisible player x/y once anyone holds reveal', () => {
  // Once any hero has 洞察之眼, stealth's "hide from everyone" promise is
  // already broken for that frame — no point masking (and doing so would
  // even create a side channel: the reveal-holder's own dot would still
  // appear, letting anyone infer the masking by checking who vanished).
  const w = new World();
  w.merchants.clear(); w.items.clear(); w.obstacles.length = 0;
  const cloaked = w.addPlayer('Cloak', 'warrior');
  const seer = w.addPlayer('Seer', 'mage');
  cloaked.buffs.invis = Date.now() + 10000;
  seer.buffs.reveal = Date.now() + 10000;
  const ov = w.overview();
  const me = ov.players.find(p => p.id === cloaked.id);
  assert.ok(me, 'player appears in overview');
  assert.equal(typeof me.x, 'number', 'x is numeric while reveal-buff exists');
  assert.equal(typeof me.y, 'number', 'y is numeric while reveal-buff exists');
});

test('prepareSnapshot includes slowUntil / slowMul for client prediction', () => {
  // predictSelf on the client mirrors effSpeed(), which includes the slow
  // debuff. The snapshot must carry both fields or the client will predict
  // full speed until the server corrects (a visible jitter on 霜雪新星 hit).
  const w = new World();
  w.merchants.clear(); w.items.clear(); w.obstacles.length = 0;
  const p = w.addPlayer('P', 'mage');
  w.applySlow(p, 2500, 0.5);
  w.prepareSnapshot();
  const rect = { x0: -1, y0: -1, x1: WORLD.width + 1, y1: WORLD.height + 1 };
  const slice = w.viewFor(rect, p);
  const me = slice.players.find(x => x.id === p.id);
  assert.ok(me, 'self appears in snapshot');
  assert.ok(me.slowUntil > Date.now(), 'slowUntil is in the future');
  assert.equal(me.slowMul, 0.5, 'slowMul mirrors the applied slow');
});

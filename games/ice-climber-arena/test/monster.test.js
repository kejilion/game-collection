// Unit tests for the expanded monster roster (6 small kinds, 2–3 per level)
// and the per-round boss (6 kinds, one random per round).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateLevel } from '../server/game/Level.js';
import { Monster } from '../server/game/Monster.js';
import {
  MonsterKind, BossKind, MONSTER_TYPES, BOSS_TYPES, FLOOR_COUNT, floorTopY,
} from '../public/shared/constants.js';

const smallKinds = Object.values(MonsterKind);
const bossKinds = Object.values(BossKind);
const fakePlayer = (x, y) => ({ x, y, alive: true, rescued: false, invuln: 0 });

test('every level fields one boss and a small 2–3 kind roster', () => {
  const seenBoss = new Set();
  for (let r = 1; r <= 40; r++) {
    const lv = generateLevel(r);

    // exactly one boss, valid kind, on a real high floor, with a patrol band
    assert.ok(lv.boss, 'level has a boss');
    assert.ok(bossKinds.includes(lv.boss.kind), 'valid boss kind: ' + lv.boss.kind);
    assert.ok(lv.boss.minX < lv.boss.maxX, 'boss has a patrol band');
    assert.ok(lv.boss.floor >= 2 && lv.boss.floor <= FLOOR_COUNT - 2, 'boss on a high interior floor');
    seenBoss.add(lv.boss.kind);

    // small monsters only ever use a handful of distinct, valid kinds
    const kinds = new Set(lv.monsters.map((m) => m.kind));
    assert.ok(kinds.size >= 1 && kinds.size <= 3, 'roster of 1–3 kinds, got ' + kinds.size);
    for (const k of kinds) assert.ok(smallKinds.includes(k), 'valid small kind: ' + k);
  }
  // across many rounds the boss really is randomised (not stuck on one kind)
  assert.ok(seenBoss.size >= 3, 'multiple boss kinds appear over time, got ' + seenBoss.size);
});

test('monster patrol band is widened past the climb band', () => {
  // a mid-tower wall floor monster should roam a band much wider than the old
  // (band − 32) bounds; just assert it spans a healthy chunk of the world.
  let widest = 0;
  for (let r = 0; r < 40; r++) {
    for (const m of generateLevel(3).monsters) widest = Math.max(widest, m.maxX - m.minX);
  }
  assert.ok(widest > 700, 'some monster patrols a wide band, widest=' + widest);
});

test('all six small kinds simulate safely and stay inside their band', () => {
  const y = floorTopY(4);
  for (const kind of smallKinds) {
    const m = new Monster({ kind, minX: 200, maxX: 1400, y });
    const support = { y, minX: 0, maxX: 1600 };
    const players = [fakePlayer(700, y)];
    let fired = false;
    for (let i = 0; i < 400; i++) {
      const act = m.update(1 / 60, players, support);
      if (act && act.bolts) fired = true;
      assert.ok(Number.isFinite(m.x) && Number.isFinite(m.y), kind + ' finite');
      assert.ok(m.x >= m.minX - 1 && m.x <= m.maxX + 1, kind + ' stays in band');
    }
    const beh = MONSTER_TYPES[kind].behavior;
    if (beh === 'aimed' || beh === 'spread') assert.ok(fired, kind + ' eventually fires a bolt');
  }
});

test('all six bosses simulate safely: anchored hold their floor, the flyer hovers, the queen summons', () => {
  const y = floorTopY(7);
  for (const kind of bossKinds) {
    const m = new Monster({ boss: true, kind, minX: 200, maxX: 1400, y, floor: 7 });
    const players = [fakePlayer(800, y - 40)];
    let summon = 0, bolts = 0;
    for (let i = 0; i < 600; i++) {
      const support = (m.fly || m.anchored) ? null : { y, minX: 0, maxX: 1600 };
      const act = m.update(1 / 60, players, support);
      if (act && act.summon) summon += act.summon;
      if (act && act.bolts) bolts += act.bolts.length;
      assert.ok(Number.isFinite(m.x) && Number.isFinite(m.y), kind + ' finite');
    }
    const def = BOSS_TYPES[kind];
    if (def.fly) assert.ok(m.y < y - 40, 'wyvern hovers above its floor');
    else assert.ok(Math.abs(m.y - y) < 1.5, kind + ' stays anchored on its floor');
    if (def.behavior === 'summon') assert.ok(summon > 0, 'queen summons adds');
    if (['volley', 'radial', 'fly'].includes(def.behavior)) assert.ok(bolts > 0, kind + ' fires bolts');
  }
});

test('a boss summons capped adds inside a running room', async () => {
  const { GameRoom } = await import('../server/game/GameRoom.js');
  const { Leaderboard } = await import('../server/game/Leaderboard.js');
  const room = new GameRoom({ emit() {}, volatile: { emit() {} } }, new Leaderboard({ persist: false }));
  // force a queen boss adjacent to a player so it actually summons
  room.monsters = room.monsters.filter((m) => !m.boss);
  const y = floorTopY(6);
  const queen = new Monster({ boss: true, kind: BossKind.QUEEN, minX: 200, maxX: 1400, x: 800, y, floor: 6 });
  room.monsters.push(queen);
  const p = room.addPlayer('q', 'Q', {});
  p.x = 800; p.y = y - 30; p.updateFloor();
  for (let i = 0; i < 60 * 12; i++) room.tick(); // ~12s: a couple of summon waves
  const adds = room.monsters.filter((m) => m.summonedBy === queen.id).length;
  assert.ok(adds <= 3, 'summoned adds are capped, got ' + adds);
});

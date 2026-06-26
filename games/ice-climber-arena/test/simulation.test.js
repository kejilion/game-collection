// Headless smoke + unit tests for the authoritative simulation.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateLevel } from '../server/game/Level.js';
import { Leaderboard } from '../server/game/Leaderboard.js';
import { GameRoom } from '../server/game/GameRoom.js';
import { stepPlayer, buildRects } from '../public/shared/physics.js';
import {
  FLOOR_COUNT, Tile, floorTopY, PLAYER_H, GROUND_THICKNESS, WORLD_WIDTH,
} from '../public/shared/constants.js';

const mockIo = () => ({ emit() {}, volatile: { emit() {} } });

test('level has a climbable, well-formed structure', () => {
  const lv = generateLevel(3);
  assert.equal(lv.floors.length, FLOOR_COUNT);
  // ground floor spans the world
  const ground = lv.platforms.find((p) => p.type === Tile.GROUND);
  assert.ok(ground && ground.w >= WORLD_WIDTH - 1);
  // a guaranteed main ledge on every floor above ground
  for (let i = 1; i < FLOOR_COUNT; i++) {
    assert.ok(lv.platforms.some((p) => p.floor === i && p.main), `floor ${i} has a main ledge`);
  }
  // rescue pad on top
  assert.ok(lv.topPadId != null);
  assert.ok(lv.platforms.find((p) => p.id === lv.topPadId).floor === FLOOR_COUNT - 1);
});

test('physics: a player falls and lands on the ground', () => {
  const lv = generateLevel(1);
  const rects = buildRects(lv.platforms, new Set(), 0);
  const s = { x: WORLD_WIDTH / 2, y: 100, vx: 0, vy: 0, facing: 1, onGround: false, jumpHeld: false, fallStartY: 100 };
  const noInput = { left: false, right: false, jump: false, attack: false };
  let landed = false;
  for (let i = 0; i < 600 && !landed; i++) {
    const ev = stepPlayer(s, noInput, rects, 1 / 60, {});
    if (ev.landed) landed = true;
  }
  assert.ok(landed, 'player eventually lands');
  assert.ok(s.onGround, 'player is grounded');
  // rests exactly on top of some solid surface (ground or a ledge below center)
  const feet = s.y + PLAYER_H / 2;
  const onSurface = rects.some((r) =>
    Math.abs(feet - r.y) < 1.5 && s.x >= r.x - 1 && s.x <= r.x + r.w + 1);
  assert.ok(onSurface, 'feet rest on a platform top');
});

test('physics: head-bonk reports breakable ice', () => {
  const ice = { id: 7, type: Tile.ICE, x: 100, y: 100, w: 80, h: 30, solid: true };
  const rects = [ice];
  // start just under the ice, moving up
  const s = { x: 140, y: 100 + 30 + PLAYER_H / 2 + 4, vx: 0, vy: -400, facing: 1, onGround: false, jumpHeld: true, fallStartY: 0 };
  let bonked = null;
  for (let i = 0; i < 10 && !bonked; i++) {
    const ev = stepPlayer(s, { left: false, right: false, jump: true, attack: false }, rects, 1 / 60, {});
    if (ev.bonk.length) bonked = ev.bonk[0];
  }
  assert.ok(bonked && bonked.type === Tile.ICE, 'reports the ice tile it bonked');
});

test('leaderboard sorts by time and remembers the round', () => {
  const lb = new Leaderboard({ persist: false });
  lb.add({ name: 'B', timeMs: 5000, round: 2, rank: 1 });
  lb.add({ name: 'A', timeMs: 3000, round: 4, rank: 1 });
  lb.add({ name: 'C', timeMs: 9000, round: 1, rank: 2 });
  const top = lb.top(3);
  assert.deepEqual(top.map((e) => e.name), ['A', 'B', 'C']);
  assert.equal(top[0].round, 4);
});

test('GameRoom runs many ticks with players without crashing', () => {
  const room = new GameRoom(mockIo(), new Leaderboard({ persist: false }));
  const p1 = room.addPlayer('s1', 'P1', { outfit: '#e74c3c' });
  const p2 = room.addPlayer('s2', 'P2', { outfit: '#2ecc71' });

  room.setInput('s1', { left: false, right: true, jump: true, attack: true, seq: 1 });
  room.setInput('s2', { left: true, right: false, jump: false, attack: false, seq: 1 });

  for (let i = 0; i < 240; i++) room.tick(); // ~4 simulated seconds

  for (const p of [p1, p2]) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'finite position');
    assert.ok(p.hp <= 100, 'hp within bounds');
    assert.ok(p.floor >= 0 && p.floor < FLOOR_COUNT, 'valid floor');
  }
  const ranking = room.rankingList();
  assert.equal(ranking.length, 2);
});

test('GameRoom: rescuing players ends the round and records times', () => {
  const room = new GameRoom(mockIo(), new Leaderboard({ persist: false }));
  const p = room.addPlayer('solo', 'Solo', {});
  room.activatePlane();
  room.planeY = -20; // simulate the plane diving down to grab range
  // place the player airborne inside the pickup zone
  p.floor = FLOOR_COUNT - 1;
  p.onGround = false;
  p.x = room.planeX;
  p.y = 40; // dangles inside the dive rescue zone (planeY -10 -> zone ~10..70)
  room._checkRescue(p, Date.now());
  assert.ok(p.rescued, 'player got rescued');
  assert.equal(room.phase, 'intermission', 'round ended (solo target reached)');
  assert.equal(room.leaderboard.entries.length, 1, 'time recorded to leaderboard');
});

import { GameRoom } from '../server/game/GameRoom.js';
import { Leaderboard } from '../server/game/Leaderboard.js';
import { FLOOR_COUNT, floorTopY } from '../public/shared/constants.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const mockIo = () => ({ emit() {}, volatile: { emit() {} } });

test('per-player timer: rescue time derived from player startMs, not roundStartMs', () => {
  const room = new GameRoom(mockIo(), new Leaderboard({ persist: false }));
  // Pretend the round started long ago, but this player only entered 2s ago.
  room.roundStartMs = Date.now() - 60000;
  const p = room.addPlayer('solo', 'solo', {});
  p.startMs = Date.now() - 2000; // entered 2s ago

  room.activatePlane();
  room.planeY = -20; // simulate the plane diving down to grab range
  p.floor = FLOOR_COUNT - 1; p.onGround = false;
  p.x = room.planeX; p.y = 40; // dangles inside the dive rescue zone
  const now = Date.now();
  room._checkRescue(p, now);

  assert.ok(p.rescued, 'player got rescued');
  const recorded = room.leaderboard.entries[0];
  // Should be ~2000ms (per-player), nowhere near the 60000ms round elapsed.
  assert.ok(recorded.timeMs >= 1500 && recorded.timeMs <= 4000,
    'expected per-player time ~2s, got ' + recorded.timeMs);
});

test('per-player timer: no round time cap ends the round on its own', () => {
  const room = new GameRoom(mockIo(), new Leaderboard({ persist: false }));
  room.roundStartMs = Date.now() - 60 * 60 * 1000;
  room.addPlayer('z', 'lonely', {});
  for (let i = 0; i < 120; i++) room.tick();
  assert.equal(room.phase, 'playing', 'no auto end despite huge round elapsed');
});

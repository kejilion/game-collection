import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GameRoom } from '../server/game/GameRoom.js';
import { Leaderboard } from '../server/game/Leaderboard.js';
import {
  PLANE_Y_LOW, PLANE_PATROL_RANGE, PLANE_SPEED, PICKUP_W,
  RESCUE_ZONE_TOP_OFFSET, RESCUE_ZONE_BOTTOM_OFFSET,
} from '../public/shared/constants.js';

const mockIo = () => ({ emit() {}, volatile: { emit() {} } });

test('plane flies a steady horizontal sweep and never dives to linger', () => {
  const room = new GameRoom(mockIo(), new Leaderboard({ persist: false }));
  room.activatePlane();
  const cx = room.planeCenter;
  const range = PLANE_PATROL_RANGE;

  let prevX = room.planeX;
  let sawTurn = false;
  const ys = new Set();
  const xs = [];

  // simulate ~6 seconds (> one full round trip so a turn is guaranteed)
  for (let i = 0; i < 6 * 60; i++) {
    room._updatePlane();
    // altitude is constant the whole time -- no dive up/down toward the pad
    assert.equal(room.planeY, PLANE_Y_LOW, `tick ${i}: plane stays at patrol altitude`);
    ys.add(Math.round(room.planeY));
    xs.push(room.planeX);
    // stays inside the patrol band
    assert.ok(room.planeX >= cx - range - 1 && room.planeX <= cx + range + 1,
      `tick ${i}: plane inside band`);
    // detect a direction reversal (proves it turns at the edges, not hovering)
    if ((room.planeX - prevX) * (room.planeDir) < 0) sawTurn = true;
    prevX = room.planeX;
  }
  assert.ok(ys.size === 1, 'altitude never changes during the sweep');
  assert.ok(sawTurn, 'the plane reverses direction at the band edges');
  // it actually travels the full width (not stuck near the centre over the pad)
  assert.ok(Math.max(...xs) - Math.min(...xs) > range, 'plane traverses most of the band');
});

test('rescue grab zone is small for a harder, timing-based dock', () => {
  const room = new GameRoom(mockIo(), new Leaderboard({ persist: false }));
  room.activatePlane();
  const zoneH = RESCUE_ZONE_BOTTOM_OFFSET - RESCUE_ZONE_TOP_OFFSET;
  // tighter than the original 76px window and 170px width
  assert.ok(zoneH <= 60, `zone height ${zoneH}px is tight (<=60)`);
  assert.ok(PICKUP_W <= 120, `zone width ${PICKUP_W}px is tight (<=120)`);
  // zone travels with the plane along x (no fixed pad lock), so the player must
  // line up the jump apex with the moving rope
  const z1 = room.planeX - PICKUP_W / 2;
  room._updatePlane();
  const z2 = room.planeX - PICKUP_W / 2;
  assert.notEqual(z1, z2, 'grab zone x moves with the patrolling plane');
});
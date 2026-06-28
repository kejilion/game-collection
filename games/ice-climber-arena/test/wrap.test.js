// Horizontal screen-wrap: the play-field is a left↔right loop (Ice-Climber style).
// Walk/charge off one edge and you reappear on the other; full-width monsters and
// projectiles loop too, and chasing/aiming takes the short way around the seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stepPlayer } from '../public/shared/physics.js';
import { Monster } from '../server/game/Monster.js';
import {
  WORLD_WIDTH, PLAYER_H, Tile, MonsterKind, floorTopY, wrapX, wrapDX,
} from '../public/shared/constants.js';

const fakePlayer = (x, y) => ({ x, y, alive: true, rescued: false, invuln: 0 });

test('wrapX / wrapDX fold and measure across the seam', () => {
  assert.equal(wrapX(5), 5);
  assert.equal(wrapX(-5), WORLD_WIDTH - 5);
  assert.equal(wrapX(WORLD_WIDTH + 5), 5);
  assert.equal(wrapDX(10, 25), 15);                 // plain
  assert.equal(wrapDX(WORLD_WIDTH - 5, 5), 10);     // short way is forward across the seam
  assert.equal(wrapDX(5, WORLD_WIDTH - 5), -10);    // short way is backward across the seam
  assert.ok(Math.abs(wrapDX(0, WORLD_WIDTH / 2)) === WORLD_WIDTH / 2); // antipode
});

test('physics: walking off the left edge reappears on the right', () => {
  const groundY = floorTopY(0);
  const rects = [{ id: 1, x: 0, y: groundY, w: WORLD_WIDTH, h: 96, type: Tile.GROUND, solid: true }];
  const s = {
    x: 15, y: groundY - PLAYER_H / 2, vx: 0, vy: 0,
    facing: -1, onGround: true, jumpHeld: false, fallStartY: groundY,
  };
  const left = { left: true, right: false, jump: false, attack: false };
  let wrapped = false;
  let prev = s.x;
  for (let i = 0; i < 300; i++) {
    stepPlayer(s, left, rects, 1 / 60, {});
    assert.ok(s.x >= 0 && s.x < WORLD_WIDTH, 'x stays on the loop [0,W)');
    if (s.x - prev > WORLD_WIDTH / 2) wrapped = true; // jumped from near 0 to near W
    prev = s.x;
  }
  assert.ok(wrapped, 'player crossed the left seam onto the right side');
  assert.ok(s.x > WORLD_WIDTH / 2, 'ended up on the right half');
});

test('a full-width monster chases the SHORT way across the seam', () => {
  const y = floorTopY(0);
  // monster hugging the right edge; player just across the seam on the left (~50px away,
  // but ~1550px the long way) — it must turn toward the seam and close the gap, not retreat.
  const m = new Monster({ kind: MonsterKind.WALKER, minX: 24, maxX: WORLD_WIDTH - 24, wrap: true, x: WORLD_WIDTH - 30, y });
  const support = { y, minX: 0, maxX: WORLD_WIDTH };
  const players = [fakePlayer(20, y)];

  const before = Math.abs(wrapDX(m.x, 20));
  m.update(1 / 60, players, support);
  assert.equal(m.dir, 1, 'heads toward the seam (right), not the long way back');

  for (let i = 0; i < 60; i++) {
    m.update(1 / 60, players, support);
    assert.ok(m.x >= 0 && m.x < WORLD_WIDTH, 'monster stays on the loop');
  }
  assert.ok(Math.abs(wrapDX(m.x, 20)) < before, 'monster closed the gap across the seam');
});

test('a banded (non-wrap) monster still bounces at its edges', () => {
  const y = floorTopY(4);
  const m = new Monster({ kind: MonsterKind.WALKER, minX: 200, maxX: 1400, y }); // no wrap flag
  const support = { y, minX: 0, maxX: WORLD_WIDTH };
  const players = [fakePlayer(20, y)]; // far left — would lure it out of band if seam-aware
  for (let i = 0; i < 400; i++) {
    m.update(1 / 60, players, support);
    assert.ok(m.x >= m.minX - 1 && m.x <= m.maxX + 1, 'stays inside its patrol band');
  }
});

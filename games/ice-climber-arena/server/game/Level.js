// ============================================================================
//  Procedural level generation (server-authoritative).
//  A tower of FLOOR_COUNT floors.  Floor 0 is the full-width ground / spawn,
//  floor 9 is the narrow rescue pad.  Each floor between is a handful of
//  ledges (solid / breakable-ice / moving / speed) confined to a band that
//  narrows as you climb.  A guaranteed "main path" keeps the tower climbable.
// ============================================================================
import {
  WORLD_WIDTH, FLOOR_COUNT, GROUND_THICKNESS, PLATFORM_H, BRICK_W, FLOOR_SPACING,
  floorTopY, floorBandHalfWidth, Tile, MonsterKind, ItemKind,
} from '../../public/shared/constants.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const irnd = (a, b) => Math.floor(rnd(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

let nextId = 1;

function makePlatform(floor, type, x, y, w) {
  const p = { id: nextId++, floor, type, x: Math.round(x), y, w: Math.round(w), h: PLATFORM_H };
  if (type === Tile.MOVING) {
    const half = floorBandHalfWidth(floor);
    const center = WORLD_WIDTH / 2;
    const minX = center - half;
    const maxX = center + half;
    let range = rnd(45, 120);
    range = Math.min(range, (maxX - minX - w) / 2 - 4);
    range = Math.max(20, range);
    p.range = Math.round(range);
    p.speed = rnd(0.6, 1.25);
    p.phase = rnd(0, Math.PI * 2);
    // recenter base so the full travel stays inside the band
    const c = clamp(p.x + w / 2, minX + range + w / 2, maxX - range - w / 2);
    p.x = Math.round(c - w / 2);
  }
  return p;
}

/**
 * Generate a full level. `round` gently scales difficulty (more monsters /
 * hazards on later rounds).  Returns a plain serialisable object.
 */
export function generateLevel(round = 1) {
  const platforms = [];
  const floors = [];

  // floor 0 — ground / spawn
  const groundY = floorTopY(0);
  platforms.push({ id: nextId++, floor: 0, type: Tile.GROUND, x: 0, y: groundY, w: WORLD_WIDTH, h: GROUND_THICKNESS });
  floors.push({ i: 0, y: groundY, hazard: false, mainX: WORLD_WIDTH / 2 });

  let pathX = WORLD_WIDTH / 2;

  for (let i = 1; i < FLOOR_COUNT; i++) {
    const y = floorTopY(i);
    const half = floorBandHalfWidth(i);
    const center = WORLD_WIDTH / 2;
    const minX = center - half;
    const maxX = center + half;
    const isTop = i === FLOOR_COUNT - 1;

    // ---- top floor: the narrow rescue pad ----
    if (isTop) {
      const mainW = 210;
      const mainLeft = clamp(center - mainW / 2, minX, maxX - mainW);
      const pad = makePlatform(i, Tile.SOLID, mainLeft, y, mainW);
      pad.main = true;
      platforms.push(pad);
      floors.push({ i, y, hazard: false, mainX: mainLeft + mainW / 2 });
      continue;
    }

    // ---- interior floor: a full breakable brick wall spanning the band ----
    //  The player must head-bonk a breakable brick to open a hole, then hop up
    //  through it onto this floor.  A guaranteed run of ICE around the wandering
    //  "main path" keeps the tower solvable; sparse SOLID rock bricks (more on
    //  higher floors) are unbreakable obstacles to route around.
    pathX = clamp(pathX + rnd(-150, 150), minX + BRICK_W, maxX - BRICK_W);
    const solidChance = clamp(0.07 + i * 0.016, 0.07, 0.26);

    let mainBrick = null;
    let bx = minX;
    while (bx < maxX - 2) {
      const w = Math.min(BRICK_W, maxX - bx);
      if (w < 16) break; // drop a tiny end sliver
      const cx = bx + w / 2;
      const nearPath = Math.abs(cx - pathX) <= BRICK_W * 1.4; // guaranteed ~3-brick breakable opening (room to land beside the hole)
      let type = (!nearPath && chance(solidChance)) ? Tile.SOLID : Tile.ICE;
      const brick = makePlatform(i, type, bx, y, w);
      if (!mainBrick && cx >= pathX) { // the brick covering the path opening
        brick.type = Tile.ICE;
        brick.main = true;
        mainBrick = brick;
      }
      platforms.push(brick);
      bx += w;
    }
    if (!mainBrick) { // safety net so every floor keeps a tagged main brick
      const row = platforms.filter((p) => p.floor === i);
      mainBrick = row[Math.floor(row.length / 2)] || row[0];
      if (mainBrick) { mainBrick.type = Tile.ICE; mainBrick.main = true; }
    }
    const floorMeta = { i, y, hazard: false, mainX: mainBrick ? mainBrick.x + mainBrick.w / 2 : pathX };

    // ---- occasional helper platform (moving lift / slippery strip) in the gap ----
    if (i >= 3 && chance(0.34)) {
      const gy = y + Math.round(FLOOR_SPACING * 0.5); // mid-gap, below this wall
      const w = rnd(76, 116);
      const x = clamp(rnd(minX, maxX - w), minX, maxX - w);
      const type = chance(0.5) ? Tile.MOVING : Tile.SPEED;
      platforms.push(makePlatform(i, type, x, gy, w));
    }

    floors.push(floorMeta);
  }

  // ---- hazard (falling-icicle) floors ----
  const hazardCount = clamp(2 + Math.floor(round / 2), 2, 4);
  const hazardPool = shuffle([2, 3, 4, 5, 6, 7]).slice(0, hazardCount);
  for (const fi of hazardPool) floors[fi].hazard = true;

  // ---- monster spawns ----
  const monsters = [];
  const monsterCount = clamp(2 + round, 2, 6);
  const monsterPool = shuffle([2, 3, 4, 5, 6, 7, 8]).slice(0, monsterCount);
  for (const fi of monsterPool) {
    const m = platforms.find((p) => p.floor === fi && p.main);
    if (!m) continue;
    // patrol the whole walkable wall top (the band), not just one brick
    const half = floorBandHalfWidth(fi);
    const center = WORLD_WIDTH / 2;
    monsters.push({
      floor: fi,
      kind: chance(0.55) ? MonsterKind.WALKER : MonsterKind.CASTER,
      minX: clamp(center - half + 16, 16, WORLD_WIDTH - 16),
      maxX: clamp(center + half - 16, 16, WORLD_WIDTH - 16),
      y: floorTopY(fi),
      platformId: m.id,
    });
  }

  // ---- item spawns ----
  const items = [];
  const itemCount = irnd(3, 5);
  const itemPool = shuffle([1, 2, 3, 4, 5, 6, 7, 8]).slice(0, itemCount);
  for (const fi of itemPool) {
    const m = platforms.find((p) => p.floor === fi && p.main);
    if (!m) continue;
    items.push({
      floor: fi,
      kind: pick([ItemKind.FIRE, ItemKind.HEAL, ItemKind.JUMP]),
      x: m.x + m.w / 2,
      y: m.y - 42,
    });
  }

  const topPad = platforms.find((p) => p.floor === FLOOR_COUNT - 1 && p.main);

  return { platforms, floors, monsters, items, topPadId: topPad ? topPad.id : null, round };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

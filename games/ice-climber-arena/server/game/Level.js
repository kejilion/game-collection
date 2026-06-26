// ============================================================================
//  Procedural level generation (server-authoritative).
//
//  A tower of FLOOR_COUNT floors that gets MEANINGFULLY HARDER the higher you
//  climb.  Floor 0 is the full-width ground / spawn; the top floor is the narrow
//  rescue pad.  Interior floors come in two flavours:
//
//   • WALL  — a *full-width* wall you must smash a hole through.  The outer
//             shoulders are unbreakable ROCK that seal the sides (so you can no
//             longer just hop up the corners — the old "climb both edges" cheat),
//             and only a central ICE band is breakable.  That band NARROWS and
//             gets studded with more rock the higher you go, so the climb funnels
//             inward and you must hunt the ice vein under growing pressure.
//   • OPEN  — a breather of open sky with a guaranteed solid landing ledge plus
//             optional moving / speed lifts and a tempting item off to one side.
//             Never two in a row, so a sealed wall always sits between them and
//             no corner-hop chain can ever skip the climb.
//
//  A guaranteed, wandering "main path" keeps every tower solvable with the
//  one-floor jump height.  Monsters, hazards and items are biased toward the
//  dangerous upper floors; the good loot up high rewards the risk of going for it.
// ============================================================================
import {
  WORLD_WIDTH, FLOOR_COUNT, GROUND_THICKNESS, PLATFORM_H, BRICK_W,
  floorTopY, floorBandHalfWidth, Tile, MonsterKind, ItemKind,
  OPEN_FLOOR_CHANCE_LOW, OPEN_FLOOR_CHANCE_HIGH, WALL_ROCK_LOW, WALL_ROCK_HIGH,
  HAZARD_FLOORS_BASE, MONSTER_FLOORS_BASE, CASTER_CHANCE_LOW, CASTER_CHANCE_HIGH,
  MOVING_SPEED_LOW, MOVING_SPEED_HIGH,
} from '../../public/shared/constants.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
/** altitude 0(ground)…1(summit) for floor i */
const alt = (i) => i / (FLOOR_COUNT - 1);

let nextId = 1;

function makePlatform(floor, type, x, y, w, opts = {}) {
  const p = { id: nextId++, floor, type, x: Math.round(x), y, w: Math.round(w), h: PLATFORM_H };
  if (type === Tile.MOVING) {
    const half = floorBandHalfWidth(floor);
    const center = WORLD_WIDTH / 2;
    const minX = center - half;
    const maxX = center + half;
    let range = rnd(90, 240);
    range = Math.min(range, (maxX - minX - w) / 2 - 4);
    range = Math.max(40, range);
    p.range = Math.round(range);
    // lifts get faster the higher they live -> tighter timing up top
    p.speed = rnd(0.6, 1.1) * lerp(MOVING_SPEED_LOW, MOVING_SPEED_HIGH, opts.t ?? 0);
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
  const center = WORLD_WIDTH / 2;

  // floor 0 — ground / spawn
  const groundY = floorTopY(0);
  platforms.push({ id: nextId++, floor: 0, type: Tile.GROUND, x: 0, y: groundY, w: WORLD_WIDTH, h: GROUND_THICKNESS });
  floors.push({ i: 0, y: groundY, hazard: false, mainX: center });

  // ---- decide each interior floor's archetype (bottom-up) --------------------
  //  OPEN "breather" floors are common low and rare high, and NEVER adjacent so
  //  a sealed wall always sits between them — that's what kills any attempt to
  //  chain open floors into a free staircase.  The floor right below the rescue
  //  pad is always a sealed wall, giving a continuous surface to line up the
  //  final hop onto the pad.
  const isOpen = new Array(FLOOR_COUNT).fill(false);
  for (let i = 1; i < FLOOR_COUNT - 2; i++) {
    if (!isOpen[i - 1] && chance(lerp(OPEN_FLOOR_CHANCE_LOW, OPEN_FLOOR_CHANCE_HIGH, alt(i)))) {
      isOpen[i] = true;
    }
  }
  // guarantee at least one breather (so the moving / speed lifts always feature)
  if (!isOpen.some(Boolean)) isOpen[pick([2, 3, 4])] = true;

  let pathX = center; // wandering breakthrough point, kept solvable floor-to-floor

  for (let i = 1; i < FLOOR_COUNT; i++) {
    const y = floorTopY(i);
    const t = alt(i);
    const half = floorBandHalfWidth(i);
    const minX = center - half;
    const maxX = center + half;
    const isTop = i === FLOOR_COUNT - 1;

    // ---- top floor: the narrow rescue pad ----
    if (isTop) {
      const mainW = 380;
      const mainLeft = clamp(center - mainW / 2, minX, maxX - mainW);
      const pad = makePlatform(i, Tile.SOLID, mainLeft, y, mainW);
      pad.main = true;
      platforms.push(pad);
      floors.push({ i, y, hazard: false, mainX: mainLeft + mainW / 2 });
      continue;
    }

    if (isOpen[i]) {
      // ---- OPEN breather: a guaranteed solid landing on the path, optional
      //  side lifts, and open sky to fall through if you slip. The central ledge
      //  sits ON the wandering path so the wall above lines up directly over it:
      //  hop up onto the ledge, then smash the next ceiling. pathX is held steady
      //  across the breather so that alignment is exact.
      const ledgeW = rnd(170, 230);
      pathX = clamp(pathX, minX + ledgeW / 2 + 24, maxX - ledgeW / 2 - 24);
      const ledge = makePlatform(i, Tile.SOLID, pathX - ledgeW / 2, y, ledgeW, { t });
      ledge.main = true;
      platforms.push(ledge);

      // side lifts (moving / speed) — pure flavour + a way to reach a side item;
      // they never gate the climb, so timing failure just costs you the detour.
      const sideCount = 1 + (chance(0.6) ? 1 : 0);
      for (let k = 0; k < sideCount; k++) {
        const side = k === 0 ? -1 : 1;
        const w = rnd(120, 170);
        const sx = clamp(center + side * half * 0.6 - w / 2, minX, maxX - w);
        const type = chance(0.6) ? Tile.MOVING : Tile.SPEED;
        platforms.push(makePlatform(i, type, sx, y, w, { t }));
      }
      floors.push({ i, y, hazard: false, mainX: pathX, open: true });
      continue;
    }

    // ---- WALL: full-width wall, rock shoulders, breakable ICE band w/ studs ----
    //  Wander the breakthrough point (kept inside this floor's narrowing band),
    //  then tile bricks edge-to-edge across the WHOLE world: outside the band is
    //  always unbreakable rock (no side gap to sneak up), inside the band is
    //  mostly ICE with a height-scaled scatter of rock studs to route around.
    pathX = clamp(pathX + rnd(-220, 220), minX + BRICK_W, maxX - BRICK_W);
    const rockChance = lerp(WALL_ROCK_LOW, WALL_ROCK_HIGH, t);

    let mainBrick = null;
    let bx = 0;
    while (bx < WORLD_WIDTH - 0.5) {
      const w = Math.min(BRICK_W, WORLD_WIDTH - bx);
      const cx = bx + w / 2;
      const inBand = cx > minX && cx < maxX;
      const coversPath = pathX >= bx && pathX < bx + w; // the guaranteed opening
      let type;
      if (!inBand) type = Tile.SOLID; // sealed rock shoulder
      else if (coversPath) type = Tile.ICE; // forced breakable main path
      else type = chance(rockChance) ? Tile.SOLID : Tile.ICE;
      const brick = makePlatform(i, type, bx, y, w);
      if (coversPath && !mainBrick) { brick.main = true; mainBrick = brick; }
      platforms.push(brick);
      bx += w;
    }
    // fold a trailing sub-brick sliver into the last brick (no end gap)
    {
      const row = platforms.filter((p2) => p2.floor === i);
      const last = row[row.length - 1];
      const remain = WORLD_WIDTH - (last.x + last.w);
      if (remain > 0.5) last.w = Math.round(last.w + remain);
    }
    if (!mainBrick) { // safety net: keep a tagged ICE opening inside the band
      const row = platforms.filter((p) => p.floor === i && p.x + p.w / 2 > minX && p.x + p.w / 2 < maxX);
      mainBrick = row[Math.floor(row.length / 2)] || row[0];
      if (mainBrick) { mainBrick.type = Tile.ICE; mainBrick.main = true; }
    }
    floors.push({ i, y, hazard: false, mainX: mainBrick ? mainBrick.x + mainBrick.w / 2 : pathX });
  }

  // ---- hazards / monsters / items — all biased toward the upper floors --------
  const interior = [];
  for (let i = 2; i <= FLOOR_COUNT - 2; i++) interior.push(i);
  // weight that grows ~2.4x from the lowest interior floor to the highest
  const highW = (i) => 0.4 + alt(i) * 1.6;
  const pickHigh = (pool, n) => weightedSample(pool, n, highW);

  // hazards (falling icicles) — more, and higher, on later rounds
  const hazardCount = clamp(HAZARD_FLOORS_BASE + Math.floor(round / 2), 2, 5);
  for (const fi of pickHigh(interior.filter((i) => !floors[i].open), hazardCount)) {
    floors[fi].hazard = true;
  }

  // monsters — biased high, and nastier (ranged casters) the higher they spawn
  const monsters = [];
  const monsterCount = clamp(MONSTER_FLOORS_BASE + round, 3, 7);
  for (const fi of pickHigh(interior, monsterCount)) {
    const m = platforms.find((p) => p.floor === fi && p.main);
    if (!m) continue;
    let lo, hi;
    if (floors[fi].open) { lo = m.x + 8; hi = m.x + m.w - 8; } // patrol the landing ledge
    else {
      const bandHalf = floorBandHalfWidth(fi);
      lo = clamp(center - bandHalf + 16, 16, WORLD_WIDTH - 16);
      hi = clamp(center + bandHalf - 16, 16, WORLD_WIDTH - 16);
    }
    monsters.push({
      floor: fi,
      kind: chance(lerp(CASTER_CHANCE_LOW, CASTER_CHANCE_HIGH, alt(fi))) ? MonsterKind.CASTER : MonsterKind.WALKER,
      minX: lo, maxX: hi,
      y: floorTopY(fi),
      platformId: m.id,
    });
  }

  // items — a couple early to get going, the good stuff up high to reward risk
  const items = [];
  const itemFloors = new Set();
  for (const fi of weightedSample([1, 2, 3].filter((i) => i < FLOOR_COUNT - 1), 1 + (chance(0.6) ? 1 : 0), () => 1)) {
    itemFloors.add(fi);
  }
  for (const fi of pickHigh(interior, 2 + (chance(0.5) ? 1 : 0))) itemFloors.add(fi);
  for (const fi of itemFloors) {
    const m = platforms.find((p) => p.floor === fi && p.main);
    if (!m) continue;
    // high up, favour survival picks (heal / jump); low, anything goes
    const kind = alt(fi) > 0.5
      ? pick([ItemKind.HEAL, ItemKind.HEAL, ItemKind.JUMP, ItemKind.FIRE])
      : pick([ItemKind.FIRE, ItemKind.HEAL, ItemKind.JUMP]);
    items.push({ floor: fi, kind, x: m.x + m.w / 2, y: m.y - 42 });
  }

  const topPad = platforms.find((p) => p.floor === FLOOR_COUNT - 1 && p.main);

  return { platforms, floors, monsters, items, topPadId: topPad ? topPad.id : null, round };
}

// Sample up to n distinct entries from `pool`, each chosen with probability
// proportional to weight(entry).  No replacement.
function weightedSample(pool, n, weight) {
  const items = pool.slice();
  const out = [];
  n = Math.min(n, items.length);
  for (let k = 0; k < n; k++) {
    let total = 0;
    for (const it of items) total += Math.max(0, weight(it));
    let idx = 0;
    if (total > 0) {
      let r = Math.random() * total;
      for (let j = 0; j < items.length; j++) {
        r -= Math.max(0, weight(items[j]));
        if (r <= 0) { idx = j; break; }
      }
    }
    out.push(items[idx]);
    items.splice(idx, 1);
  }
  return out;
}

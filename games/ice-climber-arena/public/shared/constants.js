// ============================================================================
//  Shared constants & tuning.
//  Imported by BOTH the browser client and the Node server so that the
//  client-side prediction stays in lock-step with the authoritative server
//  simulation.  Keep this file pure data + tiny pure helpers (no DOM, no fs).
// ============================================================================

// ---- Simulation cadence ----------------------------------------------------
export const TICK_RATE = 60; // server fixed-step ticks per second
export const DT = 1 / TICK_RATE; // seconds per step
export const SNAPSHOT_RATE = 30; // state broadcasts per second

// ---- World geometry --------------------------------------------------------
export const WORLD_WIDTH = 960;
export const FLOOR_COUNT = 10; // floor 0 = ground … floor 9 = top (rescue)
export const FLOOR_SPACING = 140; // vertical px between floor surfaces
export const TOP_MARGIN = 170; // air above the top floor (room for the plane)
export const GROUND_THICKNESS = 70;
export const PLATFORM_H = 30; // ledge thickness
export const BRICK_W = 46; // width of a single breakable wall brick

/** Canvas-y of a floor's walking surface (y grows downward). */
export function floorTopY(i) {
  return TOP_MARGIN + (FLOOR_COUNT - 1 - i) * FLOOR_SPACING;
}

export const WORLD_HEIGHT = floorTopY(0) + GROUND_THICKNESS + 90;

/** Which floor index a world-y belongs to (nearest surface at/below). */
export function floorAtY(y) {
  let best = 0;
  for (let i = FLOOR_COUNT - 1; i >= 0; i--) {
    if (y <= floorTopY(i) + FLOOR_SPACING * 0.5) return i;
  }
  return best;
}

/** Half-width of the horizontal play band for a floor (narrows while climbing). */
export function floorBandHalfWidth(i) {
  const t = i / (FLOOR_COUNT - 1); // 0 at ground → 1 at top
  const wide = WORLD_WIDTH / 2 - 26; // ground spans (almost) full width
  const narrow = 155; // top floors are tight ledges
  return wide + (narrow - wide) * t;
}

// ---- Player ----------------------------------------------------------------
export const PLAYER_W = 26;
export const PLAYER_H = 34;
export const PLAYER_MAX_HP = 100;

export const RUN_SPEED = 250; // px/s ground max
export const RUN_ACCEL = 2600;
export const AIR_ACCEL = 1750;
export const GROUND_FRICTION = 2300;
export const ICE_FRICTION = 280; // slippery surfaces (speed tiles)
export const SPEED_TILE_MULT = 1.7; // max-speed boost on an acceleration tile

export const GRAVITY = 2050;
export const TERMINAL_VY = 1150;
export const JUMP_VEL = 915; // apex ≈ 204px — generous hang to bust a brick and drift onto the next floor (spacing 140), still < 2 floors
export const JUMP_BUFF_MULT = 1.34; // "higher jump" pickup

// ---- Fall damage -----------------------------------------------------------
export const FALL_SAFE_FLOORS = 2; // falling MORE than this hurts
export const FALL_DMG_PER_FLOOR = 15; // per floor beyond the safe threshold

// ---- Combat ----------------------------------------------------------------
export const ATTACK_COOLDOWN = 0.42; // seconds between melee swings
export const MELEE_RANGE = 30;
export const MELEE_W = 32;
export const MELEE_H = 30;
export const MELEE_DMG = 6; // intentionally low → killing players is slow
export const MELEE_KNOCKBACK = 250;
export const ATTACK_ANIM = 0.22; // swing visual duration

export const MONSTER_TOUCH_DMG = 13;
export const MONSTER_STUN = 1.1; // crowd-control freeze seconds
export const RESPAWN_INVULN = 1.7;

// ---- Items / buffs ---------------------------------------------------------
export const BUFF_JUMP_TIME = 14;
export const BUFF_FIRE_TIME = 10;
export const HEAL_AMOUNT = 45;
export const FIREBALL_SPEED = 470;
export const FIREBALL_DMG = 22;
export const FIREBALL_COOLDOWN = 0.32;

// ---- Hazards ---------------------------------------------------------------
export const ICICLE_DMG = 18;
export const ICICLE_GRAVITY = 920;
export const ICICLE_INTERVAL = 2.1; // seconds between drops on a hazard floor

// ---- Monsters --------------------------------------------------------------
export const MONSTER_HP = 40;
export const MONSTER_SPEED = 70;
export const MONSTER_AGGRO_SPEED = 135;
export const MONSTER_DETECT = 220;

// ---- Win / round -----------------------------------------------------------
export const RESCUE_TARGET = 3; // first N players rescued ends the round
export const INTERMISSION_MS = 8000;
export const ROUND_TIME_LIMIT_MS = 6 * 60 * 1000; // safety cap

export const PLANE_Y = 70;
export const PLANE_SPEED = 70; // horizontal patrol px/s
export const PICKUP_W = 92;
export const PICKUP_H = 64;

// ---- Enums -----------------------------------------------------------------
export const Tile = {
  GROUND: 'ground',
  SOLID: 'solid', // unbreakable rock
  ICE: 'ice', // breakable from below
  MOVING: 'moving', // horizontal lift
  SPEED: 'speed', // slippery / acceleration strip
};

export const ItemKind = { FIRE: 'fire', HEAL: 'heal', JUMP: 'jump' };
export const MonsterKind = { WALKER: 'walker', CASTER: 'caster' };
export const Phase = { LOBBY: 'lobby', PLAYING: 'playing', INTERMISSION: 'intermission' };

// Cosmetic palettes offered in the character creator (also validated server-side).
export const SKIN_TONES = ['#ffd9b3', '#f1c089', '#d9a066', '#a86b3c', '#8a5a2b'];
export const OUTFIT_COLORS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c',
  '#3498db', '#9b59b6', '#e84393', '#34495e', '#ecf0f1',
];
export const HAT_COLORS = [
  '#c0392b', '#d35400', '#16a085', '#27ae60', '#2980b9',
  '#8e44ad', '#2c3e50', '#f39c12', '#fd79a8', '#bdc3c7',
];
export const BODY_STYLES = ['beanie', 'earflap', 'bobble']; // hat silhouettes

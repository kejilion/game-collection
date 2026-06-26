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
export const WORLD_WIDTH = 1600;
export const FLOOR_COUNT = 10; // floor 0 = ground �?floor 9 = top (rescue)
export const FLOOR_SPACING = 200; // vertical px between floor surfaces
export const TOP_MARGIN = 320; // air above the top floor (room for the plane)
export const GROUND_THICKNESS = 96;
export const PLATFORM_H = 40; // ledge thickness
export const BRICK_W = 80; // width of a single breakable wall brick (= 2 square cells, for a clean uniform grid)
export const BRICK_CELL_W = 40; // a brick subdivides into SQUARE cells this wide (= PLATFORM_H); one head-bonk shatters ONE cell
export const BRICK_HOLE_CELLS = 2; // cells a player must clear to fit through a hole (player ~42px wide > one 40px cell, so 2 are needed)

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
  const t = i / (FLOOR_COUNT - 1); // 0 at ground �?1 at top
  const wide = WORLD_WIDTH / 2 - 42; // ground spans (almost) full width
  const narrow = 260; // top floors are tight ledges
  return wide + (narrow - wide) * t;
}

// ---- Level generation & difficulty curve -----------------------------------
//  Difficulty is driven by ALTITUDE �?t = floor/(FLOOR_COUNT-1), 0 at the
//  bottom, 1 at the summit.  The higher you climb the narrower the breakable
//  band, the more unbreakable rock studs each wall, the more (and nastier) the
//  monsters, and the more hazards rain down �?while richer rewards up top pay
//  back the risk.  Tune the whole curve here; both ends interpolate by altitude.
export const OPEN_FLOOR_CHANCE_LOW = 0.34;
export const OPEN_FLOOR_CHANCE_HIGH = 0.05;
export const WALL_ROCK_LOW = 0.06;
export const WALL_ROCK_HIGH = 0.46;
export const HAZARD_FLOORS_BASE = 2; // icicle floors (grows with round), biased high
export const MONSTER_FLOORS_BASE = 3; // monster floors (grows with round), biased high
export const CASTER_CHANCE_LOW = 0.25;
export const CASTER_CHANCE_HIGH = 0.7;
export const MOVING_SPEED_LOW = 0.7;
export const MOVING_SPEED_HIGH = 1.5;

// ---- Player ----------------------------------------------------------------
export const PLAYER_W = 42;
export const PLAYER_H = 54;
export const PLAYER_MAX_HP = 100;

export const RUN_SPEED = 400; // px/s ground max
export const RUN_ACCEL = 4200;
export const AIR_ACCEL = 2900;
export const GROUND_FRICTION = 3800;
export const ICE_FRICTION = 460; // slippery surfaces (speed tiles)
export const SPEED_TILE_MULT = 1.7; // max-speed boost on an acceleration tile

export const GRAVITY = 2050;
export const TERMINAL_VY = 1800;
export const JUMP_VEL = 928; // apex ~210px, just clears one floor (spacing 200), cannot skip two floors
export const JUMP_BUFF_MULT = 1.2; // higher jump pickup (modest so the plane stays out of reach)

// ---- Fall damage -----------------------------------------------------------
export const FALL_SAFE_FLOORS = 2; // falling MORE than this hurts
export const FALL_DMG_PER_FLOOR = 15; // per floor beyond the safe threshold

// ---- Combat ----------------------------------------------------------------
export const ATTACK_COOLDOWN = 0.42; // seconds between melee swings
export const MELEE_RANGE = 48;
export const MELEE_W = 52;
export const MELEE_H = 48;
export const MELEE_DMG = 6; // intentionally low �?killing players is slow
export const MELEE_KNOCKBACK = 250;
export const ATTACK_ANIM = 0.22; // swing visual duration

export const MONSTER_TOUCH_DMG = 13;
export const MONSTER_STUN = 1.1; // crowd-control freeze seconds
export const RESPAWN_INVULN = 1.7;
export const DEATH_DURATION = 1.2; // 缁夋帪绱板璁抽閸氬骸甯崷鐗堟尡閺€鎯уЗ閻紮绱濋崘宥夊櫢�?
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
export const ROUND_TIME_LIMIT_MS = 0; // 0 = no per-round time cap; each player is timed individually from spawn to rescue

export const PLANE_Y_HIGH = -90; // cruising altitude: rope end (~-10) far above jump apex (head ~56), out of reach
export const PLANE_Y_LOW = -20;  // dive altitude: rope end (~60) meets jump apex head (~56) �� only the peak of the hop reaches
export const PLANE_DIVE_PERIOD = 9.0; // seconds per approach -> dive -> grab -> depart cycle
export const PLANE_DIVE_HOLD = 1.6;   // seconds spent low offering the rope
export const PLANE_SPEED = 320; // horizontal travel px/s (fast approach/depart between screen-edge and the pad)
export const PLANE_OFFSCREEN = 720; // how far beyond the pad center the plane loiters (just off the visible edges)
export const PICKUP_W = 170;
export const PICKUP_H = 104;
// The rope hangs a fixed length below the plane belly; the rescue zone travels
// with the plane so the rope is only grabbable when the plane dives down.
export const ROPE_BELLY_OFFSET = 20;          // distance from plane center to rope top
export const RESCUE_ZONE_TOP_OFFSET = 20;     // zone top below plane center
export const RESCUE_ZONE_BOTTOM_OFFSET = 96; // zone bottom below plane center (dive: ~76, a tight ~6px window past apex head ~70)
export const ROPE_KNOT_OFFSET = 96;           // rope-end knot below plane center

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

// ---- chat ----
export const CHAT_MAX_LEN = 80;     // max characters per message (server trims)
export const CHAT_THROTTLE_MS = 700; // min gap between messages from one player
export const CHAT_DUR_MS = 4000;     // how long a speech bubble stays on screen

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

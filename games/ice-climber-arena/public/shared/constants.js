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
export const FLOOR_COUNT = 10; // floor 0 = ground — floor 9 = top (rescue)
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
  const t = i / (FLOOR_COUNT - 1); // 0 at ground — 1 at top
  const wide = WORLD_WIDTH / 2 - 42; // ground spans (almost) full width
  const narrow = 260; // top floors are tight ledges
  return wide + (narrow - wide) * t;
}

// ---- Level generation & difficulty curve -----------------------------------
//  Difficulty is driven by ALTITUDE — t = floor/(FLOOR_COUNT-1), 0 at the
//  bottom, 1 at the summit.  The higher you climb the narrower the breakable
//  band, the more unbreakable rock studs each wall, the more (and nastier) the
//  monsters, and the more hazards rain down — while richer rewards up top pay
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
export const MELEE_DMG = 6; // intentionally low — killing players is slow
export const MELEE_KNOCKBACK = 250;
export const ATTACK_ANIM = 0.22; // swing visual duration

export const MONSTER_TOUCH_DMG = 13;
export const MONSTER_STUN = 1.1; // crowd-control freeze seconds
export const RESPAWN_INVULN = 1.7;
export const DEATH_DURATION = 1.2; // 死亡动画/重生冻结持续秒数（此期间冻结物理与交互）
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
//  Legacy defaults (kept as fallbacks); per-type stats now live in
//  MONSTER_TYPES / BOSS_TYPES below.
export const MONSTER_HP = 40;
export const MONSTER_SPEED = 70;
export const MONSTER_AGGRO_SPEED = 135;
export const MONSTER_DETECT = 320; // widened so monsters notice & hunt over a larger area
// How much wider than the playable band a monster may roam on a full WALL floor
// (the whole floor is solid bricks, so they can patrol well past the climb band).
export const MONSTER_BAND_WIDEN = 1.5;
// Distinct small-monster kinds rolled per level (the level only spawns from this
// random subset, so every tower feels different): 2–3 of the six.
export const MONSTER_KINDS_PER_LEVEL_MIN = 2;
export const MONSTER_KINDS_PER_LEVEL_MAX = 3;

// ---- Win / round -----------------------------------------------------------
export const RESCUE_TARGET = 3; // first N players rescued ends the round
export const INTERMISSION_MS = 8000;
export const ROUND_TIME_LIMIT_MS = 0; // 0 = no per-round time cap; each player is timed individually from spawn to rescue
// Once the FIRST player is rescued, the plane starts a final-departure countdown.
// The round ends when RESCUE_TARGET are aboard OR this timer expires -- so the
// fast finishers never wait indefinitely for a slow 3rd place. 0 = disabled.
export const RESCUE_COUNTDOWN_MS = 30000;

export const PLANE_Y_HIGH = -90; // unused legacy cruise altitude (kept for backwards compat)
export const PLANE_Y_LOW = -20;  // patrol altitude: rope end (~76) meets jump apex head (~56) so only the hop peak reaches the rope
export const PLANE_DIVE_PERIOD = 9.0; // legacy (unused) -- plane no longer dives
export const PLANE_DIVE_HOLD = 1.6;   // legacy (unused) -- plane no longer lingers
export const PLANE_SPEED = 300; // horizontal patrol travel px/s (steady, never slows to pick anyone up)
export const PLANE_OFFSCREEN = 720; // how far beyond the pad center the plane turns around (just off the visible edges)
export const PLANE_PATROL_RANGE = 720; // half-width of the smooth back-and-forth patrol band around the pad center
export const PICKUP_W = 96;  // tight rope-side grab window (was 170) -- harder to line up
export const PICKUP_H = 48;  // tight grab height (was 104)
// The plane flies a fixed sweep across the sky at patrol altitude; it never dives
// toward the pad. The rope-end (knot) is the only thing near the jump apex, so the
// climber must time their hop to meet the rope as the plane passes overhead.
export const ROPE_BELLY_OFFSET = 20;          // distance from plane center to rope top
export const RESCUE_ZONE_TOP_OFFSET = 52;     // zone top below plane center (knot sits at the bottom edge)
export const RESCUE_ZONE_BOTTOM_OFFSET = 100; // zone bottom below plane center (tight ~48px reach past apex head ~56)
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

// ---- Monster roster --------------------------------------------------------
//  Six small "trash mob" kinds + six bosses.  Each entry is pure data read by
//  the Monster AI (server) and the procedural art (client), so adding/tuning a
//  kind is a one-line change that both ends pick up.
export const MonsterKind = {
  WALKER: 'walker',   // 冰拳企鹅 — baseline chaser, freezes on contact
  CASTER: 'caster',   // 寒冰法师 — holds ground, lobs an aimed freeze bolt
  DASHER: 'dasher',   // 冲锋兽   — creeps, then bursts a fast lunge
  HOPPER: 'hopper',   // 跳跳雪怪 — bounds along in hops, hard to time
  BRUTE:  'brute',    // 冰甲重兽 — slow tank, big body, heavy knockback
  SPITTER: 'spitter', // 霜吐者   — fires a 3-way spread of bolts
};

export const BossKind = {
  GIANT: 'giant',       // 冰霜巨人   — huge melee, devastating knockback
  BLIZZARD: 'blizzard', // 暴风雪法师 — rapid fan volleys of freeze bolts
  QUEEN: 'queen',       // 寒冰女王   — summons small adds + bolts
  MAMMOTH: 'mammoth',   // 冰川猛犸   — charges back and forth across the floor
  WYVERN: 'wyvern',     // 霜翼飞龙   — flies above the ledge, rains shards
  GOLEM: 'golem',       // 冰晶魔像   — periodic radial burst of ice shards
};

// behavior: how the AI drives it (see Monster.js).  scale: hit-box + art size
// multiplier vs the 48px baseline.  castCd/dash*/hop*/summon* tune that behavior.
export const MONSTER_TYPES = {
  walker:  { name: '冰拳企鹅', behavior: 'melee',  hp: 40, speed: 80, aggro: 150, detect: 300, touchDmg: 13, stun: 1.1, knockback: 320, scale: 1.0 },
  caster:  { name: '寒冰法师', behavior: 'aimed',  hp: 32, speed: 40, aggro: 60,  detect: 360, touchDmg: 10, stun: 1.1, knockback: 240, scale: 1.0,  castCd: 2.3 },
  dasher:  { name: '冲锋兽',   behavior: 'dash',   hp: 30, speed: 55, aggro: 120, detect: 360, touchDmg: 16, stun: 1.0, knockback: 440, scale: 0.95, dashSpeed: 520, dashTime: 0.45, dashCd: 2.0 },
  hopper:  { name: '跳跳雪怪', behavior: 'hop',    hp: 34, speed: 95, aggro: 180, detect: 300, touchDmg: 12, stun: 1.2, knockback: 300, scale: 0.9,  hopVel: 360, hopCd: 0.9 },
  brute:   { name: '冰甲重兽', behavior: 'melee',  hp: 80, speed: 42, aggro: 78,  detect: 280, touchDmg: 20, stun: 1.3, knockback: 560, scale: 1.4 },
  spitter: { name: '霜吐者',   behavior: 'spread', hp: 30, speed: 38, aggro: 55,  detect: 380, touchDmg: 9,  stun: 1.0, knockback: 220, scale: 1.0,  castCd: 2.6 },
};

export const BOSS_TYPES = {
  giant:    { name: '冰霜巨人',   behavior: 'melee',  hp: 360, speed: 70,  aggro: 130, detect: 520, touchDmg: 26, stun: 1.4, knockback: 640, scale: 2.3 },
  blizzard: { name: '暴风雪法师', behavior: 'volley', hp: 280, speed: 52,  aggro: 64,  detect: 560, touchDmg: 18, stun: 1.3, knockback: 360, scale: 2.0, castCd: 2.2 },
  queen:    { name: '寒冰女王',   behavior: 'summon', hp: 300, speed: 58,  aggro: 72,  detect: 560, touchDmg: 20, stun: 1.3, knockback: 420, scale: 2.1, castCd: 2.8, summonCd: 5.0, summonCount: 2 },
  mammoth:  { name: '冰川猛犸',   behavior: 'charge', hp: 380, speed: 80,  aggro: 240, detect: 520, touchDmg: 24, stun: 1.2, knockback: 560, scale: 2.3, dashSpeed: 600, dashTime: 0.7, dashCd: 1.6 },
  wyvern:   { name: '霜翼飞龙',   behavior: 'fly',    hp: 240, speed: 120, aggro: 140, detect: 560, touchDmg: 22, stun: 1.2, knockback: 360, scale: 2.0, fly: true, castCd: 1.7 },
  golem:    { name: '冰晶魔像',   behavior: 'radial', hp: 420, speed: 44,  aggro: 58,  detect: 480, touchDmg: 22, stun: 1.4, knockback: 520, scale: 2.4, castCd: 3.0 },
};

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

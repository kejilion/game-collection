// ============================================================================
//  Arena Brawl — shared game configuration & definitions
//  Single source of truth for world size, tick rates, classes, items, balance.
//  A trimmed copy of CLASSES / ITEM_TYPES / SHOP is sent to clients on join.
// ============================================================================

const WORLD = { width: 3200, height: 2200 };

// ---- shared day / night timeline ------------------------------------------
// The World owns the start timestamp; this module keeps the timeline pure so
// simulation, snapshots and tests always agree on the same phase.
const DAY_NIGHT = {
  dayMs: 150000,
  duskMs: 60000,
  nightMs: 90000,
  dawnMs: 60000,
  nightVisibility: 0.5
};

function dayNightLightAt(elapsedMs) {
  const cycleMs = DAY_NIGHT.dayMs + DAY_NIGHT.duskMs + DAY_NIGHT.nightMs + DAY_NIGHT.dawnMs;
  let t = ((elapsedMs % cycleMs) + cycleMs) % cycleMs;
  if (t < DAY_NIGHT.dayMs) return { phase: 'day', visibility: 1, phaseProgress: t / DAY_NIGHT.dayMs };
  t -= DAY_NIGHT.dayMs;
  if (t < DAY_NIGHT.duskMs) {
    const progress = t / DAY_NIGHT.duskMs;
    return { phase: 'dusk', visibility: 1 + (DAY_NIGHT.nightVisibility - 1) * progress, phaseProgress: progress };
  }
  t -= DAY_NIGHT.duskMs;
  if (t < DAY_NIGHT.nightMs) return { phase: 'night', visibility: DAY_NIGHT.nightVisibility, phaseProgress: t / DAY_NIGHT.nightMs };
  t -= DAY_NIGHT.nightMs;
  const progress = t / DAY_NIGHT.dawnMs;
  return { phase: 'dawn', visibility: DAY_NIGHT.nightVisibility + (1 - DAY_NIGHT.nightVisibility) * progress, phaseProgress: progress };
}

const TICK_RATE = 30;        // server simulation steps / second
const BROADCAST_RATE = 20;   // state snapshots / second

// ---- Player classes --------------------------------------------------------
// attackType: 'melee_aoe' | 'melee_single' | 'projectile'
const CLASSES = {
  warrior: {
    id: 'warrior', name: '战士', color: '#ef5b52', accent: '#ffd0cb',
    maxHp: 200, speed: 158, attack: 21, defense: 7,
    attackCd: 620, critChance: 0.06, critMult: 1.6,
    attackType: 'melee_aoe', attackRange: 130, attackArc: Math.PI * 0.95,
    // skill[0] is the level-1 signature; skill[1] unlocks at reqLevel (a mid-early power spike).
    skills: [
      { id: 'whirlwind', name: '旋风斩', reqLevel: 1, cd: 6000, mult: 1.9, radius: 220,
        desc: '横扫周身敌人，造成大量范围伤害' },
      // identity gap: the tank has no defensive cooldown. War Cry = instant survive button.
      { id: 'warcry', name: '铁壁战吼', reqLevel: 3, cd: 14000, mult: 1.3, radius: 150,
        heal: 0.18, guardMs: 4000,
        desc: '怒吼回血、进入铁壁姿态（持续减伤），并将周身敌人吸聚到身边' }
    ],
    desc: '范围近战 · 血厚耐打，旋风斩横扫四方'
  },
  mage: {
    id: 'mage', name: '法师', color: '#5b8cff', accent: '#cfe0ff',
    maxHp: 98, speed: 162, attack: 16, defense: 2,
    attackCd: 550, critChance: 0.08, critMult: 1.75,
    attackType: 'projectile', attackRange: 640, projSpeed: 470, projRadius: 9,
    skills: [
      { id: 'fireball', name: '火球术', reqLevel: 1, cd: 5200, mult: 2.25, radius: 115,
        projSpeed: 360, projRadius: 16, desc: '发射爆炸火球，命中后范围炸裂' },
      // identity gap: the glass cannon dies when chased down. Frost Nova = panic peel + setup control.
      { id: 'frostnova', name: '霜雪新星', reqLevel: 3, cd: 9000, mult: 1.6, radius: 150,
        projSpeed: 340, projRadius: 14,
        slowMs: 2500, slowMul: 0.5,
        desc: '发射寒冰弹，命中后范围冰冻减速敌人，拉开身位或接火球' }
    ],
    desc: '远程法术 · 脆皮高爆发，火球术范围秒杀'
  },
  assassin: {
    id: 'assassin', name: '刺客', color: '#a368ff', accent: '#e6d4ff',
    maxHp: 118, speed: 206, attack: 18, defense: 3,
    attackCd: 420, critChance: 0.5, critMult: 2.2,
    attackType: 'melee_single', attackRange: 82,
    skills: [
      { id: 'shadowstrike', name: '影袭', reqLevel: 1, cd: 7000, mult: 2.4, dash: 230, radius: 64,
        desc: '瞬步突袭，穿越敌人并必定暴击' },
      // identity gap: can engage (影袭) but can't disengage. 影遁 = the escape, opposite direction.
      { id: 'shadowveil', name: '影遁', reqLevel: 3, cd: 11000, mult: 1.2, radius: 90, dash: 210,
        stealthMs: 3000, hasteMs: 2600,
        desc: '朝移动方向瞬遁并隐身疾走，留烟反伤——脱战或换位' }
    ],
    desc: '高暴击近战 · 移速极快，影袭瞬步斩杀'
  }
};

// ---- Pickups / status items ------------------------------------------------
const ITEM_TYPES = {
  heal:    { name: '治疗药水', color: '#ff5d73', icon: '♥', kind: 'instant', desc: '恢复 40% 生命' },
  speed:   { name: '疾速之靴', color: '#37d67a', icon: '»', kind: 'buff',    desc: '8 秒内移动速度 +42%' },
  haste:   { name: '狂怒图腾', color: '#ffb020', icon: '⚡', kind: 'buff',    desc: '8 秒内攻击速度 +38%' },
  invis:   { name: '隐身斗篷', color: '#9aa3b2', icon: '◌', kind: 'buff',    desc: '隐身 10 秒，敌人无法看见你' },
  life:    { name: '复活之心', color: '#ff7ab8', icon: '✚', kind: 'instant', desc: '获得额外一条命' },
  defense: { name: '守护之盾', color: '#4aa3ff', icon: '⛨', kind: 'buff',    desc: '15 秒内防御大幅提升' },
  power:   { name: '力量结晶', color: '#ff7a3d', icon: '⚔', kind: 'buff',    desc: '15 秒内攻击力 +30%' },
  exp:     { name: '经验药水', color: '#b66bff', icon: '★', kind: 'instant', desc: '立即获得经验' },
  reveal:  { name: '洞察之眼', color: '#33e0e0', icon: '◉', kind: 'buff',    desc: '10 秒内显示全部玩家位置' },
  gold:    { name: '金币宝箱', color: '#ffd23f', icon: '$', kind: 'instant', desc: '开启获得随机金币' }
};

// spawn weighting (higher = more common)
const ITEM_WEIGHTS = {
  gold: 12, heal: 20, exp: 14, speed: 9, haste: 9,
  power: 8, defense: 8, reveal: 5, invis: 4, life: 1
};

// ---- Merchant shop ---------------------------------------------------------
// Permanent in-match shop — replaced the old consumable SHOP array.
// Equipment: stat-boost pieces, all classes can buy, stack within the match.
// Cosmetics: per-class visual items (skin / trail / glow / size), one-of-each
// per cosmetic slot — buying a new skin replaces the old skin, etc.
//
// Each equipment item carries an `icon` (svg path) + `iconBg` so the shop card
// can show a glyph that matches the stat (heart, sword, wing, target, glove).
// Each cosmetic carries a `preview` (skin/trail/glow/size) the client uses to
// draw a mini canvas preview of the effect — replacing the old uniform "✦".
//
// 神秘商人提价 25% — all listed prices are post-markup. Base values were
// rounded to the nearest 25.
const EQUIPMENT = [
  { id: 'eq_hp1',     name: '生命宝珠·小',  price: 1125, bonus: { hp: 40 },
    icon: 'M12 21s-7-4.5-9.5-9C.7 8.7 2.5 5 6 5c2 0 3.5 1 4 2 0.5-1 2-2 4-2 3.5 0 5.3 3.7 3.5 7-2.5 4.5-9.5 9-9.5 9z',
    iconBg: '#ff5d73' },
  { id: 'eq_atk1',    name: '锋利之爪·小',  price: 1375, bonus: { atk: 5 },
    icon: 'M14 3l7 7-3 3-7-7 3-3zM3 21l7-7 3 3-7 7H3v-3z',
    iconBg: '#ef5b52' },
  { id: 'eq_spd1',    name: '迅捷护腕·小',  price: 1250, bonus: { speed: 18 },
    icon: 'M2 17l4-1 1-3 6 1 4-2 4 1-2 4-6 2-4-1-3 1-4-2zM3 21l3-1 1 2H4l-1-1z',
    iconBg: '#37d67a' },
  { id: 'eq_crit1',   name: '暴击印记·小',  price: 1750, bonus: { critChance: 0.05 },
    icon: 'M12 2l2.5 6.5L21 9l-5 4.5L17.5 21 12 17l-5.5 4L8 13.5 3 9l6.5-0.5L12 2z',
    iconBg: '#ffb020' },
  { id: 'eq_atkspd1', name: '疾速拳套·小',  price: 1625, bonus: { attackCdMul: 0.85 },
    icon: 'M13 2L4 14h7l-2 8 9-12h-7l2-8z',
    iconBg: '#5b8cff' },
];

const COSMETICS = {
  warrior: [
    { id: 'w_skin_crimson',  cls: 'warrior',  name: '绯红战甲',   price: 1500, skin:  'crimson', preview: 'skin' },
    { id: 'w_trail_fire',    cls: 'warrior',  name: '烈焰拖尾',   price: 2250, trail: 'fire',   preview: 'trail' },
    { id: 'w_glow_gold',     cls: 'warrior',  name: '黄金外发光', price: 1875, glow:  '#ffd766', preview: 'glow' },
    { id: 'w_size_colossus', cls: 'warrior',  name: '巨人体魄',   price: 2750, size:  1.20,     preview: 'size' },
  ],
  mage: [
    { id: 'm_skin_arcane',   cls: 'mage',     name: '奥术长袍',   price: 1500, skin:  'arcane', preview: 'skin' },
    { id: 'm_trail_frost',   cls: 'mage',     name: '寒霜拖尾',   price: 2250, trail: 'frost', preview: 'trail' },
    { id: 'm_glow_blue',     cls: 'mage',     name: '蓝光灵体',   price: 1875, glow:  '#7fd8ff', preview: 'glow' },
    { id: 'm_size_pixie',    cls: 'mage',     name: '精灵身形',   price: 2750, size:  0.80,    preview: 'size' },
  ],
  assassin: [
    { id: 'a_skin_shadow',   cls: 'assassin', name: '暗影披风',   price: 1500, skin:  'shadow', preview: 'skin' },
    { id: 'a_trail_smoke',   cls: 'assassin', name: '烟遁拖尾',   price: 2250, trail: 'smoke', preview: 'trail' },
    { id: 'a_glow_purple',   cls: 'assassin', name: '紫影外发光', price: 1875, glow:  '#a368ff', preview: 'glow' },
    { id: 'a_size_quick',    cls: 'assassin', name: '纤毫身姿',   price: 2750, size:  0.88,     preview: 'size' },
  ],
};

const PERMANENT_SHOP_CATALOG = { equipment: EQUIPMENT, cosmetics: COSMETICS };

// ---- Balance knobs ---------------------------------------------------------
const BALANCE = {
  pickupRadius: 32,
  spawnProtect: 2500,
  respawnDelay: 3000,
  maxLives: 5,          // 总命数上限（含当前命）：复活之心最多叠到 5 条命
  itemCap: 46,
  itemSpawnMs: 1000,
  buffDur: { speed: 8000, haste: 8000, invis: 10000, defense: 15000, power: 15000, reveal: 10000 },
  buff: { speedMul: 1.42, hasteMul: 0.62, powerMul: 1.30, defenseAdd: 13 },
  chatDur: 5000,
  merchantRange: 135,
  xp: { perDamage: 0.22, killBase: 40, killPerLevel: 12, bossKill: 430, expPotion: 75 },
  hp: { perLevel: 22 }, attackPerLevel: 3, defensePerLevel: 1,
  // skill knobs: warrior 铁壁战吼 incoming-damage multiplier while braced (lower = tankier)
  skill: { guardMul: 0.55 },
  goldChest: [30, 130], killBounty: [18, 40],
  // Boss spawn cadence only. Each archetype's stats / abilities / rewards live in
  // BOSS_TYPES below; bounty & xp are per-type (a tougher boss is worth more).
  boss: { count: 1, respawnMs: 22000, bountyDefault: 270 },
  // merchant: short hops then a pause, so players can actually reach & buy
  merchantCount: 2, merchantSpeed: 70,
  merchantPauseMs: [4500, 8500],   // how long it stands still ("营业中")
  merchantRoamDist: [170, 420],    // distance of each short hop
  merchantMoveMaxMs: 9000,         // safety cap on a single hop
  merchant: { maxHp: 220, respawnMs: 30000 },   // 商人可被打 + 30s 复活
  maxLevel: 25                                      // 等级上限（满级后不升级、不转经验）
};

// ---- Boss archetypes -------------------------------------------------------
// Each entry is a *distinct playstyle*, not just a re-skin: different stats,
// a different ability kit, and different passive traits. The simulation
// (world.js) reads `abilities` (cooldown-gated) and `traits` (passives).
//
//   ability kinds:
//     slam   { cd, dmg, radius }                 — instant ring AOE around the boss
//     orbs   { cd, count, speed, dmg, radius, mode:'radial'|'aimed', spread, homing, turn, life }
//     spiral { cd, arms, step, speed, dmg, radius } — rotating bullet-hell fan (fires fast)
//     charge { cd, windup, dash, speed, dmg, hitR, nova:{dmg,radius} } — telegraphed line dash
//     blink  { cd, dist, awayIf } — teleport (toward target, or away when a hero is within awayIf)
//     drain  { cd, dmg, radius, heal } — AOE that heals the boss for heal*dmg per hero hit
//   traits (passive):
//     enrageAt (hp fraction) + moveMul + rateMul — below the threshold it speeds up
//     regen (hp/sec), lifesteal (fraction of contact damage healed back)
const BOSS_TYPES = {
  // 1) Juggernaut — the original all-rounder: tanky, stomps + radial fire nova.
  brute: {
    name: '炎魔·巴洛尔', color: '#9e2b2b', accent: '#ff6a4d', shape: 'demon',
    hp: 2350, attack: 40, speed: 66, radius: 60, aggro: 820,
    contactMs: 1000, contactRange: 86, bounty: 320, xp: 520,
    desc: '全能炎魔 · 践踏震地，火球弹幕封锁四方',
    abilities: [
      { k: 'slam', cd: 4400, dmg: 58, radius: 185 },
      { k: 'orbs', cd: 6200, count: 14, speed: 230, dmg: 28, radius: 11, mode: 'radial' }
    ],
    traits: {}
  },
  // 2) Diver — fast melee bruiser. Telegraphed line-charge + frost burst on arrival.
  //    No ranged tools: kite the charge and it is harmless. Enrages when low.
  charger: {
    name: '霜牙暴君', color: '#2f7fd0', accent: '#bfe6ff', shape: 'beast',
    hp: 2050, attack: 36, speed: 98, radius: 52, aggro: 1000,
    contactMs: 850, contactRange: 78, bounty: 350, xp: 560,
    desc: '冲锋猛兽 · 直线冲撞撕裂，落点炸开寒霜',
    abilities: [
      { k: 'charge', cd: 4600, windup: 620, dash: 380, speed: 780, dmg: 70, hitR: 58,
        nova: { dmg: 36, radius: 160 } }
    ],
    traits: { enrageAt: 0.35, moveMul: 1.3, rateMul: 0.7 }
  },
  // 3) Summoner — slow, very tanky, regenerates. Fires waves of homing void-eyes
  //    and blinks toward heroes to keep the seekers on top of them.
  warden: {
    name: '深渊看守者', color: '#5a3aa8', accent: '#caa8ff', shape: 'wraith',
    hp: 3000, attack: 32, speed: 46, radius: 64, aggro: 1150,
    contactMs: 1100, contactRange: 92, bounty: 390, xp: 650,
    desc: '深渊召唤者 · 追踪虚空之眼，瞬移如影随形',
    abilities: [
      { k: 'orbs', cd: 4800, count: 6, speed: 150, dmg: 26, radius: 13,
        mode: 'aimed', spread: 1.0, homing: true, turn: 2.4, life: 4.8 },
      { k: 'blink', cd: 7000, dist: 380 }
    ],
    traits: { regen: 8 }
  },
  // 4) Juggernaut-plus — enormous HP/radius, devastating shockwave + aimed boulder.
  //    Barely moves, but enrages hard below 35% and starts slamming relentlessly.
  golem: {
    name: '远古石巨人', color: '#6b7280', accent: '#d3c08a', shape: 'golem',
    hp: 4200, attack: 54, speed: 34, radius: 80, aggro: 780,
    contactMs: 1250, contactRange: 106, bounty: 440, xp: 780,
    desc: '重甲巨像 · 震地冲击波与飞石，残血陷入狂暴',
    abilities: [
      { k: 'slam', cd: 5000, dmg: 88, radius: 260 },
      { k: 'orbs', cd: 6000, count: 1, speed: 300, dmg: 72, radius: 20, mode: 'aimed', spread: 0 }
    ],
    traits: { enrageAt: 0.4, moveMul: 1.3, rateMul: 0.55 }
  },
  // 5) Caster / kiter — fragile but fills the arena with a rotating spiral, snipes
  //    with a 3-shot fan, and blinks AWAY the instant a hero closes in. Corner it.
  eye: {
    name: '混沌之眼', color: '#8e44c8', accent: '#f0c6ff', shape: 'eye',
    hp: 1900, attack: 18, speed: 74, radius: 54, aggro: 1200,
    contactMs: 1000, contactRange: 76, bounty: 380, xp: 600,
    desc: '混沌法师 · 螺旋弹幕铺场，近身即瞬退',
    abilities: [
      { k: 'spiral', cd: 220, arms: 3, step: 0.42, speed: 240, dmg: 18, radius: 9 },
      { k: 'orbs', cd: 3200, count: 3, speed: 330, dmg: 30, radius: 11, mode: 'aimed', spread: 0.34 },
      { k: 'blink', cd: 3000, dist: 300, awayIf: 230 }
    ],
    traits: {}
  },
  // 6) Sustain / vampire — heals off every melee hit, and its drain pulse converts
  //    hero HP straight into its own. Burst it down or it claws everything back.
  revenant: {
    name: '虚空领主', color: '#2f9e6a', accent: '#9bf0c4', shape: 'revenant',
    hp: 2600, attack: 38, speed: 74, radius: 58, aggro: 920,
    contactMs: 900, contactRange: 84, bounty: 400, xp: 680,
    desc: '噬血领主 · 吸血打击与汲取脉冲，持续自愈',
    abilities: [
      { k: 'drain', cd: 4800, dmg: 42, radius: 210, heal: 1.0 },
      { k: 'orbs', cd: 4200, count: 8, speed: 270, dmg: 26, radius: 10, mode: 'radial' }
    ],
    traits: { lifesteal: 0.7, regen: 6 }
  }
};

// client-facing subset (visuals only) so the renderer can draw each archetype
const BOSS_DEFS = Object.fromEntries(Object.entries(BOSS_TYPES).map(
  ([k, d]) => [k, { id: k, name: d.name, color: d.color, accent: d.accent, shape: d.shape, radius: d.radius, desc: d.desc }]
));

// ---- static cover / obstacles ---------------------------------------------
const OBSTACLES = { count: 18, minR: 34, maxR: 72, margin: 200, gap: 120 };

// ---- loot dropped on death (uses ITEM_WEIGHTS) ----------------------------
const DROP = { playerMin: 1, playerMax: 5, bossMin: 6, bossMax: 10, scatter: 84 };

// ---- kill feed / announcements --------------------------------------------
const KILL = { multiWindowMs: 10000 };   // consecutive kills within this window chain into 双杀/三杀…

module.exports = {
  WORLD, TICK_RATE, BROADCAST_RATE,
  DAY_NIGHT, dayNightLightAt,
  CLASSES, ITEM_TYPES, ITEM_WEIGHTS, PERMANENT_SHOP_CATALOG, BALANCE, BOSS_TYPES, BOSS_DEFS, OBSTACLES, DROP, KILL
};

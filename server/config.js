// ============================================================================
//  Arena Brawl — shared game configuration & definitions
//  Single source of truth for world size, tick rates, classes, items, balance.
//  A trimmed copy of CLASSES / ITEM_TYPES / SHOP is sent to clients on join.
// ============================================================================

const WORLD = { width: 3200, height: 2200 };

const TICK_RATE = 30;        // server simulation steps / second
const BROADCAST_RATE = 20;   // state snapshots / second

// ---- Player classes --------------------------------------------------------
// attackType: 'melee_aoe' | 'melee_single' | 'projectile'
const CLASSES = {
  warrior: {
    id: 'warrior', name: '战士', color: '#ef5b52', accent: '#ffd0cb',
    maxHp: 165, speed: 158, attack: 21, defense: 7,
    attackCd: 620, critChance: 0.06, critMult: 1.6,
    attackType: 'melee_aoe', attackRange: 98, attackArc: Math.PI * 0.95,
    skills: [
      { id: 'whirlwind', name: '旋风斩', cd: 6000, mult: 1.9, radius: 155,
        desc: '横扫周身敌人，造成大量范围伤害' }
    ],
    desc: '范围近战 · 血厚耐打，旋风斩横扫四方'
  },
  mage: {
    id: 'mage', name: '法师', color: '#5b8cff', accent: '#cfe0ff',
    maxHp: 98, speed: 162, attack: 16, defense: 2,
    attackCd: 520, critChance: 0.08, critMult: 1.75,
    attackType: 'projectile', attackRange: 640, projSpeed: 470, projRadius: 9,
    skills: [
      { id: 'fireball', name: '火球术', cd: 5200, mult: 2.25, radius: 115,
        projSpeed: 360, projRadius: 16, desc: '发射爆炸火球，命中后范围炸裂' }
    ],
    desc: '远程法术 · 脆皮高爆发，火球术范围秒杀'
  },
  assassin: {
    id: 'assassin', name: '刺客', color: '#a368ff', accent: '#e6d4ff',
    maxHp: 118, speed: 206, attack: 18, defense: 3,
    attackCd: 420, critChance: 0.5, critMult: 2.2,
    attackType: 'melee_single', attackRange: 82,
    skills: [
      { id: 'shadowstrike', name: '影袭', cd: 7000, mult: 2.4, dash: 230, radius: 64,
        desc: '瞬步突袭，穿越敌人并必定暴击' }
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
  gold: 22, heal: 20, exp: 14, speed: 9, haste: 9,
  power: 8, defense: 8, reveal: 5, invis: 4, life: 2
};

// ---- Merchant shop ---------------------------------------------------------
const SHOP = [
  { id: 'heal',    price: 55  },
  { id: 'power',   price: 130 },
  { id: 'defense', price: 120 },
  { id: 'speed',   price: 95  },
  { id: 'haste',   price: 110 },
  { id: 'invis',   price: 150 },
  { id: 'life',    price: 260 }
];

// ---- Balance knobs ---------------------------------------------------------
const BALANCE = {
  pickupRadius: 32,
  spawnProtect: 2500,
  respawnDelay: 3000,
  itemCap: 46,
  itemSpawnMs: 1000,
  buffDur: { speed: 8000, haste: 8000, invis: 10000, defense: 15000, power: 15000, reveal: 10000 },
  buff: { speedMul: 1.42, hasteMul: 0.62, powerMul: 1.30, defenseAdd: 13 },
  chatDur: 5000,
  merchantRange: 135,
  xp: { perDamage: 0.22, killBase: 40, killPerLevel: 12, bossKill: 430, expPotion: 75 },
  hp: { perLevel: 22 }, attackPerLevel: 3, defensePerLevel: 1,
  goldChest: [30, 130], killBounty: [18, 40],
  boss: {
    count: 1, respawnMs: 22000, hp: 1750, attack: 34, speed: 64, radius: 62,
    aggro: 780, contactMs: 1000, contactRange: 86,
    slamMs: 4400, slamDmg: 48, slamRadius: 175,
    orbMs: 6500, orbCount: 10, orbSpeed: 230, orbDmg: 24, orbRadius: 11,
    bounty: 270
  },
  merchantCount: 2, merchantSpeed: 72
};

const BOSS_NAMES = ['炎魔·巴洛尔', '深渊看守者', '远古石巨人', '混沌之眼', '霜牙暴君', '虚空领主'];

module.exports = {
  WORLD, TICK_RATE, BROADCAST_RATE,
  CLASSES, ITEM_TYPES, ITEM_WEIGHTS, SHOP, BALANCE, BOSS_NAMES
};

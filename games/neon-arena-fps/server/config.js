// 游戏共享配置：服务端权威使用，join 时整体下发给客户端（保证两端几何/数值一致）
'use strict';

// ---------- 地图 ----------
// 竞技场 70x70，四周高墙。障碍物为轴对齐盒子/圆柱（少量掩体，相对空旷）
const MAP = {
  half: 35,            // 场地半宽（墙位于 ±35）
  wallH: 6,
  obstacles: [
    // 中央双墙掩体
    { t: 'box', x: 0,   z: 3,   w: 11,  d: 1.4, h: 3.2, kind: 'wall'  },
    { t: 'box', x: -6,  z: -6,  w: 1.4, d: 9,   h: 3.2, kind: 'wall'  },
    // 木箱
    { t: 'box', x: 14,  z: 11,  w: 2.2, d: 2.2, h: 2.2, kind: 'crate' },
    { t: 'box', x: -16, z: 9,   w: 2.2, d: 2.2, h: 2.2, kind: 'crate' },
    { t: 'box', x: 10,  z: -18, w: 2.2, d: 2.2, h: 2.2, kind: 'crate' },
    { t: 'box', x: -13, z: -16, w: 2.2, d: 2.2, h: 2.2, kind: 'crate' },
    { t: 'box', x: 22,  z: 19,  w: 3.2, d: 3.2, h: 2.8, kind: 'crate' },
    { t: 'box', x: -21, z: -23, w: 3.2, d: 3.2, h: 2.8, kind: 'crate' },
    // 低矮路障（可跳上/翻越视线）
    { t: 'box', x: 7,   z: 17,  w: 4.5, d: 1.1, h: 1.15, kind: 'barrier' },
    { t: 'box', x: -9,  z: -1,  w: 1.1, d: 4.5, h: 1.15, kind: 'barrier' },
    { t: 'box', x: 17,  z: -13, w: 4.5, d: 1.1, h: 1.15, kind: 'barrier' },
    { t: 'box', x: 24,  z: -4,  w: 1.1, d: 4.5, h: 1.15, kind: 'barrier' },
    // 油桶
    { t: 'cyl', x: -19, z: 17,  r: 0.85, h: 1.7, kind: 'barrel' },
    { t: 'cyl', x: 4,   z: -11, r: 0.85, h: 1.7, kind: 'barrel' },
    { t: 'cyl', x: 26,  z: -21, r: 0.85, h: 1.7, kind: 'barrel' },
  ],
  // 出生点（随机取，均远离中心）
  spawns: [
    [28, 28], [-28, 28], [28, -28], [-28, -26], [0, 30], [0, -30],
    [30, 0], [-30, 4], [20, -27], [-24, 14],
  ],
  // 拾取点：cat = wep 武器 / equip 装备 / buff 状态道具
  pickups: [
    { id: 0,  x: 0,    z: -3,  cat: 'wep'   },
    { id: 1,  x: 13,   z: 14,  cat: 'wep'   },
    { id: 2,  x: -14,  z: 12,  cat: 'wep'   },
    { id: 3,  x: 9,    z: -15, cat: 'wep'   },
    { id: 4,  x: -11,  z: -19, cat: 'wep'   },
    { id: 5,  x: 21,   z: 1,   cat: 'wep'   },
    { id: 6,  x: 26,   z: 25,  cat: 'equip' },
    { id: 7,  x: -26,  z: -28, cat: 'equip' },
    { id: 8,  x: -25,  z: 21,  cat: 'equip' },
    { id: 9,  x: 23,   z: -25, cat: 'equip' },
    { id: 10, x: 3,    z: 8,   cat: 'buff'  },
    { id: 11, x: -3,   z: 24,  cat: 'buff'  },
    { id: 12, x: 17,   z: 23,  cat: 'buff'  },
    { id: 13, x: -30,  z: -8,  cat: 'buff'  },
    { id: 14, x: 30,   z: -12, cat: 'buff'  },
    { id: 15, x: -17,  z: -6,  cat: 'buff'  },
  ],
  merchant: { x: -29, z: 29 },       // 神秘商人摊位（西北角）
  bossSpawns: [[0, -18], [16, 10], [-16, -10], [0, 20]],
};

// ---------- 武器 ----------
// 无限子弹：枪械弹匣打空自动换弹（reload 秒），近战为挥击冷却，手雷为投掷冷却
const WEAPONS = {
  fist:   { slot: 'melee', name: '拳头',   dmg: 15,  range: 2.4, cd: 0.4  },
  knife:  { slot: 'melee', name: '小刀',   dmg: 26,  range: 2.6, cd: 0.32 },
  sword:  { slot: 'melee', name: '长刀',   dmg: 42,  range: 3.5, cd: 0.65 },
  hammer: { slot: 'melee', name: '铁锤',   dmg: 70,  range: 3.0, cd: 1.15, sweep: true },
  pistol: { slot: 'gun',   name: '手枪',   dmg: 22,  range: 80,  cd: 0.27, mag: 12, reload: 1.3, auto: false, spread: 0.014 },
  mg:     { slot: 'gun',   name: '机枪',   dmg: 13,  range: 65,  cd: 0.09, mag: 40, reload: 2.4, auto: true,  spread: 0.05  },
  sniper: { slot: 'gun',   name: '狙击枪', dmg: 95,  range: 220, cd: 1.4,  mag: 5,  reload: 2.8, auto: false, spread: 0.002, zoom: true },
  nade:   { slot: 'nade',  name: '手雷',   dmg: 105, radius: 6.5, fuse: 2.2, cd: 3.5 },
};

// ---------- 装备（即时生效拾取物） ----------
const EQUIPS = {
  health: { name: '医疗包',  desc: '恢复 50 生命' },
  armor:  { name: '防弹衣',  desc: '获得 50 护甲(减伤60%)' },
  boots:  { name: '疾风靴',  desc: '永久+10%移速(本条命,最多3层)' },
};

// ---------- 状态道具（限时 BUFF） ----------
const BUFFS = {
  speed:  { name: '疾速',     dur: 10, icon: '⚡', color: '#38d9ff', desc: '移动速度 +60%' },
  rage:   { name: '狂暴',     dur: 10, icon: '🔥', color: '#ff5c38', desc: '攻击力 +60%' },
  crit:   { name: '暴击',     dur: 12, icon: '💥', color: '#ffd23c', desc: '30% 概率造成 2 倍伤害' },
  invis:  { name: '隐身',     dur: 8,  icon: '👻', color: '#c7bfff', desc: '身形近乎透明' },
  zombie: { name: '暴走丧尸', dur: 12, icon: '🧟', color: '#7bff4d', desc: '只能近战：伤害x2 吸血60% 移速+35%' },
  jump:   { name: '弹跳',     dur: 12, icon: '🦘', color: '#ffa94d', desc: '跳跃高度大幅提升' },
  shield: { name: '护盾',     dur: 15, icon: '🛡️', color: '#4dc7ff', desc: '吸收 100 点伤害' },
};

// 拾取点各分类可随机出的物品
const PICKUP_POOLS = {
  wep:   ['knife', 'sword', 'hammer', 'pistol', 'pistol', 'mg', 'mg', 'sniper', 'nade', 'nade'],
  equip: ['health', 'health', 'armor', 'armor', 'boots'],
  buff:  ['speed', 'rage', 'crit', 'invis', 'zombie', 'jump', 'shield'],
};

// ---------- BOSS ----------
const BOSS = {
  hp: 900, speed: 3.4, radius: 1.7,
  meleeDmg: 32, meleeRange: 3.8, meleeCd: 1.7,
  fireDmg: 26, fireSpeed: 14, fireCd: 3.2, aggro: 48,
  killScore: 100, killCoins: 200, assistCoins: 60, assistMin: 80,
  respawnMin: 40, respawnMax: 90,   // 秒
  firstDelay: 25,                   // 开服后首个 BOSS 延迟
  names: ['熔岩魔像', '暗影领主', '狂暴巨兽', '虚空撕裂者', '钢铁暴君'],
};

// ---------- 神秘商人（外观装饰，金币购买，按名字持久保存） ----------
const SHOP = [
  { id: 'hat_cowboy',  slot: 'head', name: '牛仔帽',   price: 120 },
  { id: 'hat_beret',   slot: 'head', name: '贝雷帽',   price: 150 },
  { id: 'hat_horns',   slot: 'head', name: '恶魔之角', price: 300 },
  { id: 'hat_crown',   slot: 'head', name: '黄金皇冠', price: 500 },
  { id: 'face_shades', slot: 'face', name: '黑超墨镜', price: 100 },
  { id: 'face_visor',  slot: 'face', name: '赛博面罩', price: 260 },
  { id: 'back_cape',   slot: 'back', name: '猩红披风', price: 220 },
  { id: 'back_jet',    slot: 'back', name: '火箭背包', price: 400 },
  { id: 'back_wings',  slot: 'back', name: '天使之翼', price: 550 },
  { id: 'fx_ice',      slot: 'fx',   name: '寒冰武器光效', price: 200 },
  { id: 'fx_gold',     slot: 'fx',   name: '黄金武器光效', price: 350 },
  { id: 'fx_rainbow',  slot: 'fx',   name: '彩虹武器光效', price: 600 },
];
const SHOP_SLOTS = { head: '头部', face: '面部', back: '背部', fx: '武器光效' };

// ---------- 全局玩法参数 ----------
const RULES = {
  maxHp: 100, maxArmor: 100,
  baseSpeed: 6.2, jumpVel: 8.2, gravity: 22,
  eyeH: 1.62,
  startCoins: 100,
  killScore: 100, killCoins: 25, killHeal: 15,
  respawnMs: 4000, protectMs: 2500,
  armorAbsorb: 0.6, headshotMul: 1.5,
  critChance: 0.3, rageMul: 1.6, zombieMeleeMul: 2.0, zombieLifesteal: 0.6,
  shieldHp: 100,
  pickupDist: 3.4, merchantDist: 5,
  pickupRespawnMin: 12, pickupRespawnMax: 22, // 秒
  maxPlayers: 24,
  tickRate: 30, broadcastRate: 15,
};

module.exports = { MAP, WEAPONS, EQUIPS, BUFFS, PICKUP_POOLS, BOSS, SHOP, SHOP_SLOTS, RULES };

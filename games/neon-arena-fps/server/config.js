// 游戏共享配置：服务端权威使用，join 时整体下发给客户端（保证两端几何/数值一致）
'use strict';

// ---------- 地图 ----------
// 竞技场 70x70，四周高墙。障碍物为轴对齐盒子（少量掩体 + 两处高地，相对空旷）
// 斜坡实现：碰撞用一串 0.15 级差的微阶片（复用 AABB 跨步逻辑，两端零新代码），
// 客户端渲染时以整块斜面盖在上面，行走手感与视觉都是平滑坡道
function rampSlices(x, z, axis, dir, len, w, h) {
  const slices = [];
  const n = Math.max(8, Math.round(len / 0.3));
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const hh = h * (i + 1) / n;
    const off = (t - 0.5) * len * dir;
    slices.push(axis === 'x'
      ? { t: 'box', x: x + off, z, w: len / n + 0.02, d: w, h: hh, kind: 'rampslice' }
      : { t: 'box', x, z: z + off, w, d: len / n + 0.02, h: hh, kind: 'rampslice' });
  }
  return slices;
}
const RAMPS = [
  { x: 12.6,  z: -19,   axis: 'x', dir: 1,  len: 4.8, w: 3, h: 2.2 },  // 高地A 西坡
  { x: 19,    z: -25.4, axis: 'z', dir: 1,  len: 4.8, w: 3, h: 2.2 },  // 高地A 北坡
  { x: -14,   z: 13,    axis: 'x', dir: -1, len: 4,   w: 3, h: 1.6 },  // 高地B 东坡
];

const OUTER_COVER = [
  { t: 'box', x: 35,  z: 27,   w: 5.5, d: 1.3, h: 3.0, kind: 'wall' },
  { t: 'box', x: -35, z: -27,  w: 5.5, d: 1.3, h: 3.0, kind: 'wall' },
  { t: 'box', x: -37, z: 24,   w: 1.3, d: 5.5, h: 3.0, kind: 'wall' },
  { t: 'box', x: 37,  z: -31,  w: 1.3, d: 5.5, h: 3.0, kind: 'wall' },
  { t: 'box', x: 38,  z: -8,   w: 2.4, d: 2.4, h: 2.4, kind: 'crate' },
  { t: 'box', x: -38, z: 10,   w: 2.4, d: 2.4, h: 2.4, kind: 'crate' },
  { t: 'box', x: 7,   z: 38,   w: 2.4, d: 2.4, h: 2.4, kind: 'crate' },
  { t: 'box', x: -9,  z: -38,  w: 2.4, d: 2.4, h: 2.4, kind: 'crate' },
  { t: 'box', x: 27,  z: 39,   w: 5.0, d: 1.1, h: 1.15, kind: 'barrier' },
  { t: 'box', x: -27, z: -39,  w: 5.0, d: 1.1, h: 1.15, kind: 'barrier' },
  { t: 'box', x: 41,  z: 14,   w: 1.1, d: 4.5, h: 1.15, kind: 'barrier' },
  { t: 'box', x: -41, z: -14,  w: 1.1, d: 4.5, h: 1.15, kind: 'barrier' },
];
const MAP = {
  half: 48,            // 场地半宽（外墙位于 ±48，整体战场 96x96）
  wallH: 6,
  obstacles: [
    // 中央双墙掩体
    { t: 'box', x: 0,   z: 3,   w: 11,  d: 1.4, h: 3.2, kind: 'wall'  },
    { t: 'box', x: -6,  z: -6,  w: 1.4, d: 9,   h: 3.2, kind: 'wall'  },
    // 木箱
    { t: 'box', x: 14,  z: 11,  w: 2.2, d: 2.2, h: 2.2, kind: 'crate' },
    { t: 'box', x: -14, z: 7,   w: 2.2, d: 2.2, h: 2.2, kind: 'crate' },
    { t: 'box', x: 7,   z: -22, w: 2.2, d: 2.2, h: 2.2, kind: 'crate' },
    { t: 'box', x: -13, z: -16, w: 2.2, d: 2.2, h: 2.2, kind: 'crate' },
    { t: 'box', x: 22,  z: 19,  w: 3.2, d: 3.2, h: 2.8, kind: 'crate' },
    { t: 'box', x: -21, z: -23, w: 3.2, d: 3.2, h: 2.8, kind: 'crate' },
    // 低矮路障（可跳上）
    { t: 'box', x: 7,   z: 17,  w: 4.5, d: 1.1, h: 1.15, kind: 'barrier' },
    { t: 'box', x: -9,  z: -1,  w: 1.1, d: 4.5, h: 1.15, kind: 'barrier' },
    { t: 'box', x: 17,  z: -13, w: 4.5, d: 1.1, h: 1.15, kind: 'barrier' },
    { t: 'box', x: 24,  z: -4,  w: 1.1, d: 4.5, h: 1.15, kind: 'barrier' },
    // 高地 A（东南）：8x8x2.2 平台 + 西/北两条斜坡
    { t: 'box', x: 19,   z: -19,   w: 8,   d: 8,   h: 2.2,  kind: 'platform' },
    // 高地 B（西北）：6x6x1.6 平台 + 东侧斜坡
    { t: 'box', x: -19,  z: 13,    w: 6,   d: 6,   h: 1.6,  kind: 'platform' },
    ...RAMPS.flatMap(r => rampSlices(r.x, r.z, r.axis, r.dir, r.len, r.w, r.h)),
    ...OUTER_COVER,
  ],
  ramps: RAMPS,   // 客户端渲染整块斜面用
  // 可摧毁油桶（独立实体，非静态障碍）
  barrels: [
    { x: -19, z: 17.5 }, { x: 4, z: -11 }, { x: 26, z: -21 },
    { x: 12, z: 20 }, { x: -6, z: -24 }, { x: 34, z: 8 },
    { x: -34, z: -8 },
  ],
  barrelR: 0.85, barrelH: 1.7,
  // 出生点（随机取，均远离中心）
  spawns: [
    [39, 34], [-39, 34], [39, -34], [-39, -34], [0, 41], [0, -41],
    [41, 0], [-41, 0], [30, -38], [-30, 38], [32, 22], [-32, -22],
  ],
  // 拾取点：cat = wep 武器 / equip 装备 / buff 状态道具；y 为所在地面高度
  pickups: [
    { id: 0,  x: 0,    z: -6,  cat: 'wep'   },
    { id: 1,  x: 17,   z: 14,  cat: 'wep'   },
    { id: 2,  x: -18,  z: 8,   cat: 'wep'   },
    { id: 3,  x: 3,    z: -23, cat: 'wep'   },
    { id: 4,  x: -29,  z: -24, cat: 'wep'   },
    { id: 5,  x: 30,   z: 10,  cat: 'wep'   },
    { id: 6,  x: 39,   z: 31,  cat: 'equip' },
    { id: 7,  x: -39,  z: -31, cat: 'equip' },
    { id: 8,  x: -32,  z: 27,  cat: 'equip' },
    { id: 9,  x: 32,   z: -37, cat: 'equip', y: 0 },
    { id: 10, x: 4,    z: 10,  cat: 'buff'  },
    { id: 11, x: -8,   z: 32,  cat: 'buff'  },
    { id: 12, x: 28,   z: 29,  cat: 'buff'  },
    { id: 13, x: -32,  z: -10, cat: 'buff'  },
    { id: 14, x: 32,   z: -18, cat: 'buff'  },
    { id: 15, x: -8,   z: -32, cat: 'buff'  },
    { id: 16, x: 19,   z: -19, cat: 'wep',  y: 2.2 },   // 高地 A 顶
    { id: 17, x: -19,  z: 13,  cat: 'buff', y: 1.6 },   // 高地 B 顶
  ],
  merchant: { x: -43, z: 40 },       // 神秘商人摊位（西北侧）
  bossSpawns: [[0, -18], [22, 12], [-22, -12], [0, 26], [28, -28], [-28, 24]],
};

// ---------- 武器 ----------
// 无限子弹：枪械弹匣打空自动换弹（reload 秒），近战为挥击冷却，手雷为投掷冷却
const WEAPONS = {
  fist:   { slot: 'melee', name: '拳头',   dmg: 15,  range: 2.4, cd: 0.4  },
  knife:  { slot: 'melee', name: '小刀',   dmg: 26,  range: 2.6, cd: 0.32 },
  sword:  { slot: 'melee', name: '长刀',   dmg: 42,  range: 3.5, cd: 0.65 },
  hammer: { slot: 'melee', name: '铁锤',   dmg: 70,  range: 3.0, cd: 1.15, sweep: true },
  // reserveMags = 首个弹匣外可换弹的匣数（越强的枪越少）；打光备弹自动切近战，拾取武器补满
  pistol: { slot: 'gun',   name: '手枪',   dmg: 22,  range: 80,  cd: 0.27, mag: 12, reload: 1.3, auto: false, spread: 0.014, reserveMags: 12 },
  mg:     { slot: 'gun',   name: '机枪',   dmg: 13,  range: 65,  cd: 0.09, mag: 40, reload: 2.4, auto: true,  spread: 0.05,  reserveMags: 8  },
  sniper: { slot: 'gun',   name: '狙击枪', dmg: 95,  range: 220, cd: 1.4,  mag: 5,  reload: 2.8, auto: false, spread: 0.002, zoom: true, reserveMags: 6 },
  // count = 携带个数（拾取补满，投完切近战）
  nade:   { slot: 'nade',  name: '手雷',   dmg: 105, radius: 6.5, fuse: 2.2, cd: 2.0, kind: 'frag',  count: 5 },
  flash:  { slot: 'nade',  name: '闪光弹', radius: 14,  fuse: 1.3, cd: 1.6, kind: 'flash', blindMax: 5.0, blindRadius: 14, count: 6 },
  smoke:  { slot: 'nade',  name: '烟雾弹', radius: 8,   fuse: 1.4, cd: 1.6, kind: 'smoke', smokeDur: 15000, count: 8 },
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
  wep:   ['knife', 'sword', 'hammer', 'pistol', 'pistol', 'mg', 'mg', 'sniper', 'nade', 'nade', 'flash', 'flash', 'smoke', 'smoke'],
  equip: ['health', 'health', 'armor', 'armor', 'boots'],
  buff:  ['speed', 'rage', 'crit', 'invis', 'zombie', 'jump', 'shield'],
};

// ---------- BOSS（多种类型，随机降临，同场仅一只） ----------
const BOSS = {
  aggro: 48,
  killScore: 100, assistCoins: 60, assistMin: 80,
  respawnMin: 40, respawnMax: 90,   // 秒
  firstDelay: 25,                   // 开服后首个 BOSS 延迟
};
const BOSSES = {
  golem: {      // 经典近战 + 火球
    name: '熔岩魔像', hp: 900, speed: 3.4, radius: 1.7, yc: 2.1, killCoins: 200, color: '#ff6a1a',
    meleeDmg: 32, meleeRange: 3.8, meleeCd: 1.7, fireDmg: 26, fireSpeed: 14, fireCd: 3.2,
  },
  assassin: {   // 高速近战，会闪现到目标身后、周期性隐身
    name: '暗影刺客', hp: 550, speed: 5.6, radius: 0.95, yc: 1.4, killCoins: 180, color: '#b46bff',
    meleeDmg: 24, meleeRange: 2.7, meleeCd: 0.8, blinkCd: 6, invisCd: 12, invisDur: 3,
  },
  warmachine: { // 重装机炮：连射弹幕 + 三连火箭
    name: '钢铁暴君', hp: 1400, speed: 2.1, radius: 2.0, yc: 2.2, killCoins: 280, color: '#ff4040',
    burstCd: 4, burstCount: 6, burstGap: 0.18, burstDmg: 8, bulletSpeed: 24,
    rocketCd: 9.5, rocketDmg: 22, fireSpeed: 13,
  },
  lich: {       // 虚空巫妖：追踪法球 + 延迟落地的虚空爆破
    name: '虚空巫妖', hp: 700, speed: 2.7, radius: 1.2, yc: 2.0, killCoins: 220, color: '#8f7bff',
    orbCd: 3.5, orbDmg: 24, orbSpeed: 8.5, blastCd: 8, blastDmg: 38, blastR: 3.4, blastDelay: 1.2,
  },
};

// ---------- 神秘商人（外观装饰，金币购买，按名字持久保存） ----------
const SHOP = [
  { id: 'hat_cowboy',  slot: 'head', name: '牛仔帽',   price: 600 },
  { id: 'hat_beret',   slot: 'head', name: '贝雷帽',   price: 750 },
  { id: 'hat_horns',   slot: 'head', name: '恶魔之角', price: 1500 },
  { id: 'hat_crown',   slot: 'head', name: '黄金皇冠', price: 2500 },
  { id: 'face_shades', slot: 'face', name: '黑超墨镜', price: 500 },
  { id: 'face_visor',  slot: 'face', name: '赛博面罩', price: 1300 },
  { id: 'back_cape',   slot: 'back', name: '猩红披风', price: 1100 },
  { id: 'back_jet',    slot: 'back', name: '火箭背包', price: 2000 },
  { id: 'back_wings',  slot: 'back', name: '天使之翼', price: 2750 },
  { id: 'fx_ice',      slot: 'fx',   name: '寒冰武器光效', price: 1000 },
  { id: 'fx_gold',     slot: 'fx',   name: '黄金武器光效', price: 1750 },
  { id: 'fx_rainbow',  slot: 'fx',   name: '彩虹武器光效', price: 3000 },
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
  barrelHp: 30, barrelDmg: 55, barrelRadius: 4.5,
  barrelRespawnMin: 30, barrelRespawnMax: 45, // 秒
  dayMs: 600000,                              // 10 分钟一昼夜
  maxPlayers: 24,
  tickRate: 30, broadcastRate: 20,
};

module.exports = { MAP, WEAPONS, EQUIPS, BUFFS, PICKUP_POOLS, BOSS, BOSSES, SHOP, SHOP_SLOTS, RULES };

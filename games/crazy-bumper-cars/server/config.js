'use strict';
const path = require('path');

module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 3000,
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

  MAX_PLAYERS: 40,
  TICK_RATE: 30,        // 物理模拟频率
  BROADCAST_RATE: 15,   // 快照广播频率
  BOARDS_MS: 1000,      // 排行榜广播间隔
  BACKPRESSURE_BYTES: 256 * 1024,

  WORLD: { w: 3200, h: 2200 },

  CAR: {
    r: 26,
    accel: 1150,         // 朝按键方向的加速度 px/s^2
    maxSpeed: 430,
    boostAccel: 1900,
    boostSpeed: 740,
    turnRate: 11,        // 车头转向行驶方向的速度 rad/s（纯视觉）
    friction: 1.7,       // 速度衰减系数 /s
    hp: 100
  },

  NITRO: { max: 100, drain: 40, regen: 15, minToFire: 12 },

  // 碰撞伤害：impact(相对逼近速度) 超过 minImpact 才掉血
  DMG: {
    minImpact: 150,
    scale: 0.085,
    cap: 45,
    pairCooldownMs: 300, // 同一对车两次伤害的最短间隔
    wallMinSpeed: 520,   // 撞墙自伤阈值
    wallDmg: 6
  },

  KNOCK: {
    restitution: 1.18,   // >1：卡通式越撞越飞
    victimShove: 0.95,   // 额外把受害者铲飞的系数
    spin: 7.0            // 被撞后的旋转视觉量
  },

  SAW: { dmg: 22, fling: 760, cooldownMs: 800 },
  BUMPER: { restitution: 1.55, minKick: 420 },
  PAD: { kick: 560, cooldownMs: 600 },

  RESPAWN_MS: 3000,
  SPAWN_PROT_MS: 2500,
  KILL_CREDIT_MS: 8000,

  SCORE: { kill: 150, killCrown: 300, dmgFactor: 1.0 },

  PICKUPS: {
    max: 12,
    intervalMs: 3200,
    kinds: ['wrench', 'nitro', 'shield', 'power'],
    heal: 40,
    shieldMs: 6000,
    powerMs: 8000,
    r: 20
  },

  CHAT: { cooldownMs: 700, maxLen: 80 },
  NAME_MAX: 12,
  COLORS: 8,

  // ---- 大地图布局 ----
  // 弹力柱（像弹球台一样把车弹开）
  BUMPERS: [
    { x: 800,  y: 600,  r: 80 },
    { x: 2400, y: 600,  r: 80 },
    { x: 800,  y: 1600, r: 80 },
    { x: 2400, y: 1600, r: 80 },
    { x: 1600, y: 1100, r: 115 }
  ],
  // 电锯（碰到掉血并被弹飞）
  SAWS: [
    { x: 1600, y: 330,  r: 85 },
    { x: 1600, y: 1870, r: 85 },
    { x: 330,  y: 1100, r: 70 },
    { x: 2870, y: 1100, r: 70 }
  ],
  // 加速带 { x,y,w,h, dir(弧度) }
  PADS: [
    { x: 420,  y: 360,  w: 220, h: 90, dir: 0 },
    { x: 2560, y: 360,  w: 220, h: 90, dir: Math.PI },
    { x: 420,  y: 1750, w: 220, h: 90, dir: 0 },
    { x: 2560, y: 1750, w: 220, h: 90, dir: Math.PI },
    { x: 1490, y: 700,  w: 90,  h: 200, dir: Math.PI / 2 },
    { x: 1490, y: 1300, w: 90,  h: 200, dir: -Math.PI / 2 }
  ],
  SPAWNS: [
    { x: 400,  y: 400 },  { x: 2800, y: 400 },
    { x: 400,  y: 1800 }, { x: 2800, y: 1800 },
    { x: 1600, y: 550 },  { x: 1600, y: 1650 },
    { x: 700,  y: 1100 }, { x: 2500, y: 1100 }
  ]
};

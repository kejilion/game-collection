'use strict';

// 全局配置：地图、节奏、玩家/炸弹/怪物数值。
// 所有距离单位均为“格”（tile），时间单位为秒。
module.exports = {
  // 大地图（含四周硬墙边框；内部按经典炸弹人规则布置柱子）
  COLS: 41,
  ROWS: 33,
  BRICK_DENSITY: 0.62, // 可炸砖块覆盖率

  // 服务器模拟与广播
  TICK_RATE: 30,   // 模拟频率
  SNAP_EVERY: 2,   // 每 N 个模拟帧广播一次快照（=15Hz，降低带宽，客户端插值）
  MAX_PLAYERS: 16,

  // 玩家
  PLAYER_RADIUS: 0.36,
  BASE_SPEED: 3.0,
  SPEED_STEP: 0.35,
  MAX_SPEED: 5.5,
  BASE_BOMBS: 1,
  MAX_BOMBS: 8,
  BASE_RANGE: 1,
  MAX_RANGE: 10,
  SPAWN_SHIELD: 3,    // 出生/重生保护时长
  HIT_INVULN: 1.5,    // 护盾破碎后的短暂无敌
  RESPAWN_DELAY: 2.5, // 死亡后自动重生延迟
  DEATH_DROPS: 2,     // 死亡时掉落的强化道具数量上限
  SPAWN_MONSTER_DIST: 5, // 出生点离怪物的最小距离
  SPAWN_PLAYER_DIST: 4,  // 出生点离其他玩家的最小距离（尽量满足）

  // 炸弹与爆炸
  BOMB_FUSE: 2.6,
  CHAIN_DELAY: 0.15, // 被波及炸弹的连锁引信
  BLAST_TIME: 0.55,  // 火焰滞留时长

  // 道具
  POWERUP_CHANCE: 0.42, // 砖块掉落道具概率
  POWERUP_WEIGHTS: { bomb: 30, fire: 32, speed: 22, shield: 16 },
  POWERUP_TTL: 40,           // 道具在地上的存活时间
  MONSTER_DROP_CHANCE: 0.2,  // 普通怪物死亡掉落道具概率

  // 砖块再生（常驻世界需要资源循环）
  BRICK_REGROW_MIN: 45,
  BRICK_REGROW_MAX: 90,

  // 怪物种群
  MONSTER_BASE: 8,
  MONSTER_PER_PLAYER: 2,
  MONSTER_MAX: 24,
  MONSTER_RESPAWN_INTERVAL: 3, // 低于目标数量时每 N 秒补一只
  MONSTER_PLAYER_DIST: 8,      // 怪物出生离玩家的最小距离
  MONSTER_TOUCH: 0.6,          // 触碰判定距离
  MONSTER_SPEED: { slime: 1.5, ghost: 1.9, imp: 2.5, gold: 2.9 },
  MONSTER_WEIGHTS: { slime: 45, ghost: 30, imp: 25 }, // 金史莱姆单独按概率出
  MONSTER_SCORE: { slime: 50, ghost: 100, imp: 150, gold: 500 },
  GOLD_CHANCE: 0.06, // 每次补怪时出金史莱姆的概率（场上最多一只）

  // 计分
  SCORE: {
    brick: 10,
    kill: 300,
    pickup: 20,
    streakBonus: 100, // 连杀每级额外加分
    streakCap: 700,   // 连杀额外加分上限
  },
};

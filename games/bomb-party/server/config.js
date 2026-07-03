'use strict';

// 全局配置：地图、节奏、玩家/炸弹/怪物数值。
// 所有距离单位均为“格”（tile），时间单位为秒。
module.exports = {
  // 地图（含四周硬墙边框；内部按经典炸弹人规则布置柱子）
  // 紧凑尺寸 + 较低砖密度：配合拉近的视野，局部战况更清晰
  COLS: 27,
  ROWS: 21,
  BRICK_DENSITY: 0.55, // 可炸砖块覆盖率

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

  // 怪物种群（随地图缩小同步收敛）
  MONSTER_BASE: 6,
  MONSTER_PER_PLAYER: 1.5,
  MONSTER_MAX: 14,
  MONSTER_RESPAWN_INTERVAL: 3, // 低于目标数量时每 N 秒补一只
  MONSTER_PLAYER_DIST: 6,      // 怪物出生离玩家的最小距离
  MONSTER_TOUCH: 0.6,          // 触碰判定距离
  MONSTER_SPEED: { slime: 1.5, ghost: 1.9, imp: 2.5, gold: 2.9, king: 1.15, golem: 0.95 },
  MONSTER_WEIGHTS: { slime: 45, ghost: 30, imp: 25 }, // 金史莱姆单独按概率出
  MONSTER_SCORE: { slime: 50, ghost: 100, imp: 150, gold: 500, king: 800, golem: 1200 },
  GOLD_CHANCE: 0.06, // 每次补怪时出金史莱姆的概率（场上最多一只）

  // BOSS（场上最多一只，定时刷新）
  BOSS_INTERVAL: 90,       // 无 BOSS 时每 N 秒刷一只
  BOSS_HIT_COOLDOWN: 0.8,  // 受击无敌帧，防止一团火多段掉血
  BOSS_HP: { king: 4, golem: 6 },
  BOSS_DROPS: 2,           // BOSS 死亡必掉道具数
  KING_SPLIT: 3,           // 史莱姆王死亡分裂出的小史莱姆数

  // 流浪商人
  MERCHANT_INTERVAL: 110, // 每 N 秒来一次
  MERCHANT_STAY: 45,      // 停留时长
  MERCHANT_RANGE: 3,      // 可交易距离

  // 计分
  SCORE: {
    brick: 10,
    kill: 300,
    pickup: 20,
    streakBonus: 100, // 连杀每级额外加分
    streakCap: 700,   // 连杀额外加分上限
  },
};

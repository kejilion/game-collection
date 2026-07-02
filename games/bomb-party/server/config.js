'use strict';

// 全局配置：地图、节奏、玩家/炸弹/怪物数值。
// 所有距离单位均为“格”（tile），时间单位为秒。
module.exports = {
  // 地图（含四周硬墙边框；内部按经典炸弹人规则布置柱子）
  COLS: 15,
  ROWS: 13,
  BRICK_DENSITY: 0.72, // 可炸砖块覆盖率

  // 服务器模拟
  TICK_RATE: 30,
  MAX_PLAYERS: 8,

  // 玩家
  PLAYER_RADIUS: 0.36,
  BASE_SPEED: 3.0,
  SPEED_STEP: 0.35,
  MAX_SPEED: 5.5,
  BASE_BOMBS: 1,
  MAX_BOMBS: 6,
  BASE_RANGE: 1,
  MAX_RANGE: 8,
  SPAWN_SHIELD: 3,   // 出生/复活保护时长
  HIT_INVULN: 1.5,   // 护盾破碎后的短暂无敌

  // 炸弹与爆炸
  BOMB_FUSE: 2.6,
  CHAIN_DELAY: 0.15, // 被波及炸弹的连锁引信
  BLAST_TIME: 0.55,  // 火焰滞留时长

  // 道具
  POWERUP_CHANCE: 0.4, // 砖块掉落道具概率
  POWERUP_WEIGHTS: { bomb: 30, fire: 32, speed: 22, shield: 16 },
  MONSTER_DROP_CHANCE: 0.15, // 怪物死亡掉落道具概率

  // 怪物
  MONSTER_BASE: 4,
  MONSTER_PER_PLAYER: 0.5,
  MONSTER_MAX: 8,
  MONSTER_TOUCH: 0.6, // 触碰判定距离
  MONSTER_SPEED: { slime: 1.5, ghost: 1.9, imp: 2.5 },
  MONSTER_WEIGHTS: { slime: 45, ghost: 35, imp: 20 },

  // 回合
  ROUND_TIME: 150,            // 进入突然死亡前的时长
  SUDDEN_DEATH_INTERVAL: 0.3, // 突然死亡每格坍塌间隔
  ROUND_END_DELAY: 6,         // 结算展示时长
  START_COUNTDOWN: 3,
  JOIN_GRACE: 20,             // 开局多少秒内加入仍可直接参战

  // 计分
  SCORE: { brick: 10, monster: 100, kill: 300, win: 500, pickup: 20 },
};

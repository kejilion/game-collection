// 反作弊库入口：核心引擎 + 存储适配器 + 体裁预设
'use strict';
const { AntiCheat, Monitor, TokenBucket, DEFAULTS } = require('./core');
const { createJsonStore, createMemoryStore } = require('./store');

// FPS/动作类预设：客户端上报位置 + 服务端裁决伤害 的典型架构
// override 里可覆盖任意 DEFAULTS 字段（deepMerge）
function fpsPreset(override) {
  return Object.assign({
    thresholds: { warn: 15, kick: 35, ban: 70 },
    banMinutes: 15,
    kicksToBan: 3,
  }, override || {});
}

// 回合/慢节奏类预设：动作频率低，限速与冷却更严格，移动校验通常不需要
function turnBasedPreset(override) {
  return Object.assign({
    thresholds: { warn: 10, kick: 25, ban: 50 },
    weights: { rate: 2, cooldown: 5, badvec: 6, protocol: 5 },
    banMinutes: 30,
  }, override || {});
}

// 每类消息的推荐限速 [每秒, 突发]，接入方可直接引用或自行调整
const RATE_PRESETS = {
  move: [40, 80], fire: [25, 35], melee: [10, 15], nade: [4, 6],
  chat: [2, 4], pickup: [10, 20], switch: [10, 15], reload: [5, 8],
  buy: [3, 6], equip: [5, 8], ping: [2, 4], default: [6, 10],
};

module.exports = {
  AntiCheat, Monitor, TokenBucket, DEFAULTS,
  createJsonStore, createMemoryStore,
  fpsPreset, turnBasedPreset, RATE_PRESETS,
};

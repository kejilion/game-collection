'use strict';

// 外观商店：商品目录 + 按玩家名持久化的已购/已装备记录。
// 数据落盘到 DATA_DIR/cosmetics.json（与排行榜同卷，重启不丢）。

const fs = require('fs');
const path = require('path');

// 商品目录：slot 为装备槽（每槽同时只能装备一件），price 为积分价格。
// 价格偏高，作为积分的中长线消耗目标。
const CATALOG = {
  hat_straw: { slot: 'hat', name: '草帽', icon: '👒', price: 1200 },
  hat_bow: { slot: 'hat', name: '蝴蝶结', icon: '🎀', price: 1500 },
  hat_top: { slot: 'hat', name: '绅士礼帽', icon: '🎩', price: 2500 },
  hat_wiz: { slot: 'hat', name: '魔法尖帽', icon: '🧙', price: 3000 },
  hat_gold: { slot: 'hat', name: '黄金王冠', icon: '👑', price: 5000 },
  pat_stripe: { slot: 'pattern', name: '虎纹', icon: '🐯', price: 1000 },
  pat_dot: { slot: 'pattern', name: '波点', icon: '🔴', price: 1000 },
  pat_star: { slot: 'pattern', name: '星星肚皮', icon: '⭐', price: 1800 },
  eye_big: { slot: 'eyes', name: '大眼萌', icon: '👀', price: 1600 },
  eye_star: { slot: 'eyes', name: '星星眼', icon: '🤩', price: 2800 },
  glow_soft: { slot: 'glow', name: '柔光光环', icon: '💡', price: 2600 },
  glow_gold: { slot: 'glow', name: '黄金外发光', icon: '✨', price: 4000 },
  trail_bub: { slot: 'trail', name: '泡泡拖尾', icon: '🫧', price: 2200 },
  trail_star: { slot: 'trail', name: '星尘拖尾', icon: '💫', price: 3200 },
  trail_rain: { slot: 'trail', name: '彩虹拖尾', icon: '🌈', price: 4500 },
  wing_angel: { slot: 'wings', name: '天使之翼', icon: '🕊️', price: 3600 },
  wing_fairy: { slot: 'wings', name: '蝴蝶精灵翼', icon: '🦋', price: 3200 },
  wing_devil: { slot: 'wings', name: '恶魔之翼', icon: '🦇', price: 4200 },
  wing_phoenix: { slot: 'wings', name: '火凤之翼', icon: '🔥', price: 6000 },
};

function createCosmetics(dataDir) {
  const file = path.join(dataDir, 'cosmetics.json');
  let data = { players: {} };
  let saveTimer = null;

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed.players === 'object') data = parsed;
    }
  } catch (err) {
    console.error('[cosmetics] 读取失败，使用空数据:', err.message);
  }

  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.writeFileSync(file, JSON.stringify(data));
      } catch (err) {
        console.error('[cosmetics] 保存失败:', err.message);
      }
    }, 1000);
  }

  function entry(name) {
    if (!data.players[name]) data.players[name] = { owned: [], equip: {} };
    return data.players[name];
  }

  return {
    CATALOG,
    // 玩家当前外观状态 {owned:[], equip:{slot:id}}
    state(name) {
      const e = entry(name);
      return { owned: e.owned.slice(), equip: Object.assign({}, e.equip) };
    },
    owns(name, id) {
      return entry(name).owned.includes(id);
    },
    // 购买并自动装备（扣分由调用方负责）
    buy(name, id) {
      const item = CATALOG[id];
      if (!item) return false;
      const e = entry(name);
      if (e.owned.includes(id)) return false;
      e.owned.push(id);
      e.equip[item.slot] = id;
      save();
      return true;
    },
    // 切换装备：已装备则卸下，否则装上（需已拥有）
    toggle(name, id) {
      const item = CATALOG[id];
      if (!item) return false;
      const e = entry(name);
      if (!e.owned.includes(id)) return false;
      if (e.equip[item.slot] === id) delete e.equip[item.slot];
      else e.equip[item.slot] = id;
      save();
      return true;
    },
    flush() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      try {
        fs.writeFileSync(file, JSON.stringify(data));
      } catch (err) {
        console.error('[cosmetics] 保存失败:', err.message);
      }
    },
  };
}

module.exports = { createCosmetics, CATALOG };

// 历史排行榜 + 玩家档案（金币/外观）持久化。按玩家昵称保存到 data/profiles.json
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'profiles.json');

let profiles = {};   // name -> { kills, deaths, bossKills, coins, owned:[], eq:{}, joins, last }
let saveTimer = null;

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) profiles = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
  } catch (e) {
    console.error('[leaderboard] 读取失败，使用空档案:', e.message);
    profiles = {};
  }
}

function saveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(profiles));
  } catch (e) {
    console.error('[leaderboard] 保存失败:', e.message);
  }
}

function save() {  // 2 秒防抖
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 2000);
}

function get(name) {
  if (!profiles[name]) {
    profiles[name] = { kills: 0, deaths: 0, bossKills: 0, bestStreak: 0, coins: null, owned: [], eq: {}, joins: 0, last: 0 };
  }
  const p = profiles[name];
  if (p.kills === undefined) p.kills = 0;
  if (p.deaths === undefined) p.deaths = 0;
  if (p.bossKills === undefined) p.bossKills = 0;
  if (p.bestStreak === undefined) p.bestStreak = 0;
  if (p.coins === undefined) p.coins = null;
  if (!Array.isArray(p.owned)) p.owned = [];
  if (!p.eq || typeof p.eq !== 'object') p.eq = {};
  if (p.joins === undefined) p.joins = 0;
  if (p.last === undefined) p.last = 0;
  return profiles[name];
}

// 历史榜：总击杀优先，其次历史最高连杀，其次 BOSS 击杀，其次死亡少
function top(n = 10) {
  return Object.entries(profiles)
    .map(([name, p]) => ({ n: name, k: p.kills | 0, d: p.deaths | 0, bk: p.bossKills | 0, bs: p.bestStreak | 0 }))
    .filter(e => e.k > 0 || e.bk > 0 || e.d > 0)
    .sort((a, b) => b.k - a.k || b.bs - a.bs || b.bk - a.bk || a.d - b.d)
    .slice(0, n);
}

load();
module.exports = { get, save, saveNow, top };

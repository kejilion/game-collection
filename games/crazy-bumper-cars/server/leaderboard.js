'use strict';
// 历史排行榜：按名字保留最佳单命得分，持久化到 DATA_DIR/leaderboard.json。
// Docker 部署时把卷挂到 /app/data 即可跨重启保留历史。
const fs = require('fs');
const path = require('path');
const C = require('./config');

const FILE = path.join(C.DATA_DIR, 'leaderboard.json');
const MAX = 50;

let history = [];
let saveTimer = null;

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) history = data.filter(e => e && typeof e.n === 'string');
  } catch (_) { /* 首次运行没有文件，正常 */ }
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(C.DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(history));
    } catch (err) {
      console.error('[leaderboard] 保存失败:', err.message);
    }
  }, 1500);
}

// 记录一条命的战绩；同名只保留最高分
function record(p) {
  if (!p || !p.name || !(p.score > 0)) return;
  const entry = { n: p.name, c: p.color, sc: p.score, k: p.kills, t: Date.now() };
  const i = history.findIndex(e => e.n === p.name);
  if (i >= 0) {
    if (history[i].sc >= entry.sc) return;
    history[i] = entry;
  } else {
    history.push(entry);
  }
  history.sort((a, b) => b.sc - a.sc);
  if (history.length > MAX) history.length = MAX;
  save();
}

function top(n = 10) { return history.slice(0, n); }

load();
module.exports = { record, top };

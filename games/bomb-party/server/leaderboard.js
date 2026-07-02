'use strict';

// 排行榜持久化：按玩家名记录胜场/最高分/参与回合数。
// 数据落盘到 DATA_DIR/leaderboard.json（Docker 中挂载 /app/data 卷即可保留）。

const fs = require('fs');
const path = require('path');

function createLeaderboard(dataDir) {
  const file = path.join(dataDir, 'leaderboard.json');
  let data = { players: {} };
  let saveTimer = null;

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed.players === 'object') data = parsed;
    }
  } catch (err) {
    console.error('[leaderboard] 读取失败，使用空数据:', err.message);
  }

  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
      } catch (err) {
        console.error('[leaderboard] 保存失败:', err.message);
      }
    }, 1000);
  }

  return {
    // 记录玩家战绩：best 取历史最高分，kills 按增量累计
    record(name, { score = 0, killsDelta = 0 } = {}) {
      if (!name) return;
      const entry = data.players[name] || { best: 0, kills: 0 };
      if (score > entry.best) entry.best = score;
      entry.kills = (entry.kills || 0) + Math.max(0, killsDelta);
      entry.seen = Date.now();
      data.players[name] = entry;
      save();
    },
    top(n = 10) {
      return Object.entries(data.players)
        .map(([name, e]) => ({ name, best: e.best || 0, kills: e.kills || 0 }))
        .sort((a, b) => b.best - a.best || b.kills - a.kills)
        .slice(0, n);
    },
    flush() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
      } catch (err) {
        console.error('[leaderboard] 保存失败:', err.message);
      }
    },
  };
}

module.exports = { createLeaderboard };

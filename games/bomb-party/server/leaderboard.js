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
    // 回合结束时记录：win 为是否夺冠，score 为该玩家当前累计分
    record(name, { win = false, score = 0 } = {}) {
      if (!name) return;
      const entry = data.players[name] || { wins: 0, best: 0, rounds: 0 };
      entry.rounds++;
      if (win) entry.wins++;
      if (score > entry.best) entry.best = score;
      data.players[name] = entry;
      save();
    },
    top(n = 10) {
      return Object.entries(data.players)
        .map(([name, e]) => ({ name, wins: e.wins, best: e.best, rounds: e.rounds }))
        .sort((a, b) => b.wins - a.wins || b.best - a.best)
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

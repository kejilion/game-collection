// ============================================================================
//  Historical leaderboard — persisted to disk so it survives restarts.
//  In Docker, mount a volume at /app/data to keep history between deploys.
// ============================================================================
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'leaderboard.json');
const MAX = 20;

let history = [];

function load() {
  try {
    if (fs.existsSync(FILE)) history = JSON.parse(fs.readFileSync(FILE, 'utf8')) || [];
  } catch (e) { history = []; }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;                       // debounce writes
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(history, null, 0));
    } catch (e) { console.error('leaderboard save failed:', e.message); }
  }, 1500);
}

// Record a player's final run. Keeps the single best score per name.
function record(p) {
  if (!p || p.score <= 0) return;
  const entry = {
    name: p.name, cls: p.clsId, score: p.score,
    level: p.level, kills: p.kills, bossKills: p.bossKills, at: Date.now()
  };
  const existing = history.find(h => h.name === entry.name);
  if (existing) {
    if (entry.score > existing.score) Object.assign(existing, entry);
  } else {
    history.push(entry);
  }
  history.sort((a, b) => b.score - a.score);
  if (history.length > MAX) history.length = MAX;
  save();
}

function top(n = 8) { return history.slice(0, n); }

load();
module.exports = { record, top };

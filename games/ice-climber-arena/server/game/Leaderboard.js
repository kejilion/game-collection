// ============================================================================
//  Persistent leaderboard — best rescue times across the lifetime of the
//  server, stored as a small JSON file so it survives restarts and Docker
//  redeploys (mount ./data as a volume).  Ranked by time; remembers which
//  in-server round produced the record.
// ============================================================================
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const FILE = path.join(DATA_DIR, 'leaderboard.json');
const MAX_ENTRIES = 200;

export class Leaderboard {
  constructor({ persist = true } = {}) {
    this.entries = []; // { name, timeMs, round, rank, date }
    this.persist = persist;
    this._saving = null;
    this._dirty = false;
  }

  async load() {
    try {
      const raw = await fs.readFile(FILE, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) this.entries = data;
    } catch {
      this.entries = []; // first boot — no file yet
    }
    return this;
  }

  /** Record a rescue. Returns the entry's all-time rank (1-based). */
  add({ name, timeMs, round, rank }) {
    const entry = {
      name: String(name || '???').slice(0, 16),
      timeMs: Math.round(timeMs),
      round,
      rank,
      date: new Date().toISOString(),
    };
    this.entries.push(entry);
    this.entries.sort((a, b) => a.timeMs - b.timeMs);
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    this._save();
    return this.entries.indexOf(entry) + 1;
  }

  top(n = 10) {
    return this.entries.slice(0, n);
  }

  // debounced atomic-ish write
  _save() {
    if (!this.persist) return;
    this._dirty = true;
    if (this._saving) return;
    this._saving = (async () => {
      while (this._dirty) {
        this._dirty = false;
        try {
          await fs.mkdir(DATA_DIR, { recursive: true });
          const tmp = FILE + '.tmp';
          await fs.writeFile(tmp, JSON.stringify(this.entries, null, 2));
          await fs.rename(tmp, FILE);
        } catch (err) {
          console.error('[leaderboard] save failed:', err.message);
        }
      }
      this._saving = null;
    })();
  }
}

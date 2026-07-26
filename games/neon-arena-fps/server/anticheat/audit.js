'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE_RE = /^anticheat-audit-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function dayOf(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function createSalt(dataDir) {
  const file = path.join(dataDir, '.anticheat-audit-salt');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const salt = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, salt, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return salt;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return fs.readFileSync(file, 'utf8').trim();
  }
}

class AuditLog {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.dataDir = options.dataDir || path.join(__dirname, '..', '..', 'data');
    this.flushMs = Math.max(100, Number(options.flushMs) || 1000);
    this.maxQueue = Math.max(100, Number(options.maxQueue) || 5000);
    this.retentionDays = Math.max(1, Number(options.retentionDays) || 30);
    this.schemaVersion = Number(options.schemaVersion) || 1;
    this.deployVersion = String(options.deployVersion || process.env.DEPLOY_VERSION || 'local');
    this.ruleVersion = String(options.ruleVersion || process.env.AC_RULE_VERSION || '2026-07-16-v1');
    this.queue = [];
    this.writing = null;
    this.closed = false;
    this.written = 0;
    this.dropped = 0;
    this.errors = 0;
    this.lastWriteAt = 0;
    this.lastError = '';
    this.currentFile = '';
    this.salt = '';
    this.timer = null;

    if (!this.enabled) return;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.salt = createSalt(this.dataDir);
    this.prune();
    this.timer = setInterval(() => { this.flush(); }, this.flushMs);
    if (this.timer.unref) this.timer.unref();
  }

  identityHash(value) {
    if (!this.enabled || !this.salt || !value) return null;
    return crypto.createHmac('sha256', this.salt).update(String(value)).digest('hex').slice(0, 24);
  }

  write(entry) {
    if (!this.enabled || this.closed || !entry || typeof entry !== 'object') return false;
    const timestamp = Number(entry.t) || Date.now();
    const row = Object.assign({
      schema: this.schemaVersion,
      t: timestamp,
      deploy: this.deployVersion,
      rules: this.ruleVersion,
    }, entry);
    row.t = timestamp;
    let line;
    try { line = JSON.stringify(row); } catch (error) {
      this.errors++;
      this.lastError = error.message;
      return false;
    }
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push({ day: dayOf(timestamp), line });
    if (this.queue.length >= 500) this.flush();
    return true;
  }

  async appendBatch(batch) {
    const groups = new Map();
    for (const row of batch) {
      if (!groups.has(row.day)) groups.set(row.day, []);
      groups.get(row.day).push(row.line);
    }
    for (const [day, lines] of groups) {
      const file = path.join(this.dataDir, `anticheat-audit-${day}.jsonl`);
      await fs.promises.appendFile(file, lines.join('\n') + '\n', 'utf8');
      this.currentFile = file;
    }
    this.written += batch.length;
    this.lastWriteAt = Date.now();
  }

  flush() {
    if (!this.enabled || this.writing || this.queue.length === 0) return this.writing || Promise.resolve();
    const batch = this.queue.splice(0, this.queue.length);
    this.writing = this.appendBatch(batch)
      .catch(error => {
        this.errors++;
        this.lastError = error.message;
        const remaining = Math.max(0, this.maxQueue - this.queue.length);
        const restore = batch.slice(Math.max(0, batch.length - remaining));
        this.dropped += batch.length - restore.length;
        this.queue.unshift(...restore);
      })
      .finally(() => {
        this.writing = null;
        if (!this.closed && this.queue.length) this.flush();
      });
    return this.writing;
  }

  prune(referenceTime = Date.now()) {
    if (!this.enabled) return;
    const cutoff = referenceTime - this.retentionDays * 86400000;
    let files = [];
    try { files = fs.readdirSync(this.dataDir); } catch (_) { return; }
    for (const name of files) {
      const match = FILE_RE.exec(name);
      if (!match) continue;
      const timestamp = Date.parse(match[1] + 'T00:00:00.000Z');
      if (!Number.isFinite(timestamp) || timestamp >= cutoff) continue;
      try { fs.unlinkSync(path.join(this.dataDir, name)); } catch (_) { /* 下次启动重试 */ }
    }
  }

  status() {
    return {
      enabled: this.enabled,
      queued: this.queue.length,
      written: this.written,
      dropped: this.dropped,
      errors: this.errors,
      retentionDays: this.retentionDays,
      currentFile: this.currentFile ? path.basename(this.currentFile) : '',
      lastWriteAt: this.lastWriteAt,
      lastError: this.lastError,
      deploy: this.deployVersion,
      rules: this.ruleVersion,
    };
  }

  async close() {
    if (!this.enabled) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    let consecutiveFailures = 0;
    let previousErrors = this.errors;
    while (this.writing || this.queue.length) {
      if (this.writing) await this.writing;
      else await this.flush();
      if (this.errors > previousErrors) consecutiveFailures++;
      else consecutiveFailures = 0;
      previousErrors = this.errors;
      if (consecutiveFailures >= 2) {
        this.dropped += this.queue.length;
        this.queue.length = 0;
        break;
      }
    }
  }
}

function createAuditLog(options) {
  return new AuditLog(options);
}

module.exports = { AuditLog, createAuditLog, FILE_RE };

'use strict';

const fs = require('fs');
const path = require('path');

function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const from = String(raw.from || '').replace(/[<>&"']/g, '').trim().slice(0, 12);
  const text = String(raw.text || '').replace(/[<>]/g, '').trim().slice(0, 120);
  const color = /^#[0-9a-f]{6}$/i.test(String(raw.color || '')) ? String(raw.color) : '#ffffff';
  const at = Number.isFinite(raw.at) ? Math.round(raw.at) : Date.now();
  return from && text ? { from, color, text, at } : null;
}

function createChatHistory(options = {}) {
  const filePath = options.filePath || path.join(process.cwd(), 'data', 'chat-history.jsonl');
  const maxEntries = Math.max(40, options.maxEntries || 200);
  const maxFileBytes = Math.max(64 * 1024, options.maxFileBytes || 1024 * 1024);
  const log = options.log || console.warn;
  let entries = [];
  let writesSinceCompact = 0;

  function rewrite() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = filePath + '.tmp';
    const content = entries.map(entry => JSON.stringify(entry)).join('\n');
    fs.writeFileSync(tempPath, content ? content + '\n' : '');
    fs.renameSync(tempPath, filePath);
  }

  function load() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      if (!fs.existsSync(filePath)) return;
      const loaded = [];
      for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = sanitizeEntry(JSON.parse(line));
          if (entry) loaded.push(entry);
        } catch (_) { /* 忽略异常或未写完的单行 */ }
      }
      entries = loaded.slice(-maxEntries);
      if (fs.statSync(filePath).size > maxFileBytes) rewrite();
    } catch (error) {
      log(`[chat-history] 读取失败，使用空历史: ${error.message}`);
      entries = [];
    }
  }

  function add(raw) {
    const entry = sanitizeEntry(Object.assign({}, raw, { at: raw && raw.at || Date.now() }));
    if (!entry) return null;
    entries.push(entry);
    if (entries.length > maxEntries) entries.shift();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
      writesSinceCompact++;
      if (writesSinceCompact >= maxEntries && fs.statSync(filePath).size > maxFileBytes) {
        rewrite();
        writesSinceCompact = 0;
      }
    } catch (error) {
      log(`[chat-history] 写入失败: ${error.message}`);
    }
    return entry;
  }

  function recent(limit = 40) {
    const count = Math.max(0, Math.min(maxEntries, Number(limit) || 0));
    return entries.slice(-count).map(entry => Object.assign({}, entry));
  }

  function status() {
    return { enabled: true, entries: entries.length, maxEntries };
  }

  load();
  return { add, recent, status };
}

module.exports = { createChatHistory };

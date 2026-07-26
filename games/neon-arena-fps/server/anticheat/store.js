// 封禁/踢出记录持久化：JSON 文件适配器（可替换为 Redis/数据库，实现同名四方法即可）
'use strict';
const fs = require('fs');
const path = require('path');
const EVENT_LIMIT = 500;

function cleanEvent(entry) {
  const out = {
    type: entry.type || 'flag', t: Number(entry.t) || Date.now(),
    key: entry.key, name: entry.name, rule: entry.rule, channel: entry.channel,
    action: entry.action, reason: entry.reason, detail: entry.detail,
    w: entry.w, score: entry.score, scores: entry.scores,
    identity: entry.identity, players: entry.players,
    persistent: !!entry.persistent, movementOnly: !!entry.movementOnly,
  };
  for (const key of Object.keys(out)) if (out[key] === undefined || out[key] === '') delete out[key];
  return out;
}

function ensureEventData(data) {
  if (!Array.isArray(data.events)) data.events = [];
  if (!data.eventStats || typeof data.eventStats !== 'object') data.eventStats = {};
  for (const key of ['flags', 'observations', 'actions']) {
    if (!data.eventStats[key] || typeof data.eventStats[key] !== 'object') data.eventStats[key] = {};
  }
}

function appendEvent(data, entry) {
  ensureEventData(data);
  const row = cleanEvent(entry);
  data.events.push(row);
  if (data.events.length > EVENT_LIMIT) data.events.splice(0, data.events.length - EVENT_LIMIT);
  const bucket = row.type === 'action'
    ? data.eventStats.actions
    : (row.type === 'observe' ? data.eventStats.observations : data.eventStats.flags);
  const key = row.type === 'action' ? row.action : row.rule;
  if (key) bucket[key] = (bucket[key] || 0) + 1;
}

function createJsonStore(file) {
  let data = { bans: {}, kicks: {} };
  let timer = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      data = Object.assign(data, JSON.parse(raw));
    }
  } catch (e) {
    console.error('[anticheat/store] 读取失败，使用空数据:', e.message);
  }
  ensureEventData(data);
  const save = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try { fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { console.error('[anticheat/store] 保存失败:', e.message); }
    }, 1500);
  };
  const saveNow = () => {
    try { fs.writeFileSync(file, JSON.stringify(data)); } catch (_) { /* 忽略 */ }
  };
  return {
    getBan(ident) {
      const b = data.bans[ident];
      if (!b) return null;
      if (b.until <= Date.now()) { delete data.bans[ident]; save(); return null; }
      return b;
    },
    setBan(ident, ban) { data.bans[ident] = ban; save(); },
    banCount(ident) {
      const arr = data.banHistory && data.banHistory[ident];
      return arr ? arr.length : 0;
    },
    addBanRecord(ident) {
      if (!data.banHistory) data.banHistory = {};
      if (!data.banHistory[ident]) data.banHistory[ident] = [];
      data.banHistory[ident].push(Date.now());
      save();
    },
    // 记录一次踢出，返回窗口期内累计次数
    addKick(ident, windowMs) {
      const t = Date.now();
      const arr = (data.kicks[ident] || []).filter(ts => t - ts < windowMs);
      arr.push(t);
      data.kicks[ident] = arr;
      save();
      return arr.length;
    },
    kickCount(ident, windowMs) {
      const t = Date.now();
      return (data.kicks[ident] || []).filter(ts => t - ts < windowMs).length;
    },
    addEvent(entry) { appendEvent(data, entry); save(); },
    recentEvents(limit) { return data.events.slice(-Math.max(0, limit || 20)); },
    eventStats() {
      return {
        flags: Object.assign({}, data.eventStats.flags),
        observations: Object.assign({}, data.eventStats.observations),
        actions: Object.assign({}, data.eventStats.actions),
      };
    },
    save: saveNow,
  };
}

// 无持久化（内存版）：适合测试或无落盘环境
function createMemoryStore() {
  const data = { bans: {}, kicks: {}, events: [], eventStats: { flags: {}, observations: {}, actions: {} } };
  return {
    getBan(ident) {
      const b = data.bans[ident];
      return b && b.until > Date.now() ? b : null;
    },
    setBan(ident, ban) { data.bans[ident] = ban; },
    banCount(ident) {
      const arr = data.banHistory && data.banHistory[ident];
      return arr ? arr.length : 0;
    },
    addBanRecord(ident) {
      if (!data.banHistory) data.banHistory = {};
      if (!data.banHistory[ident]) data.banHistory[ident] = [];
      data.banHistory[ident].push(Date.now());
    },
    addKick(ident, windowMs) {
      const t = Date.now();
      const arr = (data.kicks[ident] || []).filter(ts => t - ts < windowMs);
      arr.push(t);
      data.kicks[ident] = arr;
      return arr.length;
    },
    kickCount(ident, windowMs) {
      const t = Date.now();
      return (data.kicks[ident] || []).filter(ts => t - ts < windowMs).length;
    },
    addEvent(entry) { appendEvent(data, entry); },
    recentEvents(limit) { return data.events.slice(-Math.max(0, limit || 20)); },
    eventStats() {
      return {
        flags: Object.assign({}, data.eventStats.flags),
        observations: Object.assign({}, data.eventStats.observations),
        actions: Object.assign({}, data.eventStats.actions),
      };
    },
    save() { /* 内存版无需落盘 */ },
  };
}

module.exports = { createJsonStore, createMemoryStore };

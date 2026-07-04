// 封禁/踢出记录持久化：JSON 文件适配器（可替换为 Redis/数据库，实现同名四方法即可）
'use strict';
const fs = require('fs');
const path = require('path');

function createJsonStore(file) {
  let data = { bans: {}, kicks: {} };
  let timer = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) data = Object.assign(data, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    console.error('[anticheat/store] 读取失败，使用空数据:', e.message);
  }
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
    save: saveNow,
  };
}

// 无持久化（内存版）：适合测试或无落盘环境
function createMemoryStore() {
  const data = { bans: {}, kicks: {} };
  return {
    getBan(ident) {
      const b = data.bans[ident];
      return b && b.until > Date.now() ? b : null;
    },
    setBan(ident, ban) { data.bans[ident] = ban; },
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
    save() { /* 内存版无需落盘 */ },
  };
}

module.exports = { createJsonStore, createMemoryStore };

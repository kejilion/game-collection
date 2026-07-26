'use strict';

const fs = require('fs');
const path = require('path');
const { FILE_RE } = require('../anticheat/audit');

function parseArgs(argv) {
  const args = { days: 7, dataDir: process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), json: false };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--days') args.days = Math.max(1, Number(argv[++index]) || 7);
    else if (value === '--data-dir') args.dataDir = path.resolve(argv[++index]);
    else if (value === '--json') args.json = true;
  }
  return args;
}

function increment(target, key, amount = 1) {
  if (!key) return;
  target[key] = (target[key] || 0) + amount;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

function distribution(rows, field) {
  const values = rows
    .filter(row => row[field] !== null && row[field] !== undefined)
    .map(row => Number(row[field]))
    .filter(Number.isFinite);
  if (!values.length) return { samples: 0, p50: null, p95: null, max: null };
  return {
    samples: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

function readRows(dataDir, days, referenceTime = Date.now()) {
  const cutoff = referenceTime - days * 86400000;
  const rows = [];
  let invalidLines = 0;
  let files = [];
  try { files = fs.readdirSync(dataDir).filter(name => FILE_RE.test(name)).sort(); } catch (_) { return { rows, invalidLines, files: [] }; }
  for (const name of files) {
    const content = fs.readFileSync(path.join(dataDir, name), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if ((Number(row.t) || 0) >= cutoff) rows.push(row);
      } catch (_) { invalidLines++; }
    }
  }
  return { rows, invalidLines, files };
}

function buildReport(rows, meta = {}) {
  const types = {};
  const flags = {};
  const observations = {};
  const actions = {};
  const deployments = {};
  const identities = new Map();
  const sessions = new Map();

  for (const row of rows) {
    increment(types, row.type);
    increment(deployments, row.deploy);
    if (row.type === 'flag') increment(flags, row.rule);
    if (row.type === 'observe') increment(observations, row.rule);
    if (row.type === 'action') increment(actions, row.action || row.rule);
    if (row.type === 'session' && row.sessionId) {
      const previous = sessions.get(row.sessionId);
      if (!previous || Number(row.t) >= Number(previous.t)) sessions.set(row.sessionId, row);
    }
    if (row.identity) {
      let identity = identities.get(row.identity);
      if (!identity) identity = { identity: row.identity, name: '', flags: 0, observations: 0, actions: 0, lastAt: 0 };
      if (row.name) identity.name = row.name;
      if (row.type === 'flag') identity.flags++;
      if (row.type === 'observe') identity.observations++;
      if (row.type === 'action') identity.actions++;
      identity.lastAt = Math.max(identity.lastAt, Number(row.t) || 0);
      identities.set(row.identity, identity);
    }
  }

  const latestSessions = [...sessions.values()];
  const rttRows = latestSessions.filter(row => row.rtt && Number.isFinite(Number(row.rtt.p95)))
    .map(row => Object.assign({}, row, { rttP95: Number(row.rtt.p95) }));
  const topIdentities = [...identities.values()]
    .filter(row => row.flags || row.actions)
    .sort((a, b) => (b.actions * 100 + b.flags) - (a.actions * 100 + a.flags) || b.lastAt - a.lastAt)
    .slice(0, 20);

  return {
    generatedAt: Date.now(),
    rangeDays: meta.days || 7,
    files: meta.files || [],
    invalidLines: meta.invalidLines || 0,
    events: rows.length,
    types, flags, observations, actions, deployments,
    sessions: {
      count: latestSessions.length,
      kpm: distribution(latestSessions, 'kpm'),
      kd: distribution(latestSessions, 'kd'),
      hitRate: distribution(latestSessions, 'hitRate'),
      headshotRate: distribution(latestSessions, 'headshotRate'),
      shotsPerKill: distribution(latestSessions, 'shotsPerKill'),
      rttP95: distribution(rttRows, 'rttP95'),
    },
    topIdentities,
  };
}

function countText(values) {
  const rows = Object.entries(values).sort((a, b) => b[1] - a[1]);
  return rows.length ? rows.map(([key, value]) => `${key}=${value}`).join(', ') : '无';
}

function metricText(metric, percent) {
  if (!metric.samples) return '无样本';
  const format = value => percent ? `${(value * 100).toFixed(1)}%` : Number(value).toFixed(2);
  return `样本${metric.samples}，P50=${format(metric.p50)}，P95=${format(metric.p95)}，最大=${format(metric.max)}`;
}

function formatReport(report) {
  const lines = [
    `反作弊审计报告（最近 ${report.rangeDays} 天）`,
    `文件 ${report.files.length} 个，事件 ${report.events} 条，无效行 ${report.invalidLines} 条`,
    `事件类型：${countText(report.types)}`,
    `计分规则：${countText(report.flags)}`,
    `观察规则：${countText(report.observations)}`,
    `处置结果：${countText(report.actions)}`,
    `部署版本：${countText(report.deployments)}`,
    `会话：${report.sessions.count} 个`,
    `KPM：${metricText(report.sessions.kpm, false)}`,
    `K/D：${metricText(report.sessions.kd, false)}`,
    `命中率：${metricText(report.sessions.hitRate, true)}`,
    `爆头率：${metricText(report.sessions.headshotRate, true)}`,
    `每杀耗弹：${metricText(report.sessions.shotsPerKill, false)}`,
    `RTT P95(ms)：${metricText(report.sessions.rttP95, false)}`,
  ];
  if (report.topIdentities.length) {
    lines.push('高关注身份（匿名 IP 哈希）：');
    for (const row of report.topIdentities.slice(0, 10)) {
      lines.push(`- ${row.identity} ${row.name || '未知昵称'}：计分${row.flags}，观察${row.observations}，处置${row.actions}`);
    }
  }
  return lines.join('\n');
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const loaded = readRows(args.dataDir, args.days);
  const report = buildReport(loaded.rows, { days: args.days, files: loaded.files, invalidLines: loaded.invalidLines });
  process.stdout.write(args.json ? JSON.stringify(report, null, 2) + '\n' : formatReport(report) + '\n');
}

module.exports = { parseArgs, readRows, buildReport, formatReport, distribution };

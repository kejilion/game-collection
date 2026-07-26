'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const ANTICHEAT_FILE = path.join(DATA_DIR, 'anticheat.json');
const apply = process.argv.includes('--apply');

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function isRanked(profile) {
  return !!profile && ((((profile.bestSession || {}).kills) | 0) > 0 || (profile.bestStreak | 0) > 0);
}

function kickedNames(anticheat) {
  const names = new Set();
  for (const key of Object.keys(anticheat.kicks || {})) {
    const match = /^(?:network:)?name:(.+)$/.exec(key);
    if (match && match[1]) names.add(match[1]);
  }
  return names;
}

const profiles = readJson(PROFILES_FILE, {});
const anticheat = readJson(ANTICHEAT_FILE, { kicks: {} });
const names = kickedNames(anticheat);
const targets = Array.from(names).filter(name => isRanked(profiles[name])).sort((a, b) => a.localeCompare(b, 'zh-CN'));
const report = {
  applied: apply,
  profilesBefore: Object.keys(profiles).length,
  kickedNames: names.size,
  removed: targets.length,
  names: targets,
};

if (apply && targets.length > 0) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = `${PROFILES_FILE}.pre-kick-cleanup-${stamp}.bak`;
  fs.copyFileSync(PROFILES_FILE, backupFile);
  for (const name of targets) delete profiles[name];
  const tempFile = PROFILES_FILE + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify(profiles));
  fs.renameSync(tempFile, PROFILES_FILE);
  report.backupFile = backupFile;
}

report.profilesAfter = apply ? Object.keys(profiles).length : report.profilesBefore - targets.length;
console.log(JSON.stringify(report, null, 2));

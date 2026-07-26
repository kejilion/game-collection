'use strict';

const fs = require('fs');
const path = require('path');

const KEEP_CHAR = /[\p{L}\p{N}]/u;

function compactWithMap(value) {
  const source = String(value || '');
  let compact = '';
  const map = [];

  for (let offset = 0; offset < source.length;) {
    const codePoint = source.codePointAt(offset);
    const char = String.fromCodePoint(codePoint);
    const end = offset + char.length;
    const normalized = char.normalize('NFKC').toLowerCase();

    for (const normalizedChar of normalized) {
      if (!KEEP_CHAR.test(normalizedChar)) continue;
      compact += normalizedChar;
      for (let i = 0; i < normalizedChar.length; i++) map.push({ start: offset, end });
    }
    offset = end;
  }

  return { source, compact, map };
}

function loadWords(filePath) {
  const seen = new Set();
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const term = compactWithMap(line).compact;
    if (term.length >= 2) seen.add(term);
  }
  return Array.from(seen).sort((a, b) => b.length - a.length);
}

function findRanges(value, words) {
  const normalized = compactWithMap(value);
  const ranges = [];

  for (const word of words) {
    let from = 0;
    while (from < normalized.compact.length) {
      const at = normalized.compact.indexOf(word, from);
      if (at < 0) break;
      const first = normalized.map[at];
      const last = normalized.map[at + word.length - 1];
      if (first && last) ranges.push({ start: first.start, end: last.end });
      from = at + word.length;
    }
  }

  return { source: normalized.source, ranges };
}

function maskRanges(source, ranges) {
  if (!ranges.length) return source;
  const mask = new Uint8Array(source.length);
  for (const range of ranges) {
    for (let i = range.start; i < range.end; i++) mask[i] = 1;
  }

  let output = '';
  for (let offset = 0; offset < source.length;) {
    const codePoint = source.codePointAt(offset);
    const char = String.fromCodePoint(codePoint);
    const end = offset + char.length;
    output += mask[offset] && !/^\s+$/u.test(char) ? '*' : char;
    offset = end;
  }
  return output;
}

function createChatFilter(options = {}) {
  const enabled = options.enabled !== false;
  const filePath = options.filePath || path.join(__dirname, 'sensitive-words.txt');
  let words = [];
  if (enabled) {
    try {
      words = loadWords(filePath);
    } catch (error) {
      const log = options.log || console.warn;
      log(`[chat-filter] 词库加载失败，过滤功能已降级关闭: ${error.message}`);
    }
  }

  const stats = { filteredMessages: 0, blockedNames: 0, matches: 0 };
  return {
    contains(value) {
      return enabled && words.length > 0 && findRanges(value, words).ranges.length > 0;
    },
    filter(value) {
      if (!enabled || words.length === 0) return { text: String(value || ''), filtered: false, matches: 0 };
      const result = findRanges(value, words);
      if (!result.ranges.length) return { text: result.source, filtered: false, matches: 0 };
      stats.filteredMessages++;
      stats.matches += result.ranges.length;
      return { text: maskRanges(result.source, result.ranges), filtered: true, matches: result.ranges.length };
    },
    noteBlockedName() {
      stats.blockedNames++;
    },
    status() {
      return {
        enabled: enabled && words.length > 0,
        terms: words.length,
        filteredMessages: stats.filteredMessages,
        blockedNames: stats.blockedNames,
        matches: stats.matches,
      };
    },
  };
}

module.exports = { createChatFilter };
